/**
 * Somebody other than the employee receiving a tenure gift.
 *
 * Kane, 2026-09-18: *"There are some employees that have their spouses receive
 * their gifts for them."* Until now the only place to say so was the free-text
 * Notes box — whose placeholder has read "alternative recipient" since the form
 * shipped — so the fact existed in prose and nothing could act on it.
 *
 * ONE IMPLEMENTATION, DELIBERATELY. Both forms (the employee dashboard card and
 * the public /update-gift-address page), both write routes, the Gift Tracker and
 * all three export formats read this module. Due-ness has exactly one
 * implementation for the same reason (docs/features/gift-tracker-receipts.md);
 * a second spelling of "does this parcel go to someone else" is how the screen
 * and the shipping list end up disagreeing about who is at the door.
 *
 * THE COURIER STILL CALLS THE EMPLOYEE. Kane's ruling on the brief's Q1 —
 * *"The Employees as they will contact their spouse"* — means
 * `active_contact_number` keeps its exact meaning and `recipient_contact` is an
 * additional fallback that NEVER substitutes for it. Nothing in this module
 * returns one in place of the other, and `shipping-export.test.ts` pins that the
 * export's `Contact Number` column still prints the employee's.
 *
 * Presentational and structural only: nothing here decides a milestone, a
 * due-ness, or whether a gift was received. Deliberately free of `server-only`
 * and of any React import so a server route and a client component can both
 * read it.
 */

/**
 * The closed list, mirrored by the `egsd_recipient_relationship_known` CHECK in
 * references/sql/migrate/2026-09-18_gift_alternate_recipient.sql. Keep the two
 * in step: the database is the backstop, not the definition.
 *
 * A value outside the list is REFUSED, never coerced to blank — the same trade
 * `APPAREL_SIZES` makes, and for the same reason. A silently dropped value means
 * somebody hands the parcel to the wrong person and never finds out why.
 */
export const GIFT_RECIPIENT_RELATIONSHIPS = [
  'Spouse',
  'Partner',
  'Parent',
  'Sibling',
  'Child',
  'Relative',
  'Housemate',
  'Friend',
  'Colleague',
  'Other',
] as const;

export type GiftRecipientRelationship = (typeof GIFT_RECIPIENT_RELATIONSHIPS)[number];

/** Matches the route limits and the `egsd_recipient_lengths` CHECK. */
export const MAX_RECIPIENT_NAME = 120;
export const MAX_RECIPIENT_CONTACT = 60;

/** The shape carried on a submission row, on both forms and in both routes. */
export interface AlternateRecipient {
  name: string;
  relationship: string;
  contact: string;
}

/** The "the employee receives it themself" value. Never null, never undefined. */
export const NO_ALTERNATE_RECIPIENT: AlternateRecipient = {
  name: '',
  relationship: '',
  contact: '',
};

/** Anything carrying the three columns — a database row, a form draft, a body. */
export type AlternateRecipientFields = {
  recipient_name?: string | null;
  recipient_relationship?: string | null;
  recipient_contact?: string | null;
};

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * THE predicate. A parcel goes to somebody else if and only if a non-blank name
 * was recorded.
 *
 * The name is the load-bearing field because it is the only one a courier can
 * act on: a relationship with no name names nobody, and a phone number with no
 * name is somebody to call, not somebody to hand a box to. The database refuses
 * those combinations outright (`egsd_recipient_all_or_nothing`), and this
 * predicate agrees with it rather than inventing a second rule.
 *
 * Trimmed, so '   ' is not a person.
 */
export function hasAlternateRecipient(row: AlternateRecipientFields | null | undefined): boolean {
  if (!row) return false;
  return str(row.recipient_name) !== '';
}

/**
 * Trim the triple and collapse a nameless one to the empty value.
 *
 * A relationship or a contact with no name is DROPPED rather than stored: it is
 * what a half-filled form produces, it cannot be acted on, and leaving it on the
 * row would make `hasAlternateRecipient` disagree with what the Gift Tracker
 * displays. This is the normaliser, not the validator — it never reports; it
 * only produces something storable. Use {@link validateAlternateRecipient} on
 * anything that came from a request body or a form.
 *
 * IT DOES NOT TRUNCATE. An over-long name is the validator's refusal and the
 * `egsd_recipient_lengths` CHECK's refusal; if this quietly sliced it, a write
 * path that skipped the validator would store a shortened name and the shipping
 * list would carry somebody the employee never wrote down.
 */
export function normalizeAlternateRecipient(
  input: AlternateRecipientFields | null | undefined,
): AlternateRecipient {
  const name = str(input?.recipient_name);
  if (!name) return { ...NO_ALTERNATE_RECIPIENT };
  return {
    name,
    relationship: str(input?.recipient_relationship),
    contact: str(input?.recipient_contact),
  };
}

export type AlternateRecipientVerdict =
  | { ok: true; value: AlternateRecipient }
  | { ok: false; error: string };

/**
 * Validate a submitted triple.
 *
 * REFUSES rather than repairs, in all four cases:
 *   * a name with no relationship — the form asks for both, and "who is this
 *     person to you" is what gets a parcel handed over at a door;
 *   * a relationship or a contact with no name — the partial record;
 *   * an unknown relationship — see GIFT_RECIPIENT_RELATIONSHIPS;
 *   * an over-long name or contact — matching the CHECK, so the app and the
 *     database refuse the same thing rather than one of them truncating.
 *
 * The contact is OPTIONAL by design. Kane's Q1 ruling put the courier on the
 * employee's number, so the recipient's is a fallback — requiring a fallback
 * would block a legitimate submission from somebody who simply does not have it
 * to hand.
 */
export function validateAlternateRecipient(
  input: AlternateRecipientFields | null | undefined,
): AlternateRecipientVerdict {
  const rawName = str(input?.recipient_name);
  const rawRelationship = str(input?.recipient_relationship);
  const rawContact = str(input?.recipient_contact);

  if (!rawName) {
    if (rawRelationship || rawContact) {
      return {
        ok: false,
        error: 'Enter the name of the person receiving the gift, or clear the other recipient fields.',
      };
    }
    return { ok: true, value: { ...NO_ALTERNATE_RECIPIENT } };
  }

  if (rawName.length > MAX_RECIPIENT_NAME) {
    return { ok: false, error: 'That name is longer than we can store.' };
  }
  if (rawContact.length > MAX_RECIPIENT_CONTACT) {
    return { ok: false, error: 'That contact number is longer than we can store.' };
  }
  if (!rawRelationship) {
    return { ok: false, error: 'Pick how this person is related to you.' };
  }
  if (!(GIFT_RECIPIENT_RELATIONSHIPS as readonly string[]).includes(rawRelationship)) {
    return { ok: false, error: 'Pick a relationship from the list.' };
  }

  return {
    ok: true,
    value: { name: rawName, relationship: rawRelationship, contact: rawContact },
  };
}

/**
 * "Maria Dela Cruz (Spouse)" — one spelling, shared by the export, the Gift
 * Tracker and both forms. Empty string when the employee receives it themself,
 * so a caller can fall back to a dash without re-deriving the predicate.
 */
export function describeAlternateRecipient(
  row: AlternateRecipientFields | null | undefined,
): string {
  if (!hasAlternateRecipient(row)) return '';
  const name = str(row?.recipient_name);
  const relationship = str(row?.recipient_relationship);
  return relationship ? `${name} (${relationship})` : name;
}

/** The three columns as a database patch. Always all three, never a partial. */
export function alternateRecipientColumns(
  value: AlternateRecipient,
): Required<{ [K in keyof AlternateRecipientFields]: string }> {
  return {
    recipient_name: value.name,
    recipient_relationship: value.relationship,
    recipient_contact: value.contact,
  };
}
