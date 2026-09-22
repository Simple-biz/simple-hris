/**
 * "Recently filled / updated" — the gift-address submissions, newest first,
 * with the surface each one came from.
 *
 * Kane, 2026-09-22: *"so we can catch people that are using the link"*, and on
 * which submissions count — *"either from HRIS or the external link same way
 * someone we catch from the update bank information"*. So this is every
 * submission, not only the public ones, with the channel shown rather than
 * filtered.
 *
 * PURE. No Supabase import, no React import — the route reads, this shapes, the
 * sub-tab renders. Tested against `recent-submissions.test.ts`.
 *
 * THE CHANNEL IS READ, NEVER INFERRED. `employee_gift_shipping_details` has no
 * source column and is deliberately not gaining one: both write routes already
 * stamp the channel into their own `audit_log` row, so it is answerable for
 * every submission ever made without a migration and without a backfill (which
 * `docs/features/gift-alternate-recipient.md:160` forbids on this table anyway).
 * A row whose channel cannot be resolved reports `null` — rendered as
 * "Unknown source" — and NEVER the most likely one. Guessing here would
 * mislabel exactly the thing the tab exists to measure.
 *
 * THE TWO AUDIT FAMILIES KEY DIFFERENTLY, AND THAT IS THE TRAP IN THIS FILE:
 *
 *   `gift_address.saved`              resource_id = the WORK email
 *                                     (`app/api/gift-address/save/route.ts:171`,
 *                                     `resource_id: person.workEmail`)
 *                                     milestones  = `details.milestones_saved[]`
 *
 *   `employee_gift_shipping.submitted` resource_id = the PERSONAL email
 *                                     (`app/api/employee-gift-shipping/route.ts:171`,
 *                                     `normEmail(body.personal_email)`)
 *                                     milestone   = `details.milestone_index`
 *
 * The submission row itself is keyed on `personal_email`. So one family needs a
 * roster bridge and the other does not, and a bridge that silently failed would
 * relabel a public submission as unknown — which reads as "nobody used the
 * link". Both keys are resolved to the personal email before matching, and the
 * bridge folds identity across every address column the roster carries.
 */

import type { GiftSubmissionChannel } from './gift-live';

/** Trim + lowercase, or null for anything blank. One spelling, used everywhere
 *  in this module so a key can never be compared at two different casings. */
export function normKey(v: unknown): string | null {
  const t = String(v ?? '').trim().toLowerCase();
  return t || null;
}

/** The submission row, narrowed to what this feed reads. Structurally satisfied
 *  by `EmployeeGiftShippingRow` — kept local so the module stays importable from
 *  a test without dragging the Supabase types in. */
export interface SubmissionInput {
  id: string;
  personal_email: string;
  milestone_index: number;
  milestone_date: string;
  preferred_delivery_location: string;
  active_contact_number: string;
  recipient_name: string;
  recipient_relationship: string;
  notes: string;
  status: string;
  created_at: string;
  updated_at: string;
}

/** One roster person, with every address they are known by. */
export interface RosterInput {
  work_email?: string | null;
  personal_email?: string | null;
  alternate_work_email?: string | null;
  alternate_work_email_2?: string | null;
  name?: string | null;
  department?: string | null;
}

/** An `audit_log` row from either family, already narrowed by the route. */
export interface ChannelEventInput {
  action: string;
  resource_id: string | null;
  created_at: string;
  details: Record<string, unknown> | null;
}

export type SubmissionKind = 'filled' | 'updated';

export interface RecentSubmission {
  id: string;
  personalEmail: string;
  /** Null when the submitter matches no roster row — see `offRoster`. */
  workEmail: string | null;
  name: string | null;
  department: string | null;
  milestoneIndex: number;
  milestoneDate: string;
  status: string;
  /** When the row was first written. */
  filledAt: string;
  /** When it last changed. The feed's sort key. */
  updatedAt: string;
  /** `filled` on a first submission, `updated` on a later edit — see below. */
  kind: SubmissionKind;
  /** Null means the channel could not be resolved. Never a guess. */
  channel: GiftSubmissionChannel | null;
  /**
   * The submitter matches no roster row. NOT dropped and NOT hidden: an
   * off-roster submitter is the likeliest mis-ship, which is why the export
   * already appends them flagged rather than filtering them out
   * (`docs/features/gift-tracker-shipping-export.md`).
   */
  offRoster: boolean;
  /** Somebody else is receiving this one. */
  hasAlternateRecipient: boolean;
  /** "Maria Dela Cruz (Spouse)", or '' — one spelling, from the shared module. */
  alternateRecipient: string;
  address: string;
  contact: string;
  notes: string;
}

/**
 * How far apart `created_at` and `updated_at` may be and still mean "this row
 * has only ever been written once".
 *
 * The table carries no edit counter and no revision column, so first-write vs
 * later-edit is derived from the two timestamps. They are set by two separate
 * column defaults on the same INSERT, so they are near-identical but not
 * guaranteed bit-equal. Two seconds is far wider than that gap and far narrower
 * than any human returning to edit an address.
 *
 * Deliberately NOT derived by counting audit rows instead: the audit read is
 * windowed (an unbounded scan of `audit_log` is the performance trap this route
 * avoids), so a row last touched before the window would silently become
 * "filled" again. A timestamp is always on the row.
 */
export const FIRST_WRITE_TOLERANCE_MS = 2_000;

function ms(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

export function classifyKind(createdAt: string, updatedAt: string): SubmissionKind {
  const delta = ms(updatedAt) - ms(createdAt);
  return delta > FIRST_WRITE_TOLERANCE_MS ? 'updated' : 'filled';
}

/** Read the channel off an audit row's details, refusing anything not in the
 *  closed set. An unrecognised value is dropped rather than passed through — a
 *  new write surface must add itself here deliberately. */
export function channelFromDetails(details: Record<string, unknown> | null): GiftSubmissionChannel | null {
  const raw = normKey(details?.channel);
  if (raw === 'external_link' || raw === 'employee_self' || raw === 'staff') return raw;
  return null;
}

/**
 * Index the roster by EVERY address each person is known by, so a grant, an
 * audit row or a submission keyed on an alternate address still resolves to the
 * same human. Same bridge `listTicketMembers` builds, and the same reason.
 *
 * First writer wins on a collision: personal_email is NOT injective on this
 * roster (two active pairs share one, per `gift-address-external-link.md`), so a
 * later row must not silently steal an address an earlier person already claims.
 */
export function indexRoster(roster: readonly RosterInput[]): Map<string, RosterInput> {
  const byEmail = new Map<string, RosterInput>();
  for (const person of roster) {
    for (const raw of [
      person.work_email,
      person.personal_email,
      person.alternate_work_email,
      person.alternate_work_email_2,
    ]) {
      const key = normKey(raw);
      if (key && !byEmail.has(key)) byEmail.set(key, person);
    }
  }
  return byEmail;
}

/**
 * Fold the audit events into a lookup of `personal email → milestone → channel`.
 *
 * Both families are resolved to the PERSONAL email, because that is what the
 * submission row is keyed on. `gift_address.saved` carries the work email, so it
 * goes through the roster bridge; an unresolvable one is dropped rather than
 * matched on the raw address, which would attach a channel to the wrong person
 * whenever two people share an address.
 *
 * Newest event wins, so a row edited through a second surface reports the
 * surface that last touched it — which is what "recently updated" means.
 */
export function buildChannelIndex(
  events: readonly ChannelEventInput[],
  byEmail: Map<string, RosterInput>,
): Map<string, Map<number, { channel: GiftSubmissionChannel; at: string }>> {
  const out = new Map<string, Map<number, { channel: GiftSubmissionChannel; at: string }>>();

  const put = (personalEmail: string | null, milestone: number, channel: GiftSubmissionChannel, at: string) => {
    if (!personalEmail || !Number.isInteger(milestone)) return;
    let perMilestone = out.get(personalEmail);
    if (!perMilestone) {
      perMilestone = new Map();
      out.set(personalEmail, perMilestone);
    }
    const cur = perMilestone.get(milestone);
    if (cur && ms(cur.at) >= ms(at)) return;
    perMilestone.set(milestone, { channel, at });
  };

  for (const ev of events) {
    const channel = channelFromDetails(ev.details);
    if (!channel) continue;
    const resourceId = normKey(ev.resource_id);
    if (!resourceId) continue;

    if (ev.action === 'gift_address.saved') {
      // resource_id is the WORK email — bridge it, or drop the event.
      const person = byEmail.get(resourceId);
      const personal = normKey(person?.personal_email);
      if (!personal) continue;
      const saved = ev.details?.milestones_saved;
      if (!Array.isArray(saved)) continue;
      for (const m of saved) put(personal, Number(m), channel, ev.created_at);
      continue;
    }

    if (ev.action === 'employee_gift_shipping.submitted') {
      // resource_id is already the PERSONAL email.
      const milestone = Number(ev.details?.milestone_index);
      put(resourceId, milestone, channel, ev.created_at);
    }
  }

  return out;
}

export interface BuildArgs {
  submissions: readonly SubmissionInput[];
  roster: readonly RosterInput[];
  events: readonly ChannelEventInput[];
  /** "Maria Dela Cruz (Spouse)" — injected so this module keeps exactly one
   *  spelling of the alternate recipient without importing the whole module. */
  describeRecipient: (row: { recipient_name: string; recipient_relationship: string }) => string;
}

/**
 * The feed. Newest change first.
 *
 * Sorted on `updated_at` because the tab's question is *who has touched this
 * lately*, not *who submitted first* — an employee correcting their address the
 * day before a parcel ships is exactly the event the team must not miss.
 * `id` breaks a tie so the order is stable across refetches rather than
 * shuffling two same-second rows on every poll.
 */
export function buildRecentSubmissions(args: BuildArgs): RecentSubmission[] {
  const byEmail = indexRoster(args.roster);
  const channels = buildChannelIndex(args.events, byEmail);

  const rows: RecentSubmission[] = [];
  for (const s of args.submissions) {
    const personalEmail = normKey(s.personal_email);
    if (!personalEmail) continue;
    const person = byEmail.get(personalEmail) ?? null;
    const recipientName = (s.recipient_name ?? '').trim();

    rows.push({
      id: s.id,
      personalEmail,
      workEmail: normKey(person?.work_email),
      name: person?.name?.trim() || null,
      department: person?.department?.trim() || null,
      milestoneIndex: s.milestone_index,
      milestoneDate: s.milestone_date,
      status: s.status,
      filledAt: s.created_at,
      updatedAt: s.updated_at,
      kind: classifyKind(s.created_at, s.updated_at),
      channel: channels.get(personalEmail)?.get(s.milestone_index)?.channel ?? null,
      offRoster: person === null,
      hasAlternateRecipient: recipientName !== '',
      alternateRecipient: args.describeRecipient({
        recipient_name: s.recipient_name ?? '',
        recipient_relationship: s.recipient_relationship ?? '',
      }),
      address: s.preferred_delivery_location ?? '',
      contact: s.active_contact_number ?? '',
      notes: s.notes ?? '',
    });
  }

  rows.sort((a, b) => {
    const d = ms(b.updatedAt) - ms(a.updatedAt);
    return d !== 0 ? d : a.id.localeCompare(b.id);
  });
  return rows;
}

/** Counts for the sub-tab's header. Each is its own question — they are NEVER
 *  summed, the same rule the fulfilment tiles follow: a submission is both
 *  "from the link" and "an update", so a total would double-count. */
export interface RecentSummary {
  total: number;
  filled: number;
  updated: number;
  externalLink: number;
  employeeSelf: number;
  staff: number;
  unknownChannel: number;
  offRoster: number;
}

export function summarize(rows: readonly RecentSubmission[]): RecentSummary {
  const s: RecentSummary = {
    total: rows.length,
    filled: 0,
    updated: 0,
    externalLink: 0,
    employeeSelf: 0,
    staff: 0,
    unknownChannel: 0,
    offRoster: 0,
  };
  for (const r of rows) {
    if (r.kind === 'filled') s.filled += 1;
    else s.updated += 1;
    if (r.channel === 'external_link') s.externalLink += 1;
    else if (r.channel === 'employee_self') s.employeeSelf += 1;
    else if (r.channel === 'staff') s.staff += 1;
    else s.unknownChannel += 1;
    if (r.offRoster) s.offRoster += 1;
  }
  return s;
}
