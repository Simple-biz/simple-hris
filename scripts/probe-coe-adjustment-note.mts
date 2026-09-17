/**
 * READ-ONLY: what IS the 25,000 on gyd@'s 2026-08-23 week? Prints the wizard's
 * additions overlay (the "Adj." column + its note) and the final_pay snapshot's
 * own itemisation, so the COE's exclusion of the Adjustment line can be judged
 * against what the money actually was.
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config();

const { createSupabaseServiceRoleClient } = await import("../src/lib/supabase/server");
const supabase = createSupabaseServiceRoleClient();
if (!supabase) { console.error("no client"); process.exit(1); }

const EMAIL = (process.argv[2] ?? "gyd@simple.biz").toLowerCase();
const FILES = process.argv.slice(3).length
  ? process.argv.slice(3)
  : ["simple-biz_daily_report_2026-08-23_to_2026-08-29.csv", "simple-biz_daily_report_2026-07-26_to_2026-08-01.csv"];

for (const file of FILES) {
  for (const prefix of ["payroll.wizard.additions.", "payroll.wizard.final_pay."]) {
    const key = prefix + file;
    const { data, error } = await supabase.from("app_settings").select("key, value").eq("key", key).maybeSingle();
    if (error) { console.log(`\n${key}: ERROR ${error.message}`); continue; }
    if (!data) { console.log(`\n${key}: ABSENT`); continue; }
    let parsed: any = null;
    try { parsed = JSON.parse(String((data as any).value)); } catch { console.log(`\n${key}: unparseable`); continue; }
    // Find this person's entry wherever it lives in the blob.
    const hits: Array<[string, unknown]> = [];
    const walk = (node: any, path: string, depth: number) => {
      if (depth > 4 || node == null || typeof node !== "object") return;
      for (const [k, v] of Object.entries(node)) {
        if (k.toLowerCase().includes(EMAIL.split("@")[0]) || k.toLowerCase() === EMAIL) hits.push([`${path}.${k}`, v]);
        else walk(v, `${path}.${k}`, depth + 1);
      }
    };
    walk(parsed, "", 0);
    console.log(`\n${key}: ${hits.length} entr${hits.length === 1 ? "y" : "ies"} for ${EMAIL}`);
    for (const [p, v] of hits) console.log(`  ${p} = ${JSON.stringify(v, null, 2)}`);
    if (hits.length === 0) console.log("  top-level keys:", Object.keys(parsed).slice(0, 12).join(", "));
  }
}
console.log("\nDone — read-only.");
