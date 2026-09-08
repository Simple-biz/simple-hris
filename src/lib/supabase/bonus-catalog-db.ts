import { createSupabaseServiceRoleClient } from './server';
import { selectAllPaged } from './select-all-paged';
import type { BonusDef, BonusAssignment } from '@/lib/bonus-catalog/types';
import {
  diffAssignment,
  diffBonusFields,
  normalizeEmailList,
  todayIso,
  type AssignmentEvent,
  type AssignmentEventKind,
  type BonusVersion,
  type TrackedBonusField,
} from '@/lib/bonus-catalog/history';

// Persistence for the Bonus Catalog (see references/create_bonus_catalog.sql and
// references/sql/create/2026-09-08_bonus_catalog_history.sql).
// One row per bonus / assignment, each carrying a creator + timestamps, so the
// UI can show who added what and update live across users. Every definition
// save that changes a tracked field mints a new VERSION row, and every
// assignment change lands as an EVENT row — display + audit only, the payout
// path never reads either.

const BONUSES = 'bonus_catalog_bonuses';
const ASSIGNMENTS = 'bonus_catalog_assignments';
const BONUS_HISTORY = 'bonus_catalog_bonus_history';
const ASSIGNMENT_HISTORY = 'bonus_catalog_assignment_history';

type BonusRow = {
  id: string;
  name: string;
  description: string | null;
  kind: 'flat' | 'formula';
  amount: number | string | null;
  formula: string | null;
  currency: 'PHP' | 'USD' | null;
  cadence: 'weekly' | 'monthly' | null;
  starred: boolean | null;
  version?: number | null;
  effective_from?: string | null;
  created_by: string | null;
  created_at: string | null;
  updated_by: string | null;
  updated_at: string | null;
};

type AssignmentRow = {
  id: string;
  bonus_id: string;
  scope: 'department' | 'employee';
  department_key: string;
  employee_email: string | null;
  employee_name: string | null;
  excluded_emails: string[] | null;
  shared_team: boolean | null;
  created_by: string | null;
  created_at: string | null;
};

type BonusHistoryRow = {
  id: number;
  bonus_id: string;
  version: number;
  name: string;
  description: string | null;
  kind: 'flat' | 'formula';
  amount: number | string | null;
  formula: string | null;
  currency: string | null;
  cadence: string | null;
  changed_fields: string[] | null;
  effective_from: string;
  note: string | null;
  created_by: string | null;
  created_at: string | null;
};

type AssignmentHistoryRow = {
  id: number;
  bonus_id: string;
  assignment_id: string;
  event: AssignmentEventKind;
  scope: 'department' | 'employee';
  department_key: string;
  employee_email: string | null;
  employee_name: string | null;
  excluded_before: string[] | null;
  excluded_after: string[] | null;
  shared_team: boolean | null;
  effective_from: string;
  note: string | null;
  created_by: string | null;
  created_at: string | null;
};

function mapBonus(r: BonusRow): BonusDef {
  return {
    id: r.id,
    name: r.name,
    description: r.description ?? undefined,
    kind: r.kind,
    amount: r.amount == null ? undefined : Number(r.amount),
    formula: r.formula ?? undefined,
    // Legacy rows (pre-currency) are PHP.
    currency: r.currency === 'USD' ? 'USD' : 'PHP',
    // Legacy rows (pre-cadence) pay weekly.
    cadence: r.cadence === 'monthly' ? 'monthly' : 'weekly',
    starred: r.starred ?? false,
    // Pre-migration DB: the column is absent ⇒ v1, no stored effective date.
    version: r.version ?? 1,
    effectiveFrom: r.effective_from ?? null,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedBy: r.updated_by,
    updatedAt: r.updated_at,
  };
}

function mapAssignment(r: AssignmentRow): BonusAssignment {
  return {
    id: r.id,
    bonusId: r.bonus_id,
    scope: r.scope,
    departmentKey: r.department_key,
    employeeEmail: r.employee_email ?? undefined,
    employeeName: r.employee_name ?? undefined,
    excludedEmails: r.excluded_emails ?? [],
    sharedTeam: r.shared_team ?? false,
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}

function mapBonusVersion(r: BonusHistoryRow): BonusVersion {
  return {
    id: r.id,
    bonusId: r.bonus_id,
    version: r.version,
    name: r.name,
    description: r.description ?? undefined,
    kind: r.kind,
    amount: r.amount == null ? undefined : Number(r.amount),
    formula: r.formula ?? undefined,
    currency: r.currency === 'USD' ? 'USD' : r.currency === 'COP' ? 'COP' : 'PHP',
    cadence: r.cadence === 'monthly' ? 'monthly' : 'weekly',
    changedFields: (r.changed_fields ?? []) as TrackedBonusField[],
    effectiveFrom: r.effective_from,
    note: r.note,
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}

function mapAssignmentEvent(r: AssignmentHistoryRow): AssignmentEvent {
  return {
    id: r.id,
    bonusId: r.bonus_id,
    assignmentId: r.assignment_id,
    event: r.event,
    scope: r.scope,
    departmentKey: r.department_key,
    employeeEmail: r.employee_email ?? undefined,
    employeeName: r.employee_name ?? undefined,
    excludedBefore: r.excluded_before ?? [],
    excludedAfter: r.excluded_after ?? [],
    sharedTeam: r.shared_team,
    effectiveFrom: r.effective_from,
    note: r.note,
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}

/** PostgREST's "relation does not exist" — the history migration has not been
 *  run yet. Saves must still succeed; only the history is unavailable. */
function isMissingTable(message: string | undefined): boolean {
  return !!message && /does not exist|schema cache|PGRST205|42P01/i.test(message);
}

export async function listBonusCatalog(): Promise<{
  bonuses: BonusDef[];
  assignments: BonusAssignment[];
}> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { bonuses: [], assignments: [] };
  const [bRes, aRes] = await Promise.all([
    supabase.from(BONUSES).select('*').order('created_at', { ascending: true }),
    supabase.from(ASSIGNMENTS).select('*').order('created_at', { ascending: true }),
  ]);
  return {
    bonuses: (bRes.data ?? []).map((r) => mapBonus(r as BonusRow)),
    assignments: (aRes.data ?? []).map((r) => mapAssignment(r as AssignmentRow)),
  };
}

/**
 * Create or update a bonus definition.
 *
 * The previous row is read in the SAME request so the version diff is against
 * what is actually stored (two accountants saving back to back each diff
 * against the real prior state, not a stale client copy). `version` is bumped
 * only when a tracked field changed; a star toggle or no-op re-save keeps the
 * version and writes no history. The history INSERT is awaited: a saved bonus
 * whose version row went missing is the bug this feature exists to prevent, so
 * that failure is reported as `historyError` instead of swallowed — the
 * definition itself is still saved.
 */
export async function upsertBonus(
  bonus: BonusDef,
  actor: string,
  effectiveDateIso?: string,
): Promise<{ row: BonusDef | null; error: string | null; historyError: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { row: null, error: 'Supabase client unavailable', historyError: null };

  const { data: prevRaw, error: prevErr } = await supabase
    .from(BONUSES)
    .select('*')
    .eq('id', bonus.id)
    .maybeSingle();
  if (prevErr) return { row: null, error: prevErr.message, historyError: null };
  const prev = prevRaw ? mapBonus(prevRaw as BonusRow) : null;

  const changed = diffBonusFields(prev, bonus);
  const isNew = !prev;
  const mintsVersion = isNew || changed.length > 0;
  const nextVersion = isNew ? 1 : mintsVersion ? (prev.version ?? 1) + 1 : (prev.version ?? 1);
  const effective = effectiveDateIso ?? todayIso();

  // created_by/created_at are preserved on UPDATE by the touch trigger, so it's
  // safe to send `actor` as both creator and updater here.
  const payload: Record<string, unknown> = {
    id: bonus.id,
    name: bonus.name,
    description: bonus.description ?? null,
    kind: bonus.kind,
    amount: bonus.kind === 'flat' ? (Number.isFinite(bonus.amount) ? bonus.amount : 0) : null,
    formula: bonus.kind === 'formula' ? (bonus.formula ?? '') : null,
    currency: bonus.currency === 'USD' ? 'USD' : 'PHP',
    cadence: bonus.cadence === 'monthly' ? 'monthly' : 'weekly',
    starred: !!bonus.starred,
    created_by: actor,
    updated_by: actor,
  };
  if (mintsVersion) {
    payload.version = nextVersion;
    payload.effective_from = effective;
  }

  let upserted = await supabase.from(BONUSES).upsert(payload, { onConflict: 'id' }).select('*').maybeSingle();
  if (upserted.error && mintsVersion && isMissingColumn(upserted.error.message)) {
    // Pre-migration DB: the version/effective_from columns do not exist yet.
    // Save the definition without them rather than refusing the edit.
    delete payload.version;
    delete payload.effective_from;
    upserted = await supabase.from(BONUSES).upsert(payload, { onConflict: 'id' }).select('*').maybeSingle();
  }
  if (upserted.error) return { row: null, error: upserted.error.message, historyError: null };
  const row = upserted.data ? mapBonus(upserted.data as BonusRow) : null;

  let historyError: string | null = null;
  if (mintsVersion && row) {
    const { error: hErr } = await supabase.from(BONUS_HISTORY).insert({
      bonus_id: row.id,
      version: nextVersion,
      name: row.name,
      description: row.description ?? null,
      kind: row.kind,
      amount: row.kind === 'flat' ? (row.amount ?? 0) : null,
      formula: row.kind === 'formula' ? (row.formula ?? '') : null,
      currency: row.currency ?? 'PHP',
      cadence: row.cadence ?? 'weekly',
      changed_fields: isNew ? [] : changed,
      effective_from: effective,
      note: isNew ? 'created' : 'edited',
      created_by: actor,
    });
    if (hErr) {
      historyError = isMissingTable(hErr.message)
        ? 'History is unavailable until the bonus history migration is applied'
        : hErr.message;
    }
  }
  return { row, error: null, historyError };
}

function isMissingColumn(message: string | undefined): boolean {
  return !!message && /column .* does not exist|PGRST204|42703/i.test(message);
}

export async function deleteBonus(id: string): Promise<{ error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { error: 'Supabase client unavailable' };
  // Assignments AND both history tables cascade-delete via their FKs.
  const { error } = await supabase.from(BONUSES).delete().eq('id', id);
  return { error: error ? error.message : null };
}

async function insertAssignmentEvents(
  supabase: NonNullable<ReturnType<typeof createSupabaseServiceRoleClient>>,
  a: BonusAssignment,
  events: AssignmentEventKind[],
  prev: BonusAssignment | null,
  actor: string,
  effective: string,
): Promise<string | null> {
  if (events.length === 0) return null;
  const rows = events.map((event) => ({
    bonus_id: a.bonusId,
    assignment_id: a.id,
    event,
    scope: a.scope,
    department_key: a.departmentKey,
    employee_email: a.employeeEmail?.toLowerCase() ?? null,
    employee_name: a.employeeName ?? null,
    excluded_before: normalizeEmailList(prev?.excludedEmails),
    excluded_after: event === 'removed' ? [] : normalizeEmailList(a.excludedEmails),
    shared_team: a.scope === 'department' ? !!a.sharedTeam : null,
    effective_from: effective,
    created_by: actor,
  }));
  const { error } = await supabase.from(ASSIGNMENT_HISTORY).insert(rows);
  if (!error) return null;
  return isMissingTable(error.message)
    ? 'History is unavailable until the bonus history migration is applied'
    : error.message;
}

export async function addAssignment(
  assignment: BonusAssignment,
  actor: string,
  effectiveDateIso?: string,
): Promise<{ row: BonusAssignment | null; error: string | null; historyError: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { row: null, error: 'Supabase client unavailable', historyError: null };

  // Read the stored row first so the event diff (added vs exclusions/shared-team
  // changed) is against what is actually persisted.
  const { data: prevRaw, error: prevErr } = await supabase
    .from(ASSIGNMENTS)
    .select('*')
    .eq('id', assignment.id)
    .maybeSingle();
  if (prevErr) return { row: null, error: prevErr.message, historyError: null };
  const prev = prevRaw ? mapAssignment(prevRaw as AssignmentRow) : null;

  // Upsert (not insert): editing a common bonus's exclusion list reuses the same
  // assignment id, so it must update the existing row. The touch trigger keeps
  // created_by/created_at immutable across those edits.
  const payload = {
    id: assignment.id,
    bonus_id: assignment.bonusId,
    scope: assignment.scope,
    department_key: assignment.departmentKey,
    employee_email: assignment.employeeEmail ?? null,
    employee_name: assignment.employeeName ?? null,
    excluded_emails:
      assignment.scope === 'department'
        ? (assignment.excludedEmails ?? []).map((e) => e.toLowerCase())
        : [],
    shared_team: assignment.scope === 'department' ? !!assignment.sharedTeam : false,
    created_by: actor,
  };
  const { data, error } = await supabase
    .from(ASSIGNMENTS)
    .upsert(payload, { onConflict: 'id' })
    .select('*')
    .maybeSingle();
  if (error) return { row: null, error: error.message, historyError: null };
  const row = data ? mapAssignment(data as AssignmentRow) : null;

  const events = diffAssignment(prev, assignment);
  const historyError = row
    ? await insertAssignmentEvents(supabase, row, events, prev, actor, effectiveDateIso ?? todayIso())
    : null;
  return { row, error: null, historyError };
}

export async function removeAssignment(
  id: string,
  actor: string,
  effectiveDateIso?: string,
): Promise<{ error: string | null; historyError: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { error: 'Supabase client unavailable', historyError: null };

  // Read before deleting so the `removed` event knows WHO lost WHICH bonus —
  // the client only sends the assignment id.
  const { data: prevRaw, error: prevErr } = await supabase
    .from(ASSIGNMENTS)
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (prevErr) return { error: prevErr.message, historyError: null };
  const prev = prevRaw ? mapAssignment(prevRaw as AssignmentRow) : null;

  const { error } = await supabase.from(ASSIGNMENTS).delete().eq('id', id);
  if (error) return { error: error.message, historyError: null };
  if (!prev) return { error: null, historyError: null }; // already gone — nothing was removed by us

  const historyError = await insertAssignmentEvents(
    supabase,
    prev,
    ['removed'],
    prev,
    actor,
    effectiveDateIso ?? todayIso(),
  );
  return { error: null, historyError };
}

/**
 * Every version and every assignment event for one bonus, newest first. Paged
 * even though one bonus's history is small — PostgREST caps un-paged reads at
 * 1000 rows silently. A missing table is reported as `error`, never as an empty
 * list (bonus-catalog.md §3.1.5: a failed read is SAID).
 */
export async function listBonusHistory(bonusId: string): Promise<{
  versions: BonusVersion[];
  assignmentEvents: AssignmentEvent[];
  error: string | null;
}> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { versions: [], assignmentEvents: [], error: 'Supabase client unavailable' };

  const [v, e] = await Promise.all([
    selectAllPaged<BonusHistoryRow>((from, to) =>
      supabase
        .from(BONUS_HISTORY)
        .select('*')
        .eq('bonus_id', bonusId)
        .order('version', { ascending: false })
        .range(from, to),
    ),
    selectAllPaged<AssignmentHistoryRow>((from, to) =>
      supabase
        .from(ASSIGNMENT_HISTORY)
        .select('*')
        .eq('bonus_id', bonusId)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .range(from, to),
    ),
  ]);
  const err = v.error ?? e.error;
  if (err) {
    return {
      versions: [],
      assignmentEvents: [],
      error: isMissingTable(err) ? 'History is unavailable until the bonus history migration is applied' : err,
    };
  }
  return {
    versions: v.rows.map(mapBonusVersion),
    assignmentEvents: e.rows.map(mapAssignmentEvent),
    error: null,
  };
}
