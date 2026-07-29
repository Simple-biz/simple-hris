/**
 * Fix the rate-source underpayments — verified against the Google rates Sheet.
 *
 * THE BUG: the pay engine resolves each day's rate from `employee_rate_history`
 * (newest `effective_from <= day` wins) and only falls back to the flat
 * `employee_hourly_rates` cache when history has no row. A raise that reached the
 * sheet/cache but never got a history row therefore keeps paying the OLD rate —
 * silently, because the stub's line totals still add up. 2026-07-29: 22 people
 * genuinely short ₱25,688.89 in the 07-19 week alone.
 *
 * THE TRAP THIS SCRIPT AVOIDS: the DB's `employee_hourly_rates` "higher rate" is
 * NOT trustworthy — several people carry a stale duplicate row holding ANOTHER
 * DEPARTMENT'S rate (e.g. Hogan Smith Law ₱225 rows attached to Lead Gen staff),
 * and `disbursement_records.regular_rate_php` is mislabeled by this very bug. So
 * the verification authority here is the live **Google rates Sheet** (the artifact
 * payroll actually maintains, upstream of both DB tables), fetched read-only with
 * the same service account the app uses.
 *
 * Decision per divergent person (history-paid rate vs Google Sheet rate):
 *   sheet > paid          → UNDERPAID, fix at the sheet rate
 *   sheet == paid         → the DB's higher rate was stale leakage → leave alone
 *   sheet < paid          → NEVER auto-lower (legit manual raises exist) → leave alone
 *   not on sheet          → hold, unless explicitly user-confirmed below
 *
 * USER-CONFIRMED OVERRIDES: Kane confirmed 2026-07-29 (twice) that Nathaniel
 * Rosal's regular pay is ₱9,000/40h = ₱225/h. That instruction outranks the sheet
 * for him; the sheet value is still reported next to it for the record.
 *
 * THE FIX (per person, exactly the app's own remediation path):
 *   1. an employee-scope `payment_catalog_pay_structures` row — the pay engine's
 *      highest-priority source (`catalogOverride` in current-pay.ts bypasses the
 *      stale per-day history entirely) and immune to sheet-sync clobber;
 *   2. a dated `employee_rate_history` row (default effective 2026-07-05, the
 *      first known short week) so per-day replays of unpaid weeks re-price too.
 *      Already-PAID stubs are frozen snapshots — a history fix cannot touch them.
 *
 * Deliberately NOT done (outward-facing): no Google Sheet writes, no employee
 * "rate changed" notifications, no changes to the 3 paid-ABOVE-sheet people.
 *
 * Usage:
 *   node scripts/fix-rate-underpayments.mjs               # dry run: decision table
 *   node scripts/fix-rate-underpayments.mjs --apply       # backup + write the fixes
 *   node scripts/fix-rate-underpayments.mjs --apply --from 2026-07-05 --week 2026-07-19
 */
import { createClient } from "@supabase/supabase-js";
import { writeFileSync, mkdirSync } from "node:fs";
import crypto from "node:crypto";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config();

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (.env.local)");
  process.exit(1);
}
const supabase = createClient(url, key);

const argv = process.argv.slice(2);
const flag = (n) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : null;
};
const APPLY = argv.includes("--apply");
const AS_OF = flag("week") || "2026-07-19"; // resolve "what history pays" as of this date
const EFFECTIVE = flag("from") || "2026-07-05"; // first known short week
const ACTOR = "rate-divergence fix 2026-07-29";

/**
 * Kane's direct instruction (2026-07-29, twice: the AskUserQuestion answer and
 * "supposed to have 9k as his reg rate"): Nathaniel is ₱225/h. Outranks the sheet.
 */
const USER_CONFIRMED = new Map([
  ["nathanr@simple.biz", { reg: 225, ot: 337.5, why: "Kane confirmed ₱9,000/40h regular, 2026-07-29" }],
]);

const norm = (e) => (typeof e === "string" ? e.trim().toLowerCase() : "");
const num = (v) => {
  if (v == null || v === "") return null;
  const n = parseFloat(String(v).replace(/,/g, "").replace(/[₱$]/g, ""));
  return Number.isFinite(n) ? n : null;
};
const peso = (n) =>
  n == null
    ? "—"
    : `₱${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const r2 = (n) => Math.round(n * 100) / 100;
const slug = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "unknown";

// ── Google Sheets (read-only), mirroring src/lib/google-sheets/auth.ts ──
const b64url = (buf) =>
  (typeof buf === "string" ? Buffer.from(buf) : buf)
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

async function sheetsToken() {
  const clientEmail = process.env.GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL?.trim();
  const privateKey = (process.env.GOOGLE_SHEETS_SERVICE_ACCOUNT_PRIVATE_KEY ?? "")
    .replace(/\\n/g, "\n")
    .trim();
  if (!clientEmail || !privateKey) throw new Error("Google service-account env vars missing");
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(
    JSON.stringify({
      iss: clientEmail,
      scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }),
  );
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(`${header}.${claim}`);
  const jwt = `${header}.${claim}.${b64url(signer.sign(privateKey))}`;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });
  const json = await res.json();
  if (!res.ok || !json.access_token) throw new Error(`Google token exchange failed: ${json.error_description ?? json.error}`);
  return json.access_token;
}

async function fetchSheetGrid(sheetIdEnv, tabEnv) {
  const sheetId = process.env[sheetIdEnv]?.trim();
  const tabName = process.env[tabEnv]?.trim();
  if (!sheetId || !tabName) throw new Error(`${sheetIdEnv} / ${tabEnv} missing`);
  const token = await sheetsToken();
  const range = encodeURIComponent(`'${tabName.replace(/'/g, "''")}'`);
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}?valueRenderOption=FORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const json = await res.json();
  if (!res.ok) throw new Error(`Sheets API error (${res.status}): ${json.error?.message ?? res.statusText}`);
  return Array.isArray(json.values) ? json.values : [];
}

const fetchRatesSheet = () => fetchSheetGrid("GOOGLE_SHEETS_RATES_SHEET_ID", "GOOGLE_SHEETS_RATES_TAB_NAME");

/**
 * The Hogan Agents Pay Plan sheet — the SOLE authority for HSL rates (the
 * All-Dept rates sync filters HSL rows out, so an HSL person's All-Dept row is
 * just their pre-HSL history; see hsl-upload-db.ts). Header row auto-detected
 * like fetch-hsl-sheet.ts: the first row carrying an email cell + a rate cell.
 */
async function fetchHslIndex() {
  const grid = await fetchSheetGrid("GOOGLE_SHEETS_HSL_SHEET_ID", "GOOGLE_SHEETS_HSL_TAB_NAME");
  let headerIdx = -1;
  for (let i = 0; i < Math.min(grid.length, 10); i++) {
    const cells = grid[i].map((c) => String(c ?? "").replace(/\s+/g, " ").trim().toLowerCase());
    if (cells.some((c) => /e-?mail/.test(c)) && cells.some((c) => /hourly rate|regular rate/.test(c))) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx < 0) throw new Error("Hogan sheet: could not locate the header row");
  const headers = grid[headerIdx].map((c) => String(c ?? "").replace(/\s+/g, " ").trim().toLowerCase());
  const col = (re) => headers.findIndex((h) => re.test(h));
  const cEmail = col(/e-?mail/);
  const cRate = col(/hourly rate|regular rate/);
  const cOt = col(/\bot rate\b|ot rate/);
  const byEmail = new Map();
  for (let i = headerIdx + 1; i < grid.length; i++) {
    const row = grid[i];
    const em = norm(row[cEmail]);
    const reg = num(row[cRate]);
    if (!em || reg == null) continue;
    byEmail.set(em, { reg, ot: cOt >= 0 ? num(row[cOt]) : null, rowNum: i + 1 });
  }
  return byEmail;
}

/**
 * Index the sheet by email → the person's LATEST-week row.
 *
 * The tab is a weekly LOG (a "Week 7/19/26 - 7/25/26" column, one row per person
 * per week, ~8,400 rows), NOT a current roster. Taking a max across all rows would
 * resurrect a rate from an old week/department stint — the very stale-data trap
 * this script exists to avoid. Only the newest week's row speaks for a person;
 * their previous week's rate is kept alongside purely for the report.
 */
function indexSheet(grid) {
  if (grid.length === 0) throw new Error("Rates sheet came back empty");
  // Header cells carry embedded newlines ("regular \nrate") — collapse whitespace.
  const headers = grid[0].map((h) => String(h ?? "").replace(/\s+/g, " ").trim().toLowerCase());
  const col = (re) => headers.findIndex((h) => re.test(h));
  const cWork = col(/work e-?mail/);
  const cPers = col(/personal e-?mail/);
  const cReg = col(/^regular rate$/);
  const cOt = col(/^ot rate$/);
  const cDept = col(/^department$/);
  const cWeek = col(/^week$/);
  // A mid-week rate change: the sheet records the NEW go-forward rate here.
  const cMid = col(/mid-?week new hourly rate/);
  if (cWork < 0 || cReg < 0) {
    throw new Error(`Could not find Work Email / Regular Rate columns. Headers: ${headers.join(" | ")}`);
  }

  // "Week 7/19/26 - 7/25/26" → the start date's timestamp (0 when unparsable, so
  // dated rows always beat undated ones and row order breaks ties).
  const weekStartTs = (v) => {
    const m = /(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(String(v ?? ""));
    if (!m) return 0;
    let y = Number(m[3]);
    if (y < 100) y += 2000;
    return new Date(y, Number(m[1]) - 1, Number(m[2])).getTime();
  };

  const byEmail = new Map(); // em → { latest, prevReg }
  const consider = (em, entry) => {
    if (!em) return;
    const cur = byEmail.get(em);
    if (!cur) {
      byEmail.set(em, { latest: entry, prevReg: null });
      return;
    }
    const newer =
      entry.weekTs > cur.latest.weekTs ||
      (entry.weekTs === cur.latest.weekTs && entry.rowNum > cur.latest.rowNum);
    if (newer) {
      byEmail.set(em, { latest: entry, prevReg: cur.latest.reg });
    } else if (cur.prevReg == null && entry.weekTs < cur.latest.weekTs) {
      cur.prevReg = entry.reg;
    }
  };

  for (let i = 1; i < grid.length; i++) {
    const row = grid[i];
    const baseReg = num(row[cReg]);
    const midReg = cMid >= 0 ? num(row[cMid]) : null;
    // A mid-week change's NEW rate is that row's go-forward rate.
    const reg = midReg ?? baseReg;
    if (reg == null) continue;
    const entry = {
      reg,
      ot: cOt >= 0 ? num(row[cOt]) : null,
      dept: cDept >= 0 ? String(row[cDept] ?? "").trim() : "",
      rowNum: i + 1,
      weekTs: cWeek >= 0 ? weekStartTs(row[cWeek]) : 0,
      week: cWeek >= 0 ? String(row[cWeek] ?? "").trim() : "",
      midWeek: midReg != null && baseReg != null && midReg !== baseReg ? midReg : null,
    };
    consider(norm(row[cWork]), entry);
    if (cPers >= 0) consider(norm(row[cPers]), entry);
  }
  return byEmail;
}

async function pageAll(table, select, tries = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      const out = [];
      const SIZE = 1000;
      for (let from = 0; ; from += SIZE) {
        const { data, error } = await supabase.from(table).select(select).range(from, from + SIZE - 1);
        if (error) throw new Error(error.message);
        out.push(...(data ?? []));
        if (!data || data.length < SIZE) break;
      }
      return out;
    } catch (e) {
      if (attempt >= tries) throw new Error(`${table}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
}

function resolveAsOf(rows, asOf) {
  const t = new Date(asOf).getTime();
  let best = null;
  for (const r of rows) {
    const eff = new Date(r.effective_from).getTime();
    if (eff <= t && (best == null || eff > new Date(best.effective_from).getTime())) best = r;
  }
  return best;
}

async function main() {
  console.log(`Authority: live Google rates Sheet · as-of ${AS_OF} · effective ${EFFECTIVE}\n`);

  const [grid, hslSheet, history, cacheRows, master, structures, mlUploads] = await Promise.all([
    fetchRatesSheet(),
    fetchHslIndex(),
    pageAll("employee_rate_history", "employee_email, regular_rate, ot_rate, effective_from, note, created_by"),
    pageAll("employee_hourly_rates", '"Work Email", "Regular Rate", "OT Rate", "Department"'),
    pageAll("global_master_list", '"Work Email", "Personal Email", "Name", "Department", off_boarded_at, last_seen_upload_id'),
    pageAll("payment_catalog_pay_structures", "id, scope, employee_email, department_key, regular_rate, ot_rate, currency"),
    pageAll("master_list_uploads", "id, is_current"),
  ]);
  const sheet = indexSheet(grid);
  console.log(`All-Dept sheet rows: ${grid.length - 1} · people indexed: ${sheet.size}`);
  console.log(`Hogan Pay Plan agents indexed: ${hslSheet.size}`);

  const currentUpload = mlUploads.find((u) => u.is_current)?.id ?? null;
  const active = new Map();
  for (const m of master) {
    const em = norm(m["Work Email"]);
    if (!em || m.off_boarded_at) continue;
    if (currentUpload && m.last_seen_upload_id !== currentUpload) continue;
    active.set(em, m);
  }
  const histBy = new Map();
  for (const h of history) {
    const em = norm(h.employee_email);
    if (!em) continue;
    if (!histBy.has(em)) histBy.set(em, []);
    histBy.get(em).push(h);
  }
  const cacheBy = new Map();
  for (const r of cacheRows) {
    const em = norm(r["Work Email"]);
    if (!em) continue;
    if (!cacheBy.has(em)) cacheBy.set(em, []);
    cacheBy.get(em).push(r);
  }
  const immune = new Set(structures.filter((s) => s.scope === "employee").map((s) => norm(s.employee_email)));

  // Divergent = history pays a different rate than the DB cache suggests. Then the
  // SHEET decides which side is real.
  const fixes = [];
  const holds = [];
  for (const [em, m] of active) {
    if (immune.has(em)) continue;
    const hist = histBy.get(em) ?? [];
    const cache = cacheBy.get(em) ?? [];
    if (hist.length === 0 || cache.length === 0) continue;
    const resolved = resolveAsOf(hist, AS_OF);
    const paid = num(resolved?.regular_rate);
    if (paid == null) continue;
    const cacheMax = Math.max(...cache.map((r) => num(r["Regular Rate"])).filter((v) => v != null), -1);
    if (cacheMax < 0 || Math.abs(cacheMax - paid) < 0.005) continue; // tables agree → fine

    // Authority routing: HSL people live on the Hogan Pay Plan sheet (the
    // All-Dept sheet drops them, so their All-Dept row is pre-HSL history).
    // Everyone else: the All-Dept sheet's LATEST-week row.
    const pe = norm(m["Personal Email"]);
    const isHslPerson = /^hsl\b|hogan/i.test(String(m["Department"] ?? ""));
    let latest = null;
    let hit = null;
    let authority;
    if (isHslPerson) {
      const hsl = hslSheet.get(em) ?? (pe ? hslSheet.get(pe) : null) ?? null;
      if (hsl) {
        latest = { reg: hsl.reg, ot: hsl.ot, dept: "HSL", rowNum: hsl.rowNum, week: "", midWeek: null };
        authority = `Hogan Pay Plan row ${hsl.rowNum}`;
      } else {
        authority = "Hogan Pay Plan (not listed)";
      }
    } else {
      hit = sheet.get(em) ?? (pe ? sheet.get(pe) : null) ?? null;
      latest = hit?.latest ?? null;
      authority = latest ? `All-Dept latest week ${latest.week || "?"} row ${latest.rowNum}` : "All-Dept sheet (not listed)";
    }
    const sheetReg = latest?.reg ?? null;
    // OT from the SAME row, sanity-checked: an OT below the regular rate is a
    // stale/foreign cell — fall back to the standard 1.5×.
    const sheetOt =
      latest?.ot != null && sheetReg != null && latest.ot >= sheetReg ? latest.ot : sheetReg != null ? r2(sheetReg * 1.5) : null;
    const confirmed = USER_CONFIRMED.get(em) ?? null;

    const base = {
      email: em,
      name: m["Name"] ?? em,
      dept: m["Department"] ?? "",
      paid,
      paidOt: num(resolved?.ot_rate),
      cacheMax,
      sheetReg,
      sheetOt,
      sheetDept: latest?.dept ?? "",
      sheetWeek: latest?.week ?? "",
      prevWeekReg: hit?.prevReg ?? null,
      histSig: `${String(resolved?.effective_from).slice(0, 10)}/${resolved?.created_by ?? "?"}`,
    };

    if (confirmed) {
      // Kane's word wins; take the sheet only if it is HIGHER than the confirmed rate.
      const reg = sheetReg != null && sheetReg > confirmed.reg ? sheetReg : confirmed.reg;
      const ot = reg === confirmed.reg ? confirmed.ot : sheetOt ?? r2(reg * 1.5);
      fixes.push({ ...base, newReg: reg, newOt: ot, basis: `user-confirmed (${confirmed.why}); ${authority} says ${sheetReg != null ? peso(sheetReg) : "—"}` });
    } else if (sheetReg == null) {
      holds.push({ ...base, reason: `${authority} — needs a human` });
    } else if (sheetReg > paid + 0.005) {
      // Corroboration guard for Hogan-sheet reads: the HSL sync mirrors the Hogan
      // sheet into `employee_hourly_rates`, so a genuine Hogan rate should ALSO
      // appear as one of the person's cache rows. When my read of the sheet and
      // the app's own mirror of the same sheet disagree, one of the two is wrong
      // (mis-mapped section, post-mirror edit, template row) — a human decides,
      // not a script. All-Dept current-week rows are exempt: the cache lags them
      // by design (the rates sync is disabled), so disagreement is expected.
      const corroborated =
        !isHslPerson ||
        (cacheBy.get(em) ?? []).some((r) => {
          const v = num(r["Regular Rate"]);
          return v != null && Math.abs(v - sheetReg) <= 0.005;
        });
      if (!corroborated) {
        holds.push({
          ...base,
          reason: `${authority} says ${peso(sheetReg)} but the app's own Hogan-sheet mirror wrote ${peso(cacheMax)} to the cache — the two reads disagree; confirm by hand before a ${peso(sheetReg - paid)}/h change`,
        });
      } else {
        fixes.push({ ...base, newReg: sheetReg, newOt: sheetOt, basis: `${authority}${latest?.midWeek != null ? `, mid-week change to ${peso(latest.midWeek)}` : ""}` });
      }
    } else if (Math.abs(sheetReg - paid) <= 0.005) {
      holds.push({ ...base, reason: `${authority} agrees with the PAID rate ${peso(paid)} — the DB's ${peso(cacheMax)} is stale leakage; nothing owed` });
    } else {
      holds.push({ ...base, reason: `${authority} says ${peso(sheetReg)}, BELOW the paid ${peso(paid)} — never auto-lower` });
    }
  }

  fixes.sort((a, b) => b.newReg - b.paid - (a.newReg - a.paid));

  console.log(`\n══ FIX (${fixes.length}) — sheet/user confirms the higher rate ══`);
  for (const f of fixes) {
    console.log(
      `  ${String(f.name).slice(0, 36).padEnd(36)} ${String(f.dept).slice(0, 12).padEnd(12)} ` +
        `${peso(f.paid)} → ${peso(f.newReg)} (ot ${peso(f.newOt)})   [${f.basis}]` +
        (f.prevWeekReg != null && f.prevWeekReg !== f.newReg ? `  (prev week ${peso(f.prevWeekReg)})` : ""),
    );
  }
  console.log(`\n══ HOLD (${holds.length}) — no write ══`);
  for (const h of holds) {
    console.log(
      `  ${String(h.name).slice(0, 36).padEnd(36)} ${String(h.dept).slice(0, 12).padEnd(12)} ` +
        `paid ${peso(h.paid)} · cache ${peso(h.cacheMax)} · sheet ${peso(h.sheetReg)} — ${h.reason}`,
    );
  }

  if (!APPLY) {
    console.log(`\nDry run. Re-run with --apply to write ${fixes.length} fixes (catalog structure + history row each).`);
    return;
  }
  if (fixes.length === 0) {
    console.log("\nNothing to apply.");
    return;
  }

  // ── backup, then write ──
  mkdirSync("reports", { recursive: true });
  const backup = {
    at: new Date().toISOString(),
    actor: ACTOR,
    asOf: AS_OF,
    effective: EFFECTIVE,
    people: fixes.map((f) => ({
      fix: f,
      before: {
        history: (histBy.get(f.email) ?? []),
        cacheRows: (cacheBy.get(f.email) ?? []),
      },
    })),
  };
  const backupPath = `reports/backup_rate_fix_${new Date().toISOString().slice(0, 10)}.json`;
  writeFileSync(backupPath, JSON.stringify(backup, null, 2), "utf8");
  console.log(`\nBackup written: ${backupPath}`);

  let ok = 0;
  const failures = [];
  for (const f of fixes) {
    // 1) employee-scope catalog structure — highest-priority rate, clobber-immune.
    const { error: sErr } = await supabase.from("payment_catalog_pay_structures").insert({
      id: crypto.randomUUID(),
      scope: "employee",
      department_key: slug(f.dept),
      employee_email: f.email,
      employee_name: f.name,
      regular_rate: f.newReg,
      ot_rate: f.newOt,
      currency: "PHP",
      created_by: ACTOR,
      updated_by: ACTOR,
    });
    if (sErr) {
      failures.push(`${f.name}: catalog insert failed — ${sErr.message}`);
      continue; // don't write a half-fix's history row without its structure
    }
    // 2) dated history row so unpaid-week replays re-price too.
    const { error: hErr } = await supabase.from("employee_rate_history").insert({
      employee_email: f.email,
      regular_rate: String(f.newReg),
      ot_rate: String(f.newOt),
      effective_from: EFFECTIVE,
      created_by: ACTOR,
      note: `Underpay fix: engine paid ${peso(f.paid)} from stale history while the correct rate was ${peso(f.newReg)} (${f.basis}). Effective ${EFFECTIVE}.`,
    });
    if (hErr) {
      failures.push(`${f.name}: history insert failed (structure WAS created, pay is already corrected) — ${hErr.message}`);
      continue;
    }
    // Warn if a newer history row would still out-rank ours in pure-history replays.
    const newer = (histBy.get(f.email) ?? []).filter(
      (h) => new Date(h.effective_from) > new Date(EFFECTIVE) && num(h.regular_rate) !== f.newReg,
    );
    if (newer.length) {
      console.log(`  ⚠ ${f.name}: ${newer.length} history row(s) newer than ${EFFECTIVE} still present (catalog override wins live, but check them)`);
    }
    ok += 1;
    console.log(`  ✓ ${f.name} → ${peso(f.newReg)}/${peso(f.newOt)} (structure + history)`);
  }

  console.log(`\nApplied ${ok}/${fixes.length}.`);
  if (failures.length) {
    console.log("FAILURES:");
    for (const m of failures) console.log(`  ✗ ${m}`);
  }
  console.log("\nNext: re-open the Payroll Wizard for the current cycle and re-lock — the staged");
  console.log("07-19 payloads restage at the corrected rates (display AND pay now both correct).");
  console.log("Already-SENT weeks are frozen; their gap is back-pay, listed in the reports CSV.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
