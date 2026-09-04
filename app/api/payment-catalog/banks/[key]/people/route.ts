// Payment Catalog -- Current Banks -> who banks here.
//
// GET /api/payment-catalog/banks/<key>/people -> { people } : everyone whose bank
// cells land in this one bank, with their name, work email, which slot it sits on,
// the spelling on their own record, and whether they have left.
//
// **LAZY BY DESIGN.** The bank LIST endpoint still returns groups with counts and no
// per-person row at all; names travel only when somebody opens one specific bank.
// That keeps the cheap, always-fetched payload identity-free and makes the one path
// that does carry people an explicit, auditable request.
//
// **STILL NO ACCOUNT DATA.** `employee_ids` also holds account numbers, SWIFT codes,
// routing numbers, addresses and wallet emails. This route projects five columns --
// name, work email, and the three bank-shape columns -- and returns exactly those
// four fields per person. `bank-preferred-routing.md` is absolute about the receiving
// account, and the audited reveal-banking endpoint remains the only path to a full
// number.
//
// **Leavers are included** here, matching the count on the card (Kane, 2026-09-04),
// and the CLIENT marks them: the Payment Catalog already ships
// `catalogOffboardedEmails` to the browser and every other catalog surface filters on
// that same set. Re-deriving it here would be a second answer to "who has left" that
// could drift from the one the rest of the tab uses -- and the naive shortcut
// (reading the raw evidence tables) marks working people as leavers, because the
// reason column is free text carrying `duplicate_cleanup` on 94 rows and
// `temporary_pause` suspensions. See payment-catalog-current-banks.md §5.

import { NextResponse } from 'next/server';
import { deniedResponse, requireRateVisibilitySession } from '@/lib/auth/authorize-email';
import { getEmployeeIds } from '@/lib/supabase/employee-ids';
import { peopleForBank, type BankRosterPerson } from '@/lib/payment-catalog/banks';
import { readBankRegistry } from '@/lib/payment-catalog/banks-db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(_req: Request, context: { params: Promise<{ key: string }> }) {
  // Same read gate as the bank list and the rest of the Payment Catalog.
  const authz = await requireRateVisibilitySession();
  if (!authz.ok) return deniedResponse(authz);

  const { key: rawKey } = await context.params;
  const key = decodeURIComponent(rawKey ?? '').trim();
  if (!key) return NextResponse.json({ people: [], error: 'Missing bank key' }, { status: 400 });

  try {
    // `getEmployeeIds` pages past the PostgREST 1000-row cap (1,995 rows today).
    const [{ rows, error }, registry] = await Promise.all([getEmployeeIds(), readBankRegistry()]);
    if (error) throw new Error(error);

    // The explicit projection, written out so a column added to `EmployeeIdRow` later
    // cannot start riding along into a per-person response.
    const people: BankRosterPerson[] = rows.map((r) => ({
      name: r.name ?? '',
      workEmail: r.work_email ?? '',
      bankName: r.bank_name,
      altBankName: r.alt_bank_name,
      preferredSlot:
        (r.preferred_bank_slot ?? 'primary') === 'alternative' ? 'alternative' : 'primary',
    }));

    return NextResponse.json({ people: peopleForBank(people, key, registry.stored), error: null });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Could not read the people on this bank';
    return NextResponse.json({ people: [], error: message }, { status: 500 });
  }
}
