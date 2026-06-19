import { randomUUID } from "crypto";
import {
  createSupabaseServerClient,
  createSupabaseServiceRoleClient,
} from "./server";
import { HR_ONBOARDING_BUCKET } from "./hr-onboarding-submissions";
import { normalizeDeptToKey } from "@/lib/payroll/normalize-dept-key";
import { resolveOnboardingCountry } from "@/lib/onboarding/countries";

const TABLE = "onboarding_pay_plans";

/**
 * One HR-uploaded pay-plan PDF, keyed by (department, country). The PDF bytes
 * live in the private `hr-onboarding-files` bucket at `file_path`; this row is
 * just metadata + the storage path. See create_onboarding_pay_plans.sql.
 */
export type OnboardingPayPlanRow = {
  id: string;
  department: string;
  country: string;
  file_path: string;
  file_name: string;
  content_type: string | null;
  file_size: number | null;
  uploaded_by: string | null;
  created_at: string;
  updated_at: string;
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

/**
 * Normalized match key for a department. Both the HR-assigned `invite_department`
 * and the stored pay-plan department are run through this so "Lead Gen",
 * "lead gen", and "Lead Generation" all resolve to the same plan. Falls back to
 * the trimmed/lower-cased raw name when the dept isn't a known canonical one.
 */
function deptMatchKey(dept: string | null | undefined): string {
  const raw = (dept ?? "").trim();
  return normalizeDeptToKey(raw) ?? raw.toLowerCase();
}

/**
 * Normalized match key for a country. Resolves aliases ("USA", "Columbia") to
 * the canonical country name, so the hire's typed/selected value matches the
 * stored plan regardless of spelling. Falls back to trimmed/lower-cased raw.
 */
function countryMatchKey(country: string | null | undefined): string {
  const raw = (country ?? "").trim();
  return (resolveOnboardingCountry(raw)?.name ?? raw).toLowerCase();
}

/** All pay plans, newest first. */
export async function listOnboardingPayPlans(): Promise<{
  rows: OnboardingPayPlanRow[];
  error: string | null;
}> {
  const sb = client();
  const { data, error } = await sb
    .from(TABLE)
    .select("*")
    .order("department", { ascending: true })
    .order("country", { ascending: true });
  if (error) return { rows: [], error: error.message };
  return { rows: (data ?? []) as OnboardingPayPlanRow[], error: null };
}

export async function getOnboardingPayPlanById(
  id: string,
): Promise<{ row: OnboardingPayPlanRow | null; error: string | null }> {
  const sb = client();
  const { data, error } = await sb
    .from(TABLE)
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) return { row: null, error: error.message };
  return { row: (data ?? null) as OnboardingPayPlanRow | null, error: null };
}

/**
 * Find the pay plan for a (department, country) pair using normalized matching.
 * Pulls the (small) table and matches in code so dept/country spelling variants
 * still resolve. Returns null when no plan is configured for the pair.
 */
export async function findPayPlanForDeptCountry(
  department: string | null | undefined,
  country: string | null | undefined,
): Promise<{ row: OnboardingPayPlanRow | null; error: string | null }> {
  const dKey = deptMatchKey(department);
  const cKey = countryMatchKey(country);
  if (!dKey || !cKey) return { row: null, error: null };
  const { rows, error } = await listOnboardingPayPlans();
  if (error) return { row: null, error };
  const row =
    rows.find(
      (r) => deptMatchKey(r.department) === dKey && countryMatchKey(r.country) === cKey,
    ) ?? null;
  return { row, error: null };
}

/**
 * Upload (or replace) the pay-plan PDF for a (department, country) pair. When a
 * plan already exists for the pair (normalized), its row + storage object are
 * overwritten in place so there's only ever one plan per pair. Returns the row.
 */
export async function upsertOnboardingPayPlan(args: {
  department: string;
  country: string;
  fileBytes: ArrayBuffer | Uint8Array;
  contentType: string | null;
  fileName: string;
  fileSize?: number | null;
  uploadedBy?: string | null;
}): Promise<{ row: OnboardingPayPlanRow | null; error: string | null }> {
  const sb = client();

  const department = args.department.trim();
  // Store the canonical country name so the list reads cleanly; matching is
  // still normalized on read.
  const country =
    resolveOnboardingCountry(args.country)?.name ?? args.country.trim();
  if (!department) return { row: null, error: "Department is required." };
  if (!country) return { row: null, error: "Country is required." };

  // Reuse an existing plan's id + storage path so a re-upload overwrites in
  // place (one PDF per pair, no orphaned objects).
  const { row: existing } = await findPayPlanForDeptCountry(department, country);
  const id = existing?.id ?? randomUUID();
  const path = existing?.file_path ?? `pay-plans/${id}.pdf`;

  const bytes =
    args.fileBytes instanceof Uint8Array
      ? args.fileBytes
      : new Uint8Array(args.fileBytes);

  const { error: uploadErr } = await sb.storage
    .from(HR_ONBOARDING_BUCKET)
    .upload(path, bytes, {
      contentType: args.contentType || "application/pdf",
      upsert: true,
      cacheControl: "no-cache",
    });
  if (uploadErr) return { row: null, error: uploadErr.message };

  const now = new Date().toISOString();
  const payload = {
    id,
    department,
    country,
    file_path: path,
    file_name: args.fileName,
    content_type: args.contentType || "application/pdf",
    file_size: args.fileSize ?? null,
    uploaded_by: args.uploadedBy?.trim().toLowerCase() || null,
    updated_at: now,
  };

  if (existing) {
    const { data, error } = await sb
      .from(TABLE)
      .update(payload)
      .eq("id", id)
      .select("*")
      .single();
    if (error) return { row: null, error: error.message };
    return { row: data as OnboardingPayPlanRow, error: null };
  }

  const { data, error } = await sb
    .from(TABLE)
    .insert(payload)
    .select("*")
    .single();
  if (error) return { row: null, error: error.message };
  return { row: data as OnboardingPayPlanRow, error: null };
}

/** Delete a pay plan: removes the storage object then the row. */
export async function deleteOnboardingPayPlan(
  id: string,
): Promise<{ error: string | null }> {
  const sb = client();
  const { row } = await getOnboardingPayPlanById(id);
  if (row?.file_path) {
    // Best-effort — a missing object should not block deleting the row.
    await sb.storage.from(HR_ONBOARDING_BUCKET).remove([row.file_path]);
  }
  const { error } = await sb.from(TABLE).delete().eq("id", id);
  return { error: error?.message ?? null };
}

/** Sign a private pay-plan PDF URL (for HR preview/download, or webhook forward). */
export async function getPayPlanSignedUrl(
  path: string,
  expiresInSeconds = 600,
): Promise<{ url: string | null; error: string | null }> {
  const sb = client();
  const { data, error } = await sb.storage
    .from(HR_ONBOARDING_BUCKET)
    .createSignedUrl(path, expiresInSeconds);
  if (error) return { url: null, error: error.message };
  return { url: data?.signedUrl ?? null, error: null };
}
