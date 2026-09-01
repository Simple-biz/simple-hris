import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth/auth-options';
import { createSupabaseServiceRoleClient, createSupabaseServerClient } from '@/lib/supabase/server';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { insertBankUpdateHistory } from '@/lib/supabase/bank-update-history';
import { getSessionActor } from '@/lib/auth/session-actor';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { requireFeatureEditAnyView } from '@/lib/auth/authorize-feature';
import {
  getBankPreferredRequestById,
  getLatestBankPreferredRequest,
} from '@/lib/supabase/bank-preferred-requests';
import { DISPUTE_DELETE_ROLES } from '@/lib/supabase/pab-day-disputes';
import { getPayrollDispatchLock } from '@/lib/supabase/payroll-dispatch-lock';
import { invalidateRateProfilesCache } from '@/lib/supabase/employee-rate-profiles';
import { pulseBankChanges } from '@/lib/supabase/app-settings';
import {
  bankPreferredLabelForProcessor,
  isBankPreferredAllowedForReceiving,
  mirroredDisbursementFor,
} from '@/lib/employee-payment-processors';
import { getEmployeeIdRowByEmail } from '@/lib/supabase/employee-ids';
import type { ProcessorId } from '@/lib/employee-payment-processors';
import { randomUUID } from 'crypto';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const TABLE = 'bank_preferred_change_requests';

function labelFor(v: string | null): string {
  if (!v) return 'none';
  return bankPreferredLabelForProcessor(v as ProcessorId) || v;
}

// PATCH /api/bank-preferred-requests/[id]
// Accounting-only (Issues tab): approve or deny a Bank Preferred change request.
//
// Transitions (2026-09-01 — decided rows became editable, Kane's ask):
//   pending  → approved   apply the value to employee_ids.bank_preferred
//   pending  → denied     leave the value untouched
//   denied   → approved   apply now — only for the employee's LATEST request
//   approved → denied     REVERT — restores from_value, only while the live
//                         bank_preferred still equals this request's to_value
//   same     → same       note-only edit (review_notes refreshed)
//   superseded            immutable — a newer request replaced it
//
// Every transition that writes employee_ids re-runs the same gates the original
// approve ran: the dispatch lock (423) and the 1:1 rule against the LIVE
// receiving channel (fail closed — a read error is a 503, never an applied
// write). Deleting a request (DELETE below) NEVER touches employee_ids.
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    // Same gate as the rest of the Issues tab (PAB disputes live here too).
    const authz = await requireFeatureEditAnyView('disputes');
    if (!authz.ok) return deniedResponse(authz);

    const { id } = await params;
    if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });

    const body = (await request.json()) as { status?: string; review_notes?: string | null };
    const status = (body.status ?? '').trim();
    if (!['approved', 'denied'].includes(status)) {
      return NextResponse.json({ error: 'status must be approved or denied' }, { status: 400 });
    }

    const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
    if (!supabase) return NextResponse.json({ error: 'DB unavailable' }, { status: 500 });

    const { row, error: loadErr } = await getBankPreferredRequestById(id);
    if (loadErr) return NextResponse.json({ error: loadErr }, { status: 500 });
    if (!row) return NextResponse.json({ error: 'Request not found' }, { status: 404 });
    if (row.status === 'superseded') {
      return NextResponse.json(
        { error: 'This request was superseded by a newer one — decide that one instead.' },
        { status: 409 },
      );
    }

    const nowIso = new Date().toISOString();
    const reviewNotes = body.review_notes ?? null;
    const workEmail = row.work_email.trim().toLowerCase();
    const isRevert = row.status === 'approved' && status === 'denied';
    const isEdit = row.status !== 'pending';

    // Note-only edit: same status, just refresh the note + reviewer.
    if (row.status === status) {
      const { error: noteErr } = await supabase
        .from(TABLE)
        .update({ review_notes: reviewNotes, reviewed_by: authz.sessionEmail, reviewed_at: nowIso })
        .eq('id', id);
      if (noteErr) return NextResponse.json({ error: noteErr.message }, { status: 500 });
      const actor = await getSessionActor();
      void insertAuditLog({
        user_name: actor.user_name,
        user_role: actor.user_role,
        action: `bank_preferred.request.${status}`,
        resource: TABLE,
        resource_id: id,
        details: { work_email: row.work_email, from: row.from_value, to: row.to_value, review_notes: reviewNotes, note_only: true },
      });
      return NextResponse.json({ success: true });
    }

    // Any transition that writes employee_ids.bank_preferred refuses while
    // payroll is processing — same rule as every other writer of this column
    // (people/[email]/banking, update-employee-ids, bank-update/save). Without
    // it a flip could reroute someone AFTER the dispatch queue was built.
    if (status === 'approved' || isRevert) {
      const lock = await getPayrollDispatchLock();
      if (lock.locked) {
        return NextResponse.json(
          {
            error:
              'Payroll is being processed right now, so payment routing is temporarily locked. Change this request once the dispatch completes.',
          },
          { status: 423 },
        );
      }
    }

    if (status === 'approved') {
      // Re-approving an old denied request must not resurrect a stale ask over
      // a newer one — only the employee's LATEST request can be flipped live.
      if (isEdit) {
        const { row: latest, error: latestErr } = await getLatestBankPreferredRequest(workEmail);
        if (latestErr) return NextResponse.json({ error: latestErr }, { status: 500 });
        if (latest && latest.id !== row.id) {
          return NextResponse.json(
            { error: 'A newer Bank Preferred request exists for this employee — decide that one instead.' },
            { status: 409 },
          );
        }
      }

      // THE 1:1 RULE re-checked against the LIVE receiving channel, not the
      // request's from_value (both fields may have changed since it was filed):
      // a wallet receiver's send-from must be that wallet, a bank receiver
      // never sends from a wallet, and an unset receiver takes anything (the
      // forward mirror below completes the pair).
      //
      // MUST fail closed. This site once relied on a failed read collapsing to
      // null, which silently inverted to fail-OPEN when null's meaning changed
      // (2026-08-24) — so the read error stays explicit, never implied.
      const { row: liveIds, error: liveErr } = await getEmployeeIdRowByEmail(workEmail).catch(
        (e: unknown) => ({ row: null, error: e instanceof Error ? e.message : String(e) }),
      );
      if (liveErr) {
        console.error(
          `bank-preferred approve: live receiving-channel read failed for ${workEmail}: ${liveErr}`,
        );
        return NextResponse.json(
          {
            error:
              'Could not verify the current receiving bank for this employee, so the approval was not applied. Please retry.',
          },
          { status: 503 },
        );
      }
      if (!isBankPreferredAllowedForReceiving(liveIds?.preferred_processor ?? null, row.to_value)) {
        return NextResponse.json(
          {
            error:
              'The sending rail must match the receiving bank: this employee currently receives on a different rail than the request asks to send from. Deny this request, or fix the receiving bank first.',
          },
          { status: 400 },
        );
      }

      const { data: updatedRows, error: updErr } = await supabase
        .from('employee_ids')
        .update({
          bank_preferred: row.to_value,
          bank_last_self_updated_at: nowIso,
          // WALLET MIRROR (Kane, 2026-08-24) — the same rule the People → Banking
          // save applies, from the same helper. This is the ONE path an
          // employee's own Kolan/HiGlobe pick can land through, so omitting it
          // here would leave the two write paths disagreeing.
          ...(mirroredDisbursementFor(row.to_value)
            ? { preferred_processor: mirroredDisbursementFor(row.to_value) }
            : {}),
        })
        .ilike('work_email', workEmail)
        .select('employee_id');

      if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

      // No employee_ids row yet (employee only ever submitted a Bank Preferred and
      // had no payout row) — bootstrap one so the approved value has a home.
      if (!updatedRows || updatedRows.length === 0) {
        const employeeId = `SELF-${randomUUID().replace(/-/g, '').slice(0, 14).toUpperCase()}`;
        const { error: insErr } = await supabase.from('employee_ids').insert({
          employee_id: employeeId,
          name: row.employee_name ?? workEmail,
          work_email: workEmail,
          bank_preferred: row.to_value,
          bank_last_self_updated_at: nowIso,
        });
        if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });
      }

      invalidateRateProfilesCache();

      // Record into the People-tab bank-change history so approvals are auditable
      // there alongside self-service changes. Best-effort.
      await insertBankUpdateHistory({
        work_email: workEmail,
        employee_name: row.employee_name,
        fields: ['bank_preferred'],
        changes: [
          {
            field: 'bank_preferred',
            before: labelFor(row.from_value),
            after: labelFor(row.to_value),
            changed: (row.from_value ?? '') !== (row.to_value ?? ''),
          },
        ],
        processor: row.to_value,
        created_new: false,
        via: isEdit ? 'accounting_edit' : 'accounting_approval',
        ip_address: null,
      }).catch(() => undefined);
      await pulseBankChanges().catch(() => undefined);
    }

    if (isRevert) {
      // REVERT an applied approval. Only safe while our approval is still the
      // live value — anything newer (People → Banking edit, a later approved
      // request) must never be clobbered by unwinding an old one.
      const { row: liveIds, error: liveErr } = await getEmployeeIdRowByEmail(workEmail).catch(
        (e: unknown) => ({ row: null, error: e instanceof Error ? e.message : String(e) }),
      );
      if (liveErr) {
        console.error(
          `bank-preferred revert: live read failed for ${workEmail}: ${liveErr}`,
        );
        return NextResponse.json(
          {
            error:
              'Could not verify the current Bank Preferred for this employee, so the approval was not reversed. Please retry.',
          },
          { status: 503 },
        );
      }
      const liveBankPreferred = (liveIds?.bank_preferred ?? '').trim().toLowerCase() || null;
      if (liveBankPreferred !== row.to_value.trim().toLowerCase()) {
        return NextResponse.json(
          {
            error:
              'Their Bank Preferred has changed since this approval, so there is nothing to reverse here. Edit it in People → Banking instead.',
          },
          { status: 409 },
        );
      }
      // The restored value obeys the same stateless 1:1 rule as any write. If
      // receiving has since moved onto a wallet, restoring wires is refused —
      // fix the receiving bank in People → Banking first.
      if (!isBankPreferredAllowedForReceiving(liveIds?.preferred_processor ?? null, row.from_value)) {
        return NextResponse.json(
          {
            error: `Restoring ${labelFor(row.from_value)} is not allowed against their current receiving bank (1:1 rule). Fix the receiving bank in People → Banking first.`,
          },
          { status: 400 },
        );
      }

      const { error: updErr } = await supabase
        .from('employee_ids')
        .update({
          bank_preferred: row.from_value,
          bank_last_self_updated_at: nowIso,
          ...(mirroredDisbursementFor(row.from_value)
            ? { preferred_processor: mirroredDisbursementFor(row.from_value) }
            : {}),
        })
        .ilike('work_email', workEmail);
      if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

      invalidateRateProfilesCache();
      await insertBankUpdateHistory({
        work_email: workEmail,
        employee_name: row.employee_name,
        fields: ['bank_preferred'],
        changes: [
          {
            field: 'bank_preferred',
            before: labelFor(row.to_value),
            after: labelFor(row.from_value),
            changed: (row.to_value ?? '') !== (row.from_value ?? ''),
          },
        ],
        processor: row.from_value,
        created_new: false,
        via: 'accounting_edit',
        ip_address: null,
      }).catch(() => undefined);
      await pulseBankChanges().catch(() => undefined);
    }

    const { error: markErr } = await supabase
      .from(TABLE)
      .update({
        status,
        review_notes: reviewNotes,
        reviewed_by: authz.sessionEmail,
        reviewed_at: nowIso,
        applied_at: status === 'approved' ? nowIso : null,
      })
      .eq('id', id);

    if (markErr) return NextResponse.json({ error: markErr.message }, { status: 500 });

    // Notify the employee of the decision. Best-effort. Reuses the existing
    // bank_preferred.decided type — the notifications CHECK rejects new types
    // silently, so no new type is ever minted here.
    try {
      const approved = status === 'approved';
      await supabase.from('employee_notifications').insert({
        recipient_email: workEmail,
        type: 'bank_preferred.decided',
        tone: approved ? 'positive' : 'neutral',
        title: approved
          ? 'Bank Preferred change approved'
          : isRevert
            ? 'Bank Preferred approval reversed'
            : 'Bank Preferred change denied',
        message: approved
          ? `Accounting approved your Bank Preferred change to ${labelFor(row.to_value)}. It's now active.`
          : isRevert
            ? `Accounting reversed the earlier approval of your Bank Preferred change to ${labelFor(row.to_value)}. Your setting is back to ${labelFor(row.from_value)}.${reviewNotes ? ` Note: ${reviewNotes}` : ''}`
            : `Accounting denied your Bank Preferred change to ${labelFor(row.to_value)}. Your current setting is unchanged.${reviewNotes ? ` Note: ${reviewNotes}` : ''}`,
        details: { kind: 'bank_preferred_request', status, from: row.from_value, to: row.to_value, reverted: isRevert || undefined },
      });
    } catch {
      /* notification failure must not fail the decision */
    }

    const actor = await getSessionActor();
    void insertAuditLog({
      user_name: actor.user_name,
      user_role: actor.user_role,
      action: `bank_preferred.request.${status}`,
      resource: TABLE,
      resource_id: id,
      details: {
        work_email: row.work_email,
        from: row.from_value,
        to: row.to_value,
        review_notes: reviewNotes,
        edited: isEdit || undefined,
        reverted: isRevert || undefined,
      },
    });

    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// DELETE /api/bank-preferred-requests/[id]
// Hard-delete the request RECORD. Same role bar as the dispute admin delete
// (DISPUTE_DELETE_ROLES) on top of the Issues-tab feature gate. Deleting NEVER
// touches employee_ids — an applied approval stays applied; reversing it is
// the approved→denied PATCH above. Logged as bank_preferred.request.deleted.
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const authz = await requireFeatureEditAnyView('disputes');
    if (!authz.ok) return deniedResponse(authz);

    const { id } = await params;
    if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });

    const session = await getServerSession(authOptions);
    const user = session?.user as { email?: string | null; roles?: string[] } | undefined;
    const sessionEmail = (user?.email ?? '').toString().trim().toLowerCase();
    const roles = user?.roles ?? [];
    if (!sessionEmail) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
    const allowedRole = roles.find((r) => DISPUTE_DELETE_ROLES.includes(r));
    if (!allowedRole) {
      return NextResponse.json({ error: 'Requires admin or accounting' }, { status: 403 });
    }

    const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
    if (!supabase) return NextResponse.json({ error: 'DB unavailable' }, { status: 500 });

    const { row, error: loadErr } = await getBankPreferredRequestById(id);
    if (loadErr) return NextResponse.json({ error: loadErr }, { status: 500 });
    if (!row) return NextResponse.json({ error: 'Request not found' }, { status: 404 });

    const { error: delErr } = await supabase.from(TABLE).delete().eq('id', id);
    if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 });

    void insertAuditLog({
      user_name: sessionEmail,
      user_role: allowedRole,
      action: 'bank_preferred.request.deleted',
      resource: TABLE,
      resource_id: id,
      details: {
        work_email: row.work_email,
        employee_name: row.employee_name,
        from: row.from_value,
        to: row.to_value,
        status: row.status,
        reviewed_by: row.reviewed_by,
        review_notes: row.review_notes,
        applied_at: row.applied_at,
        created_at: row.created_at,
      },
    });

    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
