import { NextResponse } from "next/server";
import {
  getHrOnboardingSubmissionByToken,
  uploadW8BenFile,
} from "@/lib/supabase/hr-onboarding-submissions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const ALLOWED_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/jpg",
]);

/**
 * POST /api/onboarding/[token]/w8ben
 *
 * Public — the token gates the upload. We store the PDF in a private storage
 * bucket and return the storage path so the form can include it in the
 * final submit POST.
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
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (row.status !== "pending") {
    return NextResponse.json(
      { error: "This onboarding form has already been submitted." },
      { status: 409 },
    );
  }

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: "File too large (max 10 MB)" },
      { status: 400 },
    );
  }
  if (file.type && !ALLOWED_TYPES.has(file.type)) {
    return NextResponse.json(
      { error: "Only PDF / PNG / JPG uploads are accepted" },
      { status: 400 },
    );
  }

  const buffer = await file.arrayBuffer();
  const { path, error: uploadErr } = await uploadW8BenFile(
    row.id,
    buffer,
    file.type,
    file.name,
  );
  if (uploadErr) return NextResponse.json({ error: uploadErr }, { status: 500 });

  return NextResponse.json({ path, name: file.name });
}
