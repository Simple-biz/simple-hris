// For one Hubstaff week, classify every person whose dated rate history CHANGES
// across their worked days:
//   WILL PRORATE — no individual catalog structure (history has always ruled), or
//     the structure matches the history's terminal rate (catalog-consistent →
//     both engines now prorate the week per day; re-lock reprices).
//   CONFLICT — the structure disagrees with the history's terminal rate. Both
//     engines keep the FLAT-at-catalog week (stale data must not blend), and
//     Accounting needs to align one side (usually: update the Payment Catalog
//     structure to the intended rate, or delete the bogus history row).
// Read-only. This is an audit approximation (regular rate only, no OT check).
// Usage: node scripts/audit-catalog-history-conflicts.mjs [source_file]
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
dotenv.config();
dotenv.config({ path: ".env.local" });

const SOURCE_FILE = (process.argv[2] || "").trim() || "simple-biz_daily_report_2026-07-19_to_2026-07-25.csv";
const WEEK_DATES = (() => {
  const m = SOURCE_FILE.match(/(\d{4})-(\d{2})-(\d{2})_to_(\d{4})-(\d{2})-(\d{2})/);
  if (!m) { console.error("source_file has no date range"); process.exit(1); }
  const start = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const keys = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const out = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    out.push([keys[d.getDay()], `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`]);
  }
  return out;
})();

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!url || !key) { console.error("missing supabase env"); process.exit(1); }
const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

/** PostgREST caps selects at 1000 rows — always page. */
async function pageAll(table, cols, filter) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    let q = sb.from(table).select(cols).range(from, from + 999);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) { console.error(table, error.message); break; }
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

const hub = await pageAll(
  "hubstaff_hours",
  '"Member", "Email", monday, tuesday, wednesday, thursday, friday, saturday, sunday',
  (q) => q.eq("source_file", SOURCE_FILE),
);
const histAll = await pageAll("employee_rate_history", "employee_email, regular_rate, effective_from");
const structs = await pageAll(
  "payment_catalog_pay_structures",
  "employee_email, regular_rate, currency, scope",
  (q) => q.eq("scope", "employee"),
);
console.log(`rows: hubstaff ${hub.length} | history ${histAll.length} | employee structures ${structs.length}`);

const catByEmail = new Map(structs.map((s) => [(s.employee_email || "").trim().toLowerCase(), s]));
const histBy = new Map();
for (const h of histAll) {
  const em = (h.employee_email || "").trim().toLowerCase();
  if (!histBy.has(em)) histBy.set(em, []);
  histBy.get(em).push(h);
}
const hms = (v) => {
  const p = String(v || "0:00:00").split(":").map(Number);
  return (p[0] || 0) * 3600 + (p[1] || 0) * 60 + (p[2] || 0);
};

const prorate = [];
const conflict = [];
for (const r of hub) {
  const em = (r["Email"] || "").trim().toLowerCase();
  const rows = (histBy.get(em) ?? []).sort((a, b) => String(b.effective_from).localeCompare(String(a.effective_from)));
  if (!rows.length) continue;
  const worked = WEEK_DATES.filter(([k]) => hms(r[k]) > 0).map(([, d]) => d);
  if (!worked.length) continue;
  const resolve = (d) => rows.find((h) => String(h.effective_from).slice(0, 10) <= d);
  const rates = worked.map((d) => {
    const x = resolve(d);
    return x ? Number(x.regular_rate) : NaN;
  });
  const distinct = [...new Set(rates.filter(Number.isFinite))];
  if (distinct.length < 2) continue; // single resolved rate — nothing to split
  const term = rates[rates.length - 1];
  const cat = catByEmail.get(em);
  if (!cat) {
    prorate.push([r["Member"], em, "no-catalog", distinct.join("→")]);
  } else if (cat.currency === "PHP" && Math.abs(Number(cat.regular_rate) - term) <= 0.005) {
    prorate.push([r["Member"], em, `catalog-consistent ${cat.regular_rate}`, distinct.join("→")]);
  } else {
    conflict.push([r["Member"], em, `catalog ${cat.regular_rate} vs terminal ${term}`, distinct.join("→")]);
  }
}

console.log(`\n== WILL PRORATE (${SOURCE_FILE}): ${prorate.length}`);
for (const p of prorate) console.log("  ", ...p);
console.log(`\n== CONFLICT — stays flat until Accounting aligns catalog vs history: ${conflict.length}`);
for (const c of conflict) console.log("  ", ...c);
