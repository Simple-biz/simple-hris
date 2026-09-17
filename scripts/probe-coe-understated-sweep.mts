/**
 * READ-ONLY sweep: which issued COEs understate the "Bonuses earned over the
 * last N pay cycles" line because the money was paid through the wizard's
 * Adj. column (`bonusOverrides`), which the COE deliberately excludes?
 *
 * Kane, 2026-09-17: "COE's are inaccurate because it's not inputting all the
 * bonus info ... missing her 25000 bonus ... Same for two others."
 *
 * For every COE request, reads the additions blob of each week inside that
 * request's own 4-completed-cycle window and reports any non-zero adjustment,
 * beside the Payroll Notes prose that explains it. Only SELECTs are issued.
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config();

const { createSupabaseServiceRoleClient } = await import("../src/lib/supabase/server");
const { selectAllPaged } = await import("../src/lib/supabase/select-all-paged");
const supabase = createSupabaseServiceRoleClient();
if (!supabase) { console.error("no client"); process.exit(1); }

const money = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2 });

// ── every COE request ────────────────────────────────────────────────────────
const { rows: reqs, error: reqErr } = await selectAllPaged<Record<string, any>>((from, to) =>
  supabase.from("document_requests").select("*").ilike("document_type", "%coe%")
    .order("requested_at", { ascending: false }).range(from, to),
);
if (reqErr) { console.error("document_requests:", reqErr); process.exit(1); }
console.log(`COE requests: ${reqs.length}`);
if (reqs[0]) console.log("columns:", Object.keys(reqs[0]).join(", "), "\n");

// ── every additions blob, newest weeks first ────────────────────────────────
const { rows: settings, error: setErr } = await selectAllPaged<{ key: string; value: string }>((from, to) =>
  supabase.from("app_settings").select("key, value")
    .like("key", "payroll.wizard.additions.%").order("key", { ascending: false }).range(from, to),
);
if (setErr) { console.error("app_settings:", setErr); process.exit(1); }

/** week end (YYYY-MM-DD) -> { file, overrides } */
const weeks: Array<{ end: string; start: string; file: string; overrides: Record<string, number> }> = [];
for (const s of settings) {
  const file = s.key.replace("payroll.wizard.additions.", "");
  const m = file.match(/(\d{4}-\d{2}-\d{2})_to_(\d{4}-\d{2}-\d{2})/);
  if (!m) continue;
  let parsed: any;
  try { parsed = JSON.parse(String(s.value)); } catch { continue; }
  const ov = (parsed?.bonusOverrides ?? {}) as Record<string, number>;
  weeks.push({ start: m[1], end: m[2], file, overrides: ov });
}
weeks.sort((a, b) => b.end.localeCompare(a.end));
console.log(`additions blobs with a dated week: ${weeks.length}\n`);

// ── payroll notes prose, keyed by worker+week ───────────────────────────────
const { rows: notes } = await selectAllPaged<Record<string, any>>((from, to) =>
  supabase.from("payroll_wizard_notes").select("worker_email, worker, week_start, adjustment, note, created_at")
    .order("created_at", { ascending: false }).range(from, to),
);
const noteFor = (email: string, weekStart: string) =>
  (notes ?? []).filter((n: any) =>
    String(n.worker_email ?? "").toLowerCase() === email && String(n.week_start ?? "").slice(0, 10) === weekStart);

console.log("=".repeat(104));
console.log("COEs whose window contains an adjustment the certificate did NOT count");
console.log("=".repeat(104));

let affected = 0;
for (const r of reqs) {
  const email = String(r.employee_email ?? r.requested_by ?? "").toLowerCase().trim();
  if (!email) continue;
  const issuedAt = String(r.signed_at ?? r.requested_at ?? "").slice(0, 10);
  if (!issuedAt) continue;
  // The COE counts the 4 most recent COMPLETED weeks as of the issue date.
  const completed = weeks.filter((w) => w.end < issuedAt).slice(0, 4);
  const hits = completed
    .map((w) => ({ w, amt: Number(w.overrides[email] ?? 0) }))
    .filter((h) => Number.isFinite(h.amt) && h.amt !== 0);
  if (hits.length === 0) continue;
  affected += 1;
  const window = completed.length
    ? `${completed[completed.length - 1].start} → ${completed[0].end}`
    : "(none)";
  console.log(`\n${email}  · ${String(r.status ?? "?")} · issued ${issuedAt} · window ${window}`);
  for (const h of hits) {
    const ns = noteFor(email, h.w.start);
    console.log(`    ${h.w.start}→${h.w.end}  adj ₱${money(h.amt).padStart(12)}   ${ns.length ? "" : "(no Payroll Notes row)"}`);
    for (const n of ns) console.log(`        note: adjustment=${JSON.stringify(n.adjustment)} note=${JSON.stringify(n.note)}`);
  }
}
console.log(`\n${affected} of ${reqs.length} COE requests affected.`);
console.log("\nDone — read-only, nothing written.");
