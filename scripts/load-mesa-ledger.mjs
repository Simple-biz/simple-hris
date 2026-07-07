// Loads references/sql/create/backfill_mesa_ledger.sql into the mesa_ledger table
// via the Supabase REST API (service-role key) in batches — bypasses the SQL
// Editor's request-size limit.
//
// PREREQUISITE: run the DDL (CREATE TABLE mesa_ledger + indexes) once in the
// Supabase SQL Editor first. That block is tiny and pastes fine. This script
// only inserts the 7,235 data rows (idempotent upsert on id).
//
// Usage:  node scripts/load-mesa-ledger.mjs
//         node scripts/load-mesa-ledger.mjs --dry   (parse only, no writes)

import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { readFileSync } from "node:fs";

dotenv.config({ path: ".env.local" });
dotenv.config(); // .env fills any gaps

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const DRY = process.argv.includes("--dry");
const FILE = "references/sql/create/backfill_mesa_ledger.sql";
const BATCH = 500;

const sql = readFileSync(FILE, "utf8");

// --- the file has multiple INSERT ... VALUES ... ON CONFLICT blocks (batched) ---
const headerRe = /INSERT INTO mesa_ledger\s*\(([^)]*)\)\s*VALUES/gi;
let columns = null;
const blobs = [];
let hm;
while ((hm = headerRe.exec(sql)) !== null) {
  const cols = hm[1].split(",").map((c) => c.trim());
  if (!columns) columns = cols;
  const valuesStart = hm.index + hm[0].length;
  const after = sql.slice(valuesStart);
  const oc = after.search(/ON CONFLICT/i);
  const end = oc === -1 ? after.search(/;\s*$/m) : oc;
  blobs.push(oc === -1 && end === -1 ? after : after.slice(0, end));
}
if (!columns) throw new Error("Could not find INSERT ... VALUES header");
console.log(`Found ${blobs.length} INSERT block(s).`);
const blob = blobs.join("\n");

// --- tokenize top-level ( ... ) tuples, respecting single-quoted strings ---
function parseTuples(text) {
  const tuples = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    if (text[i] !== "(") { i++; continue; }
    // start of a tuple
    i++;
    const fields = [];
    let cur = "";
    let depth = 0;
    let inStr = false;
    for (; i < n; i++) {
      const ch = text[i];
      if (inStr) {
        if (ch === "'") {
          if (text[i + 1] === "'") { cur += "''"; i++; } // escaped quote
          else { cur += ch; inStr = false; }
        } else cur += ch;
        continue;
      }
      if (ch === "'") { cur += ch; inStr = true; continue; }
      if (ch === "(") { depth++; cur += ch; continue; }
      if (ch === ")") {
        if (depth === 0) { fields.push(cur.trim()); break; } // tuple closed
        depth--; cur += ch; continue;
      }
      if (ch === "," && depth === 0) { fields.push(cur.trim()); cur = ""; continue; }
      cur += ch;
    }
    tuples.push(fields);
  }
  return tuples;
}

// --- convert one SQL field token to a JS value ---
function coerce(tok) {
  if (tok == null) return null;
  const t = tok.trim();
  if (t === "" || /^NULL$/i.test(t)) return null;
  let m;
  if ((m = t.match(/^DATE\s+'(.*)'$/is))) return m[1].replace(/''/g, "'");
  if ((m = t.match(/^TIMESTAMP(?:TZ)?\s+'(.*)'$/is))) return m[1].replace(/''/g, "'");
  if (t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (/^(true|false)$/i.test(t)) return /^true$/i.test(t);
  return t; // fallback: raw
}

const tuples = parseTuples(blob);
const rows = tuples.map((fields) => {
  if (fields.length !== columns.length) {
    throw new Error(
      `Field count ${fields.length} != column count ${columns.length} at row id-ish ${fields[0]}`,
    );
  }
  const obj = {};
  columns.forEach((c, idx) => { obj[c] = coerce(fields[idx]); });
  return obj;
});

console.log(`Parsed ${rows.length} rows, ${columns.length} columns each.`);
console.log("Sample first row:", JSON.stringify(rows[0]));
console.log("Sample last row: ", JSON.stringify(rows[rows.length - 1]));

if (DRY) { console.log("--dry: no writes performed."); process.exit(0); }

const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

let done = 0;
for (let start = 0; start < rows.length; start += BATCH) {
  const chunk = rows.slice(start, start + BATCH);
  const { error } = await supabase
    .from("mesa_ledger")
    .upsert(chunk, { onConflict: "id" });
  if (error) {
    console.error(`Batch ${start}-${start + chunk.length} FAILED:`, error.message, error.details ?? "");
    process.exit(1);
  }
  done += chunk.length;
  console.log(`upserted ${done}/${rows.length}`);
}
console.log("Done.");
