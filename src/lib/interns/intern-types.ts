// Client-safe types + constants for orphanage interns. No server imports here —
// the Orphanage dashboard, the Accounting Interns view and the dispatch queue
// all import from this file. DB access lives in src/lib/supabase/orphanage-intern*.ts.

export type InternStatus = 'active' | 'ended';
export type InternPayStatus = 'submitted' | 'accepted' | 'rejected';
/** Q2 (Ellie/Ralph): does HRIS split the 50% to two payees, or does the intern remit it? */
export type InternShareMode = 'system_split' | 'intern_remits';
/** How a locked week's PAB figure was produced. Ralph fixed the rule (weekly hours). */
export type InternPabMode = 'weekly_hours' | 'not_payout_week';

/** The meeting's numbers. Per-intern columns carry these as DB defaults too. */
export const INTERN_DEFAULTS = {
  ratePhp: 200,
  weeklyCapHours: 5,
  dailyCapHours: 5,
  pabBonusPhp: 1000,
  orphanageSharePct: 50,
} as const;

export interface OrphanageInternRow {
  id: string;
  email: string;
  /** Name PARTS are the source of truth (like Simple's onboarding); full_name is
   *  composed from first + last + extension on every write. middle_name is
   *  stored and shown but never composed in (onboarding-name-parts.md). */
  first_name: string;
  middle_name: string | null;
  last_name: string;
  name_extension: string | null;
  full_name: string;
  personal_email: string | null;
  phone: string | null;
  orphanage_id: string | null;
  status: InternStatus;
  started_on: string | null;
  ended_on: string | null;
  weekly_cap_hours: number;
  daily_cap_hours: number;
  pab_bonus_php: number;
  orphanage_share_pct: number;
  bank_name: string;
  bank_account_name: string;
  bank_account_number: string;
  swift_code: string;
  note: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface OrphanageInternRateRow {
  id: string;
  intern_id: string;
  rate_php: number;
  effective_from: string; // YYYY-MM-DD
  set_by: string | null;
  created_at: string;
}

/** A profile as the LIST endpoints return it — account number masked to last 4. */
export interface OrphanageInternListItem extends Omit<OrphanageInternRow, 'bank_account_number'> {
  bank_account_last4: string | null;
  /** The rate in force today (newest effective_from <= today), null when none set. */
  current_rate_php: number | null;
  current_rate_effective_from: string | null;
}

export interface OrphanageInternHoursUploadRow {
  id: string;
  source_file: string;
  week_start: string;
  week_end: string;
  row_count: number;
  refused_count: number;
  uploaded_by: string | null;
  uploaded_at: string;
}

export interface InternHoursByDayEntry {
  raw: number;
  paid: number;
  rate_php: number | null;
}

export interface OrphanageInternPayRow {
  id: string;
  source_file: string;
  intern_id: string;
  intern_email: string;
  intern_name: string;
  week_start: string;
  week_end: string;
  hours_raw: number;
  hours_paid: number;
  hours_by_day: Record<string, InternHoursByDayEntry>;
  rate_php: number;
  pay_php: number;
  pab_php: number;
  pab_mode: InternPabMode;
  pab_month: string | null;
  gross_php: number;
  orphanage_share_pct: number;
  orphanage_share_php: number;
  intern_share_php: number;
  share_mode: InternShareMode;
  status: InternPayStatus;
  submitted_by: string | null;
  submitted_at: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  created_at: string;
  updated_at: string;
}

export function formatInternPHP(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `₱${v.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** One row of Accounting's inbox: the stored week row + its on-read reconciliation + dispatch state. */
export interface InternInboxRow extends OrphanageInternPayRow {
  reconcile: {
    status: 'ok' | 'pay_mismatch' | 'gross_mismatch' | 'share_mismatch';
    expectedPayPhp: number;
    expectedGrossPhp: number;
    expectedOrphanagePhp: number;
    expectedInternPhp: number;
    deltaPhp: number;
    message: string;
  };
  dispatch: { types: string[]; paid: boolean; problem: boolean } | null;
}

/** A locked week as Accounting's inbox groups it. */
export interface InternInboxWeek {
  sourceFile: string;
  weekStart: string;
  weekEnd: string;
  status: InternPayStatus;
  submittedBy: string | null;
  submittedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  rows: InternInboxRow[];
  totals: { interns: number; hoursPaid: number; payPhp: number; pabPhp: number; grossPhp: number; orphanagePhp: number; internPhp: number };
  /** Rows whose stored money disagrees with their own hours × rates. */
  mismatches: number;
  paidRows: number;
}
