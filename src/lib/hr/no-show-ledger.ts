import { normEmail } from '@/lib/email/norm-email';

/**
 * Puts an orientation no-show on the Offboarded list (`offboarded_sheet`).
 *
 * Manager → Newly Hired → *Did not attend* tears the hire's account down and
 * fires `offboarding_delete`, but until 2026-10-05 it never wrote the ledger
 * both Offboarded lists read. A no-show was findable only on HR → Onboarding →
 * No-show, so HR checking the Offboarded list before an interview found nothing
 * and nearly re-interviewed a returning no-show (audit item 343). In the sheet
 * era HR typed these rows by hand (401 `No Show During Orientation` + 457
 * `No Show`, monthly through 2026-07); the HRIS button replaced the habit and
 * dropped the record.
 *
 * Shared by the no-show route and `scripts/backfill-noshow-offboarded.mts`, so
 * a live write and a backfilled one are the same row.
 *
 * Three rules, each with a reason that outlives this file:
 *
 * 1. **Reason `ncns`.** A did-not-attend no-show is by definition a
 *    No-Call-No-Show — the route already sends that key to n8n, and the ledger
 *    row must not disagree with it.
 * 2. **The work email is WITHHELD when a live master row carries it.** The
 *    ledger is off-board evidence source #2 (`offboard-evidence.ts`): a record
 *    on a work email someone is using now is evidence AGAINST that person
 *    (`offboarding-automation.md`, recycled emails). The row is still written,
 *    keyed on the personal email and name, which is all HR searches by. 9 of the
 *    13 no-shows rehired by 2026-10-05 came back on the SAME work email.
 * 3. **One row per pending hire, ever.** The note carries `(pending hire #id)`,
 *    and an existing marker means the row is already there. That makes the
 *    route safe to re-run and the backfill safe to repeat.
 */

export const NO_SHOW_LEDGER_REASON = 'ncns';
export const NO_SHOW_LEDGER_NOTE = 'Did not attend orientation';

/** The idempotency marker. The closing paren is load-bearing: `#1379)` is not a
 *  substring of `#13790)`. */
export function noShowLedgerMarker(pendingId: number): string {
  return `(pending hire #${pendingId})`;
}

/** The pending-hire id a ledger note was written for, or null. */
export function pendingIdFromLedgerNote(note: string | null | undefined): number | null {
  const m = /\(pending hire #(\d+)\)/.exec(note ?? '');
  return m ? Number(m[1]) : null;
}

/** Why the work email was left off the row, when it was. */
export type WorkEmailWithheld = 'live_on_roster' | 'live_check_failed';

export interface NoShowLedgerInput {
  pendingId: number;
  name: string | null;
  workEmail: string | null;
  personalEmail: string | null;
  department: string | null;
  /** When the no-show was recorded (ISO). Becomes `off_boarded_at`. */
  noShowAt: string;
  /** The manager who marked it. Becomes `off_boarded_by`. */
  markedBy: string;
  managerNote?: string | null;
  /** True when a `global_master_list` row with `off_boarded_at IS NULL` carries
   *  the work email; null when that could not be checked. */
  workEmailLive: boolean | null;
}

export interface NoShowLedgerRow {
  personal_email: string;
  work_email: string | null;
  name: string | null;
  department: string | null;
  start_date: null;
  off_boarded_at: string;
  off_boarded_reason: typeof NO_SHOW_LEDGER_REASON;
  off_boarded_note: string;
  off_boarded_by: string;
  origin: 'hris';
}

export type NoShowLedgerDecision =
  | { kind: 'insert'; row: NoShowLedgerRow; workEmailWithheld: WorkEmailWithheld | null }
  | { kind: 'skip'; reason: 'no_personal_email' };

/**
 * The ledger row for one no-show. Pure.
 *
 * `personal_email` is NOT NULL on the table and is the only inbox that survives
 * the teardown, so a hire without one cannot be written. That is reported, never
 * papered over with the work address (the Offboarded tab's rule: a blank
 * personal email never falls back to the work one).
 */
export function buildNoShowLedgerRow(input: NoShowLedgerInput): NoShowLedgerDecision {
  const personal = normEmail(input.personalEmail ?? '');
  if (!personal) return { kind: 'skip', reason: 'no_personal_email' };

  const work = normEmail(input.workEmail ?? '');
  // Unknown liveness withholds too: on an evidence table the safe direction is
  // the record that can't count against anyone.
  const withheld: WorkEmailWithheld | null = !work
    ? null
    : input.workEmailLive === true
      ? 'live_on_roster'
      : input.workEmailLive === null
        ? 'live_check_failed'
        : null;

  const parts = [`${NO_SHOW_LEDGER_NOTE} ${noShowLedgerMarker(input.pendingId)}`];
  if (withheld === 'live_on_roster') parts.push(`work email ${work} not recorded: it is in use on the active roster`);
  if (withheld === 'live_check_failed') parts.push(`work email ${work} not recorded: the active roster could not be checked`);
  const managerNote = input.managerNote?.trim();
  if (managerNote) parts.push(managerNote);

  return {
    kind: 'insert',
    workEmailWithheld: withheld,
    row: {
      personal_email: personal,
      work_email: work && !withheld ? work : null,
      name: input.name?.trim() || null,
      department: input.department?.trim() || null,
      // They never started. A guessed start date would be evidence of a stint.
      start_date: null,
      off_boarded_at: input.noShowAt,
      off_boarded_reason: NO_SHOW_LEDGER_REASON,
      off_boarded_note: parts.join(' · '),
      off_boarded_by: normEmail(input.markedBy) || input.markedBy,
      origin: 'hris',
    },
  };
}

/** The three reads/writes the route needs, injected so the order and the
 *  failure handling are testable without a database. */
export interface NoShowLedgerStore {
  markerExists(marker: string): Promise<{ exists: boolean; error: string | null }>;
  workEmailLive(workEmail: string): Promise<{ live: boolean; error: string | null }>;
  insert(row: NoShowLedgerRow): Promise<{ error: string | null }>;
}

export interface NoShowLedgerResult {
  written: boolean;
  /** Set when nothing was written on purpose. */
  skipped: 'already_on_list' | 'no_personal_email' | null;
  workEmailWithheld: WorkEmailWithheld | null;
  /** Set when the row should have been written and was not. */
  error: string | null;
}

/**
 * Write the no-show's ledger row unless it is already there.
 *
 * A failed marker read writes NOTHING and reports the error: a blind insert could
 * duplicate the row, and the backfill script (idempotent on the same marker) is
 * the repair. A failed liveness read still writes, with the work email withheld.
 */
export async function recordNoShowOnLedger(
  store: NoShowLedgerStore,
  input: Omit<NoShowLedgerInput, 'workEmailLive'>,
): Promise<NoShowLedgerResult> {
  const none = { written: false, workEmailWithheld: null } as const;

  const marker = await store.markerExists(noShowLedgerMarker(input.pendingId));
  if (marker.error) return { ...none, skipped: null, error: `Offboarded list check failed: ${marker.error}` };
  if (marker.exists) return { ...none, skipped: 'already_on_list', error: null };

  const work = normEmail(input.workEmail ?? '');
  let workEmailLive: boolean | null = false;
  if (work) {
    const live = await store.workEmailLive(work);
    workEmailLive = live.error ? null : live.live;
  }

  const decision = buildNoShowLedgerRow({ ...input, workEmailLive });
  if (decision.kind === 'skip') return { ...none, skipped: decision.reason, error: null };

  const ins = await store.insert(decision.row);
  if (ins.error) {
    return { written: false, skipped: null, workEmailWithheld: decision.workEmailWithheld, error: ins.error };
  }
  return { written: true, skipped: null, workEmailWithheld: decision.workEmailWithheld, error: null };
}

/** `ilike` treats `_` and `%` as wildcards, and `_` is legal in an email. */
export function escapeIlike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}
