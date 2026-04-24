import {
  getProfilePhotoUrlForEmail,
  uploadEmployeeProfilePhotoAndUpdateRow,
} from "@/lib/supabase/employee-profile-photo";
import { MAX_PROFILE_PHOTO_BYTES } from "@/lib/images/compress-profile-photo";
import { NextResponse } from "next/server";
import { authorizeEmailAccess, deniedResponse } from "@/lib/auth/authorize-email";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET ?email= — returns stored profile photo URL from the master list (if any).
 */
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const email = searchParams.get("email")?.trim();
    if (!email) {
      return NextResponse.json({ error: "email query parameter is required" }, { status: 400 });
    }

    const authz = await authorizeEmailAccess(email);
    if (!authz.ok) return deniedResponse(authz);

    const profilePhotoUrl = await getProfilePhotoUrlForEmail(authz.effectiveEmail);
    return NextResponse.json({ profilePhotoUrl });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/**
 * POST multipart: email + file (image). Expects the file to be at most 5 MiB (client should compress).
 */
export async function POST(req: Request) {
  try {
    const ct = req.headers.get("content-type") ?? "";
    if (!ct.includes("multipart/form-data")) {
      return NextResponse.json(
        { error: "Expected multipart/form-data with email and file" },
        { status: 400 },
      );
    }

    const form = await req.formData();
    const email = String(form.get("email") ?? "").trim();
    const file = form.get("file");

    if (!email) {
      return NextResponse.json({ error: "email is required" }, { status: 400 });
    }

    const authz = await authorizeEmailAccess(email);
    if (!authz.ok) return deniedResponse(authz);

    if (!(file instanceof Blob)) {
      return NextResponse.json({ error: "file is required" }, { status: 400 });
    }

    if (file.size > MAX_PROFILE_PHOTO_BYTES) {
      return NextResponse.json(
        {
          error: `Upload must be at most ${MAX_PROFILE_PHOTO_BYTES / (1024 * 1024)} MB (compress in the browser first).`,
        },
        { status: 400 },
      );
    }

    const type = file.type || "application/octet-stream";
    if (!type.startsWith("image/")) {
      return NextResponse.json({ error: "Only image uploads are allowed" }, { status: 400 });
    }

    const buf = await file.arrayBuffer();
    const result = await uploadEmployeeProfilePhotoAndUpdateRow(authz.effectiveEmail, buf);
    if ("error" in result) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }

    return NextResponse.json({ profilePhotoUrl: result.publicUrl });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
