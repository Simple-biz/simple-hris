import { randomBytes } from "crypto";
import {
  createSupabaseServerClient,
  createSupabaseServiceRoleClient,
} from "./server";

const TABLE = "hr_onboarding_submissions";
export const HR_ONBOARDING_BUCKET = "hr-onboarding-files";

export type HrOnboardingStatus = "pending" | "submitted" | "archived";
export type OnboardingPaymentMethod = "hurupay" | "wires";

export type HrOnboardingSubmissionRow = {
  id: string;
  token: string;
  status: HrOnboardingStatus;

  created_at: string;
  created_by: string | null;
  submitted_at: string | null;

  invite_name: string | null;
  invite_personal_email: string | null;
  invite_department: string | null;
  invite_note: string | null;

  full_name: string | null;
  phone: string | null;
  email: string | null;

  non_solicitation_signature: string | null;
  privacy_signature: string | null;

  w8ben_applicable: boolean | null;
  w8ben_file_path: string | null;
  w8ben_file_name: string | null;

  payment_method: OnboardingPaymentMethod | null;
  hurupay_email: string | null;
  bank_full_name: string | null;
  bank_account_name: string | null;
  bank_account_number: string | null;
  bank_swift_code: string | null;
  bank_street: string | null;
  bank_city: string | null;
  bank_province: string | null;
  bank_postal_code: string | null;
  bank_full_address: string | null;

  contract_signature: string | null;
  contract_date: string | null;

  /** Minted @simple.biz address (set when HR converts a submitted form). */
  work_email: string | null;
  /** FK to the hr_pending_employees row spun up at conversion; null until then. */
  pending_employee_id: number | null;

  archived_at: string | null;
  notes: string | null;
};

/** Fields the public form route accepts on submit. Token comes from the URL. */
export type SubmitOnboardingInput = {
  full_name: string;
  phone: string;
  email: string;

  non_solicitation_signature: string;
  privacy_signature: string;

  w8ben_applicable: boolean;
  w8ben_file_path?: string | null;
  w8ben_file_name?: string | null;

  payment_method: OnboardingPaymentMethod;
  hurupay_email?: string | null;
  bank_full_name?: string | null;
  bank_account_name?: string | null;
  bank_account_number?: string | null;
  bank_swift_code?: string | null;
  bank_street?: string | null;
  bank_city?: string | null;
  bank_province?: string | null;
  bank_postal_code?: string | null;
  bank_full_address?: string | null;

  contract_signature: string;
  contract_date: string;
};

export type CreateOnboardingLinkInput = {
  invite_name?: string | null;
  invite_personal_email?: string | null;
  invite_department?: string | null;
  invite_note?: string | null;
  created_by?: string | null;
};

function client() {
  const sb = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!sb) {
    throw new Error(
      "Supabase client missing — set NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY",
    );
  }
  return sb;
}

/** 32-byte url-safe token. Long enough that guessing it is impractical. */
export function generateOnboardingToken(): string {
  return randomBytes(24).toString("base64url");
}

export async function listHrOnboardingSubmissions(): Promise<{
  rows: HrOnboardingSubmissionRow[];
  error: string | null;
}> {
  const sb = client();
  const { data, error } = await sb
    .from(TABLE)
    .select("*")
    .order("created_at", { ascending: false })
    .range(0, 999);
  if (error) return { rows: [], error: error.message };
  return { rows: (data ?? []) as HrOnboardingSubmissionRow[], error: null };
}

export async function getHrOnboardingSubmissionById(
  id: string,
): Promise<{ row: HrOnboardingSubmissionRow | null; error: string | null }> {
  const sb = client();
  const { data, error } = await sb
    .from(TABLE)
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) return { row: null, error: error.message };
  return { row: (data ?? null) as HrOnboardingSubmissionRow | null, error: null };
}

export async function getHrOnboardingSubmissionByToken(
  token: string,
): Promise<{ row: HrOnboardingSubmissionRow | null; error: string | null }> {
  const sb = client();
  const { data, error } = await sb
    .from(TABLE)
    .select("*")
    .eq("token", token)
    .maybeSingle();
  if (error) return { row: null, error: error.message };
  return { row: (data ?? null) as HrOnboardingSubmissionRow | null, error: null };
}

export async function createHrOnboardingLink(
  input: CreateOnboardingLinkInput,
): Promise<{ row: HrOnboardingSubmissionRow | null; error: string | null }> {
  const sb = client();
  const payload = {
    token: generateOnboardingToken(),
    status: "pending" as HrOnboardingStatus,
    invite_name: input.invite_name?.trim() || null,
    invite_personal_email:
      input.invite_personal_email?.trim().toLowerCase() || null,
    invite_department: input.invite_department?.trim() || null,
    invite_note: input.invite_note?.trim() || null,
    created_by: input.created_by?.trim().toLowerCase() || null,
  };
  const { data, error } = await sb
    .from(TABLE)
    .insert(payload)
    .select("*")
    .single();
  if (error) return { row: null, error: error.message };
  return { row: data as HrOnboardingSubmissionRow, error: null };
}

export async function submitHrOnboarding(
  token: string,
  input: SubmitOnboardingInput,
): Promise<{ row: HrOnboardingSubmissionRow | null; error: string | null }> {
  const sb = client();

  const { data: existing, error: fetchErr } = await sb
    .from(TABLE)
    .select("id, status")
    .eq("token", token)
    .maybeSingle();
  if (fetchErr) return { row: null, error: fetchErr.message };
  if (!existing) return { row: null, error: "Onboarding link not found" };
  const existingStatus = (existing as { status: HrOnboardingStatus }).status;
  if (existingStatus === "archived") {
    return { row: null, error: "This onboarding link is no longer active." };
  }
  // Both 'pending' and 'submitted' are accepted — submitted rows can be updated
  // when HR resends the link and the hire wants to correct their details.

  const update: Record<string, unknown> = {
    status: "submitted" as HrOnboardingStatus,
    submitted_at: new Date().toISOString(),
    full_name: input.full_name.trim(),
    phone: input.phone.trim(),
    email: input.email.trim().toLowerCase(),
    non_solicitation_signature: input.non_solicitation_signature,
    privacy_signature: input.privacy_signature,
    w8ben_applicable: input.w8ben_applicable,
    w8ben_file_path: input.w8ben_file_path ?? null,
    w8ben_file_name: input.w8ben_file_name ?? null,
    payment_method: input.payment_method,
    hurupay_email: input.hurupay_email?.trim().toLowerCase() || null,
    bank_full_name: input.bank_full_name?.trim() || null,
    bank_account_name: input.bank_account_name?.trim() || null,
    bank_account_number: input.bank_account_number?.trim() || null,
    bank_swift_code: input.bank_swift_code?.trim() || null,
    bank_street: input.bank_street?.trim() || null,
    bank_city: input.bank_city?.trim() || null,
    bank_province: input.bank_province?.trim() || null,
    bank_postal_code: input.bank_postal_code?.trim() || null,
    bank_full_address: input.bank_full_address?.trim() || null,
    contract_signature: input.contract_signature,
    contract_date: input.contract_date,
  };

  const { data, error } = await sb
    .from(TABLE)
    .update(update)
    .eq("token", token)
    .select("*")
    .single();
  if (error) return { row: null, error: error.message };
  return { row: data as HrOnboardingSubmissionRow, error: null };
}

/**
 * Mint a fresh token on a row and persist it. Called by the send route so each
 * email carries a unique URL; any link from a previous send for the same row
 * is implicitly invalidated. Allowed for both `pending` and `submitted` rows —
 * submitted rows can be resent so the hire gets a fresh link to their
 * confirmation screen. Archived rows are excluded (they should not be sendable).
 */
export async function rotateHrOnboardingToken(
  id: string,
): Promise<{ token: string | null; error: string | null }> {
  const sb = client();
  const token = generateOnboardingToken();
  const { data, error } = await sb
    .from(TABLE)
    .update({ token })
    .eq("id", id)
    .in("status", ["pending", "submitted"])
    .select("token")
    .maybeSingle();
  if (error) return { token: null, error: error.message };
  if (!data) {
    return {
      token: null,
      error: "Cannot resend — this submission is archived.",
    };
  }
  return { token: (data as { token: string }).token, error: null };
}

/**
 * Stamp a submitted form with the minted work email and the staged-hire id it
 * was converted into. Called by the set-work-email route after the matching
 * `hr_pending_employees` row is created.
 */
export async function linkOnboardingToPendingHire(
  id: string,
  args: { work_email: string; pending_employee_id: number },
): Promise<{ error: string | null }> {
  const sb = client();
  const { error } = await sb
    .from(TABLE)
    .update({
      work_email: args.work_email.trim().toLowerCase() || null,
      pending_employee_id: args.pending_employee_id,
    })
    .eq("id", id);
  return { error: error?.message ?? null };
}

export async function archiveHrOnboardingSubmission(
  id: string,
): Promise<{ error: string | null }> {
  const sb = client();
  const { error } = await sb
    .from(TABLE)
    .update({
      status: "archived" as HrOnboardingStatus,
      archived_at: new Date().toISOString(),
    })
    .eq("id", id);
  return { error: error?.message ?? null };
}

export async function deleteHrOnboardingSubmission(
  id: string,
): Promise<{ error: string | null }> {
  const sb = client();
  const { error } = await sb.from(TABLE).delete().eq("id", id);
  return { error: error?.message ?? null };
}

/**
 * Upload a W-8BEN PDF into the private storage bucket. Returns the storage
 * path so the caller can write it onto the submission row.
 */
export async function uploadW8BenFile(
  submissionId: string,
  body: ArrayBuffer,
  contentType: string,
  originalFileName: string,
): Promise<{ path: string | null; error: string | null }> {
  const sb = client();
  const safeExt = (() => {
    const m = originalFileName.match(/\.([a-z0-9]{1,8})$/i);
    return m ? `.${m[1].toLowerCase()}` : ".pdf";
  })();
  const path = `${submissionId}/w8ben${safeExt}`;
  const { error } = await sb.storage
    .from(HR_ONBOARDING_BUCKET)
    .upload(path, new Uint8Array(body), {
      contentType: contentType || "application/pdf",
      upsert: true,
      cacheControl: "no-cache",
    });
  if (error) return { path: null, error: error.message };
  return { path, error: null };
}

/**
 * Sign a private W-8BEN URL for HR to download. Short TTL since this is a
 * sensitive tax document.
 */
export async function getW8BenSignedUrl(
  path: string,
  expiresInSeconds = 300,
): Promise<{ url: string | null; error: string | null }> {
  const sb = client();
  const { data, error } = await sb.storage
    .from(HR_ONBOARDING_BUCKET)
    .createSignedUrl(path, expiresInSeconds);
  if (error) return { url: null, error: error.message };
  return { url: data?.signedUrl ?? null, error: null };
}
