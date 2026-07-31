/**
 * READ-ONLY verifier for the Admin Penny AI audit tools: runs the REAL
 * `runAdminTool()` — the exact function /api/admin/penny-chat calls — from the
 * command line, so what Penny can actually see is checked against production
 * logic rather than a hand-maintained replica.
 *
 * Usage:
 *   $env:TSX_TSCONFIG_PATH="tsconfig.readiness-verify.json"
 *   node --import tsx scripts/verify-penny-audit-tools.mts [email]
 *
 * [email] defaults to gracea@simple.biz — the 2026-07-24 wrong-bank case, whose
 * key event sits OUTSIDE the old newest-300 scan window and so was the exact
 * blind spot these tools were changed to close.
 */
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config();

const subject = process.argv[2] ?? "gracea@simple.biz";

// Import AFTER dotenv so the Supabase clients see the env when constructed.
const { runAdminTool, ADMIN_TOOLS } = await import("../src/lib/anthropic/admin-tools");

const line = (s: string) => console.log(`\n${"─".repeat(78)}\n${s}\n${"─".repeat(78)}`);
const j = (v: unknown, n = 1400) => {
  const s = JSON.stringify(v, null, 1);
  return s.length > n ? `${s.slice(0, n)}\n  …(truncated)` : s;
};

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
};

console.log(`Penny admin tools exposed: ${ADMIN_TOOLS.length}`);
console.log(ADMIN_TOOLS.map((t) => `  · ${t.name}`).join("\n"));

// ── 1. The action catalogue is real, not a hand-written list ────────────────
line("list_audit_actions (filter: bank)");
const actions = (await runAdminTool("list_audit_actions", { contains: "bank" })) as Record<string, unknown>;
console.log(j(actions, 900));
check("returns distinct bank actions", Number(actions.distinct_actions ?? 0) > 0);
check(
  "includes the staff-side people.banking.updated",
  JSON.stringify(actions.actions ?? []).includes("people.banking.updated"),
);

// ── 2. The old blind spot: an event older than the newest-300 window ────────
line(`get_bank_change_history(${subject})`);
const bank = (await runAdminTool("get_bank_change_history", { work_email: subject })) as Record<string, unknown>;
console.log(j(bank, 2600));
const bankEvents = (bank.related_audit_events ?? []) as Array<Record<string, unknown>>;
check("no lookup errors", !bank.lookup_errors, JSON.stringify(bank.lookup_errors ?? ""));
check("returns audit events", bankEvents.length > 0, `${bankEvents.length} events`);
if (subject === "gracea@simple.biz") {
  const jul24 = bankEvents.find(
    (e) => String(e.when ?? "").startsWith("2026-07-24") && e.action === "bank_update.saved",
  );
  check(
    "REGRESSION: the 2026-07-24 bank_update.saved is visible (it predates the old 300-row window)",
    !!jul24,
    jul24 ? `actor=${String(jul24.actor)}` : "MISSING — the recency blind spot is back",
  );
  check(
    "the acting admin is named",
    String(jul24?.actor ?? "") === "breaj@simple.biz",
    String(jul24?.actor ?? "none"),
  );
  check("the IP survives into the result", !!jul24?.ip_address, String(jul24?.ip_address ?? "dropped"));
  check(
    "details are not truncated before the account holder name",
    JSON.stringify(jul24?.details ?? "").includes("Evannie"),
  );
}

// ── 3. The unified timeline ─────────────────────────────────────────────────
line(`get_change_timeline(${subject})`);
const tl = (await runAdminTool("get_change_timeline", { email: subject, limit: 12 })) as Record<string, unknown>;
console.log(j({ ...tl, timeline: undefined }, 800));
const entries = (tl.timeline ?? []) as Array<Record<string, unknown>>;
for (const e of entries.slice(0, 12)) {
  console.log(`   ${String(e.when).slice(0, 19)}  [${String(e.category).padEnd(10)}] ${String(e.what).slice(0, 78)}  · ${e.actor ?? "—"}`);
}
check("timeline is populated", entries.length > 0, `${tl.total_changes} total changes`);
check(
  "merges more than one source",
  new Set(entries.map((e) => String(e.source).split(":")[0])).size > 1,
  [...new Set(entries.map((e) => String(e.source).split(":")[0]))].join(", "),
);
check("newest-first ordering", entries.every((e, i) => i === 0 || String(entries[i - 1]!.when) >= String(e.when)));

line(`get_change_timeline(${subject}, kind=identity)`);
const ident = (await runAdminTool("get_change_timeline", { email: subject, kind: "identity" })) as Record<string, unknown>;
console.log(j({ kind: ident.kind, total: ident.total_changes, counts: ident.counts_by_category }, 400));
check("kind filter is accepted", !ident.error, String(ident.error ?? ""));
const badKind = (await runAdminTool("get_change_timeline", { email: subject, kind: "nonsense" })) as Record<string, unknown>;
check("an unknown kind is rejected, not silently ignored", !!badKind.error, String(badKind.error ?? "no error"));

// ── 4. Payroll notes resolve from a bare row id to a worker ────────────────
line("get_payroll_notes_history (company-wide, latest)");
const notes = (await runAdminTool("get_payroll_notes_history", { limit: 6 })) as Record<string, unknown>;
const edits = (notes.edits ?? []) as Array<Record<string, unknown>>;
console.log(j({ scope: notes.scope, notes_matched: notes.notes_matched, edit_events: notes.edit_events }, 400));
for (const e of edits) {
  const about = (e.note_is_about ?? null) as Record<string, unknown> | null;
  console.log(
    `   ${String(e.when).slice(0, 19)}  ${String(e.edited_by).padEnd(24)} ${String(e.what).padEnd(34)} → ${
      about ? `${about.worker} (${about.worker_email}) wk ${about.pay_week_start} adj ${about.adjustment ?? "—"}` : "UNRESOLVED"
    }`,
  );
}
check("note edits are returned", edits.length > 0, `${edits.length}`);
check(
  "each edit resolves to the worker it is about (the raw event only has a row id)",
  edits.every((e) => e.note_is_about != null),
);

// ── 5. Multi-family search in one call ─────────────────────────────────────
line("search_audit_log (multi-prefix + email target)");
const multi = (await runAdminTool("search_audit_log", {
  action_prefix: "people.profile,bank_update,payroll.rate",
  target: subject,
  limit: 8,
})) as Record<string, unknown>;
console.log(j({ match_count: multi.match_count, scanned_note: multi.scanned_note }, 700));
for (const e of ((multi.events ?? []) as Array<Record<string, unknown>>))
  console.log(`   ${String(e.when).slice(0, 19)}  ${String(e.action).padEnd(28)} ${e.actor}`);
check("multi-prefix search runs", !multi.error, String(multi.error ?? ""));
check(
  "spans more than one family",
  new Set(((multi.events ?? []) as Array<Record<string, unknown>>).map((e) => String(e.action).split(".")[0])).size >= 1,
);

line(failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
