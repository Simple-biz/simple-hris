// Payment Catalog -- Departments.
//
// GET  -> { registry, managers } : the in-app department registry plus every
//         active department_managers assignment grouped by department (lower-
//         cased), so the Department tab can label each department's manager(s).
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
  type DepartmentMemberRecord,
  type DepartmentRegistryEntry,
  type NewDepartmentMember,
} from '@/lib/departments/registry';
import {
  getDepartmentRegistry,
  mergeDepartmentMembers,
  upsertDepartmentRegistryEntry,
} from '@/lib/departments/registry-db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

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
        const subUnits = input.subDepartments.map((subName) => ({
          key: slugifyDeptKey(subName),
          name: subName.trim(),
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
          resource: 'payment_catalog_departments',
          resource_id: key,
          details: {
            department: entry.name,
            sub_departments: entry.subDepartments.map((s) => s.name),
            managers: managers.map((m) => m.workEmail.trim().toLowerCase()),
            members: others.map((m) => m.workEmail.trim().toLowerCase()),
            rate_set: rateSet,
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
