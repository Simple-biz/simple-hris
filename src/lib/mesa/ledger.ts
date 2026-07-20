// Shared MESA ledger types + pure aggregation. Imported by both the
// /api/mesa-ledger route (server) and the HR/Accounting/Employee MESA views
// (client), so this module must stay free of server-only / 'use client' imports.
//
// The mesa_ledger table is a faithful 1:1 backfill of the external MESA program
// tracker. Each row is one ledger EVENT: a weekly deposit (₱100 worker + ₱300
// Simple.biz match = ₱400), a disbursement, or a membership/status snapshot.
// Members are keyed by lowercased email. See references/sql/create/backfill_mesa_ledger.sql.

import { normEmail } from '@/lib/email/norm-email';
import { resolveMesaEmail } from '@/lib/mesa/email-aliases';

/** One raw ledger event, as selected from mesa_ledger. */
export interface MesaLedgerEvent {
  id: number;
  email: string | null;
  name: string | null;
  department: string | null;
  status: string | null;
  worker_contribution_php: number | null;
  simple_match_php: number | null;
  total_daily_deposit_php: number | null;
  deposit_date: string | null;
  disbursement_amount_php: number | null;
  disbursement_date: string | null;
  disbursement_type: string | null;
  /** Frozen, per-event free text from the original CSV backfill (read-only). */
  notes: string | null;
  additional_notes: string | null;
}

/** Columns to SELECT from mesa_ledger to build the shapes below. */
export const MESA_LEDGER_SELECT =
  'id, email, name, department, status, worker_contribution_php, simple_match_php, total_daily_deposit_php, deposit_date, disbursement_amount_php, disbursement_date, disbursement_type, notes, additional_notes';

/** Per-member rollup — "how much they've contributed, and what's left". */
export interface MesaMemberSummary {
  email: string;
  name: string | null;
  department: string | null;
  /** Latest known Active/Inactive status, or null if never stamped. */
  status: string | null;
  /** Whether the member is currently active in the program (status === 'Active'). */
  isActive: boolean;
  /** Σ worker_contribution_php — the employee's own money. */
  contributed: number;
  /** Σ simple_match_php — Simple.biz's 3× match. */
  matched: number;
  /** Σ total_daily_deposit_php — contributed + matched. */
  deposited: number;
  /** Σ disbursement_amount_php — money paid out to the member. */
  disbursed: number;
  /** deposited − disbursed — funds currently sitting in the account. */
  balance: number;
  /** Number of weekly deposit events. */
  depositCount: number;
  /** Number of disbursement events. */
  disbursementCount: number;
  firstDeposit: string | null;
  lastDeposit: string | null;
  lastDisbursement: string | null;
  /**
   * True when the member's most recent DATED ledger event is a program EXIT — an
   * 'Opt-out'/'Termination' disbursement or an 'Inactive' status snapshot — with
   * no later deposit re-joining them. In plain terms: "their last entry was an
   * opt-out." Lets callers treat a member as opted-out even when the
   * employee_hourly_rates.mesa_member flag has drifted out of sync (stayed true).
   */
  lastEventOptedOut: boolean;
  /**
   * The member's CURRENT (open) mesa_accounts number ("YY-MM-#####"), when the
   * accounts registry is populated. When set, every figure above is scoped to
   * that account (events on/after accountOpenedOn) — an opt-out closes the
   * account, so a re-joined member starts from ₱0 on a fresh number.
   */
  accountNumber?: string | null;
  accountOpenedOn?: string | null;
}

const num = (v: number | null | undefined): number => (typeof v === 'number' && !Number.isNaN(v) ? v : 0);

/** Best available date on an event, for "latest status" ordering and for
 *  scoping events to a MESA account window (undated snapshot rows sort as ''
 *  and therefore never leak into an account opened later). */
export function mesaEventDate(e: MesaLedgerEvent): string {
  return e.deposit_date ?? e.disbursement_date ?? '';
}
const eventDate = mesaEventDate;

/** Roll a single member's events up into a summary. Assumes all events share an email. */
export function summarizeMember(events: MesaLedgerEvent[]): MesaMemberSummary {
  const first = events[0] ?? ({} as MesaLedgerEvent);
  let contributed = 0;
  let matched = 0;
  let deposited = 0;
  let disbursed = 0;
  let depositCount = 0;
  let disbursementCount = 0;
  let firstDeposit: string | null = null;
  let lastDeposit: string | null = null;
  let lastDisbursement: string | null = null;
  // Latest DATED program-exit event (Opt-out/Termination disbursement, or an
  // 'Inactive' status snapshot) — used to detect a trailing opt-out below.
  let lastTermination: string | null = null;
  // Latest non-null status wins, ordered by the event's own date.
  let statusDate = '';
  let status: string | null = null;
  // Prefer a non-blank name/department in case some snapshot rows omit them.
  let name: string | null = null;
  let department: string | null = null;

  for (const e of events) {
    contributed += num(e.worker_contribution_php);
    matched += num(e.simple_match_php);
    deposited += num(e.total_daily_deposit_php);
    disbursed += num(e.disbursement_amount_php);

    if (num(e.total_daily_deposit_php) > 0 && e.deposit_date) {
      depositCount += 1;
      if (!firstDeposit || e.deposit_date < firstDeposit) firstDeposit = e.deposit_date;
      if (!lastDeposit || e.deposit_date > lastDeposit) lastDeposit = e.deposit_date;
    }
    if (num(e.disbursement_amount_php) > 0 && e.disbursement_date) {
      disbursementCount += 1;
      if (!lastDisbursement || e.disbursement_date > lastDisbursement) lastDisbursement = e.disbursement_date;
    }
    // Program exit: an 'Inactive' status snapshot, or an Opt-out/Termination
    // disbursement (matches the accounts-seed convention). Track the latest
    // DATED one; a bare 'n/a'/undated exit can't be ordered so it's skipped.
    if (e.status === 'Inactive' || /opt.?out|termination/i.test(e.disbursement_type ?? '')) {
      const termDate = e.disbursement_date ?? e.deposit_date ?? '';
      if (termDate && (!lastTermination || termDate > lastTermination)) lastTermination = termDate;
    }
    if (e.status) {
      const d = eventDate(e);
      if (status === null || d >= statusDate) {
        status = e.status;
        statusDate = d;
      }
    }
    if (!name && e.name) name = e.name;
    if (!department && e.department) department = e.department;
  }

  // "Their last entry was an opt-out": a dated exit event on/after the last
  // deposit (or with no deposits at all). A deposit dated after it means they
  // re-joined and are active again, so it does NOT count as opted out.
  const lastEventOptedOut =
    lastTermination !== null && (lastDeposit === null || lastTermination >= lastDeposit);

  return {
    email: normEmail(first.email) ?? '',
    name: name ?? first.name ?? null,
    department: department ?? first.department ?? null,
    status,
    isActive: status === 'Active',
    contributed,
    matched,
    deposited,
    disbursed,
    balance: deposited - disbursed,
    depositCount,
    disbursementCount,
    firstDeposit,
    lastDeposit,
    lastDisbursement,
    lastEventOptedOut,
  };
}

/** Minimal shape of a member's OPEN mesa_accounts row (kept local so this
 *  module stays importable from client components). */
export interface MesaOpenAccountRef {
  account_number: string;
  opened_on: string; // YYYY-MM-DD
}

/**
 * Roll up ONLY the member's current account: events dated on/after the open
 * account's opened_on. An opt-out closes the account, so a re-joined member's
 * figures restart from ₱0 — the old (closed) account is settled/"zeroed" and
 * its history no longer feeds the visible balance. With no event in the window
 * yet (brand-new enrollee) the summary is all-zero but keeps the member's
 * identity from their full history.
 */
export function summarizeMemberAccount(
  events: MesaLedgerEvent[],
  account: MesaOpenAccountRef,
): MesaMemberSummary {
  const scoped = events.filter((e) => mesaEventDate(e) >= account.opened_on);
  const base = scoped.length
    ? summarizeMember(scoped)
    : {
        ...summarizeMember(events),
        status: null,
        isActive: false,
        contributed: 0,
        matched: 0,
        deposited: 0,
        disbursed: 0,
        balance: 0,
        depositCount: 0,
        disbursementCount: 0,
        firstDeposit: null,
        lastDeposit: null,
        lastDisbursement: null,
        lastEventOptedOut: false,
      };
  return { ...base, accountNumber: account.account_number, accountOpenedOn: account.opened_on };
}

/**
 * Group raw events by lowercased email and summarize each member. Rows with no
 * email are dropped. When `openAccounts` (email → open account) is provided,
 * members with an open account are scoped to it via summarizeMemberAccount;
 * members without one keep the full-history rollup.
 */
export function summarizeMembers(
  events: MesaLedgerEvent[],
  openAccounts?: Map<string, MesaOpenAccountRef> | null,
): MesaMemberSummary[] {
  // Group by the member's CURRENT roster email, following the drift alias map so
  // savings recorded under an old address (e.g. jennb@) roll up under the person
  // the roster knows (jeanneb@) instead of detaching into a phantom member.
  const byEmail = new Map<string, MesaLedgerEvent[]>();
  for (const e of events) {
    const key = resolveMesaEmail(e.email);
    if (!key) continue; // external aggregate/summary rows carry no member email
    const bucket = byEmail.get(key);
    if (bucket) bucket.push(e);
    else byEmail.set(key, [e]);
  }
  // Open accounts are keyed by the account's stored email, which may also be a
  // pre-drift address — resolve those keys too so scoping lines up with the
  // regrouped events.
  const resolvedAccounts = openAccounts
    ? new Map(
        [...openAccounts].map(([k, v]) => [resolveMesaEmail(k) ?? k, v] as [string, MesaOpenAccountRef]),
      )
    : null;
  const out: MesaMemberSummary[] = [];
  for (const [key, bucket] of byEmail) {
    const account = resolvedAccounts?.get(key);
    const summary = account ? summarizeMemberAccount(bucket, account) : summarizeMember(bucket);
    // Stamp the canonical (alias-resolved) email so it matches the roster join,
    // rather than the raw first-event email which may be a pre-drift address.
    summary.email = key;
    out.push(summary);
  }
  out.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
  return out;
}
