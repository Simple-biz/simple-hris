import { randomBytes } from "crypto";
import {
  createSupabaseServerClient,
  createSupabaseServiceRoleClient,
} from "./server";
import {
  sanitizeNameOrNull,
  toTitleCaseName,
  toTitleCaseNameOrNull,
} from "../text/sanitize-name";
import { composeFullName } from "../hr/work-email";

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
  /** Country HR picks at invite time — selects the pay-plan PDF (by department +
   *  country) that rides the onboarding invite email. Distinct from `country`,
   *  which the HIRE selects on the paperwork. */
  invite_country: string | null;
  invite_note: string | null;

  full_name: string | null;
  /** Structured name — the SOURCE OF TRUTH the hire typed in the three boxes.
   *  `full_name` above is composed FROM these (kept for the master-list Sheet,
   *  payroll name-matching, and the display trigger); downstream reads the parts
   *  directly rather than re-parsing the blob. Null on rows that predate the
   *  split migration (2026-07-20_split_onboarding_name_columns.sql). */
  first_name: string | null;
  /** Whole surname as typed ("Dela Cruz") — NOT reduced to the last token. */
  last_name: string | null;
  /** Generational suffix (Jr./Sr./II/III/IV) the hire entered separately. */
  name_extension: string | null;
  /** DERIVED surname-first display name — `Surname[ Suffix], Given... "GoBy"`
   *  (e.g. "Jan Kane Reroma" → `Reroma, Jan Kane "Kane"`). Computed from
   *  `full_name` by the `name_last_first_quoted()` DB trigger; null for rows
   *  without a submitted name. Display only — `full_name` stays canonical for
   *  payroll name-matching + work-email derivation. See migration #87. */
  display_name: string | null;
  /** Surname for the @simple.biz Google account — sent to the workspace-account
   *  webhook in place of the legal last name (falls back to it when null). */
  gmail_surname: string | null;
  /** Lead Gen only: the nickname the hire typed on the paperwork — how they want
   *  to be called on the CallTools dialer. Null for every other department. */
  calltools_nickname: string | null;
  /** Lead Gen only: the auto-minted CallTools dialer username —
   *  `<Nickname> <first initial>. <surname slice>.` (e.g. "Mikey J. T."), the
   *  slice lengthened until unique (see src/lib/hr/calltools-username.ts). */
  calltools_username: string | null;
  phone: string | null;
  email: string | null;
  /**
   * Composed "street, city, region, postal" address. Kept for downstream
   * consumers (promote -> hr_pending_employees -> global_master_list."Location").
   * The structured parts below are the source; this is derived on submit.
   */
  location: string | null;
  /** Country the hire selected — derives their currency (USD/PHP/COP). */
  country: string | null;
  // Structured address — the broken-down Location field.
  address_street: string | null;
  address_city: string | null;
  address_state: string | null;
  address_province: string | null;
  address_region: string | null;
  address_postal_code: string | null;

  // Intellectual Property Assignment — standalone document signed first, before
  // the rest of the onboarding paperwork. The generated PDF lives in storage.
  ip_agreement_agreed: boolean | null;
  ip_agreement_name: string | null;
  ip_agreement_signature: string | null;
  ip_agreement_date: string | null;
  ip_assignment_file_path: string | null;
  ip_assignment_file_name: string | null;

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

  /**
   * Outcome of the create-workspace-account webhook fired when the work email
   * was set. `true` = webhook returned 2xx (the address is a CONFIRMED
   * designated work email); `false` = it failed / never fired (the address was
   * still minted but the account/Hubstaff invite was NOT provisioned);
   * `null` = never attempted, or a legacy row from before this was tracked.
   */
  workspace_account_ok: boolean | null;
  /** Raw HTTP status the webhook returned (for debugging). */
  workspace_account_status: number | null;
  /** Friendly error message when the webhook failed. */
  workspace_account_error: string | null;
  /** When the webhook was last attempted. */
  workspace_account_at: string | null;

  archived_at: string | null;
  notes: string | null;

  /**
   * DERIVED (not a column): status of the linked `hr_pending_employees` row, so
   * the UI can show "Archived/Complete" for an archived submission whose hire was
   * promoted to the master list. Populated by listHrOnboardingSubmissions; null
   * when there's no linked hire or it couldn't be read.
   */
  pending_status?: string | null;
};

/**
 * Outcome of the create-workspace-account webhook, persisted onto the
 * submission so the Submitted tab can distinguish a confirmed designated work
 * email (200) from a minted-but-failed one.
 */
export type WorkspaceAccountOutcome = {
  ok: boolean;
  status?: number | null;
  error?: string | null;
};

/** Fields the public form route accepts on submit. Token comes from the URL. */
export type SubmitOnboardingInput = {
  /** Structured name parts — the form sends these; `full_name` is composed from
   *  them server-side (see composeFullName). `full_name` may still be sent as a
   *  fallback for any legacy caller, but the parts win when present. */
  first_name?: string | null;
  last_name?: string | null;
  name_extension?: string | null;
  full_name: string;
  /** Optional surname for the @simple.biz Google account (falls back to the
   *  legal last name when blank). */
  gmail_surname?: string | null;
  /** Lead Gen only — the hire's self-chosen dialer nickname. Omit (undefined)
   *  for other departments so the columns aren't touched. */
  calltools_nickname?: string | null;
  /** Lead Gen only — the minted CallTools username ("Mikey J. T."). */
  calltools_username?: string | null;
  phone: string;
  email: string;
  /** Optional pre-composed location; normally derived from the parts below. */
  location?: string | null;
  /** Country the hire selected — derives their currency (USD/PHP/COP). */
  country?: string | null;
  // Structured address parts (the broken-down Location field).
  address_street?: string | null;
  address_city?: string | null;
  address_state?: string | null;
  address_province?: string | null;
  address_region?: string | null;
  address_postal_code?: string | null;

  ip_agreement_agreed: boolean;
  ip_agreement_name: string;
  ip_agreement_signature: string;
  ip_agreement_date: string;
  // Storage path/name of the generated IP-assignment PDF. Set server-side after
  // the document is rendered + uploaded; omitted means "keep what's stored".
  ip_assignment_file_path?: string | null;
  ip_assignment_file_name?: string | null;

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
  invite_country?: string | null;
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

/**
 * Every column the Onboarding "Submitted" list + its detail modal read, EXCEPT
 * the four captured-signature data-URL columns (`ip_agreement_signature`,
 * `non_solicitation_signature`, `privacy_signature`, `contract_signature`).
 *
 * Those four base64 PNGs are ~80 KB PER ROW combined and account for ~99% of the
 * table's payload — a `SELECT *` over a few hundred rows pulls tens of MB, which
 * downloads in ~1-2s from Vercel (same-region backbone) but takes MINUTES over a
 * local/residential connection, so the HR Onboarding table "loads forever" on
 * localhost while it's fine on prod. The list/table never renders a signature;
 * only the per-row detail modal does, and it already fetches the full single row
 * via GET /api/hr/onboarding-submissions/[id] on open — so it hydrates the
 * signatures there instead. Keep this list in sync with the columns the UI needs
 * (all non-signature columns of the row).
 */
// NOTE: calltools_nickname / calltools_username are deliberately NOT listed —
// the list/table never shows them, the detail modal reads them from its
// full-row (`select("*")`) hydration fetch, and keeping them out means this
// query keeps working on a database where migration
// add_calltools_username_to_onboarding.sql hasn't run yet.
const LIST_COLUMNS = [
  "id", "token", "status", "created_at", "created_by", "submitted_at",
  "invite_name", "invite_personal_email", "invite_department", "invite_country",
  "invite_note", "full_name", "display_name", "gmail_surname", "phone", "email",
  "location", "country", "address_street", "address_city", "address_state",
  "address_province", "address_region", "address_postal_code",
  "ip_agreement_agreed", "ip_agreement_name", "ip_agreement_date",
  "ip_assignment_file_path", "ip_assignment_file_name",
  "w8ben_applicable", "w8ben_file_path", "w8ben_file_name",
  "payment_method", "hurupay_email", "bank_full_name", "bank_account_name",
  "bank_account_number", "bank_swift_code", "bank_street", "bank_city",
  "bank_province", "bank_postal_code", "bank_full_address",
  "contract_date", "work_email", "pending_employee_id", "workspace_account_ok",
  "workspace_account_status", "workspace_account_error", "workspace_account_at",
  "archived_at", "notes",
].join(",");

export async function listHrOnboardingSubmissions(): Promise<{
  rows: HrOnboardingSubmissionRow[];
  error: string | null;
}> {
  const sb = client();
  const { data, error } = await sb
    .from(TABLE)
    .select(LIST_COLUMNS)
    .order("created_at", { ascending: false })
    .range(0, 999);
  if (error) return { rows: [], error: error.message };
  // Cast via `unknown`: a column-list `.select()` (vs `.select("*")`) makes
  // supabase-js infer `GenericStringError[]`, which doesn't structurally overlap
  // the row type, so a direct cast is rejected.
  const rows = (data ?? []) as unknown as HrOnboardingSubmissionRow[];

  // Attach the linked pending hire's status so the UI can mark an archived
  // submission whose hire was promoted as "Archived/Complete". Best-effort.
  const pendingIds = Array.from(
    new Set(
      rows
        .map((r) => r.pending_employee_id)
        .filter((v): v is number => typeof v === "number"),
    ),
  );
  const statusById = new Map<number, string>();
  if (pendingIds.length > 0) {
    const { data: pend } = await sb
      .from("hr_pending_employees")
      .select("id, status")
      .in("id", pendingIds);
    for (const p of (pend ?? []) as Array<{ id: number; status: string }>) {
      statusById.set(p.id, p.status);
    }
  }
  for (const r of rows) {
    r.pending_status =
      r.pending_employee_id != null ? statusById.get(r.pending_employee_id) ?? null : null;
  }

  return { rows, error: null };
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

/**
 * Returns the first non-archived submission that was invited to the given
 * personal email. Used to block duplicate links before creating a new one.
 */
export async function findActiveSubmissionByEmail(
  email: string,
): Promise<{ row: HrOnboardingSubmissionRow | null; error: string | null }> {
  const sb = client();
  const { data, error } = await sb
    .from(TABLE)
    .select("id, status, invite_name, invite_department, created_at")
    .eq("invite_personal_email", email.trim().toLowerCase())
    .neq("status", "archived")
    .order("created_at", { ascending: false })
    .limit(1)
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
    // Fold styled/invisible Unicode (e.g. math-italic) AND title-case a SHOUTED
    // / all-lowercase name ("JAN KANE REROMA" -> "Jan Kane Reroma") so the hire
    // is matchable and reads naturally from the very first write. Mixed-case
    // names are preserved as typed. See sanitize-name.ts.
    invite_name: toTitleCaseNameOrNull(input.invite_name),
    invite_personal_email:
      input.invite_personal_email?.trim().toLowerCase() || null,
    invite_department: input.invite_department?.trim() || null,
    invite_country: input.invite_country?.trim() || null,
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

  // Compose the legacy `location` string from the structured parts so anything
  // reading it (promote -> hr_pending_employees -> master "Location") keeps
  // working. Fall back to any pre-composed value the client sent.
  const addressParts = [
    input.address_street,
    input.address_city,
    input.address_state,
    input.address_province,
    input.address_region,
    input.address_postal_code,
  ]
    .map((p) => p?.trim())
    .filter((p): p is string => Boolean(p));
  const composedLocation =
    addressParts.length > 0
      ? addressParts.join(", ")
      : input.location?.trim() || null;

  // The structured parts are the SOURCE OF TRUTH the hire typed; compose the
  // legacy combined `full_name` from them so the master-list Sheet, payroll
  // name-matching, and the surname-first display trigger stay in sync without
  // anything re-parsing. Fall back to a full_name a legacy caller might send.
  const firstName = toTitleCaseNameOrNull(input.first_name);
  const lastName = toTitleCaseNameOrNull(input.last_name);
  const nameExtension = toTitleCaseNameOrNull(input.name_extension);
  const composedFullName =
    composeFullName(input.first_name, input.last_name, input.name_extension) ||
    input.full_name;

  const update: Record<string, unknown> = {
    status: "submitted" as HrOnboardingStatus,
    submitted_at: new Date().toISOString(),
    // Fold styled/invisible Unicode in human names (math-italic, full-width,
    // zero-width chars, etc.) AND title-case a SHOUTED / all-lowercase name so
    // the hire is matchable everywhere downstream and reads naturally.
    full_name: toTitleCaseName(composedFullName),
    // Structured parts, stored verbatim (only Unicode-folded + title-cased) so
    // downstream reads them directly instead of splitting full_name.
    first_name: firstName,
    last_name: lastName,
    name_extension: nameExtension,
    // gmail_surname is the @simple.biz Google account surname — kept verbatim
    // (only Unicode-folded). It is NOT title-cased: it can legitimately be a
    // short all-caps initial form and feeds account provisioning, not display.
    gmail_surname: sanitizeNameOrNull(input.gmail_surname),
    // Lead Gen dialer fields — only written when the client sent them (the form
    // sends them for Lead Gen hires only), so other departments never touch the
    // columns. Kept verbatim like gmail_surname: the username's casing
    // ("Mikey J. TH.") is deliberate and must match what the hire was shown.
    ...(input.calltools_nickname !== undefined && {
      calltools_nickname: sanitizeNameOrNull(input.calltools_nickname),
    }),
    ...(input.calltools_username !== undefined && {
      calltools_username: sanitizeNameOrNull(input.calltools_username),
    }),
    phone: input.phone.trim(),
    email: input.email.trim().toLowerCase(),
    location: composedLocation,
    country: input.country?.trim() || null,
    address_street: input.address_street?.trim() || null,
    address_city: input.address_city?.trim() || null,
    address_state: input.address_state?.trim() || null,
    address_province: input.address_province?.trim() || null,
    address_region: input.address_region?.trim() || null,
    address_postal_code: input.address_postal_code?.trim() || null,
    ip_agreement_agreed: input.ip_agreement_agreed,
    ip_agreement_name: toTitleCaseNameOrNull(input.ip_agreement_name),
    ip_agreement_signature: input.ip_agreement_signature,
    ip_agreement_date: input.ip_agreement_date || null,
    // Only overwrite the stored PDF path when the route regenerated it on this
    // submit (it always does when a signature is present). Omitting = keep.
    ...(input.ip_assignment_file_path !== undefined && {
      ip_assignment_file_path: input.ip_assignment_file_path,
    }),
    ...(input.ip_assignment_file_name !== undefined && {
      ip_assignment_file_name: input.ip_assignment_file_name,
    }),
    non_solicitation_signature: input.non_solicitation_signature,
    privacy_signature: input.privacy_signature,
    w8ben_applicable: input.w8ben_applicable,
    // Only overwrite the stored file when the client explicitly sent a new path.
    // Omitting these fields (undefined) means "keep whatever is already stored",
    // which preserves a previously-uploaded W-8BEN when the hire reopens the form.
    ...(input.w8ben_file_path !== undefined && { w8ben_file_path: input.w8ben_file_path }),
    ...(input.w8ben_file_name !== undefined && { w8ben_file_name: input.w8ben_file_name }),
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

  // Pre-migration safety net: on a database missing an optional column family
  // (a migration not yet run), the submit would otherwise hard-fail and block
  // the hire. Strip the offending columns and retry rather than lose the whole
  // submission. Covers the calltools_* columns
  // (add_calltools_username_to_onboarding.sql) and the split-name columns
  // (2026-07-20_split_onboarding_name_columns.sql) — full_name still lands, so
  // the hire is never blocked; only the not-yet-migrated extras are dropped.
  const OPTIONAL_COLUMN_FAMILIES: Array<{ test: RegExp; keys: string[]; note: string }> = [
    {
      test: /calltools_/i,
      keys: ["calltools_nickname", "calltools_username"],
      note: "references/sql/alter/add_calltools_username_to_onboarding.sql",
    },
    {
      test: /first_name|last_name|name_extension/i,
      keys: ["first_name", "last_name", "name_extension"],
      note: "references/sql/migrate/2026-07-20_split_onboarding_name_columns.sql",
    },
  ];
  for (let attempt = 0; ; attempt++) {
    const { data, error } = await sb
      .from(TABLE)
      .update(update)
      .eq("token", token)
      .select("*")
      .single();
    if (!error) return { row: data as HrOnboardingSubmissionRow, error: null };
    // Strip a column family the error names AND that we're actually writing,
    // then retry. Bounded by the number of families so it can't loop forever.
    const family = OPTIONAL_COLUMN_FAMILIES.find(
      (f) => f.test.test(error.message) && f.keys.some((k) => k in update),
    );
    if (!family || attempt >= OPTIONAL_COLUMN_FAMILIES.length) {
      return { row: null, error: error.message };
    }
    console.error(
      `hr_onboarding_submissions is missing columns (${family.keys.join(", ")}); run ` +
        `${family.note}. Saving the submission without them:`,
      error.message,
    );
    for (const k of family.keys) delete update[k];
  }
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
 * `hr_pending_employees` row is created AND the workspace-account webhook has
 * fired, so the webhook outcome is persisted in the same write. Persisting the
 * outcome is what lets the Submitted tab show a "Designated Work Email" only
 * when the webhook returned a 200 (vs a minted-but-failed address).
 */
export async function linkOnboardingToPendingHire(
  id: string,
  args: {
    work_email: string;
    pending_employee_id: number;
    workspace?: WorkspaceAccountOutcome | null;
  },
): Promise<{ error: string | null }> {
  const sb = client();
  const update: Record<string, unknown> = {
    work_email: args.work_email.trim().toLowerCase() || null,
    pending_employee_id: args.pending_employee_id,
  };
  // Only stamp the webhook outcome when we actually attempted it. Leaving these
  // untouched (when `workspace` is omitted) preserves a prior successful result.
  if (args.workspace) {
    update.workspace_account_ok = args.workspace.ok;
    update.workspace_account_status = args.workspace.status ?? null;
    update.workspace_account_error = args.workspace.ok
      ? null
      : args.workspace.error ?? null;
    update.workspace_account_at = new Date().toISOString();
  }
  const { error } = await sb.from(TABLE).update(update).eq("id", id);
  return { error: error?.message ?? null };
}

/**
 * Overwrite just the workspace-account outcome columns on a submission. Used by
 * the read-only verify flow (and any re-check) to flip a row to confirmed /
 * failed without touching the minted work_email or the pending-hire link.
 */
export async function setOnboardingWorkspaceOutcome(
  id: string,
  outcome: WorkspaceAccountOutcome,
): Promise<{ error: string | null }> {
  const sb = client();
  const { error } = await sb
    .from(TABLE)
    .update({
      workspace_account_ok: outcome.ok,
      workspace_account_status: outcome.status ?? null,
      workspace_account_error: outcome.ok ? null : outcome.error ?? null,
      workspace_account_at: new Date().toISOString(),
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

/**
 * Upload the server-generated Intellectual Property Assignment PDF into the
 * private storage bucket at `<submission_id>/ip-assignment.pdf`. Returns the
 * path so the caller can record it on the submission row.
 */
export async function uploadIpAssignmentFile(
  submissionId: string,
  body: ArrayBuffer | Uint8Array,
): Promise<{ path: string | null; error: string | null }> {
  const sb = client();
  const path = `${submissionId}/ip-assignment.pdf`;
  const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
  const { error } = await sb.storage
    .from(HR_ONBOARDING_BUCKET)
    .upload(path, bytes, {
      contentType: "application/pdf",
      upsert: true,
      cacheControl: "no-cache",
    });
  if (error) return { path: null, error: error.message };
  return { path, error: null };
}

/** Sign a private IP-assignment PDF URL for HR to view/download. */
export async function getIpAssignmentSignedUrl(
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
