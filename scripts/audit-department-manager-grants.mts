/**
 * STRICTLY READ-ONLY. No insert / update / delete / upsert.
 *
 * What shape are the live `department_managers` grants in? Specifically: does
 * HSL really hold per-sub-team `hsl:<key>` grants, and are there family-level
 * grants ("HSL", "Hogan Smith Law") or retired sub-keys that the new scoped
 * editor must leave alone rather than silently revoke?
 */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });
dotenv.config();

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (.env.local)');
  process.exit(1);
}
const sb = createClient(url, key, { auth: { persistSession: false } });

/** PostgREST truncates at 1000 rows even with .range() — always page. */
async function selectAllPaged(table: string, cols: string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  const size = 1000;
  for (let from = 0; ; from += size) {
    const { data, error } = await sb.from(table).select(cols).range(from, from + size - 1);
    if (error) {
      console.error(table, error.message);
      process.exit(1);
    }
    const rows = (data ?? []) as unknown as Record<string, unknown>[];
    out.push(...rows);
    if (rows.length < size) break;
  }
  return out;
}

const rows = await selectAllPaged('department_managers', '*');
console.log('total department_managers rows:', rows.length);
console.log('columns:', Object.keys(rows[0] ?? {}).join(', '));

const active = rows.filter((r) => (r as Record<string, unknown>).is_active !== false && !(r as Record<string, unknown>).revoked_at);
console.log('active rows:', active.length);

const byLabel = new Map<string, string[]>();
for (const r of active) {
  const label = String(r.department ?? '').trim();
  const email = String(r.manager_email ?? '').trim().toLowerCase();
  if (!byLabel.has(label)) byLabel.set(label, []);
  byLabel.get(label)!.push(email);
}

console.log('\n--- every distinct grant label ---');
for (const [label, emails] of [...byLabel].sort((a, b) => a[0].localeCompare(b[0]))) {
  console.log(`${JSON.stringify(label).padEnd(36)} x${String(emails.length).padStart(3)}  ${[...new Set(emails)].join(', ')}`);
}

console.log('\n--- HSL-family labels only ---');
let hslTotal = 0;
for (const [label, emails] of byLabel) {
  const s = label.toLowerCase();
  if (s.startsWith('hsl') || s === 'hogan smith law' || s === 'hogan_smith_law') {
    hslTotal += emails.length;
    const kind = s.startsWith('hsl:') ? 'SUB-TEAM' : 'FAMILY-LEVEL (unscoped by the new editor)';
    console.log(`${JSON.stringify(label).padEnd(36)} ${kind.padEnd(42)} ${[...new Set(emails)].join(', ')}`);
  }
}
console.log('HSL-family grant rows:', hslTotal);
