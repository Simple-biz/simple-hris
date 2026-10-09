/**
 * Accounting Scoreboard Keys (Open item 424, Carla 2026-10-08): the paid platforms (QBO, Stripe...) each person holds
 * a seat on, so that taking someone off the team shows every seat still to remove. Pure, so the route and Setup →
 * Keys ask the same rules.
 *
 *   - A key is one platform. Its name is unique among live keys, whatever the case.
 *   - A seat is one person holding one key. Removing it is a stamp (who, when), never a delete; holding it again is
 *     a new seat. One live seat per key per person.
 *   - Seats are given only to people on the board (the same list as tasks). Anyone who leaves the board while
 *     still holding a seat is "off the board" and listed first, because those seats are still being paid for.
 *
 * Governing doc: docs/features/accounting-scoreboard-keys.md.
 */

import type { KeySeat, ScoreboardKey, TaskPerson } from './types';
import { isUuid, normalizeEmail, type Parsed } from './validate';

export const KEY_LABEL_MAX = 40;

function obj(body: unknown): Record<string, unknown> | null {
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

/** A key's name: trimmed, inner runs of spaces collapsed, 1 to 40 characters. */
export function cleanKeyLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const label = value.trim().replace(/\s+/g, ' ');
  return label.length >= 1 && label.length <= KEY_LABEL_MAX ? label : null;
}

export function parseKeyCreate(body: unknown): Parsed<{ label: string }> {
  const b = obj(body);
  if (!b) return { ok: false, error: 'Expected a JSON object' };
  const label = cleanKeyLabel(b.label);
  if (!label) return { ok: false, error: `A key needs a name of 1 to ${KEY_LABEL_MAX} characters` };
  return { ok: true, value: { label } };
}

/** POST /keys/seats { keyId, email } and DELETE /keys/seats?keyId=…&email=… */
export function parseKeySeatWrite(body: unknown): Parsed<{ keyId: string; email: string }> {
  const b = obj(body);
  if (!b) return { ok: false, error: 'Expected a JSON object' };
  if (!isUuid(b.keyId)) return { ok: false, error: 'keyId must be a key id' };
  const email = normalizeEmail(b.email);
  if (!email) return { ok: false, error: 'A work email is required' };
  return { ok: true, value: { keyId: b.keyId, email } };
}

/** Same name, whatever the case and spacing: "QBO" and " qbo " are one platform. */
export function sameKeyName(a: string, b: string): boolean {
  return (cleanKeyLabel(a) ?? a).toLowerCase() === (cleanKeyLabel(b) ?? b).toLowerCase();
}

export function isLiveSeat(seat: Pick<KeySeat, 'removedAt'>): boolean {
  return seat.removedAt === null;
}

/** One person in the Keys grid. */
export interface KeyGridPerson {
  email: string;
  name: string;
  /** On a live person row, under Members, or holding a role grant. */
  onBoard: boolean;
  /** Live seats, in the grid's key order. */
  seats: KeySeat[];
  /** Removed seats, newest first: the history shown under the person. */
  removed: KeySeat[];
}

export interface KeyGrid {
  /** Live keys, A to Z. */
  keys: ScoreboardKey[];
  /** Live seats per key id. */
  seatCount: Record<string, number>;
  /** Everyone on the board, plus anyone off it who ever held a seat. Off-the-board holders of a live seat first. */
  people: KeyGridPerson[];
  /** People off the board who still hold a live seat: those seats are still being paid for. */
  offBoard: KeyGridPerson[];
}

function byName(a: { name: string; email: string }, b: { name: string; email: string }): number {
  return a.name.localeCompare(b.name) || a.email.localeCompare(b.email);
}

/**
 * The grid, from the GET payload. `people` is the board's people list (listTaskPeople). A seat whose holder is not on
 * it still shows, named by the address, because the point of Keys is to find seats nobody removed.
 */
export function buildKeyGrid(input: { keys: ScoreboardKey[]; seats: KeySeat[]; people: TaskPerson[] }): KeyGrid {
  const keys = input.keys.filter((k) => !k.archived).sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
  const order = new Map(keys.map((k, i) => [k.id, i]));
  const seatCount: Record<string, number> = {};
  for (const k of keys) seatCount[k.id] = 0;

  const byEmail = new Map<string, KeyGridPerson>();
  for (const p of input.people) {
    const email = p.email.trim().toLowerCase();
    if (!byEmail.has(email)) byEmail.set(email, { email, name: p.name, onBoard: true, seats: [], removed: [] });
  }
  for (const s of input.seats) {
    let person = byEmail.get(s.email);
    if (!person) {
      person = { email: s.email, name: s.email.split('@')[0], onBoard: false, seats: [], removed: [] };
      byEmail.set(s.email, person);
    }
    if (isLiveSeat(s)) {
      person.seats.push(s);
      if (s.keyId in seatCount) seatCount[s.keyId] += 1;
    } else {
      person.removed.push(s);
    }
  }

  const people = [...byEmail.values()];
  for (const p of people) {
    p.seats.sort((a, b) => (order.get(a.keyId) ?? 1e9) - (order.get(b.keyId) ?? 1e9));
    p.removed.sort((a, b) => (b.removedAt ?? '').localeCompare(a.removedAt ?? ''));
  }
  const offBoard = people.filter((p) => !p.onBoard && p.seats.length > 0).sort(byName);
  const rest = people.filter((p) => p.onBoard || p.seats.length === 0).sort(byName);
  // Someone off the board with no live seat left is history only: kept at the end, after everyone on the board.
  const onBoard = rest.filter((p) => p.onBoard);
  const gone = rest.filter((p) => !p.onBoard);
  return { keys, seatCount, people: [...offBoard, ...onBoard, ...gone], offBoard };
}

/** The live seat a person holds on a key, if any. */
export function liveSeatOf(person: Pick<KeyGridPerson, 'seats'>, keyId: string): KeySeat | null {
  return person.seats.find((s) => s.keyId === keyId) ?? null;
}

/** A key can be archived only once nobody holds a seat on it (the table's trigger refuses it too). */
export function canArchiveKey(seatsOnKey: number): boolean {
  return seatsOnKey === 0;
}

/** Search the grid by name or address. */
export function matchesPerson(person: Pick<KeyGridPerson, 'name' | 'email'>, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return person.name.toLowerCase().includes(q) || person.email.includes(q);
}
