"use client";

import React, { useEffect, useMemo, useState } from "react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  DollarSign,
  Edit2,
  Eye,
  Loader2,
  Plus,
  Search,
  Trash2,
  UserCog,
  X,
} from "lucide-react";
import { motion } from "motion/react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
import type { EmployeeIdRow } from "@/lib/supabase/employee-ids";

type EmployeeRateProfile = {
  id: string;
  displayName: string;
  subtitle: string | null;
  department: string | null;
  organization: string | null;
  fields: { key: string; value: unknown }[];
};

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
    regularRate: pickFromMap(m, ["Regular Rate", "regular_rate", "Regular_Rate"]),
    otRate: pickFromMap(m, ["OT Rate", "ot_rate", "OT_Rate", "Ot Rate"]),
  };
}

const dialogEase = [0.22, 1, 0.36, 1] as const;

const PAGE_SIZE = 12;

export default function Rates() {
  const [profiles, setProfiles] = useState<EmployeeRateProfile[]>([]);
  const [employeeIdMap, setEmployeeIdMap] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [page, setPage] = useState(1);
  const [profileOpen, setProfileOpen] = useState(false);
  const [activeProfile, setActiveProfile] = useState<EmployeeRateProfile | null>(null);
  const [mergeNotes, setMergeNotes] = useState<string[]>([]);

  // Rate editing state
  const [isEditing, setIsEditing] = useState(false);
  const [editRegularRate, setEditRegularRate] = useState("");
  const [editOtRate, setEditOtRate] = useState("");
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
          regularRate: addForm.regularRate.trim() || null,
          otRate: addForm.otRate.trim() || null,
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
  const [deleteTarget, setDeleteTarget] = useState<EmployeeRateProfile | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  function extractEmailsFromProfile(p: EmployeeRateProfile): { workEmail: string | null; personalEmail: string | null } {
    const m = buildNormFieldMap(p.fields);
    let workEmail = pickFromMap(m, ["Work Email", "work_email", "Work_Email"]);
    let personalEmail = pickFromMap(m, ["Personal Email", "personal_email", "Personal_Email"]);
    // Fallback: id is "e:<email>"
    if (workEmail === "—" && p.id.startsWith("e:")) workEmail = p.id.slice(2);
    // Fallback: subtitle
    if (workEmail === "—" && p.subtitle) {
      const parts = p.subtitle.split("·").map((s) => s.trim());
      if (parts[0]) workEmail = parts[0];
      if (parts[1]) personalEmail = parts[1];
    }
    return {
      workEmail: workEmail !== "—" ? workEmail : null,
      personalEmail: personalEmail !== "—" ? personalEmail : null,
    };
  }

  async function handleDeleteEmployee() {
    if (!deleteTarget) return;
    setIsDeleting(true);
    try {
      const { workEmail, personalEmail } = extractEmailsFromProfile(deleteTarget);
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
      await fetchProfiles();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete employee");
    } finally {
      setIsDeleting(false);
    }
  }

  const fetchProfiles = async () => {
    try {
      const [profilesRes, idsRes] = await Promise.all([
        fetch("/api/employee-rate-profiles", { cache: "no-store" }),
        fetch("/api/employee-ids", { cache: "no-store" }),
      ]);
      if (!profilesRes.ok) throw new Error(`HTTP ${profilesRes.status}`);

      const json = (await profilesRes.json()) as {
        profiles: EmployeeRateProfile[];
        error: string | null;
        mergeNotes?: string[];
      };
      setProfiles(json.profiles ?? []);
      setError(json.error ?? null);
      setMergeNotes(json.mergeNotes ?? []);

      if (idsRes.ok) {
        const idsJson = (await idsRes.json()) as { rows: EmployeeIdRow[] };
        const map = new Map<string, string>();
        for (const r of idsJson.rows ?? []) {
          const we = normEmail(r.work_email ?? "");
          const pe = normEmail(r.personal_email ?? "");
          if (we) map.set(we, r.employee_id);
          if (pe && !map.has(pe)) map.set(pe, r.employee_id);
        }
        setEmployeeIdMap(map);
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

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return profiles;
    return profiles.filter((p) => {
      const row = tableRowFromProfile(p, employeeIdMap);
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
        ...p.fields.flatMap((f) => [f.key, formatFieldValue(f.key, f.value)]),
      ]
        .join(" ")
        .toLowerCase();
      return blob.includes(q);
    });
  }, [profiles, searchQuery, employeeIdMap]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);

  useEffect(() => {
    setPage(1);
  }, [searchQuery]);

  useEffect(() => {
    setPage((p) => Math.min(p, totalPages));
  }, [totalPages]);

  const pageRows = useMemo(() => {
    const start = (safePage - 1) * PAGE_SIZE;
    return filtered.slice(start, start + PAGE_SIZE);
  }, [filtered, safePage]);

  function openProfile(p: EmployeeRateProfile) {
    setActiveProfile(p);
    setProfileOpen(true);
    setIsEditing(false);
    setIsEditingProfile(false);

    // Find current rates
    const m = buildNormFieldMap(p.fields);
    setEditRegularRate(pickFromMap(m, ["Regular Rate", "regular_rate", "Regular_Rate"]));
    setEditOtRate(pickFromMap(m, ["OT Rate", "ot_rate", "OT_Rate", "Ot Rate"]));
  }

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
          regularRate: editRegularRate,
          otRate: editOtRate,
        }),
      });

      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to update rates");

      toast.success("Rates updated successfully");
      setIsEditing(false);

      // We need to update the local activeProfile state and the profiles list
      // Simplest is to refetch all profiles
      await fetchProfiles();

      // Also update activeProfile fields locally to reflect the change in the modal
      const updatedFields = activeProfile.fields.map(f => {
        const nk = normFieldKey(f.key);
        if (["regular_rate", "regular_rate", "Regular_Rate"].map(normFieldKey).includes(nk)) {
          return { ...f, value: editRegularRate };
        }
        if (["ot_rate", "ot_rate", "OT_Rate", "Ot Rate"].map(normFieldKey).includes(nk)) {
          return { ...f, value: editOtRate };
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
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update profile");
    } finally {
      setIsSavingProfile(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-hidden bg-gradient-to-br from-white via-orange-50/30 to-blue-50/20 p-4 sm:p-5 dark:bg-none dark:bg-[#0d1117]">
      <div className="flex shrink-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-xl font-bold tracking-tight text-zinc-900 sm:text-2xl dark:text-white">
            Rates &amp; profiles
          </h2>
          <p className="line-clamp-2 text-xs text-zinc-600 sm:text-sm dark:text-zinc-500">
            Rows match by work/personal email (or name). Open a row for the full merged profile from
            Supabase.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2 sm:gap-3">
          <Button
            type="button"
            onClick={() => { resetAddForm(); setAddOpen(true); }}
            className="gap-1.5 bg-gradient-to-r from-orange-500 to-orange-600 text-white shadow-sm shadow-orange-500/25 hover:from-orange-600 hover:to-orange-700 dark:from-orange-500 dark:to-orange-600 dark:hover:from-orange-600 dark:hover:to-orange-700"
          >
            <Plus className="size-4" />
            Add Employee
          </Button>
          <Badge
            variant="outline"
            className="w-fit border-blue-500/20 bg-gradient-to-r from-orange-500/10 to-blue-500/10 px-3 py-1 text-blue-700 dark:border-blue-500/30 dark:text-blue-400"
          >
            <DollarSign className="mr-1 inline size-3" />
            Supabase
          </Badge>
        </div>
      </div>

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

      <Card className="flex min-h-0 flex-1 flex-col overflow-hidden border-orange-100/80 bg-gradient-to-br from-white to-blue-50/20 shadow-sm dark:border-blue-950/60 dark:bg-none dark:from-blue-950/20 dark:to-blue-950/5">
        <CardHeader className="shrink-0 space-y-0 pb-2 pt-3">
          <CardTitle className="text-base font-semibold text-zinc-900 sm:text-lg dark:text-white">
            Employee rates
          </CardTitle>
        </CardHeader>
        <CardContent className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden pt-0">
          <div className="max-w-md shrink-0 space-y-1.5">
            <Label htmlFor="rates-search" className="text-xs text-zinc-600 dark:text-zinc-500">
              Search
            </Label>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-zinc-500" />
              <Input
                id="rates-search"
                placeholder="Name, email, rates…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                disabled={loading || !!error}
                className="h-9 border-zinc-200 bg-white pl-9 text-zinc-900 placeholder:text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/80 dark:text-zinc-200 dark:placeholder:text-zinc-600"
              />
            </div>
          </div>

          {loading ? (
            <div className="flex flex-1 items-center justify-center gap-2 py-8 text-sm text-zinc-500 dark:text-zinc-400">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading rates…
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
                  <span className="font-mono text-zinc-800 dark:text-zinc-300">
                    {filtered.length === 0 ? 0 : (safePage - 1) * PAGE_SIZE + 1}–
                    {Math.min(safePage * PAGE_SIZE, filtered.length)}
                  </span>{" "}
                  of <span className="font-mono text-zinc-800 dark:text-zinc-300">{filtered.length}</span>
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
                  <span className="px-2 font-mono text-zinc-600 dark:text-zinc-400">
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
              <div className="min-h-0 flex-1 overflow-auto rounded-md border border-zinc-200 dark:border-zinc-800">
                <Table>
                  <TableHeader className="sticky top-0 z-10 bg-gradient-to-r from-orange-50/95 to-blue-50/60 backdrop-blur-sm dark:from-blue-950/90 dark:to-blue-950/70">
                    <TableRow className="border-zinc-200 hover:bg-transparent dark:border-zinc-800">
                      <TableHead className="w-[7rem] shrink-0 text-zinc-600 dark:text-zinc-400">
                        Employee ID
                      </TableHead>
                      <TableHead className="min-w-[11rem] whitespace-normal text-zinc-600 dark:text-zinc-400">
                        Name
                      </TableHead>
                      <TableHead className="min-w-[9rem] whitespace-normal text-zinc-600 dark:text-zinc-400">
                        Department
                      </TableHead>
                      <TableHead className="min-w-[9rem] whitespace-normal text-zinc-600 dark:text-zinc-400">
                        Organization
                      </TableHead>
                      <TableHead className="min-w-[10rem] whitespace-normal text-zinc-600 dark:text-zinc-400">
                        Work Email
                      </TableHead>
                      <TableHead className="text-right text-zinc-600 dark:text-zinc-400">
                        Regular Rate
                      </TableHead>
                      <TableHead className="text-right text-zinc-600 dark:text-zinc-400">OT Rate</TableHead>
                      <TableHead className="w-[160px] text-right text-zinc-600 dark:text-zinc-400">
                        Action
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pageRows.map((p) => {
                      const row = tableRowFromProfile(p, employeeIdMap);
                      return (
                        <TableRow
                          key={p.id}
                          className="border-zinc-200 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900/40"
                        >
                          <TableCell className="align-top">
                            {row.employeeId ? (
                              <span className="inline-flex items-center rounded-md border border-orange-200 bg-orange-50 px-2 py-0.5 font-mono text-xs font-semibold text-orange-700 dark:border-orange-500/30 dark:bg-orange-500/10 dark:text-orange-400">
                                {row.employeeId}
                              </span>
                            ) : (
                              <span className="text-xs text-zinc-400 dark:text-zinc-600">—</span>
                            )}
                          </TableCell>
                          <TableCell className="min-w-[11rem] whitespace-normal break-words align-top font-medium leading-snug text-zinc-900 dark:text-zinc-100">
                            {row.name}
                          </TableCell>
                          <TableCell className="min-w-[9rem] whitespace-normal break-words align-top text-sm leading-snug text-zinc-700 dark:text-zinc-300">
                            {row.department ? (
                              <span className="inline-flex items-center rounded-md border border-blue-200 bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-400">
                                {row.department}
                              </span>
                            ) : (
                              <span className="text-xs text-zinc-400 dark:text-zinc-600">—</span>
                            )}
                          </TableCell>
                          <TableCell className="min-w-[9rem] whitespace-normal break-words align-top text-sm leading-snug text-zinc-700 dark:text-zinc-300">
                            {row.organization && row.organization !== "—" ? (
                              <span className="inline-flex items-center rounded-md border border-violet-200 bg-violet-50 px-2 py-0.5 text-xs font-medium text-violet-700 dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-400">
                                {row.organization}
                              </span>
                            ) : (
                              <span className="text-xs text-zinc-400 dark:text-zinc-600">—</span>
                            )}
                          </TableCell>
                          <TableCell className="min-w-[10rem] max-w-[280px] whitespace-normal break-all font-mono text-xs leading-snug text-zinc-600 dark:text-zinc-400">
                            {row.workEmail}
                          </TableCell>
                          <TableCell className="text-right font-mono text-sm tabular-nums text-zinc-800 dark:text-zinc-200">
                            {row.regularRate}
                          </TableCell>
                          <TableCell className="text-right font-mono text-sm tabular-nums text-zinc-800 dark:text-zinc-200">
                            {row.otRate}
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex items-center justify-end gap-1.5">
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="h-8 gap-1.5 border-zinc-200 text-zinc-800 dark:border-zinc-700 dark:text-zinc-200"
                                onClick={() => openProfile(p)}
                              >
                                <Eye className="size-3.5" />
                                View
                              </Button>
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="h-8 w-8 border-zinc-200 p-0 text-red-500 hover:border-red-300 hover:bg-red-50 hover:text-red-600 dark:border-zinc-700 dark:text-red-400 dark:hover:border-red-800 dark:hover:bg-red-950/40 dark:hover:text-red-400"
                                onClick={() => setDeleteTarget(p)}
                                title={`Delete ${p.displayName}`}
                              >
                                <Trash2 className="size-3.5" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

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
              <span className="font-mono text-xs">employee_hourly_rates</span> and{" "}
              <span className="font-mono text-xs">global_master_list</span>.
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

      {/* Add Employee Modal */}
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
            "w-[min(92vw,560px)] max-w-[min(92vw,560px)] rounded-2xl border-orange-100/60 bg-gradient-to-br from-white via-orange-50/20 to-blue-50/30 p-0",
            "shadow-[0_25px_50px_-12px_rgba(249,115,22,0.12),0_10px_20px_-5px_rgba(0,0,0,0.10)] dark:border-blue-950/60 dark:from-[#0d1117] dark:via-[#0f1729] dark:to-[#0a1628] dark:shadow-black/50",
            "sm:max-w-[min(92vw,560px)]",
            "duration-[340ms] ease-[cubic-bezier(0.22,1,0.36,1)]",
            "data-open:animate-in data-open:fade-in-0 data-open:zoom-in-[0.93] data-open:slide-in-from-bottom-8",
            "data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-[0.97] data-closed:slide-out-to-bottom-4 data-closed:duration-[180ms] data-closed:ease-in",
          )}
        >
          <form onSubmit={handleAddEmployee}>
            <DialogHeader className="border-b border-orange-100/60 bg-gradient-to-r from-orange-50/90 via-white to-blue-50/60 px-6 py-5 dark:border-blue-950/60 dark:from-blue-950/60 dark:via-[#0f1729] dark:to-blue-950/40">
              <DialogTitle className="text-xl font-semibold tracking-tight text-zinc-900 dark:text-white">
                Add Employee
              </DialogTitle>
              <DialogDescription className="text-sm text-zinc-500 dark:text-zinc-400">
                Creates a new profile in both <span className="font-mono text-xs">employee_hourly_rates</span> and <span className="font-mono text-xs">global_master_list</span>.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-5 overflow-y-auto px-6 py-6" style={{ maxHeight: "min(70vh, 560px)" }}>
              {/* Name & Department */}
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
                    className="h-9 border-zinc-200 bg-white text-zinc-900 placeholder:text-zinc-400 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="add-department" className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
                    Department
                  </Label>
                  <Input
                    id="add-department"
                    placeholder="e.g. Engineering"
                    value={addForm.department}
                    onChange={(e) => setAddForm((f) => ({ ...f, department: e.target.value }))}
                    className="h-9 border-zinc-200 bg-white text-zinc-900 placeholder:text-zinc-400 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
                  />
                </div>
              </div>

              {/* Emails */}
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="add-work-email" className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
                    Work Email
                  </Label>
                  <Input
                    id="add-work-email"
                    type="email"
                    placeholder="name@company.com"
                    value={addForm.workEmail}
                    onChange={(e) => setAddForm((f) => ({ ...f, workEmail: e.target.value }))}
                    className="h-9 border-zinc-200 bg-white font-mono text-sm text-zinc-900 placeholder:font-sans placeholder:text-zinc-400 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="add-personal-email" className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
                    Personal Email
                  </Label>
                  <Input
                    id="add-personal-email"
                    type="email"
                    placeholder="personal@email.com"
                    value={addForm.personalEmail}
                    onChange={(e) => setAddForm((f) => ({ ...f, personalEmail: e.target.value }))}
                    className="h-9 border-zinc-200 bg-white font-mono text-sm text-zinc-900 placeholder:font-sans placeholder:text-zinc-400 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
                  />
                </div>
              </div>
              <p className="text-[11px] text-zinc-400 dark:text-zinc-600 -mt-2">
                At least one email is required.
              </p>

              {/* Start Date */}
              <div className="space-y-1.5">
                <Label htmlFor="add-start-date" className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
                  Start Date
                </Label>
                <Input
                  id="add-start-date"
                  type="date"
                  value={addForm.startDate}
                  onChange={(e) => setAddForm((f) => ({ ...f, startDate: e.target.value }))}
                  className="h-9 w-full border-zinc-200 bg-white text-zinc-900 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
                />
              </div>

              {/* Rates */}
              <div className="rounded-lg border border-orange-100/80 bg-gradient-to-br from-orange-50/60 to-blue-50/40 p-4 dark:border-blue-950/50 dark:from-blue-950/30 dark:to-blue-950/10">
                <p className="mb-3 text-[10px] font-bold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
                  Hourly Rates
                </p>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label htmlFor="add-regular-rate" className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
                      Regular Rate
                    </Label>
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-zinc-400">$</span>
                      <Input
                        id="add-regular-rate"
                        placeholder="0.00"
                        value={addForm.regularRate}
                        onChange={(e) => setAddForm((f) => ({ ...f, regularRate: e.target.value }))}
                        className="h-9 border-zinc-200 bg-white pl-6 font-mono text-sm text-zinc-900 placeholder:text-zinc-400 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
                      />
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="add-ot-rate" className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
                      OT Rate
                    </Label>
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-zinc-400">$</span>
                      <Input
                        id="add-ot-rate"
                        placeholder="0.00"
                        value={addForm.otRate}
                        onChange={(e) => setAddForm((f) => ({ ...f, otRate: e.target.value }))}
                        className="h-9 border-zinc-200 bg-white pl-6 font-mono text-sm text-zinc-900 placeholder:text-zinc-400 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
                      />
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <DialogFooter className="border-t border-orange-100/60 bg-gradient-to-r from-orange-50/70 to-blue-50/40 px-6 py-4 dark:border-blue-950/60 dark:from-blue-950/50 dark:to-blue-950/30">
              <Button
                type="button"
                variant="ghost"
                onClick={() => { setAddOpen(false); resetAddForm(); }}
                disabled={isAdding}
                className="text-zinc-600 hover:bg-orange-50 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-blue-950/40 dark:hover:text-white"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={isAdding}
                className="gap-1.5 bg-gradient-to-r from-orange-500 to-orange-600 text-white shadow-sm shadow-orange-500/25 hover:from-orange-600 hover:to-orange-700"
              >
                {isAdding ? (
                  <>
                    <Loader2 className="size-3.5 animate-spin" />
                    Adding…
                  </>
                ) : (
                  <>
                    <Plus className="size-3.5" />
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
            setIsEditingProfile(false);
          }
        }}
      >
        <DialogContent
          showCloseButton
          className={cn(
            "w-[min(92vw,1200px)] max-w-[min(92vw,1200px)] max-h-[min(92vh,960px)] overflow-hidden rounded-2xl border-orange-100/60 bg-gradient-to-br from-white via-orange-50/20 to-blue-50/30 p-0",
            "shadow-[0_25px_50px_-12px_rgba(0,0,0,0.18)] dark:border-blue-950/60 dark:from-[#0d1117] dark:via-[#0f1729] dark:to-[#0a1628] dark:shadow-black/50",
            "sm:max-w-[min(92vw,1200px)]",
            "duration-[380ms] ease-[cubic-bezier(0.22,1,0.36,1)]",
            "data-open:animate-in data-open:fade-in-0 data-open:zoom-in-[0.96] data-open:slide-in-from-bottom-6",
            "data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-[0.98] data-closed:slide-out-to-bottom-3 data-closed:duration-[200ms] data-closed:ease-in",
          )}
        >
          {activeProfile ? (
            <motion.div
              key={activeProfile.id}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, ease: dialogEase }}
              className="flex flex-col"
            >
              <DialogHeader className="shrink-0 space-y-2 border-b border-orange-100/60 bg-gradient-to-r from-orange-50/80 via-white to-blue-50/60 px-6 py-5 dark:border-blue-950/60 dark:from-blue-950/60 dark:via-[#0f1729] dark:to-blue-950/40">
                <div className="flex items-start gap-3">
                  <DialogTitle className="pr-10 text-xl font-semibold leading-snug tracking-tight text-zinc-900 dark:text-white">
                    {activeProfile.displayName}
                  </DialogTitle>
                  {(() => {
                    const empId = tableRowFromProfile(activeProfile, employeeIdMap).employeeId;
                    return empId ? (
                      <span className="mt-0.5 inline-flex shrink-0 items-center rounded-md border border-orange-200 bg-orange-50 px-2.5 py-1 font-mono text-xs font-semibold text-orange-700 dark:border-orange-500/30 dark:bg-orange-500/10 dark:text-orange-400">
                        {empId}
                      </span>
                    ) : null;
                  })()}
                </div>
                {(activeProfile.department || activeProfile.organization) ? (
                  <div className="flex flex-wrap items-center gap-2">
                    {activeProfile.department ? (
                      <span className="inline-flex items-center rounded-md border border-blue-200 bg-blue-50 px-2.5 py-0.5 text-xs font-medium text-blue-700 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-400">
                        {activeProfile.department}
                      </span>
                    ) : null}
                    {activeProfile.organization ? (
                      <span className="inline-flex items-center rounded-md border border-violet-200 bg-violet-50 px-2.5 py-0.5 text-xs font-medium text-violet-700 dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-400">
                        {activeProfile.organization}
                      </span>
                    ) : null}
                  </div>
                ) : null}
                {activeProfile.subtitle ? (
                  <DialogDescription className="text-left font-mono text-xs leading-relaxed text-zinc-500 dark:text-zinc-500">
                    {activeProfile.subtitle}
                  </DialogDescription>
                ) : (
                  <DialogDescription className="sr-only">
                    Complete merged fields for this employee.
                  </DialogDescription>
                )}
                <p className="text-xs leading-relaxed text-zinc-500 dark:text-zinc-600">
                  {activeProfile.fields.length} unique field
                  {activeProfile.fields.length === 1 ? "" : "s"} — merged from all matching tables;
                  duplicate column names appear once (hourly rates first, then master, then others A–Z).
                </p>
              </DialogHeader>

              {/* Quick Rate Editor Section */}
              <div className="shrink-0 border-b border-orange-100/40 bg-gradient-to-r from-white to-orange-50/30 px-6 py-4 dark:border-blue-950/40 dark:from-[#0d1117] dark:to-blue-950/10">
                <div className="flex items-center justify-between">
                  <div className="flex gap-8">
                    <div className="space-y-1">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
                        Regular Rate
                      </p>
                      {isEditing ? (
                        <Input
                          value={editRegularRate}
                          onChange={(e) => setEditRegularRate(e.target.value)}
                          className="h-8 w-24 border-zinc-200 bg-white px-2 py-0 text-sm font-mono focus-visible:ring-orange-500 dark:border-zinc-800 dark:bg-zinc-900"
                        />
                      ) : (
                        <p className="font-mono text-lg font-semibold text-zinc-900 dark:text-white">
                          {editRegularRate === "—" ? "—" : `$${editRegularRate}`}
                        </p>
                      )}
                    </div>
                    <div className="space-y-1">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
                        OT Rate
                      </p>
                      {isEditing ? (
                        <Input
                          value={editOtRate}
                          onChange={(e) => setEditOtRate(e.target.value)}
                          className="h-8 w-24 border-zinc-200 bg-white px-2 py-0 text-sm font-mono focus-visible:ring-orange-500 dark:border-zinc-800 dark:bg-zinc-900"
                        />
                      ) : (
                        <p className="font-mono text-lg font-semibold text-zinc-900 dark:text-white">
                          {editOtRate === "—" ? "—" : `$${editOtRate}`}
                        </p>
                      )}
                    </div>
                  </div>
                  <div>
                    {isEditing ? (
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-8 w-8 p-0 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-white"
                          onClick={() => {
                            setIsEditing(false);
                            const m = buildNormFieldMap(activeProfile.fields);
                            setEditRegularRate(pickFromMap(m, ["Regular Rate", "regular_rate", "Regular_Rate"]));
                            setEditOtRate(pickFromMap(m, ["OT Rate", "ot_rate", "OT_Rate", "Ot Rate"]));
                          }}
                          disabled={isSaving}
                        >
                          <X className="size-4" />
                        </Button>
                        <Button
                          size="sm"
                          className="h-8 gap-1.5 bg-gradient-to-r from-orange-500 to-orange-600 px-3 text-white hover:from-orange-600 hover:to-orange-700 shadow-sm shadow-orange-500/20"
                          onClick={handleSaveRates}
                          disabled={isSaving}
                        >
                          {isSaving ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <Check className="size-3.5" />
                          )}
                          Save
                        </Button>
                      </div>
                    ) : (
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 gap-1.5 border-zinc-200 text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                          onClick={openEditProfile}
                          disabled={isEditingProfile}
                        >
                          <UserCog className="size-3.5" />
                          Edit Profile
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 gap-1.5 border-orange-200 text-orange-700 hover:bg-orange-50 dark:border-orange-900/50 dark:text-orange-400 dark:hover:bg-orange-950/30"
                          onClick={() => setIsEditing(true)}
                        >
                          <Edit2 className="size-3.5" />
                          Edit rates
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 gap-1.5 border-red-200 text-red-500 hover:bg-red-50 hover:text-red-600 dark:border-red-900/60 dark:text-red-400 dark:hover:bg-red-950/40"
                          onClick={() => setDeleteTarget(activeProfile)}
                        >
                          <Trash2 className="size-3.5" />
                          Delete
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
              <div className="overflow-y-auto overflow-x-hidden bg-gradient-to-b from-white to-orange-50/20 px-6 [-webkit-overflow-scrolling:touch] dark:from-[#0d1117] dark:to-blue-950/10" style={{ maxHeight: "min(58vh, 600px)" }}>
                {isEditingProfile ? (
                  <div className="py-5">
                    <p className="mb-4 text-[10px] font-bold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
                      Edit Profile
                    </p>
                    <div className="space-y-4">
                      {/* Name (full width) */}
                      <div className="space-y-1.5">
                        <Label className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
                          Name
                        </Label>
                        <Input
                          placeholder="Full name"
                          value={editProfileForm.name}
                          onChange={(e) => setEditProfileForm((f) => ({ ...f, name: e.target.value }))}
                          className="h-9 border-zinc-200 bg-white text-zinc-900 placeholder:text-zinc-400 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
                        />
                      </div>
                      {/* Department + Start Date */}
                      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                        <div className="space-y-1.5">
                          <Label className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
                            Department
                          </Label>
                          <Input
                            placeholder="e.g. Engineering"
                            value={editProfileForm.department}
                            onChange={(e) => setEditProfileForm((f) => ({ ...f, department: e.target.value }))}
                            className="h-9 border-zinc-200 bg-white text-zinc-900 placeholder:text-zinc-400 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
                          />
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
                            Start Date
                          </Label>
                          <Input
                            type="date"
                            value={editProfileForm.startDate}
                            onChange={(e) => setEditProfileForm((f) => ({ ...f, startDate: e.target.value }))}
                            className="h-9 border-zinc-200 bg-white text-zinc-900 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
                          />
                        </div>
                      </div>
                      {/* Emails */}
                      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                        <div className="space-y-1.5">
                          <Label className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
                            Work Email
                          </Label>
                          <Input
                            type="email"
                            placeholder="name@company.com"
                            value={editProfileForm.workEmail}
                            onChange={(e) => setEditProfileForm((f) => ({ ...f, workEmail: e.target.value }))}
                            className="h-9 border-zinc-200 bg-white font-mono text-sm text-zinc-900 placeholder:font-sans placeholder:text-zinc-400 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
                          />
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
                            Personal Email
                          </Label>
                          <Input
                            type="email"
                            placeholder="personal@email.com"
                            value={editProfileForm.personalEmail}
                            onChange={(e) => setEditProfileForm((f) => ({ ...f, personalEmail: e.target.value }))}
                            className="h-9 border-zinc-200 bg-white font-mono text-sm text-zinc-900 placeholder:font-sans placeholder:text-zinc-400 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
                          />
                        </div>
                      </div>
                    </div>
                    {/* Form actions */}
                    <div className="mt-6 flex justify-end gap-2 border-t border-zinc-100 pt-5 dark:border-zinc-800">
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
                        className="gap-1.5 bg-gradient-to-r from-zinc-800 to-zinc-900 text-white shadow-sm hover:from-zinc-700 hover:to-zinc-800 dark:from-zinc-200 dark:to-zinc-100 dark:text-zinc-900 dark:hover:from-white dark:hover:to-zinc-200"
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
                        const empId = tableRowFromProfile(activeProfile, employeeIdMap).employeeId;
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
                              <span className="inline-flex items-center rounded-md border border-orange-200 bg-orange-50 px-2.5 py-0.5 font-mono text-sm font-semibold text-orange-700 dark:border-orange-500/30 dark:bg-orange-500/10 dark:text-orange-400">
                                {empId}
                              </span>
                            </dd>
                          </motion.div>
                        );
                      })()}
                      {activeProfile.fields.map(({ key, value }, i) => (
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
    </div>
  );
}
