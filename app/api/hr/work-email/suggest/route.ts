import { NextResponse } from "next/server";
import {
  deniedResponse,
  requireElevatedSession,
} from "@/lib/auth/authorize-email";
import {
  splitFullName,
  suggestWorkEmail,
  WORK_EMAIL_DOMAIN,
  type WorkEmailSuggestion,
} from "@/lib/hr/work-email";
import { loadTakenWorkEmails } from "@/lib/hr/work-email-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/hr/work-email/suggest
 *
 * Body (any subset):
 *   { fullName?, first?, last?, candidate? }
 *
 * Returns:
 *   { suggestion: { email, localPart } | null,
 *     candidate:  { email, available } | null }
 *
 * `suggestion` is computed from the name (fullName split, or explicit
 * first/last). `candidate` echoes an availability check for a specific address
 * HR is editing. The full taken list is never returned — only booleans — so we
 * don't leak the roster's addresses to the client.
 */
export async function POST(req: Request) {
  const authz = await requireElevatedSession();
  if (!authz.ok) return deniedResponse(authz);

  let body: {
    fullName?: string;
    first?: string;
    last?: string;
    candidate?: string;
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

  // Resolve first/last from explicit fields or by splitting the full name.
  let first = body.first?.trim() ?? "";
  let last = body.last?.trim() ?? "";
  if (!first && !last && body.fullName) {
    const s = splitFullName(body.fullName);
    first = s.first;
    last = s.last;
  }

  let suggestion: WorkEmailSuggestion | null = null;
  if (first || last) {
    suggestion = suggestWorkEmail(first, last, taken);
  }

  let candidate: { email: string; available: boolean } | null = null;
  const raw = body.candidate?.trim().toLowerCase();
  if (raw) {
    // Accept either a bare local part or a full address; normalize to a full
    // address on the company domain for the availability lookup.
    const email = raw.includes("@") ? raw : `${raw}@${WORK_EMAIL_DOMAIN}`;
    candidate = { email, available: !taken.has(email) };
  }

  return NextResponse.json({ suggestion, candidate });
}
