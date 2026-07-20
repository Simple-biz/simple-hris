// MESA email-drift bridge.
//
// The MESA program tracker (sheet → mesa_ledger) keys each member by whatever
// email they had at signup. Some of those addresses no longer match the
// person's CURRENT Global-Master-List email (e.g. the sheet still says
// `jennb@simple.biz`, but the roster now knows her as `jeanneb@simple.biz`).
// Because the Accounting tabs join ledger→roster BY EMAIL, a drifted address
// silently detaches a member from their own contributions — they look empty and
// fall to Non Members even though they're actively saving.
//
// This map (old ledger email → current roster email) reattaches them. It is
// applied in three places, all reading THIS single source:
//   • src/lib/mesa/ledger.ts  → summarizeMembers() groups events by resolved email
//   • app/api/mesa-ledger/route.ts → per-member fetch pulls all aliased emails
//   • scripts/load-mesa-ledger-from-csv.mjs → re-keys rows on every sheet reload
//
// To add a member: put their old ledger email as the key and current roster
// email as the value (both lowercased). Only add SAME-PERSON pairs (confirmed by
// name) — a wrong entry would merge two people's savings.
import rawAliases from '@/data/mesa-email-aliases.json';
import { normEmail } from '@/lib/email/norm-email';

const ALIASES: Record<string, string> = rawAliases as Record<string, string>;

/**
 * Resolve a MESA ledger email to the member's CURRENT roster email by following
 * the drift map. Returns the normalized (lowercased) input when there's no
 * alias, or null for an empty/blank email.
 */
export function resolveMesaEmail(email: string | null | undefined): string | null {
  const e = normEmail(email);
  if (!e) return null;
  return ALIASES[e] ?? e;
}

/**
 * Every ledger email that belongs to the given roster email, including itself —
 * for querying a member's full history while the DB still holds pre-drift
 * addresses. e.g. mesaEmailAliasesFor('jeanneb@simple.biz') →
 * ['jeanneb@simple.biz', 'jennb@simple.biz'].
 */
export function mesaEmailAliasesFor(email: string | null | undefined): string[] {
  const e = normEmail(email);
  if (!e) return [];
  const out = new Set<string>([e]);
  for (const [oldEmail, newEmail] of Object.entries(ALIASES)) {
    if (newEmail === e) out.add(oldEmail);
  }
  return [...out];
}
