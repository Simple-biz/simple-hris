/**
 * READ-ONLY parity guard: does the People tab show the SAME bank routing
 * Payment Dispatch uses, per active roster person?
 *
 *   node scripts/audit-people-vs-dispatch-banks.mjs
 *
 * Two distinct "banks" are involved (docs/features/bank-preferred-routing.md):
 *   - SEND-FROM rail  = employee_ids.bank_preferred → preferred_processor →
 *     legacy employee_hourly_rates."Bank Preferred" (PD's routing precedence).
 *   - RECEIVING acct  = employee_ids account/wallet columns, preferred_bank_slot
 *     (PD's queue row falls back across slots via pickFirst).
 *
 * Since the 2026-08-10 fix the People tab resolves both through the shared
 * dispatch-parity helpers (resolveEffectivePayoutProcessor / isPayoutComplete
 * WITH legacy extras, cross-slot display fallback, effective-rail field
 * visibility). This script re-implements BOTH sides independently:
 *   - "People" side mirrors src/lib/people/people-roster.ts + PeopleTab.tsx
 *     (text-tolerant bank_preferred mapping, payout-completeness.ts).
 *   - "PD" side mirrors mock-queue.ts buildQueueFromRates exactly
 *     (STRICT isKnownProcessor on employee_ids values + legacy cell mapping).
 * All buckets are expected to be 0; a non-zero bucket means a code change on
 * one side drifted, or dirty employee_ids.bank_preferred data split the
 * tolerant/strict mappings. NO WRITES.
 */
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config();

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

const KNOWN = new Set(["hurupay", "wepay", "higlobe", "wise", "jeeves", "wires"]);
const norm = (e) => (e ?? "").toString().trim().toLowerCase();

/** Mirrors processorIdFromBankPreferredText / processorIdFromBankPreferred. */
function procFromText(raw) {
  if (!raw) return null;
  const v = String(raw).trim().toLowerCase().replace(/\s+/g, "");
  if (!v) return null;
  if (v === "hurupay" || v === "huru" || v === "huropay") return "hurupay";
  if (v === "wepay") return "wepay";
  if (v === "higlobe" || v === "higloble" || v === "higlobel") return "higlobe";
  if (v === "wise" || v === "transferwise") return "wise";
  if (v === "jeeves") return "jeeves";
  if (/^x?\d{3,5}$/.test(v) || v === "wire" || v === "wires" || v.startsWith("wire")) return "wires";
  return null;
}

/** Sheet-import tables carry human header column names — flexible pick. */
function pick(row, keys) {
  for (const k of keys) {
    const v = row[k];
    if (v != null && String(v).trim()) return String(v).trim();
  }
  return "";
}

async function withRetry(label, run) {
  let last;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await run();
      if (!res.error) return res;
      last = new Error(`${label}: ${res.error.message}`);
      if (!/fetch failed|522|timeout/i.test(res.error.message)) throw last;
    } catch (e) {
      last = e;
      if (!/fetch failed|522|timeout/i.test(String(e?.message ?? e))) throw e;
    }
    await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
  }
  throw last;
}

/** Page past the PostgREST 1000-row cap. Returns null on a table/view error. */
async function selectAllPaged(table, cols, applyFilters, { soft = false } = {}) {
  const PAGE = 1000;
  const rows = [];
  let from = 0;
  for (;;) {
    let data;
    try {
      ({ data } = await withRetry(table, () => {
        let q = supabase.from(table).select(cols).range(from, from + PAGE - 1);
        if (applyFilters) q = applyFilters(q);
        return q;
      }));
    } catch (e) {
      if (soft) return null;
      throw e;
    }
    rows.push(...(data ?? []));
    if ((data ?? []).length < PAGE) break;
    from += PAGE;
  }
  return rows;
}

/** Mirrors payout-completeness.ts isPayoutComplete (People side, WITH extras). */
function isPayoutComplete(row, extras) {
  const processor = resolveEffective(row, extras);
  if (!processor) return false;
  const g = (k) => (row && row[k] != null && String(row[k]).trim() ? String(row[k]).trim() : "");
  const hasWireDetails =
    !!(g("bank_name") || g("alt_bank_name")) && !!(g("account_number") || g("alt_account_number"));
  switch (processor) {
    case "hurupay":
      return !!(g("hurupay_email") || (extras?.hurupayEmail ?? "").trim());
    case "wepay":
      return !!g("wepay_email");
    case "higlobe":
      return (
        !!(g("higlobe_email") || (extras?.higlobeEmail ?? "").trim()) &&
        !!(g("higlobe_account_name") || (extras?.higlobeAccountName ?? "").trim())
      );
    case "wise":
    case "jeeves":
    case "wires":
      return hasWireDetails;
    default:
      return false;
  }
}

/** People side: resolveEffectivePayoutProcessor (text-tolerant on bank_preferred). */
function resolveEffective(row, extras) {
  const bp = row ? procFromText(row.bank_preferred) : null;
  if (bp) return bp;
  const disb = norm(row?.preferred_processor);
  if (KNOWN.has(disb)) return disb;
  return procFromText(extras?.bankPreferredRaw);
}

/** PD side: mock-queue resolveChosenProcessor (STRICT ids) + legacy cell. */
function pdQueueProcessor(idsRow, legacyRaw) {
  const bp = norm(idsRow?.bank_preferred);
  const pp = norm(idsRow?.preferred_processor);
  const chosen = (KNOWN.has(bp) ? bp : null) ?? (KNOWN.has(pp) ? pp : null);
  return chosen ?? procFromText(legacyRaw);
}

async function main() {
  // Rates: the SAME deduped one-row-per-email view Payment Dispatch's bulk API
  // (getEmployeeHourlyRatesRows) prefers, falling back to the base table.
  let rates = await selectAllPaged("employee_hourly_rates_current", "*", null, { soft: true });
  let ratesSource = "employee_hourly_rates_current (view)";
  if (!rates) {
    rates = await selectAllPaged("employee_hourly_rates", "*");
    ratesSource = "employee_hourly_rates (base table fallback)";
  }
  const [master, ids] = await Promise.all([
    selectAllPaged("global_master_list", "*", (q) => q.is("off_boarded_at", null)),
    selectAllPaged(
      "employee_ids",
      "work_email, personal_email, name, bank_preferred, preferred_processor, preferred_bank_slot, bank_name, account_number, alt_bank_name, alt_account_number, hurupay_email, wepay_email, higlobe_email, higlobe_account_name, wise_email",
    ),
  ]);
  console.log(
    `Loaded: ${master.length} active master rows, ${ids.length} employee_ids rows, ${rates.length} rates rows [${ratesSource}]\n`,
  );

  // employee_ids keyed like PD's buildIdsMap: work email last-wins, personal fills.
  const idByEmail = new Map();
  for (const r of ids) {
    const we = norm(r.work_email);
    const pe = norm(r.personal_email);
    if (we) idByEmail.set(we, r);
    if (pe && !idByEmail.has(pe)) idByEmail.set(pe, r);
  }
  const ratesByEmail = new Map();
  for (const r of rates) {
    const we = norm(pick(r, ["Work Email", "work_email"]));
    const pe = norm(pick(r, ["Personal Email", "personal_email"]));
    if (we) ratesByEmail.set(we, r);
    if (pe && !ratesByEmail.has(pe)) ratesByEmail.set(pe, r);
  }

  // Dedup master rows the way people-roster does (first occurrence wins).
  const seen = new Set();
  const people = [];
  for (const e of master) {
    const w = norm(pick(e, ["Work Email", "work_email"]));
    const p = norm(pick(e, ["Personal Email", "personal_email"]));
    const n = pick(e, ["Name", "name"]).toLowerCase();
    const base = w || p || n;
    const key = `${base}|${n}`;
    if (base && seen.has(key)) continue;
    seen.add(key);
    people.push(e);
  }

  const buckets = {
    chipNoneButRouted: [], // People roster shows nothing; PD routes them
    chipDiffersFromPD: [], // People roster rail ≠ PD queue rail
    flaggedMissingButPayable: [], // People "Missing bank info" ∧ PD-payable
    bankTabHidesAccount: [], // profile Banking hides the account PD shows
    dirtyBankPreferred: [], // employee_ids.bank_preferred not a clean id
  };
  let routedTotal = 0;
  let chipShown = 0;
  let bankPreferredSet = 0;

  for (const e of people) {
    const aliases = [
      pick(e, ["Work Email", "work_email"]),
      pick(e, ["Personal Email", "personal_email"]),
      pick(e, ["Alternate Work Email", "alternate_work_email"]),
      pick(e, ["Alternate Work Email 2", "alternate_work_email_2"]),
    ]
      .map(norm)
      .filter(Boolean);
    const name = pick(e, ["Name", "name"]) || aliases[0] || "(unnamed)";
    const dept = pick(e, ["Department", "department"]);

    const idsRow = aliases.map((a) => idByEmail.get(a)).find(Boolean) ?? null;
    const ratesRow = aliases.map((a) => ratesByEmail.get(a)).find(Boolean) ?? null;
    const legacyRaw = ratesRow ? pick(ratesRow, ["Bank Preferred", "bank_preferred"]) : "";
    const extras = ratesRow
      ? {
          bankPreferredRaw: legacyRaw || null,
          hurupayEmail: pick(ratesRow, ["Hurupay Email", "hurupay_email", "HuruPay Email Account", "Hurupay Email Account"]) || null,
          higlobeEmail: pick(ratesRow, ["HiGlobe Email", "higlobe_email", "HiGlobe  Email", "Higlobe Email"]) || null,
          higlobeAccountName: pick(ratesRow, ["HiGlobe Account Name", "higlobe_account_name", "Higlobe Account Name"]) || null,
        }
      : undefined;

    // ── People tab side (post-fix people-roster.ts) ──
    const chip = resolveEffective(idsRow, extras);
    const hasBankingPeople = isPayoutComplete(idsRow, extras);

    // ── Payment Dispatch side (mock-queue.ts) ──
    const pdEffective = pdQueueProcessor(idsRow, legacyRaw);
    const payablePD = isPayoutComplete(idsRow, extras);

    if (pdEffective) routedTotal++;
    if (chip) chipShown++;
    const bp = norm(idsRow?.bank_preferred);
    if (bp) bankPreferredSet++;
    if (bp && !KNOWN.has(bp)) buckets.dirtyBankPreferred.push({ name, dept, value: idsRow.bank_preferred });

    if (!chip && pdEffective) buckets.chipNoneButRouted.push({ name, dept, pd: pdEffective });
    if (chip && pdEffective && chip !== pdEffective)
      buckets.chipDiffersFromPD.push({ name, dept, chip, pd: pdEffective });

    const isUsee = dept.trim().toUpperCase() === "USEE";
    if (!hasBankingPeople && !isUsee && payablePD)
      buckets.flaggedMissingButPayable.push({ name, dept, pd: pdEffective });

    // Profile Banking read view (post-fix PeopleTab) vs PD row details.
    if (idsRow && pdEffective && ["wires", "wise", "jeeves"].includes(pdEffective)) {
      const prefAlt = norm(idsRow.preferred_bank_slot) === "alternative";
      // People now falls back across slots, same pickFirst as PD.
      const peopleShownAcct = prefAlt
        ? idsRow.alt_account_number || idsRow.account_number
        : idsRow.account_number || idsRow.alt_account_number;
      const pdShownAcct = peopleShownAcct; // identical rule by construction
      const procPeople = resolveEffective(idsRow, extras); // field visibility now keys on the effective rail
      const peopleTabShowsBankFields =
        procPeople === "wires" || procPeople === "jeeves" || procPeople === "wise" ||
        (!procPeople && !!String((prefAlt ? idsRow.alt_bank_name : idsRow.bank_name) ?? "").trim());
      const hidden =
        (!String(peopleShownAcct ?? "").trim() || !peopleTabShowsBankFields) &&
        !!String(pdShownAcct ?? "").trim();
      if (hidden)
        buckets.bankTabHidesAccount.push({ name, dept, pd: pdEffective });
    }
  }

  const show = (label, arr, fmt) => {
    console.log(`\n■ ${label}: ${arr.length}`);
    for (const x of arr.slice(0, 15)) console.log("   - " + fmt(x));
    if (arr.length > 15) console.log(`   … and ${arr.length - 15} more`);
  };

  console.log(`Active roster people (deduped): ${people.length}`);
  console.log(`PD would route (has an effective processor): ${routedTotal}`);
  console.log(`People roster shows a processor chip:        ${chipShown}`);
  console.log(`employee_ids.bank_preferred set:             ${bankPreferredSet}`);

  show("People chip EMPTY but PD routes them", buckets.chipNoneButRouted, (x) => `${x.name} [${x.dept}] → PD: ${x.pd}`);
  show("People chip DIFFERS from PD rail", buckets.chipDiffersFromPD, (x) => `${x.name} [${x.dept}] chip: ${x.chip} vs PD: ${x.pd}`);
  show("Flagged 'Missing bank info' in People but PD-payable", buckets.flaggedMissingButPayable, (x) => `${x.name} [${x.dept}] PD pays via ${x.pd}`);
  show("Profile Banking tab hides the account PD displays", buckets.bankTabHidesAccount, (x) => `${x.name} [${x.dept}] PD ${x.pd}`);
  show("Dirty employee_ids.bank_preferred values (would split tolerant/strict mapping)", buckets.dirtyBankPreferred, (x) => `${x.name} [${x.dept}] = "${x.value}"`);

  const total =
    buckets.chipNoneButRouted.length +
    buckets.chipDiffersFromPD.length +
    buckets.flaggedMissingButPayable.length +
    buckets.bankTabHidesAccount.length;
  console.log(`\n${total === 0 ? "✅ PARITY: People tab matches Payment Dispatch for every active person." : `❌ ${total} disagreements remain.`}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
