/** [TERMINATION-DOCS]
 * The blank-only write-back — the ONLY code in this feature that writes to a
 * pre-existing table, and the only irreversible act it performs.
 *
 * It writes `global_master_list` and nothing else. Three columns, allowlisted
 * in the type system (`TERMINATION_WRITEBACK_COLUMNS`): `off_boarded_at`,
 * `off_boarded_reason`, `"Start Date"`. Never `"Department"` — the most-clobbered
 * cell in the system, reverted by the next master sync, and display-only here.
 * Never a rate column — the two rate tables are live pay paths and both engines
 * prorate per-day from `effective_from`, so a "filled-in historical rate"
 * silently re-prices weeks that were already paid.
 *
 * THIS MODULE IS THE SUPABASE ADAPTER, NOTHING MORE. The loop, the guards and
 * the trail bookkeeping live in `./termination-writeback-rules`, which is pure
 * and is what the tests EXECUTE — `server-only` is unresolvable by Node, so a
 * test cannot import this file, and a loop that lived here could only ever be
 * mirrored by a copy inside the test file. A mirror is how a deleted skip branch
 * stays green.
 *
 * Blank-ness is enforced IN THE FILTER CHAIN, never by reading then writing.
 * TWO guarded UPDATEs, one per blank state the database can prove:
 *   `.is(col, null)`  proves the cell was NULL;
 *   `.eq(col, '')`    proves it was the empty string.
 * A read-then-write races the master sync and every other session on this shared
 * surface — POST /api/update-employee-profile and the sheet sync both write
 * these cells with no guard — and an undo record taken from a read can claim a
 * `before` that belonged to somebody else's value, so the reverse would then
 * DESTROY it. `.select('id')` closes the other half of the hole: a
 * guard-filtered UPDATE that matches nothing returns `{ data: [], error: null }`,
 * so WITHOUT the select it reports success while writing nothing.
 * ZERO RETURNED ROWS IS A SKIP, NEVER A SUCCESS.
 *
 * The empty-string guard runs only for the TEXT columns
 * (`TERMINATION_EMPTY_STRING_COLUMNS`). `off_boarded_at` is TIMESTAMPTZ, cannot
 * hold `''`, and `.eq(col, '')` against it raises 22007 — which also means
 * `before: ''` is unreachable for that column and the reverse can never write
 * `''` into a timestamp.
 *
 * A whitespace-only cell is NOT overwritten. Only NULL and `''` can be proved
 * blank inside a filter chain, and `TerminationWritebackRecord.before` can
 * express only those two, so a cell holding `'   '` is SKIPPED with that stated
 * as the reason rather than silently rewritten with `before: ''` — which is what
 * the old read-then-write did, making "the reverse restores the exact prior
 * state" untrue.
 *
 * Keyed on `global_master_list.id`, never on an email: one work email owns
 * several master rows and /api/hr/offboard stamps every active one
 * (app/api/hr/offboard/route.ts:170-171), so an email-keyed reverse can restore
 * the wrong row.
 *
 * The `applied` array is the ONLY undo data that exists, and it is persisted
 * INCREMENTALLY through `persistTrail` — each record reaches
 * `termination_documents.field_writebacks` before the next cell is touched, and
 * a failure there stops the run. A crash between two writes can therefore cost
 * at most one unrecorded cell, not all three. `audit_log` cannot serve as the
 * fallback because `clearAuditLog()` truncates the whole table behind
 * DELETE /api/audit-log; it carries a second copy, not the copy.
 */
import 'server-only';

import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { normEmail } from '@/lib/email/norm-email';
import type { TerminationWritebackColumn } from './types';
import {
  applyTerminationWriteBackWith,
  type TerminationWritebackOutcome,
  type TerminationWritebackPort,
  type TerminationWritebackTrailSink,
} from './termination-writeback-rules';

/** The pure core, re-exported so a caller needs one import site. It is DEFINED
 *  in ./termination-writeback-rules because `server-only` is unresolvable by
 *  Node and the tests cannot load this module — see that file's header. */
export {
  applyTerminationWriteBackWith,
  canHoldEmptyString,
  decideWriteback,
  isBlankCell,
  readStoredWritebackRecord,
  reverseValueForRecord,
  TERMINATION_EMPTY_STRING_COLUMNS,
  TERMINATION_WRITEBACK_TABLE,
  type TerminationWritebackDecision,
  type TerminationWritebackGuard,
  type TerminationWritebackOutcome,
  type TerminationWritebackPort,
  type TerminationWritebackSkip,
  type TerminationWritebackTrailSink,
} from './termination-writeback-rules';

/** The one table this module may name. A const literal for the same reason
 *  `TABLE` is one in termination-log.ts: it makes the blast radius greppable. */
const MASTER_TABLE = 'global_master_list';

/**
 * Fill the blank master cells the rep just supplied answers for.
 *
 * Everything decided here is decided by `applyTerminationWriteBackWith`; this
 * function's whole job is to hand it a port that speaks Supabase, and to refuse
 * to start without a client, a row id and a known actor.
 *
 * `persistTrail` is REQUIRED: the undo trail is written as the cells land, not
 * after. An irreversible write whose record is not yet on disk is exactly the
 * state a crash used to leave behind with no trace anywhere.
 */
export async function applyTerminationWriteBack(args: {
  masterRowId: string;
  values: Partial<Record<TerminationWritebackColumn, string>>;
  actorEmail: string;
  persistTrail: TerminationWritebackTrailSink;
}): Promise<TerminationWritebackOutcome> {
  const nothing: TerminationWritebackOutcome = {
    applied: [],
    persistedTrail: [],
    skipped: [],
    error: null,
    trailError: null,
  };

  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { ...nothing, error: 'Supabase not configured' };

  const rowId = args.masterRowId?.trim();
  if (!rowId) return { ...nothing, error: 'Missing global_master_list row id' };

  // An irreversible write never runs without a known actor: the caller stamps
  // this same address onto the log row and its audit entries.
  if (!normEmail(args.actorEmail)) {
    return { ...nothing, error: 'Missing actor email' };
  }

  const port: TerminationWritebackPort = {
    async updateBlankCell({ column, value, guard }) {
      // `column` comes from the allowlist loop inside the core, so this envelope
      // can only ever carry one of the three permitted identifiers.
      const payload: Record<string, string> = { [column]: value };

      if (guard === 'null') {
        const guarded = await supabase
          .from(MASTER_TABLE)
          .update(payload)
          .eq('id', rowId)
          .is(column, null)
          .select('id');
        return { rows: (guarded.data ?? []).length, error: guarded.error?.message ?? null };
      }

      // The SECOND guarded write: blank-ness proved as `col = ''`, by the
      // database, in the statement that writes. Not a retry of the first — a
      // different guard, and just as filtered.
      const guarded = await supabase
        .from(MASTER_TABLE)
        .update(payload)
        .eq('id', rowId)
        .eq(column, '')
        .select('id');
      return { rows: (guarded.data ?? []).length, error: guarded.error?.message ?? null };
    },

    async readCell(column) {
      // `column` can only be one of the three allowlisted literals, so the
      // quoting below is fixed text, not caller input. `"Start Date"` needs the
      // quotes; the other two are quoted harmlessly for symmetry.
      const current = await supabase
        .from(MASTER_TABLE)
        .select(`id, "${column}"`)
        .eq('id', rowId)
        .maybeSingle();
      if (current.error) return { found: false, value: undefined, error: current.error.message };
      const row = (current.data ?? null) as Record<string, unknown> | null;
      if (!row) return { found: false, value: undefined, error: null };
      return { found: true, value: row[column], error: null };
    },
  };

  return applyTerminationWriteBackWith(port, {
    rowId,
    values: args.values,
    persistTrail: args.persistTrail,
  });
}
