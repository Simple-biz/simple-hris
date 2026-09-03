// Payment Catalog -- Departments.
//
// GET  -> { registry, revision, managers } : the in-app department registry, its
//         revision (app_settings.updated_at — the Edit dialog hands it back so a
//         stale save is refused) plus every active department_managers
//         assignment grouped by department (lower-cased), so the Department tab
//         can label each department's manager(s).
// PATCH -> edits ONE department (see docs/features/payment-catalog-departments.md
//         §6), streaming the same ndjson stage protocol:
//           1. "department" -- the whole entry (name, sub-departments, members)
//                              in ONE compare-and-swap write; 409 when stale
//           2. "managers"   -- department_managers grants diffed against the
//                              previous manager set, under managerGrantLabel()
//           3. "rates"      -- base rates for NEW sub-departments; the own base
//                              rate row of a REMOVED sub-department is deleted
//         The key never changes. A rename files the old name in previousNames.
// POST -> creates a department end-to-end, STREAMING progress as ndjson lines
//         (one JSON CreateDepartmentEvent per line) so the wizard's staged
//         loading animation tracks real work, not a timer:
//           1. "department" -- registry entry (name + sub-departments)
//           2. "managers"   -- manager member records + department_managers grants
//           3. "members"    -- remaining member records
//           4. "rates"      -- department-scoped Payment Catalog pay structure
//
// SELF-CONTAINED: in-app departments do NOT depend on the Global Master List.
// People are stored as member records on the registry entry itself (a JSON
// blob in app_settings -- see src/lib/departments/registry.ts); nothing here
// reads or writes global_master_list or the master Google Sheet. The only
// outward writes are department_managers oversight grants and the Payment
// Catalog pay structure -- neither is the master list.
//
// Every step is idempotent, so a failed run can simply be retried: the registry
// upserts by key, member merges key on work email, manager grants no-op, and
// the rate upsert reuses the department structure's id.

import { NextResponse } from 'next/server';
import { deniedResponse, requireRateVisibilitySession } from '@/lib/auth/authorize-email';
import { requireFeatureEdit } from '@/lib/auth/authorize-feature';
import {
  assignManagerDepartment,
  listAllDepartmentManagers,
  revokeManagerDepartment,
} from '@/lib/supabase/department-managers';
import { deletePayStructure, listPayStructures, upsertPayStructure } from '@/lib/supabase/pay-structures-db';
import { newPayId, type PayStructure } from '@/lib/payment-catalog/pay-structure';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { getSessionActor } from '@/lib/auth/session-actor';
import { DEPARTMENTS } from '@/lib/payroll/department-bonus';
import { normalizeDeptToKey } from '@/lib/payroll/normalize-dept-key';
import {
  applyDepartmentEdit,
  diffBuiltinManagers,
  diffDepartmentEdit,
  validateBuiltinManagersInput,
  type BuiltinManagersEvent,
  type BuiltinManagersInput,
  managerGrantLabel,
  slugifyDeptKey,
  subDeptStructureKey,
  validateCreateDepartmentInput,
  validateEditDepartmentInput,
  type CreateDepartmentEvent,
  type CreateDepartmentInput,
  type CreateDepartmentStageKey,
  type DepartmentMemberRecord,
  type DepartmentRegistryEntry,
  type EditDepartmentEvent,
  type EditDepartmentInput,
  type NewDepartmentMember,
} from '@/lib/departments/registry';
import {
  getDepartmentRegistry,
  getDepartmentRegistryWithRevision,
  mergeDepartmentMembers,
  replaceDepartmentRegistryEntry,
  upsertDepartmentRegistryEntry,
} from '@/lib/departments/registry-db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  // Same read gate as the pay structures this tab sits beside.
  const authz = await requireRateVisibilitySession();
  if (!authz.ok) return deniedResponse(authz);

  let registry: DepartmentRegistryEntry[];
  let revision: string | null;
  try {
    ({ registry, revision } = await getDepartmentRegistryWithRevision());
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Could not read the department registry';
    return NextResponse.json({ registry: [], revision: null, managers: {}, error: message }, { status: 500 });
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
  return NextResponse.json({ registry, revision, managers, error: error ?? null });
}

/** Wizard member -> stored registry record (normalized emails + attribution). */
function toMemberRecord(m: NewDepartmentMember, actor: string): DepartmentMemberRecord {
  return {
    name: m.name.trim(),
    workEmail: m.workEmail.trim().toLowerCase(),
    personalEmail: m.personalEmail?.trim().toLowerCase() || null,
    isManager: m.isManager,
    subDepartment: m.subDepartment ?? null,
    startDate: m.startDate ?? null,
    addedBy: actor,
    addedAt: new Date().toISOString(),
  };
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

  // Resolve the registry before streaming, while a clean 4xx/5xx is possible.
  // An existing entry with this key means a retry / re-run, which is safe end
  // to end (everything below merges idempotently).
  let registry: DepartmentRegistryEntry[];
  try {
    registry = await getDepartmentRegistry();
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Could not read the department registry';
    return NextResponse.json({ error: message }, { status: 500 });
  }
  const existingEntry = registry.find((entry) => entry.key === key) ?? null;

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
        // -- Stage 1: the department itself ---------------------------------
        emit({ type: 'stage', stage: 'department', status: 'start' });
        const subUnits = input.subDepartments.map((sub) => ({
          key: slugifyDeptKey(sub.name),
          name: sub.name.trim(),
        }));
        const mergedSubs = [...(existingEntry?.subDepartments ?? [])];
        for (const sub of subUnits) {
          if (!mergedSubs.some((s) => s.key === sub.key)) mergedSubs.push(sub);
        }
        const entry: DepartmentRegistryEntry = {
          key,
          name: existingEntry?.name ?? name,
          subDepartments: mergedSubs,
          // Members land in stages 2 + 3; a retry keeps the ones already there.
          members: existingEntry?.members ?? [],
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
        const managerMerge = await mergeDepartmentMembers(
          key,
          managers.map((m) => toMemberRecord(m, actor)),
        );
        if (managerMerge.error) return fail('managers', managerMerge.error);
        for (const member of managers) {
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
        if (others.length > 0) {
          const memberMerge = await mergeDepartmentMembers(
            key,
            others.map((m) => toMemberRecord(m, actor)),
          );
          if (memberMerge.error) return fail('members', memberMerge.error);
        }
        emit({
          type: 'stage',
          stage: 'members',
          status: 'done',
          note: others.length > 0 ? `${others.length} member${others.length === 1 ? '' : 's'}` : 'no additional members',
        });

        // -- Stage 4: pay structures -----------------------------------------
        // Flat department: one department-scoped structure keyed on the dept
        // key. With sub-departments, base rates live on each sub-department
        // instead — one structure per sub, keyed `<parentKey>:<subKey>`
        // (validation guarantees the parent rate is null in that case).
        emit({ type: 'stage', stage: 'rates', status: 'start' });
        let rateSet = false;
        let subRatesSet = 0;
        const ratedSubs = input.subDepartments.filter((s) => s.payStructure);
        if (input.payStructure || ratedSubs.length > 0) {
          // Department-scoped structures are unique per key (partial unique
          // index) -- reuse ids on a retry instead of colliding.
          const { structures, error: listErr } = await listPayStructures();
          if (listErr) return fail('rates', listErr);
          const existingIdFor = (structureKey: string) =>
            structures.find((s) => s.scope === 'department' && s.departmentKey === structureKey)?.id;
          if (input.payStructure) {
            const structure: PayStructure = {
              id: existingIdFor(key) ?? newPayId(),
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
          for (const rated of ratedSubs) {
            const subKey = subDeptStructureKey(key, slugifyDeptKey(rated.name));
            const structure: PayStructure = {
              id: existingIdFor(subKey) ?? newPayId(),
              scope: 'department',
              departmentKey: subKey,
              regularRate: rated.payStructure!.regularRate,
              otRate: rated.payStructure!.otRate,
              currency: rated.payStructure!.currency,
            };
            const { error: rateErr } = await upsertPayStructure(structure, actor);
            if (rateErr) return fail('rates', `${rated.name.trim()}: ${rateErr}`);
            subRatesSet += 1;
          }
        }
        emit({
          type: 'stage',
          stage: 'rates',
          status: 'done',
          note:
            subRatesSet > 0
              ? `${subRatesSet} sub-department rate${subRatesSet === 1 ? '' : 's'}`
              : rateSet
                ? undefined
                : 'skipped -- set it any time in Pay Structure',
        });

        // Audit trail (best-effort, never fails the creation).
        const whoActor = await getSessionActor();
        void insertAuditLog({
          user_name: whoActor.user_name,
          user_role: whoActor.user_role,
          action: 'department.create',
          resource: 'payment_catalog_departments',
          resource_id: key,
          details: {
            department: entry.name,
            sub_departments: entry.subDepartments.map((s) => s.name),
            managers: managers.map((m) => m.workEmail.trim().toLowerCase()),
            members: others.map((m) => m.workEmail.trim().toLowerCase()),
            rate_set: rateSet,
            sub_rates_set: ratedSubs.map((s) => s.name.trim()),
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
            subRatesSet,
            warnings: [],
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

/** Shared response headers for the ndjson stage stream. */
const NDJSON_HEADERS = {
  'Content-Type': 'application/x-ndjson; charset=utf-8',
  'Cache-Control': 'no-store',
  // Defensive: some proxies buffer streamed responses without this.
  'X-Accel-Buffering': 'no',
};

/** The message a stale save gets, everywhere it can surface. */
const STALE_EDIT_MESSAGE = 'This department changed since you opened it. Reload and try again.';

export async function PATCH(request: Request) {
  const authz = await requireFeatureEdit('accounting', 'bonus_catalog');
  if (!authz.ok) return deniedResponse(authz);
  const actor = authz.sessionEmail;

  let input: EditDepartmentInput;
  try {
    input = (await request.json()) as EditDepartmentInput;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  // A master-list department: only its manager grants are editable (§7).
  if (input && typeof (input as unknown as BuiltinManagersInput).builtinKey === 'string') {
    return patchBuiltinManagers(input as unknown as BuiltinManagersInput, actor);
  }
  if (
    !input ||
    typeof input.key !== 'string' ||
    typeof input.name !== 'string' ||
    !Array.isArray(input.subDepartments) ||
    !Array.isArray(input.members)
  ) {
    return NextResponse.json({ error: 'Malformed edit payload' }, { status: 400 });
  }

  // Resolve the registry before streaming, while a clean 4xx/5xx is possible.
  let loaded: { registry: DepartmentRegistryEntry[]; revision: string | null };
  try {
    loaded = await getDepartmentRegistryWithRevision();
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Could not read the department registry';
    return NextResponse.json({ error: message }, { status: 500 });
  }
  const existing = loaded.registry.find((entry) => entry.key === input.key) ?? null;
  if (!existing) {
    return NextResponse.json({ error: 'That department is no longer in the registry.' }, { status: 404 });
  }
  if ((input.expectedRevision ?? null) !== (loaded.revision ?? null)) {
    return NextResponse.json({ error: STALE_EDIT_MESSAGE, conflict: true }, { status: 409 });
  }
  const check = validateEditDepartmentInput(input, existing, loaded.registry);
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: 400 });

  const diff = diffDepartmentEdit(existing, input);
  const nowIso = new Date().toISOString();
  const next = applyDepartmentEdit(existing, input, actor, nowIso);
  // Grants live under the label whose slug IS the key (the original name) —
  // manager surfaces slug the grant string to find the department, so this must
  // not follow a rename. `existing` and `next` agree (the old name is filed in
  // next.previousNames); read it off `existing` for clarity.
  const grantLabel = managerGrantLabel(existing);
  const key = existing.key;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: EditDepartmentEvent) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };
      const fail = (stage: CreateDepartmentStageKey, message: string) => {
        emit({ type: 'error', stage, message });
        controller.close();
      };

      try {
        // -- Stage 1: the entry, in one CAS write ---------------------------
        emit({ type: 'stage', stage: 'department', status: 'start' });
        const saved = await replaceDepartmentRegistryEntry(next, loaded.revision);
        if (saved.conflict) return fail('department', STALE_EDIT_MESSAGE);
        if (!saved.ok) return fail('department', saved.error ?? 'Could not save the department');
        const deptNotes: string[] = [];
        if (diff.renamed) deptNotes.push(`renamed to ${diff.renamed.to}`);
        if (diff.subsAdded.length) deptNotes.push(`+${diff.subsAdded.length} sub-dept`);
        if (diff.subsRemoved.length) deptNotes.push(`-${diff.subsRemoved.length} sub-dept`);
        if (diff.membersAdded.length) deptNotes.push(`+${diff.membersAdded.length} people`);
        if (diff.membersRemoved.length) deptNotes.push(`-${diff.membersRemoved.length} people`);
        emit({
          type: 'stage',
          stage: 'department',
          status: 'done',
          note: deptNotes.length > 0 ? deptNotes.join(' · ') : 'no structural change',
        });

        // -- Stage 2: manager grants, diffed ---------------------------------
        emit({ type: 'stage', stage: 'managers', status: 'start' });
        for (const email of diff.managersRevoked) {
          const res = await revokeManagerDepartment({ manager_email: email, department: grantLabel });
          if (res.error) return fail('managers', `${email}: could not revoke manager access: ${res.error}`);
        }
        for (const email of diff.managersGranted) {
          const res = await assignManagerDepartment({
            manager_email: email,
            department: grantLabel,
            assigned_by: actor,
          });
          if (res.error) return fail('managers', `${email}: manager grant failed: ${res.error}`);
        }
        emit({
          type: 'stage',
          stage: 'managers',
          status: 'done',
          note:
            diff.managersGranted.length + diff.managersRevoked.length === 0
              ? 'unchanged'
              : `+${diff.managersGranted.length} / -${diff.managersRevoked.length}`,
        });

        // -- Stage 3: base rates -------------------------------------------
        // New sub-departments may carry an initial base rate (as in Create); a
        // removed sub-department's OWN dept-scope row is deleted so no orphaned
        // `<key>:<sub>` structure lingers (Kane, 2026-09-03). Existing subs'
        // rates are never touched here — Pay Structure is their write path.
        emit({ type: 'stage', stage: 'rates', status: 'start' });
        let ratesSet = 0;
        let ratesDeleted = 0;
        const warnings: string[] = [];
        const ratedNew = input.subDepartments.filter((s) => s.key == null && s.payStructure);
        const needStructures = ratedNew.length > 0 || diff.subsRemoved.length > 0 || (existing.subDepartments.length === 0 && next.subDepartments.length > 0);
        if (needStructures) {
          const { structures, error: listErr } = await listPayStructures();
          if (listErr) return fail('rates', listErr);
          const existingFor = (structureKey: string) =>
            structures.find((s) => s.scope === 'department' && s.departmentKey === structureKey);
          for (const removed of diff.subsRemoved) {
            const row = existingFor(subDeptStructureKey(key, removed.key));
            if (!row) continue;
            const { error: delErr } = await deletePayStructure(row.id);
            if (delErr) return fail('rates', `${removed.name}: could not delete its base rate: ${delErr}`);
            ratesDeleted += 1;
          }
          for (const sub of ratedNew) {
            const structureKey = subDeptStructureKey(key, slugifyDeptKey(sub.name));
            const structure: PayStructure = {
              id: existingFor(structureKey)?.id ?? newPayId(),
              scope: 'department',
              departmentKey: structureKey,
              regularRate: sub.payStructure!.regularRate,
              otRate: sub.payStructure!.otRate,
              currency: sub.payStructure!.currency,
            };
            const { error: rateErr } = await upsertPayStructure(structure, actor);
            if (rateErr) return fail('rates', `${sub.name.trim()}: ${rateErr}`);
            ratesSet += 1;
          }
          // A flat department that just gained sub-departments may still carry a
          // department-wide rate. Create refuses that combination; an edit keeps
          // the row (it is the fallback for unpriced subs) and says so.
          if (existing.subDepartments.length === 0 && next.subDepartments.length > 0) {
            const parentRow = existingFor(key);
            if (parentRow) {
              warnings.push(
                `${next.name} keeps its department-wide rate (${parentRow.currency} ${parentRow.regularRate}/hr) as the fallback for sub-departments without their own rate. Remove it in Pay Structure if you don't want that.`,
              );
            }
          }
        }
        emit({
          type: 'stage',
          stage: 'rates',
          status: 'done',
          note:
            ratesSet + ratesDeleted === 0
              ? 'unchanged'
              : [ratesSet > 0 ? `${ratesSet} set` : null, ratesDeleted > 0 ? `${ratesDeleted} removed` : null]
                  .filter(Boolean)
                  .join(' · '),
        });

        // Audit trail (best-effort, never fails the save).
        const whoActor = await getSessionActor();
        void insertAuditLog({
          user_name: whoActor.user_name,
          user_role: whoActor.user_role,
          action: 'department.update',
          resource: 'payment_catalog_departments',
          resource_id: key,
          details: {
            department: next.name,
            renamed: diff.renamed,
            grant_label: grantLabel,
            sub_departments_added: diff.subsAdded.map((s) => s.name),
            sub_departments_renamed: diff.subsRenamed,
            sub_departments_removed: diff.subsRemoved.map((s) => s.name),
            members_added: diff.membersAdded,
            members_removed: diff.membersRemoved,
            managers_granted: diff.managersGranted,
            managers_revoked: diff.managersRevoked,
            sub_reassigned: diff.subReassigned,
            rates_set: ratesSet,
            rates_deleted: ratesDeleted,
          },
        }).catch(() => undefined);

        emit({
          type: 'done',
          summary: { key, name: next.name, diff, ratesSet, ratesDeleted, warnings },
        });
        controller.close();
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Saving the department failed';
        try {
          emit({ type: 'error', stage: 'department', message });
          controller.close();
        } catch {
          /* stream already closed */
        }
      }
    },
  });

  return new Response(stream, { headers: NDJSON_HEADERS });
}

/**
 * PATCH { builtinKey, managers } -- the manager set of a BUILT-IN department.
 *
 * "Current" is every active department_managers row whose raw label normalizes
 * to the key (Admin Roles writes whatever label the picker offered -- "Lead
 * Gen", "Lead Generation" -- so aliases must count, or a removal would leave a
 * ghost grant that still lights the manager's dashboard). Revocation therefore
 * hits EVERY raw-label variant the person holds for this key; new grants are
 * written under the built-in display name. HSL is refused by the validator: its
 * grants are per-sub-team access keys, not department management.
 */
async function patchBuiltinManagers(input: BuiltinManagersInput, actor: string): Promise<Response> {
  const check = validateBuiltinManagersInput(input);
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: 400 });
  const key = input.builtinKey.trim();
  const dept = DEPARTMENTS.find((d) => d.key === key);
  if (!dept) return NextResponse.json({ error: 'That is not a built-in department.' }, { status: 400 });

  const { rows, error: listErr } = await listAllDepartmentManagers();
  if (listErr) return NextResponse.json({ error: listErr }, { status: 500 });
  const currentRows = rows.filter((r) => normalizeDeptToKey(r.department) === key);
  const current = currentRows.map((r) => r.manager_email.trim().toLowerCase());
  const next = input.managers.map((m) => m.workEmail.trim().toLowerCase());
  const diff = diffBuiltinManagers(current, next);
  const nameFor = new Map(input.managers.map((m) => [m.workEmail.trim().toLowerCase(), m.name.trim()] as const));

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: BuiltinManagersEvent) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };
      const fail = (message: string) => {
        emit({ type: 'error', stage: 'managers', message });
        controller.close();
      };
      try {
        emit({ type: 'stage', stage: 'managers', status: 'start' });
        for (const email of diff.revoked) {
          // Every raw-label variant this person holds for the key.
          const labels = new Set(
            currentRows.filter((r) => r.manager_email.trim().toLowerCase() === email).map((r) => r.department.trim()),
          );
          for (const label of labels) {
            const res = await revokeManagerDepartment({ manager_email: email, department: label });
            if (res.error) return fail(`${email}: could not revoke manager access: ${res.error}`);
          }
        }
        for (const email of diff.granted) {
          const res = await assignManagerDepartment({ manager_email: email, department: dept.name, assigned_by: actor });
          if (res.error) return fail(`${nameFor.get(email) || email}: manager grant failed: ${res.error}`);
        }
        emit({
          type: 'stage',
          stage: 'managers',
          status: 'done',
          note: diff.changed ? `+${diff.granted.length} / -${diff.revoked.length}` : 'unchanged',
        });

        const whoActor = await getSessionActor();
        void insertAuditLog({
          user_name: whoActor.user_name,
          user_role: whoActor.user_role,
          action: 'department.managers.update',
          resource: 'department_managers',
          resource_id: key,
          details: {
            department: dept.name,
            managers_granted: diff.granted,
            managers_revoked: diff.revoked,
            resulting_managers: next,
          },
        }).catch(() => undefined);

        emit({
          type: 'done',
          summary: { key, name: dept.name, granted: diff.granted, revoked: diff.revoked, warnings: [] },
        });
        controller.close();
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Updating manager access failed';
        try {
          emit({ type: 'error', stage: 'managers', message });
          controller.close();
        } catch {
          /* stream already closed */
        }
      }
    },
  });
  return new Response(stream, { headers: NDJSON_HEADERS });
}
