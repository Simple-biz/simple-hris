import { NextResponse } from "next/server";
import {
  deniedResponse,
  requireElevatedSession,
} from "@/lib/auth/authorize-email";
import {
  splitFullName,
  suggestWorkEmail,
  workEmailCandidates,
  WORK_EMAIL_DOMAIN,
  type WorkEmailSuggestion,
} from "@/lib/hr/work-email";
import { loadTakenWorkEmails } from "@/lib/hr/work-email-server";
import { verifyWorkspaceAccount } from "@/lib/hr/workspace-account";

// Cap on how many roster-taken candidates we'll verify against Google Workspace
// per request, so a name whose ideal addresses are genuinely in use can't fan
// out into a burst of Directory lookups.
const MAX_VERIFY_LOOKUPS = 4;

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/hr/work-email/suggest
 *
 * Body (any subset):
 *   { fullName?, first?, last?, candidate?, also_taken? }
 *
 * Returns:
 *   { suggestion: { email, localPart } | null,
 *     candidate:  { email, available } | null }
 *
 * `suggestion` is computed from the name (fullName split, or explicit
 * first/last). `candidate` echoes an availability check for a specific address
 * HR is editing. The full taken list is never returned — only booleans — so we
 * don't leak the roster's addresses to the client.
 *
 * `also_taken` lets a caller treat extra addresses as already-in-use on top of
 * the live roster. The bulk set-work-email modal uses this so a batch of
 * not-yet-saved hires gets a UNIQUE suggestion each: it threads the addresses
 * already assigned earlier in the batch through `also_taken`, and two
 * same-named hires no longer collide on the same suggestion (or both pass the
 * availability check).
 */
export async function POST(req: Request) {
  const authz = await requireElevatedSession();
  if (!authz.ok) return deniedResponse(authz);

  let body: {
    fullName?: string;
    first?: string;
    last?: string;
    candidate?: string;
    also_taken?: string[];
    // When true, an address that's "taken" only by the roster is double-checked
    // against Google Workspace (verify webhook); if no real account exists, it's
    // treated as available again. Used by the single Set/Retry dialog so a stale
    // prior claim doesn't permanently burn an otherwise-free address.
    verify?: boolean;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  let taken: Set<string>;
  try {
    taken = await loadTakenWorkEmails();
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to read roster" },
      { status: 500 },
    );
  }

  // Fold in caller-supplied addresses (bare local part or full address) so the
  // suggestion + availability check both treat them as taken.
  if (Array.isArray(body.also_taken)) {
    for (const raw of body.also_taken) {
      const t = String(raw ?? "").trim().toLowerCase();
      if (!t) continue;
      taken.add(t.includes("@") ? t : `${t}@${WORK_EMAIL_DOMAIN}`);
    }
  }

  // Resolve first/last from explicit fields or by splitting the full name.
  let first = body.first?.trim() ?? "";
  let last = body.last?.trim() ?? "";
  if (!first && !last && body.fullName) {
    const s = splitFullName(body.fullName);
    first = s.first;
    last = s.last;
  }

  const verifyEnabled = body.verify === true;

  let suggestion: WorkEmailSuggestion | null = null;
  if (first || last) {
    if (verifyEnabled) {
      // Walk the preferred candidates in order. Take the first that's free in
      // the roster; for an earlier (more ideal) candidate that's only
      // roster-taken, ask Google Workspace — if there's no real account, the
      // claim is stale and we reclaim that address. Falls back to the normal
      // numeric-suffix suggester if everything is genuinely in use.
      let lookups = 0;
      for (const cand of workEmailCandidates(first, last)) {
        if (!taken.has(cand.email)) {
          suggestion = cand;
          break;
        }
        if (lookups >= MAX_VERIFY_LOOKUPS) continue;
        lookups += 1;
        const v = await verifyWorkspaceAccount(cand.email);
        if (v.state === "missing") {
          suggestion = cand; // taken by a stale claim only — reclaim it
          break;
        }
      }
      if (!suggestion) suggestion = suggestWorkEmail(first, last, taken);
    } else {
      suggestion = suggestWorkEmail(first, last, taken);
    }
  }

  let candidate: { email: string; available: boolean; verifiedFree?: boolean } | null = null;
  const raw = body.candidate?.trim().toLowerCase();
  if (raw) {
    // Accept either a bare local part or a full address; normalize to a full
    // address on the company domain for the availability lookup.
    const email = raw.includes("@") ? raw : `${raw}@${WORK_EMAIL_DOMAIN}`;
    let available = !taken.has(email);
    let verifiedFree = false;
    // Roster says taken — but if it's a stale claim with no real Workspace
    // account, free it up. Only flips on a definite "missing" (never on a
    // webhook error), so a real account or an outage keeps it locked.
    if (!available && verifyEnabled && email.endsWith(`@${WORK_EMAIL_DOMAIN}`)) {
      const v = await verifyWorkspaceAccount(email);
      if (v.state === "missing") {
        available = true;
        verifiedFree = true;
      }
    }
    candidate = { email, available, verifiedFree };
  }

  return NextResponse.json({ suggestion, candidate });
}
