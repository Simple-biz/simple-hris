import { updateEmployeeRates } from "@/lib/supabase/employee-hourly-rates";
import { NextResponse } from "next/server";

export async function POST(req: Request) {
  try {
    const { workEmail, personalEmail, regularRate, otRate } = await req.json();

    if (!workEmail && !personalEmail) {
      return NextResponse.json(
        { error: "Work email or personal email is required" },
        { status: 400 }
      );
    }

    if (regularRate === undefined || otRate === undefined) {
      return NextResponse.json(
        { error: "Regular rate and OT rate are required" },
        { status: 400 }
      );
    }

    const { error } = await updateEmployeeRates({
      workEmail,
      personalEmail,
      regularRate,
      otRate,
    });

    if (error) {
      return NextResponse.json({ error }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
