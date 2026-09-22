/**
 * READ-ONLY probe: does the opt-in route's new alias guard actually see the
 * account an aliased member already holds?
 *
 * `POST /api/toggle-mesa-member` resolved the open account by the ONE email it
 * was handed. For a member whose MESA identity drifted (`dale@simple.biz` on
 * `mesa_accounts`, `dales@simple.biz` on the roster) it found none and minted a
 * SECOND account dated today, hiding the balance they already hold
 * (docs/features/mesa.md:225). `getOpenMesaAccountAcrossAliases` is the refusal
 * that replaced that; this proves it against the real registry rather than
 * asserting it.
 *
 * Writes NOTHING. Usage:
 *   node --import tsx scripts/probe-mesa-alias-account-guard.mts
 */
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config();

const { getOpenMesaAccount, getOpenMesaAccountAcrossAliases } = await import(
  "../src/lib/supabase/mesa-accounts"
);
const { aliasAccountConflict } = await import("../src/lib/mesa/enrollment-date");
const { mesaEmailAliasesFor } = await import("../src/lib/mesa/email-aliases");
const rawAliases = (await import("../src/data/mesa-email-aliases.json")).default as Record<string, string>;

// Every roster address the alias map points at, plus a control that has no alias.
const rosterTargets = [...new Set(Object.values(rawAliases))].sort();
const CONTROL = "kaner@simple.biz";

console.log("\nMESA alias account guard — read-only\n" + "=".repeat(78));
console.log(`alias map: ${Object.keys(rawAliases).length} pairs -> ${rosterTargets.length} roster addresses\n`);

let wouldHaveMinted = 0;

for (const email of [...rosterTargets, CONTROL]) {
  const aliases = mesaEmailAliasesFor(email).filter((e) => e !== email);
  const own = await getOpenMesaAccount(email);
  const viaAlias = await getOpenMesaAccountAcrossAliases(email);

  if (!viaAlias.ok) {
    console.log(`${email}\n  LOOKUP FAILED: ${viaAlias.error}  (route would 503 and write nothing)`);
    continue;
  }

  const found = viaAlias.found;
  const verdict = own
    ? "already enrolled under its own address — the pre-existing open-account check owns this"
    : found
      ? "REFUSED by the new guard"
      : "no open account anywhere — opt-in proceeds as before";

  console.log(`${email}`);
  console.log(`  aliases        : ${aliases.length ? aliases.join(", ") : "(none)"}`);
  console.log(`  own open acct  : ${own?.account_number ?? "none"}`);
  console.log(`  alias open acct: ${found ? `${found.account.account_number} (${found.email}, opened ${found.account.opened_on})` : "none"}`);
  console.log(`  verdict        : ${verdict}`);

  if (!own && found) {
    wouldHaveMinted += 1;
    console.log(`  refusal        : ${aliasAccountConflict(email, found)}`);
  }
  console.log("");
}

console.log("=".repeat(78));
console.log(
  `${wouldHaveMinted} member(s) would have had a SECOND account minted over their savings by an Opt In click.`,
);
console.log("The guard now refuses each with a 409 and writes nothing.\n");
