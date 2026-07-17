"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useSession } from "next-auth/react";
import { AnimatePresence, motion } from "motion/react";
import {
  CalendarDays,
  CheckCheck,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ListChecks,
  Loader2,
  Plus,
  StickyNote,
  Trash2,
  User,
  Wallet,
  Zap,
} from "lucide-react";
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
  PayrollWorkerOption,
} from "@/lib/supabase/payroll-wizard-notes";
import { DEPARTMENTS } from "@/lib/payroll/department-bonus";
import {
  defaultOtRate,
  formatRate,
  type PayStructure,
} from "@/lib/payment-catalog/pay-structure";
import { manilaWeekStart, weekRangeLabel } from "@/lib/payroll/manila-week";
import {
  APPLY_NOTE_ADJUSTMENTS_EVENT,
  NOTE_ADJUSTMENT_REMOVED_EVENT,
} from "@/lib/payroll/adjustment-bridge";

/**
 * The Payroll Wizard's floating "Notes" checklist — carry-over items for the
 * next payroll week (missed bonuses, rate changes, staged deductions), the
 * digital version of the spreadsheet's "Phase 5: Adjustments" block.
 *
 * A pulsing sticky-note FAB sits over the wizard; clicking it opens a modal
 * with a fixed grid (Date | Payroll Clerk | Done | Worker | Adjustment | Notes).
 * Cells save on blur, Done saves on click, Add Row appends a pre-stamped
 * blank line. A period selector scopes the board to a payroll week: the live
 * week is the working checklist (this week's rows + open carry-overs + blank
 * seeds); a past week is that week's page as written, done items included.
 * Rendered in App.tsx OUTSIDE the wizard's strict ReadOnlyTab
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
  { field: "adjustment", label: "Adjustment", width: "w-40" },
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
  // Period selector: which payroll week (Manila Monday) the board is showing.
  // Defaults to — and follows — the live week; past weeks are read-back pages.
  const currentWeek = manilaWeekStart();
  const [weekStart, setWeekStart] = useState<string>(currentWeek);
  const isLiveWeek = weekStart === currentWeek;
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

  // Worker-cell suggestions: the people in the current Hubstaff timesheet CSV
  // — the same list the Payroll Wizard's Initial Calculation step shows, keyed
  // on the Hubstaff email so a picked worker links to the wizard's Adj. column.
  // Fetched once per session on first open; free text keeps working if the
  // fetch fails or while it's in flight.
  const [workers, setWorkers] = useState<PayrollWorkerOption[]>([]);
  useEffect(() => {
    if (!open || !canEdit || workers.length > 0) return;
    let alive = true;
    fetch("/api/payroll-wizard/notes/workers", { cache: "no-store" })
      .then(async (res) => (await res.json()) as { workers?: PayrollWorkerOption[] })
      .then((j) => {
        if (alive) setWorkers(j.workers ?? []);
      })
      .catch(() => {
        /* suggestions are an enhancement — typing stays free-form */
      });
    return () => {
      alive = false;
    };
  }, [open, canEdit, workers.length]);

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
    if (next === prev) return;
    const values: Partial<Record<PayrollWizardNoteField, string | null> & { done: boolean }> = {
      [field]: next === "" ? null : next,
    };
    // Keep the worker→email link honest: hand-typed text that exactly matches
    // a suggestion links to that person; anything else unlinks the row (so the
    // wizard's Adjustment bridge never targets the wrong human).
    if (field === "worker") {
      const match = workers.find((w) => w.name.toLowerCase() === next.toLowerCase());
      const nextEmail = match?.work_email ?? null;
      if ((saved?.worker_email ?? null) !== nextEmail) values.worker_email = nextEmail;
    }
    // A fresh change to an applied column (Worker / Adjustment) reopens a row
    // that had been filed as Done by "Apply Changes" — the new value hasn't
    // been applied to the wizard yet, so it must not keep its Done tick.
    // (Editing Date/Notes leaves Done alone — they don't change the amount.)
    if (row.done && (field === "worker" || field === "adjustment")) {
      values.done = false;
      setRows((p) => p.map((r) => (r.id === id ? { ...r, done: false } : r)));
    }
    // Clearing a linked row's Adjustment retracts its applied override too.
    if (field === "adjustment" && next === "" && prev !== "") {
      notifyAdjustmentRemoved(saved?.worker_email ?? row.worker_email, prev);
    }
    void saveRow(id, values);
  };

  /** Tell the wizard a linked adjustment left the board — the row was deleted
   *  or its Adjustment cell cleared — so a MATCHING Adj. override is deleted
   *  too (the wizard only clears when its current value still equals this
   *  amount; a hand-typed wizard figure is never touched). */
  const notifyAdjustmentRemoved = (workerEmail: string | null, adjustment: string | null) => {
    const email = (workerEmail ?? "").trim().toLowerCase();
    const text = (adjustment ?? "").trim();
    if (!email || !text) return;
    window.dispatchEvent(
      new CustomEvent(NOTE_ADJUSTMENT_REMOVED_EVENT, {
        detail: { workerEmail: email, adjustment: text },
      }),
    );
  };

  /** One clerk's "Apply Changes": hand THEIR rows to the wizard, which
   *  overwrites its Adj. overrides from them (linked workers with plain
   *  amounts). The event handshake tells us whether a live wizard took it —
   *  if it did, the modal closes so the Adj. column itself is visible. */
  const applyGroupAdjustments = (groupRows: PayrollWizardNoteRow[]) => {
    const ev = new CustomEvent(APPLY_NOTE_ADJUSTMENTS_EVENT, {
      cancelable: true,
      detail: { rowIds: groupRows.map((r) => r.id) },
    });
    const unhandled = window.dispatchEvent(ev);
    if (unhandled) {
      toast.info("The wizard can't apply right now", {
        description: "Load the live pay period first — replaying a past week is view-only.",
      });
      return;
    }
    setOpen(false);
  };

  /** A worker picked from the suggestion list — commit name + email link now
   *  (no blur needed; picking IS the decision). */
  const onPickWorker = (id: string, w: PayrollWorkerOption) => {
    // Picking a new worker on an already-applied (Done) row reopens it — the
    // adjustment now targets a different person and hasn't been re-applied.
    const wasDone = rows.find((r) => r.id === id)?.done === true;
    setRows((prev) =>
      prev.map((r) =>
        r.id === id
          ? { ...r, worker: w.name, worker_email: w.work_email, ...(wasDone ? { done: false } : {}) }
          : r,
      ),
    );
    void saveRow(
      id,
      wasDone
        ? { worker: w.name, worker_email: w.work_email, done: false }
        : { worker: w.name, worker_email: w.work_email },
    );
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
    const removed = prev.find((r) => r.id === id) ?? null;
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
      // A deleted note takes its applied adjustment with it (match-checked
      // wizard-side, so only an override this row produced is cleared).
      if (removed) notifyAdjustmentRemoved(removed.worker_email, removed.adjustment);
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
        (r.adjustment ?? "").trim() !== "" ||
        (r.notes ?? "").trim() !== ""),
  ).length;

  // The weeks the selector offers: the live week plus every week with notes on
  // file (kept stable if the selected week's rows vanish under a live refresh).
  const weekOptions = useMemo(() => {
    const set = new Set<string>([currentWeek, weekStart]);
    for (const r of rows) if (r.week_start) set.add(r.week_start);
    return [...set].sort((a, b) => b.localeCompare(a));
  }, [rows, currentWeek, weekStart]);

  // The selected week's slice of the board. The live week is the working
  // checklist: this week's rows, the blank seeds (week_start null), and every
  // still-open carry-over from a past week. A past week is that week's page —
  // exactly what was written then, done or not (ticking a carry-over files it
  // back under the week it was written).
  const weekRows = rows.filter((r) =>
    isLiveWeek
      ? r.week_start === null || r.week_start === currentWeek || !r.done
      : r.week_start === weekStart,
  );

  // Only my rows when the toggle is off (mine = rows I created, incl. my seeds).
  const visibleRows = showOthers
    ? weekRows
    : weekRows.filter((r) => (r.created_by ?? "").trim().toLowerCase() === selfEmail);

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
                  deduction in progress. <span className="font-medium">Apply Changes</span> pushes
                  your rows to the wizard and marks them <span className="font-medium">Done</span>;
                  editing a Worker or Adjustment reopens the row. Cells save automatically.
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

          <div className="flex flex-wrap items-center justify-between gap-2">
            <WeekSelector
              value={weekStart}
              currentWeek={currentWeek}
              options={weekOptions}
              onChange={setWeekStart}
            />
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
                  <th className="w-40 px-2 py-2">Adjustment</th>
                  <th className="min-w-96 px-2 py-2">Notes</th>
                  {canEdit && <th className="w-10 px-1 py-2" aria-label="Row actions" />}
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan={canEdit ? 7 : 6} className="px-3 py-8 text-center text-zinc-400">
                      <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />
                      Loading notes…
                    </td>
                  </tr>
                ) : visibleRows.length === 0 ? (
                  <tr>
                    <td colSpan={canEdit ? 7 : 6} className="px-3 py-8 text-center text-zinc-400">
                      {!isLiveWeek
                        ? `No notes were logged the week of ${weekRangeLabel(weekStart)}.`
                        : showOthers
                          ? "Nothing on the board yet."
                          : "You have no notes yet — flip on “Show everyone's notes” to see the rest of the board."}
                    </td>
                  </tr>
                ) : (
                  groups.map((group, gi) => (
                    <Fragment key={`${group.clerk}-${gi}`}>
                      {/* Divider: one section per clerk. The Apply button is
                          rendered ONLY on the signed-in clerk's own section —
                          each clerk applies their rows, nobody else's. */}
                      <tr className="border-t-2 border-orange-200/90 bg-orange-50/70 dark:border-blue-900/70 dark:bg-blue-950/40">
                        <td colSpan={canEdit ? 7 : 6} className="px-2 py-1">
                          <div className="flex min-h-6 items-center justify-between gap-2">
                            <span className="text-[11px] font-bold tracking-wider text-orange-700 uppercase dark:text-orange-300">
                              {group.clerk}
                            </span>
                            {canEdit && isOwnGroup(group) && (
                              <button
                                type="button"
                                onClick={() => applyGroupAdjustments(group.rows)}
                                title="Apply YOUR rows' Adjustment amounts to the wizard's Adj. column, then mark those rows Done (workers picked from the list, amounts like +₱500 / -$25 / COP 50,000). Editing a Worker or Adjustment reopens a row."
                                className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 ring-1 ring-emerald-400/40 transition-all hover:scale-[1.03] hover:bg-emerald-200 focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:outline-none dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-500/30 dark:hover:bg-emerald-950/70"
                              >
                                <CheckCheck className="h-3 w-3" />
                                Apply Changes
                              </button>
                            )}
                          </div>
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
                          {field === "worker" && canEdit ? (
                            <WorkerNoteCell
                              row={row}
                              workers={workers}
                              onChange={onCellChange}
                              onFocus={onCellFocus}
                              onBlur={onCellBlur}
                              onPick={onPickWorker}
                            />
                          ) : (
                            <NoteCell
                              row={row}
                              field={field}
                              canEdit={canEdit}
                              onChange={onCellChange}
                              onFocus={onCellFocus}
                              onBlur={onCellBlur}
                            />
                          )}
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
              {isLiveWeek ? (
                <Button type="button" variant="outline" size="sm" onClick={() => void addRow()} disabled={adding}>
                  {adding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                  Add Row
                </Button>
              ) : (
                <span className="text-xs text-zinc-400">
                  Viewing a past week — new rows are added on the live week.
                </span>
              )}
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

/**
 * Period selector for the notes board — prev/next arrows step through payroll
 * weeks (Manila Mondays), the dropdown lists the live week plus every past
 * week that has notes. Plain-button disclosure (same pattern as the QC
 * Overview's period selector) so Tab + Enter/Space work natively.
 */
function WeekSelector({
  value,
  currentWeek,
  options,
  onChange,
}: {
  value: string;
  currentWeek: string;
  options: string[]; // sorted newest-first, always contains value + currentWeek
  onChange: (weekStart: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const idx = options.indexOf(value);
  const isLive = value === currentWeek;
  const hasOlder = idx >= 0 && idx < options.length - 1;
  const hasNewer = idx > 0;

  const arrowCls =
    "rounded-md border border-orange-200/80 bg-white p-1 text-zinc-500 transition-colors hover:bg-orange-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-blue-900/60 dark:bg-blue-950/30 dark:text-zinc-400 dark:hover:bg-blue-950/50";

  return (
    <div ref={ref} className="relative inline-flex items-center gap-1">
      <button
        type="button"
        aria-label="Older week"
        disabled={!hasOlder}
        onClick={() => hasOlder && onChange(options[idx + 1]!)}
        className={arrowCls}
      >
        <ChevronLeft className="h-3.5 w-3.5" />
      </button>

      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="true"
        className="inline-flex items-center gap-2 rounded-lg border border-orange-200/80 bg-white px-2.5 py-1 text-left transition-colors hover:bg-orange-50 dark:border-blue-900/60 dark:bg-blue-950/30 dark:hover:bg-blue-950/50"
      >
        <CalendarDays className="h-3.5 w-3.5 text-orange-500 dark:text-orange-400" />
        <span className="text-xs font-semibold tracking-tight text-zinc-800 dark:text-zinc-100">
          {weekRangeLabel(value)}
        </span>
        <span
          className={`rounded-full px-1.5 py-0.5 font-mono text-[8px] font-semibold tracking-wide uppercase ${
            isLive
              ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300"
              : "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
          }`}
        >
          {isLive ? "Live" : "Past"}
        </span>
        <ChevronDown
          className={`h-3.5 w-3.5 text-zinc-400 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      <button
        type="button"
        aria-label="Newer week"
        disabled={!hasNewer}
        onClick={() => hasNewer && onChange(options[idx - 1]!)}
        className={arrowCls}
      >
        <ChevronRight className="h-3.5 w-3.5" />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.16, ease: EASE }}
            className="absolute top-full left-0 z-30 mt-1.5 w-60 overflow-hidden rounded-xl border border-orange-200/80 bg-white shadow-xl dark:border-blue-900/60 dark:bg-[#0d1117]"
          >
            <div className="flex items-center justify-between border-b border-orange-100 px-3 py-2 dark:border-blue-950/60">
              <span className="font-mono text-[9px] font-semibold tracking-[0.16em] text-zinc-500 uppercase">
                Payroll weeks
              </span>
              {!isLive && (
                <button
                  type="button"
                  onClick={() => {
                    onChange(currentWeek);
                    setOpen(false);
                  }}
                  className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-1.5 py-0.5 font-mono text-[9px] font-semibold tracking-wide text-emerald-700 uppercase transition-colors hover:bg-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-300 dark:hover:bg-emerald-950/70"
                >
                  <Zap className="h-2.5 w-2.5" /> Live
                </button>
              )}
            </div>
            <ul className="max-h-64 overflow-y-auto py-1">
              {options.map((w) => {
                const selected = w === value;
                const live = w === currentWeek;
                return (
                  <li key={w}>
                    <button
                      type="button"
                      onClick={() => {
                        onChange(w);
                        setOpen(false);
                      }}
                      className={`flex w-full items-center justify-between px-3 py-1.5 text-left text-xs transition-colors ${
                        selected
                          ? "bg-orange-50 font-semibold text-orange-700 dark:bg-blue-950/50 dark:text-orange-300"
                          : "text-zinc-700 hover:bg-orange-50/60 dark:text-zinc-200 dark:hover:bg-blue-950/40"
                      }`}
                    >
                      {weekRangeLabel(w)}
                      {live && (
                        <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 font-mono text-[8px] font-semibold tracking-wide text-emerald-700 uppercase dark:bg-emerald-950/50 dark:text-emerald-300">
                          Live
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>
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
        <div className={`${bar} w-24`} />
      </td>
      <td className="px-2 py-2 align-top">
        <div className={`${bar} w-3/4`} />
      </td>
      {canEdit && <td className="px-1 py-2" />}
    </tr>
  );
}

/** "Jul 10" from an offboarded_sheet timestamp, for the suggestion badge. */
function offboardedStamp(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "Asia/Manila" });
}

/**
 * The Worker cell: the same borderless sheet-style input as every other cell,
 * plus typeahead over the Global Master List and recently offboarded
 * employees (badged — they're the Last Pay cases the board exists for).
 * The list is a fixed-position popover PORTALLED to <body> so the table's
 * scroll container never clips it; options commit on mousedown-preventDefault
 * so the input keeps focus and the blur-save flow stays untouched. Picking
 * also links the row to the person's work email (the Adjustment bridge's key);
 * free text remains perfectly valid — it just carries no link.
 */
function WorkerNoteCell({
  row,
  workers,
  onChange,
  onFocus,
  onBlur,
  onPick,
}: {
  row: PayrollWizardNoteRow;
  workers: PayrollWorkerOption[];
  onChange: (id: string, field: PayrollWizardNoteField, value: string) => void;
  onFocus: () => void;
  onBlur: (id: string, field: PayrollWizardNoteField) => void;
  onPick: (id: string, w: PayrollWorkerOption) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [pos, setPos] = useState<{ topPx: number; bottomPx: number; left: number; flip: boolean } | null>(null);

  const POP_W = 320;
  const POP_MAX_H = 244;

  const q = (row.worker ?? "").trim().toLowerCase();
  // Name-starts-with matches first, then name/email-contains; capped so a
  // 1-letter query doesn't paint a 400-row list.
  const matches = useMemo(() => {
    if (!open || q === "") return [];
    const starts: PayrollWorkerOption[] = [];
    const contains: PayrollWorkerOption[] = [];
    for (const w of workers) {
      const name = w.name.toLowerCase();
      if (name.startsWith(q)) starts.push(w);
      else if (name.includes(q) || (w.work_email ?? "").includes(q)) contains.push(w);
    }
    return [...starts, ...contains].slice(0, 40);
  }, [workers, q, open]);

  const place = () => {
    const el = inputRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const below = window.innerHeight - r.bottom;
    const flip = below < POP_MAX_H + 12 && r.top > below;
    setPos({
      topPx: r.bottom + 4,
      bottomPx: window.innerHeight - r.top + 4,
      left: Math.max(8, Math.min(r.left, window.innerWidth - POP_W - 8)),
      flip,
    });
  };

  const close = () => {
    setOpen(false);
    setActive(-1);
  };

  // The popover follows TYPING only (focusing shouldn't unroll the roster).
  const onType = (value: string) => {
    onChange(row.id, "worker", value);
    setActive(-1);
    if (value.trim() === "") close();
    else {
      place();
      setOpen(true);
    }
  };

  // Outside scroll (the table's scroller included) and resize detach a fixed
  // popover — close it; the popover's own scroll must stay open.
  useEffect(() => {
    if (!open) return;
    const onScroll = (e: Event) => {
      const t = e.target as Node | null;
      if (t && popRef.current?.contains(t)) return;
      close();
    };
    const onResize = () => close();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (open && matches.length > 0 && e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, matches.length - 1));
    } else if (open && matches.length > 0 && e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (open && active >= 0 && active < matches.length) {
        onPick(row.id, matches[active]!);
        close();
      } else {
        close();
        e.currentTarget.blur(); // Enter = OK, same as every other cell
      }
    } else if (e.key === "Escape" && open) {
      // Close only the popover — never the surrounding modal.
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };

  const doneCls = row.done ? "text-zinc-400 line-through dark:text-zinc-500" : "";
  const showPop = open && matches.length > 0 && pos !== null;

  return (
    <>
      <Input
        ref={inputRef}
        value={row.worker ?? ""}
        role="combobox"
        aria-expanded={showPop}
        aria-autocomplete="list"
        onChange={(e) => onType(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={onFocus}
        onBlur={() => {
          close();
          onBlur(row.id, "worker");
        }}
        placeholder="—"
        className={`h-8 rounded-md border-transparent bg-transparent px-1.5 text-sm shadow-none hover:border-orange-200 focus-visible:ring-1 dark:hover:border-blue-900 ${doneCls}`}
      />
      {typeof document !== "undefined" &&
        createPortal(
          <AnimatePresence>
            {showPop && (
              <motion.div
                ref={popRef}
                role="listbox"
                initial={{ opacity: 0, y: pos.flip ? 4 : -4, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: pos.flip ? 4 : -4, scale: 0.98 }}
                transition={{ duration: 0.14, ease: EASE }}
                style={{
                  position: "fixed",
                  left: pos.left,
                  width: POP_W,
                  maxHeight: POP_MAX_H,
                  ...(pos.flip ? { bottom: pos.bottomPx } : { top: pos.topPx }),
                }}
                className="z-[140] overflow-y-auto overscroll-contain rounded-xl border border-orange-200/80 bg-white py-1 shadow-xl shadow-black/15 dark:border-blue-900/60 dark:bg-[#0d1117]"
              >
                {matches.map((w, i) => (
                  <button
                    key={`${w.name}|${w.work_email ?? ""}`}
                    type="button"
                    role="option"
                    aria-selected={i === active}
                    onMouseDown={(e) => e.preventDefault()} // keep the input focused
                    onMouseEnter={() => setActive(i)}
                    onClick={() => {
                      onPick(row.id, w);
                      close();
                    }}
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors ${
                      i === active ? "bg-orange-50 dark:bg-blue-950/50" : ""
                    }`}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium text-zinc-800 dark:text-zinc-100">
                        {w.name}
                      </span>
                      <span className="block truncate text-[10.5px] text-zinc-400 dark:text-zinc-500">
                        {[w.department, w.work_email].filter(Boolean).join(" · ") || "—"}
                      </span>
                    </span>
                    {w.off_boarded_at && (
                      <span
                        className="shrink-0 rounded-full bg-amber-100 px-1.5 py-0.5 text-[9px] font-semibold tracking-wide text-amber-700 uppercase dark:bg-amber-950/50 dark:text-amber-300"
                        title="Recently offboarded — likely a Last Pay item"
                      >
                        Offboarded {offboardedStamp(w.off_boarded_at)}
                      </span>
                    )}
                  </button>
                ))}
              </motion.div>
            )}
          </AnimatePresence>,
          document.body,
        )}
    </>
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
