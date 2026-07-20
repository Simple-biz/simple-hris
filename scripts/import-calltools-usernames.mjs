// Bulk-import CallTools dialer usernames into employee_calltools_usernames,
// matching each CSV row to an active employee by email (preferred) or name.
//
//   node scripts/import-calltools-usernames.mjs <file.csv>            # dry run
//   node scripts/import-calltools-usernames.mjs <file.csv> --apply    # write
//
// Optional explicit column names (else auto-detected from the header):
//   --username-col="CallTools Username"  --email-col="Email"  --name-col="Agent"
//
// Safe to run repeatedly (upsert by email). Dry run prints matched + unmatched
// so you can eyeball the matching before --apply. Requires SUPABASE_SERVICE_ROLE_KEY.
import { createClient } from "@supabase/supabase-js";
import { parse } from "csv-parse/sync";
import { readFileSync } from "node:fs";
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config();

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const apply = args.includes("--apply");
const argVal = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
if (!file) {
  console.log("Usage: node scripts/import-calltools-usernames.mjs <file.csv> [--apply]");
  process.exit(1);
}

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL?.trim(),
  process.env.SUPABASE_SERVICE_ROLE_KEY?.trim(),
  { auth: { persistSession: false } },
);
const norm = (e) => (e ?? "").toString().trim().toLowerCase();
const normName = (s) =>
  (s ?? "")
    .replace(/["“”][^"“”]*["“”]/g, " ")
    .replace(/[.,]/g, " ")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv|n\/?a)\b/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(" ");

const records = parse(readFileSync(file), {
  columns: true,
  skip_empty_lines: true,
  trim: true,
  bom: true,
  relax_column_count: true,
});
if (records.length === 0) {
  console.log("No rows in CSV.");
  process.exit(1);
}
const headers = Object.keys(records[0]);
const find = (cands) =>
  headers.find((h) => cands.some((c) => h.toLowerCase().replace(/[\s_]/g, "").includes(c)));
const usernameCol = argVal("username-col") || find(["calltoolsusername", "calltoolsuser", "dialerusername", "username", "calltools", "dialer"]);
const emailCol = argVal("email-col") || find(["workemail", "companyemail", "email"]);
const nameCol = argVal("name-col") || find(["fullname", "agentname", "employeename", "name", "agent"]);

console.log(`\nCSV: ${file}  (${records.length} rows)`);
console.log(`Headers: ${headers.join(" | ")}`);
console.log(`Detected -> username: ${usernameCol ?? "(none!)"}   email: ${emailCol ?? "(none)"}   name: ${nameCol ?? "(none)"}`);
if (!usernameCol) {
  console.log("\n✗ Could not find a username column. Pass --username-col=\"<header>\".");
  process.exit(1);
}
if (!emailCol && !nameCol) {
  console.log("\n✗ Need at least an email or name column to match on. Pass --email-col / --name-col.");
  process.exit(1);
}

// Load all active employees for matching.
async function fetchAll(select) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("active_employees").select(select).range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}
const emps = await fetchAll('"Name", "Work Email", "Personal Email", "Department"');
const byEmail = new Map();
const byName = new Map();
const empTokens = [];
for (const e of emps) {
  for (const k of [norm(e["Work Email"]), norm(e["Personal Email"])]) if (k) byEmail.set(k, e);
  const n = normName(e.Name);
  if (n && !byName.has(n)) byName.set(n, e);
  empTokens.push({ set: new Set(n.split(" ").filter(Boolean)), emp: e });
}

const upserts = new Map(); // keyEmail -> {username, name, matchedBy}
const unmatched = [];
for (const row of records) {
  const username = (row[usernameCol] ?? "").toString().trim();
  if (!username) continue;
  const email = emailCol ? norm(row[emailCol]) : "";
  const name = nameCol ? row[nameCol] : "";
  let emp = email ? byEmail.get(email) : null;
  let matchedBy = emp ? "email" : "";
  if (!emp && name) {
    emp = byName.get(normName(name));
    if (emp) matchedBy = "name";
  }
  // Fallback: CSV name tokens are a subset of exactly one employee's tokens —
  // recovers messy roster names that carry extra nickname tokens ("Gan, Mark
  // Anthony \"Koki\""). Skipped when ambiguous (>1 candidate) to avoid mis-links.
  if (!emp && name) {
    const toks = normName(name).split(" ").filter(Boolean);
    if (toks.length >= 2) {
      const supersets = empTokens.filter(({ set }) => toks.every((t) => set.has(t)));
      if (supersets.length === 1) {
        emp = supersets[0].emp;
        matchedBy = "name~";
      }
    }
  }
  if (!emp) {
    unmatched.push({ username, email, name });
    continue;
  }
  const keyEmail = norm(emp["Work Email"]) || norm(emp["Personal Email"]) || email;
  if (!keyEmail) {
    unmatched.push({ username, email, name });
    continue;
  }
  upserts.set(keyEmail, { username, name: emp.Name ?? name ?? null, matchedBy, dept: emp.Department });
}

console.log(`\nMatched to an employee: ${upserts.size}`);
console.log(`Unmatched rows:         ${unmatched.length}`);
for (const [keyEmail, u] of [...upserts].slice(0, 20))
  console.log(`  ✓ ${keyEmail}  "${u.username}"  (${u.matchedBy}, ${u.dept})`);
if (upserts.size > 20) console.log(`  … +${upserts.size - 20} more`);
if (unmatched.length)
  console.log(
    `\nUnmatched (first 20 — fix email/name or add these employees first):\n` +
      unmatched.slice(0, 20).map((u) => `  ✗ "${u.username}"  email=${u.email || "—"}  name=${u.name || "—"}`).join("\n"),
  );

if (!apply) {
  console.log(`\nDry run. Re-run with --apply to write ${upserts.size} rows.\n`);
  process.exit(0);
}

const rows = [...upserts].map(([email, u]) => ({
  email,
  calltools_username: u.username,
  name: u.name,
  updated_by: "import-script",
  updated_at: new Date().toISOString(),
}));
let wrote = 0;
for (let i = 0; i < rows.length; i += 500) {
  const batch = rows.slice(i, i + 500);
  const { error } = await sb.from("employee_calltools_usernames").upsert(batch, { onConflict: "email" });
  if (error) {
    console.log(`\n✗ Upsert failed at batch ${i}: ${error.message}`);
    if (/employee_calltools_usernames/i.test(error.message))
      console.log("   Run references/sql/migrate/2026-07-20_employee_calltools_usernames.sql first.");
    process.exit(1);
  }
  wrote += batch.length;
}
console.log(`\n✓ Upserted ${wrote} CallTools usernames.\n`);
