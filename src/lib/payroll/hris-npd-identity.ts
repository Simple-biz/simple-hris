/**
 * HRIS vs NPD → "who is this address in HRIS?" — the roster lookup behind the Why line of a
 * **Not in HRIS** row (Kane, 2026-10-06: "Lets add the reason why they arent in HRIS please").
 *
 * The wizard's own roster is `active_employees`, which carries no one who has left, so it cannot
 * tell "offboarded on Sep 24" from "no such person". The route
 * (`POST /api/payroll-wizard/npd-identities`) reads the whole master list, active and offboarded,
 * and answers for each address NPD used: every master row that carries it, as its work email,
 * personal email or an alternate work email.
 *
 * PURE: shared by the route (matching) and the wizard (reading the reply). No fetch, no Supabase.
 *
 * Rules (docs/features/payroll-wizard-hris-vs-npd.md § Why: the reason under each row):
 *   - **It names; it never joins.** The comparison's join is the work email, exactly (Kane,
 *     2026-09-30). This lookup only explains a row that is already Not in HRIS; nothing here
 *     can move a figure or a verdict.
 *   - **Absence is not "no one".** Every requested address gets an entry, and an empty list means
 *     the master list was read whole and holds no such address. A reply missing an address is
 *     refused (`parseNpdIdentityPayload` → null), so a partial answer can never read as
 *     "not on the roster".
 */

import { normEmail } from '@/lib/email/norm-email';

/** The most addresses one lookup may ask about (the Not in HRIS rows of one week's output). */
export const NPD_IDENTITY_MAX_EMAILS = 500;

/** The master-list columns the lookup reads, as PostgREST returns them. */
export interface MasterIdentityRow {
  Name: string | null;
  Department: string | null;
  'Work Email': string | null;
  'Personal Email': string | null;
  'Alternate Work Email': string | null;
  'Alternate Work Email 2': string | null;
  'Start Date': string | null;
  off_boarded_at: string | null;
  off_boarded_reason: string | null;
}

/** One master row that carries the address asked about. */
export interface NpdIdentityMatch {
  name: string | null;
  workEmail: string | null;
  personalEmail: string | null;
  alternateEmails: string[];
  /** The master Department cell, verbatim. */
  department: string | null;
  /** The master "Start Date" cell, verbatim (the sheet's mixed formats). */
  startDate: string | null;
  /** ISO, or null while the row is active. */
  offboardedAt: string | null;
  offboardedReason: string | null;
  /** Which of the row's addresses is the one NPD used. */
  matchedBy: 'work' | 'personal' | 'alternate';
}

/** Normalized address → every master row carrying it. `[]` = the list was read and has none. */
export type NpdIdentityLookup = Readonly<Record<string, readonly NpdIdentityMatch[]>>;

function clean(s: string | null | undefined): string | null {
  const t = (s ?? '').trim();
  return t ? t : null;
}

/** The addresses a lookup is asked about: normalized, deduplicated, sorted. */
export function normalizeIdentityEmails(raw: readonly unknown[]): string[] {
  const out = new Set<string>();
  for (const e of raw) {
    const n = normEmail(typeof e === 'string' ? e : null);
    if (n) out.add(n);
  }
  return [...out].sort();
}

/**
 * Every master row carrying each address. Rows that say the same thing (one person's duplicate
 * rows with the same department and status) are kept once. Active rows sort first, then the most
 * recently offboarded, so `[0]` is the row that best describes the person today.
 */
export function matchNpdIdentities(rows: readonly MasterIdentityRow[], emails: readonly string[]): Record<string, NpdIdentityMatch[]> {
  const wanted = new Set(normalizeIdentityEmails(emails));
  const out: Record<string, NpdIdentityMatch[]> = {};
  for (const e of wanted) out[e] = [];
  for (const r of rows) {
    const work = normEmail(r['Work Email']);
    const personal = normEmail(r['Personal Email']);
    const alts = [normEmail(r['Alternate Work Email']), normEmail(r['Alternate Work Email 2'])].filter(
      (x): x is string => !!x,
    );
    const hits: Array<[string, NpdIdentityMatch['matchedBy']]> = [];
    if (work && wanted.has(work)) hits.push([work, 'work']);
    if (personal && wanted.has(personal) && personal !== work) hits.push([personal, 'personal']);
    for (const a of alts) if (wanted.has(a) && a !== work && a !== personal) hits.push([a, 'alternate']);
    for (const [email, matchedBy] of hits) {
      const m: NpdIdentityMatch = {
        name: clean(r.Name),
        workEmail: work,
        personalEmail: personal,
        alternateEmails: alts,
        department: clean(r.Department),
        startDate: clean(r['Start Date']),
        offboardedAt: clean(r.off_boarded_at),
        offboardedReason: clean(r.off_boarded_reason),
        matchedBy,
      };
      const list = out[email];
      const dup = list.some(
        (x) =>
          x.workEmail === m.workEmail &&
          x.department === m.department &&
          x.offboardedAt === m.offboardedAt &&
          x.matchedBy === m.matchedBy,
      );
      if (!dup) list.push(m);
    }
  }
  for (const list of Object.values(out)) {
    list.sort((a, b) => {
      if ((a.offboardedAt == null) !== (b.offboardedAt == null)) return a.offboardedAt == null ? -1 : 1;
      return (b.offboardedAt ?? '').localeCompare(a.offboardedAt ?? '');
    });
  }
  return out;
}

function isMatch(v: unknown): v is NpdIdentityMatch {
  if (!v || typeof v !== 'object') return false;
  const m = v as Record<string, unknown>;
  const strOrNull = (x: unknown) => x === null || typeof x === 'string';
  return (
    strOrNull(m.name) &&
    strOrNull(m.workEmail) &&
    strOrNull(m.personalEmail) &&
    Array.isArray(m.alternateEmails) &&
    m.alternateEmails.every((a) => typeof a === 'string') &&
    strOrNull(m.department) &&
    strOrNull(m.startDate) &&
    strOrNull(m.offboardedAt) &&
    strOrNull(m.offboardedReason) &&
    (m.matchedBy === 'work' || m.matchedBy === 'personal' || m.matchedBy === 'alternate')
  );
}

/**
 * The route's reply, or null when it does not hang together — including when ANY requested
 * address is missing from it. A missing address must never read as "not on the roster".
 */
export function parseNpdIdentityPayload(json: unknown, requested: readonly string[]): NpdIdentityLookup | null {
  if (!json || typeof json !== 'object') return null;
  const byEmail = (json as { byEmail?: unknown }).byEmail;
  if (!byEmail || typeof byEmail !== 'object') return null;
  const out: Record<string, NpdIdentityMatch[]> = {};
  for (const e of normalizeIdentityEmails(requested)) {
    const list = (byEmail as Record<string, unknown>)[e];
    if (!Array.isArray(list) || !list.every(isMatch)) return null;
    out[e] = list as NpdIdentityMatch[];
  }
  return out;
}
