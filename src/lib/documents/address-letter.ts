// Proof of Residential Address letter — the PURE rules.
//
// Accounting → Documents → Signing Queue → "Proof of Address" issues a signed letter
// stating that a worker is contracted with Simple and has given us the residential
// address printed in its box. Carla's rule (2026-10-06): only Accounting creates it.
//
// WHERE THE ADDRESS COMES FROM — one source per address, never a blend:
//   1. the ROSTER (`global_master_list`): `full_address` wins over `street` for the
//      address line, exactly as the ID card composes it (employee-id-card.md:99), with
//      city / province / postal code from the same row;
//   2. else the NEWEST onboarding submission carrying a street — the address the
//      contractor typed on their own paperwork;
//   3. else nothing, and every field is a blank Accounting must type.
// `employee_ids.full_address` (the payout address the employee edits on Profile →
// Payment) is NEVER a source: an identity document follows the roster, and a fallback
// to the payout row is the one employee-id-card.md:93-95 forbids.
//
// Mixing sources is refused on purpose: a street from the roster with a postal code
// from a 2026 onboarding form describes no house anyone lives in.
//
// COUNTRY comes only from a submission's hire-selected `country`, never `invite_country`
// (a Filipino was once invited under "Colombia", cop-country-payees.md:57-64). The
// roster has no country column, so a roster-sourced address usually leaves it blank.
//
// THE REP FILLS ONLY BLANKS — Termination Letters #35 (termination-docs.md:310). An
// on-file value cannot be overridden from this dialog; a stale roster address is fixed
// by HR on the roster, not typed over here.
//
// This module is imported by `npm test`, so it stays free of 'server-only' imports;
// the reads live in ./address-letter-facts.ts.

import { ONBOARDING_COUNTRIES, resolveOnboardingCountry } from '@/lib/onboarding/countries';
import type { ActiveGateWording } from './coe-admin';
import {
  ADDRESS_LETTER_FIELDS,
  formatDocumentDate,
  type AddressLetterAddress,
  type AddressLetterField,
  type CompleteLetterAddress,
  type AddressLetterPreviewFacts,
} from './types';

/** Server-side facts — the same shape the preview route returns. */
export type AddressLetterFacts = AddressLetterPreviewFacts;

/** Why a letter cannot be issued. Surfaced verbatim to the rep. */
export type AddressLetterBlockedReason =
  | { code: 'no_master'; message: string }
  | { code: 'bad_name'; message: string }
  | { code: 'no_start_date'; message: string }
  | { code: 'no_department'; message: string };

export type AddressLetterFactsResult =
  | { facts: AddressLetterFacts; blocked: null; error: null }
  | { facts: null; blocked: AddressLetterBlockedReason; error: null }
  | { facts: null; blocked: null; error: string };

/** The letter says "is currently contracted with Simple", so it takes the COE's
 *  active-roster gate (fails closed) under its own name. */
export const ADDRESS_LETTER_GATE_WORDING: ActiveGateWording = {
  short: 'Proof of Address letter',
  long: 'Proof of Residential Address letter',
};

/** Rep-facing names for the four box fields, in the letter's own words. */
export const ADDRESS_LETTER_FIELD_LABELS: Record<AddressLetterField, string> = {
  street: 'Residential address',
  cityProvince: 'City / State / Province',
  postalCode: 'Postal / ZIP code',
  country: 'Country',
};

/** Longest value a rep may type per field. The letter wraps, but a paragraph
 *  pasted into a postal-code box is a mistake, not an address. */
export const ADDRESS_LETTER_MAX_LENGTH: Record<AddressLetterField, number> = {
  street: 200,
  cityProvince: 120,
  postalCode: 20,
  country: 60,
};

/** The countries a rep may pick — the onboarding list, nothing typed. */
export const ADDRESS_LETTER_COUNTRIES: readonly string[] = ONBOARDING_COUNTRIES.map((c) => c.name);

/** The roster row's address cells, as `getEmployeeMasterRecord` maps them. */
export interface RosterAddressParts {
  fullAddress: string | null | undefined;
  street: string | null | undefined;
  city: string | null | undefined;
  province: string | null | undefined;
  postalCode: string | null | undefined;
}

/** One `hr_onboarding_submissions` row's address cells. */
export interface SubmissionAddressRow {
  createdAt: string | null;
  street: string | null;
  city: string | null;
  province: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
}

export interface PickedLetterAddress {
  address: AddressLetterAddress;
  addressSource: 'roster' | 'onboarding' | null;
  addressSourceDetail: string | null;
  countrySource: 'onboarding' | null;
}

/** Trim + collapse inner whitespace; blank ⇒ null. */
export function cleanAddressPart(raw: string | null | undefined): string | null {
  const s = (raw ?? '').replace(/\s+/g, ' ').trim();
  return s || null;
}

/** "Caloocan, Metro Manila". A province that repeats the city ("Cebu City", "Cebu"
 *  is fine; "Makati", "Makati" is not) prints once. */
export function joinCityProvince(
  city: string | null | undefined,
  province: string | null | undefined,
): string | null {
  const c = cleanAddressPart(city);
  const p = cleanAddressPart(province);
  if (c && p && c.toLowerCase() === p.toLowerCase()) return c;
  return [c, p].filter(Boolean).join(', ') || null;
}

/** Newest first; an undated row sorts last (it cannot be shown to be current). */
function byNewest(a: SubmissionAddressRow, b: SubmissionAddressRow): number {
  const at = a.createdAt ? Date.parse(a.createdAt) : Number.NaN;
  const bt = b.createdAt ? Date.parse(b.createdAt) : Number.NaN;
  if (Number.isNaN(at) && Number.isNaN(bt)) return 0;
  if (Number.isNaN(at)) return 1;
  if (Number.isNaN(bt)) return -1;
  return bt - at;
}

/**
 * Decide the letter's address from the records — roster, else the newest
 * onboarding submission with a street, else nothing. See the file header.
 */
export function pickLetterAddress(
  roster: RosterAddressParts | null,
  submissions: readonly SubmissionAddressRow[],
): PickedLetterAddress {
  const sorted = [...submissions].sort(byNewest);

  // Country: the hire-selected value only, canonicalised through the onboarding
  // list so "PH" and "Philippines" print the same.
  const countryOf = (row: SubmissionAddressRow | undefined): string | null =>
    row ? resolveOnboardingCountry(row.country)?.name ?? null : null;

  const rosterLine = roster
    ? cleanAddressPart(roster.fullAddress) ?? cleanAddressPart(roster.street)
    : null;
  if (roster && rosterLine) {
    const withCountry = sorted.find((s) => countryOf(s));
    const country = countryOf(withCountry);
    return {
      address: {
        street: rosterLine,
        cityProvince: joinCityProvince(roster.city, roster.province),
        postalCode: cleanAddressPart(roster.postalCode),
        country,
      },
      addressSource: 'roster',
      addressSourceDetail: 'Roster (Global Master List)',
      countrySource: country ? 'onboarding' : null,
    };
  }

  const submission = sorted.find((s) => cleanAddressPart(s.street));
  if (submission) {
    // One source per address: the country must come from THIS form too.
    const country = countryOf(submission);
    const when = submission.createdAt ? formatDocumentDate(submission.createdAt) : null;
    return {
      address: {
        street: cleanAddressPart(submission.street),
        cityProvince: joinCityProvince(submission.city, submission.province ?? submission.state),
        postalCode: cleanAddressPart(submission.postalCode),
        country,
      },
      addressSource: 'onboarding',
      addressSourceDetail: when && when !== '—' ? `Onboarding form, submitted ${when}` : 'Onboarding form',
      countrySource: country ? 'onboarding' : null,
    };
  }

  // No address on file at all. A country on some form is still a fact about the
  // person, but with no street it would sit alone in a box the rep is otherwise
  // typing — keep it, it saves a pick and it is the hire's own answer.
  const country = countryOf(sorted.find((s) => countryOf(s)));
  return {
    address: { street: null, cityProvince: null, postalCode: null, country },
    addressSource: null,
    addressSourceDetail: null,
    countrySource: country ? 'onboarding' : null,
  };
}

/** The fields the records leave blank, in box order. */
export function letterBlanks(address: AddressLetterAddress): AddressLetterField[] {
  return ADDRESS_LETTER_FIELDS.filter((f) => !address[f]);
}

export type ApplyLetterFillsResult =
  | { ok: true; address: CompleteLetterAddress; typed: AddressLetterField[] }
  | { ok: false; error: string };

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const POSTAL_SHAPE = /^[A-Za-z0-9][A-Za-z0-9 -]*$/;

/**
 * Merge what the rep typed into the on-file address. ONLY blank fields may be
 * filled (termination-docs.md:310); any other key, an unknown key, a bad value or
 * a field still blank after the merge refuses the whole request.
 */
export function applyLetterFills(
  onFile: AddressLetterAddress,
  fills: unknown,
): ApplyLetterFillsResult {
  if (fills != null && (typeof fills !== 'object' || Array.isArray(fills))) {
    return { ok: false, error: 'fills must be an object' };
  }
  const given = (fills ?? {}) as Record<string, unknown>;
  const blanks = new Set(letterBlanks(onFile));
  const merged: AddressLetterAddress = { ...onFile };
  const typed: AddressLetterField[] = [];

  for (const [key, raw] of Object.entries(given)) {
    if (!(ADDRESS_LETTER_FIELDS as readonly string[]).includes(key)) {
      return { ok: false, error: `Unknown field "${key}"` };
    }
    const field = key as AddressLetterField;
    const label = ADDRESS_LETTER_FIELD_LABELS[field];
    if (raw == null || raw === '') continue; // left empty — caught by the "still blank" check
    if (typeof raw !== 'string') return { ok: false, error: `${label} must be text` };
    if (!blanks.has(field)) {
      return {
        ok: false,
        error: `${label} is already on file and can't be changed here. Ask HR to correct the roster.`,
      };
    }
    if (CONTROL_CHARS.test(raw)) return { ok: false, error: `${label} contains a control character` };
    const value = cleanAddressPart(raw);
    if (!value) continue;
    if (value.length > ADDRESS_LETTER_MAX_LENGTH[field]) {
      return { ok: false, error: `${label} is too long (max ${ADDRESS_LETTER_MAX_LENGTH[field]} characters)` };
    }
    if (field === 'country') {
      const country = resolveOnboardingCountry(value);
      if (!country) {
        return { ok: false, error: `Country must be one of: ${ADDRESS_LETTER_COUNTRIES.join(', ')}` };
      }
      merged.country = country.name;
    } else if (field === 'postalCode') {
      if (!POSTAL_SHAPE.test(value)) {
        return { ok: false, error: 'Postal / ZIP code may contain only letters, digits, spaces and hyphens' };
      }
      merged.postalCode = value;
    } else {
      merged[field] = value;
    }
    typed.push(field);
  }

  const { street, cityProvince, postalCode, country } = merged;
  if (!street || !cityProvince || !postalCode || !country) {
    const stillBlank = letterBlanks(merged);
    return {
      ok: false,
      error: `Still blank: ${stillBlank.map((f) => ADDRESS_LETTER_FIELD_LABELS[f]).join(', ')}. The letter can't print an empty line.`,
    };
  }
  return { ok: true, address: { street, cityProvince, postalCode, country }, typed };
}

/** Compact one-liner for the queue chip (`period_label`): "Caloocan, Metro Manila · Philippines". */
export function addressLetterSummaryLabel(address: AddressLetterAddress): string {
  return [address.cityProvince, address.country].filter(Boolean).join(' · ') || 'Residential address';
}
