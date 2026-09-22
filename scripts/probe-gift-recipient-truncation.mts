/**
 * READ-ONLY probe — how many alternate-recipient names are a one-character stub?
 *
 *   npx tsx scripts/probe-gift-recipient-truncation.mts
 *
 * The public /update-gift-address form swaps its recipient editor for the amber
 * "Still going to someone else" summary the moment `recipientName` is non-blank,
 * so a name first typed there can only ever be one character long. This counts
 * the rows that carry the damage. Writes nothing.
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing');

type Row = {
  id: string;
  personal_email: string | null;
  recipient_name: string | null;
  recipient_relationship: string | null;
  recipient_contact: string | null;
  notes: string | null;
  updated_at: string | null;
};

const cols = 'id,personal_email,recipient_name,recipient_relationship,recipient_contact,notes,updated_at';
const rows: Row[] = [];
for (let from = 0; ; from += 1000) {
  const res = await fetch(`${url}/rest/v1/employee_gift_shipping_details?select=${cols}&order=id`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, Range: `${from}-${from + 999}` },
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const page = (await res.json()) as Row[];
  rows.push(...page);
  if (page.length < 1000) break;
}

const named = rows.filter((r) => (r.recipient_name ?? '').trim() !== '');
const stub = named.filter((r) => (r.recipient_name ?? '').trim().length <= 3);

console.log(`total shipping detail rows : ${rows.length}`);
console.log(`rows with a recipient name : ${named.length}`);
console.log(`name <= 3 chars (suspect)  : ${stub.length}\n`);
for (const r of named) {
  const n = (r.recipient_name ?? '').trim();
  console.log(
    `${String(n.length).padStart(3)}  "${n}" (${(r.recipient_relationship ?? '').trim() || 'NO RELATIONSHIP'})  ${r.personal_email ?? ''}  ${r.updated_at ?? ''}${n.length <= 3 ? '  <<< STUB' : ''}`,
  );
  if (n.length <= 3 && (r.notes ?? '').trim()) {
    console.log(`     notes: ${(r.notes ?? '').trim().slice(0, 200)}`);
  }
}
