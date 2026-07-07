// Shared MESA ledger types + pure aggregation. Imported by both the
// /api/mesa-ledger route (server) and the HR/Accounting/Employee MESA views
// (client), so this module must stay free of server-only / 'use client' imports.
//
// The mesa_ledger table is a faithful 1:1 backfill of the external MESA program
// tracker. Each row is one ledger EVENT: a weekly deposit (₱100 worker + ₱300
// Simple.biz match = ₱400), a disbursement, or a membership/status snapshot.
// Members are keyed by lowercased email. See references/sql/create/backfill_mesa_ledger.sql.

import { normEmail } from '@/lib/email/norm-email';

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
}

/** Columns to SELECT from mesa_ledger to build the shapes below. */
export const MESA_LEDGER_SELECT =
  'id, email, name, department, status, worker_contribution_php, simple_match_php, total_daily_deposit_php, deposit_date, disbursement_amount_php, disbursement_date, disbursement_type';

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
}

const num = (v: number | null | undefined): number => (typeof v === 'number' && !Number.isNaN(v) ? v : 0);

/** Best available date on an event, for "latest status" ordering. */
function eventDate(e: MesaLedgerEvent): string {
  return e.deposit_date ?? e.disbursement_date ?? '';
}

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
  };
}

/** Group raw events by lowercased email and summarize each member. Rows with no email are dropped. */
export function summarizeMembers(events: MesaLedgerEvent[]): MesaMemberSummary[] {
  const byEmail = new Map<string, MesaLedgerEvent[]>();
  for (const e of events) {
    const key = normEmail(e.email);
    if (!key) continue; // external aggregate/summary rows carry no member email
    const bucket = byEmail.get(key);
    if (bucket) bucket.push(e);
    else byEmail.set(key, [e]);
  }
  const out: MesaMemberSummary[] = [];
  for (const bucket of byEmail.values()) out.push(summarizeMember(bucket));
  out.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
  return out;
}
