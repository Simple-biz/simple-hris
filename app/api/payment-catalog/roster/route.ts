// Payment Catalog -- the people the catalog counts and offers.
//
// GET -> { employees, catalogOffboardedEmails, error, offboardedError }
//
// The same two datasets `prefetchAccountingData` hands the catalog at page load,
// re-read on every catalog `refetch()` so a transfer applied after the page opened
// moves the headcounts (Healthcare Specialist read "0 people" with someone in it,
// 2026-09-24). Rows are projected to four fields by `toCatalogRosterRows` — never
// `EmployeeRow`, which carries bank details.

import { NextResponse } from 'next/server';
import { deniedResponse, requireRateVisibilitySession } from '@/lib/auth/authorize-email';
import { getEmployees } from '@/lib/supabase/employees';
import { loadCatalogOffboardedEmails } from '@/lib/payment-catalog/catalog-offboarded-emails';
import { toCatalogRosterRows, type CatalogRosterResponse } from '@/lib/payment-catalog/catalog-roster';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  // Same read gate as the rest of the Payment Catalog.
  const authz = await requireRateVisibilitySession();
  if (!authz.ok) return deniedResponse(authz);

  const fail = (message: string) =>
    NextResponse.json<CatalogRosterResponse>(
      { employees: [], catalogOffboardedEmails: [], error: message, offboardedError: null },
      { status: 500 },
    );

  let employees;
  try {
    const result = await getEmployees();
    if (result.error) return fail(result.error);
    employees = result.employees ?? [];
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Could not read the roster');
  }

  // Degrades to "hide nobody" on any evidence failure — the prefetch's rule.
  const off = await loadCatalogOffboardedEmails(employees).catch((e: unknown) => ({
    emails: [] as string[],
    error: e instanceof Error ? e.message : 'Off-board evidence could not be read — nobody was hidden',
  }));

  return NextResponse.json<CatalogRosterResponse>({
    employees: toCatalogRosterRows(employees),
    catalogOffboardedEmails: off.emails,
    error: null,
    offboardedError: off.error ?? null,
  });
}
