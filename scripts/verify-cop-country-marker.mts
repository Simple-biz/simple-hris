/**
 * READ-ONLY verifier: runs the REAL `computeCurrentPay()` and reports which
 * payees carry `countryCurrency: 'COP'` (Colombian staff riding the PHP rails)
 * plus their native COP figure — the marker Payment Dispatch uses to swap the
 * secondary amount / Mark Paid dialog sub-line from PHP to COP.
 *
 * Usage:
 *   $env:TSX_TSCONFIG_PATH="tsconfig.readiness-verify.json"; node --import tsx scripts/verify-cop-country-marker.mts [source_file]
 */
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config();

const sourceFile = process.argv[2] ?? null;

// Import AFTER dotenv so the Supabase clients see the env when constructed.
const { computeCurrentPay } = await import("../src/lib/payroll/current-pay");

const r = await computeCurrentPay(sourceFile ? { sourceFile } : undefined);

console.log(`cycle: ${r.period.sourceFile ?? "(none)"}  fx usd→php=${r.fxRate} usd→cop=${r.fxRates.usdToCop}`);

const entries = Object.entries(r.byEmail);
const cop = entries.filter(([, e]) => e.countryCurrency === "COP");
const marked = entries.filter(([, e]) => e.countryCurrency != null);

console.log(`payees: ${entries.length} · countryCurrency set: ${marked.length} · COP: ${cop.length}`);
for (const [email, e] of cop) {
  console.log(
    `  ${email}  dept=${e.departmentKey ?? "—"}  payCurrency=${e.payCurrency}  ` +
      `PHP=${e.totalPayPHP ?? "—"}  USD=${e.totalPayUSD ?? "—"}  COP=${e.totalPayCOP ?? "—"}`,
  );
}

// Currency spread across all markers, so a bad country mapping is obvious.
const byCur = new Map<string, number>();
for (const [, e] of marked) byCur.set(e.countryCurrency!, (byCur.get(e.countryCurrency!) ?? 0) + 1);
console.log("marker spread:", JSON.stringify(Object.fromEntries(byCur)));
