import 'server-only';

/**
 * One pass of the hiring-database sync. Server-only.
 * Doc: docs/features/new-hire-source-sync.md
 *
 *   1. read the source (paged, capped)                         — READ ONLY on their side
 *   2. save every new or changed hire into OUR copy            — hr_new_hire_source_rows
 *   3. decide each undecided hire: place / link / hold         — decidePlacement
 *   4. push source changes into cells the sync owns            — mergeSourceIntoRow
 *   5. Broadcast `changed` to every week room it touched       — open grids refetch in ~1s
 *
 * Idempotent and safe to run concurrently: an unchanged source row costs no
 * write, a second sync placing the same hire loses on the unique index and
 * resolves to the winner's row, and a merge diffs against the DB.
 *
 * Never: writes a locked week, fills a week before this one on its own, lists a
 * hire twice, overwrites a cell HR typed, blanks a cell, deletes anything.
 */

import { broadcastFromServer } from '@/lib/supabase/realtime-broadcast';
import {
  insertHrNewHireChecklistRow,
  updateHrNewHireChecklistRow,
} from '@/lib/supabase/hr-new-hire-checklist';
import {
  findChecklistRowBySourceKey,
  getChecklistCells,
  listChecklistContext,
  listLockedChecklistWeeks,
  listSourceRows,
  probeHiresSyncTables,
  updateSourcePlacement,
  upsertSourceRows,
  type ChecklistContextRow,
  type SourceRow,
  type SourceRowWrite,
} from '@/lib/supabase/hr-new-hire-source-db';

import { readHiresSourceConfig } from './hires-source-config';
import {
  HIRES_SYNC_ACTOR,
  LINK_LOOKBACK_DAYS,
  appliedFromValues,
  canonicalizeHireValues,
  contentHash,
  currentManilaSunday,
  decidePlacement,
  mapSourceRow,
  mergeSourceIntoRow,
  type HireValues,
} from './hires-source-map';
import { pullSourceHires } from './hires-source-read';

/** The room every New Hire Checklist grid joins for a week (useChecklistRoom). */
export function checklistRoomTopic(period: string): string {
  return `hr-nhc-room:${period}`;
}

export type HiresSyncSummary = {
  pulled: number;
  /** Source rows with no usable id — counted, never guessed at. */
  skippedNoId: number;
  newRows: number;
  changedRows: number;
  placed: number;
  /** Of `placed`: went to this week (or the next open one) because the interview
   *  week was unusable — no date, already past, or locked. */
  placedFallback: number;
  linked: number;
  held: number;
  /** Cells the sync wrote on rows already on the checklist (fills + source changes). */
  updatedCells: number;
  touchedWeeks: string[];
  truncated: boolean;
  errors: string[];
};

export type HiresSyncResult =
  | { status: 'not_configured'; reason: string; missing: string[] }
  | { status: 'not_ready'; reason: string }
  | { status: 'source_error'; reason: string }
  | { status: 'error'; reason: string }
  | { status: 'ok'; summary: HiresSyncSummary };

function valuesOf(r: SourceRow): HireValues {
  return {
    name: r.name,
    personal_email: r.personal_email,
    location: r.location,
    phone_number: r.phone_number,
    date_of_interview: r.date_of_interview,
    source: r.source,
    referred_by: r.referred_by,
    hired_by: r.hired_by,
    department: r.department,
    country: r.country,
  };
}

/** Distinct department / source spellings already on the checklist (first-seen casing). */
function knownSpellings(rows: readonly ChecklistContextRow[]): { departments: string[]; sources: string[] } {
  const pick = (key: 'department' | 'source') => {
    const seen = new Map<string, string>();
    for (const r of rows) {
      const v = (r[key] ?? '').trim();
      if (v && !seen.has(v.toLowerCase())) seen.set(v.toLowerCase(), v);
    }
    return [...seen.values()];
  };
  return { departments: pick('department'), sources: pick('source') };
}

export async function runHiresSourceSync(opts: { now?: number } = {}): Promise<HiresSyncResult> {
  const now = opts.now ?? Date.now();
  const nowIso = new Date(now).toISOString();

  const cfg = readHiresSourceConfig();
  if (!cfg.ok) return { status: 'not_configured', reason: cfg.reason, missing: cfg.missing };

  const probe = await probeHiresSyncTables();
  if (!probe.ready) return { status: 'not_ready', reason: probe.reason ?? 'The hires-sync tables are not ready' };

  let pull;
  try {
    pull = await pullSourceHires(cfg.config);
  } catch (e) {
    return { status: 'source_error', reason: e instanceof Error ? e.message : String(e) };
  }

  const summary: HiresSyncSummary = {
    pulled: pull.rows.length,
    skippedNoId: 0,
    newRows: 0,
    changedRows: 0,
    placed: 0,
    placedFallback: 0,
    linked: 0,
    held: 0,
    updatedCells: 0,
    touchedWeeks: [],
    truncated: pull.truncated,
    errors: [],
  };

  // ── 1–2. Our copy: write only what is new or changed ─────────────────────────
  const existing = await listSourceRows();
  if (existing.error) return { status: 'error', reason: `Reading the HRIS copy failed: ${existing.error}` };
  const copyByKey = new Map(existing.rows.map((r) => [r.source_key, r]));

  const writes: SourceRowWrite[] = [];
  const changedKeys = new Set<string>();
  const seenKeys = new Set<string>();
  for (const raw of pull.rows) {
    const mapped = mapSourceRow(raw, cfg.config);
    if (!mapped) {
      summary.skippedNoId++;
      continue;
    }
    if (seenKeys.has(mapped.sourceKey)) continue; // a repeated id upstream: first wins
    seenKeys.add(mapped.sourceKey);
    const hash = contentHash(mapped.values);
    const prior = copyByKey.get(mapped.sourceKey);
    if (prior && prior.content_hash === hash) continue;
    if (prior) {
      summary.changedRows++;
      changedKeys.add(mapped.sourceKey);
    } else {
      summary.newRows++;
    }
    writes.push({
      source_key: mapped.sourceKey,
      ...mapped.values,
      interview_at: mapped.interviewAt,
      source_created_at: mapped.sourceCreatedAt,
      source_updated_at: mapped.sourceUpdatedAt,
      content_hash: hash,
      last_changed_at: nowIso,
    });
  }
  const up = await upsertSourceRows(writes);
  if (up.error) return { status: 'error', reason: `Saving the HRIS copy failed: ${up.error}` };

  // Re-read only if something was written, so the decisions below see the new
  // rows' first_pulled_at and placement defaults.
  const copy = writes.length > 0 ? await listSourceRows() : existing;
  if (copy.error) return { status: 'error', reason: `Reading the HRIS copy failed: ${copy.error}` };

  // Re-decide every pending AND every held hire. Since 2026-10-08 ("A") a hire is
  // held only when every week in the fallback window is locked, so held rows are
  // rare, and each pass must retry them (a week may have reopened, a new one
  // opened). Rows held under the earlier rules (no date / past week) get placed
  // into this week by the first pass that runs this code.
  const toDecide = copy.rows.filter((r) => r.placement === 'pending' || r.placement === 'held');
  const toMerge = copy.rows.filter(
    (r) => changedKeys.has(r.source_key) && (r.placement === 'placed' || r.placement === 'linked') && r.checklist_row_id,
  );
  if (toDecide.length === 0 && toMerge.length === 0) return { status: 'ok', summary };

  // ── 3. Decisions ────────────────────────────────────────────────────────────
  const [ctx, locked] = await Promise.all([listChecklistContext(), listLockedChecklistWeeks()]);
  if (ctx.error) return { status: 'error', reason: `Reading the checklist failed: ${ctx.error}` };
  if (locked.error) return { status: 'error', reason: `Reading the week locks failed: ${locked.error}` };
  const index = [...ctx.rows];
  const known = knownSpellings(ctx.rows);
  const isWeekLocked = (p: string) => locked.weeks.has(p);
  const currentSunday = currentManilaSunday(now);
  // The sync WRITES only this week and later, and never a locked week. A link to
  // a hire HR typed into an older week is recorded, but that week is history.
  const isWritableWeek = (p: string | null): p is string => !!p && p >= currentSunday && !isWeekLocked(p);
  const touched = new Set<string>();

  for (const src of toDecide) {
    const values = canonicalizeHireValues(valuesOf(src), known);
    const decision = decidePlacement({ values, currentSunday, isWeekLocked, checklist: index });

    if (decision.kind === 'hold') {
      if (src.placement !== 'held' || src.hold_reason !== decision.reason || src.target_period_start !== decision.period) {
        const r = await updateSourcePlacement(src.source_key, {
          placement: 'held',
          hold_reason: decision.reason,
          target_period_start: decision.period,
        });
        if (r.error) summary.errors.push(`${src.source_key}: ${r.error}`);
      }
      summary.held++;
      continue;
    }

    if (decision.kind === 'place') {
      const ins = await insertHrNewHireChecklistRow(decision.period, values, {
        createdBy: HIRES_SYNC_ACTOR,
        synced: { sourceKey: src.source_key, receivedAt: src.first_pulled_at },
      });
      let rowId = ins.row?.id ?? null;
      let period = decision.period;
      if (ins.conflict) {
        // A parallel sync placed it a moment ago; adopt that row.
        const won = await findChecklistRowBySourceKey(src.source_key);
        rowId = won.row?.id ?? null;
        period = won.row?.period_start ?? period;
      } else if (ins.error || !ins.row) {
        summary.errors.push(`${src.source_key}: ${ins.error ?? 'insert failed'}`);
        continue;
      }
      const r = await updateSourcePlacement(src.source_key, {
        placement: 'placed',
        hold_reason: null,
        target_period_start: period,
        checklist_row_id: rowId,
        placed_at: nowIso,
        placed_by: HIRES_SYNC_ACTOR,
        applied_values: appliedFromValues(values),
      });
      if (r.error) summary.errors.push(`${src.source_key}: ${r.error}`);
      // A second source row for the same person in this batch must LINK, not add.
      if (rowId) {
        index.push({
          id: rowId,
          period_start: period,
          personal_email: values.personal_email,
          name: values.name,
          department: values.department,
          source: values.source,
        });
      }
      touched.add(period);
      summary.placed++;
      if (decision.fallback) summary.placedFallback++;
      continue;
    }

    // link: fill the blanks of the row HR typed — only in a writable week.
    let applied: Partial<HireValues> = {};
    if (isWritableWeek(decision.period)) {
      const cells = await getChecklistCells([decision.rowId]);
      const current = cells.rows.get(decision.rowId);
      if (current) {
        const m = mergeSourceIntoRow({ current, applied: null, incoming: values });
        applied = m.nextApplied;
        if (Object.keys(m.updates).length > 0) {
          const upd = await updateHrNewHireChecklistRow(decision.rowId, m.updates, { editedBy: HIRES_SYNC_ACTOR });
          if (upd.error) summary.errors.push(`${src.source_key}: ${upd.error}`);
          else {
            summary.updatedCells += Object.keys(m.updates).length;
            touched.add(decision.period);
          }
        }
      }
    }
    // A link changes what that week's grid shows (the row gains its "In database" tag),
    // so the week refreshes like a placement does. (Only pending/held hires get here,
    // so this is always a FIRST link.)
    touched.add(decision.period);
    const r = await updateSourcePlacement(src.source_key, {
      placement: 'linked',
      hold_reason: null,
      target_period_start: decision.period,
      checklist_row_id: decision.rowId,
      placed_at: nowIso,
      placed_by: HIRES_SYNC_ACTOR,
      applied_values: applied,
    });
    if (r.error) summary.errors.push(`${src.source_key}: ${r.error}`);
    summary.linked++;
  }

  // ── 4. Source changes reach the cells the sync owns ─────────────────────────
  if (toMerge.length > 0) {
    const cells = await getChecklistCells(toMerge.map((r) => r.checklist_row_id!));
    if (cells.error) summary.errors.push(`checklist read: ${cells.error}`);
    for (const src of toMerge) {
      const current = cells.rows.get(src.checklist_row_id!);
      const week = current?.period_start ?? null;
      if (!current || !isWritableWeek(week)) continue;
      const values = canonicalizeHireValues(valuesOf(src), known);
      const m = mergeSourceIntoRow({ current, applied: src.applied_values ?? {}, incoming: values });
      if (Object.keys(m.updates).length === 0) continue;
      const upd = await updateHrNewHireChecklistRow(current.id, m.updates, { editedBy: HIRES_SYNC_ACTOR });
      if (upd.error) {
        summary.errors.push(`${src.source_key}: ${upd.error}`);
        continue;
      }
      summary.updatedCells += Object.keys(m.updates).length;
      touched.add(week);
      const r = await updateSourcePlacement(src.source_key, {
        placement: src.placement,
        hold_reason: null,
        target_period_start: src.target_period_start,
        applied_values: m.nextApplied,
      });
      if (r.error) summary.errors.push(`${src.source_key}: ${r.error}`);
    }
  }

  // ── 5. Tell every open grid on a touched week to refetch ────────────────────
  summary.touchedWeeks = [...touched].sort();
  for (const week of summary.touchedWeeks) {
    void broadcastFromServer(checklistRoomTopic(week), 'changed', { e: HIRES_SYNC_ACTOR });
  }
  return { status: 'ok', summary };
}

export type PlaceHeldResult =
  | { ok: true; rowId: string; period: string }
  | { ok: false; status: number; reason: string };

/**
 * HR places a held hire by hand ("Add to this week"). The week must be open; the
 * hire must still be held (a placed or linked hire is refused, so a double-click
 * or a second coordinator cannot list it twice — the unique index backs that
 * up). The row is an ordinary synced row, attributed to the person who placed it.
 */
export async function placeHeldSourceHire(args: {
  sourceKey: string;
  period: string;
  isWeekLocked: boolean;
  actor: string;
  getRow: (key: string) => Promise<{ row: SourceRow | null; error: string | null }>;
}): Promise<PlaceHeldResult> {
  if (args.isWeekLocked) return { ok: false, status: 409, reason: 'This week is locked. Reopen it before adding hires.' };
  const { row: src, error } = await args.getRow(args.sourceKey);
  if (error) return { ok: false, status: 500, reason: error };
  if (!src) return { ok: false, status: 404, reason: 'That hire is not in the HRIS copy of the hiring database.' };
  if (src.placement !== 'held') {
    return { ok: false, status: 409, reason: 'That hire is already on the checklist.' };
  }
  const ctx = await listChecklistContext();
  if (ctx.error) return { ok: false, status: 500, reason: ctx.error };
  const values = canonicalizeHireValues(valuesOf(src), knownSpellings(ctx.rows));
  // HR may have typed this person in since the hire was held — then "Add" would
  // be a second listing (a second orientation email). Same email in the chosen
  // week or the 4 weeks before it / any week after → refuse and say where.
  const email = values.personal_email?.toLowerCase() ?? null;
  if (email) {
    const floor = new Date(Date.parse(`${args.period}T00:00:00Z`) - LINK_LOOKBACK_DAYS * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const dup = ctx.rows.find(
      (r) => (r.personal_email ?? '').trim().toLowerCase() === email && r.period_start >= floor,
    );
    if (dup) {
      return { ok: false, status: 409, reason: `This hire is already on the checklist (week of ${dup.period_start}).` };
    }
  }
  const ins = await insertHrNewHireChecklistRow(args.period, values, {
    createdBy: args.actor,
    synced: { sourceKey: src.source_key, receivedAt: src.first_pulled_at },
  });
  if (ins.conflict) return { ok: false, status: 409, reason: 'That hire is already on the checklist.' };
  if (ins.error || !ins.row) return { ok: false, status: 500, reason: ins.error ?? 'Insert failed' };
  const nowIso = new Date().toISOString();
  const r = await updateSourcePlacement(src.source_key, {
    placement: 'placed',
    hold_reason: null,
    target_period_start: args.period,
    checklist_row_id: ins.row.id,
    placed_at: nowIso,
    placed_by: args.actor.toLowerCase(),
    applied_values: appliedFromValues(values),
  });
  if (r.error) return { ok: false, status: 500, reason: `Added, but the HRIS copy was not updated: ${r.error}` };
  void broadcastFromServer(checklistRoomTopic(args.period), 'changed', { e: args.actor.toLowerCase() });
  return { ok: true, rowId: ins.row.id, period: args.period };
}
