// READ-ONLY probe: the exact per-processor × reason cross-tab a "Monthly card →
// Open" modal would render, pooled per month. Nothing is written; no PII is
// printed — processor keys, reasons, counts and money only.
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config({ path: "c:/Users/Kane/Desktop/simple-hris/.env" });
dotenv.config({ path: "c:/Users/Kane/Desktop/simple-hris/.env.local" });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!url || !key) { console.log("Missing Supabase env vars"); process.exit(1); }
const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

const rows = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await supabase
    .from("app_settings").select("key, value")
    .like("key", "dispatch.cycle_closeout.%")
    .order("key", { ascending: true }).range(from, from + 999);
  if (error) { console.log("QUERY ERROR:", error.message); process.exit(1); }
  rows.push(...(data ?? []));
  if (!data || data.length < 1000) break;
}

const months = new Map();
for (const r of rows) {
  let rec; try { rec = JSON.parse(r.value); } catch { continue; }
  const mk = (rec.period_end ?? "").slice(0, 7);
  let m = months.get(mk);
  if (!m) { m = { cycles: 0, proc: new Map() }; months.set(mk, m); }
  m.cycles += 1;
  const get = (k) => {
    let p = m.proc.get(k);
    if (!p) { p = { paid: 0, usd: 0, php: 0, pending: 0, problem: 0, threshold: 0, owedUSD: 0, owedPHP: 0 }; m.proc.set(k, p); }
    return p;
  };
  for (const [k, v] of Object.entries(rec.byProcessor ?? {})) {
    const p = get(k); p.paid += v.count ?? 0; p.usd += v.usd ?? 0; p.php += v.php ?? 0;
  }
  for (const pe of rec.unpaid?.payees ?? []) {
    const k = (pe.processor ?? "").trim() || "unknown";
    const p = get(k);
    const reason = ["pending", "problem", "threshold"].includes(pe.reason) ? pe.reason : "pending";
    p[reason] += 1;
    p.owedUSD += pe.amountUSD ?? 0; p.owedPHP += pe.amountPHP ?? 0;
  }
}

for (const [mk, m] of [...months.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1))) {
  console.log(`\n═══ ${mk}   ${m.cycles} closed cycle(s)`);
  console.log("proc       paid    paid USD      paid PHP    pend  prob  thresh   owed PHP   settle%");
  const all = [...m.proc.entries()].sort((a, b) => b[1].paid - a[1].paid);
  let T = { paid: 0, usd: 0, php: 0, pending: 0, problem: 0, threshold: 0, owedPHP: 0 };
  for (const [k, p] of all) {
    const denom = p.paid + p.pending + p.problem + p.threshold;
    const rate = denom > 0 ? ((p.paid / denom) * 100).toFixed(2) + "%" : "—";
    console.log(
      `${k.padEnd(9)} ${String(p.paid).padStart(5)} ${p.usd.toFixed(2).padStart(11)} ${p.php.toFixed(2).padStart(13)} ` +
      `${String(p.pending).padStart(5)} ${String(p.problem).padStart(5)} ${String(p.threshold).padStart(7)} ` +
      `${p.owedPHP.toFixed(2).padStart(10)} ${rate.padStart(8)}`,
    );
    T.paid += p.paid; T.usd += p.usd; T.php += p.php;
    T.pending += p.pending; T.problem += p.problem; T.threshold += p.threshold; T.owedPHP += p.owedPHP;
  }
  const d = T.paid + T.pending + T.problem + T.threshold;
  console.log(
    `${"TOTAL".padEnd(9)} ${String(T.paid).padStart(5)} ${T.usd.toFixed(2).padStart(11)} ${T.php.toFixed(2).padStart(13)} ` +
    `${String(T.pending).padStart(5)} ${String(T.problem).padStart(5)} ${String(T.threshold).padStart(7)} ` +
    `${T.owedPHP.toFixed(2).padStart(10)} ${(d > 0 ? ((T.paid / d) * 100).toFixed(2) + "%" : "—").padStart(8)}`,
  );
  console.log(`   cross-check vs month card: paid=${T.paid} unpaid=${T.pending + T.problem + T.threshold} payable=${d}`);
}
