import { NextResponse } from "next/server";
import {
  getHrOnboardingSubmissionByToken,
  submitHrOnboarding,
  type SubmitOnboardingInput,
} from "@/lib/supabase/hr-onboarding-submissions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/onboarding/[token]
 *
 * Public — looking up the row by the random token is the auth. Returns the
 * pending row so the form can pre-fill invite_name/department, or the
 * already-submitted row so the form can show its "already received" state.
 */
export async function GET(
  _req: Request,
  context: { params: Promise<{ token: string }> },
) {
  const { token } = await context.params;
  if (!token) {
    return NextResponse.json({ error: "Missing token" }, { status: 400 });
  }
  const { row, error } = await getHrOnboardingSubmissionByToken(token);
  if (error) return NextResponse.json({ error }, { status: 500 });
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // For submitted rows include the prior form data so the page can pre-fill.
  // w8ben_file_path is kept server-side (not sent); w8ben_file_name is
  // included so the form can show "already uploaded: filename".
  const base = {
    id: row.id,
    status: row.status,
    invite_name: row.invite_name,
    invite_personal_email: row.invite_personal_email,
    invite_department: row.invite_department,
    invite_note: row.invite_note,
    submitted_at: row.submitted_at,
  };
  const priorData = row.status === "submitted"
    ? {
        full_name: row.full_name,
        phone: row.phone,
        email: row.email,
        non_solicitation_signature: row.non_solicitation_signature,
        privacy_signature: row.privacy_signature,
        w8ben_applicable: row.w8ben_applicable,
        w8ben_file_name: row.w8ben_file_name,
        payment_method: row.payment_method,
        hurupay_email: row.hurupay_email,
        bank_full_name: row.bank_full_name,
        bank_account_name: row.bank_account_name,
        bank_account_number: row.bank_account_number,
        bank_swift_code: row.bank_swift_code,
        bank_street: row.bank_street,
        bank_city: row.bank_city,
        bank_province: row.bank_province,
        bank_postal_code: row.bank_postal_code,
        bank_full_address: row.bank_full_address,
        contract_signature: row.contract_signature,
        contract_date: row.contract_date,
      }
    : null;
  return NextResponse.json({ row: { ...base, priorData } });
}

/**
 * POST /api/onboarding/[token]
 *
 * Public submit endpoint. The token must point at a pending row; if the row
 * is already submitted or archived we refuse with 409.
 */
export async function POST(
  req: Request,
  context: { params: Promise<{ token: string }> },
) {
  const { token } = await context.params;
  if (!token) {
    return NextResponse.json({ error: "Missing token" }, { status: 400 });
  }

  let body: Partial<SubmitOnboardingInput>;
  try {
    body = (await req.json()) as Partial<SubmitOnboardingInput>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Required fields across the 6 steps.
  const missing: string[] = [];
  if (!body.full_name?.trim()) missing.push("full_name");
  if (!body.phone?.trim()) missing.push("phone");
  if (!body.email?.trim()) missing.push("email");
  if (!body.non_solicitation_signature) missing.push("non_solicitation_signature");
  if (!body.privacy_signature) missing.push("privacy_signature");
  if (typeof body.w8ben_applicable !== "boolean") missing.push("w8ben_applicable");
  if (body.payment_method !== "hurupay" && body.payment_method !== "wires") {
    missing.push("payment_method");
  }
  if (!body.contract_signature) missing.push("contract_signature");
  if (!body.contract_date) missing.push("contract_date");

  // Hurupay-specific required field (only when the hire chose hurupay).
  if (body.payment_method === "hurupay" && !body.hurupay_email?.trim()) {
    missing.push("hurupay_email");
  }

  // Wires-specific required fields (only when the hire chose wires).
  if (body.payment_method === "wires") {
    if (!body.bank_full_name?.trim()) missing.push("bank_full_name");
    if (!body.bank_account_name?.trim()) missing.push("bank_account_name");
    if (!body.bank_account_number?.trim()) missing.push("bank_account_number");
    if (!body.bank_swift_code?.trim()) missing.push("bank_swift_code");
    if (!body.bank_street?.trim()) missing.push("bank_street");
    if (!body.bank_city?.trim()) missing.push("bank_city");
    if (!body.bank_province?.trim()) missing.push("bank_province");
    if (!body.bank_postal_code?.trim()) missing.push("bank_postal_code");
    if (!body.bank_full_address?.trim()) missing.push("bank_full_address");
  }

  if (missing.length > 0) {
    return NextResponse.json(
      { error: `Missing required fields: ${missing.join(", ")}` },
      { status: 400 },
    );
  }

  const { row, error } = await submitHrOnboarding(token, body as SubmitOnboardingInput);
  if (error) {
    const status = /not found|no longer active/i.test(error) ? 409 : 500;
    return NextResponse.json({ error }, { status });
  }
  return NextResponse.json({ row: { id: row?.id, status: row?.status } });
}
