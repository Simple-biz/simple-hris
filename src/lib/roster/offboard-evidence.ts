import 'server-only';

/**
 * The ONE place the three off-board evidence sources are enumerated.
 *
 * `active_employees` cannot answer "has this person left". HR keeps a leaver on
 * the master Google Sheet through their final pay, so they stay in the current
 * upload — and the off-board stamp lands on a DUPLICATE `global_master_list`
 * row, never on the one the view serves. Measured 2026-08-21: 1,287 active rows,
 * **zero** carrying an `off_boarded_at`, while 294 of those people are off-boarded
 * according to the sources below.
 *
 * The evidence is:
 *   1. `global_master_list` rows stamped `off_boarded_at` (the duplicates),
 *   2. the `offboarded_sheet` ledger (HRIS-owned since the Sheet intake was
 *      retired — see the final-pay-roster-overlay memory),
 *   3. completed `offboarding_queue` rows (`decided_at`).
 *
 * Latest date per email wins, and the REASON recorded on that latest record
 * rides along: `temporary_pause` is a suspension with a return, not a departure,
 * so every consumer has to be able to tell the two apart.
 *
 * **Best-effort per source, deliberately.** Each read catches its own failure, so
 * one broken table degrades the evidence rather than the caller. Every consumer
 * treats missing evidence as "still here", which is the only safe direction: a
 * leaver who lingers one week too long costs nothing, whereas an active worker
 * dropped off a money surface stops getting paid correctly.
 */
import { normEmail } from '@/lib/email/norm-email';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { normalizeMasterDate } from '@/lib/roster/master-date';

/**
 * Which identity columns an evidence record is indexed under.
 *
 * `'all'` indexes work AND personal addresses — the historical behaviour, right
 * for a surface that only ever OVER-lists (Payroll Readiness keeps a leaver on
 * its bank list a week longer than needed and nothing breaks).
 *
 * `'work'` indexes work addresses only, and is required by any surface where a
 * false positive HIDES someone. A personal email is not an identity here:
 *   • `offboarding_queue.employee_email` holds the PERSONAL address on all 460
 *     completed rows, not the work one;
 *   • duplicate master identities share one personal inbox, so the departure of
 *     one bleeds onto the other — `carla@simple.biz` (USEE, Active) picks up the
 *     2026-06-03 `resigned` stamp belonging to `carlath@simple.biz` (Accounting)
 *     purely through `carlathomas0112@gmail.com`. Same class as the
 *     shared-personal-email KPI cross-wire and the Maria Argote split identity.
 */
export type OffboardEvidenceKeys = 'all' | 'work';

export interface OffboardEvidence {
  /** Latest off-board date across all three sources, `YYYY-MM-DD`. */
  offDate: string;
  /** The reason carried by the record that supplied {@link offDate}, when it has
   *  one. `offboarding_queue` and both stamped tables record it; a legacy row
   *  may not, which reads as null (an unknown reason is a real departure). */
  reason: string | null;
}

type Row = Record<string, unknown>;

/**
 * Off-board evidence for every email that has any, keyed by normalized email.
 *
 * @param keys which identity columns to index under — see
 *   {@link OffboardEvidenceKeys}. Defaults to `'all'`, which is what Payroll
 *   Readiness has always used; pass `'work'` on any surface where a false
 *   positive hides someone.
 */
export async function loadOffboardEvidenceByEmail(
  keys: OffboardEvidenceKeys = 'all',
): Promise<Map<string, OffboardEvidence>> {
  const workOnly = keys === 'work';
  const byEmail = new Map<string, OffboardEvidence>();
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return byEmail;

  const note = (email: unknown, when: unknown, reason: unknown) => {
    const em = normEmail(typeof email === 'string' ? email : '');
    const day = normalizeMasterDate(typeof when === 'string' ? when : null);
    if (!em || !day) return;
    const cur = byEmail.get(em);
    if (cur && day <= cur.offDate) return;
    byEmail.set(em, {
      offDate: day,
      reason: typeof reason === 'string' && reason.trim() ? reason.trim() : null,
    });
  };

  const readAll = async (
    page: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
  ): Promise<Row[]> => {
    // PostgREST truncates at db.max-rows (1000) even with `.range()`, so page.
    const PAGE = 1000;
    const out: Row[] = [];
    let from = 0;
    while (true) {
      const { data, error } = await page(from, from + PAGE - 1);
      if (error) throw new Error(error.message);
      const batch = (data ?? []) as Row[];
      out.push(...batch);
      if (batch.length < PAGE) break;
      from += PAGE;
    }
    return out;
  };

  await Promise.all([
    readAll((from, to) =>
      supabase
        .from('global_master_list')
        .select('"Work Email","Personal Email",off_boarded_at,off_boarded_reason')
        .not('off_boarded_at', 'is', null)
        .range(from, to),
    )
      .then((rows) => {
        for (const r of rows) {
          note(r['Work Email'], r['off_boarded_at'], r['off_boarded_reason']);
          if (!workOnly) note(r['Personal Email'], r['off_boarded_at'], r['off_boarded_reason']);
        }
      })
      .catch(() => {}),
    readAll((from, to) =>
      supabase
        .from('offboarded_sheet')
        .select('work_email, personal_email, off_boarded_at, off_boarded_reason')
        .range(from, to),
    )
      .then((rows) => {
        for (const r of rows) {
          note(r['work_email'], r['off_boarded_at'], r['off_boarded_reason']);
          if (!workOnly) note(r['personal_email'], r['off_boarded_at'], r['off_boarded_reason']);
        }
      })
      .catch(() => {}),
    readAll((from, to) =>
      supabase
        .from('offboarding_queue')
        .select('employee_email, employee_work_email, employee_personal_email, decided_at, reason')
        .eq('status', 'completed')
        .range(from, to),
    )
      .then((rows) => {
        for (const r of rows) {
          note(r['employee_work_email'], r['decided_at'], r['reason']);
          // `employee_email` is the PERSONAL address on every completed row
          // (460/460, measured 2026-08-21) — it belongs with the personal key,
          // not the work one.
          if (!workOnly) {
            note(r['employee_email'], r['decided_at'], r['reason']);
            note(r['employee_personal_email'], r['decided_at'], r['reason']);
          }
        }
      })
      .catch(() => {}),
  ]);

  return byEmail;
}
