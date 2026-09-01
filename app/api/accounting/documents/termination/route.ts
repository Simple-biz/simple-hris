import { randomUUID } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { requireFeatureAccess, requireFeatureEdit } from '@/lib/auth/authorize-feature';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { normEmail } from '@/lib/email/norm-email';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { offboardReasonLabel } from '@/lib/hr/offboard-reasons';
import { formatDeptLabel } from '@/lib/departments/hsl-subdept';
import { formatCoeStartDate } from '@/lib/documents/coe-facts';
import { getDocumentSignature } from '@/lib/documents/signatures';
import { resolveTerminationFacts } from '@/lib/documents/termination/termination-facts';
import { renderTerminationDocument } from '@/lib/documents/termination/termination-document';
import {
  auditTerminationWriteback,
  createTerminationDocument,
  listTerminationDocuments,
  signedUrlForTerminationDocument,
} from '@/lib/documents/termination/termination-log';
import { applyTerminationWriteBack } from '@/lib/documents/termination/termination-writeback';
import {
  admitFilledDay,
  admitFilledFields,
  admitFilledReason,
  checkMergedTerminationDates,
  decideTerminationSignatureGate,
  describeMissingRequiredFacts,
  resolveFilledRateCurrency,
  terminationThrownStatus,
  TERMINATION_SIGNATURE_MISSING_MESSAGE,
  type TerminationRouteRejection,
} from '@/lib/documents/termination/termination-route-rules';
import {
  type TerminationBlankField,
  type TerminationBlockedReason,
  type TerminationFacts,
  type TerminationGenerateRequest,
  type TerminationGenerateResponse,
  type TerminationLogResponse,
  type TerminationWritebackColumn,
  type TerminationWritebackRecord,
} from '@/lib/documents/termination/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * [TERMINATION-DOCS] Accounting → Documents → Termination Docs.
 *
 *   GET  ?q=&before=&limit=  → the permanent log (view).
 *   POST { work_email, filled, write_back } → generate + sign a letter (edit).
 *
 * Both gates name the EXISTING `('accounting', 'documents')` feature. This tab
 * deliberately adds no feature key: `resolveFeatureAccess` defaults an unknown
 * key to `'hidden'` and `provisionDashboardTabs` only backfills on a role grant,
 * so a new key would make the whole Documents tab vanish for every current rep.
 */

/** The write-back trail lives on the document row. Module-const literal, never a
 *  parameter — the same rule `termination-log.ts` follows for G8. */
const TABLE = 'termination_documents';

/** Every ORDERED decision in the POST below - the blanks admission, G2's
 *  layer-3 reason re-validation, the rate currency, G4's merged-date re-check
 *  and G9's signature ladder - lives in `termination-route-rules.ts` and is
 *  unit-tested there. `npm test` is `node --import tsx --test "src/**\/*.test.ts"`,
 *  so a decision left inside this handler is a decision with no proof behind it.
 */

/** One exit for every refusal the pure rules return, so a rule's status,
 *  message and `blocked` reach the client exactly as its test pinned them. */
function rejected(rejection: TerminationRouteRejection): NextResponse {
  return generateFailure(rejection.message, rejection.status, rejection.blocked);
}

function generateFailure(
  message: string,
  status: number,
  blocked: TerminationBlockedReason | null = null,
): NextResponse {
  const body: TerminationGenerateResponse = {
    row: null,
    url: null,
    blocked,
    writebacks: [],
    writeback_skipped: [],
    error: message,
  };
  return NextResponse.json(body, { status });
}

/** A rep-typed rate. Commas are stripped for the same reason `parseRateText`
 *  strips them (`Number('1,234.50')` is NaN). Zero and negative are REJECTED,
 *  not stored: "a zero rate is not a rate", and both DB CHECKs demand `> 0`. */
function repSuppliedRate(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, '').trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Attach the write-back trail to the document row, AS EACH CELL LANDS.
 *
 * `field_writebacks` is the ONLY undo data for the three `global_master_list`
 * cells this feature may fill — `audit_log` cannot hold it because
 * `clearAuditLog()` truncates that table behind `DELETE /api/audit-log`. The
 * write-back is deliberately the LAST thing that happens (a failure there must
 * not cost the rep the document), so the trail cannot be part of the original
 * insert.
 *
 * This is passed to `applyTerminationWriteBack` as its `persistTrail` sink and
 * called with the WHOLE accumulated array immediately after every successful
 * cell write, before the next cell is attempted. One trailing UPDATE after all
 * three writes had landed meant a crash, timeout or recycled process in between
 * lost every undo record with no trace: the master cells were changed for good,
 * `field_writebacks` stayed `'[]'`, and the reverse script reported a clean
 * "nothing to reverse". Writing the same full array each time is idempotent and
 * monotonic, so a repeat call can never shrink what is on disk.
 */
async function persistWritebackTrail(
  documentRowId: string,
  records: readonly TerminationWritebackRecord[],
): Promise<string | null> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return 'Supabase not configured';
  const { data, error } = await supabase
    .from(TABLE)
    .update({ field_writebacks: [...records] })
    .eq('id', documentRowId)
    .select('id');
  if (error) return error.message;
  // Zero rows is a silent no-op on PostgREST: without `.select('id')` this would
  // report success while the undo data went nowhere.
  if (!data || data.length === 0) return 'the document row could not be found to attach the undo trail';
  return null;
}

export async function GET(req: NextRequest) {
  const authz = await requireFeatureAccess('accounting', 'documents', 'view');
  if (!authz.ok) return deniedResponse(authz);

  const params = req.nextUrl.searchParams;
  const query = params.get('q')?.trim() || undefined;
  const before = params.get('before')?.trim() || undefined;
  const rawLimit = Number(params.get('limit'));
  const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? rawLimit : undefined;

  const { rows, truncated, error } = await listTerminationDocuments({ query, before, limit });
  if (error) {
    // A refused cursor is the CALLER's mistake, not a broken read — the log
    // refuses a malformed `before` rather than silently handing back page one,
    // and a 500 there would send the panel into a retry loop.
    const status = error === 'Invalid cursor' ? 400 : 500;
    return NextResponse.json({ rows: [], truncated: false, error } as TerminationLogResponse, { status });
  }
  return NextResponse.json({ rows, truncated } as TerminationLogResponse);
}

/**
 * Generate one signed termination letter.
 *
 * This handler is the trust boundary. The body carries an identity, values for
 * blanks, and an opt-in flag — nothing else is believed:
 *   · every printed fact is RE-RESOLVED here from the work email alone;
 *   · a `filled` key the server's own resolution did not report blank is a 400,
 *     so a client cannot overwrite a fact that exists in the record;
 *   · a filled reason passes `isTerminationDepartureReason` before use — G2's
 *     third layer, under the type system and over the DB CHECK;
 *   · the signature comes from the SESSION email, never from a body field;
 *   · any refusal is a 409 and nothing is rendered, stored, or written back.
 */
export async function POST(req: NextRequest) {
  const authz = await requireFeatureEdit('accounting', 'documents');
  if (!authz.ok) return deniedResponse(authz);

  try {
    const body = (await req.json().catch(() => ({}))) as Partial<TerminationGenerateRequest>;

    const workEmail = normEmail(body.work_email);
    if (!workEmail) return generateFailure('work_email is required', 400);

    const resolved = await resolveTerminationFacts(workEmail);
    // `!== null`, not truthiness: the 3-arm result discriminates on `error`
    // being `null` vs `string`, and `''` is a falsy string — a truthy test
    // leaves the error arm alive, so `resolved.facts` stays `| null` and an
    // empty-message read failure would fall through into the render path with
    // no facts at all. Explicit null checks eliminate both non-facts arms.
    if (resolved.error !== null) return generateFailure(resolved.error, 500);
    if (resolved.blocked !== null) {
      return generateFailure(resolved.blocked.message, 409, resolved.blocked);
    }
    const facts: TerminationFacts = resolved.facts;

    // ── The rep's values, admitted only into holes the SERVER found ──────────
    // An unrecognised key is refused before any value is read; a recognised one
    // is refused unless the SERVER's own resolution reported that field blank.
    const supplied = (body.filled ?? {}) as Record<string, unknown>;
    const admitted = admitFilledFields(supplied, facts.blanks);
    if (!admitted.ok) return rejected(admitted.rejection);
    const filledFields: TerminationBlankField[] = admitted.value;

    const merged: TerminationFacts = { ...facts };

    // ONE clock for both supplied days, so a request cannot straddle midnight and
    // have the two dates judged against different "todays".
    const now = new Date();

    if (filledFields.includes('termination_date')) {
      // G5 on the POST path, via the pure admitter: the panel's ISO_DAY shape,
      // then `explicitMasterDay` — the same gate every RESOLVED date passes, and
      // the one thing `sanitizeOffboardDay(normalizeMasterDate(v))` alone could
      // not do, because that pair happily fabricates the parts a value omits.
      const day = admitFilledDay({ label: 'Termination date', raw: supplied.termination_date, now });
      if (!day.ok) return rejected(day.rejection);
      merged.terminationDate = day.value;
      merged.terminationDateLabel = formatCoeStartDate(day.value);
    }

    if (filledFields.includes('reason')) {
      // G2, layer 3. The allowlist is VALID_OFFBOARD_REASONS minus
      // 'temporary_pause': a suspension can never become a termination letter.
      const reason = admitFilledReason(supplied.reason);
      if (!reason.ok) return rejected(reason.rejection);
      merged.reasonKey = reason.value;
      merged.reasonLabel = offboardReasonLabel(reason.value);
    }

    if (filledFields.includes('ending_department')) {
      // `endingDepartmentRaw` stays as resolved — it means "what the master cell
      // held", and the rep typing a label does not change that. Only the printed
      // label moves, and it goes through formatDeptLabel so no `hsl:` slug can
      // reach a human-readable column.
      const label = formatDeptLabel(String(supplied.ending_department));
      if (!label) return generateFailure('Ending department cannot be empty', 400);
      merged.endingDepartmentLabel = label;
    }

    if (filledFields.includes('start_date')) {
      const day = admitFilledDay({ label: 'Start date', raw: supplied.start_date, now });
      if (!day.ok) return rejected(day.rejection);
      merged.startDate = day.value;
      merged.startDateLabel = formatCoeStartDate(day.value);
    }

    // A rep-filled rate keeps the currency the RECORD holds - risk 4, print the
    // NATIVE currency. This was a hardcoded 'PHP', which printed a COP salary as
    // a peso figure on a signed letter and stored 'PHP' beside it.
    // `facts.<rate>.currency` is the badge the panel showed the rep, and a
    // currency echoed back in the body must still agree with it.
    if (filledFields.includes('starting_rate')) {
      const amount = repSuppliedRate(supplied.starting_rate);
      if (amount === null) return generateFailure('Starting rate must be greater than zero', 400);
      const currency = resolveFilledRateCurrency({
        label: 'Starting rate',
        supplied: supplied.starting_rate_currency,
        resolved: facts.startingRate.currency,
      });
      if (!currency.ok) return rejected(currency.rejection);
      merged.startingRate = {
        amount,
        currency: currency.value,
        source: 'rep_supplied',
        blankReason: null,
      };
    }

    if (filledFields.includes('ending_rate')) {
      const amount = repSuppliedRate(supplied.ending_rate);
      if (amount === null) return generateFailure('Ending rate must be greater than zero', 400);
      const currency = resolveFilledRateCurrency({
        label: 'Ending rate',
        supplied: supplied.ending_rate_currency,
        resolved: facts.endingRate.currency,
      });
      if (!currency.ok) return rejected(currency.rejection);
      merged.endingRate = {
        amount,
        currency: currency.value,
        source: 'rep_supplied',
        blankReason: null,
      };
    }

    // Recomputed from the merged values, never carried over — the snapshot on the
    // row has to say which facts were STILL blank when the letter was signed.
    const remaining: TerminationBlankField[] = [];
    if (!merged.terminationDate) remaining.push('termination_date');
    if (!merged.reasonKey) remaining.push('reason');
    if (!merged.endingDepartmentLabel) remaining.push('ending_department');
    if (!merged.startDate) remaining.push('start_date');
    if (merged.startingRate.amount === null) remaining.push('starting_rate');
    if (merged.endingRate.amount === null) remaining.push('ending_rate');
    merged.blanks = remaining;

    const missing = describeMissingRequiredFacts(remaining);
    if (missing) return rejected(missing);

    // G4 again, against the MERGED dates: the rep can only have made this true by
    // filling one of them, and the DDL restates it as
    // `check (start_date is null or termination_date > start_date)`. Comparing
    // 'YYYY-MM-DD' strings is a calendar comparison with no Date parsing.
    const rehire = checkMergedTerminationDates(merged.terminationDate, merged.startDate);
    if (rehire) return rejected(rehire);

    // ── The signature: the SESSION rep's own, and live (G9) ──────────────────
    // The whole ladder is `decideTerminationSignatureGate`: `error` FIRST (a null
    // row carrying 'Supabase not configured' is a config failure - a 500 - and
    // reading it as "no signature" would steer the rep into re-drawing a
    // signature they already have), then no row, then the revoke switch. That
    // ORDER is the guard, so it is pinned in termination-route-rules.test.ts
    // instead of being restated here where no test can reach it.
    const loaded = await getDocumentSignature(authz.sessionEmail);
    const gate = decideTerminationSignatureGate(loaded);
    if (!gate.ok) return rejected(gate.rejection);
    // The gate already refused every null-row case; re-reading `loaded.row` into
    // a local is what NARROWS it for the render below, since the guard ran in
    // another function.
    const signature = loaded.row;
    if (!signature) return generateFailure(TERMINATION_SIGNATURE_MISSING_MESSAGE, 412);

    const signerName = signature.owner_name?.trim() || authz.sessionEmail;
    const signerTitle = signature.title?.trim() || 'Accounting Head';
    const documentId = randomUUID();
    const generatedAtIso = new Date().toISOString();

    const bytes = await renderTerminationDocument({
      facts: merged,
      documentId,
      generatedAtIso,
      signature: {
        dataUrl: signature.image_data_url,
        name: signerName,
        title: signerTitle,
        email: authz.sessionEmail,
        signedAtIso: generatedAtIso,
      },
    });

    // Upload + row insert + the awaited audit write. The trail starts empty
    // because the write-back has not run yet, on purpose: it is appended
    // incrementally below as each cell lands, and audited by its own
    // `documents.termination_writeback` entry once it has.
    const { row, error: createErr } = await createTerminationDocument({
      facts: merged,
      filled: filledFields,
      bytes,
      generatedBy: authz.sessionEmail,
      generatedByName: signerName,
      generatedByTitle: signerTitle,
      generatedAtIso,
      documentId,
      writebacks: [],
    });
    if (createErr || !row) {
      return generateFailure(createErr ?? 'Could not save the termination document', 500);
    }

    const { url } = await signedUrlForTerminationDocument(row);

    // ── Write-back, LAST, and never fatal ───────────────────────────────────
    // The document is the deliverable. From here on every failure is reported as
    // a skip and returned with a 200: the letter exists, is stored, and is
    // audited, and a rep who is told which cell did not get filled can fix it in
    // People. Losing the PDF over a master-list write would be the worse trade.
    const writebacks: TerminationWritebackRecord[] = [];
    const skipped: TerminationGenerateResponse['writeback_skipped'] = [];

    if (body.write_back === true) {
      const values: Partial<Record<TerminationWritebackColumn, string>> = {};
      // Only cells the REP filled are candidates. A fact the server resolved is
      // already on the record; re-writing it would be a clobber, not a fill.
      if (filledFields.includes('termination_date') && merged.terminationDate) {
        // The calendar day, not a synthesised timestamp — the letter states a day,
        // and normalizeMasterDate reads the same prefix back out.
        values.off_boarded_at = merged.terminationDate;
      }
      if (filledFields.includes('reason') && merged.reasonKey) {
        values.off_boarded_reason = merged.reasonKey;
      }
      if (filledFields.includes('start_date') && merged.startDate) {
        values['Start Date'] = merged.startDate;
      }

      const columns = Object.keys(values) as TerminationWritebackColumn[];
      const masterRowId = merged.identity.masterRowId;

      if (columns.length > 0 && !masterRowId) {
        // No arbitrated master row means no id to key the REVERSE on, and the
        // reverse is keyed on global_master_list.id because one work email owns
        // several rows. Skipping is the only safe answer.
        for (const column of columns) {
          skipped.push({
            column,
            rowId: '',
            reason: 'no master row won the arbitration — there is nothing to write back safely',
          });
        }
      } else if (columns.length > 0 && masterRowId) {
        // The undo trail is written AS THE CELLS LAND, not afterwards: the sink
        // patches `field_writebacks` after every successful column and the
        // write-back stops if that patch fails, so the trail on disk is never
        // behind the mutations it describes. It also already reports the
        // "WRITTEN but not recorded" state per column, which is why nothing is
        // stitched on here any more.
        const wb = await applyTerminationWriteBack({
          masterRowId,
          values,
          actorEmail: authz.sessionEmail,
          persistTrail: (records) => persistWritebackTrail(row.id, records),
        });
        // What the ROW holds, which is what the reverse script can act on. A
        // record that was written but whose trail patch failed is reported in
        // `skipped`, never counted here as reversible.
        writebacks.push(...wb.persistedTrail);
        skipped.push(...wb.skipped);
        if (wb.error) {
          const accounted = new Set<string>([
            ...wb.applied.map((r) => r.column),
            ...wb.skipped.map((s) => s.column),
          ]);
          for (const column of columns) {
            if (accounted.has(column)) continue;
            skipped.push({ column, rowId: masterRowId, reason: `write-back failed: ${wb.error}` });
          }
        }

        // The irreversible write gets its own audit entry, AFTER it ran and
        // carrying the records. The generation entry cannot: it is inserted
        // before the write-back, so its `field_writebacks` is always []. This is
        // the cheap second copy that makes the single-copy window survivable —
        // `audit_log` is not a substitute for the row (clearAuditLog() truncates
        // it), but an unaudited irreversible write is not acceptable either.
        if (wb.applied.length > 0) {
          const wbAudit = await auditTerminationWriteback({
            documentId: row.id,
            workEmail: merged.identity.workEmail,
            masterRowId,
            actorEmail: authz.sessionEmail,
            applied: wb.applied,
            persistedTrail: wb.persistedTrail,
            skipped: wb.skipped,
            writebackError: wb.error,
            trailError: wb.trailError,
          });
          if (wbAudit.error) {
            for (const record of wb.applied) {
              // A record already reported as "WRITTEN but not recorded" is not
              // re-reported here; for the rest the cell is still reversible from
              // the row, and it is only the audit copy that is missing.
              // Keyed on the column, not on object identity: one column can be
              // written at most once per run.
              if (!wb.persistedTrail.some((p) => p.column === record.column)) continue;
              skipped.push({
                column: record.column,
                rowId: record.rowId,
                reason: `WRITTEN and undo-recorded on the document row, but the audit entry failed (${wbAudit.error}) — the cell is reversible, the audit copy is not there`,
              });
            }
          }
        }
      }
    }

    // `writebacks` is the trail the DB row actually holds (the sink confirmed
    // every record in it), so the response cannot show the rep a "written back"
    // count that only exists in this process's memory.
    const responseRow = writebacks.length > 0 ? { ...row, field_writebacks: writebacks } : row;
    const success: TerminationGenerateResponse = {
      row: responseRow,
      url: url ?? null,
      blocked: null,
      writebacks,
      writeback_skipped: skipped,
    };
    return NextResponse.json(success);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // The 412 substrings are matched, not typed — the UI steers the rep into the
    // signature-capture dialog on them (`[id]/route.ts:73`). Reproduced here so a
    // message thrown from deeper in the stack maps the same way.
    return generateFailure(msg, terminationThrownStatus(msg));
  }
}
