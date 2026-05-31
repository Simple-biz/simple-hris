import { NextResponse } from "next/server";
import { seedMissingDisbursementRecords } from "@/lib/payroll/disbursement-reports";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST() {
  try {
    const { seeded, error } = await seedMissingDisbursementRecords();
    if (error) {
      return NextResponse.json({ seeded: 0, error }, { status: 500 });
    }
    return NextResponse.json({ seeded, error: null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ seeded: 0, error: msg }, { status: 500 });
  }
}
