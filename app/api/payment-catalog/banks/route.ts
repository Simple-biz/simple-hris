// Payment Catalog -- Pay Processors -> Current Banks.
//
// GET   -> { banks } : every receiving bank our payees have on file, folded to its
//          OFFICIAL name, with how many people are paid into it.
// POST  -> create a registry row for one bank group (logo, name override, aliases).
// PATCH -> edit that row.
//
// **THIS ROUTE READS THREE COLUMNS AND RETURNS COUNTS.** `employee_ids` also holds
// account numbers, SWIFT codes, addresses and wallet emails; none of them is
// projected, and the response carries no per-person rows at all, so there is nothing
// here to leak even if the payload is logged. `banks.test.ts` and the shape guard
// below both pin that. Kane asked for "only the bank name".
//
// Nothing is ever written to `employee_ids`: the free-text column keeps its 129
// spellings, and the normalization lives in the registry (see banks.ts).

import { NextResponse } from 'next/server';
import { deniedResponse, requireRateVisibilitySession } from '@/lib/auth/authorize-email';
import { requireFeatureEdit } from '@/lib/auth/authorize-feature';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { getSessionActor } from '@/lib/auth/session-actor';
import { getEmployeeIds } from '@/lib/supabase/employee-ids';
import {
  applyBankPatch,
  buildBankEntry,
  foldBankSpellings,
  validateBankInput,
  type BankGroup,
  type BankInput,
  type BankRegistryEntry,
  type BankRosterRow,
} from '@/lib/payment-catalog/banks';
import { mutateBankRegistry, readBankRegistry } from '@/lib/payment-catalog/banks-db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Payee rows → the ONLY three fields the fold may see. Written as an explicit
 * projection rather than passing `rows` through, so a column added to
 * `EmployeeIdRow` later cannot silently start riding along into the response.
 */
function toRosterRows(rows: Awaited<ReturnType<typeof getEmployeeIds>>['rows']): BankRosterRow[] {
  return rows.map((r) => ({
    bankName: r.bank_name,
    altBankName: r.alt_bank_name,
    preferredSlot: (r.preferred_bank_slot ?? 'primary') === 'alternative' ? 'alternative' : 'primary',
  }));
}

async function loadGroups(): Promise<{ groups: BankGroup[]; stored: BankRegistryEntry[] }> {
  // `getEmployeeIds` pages past the PostgREST 1000-row cap already — 1,995 rows today,
  // so a bare select would silently drop half the banks.
  const [{ rows, error }, registry] = await Promise.all([getEmployeeIds(), readBankRegistry()]);
  if (error) throw new Error(error);
  return { groups: foldBankSpellings(toRosterRows(rows), registry.stored), stored: registry.stored };
}

export async function GET() {
  // Same read gate as the rest of the Payment Catalog.
  const authz = await requireRateVisibilitySession();
  if (!authz.ok) return deniedResponse(authz);
  try {
    const { groups } = await loadGroups();
    return NextResponse.json({ banks: groups, error: null });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Could not read the bank list';
    return NextResponse.json({ banks: [], error: message }, { status: 500 });
  }
}

function pickInput(body: Record<string, unknown>): BankInput {
  return {
    key: String(body.key ?? ''),
    name: typeof body.name === 'string' ? body.name : undefined,
    aliases: Array.isArray(body.aliases)
      ? body.aliases.filter((a): a is string => typeof a === 'string')
      : undefined,
    kind: body.kind === 'wallet' ? 'wallet' : body.kind === 'bank' ? 'bank' : undefined,
    logo: body.logo === undefined ? undefined : (body.logo as BankInput['logo']),
    notes: typeof body.notes === 'string' ? body.notes : undefined,
  };
}

async function audit(action: string, entry: BankRegistryEntry, extra: Record<string, unknown>) {
  const who = await getSessionActor();
  void insertAuditLog({
    user_name: who.user_name,
    user_role: who.user_role,
    action,
    resource: 'payment_catalog_banks',
    resource_id: entry.key,
    details: {
      name: entry.name,
      kind: entry.kind,
      aliases: entry.aliases,
      has_logo: entry.logo !== null,
      logo_kind: entry.logo?.kind ?? null,
      ...extra,
    },
  }).catch(() => undefined);
}

/** POST and PATCH differ only in whether a row already exists, so they share this. */
async function upsert(request: Request, mode: 'create' | 'edit') {
  const authz = await requireFeatureEdit('accounting', 'bonus_catalog');
  if (!authz.ok) return deniedResponse(authz);
  const actor = authz.sessionEmail;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // Validate against the LIVE group keys: a registry row for a bank nobody banks
  // with would be invisible and unreachable in the tab.
  let groups: BankGroup[];
  try {
    ({ groups } = await loadGroups());
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Could not read the bank list' },
      { status: 500 },
    );
  }
  const check = validateBankInput(body, new Set(groups.map((g) => g.key)));
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: 400 });

  const input = pickInput(body);
  const now = new Date().toISOString();
  let saved: BankRegistryEntry | null = null;
  let created = false;

  const result = await mutateBankRegistry((stored) => {
    const existing = stored.find((e) => e.key === input.key.trim()) ?? null;
    if (mode === 'edit' && !existing) {
      // Editing a bank that has no registry row yet is a CREATE — every group starts
      // without one, and the dialog cannot know which is which.
      created = true;
      saved = buildBankEntry(input, actor, now);
      return [...stored, saved];
    }
    if (existing) {
      saved = applyBankPatch(existing, input, actor, now);
      return [...stored.filter((e) => e.key !== existing.key), saved];
    }
    created = true;
    saved = buildBankEntry(input, actor, now);
    return [...stored, saved];
  });
  if (result.error || !saved) {
    return NextResponse.json(
      { error: result.error ?? 'Save failed' },
      { status: result.conflict ? 409 : 400 },
    );
  }

  await audit(created ? 'bank.create' : 'bank.update', saved, {});

  // Re-fold so the client gets the list the save produced (a new alias moves counts
  // between cards, which the caller cannot compute on its own).
  try {
    const { groups: next } = await loadGroups();
    return NextResponse.json({ bank: saved, banks: next });
  } catch {
    return NextResponse.json({ bank: saved, banks: null });
  }
}

export async function POST(request: Request) {
  return upsert(request, 'create');
}

export async function PATCH(request: Request) {
  return upsert(request, 'edit');
}
