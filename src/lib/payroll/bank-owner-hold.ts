import { normEmail } from '@/lib/email/norm-email';

/**
 * Does the bank / wallet row Payment Dispatch would pay into belong to someone
 * other than the person being paid? The pure core of the `bank_owner_mismatch`
 * hold (`useDispatchQueue`, docs/features/payment-dispatch.md §3.7).
 *
 * Dispatch finds the payout row (`employee_ids`) by WORK EMAIL. Work emails were
 * recycled, so that row could be a previous holder's: Mary Angelie Tudtud's
 * first week would have paid Mary Rose Tronco's Hurupay wallet through Mary Jean
 * Tan's row (audit item 344), and on 2026-10-05 `markp@` (Pahunang) and
 * `michaelc@` (Cuyos) still pay into rows named Pardillo and Carpio.
 *
 * The anchor is the PAYEE's identity, never the rates row (which a recycled
 * address shares with the previous holder): the Global Master List row's name and
 * personal email, else, for someone with hours but no master row yet, the Hubstaff
 * member name.
 *
 * Personal email alone is NOT enough to hold. On the 2026-10-05 live week it
 * would have held 19 payees, about 16 of them the same person with a variant
 * address (`…@gmailcom`, hotmail vs gmail, a dropped dot). So a row is held only
 * when the personal emails do not positively match AND neither name's surname
 * appears in the other name. A name that is not a person's name (an email
 * address in the `name` column, a blank) proves nothing, and the row is not held.
 */
export interface BankOwnerHoldInput {
  /** Lowercased work email the queue row is keyed by. */
  workEmail: string;
  payee: { name: string | null; personalEmail: string | null } | null;
  bank: { workEmail: string | null; name: string | null; personalEmail: string | null } | null;
}

const PARTICLES = new Set(['de', 'del', 'dela', 'la', 'los', 'san', 'sta', 'van', 'von', 'da', 'di', 'jr', 'sr', 'ii', 'iii', 'iv']);

function cleanName(raw: string): string {
  return raw
    .toLowerCase()
    // Quoted nicknames: "Kane", “Kane”, ‘Kane’ — any pairing of straight/curly quotes.
    .replace(/["“”'‘’][^"“”'‘’]*["“”'‘’]/g, ' ')
    .replace(/["“”'‘’]/g, ' ');
}

function tokensOf(part: string): string[] {
  return part
    .split(/[^a-zñáéíóúü]+/i)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !PARTICLES.has(t));
}

/** Every name token, or null when the value is not a person's name. */
export function personNameTokens(raw: string | null | undefined): Set<string> | null {
  const s = (raw ?? '').trim();
  if (!s || s.includes('@')) return null;
  const toks = tokensOf(cleanName(s));
  return toks.length > 0 ? new Set(toks) : null;
}

/** "Last, First" → the tokens before the comma; "First Middle Last" → the last token. */
export function surnameTokens(raw: string | null | undefined): string[] {
  const s = (raw ?? '').trim();
  if (!s || s.includes('@')) return [];
  const cleaned = cleanName(s);
  if (cleaned.includes(',')) return tokensOf(cleaned.split(',')[0]).filter((t) => t.length >= 3);
  const toks = tokensOf(cleaned);
  return toks.length > 0 ? [toks[toks.length - 1]] : [];
}

export function bankBelongsToSomeoneElse(input: BankOwnerHoldInput): boolean {
  const { payee, bank } = input;
  if (!payee || !bank) return false;
  // A row found through the payee's personal email is keyed to THEM, not to the
  // address — only a row sitting on the work email can be a previous holder's.
  if (normEmail(bank.workEmail ?? '') !== normEmail(input.workEmail)) return false;

  const payeePersonal = normEmail(payee.personalEmail ?? '');
  const bankPersonal = normEmail(bank.personalEmail ?? '');
  if (payeePersonal && bankPersonal && payeePersonal === bankPersonal) return false;

  const payeeTokens = personNameTokens(payee.name);
  const bankTokens = personNameTokens(bank.name);
  if (!payeeTokens || !bankTokens) return false;

  const sameSurname =
    surnameTokens(payee.name).some((t) => bankTokens.has(t)) ||
    surnameTokens(bank.name).some((t) => payeeTokens.has(t));
  return !sameSurname;
}
