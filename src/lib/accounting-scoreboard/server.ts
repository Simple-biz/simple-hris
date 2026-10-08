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
import { insertAuditLog } from '@/lib/supabase/audit-log';
import {
  CUSTOM_KINDS,
  MON_FRI,
  isHostSectionKey,
  isOutcome,
  isRowSectionKey,
  isSectionKey,
  type CustomKind,
  type CustomSection,
  type GoalDirection,
  type SectionKey,
  type SectionSetting,
  type Slot,
  type Weekday,
} from './sections';
import { addDays, easternToUtc, todayEastern, weekStartOf } from './week';
import { shortNameFromRoster } from './names';
import {
  can,
  canRevokeGrant,
  highestGrant,
  resolveBoardRole,
  type BoardAction,
  type BoardRole,
  type GrantRole,
} from './roles';
import {
  PAYROLL_EVENT_ACTIONS,
  firstClosedPeriodEnd,
  payrollEventFromAudit,
  type PayrollAuditRow,
  type PayrollEvent,
} from './payroll-cycle';
import { collectionsHistory, type CollectionEntry, type ProblemEntry, type StoredEntry } from './scoring';
import { pickPreviewBonus, type FormulaBonus, type PreviewVerdict } from './bonus-preview';
import type { BoardMember, BoardPayload, BoardRow, ProblemType, RoleGrant, RosterPerson } from './types';
import type { BoardRead, BoardReadProgress } from './load-progress';
import {
  customGoal,
  entryAllowed,
  type CollectionCreate,
  type CustomSectionCreate,
  type CustomSectionPatch,
  type EntryWrite,
  type ProblemCreate,
  type RowCreate,
  type RowPatch,
  type SectionPatch,
} from './validate';

const ROWS = 'accounting_scoreboard_rows';
const ENTRIES = 'accounting_scoreboard_entries';
const COLLECTIONS = 'accounting_scoreboard_collections';
/** Live points per (rep row, Sunday week): references/sql/create/2026-10-01_accounting_scoreboard_backfill.sql. */
const COLLECTION_WEEKS = 'accounting_scoreboard_collection_weeks';
const MEMBERS = 'accounting_scoreboard_members';
const SECTIONS_TABLE = 'accounting_scoreboard_sections';
// Round 3 (references/sql/create/2026-10-06_accounting_scoreboard_round3.sql).
const CUSTOM_SECTIONS = 'accounting_scoreboard_custom_sections';
const VERIFICATIONS = 'accounting_scoreboard_collection_verifications';
const PROBLEM_TYPES = 'accounting_scoreboard_problem_types';
const PROBLEMS = 'accounting_scoreboard_problems';
// Board-local roles (references/sql/create/2026-10-08_accounting_scoreboard_roles.sql).
const ROLES = 'accounting_scoreboard_roles';

export interface Viewer {
  email: string;
  aliases: string[];
  /** The session's HRIS roles. Only `admin` decides anything here (the break glass), in resolveBoardRole. */
  roles: string[];
  /** The board-local role (roles.ts): what this person may do on the board. */
  role: BoardRole;
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

/**
 * PostgREST / Postgres "relation (or column) does not exist": a migration has not been applied yet.
 * Round 3's new columns (custom_section_id, bucket_day, due_soon) and tables fail the same way.
 */
function isMissingTable(message: string | undefined): boolean {
  return !!message && /does not exist|schema cache|PGRST205|PGRST200|42P01|42703/i.test(message);
}

const NOT_SET_UP = fail(
  503,
  'not_set_up',
  'The Accounting Scoreboard tables are not set up yet. The migrations have to be applied first (scripts/apply-accounting-scoreboard-migration.mts, scripts/apply-accounting-scoreboard-backfill-migration.mts, then scripts/apply-accounting-scoreboard-round3-migration.mts, and every later scripts/apply-accounting-scoreboard-*-migration.mts, the board-local roles one included).',
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

/** What a refusal says, per action: the role that may, in the board's own words. */
const REFUSED: Record<BoardAction, string> = {
  edit_cells: 'You are not allowed to type on the scoreboard.',
  log_lines: 'You are not allowed to log on the scoreboard.',
  delete_any_line: "Only an Admin can delete someone else's line.",
  unverify_any: "Only an Admin can uncheck someone else's Payment Verified.",
  view_setup: 'Only an Admin or an Assistant can see Setup.',
  edit_setup: 'Only an Admin can change Setup.',
  view_all_tasks: "Only an Admin or an Assistant can see everyone's tasks.",
  manage_tasks: 'Only an Admin can add or remove tasks.',
  lock_week: 'Only an Admin can lock a week.',
  reopen_week: 'Only an Admin can reopen a week.',
  manage_roles: 'Only an Admin can grant or revoke a role.',
};

/**
 * Session → viewer with its board-local role (roles.ts), then the action's check. `action` null = may open
 * the board at all (any role). The role is resolved here on every request and never cached by the client.
 *
 * An HRIS `admin` is a board Admin without a read (the break glass). Everyone else is looked up by every
 * address they sign in with: a live grant in accounting_scoreboard_roles, else the member list (a live
 * person row, or accounting_scoreboard_members). HRIS `accounting` alone decides nothing (Kane, 2026-10-07).
 */
export async function resolveAccess(action: BoardAction | null = null): Promise<Result<Viewer>> {
  const session = await getServerSession(authOptions);
  const user = session?.user as { email?: string | null; roles?: string[] } | undefined;
  const email = (user?.email ?? '').trim().toLowerCase();
  if (!email) return fail(401, 'auth_required', 'Not signed in');
  const roles = user?.roles ?? [];
  const expanded = await expandWorkEmailAliases(email);
  const aliases = expanded.length ? expanded : [email];

  let role: BoardRole | null;
  if (roles.includes('admin')) {
    role = 'admin';
  } else {
    const sb = client();
    const [grantHit, rowHit, memberHit] = await Promise.all([
      sb.from(ROLES).select('role').in('email', aliases).is('revoked_at', null),
      sb.from(ROWS).select('id').in('work_email', aliases).is('archived_at', null).limit(1),
      sb.from(MEMBERS).select('work_email').in('work_email', aliases).is('removed_at', null).limit(1),
    ]);
    if (grantHit.error) return dbFailure(grantHit.error, 'Could not check your role');
    if (rowHit.error) return dbFailure(rowHit.error, 'Could not check membership');
    if (memberHit.error) return dbFailure(memberHit.error, 'Could not check membership');
    const grants = ((grantHit.data ?? []) as { role: string }[])
      .map((g) => g.role)
      .filter((r): r is GrantRole => r === 'admin' || r === 'assistant');
    role = resolveBoardRole({
      hrisRoles: roles,
      grant: highestGrant(grants),
      isMember: (rowHit.data ?? []).length > 0 || (memberHit.data ?? []).length > 0,
    });
  }
  if (!role) {
    return fail(
      403,
      'not_member',
      "You're not on the Accounting Scoreboard. Ask Carla or Claire to add you under Setup → Members.",
    );
  }
  if (action && !can(role, action)) return fail(403, 'not_allowed', REFUSED[action]);
  return { ok: true, value: { email, aliases, roles, role } };
}

// ---------------------------------------------------------------------------
// The board
// ---------------------------------------------------------------------------

type RowRecord = {
  id: string;
  section_key: string;
  custom_section_id: string | null;
  label: string;
  work_email: string | null;
  sort_order: number;
  archived_at: string | null;
  bucket_day: string | null;
  due_soon: boolean;
  outcome: string | null;
};
type EntryRecord = { row_id: string; entry_date: string; slot: Slot; value: number | string };
type VerificationRecord = { verified_by: string; verified_by_name: string; verified_at: string };
type CollectionRecord = {
  id: string;
  entry_date: string;
  row_id: string;
  business_name: string;
  points: number | string;
  amount_usd: number | string | null;
  created_by: string;
  created_at: string;
  /** Embedded: the live verification (unverified_at is null), at most one by the unique index. */
  verifications?: VerificationRecord[] | null;
};
type ProblemRecord = {
  id: string;
  entry_date: string;
  row_id: string;
  type_id: string;
  problem_count: number;
  created_by: string;
  created_at: string;
};
type ProblemTypeRecord = { id: string; label: string; sort_order: number; archived_at: string | null };
type CustomSectionRecord = {
  id: string;
  title: string;
  kind: string;
  goal: number | string | null;
  goal_direction: string | null;
  enabled: boolean;
  show_on_overview: boolean;
  sort_order: number;
  archived_at: string | null;
  host_section_key: string | null;
};
type SectionSettingRecord = { section_key: string; enabled: boolean; goal: number | string | null; show_on_overview: boolean };

function mapSetting(s: SectionSettingRecord & { section_key: SectionKey }): SectionSetting {
  return {
    sectionKey: s.section_key,
    enabled: s.enabled,
    goal: s.goal === null ? null : Number(s.goal),
    showOnOverview: s.show_on_overview,
  };
}

function mapRow(r: RowRecord): BoardRow | null {
  if (!isRowSectionKey(r.section_key)) return null;
  if (r.section_key === 'custom' && !r.custom_section_id) return null;
  const bucketDay = (MON_FRI as readonly string[]).includes(r.bucket_day ?? '') ? (r.bucket_day as Weekday) : null;
  return {
    id: r.id,
    sectionKey: r.section_key,
    customSectionId: r.section_key === 'custom' ? r.custom_section_id : null,
    label: r.label,
    workEmail: r.work_email,
    sortOrder: r.sort_order,
    archived: r.archived_at !== null,
    bucketDay,
    dueSoon: r.due_soon === true,
    outcome: isOutcome(r.outcome) ? r.outcome : null,
  };
}

function mapEntry(r: EntryRecord): StoredEntry {
  return { rowId: r.row_id, date: r.entry_date, slot: r.slot, value: Number(r.value) };
}

function mapCollection(r: CollectionRecord): CollectionEntry {
  const v = (r.verifications ?? [])[0];
  return {
    id: r.id,
    date: r.entry_date,
    rowId: r.row_id,
    businessName: r.business_name,
    points: Number(r.points),
    amountUsd: r.amount_usd === null ? null : Number(r.amount_usd),
    createdBy: r.created_by,
    createdAt: r.created_at,
    verified: v ? { by: v.verified_by, name: v.verified_by_name, at: v.verified_at } : null,
  };
}

function mapProblem(r: ProblemRecord): ProblemEntry {
  return {
    id: r.id,
    date: r.entry_date,
    rowId: r.row_id,
    typeId: r.type_id,
    count: Number(r.problem_count),
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}

function mapCustomSection(r: CustomSectionRecord): CustomSection | null {
  if (!(CUSTOM_KINDS as readonly string[]).includes(r.kind)) return null;
  const direction = r.goal_direction === 'at_least' || r.goal_direction === 'below' ? (r.goal_direction as GoalDirection) : null;
  const goal = r.goal === null || direction === null ? null : Number(r.goal);
  return {
    id: r.id,
    title: r.title,
    kind: r.kind as CustomKind,
    goal,
    goalDirection: goal === null ? null : direction,
    enabled: r.enabled,
    showOnOverview: r.show_on_overview,
    sortOrder: r.sort_order,
    hostSectionKey: isHostSectionKey(r.host_section_key) ? r.host_section_key : null,
  };
}

const ROW_COLS = 'id, section_key, custom_section_id, label, work_email, sort_order, archived_at, bucket_day, due_soon, outcome';
const COLLECTION_COLS = 'id, entry_date, row_id, business_name, points, amount_usd, created_by, created_at';
/** The collection plus its live Payment Verified tick, embedded (no `.in()` of ids: the URL would outgrow PostgREST). */
const COLLECTION_WITH_VERIFIED = `${COLLECTION_COLS}, verifications:${VERIFICATIONS}(verified_by, verified_by_name, verified_at)`;
const PROBLEM_COLS = 'id, entry_date, row_id, type_id, problem_count, created_by, created_at';
const CUSTOM_COLS = 'id, title, kind, goal, goal_direction, enabled, show_on_overview, sort_order, archived_at, host_section_key';
/** A built-in section's stored switches. show_on_overview needs the 2026-10-07 visibility migration applied first. */
const SECTION_COLS = 'section_key, enabled, goal, show_on_overview';

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

/**
 * The board for one week. `progress` (the loading modal's stream, load-progress.ts) hears each read
 * the moment it answers, with how many records came back, and `failed` hears the read that failed.
 * A read that failed is never reported as answered. Without `progress` this is exactly the plain read.
 */
export async function readBoard(
  viewer: Viewer,
  weekStart: string,
  progress?: BoardReadProgress & { failed?(read: BoardRead): void },
): Promise<Result<BoardPayload>> {
  const sb = client();
  /** A paged read: answered with its row count, or failed. */
  const paged = <T,>(read: BoardRead, p: Promise<{ rows: T[]; error: string | null }>) =>
    p.then((r) => {
      if (r.error) progress?.failed?.(read);
      else progress?.done(read, r.rows.length);
      return r;
    });
  /** A single PostgREST read: answered with `count(data)`, or failed. */
  const single = <R extends { data: unknown; error: unknown }>(read: BoardRead, p: PromiseLike<R>, count: (data: R['data']) => number) =>
    Promise.resolve(p).then((r) => {
      if (r.error) progress?.failed?.(read);
      else progress?.done(read, count(r.data));
      return r;
    });
  // Only a board that shows Setup (Admin, Assistant) reads the member list; a Team member's is decided here.
  if (!can(viewer.role, 'view_setup')) progress?.done('members', 0);
  const today = todayEastern();
  const lastWeekStart = addDays(weekStart, -7);
  const weekEnd = addDays(weekStart, 6);

  // Payroll Timing shows the cycles paid by this week and the two before it; the oldest starts three
  // weeks back. No upper bound: a past cycle started or closed late still lands on its own week.
  const eventsFrom = easternToUtc(addDays(weekStart, -21), 0).toISOString();

  const [liveRows, entries, collections, history, settings, bonus, payroll, closes, problems, problemTypes, customs, lastMeeting] = await Promise.all([
    paged('rows', selectAllPaged<RowRecord>((from, to) =>
      sb.from(ROWS).select(ROW_COLS).is('archived_at', null).order('id').range(from, to),
    )),
    paged('entries', selectAllPaged<EntryRecord>((from, to) =>
      sb
        .from(ENTRIES)
        .select('row_id, entry_date, slot, value')
        .gte('entry_date', lastWeekStart)
        .lte('entry_date', weekEnd)
        .order('row_id')
        .order('entry_date')
        .order('slot')
        .range(from, to),
    )),
    paged('collections', selectAllPaged<CollectionRecord>((from, to) =>
      sb
        .from(COLLECTIONS)
        .select(COLLECTION_WITH_VERIFIED)
        .is('deleted_at', null)
        .is('verifications.unverified_at', null)
        .gte('entry_date', lastWeekStart)
        .lte('entry_date', weekEnd)
        .order('id')
        .range(from, to),
    )),
    // All Time and the record come from one row per (rep row, week), never from every log line: the
    // sheet's history (~10k lines, backfilled 2026-10-01) would be 10+ pages on every 45 s refresh.
    paged('collectionWeeks', selectAllPaged<{ row_id: string; week_start: string; points: number | string; first_date: string }>((from, to) =>
      sb
        .from(COLLECTION_WEEKS)
        .select('row_id, week_start, points, first_date')
        .order('row_id')
        .order('week_start')
        .range(from, to),
    )),
    single('settings', sb.from(SECTIONS_TABLE).select(SECTION_COLS), (d) => (Array.isArray(d) ? d.length : 0)),
    // The board TOLERATES a failed catalog read (the preview card says so), so its line stays done,
    // but it is told, and never claims the formula was read.
    readBonusCandidates().then((v) => {
      progress?.done('bonus', 1, !v.ok && v.reason.startsWith('Could not read') ? 'the bonus formula could not be read' : undefined);
      return v;
    }),
    // Payroll Timing: the Wizard's own Start Processing stamps (each names the cycle it was on) and
    // the pay-cycle closes/reopens. Only the action, the time and the cycle's file and period are
    // read; the close-out record (which holds unpaid payees) is never touched.
    paged('payrollEvents', selectAllPaged<PayrollAuditRow>((from, to) =>
      sb
        .from('audit_log')
        .select(
          'action, created_at, resource_id, src:details->>source_file, csrc:details->cycle->>source_file, cps:details->cycle->>period_start',
        )
        .in('action', [...PAYROLL_EVENT_ACTIONS])
        .gte('created_at', eventsFrom)
        .order('created_at')
        .order('id')
        .range(from, to),
    )),
    // Every close ever filed, for the boundary before which Close Pay Cycle did not exist.
    paged('closes', selectAllPaged<Pick<PayrollAuditRow, 'src' | 'resource_id'>>((from, to) =>
      sb
        .from('audit_log')
        .select('resource_id, src:details->>source_file')
        .eq('action', 'payment_cycle.closed')
        .order('created_at')
        .order('id')
        .range(from, to),
    )),
    // Payroll Problems: this week's and last week's live log lines.
    paged('problems', selectAllPaged<ProblemRecord>((from, to) =>
      sb
        .from(PROBLEMS)
        .select(PROBLEM_COLS)
        .is('deleted_at', null)
        .gte('entry_date', lastWeekStart)
        .lte('entry_date', weekEnd)
        .order('id')
        .range(from, to),
    )),
    // Every problem type: archived ones too, so an old line still prints its type.
    paged('problemTypes', selectAllPaged<ProblemTypeRecord>((from, to) =>
      sb.from(PROBLEM_TYPES).select('id, label, sort_order, archived_at').order('id').range(from, to),
    )),
    paged('customSections', selectAllPaged<CustomSectionRecord>((from, to) =>
      sb.from(CUSTOM_SECTIONS).select(CUSTOM_COLS).is('archived_at', null).order('id').range(from, to),
    )),
    // PM Buckets' No Meeting Streak: the latest day any PM meeting was ticked, ever (archived PM
    // rows included: the meeting happened). One row, through the row's section, no id list.
    single(
      'lastMeeting',
      sb
        .from(ENTRIES)
        .select('entry_date, row:accounting_scoreboard_rows!inner(section_key)')
        .eq('slot', 'mtg')
        .eq('value', 1)
        .eq('row.section_key', 'pm_buckets')
        .order('entry_date', { ascending: false })
        .limit(1),
      (d) => (Array.isArray(d) ? d.length : 0),
    ),
  ]);

  for (const r of [liveRows, entries, collections, history, payroll, closes, problems, problemTypes, customs]) {
    if (r.error) return dbFailure({ message: r.error }, 'Could not read the scoreboard');
  }
  if (settings.error) return dbFailure(settings.error, 'Could not read the scoreboard');
  if (lastMeeting.error) return dbFailure(lastMeeting.error, 'Could not read the PM meetings');

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
    ...problems.rows.map((p) => p.row_id),
  ]);
  const missing = [...referenced].filter((id) => !rows.has(id));
  if (missing.length) {
    const { data, error } = await sb.from(ROWS).select(ROW_COLS).in('id', missing.slice(0, 200));
    if (error) {
      progress?.failed?.('removedRows');
      return dbFailure(error, 'Could not read the scoreboard');
    }
    for (const r of (data ?? []) as RowRecord[]) {
      const m = mapRow(r);
      if (m) rows.set(m.id, m);
    }
    progress?.done('removedRows', (data ?? []).length);
  } else {
    progress?.done('removedRows', 0);
  }

  // A week's Sunday key is a date in that week, so the week rows give the same totals and record.
  const hist = collectionsHistory(
    history.rows.map((h) => ({ date: h.week_start, rowId: h.row_id, points: Number(h.points) })),
  );
  const liveSince = history.rows.reduce<string | null>(
    (min, h) => (min === null || h.first_date < min ? h.first_date : min),
    null,
  );

  let members: BoardMember[] | null = null;
  if (can(viewer.role, 'view_setup')) {
    const m = await selectAllPaged<{ work_email: string; added_at: string; added_by: string }>((from, to) =>
      sb
        .from(MEMBERS)
        .select('work_email, added_at, added_by')
        .is('removed_at', null)
        .order('work_email')
        .range(from, to),
    );
    if (m.error) {
      progress?.failed?.('members');
      return dbFailure({ message: m.error }, 'Could not read the members');
    }
    members = m.rows.map((r) => ({ workEmail: r.work_email, addedAt: r.added_at, addedBy: r.added_by }));
    progress?.done('members', members.length);
  }

  return {
    ok: true,
    value: {
      weekStart,
      lastWeekStart,
      today,
      viewer: { email: viewer.email, role: viewer.role },
      settings: ((settings.data ?? []) as SectionSettingRecord[])
        .filter((s): s is SectionSettingRecord & { section_key: SectionKey } => isSectionKey(s.section_key))
        .map(mapSetting),
      customSections: customs.rows.map(mapCustomSection).filter((c): c is CustomSection => c !== null),
      rows: [...rows.values()].sort(
        (a, b) => Number(a.archived) - Number(b.archived) || a.sortOrder - b.sortOrder || a.label.localeCompare(b.label),
      ),
      entries: entries.rows.map(mapEntry),
      collections: collections.rows.map(mapCollection),
      problems: problems.rows.map(mapProblem),
      problemTypes: problemTypes.rows
        .map(
          (t): ProblemType => ({ id: t.id, label: t.label, sortOrder: t.sort_order, archived: t.archived_at !== null }),
        )
        .sort((a, b) => Number(a.archived) - Number(b.archived) || a.sortOrder - b.sortOrder || a.label.localeCompare(b.label)),
      lastMeetingDate: ((lastMeeting.data ?? []) as { entry_date: string }[])[0]?.entry_date ?? null,
      history: { allTimeByRow: Object.fromEntries(hist.allTimeByRow), record: hist.record, liveSince },
      members,
      bonus,
      payrollEvents: payroll.rows.map(payrollEventFromAudit).filter((e): e is PayrollEvent => e !== null),
      firstClosedPeriodEnd: firstClosedPeriodEnd(closes.rows),
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

/** A live custom section, or a refusal that says why it cannot take numbers. */
async function readLiveCustomSection(id: string): Promise<Result<CustomSection>> {
  const { data, error } = await client().from(CUSTOM_SECTIONS).select(CUSTOM_COLS).eq('id', id).maybeSingle();
  if (error) return dbFailure(error, 'Could not read the section');
  const rec = data as CustomSectionRecord | null;
  const section = rec ? mapCustomSection(rec) : null;
  if (!rec || !section) return fail(404, 'not_found', 'That section is not on the scoreboard.');
  if (rec.archived_at) return fail(409, 'archived', 'That section was removed from the scoreboard; its numbers are read-only.');
  return { ok: true, value: section };
}

/** Set or clear one cell. A cleared cell is deleted, never stored as 0. */
export async function writeEntry(viewer: Viewer, w: EntryWrite): Promise<Result<StoredEntry | null>> {
  const row = await readLiveRow(w.rowId);
  if (!row.ok) return row;
  let target: Parameters<typeof entryAllowed>[0];
  if (row.value.sectionKey === 'custom') {
    const custom = await readLiveCustomSection(row.value.customSectionId ?? '');
    if (!custom.ok) return custom;
    target = { title: custom.value.title, kind: custom.value.kind, days: MON_FRI };
  } else {
    target = row.value.sectionKey;
  }
  const allowed = entryAllowed(target, w.slot, w.date);
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
  if (!can(viewer.role, 'delete_any_line') && !viewer.aliases.includes(rec.created_by.toLowerCase())) {
    return fail(403, 'not_owner', 'Only the person who logged it, or an Admin, can delete a collection.');
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

/**
 * The name printed beside a Payment Verified tick: the label of the viewer's own person row on the
 * board (what the team calls them: "Carla"), else their roster nickname, else their email handle.
 */
async function displayNameFor(viewer: Viewer): Promise<Result<string>> {
  const sb = client();
  const own = await sb.from(ROWS).select('label').in('work_email', viewer.aliases).is('archived_at', null).limit(1);
  if (own.error) return dbFailure(own.error, 'Could not read your name');
  const label = ((own.data ?? []) as { label: string }[])[0]?.label;
  if (label) return { ok: true, value: label };
  for (const col of ['Work Email', 'Alternate Work Email', 'Alternate Work Email 2']) {
    const { data, error } = await sb.from('active_employees').select('"Name"').in(col, viewer.aliases).limit(1);
    if (error) return dbFailure(error, 'Could not read your name');
    const name = shortNameFromRoster(((data ?? []) as { Name: string | null }[])[0]?.Name ?? '');
    if (name) return { ok: true, value: name.slice(0, 120) };
  }
  return { ok: true, value: viewer.email.split('@')[0] };
}

type LiveVerification = { id: string } & VerificationRecord;

async function readLiveVerification(collectionId: string): Promise<Result<LiveVerification | null>> {
  const { data, error } = await client()
    .from(VERIFICATIONS)
    .select('id, verified_by, verified_by_name, verified_at')
    .eq('collection_id', collectionId)
    .is('unverified_at', null)
    .maybeSingle();
  if (error) return dbFailure(error, 'Could not read the verification');
  return { ok: true, value: (data as LiveVerification | null) ?? null };
}

const asVerified = (v: VerificationRecord): NonNullable<CollectionEntry['verified']> => ({
  by: v.verified_by,
  name: v.verified_by_name,
  at: v.verified_at,
});

/**
 * Payment Verified (Carla, 2026-10-02). Any member may tick it, and the tick stores who did it. Only
 * the person who ticked it, or a manager, may take it back; taking it back stamps the line and never
 * deletes it. The collection itself is never touched (the log is append-only).
 */
export async function setVerified(
  viewer: Viewer,
  collectionId: string,
  verified: boolean,
): Promise<Result<CollectionEntry['verified']>> {
  const sb = client();
  const { data: coll, error: collErr } = await sb
    .from(COLLECTIONS)
    .select('id, deleted_at')
    .eq('id', collectionId)
    .maybeSingle();
  if (collErr) return dbFailure(collErr, 'Could not read the collection');
  const rec = coll as { id: string; deleted_at: string | null } | null;
  if (!rec || rec.deleted_at) return fail(404, 'not_found', 'That collection is not on the log.');

  const live = await readLiveVerification(collectionId);
  if (!live.ok) return live;

  if (verified) {
    if (live.value) return { ok: true, value: asVerified(live.value) };
    const name = await displayNameFor(viewer);
    if (!name.ok) return name;
    const { data, error } = await sb
      .from(VERIFICATIONS)
      .insert({ collection_id: collectionId, verified_by: viewer.email, verified_by_name: name.value })
      .select('verified_by, verified_by_name, verified_at')
      .single();
    if (error?.code === '23505') {
      // Someone ticked it a moment earlier: theirs stands.
      const again = await readLiveVerification(collectionId);
      if (!again.ok) return again;
      return { ok: true, value: again.value ? asVerified(again.value) : null };
    }
    if (error) return dbFailure(error, 'Could not save the verification');
    return { ok: true, value: asVerified(data as VerificationRecord) };
  }

  if (!live.value) return { ok: true, value: null };
  if (!can(viewer.role, 'unverify_any') && !viewer.aliases.includes(live.value.verified_by.toLowerCase())) {
    return fail(403, 'not_owner', `Only ${live.value.verified_by_name}, who verified it, or an Admin can uncheck it.`);
  }
  const { data, error } = await sb
    .from(VERIFICATIONS)
    .update({ unverified_at: new Date().toISOString(), unverified_by: viewer.email })
    .eq('id', live.value.id)
    .is('unverified_at', null)
    .select('id');
  if (error) return dbFailure(error, 'Could not uncheck the verification');
  if (!(data ?? []).length) return fail(409, 'conflict', 'That verification just changed. Refresh and try again.');
  return { ok: true, value: null };
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
  if (r.sectionKey === 'custom') {
    const custom = await readLiveCustomSection(r.customSectionId ?? '');
    if (!custom.ok) return custom;
  }
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
  let lastQuery = sb.from(ROWS).select('sort_order').eq('section_key', r.sectionKey).is('archived_at', null);
  if (r.customSectionId) lastQuery = lastQuery.eq('custom_section_id', r.customSectionId);
  const { data: last } = await lastQuery.order('sort_order', { ascending: false }).limit(1);
  const nextOrder = ((last ?? [])[0] as { sort_order?: number } | undefined)?.sort_order ?? -1;
  const { data, error } = await sb
    .from(ROWS)
    .insert({
      section_key: r.sectionKey,
      custom_section_id: r.customSectionId,
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
  // The three row flags belong to one section each (the SQL CHECKs acct_sb_rows_bucket_day_valid,
  // acct_sb_rows_due_soon_valid and acct_sb_rows_outcome_valid say the same; this says it in words).
  if (p.bucketDay !== undefined) {
    if (current.value.sectionKey !== 'buckets') {
      return fail(422, 'refused', 'Only an Accounting Buckets row is worked on a weekday.');
    }
    update.bucket_day = p.bucketDay;
  }
  if (p.dueSoon !== undefined) {
    if (current.value.sectionKey !== 'chargebacks') {
      return fail(422, 'refused', 'Only an Open Disputes line can be marked "due in 7 days".');
    }
    update.due_soon = p.dueSoon;
  }
  if (p.outcome !== undefined) {
    if (current.value.sectionKey !== 'chargeback_outcomes') {
      return fail(422, 'refused', 'Only a Chargeback Outcomes line counts as a win, a loss or Pre-arb.');
    }
    update.outcome = p.outcome;
  }
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

// ---------------------------------------------------------------------------
// Board-local roles (Setup → Access; Admins only). A grant is append-only: a role change is a revoke and a
// new grant, and the table's trigger refuses revoking the last live Admin grant under a lock.
// ---------------------------------------------------------------------------

type RoleGrantRecord = { id: string; email: string; role: string; granted_by: string; granted_at: string };
const ROLE_COLS = 'id, email, role, granted_by, granted_at';
const ROLE_WORD: Record<GrantRole, string> = { admin: 'an Admin', assistant: 'an Assistant' };

function asGrant(r: RoleGrantRecord): RoleGrant | null {
  if (r.role !== 'admin' && r.role !== 'assistant') return null;
  return { email: r.email, role: r.role, grantedBy: r.granted_by, grantedAt: r.granted_at };
}

async function liveAdminGrantCount(): Promise<Result<number>> {
  const { rows, error } = await selectAllPaged<{ id: string }>((from, to) =>
    client().from(ROLES).select('id').eq('role', 'admin').is('revoked_at', null).order('id').range(from, to),
  );
  if (error) return dbFailure({ message: error }, 'Could not count the Admins');
  return { ok: true, value: rows.length };
}

export async function listRoleGrants(): Promise<Result<RoleGrant[]>> {
  const { rows, error } = await selectAllPaged<RoleGrantRecord>((from, to) =>
    client().from(ROLES).select(ROLE_COLS).is('revoked_at', null).order('id').range(from, to),
  );
  if (error) return dbFailure({ message: error }, 'Could not read the roles');
  const grants = rows.map(asGrant).filter((g): g is RoleGrant => g !== null);
  grants.sort((a, b) => (a.role === b.role ? a.email.localeCompare(b.email) : a.role === 'admin' ? -1 : 1));
  return { ok: true, value: grants };
}

export async function grantRole(viewer: Viewer, email: string, role: GrantRole): Promise<Result<RoleGrant>> {
  const sb = client();
  const { data: live, error: readErr } = await sb.from(ROLES).select('role').eq('email', email).is('revoked_at', null).maybeSingle();
  if (readErr) return dbFailure(readErr, 'Could not read the roles');
  const held = (live as { role: string } | null)?.role;
  if (held === 'admin' || held === 'assistant') {
    return fail(
      409,
      'already_granted',
      held === role ? `${email} is already ${ROLE_WORD[role]}.` : `${email} is ${ROLE_WORD[held]}. Revoke that first, then grant the new role.`,
    );
  }
  const { data, error } = await sb.from(ROLES).insert({ email, role, granted_by: viewer.email }).select(ROLE_COLS).single();
  if (error?.code === '23505') return fail(409, 'already_granted', `${email} already holds a role.`);
  if (error) return dbFailure(error, 'Could not grant the role');
  const grant = asGrant(data as RoleGrantRecord);
  if (!grant) return fail(500, 'db_error', 'The grant came back unreadable.');
  await insertAuditLog({
    user_name: viewer.email,
    user_role: 'Admin',
    action: 'accounting_scoreboard.role_granted',
    resource: ROLES,
    resource_id: (data as RoleGrantRecord).id,
    details: { email, role },
  });
  return { ok: true, value: grant };
}

export async function revokeRole(viewer: Viewer, email: string): Promise<Result<{ email: string; role: GrantRole }>> {
  const sb = client();
  const { data: live, error: readErr } = await sb.from(ROLES).select('id, role').eq('email', email).is('revoked_at', null).maybeSingle();
  if (readErr) return dbFailure(readErr, 'Could not read the roles');
  const rec = live as { id: string; role: string } | null;
  if (!rec || (rec.role !== 'admin' && rec.role !== 'assistant')) return fail(404, 'not_found', `${email} holds no role on the board.`);
  const role: GrantRole = rec.role;
  const admins = await liveAdminGrantCount();
  if (!admins.ok) return admins;
  // Review Focus 3. The trigger refuses the same revoke under a lock; this is the friendly answer.
  if (!canRevokeGrant({ role }, admins.value)) {
    return fail(409, 'last_admin', 'The board keeps at least one Admin. Grant another Admin first, then revoke this one.');
  }
  const { data, error } = await sb
    .from(ROLES)
    .update({ revoked_at: new Date().toISOString(), revoked_by: viewer.email })
    .eq('id', rec.id)
    .is('revoked_at', null)
    .select('id');
  if (error) return dbFailure(error, 'Could not revoke the role');
  if (!(data ?? []).length) return fail(409, 'conflict', 'Someone else changed this role just now. Refresh and try again.');
  await insertAuditLog({
    user_name: viewer.email,
    user_role: 'Admin',
    action: 'accounting_scoreboard.role_revoked',
    resource: ROLES,
    resource_id: rec.id,
    details: { email, role },
  });
  return { ok: true, value: { email, role } };
}

export async function patchSection(viewer: Viewer, p: SectionPatch): Promise<Result<SectionSetting>> {
  const sb = client();
  const { data: current, error: readErr } = await sb
    .from(SECTIONS_TABLE)
    .select(SECTION_COLS)
    .eq('section_key', p.sectionKey)
    .maybeSingle();
  if (readErr) return dbFailure(readErr, 'Could not read the section');
  const cur = current as SectionSettingRecord | null;
  // The whole row is written, so a change to one switch carries the others as stored (a missing row is
  // the code default: on, shown, default goal).
  const row = {
    section_key: p.sectionKey,
    enabled: p.enabled ?? cur?.enabled ?? true,
    goal: p.goal !== undefined ? p.goal : cur?.goal ?? null,
    show_on_overview: p.showOnOverview ?? cur?.show_on_overview ?? true,
    updated_by: viewer.email,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await sb
    .from(SECTIONS_TABLE)
    .upsert(row, { onConflict: 'section_key' })
    .select(SECTION_COLS)
    .single();
  if (error) return dbFailure(error, 'Could not save the section');
  return { ok: true, value: mapSetting(data as SectionSettingRecord & { section_key: SectionKey }) };
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

// ---------------------------------------------------------------------------
// Payroll Problems: the log and its types (Carla, 2026-10-02)
// ---------------------------------------------------------------------------

/** Log problems for a person on a day, with their type. Any member, stamped with the session email. */
export async function logProblem(viewer: Viewer, p: ProblemCreate): Promise<Result<ProblemEntry>> {
  const row = await readLiveRow(p.rowId);
  if (!row.ok) return row;
  if (row.value.sectionKey !== 'payroll_problems') return fail(422, 'refused', 'Pick a person from the Payroll Problems section.');
  const sb = client();
  const { data: type, error: typeErr } = await sb.from(PROBLEM_TYPES).select('id, archived_at').eq('id', p.typeId).maybeSingle();
  if (typeErr) return dbFailure(typeErr, 'Could not read the problem type');
  const t = type as { id: string; archived_at: string | null } | null;
  if (!t) return fail(422, 'refused', 'That problem type does not exist.');
  if (t.archived_at) return fail(422, 'refused', 'That problem type was removed. Pick another one.');
  const { data, error } = await sb
    .from(PROBLEMS)
    .insert({ entry_date: p.date, row_id: p.rowId, type_id: p.typeId, problem_count: p.count, created_by: viewer.email })
    .select(PROBLEM_COLS)
    .single();
  if (error) return dbFailure(error, 'Could not log the problem');
  return { ok: true, value: mapProblem(data as ProblemRecord) };
}

/** Soft-delete a logged problem. Only the person who logged it, or an Admin. The table refuses any other edit. */
export async function deleteProblem(viewer: Viewer, id: string): Promise<Result<{ id: string }>> {
  const sb = client();
  const { data: existing, error: readErr } = await sb.from(PROBLEMS).select('id, created_by, deleted_at').eq('id', id).maybeSingle();
  if (readErr) return dbFailure(readErr, 'Could not read the problem');
  const rec = existing as { id: string; created_by: string; deleted_at: string | null } | null;
  if (!rec || rec.deleted_at) return fail(404, 'not_found', 'That problem is not on the log.');
  if (!can(viewer.role, 'delete_any_line') && !viewer.aliases.includes(rec.created_by.toLowerCase())) {
    return fail(403, 'not_owner', 'Only the person who logged it, or an Admin, can delete a problem.');
  }
  const { data, error } = await sb
    .from(PROBLEMS)
    .update({ deleted_at: new Date().toISOString(), deleted_by: viewer.email })
    .eq('id', id)
    .is('deleted_at', null)
    .select('id');
  if (error) return dbFailure(error, 'Could not delete the problem');
  if (!(data ?? []).length) return fail(404, 'not_found', 'That problem is not on the log.');
  return { ok: true, value: { id } };
}

/** Managers add a problem type ("Admins should be able to add new types"). */
export async function addProblemType(viewer: Viewer, label: string): Promise<Result<ProblemType>> {
  const sb = client();
  const { data: last } = await sb
    .from(PROBLEM_TYPES)
    .select('sort_order')
    .is('archived_at', null)
    .order('sort_order', { ascending: false })
    .limit(1);
  const next = ((last ?? [])[0] as { sort_order?: number } | undefined)?.sort_order ?? -1;
  const { data, error } = await sb
    .from(PROBLEM_TYPES)
    .insert({ label, sort_order: Math.min(next + 1, 10000), created_by: viewer.email })
    .select('id, label, sort_order, archived_at')
    .single();
  if (error?.code === '23505') return fail(409, 'conflict', `"${label}" is already a problem type.`);
  if (error) return dbFailure(error, 'Could not add the problem type');
  const t = data as ProblemTypeRecord;
  return { ok: true, value: { id: t.id, label: t.label, sortOrder: t.sort_order, archived: false } };
}

/** Archive a type: it leaves the dropdown, and every line already logged keeps it. Never deleted. */
export async function archiveProblemType(viewer: Viewer, id: string): Promise<Result<{ id: string }>> {
  const { data, error } = await client()
    .from(PROBLEM_TYPES)
    .update({ archived_at: new Date().toISOString(), archived_by: viewer.email })
    .eq('id', id)
    .is('archived_at', null)
    .select('id');
  if (error) return dbFailure(error, 'Could not remove the problem type');
  if (!(data ?? []).length) return fail(404, 'not_found', 'That problem type is not on the list.');
  return { ok: true, value: { id } };
}

// ---------------------------------------------------------------------------
// Custom sections (Carla, 2026-10-02: "a button to create new sections")
// ---------------------------------------------------------------------------

/**
 * A new custom section goes to the TOP of the managers' own sections (Kane, 2026-10-06: "when a section
 * gets added it will be placed at the top"): one below the lowest live sort order, so the newest is first
 * in Setup and first among the custom tabs.
 */
export async function createCustomSection(viewer: Viewer, c: CustomSectionCreate): Promise<Result<CustomSection>> {
  const sb = client();
  const { data: first, error: orderErr } = await sb
    .from(CUSTOM_SECTIONS)
    .select('sort_order')
    .is('archived_at', null)
    .order('sort_order', { ascending: true })
    .limit(1);
  if (orderErr) return dbFailure(orderErr, 'Could not read the sections');
  const lowest = ((first ?? [])[0] as { sort_order?: number } | undefined)?.sort_order ?? 1;
  const { data, error } = await sb
    .from(CUSTOM_SECTIONS)
    .insert({
      title: c.title,
      kind: c.kind,
      goal: c.goal,
      goal_direction: c.goalDirection,
      host_section_key: c.hostSectionKey,
      sort_order: Math.max(lowest - 1, -10000),
      created_by: viewer.email,
      updated_by: viewer.email,
    })
    .select(CUSTOM_COLS)
    .single();
  if (error?.code === '23505') return fail(409, 'conflict', `There is already a section called "${c.title}".`);
  if (error) return dbFailure(error, 'Could not create the section');
  const section = mapCustomSection(data as CustomSectionRecord);
  return section ? { ok: true, value: section } : fail(500, 'db_error', 'The section came back unreadable.');
}

/**
 * Rename, switch on/off, show or hide its Overview card, set or clear the goal, show it inside a built-in
 * tab or back in its own, or archive (never deleted: its rows and numbers stay).
 */
export async function patchCustomSection(viewer: Viewer, p: CustomSectionPatch): Promise<Result<CustomSection>> {
  const current = await readLiveCustomSection(p.id);
  if (!current.ok) return current;
  const update: Record<string, unknown> = { updated_by: viewer.email, updated_at: new Date().toISOString() };
  if (p.title !== undefined) update.title = p.title;
  if (p.enabled !== undefined) update.enabled = p.enabled;
  if (p.showOnOverview !== undefined) update.show_on_overview = p.showOnOverview;
  if ('goal' in p) {
    const goal = customGoal(current.value.kind, p.goal, p.goalDirection);
    if (!goal.ok) return fail(400, 'bad_request', goal.error);
    update.goal = goal.value.goal;
    update.goal_direction = goal.value.goalDirection;
  }
  if (p.hostSectionKey !== undefined) update.host_section_key = p.hostSectionKey;
  if (p.archived) {
    update.archived_at = new Date().toISOString();
    update.archived_by = viewer.email;
  }
  const { data, error } = await client()
    .from(CUSTOM_SECTIONS)
    .update(update)
    .eq('id', p.id)
    .is('archived_at', null)
    .select(CUSTOM_COLS)
    .single();
  if (error?.code === '23505') return fail(409, 'conflict', `There is already a section called "${p.title}".`);
  if (error) return dbFailure(error, 'Could not change the section');
  const section = mapCustomSection(data as CustomSectionRecord);
  return section ? { ok: true, value: section } : fail(500, 'db_error', 'The section came back unreadable.');
}
