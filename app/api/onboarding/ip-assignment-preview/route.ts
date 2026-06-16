import { NextResponse } from "next/server";
import { generateIpAssignmentPdf } from "@/lib/onboarding/ip-assignment-pdf";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/onboarding/ip-assignment-preview
 *
 * Dry-run renderer for the Intellectual Property Assignment. Takes the name,
 * drawn signature, and date the hire entered on the form and returns the SAME
 * filled PDF the real submit would store — but writes nothing to the database
 * or storage. Powers the "preview" mode's Submit button so HR can see exactly
 * what the signed document looks like before the feature is live (no migration
 * or real onboarding link required). Public, like the rest of /api/onboarding.
 */
export async function POST(req: Request) {
  let body: { name?: string; signatureDataUrl?: string | null; dateIso?: string | null };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const pdf = await generateIpAssignmentPdf({
      name: (body.name ?? "").trim() || "Participant",
      signatureDataUrl: body.signatureDataUrl ?? null,
      dateIso: body.dateIso ?? null,
    });
    return new NextResponse(Buffer.from(pdf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": 'inline; filename="IP-Assignment-preview.pdf"',
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to render PDF" },
      { status: 500 },
    );
  }
}
