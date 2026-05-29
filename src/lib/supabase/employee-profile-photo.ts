import { normEmail } from "@/lib/email/norm-email";
import { createSupabaseServerClient, createSupabaseServiceRoleClient } from "./server";
import { invalidateRateProfilesCache } from "./employee-rate-profiles";

export const EMPLOYEE_AVATAR_BUCKET = "employee-avatars";

function getWriteClient() {
  return createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
}

function masterTable(): string {
  return process.env.NEXT_PUBLIC_SUPABASE_EMPLOYEES_TABLE?.trim() || "global_master_list";
}

/** Safe path segment for Storage (no @ or slashes). */
export function emailToAvatarStoragePath(email: string): string {
  const n = normEmail(email);
  if (!n) throw new Error("Invalid email");
  const safe = n.replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "user";
  return `avatars/${safe}/avatar.jpg`;
}

type MasterEmails = {
  work: string | null;
  personal: string | null;
};

async function fetchMasterEmailsForLookup(
  supabase: NonNullable<ReturnType<typeof getWriteClient>>,
  normalized: string,
): Promise<MasterEmails | null> {
  const table = masterTable();

  const { data: byWork } = await supabase
    .from(table)
    .select('"Work Email","Personal Email"')
    .ilike("Work Email", normalized)
    .maybeSingle();

  if (byWork) {
    return {
      work: byWork["Work Email"] != null ? String(byWork["Work Email"]) : null,
      personal:
        byWork["Personal Email"] != null ? String(byWork["Personal Email"]) : null,
    };
  }

  const { data: byPersonal } = await supabase
    .from(table)
    .select('"Work Email","Personal Email"')
    .ilike("Personal Email", normalized)
    .maybeSingle();

  if (!byPersonal) return null;
  return {
    work: byPersonal["Work Email"] != null ? String(byPersonal["Work Email"]) : null,
    personal:
      byPersonal["Personal Email"] != null
        ? String(byPersonal["Personal Email"])
        : null,
  };
}

export async function getProfilePhotoUrlForEmail(
  email: string,
): Promise<string | null> {
  const n = normEmail(email);
  if (!n) return null;

  const supabase = getWriteClient();
  if (!supabase) return null;

  const table = masterTable();

  // Prefer the manually-uploaded photo; fall back to the Google SSO photo
  // that persistGooglePhoto() writes to google_photo_url on each sign-in.
  function pickUrl(row: Record<string, unknown> | null): string | null {
    if (!row) return null;
    const uploaded = row["Profile Photo URL"];
    if (typeof uploaded === "string" && uploaded.trim()) return uploaded.trim();
    const google = row["google_photo_url"];
    if (typeof google === "string" && google.trim()) return google.trim();
    return null;
  }

  const { data: byWork } = await supabase
    .from(table)
    .select('"Profile Photo URL", google_photo_url')
    .ilike("Work Email", n)
    .maybeSingle();

  const wUrl = pickUrl(byWork as Record<string, unknown> | null);
  if (wUrl) return wUrl;

  const { data: byPersonal } = await supabase
    .from(table)
    .select('"Profile Photo URL", google_photo_url')
    .ilike("Personal Email", n)
    .maybeSingle();

  return pickUrl(byPersonal as Record<string, unknown> | null);
}

export async function uploadEmployeeProfilePhotoAndUpdateRow(
  employeeEmail: string,
  jpegBytes: ArrayBuffer,
): Promise<{ publicUrl: string } | { error: string }> {
  const supabase = getWriteClient();
  if (!supabase) {
    return { error: "Supabase client not initialized. Check environment variables." };
  }

  const n = normEmail(employeeEmail);
  if (!n) {
    return { error: "Invalid email" };
  }

  const row = await fetchMasterEmailsForLookup(supabase, n);
  if (!row) {
    return { error: "No employee row found for this email in the master list." };
  }

  const matchWork = row.work && normEmail(row.work) === n;
  const matchPersonal = row.personal && normEmail(row.personal) === n;
  const updateCol: "Work Email" | "Personal Email" = matchWork
    ? "Work Email"
    : matchPersonal
      ? "Personal Email"
      : row.work
        ? "Work Email"
        : "Personal Email";
  const updateVal = updateCol === "Work Email" ? row.work : row.personal;
  if (updateVal == null || !String(updateVal).trim()) {
    return { error: "Could not resolve employee row to update." };
  }

  const path = emailToAvatarStoragePath(employeeEmail);
  const body = new Uint8Array(jpegBytes);

  const { error: upErr } = await supabase.storage
    .from(EMPLOYEE_AVATAR_BUCKET)
    .upload(path, body, {
      contentType: "image/jpeg",
      // Tell the Supabase CDN + browsers not to hold onto the previous JPEG.
      // Without this, an overwrite at the same deterministic path (avatar.jpg)
      // keeps serving the stale image for up to an hour via the public URL.
      cacheControl: "no-cache",
      upsert: true,
    });

  if (upErr) {
    return { error: upErr.message };
  }

  const {
    data: { publicUrl: bareUrl },
  } = supabase.storage.from(EMPLOYEE_AVATAR_BUCKET).getPublicUrl(path);

  // Belt-and-braces cache buster baked into the canonical URL — every reader
  // (employee dashboard, Rates & Profiles, manager modal, etc.) now sees a
  // fresh querystring whenever the photo changes, so neither Supabase CDN nor
  // the browser's in-memory image cache can serve the old object.
  const publicUrl = `${bareUrl}${bareUrl.includes("?") ? "&" : "?"}v=${Date.now()}`;

  const table = masterTable();
  const { error: dbErr } = await supabase
    .from(table)
    .update({ "Profile Photo URL": publicUrl })
    .eq(updateCol, updateVal);

  if (dbErr) {
    return { error: dbErr.message };
  }

  // The accounting Rates & Profiles roster memoizes profile photo URLs for
  // 60s; bust it so the new avatar appears immediately for admins too.
  invalidateRateProfilesCache();

  return { publicUrl };
}

/**
 * Clears the manually-uploaded avatar: removes the Storage object and nulls
 * "Profile Photo URL" on the master row. The Google SSO photo (google_photo_url)
 * is left untouched — readers fall back to it, then to initials.
 */
export async function removeEmployeeProfilePhoto(
  employeeEmail: string,
): Promise<{ ok: true } | { error: string }> {
  const supabase = getWriteClient();
  if (!supabase) {
    return { error: "Supabase client not initialized. Check environment variables." };
  }

  const n = normEmail(employeeEmail);
  if (!n) {
    return { error: "Invalid email" };
  }

  const row = await fetchMasterEmailsForLookup(supabase, n);
  if (!row) {
    return { error: "No employee row found for this email in the master list." };
  }

  const matchWork = row.work && normEmail(row.work) === n;
  const matchPersonal = row.personal && normEmail(row.personal) === n;
  const updateCol: "Work Email" | "Personal Email" = matchWork
    ? "Work Email"
    : matchPersonal
      ? "Personal Email"
      : row.work
        ? "Work Email"
        : "Personal Email";
  const updateVal = updateCol === "Work Email" ? row.work : row.personal;
  if (updateVal == null || !String(updateVal).trim()) {
    return { error: "Could not resolve employee row to update." };
  }

  // Best-effort delete of the stored object; ignore "not found" so a missing
  // file doesn't block clearing the DB column.
  const path = emailToAvatarStoragePath(employeeEmail);
  await supabase.storage.from(EMPLOYEE_AVATAR_BUCKET).remove([path]);

  const table = masterTable();
  const { error: dbErr } = await supabase
    .from(table)
    .update({ "Profile Photo URL": null })
    .eq(updateCol, updateVal);

  if (dbErr) {
    return { error: dbErr.message };
  }

  invalidateRateProfilesCache();

  return { ok: true };
}
