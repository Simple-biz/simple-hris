// HR → Gift Tracker → CSV + XLSX + PDF export of the tenure-gift roster.
//
// The grain is the MASTER LIST, not the submissions table: one row per person on
// the roster, with their shipping submission joined on when they have one. That
// is the whole point — this export is reconciled against the tenure-gift Google
// Sheet, and a person who never filled the form in is exactly the person the
// comparison needs to surface. Membership is never decided by whether a
// submission exists.
//
// Three formats, all built entirely in the browser (in-memory Blob download) —
// the rows are already loaded in the tab, so there's no server round-trip:
//
//   - CSV   → one flat table (UTF-8 BOM so Excel renders symbols), preamble.
//   - XLSX  → sheet 1 "Gift Roster" (one row per person) + sheet 2
//             "All submissions" (every submission incl. milestone history, so
//             the detail the roster grain flattens is not lost).
//   - PDF   → a branded document built from scratch with pdf-lib so it deploys
//             cleanly on Vercel (no template file read at runtime).
//
// Modeled on src/lib/hr/global-master-list-export.ts — same shape, same helpers.
// The theme is the Gift Tracker's emerald/teal rather than that module's CEO
// orange→rose, because this is an Orphanage-team surface.
//
// NOTE on XLSX theming: the pure-JS `xlsx` (SheetJS community) build does not
// emit cell fills / font colours — that's Pro-only. The spreadsheet's "theme" is
// structural (banner rows, sized columns, an auto-filtered header). The PDF
// carries the colour treatment.
//
// SECOND EXPORT, SECOND GRAIN (2026-09-22): the Submissions sub-tab has its own
// CSV — `buildGiftSubmissionsExport` / `giftSubmissionsToCsv`, one row per
// submission actually on file, scoped to that panel's filter + search. It shares
// `GiftSubmissionRecord` and `GIFT_SUBMISSION_COLUMNS` with XLSX sheet 2. The
// roster grain above is NOT a bug to be reconciled with it — see the section
// header down there for which question each file answers.
//
// NOTE on gifts: tenure gifts are INFORMATION ONLY. `gift_price_php`,
// `gift_name` and `gift_catalog_item_id` still exist on the table as vestigial
// history columns — they are deliberately absent from every output here, and
// shipping-export.test.ts pins that.

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib';
import * as XLSX from 'xlsx';
import {
  buildMilestones,
  diffDays,
  getCurrentShippingMilestone,
  milestoneLabel as sharedMilestoneLabel,
  parseStartDate,
} from '@/lib/gift-milestones';
import { buildPersonReceiptSummary } from './receipts';
import {
  describeAlternateRecipient,
  hasAlternateRecipient,
} from './alternate-recipient';

// ---------------------------------------------------------------------------
// Input + structured model
// ---------------------------------------------------------------------------

/**
 * The subset of an `EmployeeRow` this export reads. Kept loose (plain
 * `string | null`) so the roster's `EmployeeRow` is structurally assignable
 * without a hard import.
 *
 * `location` and `phone_number` come from the EXTENDED select tier and are
 * `undefined` when the `active_employees` view is stale — never the sole source
 * of an address (see {@link homeAddressOf}).
 */
export interface GiftRosterEmployeeInput {
  name: string | null;
  department: string | null;
  work_email?: string | null;
  personal_email: string | null;
  start_date: string | null;
  street?: string | null;
  city?: string | null;
  province?: string | null;
  postal_code?: string | null;
  full_address?: string | null;
  location?: string | null;
  phone_number?: string | null;
}

/** The subset of an `EmployeeGiftShippingRow` this export reads. */
export interface GiftRosterSubmissionInput {
  personal_email: string;
  milestone_index: number;
  milestone_date: string;
  preferred_delivery_location: string;
  active_contact_number: string;
  apparel_size: string;
  recipient_name: string;
  recipient_relationship: string;
  recipient_contact: string;
  notes: string;
  status: 'pending' | 'approved' | 'rejected';
  decided_by: string | null;
  decided_at: string | null;
  updated_at: string;
  /**
   * OPTIONAL on purpose. Both are real columns on
   * `employee_gift_shipping_details`, but this interface is the loose structural
   * subset the roster's rows are assigned to — making either required would
   * reject a caller that reads fewer columns, and the outputs already print `-`
   * for an absent value. Never infer one from `updated_at`.
   */
  created_at?: string;
  decision_note?: string | null;
}

/** Where the exported address came from — printed, so the two are never confused. */
export type AddressSource = 'Submitted' | 'Master list' | 'None on file';

/** One person, normalized to clean display strings. */
export interface GiftRosterRecord {
  name: string;
  workEmail: string;
  personalEmail: string;
  department: string;
  startDate: string; // formatted, or ''
  tenure: string;
  /** How many 6-month marks this person has passed. 0 when none / no start date. */
  milestonesReached: number;
  /** e.g. "12-month", or 'None yet' when no milestone window has opened. */
  currentMilestone: string;
  milestoneDate: string;
  /** "In 12 days" / "Overdue by 3 days" / "Today" / ''. */
  dueIn: string;
  submitted: 'Yes' | 'No';
  /** 'Pending' | 'Approved' | 'Rejected' | 'Not submitted'. */
  status: string;
  shippingAddress: string;
  addressSource: AddressSource;
  /**
   * THE EMPLOYEE'S OWN NUMBER — the one the courier calls. It does NOT change
   * when somebody else is receiving the parcel. Kane's ruling, 2026-09-18:
   * "The Employees as they will contact their spouse." A test pins this, because
   * the obvious "helpful" edit is to prefer the recipient's number here, and that
   * silently points the ship list at the wrong person.
   */
  contactNumber: string;
  apparelSize: string;
  /** Somebody receiving this gift for the employee. '' when they receive it themself. */
  alternateRecipient: string;
  /** How that person relates to the employee. '' when there is no alternate. */
  recipientRelationship: string;
  /** The alternate recipient's own number. A FALLBACK — never printed as `contactNumber`. */
  recipientContact: string;
  employeeNotes: string;
  decidedBy: string;
  decidedAt: string;
  /** True for a submitter who matched no active roster row — appended + flagged. */
  offRoster: boolean;
  /**
   * Fulfilment, from employee_gift_receipts. Counted SEPARATELY and never
   * summed: `giftsOwed` is a debt somebody recorded, `giftsNotRecorded` is a
   * due milestone nobody has assessed. Folding the second into the first would
   * invent a backlog; folding it into `giftsReceived` would hide one.
   */
  giftsReceived: number;
  giftsOwed: number;
  giftsNotRecorded: number;
  /** The oldest gift still owed ("12-month"), or '' when none. */
  oldestOwed: string;
}

/** One submission, for the XLSX history sheet. */
export interface GiftSubmissionRecord {
  name: string;
  workEmail: string;
  personalEmail: string;
  department: string;
  milestone: string;
  milestoneDate: string;
  shippingAddress: string;
  contactNumber: string;
  apparelSize: string;
  alternateRecipient: string;
  recipientRelationship: string;
  recipientContact: string;
  status: string;
  employeeNotes: string;
  decidedBy: string;
  decidedAt: string;
  /** The reviewer's own words on an approve/reject — `decision_note`. */
  reviewerNote: string;
  /** When the row was first written (`created_at`). */
  firstSubmittedAt: string;
  /**
   * `updated_at` — the LAST edit, not the first. The panel labels this
   * "last edited"; the column header stays `Last Submitted` because renaming a
   * shipped column silently breaks every sheet somebody built on it.
   */
  submittedAt: string;
}

export interface GiftRosterExportModel {
  generatedAt: Date;
  rows: GiftRosterRecord[];
  /** Every submission on file for the exported people, incl. milestone history. */
  submissions: GiftSubmissionRecord[];
  /** Roster size before the in-view search filter — shown in the summary band. */
  totalRoster: number;
  /** Counts driving the at-a-glance band. */
  summary: {
    people: number;
    submitted: number;
    notSubmitted: number;
    /** People with a milestone window open who have NOT submitted — the gap. */
    dueNoSubmission: number;
    offRoster: number;
    noAddress: number;
    /** Gifts recorded as missed. A person owed three counts three here. */
    giftsOwed: number;
    /** People owed at least one. Never the same number as `giftsOwed`. */
    peopleOwed: number;
    /** People with a due milestone nobody has assessed — NOT part of `peopleOwed`. */
    peopleNotRecorded: number;
    /** Parcels going to somebody other than the employee — spouses, mostly. */
    altRecipient: number;
  };
  /** Describes the filter the rows came from, e.g. 'All employees'. */
  scopeLabel: string;
}

/**
 * One row of the fulfilment ledger. Keyed on WORK email — the submissions table
 * is keyed on personal_email, which is not injective on this roster, so the two
 * deliberately do not share a key.
 */
export interface GiftRosterReceiptInput {
  work_email: string;
  milestone_index: number;
  received: boolean;
}

export interface BuildGiftRosterInput {
  employees: readonly GiftRosterEmployeeInput[];
  submissions: readonly GiftRosterSubmissionInput[];
  /** Fulfilment assertions. Omitted entirely = every milestone reads Not recorded. */
  receipts?: readonly GiftRosterReceiptInput[];
  totalRoster: number;
  scopeLabel?: string;
  /** Injectable clock — the tests pin milestone math to a fixed date. */
  today?: Date;
}

const DASH = '-';
const NONE_YET = 'None yet';

function clean(v: unknown): string {
  return v == null ? '' : String(v).trim();
}

function join(parts: unknown[], sep = ', '): string {
  return parts.map(clean).filter(Boolean).join(sep);
}

/** "Jul 4, 2026" for an ISO date; '' when absent, the raw string when unparseable. */
function formatDate(iso: string | null | undefined): string {
  const s = clean(iso);
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  try {
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return s;
  }
}

/** "Jul 4, 2026, 3:45 PM" for a timestamptz; '' when absent. */
function formatDateTime(iso: string | null | undefined): string {
  const s = clean(iso);
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  try {
    return d.toLocaleString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  } catch {
    return s;
  }
}

/** Compact tenure from a start date — mirrors the roster's on-screen tenure. */
function tenureOf(iso: string | null | undefined, now: Date): string {
  const start = parseStartDate(iso);
  if (!start) return DASH;
  let years = now.getFullYear() - start.getFullYear();
  let months = now.getMonth() - start.getMonth();
  if (now.getDate() < start.getDate()) months -= 1;
  if (months < 0) {
    years -= 1;
    months += 12;
  }
  if (years > 0 && months > 0) return `${years}y ${months}m`;
  if (years > 0) return `${years}y`;
  if (months > 0) return `${months}mo`;
  const days = Math.floor((now.getTime() - start.getTime()) / 86_400_000);
  return days <= 0 ? 'New' : `${days}d`;
}

/**
 * The master-list home address, composed from BASE-tier columns only
 * (street/city/province/postal_code/full_address). `location` is EXTENDED-tier
 * and comes back undefined on a stale `active_employees` view, so it is a
 * last-resort enrichment, never the sole source.
 */
function homeAddressOf(e: GiftRosterEmployeeInput): string {
  const composed = join([e.street, e.city, e.province, e.postal_code]);
  return composed || clean(e.full_address) || clean(e.location);
}

/** milestone_index N → the (N x 6)-month gift, e.g. 2 → "12-month". */
export function milestoneLabel(index: number | null | undefined): string {
  if (index == null || !Number.isFinite(index) || index <= 0) return NONE_YET;
  // The "-month" spelling itself lives in gift-milestones.ts so the export, the
  // roster and the receipts ledger cannot name the same milestone differently.
  return sharedMilestoneLabel(index);
}

/** "In 12 days" / "Overdue by 3 days" / "Today" / "Tomorrow". */
function dueInLabel(days: number | null): string {
  if (days === null) return '';
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days < 0) return `Overdue by ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'}`;
  return `In ${days} days`;
}

function statusLabel(status: string | null): string {
  switch (status) {
    case 'pending': return 'Pending';
    case 'approved': return 'Approved';
    case 'rejected': return 'Rejected';
    default: return 'Not submitted';
  }
}

/** The roster's identity key — mirrors GiftTracker's own `personal_email ?? work_email`. */
function emailKeyOf(e: GiftRosterEmployeeInput): string {
  return (e.personal_email ?? e.work_email ?? '').toLowerCase().trim();
}

/**
 * Shape the roster + submissions into the export model.
 *
 * Load-bearing: **every** employee produces a row — no start date, no milestone
 * reached, and no submission are all still rows. Submitters who match no roster
 * row are APPENDED at the end flagged `offRoster`, because roster grain would
 * otherwise drop them silently and they are the likeliest to be mis-shipped.
 */
export function buildGiftRosterExport(input: BuildGiftRosterInput): GiftRosterExportModel {
  const today = input.today ?? new Date();

  // Group submissions by their lower-cased personal_email key.
  const subsByEmail = new Map<string, GiftRosterSubmissionInput[]>();
  for (const s of input.submissions) {
    const key = clean(s.personal_email).toLowerCase();
    if (!key) continue;
    const arr = subsByEmail.get(key) ?? [];
    arr.push(s);
    subsByEmail.set(key, arr);
  }
  for (const arr of subsByEmail.values()) {
    arr.sort((a, b) => a.milestone_index - b.milestone_index);
  }

  // Fulfilment, grouped by lower-cased WORK email then milestone index.
  const receiptsByWorkEmail = new Map<string, Map<number, boolean>>();
  for (const r of input.receipts ?? []) {
    const key = clean(r.work_email).toLowerCase();
    if (!key) continue;
    const inner = receiptsByWorkEmail.get(key) ?? new Map<number, boolean>();
    inner.set(r.milestone_index, r.received);
    receiptsByWorkEmail.set(key, inner);
  }
  const NO_RECEIPTS: ReadonlyMap<number, boolean> = new Map();

  const rows: GiftRosterRecord[] = [];
  const submissions: GiftSubmissionRecord[] = [];
  const matchedKeys = new Set<string>();
  // Dedupe on WORK email, not the submission key.
  //
  // `emailKeyOf` is personal-email-first because that is how submissions are
  // stored, but personal_email is not injective on this roster — two colleagues
  // share one — so deduping on it silently dropped a real person from the file
  // (and from the tracker). Identity is the work email; only a genuinely
  // duplicated master row collapses.
  const seen = new Set<string>();

  for (const e of input.employees) {
    const key = emailKeyOf(e);
    const identity = clean(e.work_email).toLowerCase() || key;
    if (!identity || seen.has(identity)) continue;
    seen.add(identity);
    if (!key) continue;
    matchedKeys.add(key);

    const start = parseStartDate(e.start_date);
    const reached = start ? buildMilestones(start, today).history.length : 0;
    const current = getCurrentShippingMilestone(start, today);
    const subs = subsByEmail.get(key) ?? [];
    // The submission for the milestone they're on now; else the newest on file,
    // so a person between windows still shows the address we last had for them.
    const sub =
      (current ? subs.find((s) => s.milestone_index === current.index) : undefined) ??
      subs[subs.length - 1];

    const name = clean(e.name) || key;
    const workEmail = clean(e.work_email);
    const department = clean(e.department) || DASH;

    // Fulfilment runs through the SAME helper the on-screen tracker uses, so
    // the file and the screen cannot disagree about who is owed a gift.
    const receiptSummary = buildPersonReceiptSummary({
      start,
      today,
      receiptsByIndex:
        receiptsByWorkEmail.get((workEmail || key).toLowerCase()) ?? NO_RECEIPTS,
    });

    const submittedAddress = clean(sub?.preferred_delivery_location);
    const home = homeAddressOf(e);
    const shippingAddress = submittedAddress || home;
    const addressSource: AddressSource = submittedAddress
      ? 'Submitted'
      : home
        ? 'Master list'
        : 'None on file';

    rows.push({
      name,
      workEmail: workEmail || DASH,
      personalEmail: clean(e.personal_email) || DASH,
      department,
      startDate: formatDate(e.start_date),
      tenure: tenureOf(e.start_date, today),
      milestonesReached: reached,
      currentMilestone: current ? milestoneLabel(current.index) : NONE_YET,
      milestoneDate: current ? formatDate(current.date.toISOString()) : '',
      dueIn: current ? dueInLabel(diffDays(current.date, today)) : '',
      giftsReceived: receiptSummary.receivedCount,
      giftsOwed: receiptSummary.owedCount,
      giftsNotRecorded: receiptSummary.unknownCount,
      oldestOwed: receiptSummary.oldestOwed?.label ?? '',
      submitted: sub ? 'Yes' : 'No',
      status: statusLabel(sub?.status ?? null),
      shippingAddress: shippingAddress || DASH,
      addressSource,
      // The EMPLOYEE'S number, unchanged by any alternate recipient. Falling back
      // to the recipient's number here would be the single most damaging edit
      // available to this file — see the field's doc comment.
      contactNumber: clean(sub?.active_contact_number) || clean(e.phone_number) || DASH,
      apparelSize: clean(sub?.apparel_size) || DASH,
      alternateRecipient: hasAlternateRecipient(sub) ? clean(sub?.recipient_name) : '',
      recipientRelationship: hasAlternateRecipient(sub)
        ? clean(sub?.recipient_relationship)
        : '',
      recipientContact: hasAlternateRecipient(sub) ? clean(sub?.recipient_contact) : '',
      employeeNotes: clean(sub?.notes),
      decidedBy: clean(sub?.decided_by),
      decidedAt: formatDateTime(sub?.decided_at),
      offRoster: false,
    });

    for (const s of subs) {
      submissions.push(submissionRecord(s, name, workEmail || DASH, department));
    }
  }

  // Off-roster submitters — appended, flagged, never dropped.
  const offRosterKeys = [...subsByEmail.keys()].filter((k) => !matchedKeys.has(k)).sort();
  for (const key of offRosterKeys) {
    const subs = subsByEmail.get(key) ?? [];
    const sub = subs[subs.length - 1];
    if (!sub) continue;
    const address = clean(sub.preferred_delivery_location);
    rows.push({
      name: key,
      workEmail: DASH,
      personalEmail: key,
      department: 'Off-roster',
      startDate: '',
      tenure: DASH,
      milestonesReached: 0,
      currentMilestone: milestoneLabel(sub.milestone_index),
      milestoneDate: formatDate(sub.milestone_date),
      dueIn: '',
      // An off-roster submitter has no master row, so no start date, so no
      // milestone can be dated and nothing about fulfilment is knowable. Zeroes
      // here mean "we cannot say", and the row is already flagged Off-roster —
      // that flag, not these counts, is the finding.
      giftsReceived: 0,
      giftsOwed: 0,
      giftsNotRecorded: 0,
      oldestOwed: '',
      submitted: 'Yes',
      status: statusLabel(sub.status),
      shippingAddress: address || DASH,
      addressSource: address ? 'Submitted' : 'None on file',
      contactNumber: clean(sub.active_contact_number) || DASH,
      apparelSize: clean(sub.apparel_size) || DASH,
      // An off-roster submitter's alternate recipient carries too. They are the
      // likeliest person to be mis-shipped, so dropping the one field that says
      // who is actually at the door would be exactly backwards.
      alternateRecipient: hasAlternateRecipient(sub) ? clean(sub.recipient_name) : '',
      recipientRelationship: hasAlternateRecipient(sub)
        ? clean(sub.recipient_relationship)
        : '',
      recipientContact: hasAlternateRecipient(sub) ? clean(sub.recipient_contact) : '',
      employeeNotes: clean(sub.notes),
      decidedBy: clean(sub.decided_by),
      decidedAt: formatDateTime(sub.decided_at),
      offRoster: true,
    });
    for (const s of subs) submissions.push(submissionRecord(s, key, DASH, 'Off-roster'));
  }

  const summary = {
    people: rows.length,
    submitted: rows.filter((r) => r.submitted === 'Yes').length,
    notSubmitted: rows.filter((r) => r.submitted === 'No').length,
    dueNoSubmission: rows.filter(
      (r) => r.currentMilestone !== NONE_YET && r.submitted === 'No',
    ).length,
    offRoster: rows.filter((r) => r.offRoster).length,
    noAddress: rows.filter((r) => r.addressSource === 'None on file').length,
    giftsOwed: rows.reduce((n, r) => n + r.giftsOwed, 0),
    peopleOwed: rows.filter((r) => r.giftsOwed > 0).length,
    peopleNotRecorded: rows.filter((r) => r.giftsNotRecorded > 0).length,
    altRecipient: rows.filter((r) => r.alternateRecipient !== '').length,
  };

  return {
    generatedAt: new Date(),
    rows,
    submissions,
    totalRoster: input.totalRoster,
    summary,
    scopeLabel: input.scopeLabel?.trim() || 'All employees',
  };
}

function submissionRecord(
  s: GiftRosterSubmissionInput,
  name: string,
  workEmail: string,
  department: string,
): GiftSubmissionRecord {
  return {
    name,
    workEmail,
    personalEmail: clean(s.personal_email),
    department,
    milestone: milestoneLabel(s.milestone_index),
    milestoneDate: formatDate(s.milestone_date),
    shippingAddress: clean(s.preferred_delivery_location) || DASH,
    contactNumber: clean(s.active_contact_number) || DASH,
    apparelSize: clean(s.apparel_size) || DASH,
    alternateRecipient: hasAlternateRecipient(s) ? clean(s.recipient_name) : '',
    recipientRelationship: hasAlternateRecipient(s) ? clean(s.recipient_relationship) : '',
    recipientContact: hasAlternateRecipient(s) ? clean(s.recipient_contact) : '',
    status: statusLabel(s.status),
    employeeNotes: clean(s.notes),
    decidedBy: clean(s.decided_by),
    decidedAt: formatDateTime(s.decided_at),
    reviewerNote: clean(s.decision_note),
    firstSubmittedAt: formatDateTime(s.created_at),
    submittedAt: formatDateTime(s.updated_at),
  };
}

// ---------------------------------------------------------------------------
// Shared: columns + timestamp
// ---------------------------------------------------------------------------

/**
 * Column order shared by the CSV and XLSX sheet 1. No price, no gift name —
 * tenure gifts carry neither (see the module header).
 */
export const GIFT_ROSTER_COLUMNS: {
  header: string;
  get: (r: GiftRosterRecord) => string | number;
}[] = [
  { header: 'Name', get: (r) => r.name },
  { header: 'Work Email', get: (r) => r.workEmail },
  { header: 'Personal Email', get: (r) => r.personalEmail },
  { header: 'Department', get: (r) => r.department },
  { header: 'Start Date', get: (r) => r.startDate || DASH },
  { header: 'Tenure', get: (r) => r.tenure },
  { header: 'Milestones Reached', get: (r) => r.milestonesReached },
  { header: 'Current Milestone', get: (r) => r.currentMilestone },
  { header: 'Milestone Date', get: (r) => r.milestoneDate || DASH },
  { header: 'Due In', get: (r) => r.dueIn || DASH },
  // Fulfilment. Three columns, never one: "owed" and "not recorded" are
  // different findings and a reconciliation that merges them is useless.
  { header: 'Gifts Received', get: (r) => r.giftsReceived },
  { header: 'Gifts Owed', get: (r) => r.giftsOwed },
  { header: 'Oldest Owed', get: (r) => r.oldestOwed || DASH },
  { header: 'Not Recorded', get: (r) => r.giftsNotRecorded },
  { header: 'Submitted?', get: (r) => r.submitted },
  { header: 'Status', get: (r) => r.status },
  { header: 'Shipping Address', get: (r) => r.shippingAddress },
  { header: 'Address Source', get: (r) => r.addressSource },
  // `Contact Number` is and stays the EMPLOYEE'S. The three recipient columns sit
  // BESIDE it rather than replacing it, so the file never has to be read twice to
  // work out whose number it printed.
  { header: 'Contact Number', get: (r) => r.contactNumber },
  { header: 'Apparel Size', get: (r) => r.apparelSize },
  { header: 'Alternate Recipient', get: (r) => r.alternateRecipient || DASH },
  { header: 'Recipient Relationship', get: (r) => r.recipientRelationship || DASH },
  { header: 'Recipient Contact', get: (r) => r.recipientContact || DASH },
  { header: 'Employee Notes', get: (r) => r.employeeNotes || DASH },
  { header: 'Decided By', get: (r) => r.decidedBy || DASH },
  { header: 'Decided At', get: (r) => r.decidedAt || DASH },
];

/**
 * Column order at SUBMISSION grain — shared by the XLSX "All submissions"
 * history sheet and the Submissions sub-tab's CSV. One list, so the two files
 * can never drift into describing the same row differently.
 *
 * `Department` doubles as the off-roster flag (`Off-roster`), exactly as it does
 * in the roster export. Do not add a second boolean column saying the same thing.
 */
export const GIFT_SUBMISSION_COLUMNS: {
  header: string;
  get: (r: GiftSubmissionRecord) => string;
}[] = [
  { header: 'Name', get: (r) => r.name },
  { header: 'Work Email', get: (r) => r.workEmail },
  { header: 'Personal Email', get: (r) => r.personalEmail },
  { header: 'Department', get: (r) => r.department },
  { header: 'Milestone', get: (r) => r.milestone },
  { header: 'Milestone Date', get: (r) => r.milestoneDate || DASH },
  { header: 'Shipping Address', get: (r) => r.shippingAddress },
  { header: 'Contact Number', get: (r) => r.contactNumber },
  { header: 'Apparel Size', get: (r) => r.apparelSize },
  { header: 'Alternate Recipient', get: (r) => r.alternateRecipient || DASH },
  { header: 'Recipient Relationship', get: (r) => r.recipientRelationship || DASH },
  { header: 'Recipient Contact', get: (r) => r.recipientContact || DASH },
  { header: 'Status', get: (r) => r.status },
  { header: 'Employee Notes', get: (r) => r.employeeNotes || DASH },
  { header: 'Decided By', get: (r) => r.decidedBy || DASH },
  { header: 'Decided At', get: (r) => r.decidedAt || DASH },
  { header: 'Reviewer Note', get: (r) => r.reviewerNote || DASH },
  // Two timestamps, never one. `Submitted At` is when they first sent it;
  // `Last Submitted` is the most recent edit. Collapsing them hides a row that
  // was quietly rewritten after somebody read it.
  { header: 'Submitted At', get: (r) => r.firstSubmittedAt || DASH },
  { header: 'Last Submitted', get: (r) => r.submittedAt || DASH },
];

/** Full export timestamp, e.g. "August 19, 2026, 3:45 PM GMT+8" (viewer's local time). */
function formatTimestamp(d: Date): string {
  try {
    return d.toLocaleString('en-US', {
      year: 'numeric', month: 'long', day: 'numeric',
      hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    });
  } catch {
    return d.toLocaleString();
  }
}

function countLabel(n: number): string {
  return `${n.toLocaleString()} ${n === 1 ? 'person' : 'people'}`;
}

/** The one-line provenance summary shared by all three formats. */
function summaryLine(model: GiftRosterExportModel): string {
  const s = model.summary;
  return (
    `${countLabel(s.people)} of ${model.totalRoster.toLocaleString()} in roster` +
    ` · ${s.submitted.toLocaleString()} submitted · ${s.notSubmitted.toLocaleString()} not submitted` +
    ` · ${s.dueNoSubmission.toLocaleString()} due with no submission` +
    ` · ${s.giftsOwed.toLocaleString()} gift(s) owed to ${s.peopleOwed.toLocaleString()} person/people` +
    ` · ${s.peopleNotRecorded.toLocaleString()} with nothing recorded` +
    ` · ${s.offRoster.toLocaleString()} off-roster · ${s.noAddress.toLocaleString()} with no address` +
    ` · ${s.altRecipient.toLocaleString()} received by someone else`
  );
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/** RFC 4180 escaping: wrap in quotes when the value has a comma/quote/newline. */
function csvEscape(v: unknown): string {
  if (v == null) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** Serialize the model to a single flat CSV table (with a UTF-8 BOM). */
export function giftRosterToCsv(model: GiftRosterExportModel): string {
  const year = model.generatedAt.getFullYear();
  const preamble = [
    ['Tenure Gift Roster'],
    [`Scope: ${model.scopeLabel}`],
    ['Pulled from Simple-HRIS System'],
    [`Exported: ${formatTimestamp(model.generatedAt)}`],
    [summaryLine(model)],
    [`Developed by AI/API Team / Simple.biz (c) ${year}`],
    [''],
  ].map((row) => row.map(csvEscape).join(','));

  const header = ['#', ...GIFT_ROSTER_COLUMNS.map((c) => c.header)].map(csvEscape).join(',');
  const body = model.rows.map((r, i) =>
    [i + 1, ...GIFT_ROSTER_COLUMNS.map((c) => c.get(r))].map(csvEscape).join(','),
  );
  return '﻿' + [...preamble, header, ...body].join('\r\n');
}

// ---------------------------------------------------------------------------
// Submissions grain — HR → Gift Tracker → Submissions → Export CSV
// ---------------------------------------------------------------------------
//
// ONE ROW PER SUBMISSION, and deliberately so.
//
// The roster export above is the opposite grain, and the reason is load-bearing:
// a person who never filled the form in is the finding, so membership there is
// never decided by whether a submission exists. That rule governs the ROSTER
// file and is not weakened here.
//
// The Submissions sub-tab is a work queue — every row is something somebody
// typed that somebody else must approve, reject or ship — and this file answers
// the shipping desk's question instead: what did these people actually send us.
// Both files are correct. The failure mode is a future reader finding one and
// "fixing" the other to match, which is why they share `GiftSubmissionRecord`
// and `GIFT_SUBMISSION_COLUMNS` and cannot describe the same row differently.

/** One in-view submission, with its roster match already resolved by the caller. */
export interface GiftSubmissionsRowInput {
  submission: GiftRosterSubmissionInput;
  /**
   * TRUE when this submission matched no roster row. Passed in, never inferred
   * from a blank name: an off-roster submitter — offboarded, or they changed the
   * personal email the form is keyed on — is the likeliest person to be
   * mis-shipped, and a heuristic that guessed wrong would hide exactly them.
   */
  offRoster: boolean;
  name?: string | null;
  workEmail?: string | null;
  department?: string | null;
}

export interface BuildGiftSubmissionsInput {
  /**
   * The rows in view, in the order the panel shows them. NEVER re-sorted here —
   * the file has to match the screen it was taken from, and the panel's own
   * pending-first ordering is the review order the team works in.
   */
  rows: readonly GiftSubmissionsRowInput[];
  /** Submissions on file BEFORE the filter. The file prints `N of TOTAL`. */
  totalSubmissions: number;
  /** What the filter pills + search were set to, e.g. `Pending · search "cebu"`. */
  scopeLabel?: string;
}

export interface GiftSubmissionsExportModel {
  generatedAt: Date;
  rows: GiftSubmissionRecord[];
  totalSubmissions: number;
  summary: {
    submissions: number;
    /** Distinct PEOPLE behind those submissions — identity is the work email. */
    people: number;
    pending: number;
    approved: number;
    rejected: number;
    offRoster: number;
    noAddress: number;
    altRecipient: number;
  };
  scopeLabel: string;
}

/**
 * Build the submission-grain model. Pure; the caller owns filtering and order.
 *
 * Every count is taken from the RAW submission, not from the formatted record —
 * a display label is a presentation decision and must never become the thing a
 * total is computed from.
 */
export function buildGiftSubmissionsExport(
  input: BuildGiftSubmissionsInput,
): GiftSubmissionsExportModel {
  const rows: GiftSubmissionRecord[] = [];
  // Identity is the WORK email, exactly as in the roster export above: two
  // colleagues share one `personal_email` on this roster, so counting distinct
  // submission keys would silently merge them into a single "person".
  const people = new Set<string>();
  const counts = { pending: 0, approved: 0, rejected: 0 };
  let offRoster = 0;
  let noAddress = 0;
  let altRecipient = 0;

  for (const r of input.rows) {
    const s = r.submission;
    const key = clean(s.personal_email).toLowerCase();
    const workEmail = clean(r.workEmail);

    rows.push(
      submissionRecord(
        s,
        clean(r.name) || key,
        // An off-roster submitter HAS no work email — the roster is where one
        // lives. `-`, never their personal address dressed up as a company one.
        r.offRoster ? DASH : workEmail || DASH,
        r.offRoster ? 'Off-roster' : clean(r.department) || DASH,
      ),
    );

    const identity = (r.offRoster ? '' : workEmail.toLowerCase()) || key;
    if (identity) people.add(identity);
    if (r.offRoster) offRoster += 1;
    if (!clean(s.preferred_delivery_location)) noAddress += 1;
    if (hasAlternateRecipient(s)) altRecipient += 1;
    if (s.status === 'pending' || s.status === 'approved' || s.status === 'rejected') {
      counts[s.status] += 1;
    }
  }

  return {
    generatedAt: new Date(),
    rows,
    totalSubmissions: input.totalSubmissions,
    summary: {
      submissions: rows.length,
      people: people.size,
      pending: counts.pending,
      approved: counts.approved,
      rejected: counts.rejected,
      offRoster,
      noAddress,
      altRecipient,
    },
    scopeLabel: input.scopeLabel?.trim() || 'All submissions',
  };
}

/**
 * The provenance line. `N of TOTAL` is not decoration: the panel's filter
 * defaults to Pending, so a file that only said "23 submissions" would read as
 * the whole queue while holding a fraction of it.
 */
function submissionsSummaryLine(model: GiftSubmissionsExportModel): string {
  const s = model.summary;
  const n = (v: number) => v.toLocaleString();
  return (
    `${n(s.submissions)} of ${n(model.totalSubmissions)} submissions on file` +
    ` · ${n(s.people)} ${s.people === 1 ? 'person' : 'people'}` +
    ` · ${n(s.pending)} pending · ${n(s.approved)} approved · ${n(s.rejected)} rejected` +
    ` · ${n(s.offRoster)} off-roster · ${n(s.noAddress)} with no address` +
    ` · ${n(s.altRecipient)} received by someone else`
  );
}

/** Serialize the submissions model to one flat CSV table (with a UTF-8 BOM). */
export function giftSubmissionsToCsv(model: GiftSubmissionsExportModel): string {
  const year = model.generatedAt.getFullYear();
  const preamble = [
    ['Tenure Gift Submissions'],
    [`Scope: ${model.scopeLabel}`],
    ['Pulled from Simple-HRIS System'],
    [`Exported: ${formatTimestamp(model.generatedAt)}`],
    [submissionsSummaryLine(model)],
    [`Developed by AI/API Team / Simple.biz (c) ${year}`],
    [''],
  ].map((row) => row.map(csvEscape).join(','));

  const header = ['#', ...GIFT_SUBMISSION_COLUMNS.map((c) => c.header)]
    .map(csvEscape)
    .join(',');
  const body = model.rows.map((r, i) =>
    [i + 1, ...GIFT_SUBMISSION_COLUMNS.map((c) => c.get(r))].map(csvEscape).join(','),
  );
  return '﻿' + [...preamble, header, ...body].join('\r\n');
}

/** Build + download the submissions CSV. */
export function downloadGiftSubmissionsCsv(model: GiftSubmissionsExportModel): void {
  downloadBlob(
    `tenure-gift-submissions-${dateSuffix(model.generatedAt)}.csv`,
    new Blob([giftSubmissionsToCsv(model)], { type: 'text/csv;charset=utf-8' }),
  );
}

// ---------------------------------------------------------------------------
// XLSX
// ---------------------------------------------------------------------------

const ROSTER_COLUMN_WIDTHS = [26, 32, 32, 20, 14, 10, 9, 16, 15, 16, 11, 14, 46, 14, 18, 12, 34, 26, 20];
// One width per entry in GIFT_SUBMISSION_COLUMNS, in the same order. It held 14
// entries for 17 columns before 2026-09-22, so every width from `Alternate
// Recipient` rightwards was being applied to the wrong column and the last three
// got none at all. Keep the two lists the same length.
const SUBMISSION_COLUMN_WIDTHS = [
  26, 32, 32, 20, 14, 15, 46, 18, 12, 22, 22, 18, 12, 34, 26, 20, 34, 20, 20,
];

/** Build the workbook: sheet 1 = one row per person, sheet 2 = every submission. */
export function buildGiftRosterWorkbook(model: GiftRosterExportModel): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();

  const aoa: (string | number)[][] = [
    ['Tenure Gift Roster'],
    [`Scope: ${model.scopeLabel}`],
    [`Exported ${formatTimestamp(model.generatedAt)} · ${summaryLine(model)}`],
    [],
    ['#', ...GIFT_ROSTER_COLUMNS.map((c) => c.header)],
  ];
  model.rows.forEach((r, i) => {
    aoa.push([i + 1, ...GIFT_ROSTER_COLUMNS.map((c) => c.get(r))]);
  });

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 5 }, ...ROSTER_COLUMN_WIDTHS.map((wch) => ({ wch }))];
  const headerRow = 5; // 1-indexed row holding the column headers
  const lastCol = GIFT_ROSTER_COLUMNS.length; // 0 = `#`, then one per column
  ws['!autofilter'] = {
    ref: `A${headerRow}:${XLSX.utils.encode_col(lastCol)}${headerRow + model.rows.length}`,
  };
  ws['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: lastCol } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: lastCol } },
    { s: { r: 2, c: 0 }, e: { r: 2, c: lastCol } },
  ];
  XLSX.utils.book_append_sheet(wb, ws, 'Gift Roster');

  // Sheet 2 — every submission, so milestone history survives the roster grain.
  const subAoa: (string | number)[][] = [
    ['All submissions — every milestone on file'],
    [`Exported ${formatTimestamp(model.generatedAt)} · ${model.submissions.length.toLocaleString()} submission${model.submissions.length === 1 ? '' : 's'}`],
    [],
    ['#', ...GIFT_SUBMISSION_COLUMNS.map((c) => c.header)],
  ];
  model.submissions.forEach((r, i) => {
    subAoa.push([i + 1, ...GIFT_SUBMISSION_COLUMNS.map((c) => c.get(r))]);
  });
  const ws2 = XLSX.utils.aoa_to_sheet(subAoa);
  ws2['!cols'] = [{ wch: 5 }, ...SUBMISSION_COLUMN_WIDTHS.map((wch) => ({ wch }))];
  const subHeaderRow = 4;
  const subLastCol = GIFT_SUBMISSION_COLUMNS.length;
  ws2['!autofilter'] = {
    ref: `A${subHeaderRow}:${XLSX.utils.encode_col(subLastCol)}${subHeaderRow + model.submissions.length}`,
  };
  ws2['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: subLastCol } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: subLastCol } },
  ];
  XLSX.utils.book_append_sheet(wb, ws2, 'All submissions');

  return wb;
}

// ---------------------------------------------------------------------------
// PDF — Gift Tracker themed (emerald → teal)
// ---------------------------------------------------------------------------

const PAGE_W = 792; // US Letter, LANDSCAPE — the address column needs the width
const PAGE_H = 612;
const MARGIN = 36;
const CONTENT_W = PAGE_W - MARGIN * 2; // 720
const BOTTOM = 52;

// Palette lifted from the Gift Tracker's own emerald/teal card chrome.
export type RGB = readonly [number, number, number];
export const C_EMERALD: RGB = [0.024, 0.588, 0.412]; // #059669  emerald-600
export const C_EMERALD_500: RGB = [0.063, 0.725, 0.506]; // #10B981  emerald-500
export const C_TEAL: RGB = [0.055, 0.58, 0.533]; // #0E9488  teal-600
const C_AMBER: RGB = [0.961, 0.62, 0.043]; // #F59E0B  amber-500
const tup = (c: RGB) => rgb(c[0], c[1], c[2]);

const EMERALD = tup(C_EMERALD);
const AMBER = tup(C_AMBER);
const WHITE = rgb(1, 1, 1);
const INK = rgb(0.094, 0.094, 0.106); // zinc-900
const MUTED = rgb(0.443, 0.443, 0.478); // zinc-500
const ROW_ALT = rgb(0.925, 0.992, 0.961); // emerald-50  #ECFDF5
const BORDER = rgb(0.827, 0.906, 0.871); // cool hairline

// pdf-lib's Helvetica is WinAnsi-encoded; characters outside it throw. Replace
// the few symbols that show up (smart punctuation, peso) with safe equivalents,
// and anything else unencodable with '?'.
export function sanitize(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 63;
    if ((code >= 32 && code <= 126) || (code >= 160 && code <= 255)) out += ch;
    else if (ch === '–' || ch === '—') out += '-';
    else if (ch === '’' || ch === '‘') out += "'";
    else if (ch === '“' || ch === '”') out += '"';
    else if (ch === '…') out += '...';
    else if (ch === '₱') out += 'PHP ';
    else out += '?';
  }
  return out;
}

/** Wrap text to a width, hard-breaking tokens that are themselves too long. */
export function wrapText(raw: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const text = sanitize(raw).trim();
  if (!text) return [''];
  const fits = (s: string) => font.widthOfTextAtSize(s, size) <= maxWidth;
  const lines: string[] = [];
  let line = '';
  for (let word of text.split(/\s+/)) {
    while (!fits(word)) {
      let i = word.length;
      while (i > 1 && !fits(word.slice(0, i))) i--;
      if (line) { lines.push(line); line = ''; }
      lines.push(word.slice(0, i));
      word = word.slice(i);
      if (i <= 1 && word.length) break;
    }
    const candidate = line ? `${line} ${word}` : word;
    if (line && !fits(candidate)) { lines.push(line); line = word; } else line = candidate;
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

/** Draw a horizontal gradient bar by slicing into thin rectangles — pdf-lib has
 *  no native gradients, so this reproduces the tab's emerald→teal accent. */
export function drawHGradient(
  page: PDFPage, x: number, y: number, w: number, h: number,
  from: RGB, to: RGB, steps = 60,
): void {
  const sw = w / steps;
  for (let i = 0; i < steps; i++) {
    const t = steps === 1 ? 0 : i / (steps - 1);
    page.drawRectangle({
      x: x + i * sw,
      y,
      width: sw + 0.6, // tiny overlap so no seams show between slices
      height: h,
      color: rgb(
        from[0] + (to[0] - from[0]) * t,
        from[1] + (to[1] - from[1]) * t,
        from[2] + (to[2] - from[2]) * t,
      ),
    });
  }
}

type Col = { header: string; width: number; align?: 'left' | 'right' };

export async function loadLogoBytes(url: string): Promise<ArrayBuffer | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.arrayBuffer();
  } catch {
    return null;
  }
}

/** Build the emerald-themed PDF report. Returns the raw PDF bytes. */
export async function generateGiftRosterPdf(
  model: GiftRosterExportModel,
  opts: { logoUrl?: string } = {},
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  let logo: PDFImage | null = null;
  const logoBytes = await loadLogoBytes(opts.logoUrl ?? '/simple-logo.png');
  if (logoBytes) {
    try {
      logo = await doc.embedPng(logoBytes);
    } catch {
      logo = null;
    }
  }

  const year = model.generatedAt.getFullYear();
  const state = { page: doc.addPage([PAGE_W, PAGE_H]), y: PAGE_H - MARGIN };

  const newPage = () => {
    state.page = doc.addPage([PAGE_W, PAGE_H]);
    state.y = PAGE_H - MARGIN;
  };
  const ensure = (space: number) => {
    if (state.y - space < BOTTOM) newPage();
  };

  // ── Masthead (page 1) ─────────────────────────────────────────────────────
  {
    const top = state.y;
    if (logo) {
      const h = 28;
      const w = (logo.width / logo.height) * h;
      state.page.drawImage(logo, { x: MARGIN, y: top - h, width: w, height: h });
    } else {
      state.page.drawText('Simple', { x: MARGIN, y: top - 22, size: 22, font: bold, color: EMERALD });
    }

    const right = (text: string, y: number, size: number, f: PDFFont, color = MUTED) => {
      const s = sanitize(text);
      const w = f.widthOfTextAtSize(s, size);
      state.page.drawText(s, { x: PAGE_W - MARGIN - w, y, size, font: f, color });
    };
    right('Pulled from Simple-HRIS System', top - 8, 9.5, bold, INK);
    right(`Exported ${formatTimestamp(model.generatedAt)}`, top - 21, 8.5, font);
    right(`${String.fromCharCode(0xa9)} ${year} Simple.biz`, top - 32, 8, font);

    state.y = top - 46;
    state.page.drawText('HR - GIFT TRACKER', { x: MARGIN, y: state.y, size: 8.5, font: bold, color: EMERALD });
    state.y -= 18;
    state.page.drawText('Tenure Gift Roster', { x: MARGIN, y: state.y, size: 17, font: bold, color: INK });
    state.y -= 13;
    state.page.drawText(
      sanitize(`${model.scopeLabel} · complete list, including people who have not submitted`),
      { x: MARGIN, y: state.y, size: 9, font, color: MUTED },
    );
    state.y -= 9;
    drawHGradient(state.page, MARGIN, state.y - 2.4, CONTENT_W, 2.4, C_EMERALD_500, C_TEAL);
    state.y -= 16;
  }

  // ── At-a-glance metric band ────────────────────────────────────────────────
  {
    const s = model.summary;
    const items: { label: string; value: string }[] = [
      { label: 'People', value: s.people.toLocaleString() },
      { label: 'Submitted', value: s.submitted.toLocaleString() },
      { label: 'Not submitted', value: s.notSubmitted.toLocaleString() },
      { label: 'Due, no submission', value: s.dueNoSubmission.toLocaleString() },
      { label: 'Gifts owed', value: s.giftsOwed.toLocaleString() },
      { label: 'People owed', value: s.peopleOwed.toLocaleString() },
      { label: 'Not recorded', value: s.peopleNotRecorded.toLocaleString() },
      { label: 'Off-roster', value: s.offRoster.toLocaleString() },
      { label: 'No address', value: s.noAddress.toLocaleString() },
      { label: 'Alt recipient', value: s.altRecipient.toLocaleString() },
    ];
    const gap = 9;
    const boxW = (CONTENT_W - gap * (items.length - 1)) / items.length;
    const boxH = 44;
    ensure(boxH + 10);
    state.y -= boxH;
    items.forEach((item, i) => {
      const x = MARGIN + i * (boxW + gap);
      state.page.drawRectangle({ x, y: state.y, width: boxW, height: boxH, color: ROW_ALT, borderColor: BORDER, borderWidth: 0.5 });
      state.page.drawRectangle({ x, y: state.y + boxH - 3, width: boxW, height: 3, color: AMBER });
      state.page.drawText(sanitize(item.label.toUpperCase()), { x: x + 8, y: state.y + boxH - 16, size: 6.5, font: bold, color: MUTED });
      state.page.drawText(sanitize(item.value), { x: x + 8, y: state.y + 10, size: 16, font: bold, color: EMERALD });
    });
    state.y -= 16;
  }

  // ── Roster table (emerald header, zebra; paginates with redrawn header) ─────
  const BODY = 7.5;
  const LH = 9.5;
  const PAD_X = 5;
  const PAD_Y = 4;

  // `Received By` is worth the width it costs: this is the printed ship list, and
  // "hand it to somebody else" is the one fact on it that changes what the person
  // at the door does. The width comes out of Name / Work Email / Shipping Address,
  // and `wrapText` wraps rather than truncates, so narrower columns cost lines on
  // the page, never characters out of a name.
  //
  // The employee's contact number is deliberately still ABSENT from the PDF, as
  // it always has been — this column does not change who the courier calls.
  const columns: Col[] = [
    { header: '#', width: 22, align: 'right' },
    { header: 'Name', width: 90 },
    { header: 'Work Email', width: 112 },
    { header: 'Department', width: 60 },
    { header: 'Milestone', width: 50 },
    { header: 'Milestone Date', width: 60 },
    { header: 'Sub?', width: 26 },
    { header: 'Status', width: 48 },
    { header: 'Shipping Address', width: 140 },
    { header: 'Received By', width: 74 },
    {
      header: 'Source',
      width: CONTENT_W - 22 - 90 - 112 - 60 - 50 - 60 - 26 - 48 - 140 - 74,
    },
  ];
  const tableRows = model.rows.map((r, i) => [
    String(i + 1),
    r.name,
    r.workEmail,
    r.department,
    r.currentMilestone,
    r.milestoneDate || DASH,
    r.submitted,
    r.status,
    r.shippingAddress,
    // Through the module, not spelled out here — "Maria (Spouse)" has exactly one
    // implementation, shared with the Gift Tracker and both forms.
    //
    // Blank reads as DASH, never as an empty cell that could be mistaken for a
    // missing value: a dash says "the employee receives it", which is an answer.
    describeAlternateRecipient({
      recipient_name: r.alternateRecipient,
      recipient_relationship: r.recipientRelationship,
    }) || DASH,
    r.addressSource,
  ]);

  const drawTable = (cols: Col[], rows: string[][]) => {
    const headerH = LH + PAD_Y * 2;
    const drawHeader = () => {
      state.page.drawRectangle({ x: MARGIN, y: state.y - headerH, width: CONTENT_W, height: headerH, color: EMERALD });
      let x = MARGIN;
      for (const c of cols) {
        const label = wrapText(c.header, bold, BODY, c.width - PAD_X * 2)[0];
        const tw = bold.widthOfTextAtSize(label, BODY);
        const tx = c.align === 'right' ? x + c.width - PAD_X - tw : x + PAD_X;
        state.page.drawText(label, { x: tx, y: state.y - PAD_Y - BODY, size: BODY, font: bold, color: WHITE });
        x += c.width;
      }
      state.y -= headerH;
    };

    ensure(headerH + LH + PAD_Y * 2);
    drawHeader();

    let alt = false;
    for (const row of rows) {
      const cellLines = cols.map((c, i) => wrapText(row[i] ?? '', font, BODY, c.width - PAD_X * 2));
      const maxLines = Math.max(1, ...cellLines.map((l) => l.length));
      const rowH = maxLines * LH + PAD_Y * 2;

      if (state.y - rowH < BOTTOM) {
        newPage();
        drawHeader();
        alt = false;
      }
      if (alt) {
        state.page.drawRectangle({ x: MARGIN, y: state.y - rowH, width: CONTENT_W, height: rowH, color: ROW_ALT });
      }

      let x = MARGIN;
      for (let i = 0; i < cols.length; i++) {
        const c = cols[i];
        const lines = cellLines[i];
        for (let li = 0; li < lines.length; li++) {
          const tw = font.widthOfTextAtSize(lines[li], BODY);
          const tx = c.align === 'right' ? x + c.width - PAD_X - tw : x + PAD_X;
          state.page.drawText(lines[li], { x: tx, y: state.y - PAD_Y - BODY - li * LH, size: BODY, font, color: INK });
        }
        x += c.width;
      }
      state.page.drawLine({
        start: { x: MARGIN, y: state.y - rowH },
        end: { x: MARGIN + CONTENT_W, y: state.y - rowH },
        thickness: 0.5,
        color: BORDER,
      });
      state.y -= rowH;
      alt = !alt;
    }
    state.y -= 8;
  };

  if (model.rows.length === 0) {
    ensure(20);
    state.page.drawText('No employees match this view.', { x: MARGIN, y: state.y - 10, size: 10, font, color: MUTED });
    state.y -= 22;
  } else {
    drawTable(columns, tableRows);
  }

  // ── Footers on every page ──────────────────────────────────────────────────
  const pages = doc.getPages();
  const total = pages.length;
  const footerText = `Developed by AI/API Team / Simple.biz ${String.fromCharCode(0xa9)} ${year}`;
  pages.forEach((p: PDFPage, i: number) => {
    drawHGradient(p, MARGIN, 39, CONTENT_W, 1, C_EMERALD_500, C_TEAL, 40);
    p.drawText(sanitize(footerText), { x: MARGIN, y: 26, size: 8, font, color: MUTED });
    const pg = `Page ${i + 1} of ${total}`;
    const w = font.widthOfTextAtSize(pg, 8);
    p.drawText(pg, { x: PAGE_W - MARGIN - w, y: 26, size: 8, font, color: MUTED });
  });

  return doc.save();
}

// ---------------------------------------------------------------------------
// Browser download helpers
// ---------------------------------------------------------------------------

/** YYYY-MM-DD for filename suffixes. */
function dateSuffix(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function downloadBlob(filename: string, blob: Blob): void {
  if (typeof window === 'undefined') return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 200);
}

function baseName(model: GiftRosterExportModel): string {
  return `tenure-gift-roster-${dateSuffix(model.generatedAt)}`;
}

/** Build + download the CSV report. */
export function downloadGiftRosterCsv(model: GiftRosterExportModel): void {
  downloadBlob(
    `${baseName(model)}.csv`,
    new Blob([giftRosterToCsv(model)], { type: 'text/csv;charset=utf-8' }),
  );
}

/** Build + download the XLSX workbook. */
export function downloadGiftRosterXlsx(model: GiftRosterExportModel): void {
  const wb = buildGiftRosterWorkbook(model);
  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  downloadBlob(
    `${baseName(model)}.xlsx`,
    new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
  );
}

/** Build + download the emerald-themed PDF report. */
export async function downloadGiftRosterPdf(
  model: GiftRosterExportModel,
  opts?: { logoUrl?: string },
): Promise<void> {
  const bytes = await generateGiftRosterPdf(model, opts);
  // Copy into a fresh ArrayBuffer so the Blob gets a plain ArrayBuffer.
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  downloadBlob(`${baseName(model)}.pdf`, new Blob([ab], { type: 'application/pdf' }));
}
