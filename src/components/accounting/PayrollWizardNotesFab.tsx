"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { AnimatePresence, motion } from "motion/react";
import { ListChecks, Loader2, Plus, StickyNote, Trash2, User, Wallet } from "lucide-react";
import { toast } from "sonner";
import { useLiveRefresh } from "@/hooks/useLiveRefresh";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type {
  PayrollWizardNoteField,
  PayrollWizardNoteRow,
} from "@/lib/supabase/payroll-wizard-notes";
import { DEPARTMENTS } from "@/lib/payroll/department-bonus";
import {
  defaultOtRate,
  formatRate,
  type PayStructure,
} from "@/lib/payment-catalog/pay-structure";

/**
 * The Payroll Wizard's floating "Notes" checklist — carry-over items for the
 * next payroll week (missed bonuses, rate changes, staged deductions), the
 * digital version of the spreadsheet's "Phase 5: Adjustments" block.
 *
 * A pulsing sticky-note FAB sits over the wizard; clicking it opens a modal
 * with a fixed 5-column grid (Date | Payroll Clerk | Done | Worker | Notes).
 * Cells save on blur, Done saves on click, Add Row appends a pre-stamped
 * blank line. Rendered in App.tsx OUTSIDE the wizard's strict ReadOnlyTab
 * wrapper so view-only accountants can still READ the list — `canEdit`
 * (the accounting/payroll_wizard `edit` grant) gates every mutation, and the
 * API enforces the same grant server-side.
 */

const API = "/api/payroll-wizard/notes";

const COLUMNS: { field: PayrollWizardNoteField; label: string; width: string }[] = [
  { field: "note_date", label: "Date", width: "w-24" },
  { field: "payroll_clerk", label: "Payroll Clerk", width: "w-36" },
  // Done (boolean) renders between these two, matching the sheet's order.
  { field: "worker", label: "Worker", width: "w-56" },
  { field: "notes", label: "Notes", width: "min-w-72" },
];

/** "7/10"-style stamp, matching how dates were written on the sheet. */
function todayStamp(): string {
  const d = new Date();
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** localStorage key base for the per-user "show everyone's notes" preference. */
const SHOW_OTHERS_KEY = "payroll-wizard-notes:show-others";

type ModalTab = "checklist" | "rates";

/** Shared easing — matches the app's tab transition (App.tsx / BonusCatalog). */
const EASE = [0.22, 1, 0.36, 1] as const;

export default function PayrollWizardNotesFab({
  sessionEmail,
  canEdit,
}: {
  sessionEmail: string | null;
  canEdit: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [modalTab, setModalTab] = useState<ModalTab>("checklist");
  // The signed-in user's real name ("First Last", from Google sign-in) for the
  // Payroll Clerk stamp — never the raw email prefix unless there's no name.
  const { data: authSession } = useSession();
  const clerkName =
    authSession?.user?.name?.trim() || (sessionEmail ?? "").split("@")[0] || "";
  const [rows, setRows] = useState<PayrollWizardNoteRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Last-saved snapshot per row, so a blur only PATCHes cells that changed.
  const savedRef = useRef<Map<string, PayrollWizardNoteRow>>(new Map());
  // True while a cell has focus — a live refresh must never clobber a draft.
  const editingRef = useRef(false);
  // "Show everyone's notes" — defaults ON (it's a shared board); remembered
  // per user across sessions.
  const selfEmail = (sessionEmail ?? "").trim().toLowerCase();
  const [showOthers, setShowOthers] = useState(true);
  useEffect(() => {
    try {
      const v = localStorage.getItem(`${SHOW_OTHERS_KEY}:${selfEmail}`);
      if (v !== null) setShowOthers(v === "1");
    } catch {
      /* ignore */
    }
  }, [selfEmail]);
  const toggleShowOthers = (v: boolean) => {
    setShowOthers(v);
    try {
      localStorage.setItem(`${SHOW_OTHERS_KEY}:${selfEmail}`, v ? "1" : "0");
    } catch {
      /* ignore */
    }
  };

  const applyRows = useCallback((next: PayrollWizardNoteRow[]) => {
    setRows(next);
    savedRef.current = new Map(next.map((r) => [r.id, r]));
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch(API, { cache: "no-store" });
      const json = (await res.json()) as { rows?: PayrollWizardNoteRow[]; error?: string };
      if (!res.ok) throw new Error(json.error || `Load failed (${res.status})`);
      applyRows(json.rows ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load notes");
    } finally {
      setLoading(false);
    }
  }, [applyRows]);

  // Load on mount (the FAB badge needs the open count) and again on open, so
  // the modal always shows what a colleague may have added meanwhile.
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  // Shared board: everyone with wizard access watches the same table, so a
  // colleague's add / tick / edit shows up here live (Realtime, with a polling
  // fallback). Skipped while a local cell is focused — the next tick catches up.
  useLiveRefresh({
    tables: ["payroll_wizard_notes"],
    channel: "payroll-wizard-notes",
    onRefresh: () => {
      if (!editingRef.current) void load();
    },
  });

  /** PATCH one row's changed fields; reconcile with the server's copy. */
  const saveRow = useCallback(
    async (id: string, values: Partial<Record<PayrollWizardNoteField, string | null> & { done: boolean }>) => {
      try {
        const res = await fetch(API, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, values }),
        });
        const json = (await res.json()) as { row?: PayrollWizardNoteRow; error?: string };
        if (!res.ok || !json.row) throw new Error(json.error || `Save failed (${res.status})`);
        const fresh = json.row;
        savedRef.current.set(id, fresh);
        setRows((prev) => prev.map((r) => (r.id === id ? fresh : r)));
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not save the note");
        const last = savedRef.current.get(id);
        if (last) setRows((prev) => prev.map((r) => (r.id === id ? last : r)));
      }
    },
    [],
  );

  const onCellChange = (id: string, field: PayrollWizardNoteField, value: string) => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, [field]: value } : r)));
  };

  const onCellFocus = () => {
    editingRef.current = true;
  };

  const onCellBlur = (id: string, field: PayrollWizardNoteField) => {
    editingRef.current = false;
    const row = rows.find((r) => r.id === id);
    const saved = savedRef.current.get(id);
    if (!row) return;
    const next = (row[field] ?? "").trim();
    const prev = (saved?.[field] ?? "").trim();
    if (next !== prev) void saveRow(id, { [field]: next === "" ? null : next });
  };

  const onToggleDone = (id: string, done: boolean) => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, done } : r)));
    void saveRow(id, { done });
  };

  const addRow = async () => {
    setAdding(true);
    try {
      const res = await fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ values: { note_date: todayStamp(), payroll_clerk: clerkName } }),
      });
      const json = (await res.json()) as { row?: PayrollWizardNoteRow; error?: string };
      if (!res.ok || !json.row) throw new Error(json.error || `Add failed (${res.status})`);
      const fresh = json.row;
      savedRef.current.set(fresh.id, fresh);
      setRows((prev) => [...prev, fresh]);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not add a row");
    } finally {
      setAdding(false);
    }
  };

  const deleteRow = async (id: string) => {
    const prev = rows;
    setRows((p) => p.filter((r) => r.id !== id));
    try {
      const res = await fetch(API, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const json = (await res.json()) as { deleted?: number; error?: string };
      if (!res.ok) throw new Error(json.error || `Delete failed (${res.status})`);
      savedRef.current.delete(id);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not delete the note");
      setRows(prev);
    }
  };

  // Open = has real content and isn't ticked. The pre-seeded blank lines
  // (5 per clerk) don't count — otherwise the badge would never clear.
  const openCount = rows.filter(
    (r) =>
      !r.done &&
      ((r.note_date ?? "").trim() !== "" ||
        (r.worker ?? "").trim() !== "" ||
        (r.notes ?? "").trim() !== ""),
  ).length;

  // Only my rows when the toggle is off (mine = rows I created, incl. my seeds).
  const visibleRows = showOthers
    ? rows
    : rows.filter((r) => (r.created_by ?? "").trim().toLowerCase() === selfEmail);

  // Per-clerk sections, each under a divider header. Grouped on the SAVED clerk
  // value so retyping a clerk cell doesn't bounce the row between sections
  // mid-keystroke (rows arrive pre-sorted by clerk from the API).
  const groups: { clerk: string; rows: PayrollWizardNoteRow[] }[] = [];
  for (const r of visibleRows) {
    const clerk =
      (savedRef.current.get(r.id)?.payroll_clerk ?? r.payroll_clerk ?? "").trim() || "Unassigned";
    const last = groups[groups.length - 1];
    if (last && last.clerk.toLowerCase() === clerk.toLowerCase()) last.rows.push(r);
    else groups.push({ clerk, rows: [r] });
  }

  // While Add Row is in flight, a skeleton row shows where the new row will
  // land: at the end of MY section, or the end of the table if I have none yet.
  const isOwnGroup = (g: { rows: PayrollWizardNoteRow[] }) =>
    g.rows.some((r) => (r.created_by ?? "").trim().toLowerCase() === selfEmail);
  const hasOwnGroup = groups.some(isOwnGroup);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Open payroll notes checklist${openCount > 0 ? ` (${openCount} open)` : ""}`}
        className="notes-fab-pulse fixed right-5 bottom-5 z-40 flex h-13 w-13 items-center justify-center rounded-full bg-gradient-to-br from-orange-500 to-amber-500 text-white shadow-lg shadow-orange-500/30 transition-[filter] hover:brightness-110 focus-visible:ring-3 focus-visible:ring-orange-400/60 focus-visible:outline-none dark:from-orange-600 dark:to-amber-600"
      >
        <StickyNote className="h-6 w-6" />
        {openCount > 0 && (
          <span className="absolute -top-1 -right-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-blue-600 px-1 text-[11px] font-bold text-white ring-2 ring-white dark:ring-[#0d1117]">
            {openCount > 99 ? "99+" : openCount}
          </span>
        )}
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-[min(96vw,84rem)] sm:max-w-[min(96vw,84rem)]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <StickyNote className="h-4 w-4 text-orange-500" />
              Payroll Notes
            </DialogTitle>
            <DialogDescription>
              {modalTab === "checklist" ? (
                <>
                  Anything to correct on an upcoming payroll — a missed bonus, a rate change, a
                  deduction in progress. Tick <span className="font-medium">Done</span> once
                  it&apos;s been applied. Cells save automatically.
                </>
              ) : (
                <>
                  The rates set in the Payment Catalog, at a glance. Hover a department card to
                  see its individual overrides — editing stays in the Payment Catalog tab.
                </>
              )}
            </DialogDescription>
          </DialogHeader>

          <div className="flex items-center gap-1 border-b border-orange-100 dark:border-blue-950/60">
            {(
              [
                { id: "checklist", label: "Checklist", icon: ListChecks },
                { id: "rates", label: "Rates", icon: Wallet },
              ] as const
            ).map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={modalTab === t.id}
                onClick={() => setModalTab(t.id)}
                className={`-mb-px flex items-center gap-1.5 rounded-t-md border-b-2 px-3 py-1.5 text-sm font-medium transition-colors ${
                  modalTab === t.id
                    ? "border-orange-500 text-orange-700 dark:border-orange-400 dark:text-orange-300"
                    : "border-transparent text-zinc-500 hover:bg-orange-50/60 hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-blue-950/30 dark:hover:text-zinc-200"
                }`}
              >
                <t.icon className="h-4 w-4" />
                {t.label}
              </button>
            ))}
          </div>

          <AnimatePresence mode="wait" initial={false}>
          {modalTab === "rates" ? (
            <motion.div
              key="rates"
              initial={{ opacity: 0, x: 14 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -14 }}
              transition={{ duration: 0.22, ease: EASE }}
            >
              <RatesGlance />
            </motion.div>
          ) : (
            <motion.div
              key="checklist"
              initial={{ opacity: 0, x: -14 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 14 }}
              transition={{ duration: 0.22, ease: EASE }}
              className="grid gap-4"
            >
          {error && (
            <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
              {error}
            </p>
          )}

          <div className="flex items-center justify-end">
            <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-zinc-600 dark:text-zinc-300">
              Show everyone&apos;s notes
              <Switch
                size="sm"
                checked={showOthers}
                onCheckedChange={(checked) => toggleShowOthers(checked === true)}
              />
            </label>
          </div>

          <div className="h-[70vh] overflow-auto rounded-lg border border-orange-100 dark:border-blue-950/60">
            <table className="w-full border-collapse text-sm">
              <thead className="sticky top-0 z-10 bg-orange-50/95 backdrop-blur dark:bg-blue-950/60">
                <tr className="text-left text-xs font-semibold text-zinc-600 dark:text-zinc-300">
                  <th className="w-24 px-2 py-2">Date</th>
                  <th className="w-40 px-2 py-2">Payroll Clerk</th>
                  <th className="w-14 px-2 py-2 text-center">Done</th>
                  <th className="w-64 px-2 py-2">Worker</th>
                  <th className="min-w-96 px-2 py-2">Notes</th>
                  {canEdit && <th className="w-10 px-1 py-2" aria-label="Row actions" />}
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan={canEdit ? 6 : 5} className="px-3 py-8 text-center text-zinc-400">
                      <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />
                      Loading notes…
                    </td>
                  </tr>
                ) : visibleRows.length === 0 ? (
                  <tr>
                    <td colSpan={canEdit ? 6 : 5} className="px-3 py-8 text-center text-zinc-400">
                      {showOthers
                        ? "Nothing on the board yet."
                        : "You have no notes yet — flip on “Show everyone's notes” to see the rest of the board."}
                    </td>
                  </tr>
                ) : (
                  groups.map((group, gi) => (
                    <Fragment key={`${group.clerk}-${gi}`}>
                      {/* Divider: one section per clerk. */}
                      <tr className="border-t-2 border-orange-200/90 bg-orange-50/70 dark:border-blue-900/70 dark:bg-blue-950/40">
                        <td
                          colSpan={canEdit ? 6 : 5}
                          className="px-2 py-1.5 text-[11px] font-bold tracking-wider text-orange-700 uppercase dark:text-orange-300"
                        >
                          {group.clerk}
                        </td>
                      </tr>
                      {group.rows.map((row) => (
                        <tr
                          key={row.id}
                          className={`border-t border-orange-100/80 dark:border-blue-950/50 ${
                            row.done ? "bg-emerald-50/50 dark:bg-emerald-950/10" : ""
                          }`}
                        >
                      {COLUMNS.slice(0, 2).map(({ field }) => (
                        <td key={field} className="px-1 py-0.5 align-top">
                          <NoteCell
                            row={row}
                            field={field}
                            canEdit={canEdit}
                            onChange={onCellChange}
                            onFocus={onCellFocus}
                            onBlur={onCellBlur}
                          />
                        </td>
                      ))}
                      <td className="px-2 pt-2.5 pb-0.5 text-center align-top">
                        <Checkbox
                          checked={row.done}
                          disabled={!canEdit}
                          onCheckedChange={(checked) => onToggleDone(row.id, checked === true)}
                          aria-label={`Mark ${row.worker || "note"} as done`}
                        />
                      </td>
                      {COLUMNS.slice(2).map(({ field }) => (
                        <td key={field} className="px-1 py-0.5 align-top">
                          <NoteCell
                            row={row}
                            field={field}
                            canEdit={canEdit}
                            onChange={onCellChange}
                            onFocus={onCellFocus}
                            onBlur={onCellBlur}
                          />
                        </td>
                      ))}
                      {canEdit && (
                        <td className="px-1 pt-1 pb-0.5 text-center align-top">
                          {/* Owner-only: you can only delete notes you created
                              (the API enforces the same rule). */}
                          {(row.created_by ?? "").trim().toLowerCase() === selfEmail && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              className="text-zinc-400 hover:text-red-600 dark:hover:text-red-400"
                              onClick={() => void deleteRow(row.id)}
                              aria-label="Delete note"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          )}
                        </td>
                      )}
                        </tr>
                      ))}
                      {adding && isOwnGroup(group) && <SkeletonNoteRow canEdit={canEdit} />}
                    </Fragment>
                  ))
                )}
                {adding && !loading && !hasOwnGroup && <SkeletonNoteRow canEdit={canEdit} />}
              </tbody>
            </table>
          </div>

          {canEdit && (
            <div className="flex items-center justify-between">
              <Button type="button" variant="outline" size="sm" onClick={() => void addRow()} disabled={adding}>
                {adding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                Add Row
              </Button>
              <span className="text-xs text-zinc-400">
                {openCount === 0 ? "All items done" : `${openCount} open item${openCount === 1 ? "" : "s"}`}
              </span>
            </div>
          )}
            </motion.div>
          )}
          </AnimatePresence>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * "Rates" tab — a read-only glance at the Pay Structure rates set in the
 * Payment Catalog. One compact card per department (Regular + OT); hovering a
 * card slides open the list of individual overrides. Deliberately light on
 * detail — currency editing, history, and everything else stays in the
 * Payment Catalog tab.
 */
function RatesGlance() {
  const [structures, setStructures] = useState<PayStructure[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/payment-catalog/pay-structures", { cache: "no-store" })
      .then(async (res) => {
        const json = (await res.json()) as { structures?: PayStructure[]; error?: string };
        if (!res.ok) throw new Error(json.error || `Load failed (${res.status})`);
        if (alive) setStructures(json.structures ?? []);
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : "Could not load rates");
      });
    return () => {
      alive = false;
    };
  }, []);

  if (error) {
    return (
      <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
        {error}
      </p>
    );
  }
  if (structures === null) {
    return (
      <div className="flex h-[70vh] items-center justify-center text-sm text-zinc-400">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Loading rates…
      </div>
    );
  }

  const cards = DEPARTMENTS.map((d) => ({
    key: d.key,
    name: d.name,
    dept: structures.find((s) => s.scope === "department" && s.departmentKey === d.key) ?? null,
    people: structures
      .filter((s) => s.scope === "employee" && s.departmentKey === d.key)
      .sort((a, b) => (a.employeeName ?? a.employeeEmail ?? "").localeCompare(b.employeeName ?? b.employeeEmail ?? "")),
  })).filter((c) => c.dept || c.people.length > 0);

  if (cards.length === 0) {
    return (
      <div className="flex h-[70vh] items-center justify-center text-sm text-zinc-400">
        No rates set yet — add them in the Payment Catalog.
      </div>
    );
  }

  return (
    <div className="h-[70vh] overflow-y-auto pr-1">
      {/* auto-fill fills the modal's width; rows keep their natural compact
          height so cards never stretch tall. */}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] content-start gap-3">
        {cards.map((c) => (
          <div
            key={c.key}
            className="rounded-lg border border-orange-100 bg-white px-3.5 py-2.5 transition-all duration-200 ease-out hover:-translate-y-0.5 hover:border-orange-300 hover:shadow-lg hover:shadow-orange-500/10 dark:border-blue-950/60 dark:bg-blue-950/20 dark:hover:border-blue-800 dark:hover:shadow-blue-500/10"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate text-sm font-semibold text-zinc-800 dark:text-zinc-100">
                {c.name}
              </span>
              {c.people.length > 0 && (
                <span
                  className="inline-flex shrink-0 items-center gap-1 rounded-full bg-orange-100/80 px-1.5 py-0.5 text-[10px] font-semibold text-orange-700 dark:bg-blue-900/50 dark:text-blue-200"
                  title={`${c.people.length} individual override${c.people.length === 1 ? "" : "s"} — see Payment Catalog`}
                >
                  <User className="h-2.5 w-2.5" />
                  {c.people.length}
                </span>
              )}
            </div>

            <div className="mt-1.5 flex items-baseline gap-4 text-xs text-zinc-500 dark:text-zinc-400">
              <span>
                Reg{" "}
                <span className="font-semibold text-zinc-800 dark:text-zinc-100">
                  {c.dept ? formatRate(c.dept.regularRate, c.dept.currency) : "—"}
                </span>
              </span>
              <span>
                OT{" "}
                <span className="font-semibold text-zinc-800 dark:text-zinc-100">
                  {c.dept
                    ? formatRate(c.dept.otRate ?? defaultOtRate(c.dept.regularRate), c.dept.currency)
                    : "—"}
                </span>
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Placeholder row shown while Add Row waits on the server — pulsing bars in
 *  each column, shaped like the real row it's about to become. */
function SkeletonNoteRow({ canEdit }: { canEdit: boolean }) {
  const bar = "h-4 animate-pulse rounded bg-orange-100/90 dark:bg-blue-900/40";
  return (
    <tr aria-hidden className="border-t border-orange-100/80 dark:border-blue-950/50">
      <td className="px-2 py-2 align-top">
        <div className={`${bar} w-12`} />
      </td>
      <td className="px-2 py-2 align-top">
        <div className={`${bar} w-28`} />
      </td>
      <td className="px-2 py-2 text-center align-top">
        <div className={`${bar} mx-auto h-4 w-4 rounded-[4px]`} />
      </td>
      <td className="px-2 py-2 align-top">
        <div className={`${bar} w-40`} />
      </td>
      <td className="px-2 py-2 align-top">
        <div className={`${bar} w-3/4`} />
      </td>
      {canEdit && <td className="px-1 py-2" />}
    </tr>
  );
}

/** One editable text cell — borderless until focused, so the grid reads like a sheet. */
function NoteCell({
  row,
  field,
  canEdit,
  onChange,
  onFocus,
  onBlur,
}: {
  row: PayrollWizardNoteRow;
  field: PayrollWizardNoteField;
  canEdit: boolean;
  onChange: (id: string, field: PayrollWizardNoteField, value: string) => void;
  onFocus: () => void;
  onBlur: (id: string, field: PayrollWizardNoteField) => void;
}) {
  const doneCls = row.done ? "text-zinc-400 line-through dark:text-zinc-500" : "";
  const lockCls = !canEdit ? "cursor-default hover:border-transparent" : "";

  // Enter = OK: commit the cell by blurring it (blur runs the save). In the
  // notes textarea, Shift+Enter still inserts a line break.
  const commitOnEnter = (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey) return;
    e.preventDefault();
    e.currentTarget.blur();
  };

  // Notes grow with their content (multi-line), so a long note never needs a
  // second row just to stay readable.
  if (field === "notes") {
    return (
      <textarea
        value={row[field] ?? ""}
        readOnly={!canEdit}
        rows={1}
        onChange={(e) => onChange(row.id, field, e.target.value)}
        onKeyDown={commitOnEnter}
        onFocus={() => canEdit && onFocus()}
        onBlur={() => canEdit && onBlur(row.id, field)}
        placeholder={canEdit ? "—" : ""}
        className={`field-sizing-content min-h-8 w-full resize-none rounded-md border border-transparent bg-transparent px-1.5 py-1.5 text-sm text-zinc-900 outline-none placeholder:text-zinc-400 hover:border-orange-200 focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 dark:text-zinc-100 dark:placeholder:text-zinc-500 dark:hover:border-blue-900 ${doneCls} ${lockCls}`}
      />
    );
  }

  return (
    <Input
      value={row[field] ?? ""}
      readOnly={!canEdit}
      onChange={(e) => onChange(row.id, field, e.target.value)}
      onKeyDown={commitOnEnter}
      onFocus={() => canEdit && onFocus()}
      onBlur={() => canEdit && onBlur(row.id, field)}
      placeholder={canEdit ? "—" : ""}
      className={`h-8 rounded-md border-transparent bg-transparent px-1.5 text-sm shadow-none hover:border-orange-200 focus-visible:ring-1 dark:hover:border-blue-900 ${doneCls} ${lockCls}`}
    />
  );
}
