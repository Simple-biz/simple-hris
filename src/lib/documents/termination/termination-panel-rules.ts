/** [TERMINATION-DOCS]
 * The two judgements the Termination Docs PANEL makes about a server response,
 * lifted out of the `.tsx` so `npm test` can run them.
 *
 * `npm test` is `node --import tsx --test "src/**\/*.test.ts"`, so nothing
 * inside a `.tsx` component is ever executed by the suite. Both rules below
 * decide whether a rep can act on a signed legal document, and both had already
 * drifted away from the server once while every test stayed green — so they live
 * here, as pure functions over the response types, and the panel calls them.
 *
 * PURE and CLIENT-SAFE: no `server-only`, no Supabase, no Node builtin. It is
 * imported by a `'use client'` component.
 *
 * ── 1. The candidate list ───────────────────────────────────────────────────
 * THE SERVER DECIDES WHO IS SELECTABLE. `buildTerminationCandidates`
 * (termination-arbitration.ts:395-421) runs the whole refusal ladder over the
 * search rows and stamps `blockedCode`; `blockedCode === null` means "the facts
 * route will answer for this person". The panel used to add its own second
 * verdict on top — `c.active ? still_active` — which refused every candidate
 * `fetchGmlStatusMap` calls ACTIVE, including the commonest leaver shape there
 * is: an unstamped live master row plus the off-board stamp on a duplicate row
 * (measured 2026-08-21, offboard-evidence.ts:8-11 — 1,287 active rows, ZERO
 * carrying `off_boarded_at`, while 294 of those people ARE offboarded). The
 * server deliberately lets that shape through, the tab's own tests certify it as
 * issuable (termination-facts.test.ts, "a search candidate with a stamped
 * departure is offered even when the map says ACTIVE"), and the client refused
 * it anyway. `active` is DISPLAY METADATA here — a chip — and never a veto.
 *
 * ── 2. The one state a human must repair by hand ────────────────────────────
 * A write-back cell that LANDED in `global_master_list` while its undo record
 * failed to reach the document row is unrecoverable by any script: the reverse
 * reads `field_writebacks`, and this record is not in it. It arrives as an
 * ordinary entry in `writeback_skipped`, and it used to be rendered as a
 * `toast.warning` fired immediately after `window.open()` had moved the browser
 * to a new tab — a dismissible sentence the rep never saw, for the only state
 * where a human must act or the data is lost.
 *
 * So it is classified HERE, promoted to a {@link TerminationManualRepair}, and
 * the panel keeps it as a non-dismissing banner plus a marker on the log row.
 * The classification is a substring of the sentence the write-back builds
 * (termination-writeback-rules.ts:325); `termination-panel-rules.test.ts` pins
 * that literal against that file's source, so the two cannot drift apart in
 * silence.
 *
 * The repairs are held in `localStorage` because there is nothing on the server
 * to re-read: the whole point of the state is that the record did NOT reach the
 * database. It survives a reload, a closed tab and a killed browser on the
 * machine that generated the letter, which is the machine of the rep who has to
 * act. `audit_log` holds the second copy for engineering
 * (`documents.termination_writeback`).
 */

import {
  TERMINATION_WRITEBACK_COLUMNS,
  type TerminationBlockedReason,
  type TerminationDocumentRow,
  type TerminationSearchCandidate,
  type TerminationWritebackColumn,
} from './types';

// ─── 1. Candidate list: the server's verdict, rendered ───────────────────────

export interface TerminationCandidateView {
  /** The identity. `null` means the matched row carried no work email. */
  workEmail: string | null;
  /** The row offers "Load facts". */
  selectable: boolean;
  /** The refusal to state on a greyed row. `null` ⇔ `selectable`. */
  refusalCode: TerminationBlockedReason['code'] | null;
  /** `fetchGmlStatusMap` reports this address as on the active roster. A CHIP,
   *  never a reason to refuse: see the file header. */
  showActiveChip: boolean;
}

/**
 * How one search candidate renders.
 *
 * The refusal is the SERVER's `blockedCode`, verbatim. The only value this
 * function adds is the impossible-response case: a candidate with no work email
 * and no code at all. `buildTerminationCandidates` always stamps `no_master` on
 * a bucket with no work email (termination-arbitration.ts:396), so that pair can
 * only appear if the response contradicts its own contract — and a greyed row
 * carrying no stated reason is exactly the dead end this tab is forbidden to
 * ship. It is not a second copy of a guard: there is no server verdict here to
 * disagree with, and it can never turn a `blockedCode: null` candidate that HAS
 * an identity into a refusal.
 */
export function viewTerminationCandidate(
  candidate: TerminationSearchCandidate,
): TerminationCandidateView {
  const workEmail = candidate.workEmail;
  const refusalCode: TerminationBlockedReason['code'] | null =
    candidate.blockedCode ?? (workEmail ? null : 'no_master');
  return {
    workEmail,
    selectable: refusalCode === null && workEmail !== null,
    refusalCode,
    showActiveChip: candidate.active === true,
  };
}

// ─── 2. "Revert this cell by hand" ───────────────────────────────────────────

/**
 * The substring that identifies the WRITTEN-but-not-recorded skip.
 *
 * Built at termination-writeback-rules.ts:325. Pinned by
 * `termination-panel-rules.test.ts` against that file's source: if the sentence
 * is reworded there and not here, the test fails rather than the banner
 * silently going quiet.
 */
export const WRITEBACK_TRAIL_LOST_MARKER = 'WRITTEN but the undo record could not be saved';

/** One `writeback_skipped` entry, as it arrives on the generate response. */
export interface TerminationWritebackSkipLike {
  column: TerminationWritebackColumn;
  rowId: string;
  reason: string;
}

/** Is this skip the state where the master cell CHANGED and the undo record did
 *  not land? Everything else — "the cell already held a value", "not attempted"
 *  — is reversible or never happened, and stays an ordinary toast. */
export function isWritebackTrailLost(skip: { reason?: unknown } | null | undefined): boolean {
  return typeof skip?.reason === 'string' && skip.reason.includes(WRITEBACK_TRAIL_LOST_MARKER);
}

/** One master-list cell a person has to put back by hand. */
export interface TerminationManualRepair {
  /** `termination_documents.id` the write-back belonged to — the log row this
   *  marks. */
  documentId: string;
  workerName: string;
  workEmail: string;
  /** `global_master_list.id`. The cell to repair is on THIS row: one work email
   *  owns several master rows, so the address is not enough. */
  masterRowId: string;
  column: TerminationWritebackColumn;
  /** What the cell now holds — the value the letter printed. `null` only if the
   *  document row did not carry it. The prior value is always BLANK: the
   *  write-back's guarded UPDATE can only ever have filled an empty cell. */
  wroteValue: string | null;
  /** The server's own sentence, kept verbatim for the audit trail. */
  reason: string;
  /** When the panel learned about it (ISO). */
  detectedAt: string;
}

/**
 * The value a write-back put into one column, read off the document row.
 *
 * The three write-back columns are exactly the three facts the letter prints, so
 * the row is a faithful record of what the cell was set to — and the row is what
 * the panel has after a reload.
 */
export function writtenValueForColumn(
  row: Pick<TerminationDocumentRow, 'termination_date' | 'reason_key' | 'start_date'>,
  column: TerminationWritebackColumn,
): string | null {
  switch (column) {
    case 'off_boarded_at':
      return row.termination_date || null;
    case 'off_boarded_reason':
      return row.reason_key || null;
    case 'Start Date':
      return row.start_date || null;
  }
  return null;
}

/** Stable identity of a repair: one column of one document is written at most
 *  once, so this never collapses two distinct repairs. */
export function manualRepairKey(repair: Pick<TerminationManualRepair, 'documentId' | 'column'>): string {
  return `${repair.documentId}::${repair.column}`;
}

/** Promote the trail-lost skips on one generate response into repairs. */
export function buildManualRepairs(args: {
  row: Pick<
    TerminationDocumentRow,
    'id' | 'worker_name' | 'work_email' | 'termination_date' | 'reason_key' | 'start_date'
  >;
  skipped: readonly TerminationWritebackSkipLike[];
  detectedAt: string;
}): TerminationManualRepair[] {
  const repairs: TerminationManualRepair[] = [];
  for (const skip of args.skipped) {
    if (!isWritebackTrailLost(skip)) continue;
    repairs.push({
      documentId: args.row.id,
      workerName: args.row.worker_name,
      workEmail: args.row.work_email,
      masterRowId: skip.rowId ?? '',
      column: skip.column,
      wroteValue: writtenValueForColumn(args.row, skip.column),
      reason: skip.reason,
      detectedAt: args.detectedAt,
    });
  }
  return repairs;
}

/** Newest first, one entry per (document, column). An existing entry KEEPS its
 *  original `detectedAt`: it is when the cell was changed, and a repeat report
 *  must not make an old, unrepaired cell look new. */
export function mergeManualRepairs(
  existing: readonly TerminationManualRepair[],
  incoming: readonly TerminationManualRepair[],
): TerminationManualRepair[] {
  const byKey = new Map<string, TerminationManualRepair>();
  for (const r of existing) byKey.set(manualRepairKey(r), r);
  for (const r of incoming) {
    const key = manualRepairKey(r);
    if (!byKey.has(key)) byKey.set(key, r);
  }
  return [...byKey.values()].sort((a, b) =>
    a.detectedAt === b.detectedAt
      ? manualRepairKey(a).localeCompare(manualRepairKey(b))
      : a.detectedAt < b.detectedAt
        ? 1
        : -1,
  );
}

/** Remove one repair, by key. The ONLY way an entry leaves the banner: the rep
 *  states the cell has been put back. Nothing expires on a timer. */
export function dropManualRepair(
  list: readonly TerminationManualRepair[],
  key: string,
): TerminationManualRepair[] {
  return list.filter((r) => manualRepairKey(r) !== key);
}

/** Per-browser, per-origin. Versioned so a shape change cannot be read as the
 *  old shape. */
export const MANUAL_REPAIR_STORAGE_KEY = 'simple-hris.termination-docs.manual-repairs.v1';

const WRITEBACK_COLUMN_SET = new Set<string>(TERMINATION_WRITEBACK_COLUMNS);

function readString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * Parse the stored banner state.
 *
 * Stored data, so every field is read as `unknown`. An entry that cannot be
 * rendered honestly — no document, or a column outside the write-back allowlist
 * — is DROPPED rather than repaired into something plausible: this banner exists
 * to state a fact about a master-list cell, and a guessed fact is worse than a
 * missing one. Malformed JSON yields `[]`, never a throw: the panel must render.
 */
export function readManualRepairs(raw: string | null | undefined): TerminationManualRepair[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: TerminationManualRepair[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const rec = entry as Record<string, unknown>;
    const documentId = readString(rec.documentId).trim();
    const column = readString(rec.column);
    if (!documentId || !WRITEBACK_COLUMN_SET.has(column)) continue;
    out.push({
      documentId,
      workerName: readString(rec.workerName),
      workEmail: readString(rec.workEmail),
      masterRowId: readString(rec.masterRowId),
      column: column as TerminationWritebackColumn,
      wroteValue: typeof rec.wroteValue === 'string' && rec.wroteValue ? rec.wroteValue : null,
      reason: readString(rec.reason),
      detectedAt: readString(rec.detectedAt),
    });
  }
  return mergeManualRepairs(out, []);
}

export function serializeManualRepairs(list: readonly TerminationManualRepair[]): string {
  return JSON.stringify(list);
}
