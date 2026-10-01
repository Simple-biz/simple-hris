import 'server-only';

/**
 * Accounting Scoreboard data access: the member check, the board read, and every write.
 * Governing doc: docs/features/accounting-scoreboard.md.
 *
 * WHO MAY USE IT. Access comes from the board's own member list, not from an HRIS role:
 *   - managers  = the `admin` and `accounting` roles. They also run Setup (rows, members, switches).
 *   - members   = anyone whose work email (or one of its alternates) is on a live person row,
 *                 or on accounting_scoreboard_members.
 * Why not a role: only 11 people hold `accounting` (2026-10-01), most of the PH team who type the
 * numbers hold no HRIS role at all, and `accounting` also opens payroll and bank data.
 *
 * Every *_by column is the SESSION email. Nothing here reads a "who" from a request body.
 * Every list read is paged (selectAllPaged): PostgREST truncates at 1000 rows.
 * Nothing here writes pay. The bonus is only previewed (bonus-preview.ts).
 */

import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth/auth-options';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { selectAllPaged } from '@/lib/supabase/select-all-paged';
import { expandWorkEmailAliases } from '@/lib/email/work-email-aliases';
import { isSectionKey, type SectionKey, type SectionSetting, type Slot } from './sections';
import { addDays, todayEastern, weekStartOf } from './week';
import { collectionsHistory, type CollectionEntry, type StoredEntry } from './scoring';
import { pickPreviewBonus, type FormulaBonus, type PreviewVerdict } from './bonus-preview';
import type { BoardMember, BoardPayload, BoardRow, RosterPerson } from './types';
import {
  entryAllowed,
  type CollectionCreate,
  type EntryWrite,
  type RowCreate,
  type RowPatch,
  type SectionPatch,
} from './validate';

const ROWS = 'accounting_scoreboard_rows';
const ENTRIES = 'accounting_scoreboard_entries';
const COLLECTIONS = 'accounting_scoreboard_collections';
const MEMBERS = 'accounting_scoreboard_members';
const SECTIONS_TABLE = 'accounting_scoreboard_sections';

export const MANAGER_ROLES: readonly string[] = ['admin', 'accounting'];

export interface Viewer {
  email: string;
  aliases: string[];
  roles: string[];
  isManager: boolean;
}

export type Failure = { ok: false; status: number; code: string; message: string };
export type Result<T> = { ok: true; value: T } | Failure;

const fail = (status: number, code: string, message: string): Failure => ({ ok: false, status, code, message });

const NO_STORE = { 'Cache-Control': 'no-store' };

export function failureResponse(f: Failure): NextResponse {
  return NextResponse.json({ error: f.message, code: f.code }, { status: f.status, headers: NO_STORE });
}

export function okResponse(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

export function badRequest(message: string): NextResponse {
  return failureResponse(fail(400, 'bad_request', message));
}

/** Last-resort handler for a route that threw: never a stack trace, never an HTML page. */
export function crashResponse(e: unknown): NextResponse {
  const message = e instanceof Error ? e.message : String(e);
  return failureResponse(fail(500, 'server_error', message));
}

export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

/** PostgREST / Postgres "relation does not exist": the migration has not been applied yet. */
function isMissingTable(message: string | undefined): boolean {
  return !!message && /does not exist|schema cache|PGRST205|42P01/i.test(message);
}

const NOT_SET_UP = fail(
  503,
  'not_set_up',
  'The Accounting Scoreboard tables are not set up yet. The migration has to be applied first (scripts/apply-accounting-scoreboard-migration.mts).',
);

function dbFailure(error: { message?: string; code?: string } | null | undefined, fallback: string): Failure {
  if (isMissingTable(error?.message)) return NOT_SET_UP;
  if (error?.code === '23505') return fail(409, 'conflict', 'That is already on this section.');
  if (error?.code === '23514' || error?.code === '23503' || error?.code === '22P02') {
    return fail(422, 'refused', error?.message ?? fallback);
  }
  return fail(500, 'db_error', error?.message ?? fallback);
}

function client() {
  const sb = createSupabaseServiceRoleClient();
  if (!sb) throw new Error('Supabase service role is not configured');
  return sb;
}

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

/** Session → viewer, with the member (or manager) check. */
export async function resolveAccess(level: 'member' | 'manager'): Promise<Result<Viewer>> {
  const session = await getServerSession(authOptions);
  const user = session?.user as { email?: string | null; roles?: string[] } | undefined;
  const email = (user?.email ?? '').trim().toLowerCase();
  if (!email) return fail(401, 'auth_required', 'Not signed in');
  const roles = user?.roles ?? [];
  const isManager = roles.some((r) => MANAGER_ROLES.includes(r));
  const aliases = await expandWorkEmailAliases(email);
  const viewer: Viewer = { email, aliases: aliases.length ? aliases : [email], roles, isManager };

  if (level === 'manager') {
    return isManager
      ? { ok: true, value: viewer }
      : fail(403, 'not_manager', 'Only Accounting or Admin can change the scoreboard setup.');
  }
  if (isManager) return { ok: true, value: viewer };

  const sb = client();
  const [rowHit, memberHit] = await Promise.all([
    sb.from(ROWS).select('id').in('work_email', viewer.aliases).is('archived_at', null).limit(1),
    sb.from(MEMBERS).select('work_email').in('work_email', viewer.aliases).is('removed_at', null).limit(1),
  ]);
  if (rowHit.error) return dbFailure(rowHit.error, 'Could not check membership');
  if (memberHit.error) return dbFailure(memberHit.error, 'Could not check membership');
  if ((rowHit.data ?? []).length || (memberHit.data ?? []).length) return { ok: true, value: viewer };
  return fail(
    403,
    'not_member',
    "You're not on the Accounting Scoreboard. Ask Carla or Claire to add you under Setup → Members.",
  );
}

// ---------------------------------------------------------------------------
// The board
// ---------------------------------------------------------------------------

type RowRecord = {
  id: string;
  section_key: string;
  label: string;
  work_email: string | null;
  sort_order: number;
  archived_at: string | null;
};
type EntryRecord = { row_id: string; entry_date: string; slot: Slot; value: number | string };
type CollectionRecord = {
  id: string;
  entry_date: string;
  row_id: string;
  business_name: string;
  points: number | string;
  amount_usd: number | string | null;
  created_by: string;
  created_at: string;
};

function mapRow(r: RowRecord): BoardRow | null {
  if (!isSectionKey(r.section_key)) return null;
  return {
    id: r.id,
    sectionKey: r.section_key,
    label: r.label,
    workEmail: r.work_email,
    sortOrder: r.sort_order,
    archived: r.archived_at !== null,
  };
}

function mapEntry(r: EntryRecord): StoredEntry {
  return { rowId: r.row_id, date: r.entry_date, slot: r.slot, value: Number(r.value) };
}

function mapCollection(r: CollectionRecord): CollectionEntry {
  return {
    id: r.id,
    date: r.entry_date,
    rowId: r.row_id,
    businessName: r.business_name,
    points: Number(r.points),
    amountUsd: r.amount_usd === null ? null : Number(r.amount_usd),
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}

const ROW_COLS = 'id, section_key, label, work_email, sort_order, archived_at';
const COLLECTION_COLS = 'id, entry_date, row_id, business_name, points, amount_usd, created_by, created_at';

async function readBonusCandidates(): Promise<PreviewVerdict> {
  const sb = client();
  const { data: assigns, error: aErr } = await sb
    .from('bonus_catalog_assignments')
    .select('bonus_id')
    .eq('department_key', 'accounting')
    .eq('scope', 'department');
  if (aErr) return { ok: false, reason: `Could not read the Payment Catalog: ${aErr.message}` };
  const ids = [...new Set((assigns ?? []).map((a: { bonus_id: string }) => a.bonus_id))];
  if (!ids.length) return pickPreviewBonus([]);
  const { data: bonuses, error: bErr } = await sb
    .from('bonus_catalog_bonuses')
    .select('id, name, kind, formula, version, currency')
    .in('id', ids)
    .eq('kind', 'formula');
  if (bErr) return { ok: false, reason: `Could not read the Payment Catalog: ${bErr.message}` };
  const candidates: FormulaBonus[] = (bonuses ?? []).map(
    (b: { id: string; name: string; formula: string | null; version: number | null; currency: string | null }) => ({
      id: b.id,
      name: b.name,
      formula: b.formula ?? '',
      version: b.version ?? null,
      currency: b.currency ?? null,
    }),
  );
  return pickPreviewBonus(candidates);
}

export async function readBoard(viewer: Viewer, weekStart: string): Promise<Result<BoardPayload>> {
  const sb = client();
  const today = todayEastern();
  const lastWeekStart = addDays(weekStart, -7);
  const weekEnd = addDays(weekStart, 6);

  const [liveRows, entries, collections, history, settings, bonus] = await Promise.all([
    selectAllPaged<RowRecord>((from, to) =>
      sb.from(ROWS).select(ROW_COLS).is('archived_at', null).order('id').range(from, to),
    ),
    selectAllPaged<EntryRecord>((from, to) =>
      sb
        .from(ENTRIES)
        .select('row_id, entry_date, slot, value')
        .gte('entry_date', lastWeekStart)
        .lte('entry_date', weekEnd)
        .order('row_id')
        .order('entry_date')
        .order('slot')
        .range(from, to),
    ),
    selectAllPaged<CollectionRecord>((from, to) =>
      sb
        .from(COLLECTIONS)
        .select(COLLECTION_COLS)
        .is('deleted_at', null)
        .gte('entry_date', lastWeekStart)
        .lte('entry_date', weekEnd)
        .order('id')
        .range(from, to),
    ),
    selectAllPaged<{ entry_date: string; row_id: string; points: number | string }>((from, to) =>
      sb.from(COLLECTIONS).select('entry_date, row_id, points').is('deleted_at', null).order('id').range(from, to),
    ),
    sb.from(SECTIONS_TABLE).select('section_key, enabled, goal'),
    readBonusCandidates(),
  ]);

  for (const r of [liveRows, entries, collections, history]) {
    if (r.error) return dbFailure({ message: r.error }, 'Could not read the scoreboard');
  }
  if (settings.error) return dbFailure(settings.error, 'Could not read the scoreboard');

  // A row archived mid-week still shows (read-only) for the weeks it has numbers in, so no
  // collection or count silently drops out of a team total.
  const rows = new Map<string, BoardRow>();
  for (const r of liveRows.rows) {
    const m = mapRow(r);
    if (m) rows.set(m.id, m);
  }
  const referenced = new Set<string>([
    ...entries.rows.map((e) => e.row_id),
    ...collections.rows.map((c) => c.row_id),
  ]);
  const missing = [...referenced].filter((id) => !rows.has(id));
  if (missing.length) {
    const { data, error } = await sb.from(ROWS).select(ROW_COLS).in('id', missing.slice(0, 200));
    if (error) return dbFailure(error, 'Could not read the scoreboard');
    for (const r of (data ?? []) as RowRecord[]) {
      const m = mapRow(r);
      if (m) rows.set(m.id, m);
    }
  }

  const hist = collectionsHistory(
    history.rows.map((h) => ({ date: h.entry_date, rowId: h.row_id, points: Number(h.points) })),
  );
  const liveSince = history.rows.reduce<string | null>(
    (min, h) => (min === null || h.entry_date < min ? h.entry_date : min),
    null,
  );

  let members: BoardMember[] | null = null;
  if (viewer.isManager) {
    const m = await selectAllPaged<{ work_email: string; added_at: string; added_by: string }>((from, to) =>
      sb
        .from(MEMBERS)
        .select('work_email, added_at, added_by')
        .is('removed_at', null)
        .order('work_email')
        .range(from, to),
    );
    if (m.error) return dbFailure({ message: m.error }, 'Could not read the members');
    members = m.rows.map((r) => ({ workEmail: r.work_email, addedAt: r.added_at, addedBy: r.added_by }));
  }

  return {
    ok: true,
    value: {
      weekStart,
      lastWeekStart,
      today,
      viewer: { email: viewer.email, isManager: viewer.isManager },
      settings: ((settings.data ?? []) as { section_key: string; enabled: boolean; goal: number | string | null }[])
        .filter((s) => isSectionKey(s.section_key))
        .map((s) => ({
          sectionKey: s.section_key as SectionKey,
          enabled: s.enabled,
          goal: s.goal === null ? null : Number(s.goal),
        })),
      rows: [...rows.values()].sort(
        (a, b) => Number(a.archived) - Number(b.archived) || a.sortOrder - b.sortOrder || a.label.localeCompare(b.label),
      ),
      entries: entries.rows.map(mapEntry),
      collections: collections.rows.map(mapCollection),
      history: { allTimeByRow: Object.fromEntries(hist.allTimeByRow), record: hist.record, liveSince },
      members,
      bonus,
      generatedAt: new Date().toISOString(),
    },
  };
}

/** The week a request asks for: a Sunday key, defaulting to this week (US Eastern). */
export function currentWeekStart(): string {
  return weekStartOf(todayEastern());
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

async function readLiveRow(id: string): Promise<Result<BoardRow>> {
  const { data, error } = await client().from(ROWS).select(ROW_COLS).eq('id', id).maybeSingle();
  if (error) return dbFailure(error, 'Could not read the row');
  const row = data ? mapRow(data as RowRecord) : null;
  if (!row) return fail(404, 'not_found', 'That row is not on the scoreboard.');
  if (row.archived) return fail(409, 'archived', 'That row was removed from the scoreboard; its numbers are read-only.');
  return { ok: true, value: row };
}

/** Set or clear one cell. A cleared cell is deleted, never stored as 0. */
export async function writeEntry(viewer: Viewer, w: EntryWrite): Promise<Result<StoredEntry | null>> {
  const row = await readLiveRow(w.rowId);
  if (!row.ok) return row;
  const allowed = entryAllowed(row.value.sectionKey, w.slot, w.date);
  if (!allowed.ok) return fail(422, 'refused', allowed.error);

  const sb = client();
  if (w.value === null) {
    const { error } = await sb
      .from(ENTRIES)
      .delete()
      .eq('row_id', w.rowId)
      .eq('entry_date', w.date)
      .eq('slot', w.slot);
    if (error) return dbFailure(error, 'Could not clear the cell');
    return { ok: true, value: null };
  }
  const { data, error } = await sb
    .from(ENTRIES)
    .upsert(
      {
        row_id: w.rowId,
        entry_date: w.date,
        slot: w.slot,
        value: w.value,
        updated_by: viewer.email,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'row_id,entry_date,slot' },
    )
    .select('row_id, entry_date, slot, value')
    .single();
  if (error) return dbFailure(error, 'Could not save the cell');
  return { ok: true, value: mapEntry(data as EntryRecord) };
}

export async function logCollection(viewer: Viewer, c: CollectionCreate): Promise<Result<CollectionEntry>> {
  const row = await readLiveRow(c.rowId);
  if (!row.ok) return row;
  if (row.value.sectionKey !== 'collections') return fail(422, 'refused', 'Pick a rep from the Collections section.');
  const { data, error } = await client()
    .from(COLLECTIONS)
    .insert({
      entry_date: c.date,
      row_id: c.rowId,
      business_name: c.businessName,
      points: c.points,
      amount_usd: c.amountUsd,
      created_by: viewer.email,
    })
    .select(COLLECTION_COLS)
    .single();
  if (error) return dbFailure(error, 'Could not log the collection');
  return { ok: true, value: mapCollection(data as CollectionRecord) };
}

/**
 * Soft-delete a logged collection. Only the person who logged it, or a manager: the log's day
 * totals are what the Dancing Queen Bonus is typed from. The table refuses any other edit.
 */
export async function deleteCollection(viewer: Viewer, id: string): Promise<Result<{ id: string }>> {
  const sb = client();
  const { data: existing, error: readErr } = await sb
    .from(COLLECTIONS)
    .select('id, created_by, deleted_at')
    .eq('id', id)
    .maybeSingle();
  if (readErr) return dbFailure(readErr, 'Could not read the collection');
  const rec = existing as { id: string; created_by: string; deleted_at: string | null } | null;
  if (!rec || rec.deleted_at) return fail(404, 'not_found', 'That collection is not on the log.');
  if (!viewer.isManager && !viewer.aliases.includes(rec.created_by.toLowerCase())) {
    return fail(403, 'not_owner', 'Only the person who logged it, or Accounting, can delete a collection.');
  }
  const { data, error } = await sb
    .from(COLLECTIONS)
    .update({ deleted_at: new Date().toISOString(), deleted_by: viewer.email })
    .eq('id', id)
    .is('deleted_at', null)
    .select('id');
  if (error) return dbFailure(error, 'Could not delete the collection');
  if (!(data ?? []).length) return fail(404, 'not_found', 'That collection is not on the log.');
  return { ok: true, value: { id } };
}

/** A person row must be someone on the active HRIS roster; anyone else is a named row. */
async function rosterHasEmail(email: string): Promise<Result<boolean>> {
  const sb = client();
  for (const col of ['"Work Email"', '"Alternate Work Email"', '"Alternate Work Email 2"']) {
    const { data, error } = await sb.from('active_employees').select('"Work Email"').eq(col, email).limit(1);
    if (error) return dbFailure(error, 'Could not check the roster');
    if ((data ?? []).length) return { ok: true, value: true };
  }
  // The roster stores emails as typed; fall back to a case-insensitive exact match.
  for (const col of ['"Work Email"', '"Alternate Work Email"', '"Alternate Work Email 2"']) {
    const escaped = email.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    const { data, error } = await sb.from('active_employees').select('"Work Email"').ilike(col, escaped).limit(1);
    if (error) return dbFailure(error, 'Could not check the roster');
    if ((data ?? []).length) return { ok: true, value: true };
  }
  return { ok: true, value: false };
}

export async function createRow(viewer: Viewer, r: RowCreate): Promise<Result<BoardRow>> {
  if (r.workEmail) {
    const onRoster = await rosterHasEmail(r.workEmail);
    if (!onRoster.ok) return onRoster;
    if (!onRoster.value) {
      return fail(
        422,
        'not_on_roster',
        `${r.workEmail} is not on the active HRIS roster. Add them as a named row instead, or add them to the Global Master List first.`,
      );
    }
  }
  const sb = client();
  const { data: last } = await sb
    .from(ROWS)
    .select('sort_order')
    .eq('section_key', r.sectionKey)
    .is('archived_at', null)
    .order('sort_order', { ascending: false })
    .limit(1);
  const nextOrder = ((last ?? [])[0] as { sort_order?: number } | undefined)?.sort_order ?? -1;
  const { data, error } = await sb
    .from(ROWS)
    .insert({
      section_key: r.sectionKey,
      label: r.label,
      work_email: r.workEmail,
      sort_order: Math.min(nextOrder + 1, 10000),
      created_by: viewer.email,
    })
    .select(ROW_COLS)
    .single();
  if (error) return dbFailure(error, 'Could not add the row');
  const row = mapRow(data as RowRecord);
  return row ? { ok: true, value: row } : fail(500, 'db_error', 'The row came back unreadable.');
}

export async function patchRow(viewer: Viewer, p: RowPatch): Promise<Result<BoardRow>> {
  const current = await readLiveRow(p.id);
  if (!current.ok) return current;
  const update: Record<string, unknown> = {};
  if (p.label !== undefined) update.label = p.label;
  if (p.sortOrder !== undefined) update.sort_order = p.sortOrder;
  if (p.archived) {
    update.archived_at = new Date().toISOString();
    update.archived_by = viewer.email;
  }
  const { data, error } = await client()
    .from(ROWS)
    .update(update)
    .eq('id', p.id)
    .is('archived_at', null)
    .select(ROW_COLS)
    .single();
  if (error) return dbFailure(error, 'Could not change the row');
  const row = mapRow(data as RowRecord);
  return row ? { ok: true, value: row } : fail(500, 'db_error', 'The row came back unreadable.');
}

export async function addMember(viewer: Viewer, workEmail: string): Promise<Result<BoardMember>> {
  const { data, error } = await client()
    .from(MEMBERS)
    .upsert(
      { work_email: workEmail, added_by: viewer.email, added_at: new Date().toISOString(), removed_at: null, removed_by: null },
      { onConflict: 'work_email' },
    )
    .select('work_email, added_at, added_by')
    .single();
  if (error) return dbFailure(error, 'Could not add the member');
  const m = data as { work_email: string; added_at: string; added_by: string };
  return { ok: true, value: { workEmail: m.work_email, addedAt: m.added_at, addedBy: m.added_by } };
}

export async function removeMember(viewer: Viewer, workEmail: string): Promise<Result<{ workEmail: string }>> {
  const { data, error } = await client()
    .from(MEMBERS)
    .update({ removed_at: new Date().toISOString(), removed_by: viewer.email })
    .eq('work_email', workEmail)
    .is('removed_at', null)
    .select('work_email');
  if (error) return dbFailure(error, 'Could not remove the member');
  if (!(data ?? []).length) return fail(404, 'not_found', 'That person is not on the member list.');
  return { ok: true, value: { workEmail } };
}

export async function patchSection(viewer: Viewer, p: SectionPatch): Promise<Result<SectionSetting>> {
  const sb = client();
  const { data: current, error: readErr } = await sb
    .from(SECTIONS_TABLE)
    .select('section_key, enabled, goal')
    .eq('section_key', p.sectionKey)
    .maybeSingle();
  if (readErr) return dbFailure(readErr, 'Could not read the section');
  const cur = current as { enabled: boolean; goal: number | string | null } | null;
  const row = {
    section_key: p.sectionKey,
    enabled: p.enabled ?? cur?.enabled ?? true,
    goal: p.goal !== undefined ? p.goal : cur?.goal ?? null,
    updated_by: viewer.email,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await sb
    .from(SECTIONS_TABLE)
    .upsert(row, { onConflict: 'section_key' })
    .select('section_key, enabled, goal')
    .single();
  if (error) return dbFailure(error, 'Could not save the section');
  const s = data as { section_key: SectionKey; enabled: boolean; goal: number | string | null };
  return { ok: true, value: { sectionKey: s.section_key, enabled: s.enabled, goal: s.goal === null ? null : Number(s.goal) } };
}

/** The people picker: name, department and work email of the active roster. Nothing else. */
export async function readRoster(): Promise<Result<RosterPerson[]>> {
  const sb = client();
  const res = await selectAllPaged<Record<string, string | null>>((from, to) =>
    sb
      .from('active_employees')
      .select('"Name","Department","Work Email"')
      .order('Work Email', { ascending: true })
      .range(from, to),
  );
  if (res.error) return dbFailure({ message: res.error }, 'Could not read the roster');
  const out: RosterPerson[] = [];
  const seen = new Set<string>();
  for (const r of res.rows) {
    const workEmail = (r['Work Email'] ?? '').trim().toLowerCase();
    if (!workEmail || seen.has(workEmail)) continue;
    seen.add(workEmail);
    out.push({ name: (r.Name ?? '').trim(), department: (r.Department ?? '').trim() || '(no department)', workEmail });
  }
  out.sort((a, b) => a.department.localeCompare(b.department) || a.name.localeCompare(b.name));
  return { ok: true, value: out };
}
