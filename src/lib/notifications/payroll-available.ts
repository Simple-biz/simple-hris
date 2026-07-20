import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { normEmail } from "@/lib/email/norm-email";
import { formatWeekHuman } from "@/lib/payroll/paystub-view";

/**
 * Fires the "salary ready to view" employee notification for a freshly uploaded
 * Hubstaff week. Called (best-effort) right after `replaceHubstaffHoursFromCsvText`
 * archives + promotes an upload in POST /api/hubstaff-hours — both the manual CSV
 * upload and the "Sync from Hubstaff" API path.
 *
 * Each employee in the uploaded batch gets one `payroll.available` notification
 * whose "Open Pay Stub" button opens the same statement the payroll.paid card
 * does (details.source_file → PayStubModal → the reconstructed/staged week; the
 * pre-launch SHOW_UNPAID_STAGED_PAYSTUBS gate makes unpaid weeks viewable).
 *
 * The crux is EMAIL RESOLUTION. `GET /api/employee-notifications` matches
 * `recipient_email` EXACTLY against the employee's normalized login (session)
 * email — it does NOT expand aliases on read. Hubstaff CSV rows, however, are
 * sometimes keyed on a gsuite alternate work email. So we reverse-map every
 * Hubstaff "Email" to the person's canonical Work Email (== their login) via the
 * Global Master List, exactly the inverse of `expandEmailAliases` in the route.
 * A Hubstaff email that resolves to no active employee (contractor / agency row
 * in the export) is skipped rather than left as a dead notification row.
 *
 * Idempotent per (recipient, source_file): a re-upload / correction of the same
 * week never double-notifies anyone already alerted, but a NEW person who first
 * appears in a re-upload still gets their notification.
 */
export async function notifyPayrollAvailable(opts: {
  sourceFile?: string | null;
  uploadId: string;
}): Promise<{ inserted: number; skipped: number; matched: number }> {
  const zero = { inserted: 0, skipped: 0, matched: 0 };

  const sourceFile = opts.sourceFile?.trim() || null;
  // Without a source_file the "Open Pay Stub" button has no week to open, so the
  // notification would be inert — skip entirely.
  if (!sourceFile) return zero;

  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return zero;

  const hoursTable =
    process.env.NEXT_PUBLIC_SUPABASE_HUBSTAFF_HOURS_TABLE?.trim() || "hubstaff_hours";

  // ── 1. Collect the Hubstaff emails from JUST this upload ────────────────────
  const hubstaffEmails = new Set<string>();
  {
    const PAGE = 1000;
    let from = 0;
    while (true) {
      const { data, error } = await supabase
        .from(hoursTable)
        .select('"Email"')
        .eq("upload_id", opts.uploadId)
        .range(from, from + PAGE - 1);
      if (error) throw new Error(error.message);
      const page = (data ?? []) as Array<Record<string, unknown>>;
      for (const r of page) {
        const e = normEmail(typeof r["Email"] === "string" ? (r["Email"] as string) : null);
        if (e) hubstaffEmails.add(e);
      }
      if (page.length < PAGE) break;
      from += PAGE;
      if (from > 20_000) break; // safety — one weekly upload won't have >20k rows
    }
  }
  if (hubstaffEmails.size === 0) return zero;

  // ── 2. Reverse alias map: any known email → canonical Work Email (login) ────
  // Inverse of expandEmailAliases in app/api/hubstaff-hours/route.ts. The
  // canonical login is the Work Email (falling back to Personal Email); every
  // other address on the row points at it so an alias resolves home.
  const aliasToLogin = new Map<string, string>();
  {
    const { data } = await supabase
      .from("active_employees")
      .select('"Work Email","Personal Email","Alternate Work Email","Alternate Work Email 2"');
    for (const raw of (data ?? []) as Array<Record<string, unknown>>) {
      const work = normEmail(typeof raw["Work Email"] === "string" ? (raw["Work Email"] as string) : null);
      const personal = normEmail(
        typeof raw["Personal Email"] === "string" ? (raw["Personal Email"] as string) : null,
      );
      const login = work ?? personal;
      if (!login) continue;
      const all = [
        raw["Work Email"],
        raw["Personal Email"],
        raw["Alternate Work Email"],
        raw["Alternate Work Email 2"],
      ]
        .map((v) => (typeof v === "string" ? normEmail(v) : null))
        .filter((v): v is string => !!v);
      for (const e of all) {
        // First writer wins so a shared/duplicate address doesn't flap between people.
        if (!aliasToLogin.has(e)) aliasToLogin.set(e, login);
      }
    }
  }

  // Resolve each Hubstaff email to a login email; skip the unresolvable.
  const recipients = new Set<string>();
  let skipped = 0;
  for (const e of hubstaffEmails) {
    const login = aliasToLogin.get(e);
    if (login) recipients.add(login);
    else skipped += 1;
  }
  const matched = recipients.size;
  if (recipients.size === 0) return { inserted: 0, skipped, matched };

  // ── 3. De-dupe against anyone already notified for THIS week ────────────────
  {
    const already = new Set<string>();
    const { data } = await supabase
      .from("employee_notifications")
      .select("recipient_email")
      .eq("type", "payroll.available")
      .eq("details->>source_file", sourceFile);
    for (const r of (data ?? []) as Array<{ recipient_email?: string | null }>) {
      const e = normEmail(r.recipient_email ?? null);
      if (e) already.add(e);
    }
    for (const e of already) recipients.delete(e);
  }
  if (recipients.size === 0) return { inserted: 0, skipped, matched };

  // ── 4. Build + bulk-insert the notifications ────────────────────────────────
  const week = parseWeekRange(sourceFile);
  const weekHuman = week ? formatWeekHuman(week.start, week.end) : "";
  const weekPhrase = weekHuman ? ` for ${weekHuman}` : "";

  const rows = [...recipients].map((recipient_email) => ({
    recipient_email,
    type: "payroll.available",
    tone: "positive",
    title: "Salary Ready to View",
    message: `Your salary${weekPhrase} is ready to view. Open your pay stub for the full breakdown.`,
    details: {
      source_file: sourceFile,
      week: week ? { start: week.start, end: week.end } : null,
    },
  }));

  const BATCH = 200;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const { error } = await supabase.from("employee_notifications").insert(batch);
    if (error) throw new Error(error.message);
    inserted += batch.length;
  }

  return { inserted, skipped, matched };
}

/** Pull the Sun→Sat ISO date range out of a weekly-summary filename, if present. */
function parseWeekRange(filename: string): { start: string; end: string } | null {
  const m = /(\d{4}-\d{2}-\d{2})_to_(\d{4}-\d{2}-\d{2})/.exec(filename);
  return m ? { start: m[1], end: m[2] } : null;
}
