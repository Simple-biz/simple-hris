import { normEmail } from "@/lib/email/norm-email";
import { createSupabaseServerClient, createSupabaseServiceRoleClient } from "./server";

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
  const { data: byWork } = await supabase
    .from(table)
    .select('"Profile Photo URL"')
    .ilike("Work Email", n)
    .maybeSingle();

  const wUrl = byWork?.["Profile Photo URL"];
  if (typeof wUrl === "string" && wUrl.trim()) return wUrl.trim();

  const { data: byPersonal } = await supabase
    .from(table)
    .select('"Profile Photo URL"')
    .ilike("Personal Email", n)
    .maybeSingle();

  const pUrl = byPersonal?.["Profile Photo URL"];
  if (typeof pUrl === "string" && pUrl.trim()) return pUrl.trim();

  return null;
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
      upsert: true,
    });

  if (upErr) {
    return { error: upErr.message };
  }

  const {
    data: { publicUrl },
  } = supabase.storage.from(EMPLOYEE_AVATAR_BUCKET).getPublicUrl(path);

  const table = masterTable();
  const { error: dbErr } = await supabase
    .from(table)
    .update({ "Profile Photo URL": publicUrl })
    .eq(updateCol, updateVal);

  if (dbErr) {
    return { error: dbErr.message };
  }

  return { publicUrl };
}
