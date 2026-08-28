import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { normEmail } from "@/lib/email/norm-email";
import { mapHubstaffHoursRow } from "@/lib/supabase/hubstaff-hours";
import { listHubstaffUploads } from "@/lib/supabase/hubstaff-hours-db";
import {
  getEmployeeHourlyRatesRows,
  indexHourlyRatesByEmail,
} from "@/lib/supabase/employee-hourly-rates";
import {
  mesaDepositDateFor,
  mesaDepositDatesToReverse,
  mesaWeekStartFor,
} from "@/lib/mesa/deposit-date";

// Weekly MESA contribution — ₱100 from the employee, matched 3× (₱300) by
// Simple.biz for a ₱400 total deposit. Mirrors the Payroll Wizard's ₱100 MESA
// deduction and the "matched three times over" copy in the employee About tab.
const WORKER_CONTRIB = 100;
const COMPANY_MATCH = 300;
const WEEKLY_TOTAL = WORKER_CONTRIB + COMPANY_MATCH;

const LEDGER_TABLE = "mesa_ledger";

/** Pull the Sun→Sat pay week's END date out of a weekly-summary filename, if
 *  present (same "…_YYYY-MM-DD_to_YYYY-MM-DD" range the wizard locks into every
 *  weekly file, and that parseWeekRange in payroll-available.ts reads). */
function parseWeekEnd(filename: string | null | undefined): string | null {
  if (!filename) return null;
  const m = /(\d{4}-\d{2}-\d{2})_to_(\d{4}-\d{2}-\d{2})/.exec(filename);
  return m ? m[2] : null;
}

/**
 * Records one weekly MESA deposit (₱100 + ₱300 match) into `mesa_ledger` for
 * every opted-in member paid in a freshly uploaded Hubstaff week — so member
 * balances actually GROW each pay period instead of staying frozen at the
 * original backfill. Called (best-effort) right after
 * `replaceHubstaffHoursFromCsvText` archives + promotes an upload in
 * POST /api/hubstaff-hours — both the manual CSV upload and the "Sync from
 * Hubstaff" API path (which passes weekEnd directly).
 *
 * Who gets credited mirrors the Wizard's deduction EXACTLY: a payroll row is
 * charged ₱100 when its rate row has `mesa_member = true` AND
 * `mesa_member_since <= week end` (a null enrollment date = legacy member, always
 * contributing). We resolve each Hubstaff "Email" to a rate row the same way the
 * Wizard does — `indexHourlyRatesByEmail` on Work/Personal email, no alias
 * expansion — so a deposit lands for precisely the people who were deducted.
 *
 * Idempotent per (member, week): a re-upload or correction of the same week
 * never double-deposits anyone already credited for that week end, but a member
 * who first appears in a re-upload still gets their deposit. The deposit carries
 * no `status` on purpose — a contribution is not a membership event, so it must
 * not mask the member's real latest Active/Inactive snapshot.
 */
export async function recordMesaWeeklyContributions(opts: {
  uploadId: string;
  sourceFile?: string | null;
  /** Pay week end (YYYY-MM-DD). Provided by the API-sync path; otherwise parsed
   *  from the source filename's locked date range. */
  weekEnd?: string | null;
}): Promise<{ inserted: number; skipped: number; members: number; weekEnd: string | null }> {
  const zero = { inserted: 0, skipped: 0, members: 0, weekEnd: null as string | null };

  const weekEnd = (opts.weekEnd?.trim() || parseWeekEnd(opts.sourceFile)) ?? null;
  // Without a week-end date we can't date the deposit — skip rather than write
  // an undated/mis-dated financial row.
  if (!weekEnd || !/^\d{4}-\d{2}-\d{2}$/.test(weekEnd)) return zero;

  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { ...zero, weekEnd };

  const hoursTable =
    process.env.NEXT_PUBLIC_SUPABASE_HUBSTAFF_HOURS_TABLE?.trim() || "hubstaff_hours";

  // ── 1. Everyone in THIS week's batch (email → display name + department) ────
  const batch = new Map<string, { name: string | null; department: string | null }>();
  {
    const PAGE = 1000;
    let from = 0;
    while (true) {
      const { data, error } = await supabase
        .from(hoursTable)
        .select("*")
        .eq("upload_id", opts.uploadId)
        .range(from, from + PAGE - 1);
      if (error) throw new Error(error.message);
      const page = (data ?? []) as Record<string, unknown>[];
      for (const raw of page) {
        const mapped = mapHubstaffHoursRow(raw);
        const e = normEmail(mapped.email);
        if (e && !batch.has(e)) batch.set(e, { name: mapped.name, department: mapped.department });
      }
      if (page.length < PAGE) break;
      from += PAGE;
      if (from > 20_000) break; // one weekly upload won't have >20k rows
    }
  }
  if (batch.size === 0) return { ...zero, weekEnd };

  // ── 2. Opted-in members in the batch (same match as the Wizard's deduction) ─
  const { rows: rateRows } = await getEmployeeHourlyRatesRows();
  const ratesByEmail = indexHourlyRatesByEmail(rateRows);

  type Member = { email: string; name: string | null; department: string | null };
  const members = new Map<string, Member>(); // keyed by normalized ledger identity (Work Email)
  for (const [email, meta] of batch) {
    const rate = ratesByEmail.get(email);
    if (!rate || rate.mesa_member !== true) continue;
    // Enrolled AFTER this week → not yet contributing (lexical YYYY-MM-DD compare).
    if (rate.mesa_member_since && rate.mesa_member_since > weekEnd) continue;
    // Ground the deposit on the member's Work Email so it groups with their
    // existing ledger history (summarizeMembers keys on lowercased email).
    const ledgerEmail = rate.work_email ?? rate.personal_email ?? email;
    const identity = normEmail(ledgerEmail) ?? email;
    if (!members.has(identity)) {
      members.set(identity, {
        email: ledgerEmail,
        name: meta.name ?? null,
        department: rate.department ?? meta.department ?? null,
      });
    }
  }
  if (members.size === 0) return { ...zero, weekEnd };

  // ── 3. Skip members already credited for this WEEK (idempotent) ─────────────
  // Dedup on the whole Sun→Sat window, NOT the exact deposit date: the original
  // tracker backfill dates its weekly deposits mid-week (e.g. a Thursday), so a
  // week can already be covered by a deposit on some other day. Matching by exact
  // date would miss that and write a duplicate for the same week. Re-uploads are
  // covered too — mesaDepositDateFor always lands inside this window (locked by
  // deposit-date.test.ts), so a prior run's own deposit is always seen here.
  // Paginated: PostgREST silently caps an unbounded select at 1000 rows.
  const weekStart = mesaWeekStartFor(weekEnd);
  const alreadyThisWeek = new Set<string>();
  {
    const PAGE = 1000;
    let from = 0;
    while (true) {
      const { data, error } = await supabase
        .from(LEDGER_TABLE)
        .select("email")
        .gte("deposit_date", weekStart)
        .lte("deposit_date", weekEnd)
        .range(from, from + PAGE - 1);
      if (error) throw new Error(error.message);
      const page = (data ?? []) as Array<{ email: string | null }>;
      for (const r of page) {
        const e = normEmail(r.email);
        if (e) alreadyThisWeek.add(e);
      }
      if (page.length < PAGE) break;
      from += PAGE;
      if (from > 20_000) break;
    }
  }

  // ── 4. Next free id — mesa_ledger.id is a plain integer PK with no default ──
  let nextId: number;
  {
    const { data, error } = await supabase
      .from(LEDGER_TABLE)
      .select("id")
      .order("id", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    nextId = ((data?.id as number | undefined) ?? 0) + 1;
  }

  // ── 5. Build the deposit rows ───────────────────────────────────────────────
  const toInsert: Record<string, unknown>[] = [];
  let skipped = 0;
  for (const [identity, m] of members) {
    if (alreadyThisWeek.has(identity)) {
      skipped += 1;
      continue;
    }
    toInsert.push({
      id: nextId++,
      email: m.email,
      name: m.name,
      department: m.department,
      status: null,
      // The FRIDAY of this pay week — one shared rule with the reversal below,
      // so the two can never drift apart. See src/lib/mesa/deposit-date.ts.
      deposit_date: mesaDepositDateFor(weekEnd),
      worker_contribution_php: WORKER_CONTRIB,
      simple_match_php: COMPANY_MATCH,
      total_daily_deposit_php: WEEKLY_TOTAL,
    });
  }
  if (toInsert.length === 0) return { inserted: 0, skipped, members: members.size, weekEnd };

  // ── 6. Insert ────────────────────────────────────────────────────────────
  const BATCH = 200;
  let inserted = 0;
  for (let i = 0; i < toInsert.length; i += BATCH) {
    const chunk = toInsert.slice(i, i + BATCH);
    const { error } = await supabase.from(LEDGER_TABLE).insert(chunk);
    if (error) throw new Error(error.message);
    inserted += chunk.length;
  }

  return { inserted, skipped, members: members.size, weekEnd };
}

/**
 * Reverses `recordMesaWeeklyContributions` when a payroll week is deleted from
 * the Payroll Wizard (DELETE /api/hubstaff-hours?source_file=…) — otherwise the
 * week's ₱100+₱300 deposits linger in `mesa_ledger` and the Employee Dashboard
 * MESA balance keeps counting a week that no longer exists.
 *
 * Call AFTER `deleteHubstaffRowsBySourceFile` has removed the batch. Deposits
 * are per-WEEK (the recorder dedupes across the Sun→Sat window), so if another
 * remaining upload still covers the same week — a corrected re-upload under a
 * different filename — the deposits stay and we report `weekStillCovered`.
 *
 * Only rows this app wrote are eligible: dated on one of the dates the recorder
 * could have used for this week (`mesaDepositDatesToReverse` — the week's FRIDAY,
 * plus the pre-cutover week end so older deposits stay reversible), with the
 * standard ₱100/₱300 amounts and NO tracker provenance (`status`,
 * `opt_in_number`, `fpu_completion_date` all null — every sheet-backfilled row
 * carries opt-in tracker fields, and mid-week-dated backfill deposits match
 * neither date). Disbursement rows are excluded outright.
 *
 * The date comes from the SAME module the recorder writes with, so this filter
 * cannot fall out of step with what was written. It used to be an independent
 * copy of the expression, and a filtered DELETE that matches nothing reports
 * success — see src/lib/mesa/deposit-date.ts for why that mattered.
 */
export async function deleteMesaWeeklyContributions(opts: {
  sourceFile: string;
}): Promise<{ deleted: number; weekEnd: string | null; weekStillCovered: boolean }> {
  const weekEnd = parseWeekEnd(opts.sourceFile);
  // No locked date range in the filename → the recorder never wrote deposits
  // for this batch (it skips undatable weeks), so there is nothing to reverse.
  if (!weekEnd) return { deleted: 0, weekEnd: null, weekStillCovered: false };

  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { deleted: 0, weekEnd, weekStillCovered: false };

  // If any surviving upload still covers this pay week, its members were deduped
  // against the very rows we'd delete — removing them would strip a week the
  // roster still legitimately contains. Errors propagate: when we can't verify
  // coverage, we must not touch financial rows.
  const uploads = await listHubstaffUploads();
  const stillCovered = uploads.some((u) => parseWeekEnd(u.source_file) === weekEnd);
  if (stillCovered) return { deleted: 0, weekEnd, weekStillCovered: true };

  const { count, error } = await supabase
    .from(LEDGER_TABLE)
    .delete({ count: "exact" })
    // The SAME rule the recorder wrote with — not a second copy of it. Includes
    // the pre-cutover week-end date so deposits written before the Friday move
    // are still reversible. See src/lib/mesa/deposit-date.ts.
    .in("deposit_date", mesaDepositDatesToReverse(weekEnd))
    .eq("worker_contribution_php", WORKER_CONTRIB)
    .eq("simple_match_php", COMPANY_MATCH)
    .is("status", null)
    .is("opt_in_number", null)
    .is("fpu_completion_date", null)
    .is("disbursement_date", null)
    .is("disbursement_amount_php", null);
  if (error) throw new Error(error.message);

  return { deleted: count ?? 0, weekEnd, weekStillCovered: false };
}
