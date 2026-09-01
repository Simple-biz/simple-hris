import { createSupabaseServiceRoleClient } from './server';
import { normEmail } from '@/lib/email/norm-email';

/**
 * Data access for the Payroll Wizard → Readiness → No Pay Rate "Ignore"
 * (see references/sql/create/create_payroll_rate_exemptions.sql) — the rate
 * twin of payroll-bank-exemptions.ts, kept as its own table + module on purpose
 * so the bank path stays byte-identical to what shipped 2026-08-04.
 *
 * An ignore acknowledges one person's missing pay rate for ONE pay week: they
 * leave the No Pay Rate list and the readiness score's rate dimension (list and
 * worker denominator alike), and appear under Exceptions instead — an expected
 * non-payment, like an onboarding hire.
 *
 * Week-scoped by design, with no expiry job: a row is only honoured for the
 * `week_start` it was filed against, so the person reappears on next week's
 * list automatically if they log hours and still have no rate.
 *
 * Readiness-only. `payroll-readiness.ts` is the sole reader — the wizard's pay
 * computation and Payment Dispatch are deliberately untouched (a person with no
 * resolvable rate still can't be priced).
 */

const TABLE = 'payroll_rate_exemptions';

export type PayrollRateExemptionRow = {
  id: string;
  work_email: string | null;
  personal_email: string | null;
  name: string;
  department: string | null;
  /** The readiness pay week this ignore applies to (ISO date). */
  week_start: string;
  reason: string | null;
  created_by: string | null;
  created_at: string;
  /** Soft delete — non-null means Undone, and the row stops being honoured. */
  revoked_at: string | null;
  revoked_by: string | null;
};

export type NewPayrollRateExemption = {
  workEmail: string | null;
  personalEmail: string | null;
  name: string;
  department: string | null;
  weekStart: string;
  reason: string | null;
  createdBy: string | null;
};

const SELECT =
  'id, work_email, personal_email, name, department, week_start, reason, created_by, created_at, revoked_at, revoked_by';

function client() {
  const sb = createSupabaseServiceRoleClient();
  if (!sb) throw new Error('Supabase client missing — set SUPABASE_SERVICE_ROLE_KEY');
  return sb;
}

/** Trim; collapse blanks to null. */
function clean(v: string | null | undefined): string | null {
  const t = (v ?? '').trim();
  return t === '' ? null : t;
}

/** `YYYY-MM-DD` or null — a garbage week key must never reach the DATE column. */
function cleanIsoDate(v: string | null | undefined): string | null {
  const t = (v ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : null;
}

/**
 * Every ACTIVE (un-revoked) ignore for one pay week. Paged, because every
 * PostgREST read is capped at 1000 rows regardless of `.range()` — a week will
 * realistically hold a handful, but the cap has silently truncated readers here
 * before.
 */
export async function listActiveRateExemptions(weekStart: string): Promise<{
  rows: PayrollRateExemptionRow[];
  error: string | null;
}> {
  const week = cleanIsoDate(weekStart);
  if (!week) return { rows: [], error: 'A YYYY-MM-DD week start is required' };

  let sb;
  try {
    sb = client();
  } catch (e) {
    return { rows: [], error: e instanceof Error ? e.message : 'Supabase unavailable' };
  }

  const PAGE = 1000;
  const out: PayrollRateExemptionRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from(TABLE)
      .select(SELECT)
      .eq('week_start', week)
      .is('revoked_at', null)
      .order('created_at', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) return { rows: [], error: error.message };
    const batch = (data ?? []) as PayrollRateExemptionRow[];
    out.push(...batch);
    if (batch.length < PAGE) break;
  }
  return { rows: out, error: null };
}

/**
 * File a new ignore. Emails are stored lowercased (they're matched
 * case-insensitively everywhere else).
 *
 * The table carries a partial-unique index over the active slice, so a
 * double-click or two clerks on the same row can't stack duplicates. That
 * collision is NOT an error to the caller: the existing active row is returned
 * instead, so the UI reads "already ignored" rather than a scary failure.
 */
export async function insertRateExemption(input: NewPayrollRateExemption): Promise<{
  row: PayrollRateExemptionRow | null;
  error: string | null;
}> {
  const week = cleanIsoDate(input.weekStart);
  if (!week) return { row: null, error: 'A YYYY-MM-DD week start is required' };

  const name = clean(input.name);
  const workEmail = normEmail(input.workEmail);
  const personalEmail = normEmail(input.personalEmail);
  if (!name && !workEmail && !personalEmail) {
    return { row: null, error: 'An ignore needs a name or an email' };
  }

  let sb;
  try {
    sb = client();
  } catch (e) {
    return { row: null, error: e instanceof Error ? e.message : 'Supabase unavailable' };
  }

  const payload = {
    work_email: workEmail,
    personal_email: personalEmail,
    // The CHECK constraint requires a name; fall back to an email when the
    // readiness row genuinely had no display name.
    name: name ?? workEmail ?? personalEmail ?? '—',
    department: clean(input.department),
    week_start: week,
    reason: clean(input.reason),
    created_by: clean(input.createdBy),
  };

  const { data, error } = await sb.from(TABLE).insert(payload).select(SELECT).single();
  if (!error) return { row: data as unknown as PayrollRateExemptionRow, error: null };

  // 23505 = unique violation → an active ignore for this person-week already
  // exists. Hand back the existing row: the desired end state is already true.
  // Re-selected on the SAME keys the unique index covers (week + both emails +
  // name), so a namesake's row can never be mistaken for this person's.
  if (error.code === '23505') {
    let q = sb
      .from(TABLE)
      .select(SELECT)
      .eq('week_start', week)
      .is('revoked_at', null)
      .eq('name', payload.name);
    q = workEmail ? q.eq('work_email', workEmail) : q.is('work_email', null);
    q = personalEmail ? q.eq('personal_email', personalEmail) : q.is('personal_email', null);
    const existing = await q.limit(1);
    const row = ((existing.data ?? []) as PayrollRateExemptionRow[])[0] ?? null;
    if (row) return { row, error: null };
  }
  return { row: null, error: error.message };
}

/**
 * Undo an ignore — a SOFT delete, so who ignored whom (and who reversed it)
 * stays on record. Already-revoked rows are left alone: `revoked` counts only
 * the rows this call actually flipped, so a double Undo reports 0 rather than
 * silently re-stamping someone else's revocation.
 */
export async function revokeRateExemption(
  id: string,
  revokedBy: string | null,
): Promise<{ row: PayrollRateExemptionRow | null; revoked: number; error: string | null }> {
  const rowId = (id ?? '').trim();
  if (!rowId) return { row: null, revoked: 0, error: 'An ignore id is required' };

  let sb;
  try {
    sb = client();
  } catch (e) {
    return { row: null, revoked: 0, error: e instanceof Error ? e.message : 'Supabase unavailable' };
  }

  const { data, error } = await sb
    .from(TABLE)
    .update({ revoked_at: new Date().toISOString(), revoked_by: clean(revokedBy) })
    .eq('id', rowId)
    .is('revoked_at', null)
    .select(SELECT);
  if (error) return { row: null, revoked: 0, error: error.message };

  const rows = (data ?? []) as PayrollRateExemptionRow[];
  return { row: rows[0] ?? null, revoked: rows.length, error: null };
}
