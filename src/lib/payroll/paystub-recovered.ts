/**
 * Recovered-week snapshots for the Employee "Pay Stubs" tab — the persisted,
 * paystub-only cache of what the engine reconstructs for a pre-snapshot week.
 *
 * ## Why a SEPARATE key, and not `payroll.wizard.final_pay.<file>`
 *
 * The wizard's `final_pay` snapshot means "the exact net pay the wizard computed
 * on the day = what Payment Dispatch paid out". Payment Dispatch PRICES from it,
 * the wizard replays from it, and the Overview trusts it as take-home. An engine
 * run made today from today's rates table is none of those things (see the
 * `rate-updated-at-not-evidence` memory: the sheet silently re-prices history),
 * so it must never be written under that key.
 *
 * `paystub.recovered.<file>` is read by ONE consumer — the employee paystub
 * route's recovery tiers — and ONLY when a week has neither a wizard snapshot
 * nor a staged payload. It exists so the pre-launch weeks (Mar–May 2026) stop
 * costing a ~6-second whole-company engine run per week, per viewer, per open.
 * It carries the SAME figures those viewers already see today.
 *
 * ## Invariants
 *
 * - **Stamped with the Hubstaff upload batch** (`upload_id`). A re-upload of the
 *   same filename mints a new batch id; the snapshot then reads as `stale` and
 *   the route falls back to the engine exactly as before. A snapshot with no
 *   verifiable batch never matches — fail closed toward the engine.
 * - **Whole-company, whole-week.** Every engine entry with hours is stored, so a
 *   `match` with the caller ABSENT means "not in this week" (the same verdict the
 *   engine gives) and the route must NOT run the engine to double-check.
 * - **Built by one pure function** ({@link buildRecoveredEntry}) that mirrors the
 *   route's engine-only branch line for line, and produces an ITEMIZED
 *   {@link WizardFinalPayEntry}, so the route renders it through the same fast
 *   path a real wizard snapshot takes. The backfill script and the route share
 *   this module — there is no second copy of the arithmetic to drift.
 */
import type { CurrentPayEntry, CurrentPayResult } from "./current-pay";
import type { WizardFinalPayEntry } from "./paystub-recovery";

export const RECOVERED_SNAPSHOT_PREFIX = "paystub.recovered.";

export function recoveredSnapshotKey(sourceFile: string): string {
  return `${RECOVERED_SNAPSHOT_PREFIX}${sourceFile}`;
}

const round2 = (n: number) => Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;

/** The persisted value of `paystub.recovered.<file>`. */
export interface RecoveredWeekSnapshot {
  version: 1;
  source_file: string;
  /** `hubstaff_uploads.id` of the batch the engine read. Null = unknown, which
   *  never matches (see {@link readRecoveredSnapshot}). */
  upload_id: string | null;
  /** ISO timestamp of the engine run. */
  computed_at: string;
  /** USD to PHP the engine priced with (PHP per $1). */
  fx_rate: number;
  /** The engine's period for the file — preferred over filename dates. */
  period: { start: string | null; end: string | null };
  /** Keyed by the engine's canonical key: lowercased work email. */
  finals: Record<string, WizardFinalPayEntry>;
}

/* ───────── Additions blob (`payroll.wizard.additions.<file>`) ───────── */

export interface AdditionsBlob {
  bonusOverrides: Record<string, unknown>;
  bonusOverrideNotes: Record<string, unknown>;
  orphanageAmounts: Record<string, unknown>;
}

export interface AdditionsOverlay {
  /** Signed PHP accounting adjustment; 0 when none/unknown. */
  adjustment: number;
  /** Note for the adjustment; null when the adjustment is 0 or no note saved. */
  adjustmentNote: string | null;
  /** Orphanage pay folded into the total; 0 when none. */
  orphanage: number;
}

export const EMPTY_ADDITIONS_OVERLAY: AdditionsOverlay = {
  adjustment: 0,
  adjustmentNote: null,
  orphanage: 0,
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function toNumber(v: unknown): number {
  const n = typeof v === "string" ? Number(v) : (v as number);
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

/** Parse the additions blob ONCE; null when absent or malformed. */
export function parseAdditionsBlob(raw: string | null | undefined): AdditionsBlob | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<AdditionsBlob> | null;
    if (!isRecord(parsed)) return null;
    return {
      bonusOverrides: isRecord(parsed.bonusOverrides) ? parsed.bonusOverrides : {},
      bonusOverrideNotes: isRecord(parsed.bonusOverrideNotes) ? parsed.bonusOverrideNotes : {},
      orphanageAmounts: isRecord(parsed.orphanageAmounts) ? parsed.orphanageAmounts : {},
    };
  } catch {
    return null;
  }
}

/** Match a map keyed by any of the employee's emails (case-insensitive). The
 *  additions blob is keyed by the raw Hubstaff email, which may be the work OR
 *  personal address in any case, so try every known alias. */
export function pickByEmail<T>(map: Record<string, T>, emailsLower: string[]): T | undefined {
  for (const e of emailsLower) {
    if (Object.prototype.hasOwnProperty.call(map, e)) return map[e];
  }
  // Case-insensitive fallback (keys stored with original casing).
  const lc = new Map<string, T>();
  for (const [k, v] of Object.entries(map)) lc.set(k.trim().toLowerCase(), v);
  for (const e of emailsLower) {
    const v = lc.get(e);
    if (v !== undefined) return v;
  }
  return undefined;
}

/** This person's overlay from a parsed additions blob. */
export function pickAdditionsOverlay(
  blob: AdditionsBlob | null,
  emailsLower: string[],
): AdditionsOverlay {
  if (!blob) return EMPTY_ADDITIONS_OVERLAY;
  const adjustment = round2(toNumber(pickByEmail(blob.bonusOverrides, emailsLower)));
  const note = pickByEmail(blob.bonusOverrideNotes, emailsLower);
  const adjustmentNote = typeof note === "string" && note.trim() ? note.trim() : null;
  const orphanage = round2(toNumber(pickByEmail(blob.orphanageAmounts, emailsLower)));
  return {
    adjustment,
    // Only surface a note when there's actually an adjustment to annotate.
    adjustmentNote: adjustment !== 0 ? adjustmentNote : null,
    orphanage,
  };
}

/* ───────── Entry builder (mirrors the route's engine-only branch) ───────── */

/**
 * One employee's recovered figures for a week with NO wizard snapshot, as an
 * itemized {@link WizardFinalPayEntry}.
 *
 * Line-for-line the same arithmetic as the paystub route's "No snapshot at all"
 * branch: base pay from the engine, PAB/Tech from the engine, MESA deduction from
 * the engine, no disbursement, performance 0, and the Adjustment/Orphanage overlay
 * GATED on `hasRate` (the wizard drops both for no-rate employees). Total =
 * initial + PAB + Tech + adjustment + orphanage − MESA deduction.
 *
 * Returns null when the person is not in this week (no hours) — the route's own
 * "not in this week" rule, so an absent entry and a null entry mean the same.
 */
export function buildRecoveredEntry(
  workEmailLower: string,
  entry: CurrentPayEntry,
  overlay: AdditionsOverlay,
): WizardFinalPayEntry | null {
  if (!(entry.totalHours > 0)) return null;
  const hasRate = entry.hasRate;
  const regularPay = round2(entry.regularPayPHP ?? 0);
  const otPay = round2(entry.otPayPHP ?? 0);
  const initial = round2(entry.initialPayPHP ?? regularPay + otPay);
  const pab = round2(entry.pabBonusPHP ?? 0);
  const tech = round2(entry.techBonusPHP ?? 0);
  const mesaDeduction = round2(entry.mesaDeductionPHP ?? 0);
  const adjustment = hasRate ? round2(overlay.adjustment) : 0;
  const orphanagePay = hasRate ? round2(overlay.orphanage) : 0;
  const final = round2(initial + pab + tech + adjustment + orphanagePay - mesaDeduction);
  return {
    workEmail: workEmailLower,
    final,
    regularPay,
    otPay,
    regularHours: entry.regularHours,
    otHours: entry.otHours,
    totalHours: entry.totalHours,
    initial,
    mesaDeduction,
    mesaDisbursement: 0,
    perfectAttendanceBonus: pab,
    techBonus: tech,
    otherBonuses: 0,
    adjustment,
    orphanagePay,
  };
}

/**
 * The whole-company snapshot for one engine run. `aliasesOf` supplies each work
 * email's other addresses (personal, gsuite alternates) so the additions blob —
 * keyed by whichever Hubstaff email the clerk saw — still matches.
 */
export function buildRecoveredSnapshot(params: {
  result: CurrentPayResult;
  sourceFile: string;
  uploadId: string | null;
  computedAt: Date;
  additionsRaw: string | null;
  aliasesOf: (workEmailLower: string) => string[];
}): RecoveredWeekSnapshot {
  const blob = parseAdditionsBlob(params.additionsRaw);
  const finals: Record<string, WizardFinalPayEntry> = {};
  for (const [rawEmail, entry] of Object.entries(params.result.byEmail)) {
    const email = rawEmail.trim().toLowerCase();
    if (!email) continue;
    const aliases = params.aliasesOf(email).map((e) => e.trim().toLowerCase());
    const emails = [...new Set([email, ...aliases])].filter(Boolean);
    const built = buildRecoveredEntry(email, entry, pickAdditionsOverlay(blob, emails));
    if (built) finals[email] = built;
  }
  return {
    version: 1,
    source_file: params.sourceFile,
    upload_id: params.uploadId,
    computed_at: params.computedAt.toISOString(),
    fx_rate: params.result.fxRate,
    period: {
      start: params.result.period?.start ?? null,
      end: params.result.period?.end ?? null,
    },
    finals,
  };
}

/* ───────── Reader ───────── */

export type RecoveredLookup =
  /** No snapshot stored (or unparseable). */
  | { status: "absent" }
  /** A snapshot exists but for a different (or unknown) upload batch — ignore it. */
  | { status: "stale"; snapshotUploadId: string | null }
  /** Usable. `entry` null = this person was not in the week (no engine to run). */
  | {
      status: "match";
      entry: WizardFinalPayEntry | null;
      fxRate: number | null;
      period: { start: string | null; end: string | null };
      computedAt: string | null;
    };

/**
 * Read a stored snapshot for the caller. A match requires the stored batch id
 * and the CURRENT batch id to both be present and equal — an unverifiable batch
 * is treated as stale so the route falls back to the engine (today's behaviour).
 */
export function readRecoveredSnapshot(
  raw: string | null | undefined,
  emailsLower: string[],
  currentUploadId: string | null,
): RecoveredLookup {
  if (!raw) return { status: "absent" };
  let parsed: Partial<RecoveredWeekSnapshot> | null;
  try {
    parsed = JSON.parse(raw) as Partial<RecoveredWeekSnapshot> | null;
  } catch {
    return { status: "absent" };
  }
  if (!isRecord(parsed) || !isRecord(parsed.finals)) return { status: "absent" };
  const snapshotUploadId =
    typeof parsed.upload_id === "string" && parsed.upload_id ? parsed.upload_id : null;
  if (!snapshotUploadId || !currentUploadId || snapshotUploadId !== currentUploadId) {
    return { status: "stale", snapshotUploadId };
  }
  const finals = parsed.finals as Record<string, WizardFinalPayEntry>;
  const candidate = pickByEmail(finals, emailsLower);
  const entry =
    candidate && typeof candidate.final === "number" && Number.isFinite(candidate.final)
      ? candidate
      : null;
  const fxRate = typeof parsed.fx_rate === "number" && parsed.fx_rate > 0 ? parsed.fx_rate : null;
  const period = {
    start: typeof parsed.period?.start === "string" ? parsed.period.start : null,
    end: typeof parsed.period?.end === "string" ? parsed.period.end : null,
  };
  return {
    status: "match",
    entry,
    fxRate,
    period,
    computedAt: typeof parsed.computed_at === "string" ? parsed.computed_at : null,
  };
}
