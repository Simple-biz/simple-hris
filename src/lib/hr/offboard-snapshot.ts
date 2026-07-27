import type { SupabaseClient } from "@supabase/supabase-js";
import { normEmail } from "@/lib/email/norm-email";
import { upsertAppSetting, getAppSetting } from "@/lib/supabase/app-settings";

/**
 * FINAL PAY SNAPSHOT — the database-side preservation of an offboarded
 * person's payment data, taken AT offboard time.
 *
 * Rationale: the Payroll Wizard can always pay a leaver's final check because
 * their Hubstaff hours live in immutable per-week uploads, and the KPI
 * calculators keep their bonus entries in their own tables. Bank details are
 * the one payment input with NO history: they live only on the live
 * `employee_ids` row, which external automation may tear down alongside the
 * Workspace account and which gets OVERWRITTEN when the person's work email is
 * recycled to a new hire. This module freezes that row (all bank/payout
 * columns, verbatim) into `app_settings` the moment the person is offboarded,
 * so Accounting can always answer "where do we send their last pay?" — no
 * schema migration needed, and no change to any n8n automation.
 *
 * Written by /api/hr/offboard (every dashboard/queue offboard goes through
 * it). One snapshot per work email; a re-hire's later offboard overwrites with
 * the fresh stint — the LATEST departure is the one whose final pay matters.
 */

/** app_settings key for a person's offboard snapshot. */
export function offboardSnapshotKey(workEmail: string): string {
  return `offboard.snapshot.${normEmail(workEmail) ?? workEmail.trim().toLowerCase()}`;
}

export interface OffboardSnapshot {
  v: 1;
  captured_at: string;
  off_boarded_at: string;
  reason: string | null;
  note: string | null;
  name: string | null;
  work_email: string;
  personal_email: string | null;
  departments: string[];
  start_date: string | null;
  /** Verbatim `employee_ids` rows matching the person's work/personal email at
   *  offboard time — bank account, routing, processor picks, payout emails,
   *  the lot. Empty when the person never had payment details on file. */
  employee_ids: Record<string, unknown>[];
}

export interface SnapshotInput {
  work_email: string;
  personal_email: string | null;
  name: string | null;
  departments: string[];
  start_date: string | null;
  reason: string | null;
  note: string | null;
  off_boarded_at: string;
}

/**
 * Capture the person's payment data into app_settings. Best-effort by design:
 * returns the stored snapshot (or null on any failure) and NEVER throws — a
 * snapshot hiccup must not block the offboard itself (the live rows are still
 * intact at this moment; the snapshot is insurance for later).
 */
export async function snapshotOffboardedBankInfo(
  supabase: SupabaseClient,
  input: SnapshotInput,
): Promise<OffboardSnapshot | null> {
  try {
    const emails = [input.work_email, input.personal_email]
      .map((e) => (e ?? "").trim())
      .filter((e) => e.length > 0);
    if (emails.length === 0) return null;

    // All employee_ids rows carrying any of the person's emails (either
    // column, case-insensitive). `select *` on purpose: bank columns have been
    // added over time (add_processor_fields / preferred_bank_slot migrations)
    // and the snapshot must keep whatever exists without a column list to
    // maintain.
    const ors = emails.flatMap((e) => [`work_email.ilike.${e}`, `personal_email.ilike.${e}`]);
    const { data, error } = await supabase.from("employee_ids").select("*").or(ors.join(","));
    if (error) {
      console.error(`[offboard-snapshot] employee_ids read failed for ${input.work_email}: ${error.message}`);
    }

    const snapshot: OffboardSnapshot = {
      v: 1,
      captured_at: new Date().toISOString(),
      off_boarded_at: input.off_boarded_at,
      reason: input.reason,
      note: input.note,
      name: input.name,
      work_email: input.work_email,
      personal_email: input.personal_email,
      departments: input.departments,
      start_date: input.start_date,
      employee_ids: (data ?? []) as Record<string, unknown>[],
    };

    const { error: writeErr } = await upsertAppSetting(
      offboardSnapshotKey(input.work_email),
      JSON.stringify(snapshot),
    );
    if (writeErr) {
      console.error(`[offboard-snapshot] write failed for ${input.work_email}: ${writeErr}`);
      return null;
    }
    return snapshot;
  } catch (e) {
    console.error(
      `[offboard-snapshot] threw for ${input.work_email}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  }
}

/** Read a person's offboard snapshot back (null when none was captured). */
export async function getOffboardSnapshot(workEmail: string): Promise<OffboardSnapshot | null> {
  try {
    const raw = await getAppSetting(offboardSnapshotKey(workEmail));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as OffboardSnapshot;
    return parsed && parsed.v === 1 ? parsed : null;
  } catch {
    return null;
  }
}
