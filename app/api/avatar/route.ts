import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Redirects to Gravatar for `email` (MD5 hash, same algorithm Gravatar uses).
 *
 * Query:
 * - `email` (required) — trimmed, lowercased for hashing
 * - `s` — pixel size (default 128)
 * - `d` — Gravatar default: use `404` so &lt;img onError&gt; can fall back to initials when no Gravatar exists
 *
 * Note: This is **not** the Google account photo. Google does not offer a public URL for profile
 * pictures by email only. Real Google avatars require OAuth (Sign in with Google) or Workspace
 * Directory API with admin credentials.
 */
export async function GET(req: NextRequest) {
  const email = req.nextUrl.searchParams.get("email")?.trim().toLowerCase();
  if (!email) {
    return NextResponse.json({ error: "Missing email" }, { status: 400 });
  }

  const hash = createHash("md5").update(email).digest("hex");
  const s = req.nextUrl.searchParams.get("s") ?? "128";
  const d = req.nextUrl.searchParams.get("d") ?? "404";

  const url = `https://www.gravatar.com/avatar/${hash}?s=${encodeURIComponent(s)}&d=${encodeURIComponent(d)}&r=pg`;
  return NextResponse.redirect(url);
}
