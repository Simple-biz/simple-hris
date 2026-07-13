import { NextResponse } from "next/server";
import { suggestCallToolsUsername } from "@/lib/hr/calltools-username";
import { loadTakenCallToolsUsernames } from "@/lib/hr/calltools-username-server";
import { requireElevatedSession, deniedResponse } from "@/lib/auth/authorize-email";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/onboarding/preview/calltools-username
 *
 * PREVIEW-ONLY (elevated session required): powers the live "CallTools
 * Username" field HR sees on /onboarding/preview with "Test as Lead Gen" on.
 * Given a nickname + first + last name, returns the collision-aware username
 * "<Nickname> <first initial>. <surname slice>." — e.g. James Thomas going by
 * "Mikey" -> "Mikey J. T."; a second identical combination -> "Mikey J. TH."
 * (see src/lib/hr/calltools-username.ts).
 *
 * Real hires NEVER call this: the username is hidden from the actual
 * paperwork and minted server-side by POST /api/onboarding/[token] at submit
 * time, so a token-holding hire can't probe which usernames exist.
 */
export async function POST(
  req: Request,
  context: { params: Promise<{ token: string }> },
) {
  const { token } = await context.params;
  if (token !== "preview") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const authz = await requireElevatedSession();
  if (!authz.ok) return deniedResponse(authz);

  let body: { nickname?: string; first?: string; last?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const nickname = (body.nickname ?? "").trim();
  const first = (body.first ?? "").trim();
  const last = (body.last ?? "").trim();
  if (!nickname || !first) {
    return NextResponse.json({ calltools_username: "" });
  }

  let taken: Set<string>;
  try {
    taken = await loadTakenCallToolsUsernames();
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to read usernames" },
      { status: 500 },
    );
  }

  const username = suggestCallToolsUsername(nickname, first, last, taken);
  return NextResponse.json({ calltools_username: username ?? "" });
}
