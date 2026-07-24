// Payment Catalog -- Departments.
//
// GET  -> { registry, managers } : the custom-department registry plus every
//         active department_managers assignment grouped by department (lower-
//         cased), so the Department tab can label each department's manager(s).
// POST -> creates a department end-to-end, STREAMING progress as ndjson lines
//         (one JSON CreateDepartmentEvent per line) so the wizard's staged
//         loading animation tracks real work, not a timer:
//           1. "department" -- registry entry (name + sub-departments)
//           2. "managers"   -- master-list rows + department_managers grants
//           3. "members"    -- master-list rows
//           4. "rates"      -- department-scoped Payment Catalog pay structure
//
// Master-list writes reuse the two battle-tested paths:
//   - existing people MOVE via applyDepartmentTransfer (same engine as the
//     Transfers feature: target-dept reconcile, unique-index safe) + the master
//     Google Sheet department write-back;
//   - new people INSERT mirroring promoteHrPendingEmployee's payload (upload-id
//     stamping so they appear in active_employees, surname-first display name,
//     idempotent (Work Email, Department) reuse) + the master Sheet append so
//     the next Sheet sync doesn't retire them.
//
// Every step is idempotent, so a failed run can simply be retried: the registry
// upserts by key, moves resolve as 'satisfied', inserts reuse the existing row,
// manager grants no-op, and the rate upsert reuses the dept structure's id.

import { NextResponse } from 'next/server';
import { deniedResponse, requireRateVisibilitySession } from '@/lib/auth/authorize-email';
import { requireFeatureEdit } from '@/lib/auth/authorize-feature';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { getCurrentMasterListUploadId } from '@/lib/supabase/global-master-list-db';
import { escapeLikePattern } from '@/lib/db/like-escape';
import { masterListDisplayName } from '@/lib/name/display-name';
import { applyDepartmentTransfer } from '@/lib/supabase/department-transfer-requests';
import { manilaTodayIso } from '@/lib/transfers/apply-transfer';
import { updateMasterSheetDepartment } from '@/lib/google-sheets/update-master-sheet-department';
import { appendMasterSheetRow } from '@/lib/google-sheets/append-master-sheet';
import { sheetWriteSucceeded } from '@/lib/supabase/hr-pending-employees';
import {
  assignManagerDepartment,
  listAllDepartmentManagers,
} from '@/lib/supabase/department-managers';
import { listPayStructures, upsertPayStructure } from '@/lib/supabase/pay-structures-db';
import { newPayId, type PayStructure } from '@/lib/payment-catalog/pay-structure';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { getSessionActor } from '@/lib/auth/session-actor';
import {
  slugifyDeptKey,
  validateCreateDepartmentInput,
  type CreateDepartmentEvent,
  type CreateDepartmentInput,
  type CreateDepartmentStageKey,
  type DepartmentRegistryEntry,
  type NewDepartmentMember,
} from '@/lib/departments/registry';
import {
  getDepartmentRegistry,
  upsertDepartmentRegistryEntry,
} from '@/lib/departments/registry-db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MASTER_TABLE = process.env.NEXT_PUBLIC_SUPABASE_EMPLOYEES_TABLE?.trim() || 'global_master_list';

export async function GET() {
  // Same read gate as the pay structures this tab sits beside.
  const authz = await requireRateVisibilitySession();
  if (!authz.ok) return deniedResponse(authz);

  let registry: DepartmentRegistryEntry[];
  try {
    registry = await getDepartmentRegistry();
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Could not read the department registry';
    return NextResponse.json({ registry: [], managers: {}, error: message }, { status: 500 });
  }

  const { rows, error } = await listAllDepartmentManagers();
  const managers: Record<string, string[]> = {};
  for (const row of rows) {
    const dept = row.department.trim().toLowerCase();
    if (!dept) continue;
    const email = row.manager_email.trim().toLowerCase();
    if (!email) continue;
    (managers[dept] ??= []).push(email);
  }
  return NextResponse.json({ registry, managers, error: error ?? null });
}

/** Distinct ACTIVE roster department strings (lower-cased) -- conflict check.
 *  Paged: an unfiltered select silently caps at 1000 rows, which would hide
 *  departments living on later rows and let a duplicate name through. */
async function listActiveDepartmentNames(): Promise<Set<string>> {
  const supabase = createSupabaseServiceRoleClient();
  const out = new Set<string>();
  if (!supabase) return out;
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('active_employees')
      .select('Department')
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`Could not read active departments: ${error.message}`);
    const rows = (data ?? []) as Array<{ Department: string | null }>;
    for (const row of rows) {
      const dept = (row.Department ?? '').trim().toLowerCase();
      if (dept) out.add(dept);
    }
    if (rows.length < PAGE) break;
  }
  return out;
}

type MemberOutcome = { warning?: string; error?: string };

/** Lands one member's master-list row in the new department (move or insert),
 *  plus the matching best-effort Google Sheet write so the next Sheet sync
 *  keeps them. Idempotent per member. */
async function ensureMemberRow(params: {
  member: NewDepartmentMember;
  deptName: string;
  uploadId: string | null;
}): Promise<MemberOutcome> {
  const { member, deptName, uploadId } = params;
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { error: 'Supabase not configured' };

  const workEmail = member.workEmail.trim().toLowerCase();
  const personalEmail = member.personalEmail?.trim().toLowerCase() || null;
  const who = member.name.trim() || workEmail;

  // Existing roster people transfer in. If the roster row has vanished since
  // the wizard loaded (off-board race), fall through to a fresh insert below --
  // we hold everything an insert needs.
  if (member.kind === 'existing') {
    const moved = await applyDepartmentTransfer({
      personalEmail,
      workEmail,
      fromDepartment: member.currentDepartment ?? '',
      toDepartment: deptName,
    });
    if (moved.error) return { error: `${who}: ${moved.error}` };
    if (moved.resolution !== 'notFound') {
      if (moved.resolution === 'satisfied') return {};
      try {
        const sheet = await updateMasterSheetDepartment({
          personalEmail,
          workEmail,
          fromDepartment: member.currentDepartment ?? '',
          toDepartment: deptName,
        });
        if (sheet.updated === 0) {
          return {
            warning: `${who}: moved on the master list, but the Google Sheet row was not updated (${sheet.reason ?? 'no matching row'}) -- fix the Sheet's Department cell so the next sync doesn't undo the move.`,
          };
        }
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        return {
          warning: `${who}: moved on the master list, but the Google Sheet write failed (${reason}).`,
        };
      }
      return {};
    }
  }

  // Fresh master-list row (kind 'new', or an 'existing' pick that no longer
  // resolves on the roster).
  if (!uploadId) {
    return {
      error: `${who}: no current master-list upload found, so a new row would be invisible. Run a master-list sync first.`,
    };
  }

  const { data: existingRow, error: lookupErr } = await supabase
    .from(MASTER_TABLE)
    .select('id')
    .ilike('Work Email', escapeLikePattern(workEmail))
    .ilike('Department', escapeLikePattern(deptName))
    .limit(1)
    .maybeSingle();
  if (lookupErr) return { error: `${who}: master lookup failed: ${lookupErr.message}` };

  if (existingRow) {
    // Re-run after a partial failure: the row is already there -- just make
    // sure it's attached to the current upload so it stays visible.
    const { error: touchErr } = await supabase
      .from(MASTER_TABLE)
      .update({ last_seen_upload_id: uploadId })
      .eq('id', (existingRow as { id: string }).id);
    if (touchErr) return { error: `${who}: master update failed: ${touchErr.message}` };
  } else {
    const payload: Record<string, unknown> = {
      Department: deptName,
      // Surname-first, nickname-quoted -- the same format every other master
      // list writer uses (see promoteHrPendingEmployee).
      Name: masterListDisplayName(member.name),
      'Personal Email': personalEmail,
      'Work Email': workEmail,
      'Start Date': member.startDate ?? manilaTodayIso(),
      first_seen_upload_id: uploadId,
      last_seen_upload_id: uploadId,
      source_file: 'payment_catalog_department_create',
    };
    const { error: insertErr } = await supabase.from(MASTER_TABLE).insert(payload);
    if (insertErr) return { error: `${who}: master insert failed: ${insertErr.message}` };
  }

  // Master Google Sheet append (best-effort): without it the next Sheet ->
  // Supabase sync would retire the row from active_employees.
  try {
    const sheet = await appendMasterSheetRow({
      name: masterListDisplayName(member.name),
      personalEmail: personalEmail ?? '',
      workEmail,
      department: deptName,
      startDate: member.startDate ?? manilaTodayIso(),
    });
    if (!sheetWriteSucceeded(sheet)) {
      return {
        warning: `${who}: added to the master list, but the Google Sheet append failed (${sheet.reason ?? 'unknown'}) -- add them to the Sheet so the next sync keeps them.`,
      };
    }
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return {
      warning: `${who}: added to the master list, but the Google Sheet append failed (${reason}).`,
    };
  }
  return {};
}

export async function POST(request: Request) {
  const authz = await requireFeatureEdit('accounting', 'bonus_catalog');
  if (!authz.ok) return deniedResponse(authz);
  const actor = authz.sessionEmail;

  let input: CreateDepartmentInput;
  try {
    input = (await request.json()) as CreateDepartmentInput;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const check = validateCreateDepartmentInput(input);
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: 400 });

  const name = input.name.trim();
  const key = slugifyDeptKey(name);

  // Everything below streams, so resolve the cheap conflict/prereq checks
  // first while a clean 4xx is still possible.
  let registry: DepartmentRegistryEntry[];
  try {
    registry = await getDepartmentRegistry();
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Could not read the department registry';
    return NextResponse.json({ error: message }, { status: 500 });
  }
  const existingEntry = registry.find((entry) => entry.key === key) ?? null;

  try {
    const activeDepts = await listActiveDepartmentNames();
    // A roster department we did NOT create is a real conflict; our own entry
    // just means this is a retry / re-run, which is safe end to end.
    if (!existingEntry && activeDepts.has(name.toLowerCase())) {
      return NextResponse.json(
        { error: `"${name}" already exists on the Global Master List.` },
        { status: 409 },
      );
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Could not check existing departments';
    return NextResponse.json({ error: message }, { status: 500 });
  }

  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) {
    return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });
  }
  const uploadId = await getCurrentMasterListUploadId(supabase);
  if (!uploadId && input.members.some((m) => m.kind === 'new')) {
    return NextResponse.json(
      {
        error:
          'No current master-list upload found -- new people would be invisible on the roster. Run a master-list sync first, then retry.',
      },
      { status: 409 },
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: CreateDepartmentEvent) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };
      const fail = (stage: CreateDepartmentStageKey, message: string) => {
        emit({ type: 'error', stage, message });
        controller.close();
      };

      try {
        const warnings: string[] = [];

        // -- Stage 1: the department itself ---------------------------------
        emit({ type: 'stage', stage: 'department', status: 'start' });
        const subUnits = input.subDepartments.map((subName) => ({
          key: slugifyDeptKey(subName),
          name: subName.trim(),
        }));
        const memberSubDepartments: Record<string, string> = {
          ...(existingEntry?.memberSubDepartments ?? {}),
        };
        for (const m of input.members) {
          if (m.subDepartment) {
            memberSubDepartments[m.workEmail.trim().toLowerCase()] = m.subDepartment;
          }
        }
        const mergedSubs = [...(existingEntry?.subDepartments ?? [])];
        for (const sub of subUnits) {
          if (!mergedSubs.some((s) => s.key === sub.key)) mergedSubs.push(sub);
        }
        const entry: DepartmentRegistryEntry = {
          key,
          name: existingEntry?.name ?? name,
          subDepartments: mergedSubs,
          memberSubDepartments,
          createdBy: existingEntry?.createdBy ?? actor,
          createdAt: existingEntry?.createdAt ?? new Date().toISOString(),
        };
        const saved = await upsertDepartmentRegistryEntry(entry);
        if (saved.error) return fail('department', saved.error);
        emit({
          type: 'stage',
          stage: 'department',
          status: 'done',
          note: subUnits.length > 0 ? `${subUnits.length} sub-departments` : undefined,
        });

        // -- Stages 2 + 3: people --------------------------------------------
        const managers = input.members.filter((m) => m.isManager);
        const others = input.members.filter((m) => !m.isManager);

        emit({ type: 'stage', stage: 'managers', status: 'start' });
        for (const member of managers) {
          const outcome = await ensureMemberRow({ member, deptName: entry.name, uploadId });
          if (outcome.error) return fail('managers', outcome.error);
          if (outcome.warning) warnings.push(outcome.warning);
          const grant = await assignManagerDepartment({
            manager_email: member.workEmail,
            department: entry.name,
            assigned_by: actor,
          });
          if (grant.error) {
            return fail('managers', `${member.name.trim() || member.workEmail}: manager grant failed: ${grant.error}`);
          }
        }
        emit({
          type: 'stage',
          stage: 'managers',
          status: 'done',
          note: `${managers.length} manager${managers.length === 1 ? '' : 's'}`,
        });

        emit({ type: 'stage', stage: 'members', status: 'start' });
        for (const member of others) {
          const outcome = await ensureMemberRow({ member, deptName: entry.name, uploadId });
          if (outcome.error) return fail('members', outcome.error);
          if (outcome.warning) warnings.push(outcome.warning);
        }
        emit({
          type: 'stage',
          stage: 'members',
          status: 'done',
          note: others.length > 0 ? `${others.length} member${others.length === 1 ? '' : 's'}` : 'no additional members',
        });

        // -- Stage 4: pay structure ------------------------------------------
        emit({ type: 'stage', stage: 'rates', status: 'start' });
        let rateSet = false;
        if (input.payStructure) {
          // One department-scoped structure per department (partial unique
          // index) -- reuse its id on a retry instead of colliding.
          const { structures, error: listErr } = await listPayStructures();
          if (listErr) return fail('rates', listErr);
          const existingStructure = structures.find(
            (s) => s.scope === 'department' && s.departmentKey === key,
          );
          const structure: PayStructure = {
            id: existingStructure?.id ?? newPayId(),
            scope: 'department',
            departmentKey: key,
            regularRate: input.payStructure.regularRate,
            otRate: input.payStructure.otRate,
            currency: input.payStructure.currency,
          };
          const { error: rateErr } = await upsertPayStructure(structure, actor);
          if (rateErr) return fail('rates', rateErr);
          rateSet = true;
        }
        emit({
          type: 'stage',
          stage: 'rates',
          status: 'done',
          note: rateSet ? undefined : 'skipped -- set it any time in Pay Structure',
        });

        // Audit trail (best-effort, never fails the creation).
        const whoActor = await getSessionActor();
        void insertAuditLog({
          user_name: whoActor.user_name,
          user_role: whoActor.user_role,
          action: 'department.create',
          resource: 'global_master_list',
          resource_id: key,
          details: {
            department: entry.name,
            sub_departments: entry.subDepartments.map((s) => s.name),
            managers: managers.map((m) => m.workEmail.trim().toLowerCase()),
            members: others.map((m) => m.workEmail.trim().toLowerCase()),
            rate_set: rateSet,
            warnings,
          },
        }).catch(() => undefined);

        emit({
          type: 'done',
          summary: {
            key,
            name: entry.name,
            managersAdded: managers.length,
            membersAdded: others.length,
            rateSet,
            warnings,
          },
        });
        controller.close();
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Department creation failed';
        try {
          emit({ type: 'error', stage: 'department', message });
          controller.close();
        } catch {
          /* stream already closed */
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
      // Defensive: some proxies buffer streamed responses without this.
      'X-Accel-Buffering': 'no',
    },
  });
}
