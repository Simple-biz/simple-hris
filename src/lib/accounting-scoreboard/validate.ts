/**
 * Accounting Scoreboard request bodies: every write is parsed here before it reaches the database.
 * The SQL CHECKs are the last line of defense; these are the first, and they say what is wrong.
 * Governing doc: docs/features/accounting-scoreboard.md § Writes.
 *
 * Pure. Session-derived fields (who, today) are passed in, never read from the body.
 */

import {
  CUSTOM_KINDS,
  MON_FRI,
  SLOTS,
  SLOTS_BY_KIND,
  goalMax,
  goalShapeOf,
  isHostSectionKey,
  isOutcome,
  isRowSectionKey,
  isSectionKey,
  sectionDef,
  type CustomKind,
  type GoalDirection,
  type Outcome,
  type RowSectionKey,
  type SectionDef,
  type SectionKey,
  type Slot,
  type Weekday,
} from './sections';
import { isIsoDate, weekdayOf } from './week';
import { isTaskFrequency, type TaskFrequency } from './tasks';

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The earliest date the board accepts: before this is a typo, not a backfill. */
export const EARLIEST_DATE = '2024-01-01';

function obj(body: unknown): Record<string, unknown> | null {
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

function isSlot(value: unknown): value is Slot {
  return typeof value === 'string' && (SLOTS as readonly string[]).includes(value);
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

/** At most 2 decimals, finite, within [min, max]. */
function money2(value: unknown, min: number, max: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < min || value > max) return null;
  if (Math.abs(value * 100 - Math.round(value * 100)) > 1e-6) return null;
  return Math.round(value * 100) / 100;
}

export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const e = value.trim().toLowerCase();
  return e.length <= 254 && EMAIL.test(e) ? e : null;
}

/** A cell date: real, not before EARLIEST_DATE, not after today (US Eastern). */
function boardDate(value: unknown, today: string): Parsed<string> {
  if (!isIsoDate(value)) return { ok: false, error: 'date must be a real YYYY-MM-DD date' };
  if (value < EARLIEST_DATE) return { ok: false, error: `date is before ${EARLIEST_DATE}` };
  if (value > today) return { ok: false, error: 'date is in the future' };
  return { ok: true, value };
}

export interface EntryWrite {
  rowId: string;
  date: string;
  slot: Slot;
  /** null clears the cell (the entry is deleted). */
  value: number | null;
}

export function parseEntryWrite(body: unknown, today: string): Parsed<EntryWrite> {
  const b = obj(body);
  if (!b) return { ok: false, error: 'Expected a JSON object' };
  if (!isUuid(b.rowId)) return { ok: false, error: 'rowId must be a row id' };
  const date = boardDate(b.date, today);
  if (!date.ok) return date;
  const slot = b.slot;
  if (!isSlot(slot)) {
    return { ok: false, error: `slot must be one of ${SLOTS.join(', ')}` };
  }
  if (b.value === null) return { ok: true, value: { rowId: b.rowId, date: date.value, slot, value: null } };
  if (slot === 'mtg') {
    return b.value === 0 || b.value === 1
      ? { ok: true, value: { rowId: b.rowId, date: date.value, slot, value: b.value } }
      : { ok: false, error: 'A meeting tick is 0 or 1' };
  }
  if (slot === 'start' || slot === 'end') {
    const t = Number.isInteger(b.value) ? money2(b.value, 0, 1440) : null;
    return t === null
      ? { ok: false, error: 'A time is whole minutes after midnight (0–1440)' }
      : { ok: true, value: { rowId: b.rowId, date: date.value, slot, value: t } };
  }
  if (slot === 'count') {
    // How many chargebacks: a whole number (the SQL CHECK acct_sb_entries_count_whole).
    const problem = numberProblem(b.value, MAX_COUNT, 'A number of chargebacks');
    if (problem) return { ok: false, error: problem };
    if (!Number.isInteger(b.value)) return { ok: false, error: 'A number of chargebacks is a whole number' };
    return { ok: true, value: { rowId: b.rowId, date: date.value, slot, value: b.value as number } };
  }
  if (slot === 'usd') {
    const problem = numberProblem(b.value, MAX_COUNT, 'A dollar amount');
    if (problem) {
      return {
        ok: false,
        error: problem.endsWith('decimals') ? 'A dollar amount is dollars and cents, like 99.00 (at most 2 decimals)' : problem,
      };
    }
    return { ok: true, value: { rowId: b.rowId, date: date.value, slot, value: Math.round((b.value as number) * 100) / 100 } };
  }
  const count = numberProblem(b.value, MAX_COUNT, 'A count');
  if (count) return { ok: false, error: count };
  return {
    ok: true,
    value: { rowId: b.rowId, date: date.value, slot, value: Math.round((b.value as number) * 100) / 100 },
  };
}

/** The largest number one AM/PM/day box takes. Measured 2026-10-01: the biggest entered was 94. */
export const MAX_COUNT = 100_000;

/** Says exactly which rule a number breaks, so a message never blames decimals for a range problem. */
function numberProblem(value: unknown, max: number, what: string): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return `${what} must be a number`;
  if (value < 0) return `${what} can't be negative`;
  if (value > max) return `${what} can't be more than ${max.toLocaleString('en-US')}`;
  if (Math.abs(value * 100 - Math.round(value * 100)) > 1e-6) return `${what} can have at most 2 decimals`;
  return null;
}

/**
 * Does this cell exist on the board? Run after the row's section is read from the database. A
 * custom section passes its own shape (its kind and Mon–Fri); a built-in one passes its key.
 */
export function entryAllowed(
  section: SectionKey | Pick<SectionDef, 'title' | 'kind' | 'days'>,
  slot: Slot,
  date: string,
): Parsed<true> {
  const def = typeof section === 'string' ? sectionDef(section) : section;
  if (!SLOTS_BY_KIND[def.kind].includes(slot)) {
    return { ok: false, error: `${def.title} has no "${slot}" number` };
  }
  if (!def.days.includes(weekdayOf(date))) {
    return { ok: false, error: `${def.title} is not kept on ${weekdayOf(date)}` };
  }
  return { ok: true, value: true };
}

export interface CollectionCreate {
  rowId: string;
  date: string;
  businessName: string;
  points: number;
  amountUsd: number | null;
}

export function parseCollectionCreate(body: unknown, today: string): Parsed<CollectionCreate> {
  const b = obj(body);
  if (!b) return { ok: false, error: 'Expected a JSON object' };
  if (!isUuid(b.rowId)) return { ok: false, error: 'Pick the rep who collected' };
  const date = boardDate(b.date, today);
  if (!date.ok) return date;
  if (!sectionDef('collections').days.includes(weekdayOf(date.value))) {
    return { ok: false, error: 'Collections are kept Monday to Friday, as on the sheet' };
  }
  const businessName = typeof b.businessName === 'string' ? b.businessName.trim().replace(/\s+/g, ' ') : '';
  if (businessName.length < 1 || businessName.length > 200) {
    return { ok: false, error: 'Business name is required (up to 200 characters)' };
  }
  // Points are WHOLE numbers: every point on the sheet's 9,984-row log and on the board is an integer
  // (0–14). A decimal here is almost always a dollar amount typed into the wrong box.
  if (typeof b.points !== 'number' || !Number.isInteger(b.points) || b.points < 0 || b.points > MAX_POINTS) {
    return {
      ok: false,
      error:
        typeof b.points === 'number' && Number.isFinite(b.points) && !Number.isInteger(b.points)
          ? 'Points are a whole number, usually 1. The dollar amount goes in Amount (USD).'
          : `Points are a whole number from 0 to ${MAX_POINTS}, usually 1`,
    };
  }
  let amountUsd: number | null = null;
  if (b.amountUsd !== undefined && b.amountUsd !== null && b.amountUsd !== '') {
    const problem = numberProblem(b.amountUsd, MAX_AMOUNT_USD, 'The amount');
    if (problem) {
      return {
        ok: false,
        error: problem.endsWith('decimals') ? 'The amount is dollars and cents, like 94.05 (at most 2 decimals)' : problem,
      };
    }
    amountUsd = Math.round((b.amountUsd as number) * 100) / 100;
  }
  return { ok: true, value: { rowId: b.rowId, date: date.value, businessName, points: b.points, amountUsd } };
}

export const MAX_POINTS = 100;
export const MAX_AMOUNT_USD = 10_000_000;

export interface RowCreate {
  sectionKey: RowSectionKey;
  /** Required for a custom section's row (sectionKey 'custom'), refused on any other. */
  customSectionId: string | null;
  label: string;
  workEmail: string | null;
}

export function cleanLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const label = value.trim().replace(/\s+/g, ' ');
  return label.length >= 1 && label.length <= 80 ? label : null;
}

export function parseRowCreate(body: unknown): Parsed<RowCreate> {
  const b = obj(body);
  if (!b) return { ok: false, error: 'Expected a JSON object' };
  if (!isRowSectionKey(b.sectionKey)) return { ok: false, error: 'Unknown section' };
  let customSectionId: string | null = null;
  if (b.sectionKey === 'custom') {
    if (!isUuid(b.customSectionId)) return { ok: false, error: 'customSectionId must be a custom section id' };
    customSectionId = b.customSectionId;
  } else if (b.customSectionId !== undefined && b.customSectionId !== null) {
    return { ok: false, error: 'Only a custom section row names a customSectionId' };
  }
  const label = cleanLabel(b.label);
  if (!label) return { ok: false, error: 'A name of 1–80 characters is required' };
  let workEmail: string | null = null;
  if (b.workEmail !== undefined && b.workEmail !== null && b.workEmail !== '') {
    workEmail = normalizeEmail(b.workEmail);
    if (!workEmail) return { ok: false, error: 'That is not an email address' };
  }
  return { ok: true, value: { sectionKey: b.sectionKey, customSectionId, label, workEmail } };
}

export interface RowPatch {
  id: string;
  label?: string;
  sortOrder?: number;
  archived?: true;
  /** Buckets only (checked against the row's section on the server): null clears it. */
  bucketDay?: Weekday | null;
  /** Open Disputes only (checked on the server). */
  dueSoon?: boolean;
  /** Chargeback Outcomes only (checked on the server): win, loss or pre_arb; null = not counted. */
  outcome?: Outcome | null;
}

export function parseRowPatch(body: unknown): Parsed<RowPatch> {
  const b = obj(body);
  if (!b) return { ok: false, error: 'Expected a JSON object' };
  if (!isUuid(b.id)) return { ok: false, error: 'id must be a row id' };
  const out: RowPatch = { id: b.id };
  if (b.label !== undefined) {
    const label = cleanLabel(b.label);
    if (!label) return { ok: false, error: 'A name of 1–80 characters is required' };
    out.label = label;
  }
  if (b.sortOrder !== undefined) {
    if (!Number.isInteger(b.sortOrder) || (b.sortOrder as number) < 0 || (b.sortOrder as number) > 10000) {
      return { ok: false, error: 'sortOrder is a whole number 0–10000' };
    }
    out.sortOrder = b.sortOrder as number;
  }
  if (b.archived !== undefined) {
    if (b.archived !== true) return { ok: false, error: 'archived can only be true (rows are never un-archived)' };
    out.archived = true;
  }
  if (b.bucketDay !== undefined) {
    if (b.bucketDay !== null && !(MON_FRI as readonly unknown[]).includes(b.bucketDay)) {
      return { ok: false, error: 'bucketDay is mon, tue, wed, thu, fri or null' };
    }
    out.bucketDay = b.bucketDay as Weekday | null;
  }
  if (b.dueSoon !== undefined) {
    if (typeof b.dueSoon !== 'boolean') return { ok: false, error: 'dueSoon is true or false' };
    out.dueSoon = b.dueSoon;
  }
  if (b.outcome !== undefined) {
    if (b.outcome !== null && !isOutcome(b.outcome)) return { ok: false, error: 'outcome is win, loss, pre_arb or null' };
    out.outcome = b.outcome;
  }
  if (
    out.label === undefined &&
    out.sortOrder === undefined &&
    out.archived === undefined &&
    out.bucketDay === undefined &&
    out.dueSoon === undefined &&
    out.outcome === undefined
  ) {
    return { ok: false, error: 'Nothing to change' };
  }
  return { ok: true, value: out };
}

export function parseMemberWrite(body: unknown): Parsed<{ workEmail: string }> {
  const b = obj(body);
  if (!b) return { ok: false, error: 'Expected a JSON object' };
  const workEmail = normalizeEmail(b.workEmail);
  if (!workEmail) return { ok: false, error: 'A work email is required' };
  return { ok: true, value: { workEmail } };
}

/** Setup → Access: grant a role. Only Admin or Assistant: a Team member is the member list, not a grant. */
export function parseRoleWrite(body: unknown): Parsed<{ email: string; role: 'admin' | 'assistant' }> {
  const b = obj(body);
  if (!b) return { ok: false, error: 'Expected a JSON object' };
  const email = normalizeEmail(b.email);
  if (!email) return { ok: false, error: 'A work email is required' };
  if (b.role !== 'admin' && b.role !== 'assistant') return { ok: false, error: 'role is admin or assistant' };
  return { ok: true, value: { email, role: b.role } };
}

export interface SectionPatch {
  sectionKey: SectionKey;
  enabled?: boolean;
  /** null resets to the default goal, or clears a goal a manager set on a section with no default. */
  goal?: number | null;
  /** False takes its card off the Overview and out of the Team Score (Carla, 2026-10-07). */
  showOnOverview?: boolean;
}

/** Setup → Sections' "Show on Overview": a real true or false, never a truthy string or a number. */
function parseShowOnOverview(value: unknown): Parsed<boolean | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== 'boolean') return { ok: false, error: 'showOnOverview is true or false' };
  return { ok: true, value };
}

export function parseSectionPatch(body: unknown): Parsed<SectionPatch> {
  const b = obj(body);
  if (!b) return { ok: false, error: 'Expected a JSON object' };
  if (!isSectionKey(b.sectionKey)) return { ok: false, error: 'Unknown section' };
  const out: SectionPatch = { sectionKey: b.sectionKey };
  if (b.enabled !== undefined) {
    if (typeof b.enabled !== 'boolean') return { ok: false, error: 'enabled is true or false' };
    out.enabled = b.enabled;
  }
  const shown = parseShowOnOverview(b.showOnOverview);
  if (!shown.ok) return shown;
  if (shown.value !== undefined) out.showOnOverview = shown.value;
  if (b.goal !== undefined) {
    if (b.goal === null) out.goal = null;
    else {
      // Every built-in section can carry a goal since 2026-10-07 (Carla: "a button to set a goal for those
      // without one"); one with no shape cannot, because nothing says what it would be judged on.
      const shape = goalShapeOf(sectionDef(b.sectionKey));
      if (!shape) return { ok: false, error: 'This section has no goal' };
      const max = goalMax(shape);
      const goal = money2(b.goal, 0, max);
      if (goal === null) {
        return { ok: false, error: `A goal is 0–${max.toLocaleString('en-US')}${shape.unit === '%' ? '%' : ''} with at most 2 decimals` };
      }
      out.goal = goal;
    }
  }
  if (out.enabled === undefined && out.goal === undefined && out.showOnOverview === undefined) {
    return { ok: false, error: 'Nothing to change' };
  }
  return { ok: true, value: out };
}

// ---------------------------------------------------------------------------
// Collections: Payment Verified
// ---------------------------------------------------------------------------

export function parseVerifyWrite(body: unknown): Parsed<{ collectionId: string; verified: boolean }> {
  const b = obj(body);
  if (!b) return { ok: false, error: 'Expected a JSON object' };
  if (!isUuid(b.collectionId)) return { ok: false, error: 'collectionId must be a collection id' };
  if (typeof b.verified !== 'boolean') return { ok: false, error: 'verified is true or false' };
  return { ok: true, value: { collectionId: b.collectionId, verified: b.verified } };
}

// ---------------------------------------------------------------------------
// Payroll Problems: the log and its types
// ---------------------------------------------------------------------------

/**
 * How many problems one log line records: 0–1000 (the SQL CHECK acct_sb_prob_count_range). 0 is a real
 * "0 problems" since 2026-10-07 (Kane: "lets not limit it to 1 to 1000 lets start from 0 because 0 can
 * count as 0 problems"); it was 1–1000. Nothing logged is still "—", never 0.
 */
export const MIN_PROBLEMS_PER_LINE = 0;
export const MAX_PROBLEMS_PER_LINE = 1000;

export interface ProblemCreate {
  rowId: string;
  date: string;
  typeId: string;
  count: number;
}

export function parseProblemCreate(body: unknown, today: string): Parsed<ProblemCreate> {
  const b = obj(body);
  if (!b) return { ok: false, error: 'Expected a JSON object' };
  if (!isUuid(b.rowId)) return { ok: false, error: 'Pick the person who handled it' };
  const date = boardDate(b.date, today);
  if (!date.ok) return date;
  if (!sectionDef('payroll_problems').days.includes(weekdayOf(date.value))) {
    return { ok: false, error: 'Payroll problems are kept Monday to Friday' };
  }
  if (!isUuid(b.typeId)) return { ok: false, error: 'Pick a problem type' };
  const count = b.count === undefined ? 1 : b.count;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < MIN_PROBLEMS_PER_LINE || count > MAX_PROBLEMS_PER_LINE) {
    return { ok: false, error: `How many is a whole number from ${MIN_PROBLEMS_PER_LINE} to ${MAX_PROBLEMS_PER_LINE}` };
  }
  return { ok: true, value: { rowId: b.rowId, date: date.value, typeId: b.typeId, count } };
}

export function cleanTypeLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const label = value.trim().replace(/\s+/g, ' ');
  return label.length >= 1 && label.length <= 60 ? label : null;
}

export function parseProblemTypeCreate(body: unknown): Parsed<{ label: string }> {
  const b = obj(body);
  if (!b) return { ok: false, error: 'Expected a JSON object' };
  const label = cleanTypeLabel(b.label);
  if (!label) return { ok: false, error: 'A type name of 1–60 characters is required' };
  return { ok: true, value: { label } };
}

export function parseProblemTypeArchive(body: unknown): Parsed<{ id: string }> {
  const b = obj(body);
  if (!b) return { ok: false, error: 'Expected a JSON object' };
  if (!isUuid(b.id)) return { ok: false, error: 'id must be a problem type id' };
  if (b.archived !== true) return { ok: false, error: 'archived can only be true (a type is never deleted or brought back)' };
  return { ok: true, value: { id: b.id } };
}

// ---------------------------------------------------------------------------
// Custom sections
// ---------------------------------------------------------------------------

export interface CustomSectionCreate {
  title: string;
  kind: CustomKind;
  goal: number | null;
  goalDirection: GoalDirection | null;
  /** The built-in tab it is shown inside; null = a tab of its own. */
  hostSectionKey: SectionKey | null;
}

/**
 * Where a custom section is shown: absent or null = a tab of its own; otherwise a built-in section
 * that has a tab of its own (HOST_SECTION_KEYS). A section's name never decides it.
 */
export function parseHostSectionKey(value: unknown): Parsed<SectionKey | null> {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (!isHostSectionKey(value)) return { ok: false, error: 'hostSectionKey is a built-in tab, or null for a tab of its own' };
  return { ok: true, value };
}

export function cleanSectionTitle(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const title = value.trim().replace(/\s+/g, ' ');
  return title.length >= 1 && title.length <= 60 ? title : null;
}

/**
 * A goal for a custom section of `kind`: an AM/PM section is scored 0–10, so its goal is a score
 * to reach (at least, at most 10); a one-number-a-day section's goal is a week total, at least or below.
 */
export function customGoal(
  kind: CustomKind,
  goal: unknown,
  direction: unknown,
): Parsed<{ goal: number | null; goalDirection: GoalDirection | null }> {
  if (goal === null || goal === undefined || goal === '') return { ok: true, value: { goal: null, goalDirection: null } };
  const max = kind === 'am_pm' ? 10 : 100000;
  const g = money2(goal, 0, max);
  if (g === null) return { ok: false, error: `A goal is 0–${max.toLocaleString('en-US')} with at most 2 decimals` };
  if (kind === 'am_pm') {
    if (direction !== undefined && direction !== null && direction !== 'at_least') {
      return { ok: false, error: 'A scored section’s goal is a score to reach (at least)' };
    }
    return { ok: true, value: { goal: g, goalDirection: 'at_least' } };
  }
  if (direction !== 'at_least' && direction !== 'below') return { ok: false, error: 'Say whether the goal is "at least" or "below"' };
  return { ok: true, value: { goal: g, goalDirection: direction } };
}

export function parseCustomSectionCreate(body: unknown): Parsed<CustomSectionCreate> {
  const b = obj(body);
  if (!b) return { ok: false, error: 'Expected a JSON object' };
  const title = cleanSectionTitle(b.title);
  if (!title) return { ok: false, error: 'A section name of 1–60 characters is required' };
  if (typeof b.kind !== 'string' || !(CUSTOM_KINDS as readonly string[]).includes(b.kind)) {
    return { ok: false, error: `kind is ${CUSTOM_KINDS.join(' or ')}` };
  }
  const kind = b.kind as CustomKind;
  const goal = customGoal(kind, b.goal, b.goalDirection);
  if (!goal.ok) return goal;
  const host = parseHostSectionKey(b.hostSectionKey);
  if (!host.ok) return host;
  return { ok: true, value: { title, kind, ...goal.value, hostSectionKey: host.value } };
}

export interface CustomSectionPatch {
  id: string;
  title?: string;
  enabled?: boolean;
  /** False takes its card off the Overview and out of the Team Score; its grid stays where it is. */
  showOnOverview?: boolean;
  /** Raw: checked against the section's kind on the server (customGoal). null clears the goal. */
  goal?: unknown;
  goalDirection?: unknown;
  /** null moves it back to a tab of its own. */
  hostSectionKey?: SectionKey | null;
  archived?: true;
}

export function parseCustomSectionPatch(body: unknown): Parsed<CustomSectionPatch> {
  const b = obj(body);
  if (!b) return { ok: false, error: 'Expected a JSON object' };
  if (!isUuid(b.id)) return { ok: false, error: 'id must be a custom section id' };
  const out: CustomSectionPatch = { id: b.id };
  if (b.title !== undefined) {
    const title = cleanSectionTitle(b.title);
    if (!title) return { ok: false, error: 'A section name of 1–60 characters is required' };
    out.title = title;
  }
  if (b.enabled !== undefined) {
    if (typeof b.enabled !== 'boolean') return { ok: false, error: 'enabled is true or false' };
    out.enabled = b.enabled;
  }
  const shown = parseShowOnOverview(b.showOnOverview);
  if (!shown.ok) return shown;
  if (shown.value !== undefined) out.showOnOverview = shown.value;
  if (b.goal !== undefined) {
    out.goal = b.goal;
    out.goalDirection = b.goalDirection;
  }
  if (b.hostSectionKey !== undefined) {
    const host = parseHostSectionKey(b.hostSectionKey);
    if (!host.ok) return host;
    out.hostSectionKey = host.value;
  }
  if (b.archived !== undefined) {
    if (b.archived !== true) return { ok: false, error: 'archived can only be true (a section is never brought back)' };
    out.archived = true;
  }
  if (
    out.title === undefined &&
    out.enabled === undefined &&
    out.showOnOverview === undefined &&
    !('goal' in out) &&
    out.hostSectionKey === undefined &&
    out.archived === undefined
  ) {
    return { ok: false, error: 'Nothing to change' };
  }
  return { ok: true, value: out };
}

// ---------------------------------------------------------------------------
// Task boards (plan Task 7, Open item 393; docs/features/accounting-scoreboard-tasks.md)
// ---------------------------------------------------------------------------

export const TASK_TITLE_MAX = 300;

function taskTitle(value: unknown): Parsed<string> {
  if (typeof value !== 'string') return { ok: false, error: 'A task needs a title' };
  const title = value.trim().replace(/\s+/g, ' ');
  if (!title) return { ok: false, error: 'A task needs a title' };
  if (title.length > TASK_TITLE_MAX) return { ok: false, error: `A task title is at most ${TASK_TITLE_MAX} characters` };
  return { ok: true, value: title };
}

export interface TaskCreate {
  ownerEmail: string;
  title: string;
  frequency: TaskFrequency;
}

/** Admin: a new task on someone's board. Whether the owner is on the board is the server's check. */
export function parseTaskCreate(body: unknown): Parsed<TaskCreate> {
  const b = obj(body);
  if (!b) return { ok: false, error: 'Expected a JSON object' };
  const ownerEmail = normalizeEmail(b.ownerEmail);
  if (!ownerEmail) return { ok: false, error: 'Pick whose board the task goes on' };
  const title = taskTitle(b.title);
  if (!title.ok) return title;
  if (!isTaskFrequency(b.frequency)) return { ok: false, error: 'Pick how often the task is done' };
  return { ok: true, value: { ownerEmail, title: title.value, frequency: b.frequency } };
}

export interface TaskPatch {
  id: string;
  title?: string;
  sortOrder?: number;
  /** Archive the task (final: a task is never deleted or un-archived). Only `true` is accepted. */
  archived?: true;
}

/**
 * Admin: rename, reorder or archive. The owner and the frequency never change in place (the table refuses it):
 * a new frequency is a new task, so an old tick never changes meaning.
 */
export function parseTaskPatch(body: unknown): Parsed<TaskPatch> {
  const b = obj(body);
  if (!b) return { ok: false, error: 'Expected a JSON object' };
  if (!isUuid(b.id)) return { ok: false, error: 'id must be a task id' };
  if (b.ownerEmail !== undefined || b.frequency !== undefined) {
    return { ok: false, error: "A task's owner and frequency never change. Archive it and add a new one." };
  }
  const out: TaskPatch = { id: b.id };
  if (b.title !== undefined) {
    const title = taskTitle(b.title);
    if (!title.ok) return title;
    out.title = title.value;
  }
  if (b.sortOrder !== undefined) {
    if (typeof b.sortOrder !== 'number' || !Number.isInteger(b.sortOrder) || Math.abs(b.sortOrder) > 100_000) {
      return { ok: false, error: 'sortOrder is a whole number' };
    }
    out.sortOrder = b.sortOrder;
  }
  if (b.archived !== undefined) {
    if (b.archived !== true) return { ok: false, error: 'A task is archived for good: archived can only be true' };
    out.archived = true;
  }
  if (out.title === undefined && out.sortOrder === undefined && out.archived === undefined) {
    return { ok: false, error: 'Nothing to change' };
  }
  return { ok: true, value: out };
}

export interface TaskFrequencyChange {
  id: string;
  frequency: TaskFrequency;
  /** A new title in the same save; absent keeps the old one. */
  title?: string;
}

/**
 * Admin: change how often a task is done (POST /tasks/frequency). Never in place: the server adds a new task with the
 * new frequency and archives this one, which keeps its ticks. The owner never changes, here or anywhere.
 */
export function parseTaskFrequencyChange(body: unknown): Parsed<TaskFrequencyChange> {
  const b = obj(body);
  if (!b) return { ok: false, error: 'Expected a JSON object' };
  if (!isUuid(b.id)) return { ok: false, error: 'id must be a task id' };
  if (b.ownerEmail !== undefined) {
    return { ok: false, error: "A task's owner never changes. Remove it and add a new one on the other board." };
  }
  if (!isTaskFrequency(b.frequency)) return { ok: false, error: 'Pick how often the task is done' };
  const out: TaskFrequencyChange = { id: b.id, frequency: b.frequency };
  if (b.title !== undefined) {
    const title = taskTitle(b.title);
    if (!title.ok) return title;
    out.title = title.value;
  }
  return { ok: true, value: out };
}

/** A tick or an untick. The period is the server's, from today (US Eastern), never the body's. */
export function parseTaskCheck(body: unknown): Parsed<{ taskId: string; done: boolean }> {
  const b = obj(body);
  if (!b) return { ok: false, error: 'Expected a JSON object' };
  if (!isUuid(b.taskId)) return { ok: false, error: 'taskId must be a task id' };
  if (typeof b.done !== 'boolean') return { ok: false, error: 'done is true or false' };
  return { ok: true, value: { taskId: b.taskId, done: b.done } };
}

/** GET ?person=: 'me' (the default), 'all' (the All view), or a board person's work email. */
export function parseTaskView(value: string | null): Parsed<{ kind: 'me' } | { kind: 'all' } | { kind: 'person'; email: string }> {
  if (value === null || value === '' || value === 'me') return { ok: true, value: { kind: 'me' } };
  if (value === 'all') return { ok: true, value: { kind: 'all' } };
  const email = normalizeEmail(value);
  if (!email) return { ok: false, error: 'person is me, all, or a work email' };
  return { ok: true, value: { kind: 'person', email } };
}
