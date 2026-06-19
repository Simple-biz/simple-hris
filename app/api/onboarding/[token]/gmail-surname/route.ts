import { NextResponse } from "next/server";
import { getHrOnboardingSubmissionByToken } from "@/lib/supabase/hr-onboarding-submissions";
import { workEmailCandidates, normalizeNamePart } from "@/lib/hr/work-email";
import { loadTakenWorkEmails } from "@/lib/hr/work-email-server";
import { requireElevatedSession, deniedResponse } from "@/lib/auth/authorize-email";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/onboarding/[token]/gmail-surname
 *
 * Public — the onboarding token is the auth. Given the hire's first + last name,
 * returns the read-only "Gmail Surname": the minimal last-name slice that makes
 * <first><slice>@simple.biz unique against the live roster, UPPER-cased.
 *
 * Mirrors the work-email rule (src/lib/hr/work-email.ts): e.g. "Kane Reroma"
 * (first to join) -> "R" (kaner@…); a later "Kane Reiner" finds "kaner" taken,
 * so it lengthens the slice -> "RE" (kanere@…). Only the slice is returned — the
 * roster's addresses are never exposed.
 */
export async function POST(
  req: Request,
  context: { params: Promise<{ token: string }> },
) {
  const { token } = await context.params;
  if (!token) {
    return NextResponse.json({ error: "Missing token" }, { status: 400 });
  }

  const { row, error: lookupErr } = await getHrOnboardingSubmissionByToken(token);
  if (lookupErr) return NextResponse.json({ error: lookupErr }, { status: 500 });

  // Auth + scope:
  //  • a real onboarding token is gated by its submission row (pending/submitted
  //    OK; archived links are dead);
  //  • the HR-facing "/onboarding/preview" has no row — gate it by an elevated
  //    session so the preview still gets roster-accurate, collision-aware
  //    surnames (otherwise it could only guess the bare initial).
  if (row) {
    if (row.status === "archived") {
      return NextResponse.json(
        { error: "This onboarding link is no longer active." },
        { status: 409 },
      );
    }
  } else if (token === "preview") {
    const authz = await requireElevatedSession();
    if (!authz.ok) return deniedResponse(authz);
  } else {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let body: { first?: string; last?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const first = (body.first ?? "").trim();
  const last = (body.last ?? "").trim();
  const f = normalizeNamePart(first);
  const l = normalizeNamePart(last);
  // Need both a first name and a last name to derive a surname slice.
  if (!f || !l) return NextResponse.json({ gmail_surname: "" });

  let taken: Set<string>;
  try {
    taken = await loadTakenWorkEmails();
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to read roster" },
      { status: 500 },
    );
  }
  // A re-submission may already hold its own minted address — don't collide
  // with self, or the slice would needlessly lengthen.
  const self = row?.work_email?.trim().toLowerCase();
  if (self) taken.delete(self);

  // Walk the progressive surname slices ("r", "re", "rei", … up to the full
  // surname) and take the first whose <first><slice>@domain is free. We use
  // workEmailCandidates (NOT suggestWorkEmail) on purpose: its numeric fallback
  // (e.g. "kanereiner2") would leak the FULL surname + a digit into the Google
  // account — the opposite of the privacy goal. If every slice collides we use
  // the longest one (full surname, no digit) as a last resort.
  const candidates = workEmailCandidates(first, last);
  if (candidates.length === 0) return NextResponse.json({ gmail_surname: "" });
  const chosen =
    candidates.find((c) => !taken.has(c.email)) ?? candidates[candidates.length - 1]!;

  // The surname is the local part with the first-name prefix removed.
  const slice = chosen.localPart.startsWith(f)
    ? chosen.localPart.slice(f.length)
    : "";
  return NextResponse.json({ gmail_surname: slice.toUpperCase() });
}
