/**
 * READ-ONLY audit of the free-text bank columns behind Payment Catalog →
 * Pay Processors → **Current Banks**.
 *
 * `employee_ids.bank_name` / `alt_bank_name` are free text. `bank-preferred-routing.md`
 * §10.1 measured "~100 distinct spellings of maybe 30 banks" and forbade a bank-name
 * breakdown on the People KPI band until the column is normalized. The Current Banks
 * tab normalizes for DISPLAY through a **declared** alias table (`OFFICIAL_BANKS` in
 * `src/lib/payment-catalog/banks.ts`) — never a fuzzy match.
 *
 * This script is what keeps that table honest. It prints:
 *   1. every distinct raw spelling with its counts (preferred slot / alt slot);
 *   2. what `foldBankSpellings` does with each — which official bank claimed it, or
 *      UNMATCHED (it becomes its own card until someone maps it);
 *   3. the folded leaderboard the tab will render.
 *
 * Run it BEFORE editing the alias table, and again after, so a new alias is proven
 * against the live data instead of assumed. An UNMATCHED spelling is not a bug — it is
 * a bank nobody has mapped yet, and inventing an equivalence to clear it is worse than
 * leaving it.
 *
 * Usage:
 *   node --import tsx scripts/audit-bank-spellings.mts
 *   node --import tsx scripts/audit-bank-spellings.mts --unmatched   # only the gaps
 *
 * Writes nothing. Every query is a SELECT.
 */
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });
dotenv.config();

const { getEmployeeIds } = await import('../src/lib/supabase/employee-ids');
const { foldBankSpellings, officialBankFor, bankSpellingKey } = await import(
  '../src/lib/payment-catalog/banks'
);

const onlyUnmatched = process.argv.includes('--unmatched');

const { rows, error } = await getEmployeeIds();
if (error) {
  console.error('Could not read employee_ids:', error);
  process.exit(1);
}
console.log(`employee_ids rows: ${rows.length}\n`);

// ── 1. Raw spellings ─────────────────────────────────────────────────────────
const raw = new Map<string, { spelling: string; preferred: number; alt: number }>();
const bump = (spelling: string | null | undefined, slot: 'preferred' | 'alt') => {
  const s = (spelling ?? '').trim();
  if (!s) return;
  const k = s.toLowerCase();
  const e = raw.get(k) ?? { spelling: s, preferred: 0, alt: 0 };
  e[slot] += 1;
  raw.set(k, e);
};
for (const r of rows) {
  const usesAlt = (r.preferred_bank_slot ?? 'primary') === 'alternative';
  bump(r.bank_name, usesAlt ? 'alt' : 'preferred');
  bump(r.alt_bank_name, usesAlt ? 'preferred' : 'alt');
}

const spellings = [...raw.values()].sort((a, b) => b.preferred + b.alt - (a.preferred + a.alt));
console.log(`distinct raw spellings: ${spellings.length}`);

const unmatched = spellings.filter((s) => officialBankFor(s.spelling) === null);
console.log(`unmatched by the alias table: ${unmatched.length}\n`);

if (!onlyUnmatched) {
  console.log('── every raw spelling ─────────────────────────────────────────');
  for (const s of spellings) {
    const official = officialBankFor(s.spelling);
    console.log(
      `${String(s.preferred + s.alt).padStart(4)}  ${s.spelling.padEnd(46)} ` +
        `key=${bankSpellingKey(s.spelling).padEnd(30)} -> ${official ?? 'UNMATCHED'}`,
    );
  }
  console.log();
}

console.log('── UNMATCHED (their own cards until someone maps them) ────────');
for (const s of unmatched) {
  console.log(`${String(s.preferred + s.alt).padStart(4)}  ${s.spelling}`);
}
console.log();

if (onlyUnmatched) process.exit(0);

// ── 2. The folded view the tab renders ───────────────────────────────────────
const groups = foldBankSpellings(
  rows.map((r) => ({
    bankName: r.bank_name,
    altBankName: r.alt_bank_name,
    preferredSlot: (r.preferred_bank_slot ?? 'primary') === 'alternative' ? 'alternative' : 'primary',
  })),
);

console.log('── folded leaderboard (what Current Banks shows) ──────────────');
for (const g of groups) {
  console.log(
    `${String(g.preferredCount).padStart(4)} paid-here  ` +
      `${String(g.altCount).padStart(4)} alt-only  ${g.name}` +
      (g.official ? '' : '   [unmapped spelling]') +
      (g.spellings.length > 1 ? `\n           spellings: ${g.spellings.join(' · ')}` : ''),
  );
}
console.log(`\ngroups: ${groups.length} (from ${spellings.length} raw spellings)`);
