import { normalizeNameTokens } from '@/lib/name/name-tokens';

/**
 * Shared-email attribution for manager KPI bonuses.
 *
 * `bonus_catalog_applied` rows are keyed by the email the KPI Calculator's
 * roster shows for a member (personal-first). The Payroll Wizard pays by
 * summing rows per email — which silently merges TWO PEOPLE whenever the same
 * address sits on more than one master row (the 2026-07-30 incident: Rhocel
 * Bencito's master row carried John Marc Corpuz's gmail, so both paystubs
 * staged her 2,500 pm_team KPI PLUS his 8,666.67 HR split as one 11,167 sum).
 *
 * This module keeps the stored keys exactly as they are (the calculator, QC
 * and history stay untouched) and instead disambiguates at RESOLUTION time:
 * every applied row carries an `employee_name` snapshot, so when — and only
 * when — an email is claimed by two differently-named master rows, each
 * claimant is paid just the rows snapshotted under their own name. Rows naming
 * neither claimant are excluded from everyone and surfaced for accounting to
 * fix, never silently paid to the wrong person.
 */

/** One applied KPI row, reduced to what attribution needs. */
export type AppliedKpiRow = {
  dept: string;
  /** `bonus_catalog_applied.employee_name` snapshot taken at apply time. */
  name: string | null;
  /** PHP amount (already cadence-filtered by the caller). */
  amount: number;
};

/** The master-list columns that participate in identity. */
export type MasterNameRow = {
  name?: string | null;
  work_email?: string | null;
  personal_email?: string | null;
  alternate_work_email?: string | null;
  alternate_work_email_2?: string | null;
};

export type SharedEmailOwner = {
  /** `normalizeNameTokens` of the master row's name — the match key. */
  tokens: string;
  /** The master row's name as stored, for banners/tooltips. */
  displayName: string;
};

function normEmail(raw: string | null | undefined): string | null {
  const e = (raw ?? '').trim().toLowerCase();
  return e.includes('@') ? e : null;
}

/**
 * Emails claimed by 2+ master rows whose names tokenize DIFFERENTLY — i.e.
 * genuinely different humans. Duplicate-person rows (the same human listed
 * twice, e.g. "Lee, Seungyong" vs "Seungyong, Lee") tokenize identically and
 * are deliberately NOT flagged: for one human the per-email sum is correct.
 */
export function buildSharedEmailOwners(
  master: MasterNameRow[],
): Map<string, SharedEmailOwner[]> {
  const claims = new Map<string, Map<string, SharedEmailOwner>>(); // email → tokens → owner
  for (const r of master) {
    const tokens = normalizeNameTokens(r.name ?? '');
    if (!tokens) continue; // a nameless row can never be name-matched — skip
    for (const col of [r.personal_email, r.work_email, r.alternate_work_email, r.alternate_work_email_2]) {
      const email = normEmail(col);
      if (!email) continue;
      const owners = claims.get(email) ?? new Map<string, SharedEmailOwner>();
      if (!owners.has(tokens)) owners.set(tokens, { tokens, displayName: r.name ?? '' });
      claims.set(email, owners);
    }
  }
  const shared = new Map<string, SharedEmailOwner[]>();
  for (const [email, owners] of claims) {
    if (owners.size > 1) shared.set(email, [...owners.values()]);
  }
  return shared;
}

export type AttributedKpiRows = {
  /** Rows snapshotted under the claimant's own name. */
  mine: AppliedKpiRow[];
  /** Rows belonging to a DIFFERENT owner of the shared email. */
  foreign: AppliedKpiRow[];
  /** Rows naming no owner (or blank) — paid to nobody, surfaced instead. */
  unattributed: AppliedKpiRow[];
};

/**
 * Split one shared email's rows for one claimant. `personName` may come in any
 * order/format ("Rhocel Bencito" from Hubstaff, 'Bencito, Rhocel "Rhocel"'
 * from the master list) — token equality absorbs the difference.
 */
export function attributeKpiRows(
  rows: AppliedKpiRow[],
  owners: SharedEmailOwner[],
  personName: string | null | undefined,
): AttributedKpiRows {
  const personTokens = normalizeNameTokens(personName ?? '');
  const ownerTokens = new Set(owners.map((o) => o.tokens));
  const out: AttributedKpiRows = { mine: [], foreign: [], unattributed: [] };
  for (const row of rows) {
    const rowTokens = normalizeNameTokens(row.name ?? '');
    if (rowTokens && personTokens && rowTokens === personTokens) out.mine.push(row);
    else if (rowTokens && ownerTokens.has(rowTokens)) out.foreign.push(row);
    else out.unattributed.push(row);
  }
  return out;
}

/**
 * Wizard-parity rounding: whole pesos per department bucket and for the total
 * (mirrors the loader's `Math.round` accumulation in PayrollWizard).
 */
export function roundedKpiTotals(rows: AppliedKpiRow[]): {
  total: number;
  byDept: Record<string, number>;
} {
  const byDeptRaw: Record<string, number> = {};
  let sum = 0;
  for (const r of rows) {
    byDeptRaw[r.dept] = (byDeptRaw[r.dept] ?? 0) + r.amount;
    sum += r.amount;
  }
  const byDept: Record<string, number> = {};
  for (const [dept, amt] of Object.entries(byDeptRaw)) byDept[dept] = Math.round(amt);
  return { total: Math.round(sum), byDept };
}

export type SharedEmailSummary = {
  perOwner: { displayName: string; tokens: string; total: number }[];
  unattributed: AppliedKpiRow[];
};

/** Per-owner split of one shared email's rows — feeds the Additions banner. */
export function summarizeSharedEmail(
  rows: AppliedKpiRow[],
  owners: SharedEmailOwner[],
): SharedEmailSummary {
  const perOwner = owners.map((o) => ({
    displayName: o.displayName,
    tokens: o.tokens,
    total: roundedKpiTotals(attributeKpiRows(rows, owners, o.displayName).mine).total,
  }));
  const unattributed = attributeKpiRows(rows, owners, null).unattributed;
  return { perOwner, unattributed };
}
