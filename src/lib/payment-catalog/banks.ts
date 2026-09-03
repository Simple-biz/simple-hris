// Payment Catalog → Pay Processors → **Current Banks** — the receiving banks our
// payees actually bank with, folded to their OFFICIAL name.
//
// `employee_ids.bank_name` / `alt_bank_name` are FREE TEXT. Measured 2026-09-03 over
// the live table: **129 distinct spellings across 1,995 rows** — 17 ways of writing
// BPI, 8 of GoTyme, 14 of BDO. `bank-preferred-routing.md` §10.1 banned a bank-name
// breakdown on the People KPI band because of exactly that, and said a bank-level view
// "belongs on its own surface, after the column is normalized". This is that surface.
//
// **The normalization is DECLARED, never inferred.** Two mechanisms, in this order:
//
//   1. `bankSpellingKey()` — a MODEST key that folds only differences no human would
//      call a different bank: case, punctuation, `&` vs `and`, whitespace, and a
//      trailing corporate suffix (Inc / Corp / Company / Ltd). It does NOT drop
//      "Bank", country words, or branch names, because those distinguish real
//      institutions ("China Bank" vs "China Bank Savings").
//   2. `OFFICIAL_BANKS` — an explicit table of official names and the spellings each
//      one claims, written from the audit output (`scripts/audit-bank-spellings.mts`).
//
// A spelling that matches neither stays its OWN card, labelled unmapped. That is the
// correct outcome, not a gap to paper over: guessing that "Rizal Bank" means RCBC (it
// could be Rizal Microbank) is precisely the invented equivalence §10.1 forbids.
//
// **Nothing here writes `employee_ids`.** The column keeps its free text; this module
// only decides what to DISPLAY. Rewriting the column would be a separate Node script
// with an `--apply` gate and a SELECT backup, and it could consume this table.
//
// CLIENT-SAFE: types + pure helpers, no Supabase imports.

import {
  PAY_PROCESSOR_LOGO_MAX_BYTES,
  validatePayProcessorLogo,
  type PayProcessorLogo,
  type Validation,
} from './pay-processors';

/** app_settings key holding the JSON registry (array of BankRegistryEntry). */
export const BANKS_SETTING_KEY = 'payment_catalog.banks.registry';

/** A logo here is the same shape and the same rules as a processor logo. */
export type BankLogo = PayProcessorLogo;

// ── The spelling key ─────────────────────────────────────────────────────────

/**
 * Trailing corporate suffixes that never distinguish two banks. Stripped
 * repeatedly from the END only — "Bank of Commerce" keeps its "of Commerce",
 * and a leading/middle occurrence is left alone.
 */
const CORPORATE_SUFFIXES = new Set(['inc', 'incorporated', 'corp', 'corporation', 'company', 'co', 'ltd', 'limited', 'na']);

/**
 * Fold a raw spelling to a comparison key.
 *
 * Deliberately MODEST — it only erases differences that are not differences:
 * case, accents, punctuation, `&` vs `and`, repeated whitespace, and a trailing
 * corporate suffix. Everything beyond that (BPI = Bank of the Philippine Islands)
 * is a DECLARED alias, because it is a claim about the world that a string
 * transform cannot justify.
 *
 * "BDO Unibank, Inc." and "Bdo Unibank Inc" → `bdo unibank`.
 * "Metropolitan Bank & Trust Company" and "Metropolitan Bank and Trust Co." →
 * `metropolitan bank and trust`.
 * "China Bank" and "China Bank Savings" stay APART.
 */
export function bankSpellingKey(raw: string | null | undefined): string {
  let s = String(raw ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip accents
    .toLowerCase();
  s = s.replace(/&/g, ' and ');
  s = s.replace(/[^a-z0-9]+/g, ' ').trim();
  if (!s) return '';
  const tokens = s.split(' ').filter(Boolean);
  while (tokens.length > 1 && CORPORATE_SUFFIXES.has(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join(' ');
}

// ── The declared official banks ──────────────────────────────────────────────

export interface OfficialBank {
  /** Stable slug — the group key, and what a registry entry is filed under. */
  key: string;
  /** The official institution name. This is what the tab displays (Kane, 2026-09-03:
   *  "normalize them, make sure to get the official, then that's what we will be using"). */
  name: string;
  /** Raw spellings this bank claims, beyond its own name. Matched by `bankSpellingKey`. */
  aliases: string[];
  /** Set when the entry is not a bank at all but a wallet/processor people typed into
   *  the bank field. Shown so the row is never hidden; labelled for what it is. */
  kind?: 'bank' | 'wallet';
}

/**
 * Written from `scripts/audit-bank-spellings.mts` against the live table on
 * 2026-09-03. Every alias below is a spelling that ACTUALLY EXISTS in the data —
 * none is speculative, and none merges two institutions that are legally distinct.
 *
 * **Subsidiaries stay separate on purpose.** BDO Network Bank is not BDO Unibank,
 * China Bank Savings is not China Banking Corporation, EastWest Rural Bank is not
 * EastWest Bank, BPI Direct BanKo is not BPI, UnionDigital is not UnionBank. Each is
 * its own licensed institution with its own clearing details, and merging them would
 * tell Accounting money is somewhere it is not.
 */
export const OFFICIAL_BANKS: OfficialBank[] = [
  {
    key: 'gotyme',
    name: 'GoTyme Bank',
    aliases: ['GoTyme', 'Go Tyme Bank', 'GoTyme Bank Corporation', 'GoTymePH', 'GoTyme Bank Ph', 'GoTyme PH Bank'],
  },
  {
    key: 'bpi',
    name: 'Bank of the Philippine Islands (BPI)',
    aliases: [
      'BPI',
      'Bank of the Philippine Islands',
      'Bank of the Philippine Island',
      'Bank of the Philippines Islands',
      'Bank of the Philippines Islands (BPI)',
      'Bank of the Philippines Island',
      'Bank of the Philippines',
      'Bank of Philippine Island',
      'Bank of Philippine Islands',
      'Bank of the Philipine Islands',
      'Bank of the Phillipine Islands',
      'BPI (Bank of the Philippine Island)',
      'Bank of the Philippine Island (BPI)',
      'Bank of the Philippine Island- Kidapawan Branch',
    ],
  },
  {
    key: 'bdo',
    name: 'BDO Unibank, Inc.',
    aliases: ['BDO', 'BDO Unibank', 'Banco De Oro', 'Banco de Oro Unibank', 'Banco de Oro, Unibank'],
  },
  { key: 'bdo_network', name: 'BDO Network Bank', aliases: ['BDO Network Bank- Davao Tibungco'] },
  {
    key: 'maribank',
    name: 'MariBank Philippines, Inc.',
    aliases: ['MariBank', 'Mari Bank', 'MariBank Philippines', 'Maribank Philippines Inc. (A Rural Bank)', 'MariBank Philippines (SeaBank)'],
  },
  { key: 'seabank', name: 'SeaBank Philippines, Inc.', aliases: ['SeaBank', 'Sea Bank'] },
  {
    key: 'gcash',
    name: 'GCash (G-Xchange, Inc.)',
    kind: 'wallet',
    aliases: ['GCash', 'G-Xchange', 'G-Xchange, Inc. (GXI)', '(Gcash) G-Xchange, Inc'],
  },
  {
    key: 'unionbank',
    name: 'Union Bank of the Philippines',
    aliases: ['UnionBank', 'Union Bank', 'UnionBank of the Philippines', 'Unionbank Philippines'],
  },
  { key: 'uniondigital', name: 'UnionDigital Bank', aliases: [] },
  {
    key: 'metrobank',
    name: 'Metropolitan Bank & Trust Company (Metrobank)',
    aliases: [
      'Metrobank',
      'Metro Bank',
      'Metropolitan Bank & Trust Company',
      'Metropolitan Bank and Trust Company (Metrobank)',
      'Metropolitan and Trust Bank Company',
    ],
  },
  { key: 'securitybank', name: 'Security Bank Corporation', aliases: ['Security Bank'] },
  {
    key: 'rcbc',
    name: 'Rizal Commercial Banking Corporation (RCBC)',
    aliases: ['RCBC', 'Rizal Commercial Banking Corporation', '(RCBC) Rizal Commercial Banking Corporation'],
  },
  {
    key: 'landbank',
    name: 'Land Bank of the Philippines',
    aliases: [
      'LandBank',
      'Land Bank',
      'LandBank of the Philippines',
      'Land Bank of the Philippines (LandBank)',
      'Bangko sa Lupa ng Pilipinas (Land Bank of the Philippines)',
    ],
  },
  {
    key: 'aub',
    name: 'Asia United Bank (AUB)',
    aliases: ['AUB', 'Asia United Bank', 'Asian United Bank', 'Asia United Bank - Manila'],
  },
  { key: 'pnb', name: 'Philippine National Bank (PNB)', aliases: ['PNB', 'Philippine National Bank'] },
  { key: 'eastwest', name: 'EastWest Bank', aliases: ['East West Bank'] },
  { key: 'eastwest_rural', name: 'EastWest Rural Bank', aliases: [] },
  { key: 'cimb', name: 'CIMB Bank Philippines', aliases: ['CIMB'] },
  { key: 'maya', name: 'Maya Bank, Inc.', kind: 'wallet', aliases: ['Maya', 'Maya Bank'] },
  { key: 'paymaya', name: 'PayMaya', kind: 'wallet', aliases: [] },
  { key: 'chinabank', name: 'China Banking Corporation (Chinabank)', aliases: ['China Bank', 'Chinabank'] },
  { key: 'chinabank_savings', name: 'China Bank Savings', aliases: [] },
  { key: 'psbank', name: 'Philippine Savings Bank (PSBank)', aliases: ['PSBank'] },
  { key: 'maybank', name: 'Maybank Philippines, Inc.', aliases: ['Maybank', 'Maybank Philippines'] },
  { key: 'bank_of_commerce', name: 'Bank of Commerce', aliases: [] },
  { key: 'cebuana', name: 'Cebuana Lhuillier Rural Bank', aliases: ['Cebuana Lhuillier Bank'] },
  { key: 'bpi_banko', name: 'BPI Direct BanKo', aliases: ['BanKo (subsidiary of BPI)'] },
  // Wise is a PROCESSOR, but 27 people typed it as their receiving bank. It shows here
  // as what the data says, flagged as a wallet/processor rather than silently dropped.
  { key: 'wise', name: 'Wise', kind: 'wallet', aliases: ['Wise Pilipinas', 'Wise US', 'Wise by Column Bank'] },
  { key: 'column', name: 'Column Bank', aliases: [] },
  { key: 'cfsb', name: 'Community Federal Savings Bank', aliases: [] },
  { key: 'south_state', name: 'South State Bank', aliases: [] },
  { key: 'truist', name: 'Truist Bank', aliases: ['Truist'] },
  { key: 'davivienda', name: 'Banco Davivienda', aliases: ['Davivienda'] },
  { key: 'fairwinds', name: 'FAIRWINDS Credit Union', aliases: ['FAIRWINDS'] },
];

/** spelling key → official bank key. Built once; every official name claims itself. */
const OFFICIAL_BY_SPELLING: Map<string, string> = (() => {
  const m = new Map<string, string>();
  for (const b of OFFICIAL_BANKS) {
    for (const spelling of [b.name, ...b.aliases]) {
      const k = bankSpellingKey(spelling);
      if (k) m.set(k, b.key);
    }
  }
  return m;
})();

const OFFICIAL_BY_KEY: Map<string, OfficialBank> = new Map(OFFICIAL_BANKS.map((b) => [b.key, b]));

/** The OFFICIAL name for a raw spelling, or null when nothing claims it. */
export function officialBankFor(spelling: string | null | undefined): string | null {
  const key = OFFICIAL_BY_SPELLING.get(bankSpellingKey(spelling));
  return key ? (OFFICIAL_BY_KEY.get(key)?.name ?? null) : null;
}

/** The official bank KEY for a raw spelling, or null. */
export function officialKeyFor(spelling: string | null | undefined): string | null {
  return OFFICIAL_BY_SPELLING.get(bankSpellingKey(spelling)) ?? null;
}

/** Group key for a spelling nothing claims — namespaced so it can never collide
 *  with a declared official key. */
export function unmappedGroupKey(spelling: string): string {
  return `unmapped:${bankSpellingKey(spelling)}`;
}

// ── "That's a person, not a bank" ────────────────────────────────────────────

/** Tokens that make a string bank-ish. Presence of ANY means we never call it a name. */
const BANKISH = new Set([
  'banking', 'savings', 'trust', 'credit', 'union', 'financial', 'finance', 'rural',
  'corporation', 'corp', 'inc', 'company', 'ach', 'deposit', 'direct', 'digital',
  'gcash', 'wise', 'maya', 'paymaya', 'gotyme', 'gotymeph', 'tyme', 'bdo', 'bpi', 'rcbc',
  'aub', 'pnb', 'psbank', 'cimb', 'metrobank', 'truist', 'fairwinds', 'davivienda',
  'column', 'cfsb', 'ssb', 'gxchange', 'gxi', 'lhuillier', 'cebuana', 'philippines',
  'philippine', 'pilipinas', 'pilipinas', 'ph',
]);

/** A token that CONTAINS a banking word — maybank, unionbank, seabank, chinabank,
 *  maribank, landbank, unibank, banco, bangko. Substring rather than an exact list,
 *  so a bank brand nobody enumerated still reads as a bank rather than a person. */
function isBankishToken(token: string): boolean {
  return (
    BANKISH.has(token) ||
    token.includes('bank') ||
    token.includes('banco') ||
    token.includes('bangko')
  );
}

/**
 * Does this spelling look like a PERSON'S NAME typed into the bank field?
 *
 * 8 rows do exactly that (audit, 2026-09-03) — the account holder's name where the
 * bank belongs. They are surfaced with a "Check this" flag rather than hidden,
 * because on a surface that claims to list every bank on file **a filter never hides
 * a row** (`dept-rail.ts`, same rule). Deliberately conservative: two to six words,
 * none of them bank-ish. A single word ("FAIRWINDS", "Truist", "Davivienda") is never
 * flagged, and neither is anything containing a banking term. Six is the ceiling
 * because "Mark Andrew Tandoc De la Cruz" is a real row.
 */
export function looksLikePersonName(spelling: string | null | undefined): boolean {
  const key = bankSpellingKey(spelling);
  if (!key) return false;
  const tokens = key.split(' ').filter(Boolean);
  if (tokens.length < 2 || tokens.length > 6) return false;
  if (tokens.some(isBankishToken)) return false;
  // Any digit makes it an account/branch string, not a name.
  return !tokens.some((t) => /\d/.test(t));
}

// ── Folding the roster ───────────────────────────────────────────────────────

/** The ONLY three columns this feature reads off a payee. No account numbers,
 *  no SWIFT, no address, no names — see the route. */
export interface BankRosterRow {
  bankName: string | null | undefined;
  altBankName: string | null | undefined;
  /** Which slot the money actually goes to. */
  preferredSlot: 'primary' | 'alternative';
}

export interface BankGroup {
  /** Official key, or `unmapped:<spellingKey>`. */
  key: string;
  /** Display name — the official name, a registry override, or the raw spelling. */
  name: string;
  /** True when a declared official bank claimed this group. */
  official: boolean;
  kind: 'bank' | 'wallet';
  /** People paid INTO this bank (it sits on their preferred slot). */
  preferredCount: number;
  /** People who hold it on their OTHER slot only — money does not go here today. */
  altCount: number;
  /** Every raw spelling folded into this group, most common first. */
  spellings: string[];
  /** Set on an unmapped group whose spelling reads as a person's name. */
  looksLikePerson: boolean;
  logo: BankLogo | null;
  notes: string;
}

/**
 * Fold every payee's bank cells into one group per bank.
 *
 * Counting rule: a bank is counted **preferred** when it sits on the slot the person
 * is actually paid into (`preferred_bank_slot`), and **alt** otherwise. 8 people sit
 * on the alternative slot with a different alt bank, so reading `bank_name` alone
 * would credit a bank the money does not go to — the same slot-awareness bug class as
 * the roster export's account column.
 *
 * A person holding the SAME bank in both slots counts once, as preferred.
 *
 * `registry` entries win over the declared table: an entry's extra aliases claim
 * spellings into its group, and its name/logo/notes override the display.
 */
export function foldBankSpellings(
  rows: readonly BankRosterRow[],
  registry: readonly BankRegistryEntry[] = [],
): BankGroup[] {
  // Registry aliases first — they are Accounting's own corrections and outrank the
  // declared table for the spellings they name.
  const claimedByRegistry = new Map<string, string>();
  for (const entry of registry) {
    for (const alias of entry.aliases) {
      const k = bankSpellingKey(alias);
      if (k) claimedByRegistry.set(k, entry.key);
    }
  }
  const registryByKey = new Map(registry.map((e) => [e.key, e]));

  const groupKeyFor = (spelling: string): { key: string; official: boolean } => {
    const sk = bankSpellingKey(spelling);
    const claimed = claimedByRegistry.get(sk);
    if (claimed) return { key: claimed, official: OFFICIAL_BY_KEY.has(claimed) };
    const official = OFFICIAL_BY_SPELLING.get(sk);
    if (official) return { key: official, official: true };
    return { key: unmappedGroupKey(spelling), official: false };
  };

  interface Acc {
    key: string;
    official: boolean;
    preferredCount: number;
    altCount: number;
    /** raw spelling → times seen, to order `spellings` and name unmapped groups. */
    spellings: Map<string, number>;
  }
  const acc = new Map<string, Acc>();

  const add = (spelling: string | null | undefined, slot: 'preferred' | 'alt') => {
    const s = String(spelling ?? '').trim();
    if (!s) return;
    const { key, official } = groupKeyFor(s);
    const a = acc.get(key) ?? { key, official, preferredCount: 0, altCount: 0, spellings: new Map() };
    if (slot === 'preferred') a.preferredCount += 1;
    else a.altCount += 1;
    a.spellings.set(s, (a.spellings.get(s) ?? 0) + 1);
    acc.set(key, a);
  };

  for (const row of rows) {
    const paidSlotIsAlt = row.preferredSlot === 'alternative';
    const paidBank = String(paidSlotIsAlt ? row.altBankName : row.bankName ?? '').trim();
    const otherBank = String(paidSlotIsAlt ? row.bankName : row.altBankName ?? '').trim();
    add(paidBank, 'preferred');
    // Same bank in both slots is one bank, not two — compared on the GROUP, not the
    // spelling, or "BPI" in one slot and "Bank of the Philippine Islands" in the other
    // double-counts one person into the same card.
    const sameBank =
      paidBank && otherBank && groupKeyFor(paidBank).key === groupKeyFor(otherBank).key;
    if (!sameBank) add(otherBank, 'alt');
  }

  const groups: BankGroup[] = [...acc.values()].map((a) => {
    const spellings = [...a.spellings.entries()]
      .sort((x, y) => y[1] - x[1] || displayScore(y[0]) - displayScore(x[0]) || x[0].localeCompare(y[0]))
      .map(([s]) => s);
    const declared = OFFICIAL_BY_KEY.get(a.key) ?? null;
    const entry = registryByKey.get(a.key) ?? null;
    const fallbackName = spellings[0] ?? a.key;
    return {
      key: a.key,
      name: entry?.name?.trim() || declared?.name || fallbackName,
      official: a.official,
      kind: entry?.kind ?? declared?.kind ?? 'bank',
      preferredCount: a.preferredCount,
      altCount: a.altCount,
      spellings,
      looksLikePerson: !a.official && !entry && looksLikePersonName(fallbackName),
      logo: entry?.logo ?? null,
      notes: entry?.notes ?? '',
    };
  });

  return groups.sort(compareBankGroups);
}

/**
 * How presentable a raw spelling is, for picking which one NAMES an unmapped group.
 * Mixed case ("Rizal Bank") beats shouting or all-lowercase ("RIZAL BANK", "rizal
 * bank") — an unmapped card is named by a spelling someone typed, so pick the one a
 * human would have written on purpose. Only ever a tie-break; frequency wins first.
 */
function displayScore(spelling: string): number {
  const hasUpper = /[A-Z]/.test(spelling);
  const hasLower = /[a-z]/.test(spelling);
  return (hasUpper && hasLower ? 2 : 0) + (/^[A-Z]/.test(spelling) ? 1 : 0);
}

/** Most-paid first; ties by name. Unmapped groups never sort above a real bank
 *  with more people, so the tab opens on what actually matters. */
export function compareBankGroups(a: BankGroup, b: BankGroup): number {
  if (a.preferredCount !== b.preferredCount) return b.preferredCount - a.preferredCount;
  if (a.altCount !== b.altCount) return b.altCount - a.altCount;
  return a.name.localeCompare(b.name);
}

// ── Registry (what Accounting saves here) ────────────────────────────────────

export interface BankRegistryEntry {
  /** Official key, or an `unmapped:<spellingKey>` group key. Immutable. */
  key: string;
  /** Display-name override. Blank = keep the official/declared name. */
  name: string;
  /** Extra raw spellings this bank claims — Accounting's own normalization, and the
   *  table a future `--apply` script would rewrite `employee_ids.bank_name` from. */
  aliases: string[];
  kind: 'bank' | 'wallet';
  logo: BankLogo | null;
  notes: string;
  createdBy: string | null;
  createdAt: string;
  updatedBy: string | null;
  updatedAt: string | null;
}

export const BANK_NAME_MAX = 60;
export const BANK_NOTES_MAX = 500;
export const BANK_ALIASES_MAX = 40;

export interface BankInput {
  key: string;
  name?: string;
  aliases?: string[];
  kind?: 'bank' | 'wallet';
  logo?: BankLogo | null;
  notes?: string;
}

/** Same logo contract as the processors — one validator, never a second copy. */
export function validateBankLogo(logo: unknown): Validation {
  return validatePayProcessorLogo(logo);
}

export { PAY_PROCESSOR_LOGO_MAX_BYTES as BANK_LOGO_MAX_BYTES };

/**
 * Validate a save. The `key` must name a group that currently exists (the caller
 * passes the live group keys) — a registry row for a bank nobody banks with would
 * be invisible and unreachable.
 */
export function validateBankInput(input: unknown, liveKeys: ReadonlySet<string>): Validation {
  if (!input || typeof input !== 'object') return { ok: false, error: 'Invalid body.' };
  const r = input as Record<string, unknown>;
  const key = typeof r.key === 'string' ? r.key.trim() : '';
  if (!key) return { ok: false, error: 'Missing bank key.' };
  if (!liveKeys.has(key)) return { ok: false, error: `No bank group "${key}" on file right now.` };
  if (r.name !== undefined && (typeof r.name !== 'string' || r.name.trim().length > BANK_NAME_MAX)) {
    return { ok: false, error: `Name must be ${BANK_NAME_MAX} characters or fewer.` };
  }
  if (r.notes !== undefined && (typeof r.notes !== 'string' || r.notes.trim().length > BANK_NOTES_MAX)) {
    return { ok: false, error: `Notes must be ${BANK_NOTES_MAX} characters or fewer.` };
  }
  if (r.kind !== undefined && r.kind !== 'bank' && r.kind !== 'wallet') {
    return { ok: false, error: 'Kind must be bank or wallet.' };
  }
  if (r.aliases !== undefined) {
    if (!Array.isArray(r.aliases)) return { ok: false, error: 'Aliases must be a list.' };
    if (r.aliases.length > BANK_ALIASES_MAX) {
      return { ok: false, error: `At most ${BANK_ALIASES_MAX} spellings per bank.` };
    }
    if (r.aliases.some((a) => typeof a !== 'string' || a.trim().length > BANK_NAME_MAX)) {
      return { ok: false, error: 'Each spelling must be text, 60 characters or fewer.' };
    }
  }
  return validateBankLogo(r.logo);
}

function cleanAliases(list: readonly string[] | undefined, fallback: readonly string[]): string[] {
  if (list === undefined) return [...fallback];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of list) {
    const t = a.trim();
    const k = bankSpellingKey(t);
    if (!t || !k || seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

/** A brand-new registry row for a group. */
export function buildBankEntry(input: BankInput, actor: string, now: string): BankRegistryEntry {
  return {
    key: input.key.trim(),
    name: (input.name ?? '').trim(),
    aliases: cleanAliases(input.aliases, []),
    kind: input.kind ?? 'bank',
    logo: input.logo ?? null,
    notes: (input.notes ?? '').trim(),
    createdBy: actor,
    createdAt: now,
    updatedBy: actor,
    updatedAt: now,
  };
}

/** Apply an edit. `key`, `createdBy` and `createdAt` are immutable. */
export function applyBankPatch(
  existing: BankRegistryEntry,
  input: BankInput,
  actor: string,
  now: string,
): BankRegistryEntry {
  return {
    ...existing,
    name: input.name === undefined ? existing.name : input.name.trim(),
    aliases: cleanAliases(input.aliases, existing.aliases),
    kind: input.kind ?? existing.kind,
    logo: input.logo === undefined ? existing.logo : input.logo,
    notes: input.notes === undefined ? existing.notes : input.notes.trim(),
    updatedBy: actor,
    updatedAt: now,
  };
}

/** One stored row → a BankRegistryEntry, or null. A logo that fails validation is
 *  dropped to null rather than failing the row (a bad image must not make a bank
 *  vanish). */
export function sanitizeBankEntry(raw: unknown): BankRegistryEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const key = typeof r.key === 'string' ? r.key.trim() : '';
  if (!key) return null;
  const aliases = Array.isArray(r.aliases)
    ? cleanAliases(
        r.aliases.filter((a): a is string => typeof a === 'string').slice(0, BANK_ALIASES_MAX),
        [],
      )
    : [];
  return {
    key,
    name: typeof r.name === 'string' ? r.name.trim().slice(0, BANK_NAME_MAX) : '',
    aliases,
    kind: r.kind === 'wallet' ? 'wallet' : 'bank',
    logo: validateBankLogo(r.logo).ok ? ((r.logo as BankLogo | null) ?? null) : null,
    notes: typeof r.notes === 'string' ? r.notes.trim().slice(0, BANK_NOTES_MAX) : '',
    createdBy: typeof r.createdBy === 'string' ? r.createdBy : null,
    createdAt: typeof r.createdAt === 'string' && r.createdAt ? r.createdAt : new Date(0).toISOString(),
    updatedBy: typeof r.updatedBy === 'string' ? r.updatedBy : null,
    updatedAt: typeof r.updatedAt === 'string' && r.updatedAt ? r.updatedAt : null,
  };
}
