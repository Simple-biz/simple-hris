/**
 * HRIS vs NPD → **Why**: the reason under every row that needs a look.
 *
 * Kane, 2026-10-06: "Not in HRIS - Lets add the reason why they arent in HRIS please it could be
 * that they were excluded from Configuration or something else - and if its not in NPD, find an
 * appropriate reason why they arent there - and for the Mismatch, lets find a way where we can
 * check what could that reason be like if they lack their PAB, Tech Bonus, KPI or whatever be
 * smart about this". Rules: docs/features/payroll-wizard-hris-vs-npd.md § Why.
 *
 * PURE: the wizard hands in what it already holds (the comparison, the parsed NPD text, HRIS's
 * paystubs for the rows with an issue, per-person facts, this week's Hubstaff addresses) plus the
 * roster lookup for the Not in HRIS addresses; this decides every line. No fetch, no React.
 *
 * ── What this file promises ────────────────────────────────────────────────
 * **It explains; it never decides.** Verdicts, figures, counts and totals are `compareHrisNpd`'s
 * and nothing here can move one. A reason that names the person behind a personal email is NOT a
 * join (Kane, 2026-09-30: the join is the work email, exactly): both rows stay what they are.
 *
 * **Three strengths, never blurred** (`HrisNpdReasonTone`):
 *   - `found`  — a fact from HRIS's own records: offboarded on a date, no Hubstaff hours, paid in
 *                COP, NPD's line for them was skipped, the address is their personal email.
 *   - `likely` — an inference that reproduces NPD's figure to the cent: the gap equals a line of
 *                HRIS's paystub (or several), or NPD's figure is HRIS's pesos at another rate.
 *   - `lead`   — a pointer worth checking, not a finding.
 *   - `pending`— the roster lookup it depends on has not answered yet.
 * **NPD's own columns are never read here.** The step reads two NPD columns only, Work Email and
 * PHP USD Conversion (npd-dashboard.md § Read by the HRIS vs NPD step; kept by Kane 2026-10-06,
 * session log item 368). So a Mismatch is explained from HRIS's side: which of its paystub lines,
 * left out, would give exactly NPD's figure. That is why such a line is `likely`, never `found`.
 *
 * **No reason while the verdicts are held.** A ₱0.00 bonus is only safe to call "no bonus" once
 * every Net input has landed (§ No verdict before the figures can be judged), so a held output
 * has no reasons at all.
 *
 * **A failed lookup is not "no one".** A roster lookup that failed says so; it never turns into
 * "not on the roster" (the wizard's rule: a failed read is not absence).
 */

import { normEmail } from '@/lib/email/norm-email';

import type { HrisNpdComparison, HrisNpdRow, NpdPasteParse } from './hris-npd-compare';
import type { NpdIdentityLookup, NpdIdentityMatch } from './hris-npd-identity';
import { formatPhp, type PayStubView } from './paystub-view';

export type HrisNpdReasonTone = 'found' | 'likely' | 'lead' | 'pending';

export interface HrisNpdReason {
  tone: HrisNpdReasonTone;
  text: string;
}

/** By `HrisNpdRow.key`. A row with nothing to say (a Match, a held row) has no entry. */
export type HrisNpdReasons = ReadonlyMap<string, readonly HrisNpdReason[]>;

/** What the wizard knows about one payable HRIS person this week (by normalized work email). */
export interface HrisNpdPersonFacts {
  /** The department the wizard pays them in, by name. */
  department: string | null;
  /** HSL is on NPD's HSL tab; everyone else on All Departments. */
  isHsl: boolean;
  totalHours: number;
  regularHours: number;
  otHours: number;
  regularRate: number | null;
  otRate: number | null;
  /** HSL's sheet form: OT is a 0.5× differential on top of base, not 1.5×. */
  otIsDifferential: boolean;
  salaried: boolean;
  /** Why a salaried week is held (its label), or null. */
  salaryHeld: string | null;
  /** Their first-ever Hubstaff hours are in this week. */
  firstPaycheck: boolean;
  /** The master "Start Date" cell, verbatim. */
  startDate: string | null;
  /** A leaver on their final check (the wizard's final-pay overlay), or null. */
  finalPay: { offboardedAt: string | null } | null;
  /** Paid in another currency than PHP ('COP'), or null. */
  settlement: string | null;
}

/** The roster lookup for the Not in HRIS addresses (`POST /api/payroll-wizard/npd-identities`). */
export type HrisNpdIdentityState =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; byEmail: NpdIdentityLookup };

/** The staged paystubs by normalized work email (one per payable Validation row). */
export type HrisNpdReasonPaystubs = ReadonlyMap<string, readonly PayStubView[]>;

export interface ExplainHrisNpdInput {
  comparison: HrisNpdComparison;
  /** The SAME parse the comparison read: its per-line figures and its refused lines. */
  parse: NpdPasteParse;
  /** The text that parse came from, for line labels ("HSL row 40" on a feed, "line 12" on a paste). */
  sourceText: string;
  /** This cycle's USD→PHP rate. */
  fxRate: number;
  /** Payable HRIS people, by normalized work email. */
  facts: ReadonlyMap<string, HrisNpdPersonFacts>;
  /** HRIS's paystubs for the Mismatch rows (others may be absent). */
  paystubs: HrisNpdReasonPaystubs;
  identities: HrisNpdIdentityState;
  /** Every normalized address with a row in this week's Hubstaff timesheet. */
  timesheetEmails: ReadonlySet<string>;
  /** The pay week's first day (YYYY-MM-DD), to say "before this week". */
  weekStart: string | null;
}

// ─── Formatting ──────────────────────────────────────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `2026-09-24T12:59:16Z` → `Sep 24, 2026`, from the stored date, no time zone guessing. */
export function reasonDate(iso: string | null): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? '');
  if (!m) return null;
  const month = MONTHS[Number(m[2]) - 1];
  return month ? `${month} ${Number(m[3])}, ${m[1]}` : null;
}

function usd(cents: number): string {
  const abs = Math.abs(cents);
  const s = `$${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`;
  return cents < 0 ? `-${s}` : s;
}

function signedPhp(n: number): string {
  return n < 0 ? `-${formatPhp(-n)}` : formatPhp(n);
}

const hrs = (h: number) => `${(Math.round(h * 100) / 100).toFixed(2)}h`;
const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);

function listOr(items: readonly string[], word: 'and' | 'or'): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} ${word} ${items[items.length - 1]}`;
}

// ─── HRIS's paystub, as lines ────────────────────────────────────────────────

/** One signed line of a paystub: what it adds to (or takes from) the Net. */
export interface PaystubLine {
  label: string;
  /** Signed pesos, as it moves the Net. */
  php: number;
  /** An hours or salary line: only ever tried alone, never in a combination. */
  base: boolean;
}

const isZero = (n: number) => Math.abs(n) < 0.005;

/**
 * A paystub's money lines, with the statement's labels (`PayStubStatement.tsx`, the same words
 * Export CSV's Notes use). Lines on ₱0.00 are not lines.
 */
export function paystubLines(v: PayStubView): PaystubLine[] {
  const out: PaystubLine[] = [];
  const push = (label: string, php: number, base = false) => {
    if (!isZero(php)) out.push({ label, php, base });
  };
  if (v.salary) {
    push('Salary', v.mfPay, true);
  } else {
    push(v.otIsDifferential ? 'M-F Hours' : 'Regular Hours', v.weekdayPay ?? v.mfPay, true);
    push(v.otIsDifferential ? 'OT Differential' : 'Overtime', v.weekdayOtPay ?? v.otPay);
    if (v.hasWeekend) push('Weekend Hours', v.weekendPay);
  }
  push('Time Adjustment', v.timeAdjustment?.payPhp ?? 0);
  push('Tech Allowance', v.techBonus);
  push('Attendance Incentive', v.attendanceBonus);
  push('Performance Bonus (KPI)', v.performanceBonus);
  push(v.adjustmentNote ? `Adjustment (${v.adjustmentNote})` : 'Adjustment', v.adjustment);
  push('Orphanage', v.orphanagePay);
  push('MESA Reimbursement', v.mesaDisbursement);
  push('MESA Deduction', -Math.abs(v.mesaDeduction));
  return out;
}

const BONUS_LINES: ReadonlyArray<[keyof PayStubView, string]> = [
  ['techBonus', 'Tech Allowance'],
  ['attendanceBonus', 'Attendance Incentive'],
  ['performanceBonus', 'Performance Bonus (KPI)'],
];

/**
 * The smallest sets of paystub lines that, left out of HRIS's pesos, give exactly NPD's figure
 * at this cycle's rate (within `tolCents`). Up to three lines; an hours or salary line is only
 * ever tried on its own. Every set of the smallest size that fits is returned, so an ambiguous
 * gap (a ₱500 Tech Allowance and a ₱500 KPI) is said as "one of".
 */
export function linesExplainingGap(
  lines: readonly PaystubLine[],
  hrisPhp: number,
  npdCents: number,
  fxRate: number,
  tolCents: number,
): PaystubLine[][] {
  if (!(fxRate > 0)) return [];
  const fits = (set: readonly PaystubLine[]) => {
    const left = set.reduce((s, l) => s + l.php, 0);
    return Math.abs(Math.round(((hrisPhp - left) / fxRate) * 100) - npdCents) <= tolCents;
  };
  const extras = lines.filter((l) => !l.base);
  const sized: PaystubLine[][][] = [
    lines.map((l) => [l]),
    [],
    [],
  ];
  for (let i = 0; i < extras.length; i += 1) {
    for (let j = i + 1; j < extras.length; j += 1) {
      sized[1].push([extras[i], extras[j]]);
      for (let k = j + 1; k < extras.length; k += 1) sized[2].push([extras[i], extras[j], extras[k]]);
    }
  }
  for (const sets of sized) {
    const hit = sets.filter(fits);
    if (hit.length > 0) return hit;
  }
  return [];
}

const lineWithAmount = (l: PaystubLine) => `${l.label} ${signedPhp(l.php)}`;

/** HRIS's three bonus lines this week, summed over its paystubs: "no Tech Allowance · Attendance
 *  Incentive ₱4,950.00 · Performance Bonus (KPI) ₱2,500.00", to hold against NPD's columns. */
function hrisBonusSummary(stubs: readonly PayStubView[]): string {
  return BONUS_LINES.map(([k, label]) => {
    const sum = stubs.reduce((acc, s) => acc + (s[k] as number), 0);
    return isZero(sum) ? `no ${label}` : `${label} ${signedPhp(sum)}`;
  }).join(' · ');
}

/**
 * How close an inference must land on NPD's figure to be called "likely": one cent. Deliberately
 * NOT the operator's "off by" setting, which decides a match; a looser bar here would let a
 * coincidence pass as a cause.
 */
export const INFER_TOL_CENTS = 1;

// ─── The rows ────────────────────────────────────────────────────────────────

interface Ctx {
  input: ExplainHrisNpdInput;
  fx: number;
  tolCents: number;
  /** HRIS rows by normalized work email. */
  hrisRowByEmail: Map<string, HrisNpdRow>;
  /** Not in NPD rows NPD listed under another of the person's addresses: HRIS email → that NPD row. */
  pairByHris: Map<string, { npdAddress: string; how: string }>;
  /** Refused NPD lines by the address on them. */
  refusalsByEmail: Map<string, Array<{ label: string; reason: string }>>;
  /** Paste/feed line number → its figure (cents) and label. */
  npdLines: Map<number, { cents: number; label: string }>;
  lineLabel: (line: number) => string;
  /** 2dp rate → how many Mismatch rows reproduce NPD exactly at it (`fxClusters`). */
  fxClusters: Map<string, number>;
  /** Per non-PHP currency: how many payable people are paid in it, and how many of them NPD lists. */
  settlementCounts: Map<string, { paid: number; inNpd: number }>;
}

const FEED_ROW_LABEL = /^(All Departments|HSL) row \d+$/;

function lineLabeler(sourceText: string): (line: number) => string {
  const lines = sourceText.split(/\r?\n/);
  return (line) => {
    const first = (lines[line - 1] ?? '').split('\t', 1)[0]?.trim() ?? '';
    return FEED_ROW_LABEL.test(first) ? first : `line ${line}`;
  };
}

const HOW: Record<NpdIdentityMatch['matchedBy'], string> = {
  work: 'work email',
  personal: 'personal email',
  alternate: 'alternate work email',
};

function personEmails(matches: readonly NpdIdentityMatch[]): Set<string> {
  const out = new Set<string>();
  for (const m of matches) {
    for (const e of [m.workEmail, m.personalEmail, ...m.alternateEmails]) {
      const n = normEmail(e);
      if (n) out.add(n);
    }
  }
  return out;
}

function personName(m: NpdIdentityMatch): string {
  return m.name ?? m.workEmail ?? 'this person';
}

/** Edit distance, capped: anything above `cap` returns `cap + 1`. */
function editDistance(a: string, b: string, cap: number): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > cap) return cap + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** The one Not in NPD address within two letters of `addr` on the same domain, or null. */
function likelyTypo(addr: string, ctx: Ctx): { email: string; distance: number } | null {
  const at = addr.lastIndexOf('@');
  const domain = addr.slice(at);
  let best: { email: string; distance: number } | null = null;
  let tie = false;
  for (const r of ctx.input.comparison.rows) {
    if (r.status !== 'not_in_npd') continue;
    const e = normEmail(r.workEmail);
    if (!e || !e.endsWith(domain)) continue;
    const d = editDistance(addr, e, 2);
    if (d > 2) continue;
    if (!best || d < best.distance) {
      best = { email: e, distance: d };
      tie = false;
    } else if (d === best.distance) {
      tie = true;
    }
  }
  return best && !tie ? best : null;
}

function explainNotInHris(row: HrisNpdRow, ctx: Ctx): HrisNpdReason[] {
  const addr = normEmail(row.workEmail);
  const out: HrisNpdReason[] = [];
  const zero: HrisNpdReason[] = row.npdCents === 0 ? [{ tone: 'lead', text: "NPD's figure for them is $0.00." }] : [];
  const ids = ctx.input.identities;
  if (!addr) return zero;
  if (ids.state === 'loading') return [{ tone: 'pending', text: 'Looking this address up in HRIS…' }, ...zero];
  if (ids.state === 'error') {
    out.push({ tone: 'lead', text: `Couldn't check HRIS's roster for this address: ${ids.message}` });
    if (!ctx.input.timesheetEmails.has(addr)) out.push({ tone: 'found', text: 'No Hubstaff hours this week under this address.' });
    return [...out, ...zero];
  }
  const matches = ids.byEmail[addr];
  if (!matches) return [{ tone: 'pending', text: 'Looking this address up in HRIS…' }, ...zero];

  if (matches.length === 0) {
    out.push({ tone: 'found', text: 'No one in HRIS has this address: it is not on the roster, active or offboarded.' });
    const typo = likelyTypo(addr, ctx);
    if (typo) {
      out.push({
        tone: 'lead',
        text: `Did NPD mean ${typo.email}? It is ${typo.distance} ${plural(typo.distance, 'letter')} off and shows as Not in NPD.`,
      });
    }
    return [...out, ...zero];
  }

  const best = matches[0];
  const name = personName(best);
  const theirs = personEmails(matches);

  // The person is in HRIS under another of their addresses.
  for (const e of theirs) {
    if (e === addr) continue;
    const pair = ctx.hrisRowByEmail.get(e);
    if (!pair) continue;
    const how = HOW[matches.find((m) => m.matchedBy !== 'work')?.matchedBy ?? best.matchedBy];
    out.push({
      tone: 'found',
      text:
        pair.status === 'not_in_npd'
          ? `This is ${name}'s ${how}. HRIS pays them as ${pair.workEmail}, which shows as Not in NPD: NPD used the wrong address.`
          : `This is ${name}'s ${how}. NPD also lists them as ${pair.workEmail}, so this line looks like a second entry for the same person.`,
    });
    return [...out, ...zero];
  }

  const hoursUnder = [...theirs].filter((e) => ctx.input.timesheetEmails.has(e));
  const active = matches.find((m) => m.offboardedAt == null);
  if (!active) {
    const when = reasonDate(best.offboardedAt);
    const before =
      best.offboardedAt && ctx.input.weekStart && best.offboardedAt.slice(0, 10) < ctx.input.weekStart ? ', before this week' : '';
    out.push({
      tone: 'found',
      text: `${name} was offboarded${when ? ` ${when}` : ''}${best.offboardedReason ? ` (${best.offboardedReason})` : ''}${before}.`,
    });
    out.push(
      hoursUnder.length === 0
        ? { tone: 'found', text: 'No Hubstaff hours this week under any of their addresses, so HRIS has nothing to pay them.' }
        : { tone: 'lead', text: `They do have Hubstaff hours this week (${hoursUnder.join(', ')}). Check the Final Pay table.` },
    );
    return [...out, ...zero];
  }

  const dept = active.department ? `${active.department}` : 'no department';
  if (hoursUnder.length === 0) {
    out.push({
      tone: 'found',
      text: `${name} is on the roster (${dept}${active.startDate ? `, start date ${active.startDate}` : ''}) but has no Hubstaff hours this week under any of their addresses, so HRIS has nothing to pay.`,
    });
  } else {
    out.push({
      tone: 'lead',
      text: `${name} is on the roster (${dept}) and has Hubstaff hours this week (${hoursUnder.join(', ')}), but no payable row. Check the Final Pay table.`,
    });
  }
  return [...out, ...zero];
}

function explainNotInNpd(row: HrisNpdRow, ctx: Ctx): HrisNpdReason[] {
  const x = normEmail(row.workEmail);
  if (!x) return [];
  const f = ctx.input.facts.get(x);
  const out: HrisNpdReason[] = [];

  const pair = ctx.pairByHris.get(x);
  if (pair) {
    out.push({
      tone: 'found',
      text: `NPD lists them as ${pair.npdAddress} (their ${pair.how}), not their work email. That line shows as Not in HRIS.`,
    });
  }
  for (const r of ctx.refusalsByEmail.get(x) ?? []) {
    out.push({ tone: 'found', text: `NPD has a line for them that was skipped (${r.label}): ${r.reason}.` });
  }
  if (f?.settlement) {
    const c = ctx.settlementCounts.get(f.settlement);
    const none = c && c.inNpd === 0 ? ` NPD lists none of this week's ${c.paid} ${f.settlement}-paid ${plural(c.paid, 'person', 'people')}.` : '';
    out.push({ tone: 'found', text: `Paid in ${f.settlement}${f.settlement === 'COP' ? ' (Colombia)' : ''}.${none}` });
  }
  if (f?.finalPay) {
    const when = reasonDate(f.finalPay.offboardedAt);
    out.push({ tone: 'found', text: `Final paycheck: offboarded${when ? ` ${when}` : ''}. NPD may have taken them off already.` });
  }
  if (f?.firstPaycheck) {
    out.push({
      tone: 'found',
      text: `First paycheck: their first Hubstaff hours are this week${f.startDate ? ` (start date ${f.startDate})` : ''}. NPD may not have added them yet.`,
    });
  }
  if (row.hrisPhp != null && isZero(row.hrisPhp)) {
    const why = f?.salaryHeld ? ` (${f.salaryHeld})` : f && !f.salaried && f.regularRate == null ? ' (no pay rate on file)' : '';
    out.push({ tone: 'found', text: `HRIS pays ₱0.00 this week${why}, so there is nothing for NPD to list.` });
  } else if (f && !f.salaried && f.totalHours > 0 && f.totalHours < 2 && row.hrisPhp != null) {
    out.push({
      tone: 'lead',
      text: `Only ${hrs(f.totalHours)} this week (${formatPhp(row.hrisPhp)}). NPD may have left out a small payout.`,
    });
  }
  if (row.noPayoutRowCount > 0) {
    out.push({ tone: 'lead', text: 'No payout address on file, so Payment Dispatch skips them too.' });
  }
  if (ctx.input.identities.state === 'loading' && ctx.input.comparison.counts && ctx.input.comparison.counts.not_in_hris > 0 && !pair) {
    out.push({ tone: 'pending', text: 'Checking whether NPD lists them under another address…' });
  }
  if (!out.some((r) => r.tone === 'found' || r.tone === 'pending')) {
    const where = f ? ` HRIS pays them in ${f.department ?? 'no department'} (${f.salaried ? 'salaried' : hrs(f.totalHours)}).` : '';
    out.push({
      tone: 'lead',
      text: `NPD has no line for this work email.${where} Look for them on NPD's ${f?.isHsl ? 'HSL' : 'All Departments'} tab under another address or name.`,
    });
  }
  return out;
}

/** The 2dp rate NPD's figure reproduces HRIS's pesos at exactly, when it is near this cycle's. */
function impliedExactRate(row: HrisNpdRow, fx: number): number | null {
  if (row.hrisPhp == null || row.npdCents == null || row.hrisPhp <= 0 || row.npdCents <= 0) return null;
  const r2 = Math.round((row.hrisPhp / (row.npdCents / 100)) * 100) / 100;
  if (Math.abs(r2 - fx) < 0.005 || Math.abs(r2 - fx) > 1) return null;
  return Math.abs(Math.round((row.hrisPhp / r2) * 100) - row.npdCents) <= 1 ? r2 : null;
}

function explainMismatch(row: HrisNpdRow, ctx: Ctx): HrisNpdReason[] {
  const x = normEmail(row.workEmail);
  if (!x || row.deltaCents == null || row.npdCents == null || row.hrisPhp == null) return [];
  const hrisPhp = row.hrisPhp;
  const npdCents = row.npdCents;
  const f = ctx.input.facts.get(x);
  const fx = ctx.fx;
  const out: HrisNpdReason[] = [];
  const gapPhp = (row.deltaCents / 100) * fx;
  const dir = row.deltaCents > 0 ? 'higher' : 'lower';
  /** Would HRIS's pesos, moved by `deltaPhp`, give NPD's figure to the cent? The bar every
   *  "likely" below clears: INFER_TOL_CENTS, never the operator's looser match tolerance. */
  const reproduces = (deltaPhp: number) =>
    Math.abs(Math.round(((hrisPhp + deltaPhp) / fx) * 100) - npdCents) <= INFER_TOL_CENTS;

  if (npdCents === 0) out.push({ tone: 'found', text: "NPD's figure for them is $0.00." });
  // Another NPD line for them was refused, so NPD's figure here is missing it.
  for (const r of ctx.refusalsByEmail.get(x) ?? []) {
    out.push({ tone: 'found', text: `Another NPD line for them was skipped (${r.label}): ${r.reason}. NPD's figure here leaves it out.` });
  }

  // Several NPD lines added together, where one of them alone is HRIS's figure.
  if (row.npdLines.length > 1) {
    const per = row.npdLines.map((l) => ctx.npdLines.get(l) ?? { cents: NaN, label: ctx.lineLabel(l) });
    const labels = per.map((p) => p.label);
    const alone = row.hrisCents != null ? per.find((p) => Math.abs(p.cents - row.hrisCents!) <= ctx.tolCents) : undefined;
    out.push(
      alone
        ? {
            tone: 'found',
            text: `NPD lists them on ${per.length} lines (${listOr(labels, 'and')}), added together. ${alone.label} alone matches HRIS, so NPD looks to have them twice.`,
          }
        : {
            tone: 'lead',
            text: `NPD lists them on ${per.length} lines, added together: ${per.map((p) => `${p.label} ${Number.isFinite(p.cents) ? usd(p.cents) : '?'}`).join(' + ')}.`,
          },
    );
    if (alone) return out;
  }

  const stubs = ctx.input.paystubs.get(x) ?? [];
  const lines = stubs.flatMap(paystubLines);

  // 1. The gap is exactly a line (or two or three) of HRIS's paystub.
  if (lines.length > 0) {
    const sets = linesExplainingGap(lines, hrisPhp, npdCents, fx, INFER_TOL_CENTS);
    if (sets.length > 0 && sets.length <= 3) {
      const many = sets[0].length > 1;
      const said = sets.map((s) => listOr(s.map(lineWithAmount), 'and'));
      const size = Math.abs(sets[0].reduce((sum, l) => sum + l.php, 0));
      out.push({
        tone: 'likely',
        text:
          sets.length === 1
            ? `NPD is ${formatPhp(size)} ${dir}: exactly HRIS's ${said[0]}. NPD likely left ${many ? 'them' : 'it'} out.`
            : `NPD is ${formatPhp(size)} ${dir}: exactly HRIS's ${listOr(said, 'or')}. NPD likely left one of them out.`,
      });
      return out;
    }
  }

  // 2. A ₱100 MESA contribution NPD took and HRIS did not (mesa-contribution-suspension).
  if (reproduces(-100) && !lines.some((l) => l.label === 'MESA Deduction')) {
    out.push({
      tone: 'likely',
      text: 'NPD is ₱100.00 lower: the MESA contribution. HRIS deducts no MESA this week; NPD looks to have taken it.',
    });
    return out;
  }

  // 3. The same pesos at another rate, on three or more rows: NPD used another FX. One row alone
  //    proves nothing (on a small gap some nearby 2dp rate always reproduces NPD's figure), so it
  //    is never said; the ✗'s tooltip already gives that row's implied rate.
  const r2 = impliedExactRate(row, fx);
  const onRate = r2 != null ? (ctx.fxClusters.get(r2.toFixed(2)) ?? 1) : 0;
  if (r2 != null && onRate >= 3) {
    out.push({
      tone: 'likely',
      text: `The pesos agree: NPD converted at ₱${r2.toFixed(2)} per $1, not this cycle's ₱${fx.toFixed(2)} (${onRate} mismatched rows are on that rate).`,
    });
    return out;
  }

  // NPD pays a ROUND amount more (₱5,000, ₱2,500, ₱500): the shape of a bonus, so it is said as a
  // bonus lead before any hours or rate reading. Measured 2026-10-06 on the 09-27 week: a ₱5,000
  // monthly bonus at a ₱500/h rate read as "10.00h more" until this came first.
  const roundMore = row.deltaCents > 0 && Math.abs(gapPhp - Math.round(gapPhp / 100) * 100) <= (fx * 1.5) / 100;
  const bonusSummary = stubs.length > 0 ? ` HRIS pays: ${hrisBonusSummary(stubs)}.` : '';

  // 4. A different hourly rate, or different hours — hourly people only.
  if (f && !f.salaried && f.regularRate != null && f.regularRate > 0 && !(roundMore && stubs.length > 0)) {
    const rate = f.regularRate;
    // What ₱1/h more on the regular rate adds this week: OT is 1.5× (or, HSL's sheet form, base on
    // every hour plus a 0.5× differential past 40).
    const payHours = f.otIsDifferential ? f.totalHours + 0.5 * f.otHours : f.regularHours + 1.5 * f.otHours;
    if (payHours >= 5) {
      // Rates move in ₱5 steps; anything finer is too easy to hit by chance to call likely.
      const step = Math.round(gapPhp / payHours / 5) * 5;
      if (step !== 0 && reproduces(step * payHours)) {
        out.push({
          tone: 'likely',
          text: `Looks like a different hourly rate: NPD pays ${formatPhp(Math.abs(step))}/h ${dir} than HRIS's ${formatPhp(rate)}/h, over ${hrs(f.totalHours)}.`,
        });
        return out;
      }
    }
    // Different hours, priced the way the week is: regular to 40, overtime past it. So "2 hours
    // fewer" on a 42.29h week comes off overtime first, as it would on the timesheet.
    const otRate = f.otIsDifferential ? 1.5 * rate : (f.otRate ?? 1.5 * rate);
    const payAt = (t: number) => Math.min(t, 40) * rate + Math.max(t - 40, 0) * otRate;
    const h0 = f.totalHours;
    const tryHours = (d: number) => d !== 0 && h0 + d >= 0 && reproduces(payAt(h0 + d) - payAt(h0));
    let hit: number | null = null;
    for (let i = 1; i <= 5 && hit == null; i += 1) {
      for (const d of [-i / 100, i / 100]) if (hit == null && tryHours(d)) hit = d;
    }
    for (let q = 1; q <= 4 * 80 && hit == null; q += 1) {
      for (const d of [-q / 4, q / 4]) if (hit == null && tryHours(d)) hit = d;
    }
    if (hit != null) {
      const rounding = Math.abs(hit) <= 0.05;
      const said = `NPD pays for ${hrs(h0 + hit)}, HRIS for ${hrs(h0)} (${hrs(Math.abs(hit))} ${hit > 0 ? 'more' : 'fewer'})`;
      // NPD paying MORE has a second story that gives the same pesos past 40h: extra hours at the
      // plain rate, paid outside the timesheet (orphanage, a time adjustment). Measured 09-27:
      // 10.50h of orphanage at ₱355/h is exactly 7.00h more overtime. Two stories = a lead.
      const q = Math.round((gapPhp / rate) * 4) / 4;
      if (row.deltaCents > 0 && !rounding && Math.abs(q - hit) >= 0.25 && Math.abs(q) >= 0.25 && reproduces(q * rate)) {
        out.push({
          tone: 'lead',
          text: `NPD is ≈${formatPhp(gapPhp)} higher: either more hours (${said}), or ${hrs(q)} at their ${formatPhp(rate)}/h rate paid outside the timesheet (orphanage, a time adjustment).`,
        });
        return out;
      }
      out.push(
        rounding
          ? {
              // Not "NPD pays for 35.39h": measured 09-27, one of three such rows had the same hours on
              // both sides, so only the size is said, never whose hours moved.
              tone: 'likely',
              text: `A rounding-sized gap (≈${formatPhp(Math.abs(gapPhp))}, the pay for about ${hrs(Math.abs(hit))}): the two sides rounded hours or pay differently.`,
            }
          : { tone: 'likely', text: `Looks like an hours difference: ${said}.` },
      );
      return out;
    }
  }

  // 5. Leads, never findings. A round amount more: a bonus. Then whole quarter hours at their
  //    regular rate: hours paid outside the timesheet. Then any other amount more: a bonus. Last,
  //    nothing found, with HRIS's bonus lines to hold against NPD's.
  const bonusLead = (): HrisNpdReason => ({
    tone: 'lead',
    text: `NPD is ≈${formatPhp(gapPhp)} higher${roundMore ? ', a round amount like a bonus' : ''}.${bonusSummary} NPD may pay a bonus HRIS does not, or a bigger one.`,
  });
  if (roundMore && stubs.length > 0) {
    out.push(bonusLead());
    return out;
  }
  if (f && !f.salaried && f.regularRate != null && f.regularRate > 0) {
    const q = Math.round((gapPhp / f.regularRate) * 4) / 4;
    if (Math.abs(q) >= 0.25 && reproduces(q * f.regularRate)) {
      out.push({
        tone: 'lead',
        text: `NPD is ≈${formatPhp(Math.abs(gapPhp))} ${dir}: ${hrs(Math.abs(q))} at their ${formatPhp(f.regularRate)}/h rate. Hours paid outside the timesheet (orphanage, a time adjustment)?`,
      });
      return out;
    }
  }
  if (row.deltaCents > 0 && stubs.length > 0) {
    out.push(bonusLead());
    return out;
  }
  out.push({
    tone: 'lead',
    text: `NPD is ≈${formatPhp(Math.abs(gapPhp))} ${dir}, and no line of HRIS's paystub accounts for it.${
      stubs.length === 0 ? ' (No staged paystub to compare.)' : bonusSummary
    }`,
  });
  return out;
}

/**
 * Why each row that needs a look is what it is. Matches have no reason; a held output has none.
 */
export function explainHrisNpd(input: ExplainHrisNpdInput): HrisNpdReasons {
  const out = new Map<string, HrisNpdReason[]>();
  const { comparison } = input;
  if (comparison.hold || comparison.counts == null || !(input.fxRate > 0)) return out;

  const hrisRowByEmail = new Map<string, HrisNpdRow>();
  for (const r of comparison.rows) {
    const e = normEmail(r.workEmail);
    if (r.inHris && e) hrisRowByEmail.set(e, r);
  }

  const lineLabel = lineLabeler(input.sourceText);
  const npdLines = new Map<number, { cents: number; label: string }>();
  for (const r of input.parse.rows) npdLines.set(r.line, { cents: r.cents, label: lineLabel(r.line) });

  const refusalsByEmail = new Map<string, Array<{ label: string; reason: string }>>();
  for (const f of input.parse.refusals) {
    const label = lineLabel(f.line);
    const seen = new Set<string>();
    for (const cell of f.raw.split('\t')) {
      const e = normEmail(cell);
      if (!e || !e.includes('@') || seen.has(e)) continue;
      seen.add(e);
      const list = refusalsByEmail.get(e) ?? [];
      list.push({ label, reason: f.reason });
      refusalsByEmail.set(e, list);
    }
  }

  // A Not in HRIS address whose person HRIS pays under another address.
  const pairByHris = new Map<string, { npdAddress: string; how: string }>();
  if (input.identities.state === 'ready') {
    for (const r of comparison.rows) {
      if (r.status !== 'not_in_hris') continue;
      const addr = normEmail(r.workEmail);
      const matches = addr ? input.identities.byEmail[addr] : undefined;
      if (!addr || !matches || matches.length === 0) continue;
      const how = HOW[matches.find((m) => m.matchedBy !== 'work')?.matchedBy ?? matches[0].matchedBy];
      for (const e of personEmails(matches)) {
        if (e === addr) continue;
        const h = hrisRowByEmail.get(e);
        if (h && h.status === 'not_in_npd' && !pairByHris.has(e)) pairByHris.set(e, { npdAddress: r.workEmail, how });
      }
    }
  }

  const fxClusters = new Map<string, number>();
  for (const r of comparison.rows) {
    if (r.status !== 'mismatch') continue;
    const r2 = impliedExactRate(r, input.fxRate);
    if (r2 != null) fxClusters.set(r2.toFixed(2), (fxClusters.get(r2.toFixed(2)) ?? 0) + 1);
  }

  const settlementCounts = new Map<string, { paid: number; inNpd: number }>();
  for (const r of comparison.rows) {
    const e = normEmail(r.workEmail);
    const cur = e ? input.facts.get(e)?.settlement : null;
    if (!r.inHris || !cur) continue;
    const c = settlementCounts.get(cur) ?? { paid: 0, inNpd: 0 };
    c.paid += 1;
    if (r.inNpd) c.inNpd += 1;
    settlementCounts.set(cur, c);
  }

  const ctx: Ctx = {
    input,
    fx: input.fxRate,
    tolCents: comparison.toleranceCents,
    hrisRowByEmail,
    pairByHris,
    refusalsByEmail,
    npdLines,
    lineLabel,
    fxClusters,
    settlementCounts,
  };

  for (const r of comparison.rows) {
    const reasons =
      r.status === 'not_in_hris'
        ? explainNotInHris(r, ctx)
        : r.status === 'not_in_npd'
          ? explainNotInNpd(r, ctx)
          : r.status === 'mismatch'
            ? explainMismatch(r, ctx)
            : [];
    if (reasons.length > 0) out.set(r.key, reasons);
  }
  return out;
}

/** True while any row's reason waits on the roster lookup — Export CSV waits for it. */
export function hrisNpdReasonsPending(reasons: HrisNpdReasons): boolean {
  for (const list of reasons.values()) if (list.some((r) => r.tone === 'pending')) return true;
  return false;
}

/** The normalized addresses the roster lookup is asked about: every Not in HRIS row's. */
export function hrisNpdIdentityEmails(comparison: HrisNpdComparison): string[] {
  if (comparison.hold || comparison.counts == null) return [];
  const out = new Set<string>();
  for (const r of comparison.rows) {
    if (r.status !== 'not_in_hris') continue;
    const e = normEmail(r.workEmail);
    if (e) out.add(e);
  }
  return [...out].sort();
}

/** One reason as plain text, for the CSV: "Likely: …" / "Check: …" / the fact itself. */
export function reasonText(r: HrisNpdReason): string {
  return r.tone === 'likely' ? `Likely: ${r.text}` : r.tone === 'lead' ? `Check: ${r.text}` : r.text;
}
