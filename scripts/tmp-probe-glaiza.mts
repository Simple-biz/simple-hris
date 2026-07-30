// READ-ONLY probe: glaizag@simple.biz — transfers (any status), master rows,
// active visibility, live sheet rows.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config();

const { createClient } = await import("@supabase/supabase-js");
const { getServiceAccountAccessToken } = await import("../src/lib/google-sheets/auth");

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);
const WORK = "glaizag@simple.biz";
async function retry<T>(fn: () => Promise<T>, label: string, tries = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) { last = e; console.error(`${label} try ${i + 1}:`, e instanceof Error ? e.message : e); }
  }
  throw last;
}

// 1) transfer requests, ANY status
const reqs = await retry(async () => {
  const { data, error } = await sb
    .from("department_transfer_requests")
    .select("id, status, from_department, to_department, effective_date, applied_at, sheet_synced, sheet_sync_error, requested_by, created_at, employee_name, employee_email, employee_work_email, employee_personal_email")
    .or(`employee_work_email.ilike.${WORK},employee_email.ilike.${WORK}`)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return data ?? [];
}, "transfers");
console.log(`=== transfer requests: ${reqs.length} ===`);
for (const r of reqs) {
  console.log(
    `  ${r.status.toUpperCase()} ${r.from_department} -> ${r.to_department} eff=${r.effective_date} applied=${r.applied_at}\n` +
      `    requested_by=${r.requested_by} sheet_synced=${r.sheet_synced} err=${JSON.stringify(r.sheet_sync_error)}\n` +
      `    name=${r.employee_name} personal=${r.employee_personal_email} created=${r.created_at}`,
  );
}
const personal = reqs.find((r) => r.employee_personal_email)?.employee_personal_email ?? null;

// 2) current upload + master rows
const current = await retry(async () => {
  const { data, error } = await sb.from("master_list_uploads").select("id, uploaded_at").eq("is_current", true).single();
  if (error) throw new Error(error.message);
  return data;
}, "is_current");
console.log(`\nis_current upload: ${current.id} @ ${current.uploaded_at}`);

const rows = await retry(async () => {
  const found = new Map<string, Record<string, unknown>>();
  for (const [col, email] of [["Work Email", WORK], ["Personal Email", personal]] as const) {
    if (!email) continue;
    const { data, error } = await sb
      .from("global_master_list")
      .select('id, "Name", "Department", "Work Email", "Personal Email", last_seen_upload_id, off_boarded_at, off_boarded_reason, off_boarded_by, created_at, "Start Date"')
      .ilike(`"${col}"`, email);
    if (error) throw new Error(error.message);
    for (const r of data ?? []) found.set(String(r.id), r);
  }
  return [...found.values()];
}, "gml");
console.log(`\n=== global_master_list rows: ${rows.length} ===`);
for (const r of rows) {
  console.log(
    `  id=${r.id}\n    Name=${JSON.stringify(r["Name"])} Dept=${r["Department"]} start=${r["Start Date"]}\n` +
      `    work=${r["Work Email"]} personal=${r["Personal Email"]}\n` +
      `    stamp=${r.last_seen_upload_id === current.id ? "CURRENT" : `STALE(${String(r.last_seen_upload_id).slice(0, 8)})`} created=${r.created_at}\n` +
      `    off_boarded_at=${r.off_boarded_at} reason=${r.off_boarded_reason ?? ""} by=${r.off_boarded_by ?? ""}`,
  );
}

// 3) active view
const { data: act } = await sb.from("active_employees").select('id, "Name", "Department"').ilike('"Work Email"', WORK);
console.log(`\nactive_employees rows: ${act?.length ?? 0} ${JSON.stringify(act ?? [])}`);

// 4) live sheet
const sheetId = process.env.GOOGLE_SHEETS_MASTER_SHEET_ID!.trim();
const tabName = process.env.GOOGLE_SHEETS_MASTER_TAB_NAME!.trim();
const token = await getServiceAccountAccessToken("https://www.googleapis.com/auth/spreadsheets.readonly");
const quotedTab = `'${tabName.replace(/'/g, "''")}'`;
const values: unknown[][] = await retry(async () => {
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(quotedTab)}?valueRenderOption=FORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`,
    { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" },
  );
  const json = (await res.json()) as { values?: unknown[][] };
  if (!res.ok) throw new Error(`sheet read ${res.status}`);
  return json.values ?? [];
}, "sheet");
console.log(`\n=== sheet rows mentioning glaiza (${values.length} raw rows total) ===`);
let hits = 0;
for (let i = 0; i < values.length; i++) {
  const row = values[i] ?? [];
  const joined = row.map((c) => String(c ?? "").toLowerCase()).join(" | ");
  if (joined.includes("glaiza") || (personal && joined.includes(String(personal).toLowerCase()))) {
    hits++;
    console.log(`  row ${i + 1}: ${row.join(" | ")}`);
  }
}
if (!hits) console.log("  NO sheet rows mention glaiza");
