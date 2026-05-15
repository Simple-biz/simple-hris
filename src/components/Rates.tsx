"use client";

import React, { useEffect, useMemo, useState } from "react";
import {
  Briefcase,
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  DollarSign,
  Edit2,
  Eye,
  Download,
  IdCard,
  LayoutGrid,
  Loader2,
  Lock,
  Mail,
  Plus,
  Rows3,
  Search,
  Trash2,
  UserCheck,
  UserCog,
  UserPlus,
  UserX,
  X,
} from "lucide-react";
import { motion } from "motion/react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { normEmail } from "@/lib/email/norm-email";
import {
  OFFICIAL_USD_TO_PHP_RATE,
  effectiveUsdToPhpRateFromStored,
} from "@/lib/fx/usd-php";
import EmployeeAvatar from "@/components/employee/EmployeeAvatar";
import type { EmployeeRow } from "@/lib/supabase/employees";
import type { EmployeeIdRow } from "@/lib/supabase/employee-ids";
import {
  buildExportRows,
  downloadCsv,
  rowsToCsv,
  todayFilenameSuffix,
} from "@/lib/rates/export-csv";

type EmployeeRateProfile = {
  id: string;
  displayName: string;
  subtitle: string | null;
  department: string | null;
  organization: string | null;
  workEmail: string | null;
  personalEmail: string | null;
  fields: { key: string; value: unknown }[];
};

type EmployeeRateProfileSummary = {
  id: string;
  displayName: string;
  subtitle: string | null;
  department: string | null;
  organization: string | null;
  workEmail: string | null;
  personalEmail: string | null;
  employeeId: string | null;
  regularRate: string | null;
  otRate: string | null;
  suspended: boolean;
  profilePhotoUrl: string | null;
  /** Google Workspace photo URL — populated by NextAuth jwt callback on sign-in. */
  googlePhotoUrl: string | null;
  hasRatesRow: boolean;
  /** MESA Program member — ₱100 deducted from every paycheck when true. */
  mesaMember: boolean;
  /** HSL role-within-HSL ("Department/Role" col) when this person is in the
   *  synced HSL roster. Surfaces as a chip on the card. */
  hslRole?: string | null;
};

const DEPARTMENT_OPTIONS = [
  'Accounting',
  'Edit',
  'Devs',
  'Lead Gen',
  'Callback',
  'QC',
  'Discovery',
  'HR',
  'Sales Assistant',
  'Smart Staff',
  'US Manager Bonus',
  'Hogan Smith Law',
] as const;

function DepartmentSelect({
  value,
  onChange,
  id,
}: {
  value: string;
  onChange: (v: string) => void;
  id?: string;
}) {
  // Keep legacy/typo'd values visible as a one-off option so saving doesn't
  // silently rewrite them to "" if the current department isn't in the canonical list.
  const trimmed = value?.trim() ?? '';
  const isKnown =
    trimmed === '' ||
    DEPARTMENT_OPTIONS.some((d) => d.toLowerCase() === trimmed.toLowerCase());
  return (
    <select
      id={id}
      value={trimmed}
      onChange={(e) => onChange(e.target.value)}
      className="h-9 w-full rounded-md border border-zinc-200 bg-white px-3 text-sm text-zinc-900 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
    >
      <option value="">— None —</option>
      {DEPARTMENT_OPTIONS.map((d) => (
        <option key={d} value={d}>{d}</option>
      ))}
      {!isKnown && (
        <option value={trimmed}>{trimmed} (legacy)</option>
      )}
    </select>
  );
}

function normFieldKey(key: string): string {
  return key.trim().toLowerCase().replace(/\s+/g, "_").replace(/-/g, "_");
}

function formatLongDateEnUS(v: unknown): string | null {
  if (v == null) return null;
  let d: Date;
  if (typeof v === "number" && Number.isFinite(v)) {
    d = new Date(v < 1e12 ? v * 1000 : v);
  } else if (typeof v === "string") {
    const s = v.trim();
    if (!s) return null;
    d = new Date(s);
  } else {
    return null;
  }
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  if (y < 1900 || y > 2100) return null;
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

function shouldTryFormatAsDate(key: string, v: unknown): boolean {
  const nk = normFieldKey(key);
  if (nk.includes("date") || nk.endsWith("_at") || nk === "dob" || nk === "birthday") return true;
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v.trim())) return true;
  return false;
}

/** Strip currency symbols and grouping; parse a numeric hourly rate. */
function parseRateNumberString(raw: string): number | null {
  const cleaned = raw.replace(/[$₱,\s]/g, "").trim();
  if (!cleaned) return null;
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Format stored rate values as Philippine peso (₱). */
function formatRateDisplay(raw: string): string {
  if (raw === "—" || !String(raw).trim()) return raw === "—" ? "—" : String(raw);
  const n = parseRateNumberString(raw);
  if (n === null) return `₱${raw}`;
  return (
    "₱" +
    n.toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  );
}

function isHourlyRateFieldKey(key: string): boolean {
  const nk = normFieldKey(key);
  return (
    nk === "regular_rate" ||
    nk === "ot_rate" ||
    nk === "overtime_rate" ||
    nk === "hourly_rate"
  );
}

function formatFieldValue(key: string, v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "object") {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  if (shouldTryFormatAsDate(key, v)) {
    const long = formatLongDateEnUS(v);
    if (long) return long;
  }
  if (isHourlyRateFieldKey(key)) {
    const s = String(v).trim();
    if (!s) return "—";
    return formatRateDisplay(s);
  }
  return String(v);
}

function buildNormFieldMap(fields: { key: string; value: unknown }[]): Map<string, unknown> {
  const m = new Map<string, unknown>();
  for (const { key, value } of fields) {
    const nk = normFieldKey(key);
    if (!m.has(nk)) m.set(nk, value);
  }
  return m;
}

function pickFromMap(m: Map<string, unknown>, aliases: string[]): string {
  for (const a of aliases) {
    const nk = normFieldKey(a);
    if (m.has(nk)) return formatFieldValue(a, m.get(nk));
  }
  return "—";
}

/** Raw cell value from merged profile fields (no formatting). */
function pickRawFromMap(m: Map<string, unknown>, aliases: string[]): string {
  for (const a of aliases) {
    const nk = normFieldKey(a);
    if (m.has(nk)) {
      const v = m.get(nk);
      if (v != null && String(v).trim() !== "") return String(v).trim();
    }
  }
  return "—";
}

/** Plain number string for rate inputs (strips $ / ₱ / commas from legacy data). */
function normalizeRateForEdit(raw: string): string {
  if (raw === "—") return "—";
  const n = parseRateNumberString(raw);
  return n !== null ? String(n) : raw;
}

function sanitizeRateForApi(raw: string): string {
  if (raw === "—") return "";
  const n = parseRateNumberString(raw);
  return n !== null ? String(n) : raw.trim();
}

function isSuspendedFromProfile(p: EmployeeRateProfile): boolean {
  const f = p.fields.find((field) => normFieldKey(field.key) === 'suspended');
  return f?.value === true;
}

function tableRowFromProfile(
  p: EmployeeRateProfile,
  employeeIdMap: Map<string, string>,
) {
  const m = buildNormFieldMap(p.fields);
  const emailFromFields = pickFromMap(m, ["Email", "email", "Work Email", "work_email", "Work_Email"]);
  const workEmail =
    emailFromFields !== "—" ? emailFromFields : p.subtitle?.trim() || "—";

  const nameFromFields = pickFromMap(m, [
    "Name",
    "name",
    "Full Name",
    "full_name",
    "Member",
    "member",
    "Employee Name",
    "employee_name",
  ]);
  const display = (p.displayName ?? "").trim();
  const name =
    nameFromFields !== "—" && String(nameFromFields).trim() !== ""
      ? String(nameFromFields).trim()
      : display || "—";

  // Resolve employee ID — try every email we can find for this profile
  const personalEmail = pickFromMap(m, ["Personal Email", "personal_email", "Personal_Email"]);
  const candidateEmails = [workEmail, personalEmail, p.subtitle ?? ""]
    .map((e) => normEmail(e))
    .filter((e): e is string => Boolean(e));
  let employeeId: string | null = null;
  for (const e of candidateEmails) {
    const found = employeeIdMap.get(e);
    if (found) { employeeId = found; break; }
  }

  return {
    employeeId,
    name,
    department: p.department ?? null,
    organization: p.organization ?? pickFromMap(m, ["Organization", "organization", "Organisation", "org", "Company", "company"]),
    workEmail,
    regularRate: formatRateDisplay(pickRawFromMap(m, ["Regular Rate", "regular_rate", "Regular_Rate"])),
    otRate: formatRateDisplay(pickRawFromMap(m, ["OT Rate", "ot_rate", "OT_Rate", "Ot Rate"])),
    suspended: isSuspendedFromProfile(p),
  };
}

const HIDDEN_FIELD_KEYS = new Set([
  "profile_photo_url",
  "profile photo url",
  "profilephotourl",
  "photo_url",
  "photo url",
  "avatar_url",
  "avatar url",
  // Internal / auth bookkeeping that doesn't belong in the visible profile.
  "password_hash",
  "previous_password_hash",
  "password_updated_at",
  // Upload provenance fields — useful for debugging in the DB but noise here.
  "source_file",
  "import_batch_id",
  "upload_id",
  "first_seen_upload_id",
  "last_seen_upload_id",
]);

function getAvatarInfoFromProfile(
  p: EmployeeRateProfile,
): { photoUrl: string | null; googlePhotoUrl: string | null; email: string | null; initials: string } {
  const m = buildNormFieldMap(p.fields);
  const photoUrl =
    pickFromMap(m, ["Profile Photo Url", "profile_photo_url", "photo_url", "avatar_url"]);
  const googlePhotoUrl =
    pickFromMap(m, ["Google Photo Url", "google_photo_url", "google_picture"]);
  const email =
    pickFromMap(m, ["Work Email", "work_email", "Work_Email", "Email", "email"]);
  const name = p.displayName?.trim() || "";
  const parts = name.split(/\s+/).filter(Boolean);
  let initials = "??";
  if (parts.length >= 2) initials = (parts[0][0] + parts[1][0]).toUpperCase();
  else if (parts.length === 1 && parts[0].length >= 2) initials = parts[0].slice(0, 2).toUpperCase();
  return {
    photoUrl: photoUrl !== "—" ? photoUrl : null,
    googlePhotoUrl: googlePhotoUrl !== "—" ? googlePhotoUrl : null,
    email: email !== "—" ? email : null,
    initials,
  };
}

function tableRowFromSummary(p: EmployeeRateProfileSummary) {
  return {
    employeeId: p.employeeId,
    name: (p.displayName ?? "").trim() || "â€”",
    department: p.department ?? null,
    organization: p.organization ?? null,
    workEmail: p.workEmail?.trim() || p.subtitle?.trim() || "â€”",
    regularRate: formatRateDisplay(p.regularRate ?? "â€”"),
    otRate: formatRateDisplay(p.otRate ?? "â€”"),
    suspended: p.suspended,
    mesaMember: p.mesaMember,
    hasRatesRow: p.hasRatesRow,
    hslRole: (p.hslRole ?? "").trim() || null,
  };
}

function getAvatarInfoFromSummary(
  p: EmployeeRateProfileSummary,
): { photoUrl: string | null; googlePhotoUrl: string | null; email: string | null; initials: string } {
  const name = p.displayName?.trim() || "";
  const parts = name.split(/\s+/).filter(Boolean);
  let initials = "??";
  if (parts.length >= 2) initials = (parts[0][0] + parts[1][0]).toUpperCase();
  else if (parts.length === 1 && parts[0].length >= 2) initials = parts[0].slice(0, 2).toUpperCase();
  return {
    photoUrl: p.profilePhotoUrl,
    googlePhotoUrl: p.googlePhotoUrl,
    email: p.workEmail ?? p.personalEmail ?? p.subtitle,
    initials,
  };
}

function profileStubFromSummary(p: EmployeeRateProfileSummary): EmployeeRateProfile {
  return {
    id: p.id,
    displayName: p.displayName,
    subtitle: p.subtitle,
    department: p.department,
    organization: p.organization,
    workEmail: p.workEmail,
    personalEmail: p.personalEmail,
    fields: [
      { key: "Work Email", value: p.workEmail },
      { key: "Personal Email", value: p.personalEmail },
      { key: "Regular Rate", value: p.regularRate },
      { key: "OT Rate", value: p.otRate },
      { key: "Suspended", value: p.suspended },
      { key: "Profile Photo URL", value: p.profilePhotoUrl },
      { key: "Google Photo URL", value: p.googlePhotoUrl },
    ],
  };
}

function isHiddenField(key: string): boolean {
  return HIDDEN_FIELD_KEYS.has(normFieldKey(key));
}

const dialogEase = [0.22, 1, 0.36, 1] as const;

const PAGE_SIZE = 12;

interface RatesProps {
  focusEmail?: string | null;
  onFocusConsumed?: () => void;
}

export default function Rates({ focusEmail, onFocusConsumed }: RatesProps = {}) {
  const [profiles, setProfiles] = useState<EmployeeRateProfileSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [rateFilter, setRateFilter] = useState<"all" | "mesa_eligible">("all");
  const [departmentFilter, setDepartmentFilter] = useState<string>("all");
  const [page, setPage] = useState(1);
  // Persist view-mode preference per browser. On mobile we always render cards
  // (table doesn't fit), so the toggle only appears on md+.
  const [viewMode, setViewMode] = useState<"cards" | "table">(() => {
    if (typeof window === "undefined") return "cards";
    const stored = window.localStorage.getItem("rates-view-mode");
    return stored === "table" ? "table" : "cards";
  });
  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem("rates-view-mode", viewMode);
    }
  }, [viewMode]);
  const [profileOpen, setProfileOpen] = useState(false);
  const [avatarViewerUrl, setAvatarViewerUrl] = useState<string | null>(null);
  const [activeProfile, setActiveProfile] = useState<EmployeeRateProfile | null>(null);
  const [activeProfileSummary, setActiveProfileSummary] = useState<EmployeeRateProfileSummary | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [mergeNotes, setMergeNotes] = useState<string[]>([]);
  /** Same `usd_to_php_rate` as Payroll — for reference next to ₱ hourly rates. */
  const [usdToPhpRate, setUsdToPhpRate] = useState(OFFICIAL_USD_TO_PHP_RATE);

  // Rate editing state
  const [isEditing, setIsEditing] = useState(false);
  const [editRegularRate, setEditRegularRate] = useState("");
  const [editOtRate, setEditOtRate] = useState("");
  const [editEffectiveDate, setEditEffectiveDate] = useState<string>(""); // YYYY-MM-DD
  const [isSaving, setIsSaving] = useState(false);

  // Profile editing state
  const [isEditingProfile, setIsEditingProfile] = useState(false);
  const [editProfileForm, setEditProfileForm] = useState({
    name: "",
    department: "",
    workEmail: "",
    personalEmail: "",
    startDate: "",
  });
  const [isSavingProfile, setIsSavingProfile] = useState(false);

  // Add Employee modal state
  const [addOpen, setAddOpen] = useState(false);
  const [isAdding, setIsAdding] = useState(false);
  const [addForm, setAddForm] = useState({
    name: "",
    department: "",
    workEmail: "",
    personalEmail: "",
    startDate: "",
    regularRate: "",
    otRate: "",
  });

  function resetAddForm() {
    setAddForm({
      name: "",
      department: "",
      workEmail: "",
      personalEmail: "",
      startDate: "",
      regularRate: "",
      otRate: "",
    });
  }

  async function handleAddEmployee(e: React.FormEvent) {
    e.preventDefault();
    if (!addForm.name.trim()) {
      toast.error("Name is required");
      return;
    }
    if (!addForm.workEmail.trim() && !addForm.personalEmail.trim()) {
      toast.error("At least one email (work or personal) is required");
      return;
    }
    setIsAdding(true);
    try {
      const res = await fetch("/api/add-employee", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: addForm.name.trim() || null,
          department: addForm.department.trim() || null,
          workEmail: addForm.workEmail.trim() || null,
          personalEmail: addForm.personalEmail.trim() || null,
          startDate: addForm.startDate || null,
          regularRate: sanitizeRateForApi(addForm.regularRate) || null,
          otRate: sanitizeRateForApi(addForm.otRate) || null,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to add employee");
      toast.success(`${addForm.name} added successfully`);
      setAddOpen(false);
      resetAddForm();
      await fetchProfiles();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to add employee");
    } finally {
      setIsAdding(false);
    }
  }

  // Delete state
  const [deleteTarget, setDeleteTarget] = useState<EmployeeRateProfileSummary | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isExporting, setIsExporting] = useState(false);

  // Suspend state — stores the profile.id currently being toggled, or null
  const [isSuspending, setIsSuspending] = useState<string | null>(null);
  // MESA Program toggle state
  const [isMesaToggling, setIsMesaToggling] = useState<string | null>(null);

  function extractEmailsFromSummary(p: EmployeeRateProfileSummary): { workEmail: string | null; personalEmail: string | null } {
    return {
      workEmail: p.workEmail ?? p.subtitle ?? null,
      personalEmail: p.personalEmail ?? null,
    };
  }

  function extractEmailsFromProfile(p: EmployeeRateProfile): { workEmail: string | null; personalEmail: string | null } {
    // Primary: explicit fields lifted during profile finalize.
    let workEmail: string | null = p.workEmail ?? null;
    let personalEmail: string | null = p.personalEmail ?? null;

    // Fallbacks for older data paths that may still carry emails inside `fields`.
    if (!workEmail || !personalEmail) {
      const m = buildNormFieldMap(p.fields);
      if (!workEmail) {
        const v = pickFromMap(m, ["Work Email", "work_email", "Work_Email"]);
        if (v && v !== "—") workEmail = v;
      }
      if (!personalEmail) {
        const v = pickFromMap(m, ["Personal Email", "personal_email", "Personal_Email"]);
        if (v && v !== "—") personalEmail = v;
      }
    }

    // Fallback: id is "e:<email>"
    if (!workEmail && p.id.startsWith("e:")) workEmail = p.id.slice(2);
    // Fallback: subtitle carries the primary email (work preferred).
    if (!workEmail && p.subtitle) workEmail = p.subtitle;

    return { workEmail, personalEmail };
  }

  function extractEmails(target: EmployeeRateProfileSummary | EmployeeRateProfile): { workEmail: string | null; personalEmail: string | null } {
    if ("fields" in target) return extractEmailsFromProfile(target);
    return extractEmailsFromSummary(target);
  }

  async function handleDeleteEmployee() {
    if (!deleteTarget) return;
    setIsDeleting(true);
    try {
      const { workEmail, personalEmail } = extractEmails(deleteTarget);
      const res = await fetch("/api/delete-employee", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workEmail,
          personalEmail,
          name: deleteTarget.displayName || null,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to delete employee");
      toast.success(`${deleteTarget.displayName} deleted`);
      setDeleteTarget(null);
      setProfileOpen(false);
      setActiveProfile(null);
      setActiveProfileSummary(null);
      await fetchProfiles();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete employee");
    } finally {
      setIsDeleting(false);
    }
  }

  async function handleToggleSuspend(profile: EmployeeRateProfileSummary | EmployeeRateProfile, suspend: boolean) {
    const { workEmail, personalEmail } = extractEmails(profile);
    if (!workEmail && !personalEmail) {
      toast.error("Cannot identify employee — no email found");
      return;
    }
    setIsSuspending(profile.id);
    try {
      const res = await fetch("/api/suspend-employee", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workEmail,
          personalEmail,
          suspended: suspend,
          name: profile.displayName || null,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to update status");
      toast.success(`${profile.displayName} ${suspend ? "suspended" : "unsuspended"}`);
      // Refresh list and keep modal in sync
      await fetchProfiles();
      setActiveProfileSummary((prev) =>
        prev && prev.id === profile.id ? { ...prev, suspended: suspend } : prev,
      );
      if (activeProfile?.id === profile.id) {
        setActiveProfile((prev) =>
          prev
            ? {
                ...prev,
                fields: prev.fields.map((f) =>
                  normFieldKey(f.key) === "suspended" ? { ...f, value: suspend } : f,
                ),
              }
            : null,
        );
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update status");
    } finally {
      setIsSuspending(null);
    }
  }

  async function handleToggleMesa(profile: EmployeeRateProfileSummary, enroll: boolean) {
    const { workEmail, personalEmail } = extractEmailsFromSummary(profile);
    if (!workEmail && !personalEmail) {
      toast.error("Cannot identify employee — no email found");
      return;
    }
    setIsMesaToggling(profile.id);
    try {
      const res = await fetch("/api/toggle-mesa-member", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workEmail, personalEmail, mesaMember: enroll, name: profile.displayName || null }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to update MESA status");
      toast.success(`${profile.displayName} ${enroll ? "enrolled in" : "removed from"} MESA Program`);
      await fetchProfiles();
      setActiveProfileSummary((prev) =>
        prev && prev.id === profile.id ? { ...prev, mesaMember: enroll } : prev,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update MESA status");
    } finally {
      setIsMesaToggling(null);
    }
  }

  const fetchProfiles = async () => {
    try {
      const [profilesRes, fxRes] = await Promise.all([
        fetch("/api/employee-rate-profiles/summary", { cache: "no-store" }),
        fetch("/api/app-settings?key=usd_to_php_rate", { cache: "no-store" }),
      ]);
      if (!profilesRes.ok) throw new Error(`HTTP ${profilesRes.status}`);

      const json = (await profilesRes.json()) as {
        profiles: EmployeeRateProfileSummary[];
        error: string | null;
        mergeNotes?: string[];
      };
      setProfiles(json.profiles ?? []);
      setError(json.error ?? null);
      setMergeNotes(json.mergeNotes ?? []);

      if (fxRes.ok) {
        const fxJson = (await fxRes.json()) as { value: string | null };
        setUsdToPhpRate(effectiveUsdToPhpRateFromStored(fxJson.value));
      }
    } catch (e) {
      setProfiles([]);
      setMergeNotes([]);
      setError(e instanceof Error ? e.message : "Failed to load rates");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchProfiles();
  }, []);

  // Reload when PayrollWizard finishes a Google Sheet sync (master / rates / HSL).
  // Server caches are invalidated in the sync route handlers; this just kicks the
  // open Rates view to re-fetch immediately instead of waiting for the next mount.
  useEffect(() => {
    const onStale = () => { void fetchProfiles(); };
    window.addEventListener('rates-profiles-stale', onStale);
    return () => window.removeEventListener('rates-profiles-stale', onStale);
  }, []);

  const fetchProfileDetail = async (summary: EmployeeRateProfileSummary) => {
    const query = summary.workEmail ?? summary.personalEmail ?? summary.subtitle ?? summary.id;
    const key = summary.workEmail || summary.personalEmail || summary.subtitle ? "email" : "id";
    setProfileLoading(true);
    setProfileError(null);
    try {
      const res = await fetch(`/api/employee-rate-profiles?${key}=${encodeURIComponent(query)}`, {
        cache: "no-store",
      });
      const json = (await res.json()) as {
        profile?: EmployeeRateProfile | null;
        error?: string | null;
      };
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      if (!json.profile) throw new Error("Profile details not found");
      setActiveProfile(json.profile);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to load full profile";
      setProfileError(msg);
      toast.error(msg);
    } finally {
      setProfileLoading(false);
    }
  };

  // Precompute `tableRowFromProfile` + a lowercased search blob once per profile.
  // Without this, each keystroke re-computed both for every profile (~900 × ~20
  // string ops) and made search unusably laggy. This memo re-runs only when the
  // profile set or the id map changes — typing in the search box is then just a
  // substring check against pre-built blobs.
  const searchIndex = useMemo(() => {
    return profiles.map((p) => {
      const row = tableRowFromSummary(p);
      const blob = [
        row.employeeId ?? "",
        p.displayName,
        p.subtitle ?? "",
        row.name,
        row.department ?? "",
        row.organization ?? "",
        row.workEmail,
        row.regularRate,
        row.otRate,
      ]
        .join(" ")
        .toLowerCase();
      return { profile: p, row, blob };
    });
  }, [profiles]);

  const departmentOptions = useMemo(() => {
    const set = new Set<string>();
    for (const p of profiles) {
      const d = (p.department ?? "").trim();
      if (d) set.add(d);
    }
    return [...set].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  }, [profiles]);

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const result: EmployeeRateProfileSummary[] = [];
    for (const { profile, row, blob } of searchIndex) {
      if (rateFilter === "mesa_eligible" && !row.mesaMember) continue;
      if (
        departmentFilter !== "all" &&
        (profile.department ?? "").trim().toLowerCase() !== departmentFilter.toLowerCase()
      ) continue;
      if (q && !blob.includes(q)) continue;
      result.push(profile);
    }
    return result;
  }, [searchIndex, searchQuery, rateFilter, departmentFilter]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);

  /** Quick-glance counts for the stats strip in the header. */
  const stats = useMemo(() => {
    const isMissing = (v?: string | null) => !v || v === "—" || v.trim() === "";
    let missingAny = 0;
    let missingBoth = 0;
    let suspended = 0;
    for (const p of profiles) {
      const reg = isMissing(p.regularRate);
      const ot = isMissing(p.otRate);
      if (reg || ot) missingAny++;
      if (reg && ot) missingBoth++;
      if (p.suspended) suspended++;
    }
    return { total: profiles.length, missingAny, missingBoth, suspended };
  }, [profiles]);

  useEffect(() => {
    setPage(1);
  }, [searchQuery, rateFilter, departmentFilter]);

  useEffect(() => {
    setPage((p) => Math.min(p, totalPages));
  }, [totalPages]);

  const pageRows = useMemo(() => {
    const start = (safePage - 1) * PAGE_SIZE;
    return filtered.slice(start, start + PAGE_SIZE);
  }, [filtered, safePage]);

  function openProfile(p: EmployeeRateProfileSummary) {
    setActiveProfileSummary(p);
    setActiveProfile(profileStubFromSummary(p));
    setProfileOpen(true);
    setIsEditing(false);
    setIsEditingProfile(false);
    setProfileError(null);

    setEditRegularRate(normalizeRateForEdit(p.regularRate ?? "â€”"));
    setEditOtRate(normalizeRateForEdit(p.otRate ?? "â€”"));
    void fetchProfileDetail(p);
  }

  useEffect(() => {
    if (!focusEmail || profiles.length === 0) return;
    const target = normEmail(focusEmail);
    if (!target) return;
    const match = profiles.find((p) => {
      const emails = [p.workEmail ?? "", p.personalEmail ?? "", p.subtitle ?? ""];
      return emails.some((e) => normEmail(e) === target);
    });
    if (match) {
      openProfile(match);
      setSearchQuery(focusEmail);
    }
    onFocusConsumed?.();
  }, [focusEmail, profiles, onFocusConsumed]);

  async function handleSaveRates() {
    if (!activeProfile) return;
    setIsSaving(true);

    try {
      const m = buildNormFieldMap(activeProfile.fields);
      let workEmail = pickFromMap(m, ["Work Email", "work_email", "Work_Email"]);
      let personalEmail = pickFromMap(m, ["Personal Email", "personal_email", "Personal_Email"]);

      // Fallback: extract from activeProfile.id if it's e:email
      if (workEmail === "—" && activeProfile.id.startsWith("e:")) {
        workEmail = activeProfile.id.slice(2);
      }
      
      // Secondary fallback: extract from subtitle
      if (workEmail === "—" && activeProfile.subtitle) {
        // Subtitle might be "work@simple.biz · personal@other.com"
        const parts = activeProfile.subtitle.split("·").map(s => s.trim());
        if (parts[0]) workEmail = parts[0];
        if (parts[1]) personalEmail = parts[1];
      }

      const emailToUse = workEmail !== "—" ? workEmail : (personalEmail !== "—" ? personalEmail : null);

      if (!emailToUse) {
        toast.error("Could not find an email to identify the employee");
        setIsSaving(false);
        return;
      }

      const res = await fetch("/api/update-employee-rates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workEmail: workEmail !== "—" ? workEmail : null,
          personalEmail: personalEmail !== "—" ? personalEmail : null,
          regularRate: sanitizeRateForApi(editRegularRate),
          otRate: sanitizeRateForApi(editOtRate),
          effectiveDate: editEffectiveDate || null,
        }),
      });

      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to update rates");

      const today = new Date();
      const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
      if (editEffectiveDate && editEffectiveDate > todayIso) {
        toast.success(`Rate change scheduled for ${editEffectiveDate}`);
      } else {
        toast.success("Rates updated successfully");
      }
      setIsEditing(false);

      // We need to update the local activeProfile state and the profiles list
      // Simplest is to refetch all profiles
      await fetchProfiles();
      setActiveProfileSummary((prev) =>
        prev
          ? {
              ...prev,
              regularRate: sanitizeRateForApi(editRegularRate) || null,
              otRate: sanitizeRateForApi(editOtRate) || null,
            }
          : prev,
      );

      // Also update activeProfile fields locally to reflect the change in the modal
      const rr = sanitizeRateForApi(editRegularRate);
      const ot = sanitizeRateForApi(editOtRate);
      const updatedFields = activeProfile.fields.map(f => {
        const nk = normFieldKey(f.key);
        if (["regular_rate", "regular_rate", "Regular_Rate"].map(normFieldKey).includes(nk)) {
          return { ...f, value: rr };
        }
        if (["ot_rate", "ot_rate", "OT_Rate", "Ot Rate"].map(normFieldKey).includes(nk)) {
          return { ...f, value: ot };
        }
        return f;
      });
      setActiveProfile({ ...activeProfile, fields: updatedFields });

    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to update rates");
    } finally {
      setIsSaving(false);
    }
  }

  function openEditProfile() {
    if (!activeProfile) return;
    const m = buildNormFieldMap(activeProfile.fields);
    const raw = (aliases: string[]) => {
      for (const a of aliases) {
        const nk = normFieldKey(a);
        if (m.has(nk)) {
          const v = m.get(nk);
          if (v != null && String(v).trim() !== "") return String(v).trim();
        }
      }
      return "";
    };
    const rawDate = raw(["Start Date", "start_date", "StartDate"]);
    // Normalise to YYYY-MM-DD for <input type="date">
    let dateValue = "";
    if (rawDate) {
      if (/^\d{4}-\d{2}-\d{2}/.test(rawDate)) {
        dateValue = rawDate.slice(0, 10);
      } else {
        const d = new Date(rawDate);
        if (!isNaN(d.getTime())) {
          dateValue = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        }
      }
    }
    // Emails are moved out of fields into subtitle/id during the merge —
    // use extractEmailsFromProfile which handles all the fallback logic.
    const { workEmail: resolvedWork, personalEmail: resolvedPersonal } =
      extractEmailsFromProfile(activeProfile);

    setEditProfileForm({
      name: activeProfile.displayName && activeProfile.displayName !== "Unknown"
        ? activeProfile.displayName
        : raw(["Name", "name", "Full Name", "full_name"]),
      department: activeProfile.department ?? "",
      workEmail: resolvedWork ?? "",
      personalEmail: resolvedPersonal ?? "",
      startDate: dateValue,
    });
    setIsEditingProfile(true);
  }

  async function handleSaveProfile() {
    if (!activeProfile) return;
    setIsSavingProfile(true);
    try {
      const { workEmail: originalWorkEmail, personalEmail: originalPersonalEmail } =
        extractEmailsFromProfile(activeProfile);
      const res = await fetch("/api/update-employee-profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          originalWorkEmail,
          originalPersonalEmail,
          name: editProfileForm.name.trim() || null,
          department: editProfileForm.department.trim() || null,
          workEmail: editProfileForm.workEmail.trim() || null,
          personalEmail: editProfileForm.personalEmail.trim() || null,
          startDate: editProfileForm.startDate || null,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to update profile");
      toast.success("Profile updated successfully");
      setIsEditingProfile(false);
      await fetchProfiles();
      setActiveProfileSummary((prev) =>
        prev
          ? {
              ...prev,
              displayName: editProfileForm.name.trim() || prev.displayName,
              department: editProfileForm.department.trim() || null,
              workEmail: editProfileForm.workEmail.trim() || null,
              personalEmail: editProfileForm.personalEmail.trim() || null,
              subtitle:
                editProfileForm.workEmail.trim() ||
                editProfileForm.personalEmail.trim() ||
                prev.subtitle,
            }
          : prev,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update profile");
    } finally {
      setIsSavingProfile(false);
    }
  }

  /**
   * CSV export — pulls master-list rows and employee_ids in parallel, joins them
   * with the currently filtered summaries by email, and downloads a flat per-row
   * CSV with 36 columns grouped by section (identity → comp → address → contact
   * → payment → media). See src/lib/rates/export-csv.ts for column order.
   */
  async function handleExportCsv() {
    if (filtered.length === 0) {
      toast.info("Nothing to export — adjust your filter or search.");
      return;
    }
    setIsExporting(true);
    try {
      const [empRes, idsRes] = await Promise.all([
        fetch("/api/employees", { cache: "no-store" }),
        fetch("/api/employee-ids", { cache: "no-store" }),
      ]);
      const empJson = (await empRes.json()) as { employees?: EmployeeRow[] };
      const idsJson = (await idsRes.json()) as { rows?: EmployeeIdRow[] };
      const masterRows = empJson.employees ?? [];
      const idRows = idsJson.rows ?? [];

      const exportRows = buildExportRows(filtered, masterRows, idRows);
      const csv = rowsToCsv(exportRows);
      const filename = `rates_and_profiles_${todayFilenameSuffix()}.csv`;
      downloadCsv(filename, csv);
      toast.success(`Exported ${exportRows.length} employee${exportRows.length === 1 ? "" : "s"} → ${filename}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Export failed");
    } finally {
      setIsExporting(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-hidden bg-gradient-to-br from-white via-orange-50/30 to-blue-50/20 px-3 py-2 sm:px-4 sm:py-3 md:px-5 lg:gap-4 lg:py-3 dark:bg-none dark:bg-[#0d1117]">
      {/* Editorial header */}
      <motion.header
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
        className="flex shrink-0 flex-col gap-3 border-b border-zinc-200/70 pb-3 dark:border-zinc-800/70 lg:flex-row lg:items-end lg:justify-between lg:gap-6"
      >
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-medium uppercase tracking-[0.18em] text-amber-700/80 dark:text-amber-500/70">
            Accounting
            <span className="mx-1.5 text-zinc-300 dark:text-zinc-700">/</span>
            Roster
          </p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-zinc-900 sm:text-3xl lg:text-[2.25rem] lg:leading-none dark:text-white">
            Rates &amp; Profiles
          </h1>
          <p className="mt-1.5 text-xs leading-snug text-zinc-500 dark:text-zinc-500">
            Merged from{" "}
            <span className="text-zinc-600 dark:text-zinc-400">employee_hourly_rates</span>{" "}
            and <span className="text-zinc-600 dark:text-zinc-400">global_master_list</span>{" "}
            — rows match by work/personal email or name. Open any row for the full profile.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={isExporting || loading || !!error || filtered.length === 0}
            onClick={() => void handleExportCsv()}
            title={
              filtered.length === 0
                ? "No rows to export — adjust filter or search"
                : `Export ${filtered.length} ${filtered.length === 1 ? "row" : "rows"} as CSV`
            }
            className="gap-1.5 border-zinc-200 text-zinc-700 hover:bg-zinc-50 hover:text-zinc-900 disabled:opacity-50 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-900 dark:hover:text-zinc-100"
          >
            {isExporting ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Download className="size-4" />
            )}
            <span className="hidden sm:inline">
              Export CSV
              {!isExporting && filtered.length > 0 && (
                <span className="ml-1 text-[10px] text-zinc-500 dark:text-zinc-500">
                  ({filtered.length})
                </span>
              )}
            </span>
            <span className="sm:hidden">CSV</span>
          </Button>
          <Button
            type="button"
            onClick={() => {
              resetAddForm();
              setAddOpen(true);
            }}
            className="gap-1.5 bg-gradient-to-r from-orange-500 to-orange-600 text-white shadow-sm shadow-orange-500/25 ring-1 ring-orange-500/20 transition-all hover:from-orange-600 hover:to-orange-700 hover:shadow-md hover:shadow-orange-500/30 active:scale-[0.98] dark:from-orange-500 dark:to-orange-600 dark:hover:from-orange-600 dark:hover:to-orange-700"
          >
            <UserPlus className="size-4" />
            Add Employee
          </Button>
        </div>
      </motion.header>

      {/* Stats strip — at-a-glance roster context */}
      <motion.div
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, delay: 0.06, ease: [0.16, 1, 0.3, 1] }}
        className="grid shrink-0 grid-cols-2 gap-2 sm:grid-cols-4 sm:gap-3"
      >
        <div className="flex flex-col gap-0.5 rounded-lg border border-zinc-200/80 bg-white/60 px-3 py-2 dark:border-zinc-800/70 dark:bg-zinc-900/30">
          <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-zinc-500 dark:text-zinc-500">
            Employees
          </span>
          <span className="text-lg font-bold tabular-nums leading-none text-zinc-900 dark:text-white">
            {stats.total}
          </span>
        </div>
        <div className="flex flex-col gap-0.5 rounded-lg border border-amber-200/80 bg-amber-50/60 px-3 py-2 dark:border-amber-900/40 dark:bg-amber-950/20">
          <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-amber-700 dark:text-amber-400">
            Missing rates
          </span>
          <span className="text-lg font-bold tabular-nums leading-none text-amber-800 dark:text-amber-300">
            {stats.missingAny}
            {stats.missingBoth > 0 && (
              <span className="ml-1.5 align-middle text-[10px] font-medium text-amber-600 dark:text-amber-500">
                ({stats.missingBoth} both)
              </span>
            )}
          </span>
        </div>
        <div className="flex flex-col gap-0.5 rounded-lg border border-zinc-200/80 bg-white/60 px-3 py-2 dark:border-zinc-800/70 dark:bg-zinc-900/30">
          <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-zinc-500 dark:text-zinc-500">
            Suspended
          </span>
          <span className="text-lg font-bold tabular-nums leading-none text-zinc-700 dark:text-zinc-300">
            {stats.suspended}
          </span>
        </div>
        <div className="flex flex-col gap-0.5 rounded-lg border border-blue-200/70 bg-blue-50/50 px-3 py-2 dark:border-blue-900/40 dark:bg-blue-950/20">
          <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-blue-700 dark:text-blue-400">
            USD → PHP
          </span>
          <span className="text-base font-bold tabular-nums leading-none text-blue-900 dark:text-blue-300">
            ₱{usdToPhpRate.toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 5 })}
          </span>
        </div>
      </motion.div>

      {mergeNotes.length > 0 ? (
        <div className="max-h-20 shrink-0 overflow-y-auto rounded-lg border border-amber-500/25 bg-amber-500/[0.08] px-3 py-2 text-sm text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100/95">
          <p className="text-xs font-medium text-amber-900 dark:text-amber-200">Merge notes</p>
          <ul className="mt-1 list-inside list-disc space-y-0.5 text-[11px] text-amber-900/90 dark:text-amber-200/85">
            {mergeNotes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Table section — single light container, no card-on-card chrome */}
      <section className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden rounded-xl border border-zinc-200/80 bg-white/60 p-3 shadow-sm sm:p-4 dark:border-zinc-800/80 dark:bg-zinc-900/30">
        {/* Refined toolbar — no labels, full-width search + compact filter */}
        <div className="flex shrink-0 flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-zinc-400" />
            <Input
              id="rates-search"
              placeholder="Search name, email, or rate…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              disabled={loading || !!error}
              className="h-9 border-zinc-200 bg-white pl-9 text-zinc-900 transition-colors placeholder:text-zinc-400 hover:border-zinc-300 focus:border-orange-500 focus:ring-2 focus:ring-orange-500/20 dark:border-zinc-800 dark:bg-zinc-900/80 dark:text-zinc-200 dark:placeholder:text-zinc-600 dark:hover:border-zinc-700 dark:focus:border-orange-400"
            />
          </div>
          <select
            id="rates-department-filter"
            value={departmentFilter}
            onChange={(e) => setDepartmentFilter(e.target.value)}
            disabled={loading || !!error}
            className="h-9 w-full rounded-md border border-zinc-200 bg-white px-3 text-sm text-zinc-900 transition-colors hover:border-zinc-300 focus:border-orange-500 focus:outline-none focus:ring-2 focus:ring-orange-500/20 disabled:opacity-50 sm:w-56 dark:border-zinc-800 dark:bg-zinc-900/80 dark:text-zinc-200 dark:hover:border-zinc-700 dark:focus:border-orange-400"
          >
            <option value="all">All departments</option>
            {departmentOptions.map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
          <select
            id="rates-filter"
            value={rateFilter}
            onChange={(e) => setRateFilter(e.target.value as typeof rateFilter)}
            disabled={loading || !!error}
            className="h-9 w-full rounded-md border border-zinc-200 bg-white px-3 text-sm text-zinc-900 transition-colors hover:border-zinc-300 focus:border-orange-500 focus:outline-none focus:ring-2 focus:ring-orange-500/20 disabled:opacity-50 sm:w-48 dark:border-zinc-800 dark:bg-zinc-900/80 dark:text-zinc-200 dark:hover:border-zinc-700 dark:focus:border-orange-400"
          >
            <option value="all">All employees</option>
            <option value="mesa_eligible">MESA Eligible</option>
          </select>

          {/* View mode toggle — sliding pill (cards | table). Hidden on mobile (table doesn't fit). */}
          <div
            role="tablist"
            aria-label="View mode"
            className="relative hidden h-9 shrink-0 items-center gap-0.5 rounded-md border border-zinc-200 bg-white p-0.5 dark:border-zinc-800 dark:bg-zinc-900/80 md:inline-flex"
          >
            {(["cards", "table"] as const).map((mode) => {
              const isActive = viewMode === mode;
              const Icon = mode === "cards" ? LayoutGrid : Rows3;
              const label = mode === "cards" ? "Cards" : "Table";
              return (
                <button
                  key={mode}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  aria-label={`${label} view`}
                  onClick={() => setViewMode(mode)}
                  disabled={loading || !!error}
                  className={cn(
                    "relative z-10 flex items-center gap-1.5 rounded px-2.5 text-xs font-medium transition-colors duration-200 disabled:opacity-50",
                    isActive
                      ? "text-white dark:text-zinc-900"
                      : "text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100",
                    "h-7"
                  )}
                >
                  {isActive && (
                    <motion.span
                      layoutId="rates-viewmode-pill"
                      aria-hidden
                      className="absolute inset-0 rounded bg-zinc-900 dark:bg-zinc-100"
                      transition={{ type: "spring", stiffness: 420, damping: 34 }}
                    />
                  )}
                  <span className="relative z-10 flex items-center gap-1.5">
                    <Icon className="h-3.5 w-3.5" />
                    {label}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

          {loading ? (
            <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden">
              {/* Pagination bar skeleton */}
              <div className="flex shrink-0 items-center justify-between text-xs">
                <div className="h-4 w-40 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
                <div className="flex items-center gap-1">
                  <div className="h-8 w-8 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
                  <div className="h-4 w-12 animate-pulse rounded bg-zinc-200/70 dark:bg-zinc-800/70" />
                  <div className="h-8 w-8 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
                </div>
              </div>
              {/* Card grid skeleton */}
              <div className="min-h-0 flex-1 overflow-y-auto">
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {Array.from({ length: PAGE_SIZE }, (_, i) => (
                    <div key={i} className="flex flex-col gap-3 rounded-xl border border-zinc-200/90 bg-white/80 p-4 dark:border-zinc-800 dark:bg-zinc-900/40" style={{ animationDelay: `${i * 35}ms` }}>
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex items-center gap-2.5">
                          <div className="h-9 w-9 shrink-0 animate-pulse rounded-full bg-zinc-200 dark:bg-zinc-800" />
                          <div className="space-y-1.5">
                            <div className="h-3.5 w-28 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
                            <div className="h-2.5 w-16 animate-pulse rounded bg-zinc-200/60 dark:bg-zinc-800/60" />
                          </div>
                        </div>
                        <div className="h-4 w-14 animate-pulse rounded bg-zinc-200/70 dark:bg-zinc-800/70" />
                      </div>
                      <div className="flex gap-1.5">
                        <div className="h-5 w-16 animate-pulse rounded-md bg-zinc-200/70 dark:bg-zinc-800/70" />
                        <div className="h-5 w-20 animate-pulse rounded-md bg-zinc-200/70 dark:bg-zinc-800/70" />
                      </div>
                      <div className="h-3 w-full animate-pulse rounded bg-zinc-200/50 dark:bg-zinc-800/50" />
                      <div className="grid grid-cols-2 gap-2">
                        <div className="h-12 animate-pulse rounded-lg bg-zinc-100 dark:bg-zinc-800/60" />
                        <div className="h-12 animate-pulse rounded-lg bg-zinc-100 dark:bg-zinc-800/60" />
                      </div>
                      <div className="flex gap-1.5 border-t border-zinc-100 pt-3 dark:border-zinc-800">
                        <div className="h-8 flex-1 animate-pulse rounded-md bg-zinc-200/70 dark:bg-zinc-800/70" />
                        <div className="h-8 w-8 animate-pulse rounded-md bg-zinc-200/70 dark:bg-zinc-800/70" />
                        <div className="h-8 w-8 animate-pulse rounded-md bg-zinc-200/70 dark:bg-zinc-800/70" />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : error ? (
            <p className="shrink-0 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-200/90">
              {error}
            </p>
          ) : filtered.length === 0 ? (
            <p className="shrink-0 text-sm text-zinc-600 dark:text-zinc-500">
              {profiles.length === 0
                ? "No rows in employee_hourly_rates, or the table could not be read."
                : "No profiles match your search."}
            </p>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden">
              <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 text-xs text-zinc-600 dark:text-zinc-500">
                <span>
                  Showing{" "}
                  <span className="text-zinc-800 dark:text-zinc-300">
                    {filtered.length === 0 ? 0 : (safePage - 1) * PAGE_SIZE + 1}–
                    {Math.min(safePage * PAGE_SIZE, filtered.length)}
                  </span>{" "}
                  of <span className="text-zinc-800 dark:text-zinc-300">{filtered.length}</span>
                </span>
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-8 border-zinc-200 text-zinc-800 dark:border-zinc-800 dark:text-zinc-300"
                    disabled={safePage <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    aria-label="Previous page"
                  >
                    <ChevronLeft className="size-4" />
                  </Button>
                  <span className="px-2 text-zinc-600 dark:text-zinc-400">
                    {safePage} / {totalPages}
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-8 border-zinc-200 text-zinc-800 dark:border-zinc-800 dark:text-zinc-300"
                    disabled={safePage >= totalPages}
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    aria-label="Next page"
                  >
                    <ChevronRight className="size-4" />
                  </Button>
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">
                {/* TABLE VIEW — desktop only (md+) when viewMode === 'table' */}
                {viewMode === "table" && (
                  <div className="hidden md:block">
                    <div className="overflow-x-auto rounded-md border border-zinc-200/80 dark:border-zinc-800/80">
                      <table className="w-full border-collapse text-[13px]">
                        <thead className="sticky top-0 z-10 bg-gradient-to-r from-orange-50/95 to-blue-50/60 backdrop-blur-sm dark:from-blue-950/90 dark:to-blue-950/70">
                          <tr className="border-b border-zinc-200 dark:border-zinc-800">
                            <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-zinc-600 dark:text-zinc-400">
                              Employee
                            </th>
                            <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-zinc-600 dark:text-zinc-400">
                              ID
                            </th>
                            <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-zinc-600 dark:text-zinc-400">
                              Department
                            </th>
                            <th className="px-3 py-2.5 text-center text-[11px] font-semibold uppercase tracking-wider text-zinc-600 dark:text-zinc-400">
                              MESA
                            </th>
                            <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-zinc-600 dark:text-zinc-400">
                              Email
                            </th>
                            <th className="px-3 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wider text-zinc-600 dark:text-zinc-400">
                              Regular
                            </th>
                            <th className="px-3 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wider text-zinc-600 dark:text-zinc-400">
                              OT
                            </th>
                            <th className="px-3 py-2.5 text-center text-[11px] font-semibold uppercase tracking-wider text-zinc-600 dark:text-zinc-400">
                              Status
                            </th>
                            <th className="w-[120px] px-3 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wider text-zinc-600 dark:text-zinc-400">
                              Actions
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {pageRows.map((p) => {
                            const row = tableRowFromSummary(p);
                            const av = getAvatarInfoFromSummary(p);
                            const isMasterOnly = !row.hasRatesRow;
                            const ratesBlank = !isMasterOnly && (row.regularRate === "—" || row.otRate === "—");
                            const isComplete = !isMasterOnly && !ratesBlank;
                            return (
                              <tr
                                key={p.id}
                                className={cn(
                                  "border-b border-zinc-100 last:border-b-0 transition-colors hover:bg-zinc-50/60 dark:border-zinc-800/60 dark:hover:bg-zinc-900/40",
                                  row.suspended && "bg-amber-50/30 opacity-75 dark:bg-amber-950/10",
                                )}
                              >
                                <td className="px-3 py-2.5">
                                  <div className="flex items-center gap-2.5">
                                    <EmployeeAvatar
                                      photoUrl={av.photoUrl}
                                      googlePhotoUrl={av.googlePhotoUrl}
                                      email={av.email}
                                      initials={av.initials}
                                      className="h-7 w-7 shrink-0 text-[10px]"
                                      pixelSize={56}
                                    />
                                    <div className="min-w-0">
                                      <p className="truncate text-[13px] font-medium leading-tight text-zinc-900 dark:text-zinc-100">
                                        {row.name}
                                      </p>
                                      {row.organization && row.organization !== "—" && (
                                        <p className="mt-0.5 truncate text-[10.5px] text-zinc-500 dark:text-zinc-400">
                                          {row.organization}
                                        </p>
                                      )}
                                    </div>
                                  </div>
                                </td>
                                <td className="px-3 py-2.5">
                                  {row.employeeId ? (
                                    <span className="inline-flex items-center rounded border border-orange-200 bg-orange-50 px-1.5 py-0.5 text-[11px] font-semibold text-orange-700 dark:border-orange-500/30 dark:bg-orange-500/10 dark:text-orange-400">
                                      {row.employeeId}
                                    </span>
                                  ) : (
                                    <span className="text-[11px] text-zinc-400 dark:text-zinc-600">—</span>
                                  )}
                                </td>
                                <td className="px-3 py-2.5">
                                  <div className="flex flex-col items-start gap-1">
                                    {row.department ? (
                                      <span className="inline-flex items-center rounded border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-[11px] font-medium text-blue-700 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-400">
                                        {row.department}
                                      </span>
                                    ) : (
                                      <span className="text-[11px] text-zinc-400 dark:text-zinc-600">—</span>
                                    )}
                                    {row.hslRole && (
                                      <span
                                        title="Role within HSL — synced from the HOGAN SMITH AGENT PAY PLAN sheet"
                                        className="inline-flex items-center rounded border border-indigo-200 bg-indigo-50 px-1.5 py-0.5 text-[10.5px] font-medium text-indigo-700 dark:border-indigo-500/30 dark:bg-indigo-500/10 dark:text-indigo-300"
                                      >
                                        {row.hslRole}
                                      </span>
                                    )}
                                  </div>
                                </td>
                                <td className="px-3 py-2.5 text-center">
                                  {row.mesaMember ? (
                                    <span
                                      title="MESA Program member — ₱100 deducted per paycheck"
                                      className="inline-flex items-center rounded border border-teal-200 bg-teal-50 px-1.5 py-0.5 text-[10.5px] font-semibold text-teal-700 dark:border-teal-500/30 dark:bg-teal-500/10 dark:text-teal-300"
                                    >
                                      MESA
                                    </span>
                                  ) : (
                                    <span
                                      title="Not enrolled in MESA Program"
                                      className="inline-flex items-center rounded border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 text-[10.5px] font-medium text-zinc-400 dark:border-zinc-700/60 dark:bg-zinc-800/40 dark:text-zinc-500"
                                    >
                                      No MESA
                                    </span>
                                  )}
                                </td>
                                <td className="px-3 py-2.5">
                                  <span className="block max-w-[220px] truncate text-[11.5px] text-zinc-600 dark:text-zinc-400">
                                    {row.workEmail}
                                  </span>
                                </td>
                                <td className="px-3 py-2.5 text-right">
                                  <span className={cn(
                                    "text-[12.5px] font-semibold tabular-nums",
                                    row.regularRate === "—" ? "text-zinc-400 dark:text-zinc-600" : "text-zinc-800 dark:text-zinc-200",
                                  )}>
                                    {row.regularRate}
                                  </span>
                                </td>
                                <td className="px-3 py-2.5 text-right">
                                  <span className={cn(
                                    "text-[12.5px] font-semibold tabular-nums",
                                    row.otRate === "—" ? "text-zinc-400 dark:text-zinc-600" : "text-zinc-800 dark:text-zinc-200",
                                  )}>
                                    {row.otRate}
                                  </span>
                                </td>
                                <td className="px-3 py-2.5 text-center">
                                  {row.suspended ? (
                                    <span className="inline-flex items-center gap-0.5 rounded border border-amber-300 bg-amber-100 px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wide text-amber-700 dark:border-amber-700/60 dark:bg-amber-950/50 dark:text-amber-400">
                                      <UserX className="h-2.5 w-2.5" />
                                      Suspended
                                    </span>
                                  ) : isComplete ? (
                                    <span className="inline-flex items-center rounded border border-emerald-300 bg-emerald-50 px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wide text-emerald-700 dark:border-emerald-700/60 dark:bg-emerald-950/40 dark:text-emerald-400">
                                      Complete
                                    </span>
                                  ) : isMasterOnly ? (
                                    <span title="No row in employee_hourly_rates" className="inline-flex items-center rounded border border-rose-300 bg-rose-100 px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wide text-rose-700 dark:border-rose-700/60 dark:bg-rose-950/50 dark:text-rose-400">
                                      Master only
                                    </span>
                                  ) : (
                                    <span title="Rates row exists but blank" className="inline-flex items-center rounded border border-yellow-300 bg-yellow-100 px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wide text-yellow-800 dark:border-yellow-700/60 dark:bg-yellow-950/50 dark:text-yellow-300">
                                      Rates blank
                                    </span>
                                  )}
                                </td>
                                <td className="px-3 py-2.5 text-right">
                                  <div className="flex items-center justify-end gap-1">
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="sm"
                                      className="h-7 w-7 p-0 text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                                      onClick={() => openProfile(p)}
                                      title={`View ${p.displayName}`}
                                    >
                                      <Eye className="size-3.5" />
                                    </Button>
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="sm"
                                      disabled={isSuspending === p.id}
                                      onClick={() => handleToggleSuspend(p, !row.suspended)}
                                      title={row.suspended ? `Unsuspend ${p.displayName}` : `Suspend ${p.displayName}`}
                                      className={cn(
                                        "h-7 w-7 p-0",
                                        row.suspended
                                          ? "text-emerald-600 hover:bg-emerald-50 hover:text-emerald-700 dark:text-emerald-400 dark:hover:bg-emerald-950/40"
                                          : "text-amber-500 hover:bg-amber-50 hover:text-amber-600 dark:text-amber-400 dark:hover:bg-amber-950/40",
                                      )}
                                    >
                                      {isSuspending === p.id ? (
                                        <Loader2 className="size-3.5 animate-spin" />
                                      ) : row.suspended ? (
                                        <UserCheck className="size-3.5" />
                                      ) : (
                                        <UserX className="size-3.5" />
                                      )}
                                    </Button>
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="sm"
                                      disabled={isMesaToggling === p.id}
                                      onClick={() => handleToggleMesa(p, !row.mesaMember)}
                                      title={row.mesaMember ? `Remove ${p.displayName} from MESA Program` : `Enroll ${p.displayName} in MESA Program (₱100/paycheck deduction)`}
                                      className={cn(
                                        "h-7 w-7 p-0",
                                        row.mesaMember
                                          ? "text-teal-600 hover:bg-teal-50 hover:text-teal-700 dark:text-teal-400 dark:hover:bg-teal-950/40"
                                          : "text-teal-600 hover:bg-teal-50 hover:text-teal-700 dark:text-teal-400 dark:hover:bg-teal-950/40",
                                      )}
                                    >
                                      {isMesaToggling === p.id ? (
                                        <Loader2 className="size-3.5 animate-spin" />
                                      ) : (
                                        <span className="text-[9px] font-black leading-none tracking-tight">M</span>
                                      )}
                                    </Button>
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="sm"
                                      className="h-7 w-7 p-0 text-red-500 hover:bg-red-50 hover:text-red-600 dark:text-red-400 dark:hover:bg-red-950/40"
                                      onClick={() => setDeleteTarget(p)}
                                      title={`Delete ${p.displayName}`}
                                    >
                                      <Trash2 className="size-3.5" />
                                    </Button>
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {/* CARD VIEW — always shown on mobile; shown on md+ when viewMode === 'cards' */}
                <div className={cn(
                  "grid gap-3 sm:grid-cols-2 xl:grid-cols-3",
                  viewMode === "table" ? "md:hidden" : "",
                )}>
                  {pageRows.map((p) => {
                    const row = tableRowFromSummary(p);
                    const av = getAvatarInfoFromSummary(p);
                    const isMasterOnly = !row.hasRatesRow;
                    const ratesBlank = !isMasterOnly && (row.regularRate === "—" || row.otRate === "—");
                    const isComplete = !isMasterOnly && !ratesBlank;
                    return (
                      <div
                        key={p.id}
                        className={cn(
                          "flex flex-col gap-3 rounded-xl border p-4 transition-shadow hover:shadow-md",
                          row.suspended
                            ? "border-amber-200/80 bg-amber-50/40 opacity-70 dark:border-amber-900/40 dark:bg-amber-950/10"
                            : "border-zinc-200/90 bg-white/80 hover:shadow-zinc-200/60 dark:border-zinc-800 dark:bg-zinc-900/40 dark:hover:shadow-black/20",
                        )}
                      >
                        {/* Avatar + name + status badge */}
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex min-w-0 items-center gap-2.5">
                            <EmployeeAvatar
                              photoUrl={av.photoUrl}
                              googlePhotoUrl={av.googlePhotoUrl}
                              email={av.email}
                              initials={av.initials}
                              className="h-9 w-9 shrink-0 text-[11px]"
                              pixelSize={72}
                            />
                            <div className="min-w-0">
                              <p className="truncate text-sm font-semibold leading-snug text-zinc-900 dark:text-zinc-100">
                                {row.name}
                              </p>
                              {row.suspended && (
                                <span className="mt-0.5 inline-flex items-center gap-0.5 rounded border border-amber-300 bg-amber-100 px-1 py-0 text-[9px] font-bold uppercase tracking-wide text-amber-700 dark:border-amber-700/60 dark:bg-amber-950/50 dark:text-amber-400">
                                  <UserX className="h-2.5 w-2.5" />
                                  Suspended
                                </span>
                              )}
                            </div>
                          </div>
                          {isComplete ? (
                            <span className="shrink-0 inline-flex items-center rounded border border-emerald-300 bg-emerald-50 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-emerald-700 dark:border-emerald-700/60 dark:bg-emerald-950/40 dark:text-emerald-400">
                              Complete
                            </span>
                          ) : isMasterOnly ? (
                            <span title="No row in employee_hourly_rates — profile built from global_master_list only." className="shrink-0 inline-flex items-center rounded border border-rose-300 bg-rose-100 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-rose-700 dark:border-rose-700/60 dark:bg-rose-950/50 dark:text-rose-400">
                              Master only
                            </span>
                          ) : (
                            <span title="Rates row exists but Regular Rate and/or OT Rate are blank." className="shrink-0 inline-flex items-center rounded border border-yellow-300 bg-yellow-100 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-yellow-800 dark:border-yellow-700/60 dark:bg-yellow-950/50 dark:text-yellow-300">
                              Rates blank
                            </span>
                          )}
                        </div>

                        {/* Chips: employee ID + department + HSL role + org */}
                        <div className="flex flex-wrap gap-1.5">
                          {row.employeeId && (
                            <span className="inline-flex items-center rounded-md border border-orange-200 bg-orange-50 px-2 py-0.5 text-xs font-semibold text-orange-700 dark:border-orange-500/30 dark:bg-orange-500/10 dark:text-orange-400">
                              {row.employeeId}
                            </span>
                          )}
                          {row.department && (
                            <span className="inline-flex items-center rounded-md border border-blue-200 bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-400">
                              {row.department}
                            </span>
                          )}
                          {row.hslRole && (
                            <span
                              title="Role within HSL — synced from the HOGAN SMITH AGENT PAY PLAN sheet"
                              className="inline-flex items-center rounded-md border border-indigo-200 bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700 dark:border-indigo-500/30 dark:bg-indigo-500/10 dark:text-indigo-300"
                            >
                              {row.hslRole}
                            </span>
                          )}
                          {row.mesaMember ? (
                            <span
                              title="MESA Program member — ₱100 deducted per paycheck"
                              className="inline-flex items-center gap-1 rounded-md border border-teal-200 bg-teal-50 px-2 py-0.5 text-xs font-semibold text-teal-700 dark:border-teal-500/30 dark:bg-teal-500/10 dark:text-teal-300"
                            >
                              MESA
                            </span>
                          ) : (
                            <span
                              title="Not enrolled in MESA Program"
                              className="inline-flex items-center gap-1 rounded-md border border-zinc-200 bg-zinc-50 px-2 py-0.5 text-xs font-medium text-zinc-400 dark:border-zinc-700/60 dark:bg-zinc-800/40 dark:text-zinc-500"
                            >
                              No MESA
                            </span>
                          )}
                          {row.organization && row.organization !== "—" && (
                            <span className="inline-flex items-center rounded-md border border-violet-200 bg-violet-50 px-2 py-0.5 text-xs font-medium text-violet-700 dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-400">
                              {row.organization}
                            </span>
                          )}
                        </div>

                        {/* Work email */}
                        <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">
                          {row.workEmail}
                        </p>

                        {/* Rate tiles */}
                        <div className="grid grid-cols-2 gap-2">
                          <div className="flex flex-col gap-0.5 rounded-lg border border-zinc-200/80 bg-zinc-50/70 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900/50">
                            <span className="text-[9px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">Regular</span>
                            <span className="text-sm font-semibold tabular-nums text-zinc-800 dark:text-zinc-200">{row.regularRate}</span>
                          </div>
                          <div className="flex flex-col gap-0.5 rounded-lg border border-zinc-200/80 bg-zinc-50/70 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900/50">
                            <span className="text-[9px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">OT</span>
                            <span className="text-sm font-semibold tabular-nums text-zinc-800 dark:text-zinc-200">{row.otRate}</span>
                          </div>
                        </div>

                        {/* Actions */}
                        <div className="flex items-center gap-1.5 border-t border-zinc-100 pt-3 dark:border-zinc-800">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-8 flex-1 gap-1.5 border-zinc-200 text-zinc-800 dark:border-zinc-700 dark:text-zinc-200"
                            onClick={() => openProfile(p)}
                          >
                            <Eye className="size-3.5" />
                            View
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={isSuspending === p.id}
                            onClick={() => handleToggleSuspend(p, !row.suspended)}
                            title={row.suspended ? `Unsuspend ${p.displayName}` : `Suspend ${p.displayName}`}
                            className={cn(
                              "h-8 w-8 p-0",
                              row.suspended
                                ? "border-emerald-200 text-emerald-600 hover:border-emerald-300 hover:bg-emerald-50 dark:border-emerald-800/60 dark:text-emerald-400 dark:hover:bg-emerald-950/40"
                                : "border-amber-200 text-amber-500 hover:border-amber-300 hover:bg-amber-50 dark:border-amber-800/60 dark:text-amber-400 dark:hover:bg-amber-950/40",
                            )}
                          >
                            {isSuspending === p.id ? (
                              <Loader2 className="size-3.5 animate-spin" />
                            ) : row.suspended ? (
                              <UserCheck className="size-3.5" />
                            ) : (
                              <UserX className="size-3.5" />
                            )}
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={isMesaToggling === p.id}
                            onClick={() => handleToggleMesa(p, !row.mesaMember)}
                            title={row.mesaMember ? `Remove ${p.displayName} from MESA Program` : `Enroll ${p.displayName} in MESA Program (₱100/paycheck deduction)`}
                            className={cn(
                              "h-8 w-8 p-0 text-xs font-bold",
                              row.mesaMember
                                ? "border-teal-200 text-teal-600 hover:border-teal-300 hover:bg-teal-50 dark:border-teal-800/60 dark:text-teal-400 dark:hover:bg-teal-950/40"
                                : "border-teal-300 text-teal-600 hover:border-teal-400 hover:bg-teal-50 dark:border-teal-700/60 dark:text-teal-400 dark:hover:bg-teal-950/40",
                            )}
                          >
                            {isMesaToggling === p.id ? (
                              <Loader2 className="size-3.5 animate-spin" />
                            ) : (
                              <span className="text-[9px] font-black leading-none tracking-tight">M</span>
                            )}
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-8 w-8 border-zinc-200 p-0 text-red-500 hover:border-red-300 hover:bg-red-50 hover:text-red-600 dark:border-zinc-700 dark:text-red-400 dark:hover:border-red-800 dark:hover:bg-red-950/40"
                            onClick={() => setDeleteTarget(p)}
                            title={`Delete ${p.displayName}`}
                          >
                            <Trash2 className="size-3.5" />
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
      </section>

      {/* Delete Confirmation Dialog */}
      <Dialog
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
      >
        <DialogContent
          showCloseButton
          className={cn(
            "w-[min(92vw,420px)] max-w-[min(92vw,420px)] rounded-2xl border-red-100/60 bg-gradient-to-br from-white via-red-50/20 to-orange-50/30 p-0",
            "shadow-[0_25px_50px_-12px_rgba(0,0,0,0.18)] dark:border-red-950/40 dark:from-[#0d1117] dark:via-[#150a0a] dark:to-[#0d1117] dark:shadow-black/50",
            "sm:max-w-[min(92vw,420px)]",
            "duration-[320ms] ease-[cubic-bezier(0.22,1,0.36,1)]",
            "data-open:animate-in data-open:fade-in-0 data-open:zoom-in-[0.93] data-open:slide-in-from-bottom-8",
            "data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-[0.97] data-closed:slide-out-to-bottom-4 data-closed:duration-[180ms] data-closed:ease-in",
          )}
        >
          <DialogHeader className="border-b border-red-100/60 bg-gradient-to-r from-red-50/70 to-orange-50/50 px-6 py-5 dark:border-red-950/40 dark:from-red-950/30 dark:to-[#0d1117]">
            <div className="flex items-center gap-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-red-100 dark:bg-red-950/60">
                <Trash2 className="size-4 text-red-600 dark:text-red-400" />
              </div>
              <div>
                <DialogTitle className="text-base font-semibold text-zinc-900 dark:text-white">
                  Delete employee
                </DialogTitle>
                <DialogDescription className="mt-0.5 text-sm text-zinc-500 dark:text-zinc-400">
                  This cannot be undone.
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>
          <div className="px-6 py-5">
            <p className="text-sm text-zinc-700 dark:text-zinc-300">
              Are you sure you want to delete{" "}
              <span className="font-semibold text-zinc-900 dark:text-white">
                {deleteTarget?.displayName}
              </span>
              ? Their record will be removed from{" "}
              <span className="text-xs">employee_hourly_rates</span> and{" "}
              <span className="text-xs">global_master_list</span>.
            </p>
          </div>
          <DialogFooter className="border-t border-red-100/60 bg-gradient-to-r from-red-50/50 to-orange-50/30 px-6 py-4 dark:border-red-950/40 dark:from-red-950/20 dark:to-[#0d1117]">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setDeleteTarget(null)}
              disabled={isDeleting}
              className="text-zinc-600 hover:bg-red-50 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-red-950/30 dark:hover:text-white"
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={handleDeleteEmployee}
              disabled={isDeleting}
              className="gap-1.5 bg-red-600 text-white hover:bg-red-700 dark:bg-red-700 dark:hover:bg-red-600"
            >
              {isDeleting ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" />
                  Deleting…
                </>
              ) : (
                <>
                  <Trash2 className="size-3.5" />
                  Delete
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/*
        Add Employee Modal — rebuilt 2026-04-25.
        Same state (`addForm`), same handlers (`handleAddEmployee`, `resetAddForm`),
        same `/api/add-employee` POST. Layout is now `flex h-full min-h-0 flex-col`
        with a single scrollable body sandwiched between a sticky header and
        sticky footer, so the submit button can never get clipped or pushed off
        the bottom regardless of viewport height.
      */}
      <Dialog
        open={addOpen}
        onOpenChange={(open) => {
          setAddOpen(open);
          if (!open) resetAddForm();
        }}
      >
        <DialogContent
          showCloseButton
          className={cn(
            "flex h-[min(92vh,720px)] w-[min(94vw,560px)] max-w-[min(94vw,560px)] flex-col overflow-hidden rounded-2xl border border-zinc-200/80 bg-white p-0 shadow-2xl",
            "dark:border-zinc-800 dark:bg-[#0d1117] dark:shadow-black/60",
            "sm:max-w-[min(94vw,560px)]",
            "duration-[280ms] ease-[cubic-bezier(0.22,1,0.36,1)]",
            "data-open:animate-in data-open:fade-in-0 data-open:zoom-in-[0.96] data-open:slide-in-from-bottom-4",
            "data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-[0.98] data-closed:slide-out-to-bottom-2 data-closed:duration-[160ms] data-closed:ease-in",
          )}
        >
          <form onSubmit={handleAddEmployee} className="flex min-h-0 flex-1 flex-col">
            {/* HEADER */}
            <DialogHeader className="shrink-0 space-y-0 border-b border-zinc-200/80 px-6 py-4 dark:border-zinc-800/80">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-orange-500/10 text-orange-600 ring-1 ring-orange-500/20 dark:bg-orange-500/15 dark:text-orange-400">
                  <UserPlus className="h-4.5 w-4.5" aria-hidden />
                </div>
                <div className="min-w-0">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-amber-700/80 dark:text-amber-500/70">
                    New Profile
                  </p>
                  <DialogTitle className="mt-0.5 text-lg font-semibold tracking-tight text-zinc-900 dark:text-white">
                    Add Employee
                  </DialogTitle>
                </div>
              </div>
              <DialogDescription className="mt-2 text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-500">
                Writes to{' '}
                <span className="text-zinc-700 dark:text-zinc-300">employee_hourly_rates</span>{' '}
                and{' '}
                <span className="text-zinc-700 dark:text-zinc-300">global_master_list</span>.
              </DialogDescription>
            </DialogHeader>

            {/* BODY — single scroll region, takes remaining height */}
            <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 py-5 [-webkit-overflow-scrolling:touch]">
              {/* Identity */}
              <fieldset className="space-y-3">
                <legend className="mb-1 flex w-full items-center gap-2 border-b border-zinc-200/70 pb-1.5 dark:border-zinc-800/70">
                  <IdCard className="h-3.5 w-3.5 text-zinc-400" aria-hidden />
                  <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500 dark:text-zinc-400">
                    Identity
                  </span>
                </legend>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="add-name" className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
                      Name <span className="text-red-500">*</span>
                    </Label>
                    <Input
                      id="add-name"
                      placeholder="Full name"
                      value={addForm.name}
                      onChange={(e) => setAddForm((f) => ({ ...f, name: e.target.value }))}
                      required
                      autoFocus
                      className="h-9 border-zinc-200 bg-white text-zinc-900 transition-colors placeholder:text-zinc-400 hover:border-zinc-300 focus:border-orange-500 focus:ring-2 focus:ring-orange-500/20 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:border-zinc-700 dark:focus:border-orange-400"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="add-department" className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
                      Department
                    </Label>
                    <DepartmentSelect
                      id="add-department"
                      value={addForm.department}
                      onChange={(v) => setAddForm((f) => ({ ...f, department: v }))}
                    />
                  </div>
                </div>
              </fieldset>

              {/* Contact */}
              <fieldset className="space-y-3">
                <legend className="mb-1 flex w-full items-center gap-2 border-b border-zinc-200/70 pb-1.5 dark:border-zinc-800/70">
                  <Mail className="h-3.5 w-3.5 text-zinc-400" aria-hidden />
                  <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500 dark:text-zinc-400">
                    Contact
                  </span>
                  <span className="ml-auto text-[10px] font-medium text-amber-700 dark:text-amber-400">
                    Need at least one
                  </span>
                </legend>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="add-work-email" className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
                      Work Email
                    </Label>
                    <div className="relative">
                      <Mail className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" aria-hidden />
                      <Input
                        id="add-work-email"
                        type="email"
                        placeholder="name@company.com"
                        value={addForm.workEmail}
                        onChange={(e) => setAddForm((f) => ({ ...f, workEmail: e.target.value }))}
                        className="h-9 border-zinc-200 bg-white pl-8 text-sm text-zinc-900 transition-colors placeholder:text-zinc-400 hover:border-zinc-300 focus:border-orange-500 focus:ring-2 focus:ring-orange-500/20 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:border-zinc-700 dark:focus:border-orange-400"
                      />
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="add-personal-email" className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
                      Personal Email
                    </Label>
                    <div className="relative">
                      <Mail className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" aria-hidden />
                      <Input
                        id="add-personal-email"
                        type="email"
                        placeholder="personal@email.com"
                        value={addForm.personalEmail}
                        onChange={(e) => setAddForm((f) => ({ ...f, personalEmail: e.target.value }))}
                        className="h-9 border-zinc-200 bg-white pl-8 text-sm text-zinc-900 transition-colors placeholder:text-zinc-400 hover:border-zinc-300 focus:border-orange-500 focus:ring-2 focus:ring-orange-500/20 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:border-zinc-700 dark:focus:border-orange-400"
                      />
                    </div>
                  </div>
                </div>
              </fieldset>

              {/* Employment */}
              <fieldset className="space-y-3">
                <legend className="mb-1 flex w-full items-center gap-2 border-b border-zinc-200/70 pb-1.5 dark:border-zinc-800/70">
                  <Briefcase className="h-3.5 w-3.5 text-zinc-400" aria-hidden />
                  <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500 dark:text-zinc-400">
                    Employment
                  </span>
                </legend>
                <div className="space-y-1.5">
                  <Label htmlFor="add-start-date" className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
                    Start Date
                  </Label>
                  <div className="relative">
                    <CalendarDays className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" aria-hidden />
                    <Input
                      id="add-start-date"
                      type="date"
                      value={addForm.startDate}
                      onChange={(e) => setAddForm((f) => ({ ...f, startDate: e.target.value }))}
                      max={new Date().toISOString().slice(0, 10)}
                      className="h-9 w-full border-zinc-200 bg-white pl-8 text-sm text-zinc-900 transition-colors hover:border-zinc-300 focus:border-orange-500 focus:ring-2 focus:ring-orange-500/20 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:border-zinc-700 dark:focus:border-orange-400"
                    />
                  </div>
                </div>
              </fieldset>

              {/* Compensation */}
              <fieldset className="space-y-3">
                <legend className="mb-1 flex w-full items-center gap-2 border-b border-zinc-200/70 pb-1.5 dark:border-zinc-800/70">
                  <DollarSign className="h-3.5 w-3.5 text-zinc-400" aria-hidden />
                  <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500 dark:text-zinc-400">
                    Compensation
                  </span>
                  <span className="ml-auto text-[10px] tabular-nums text-blue-700 dark:text-blue-400">
                    ₱{usdToPhpRate.toFixed(5)} / $1
                  </span>
                </legend>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="add-regular-rate" className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
                      Regular Rate
                    </Label>
                    <div className="relative">
                      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm font-medium text-orange-500" aria-hidden>
                        ₱
                      </span>
                      <Input
                        id="add-regular-rate"
                        placeholder="0.00"
                        inputMode="decimal"
                        value={addForm.regularRate}
                        onChange={(e) => setAddForm((f) => ({ ...f, regularRate: e.target.value }))}
                        className="h-9 border-zinc-200 bg-white pl-7 tabular-nums text-sm text-zinc-900 transition-colors placeholder:text-zinc-400 hover:border-zinc-300 focus:border-orange-500 focus:ring-2 focus:ring-orange-500/20 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:border-zinc-700 dark:focus:border-orange-400"
                      />
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="add-ot-rate" className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
                      OT Rate
                    </Label>
                    <div className="relative">
                      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm font-medium text-orange-500" aria-hidden>
                        ₱
                      </span>
                      <Input
                        id="add-ot-rate"
                        placeholder="0.00"
                        inputMode="decimal"
                        value={addForm.otRate}
                        onChange={(e) => setAddForm((f) => ({ ...f, otRate: e.target.value }))}
                        className="h-9 border-zinc-200 bg-white pl-7 tabular-nums text-sm text-zinc-900 transition-colors placeholder:text-zinc-400 hover:border-zinc-300 focus:border-orange-500 focus:ring-2 focus:ring-orange-500/20 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:border-zinc-700 dark:focus:border-orange-400"
                      />
                    </div>
                  </div>
                </div>
              </fieldset>
            </div>

            {/* FOOTER — sticky at the bottom of the dialog */}
            <DialogFooter className="shrink-0 gap-2 border-t border-zinc-200/80 bg-zinc-50/60 px-6 py-3 dark:border-zinc-800/80 dark:bg-zinc-950/60">
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setAddOpen(false);
                  resetAddForm();
                }}
                disabled={isAdding}
                className="h-9 text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-white"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={isAdding}
                className="h-9 gap-1.5 bg-gradient-to-r from-orange-500 to-orange-600 text-white shadow-sm shadow-orange-500/25 transition-all hover:from-orange-600 hover:to-orange-700 hover:shadow-md hover:shadow-orange-500/30 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isAdding ? (
                  <>
                    <Loader2 className="size-3.5 animate-spin" />
                    Adding…
                  </>
                ) : (
                  <>
                    <UserPlus className="size-3.5" />
                    Add Employee
                  </>
                )}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Profile View Modal */}
      <Dialog
        open={profileOpen}
        onOpenChange={(open) => {
          setProfileOpen(open);
          if (!open) {
            setActiveProfile(null);
            setActiveProfileSummary(null);
            setIsEditingProfile(false);
            setProfileLoading(false);
            setProfileError(null);
          }
        }}
      >
        <DialogContent
          showCloseButton
          className={cn(
            "w-[min(92vw,1100px)] max-w-[min(92vw,1100px)] max-h-[min(92vh,960px)] overflow-hidden rounded-2xl border-zinc-200/80 bg-white p-0",
            "shadow-[0_25px_50px_-12px_rgba(0,0,0,0.18)] dark:border-zinc-800 dark:bg-[#0d1117] dark:shadow-black/50",
            "sm:max-w-[min(92vw,1100px)]",
            "duration-[380ms] ease-[cubic-bezier(0.22,1,0.36,1)]",
            "data-open:animate-in data-open:fade-in-0 data-open:zoom-in-[0.96] data-open:slide-in-from-bottom-6",
            "data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-[0.98] data-closed:slide-out-to-bottom-3 data-closed:duration-[200ms] data-closed:ease-in",
          )}
        >
          {activeProfile ? (
            <motion.div
              key={activeProfile.id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, ease: dialogEase }}
              className="flex flex-col"
            >
              {/* Editorial header — slim, no gradient */}
              <DialogHeader className="shrink-0 space-y-0 border-b border-zinc-200/80 px-6 py-4 dark:border-zinc-800/80">
                {(() => {
                  const av = getAvatarInfoFromProfile(activeProfile);
                  const empId = activeProfileSummary?.employeeId ?? null;
                  return (
                    <div className="flex items-start gap-4">
                      {(() => {
                        const enlargeUrl =
                          (av.photoUrl?.trim() || av.googlePhotoUrl?.trim() || '').trim() || null;
                        const sharedAvatar = (
                          <EmployeeAvatar
                            photoUrl={av.photoUrl}
                            googlePhotoUrl={av.googlePhotoUrl}
                            email={av.email}
                            initials={av.initials}
                            className="h-12 w-12 text-base"
                            pixelSize={96}
                          />
                        );
                        return enlargeUrl ? (
                          <button
                            type="button"
                            onClick={() => setAvatarViewerUrl(enlargeUrl)}
                            aria-label={`View ${activeProfile.displayName}'s profile photo`}
                            className="group relative shrink-0 rounded-full ring-2 ring-zinc-100 transition hover:ring-orange-300 focus-visible:outline-none focus-visible:ring-orange-400 dark:ring-zinc-800 dark:hover:ring-orange-500/60"
                          >
                            {sharedAvatar}
                            <span className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-full bg-black/0 opacity-0 transition group-hover:bg-black/30 group-hover:opacity-100">
                              <Eye className="h-4 w-4 text-white drop-shadow" />
                            </span>
                          </button>
                        ) : (
                          <div className="shrink-0 rounded-full ring-2 ring-zinc-100 dark:ring-zinc-800">
                            {sharedAvatar}
                          </div>
                        );
                      })()}
                      <div className="min-w-0 flex-1">
                        <p className="text-[10px] font-medium uppercase tracking-[0.18em] text-amber-700/80 dark:text-amber-500/70">
                          Profile
                          {empId ? (
                            <>
                              <span className="mx-1.5 text-zinc-300 dark:text-zinc-700">/</span>
                              <span className="text-zinc-600 dark:text-zinc-400">{empId}</span>
                            </>
                          ) : null}
                        </p>
                        <DialogTitle className="mt-0.5 truncate text-xl font-semibold tracking-tight text-zinc-900 sm:text-2xl dark:text-white">
                          {activeProfile.displayName}
                        </DialogTitle>
                        {(activeProfile.department || activeProfile.organization) ? (
                          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-zinc-500 dark:text-zinc-500">
                            {activeProfile.department ? (
                              <span className="inline-flex items-center rounded-md border border-zinc-200 bg-zinc-50 px-2 py-0.5 font-medium text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
                                {activeProfile.department}
                              </span>
                            ) : null}
                            {activeProfile.organization ? (
                              <span className="inline-flex items-center rounded-md border border-zinc-200 bg-zinc-50 px-2 py-0.5 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
                                {activeProfile.organization}
                              </span>
                            ) : null}
                            {activeProfile.subtitle ? (
                              <span className="text-zinc-400 dark:text-zinc-600">
                                · {activeProfile.subtitle}
                              </span>
                            ) : null}
                          </div>
                        ) : (
                          <DialogDescription className="sr-only">
                            Complete merged fields for this employee.
                          </DialogDescription>
                        )}
                      </div>
                    </div>
                  );
                })()}
              </DialogHeader>

              {/* Suspended banner — left-border accent, no gradient fill */}
              {isSuspendedFromProfile(activeProfile) && (
                <div className="shrink-0 flex items-center gap-2 border-b border-amber-200/70 border-l-2 border-l-amber-500 bg-amber-50/60 px-6 py-2 dark:border-amber-900/50 dark:border-l-amber-500 dark:bg-amber-950/20">
                  <UserX className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
                  <span className="text-xs font-medium text-amber-800 dark:text-amber-300">
                    Account suspended — excluded from payroll runs.
                  </span>
                </div>
              )}

              {/* Rate panel + actions — flat layout, no gradient */}
              <div className="shrink-0 border-b border-zinc-200/80 px-6 py-4 dark:border-zinc-800/80">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                  {/* Rates */}
                  <div className="flex items-stretch gap-6">
                    <div className="flex flex-col gap-1">
                      <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-zinc-500 dark:text-zinc-500">
                        Regular Rate
                      </p>
                      {isEditing ? (
                        <div className="relative">
                          <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-sm font-medium text-orange-500">
                            ₱
                          </span>
                          <Input
                            value={editRegularRate}
                            onChange={(e) => setEditRegularRate(e.target.value)}
                            className="h-9 w-32 border-zinc-200 bg-white pl-7 tabular-nums text-base font-semibold text-zinc-900 transition-colors hover:border-zinc-300 focus:border-orange-500 focus:ring-2 focus:ring-orange-500/20 dark:border-zinc-800 dark:bg-zinc-900 dark:text-white"
                          />
                        </div>
                      ) : (
                        <p className="text-xl font-bold tabular-nums leading-none text-zinc-900 dark:text-white">
                          {formatRateDisplay(editRegularRate)}
                        </p>
                      )}
                    </div>
                    <div className="w-px self-stretch bg-zinc-200 dark:bg-zinc-800" />
                    <div className="flex flex-col gap-1">
                      <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-zinc-500 dark:text-zinc-500">
                        OT Rate
                      </p>
                      {isEditing ? (
                        <div className="relative">
                          <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-sm font-medium text-orange-500">
                            ₱
                          </span>
                          <Input
                            value={editOtRate}
                            onChange={(e) => setEditOtRate(e.target.value)}
                            className="h-9 w-32 border-zinc-200 bg-white pl-7 tabular-nums text-base font-semibold text-zinc-900 transition-colors hover:border-zinc-300 focus:border-orange-500 focus:ring-2 focus:ring-orange-500/20 dark:border-zinc-800 dark:bg-zinc-900 dark:text-white"
                          />
                        </div>
                      ) : (
                        <p className="text-xl font-bold tabular-nums leading-none text-zinc-900 dark:text-white">
                          {formatRateDisplay(editOtRate)}
                        </p>
                      )}
                    </div>
                    {isEditing && (
                      <>
                        <div className="w-px self-stretch bg-zinc-200 dark:bg-zinc-800" />
                        <div className="flex flex-col gap-1">
                          <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-emerald-600 dark:text-emerald-400">
                            Effective From
                          </p>
                          <Input
                            type="date"
                            value={editEffectiveDate}
                            onChange={(e) => setEditEffectiveDate(e.target.value)}
                            className="h-9 w-40 border-zinc-200 bg-white tabular-nums text-sm font-medium text-zinc-900 transition-colors hover:border-zinc-300 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20 dark:border-zinc-800 dark:bg-zinc-900 dark:text-white"
                          />
                        </div>
                      </>
                    )}
                    <div className="w-px self-stretch bg-zinc-200 dark:bg-zinc-800" />
                    <div className="flex flex-col gap-1">
                      <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-blue-600 dark:text-blue-400">
                        USD → PHP
                      </p>
                      <p className="text-sm font-medium tabular-nums leading-none text-blue-900 dark:text-blue-300">
                        ₱{usdToPhpRate.toFixed(5)}
                      </p>
                    </div>
                  </div>

                  {/* Action buttons */}
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    {isEditing ? (
                      <>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-8 gap-1.5 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-white"
                          onClick={() => {
                            setIsEditing(false);
                            const m = buildNormFieldMap(activeProfile.fields);
                            setEditRegularRate(normalizeRateForEdit(pickRawFromMap(m, ["Regular Rate", "regular_rate", "Regular_Rate"])));
                            setEditOtRate(normalizeRateForEdit(pickRawFromMap(m, ["OT Rate", "ot_rate", "OT_Rate", "Ot Rate"])));
                          }}
                          disabled={isSaving}
                        >
                          <X className="size-3.5" />
                          Cancel
                        </Button>
                        <Button
                          size="sm"
                          className="h-8 gap-1.5 bg-gradient-to-r from-orange-500 to-orange-600 px-3 text-white shadow-sm shadow-orange-500/20 transition-all hover:from-orange-600 hover:to-orange-700 hover:shadow-md active:scale-[0.98]"
                          onClick={handleSaveRates}
                          disabled={isSaving}
                        >
                          {isSaving ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <Check className="size-3.5" />
                          )}
                          Save Rates
                        </Button>
                      </>
                    ) : (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 gap-1.5 border-zinc-200 text-zinc-700 hover:border-zinc-300 hover:bg-zinc-50 dark:border-zinc-800 dark:text-zinc-300 dark:hover:border-zinc-700 dark:hover:bg-zinc-900"
                          onClick={openEditProfile}
                          disabled={isEditingProfile || profileLoading}
                        >
                          <UserCog className="size-3.5" />
                          Edit Profile
                        </Button>
                        {activeProfileSummary?.hslRole ? (
                          <div
                            className="flex h-8 items-center gap-1.5 rounded-md border border-violet-200 bg-violet-50/70 px-2.5 text-[11px] font-medium text-violet-700 dark:border-violet-900/50 dark:bg-violet-950/30 dark:text-violet-300"
                            title="HSL agents' rates come from the HOGAN pay plan sheet. Use the HSL Sync button to refresh them."
                          >
                            <Lock className="size-3" />
                            Managed by HOGAN pay plan sync
                          </div>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-8 gap-1.5 border-orange-200 text-orange-700 hover:border-orange-300 hover:bg-orange-50 dark:border-orange-900/50 dark:text-orange-400 dark:hover:bg-orange-950/30"
                            onClick={() => {
                              // Default effective date = next Monday so the
                              // current pay week stays on the OLD rate. The
                              // accountant can move it earlier (today, mid-cycle)
                              // to trigger prorating, or later to schedule ahead.
                              const d = new Date();
                              const dow = d.getDay(); // 0=Sun..6=Sat
                              const daysToMon = ((1 - dow + 7) % 7) || 7;
                              d.setDate(d.getDate() + daysToMon);
                              const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
                              setEditEffectiveDate(iso);
                              setIsEditing(true);
                            }}
                            disabled={profileLoading}
                          >
                            <Edit2 className="size-3.5" />
                            Edit Rates
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={isSuspending === activeProfile.id}
                          onClick={() => handleToggleSuspend(activeProfile, !isSuspendedFromProfile(activeProfile))}
                          className={cn(
                            "h-8 gap-1.5",
                            isSuspendedFromProfile(activeProfile)
                              ? "border-emerald-200 text-emerald-700 hover:border-emerald-300 hover:bg-emerald-50 dark:border-emerald-900/50 dark:text-emerald-400 dark:hover:bg-emerald-950/30"
                              : "border-amber-200 text-amber-700 hover:border-amber-300 hover:bg-amber-50 dark:border-amber-900/50 dark:text-amber-400 dark:hover:bg-amber-950/30",
                          )}
                        >
                          {isSuspending === activeProfile.id ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : isSuspendedFromProfile(activeProfile) ? (
                            <>
                              <UserCheck className="size-3.5" />
                              Unsuspend
                            </>
                          ) : (
                            <>
                              <UserX className="size-3.5" />
                              Suspend
                            </>
                          )}
                        </Button>
                        {activeProfileSummary && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={isMesaToggling === activeProfile.id}
                            onClick={() => handleToggleMesa(activeProfileSummary, !activeProfileSummary.mesaMember)}
                            title={activeProfileSummary.mesaMember ? 'Remove from MESA Program' : 'Enroll in MESA Program (₱100/paycheck deduction)'}
                            className={cn(
                              "h-8 gap-1.5",
                              activeProfileSummary.mesaMember
                                ? "border-teal-200 text-teal-700 hover:border-teal-300 hover:bg-teal-50 dark:border-teal-900/50 dark:text-teal-400 dark:hover:bg-teal-950/30"
                                : "border-zinc-200 text-zinc-500 hover:border-teal-200 hover:bg-teal-50 hover:text-teal-700 dark:border-zinc-700 dark:text-zinc-400 dark:hover:border-teal-900/50 dark:hover:bg-teal-950/30 dark:hover:text-teal-400",
                            )}
                          >
                            {isMesaToggling === activeProfile.id ? (
                              <Loader2 className="size-3.5 animate-spin" />
                            ) : (
                              <span className="text-[10px] font-black leading-none">
                                {activeProfileSummary.mesaMember ? '✕ MESA' : '+ MESA'}
                              </span>
                            )}
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 gap-1.5 border-red-200 text-red-600 hover:border-red-300 hover:bg-red-50 dark:border-red-900/60 dark:text-red-400 dark:hover:bg-red-950/30"
                          onClick={() => {
                            if (activeProfileSummary) setDeleteTarget(activeProfileSummary);
                          }}
                        >
                          <Trash2 className="size-3.5" />
                          Delete
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              </div>
              {profileLoading ? (
                <div className="mx-6 mt-3 inline-flex items-center gap-2 rounded-md border border-blue-200 bg-blue-50 px-2.5 py-1 text-[11px] text-blue-700 dark:border-blue-900/50 dark:bg-blue-950/30 dark:text-blue-300">
                  <Loader2 className="size-3 animate-spin" />
                  Loading full profile details…
                </div>
              ) : null}
              {profileError ? (
                <div className="mx-6 mt-3 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300">
                  {profileError}
                </div>
              ) : null}
              <div className="overflow-y-auto overflow-x-hidden bg-zinc-50/40 px-6 [-webkit-overflow-scrolling:touch] dark:bg-[#0a0d12]" style={{ maxHeight: "min(58vh, 600px)" }}>
                {isEditingProfile ? (
                  <div className="py-5">
                    {/* Identity */}
                    <section className="space-y-3">
                      <div className="flex items-center gap-2 border-b border-zinc-200/70 pb-1.5 dark:border-zinc-800/70">
                        <IdCard className="h-3.5 w-3.5 text-zinc-400" aria-hidden />
                        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500 dark:text-zinc-400">
                          Identity
                        </p>
                      </div>
                      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                        <div className="space-y-1.5">
                          <Label className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
                            Name
                          </Label>
                          <Input
                            placeholder="Full name"
                            value={editProfileForm.name}
                            onChange={(e) => setEditProfileForm((f) => ({ ...f, name: e.target.value }))}
                            className="h-9 border-zinc-200 bg-white text-zinc-900 transition-colors placeholder:text-zinc-400 hover:border-zinc-300 focus:border-orange-500 focus:ring-2 focus:ring-orange-500/20 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:border-zinc-700 dark:focus:border-orange-400"
                          />
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
                            Department
                          </Label>
                          <DepartmentSelect
                            value={editProfileForm.department}
                            onChange={(v) => setEditProfileForm((f) => ({ ...f, department: v }))}
                          />
                        </div>
                      </div>
                    </section>

                    {/* Contact */}
                    <section className="mt-5 space-y-3">
                      <div className="flex items-center gap-2 border-b border-zinc-200/70 pb-1.5 dark:border-zinc-800/70">
                        <Mail className="h-3.5 w-3.5 text-zinc-400" aria-hidden />
                        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500 dark:text-zinc-400">
                          Contact
                        </p>
                      </div>
                      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                        <div className="space-y-1.5">
                          <Label className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
                            Work Email
                          </Label>
                          <div className="relative">
                            <Mail className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" aria-hidden />
                            <Input
                              type="email"
                              placeholder="name@company.com"
                              value={editProfileForm.workEmail}
                              onChange={(e) => setEditProfileForm((f) => ({ ...f, workEmail: e.target.value }))}
                              className="h-9 border-zinc-200 bg-white pl-8 text-sm text-zinc-900 transition-colors placeholder:text-zinc-400 hover:border-zinc-300 focus:border-orange-500 focus:ring-2 focus:ring-orange-500/20 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:border-zinc-700 dark:focus:border-orange-400"
                            />
                          </div>
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
                            Personal Email
                          </Label>
                          <div className="relative">
                            <Mail className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" aria-hidden />
                            <Input
                              type="email"
                              placeholder="personal@email.com"
                              value={editProfileForm.personalEmail}
                              onChange={(e) => setEditProfileForm((f) => ({ ...f, personalEmail: e.target.value }))}
                              className="h-9 border-zinc-200 bg-white pl-8 text-sm text-zinc-900 transition-colors placeholder:text-zinc-400 hover:border-zinc-300 focus:border-orange-500 focus:ring-2 focus:ring-orange-500/20 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:border-zinc-700 dark:focus:border-orange-400"
                            />
                          </div>
                        </div>
                      </div>
                    </section>

                    {/* Employment */}
                    <section className="mt-5 space-y-3">
                      <div className="flex items-center gap-2 border-b border-zinc-200/70 pb-1.5 dark:border-zinc-800/70">
                        <Briefcase className="h-3.5 w-3.5 text-zinc-400" aria-hidden />
                        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500 dark:text-zinc-400">
                          Employment
                        </p>
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
                          Start Date
                        </Label>
                        <div className="relative">
                          <CalendarDays className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" aria-hidden />
                          <Input
                            type="date"
                            value={editProfileForm.startDate}
                            onChange={(e) => setEditProfileForm((f) => ({ ...f, startDate: e.target.value }))}
                            className="h-9 w-full border-zinc-200 bg-white pl-8 text-sm text-zinc-900 transition-colors hover:border-zinc-300 focus:border-orange-500 focus:ring-2 focus:ring-orange-500/20 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:border-zinc-700 dark:focus:border-orange-400"
                          />
                        </div>
                      </div>
                    </section>

                    {/* Form actions */}
                    <div className="mt-6 flex justify-end gap-2 border-t border-zinc-200/80 pt-4 dark:border-zinc-800/80">
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() => setIsEditingProfile(false)}
                        disabled={isSavingProfile}
                        className="text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-white"
                      >
                        Cancel
                      </Button>
                      <Button
                        type="button"
                        onClick={handleSaveProfile}
                        disabled={isSavingProfile}
                        className="gap-1.5 bg-gradient-to-r from-orange-500 to-orange-600 text-white shadow-sm shadow-orange-500/25 transition-all hover:from-orange-600 hover:to-orange-700 hover:shadow-md active:scale-[0.98]"
                      >
                        {isSavingProfile ? (
                          <>
                            <Loader2 className="size-3.5 animate-spin" />
                            Saving…
                          </>
                        ) : (
                          <>
                            <Check className="size-3.5" />
                            Save Profile
                          </>
                        )}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="pb-6 pt-2">
                    <dl className="grid grid-cols-1 gap-x-10 gap-y-0 md:grid-cols-2">
                      {/* Employee ID — always first */}
                      {(() => {
                        const empId = activeProfileSummary?.employeeId ?? null;
                        if (!empId) return null;
                        return (
                          <motion.div
                            key={`${activeProfile.id}-employee-id`}
                            initial={{ opacity: 0, y: 6 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ duration: 0.2, ease: dialogEase, delay: 0 }}
                            className="border-b border-zinc-100 py-3.5 dark:border-zinc-800/90"
                          >
                            <dt className="text-[11px] font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                              Employee ID
                            </dt>
                            <dd className="mt-1.5">
                              <span className="inline-flex items-center rounded-md border border-orange-200 bg-orange-50 px-2.5 py-0.5 text-sm font-semibold text-orange-700 dark:border-orange-500/30 dark:bg-orange-500/10 dark:text-orange-400">
                                {empId}
                              </span>
                            </dd>
                          </motion.div>
                        );
                      })()}
                      {activeProfile.fields.filter(({ key }) => !isHiddenField(key)).map(({ key, value }, i) => (
                        <motion.div
                          key={`${activeProfile.id}-${key}`}
                          initial={{ opacity: 0, y: 6 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{
                            duration: 0.2,
                            ease: dialogEase,
                            delay: Math.min(i * 0.01, 0.28),
                          }}
                          className="border-b border-zinc-100 py-3.5 last:border-transparent dark:border-zinc-800/90"
                        >
                          <dt className="text-[11px] font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                            {key}
                          </dt>
                          <dd className="mt-1.5 max-w-full whitespace-pre-wrap break-words text-sm leading-relaxed text-zinc-900 dark:text-zinc-100">
                            {formatFieldValue(key, value)}
                          </dd>
                        </motion.div>
                      ))}
                    </dl>
                  </div>
                )}
              </div>
            </motion.div>
          ) : null}
        </DialogContent>
      </Dialog>

      {/* Avatar lightbox — click the header avatar to enlarge the photo. */}
      <Dialog open={!!avatarViewerUrl} onOpenChange={(o) => { if (!o) setAvatarViewerUrl(null); }}>
        <DialogContent
          showCloseButton={false}
          className="border-none bg-transparent p-0 shadow-none sm:max-w-[min(80vw,380px)]"
        >
          <DialogTitle className="sr-only">Profile photo</DialogTitle>
          <DialogDescription className="sr-only">
            Enlarged profile photo. Click outside or press Escape to close.
          </DialogDescription>
          <button
            type="button"
            onClick={() => setAvatarViewerUrl(null)}
            className="group relative block w-full overflow-hidden rounded-2xl bg-zinc-900/90 ring-1 ring-white/10 shadow-2xl shadow-black/50"
            aria-label="Close enlarged photo"
          >
            {avatarViewerUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={avatarViewerUrl}
                alt="Profile photo"
                className="h-auto w-full select-none object-contain"
                draggable={false}
                referrerPolicy="no-referrer"
              />
            )}
            <span className="pointer-events-none absolute right-3 top-3 inline-flex h-8 w-8 items-center justify-center rounded-full bg-black/55 text-white opacity-80 backdrop-blur transition group-hover:opacity-100">
              <X className="h-4 w-4" />
            </span>
          </button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
