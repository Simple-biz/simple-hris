import { mailableEmail } from "@/lib/email/norm-email";
import { nameTokens } from "@/lib/name/name-tokens";

/**
 * Who a paystub's delivery address may belong to, for ONE work email.
 *
 * A paystub is mailed to a PERSONAL email, never a work email, because work
 * emails get re-issued (Kane, 2026-10-09). But the personal email is LOOKED UP
 * by the work email: the wizard's first tier is the rates-sheet row keyed by it
 * (`resolvePersonalEmail`, paystub-dispatch.md § personal_email). When an
 * address was recycled, that row still carries the PREVIOUS holder's inbox, and
 * 45 statements went to ex-employees between 08-30 and 10-08 (Open item 432;
 * krisd@'s four went to Diez instead of Dolz).
 *
 * Kane ruled (b) on 432: the master list wins when the proposed address belongs
 * to someone who left under the same work email.
 */
export interface AddressHolders {
  /** Active (not off-boarded) `global_master_list` rows carrying this address
   *  as their primary or alternate work email. Zero means nobody holds it now. */
  activeRows: number;
  /** Distinct MAILABLE personal emails on those active rows, lowercased. */
  current: string[];
  /** The names on those active rows, as token sets (see `nameKey`). */
  currentNames: string[][];
  /** Everyone who LEFT under this address (`offboarded_sheet` plus off-boarded
   *  `global_master_list` rows): each distinct mailable personal email, with the
   *  names it was recorded under. */
  previous: Array<{ email: string; names: string[][] }>;
}

export type WithholdReason =
  | "current_holder_has_no_address"
  | "current_holder_ambiguous"
  | "statement_holder_unknown";

export type DeliveryDecision =
  | { kind: "keep" }
  /** The proposed address is a previous holder's; the statement is the current holder's. */
  | { kind: "replace"; to: string }
  /** The proposed address is a previous holder's and the right inbox cannot be
   *  named. Mail NOBODY rather than the previous holder. */
  | { kind: "withhold"; reason: WithholdReason };

/** Name → sorted token set, periods dropped ("Ma." = "Ma"). Empty for no name. */
export function nameKey(name: string | null | undefined): string[] {
  if (!name) return [];
  return [...new Set(nameTokens(name).map((t) => t.replace(/\./g, "")).filter(Boolean))].sort();
}

/**
 * Two names are the same person when one token set contains the other and they
 * share at least two tokens ("Aireen Pinili" ⊂ "Pinili, Aireen Grace"). Neither
 * containing the other is two people even with a shared surname: "Sarmiento,
 * Rodney Clark" and "Sarmiento, Rodney Ken" both held rodneys@.
 */
export function sameName(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const [small, big] = a.length <= b.length ? [a, b] : [b, a];
  const bigSet = new Set(big);
  return small.length >= 2 && small.every((t) => bigSet.has(t));
}

const matchesAny = (n: string[], pool: string[][]) => pool.some((p) => sameName(n, p));

/**
 * Decide where one statement for this work email may be mailed.
 *
 * - An unmailable proposal is not this function's business: the existing
 *   missing-address path (wizard warning, n8n skip) owns it.
 * - With NO active holder there is no current holder to prefer. The proposal
 *   stands (Open item 432 names the residual: an address whose LATEST holder
 *   also left).
 * - A proposal that is not a previous holder's, or that the current holder also
 *   carries, stands.
 * - Otherwise the proposal is someone who left, and the STATEMENT'S NAME says
 *   whose pay it is. Holders can overlap (aaronr@: Ramilo started 08-03 while
 *   Ramo worked on until 10-06), so a date cannot decide it:
 *   - named for the current holder (and not for a different person who left with
 *     this address) → the current holder's address, when there is exactly one;
 *   - named for the person who left with this address → it is THEIR statement,
 *     and it stays theirs (settling an old held week must never re-point it);
 *   - neither, or two different people → withheld. Never a guess.
 *   A rehire whose old and new rows carry the same name is one person, and gets
 *   the current address.
 */
export function decidePaystubDeliveryAddress(
  proposed: string | null | undefined,
  holders: AddressHolders | undefined,
  statementName: string | null | undefined,
): DeliveryDecision {
  const p = mailableEmail(proposed);
  if (!p || !holders || holders.activeRows === 0) return { kind: "keep" };
  const leftWith = holders.previous.find((x) => x.email === p);
  if (!leftWith) return { kind: "keep" };
  if (holders.current.includes(p)) return { kind: "keep" };

  const n = nameKey(statementName);
  const isCurrent = matchesAny(n, holders.currentNames);
  const isLeaver = matchesAny(n, leftWith.names);
  const leaverIsCurrent = leftWith.names.some((ln) => matchesAny(ln, holders.currentNames));

  if (isCurrent && (!isLeaver || leaverIsCurrent)) {
    if (holders.current.length === 1) return { kind: "replace", to: holders.current[0] };
    return {
      kind: "withhold",
      reason: holders.current.length === 0 ? "current_holder_has_no_address" : "current_holder_ambiguous",
    };
  }
  if (isLeaver && !isCurrent) return { kind: "keep" };
  return { kind: "withhold", reason: "statement_holder_unknown" };
}

/** Plain-language reason for a withheld paystub, for toasts and `last_error`. */
export function withheldReasonText(workEmail: string, reason: WithholdReason): string {
  const head = `Not sent: the personal email on file for ${workEmail} belongs to someone who left under that address`;
  switch (reason) {
    case "current_holder_has_no_address":
      return `${head}, and its current holder has no personal email on the master list.`;
    case "current_holder_ambiguous":
      return `${head}, and its current master rows carry more than one personal email.`;
    case "statement_holder_unknown":
      return `${head}, and the name on the statement matches neither them nor the current holder.`;
  }
}

type Payload = Record<string, unknown> | null | undefined;

export interface GuardableEntry {
  recipient_email: string;
  recipient_name?: string | null;
  personal_email?: string | null;
  payload?: Payload;
}

export interface GuardOutcome {
  recipient_email: string;
  kind: "replace" | "withhold";
  reason?: WithholdReason;
}

/** The name a staged statement is FOR: the payload's (what the email prints), else the entry's. */
export function statementNameOf(entry: { recipient_name?: string | null; payload?: Payload }): string | null {
  const fromPayload = entry.payload && typeof entry.payload.name === "string" ? entry.payload.name : null;
  return fromPayload || entry.recipient_name || null;
}

/**
 * Apply the decision to staged entries. The payload's `personal_email` is what
 * n8n mails, so it is the one judged; the entry column follows it. A replaced
 * or withheld entry gets BOTH fields rewritten, so the queue row can never
 * disagree with the payload it carries. Entries are returned as new objects.
 */
export function guardPaystubEntries<T extends GuardableEntry>(
  entries: T[],
  holdersByWorkEmail: Map<string, AddressHolders>,
): { entries: T[]; outcomes: GuardOutcome[] } {
  const outcomes: GuardOutcome[] = [];
  const out = entries.map((e) => {
    const we = e.recipient_email.trim().toLowerCase();
    const payloadEmail = e.payload && typeof e.payload.personal_email === "string" ? e.payload.personal_email : null;
    const decision = decidePaystubDeliveryAddress(payloadEmail ?? e.personal_email, holdersByWorkEmail.get(we), statementNameOf(e));
    if (decision.kind === "keep") return e;
    const to = decision.kind === "replace" ? decision.to : null;
    outcomes.push(
      decision.kind === "replace"
        ? { recipient_email: we, kind: "replace" }
        : { recipient_email: we, kind: "withhold", reason: decision.reason },
    );
    return {
      ...e,
      personal_email: to,
      payload: e.payload ? { ...e.payload, personal_email: to } : e.payload,
    };
  });
  return { entries: out, outcomes };
}
