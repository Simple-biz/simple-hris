/**
 * Accounting Scoreboard request bodies: every write is parsed here before it reaches the database.
 * The SQL CHECKs are the last line of defense; these are the first, and they say what is wrong.
 * Governing doc: docs/features/accounting-scoreboard.md § Writes.
 *
 * Pure. Session-derived fields (who, today) are passed in, never read from the body.
 */

import { isSectionKey, sectionDef, slotsFor, type SectionKey, type Slot } from './sections';
import { isIsoDate, weekdayOf } from './week';

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The earliest date the board accepts: before this is a typo, not a backfill. */
export const EARLIEST_DATE = '2024-01-01';

function obj(body: unknown): Record<string, unknown> | null {
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
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
  if (slot !== 'am' && slot !== 'pm' && slot !== 'day' && slot !== 'mtg' && slot !== 'start' && slot !== 'end') {
    return { ok: false, error: 'slot must be am, pm, day, mtg, start or end' };
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
  const count = numberProblem(b.value, MAX_COUNT, 'A count');
  if (count) return { ok: false, error: count };
  return { ok: true, value: { rowId: b.rowId, date: date.value, slot, value: Math.round((b.value as number) * 100) / 100 } };
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

/** Does this cell exist on the board? Run after the row's section is read from the database. */
export function entryAllowed(section: SectionKey, slot: Slot, date: string): Parsed<true> {
  const def = sectionDef(section);
  if (!slotsFor(section).includes(slot)) {
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
  sectionKey: SectionKey;
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
  if (!isSectionKey(b.sectionKey)) return { ok: false, error: 'Unknown section' };
  const label = cleanLabel(b.label);
  if (!label) return { ok: false, error: 'A name of 1–80 characters is required' };
  let workEmail: string | null = null;
  if (b.workEmail !== undefined && b.workEmail !== null && b.workEmail !== '') {
    workEmail = normalizeEmail(b.workEmail);
    if (!workEmail) return { ok: false, error: 'That is not an email address' };
  }
  return { ok: true, value: { sectionKey: b.sectionKey, label, workEmail } };
}

export interface RowPatch {
  id: string;
  label?: string;
  sortOrder?: number;
  archived?: true;
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
  if (out.label === undefined && out.sortOrder === undefined && out.archived === undefined) {
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

export interface SectionPatch {
  sectionKey: SectionKey;
  enabled?: boolean;
  /** null resets to the sheet's goal. */
  goal?: number | null;
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
  if (b.goal !== undefined) {
    if (b.goal === null) out.goal = null;
    else {
      if (!sectionDef(b.sectionKey).goal) return { ok: false, error: 'This section has no goal' };
      const goal = money2(b.goal, 0, 100000);
      if (goal === null) return { ok: false, error: 'A goal is 0–100000 with at most 2 decimals' };
      out.goal = goal;
    }
  }
  if (out.enabled === undefined && out.goal === undefined) return { ok: false, error: 'Nothing to change' };
  return { ok: true, value: out };
}
