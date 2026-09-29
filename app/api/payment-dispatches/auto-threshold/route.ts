import { NextRequest, NextResponse } from "next/server";
import {
  insertPaymentDispatchBatch,
  type InsertPaymentDispatchInput,
} from "@/lib/supabase/payment-dispatches";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { selectAllPaged } from "@/lib/supabase/select-all-paged";
import {
  casUpdateAppSetting,
  getAppSettingStrict,
  getAppSettingWithMetaStrict,
  pulsePaymentsLive,
} from "@/lib/supabase/app-settings";
import { insertAuditLog, insertAuditLogs, type NewAuditLog } from "@/lib/supabase/audit-log";
import { auditFrom } from "@/lib/audit/context";
import { requireFeatureEdit } from "@/lib/auth/authorize-feature";
import { deniedResponse } from "@/lib/auth/authorize-email";
import { broadcastFromServer } from "@/lib/supabase/realtime-broadcast";
import { DISPATCH_SYNC_QUEUE_CHANGED, DISPATCH_SYNC_TOPIC } from "@/lib/payroll/dispatch-paid-toast";
import { manilaTodayIso } from "@/lib/payroll/manila-week";
import {
  AUTO_THRESHOLD_AUDIT_ACTION,
  AUTO_THRESHOLD_BANK_USED,
  AUTO_THRESHOLD_LIMIT_USD,
  AUTO_THRESHOLD_MAX_ROWS,
  AUTO_THRESHOLD_NOTE,
  autoFlaggedEmails,
  autoThresholdCreatedBy,
  autoThresholdRunKey,
  clearedThresholdEmails,
  isAutoThresholdRunStale,
  parseAutoThresholdCandidate,
  parseWizardLockedFlag,
  planAutoThreshold,
  type AutoThresholdCandidate,
  type AutoThresholdLedgerEvent,
  type AutoThresholdResponse,
  type AutoThresholdSkipReason,
} from "@/lib/payroll/auto-threshold";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface Body {
  cycle_id?: unknown;
  cycle_source_file?: unknown;
  cycle_period_start?: unknown;
  cycle_period_end?: unknown;
  rows?: unknown;
}

const NO_SKIPS: Record<AutoThresholdSkipReason, number> = {
  already_dispatched: 0,
  cleared: 0,
  already_auto: 0,
  duplicate: 0,
};

function reply(body: Partial<AutoThresholdResponse>, status = 200): NextResponse {
  const full: AutoThresholdResponse = {
    flagged: [],
    skipped: { ...NO_SKIPS },
    rejected: 0,
    error: null,
    ...body,
  };
  return NextResponse.json(full, { status });
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * Auto-Threshold — hold every pending payee under US$15.00 (Kane, 2026-09-29).
 *
 * Payment Dispatch posts the under-$15 rows of a FRESH live-week load here; this
 * route writes one `threshold` marker per person — the same row a clerk logs from
 * Mark Paid — so they leave Pending for the Threshold tab and stay owed on the
 * progress strip. See docs/features/payment-dispatch.md § Auto-Threshold.
 *
 * Refuses, rather than guesses, at every step:
 *  - edit on Payment Dispatch, the same gate as Mark Paid (a view-only load writes nothing);
 *  - only the LIVE week (`is_current`), and only while the wizard has it LOCKED;
 *  - every posted row re-validated by the shared rule (employee, wizard-priced, < $15);
 *  - nobody who has ANY dispatch row this week, nobody whose Threshold was cleared
 *    this week, nobody the rule already held this week — once per person per week;
 *  - one run at a time per week (an app_settings INSERT is the claim);
 *  - all markers in one INSERT, so a failure never leaves half the week held.
 * Any read it cannot make fails CLOSED: nothing is written.
 */
export async function POST(req: NextRequest) {
  const authz = await requireFeatureEdit("accounting", "payment_dispatch");
  if (!authz.ok) return deniedResponse(authz);
  const who = auditFrom(req, authz);

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return reply({ error: "Invalid JSON body" }, 400);
  }

  const sourceFile = str(body.cycle_source_file);
  const cycleId = str(body.cycle_id);
  if (!sourceFile || !cycleId) {
    return reply({ error: "cycle_source_file and cycle_id are required" }, 400);
  }
  if (!Array.isArray(body.rows)) return reply({ error: "rows must be an array" }, 400);
  if (body.rows.length > AUTO_THRESHOLD_MAX_ROWS) {
    return reply({ error: `At most ${AUTO_THRESHOLD_MAX_ROWS} rows per request` }, 400);
  }

  const candidates: AutoThresholdCandidate[] = [];
  let rejected = 0;
  for (const raw of body.rows) {
    const c = parseAutoThresholdCandidate(raw);
    if (c) candidates.push(c);
    else rejected += 1;
  }
  if (candidates.length === 0) return reply({ rejected });

  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return reply({ rejected, error: "Supabase client unavailable" }, 500);

  // ── Live week only ─────────────────────────────────────────────────────────
  // A past week is history: holding someone there would rewrite a closed record.
  const { data: current, error: currentErr } = await supabase
    .from("hubstaff_uploads")
    .select("id, source_file")
    .eq("is_current", true)
    .limit(1)
    .maybeSingle();
  if (currentErr) {
    return reply({ rejected, error: `Could not read the live week — nothing was flagged: ${currentErr.message}` }, 500);
  }
  const live = current as { id?: string; source_file?: string | null } | null;
  if (!live?.id || live.id !== cycleId || (live.source_file ?? "").trim() !== sourceFile) {
    return reply({ rejected, error: "Only the live pay week is auto-flagged — nothing was written." }, 409);
  }

  // ── Wizard lock ────────────────────────────────────────────────────────────
  // The amounts are the wizard's; while the week is unlocked they are still moving.
  let lockValue: string | null;
  try {
    lockValue = await getAppSettingStrict(`payroll.dispatch_lock.${sourceFile}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return reply({ rejected, error: `Could not read the wizard lock — nothing was flagged: ${msg}` }, 500);
  }
  if (!parseWizardLockedFlag(lockValue)) {
    return reply({ rejected, error: "The Payroll Wizard hasn't locked this week — nothing was flagged." }, 409);
  }

  // ── One run at a time per week ─────────────────────────────────────────────
  const runKey = autoThresholdRunKey(sourceFile);
  const claim = JSON.stringify({ by: who.user_name, at: new Date().toISOString() });
  const claimed = await claimRun(runKey, claim);
  if (claimed === "error") {
    return reply({ rejected, error: "Could not take the auto-Threshold lock — nothing was flagged." }, 500);
  }
  if (claimed === "busy") return reply({ rejected, busy: true });

  try {
    // ── Who has already been touched this week ───────────────────────────────
    const dispatched = await dispatchedEmailsForWeek(supabase, sourceFile, cycleId);
    if (dispatched.error) {
      return reply({ rejected, error: `Could not read this week's dispatches — nothing was flagged: ${dispatched.error}` }, 500);
    }
    const ledger = await ledgerEventsForWeek(supabase, sourceFile);
    if (ledger.error) {
      return reply({ rejected, error: `Could not read this week's Threshold history — nothing was flagged: ${ledger.error}` }, 500);
    }

    const plan = planAutoThreshold({
      candidates,
      dispatchedEmails: dispatched.emails,
      clearedEmails: clearedThresholdEmails(ledger.events),
      autoFlaggedEmails: autoFlaggedEmails(ledger.events),
    });
    if (plan.flag.length === 0) return reply({ rejected, skipped: plan.skipped });

    const periodStart = str(body.cycle_period_start);
    const periodEnd = str(body.cycle_period_end);
    const sentDate = manilaTodayIso();
    const createdBy = autoThresholdCreatedBy(who.user_name);
    const inputs: InsertPaymentDispatchInput[] = plan.flag.map((c) => ({
      cycle_id: cycleId,
      cycle_period_start: periodStart,
      cycle_period_end: periodEnd,
      cycle_source_file: sourceFile,
      recipient_email: c.recipient_email,
      recipient_name: c.recipient_name,
      processor: c.processor,
      bank_preferred_raw: c.bank_preferred_raw,
      amount_usd: c.amount_usd,
      amount_php: c.amount_php,
      amount_cop: c.amount_cop,
      // NOT NULL in the table. Nothing was sent, so there is no reference — an
      // honest blank, the same one Kolan/HiGlobe rows already store.
      transaction_id: "",
      bank_used: AUTO_THRESHOLD_BANK_USED,
      sent_date: sentDate,
      status: "threshold",
      note: AUTO_THRESHOLD_NOTE,
      payee_type: "employee",
      created_by: createdBy,
    }));

    const { rows, error: insertErr } = await insertPaymentDispatchBatch(inputs);
    if (insertErr) {
      return reply({ rejected, skipped: plan.skipped, error: `Could not flag the under-$15 payees: ${insertErr}` }, 500);
    }

    // ── Audit — one event per person held, AWAITED ──────────────────────────
    // These events are also the rule's once-per-week memory (`autoFlaggedEmails`),
    // so they are awaited with a per-row fallback, like the undo route's.
    const entries: NewAuditLog[] = rows.map((row) => ({
      ...who,
      action: AUTO_THRESHOLD_AUDIT_ACTION,
      resource: "payment_dispatches",
      resource_id: row.id,
      details: {
        recipient_email: row.recipient_email,
        recipient_name: row.recipient_name,
        processor: row.processor,
        amount_usd: row.amount_usd,
        amount_php: row.amount_php,
        amount_cop: row.amount_cop,
        status: row.status,
        rule: { limit_usd: AUTO_THRESHOLD_LIMIT_USD, strictly_under: true },
        values_source: plan.flag.find((c) => c.recipient_email === row.recipient_email)?.values_source ?? null,
        // Same shape as payment.dispatched so the cycle audit trail and the
        // ledger read (details->cycle->>source_file) both find these events.
        cycle: {
          cycle_id: row.cycle_id,
          source_file: row.cycle_source_file ?? null,
          period_start: row.cycle_period_start ?? null,
          period_end: row.cycle_period_end ?? null,
        },
      },
    }));
    let warning: string | null = null;
    const { error: auditErr } = await insertAuditLogs(entries);
    if (auditErr) {
      console.error("[auto-threshold] bulk audit insert failed — retrying per row", auditErr);
      let failed = 0;
      for (const entry of entries) {
        const { error: rowErr } = await insertAuditLog(entry);
        if (rowErr) failed += 1;
      }
      if (failed > 0) {
        warning = `${failed} of ${entries.length} Threshold holds were not written to the audit log.`;
      }
    }

    void pulsePaymentsLive();
    void broadcastFromServer(DISPATCH_SYNC_TOPIC, DISPATCH_SYNC_QUEUE_CHANGED, {
      sourceFile,
      ts: Date.now(),
    });

    return reply({
      rejected,
      skipped: plan.skipped,
      warning,
      flagged: rows.map((row) => ({
        email: row.recipient_email,
        name: row.recipient_name,
        processor: row.processor as AutoThresholdCandidate["processor"],
        amountUSD: Number(row.amount_usd),
        amountPHP: row.amount_php == null ? null : Number(row.amount_php),
      })),
    });
  } finally {
    await releaseRun(runKey, claim);
  }
}

/**
 * Take the per-week run lock. INSERT is the claim (the primary key refuses a
 * second one); a claim older than a minute belongs to a run that died and is
 * taken over by compare-and-swap, so a crash can never wedge the rule forever.
 */
async function claimRun(key: string, value: string): Promise<"ok" | "busy" | "error"> {
  const first = await casUpdateAppSetting(key, value, null);
  if (first.ok) return "ok";
  if (!first.conflict) return "error";
  let held: { value: string; updatedAt: string | null } | null;
  try {
    held = await getAppSettingWithMetaStrict(key);
  } catch {
    return "error";
  }
  if (!held) {
    const retry = await casUpdateAppSetting(key, value, null);
    return retry.ok ? "ok" : retry.conflict ? "busy" : "error";
  }
  let claimedAt: string | null = null;
  try {
    claimedAt = (JSON.parse(held.value) as { at?: string }).at ?? null;
  } catch {
    claimedAt = null;
  }
  if (!isAutoThresholdRunStale(claimedAt ?? held.updatedAt, Date.now())) return "busy";
  const takeover = await casUpdateAppSetting(key, value, held.updatedAt);
  return takeover.ok ? "ok" : takeover.conflict ? "busy" : "error";
}

/** Release OUR claim only — a takeover by a later run is left alone. */
async function releaseRun(key: string, value: string): Promise<void> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return;
  const { error } = await supabase.from("app_settings").delete().eq("key", key).eq("value", value);
  // A stuck claim only pauses the rule for a minute (it goes stale); say so, don't throw.
  if (error) console.error("[auto-threshold] could not release the run lock", error.message);
}

type ServiceClient = NonNullable<ReturnType<typeof createSupabaseServiceRoleClient>>;

/**
 * Everyone with ANY dispatch row this week, by file OR by cycle id — an arrears
 * leg carries `cycle_id: null`, and a row written before the file was stamped
 * carries only the id. Paged: a week passes 1,000 rows.
 */
async function dispatchedEmailsForWeek(
  supabase: ServiceClient,
  sourceFile: string,
  cycleId: string,
): Promise<{ emails: Set<string>; error: string | null }> {
  const emails = new Set<string>();
  const byFile = await selectAllPaged<{ id: string; recipient_email: string }>((from, to) =>
    supabase
      .from("payment_dispatches")
      .select("id, recipient_email")
      .eq("cycle_source_file", sourceFile)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to),
  );
  if (byFile.error) return { emails, error: byFile.error };
  const byId = await selectAllPaged<{ id: string; recipient_email: string }>((from, to) =>
    supabase
      .from("payment_dispatches")
      .select("id, recipient_email")
      .eq("cycle_id", cycleId)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to),
  );
  if (byId.error) return { emails, error: byId.error };
  for (const r of [...byFile.rows, ...byId.rows]) {
    const e = r.recipient_email?.trim().toLowerCase();
    if (e) emails.add(e);
  }
  return { emails, error: null };
}

/** This week's Threshold clears and the rule's own holds, from the audit log. */
async function ledgerEventsForWeek(
  supabase: ServiceClient,
  sourceFile: string,
): Promise<{ events: AutoThresholdLedgerEvent[]; error: string | null }> {
  const res = await selectAllPaged<{ id: string; action: string; details: Record<string, unknown> | null }>(
    (from, to) =>
      supabase
        .from("audit_log")
        .select("id, action, details")
        .in("action", ["payment.undone", AUTO_THRESHOLD_AUDIT_ACTION])
        .eq("details->cycle->>source_file", sourceFile)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to),
  );
  if (res.error) return { events: [], error: res.error };
  return { events: res.rows.map((r) => ({ action: r.action, details: r.details })), error: null };
}
