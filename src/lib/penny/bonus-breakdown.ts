/**
 * Pure assembly for Penny's `get_bonus_breakdown`.
 *
 * Carla, 2026-09-15: *"I need to be able to drill down on performance bonuses
 * to know where they came from."* Until now no Penny tool read a single bonus
 * SOURCE — `get_employee_pay` excludes bonuses by design, and the audit log
 * never sees a KPI save. This module takes the rows the server-only tool has
 * fetched and answers two questions side by side:
 *
 *   1. **What the HRIS shows** for the week — the Payroll Wizard's final-pay
 *      snapshot (PAB / Tech / other bonuses / adjustment), the staged or paid
 *      paystub, and the paid dispatch's system-bonus line.
 *   2. **Where each peso came from** — every scored HSL KPI row (with its
 *      inputs and whether its period is payable), every Payment Catalog
 *      applied row, the wizard's per-person controls, and the Payroll Notes
 *      adjustments.
 *
 * …and then reconciles them: the wizard's `otherBonuses` is its bonus total
 * MINUS the month-gated PAB and Tech amounts (PayrollWizard `autoOtherBonuses`),
 * so it should equal the payable HSL rows plus the catalog rows. When it does
 * not, the tool says so and says WHY it cannot dig further: KPI and catalog
 * saves are deliberately unaudited, so only the CURRENT stored value exists.
 *
 * No I/O here, so every rule below has a test.
 */
import { sundayOf } from '../payroll/manila-week';

export interface BonusWeek {
  /** Sunday, `YYYY-MM-DD`. */
  start: string;
  /** Saturday, `YYYY-MM-DD`. */
  end: string;
}

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d! + days));
  return dt.toISOString().slice(0, 10);
}

/**
 * Any calendar day → the Sunday–Saturday pay week containing it. Pay-week keys
 * are Sundays everywhere in this HRIS (`hsl_bonus_entries.period_start`,
 * `bonus_catalog_applied.period_start`, the QC deal), so a mid-week date is
 * snapped to its own week's Sunday and the result reports which week it chose.
 * With no input, the DEFAULT is the just-completed week (payroll runs a week in
 * arrears), read against `todayIso` (Manila).
 */
export function resolveBonusWeek(
  input: string | null | undefined,
  todayIso: string,
): { week: BonusWeek; resolved_from: 'given_date' | 'default_previous_week' } | { error: string } {
  const raw = (input ?? '').trim();
  if (!raw) {
    const start = addDays(sundayOf(todayIso), -7);
    return { week: { start, end: addDays(start, 6) }, resolved_from: 'default_previous_week' };
  }
  const m = ISO_DAY.exec(raw);
  if (!m) return { error: `week must be a YYYY-MM-DD date (got "${raw}")` };
  const probe = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(probe.getTime()) || probe.toISOString().slice(0, 10) !== raw) {
    return { error: `week is not a real calendar date ("${raw}")` };
  }
  const start = sundayOf(raw);
  return { week: { start, end: addDays(start, 6) }, resolved_from: 'given_date' };
}

/* ───────── Inputs (already fetched by the server-only tool) ───────── */

export interface HslEntryIn {
  department: string;
  employee_email: string;
  calculated_bonus: number | null;
  kpi_data: Record<string, unknown> | null;
  is_manager: boolean | null;
  period_type: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface HslStatusIn {
  department: string;
  status: string;
  locked_by: string | null;
  locked_at: string | null;
  updated_at: string | null;
}

export interface CatalogAppliedIn {
  department: string;
  employee_email: string;
  bonus_name: string | null;
  kind: string | null;
  vars: Record<string, unknown> | null;
  amount: number | null;
  applied_by: string | null;
  created_at: string | null;
  updated_at: string | null;
  cadence?: string | null;
}

export interface SnapshotIn {
  updated_at: string | null;
  perfectAttendanceBonus: number | null;
  techBonus: number | null;
  otherBonuses: number | null;
  adjustment: number | null;
  adjustmentNote: string | null;
  initial: number | null;
  final: number | null;
}

export interface PaystubIn {
  paid: boolean;
  sent_at: string | null;
  techBonus: number;
  attendanceBonus: number;
  performanceBonus: number;
  adjustment: number;
  adjustmentNote: string | null;
  totalPayPhp: number;
}

export interface DispatchIn {
  status: string;
  amount_php: number | null;
  system_bonus_php: number | null;
  system_bonus_label: string | null;
  sent_date: string | null;
  created_by: string | null;
}

export interface NoteIn {
  worker: string | null;
  adjustment: unknown;
  notes: string | null;
  done: boolean | null;
  payroll_clerk: string | null;
  created_by: string | null;
  updated_at: string | null;
}

export interface WizardControlsIn {
  /** `bonusOverrides[email]` — the signed Accounting "Adj." delta, NOT a bonus
   *  replacement (it lands in the snapshot's `adjustment`, never in `otherBonuses`). */
  accounting_adjustment: number | null;
  accounting_adjustment_note: string | null;
  /** `employeeBonuses[email]` — the per-person PAB / Tech toggles. */
  toggles: Record<string, unknown> | null;
  wizard_department: string | null;
  wizard_department_manual: string | null;
  tech_manual_grant: boolean;
  tech_manual_revoke: boolean;
  blob_updated_at: string | null;
}

export interface MasterRowIn {
  department: string | null;
  work_email: string | null;
  employee_id: string | null;
  off_boarded_at: string | null;
  on_active_roster: boolean;
}

/** Turn a `kpi_data` key into the rule it scores — the server passes the HSL
 *  schema in; the pure code only needs the lookup. Null = not a known rule. */
export type RuleLabeller = (department: string, key: string) => { label: string; how: string } | null;

export interface BonusBreakdownInput {
  email: string;
  aliases: string[];
  week: BonusWeek;
  week_resolved_from: 'given_date' | 'default_previous_week';
  source_file: string | null;
  master_rows: MasterRowIn[];
  hsl_entries: HslEntryIn[];
  hsl_status: HslStatusIn[];
  catalog_applied: CatalogAppliedIn[];
  snapshot: SnapshotIn | null;
  paystub: PaystubIn | null;
  dispatches: DispatchIn[];
  wizard_controls: WizardControlsIn | null;
  payroll_notes: NoteIn[];
  lookup_errors: string[];
  labelRule: RuleLabeller;
}

/* ───────── Output ───────── */

export type ReconciliationVerdict = 'matches' | 'unexplained' | 'no_shown_figure';

/** A type alias, not an interface, on purpose: the tool runner returns
 *  `Record<string, unknown>`, and only an object-literal type carries the
 *  implicit index signature that makes this assignable without a cast. */
export type BonusBreakdown = {
  email_checked: string;
  aliases_searched: string[];
  week: BonusWeek & { resolved_from: string; source_file: string | null };
  identity: {
    master_rows: MasterRowIn[];
    note: string;
  };
  shown: {
    wizard_snapshot: {
      snapshot_saved_at: string | null;
      perfect_attendance_bonus: number;
      tech_bonus: number;
      other_bonuses: number;
      accounting_adjustment: number;
      accounting_adjustment_note: string | null;
      pay_before_bonuses: number | null;
      final_pay: number | null;
    } | null;
    paystub: PaystubIn | null;
    paid_dispatch: {
      status: string;
      amount_php: number | null;
      system_bonus_php: number | null;
      system_bonus_label: string | null;
      sent_date: string | null;
      sent_by: string | null;
    } | null;
  };
  sources: {
    hsl_kpi: Array<{
      department: string;
      scored_as: string;
      calculated_bonus: number;
      period_status: string;
      payable: boolean;
      locked_by: string | null;
      is_manager: boolean;
      inputs: Array<{ key: string; label: string; value: unknown; how: string | null }>;
      last_saved_at: string | null;
    }>;
    payment_catalog: Array<{
      department: string;
      scored_as: string;
      bonus_name: string | null;
      kind: string | null;
      cadence: string | null;
      inputs: Record<string, unknown>;
      amount: number;
      applied_by: string | null;
      last_saved_at: string | null;
    }>;
    wizard_controls: WizardControlsIn | null;
    payroll_notes: Array<{
      worker: string | null;
      adjustment: unknown;
      note: string | null;
      done: boolean;
      clerk: string | null;
      updated_at: string | null;
    }>;
  };
  reconciliation: {
    explained_other_bonuses: number;
    shown_other_bonuses: number | null;
    delta: number | null;
    verdict: ReconciliationVerdict;
    not_payable_total: number;
  };
  coverage_notes: string[];
  field_notes: string;
};

const num = (v: unknown): number => {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
};
const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
const lower = (v: string | null | undefined): string => (v ?? '').trim().toLowerCase();

export function assembleBonusBreakdown(input: BonusBreakdownInput): BonusBreakdown {
  const statusByDept = new Map<string, HslStatusIn>();
  for (const s of input.hsl_status) statusByDept.set(lower(s.department), s);

  const hsl = input.hsl_entries.map((e) => {
    const st = statusByDept.get(lower(e.department));
    const status = st?.status ?? 'no_status_row';
    const payable = status === 'ready' || status === 'locked';
    const inputs = Object.entries(e.kpi_data ?? {}).map(([key, value]) => {
      const rule = input.labelRule(e.department, key);
      return { key, label: rule?.label ?? key, value, how: rule?.how ?? null };
    });
    return {
      department: e.department,
      scored_as: e.employee_email,
      calculated_bonus: round2(num(e.calculated_bonus)),
      period_status: status,
      payable,
      locked_by: st?.locked_by ?? null,
      is_manager: !!e.is_manager,
      inputs,
      last_saved_at: e.updated_at ?? e.created_at ?? null,
    };
  });

  const catalog = input.catalog_applied.map((r) => ({
    department: r.department,
    scored_as: r.employee_email,
    bonus_name: r.bonus_name,
    kind: r.kind,
    cadence: r.cadence ?? null,
    inputs: r.vars ?? {},
    amount: round2(num(r.amount)),
    applied_by: r.applied_by,
    last_saved_at: r.updated_at ?? r.created_at ?? null,
  }));

  const explained = round2(
    hsl.filter((h) => h.payable).reduce((a, h) => a + h.calculated_bonus, 0) +
      catalog.reduce((a, c) => a + c.amount, 0),
  );
  const notPayable = round2(hsl.filter((h) => !h.payable).reduce((a, h) => a + h.calculated_bonus, 0));

  const snap = input.snapshot;
  const shownSnapshot = snap
    ? {
        snapshot_saved_at: snap.updated_at,
        perfect_attendance_bonus: round2(num(snap.perfectAttendanceBonus)),
        tech_bonus: round2(num(snap.techBonus)),
        other_bonuses: round2(num(snap.otherBonuses)),
        accounting_adjustment: round2(num(snap.adjustment)),
        accounting_adjustment_note: snap.adjustmentNote ?? null,
        pay_before_bonuses: snap.initial == null ? null : round2(num(snap.initial)),
        final_pay: snap.final == null ? null : round2(num(snap.final)),
      }
    : null;

  // The wizard snapshot is the figure Accounting is looking at; the paystub's
  // "Performance" line is the same number once staged. Snapshot first.
  const shownOther: number | null = shownSnapshot
    ? shownSnapshot.other_bonuses
    : input.paystub
      ? round2(input.paystub.performanceBonus)
      : null;
  const delta = shownOther == null ? null : round2(shownOther - explained);
  const verdict: ReconciliationVerdict =
    shownOther == null ? 'no_shown_figure' : Math.abs(delta ?? 0) < 0.005 ? 'matches' : 'unexplained';

  const paid = input.dispatches.find((d) => d.status === 'paid') ?? input.dispatches[0] ?? null;

  const coverage: string[] = [...input.lookup_errors];
  const rowsCount = input.master_rows.length;
  const depts = [...new Set(input.master_rows.map((r) => r.department).filter((d): d is string => !!d))];
  const activeRows = input.master_rows.filter((r) => r.on_active_roster).length;
  const stamped = input.master_rows.filter((r) => r.off_boarded_at).length;
  let identityNote: string;
  if (rowsCount === 0) {
    identityNote = 'No global_master_list row matches this email — the person may be keyed under a different address; bonus rows are matched on the aliases listed.';
  } else if (rowsCount === 1) {
    identityNote = `One master row (${depts[0] ?? 'no department'})${stamped ? ', OFF-BOARDED' : activeRows ? ', on the active roster' : ', not on the active roster'}.`;
  } else {
    identityNote = `${rowsCount} master rows for one person, departments: ${depts.join(' · ')}. A duplicate identity sits in EVERY calculator its rows belong to, so the same person can be scored in ${depts.length} places for one week — check each source below before calling any of them wrong.${stamped ? ` ${stamped} of the rows carry an off-board stamp.` : ''}`;
  }

  if (!input.source_file) {
    coverage.push(`No Hubstaff upload names the week ${input.week.start}–${input.week.end}, so there is no Payroll Wizard snapshot, additions blob or paystub to read for it — only the calculator rows.`);
  } else if (!snap) {
    coverage.push(`The Payroll Wizard has not saved a final-pay snapshot for ${input.source_file} yet, so "what the HRIS shows" comes from the calculators alone; open the wizard on that week to produce one.`);
  }
  for (const h of hsl.filter((x) => !x.payable)) {
    coverage.push(`${h.department} ${input.week.start} is ${h.period_status.toUpperCase()} — scored ₱${h.calculated_bonus.toFixed(2)} but NOT submitted (ready/locked), so the wizard does not pay it and it is left out of the explained total.`);
  }
  if (verdict === 'unexplained') {
    coverage.push(
      `The stored bonus sources add up to ₱${explained.toFixed(2)} but the wizard shows ₱${(shownOther ?? 0).toFixed(2)} (difference ₱${(delta ?? 0).toFixed(2)}). KPI calculator and Payment Catalog saves are NOT audited — only the CURRENT stored value exists — so a figure changed after the snapshot cannot be recovered here. Compare snapshot_saved_at with each source's last_saved_at: a source saved LATER than the snapshot means the wizard has not been re-run since; a snapshot saved later means a source was edited and the value it held is gone. Manager banded bonuses and custom system bonuses are not itemised by this tool.`,
    );
  }
  if (hsl.length === 0 && catalog.length === 0) {
    coverage.push('No KPI calculator row (HSL or Payment Catalog) names any of these aliases for the week — a non-zero bonus shown for it would have to come from a manual wizard control or an adjustment, both listed under sources.');
  }

  return {
    email_checked: input.email,
    aliases_searched: input.aliases,
    week: { ...input.week, resolved_from: input.week_resolved_from, source_file: input.source_file },
    identity: { master_rows: input.master_rows, note: identityNote },
    shown: {
      wizard_snapshot: shownSnapshot,
      paystub: input.paystub,
      paid_dispatch: paid
        ? {
            status: paid.status,
            amount_php: paid.amount_php,
            system_bonus_php: paid.system_bonus_php,
            system_bonus_label: paid.system_bonus_label,
            sent_date: paid.sent_date,
            sent_by: paid.created_by,
          }
        : null,
    },
    sources: {
      hsl_kpi: hsl,
      payment_catalog: catalog,
      wizard_controls: input.wizard_controls,
      payroll_notes: input.payroll_notes.map((n) => ({
        worker: n.worker,
        adjustment: n.adjustment,
        note: n.notes,
        done: !!n.done,
        clerk: n.payroll_clerk ?? n.created_by,
        updated_at: n.updated_at,
      })),
    },
    reconciliation: {
      explained_other_bonuses: explained,
      shown_other_bonuses: shownOther,
      delta,
      verdict,
      not_payable_total: notPayable,
    },
    coverage_notes: coverage,
    field_notes:
      'shown.wizard_snapshot = what the Payroll Wizard computed for the week (its "Bonus" column): other_bonuses is EVERY earned bonus except PAB and Tech — HSL KPI + Payment Catalog department bonuses; accounting_adjustment is the signed Adj. column and is NOT a bonus. sources.hsl_kpi = the HSL KPI Calculator rows (one per department the person was scored in) with the inputs the manager typed; payable=false means the period is still a draft and the wizard ignores it. sources.payment_catalog = the non-HSL department calculators (e.g. Lead Gen: 1–9 appointments × ₱250, 10+ × ₱500). reconciliation.verdict "matches" = the sources fully explain the shown figure; "unexplained" = they do not, read coverage_notes. All amounts PHP.',
  };
}
