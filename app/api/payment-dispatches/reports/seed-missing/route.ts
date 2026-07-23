import { NextRequest, NextResponse } from "next/server";
import { seedMissingDisbursementRecords } from "@/lib/payroll/disbursement-reports";
import { requireFeatureEdit } from "@/lib/auth/authorize-feature";
import { deniedResponse } from "@/lib/auth/authorize-email";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const authz = await requireFeatureEdit('accounting', 'payment_dispatch');
    if (!authz.ok) return deniedResponse(authz);

    // Optional { sourceFiles: string[] } — seed only those uploads. Absent/empty
    // body preserves the original "seed all unseeded" behaviour. Tolerate a
    // missing or non-JSON body (the "Seed all" button POSTs with no body).
    let sourceFiles: string[] | undefined;
    try {
      const body = (await req.json()) as { sourceFiles?: unknown } | null;
      if (body && Array.isArray(body.sourceFiles)) {
        sourceFiles = body.sourceFiles.filter((f): f is string => typeof f === "string");
      }
    } catch {
      // no body / invalid JSON → seed all
    }

    const { seeded, error } = await seedMissingDisbursementRecords(
      sourceFiles ? { sourceFiles } : {},
    );
    if (error) {
      return NextResponse.json({ seeded: 0, error }, { status: 500 });
    }
    return NextResponse.json({ seeded, error: null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ seeded: 0, error: msg }, { status: 500 });
  }
}
