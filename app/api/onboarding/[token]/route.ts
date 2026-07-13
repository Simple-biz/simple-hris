import { NextResponse } from "next/server";
import {
  getHrOnboardingSubmissionByToken,
  submitHrOnboarding,
  uploadIpAssignmentFile,
  type SubmitOnboardingInput,
} from "@/lib/supabase/hr-onboarding-submissions";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { createHrPendingEmployee } from "@/lib/supabase/hr-pending-employees";
import { generateIpAssignmentPdf } from "@/lib/onboarding/ip-assignment-pdf";
import {
  isLeadGenDepartment,
  suggestCallToolsUsername,
} from "@/lib/hr/calltools-username";
import { loadTakenCallToolsUsernames } from "@/lib/hr/calltools-username-server";
import { splitFullName } from "@/lib/hr/work-email";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Active work emails for everyone holding one of `roles`. Used to notify HR. */
async function recipientsForRoles(roles: string[]): Promise<string[]> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return [];
  const { data } = await supabase
    .from("employee_roles")
    .select("work_email, role")
    .in("role", roles)
    .is("revoked_at", null);
  const out = new Set<string>();
  for (const r of (data ?? []) as Array<{ work_email?: string | null }>) {
    const e = (r.work_email ?? "").trim().toLowerCase();
    if (e) out.add(e);
  }
  return Array.from(out);
}

/**
 * Drop an in-app notification into every HR coordinator's / admin's bell when a
 * hire completes their onboarding form. Best-effort: a notification failure must
 * never block the public submit, so this swallows its own errors.
 */
async function notifyHrOfSubmission(args: {
  submissionId: string;
  fullName: string;
  personalEmail: string | null;
  department: string | null;
}): Promise<void> {
  try {
    const supabase = createSupabaseServiceRoleClient();
    if (!supabase) return;
    const recipients = await recipientsForRoles(["hr_coordinator", "admin"]);
    if (recipients.length === 0) return;
    const deptSuffix = args.department ? ` for ${args.department}` : "";
    await supabase.from("employee_notifications").insert(
      recipients.map((to) => ({
        recipient_email: to,
        type: "onboarding.submitted",
        tone: "positive",
        title: "New Onboarding Submission",
        message: `${args.fullName} completed their onboarding paperwork${deptSuffix}. Review it in Onboarding → Onboarding Form.`,
        details: {
          submission_id: args.submissionId,
          full_name: args.fullName,
          personal_email: args.personalEmail,
          department: args.department,
        },
      })),
    );
  } catch {
    /* non-fatal — the hire's submission still succeeds */
  }
}

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
        gmail_surname: row.gmail_surname,
        // calltools_username is intentionally omitted: it's an internal HR
        // value the hire never sees (re-minted server-side on re-submit).
        calltools_nickname: row.calltools_nickname ?? null,
        phone: row.phone,
        email: row.email,
        location: row.location,
        country: row.country,
        address_street: row.address_street,
        address_city: row.address_city,
        address_state: row.address_state,
        address_province: row.address_province,
        address_region: row.address_region,
        address_postal_code: row.address_postal_code,
        ip_agreement_agreed: row.ip_agreement_agreed,
        ip_agreement_name: row.ip_agreement_name,
        ip_agreement_signature: row.ip_agreement_signature,
        ip_agreement_date: row.ip_agreement_date,
        non_solicitation_signature: row.non_solicitation_signature,
        privacy_signature: row.privacy_signature,
        w8ben_applicable: row.w8ben_applicable,
        w8ben_file_name: row.w8ben_file_name,
        payment_method: row.payment_method,
        hurupay_email: row.hurupay_email,
        bank_full_name: row.bank_full_name,
        bank_account_name: row.bank_account_name,
        // bank_account_number and bank_swift_code are intentionally omitted:
        // this endpoint is public (token-only auth) and the token is delivered
        // via email, so account credentials must not be returned. The hire
        // re-enters them if they update their payment details.
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

  // Required fields across the steps.
  const missing: string[] = [];
  if (body.ip_agreement_agreed !== true) missing.push("ip_agreement_agreed");
  if (!body.ip_agreement_name?.trim()) missing.push("ip_agreement_name");
  if (!body.ip_agreement_signature) missing.push("ip_agreement_signature");
  if (!body.ip_agreement_date?.trim()) missing.push("ip_agreement_date");
  if (!body.full_name?.trim()) missing.push("full_name");
  if (!body.phone?.trim()) missing.push("phone");
  if (!body.email?.trim()) missing.push("email");
  if (!body.country?.trim()) missing.push("country");
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

  // Render + store the signed Intellectual Property Assignment PDF before the
  // submit write, so the storage path can be persisted in the same update. The
  // row already exists (created at link generation), so we have its id from the
  // token lookup. Best-effort: if generation/upload fails we still save the raw
  // signature/name/date (HR can fall back to the captured signature image), so
  // a PDF hiccup never blocks the hire from finishing onboarding.
  const lookup = await getHrOnboardingSubmissionByToken(token);
  const submissionId = lookup.row?.id ?? null;
  if (submissionId) {
    try {
      const pdfBytes = await generateIpAssignmentPdf({
        name: body.ip_agreement_name!.trim(),
        signatureDataUrl: body.ip_agreement_signature ?? null,
        dateIso: body.ip_agreement_date ?? null,
      });
      const safeName = (body.ip_agreement_name ?? "participant")
        .trim()
        .replace(/[^a-z0-9]+/gi, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60) || "participant";
      const { path, error: uploadErr } = await uploadIpAssignmentFile(submissionId, pdfBytes);
      if (uploadErr) {
        console.error("IP assignment PDF upload failed:", uploadErr);
      } else {
        body.ip_assignment_file_path = path;
        body.ip_assignment_file_name = `IP-Assignment-${safeName}.pdf`;
      }
    } catch (e) {
      console.error("IP assignment PDF generation failed:", e);
    }
  }

  // CallTools dialer fields are SERVER-controlled. The hire only ever types
  // their nickname — the minted username is hidden from the paperwork — so the
  // username is derived HERE, at submit time, against the freshest taken set
  // (rather than trusting a value from the client, which could be stale or
  // forged). "Mikey" + "James Thomas" -> "Mikey J. T."; taken -> "Mikey J. TH.".
  if (isLeadGenDepartment(lookup.row?.invite_department)) {
    const nickname = (body.calltools_nickname ?? "").trim();
    if (nickname) {
      // full_name is validated present above; splitFullName peels a trailing
      // Jr./Sr./III so the slice keys off the real surname.
      const { first, last } = splitFullName(body.full_name);
      let taken: Set<string>;
      try {
        taken = await loadTakenCallToolsUsernames();
      } catch (e) {
        // Never block a hire on a roster hiccup — mint the shortest form
        // uncontested; HR sees the nickname either way and can adjust.
        console.error("CallTools taken-set load failed; minting unchecked:", e);
        taken = new Set();
      }
      // A re-submission already holds its own username — don't collide with
      // self, or the slice would needlessly lengthen.
      const self = lookup.row?.calltools_username?.trim().toLowerCase();
      if (self) taken.delete(self);
      body.calltools_nickname = nickname;
      body.calltools_username = suggestCallToolsUsername(nickname, first, last, taken);
    } else {
      body.calltools_nickname = null;
      body.calltools_username = null;
    }
  } else {
    // Not a Lead Gen invite — never touch the columns, whatever the client sent.
    delete body.calltools_nickname;
    delete body.calltools_username;
  }

  const { row, error } = await submitHrOnboarding(token, body as SubmitOnboardingInput);
  if (error) {
    const status = /not found|no longer active/i.test(error) ? 409 : 500;
    return NextResponse.json({ error }, { status });
  }

  // Stage the hire the moment their paperwork lands: create the
  // hr_pending_employees row WITHOUT a work email (status pending_work_email)
  // and link it to this submission. This is what puts the hire on the manager's
  // Newly Hired tab in the week they onboarded — even before HR runs "Set work
  // email" (which finds the linked row via pending_employee_id and UPDATES it
  // in place rather than creating a duplicate), so orientation can be marked in
  // either order. Skipped when already staged (re-submission) or when the
  // invite carries no department (nothing to scope the manager view by — HR's
  // set-work-email still stages those later, exactly as before). Best-effort:
  // a failure here never blocks the hire's submit.
  if (row && row.pending_employee_id == null) {
    const department = (row.invite_department ?? "").trim();
    const stagedName = row.full_name?.trim() || body.full_name!.trim();
    if (department && stagedName) {
      try {
        const { row: staged, error: stageErr } = await createHrPendingEmployee({
          name: stagedName,
          personal_email: row.invite_personal_email ?? row.email ?? body.email!,
          department,
          phone: row.phone,
          location: row.location,
          source: "onboarding_form",
          onboarding_submission_id: row.id,
        });
        if (stageErr || !staged) {
          console.error("stage-on-submit: creating the pending hire failed:", stageErr);
        } else {
          const sb = createSupabaseServiceRoleClient();
          const { error: linkErr } = sb
            ? await sb
                .from("hr_onboarding_submissions")
                .update({ pending_employee_id: staged.id })
                .eq("id", row.id)
            : { error: { message: "Supabase client missing" } };
          if (linkErr) {
            console.error("stage-on-submit: linking the submission failed:", linkErr.message);
          }
        }
      } catch (e) {
        console.error("stage-on-submit threw:", e);
      }
    }
  }

  // Alert HR — pops into their Notifications bell (and chimes) in real time.
  if (row) {
    await notifyHrOfSubmission({
      submissionId: row.id,
      fullName: row.full_name?.trim() || body.full_name!.trim(),
      personalEmail: row.invite_personal_email ?? row.email ?? null,
      department: row.invite_department ?? null,
    });
  }

  return NextResponse.json({ row: { id: row?.id, status: row?.status } });
}
