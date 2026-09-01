import 'server-only';

/** [TERMINATION-DOCS]
 * The facts sheet a rep reviews before generating a termination letter.
 *
 * `resolveTerminationFacts` takes exactly ONE identity argument, a WORK email
 * (G1). It never sees the rep's raw query, so a personal email cannot become an
 * identity here; the departure-evidence read below is keyed on the WORK email
 * for the same reason — a shared Gmail lends one identity's departure to another
 * (`carla@` inheriting `carlath@`'s resigned stamp, offboard-evidence.ts:41-48).
 *
 * This module NEVER THROWS for a data problem. It returns the 3-arm
 * `TerminationFactsResult` — the COE contract (coe-facts.ts:116) — because a
 * thrown error on a review screen reads as "the system is down" when the truth
 * is "this person's record cannot support a letter".
 *
 * PROMPT, NEVER REFUSE — except where a refusal is the only honest answer. The
 * whole refusal ladder is in the pure `./termination-arbitration`
 * (`arbitrateTerminationFacts`), whose docstring carries THE SETTLED RULE: four
 * independent tests, T1 reads-that-must-succeed → T2 a valid first-party
 * departure record → T3 the re-engagement test → T4 hours as a refusal-only
 * signal. THIS module is the reads that feed them.
 *
 * That split exists because a `server-only` module cannot be imported by
 * `npm test`; it is the same split `readiness-score.ts` makes out of
 * `payroll-readiness.ts`.
 *
 * `getEmployeeMasterRecord` is UNUSABLE here: it hard-wires
 * `.is('off_boarded_at', null)` (employees.ts:568) and returns
 * `{employee: null, error: null}` — a SUCCESS with no row — for every
 * offboarded person, i.e. for 100% of this feature's subjects. The master read
 * below is the deliberate parallel, with NO off-board filter.
 *
 * EVERY READ THE LADDER FAILS CLOSED ON HAS A REAL ERROR CHANNEL HERE, and that
 * is the whole reason two of them are this feature's own code:
 *
 *   · the master identity read → `masterReadError`
 *   · `fetchGmlStatusMap()`    → `gmlStatusError`
 *   · `loadTerminationDepartureEvidence` → `evidenceReadError`. NOT
 *     `loadOffboardEvidenceByEmail`: all three of ITS source reads end in
 *     `.catch(() => {})` and it returns a bare `Map` with no error field, so a
 *     timed-out source is indistinguishable from an empty one. The shared helper
 *     cannot report failure and this module does not pretend it can.
 *   · the cycle timesheet → `readCycleHoursSignal`, which distinguishes
 *     UNREADABLE from UNAVAILABLE-BECAUSE-EMPTY from a real answer. The old
 *     `hours.error ? null : personWorkedCycle(...)` turned an empty-but-healthy
 *     index into a confident "did not work" for the entire roster.
 */

import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { selectAllPaged } from '@/lib/supabase/select-all-paged';
import { normEmail } from '@/lib/email/norm-email';
import { fetchGmlStatusMap } from '@/lib/roster/gml-status';
import { loadCycleHoursIndex } from '@/lib/payroll/cycle-hours-index';
import type { TerminationFactsResult } from './types';
import { escapeLikePattern } from './reason-key';
import {
  applyTerminationRates,
  arbitrateTerminationFacts,
  type TerminationMasterRow,
} from './termination-arbitration';
import {
  latestDepartureRecord,
  loadTerminationDepartureEvidence,
} from './termination-evidence';
import {
  readCycleHoursSignal,
  type TerminationHoursIdentity,
} from './termination-cycle-hours';
import {
  screenWorkAliases,
  type TerminationAliasScreenPort,
} from './termination-alias-screen';
import { resolveTerminationRates } from './termination-rates';

type Row = Record<string, unknown>;
type ServiceClient = NonNullable<ReturnType<typeof createSupabaseServiceRoleClient>>;

/** Verbatim projection. NO `off_boarded_at` filter — see the file header. */
const MASTER_SELECT =
  'id,"Name","Work Email","Personal Email","Alternate Work Email","Alternate Work Email 2","Department","Start Date",off_boarded_at,off_boarded_reason,last_seen_upload_id';

function trimOrNull(v: unknown): string | null {
  const s = typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
  return s ? s : null;
}

export async function resolveTerminationFacts(workEmail: string): Promise<TerminationFactsResult> {
  const norm = normEmail(workEmail);
  if (!norm) return { facts: null, blocked: null, error: 'A work email is required.' };

  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { facts: null, blocked: null, error: 'Supabase not configured' };

  try {
    const pat = escapeLikePattern(norm);
    const [master, upload, gml, evidence, hours] = await Promise.all([
      // NO off_boarded_at filter — every subject of this feature is offboarded.
      selectAllPaged<Row>((from, to) =>
        supabase
          .from('global_master_list')
          .select(MASTER_SELECT)
          .ilike('"Work Email"', pat)
          .order('id', { ascending: true })
          .range(from, to),
      ),
      supabase
        .from('master_list_uploads')
        .select('id')
        .eq('is_current', true)
        .then(({ data, error }) => ({
          // Exactly one is_current row is the healthy shape; anything else means
          // the roster cannot say which upload is current, so nothing is promoted.
          id: !error && (data ?? []).length === 1 ? trimOrNull((data ?? [])[0]?.id) : null,
          error: error?.message ?? null,
        })),
      fetchGmlStatusMap(),
      // This feature's OWN departure-evidence read, WORK-keyed, with a real
      // error channel — see the file header for why the shared helper is not it.
      loadTerminationDepartureEvidence(supabase, norm),
      // The cycle timesheet. `null` sourceFile = the `is_current` Hubstaff
      // upload. Never throws; `readCycleHoursSignal` below is what reads the
      // three states out of it.
      loadCycleHoursIndex(null),
    ]);

    const degraded: string[] = [];
    if (master.error) degraded.push(`global_master_list: ${master.error}`);
    if (upload.error) degraded.push(`master_list_uploads: ${upload.error}`);
    if (gml.error) degraded.push(`global_master_list status map: ${gml.error}`);
    if (evidence.error) degraded.push(`departure evidence: ${evidence.error}`);
    if (hours.error) degraded.push(`cycle timesheet: ${hours.error}`);

    const masterRows = master.rows.map(toMasterRow);

    const arbitration = arbitrateTerminationFacts({
      workEmail: norm,
      masterRows,
      currentUploadId: upload.id,
      // Corroboration only — the T2 decision reads `masterRows` directly, and an
      // ERRORED map is a hard T1 block rather than a silent "not active".
      gmlActive: gml.map.get(norm)?.active === true,
      gmlStatusError: gml.error,
      masterReadError: master.error,
      evidenceReadError: evidence.error,
      cycleHours: readCycleHoursSignal(hours, hoursIdentity(masterRows, norm)),
      evidence: latestDepartureRecord([
        ...masterRows.map((r) => ({
          offBoardedAtRaw: r.offBoardedAtRaw,
          offBoardedReason: r.offBoardedReason,
        })),
        ...evidence.sheetRows,
        ...evidence.queueRows,
      ]),
      sheetRows: evidence.sheetRows,
      readsDegraded: degraded.length > 0,
      degraded,
    });

    if (arbitration.blocked) return { facts: null, blocked: arbitration.blocked, error: null };

    // A7: an alternate work address may key a rate lookup only if it is not
    // recorded as ANY person's personal email. `workAliasesForRateContext` can
    // only screen the SUBJECT'S OWN rows, so a third party's gmail parked in an
    // "Alternate Work Email" cell survives it — and `hr_pending_employees` /
    // `employee_rate_history` are both keyed by whatever address the sheet era
    // held, so that cell prints somebody else's rate as this person's STARTING
    // RATE. One targeted, escaped, paged lookup per alternate closes it.
    const screened = await screenWorkAliases(
      arbitration.rateContext.workEmail,
      arbitration.rateContext.workAliases,
      personalEmailScreenPort(supabase),
    );

    // Rates are read ONLY after every refusal has passed — G2: a temporary pause
    // never reaches a rate read, let alone a render.
    const rates = await resolveTerminationRates({
      ...arbitration.rateContext,
      workAliases: screened.workAliases,
    });
    return {
      facts: applyTerminationRates(arbitration.facts, {
        starting: rates.starting,
        ending: rates.ending,
        degraded: [...rates.degraded, ...screened.degraded],
      }),
      blocked: null,
      error: null,
    };
  } catch (e) {
    // A data problem is a `blocked`; only a genuine fault reaches here.
    return {
      facts: null,
      blocked: null,
      error: e instanceof Error ? e.message : 'Could not resolve termination facts',
    };
  }
}

/**
 * "Is this address recorded as ANYBODY'S personal email?" — one escaped, paged
 * lookup against the `Personal Email` column.
 *
 * `select('id')` and not `head: true` with a count: an empty result from a HEAD
 * request is indistinguishable from a missing table
 * (memory `postgrest-head-true-hides-missing-table`), and the whole value of
 * this screen is that a failure is reported rather than read as "clean".
 */
function personalEmailScreenPort(supabase: ServiceClient): TerminationAliasScreenPort {
  return {
    async isRecordedAsPersonalEmail(email: string) {
      const res = await selectAllPaged<Row>((from, to) =>
        supabase
          .from('global_master_list')
          .select('id')
          .ilike('"Personal Email"', escapeLikePattern(email))
          .order('id', { ascending: true })
          .range(from, to),
      );
      if (res.error) return { found: false, error: res.error };
      return { found: res.rows.length > 0, error: null };
    },
  };
}

/**
 * Every address and every name this master record could be sitting in the
 * current cycle's timesheet under.
 *
 * Deliberately the widest read available: a hit is an absolute REFUSAL
 * (`still_active`), so a false positive costs a letter that gets issued after a
 * master-row repair, while a false negative would print a termination letter for
 * someone who worked this week. `readCycleHoursSignal` widens it further — the
 * local part of each address on any domain, and a token-subset name comparison —
 * because a working person's Hubstaff login is routinely an address the master
 * row does not carry at all.
 */
function hoursIdentity(rows: TerminationMasterRow[], workEmail: string): TerminationHoursIdentity {
  const emails = new Set<string>([workEmail]);
  const names = new Set<string>();
  for (const r of rows) {
    for (const e of [r.workEmail, r.personalEmail, r.alternateWorkEmail, r.alternateWorkEmail2]) {
      const n = normEmail(e);
      if (n) emails.add(n);
    }
    if (r.name) names.add(r.name);
  }
  return { emails: [...emails], names: [...names] };
}

function toMasterRow(r: Row): TerminationMasterRow {
  const seq = Number(r['last_seen_upload_id'] ?? 0);
  return {
    id: trimOrNull(r['id']),
    name: trimOrNull(r['Name']),
    workEmail: normEmail(trimOrNull(r['Work Email'])),
    personalEmail: normEmail(trimOrNull(r['Personal Email'])),
    alternateWorkEmail: normEmail(trimOrNull(r['Alternate Work Email'])),
    alternateWorkEmail2: normEmail(trimOrNull(r['Alternate Work Email 2'])),
    departmentRaw: trimOrNull(r['Department']),
    startDateRaw: trimOrNull(r['Start Date']),
    offBoardedAtRaw: trimOrNull(r['off_boarded_at']),
    offBoardedReason: trimOrNull(r['off_boarded_reason']),
    uploadId: trimOrNull(r['last_seen_upload_id']),
    uploadSeq: Number.isFinite(seq) ? seq : 0,
  };
}
