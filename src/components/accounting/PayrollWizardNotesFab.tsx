"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import dynamic from "next/dynamic";
import { useSession } from "next-auth/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  AlertTriangle,
  Banknote,
  CalendarDays,
  CheckCheck,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Clock,
  ListChecks,
  Loader2,
  Lock,
  Pencil,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  StickyNote,
  Trash2,
  User,
  UserPlus,
  Wallet,
  X,
  Zap,
} from "lucide-react";
import { toast } from "sonner";
import { useLiveRefresh } from "@/hooks/useLiveRefresh";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { SmoothSelect } from "@/components/ui/smooth-select";
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
import { normalizeDeptToKey } from "@/lib/payroll/normalize-dept-key";
import { HSL_DEPTS, HSL_DEPT_KEYS, hslAccessKey, type HslDeptKey } from "@/lib/hsl-bonus/schema";
import type { EmployeeRow } from "@/lib/supabase/employees";
import {
  defaultOtRate,
  formatRate,
  newPayId,
  PAY_CURRENCIES,
  type PayCurrency,
  type PayStructure,
} from "@/lib/payment-catalog/pay-structure";
import {
  EMPLOYEE_SELECTABLE_PROCESSOR_OPTIONS,
  PROCESSOR_OPTIONS,
  type ProcessorId,
} from "@/lib/employee-payment-processors";
import { addWeeks, payrollNotesWeekStart, weekRangeLabel } from "@/lib/payroll/manila-week";
import { periodLabelFromFilename } from "@/lib/hubstaff/period-label";
import type {
  PayrollReadiness,
  ReadinessKpiDept,
  ReadinessMissingRate,
  ReadinessMissingBank,
  KpiDeptStatus,
  ExceptionKind,
  ReadinessScore,
} from "@/lib/payroll/payroll-readiness";
import {
  APPLY_NOTE_ADJUSTMENTS_EVENT,
  NOTE_ADJUSTMENT_REMOVED_EVENT,
  WIZARD_CYCLE_EVENT,
  REQUEST_WIZARD_CYCLE_EVENT,
  type WizardCycleDetail,
} from "@/lib/payroll/adjustment-bridge";
import { READINESS_SOURCE } from "@/lib/payroll/readiness-audit";

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

// The manager KPI calculators, mounted inside the Readiness "fix it from here"
// modal. Lazy so the (large) calculator bundles only load when a dept is
// actually clicked, never on the wizard page itself.
const DeptBonusCalculator = dynamic(() => import("@/components/manager/DeptBonusCalculator"), {
  ssr: false,
  loading: () => <KpiCalculatorLoadingLine />,
});
const HslBonusCalculator = dynamic(() => import("@/components/manager/HslBonusCalculator"), {
  ssr: false,
  loading: () => <KpiCalculatorLoadingLine />,
});

/** Centered spinner line while a lazy calculator chunk / its roster loads. */
function KpiCalculatorLoadingLine() {
  return (
    <div className="flex h-40 items-center justify-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
      <Loader2 className="h-4 w-4 animate-spin" />
      Loading the KPI Calculator…
    </div>
  );
}

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

/** Every per-row column a save/refresh response may change. Used when folding a
 *  server copy of a row into local state (see mergeRowPreservingDrafts). */
const ROW_MERGE_KEYS = [
  "note_date",
  "payroll_clerk",
  "done",
  "worker",
  "worker_email",
  "adjustment",
  "notes",
] as const;

/**
 * Server copy ⊕ local drafts. Any cell edited locally since `baseline` (the
 * last server snapshot this client saved or loaded) keeps its LOCAL value;
 * every other cell takes the server copy.
 *
 * This is what lets a PATCH response or a live refresh land while the user is
 * mid-keystroke in ANOTHER cell of the same row without deleting their typing:
 * cells save on blur, so blurring cell A fires a PATCH that resolves ~a second
 * later — by which time the user is already typing in cell B. A whole-row swap
 * (the old behavior) wiped cell B's draft on every save.
 */
function mergeRowPreservingDrafts(
  local: PayrollWizardNoteRow,
  baseline: PayrollWizardNoteRow | undefined,
  fresh: PayrollWizardNoteRow,
): PayrollWizardNoteRow {
  if (!baseline) return fresh;
  const merged = { ...fresh };
  for (const k of ROW_MERGE_KEYS) {
    if (local[k] !== baseline[k]) Object.assign(merged, { [k]: local[k] });
  }
  return merged;
}

/** localStorage key base for the per-user "show everyone's notes" preference. */
const SHOW_OTHERS_KEY = "payroll-wizard-notes:show-others";

/** The three modal panes. `checklist` is the original carry-over adjustments
 *  board (label reads "Adjustments and Notes"); `readiness` is the payroll-ready
 *  dashboard; `rates` is the Payment-Catalog glance. Kept left→right in this
 *  order so the directional slide reads naturally. */
type ModalTab = "checklist" | "readiness" | "rates";
const TAB_ORDER: ModalTab[] = ["checklist", "readiness", "rates"];

/** Shared easing — matches the app's tab transition (App.tsx / BonusCatalog). */
const EASE = [0.22, 1, 0.36, 1] as const;

/** Directional pane slide for the modal's tab swap — the incoming pane enters
 *  from the side you moved toward and the outgoing one leaves the opposite way
 *  (§11.1). `custom` carries the direction (+1 forward / −1 back). */
const PANE_VARIANTS = {
  enter: (dir: number) => ({ opacity: 0, x: dir >= 0 ? 24 : -24 }),
  center: { opacity: 1, x: 0 },
  exit: (dir: number) => ({ opacity: 0, x: dir >= 0 ? -24 : 24 }),
};

export default function PayrollWizardNotesFab({
  sessionEmail,
  canEdit,
}: {
  sessionEmail: string | null;
  canEdit: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [modalTab, setModalTab] = useState<ModalTab>("checklist");
  const reduceMotion = useReducedMotion();
  // Which way the pane slide travels: +1 when moving toward a later tab,
  // −1 toward an earlier one, so a 3-tab switch reads like turning pages.
  const [tabDir, setTabDir] = useState(0);
  const changeTab = useCallback(
    (next: ModalTab) => {
      setModalTab((cur) => {
        if (cur === next) return cur;
        setTabDir(TAB_ORDER.indexOf(next) >= TAB_ORDER.indexOf(cur) ? 1 : -1);
        return next;
      });
    },
    [],
  );
  // The Hubstaff upload the Payroll Wizard is CURRENTLY on (possibly a replayed
  // past week), learned from its WIZARD_CYCLE broadcast. The Readiness tab keys
  // its snapshot on this so it always describes the same week the wizard shows.
  // `undefined` = not heard from the wizard yet (fall back to the live upload
  // server-side); a string / null = the wizard's actual selection.
  // `heard` flips true once the wizard answers, so a null answer (wizard's file
  // not settled yet) is distinguishable from "never replied". The value itself
  // is the wizard's `calcSourceFile` verbatim (string = a chosen week incl.
  // replays, null = no upload yet).
  const [wizardSourceFile, setWizardSourceFile] = useState<string | null>(null);
  const [heardWizard, setHeardWizard] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onCycle = (e: Event) => {
      const detail = (e as CustomEvent<WizardCycleDetail>).detail;
      setWizardSourceFile(detail?.sourceFile ?? null);
      setHeardWizard(true);
    };
    window.addEventListener(WIZARD_CYCLE_EVENT, onCycle);
    return () => window.removeEventListener(WIZARD_CYCLE_EVENT, onCycle);
  }, []);
  // Ask the (sibling) wizard which week it's on. The two mount independently and
  // the wizard's file may not be settled at first ask, so we retry a handful of
  // times (short backoff) until it answers, and again every time the modal opens
  // — so the Readiness snapshot always keys on the wizard's live CSV selection.
  useEffect(() => {
    if (typeof window === "undefined") return;
    let tries = 0;
    const ping = () => window.dispatchEvent(new CustomEvent(REQUEST_WIZARD_CYCLE_EVENT));
    ping();
    const timer = window.setInterval(() => {
      tries += 1;
      ping();
      // Stop once the wizard has answered or after ~3.2s of trying (it may not
      // be mounted at all — e.g. the board opened from a non-wizard surface).
      if (heardWizard || tries >= 8) window.clearInterval(timer);
    }, 400);
    return () => window.clearInterval(timer);
  }, [open, heardWizard]);
  // Period selector: which pay period (Sunday–Saturday) the board is showing.
  // Defaults to — and follows — the live period, i.e. the just-completed week
  // being paid now (payroll runs a week in arrears); past weeks are read-back
  // pages. See payrollNotesWeekStart() for why this trails the calendar week.
  const currentWeek = payrollNotesWeekStart();
  const [weekStart, setWeekStart] = useState<string>(currentWeek);
  const isLiveWeek = weekStart === currentWeek;
  // Past periods are history (read-only); the live period and any upcoming one
  // accept new rows so clerks can stage next week's notes ahead of time.
  const isPastWeek = weekStart < currentWeek;
  const isFutureWeek = weekStart > currentWeek;
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
    // Snapshot the OLD baselines before replacing them — the setRows updater
    // runs later (during render), by which time savedRef already holds the
    // fresh copies and every local draft would look "unchanged".
    const baseline = savedRef.current;
    savedRef.current = new Map(next.map((r) => [r.id, r]));
    setRows((prev) => {
      const localById = new Map(prev.map((r) => [r.id, r]));
      // Keep locally-edited cells (in-flight saves, mid-typing drafts) even
      // when a refresh lands — the server copy wins only where we're clean.
      return next.map((fresh) => {
        const local = localById.get(fresh.id);
        return local ? mergeRowPreservingDrafts(local, baseline.get(fresh.id), fresh) : fresh;
      });
    });
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
        const baseline = savedRef.current.get(id);
        savedRef.current.set(id, fresh);
        // Merge, never swap: by the time this PATCH resolves the user is often
        // already typing in the row's NEXT cell (cells save on blur) — a
        // whole-row replace deleted that draft mid-keystroke.
        setRows((prev) =>
          prev.map((r) => (r.id === id ? mergeRowPreservingDrafts(r, baseline, fresh) : r)),
        );
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not save the note");
        // Roll back ONLY the cells this PATCH tried to change — a draft the
        // user is typing in another cell of the row must survive the failure.
        const last = savedRef.current.get(id);
        if (last) {
          const failed = Object.keys(values) as (keyof PayrollWizardNoteRow)[];
          setRows((prev) =>
            prev.map((r) => {
              if (r.id !== id) return r;
              const rolled = { ...r };
              for (const k of failed) {
                if (k in last) Object.assign(rolled, { [k]: last[k] });
              }
              return rolled;
            }),
          );
        }
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
        // Stamp the row to the period in view — the live week normally, or the
        // upcoming week when a clerk is staging ahead (server refuses past).
        body: JSON.stringify({
          values: { note_date: todayStamp(), payroll_clerk: clerkName },
          weekStart,
        }),
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

  // The weeks the selector offers: the live week, next week (always listed so
  // staging ahead is discoverable), the current selection, plus every week with
  // notes on file (kept stable if the selected week's rows vanish on refresh).
  // The arrows can still step to any week beyond these.
  const weekOptions = useMemo(() => {
    const set = new Set<string>([currentWeek, addWeeks(currentWeek, 1), weekStart]);
    for (const r of rows) if (r.week_start) set.add(r.week_start);
    return [...set].sort((a, b) => b.localeCompare(a));
  }, [rows, currentWeek, weekStart]);

  // The selected week's slice of the board. The live week is the working
  // checklist: this week's rows, the blank seeds (week_start null), and every
  // still-open carry-over from a PAST week (future-staged rows stay on their
  // own upcoming page — they aren't due yet, so they don't clutter "now"). A
  // past/future week is that week's page — exactly what was written for it,
  // done or not (ticking a carry-over files it back under its own week).
  const weekRows = rows.filter((r) =>
    isLiveWeek
      ? r.week_start === null ||
        r.week_start === currentWeek ||
        (!r.done && r.week_start !== null && r.week_start < currentWeek)
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
        aria-label={`Open payroll notes and readiness${openCount > 0 ? ` (${openCount} open)` : ""}`}
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
              ) : modalTab === "readiness" ? (
                <>
                  Everything that has to be settled before this week&apos;s payroll can run — which
                  departments have submitted their KPIs, who still has no pay rate or bank details,
                  and who&apos;s a known exception. Green all the way down means you&apos;re{" "}
                  <span className="font-medium">Payroll Ready</span>.
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
                { id: "checklist", label: "Adjustments and Notes", icon: ListChecks },
                { id: "readiness", label: "Readiness", icon: ShieldCheck },
                { id: "rates", label: "Rates", icon: Wallet },
              ] as const
            ).map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={modalTab === t.id}
                onClick={() => changeTab(t.id)}
                className={`relative -mb-px flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium transition-colors ${
                  modalTab === t.id
                    ? "text-orange-700 dark:text-orange-300"
                    : "text-zinc-500 hover:bg-orange-50/60 hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-blue-950/30 dark:hover:text-zinc-200"
                }`}
              >
                <t.icon className="h-4 w-4" />
                {t.label}
                {modalTab === t.id && (
                  <motion.span
                    layoutId="pw-notes-tab-underline"
                    className="absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-orange-500 dark:bg-orange-400"
                    transition={{ duration: reduceMotion ? 0 : 0.3, ease: EASE }}
                  />
                )}
              </button>
            ))}
          </div>

          {/* Directional cross-fade between the three panes: the slide follows
              which tab you moved toward (tabDir), and every pane keeps the same
              h-[70vh] body height so the dialog never jumps mid-swap. Gated on
              reduced motion. */}
          <div className="overflow-x-clip">
          <AnimatePresence mode="wait" initial={false} custom={tabDir}>
          {modalTab === "rates" ? (
            <motion.div
              key="rates"
              custom={tabDir}
              variants={PANE_VARIANTS}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ duration: reduceMotion ? 0 : 0.24, ease: EASE }}
            >
              <RatesGlance />
            </motion.div>
          ) : modalTab === "readiness" ? (
            <motion.div
              key="readiness"
              custom={tabDir}
              variants={PANE_VARIANTS}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ duration: reduceMotion ? 0 : 0.24, ease: EASE }}
            >
              <PayrollReadinessGlance
                wizardSourceFile={wizardSourceFile}
                heardWizard={heardWizard}
                canEdit={canEdit}
                viewerEmail={sessionEmail}
              />
            </motion.div>
          ) : (
            <motion.div
              key="checklist"
              custom={tabDir}
              variants={PANE_VARIANTS}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ duration: reduceMotion ? 0 : 0.24, ease: EASE }}
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
                      {isPastWeek
                        ? `No notes were logged the week of ${weekRangeLabel(weekStart)}.`
                        : isFutureWeek
                          ? `Nothing staged yet for the week of ${weekRangeLabel(weekStart)} — add a row to get ahead.`
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
                            {/* Apply pushes into the CURRENT wizard run, so it
                                only appears on the live period — never a
                                past page or a staged upcoming one. */}
                            {canEdit && isLiveWeek && isOwnGroup(group) && (
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
              {!isPastWeek ? (
                <Button type="button" variant="outline" size="sm" onClick={() => void addRow()} disabled={adding}>
                  {adding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                  {isFutureWeek ? "Add Row (upcoming week)" : "Add Row"}
                </Button>
              ) : (
                <span className="text-xs text-zinc-400">
                  Viewing a past week — new rows are added on the current or an upcoming week.
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
          </div>
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

/* ────────────────────────────────────────────────────────────────────────────
 * Readiness tab — "are we Payroll Ready?"
 * ──────────────────────────────────────────────────────────────────────────── */

/** Tiny-caps status pill (§8.2) tones by KPI dept status. */
const KPI_STATUS_PILL: Record<KpiDeptStatus, { label: string; cls: string; Icon: typeof CheckCircle2 }> = {
  locked: {
    label: "Locked",
    cls: "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300",
    Icon: Lock,
  },
  ready: {
    label: "Ready",
    cls: "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300",
    Icon: CheckCircle2,
  },
  draft: {
    label: "Pending",
    cls: "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300",
    Icon: Clock,
  },
  na: {
    label: "Not due",
    cls: "border-zinc-200 bg-zinc-50 text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400",
    Icon: Clock,
  },
  // No Payment Catalog bonus the manager could apply this week — the
  // catalog-driven calculator has nothing to submit, so it reads Ready.
  no_bonus: {
    label: "Ready",
    cls: "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300",
    Icon: CheckCircle2,
  },
};

/** A KPI dept is "settled" for the week when its manager marked it ready/locked,
 *  it isn't due this week, or it has no bonus configured at all. Draft = still
 *  left to do. */
function isKpiSettled(s: KpiDeptStatus): boolean {
  return s === "ready" || s === "locked" || s === "na" || s === "no_bonus";
}

const EXCEPTION_META: Record<ExceptionKind, { label: string; cls: string; Icon: typeof UserPlus }> = {
  onboarding: {
    label: "Onboarding",
    cls: "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-300",
    Icon: UserPlus,
  },
  awaiting_orientation: {
    label: "Awaiting orientation",
    cls: "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300",
    Icon: Clock,
  },
  no_show: {
    label: "No-show",
    cls: "border-zinc-200 bg-zinc-50 text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400",
    Icon: AlertTriangle,
  },
  started_this_week: {
    label: "Started this week",
    cls: "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-300",
    Icon: UserPlus,
  },
};

/** The Readiness pane's four inner tabs — one per detail list. Left→right order
 *  matches the stat-tile row, so the directional slide reads naturally. */
type ReadinessTab = "kpi" | "rate" | "bank" | "exc";
const READINESS_TAB_ORDER: ReadinessTab[] = ["kpi", "rate", "bank", "exc"];

/** A single readiness stat tile (§6.3) — a read-only summary count. `tone` picks
 *  the palette. (Switching between the four detail lists is the job of the
 *  explicit tab strip below the tiles, not the tiles themselves.) */
function ReadinessStat({
  label,
  value,
  sub,
  tone,
  Icon,
}: {
  label: string;
  value: number | string;
  sub: string;
  tone: "emerald" | "amber" | "sky" | "orange";
  Icon: typeof CheckCircle2;
}) {
  const palette: Record<string, { ring: string; icon: string; text: string }> = {
    emerald: {
      ring: "from-emerald-200/40 to-teal-200/40",
      icon: "from-emerald-500 to-teal-500",
      text: "text-emerald-700 dark:text-emerald-300",
    },
    amber: {
      ring: "from-amber-200/40 to-orange-200/40",
      icon: "from-amber-500 to-orange-500",
      text: "text-amber-700 dark:text-amber-300",
    },
    sky: {
      ring: "from-sky-200/40 to-blue-200/40",
      icon: "from-sky-500 to-blue-500",
      text: "text-sky-700 dark:text-sky-300",
    },
    orange: {
      ring: "from-orange-200/40 to-rose-200/40",
      icon: "from-orange-500 to-rose-500",
      text: "text-orange-700 dark:text-orange-300",
    },
  };
  const p = palette[tone]!;
  return (
    <div className="relative overflow-hidden rounded-xl border border-white/60 bg-white/70 p-2.5 backdrop-blur-md sm:p-3 dark:border-zinc-800 dark:bg-zinc-900/60">
      <div className={`absolute inset-0 bg-gradient-to-br opacity-60 ${p.ring}`} aria-hidden />
      <div className="relative flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className={`text-[9px] font-semibold uppercase tracking-[0.14em] ${p.text}`}>{label}</div>
          <div className="mt-0.5 text-base font-bold tracking-tight tabular-nums sm:text-lg">{value}</div>
          <div className="mt-0.5 truncate text-[10px] text-zinc-500 dark:text-zinc-400">{sub}</div>
        </div>
        <div className={`hidden h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br ${p.icon} text-white sm:flex`}>
          <Icon className="h-4 w-4" />
        </div>
      </div>
    </div>
  );
}

/** Explicit tab strip for the Readiness pane — one labeled tab per detail list,
 *  each with icon, name, and a live count badge, plus a sliding `layoutId`
 *  underline under the active tab (matching the modal's top-level tabs). This is
 *  the control the user reaches for to switch between KPI Submissions, No Pay
 *  Rate, Bank Info, and Exceptions. Horizontally scrollable on narrow widths so
 *  all four stay reachable. */
function ReadinessTabStrip({
  active,
  onPick,
  counts,
  reduceMotion,
}: {
  active: ReadinessTab;
  onPick: (t: ReadinessTab) => void;
  counts: Record<ReadinessTab, number>;
  reduceMotion: boolean;
}) {
  // `blocker` = a no-rate worker can't be paid at all (rose). `neutral` =
  // informational, never blocks Payroll Ready (sky) — exceptions are expected
  // non-payments, so their count must NOT read as a warning to clear (mirrors
  // the sky stat tile + the hero excluding exceptions from the verdict).
  const TABS: { id: ReadinessTab; label: string; Icon: typeof CheckCircle2; blocker?: boolean; neutral?: boolean }[] = [
    { id: "kpi", label: "KPI Submissions", Icon: ClipboardList },
    { id: "rate", label: "No Pay Rate", Icon: Wallet, blocker: true },
    { id: "bank", label: "Bank Info", Icon: Banknote },
    { id: "exc", label: "Exceptions", Icon: UserPlus, neutral: true },
  ];
  return (
    <div
      role="tablist"
      aria-label="Readiness details"
      className="flex items-center gap-1 overflow-x-auto border-b border-orange-100 pb-px dark:border-blue-950/60"
    >
      {TABS.map((t) => {
        const isActive = active === t.id;
        const count = counts[t.id];
        // Count badge tone: clear (0) reads emerald; a no-rate count is a hard
        // blocker (rose); an informational count (exceptions) reads neutral sky;
        // anything else is a warning to clear (amber).
        const badgeCls =
          count === 0
            ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300"
            : t.blocker
              ? "bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300"
              : t.neutral
                ? "bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300"
                : "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300";
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onPick(t.id)}
            className={`relative -mb-px flex shrink-0 items-center gap-1.5 rounded-t-lg px-3 py-2 text-xs font-semibold whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400/60 ${
              isActive
                ? "text-orange-700 dark:text-orange-300"
                : "text-zinc-500 hover:bg-orange-50/60 hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-blue-950/30 dark:hover:text-zinc-200"
            }`}
          >
            <t.Icon className="h-3.5 w-3.5" />
            {t.label}
            <span className={`inline-flex min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold tabular-nums ${badgeCls}`}>
              {count}
            </span>
            {isActive && (
              <motion.span
                layoutId="readiness-tab-underline"
                className="absolute inset-x-1 -bottom-px h-0.5 rounded-full bg-orange-500 dark:bg-orange-400"
                transition={{ duration: reduceMotion ? 0 : 0.3, ease: EASE }}
              />
            )}
          </button>
        );
      })}
    </div>
  );
}

/** The framed body for one tab's detail list. Header-less by design: the tab
 *  strip above already owns the label + count + status colour (so a per-section
 *  header would duplicate all three within a few pixels). This is just the
 *  rounded, padded container the list sits in. */
function PaneBody({ children }: { children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-orange-100 bg-white/60 p-2.5 dark:border-blue-950/60 dark:bg-blue-950/10">
      {children}
    </section>
  );
}

/** Empty "all clear" line for a settled section (§12.1, compact). */
function AllClear({ text }: { text: string }) {
  return (
    <div className="flex items-center justify-center gap-2 px-3 py-4 text-xs text-emerald-600 dark:text-emerald-400">
      <CheckCircle2 className="h-4 w-4" />
      {text}
    </div>
  );
}

/** Case-insensitive "every field contains the query" test. Empty query passes. */
function matchesQuery(query: string, ...fields: (string | null | undefined)[]): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = fields.filter(Boolean).join(" ").toLowerCase();
  return hay.includes(q);
}

/** Compact per-section search input (§9.2, scaled to the readiness lists). Shows
 *  a live result count and a clear affordance while a query is active. */
function ReadinessSearch({
  value,
  onChange,
  placeholder,
  shown,
  total,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  shown: number;
  total: number;
}) {
  const active = value.trim() !== "";
  return (
    <div className="relative mb-2">
      <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="h-7 rounded-md pr-16 pl-8 text-xs focus-visible:ring-orange-200 dark:focus-visible:ring-blue-900"
      />
      <div className="absolute top-1/2 right-1.5 flex -translate-y-1/2 items-center gap-1">
        {active && (
          <>
            <span className="text-[10px] tabular-nums text-zinc-400">
              {shown}/{total}
            </span>
            <button
              type="button"
              onClick={() => onChange("")}
              aria-label="Clear search"
              className="rounded p-0.5 text-zinc-400 transition-colors hover:bg-orange-100/70 hover:text-zinc-700 dark:hover:bg-blue-950/50 dark:hover:text-zinc-200"
            >
              <X className="h-3 w-3" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** "No matches" line for a filtered-empty list. */
function NoMatches({ query }: { query: string }) {
  return (
    <div className="px-3 py-4 text-center text-xs text-zinc-400">
      No matches for <span className="font-mono text-zinc-500 dark:text-zinc-300">“{query.trim()}”</span>
    </div>
  );
}

/** Rows per page for the paginated people lists (No Pay Rate / Bank Info /
 *  Exceptions). Ten keeps a page short enough to scan without scrolling. */
const READINESS_PAGE_SIZE = 10;

/**
 * Client-side pagination over an already-filtered list. Returns the current
 * page's slice plus the controls state. Resets to page 1 whenever `resetKey`
 * changes (a new search query) so you never land on a now-empty page; and clamps
 * the page down if the list shrinks under it (a live refresh removing rows, or
 * the filter narrowing the count) so the view never sticks past the last page.
 */
function usePagedList<T>(items: T[], resetKey: string) {
  const [page, setPage] = useState(0); // zero-based
  const pageCount = Math.max(1, Math.ceil(items.length / READINESS_PAGE_SIZE));

  // New query → back to the first page.
  useEffect(() => {
    setPage(0);
  }, [resetKey]);

  // List shrank under the current page → clamp to the last valid page.
  useEffect(() => {
    setPage((p) => Math.min(p, pageCount - 1));
  }, [pageCount]);

  const safePage = Math.min(page, pageCount - 1);
  const start = safePage * READINESS_PAGE_SIZE;
  const pageItems = useMemo(
    () => items.slice(start, start + READINESS_PAGE_SIZE),
    [items, start],
  );
  return {
    pageItems,
    page: safePage,
    pageCount,
    setPage,
    total: items.length,
    // 1-based window bounds for the "Showing X–Y of N" caption.
    from: items.length === 0 ? 0 : start + 1,
    to: Math.min(start + READINESS_PAGE_SIZE, items.length),
  };
}

/**
 * Pager for a Readiness people list — a "Showing X–Y of N" caption on the left
 * and Prev / page-indicator / Next on the right. Renders nothing when the whole
 * list fits on one page (≤ one page of rows), so short lists stay clean.
 */
function ReadinessPager({
  page,
  pageCount,
  from,
  to,
  total,
  onPage,
}: {
  page: number; // zero-based
  pageCount: number;
  from: number;
  to: number;
  total: number;
  onPage: (p: number) => void;
}) {
  if (pageCount <= 1) return null;
  const btn =
    "inline-flex items-center gap-1 rounded-md border border-orange-200/80 bg-white px-2 py-1 text-[11px] font-medium text-zinc-600 transition-colors hover:bg-orange-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-blue-900/60 dark:bg-blue-950/30 dark:text-zinc-300 dark:hover:bg-blue-950/50";
  return (
    <div className="mt-2 flex items-center justify-between gap-2 border-t border-orange-100/70 px-1 pt-2 dark:border-blue-950/50">
      <span className="text-[11px] tabular-nums text-zinc-500 dark:text-zinc-400">
        Showing <span className="font-semibold text-zinc-700 dark:text-zinc-200">{from}–{to}</span> of{" "}
        <span className="font-semibold text-zinc-700 dark:text-zinc-200">{total}</span>
      </span>
      <div className="flex items-center gap-1.5">
        <button type="button" onClick={() => onPage(page - 1)} disabled={page === 0} className={btn} aria-label="Previous page">
          <ChevronLeft className="h-3.5 w-3.5" />
          Prev
        </button>
        <span className="px-1 text-[11px] font-semibold tabular-nums text-zinc-500 dark:text-zinc-400">
          {page + 1} / {pageCount}
        </span>
        <button
          type="button"
          onClick={() => onPage(page + 1)}
          disabled={page >= pageCount - 1}
          className={btn}
          aria-label="Next page"
        >
          Next
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

/** One KPI department row: name + a completeness bar (how much is LEFT) + a
 *  status pill. The bar fills emerald when settled, amber while still open.
 *  With `onOpen` the row is a button that pops that dept's KPI Calculator. */
function KpiDeptRow({
  dept,
  reduceMotion,
  onOpen,
}: {
  dept: ReadinessKpiDept;
  reduceMotion: boolean;
  onOpen?: () => void;
}) {
  const settled = isKpiSettled(dept.status);
  const pct =
    dept.employeeCount > 0
      ? Math.round((dept.scoredCount / dept.employeeCount) * 100)
      : settled
        ? 100
        : 0;
  const pill = KPI_STATUS_PILL[dept.status];
  const barCls = settled
    ? "bg-gradient-to-r from-emerald-400 to-teal-500"
    : "bg-gradient-to-r from-amber-400 to-orange-500";
  const rowCls =
    "flex w-full items-center gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-orange-50/50 dark:hover:bg-blue-950/30";
  const inner = (
    <>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-medium text-zinc-800 dark:text-zinc-100">{dept.name}</span>
          {dept.source === "hsl" && (
            <span className="shrink-0 rounded bg-blue-100/70 px-1 py-px text-[8.5px] font-semibold uppercase tracking-wide text-blue-700 dark:bg-blue-900/50 dark:text-blue-200">
              HSL
            </span>
          )}
          {dept.source === "custom" && (
            <span className="shrink-0 rounded bg-orange-100/70 px-1 py-px text-[8.5px] font-semibold uppercase tracking-wide text-orange-700 dark:bg-blue-900/50 dark:text-blue-200">
              In-app
            </span>
          )}
        </div>
        {/* Completeness bar — scored vs expected. */}
        <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
          <motion.div
            className={`h-full rounded-full ${barCls}`}
            initial={{ width: 0 }}
            animate={{ width: `${pct}%` }}
            transition={{ duration: reduceMotion ? 0 : 0.5, ease: EASE }}
          />
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-0.5">
        <span className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] ${pill.cls}`}>
          <pill.Icon className="h-2.5 w-2.5" />
          {pill.label}
        </span>
        {dept.status === "no_bonus" ? (
          <span className="text-[9.5px] text-zinc-400 dark:text-zinc-500">no bonus set</span>
        ) : (
          dept.employeeCount > 0 && (
            <span className="text-[9.5px] tabular-nums text-zinc-400 dark:text-zinc-500">
              {dept.scoredCount}/{dept.employeeCount} scored
            </span>
          )
        )}
      </div>
    </>
  );
  if (onOpen) {
    return (
      <button
        type="button"
        onClick={onOpen}
        title={`Open the ${dept.name} KPI Calculator`}
        className={`${rowCls} cursor-pointer text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400/60`}
      >
        {inner}
      </button>
    );
  }
  return <div className={rowCls}>{inner}</div>;
}

/** A compact person row for the missing-rate / missing-bank / exceptions lists. */
function PersonLine({
  name,
  email,
  department,
  right,
}: {
  name: string;
  email: string | null;
  department: string | null;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-orange-50/50 dark:hover:bg-blue-950/30">
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium text-zinc-800 dark:text-zinc-100">{name}</div>
        <div className="truncate text-[10px] text-zinc-400 dark:text-zinc-500">
          {[department, email].filter(Boolean).join(" · ") || "—"}
        </div>
      </div>
      {right}
    </div>
  );
}

/**
 * Maps a readiness row's raw department label to a canonical Payment Catalog
 * department key. Any HSL sub-department label ("HSL:intake_specialist",
 * "HSL - Intake", an hsl_bonus dept key or display name) files under the ONE
 * Hogan Smith Law department — HSL people get a single catalog dept, never one
 * per sub-team.
 */
function catalogDeptKeyFromLabel(raw: string | null): string {
  const s = (raw ?? "").trim();
  if (!s) return "";
  const direct = normalizeDeptToKey(s);
  if (direct) return direct;
  const lower = s.toLowerCase();
  if (lower.startsWith("hsl") || lower.includes("hogan")) return "hogan_smith_law";
  const bare = lower.replace(/^hsl[\s:_-]+/, "");
  if (
    HSL_DEPT_KEYS.some(
      (k) => k === lower || k === bare || HSL_DEPTS[k].name.toLowerCase() === lower,
    )
  ) {
    return "hogan_smith_law";
  }
  return "";
}

/** Small inline "fix it" action on a readiness person row. */
function RowFixButton({
  label,
  onClick,
  disabled,
  title,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-orange-200/80 bg-white px-2 py-1 text-[10px] font-semibold whitespace-nowrap text-orange-700 transition-colors hover:bg-orange-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-blue-900/60 dark:bg-blue-950/30 dark:text-orange-300 dark:hover:bg-blue-950/50"
    >
      <Pencil className="h-3 w-3" />
      {label}
    </button>
  );
}

/** Shared field label + input classes for the two readiness editors. */
const EDITOR_LABEL_CLS =
  "text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-500 dark:text-zinc-400";
const EDITOR_SELECT_CLS =
  "h-8 w-full rounded-md border border-orange-200/80 bg-white px-2 text-xs text-zinc-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-200 disabled:cursor-not-allowed disabled:opacity-60 dark:border-blue-900/60 dark:bg-blue-950/30 dark:text-zinc-100 dark:focus-visible:ring-blue-900";

/**
 * "Set rate" editor for a No Pay Rate row — files an EMPLOYEE-scoped Payment
 * Catalog pay structure (the top of the rate chain: individual catalog → sheet
 * → dept base), so the person resolves a rate the moment it saves. Department
 * defaults from the row's label; HSL sub-departments all file under Hogan
 * Smith Law. Saves via POST /api/payment-catalog/pay-structures, which also
 * syncs rate history / the rates sheet and notifies the employee.
 */
function SetRateDialog({
  person,
  onClose,
  onSaved,
}: {
  person: ReadinessMissingRate;
  onClose: () => void;
  onSaved: () => void;
}) {
  const mappedKey = catalogDeptKeyFromLabel(person.department);
  const [deptKey, setDeptKey] = useState(mappedKey);
  const [regular, setRegular] = useState("");
  const [ot, setOt] = useState("");
  const [currency, setCurrency] = useState<PayCurrency>("PHP");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const regNum = Number(regular);
  const regOk = regular.trim() !== "" && Number.isFinite(regNum) && regNum > 0;
  const autoOt = regOk ? defaultOtRate(regNum) : null;
  // Surfaces the HSL grouping so an "HSL:intake_specialist" label saving under
  // Hogan Smith Law never reads as a bug.
  const isHslSub =
    mappedKey === "hogan_smith_law" &&
    (person.department ?? "").trim().toLowerCase() !== "hogan smith law";

  const save = async () => {
    if (!person.email) {
      setError("This worker has no email on the roster — set their rate from the Payment Catalog instead.");
      return;
    }
    if (!deptKey) {
      setError("Pick the department this rate files under.");
      return;
    }
    if (!regOk) {
      setError("Enter a regular hourly rate above zero.");
      return;
    }
    const otNum = ot.trim() === "" ? autoOt : Number(ot);
    if (otNum == null || !Number.isFinite(otNum) || otNum < 0) {
      setError("OT rate must be a non-negative number.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const structure: PayStructure = {
        id: newPayId(),
        scope: "employee",
        departmentKey: deptKey,
        employeeEmail: person.email.trim().toLowerCase(),
        employeeName: person.name,
        regularRate: regNum,
        otRate: otNum,
        currency,
      };
      const res = await fetch("/api/payment-catalog/pay-structures", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Tag the origin so the rate reads "Set from Payroll Wizard by <actor>"
        // in the Payment Catalog's Rate History + the Audit Log.
        body: JSON.stringify({ structure, source: READINESS_SOURCE }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string | null };
      if (!res.ok || json.error) throw new Error(json.error || `Save failed (${res.status})`);
      toast.success(`Rate set for ${person.name}`, {
        description: `${formatRate(regNum, currency)} · ${
          DEPARTMENTS.find((d) => d.key === deptKey)?.name ?? deptKey
        }`,
      });
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the rate");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wallet className="h-4 w-4 text-orange-500" />
            Set pay rate
          </DialogTitle>
          <DialogDescription>
            {person.name}
            {person.email ? ` · ${person.email}` : ""} — saves an individual rate to the
            Payment Catalog, effective immediately.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1">
            <label className={EDITOR_LABEL_CLS} htmlFor="readiness-rate-dept">
              Department
            </label>
            <select
              id="readiness-rate-dept"
              value={deptKey}
              onChange={(e) => setDeptKey(e.target.value)}
              className={EDITOR_SELECT_CLS}
            >
              <option value="">Pick a department…</option>
              {DEPARTMENTS.map((d) => (
                <option key={d.key} value={d.key}>
                  {d.name}
                </option>
              ))}
            </select>
            {isHslSub && (
              <p className="text-[10px] text-zinc-400 dark:text-zinc-500">
                {person.department} is an HSL sub-department — the rate files under Hogan
                Smith Law.
              </p>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="grid gap-1">
              <label className={EDITOR_LABEL_CLS} htmlFor="readiness-rate-reg">
                Regular rate /hr
              </label>
              <Input
                id="readiness-rate-reg"
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                value={regular}
                onChange={(e) => setRegular(e.target.value)}
                placeholder="0.00"
                className="h-8 text-xs"
              />
            </div>
            <div className="grid gap-1">
              <label className={EDITOR_LABEL_CLS} htmlFor="readiness-rate-ot">
                OT rate /hr
              </label>
              <Input
                id="readiness-rate-ot"
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                value={ot}
                onChange={(e) => setOt(e.target.value)}
                placeholder={autoOt != null ? `auto ${autoOt}` : "auto 1.5×"}
                className="h-8 text-xs"
              />
            </div>
          </div>
          <div className="grid gap-1">
            <label className={EDITOR_LABEL_CLS} htmlFor="readiness-rate-currency">
              Currency
            </label>
            <select
              id="readiness-rate-currency"
              value={currency}
              onChange={(e) => setCurrency(e.target.value as PayCurrency)}
              className={EDITOR_SELECT_CLS}
            >
              {PAY_CURRENCIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          {error && (
            <p className="text-xs text-rose-600 dark:text-rose-400" role="alert">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => void save()} disabled={saving}>
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Save rate
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * "Set bank" editor for a Bank Info row — writes payout details straight to the
 * person's employee_ids row via POST /api/update-employee-ids (the same route
 * the employee portal saves through, so history/audit/notifications all fire).
 *
 * When the row already resolves an effective processor (Bank Preferred /
 * Disbursement / legacy cell), the processor is FIXED and we only collect its
 * missing details — routing changes stay in their existing approval flows (and
 * the WIRES lock stays intact). Only with NO processor at all does the picker
 * open up, writing the Disbursement channel (`preferred_processor`), never
 * `bank_preferred`.
 */
function SetBankDialog({
  person,
  onClose,
  onSaved,
}: {
  person: ReadinessMissingBank;
  onClose: () => void;
  onSaved: () => void;
}) {
  const lockedProcessor = (person.processor ?? "") as ProcessorId | "";
  const [processor, setProcessor] = useState<string>(lockedProcessor);
  const [walletEmail, setWalletEmail] = useState("");
  const [walletName, setWalletName] = useState("");
  const [bankName, setBankName] = useState("");
  const [accountHolder, setAccountHolder] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [swiftCode, setSwiftCode] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const locked = lockedProcessor !== "";
  // Wise is deliberately NOT a wallet here: like wires/jeeves it's payable on
  // full wire details (isPayoutComplete), and accounting wires these people
  // when no Wise handle is on file — so the editor collects bank details.
  // That's why the picker can offer Wise with the same fields as Wires.
  const isWallet =
    processor === "hurupay" || processor === "wepay" || processor === "higlobe";
  const needsWalletName = processor === "higlobe";
  const processorLabel =
    PROCESSOR_OPTIONS.find((p) => p.id === processor)?.label ?? processor;

  const save = async () => {
    if (!person.workEmail && !person.personalEmail) {
      setError("No email on file to key this person's payout record.");
      return;
    }
    if (!processor) {
      setError("Pick the processor this person is paid through.");
      return;
    }
    const update: Record<string, string> = {};
    if (isWallet) {
      if (!walletEmail.trim()) {
        setError(`Enter the ${processorLabel} account email.`);
        return;
      }
      if (needsWalletName && !walletName.trim()) {
        setError("Enter the HiGlobe account name.");
        return;
      }
      if (processor === "hurupay") update.hurupay_email = walletEmail.trim();
      if (processor === "wepay") update.wepay_email = walletEmail.trim();
      if (processor === "higlobe") {
        update.higlobe_email = walletEmail.trim();
        update.higlobe_account_name = walletName.trim();
      }
    } else {
      // wires / jeeves / wise — manual wire details. Bank + account number are
      // what isPayoutComplete requires; holder + SWIFT ride along when provided.
      if (!bankName.trim() || !accountNumber.trim()) {
        setError("Bank name and account number are required.");
        return;
      }
      update.bank_name = bankName.trim();
      update.account_number = accountNumber.trim();
      if (accountHolder.trim()) update.account_holder_name = accountHolder.trim();
      if (swiftCode.trim()) update.swift_code = swiftCode.trim();
    }
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, string> = {
        bootstrap_display_name: person.name,
        // Attribute this to the accountant fixing it from the wizard, not the
        // employee — the audit + People-tab source read "Payroll Wizard".
        source: READINESS_SOURCE,
        ...update,
      };
      if (person.workEmail) body.work_email = person.workEmail;
      else if (person.personalEmail) body.personal_email = person.personalEmail;
      // Routing: only set the Disbursement channel when the person had no
      // effective processor at all. Never writes bank_preferred.
      if (!locked) body.preferred_processor = processor;
      const res = await fetch("/api/update-employee-ids", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok || json.error) throw new Error(json.error || `Save failed (${res.status})`);
      toast.success(`Bank details saved for ${person.name}`, {
        description: `Paid via ${processorLabel}.`,
      });
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save bank details");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Banknote className="h-4 w-4 text-orange-500" />
            Set bank details
          </DialogTitle>
          <DialogDescription>
            {person.name}
            {person.email ? ` · ${person.email}` : ""} — saves to their payout profile;
            the employee is notified.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1">
            <span className={EDITOR_LABEL_CLS}>Processor</span>
            <SmoothSelect
              value={processor}
              onChange={setProcessor}
              disabled={locked}
              aria-label="Processor"
              className="w-full"
              triggerClassName="h-8"
              options={
                locked
                  ? [{ value: lockedProcessor, label: processorLabel }]
                  : [
                      { value: "", label: "Pick a processor…" },
                      ...EMPLOYEE_SELECTABLE_PROCESSOR_OPTIONS.map((p) => ({
                        value: p.id as string,
                        label: p.label,
                      })),
                    ]
              }
            />
            {locked && (
              <p className="text-[10px] text-zinc-400 dark:text-zinc-500">
                Already routed via {processorLabel} — just complete the missing details
                below. Routing changes go through the usual approval flow.
              </p>
            )}
          </div>
          {isWallet ? (
            <>
              <div className="grid gap-1">
                <label className={EDITOR_LABEL_CLS} htmlFor="readiness-bank-wallet-email">
                  {processorLabel} account email
                </label>
                <Input
                  id="readiness-bank-wallet-email"
                  type="email"
                  value={walletEmail}
                  onChange={(e) => setWalletEmail(e.target.value)}
                  placeholder="name@example.com"
                  className="h-8 text-xs"
                />
              </div>
              {needsWalletName && (
                <div className="grid gap-1">
                  <label className={EDITOR_LABEL_CLS} htmlFor="readiness-bank-wallet-name">
                    HiGlobe account name
                  </label>
                  <Input
                    id="readiness-bank-wallet-name"
                    value={walletName}
                    onChange={(e) => setWalletName(e.target.value)}
                    placeholder="Account holder name"
                    className="h-8 text-xs"
                  />
                </div>
              )}
            </>
          ) : processor ? (
            <>
              <div className="grid grid-cols-2 gap-2">
                <div className="grid gap-1">
                  <label className={EDITOR_LABEL_CLS} htmlFor="readiness-bank-name">
                    Bank name
                  </label>
                  <Input
                    id="readiness-bank-name"
                    value={bankName}
                    onChange={(e) => setBankName(e.target.value)}
                    placeholder="e.g. BPI"
                    className="h-8 text-xs"
                  />
                </div>
                <div className="grid gap-1">
                  <label className={EDITOR_LABEL_CLS} htmlFor="readiness-bank-holder">
                    Account holder
                  </label>
                  <Input
                    id="readiness-bank-holder"
                    value={accountHolder}
                    onChange={(e) => setAccountHolder(e.target.value)}
                    placeholder="Full name"
                    className="h-8 text-xs"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="grid gap-1">
                  <label className={EDITOR_LABEL_CLS} htmlFor="readiness-bank-account">
                    Account number
                  </label>
                  <Input
                    id="readiness-bank-account"
                    value={accountNumber}
                    onChange={(e) => setAccountNumber(e.target.value)}
                    placeholder="Account number"
                    className="h-8 text-xs"
                  />
                </div>
                <div className="grid gap-1">
                  <label className={EDITOR_LABEL_CLS} htmlFor="readiness-bank-swift">
                    SWIFT / routing
                  </label>
                  <Input
                    id="readiness-bank-swift"
                    value={swiftCode}
                    onChange={(e) => setSwiftCode(e.target.value)}
                    placeholder="Optional"
                    className="h-8 text-xs"
                  />
                </div>
              </div>
            </>
          ) : null}
          {error && (
            <p className="text-xs text-rose-600 dark:text-rose-400" role="alert">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => void save()} disabled={saving}>
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Save details
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * KPI Calculator modal for a clicked Readiness department — the SAME calculator
 * the manager uses, mounted elevated so accounting can score, save, and Mark
 * Ready without leaving the wizard. General depts get DeptBonusCalculator with
 * the clicked dept's panel auto-opened; HSL sub-depts get HslBonusCalculator
 * scoped to ONLY the clicked sub-dept (a single `hsl:<key>` grant — no
 * "All Departments" view).
 */
/** Stable empty `managedDepts` for the elevated general-dept calculator — an
 *  inline `[]` would be a fresh identity every render, and the calculators
 *  re-run their initial data load when that prop's identity changes (wiping
 *  unsaved local edits, e.g. a just-added external member). */
const NO_MANAGED_DEPTS: string[] = [];

function KpiCalculatorDialog({
  dept,
  viewerEmail,
  onClose,
}: {
  dept: ReadinessKpiDept;
  viewerEmail: string | null;
  onClose: () => void;
}) {
  const isHsl = dept.source === "hsl";
  // Memoized for the same reason as NO_MANAGED_DEPTS: the Readiness pane
  // re-renders on every live refresh (30s poll / realtime / focus), and a new
  // array identity here would make the embedded calculator reload from the DB
  // over the top of unsaved work.
  const hslManagedDepts = useMemo(
    () => [hslAccessKey(dept.key as HslDeptKey)],
    [dept.key],
  );
  // General depts need the roster the manager dashboard feeds its calculator —
  // fetched per open; the elevated scope returns the full master roster.
  const [members, setMembers] = useState<EmployeeRow[] | null>(null);
  const [memberErr, setMemberErr] = useState<string | null>(null);
  useEffect(() => {
    if (isHsl) return;
    let alive = true;
    fetch("/api/manager/department-members", { cache: "no-store" })
      .then(async (res) => {
        const json = (await res.json()) as { rows?: EmployeeRow[]; error?: string | null };
        if (!res.ok) throw new Error(json.error || `Load failed (${res.status})`);
        if (alive) setMembers(json.rows ?? []);
      })
      .catch((e) => {
        if (alive) setMemberErr(e instanceof Error ? e.message : "Could not load the roster");
      });
    return () => {
      alive = false;
    };
  }, [isHsl]);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-[min(96vw,84rem)] sm:max-w-[min(96vw,84rem)]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ClipboardList className="h-4 w-4 text-orange-500" />
            KPI Calculator — {dept.name}
          </DialogTitle>
          <DialogDescription>
            The same calculator the manager uses. Score, save, and Mark Ready from here;
            Readiness refreshes when you close this.
          </DialogDescription>
        </DialogHeader>
        <div className="h-[72vh] overflow-y-auto overscroll-contain rounded-lg border border-orange-100 bg-white dark:border-blue-950/60 dark:bg-[#0d1117]">
          {isHsl ? (
            // Scoped like a single-dept HSL manager (an `hsl:<key>` grant, NOT
            // elevated): the calculator then shows ONLY the clicked sub-dept —
            // its name in the header, no "All Departments", no dept pill rail.
            // Server-side writes still authorize on the (elevated) session.
            <HslBonusCalculator
              viewerEmail={viewerEmail}
              managedDepts={hslManagedDepts}
              isElevated={false}
              initialFilter={dept.key as HslDeptKey}
              submissionSource={READINESS_SOURCE}
            />
          ) : memberErr ? (
            <div className="flex h-40 flex-col items-center justify-center gap-2 px-6 text-center text-xs text-zinc-500 dark:text-zinc-400">
              <AlertTriangle className="h-5 w-5 text-rose-500" />
              {memberErr}
            </div>
          ) : members === null ? (
            <KpiCalculatorLoadingLine />
          ) : (
            <DeptBonusCalculator
              viewerEmail={viewerEmail}
              teamMembers={members}
              managedDepts={NO_MANAGED_DEPTS}
              isElevated
              initialOpenDept={dept.key}
              submissionSource={READINESS_SOURCE}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * "Readiness" tab — the payroll-ready dashboard. A hero banner that flips green
 * when everything's settled, a 4-up stat-tile row, then four sections: KPI
 * submission (per dept, with a "how much is left" bar), no-rate workers, no-bank
 * employees, and onboarding exceptions. Read-only; fetched from
 * GET /api/payroll-wizard/readiness and kept live via useLiveRefresh. Same
 * h-[70vh] scroller as the other panes so the modal height never jumps.
 */
function PayrollReadinessGlance({
  wizardSourceFile,
  heardWizard,
  canEdit,
  viewerEmail,
}: {
  /** The Hubstaff upload the wizard is on (null = no upload / not settled).
   *  Readiness keys its week on this so it matches the wizard's CSV selector. */
  wizardSourceFile: string | null;
  /** True once the wizard has actually answered which week it's on. We hold the
   *  first fetch until this is true (or a short grace period elapses) so the
   *  snapshot never briefly shows the fallback week before the wizard's. */
  heardWizard: boolean;
  /** Payroll-wizard edit grant — gates the inline "Set rate" / "Set bank" /
   *  KPI-calculator actions (the write APIs enforce their own grants too). */
  canEdit: boolean;
  /** Session email, forwarded to the embedded KPI calculators (saves/locks are
   *  attributed to whoever fixes it from here). */
  viewerEmail: string | null;
}) {
  const reduceMotion = useReducedMotion() ?? false;
  const [data, setData] = useState<PayrollReadiness | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // One shared search box per section, filtering that list live.
  const [kpiQuery, setKpiQuery] = useState("");
  const [rateQuery, setRateQuery] = useState("");
  const [bankQuery, setBankQuery] = useState("");
  const [excQuery, setExcQuery] = useState("");
  // Which of the four detail lists is showing. The stat tiles double as the tab
  // strip; only the selected list renders below them, swapped with a directional
  // slide. `readinessDir` carries the slide direction (+1 later tab / −1 earlier)
  // so switching left↔right reads like turning pages, matching the outer tabs.
  const [readinessTab, setReadinessTab] = useState<ReadinessTab>("kpi");
  const [readinessDir, setReadinessDir] = useState(0);
  // Person currently being fixed inline (null = no editor open). One at a time:
  // the rate editor files a Payment Catalog structure, the bank editor writes
  // payout details to employee_ids.
  const [ratePerson, setRatePerson] = useState<ReadinessMissingRate | null>(null);
  const [bankPerson, setBankPerson] = useState<ReadinessMissingBank | null>(null);
  // Dept whose KPI Calculator modal is open (null = closed).
  const [kpiDept, setKpiDept] = useState<ReadinessKpiDept | null>(null);
  const pickReadinessTab = useCallback((next: ReadinessTab) => {
    setReadinessTab((cur) => {
      if (cur === next) return cur;
      setReadinessDir(
        READINESS_TAB_ORDER.indexOf(next) >= READINESS_TAB_ORDER.indexOf(cur) ? 1 : -1,
      );
      return next;
    });
  }, []);
  // Grace flag: if the wizard never answers (e.g. board opened from a surface
  // where the wizard isn't mounted), fetch anyway after a short wait so the tab
  // isn't stuck loading forever. Reset per mount.
  const [grace, setGrace] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setGrace(true), 1500);
    return () => window.clearTimeout(t);
  }, []);
  const ready = heardWizard || grace;

  // The Hubstaff uploads (newest first) that the in-tab week selector offers —
  // the SAME list the Payroll Wizard's period dropdown shows. Fetched once; the
  // selector degrades gracefully (hidden) if this fails or is empty.
  const [uploads, setUploads] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    fetch("/api/hubstaff-hours?source_files=1", { cache: "no-store" })
      .then(async (res) => (await res.json()) as { files?: string[] })
      .then((j) => {
        if (alive) setUploads((j.files ?? []).filter((f) => typeof f === "string" && f.trim() !== ""));
      })
      .catch(() => {
        /* the selector is an enhancement — falls back to the wizard's week */
      });
    return () => {
      alive = false;
    };
  }, []);

  // The user's OWN pick from the in-tab selector, once they've chosen a week
  // here. Independent of the wizard: `null` means "follow the wizard" (the
  // default), a string means the accountant is driving Readiness themselves and
  // their choice sticks even if the wizard's CSV selector later moves.
  const [pickedSourceFile, setPickedSourceFile] = useState<string | null>(null);
  const [hasPicked, setHasPicked] = useState(false);
  // The effective week: the accountant's own pick when they've made one, else
  // the wizard's live selection (which the server maps to the current upload
  // when it, too, is null).
  const effectiveSourceFile = hasPicked ? pickedSourceFile : wizardSourceFile;
  // The newest upload is "current" — used to badge the selector and to power a
  // one-click "back to current" reset.
  const currentSourceFile = uploads[0] ?? null;

  // Monotonic request token: load() can run concurrently (a week switch, the
  // 30s poll, a realtime fire, a focus refresh), and fetches for different weeks
  // can resolve out of order. Each call stamps a fresh id; only the LATEST call
  // is allowed to write state, so a slow fetch for a week we've since left can
  // never clobber the week now in view.
  const loadSeqRef = useRef(0);
  const load = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    try {
      const qs = effectiveSourceFile ? `?source_file=${encodeURIComponent(effectiveSourceFile)}` : "";
      const res = await fetch(`/api/payroll-wizard/readiness${qs}`, { cache: "no-store" });
      const json = (await res.json()) as { readiness?: PayrollReadiness; error?: string };
      if (seq !== loadSeqRef.current) return; // superseded — a newer load is in charge
      if (!res.ok || !json.readiness) throw new Error(json.error || `Load failed (${res.status})`);
      setData(json.readiness);
      setError(null);
    } catch (e) {
      if (seq !== loadSeqRef.current) return; // superseded — don't surface a stale error
      setError(e instanceof Error ? e.message : "Could not load readiness");
    } finally {
      if (seq === loadSeqRef.current) setLoading(false);
    }
  }, [effectiveSourceFile]);

  // Hold the fetch until we know the wizard's week (or the grace period lapses),
  // then refetch whenever the effective week changes — the wizard switching its
  // CSV (while we're following it) or the accountant picking a week here.
  useEffect(() => {
    if (!ready) return;
    void load();
  }, [ready, load]);

  /** Pick a week from the in-tab selector. Selecting the current upload clears
   *  the override so Readiness resumes following the wizard; any other week
   *  latches so the wizard can no longer steer this tab. */
  const pickWeek = useCallback(
    (file: string | null) => {
      // Reset (null / the current upload) → follow the wizard; else latch.
      const resetting = file === null || file === currentSourceFile;
      const nextEffective = resetting ? wizardSourceFile : file;
      // Only flip to the spinner when the effective week actually changes — a
      // no-op pick (e.g. "Current" while already current) leaves `load`'s
      // identity untouched, so its useEffect wouldn't re-run to clear it.
      if (nextEffective !== effectiveSourceFile) setLoading(true);
      if (resetting) {
        setPickedSourceFile(null);
        setHasPicked(false);
      } else {
        setPickedSourceFile(file);
        setHasPicked(true);
      }
    },
    [currentSourceFile, wizardSourceFile, effectiveSourceFile],
  );

  // Live: reflect a manager marking their KPI ready, a rate/bank fix, or a new
  // hire promotion without a manual reload. Debounced + 30s poll fallback.
  useLiveRefresh({
    tables: [
      "hsl_bonus_period_status",
      "hsl_bonus_entries",
      "bonus_catalog_applied",
      "employee_hourly_rates",
      "payment_catalog_pay_structures",
      "employee_ids",
      "hr_pending_employees",
    ],
    channel: "payroll-readiness",
    onRefresh: () => void load(),
  });

  // Filter the three people lists live (name / email / dept / status). Computed
  // BEFORE the loading/error early-returns and made null-safe, so the paging
  // hooks below can run unconditionally (Rules of Hooks) — a null `data` just
  // yields empty lists. KPI isn't paginated (bounded dept list), so it's still
  // filtered inline in the render below.
  const ratesShown = (data?.missingRates ?? []).filter((r) =>
    matchesQuery(rateQuery, r.name, r.email, r.department),
  );
  const bankShown = (data?.missingBank ?? []).filter((r) =>
    matchesQuery(bankQuery, r.name, r.email, r.department, r.processor),
  );
  const excShown = (data?.exceptions ?? []).filter((r) =>
    matchesQuery(excQuery, r.name, r.email, r.department, r.detail, EXCEPTION_META[r.kind].label),
  );
  // Paginate each people list (10/page). Keyed on the search query so a new
  // search snaps back to page 1; the hook also clamps the page if a live refresh
  // shrinks the list under it.
  const ratesPage = usePagedList(ratesShown, rateQuery);
  const bankPage = usePagedList(bankShown, bankQuery);
  const excPage = usePagedList(excShown, excQuery);

  // The selector header stays mounted across every body state (loading / error /
  // content) so switching weeks never yanks the control out from under the
  // cursor. The upload list drives it; if uploads couldn't load it hides itself.
  const selectorHeader = (
    <ReadinessWeekSelector
      uploads={uploads}
      value={effectiveSourceFile ?? currentSourceFile}
      currentSourceFile={currentSourceFile}
      following={!hasPicked}
      onChange={pickWeek}
    />
  );

  // Loading takes precedence over a lingering error: when a fresh load is in
  // flight (e.g. Retry, or a week switch after a failure), show the skeleton
  // rather than the stale error card until this load settles. The skeleton
  // mirrors the real layout (hero + 4 stat tiles + the four sections) so the
  // shape is stable; over it sits the "Gathering data…" card (a foreground box
  // that walks through the four checks) so the wait reads as active progress,
  // not a stalled spinner.
  if (loading || !data) {
    return (
      <div className="flex h-[70vh] flex-col">
        {selectorHeader}
        <div className="relative flex-1 overflow-hidden">
          <div className="h-full overflow-y-auto pr-1" aria-hidden>
            <ReadinessSkeleton reduceMotion={reduceMotion} />
          </div>
          <ReadinessLoadingCard reduceMotion={reduceMotion} />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-[70vh] flex-col">
        {selectorHeader}
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-red-500 to-rose-600 text-white shadow-lg shadow-rose-500/30">
            <AlertTriangle className="h-6 w-6" />
          </div>
          <h2 className="text-base font-semibold">Couldn&apos;t load readiness</h2>
          <p className="max-w-md text-xs text-zinc-500 dark:text-zinc-400">{error}</p>
          <Button variant="outline" size="sm" onClick={() => { setLoading(true); void load(); }}>
            Retry
          </Button>
        </div>
      </div>
    );
  }

  const kpiPending = data.kpi.filter((d) => !isKpiSettled(d.status));
  const kpiDue = data.kpi.filter((d) => d.status !== "na");
  const kpiSubmitted = kpiDue.length - kpiPending.length;

  const blockers = data.missingRates.length; // hard blocker: can't pay at all
  const warnings = kpiPending.length + data.missingBank.length; // needs attention
  const isReady = blockers === 0 && kpiPending.length === 0 && data.missingBank.length === 0;

  // KPI search — filter the dept list live (name / key / status). The three
  // people lists (rate/bank/exc) are filtered + paginated above, before the
  // guards, so their paging hooks can run unconditionally. Counts on the section
  // pills stay the FULL count so the readiness verdict never changes because a
  // search hid rows.
  const kpiShown = data.kpi.filter((d) =>
    matchesQuery(kpiQuery, d.name, d.key, KPI_STATUS_PILL[d.status].label),
  );

  return (
    <div className="flex h-[70vh] flex-col">
      {selectorHeader}
      {/* Frozen header: the hero ("blockers to clear"), the stat tiles, and the
          tab strip stay pinned so the accountant always sees the verdict + the
          tab controls. Only the detail body below scrolls. */}
      <div className="shrink-0 space-y-3">
      {/* Hero: green when ready, amber while there's work, rose when a hard
          blocker (no-rate worker) exists. */}
      <ReadinessHero
        isReady={isReady}
        blockers={blockers}
        warnings={warnings}
        weekLabel={data.weekLabel}
        isMonthly={data.isMonthlyPayWeek}
        score={data.score}
        reduceMotion={reduceMotion}
      />

      {/* Stat tiles — a read-only at-a-glance summary of the four dimensions.
          (Switching between the detail lists is the tab strip's job, below.) */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <ReadinessStat
          label="KPIs submitted"
          value={`${kpiSubmitted}/${kpiDue.length}`}
          sub={kpiPending.length === 0 ? "all departments in" : `${kpiPending.length} still pending`}
          tone={kpiPending.length === 0 ? "emerald" : "amber"}
          Icon={ClipboardList}
        />
        <ReadinessStat
          label="No pay rate"
          value={data.missingRates.length}
          sub={data.missingRates.length === 0 ? "everyone has a rate" : "can't be paid yet"}
          tone={data.missingRates.length === 0 ? "emerald" : "orange"}
          Icon={Wallet}
        />
        <ReadinessStat
          label="No bank info"
          value={data.missingBank.length}
          sub={data.missingBank.length === 0 ? "all payable" : "missing payout details"}
          tone={data.missingBank.length === 0 ? "emerald" : "amber"}
          Icon={Banknote}
        />
        <ReadinessStat
          label="Exceptions"
          value={data.exceptions.length}
          sub={data.exceptions.length === 0 ? "none this week" : "not paid this week"}
          tone={data.exceptions.length === 0 ? "emerald" : "sky"}
          Icon={UserPlus}
        />
      </div>

      {/* Tab strip — the explicit control for switching between the four detail
          lists (KPI Submissions / No Pay Rate / Bank Info / Exceptions). */}
      <ReadinessTabStrip
        active={readinessTab}
        onPick={pickReadinessTab}
        counts={{
          kpi: kpiPending.length,
          rate: data.missingRates.length,
          bank: data.missingBank.length,
          exc: data.exceptions.length,
        }}
        reduceMotion={reduceMotion}
      />
      </div>

      {/* Scroll region: ONLY the active detail list + footer note scroll; the
          hero/tiles/tab strip above stay frozen. */}
      <div className="mt-3 min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
      {/* Active detail list. Only the selected tab's section renders; swapping
          tabs slides the old pane out and the new one in, in the direction you
          moved (readinessDir), reduced-motion gated. min-h keeps the modal from
          jumping between a short and a tall list. */}
      <div className="overflow-x-clip" role="tabpanel">
        <AnimatePresence mode="wait" initial={false} custom={readinessDir}>
          <motion.div
            key={readinessTab}
            custom={readinessDir}
            variants={PANE_VARIANTS}
            initial="enter"
            animate="center"
            exit="exit"
            transition={{ duration: reduceMotion ? 0 : 0.22, ease: EASE }}
            className="min-h-[16rem]"
          >
            {readinessTab === "kpi" ? (
              <PaneBody>
                <ReadinessSearch
                  value={kpiQuery}
                  onChange={setKpiQuery}
                  placeholder="Search departments…"
                  shown={kpiShown.length}
                  total={data.kpi.length}
                />
                {kpiShown.length === 0 ? (
                  <NoMatches query={kpiQuery} />
                ) : (
                  // Two-column grid of dept cards (single column on the narrowest
                  // widths). No inner scroller — the pane's shared outer scroller
                  // owns the overflow, so a long dept list doesn't create a nested
                  // scroll-trap (matches the three paginated lists).
                  <div className="grid grid-cols-1 gap-x-3 gap-y-0.5 sm:grid-cols-2">
                    {kpiShown.map((d) => (
                      <KpiDeptRow
                        key={`${d.source}:${d.key}`}
                        dept={d}
                        reduceMotion={reduceMotion}
                        // In-app (registry) departments have no KPI calculator
                        // to open — their row is informational.
                        onOpen={canEdit && d.source !== "custom" ? () => setKpiDept(d) : undefined}
                      />
                    ))}
                  </div>
                )}
              </PaneBody>
            ) : readinessTab === "rate" ? (
              <PaneBody>
                {data.missingRates.length === 0 ? (
                  <AllClear text="Every current-week worker has a rate." />
                ) : (
                  <>
                    <ReadinessSearch
                      value={rateQuery}
                      onChange={setRateQuery}
                      placeholder="Search people…"
                      shown={ratesShown.length}
                      total={data.missingRates.length}
                    />
                    {ratesShown.length === 0 ? (
                      <NoMatches query={rateQuery} />
                    ) : (
                      <>
                        <div className="space-y-0.5">
                          {ratesPage.pageItems.map((r) => (
                            <PersonLine
                              key={r.email ?? r.name}
                              name={r.name}
                              email={r.email}
                              department={r.department}
                              right={
                                <div className="flex shrink-0 items-center gap-1.5">
                                  <span className="shrink-0 rounded-full border border-rose-200 bg-rose-50 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300">
                                    No rate
                                  </span>
                                  {canEdit && (
                                    <RowFixButton
                                      label="Set rate"
                                      onClick={() => setRatePerson(r)}
                                      disabled={!r.email}
                                      title={
                                        r.email
                                          ? "Set this person's pay rate"
                                          : "No email on the roster — set the rate from the Payment Catalog"
                                      }
                                    />
                                  )}
                                </div>
                              }
                            />
                          ))}
                        </div>
                        <ReadinessPager
                          page={ratesPage.page}
                          pageCount={ratesPage.pageCount}
                          from={ratesPage.from}
                          to={ratesPage.to}
                          total={ratesPage.total}
                          onPage={ratesPage.setPage}
                        />
                      </>
                    )}
                  </>
                )}
              </PaneBody>
            ) : readinessTab === "bank" ? (
              <PaneBody>
                {data.missingBank.length === 0 ? (
                  <AllClear text="Everyone has payout details on file." />
                ) : (
                  <>
                    <ReadinessSearch
                      value={bankQuery}
                      onChange={setBankQuery}
                      placeholder="Search people…"
                      shown={bankShown.length}
                      total={data.missingBank.length}
                    />
                    {bankShown.length === 0 ? (
                      <NoMatches query={bankQuery} />
                    ) : (
                      <>
                        <div className="space-y-0.5">
                          {bankPage.pageItems.map((r) => (
                            <PersonLine
                              key={r.email ?? r.name}
                              name={r.name}
                              email={r.email}
                              department={r.department}
                              right={
                                <div className="flex shrink-0 items-center gap-1.5">
                                  <span className="shrink-0 rounded-full border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
                                    {r.processor ? `${r.processor} · incomplete` : "No processor"}
                                  </span>
                                  {canEdit && (
                                    <RowFixButton
                                      label="Set bank"
                                      onClick={() => setBankPerson(r)}
                                      disabled={!r.workEmail && !r.personalEmail}
                                      title={
                                        r.workEmail || r.personalEmail
                                          ? "Set this person's payout details"
                                          : "No email on file to key their payout record"
                                      }
                                    />
                                  )}
                                </div>
                              }
                            />
                          ))}
                        </div>
                        <ReadinessPager
                          page={bankPage.page}
                          pageCount={bankPage.pageCount}
                          from={bankPage.from}
                          to={bankPage.to}
                          total={bankPage.total}
                          onPage={bankPage.setPage}
                        />
                      </>
                    )}
                  </>
                )}
              </PaneBody>
            ) : (
              <PaneBody>
                {data.exceptions.length === 0 ? (
                  <AllClear text="No onboarding exceptions this week." />
                ) : (
                  <>
                    <ReadinessSearch
                      value={excQuery}
                      onChange={setExcQuery}
                      placeholder="Search people…"
                      shown={excShown.length}
                      total={data.exceptions.length}
                    />
                    {excShown.length === 0 ? (
                      <NoMatches query={excQuery} />
                    ) : (
                      <>
                        <div className="space-y-0.5">
                          {excPage.pageItems.map((r, i) => {
                            const meta = EXCEPTION_META[r.kind];
                            return (
                              <PersonLine
                                key={`${r.email ?? r.name}:${i}`}
                                name={r.name}
                                email={r.email}
                                department={r.detail ?? r.department}
                                right={
                                  <span className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${meta.cls}`}>
                                    <meta.Icon className="h-2.5 w-2.5" />
                                    {meta.label}
                                  </span>
                                }
                              />
                            );
                          })}
                        </div>
                        <ReadinessPager
                          page={excPage.page}
                          pageCount={excPage.pageCount}
                          from={excPage.from}
                          to={excPage.to}
                          total={excPage.total}
                          onPage={excPage.setPage}
                        />
                      </>
                    )}
                  </>
                )}
              </PaneBody>
            )}
          </motion.div>
        </AnimatePresence>
      </div>

      <p className="px-1 pb-1 text-center text-[10px] text-zinc-400 dark:text-zinc-500">
        {hasPicked ? "Showing the week you picked above" : "Following the wizard’s selected period"} ·
        payroll week {data.weekLabel}
        {data.isMonthlyPayWeek ? " · month-end (monthly bonuses due)" : ""} · updates live as
        managers submit and details are fixed.
      </p>
      </div>

      {/* Inline fixers — the realtime subscription refreshes the lists on save
          too, but reload explicitly so the row clears the moment it's fixed. */}
      {ratePerson && (
        <SetRateDialog
          person={ratePerson}
          onClose={() => setRatePerson(null)}
          onSaved={() => void load()}
        />
      )}
      {bankPerson && (
        <SetBankDialog
          person={bankPerson}
          onClose={() => setBankPerson(null)}
          onSaved={() => void load()}
        />
      )}
      {kpiDept && (
        <KpiCalculatorDialog
          dept={kpiDept}
          viewerEmail={viewerEmail}
          onClose={() => {
            setKpiDept(null);
            // Whatever was saved / marked ready inside → reflect it right away.
            void load();
          }}
        />
      )}
    </div>
  );
}

/** The four things the Readiness snapshot gathers, in the order the loading card
 *  walks through them. */
const READINESS_LOADING_STEPS: { label: string; Icon: typeof CheckCircle2 }[] = [
  { label: "KPI submissions", Icon: ClipboardList },
  { label: "No pay rates", Icon: Wallet },
  { label: "No bank infos", Icon: Banknote },
  { label: "Exceptions", Icon: UserPlus },
];

/**
 * "Gathering data…" card shown OVER the skeleton while the Readiness snapshot
 * loads — a foreground box that names the four checks (KPI submissions / No pay
 * rates / No bank infos / Exceptions) and lights them up one after another so
 * the wait reads as active progress instead of a stalled spinner.
 *
 * The real fetch is a single request with no per-item signal, so the steps are
 * driven by a self-advancing cursor on a short timer: a step ahead of the cursor
 * is pending (muted), the step AT the cursor is "in progress" (spinner +
 * highlight), and steps behind it are "gathered" (emerald check). The cursor
 * fills 0→total once and then HOLDS at all-gathered (it does NOT loop back —
 * un-checking a finished list would read as going backwards / stalled); the
 * header spinner keeps it feeling live while the request finishes, and the card
 * unmounts the instant real data lands. Gated on reduced motion — then all four
 * just read as gathered, no cycling.
 */
function ReadinessLoadingCard({ reduceMotion }: { reduceMotion: boolean }) {
  const total = READINESS_LOADING_STEPS.length;
  // The step currently "in progress"; everything before it reads as gathered.
  // Advances 0→total once (total = "all gathered") then stops there — no loop.
  const [cursor, setCursor] = useState(0);
  useEffect(() => {
    if (reduceMotion) return; // static: show everything gathered, no cycling
    const t = window.setInterval(() => {
      setCursor((c) => {
        if (c >= total) {
          window.clearInterval(t);
          return c; // reached "all gathered" — hold, don't reset
        }
        return c + 1;
      });
    }, 700);
    return () => window.clearInterval(t);
  }, [reduceMotion, total]);

  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center p-4">
      <motion.div
        initial={reduceMotion ? false : { opacity: 0, y: 8, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: reduceMotion ? 0 : 0.3, ease: EASE }}
        role="status"
        aria-live="polite"
        aria-label="Gathering payroll readiness data"
        className="w-full max-w-sm overflow-hidden rounded-2xl border border-orange-200/80 bg-white/95 shadow-2xl shadow-orange-500/10 backdrop-blur-md dark:border-blue-900/70 dark:bg-[#0d1117]/95 dark:shadow-black/40"
      >
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-orange-100 bg-gradient-to-br from-orange-50 to-amber-50 px-4 py-3 dark:border-blue-950/60 dark:from-blue-950/40 dark:to-blue-950/10">
          <div className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-orange-500 to-amber-500 text-white shadow-md">
            <ShieldCheck className="h-5 w-5" />
            {!reduceMotion && (
              <motion.span
                aria-hidden
                className="absolute inset-0 rounded-xl ring-2 ring-orange-400/50"
                initial={{ opacity: 0.6, scale: 1 }}
                animate={{ opacity: 0, scale: 1.4 }}
                transition={{ duration: 1.6, repeat: Infinity, ease: "easeOut" }}
              />
            )}
          </div>
          <div className="min-w-0">
            <h3 className="flex items-center gap-1.5 text-sm font-bold tracking-tight text-zinc-900 dark:text-zinc-50">
              Gathering data
              {!reduceMotion && <Loader2 className="h-3.5 w-3.5 animate-spin text-orange-500" />}
            </h3>
            <p className="truncate text-[11px] text-zinc-500 dark:text-zinc-400">
              Checking this week&apos;s payroll readiness…
            </p>
          </div>
        </div>

        {/* The four checks, lighting up in sequence. */}
        <ul className="space-y-1 p-3">
          {READINESS_LOADING_STEPS.map((step, i) => {
            // Reduced motion → everything reads as gathered. Otherwise: behind
            // the cursor = gathered, at the cursor = in progress, ahead = pending.
            const gathered = reduceMotion || i < cursor;
            const active = !reduceMotion && i === cursor;
            return (
              <li
                key={step.label}
                className={`flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 transition-colors duration-300 ${
                  active
                    ? "bg-orange-50 dark:bg-blue-950/40"
                    : gathered
                      ? "bg-emerald-50/60 dark:bg-emerald-950/15"
                      : ""
                }`}
              >
                {/* Status glyph: emerald check when gathered, spinner while in
                    progress, muted dot while still pending. */}
                <span className="flex h-5 w-5 shrink-0 items-center justify-center">
                  {gathered ? (
                    <motion.span
                      key="done"
                      initial={reduceMotion ? false : { scale: 0.5, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      transition={{ duration: 0.2, ease: EASE }}
                    >
                      <CheckCircle2 className="h-4.5 w-4.5 text-emerald-500 dark:text-emerald-400" />
                    </motion.span>
                  ) : active ? (
                    <Loader2 className="h-4 w-4 animate-spin text-orange-500 dark:text-orange-400" />
                  ) : (
                    <span className="h-1.5 w-1.5 rounded-full bg-zinc-300 dark:bg-zinc-600" />
                  )}
                </span>
                <step.Icon
                  className={`h-4 w-4 shrink-0 transition-colors duration-300 ${
                    gathered
                      ? "text-emerald-500 dark:text-emerald-400"
                      : active
                        ? "text-orange-500 dark:text-orange-400"
                        : "text-zinc-400 dark:text-zinc-500"
                  }`}
                />
                <span
                  className={`text-[13px] font-medium transition-colors duration-300 ${
                    gathered || active
                      ? "text-zinc-800 dark:text-zinc-100"
                      : "text-zinc-400 dark:text-zinc-500"
                  }`}
                >
                  {step.label}
                </span>
                <span className="ml-auto text-[10px] font-semibold tracking-wide text-zinc-400 tabular-nums dark:text-zinc-500">
                  {gathered ? "Gathered" : active ? "Gathering…" : "Queued"}
                </span>
              </li>
            );
          })}
        </ul>
      </motion.div>
    </div>
  );
}

/**
 * Loading placeholder for the Readiness pane — mirrors the real layout (hero
 * banner + 4 stat tiles + the KPI section and the three people-list sections)
 * with pulsing bars, and NAMES each of the four sections so the accountant sees
 * exactly what's being checked (KPIs, No pay rate, Bank info, Exceptions) rather
 * than a bare spinner. Keeping the shape identical means no layout jump when the
 * real data lands.
 */
function ReadinessSkeleton({ reduceMotion = false }: { reduceMotion?: boolean }) {
  // Pulse is gated on reduced motion so the backdrop honors it too (the card on
  // top already does) — under reduced motion the bars are static grey blocks.
  const bar = `rounded bg-zinc-200/80 dark:bg-zinc-800/80${reduceMotion ? "" : " animate-pulse"}`;
  // The tab strip's four labels; the first is drawn as the active tab (bottom
  // bar) to match the pane defaulting to KPI submission.
  const TILES = ["KPIs submitted", "No pay rate", "No bank info", "Exceptions"];

  return (
    <div aria-hidden className="space-y-3">
      {/* Hero — icon, headline/sub, and the score dial placeholder on the right. */}
      <div className="flex items-center gap-3 rounded-xl border border-zinc-200/70 bg-white/60 px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900/40">
        <div className={`${bar} h-11 w-11 shrink-0 rounded-2xl`} />
        <div className="min-w-0 flex-1 space-y-2">
          <div className={`${bar} h-4 w-40`} />
          <div className={`${bar} h-3 w-56`} />
        </div>
        <div className={`${bar} hidden h-[70px] w-[70px] shrink-0 rounded-full sm:block`} />
      </div>

      {/* Stat tiles — read-only summary row. */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {TILES.map((label) => (
          <div
            key={label}
            className="relative overflow-hidden rounded-xl border border-white/60 bg-white/70 p-2.5 sm:p-3 dark:border-zinc-800 dark:bg-zinc-900/60"
          >
            <div className="text-[9px] font-semibold uppercase tracking-[0.14em] text-zinc-400 dark:text-zinc-500">
              {label}
            </div>
            <div className={`${bar} mt-1 h-5 w-12`} />
            <div className={`${bar} mt-1.5 h-2 w-3/4`} />
          </div>
        ))}
      </div>

      {/* Tab strip — four labeled tabs, the first drawn as active (underline). */}
      <div className="flex items-center gap-1 border-b border-orange-100 pb-px dark:border-blue-950/60">
        {["KPI Submissions", "No Pay Rate", "Bank Info", "Exceptions"].map((label, i) => (
          <div
            key={label}
            className={`relative -mb-px flex items-center gap-1.5 px-3 py-2 text-xs font-semibold whitespace-nowrap ${
              i === 0 ? "text-orange-700 dark:text-orange-300" : "text-zinc-400 dark:text-zinc-500"
            }`}
          >
            {label}
            <span className={`${bar} h-3.5 w-4 rounded-full`} />
            {i === 0 && (
              <span className="absolute inset-x-1 -bottom-px h-0.5 rounded-full bg-orange-500 dark:bg-orange-400" />
            )}
          </div>
        ))}
      </div>

      {/* Active pane — one section shell (the default KPI list). */}
      <section className="min-h-[16rem] rounded-xl border border-orange-100 bg-white/60 dark:border-blue-950/60 dark:bg-blue-950/10">
        <div className="flex items-center justify-between gap-2 border-b border-orange-100/70 px-3 py-2 dark:border-blue-950/50">
          <span className="flex items-center gap-1.5 text-xs font-semibold text-zinc-700 dark:text-zinc-200">
            <ClipboardList className="h-3.5 w-3.5 text-orange-400/70" />
            KPI submission
          </span>
          <span className={`${bar} h-4 w-8 rounded-full`} />
        </div>
        <div className="space-y-2 p-2.5">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 px-2 py-1.5">
              <div className="min-w-0 flex-1 space-y-1.5">
                <div className={`${bar} h-3 w-1/3`} />
                <div className={`${bar} h-1.5 w-full rounded-full`} />
              </div>
              <div className={`${bar} h-4 w-14 rounded-full`} />
            </div>
          ))}
        </div>
      </section>
      {/* No footer message here — the ReadinessLoadingCard overlaid on top of
          this skeleton carries the "Gathering data…" copy, so a second
          "Checking…" line would just compete with it. */}
    </div>
  );
}

/** The readiness hero banner — a single at-a-glance verdict that flips to green
 *  when the cycle is clear. Blockers (no-rate workers) read rose; warnings
 *  (pending KPI / missing bank) read amber. */
function ReadinessHero({
  isReady,
  blockers,
  warnings,
  weekLabel,
  isMonthly,
  score,
  reduceMotion,
}: {
  isReady: boolean;
  blockers: number;
  warnings: number;
  weekLabel: string;
  isMonthly: boolean;
  score: ReadinessScore;
  reduceMotion: boolean;
}) {
  // Tone follows the score grade (blocked → rose, ready → emerald, else amber),
  // so the banner colour and the gauge always agree.
  const tone = score.grade === "ready" ? "emerald" : score.grade === "blocked" ? "rose" : "amber";
  const toneCls: Record<string, string> = {
    emerald:
      "border-emerald-200 from-emerald-50 to-teal-50 dark:border-emerald-500/30 dark:from-emerald-950/40 dark:to-teal-950/20",
    amber:
      "border-amber-200 from-amber-50 to-orange-50 dark:border-amber-500/30 dark:from-amber-950/40 dark:to-orange-950/20",
    rose: "border-rose-200 from-rose-50 to-red-50 dark:border-rose-500/30 dark:from-rose-950/40 dark:to-red-950/20",
  };
  const iconCls: Record<string, string> = {
    emerald: "from-emerald-500 to-teal-500",
    amber: "from-amber-500 to-orange-500",
    rose: "from-rose-500 to-red-600",
  };
  const Icon = isReady ? CheckCircle2 : AlertTriangle;
  const headline = isReady
    ? "Payroll Ready"
    : blockers > 0
      ? "Not ready — blockers to clear"
      : "Almost there — a few items left";
  const sub = isReady
    ? "Every department is in and everyone can be paid."
    : [
        blockers > 0 ? `${blockers} worker${blockers === 1 ? "" : "s"} with no rate` : null,
        warnings > 0 ? `${warnings} item${warnings === 1 ? "" : "s"} to review` : null,
      ]
        .filter(Boolean)
        .join(" · ") || "Reviewing…";

  return (
    <motion.div
      initial={reduceMotion ? false : { opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: reduceMotion ? 0 : 0.28, ease: EASE }}
      className={`flex items-center gap-3 rounded-xl border bg-gradient-to-br px-4 py-3 ${toneCls[tone]}`}
    >
      <div className={`relative flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br text-white shadow-md ${iconCls[tone]}`}>
        <Icon className="h-6 w-6" />
        {isReady && !reduceMotion && (
          <motion.span
            aria-hidden
            className="absolute inset-0 rounded-2xl ring-2 ring-emerald-400/50"
            initial={{ opacity: 0.6, scale: 1 }}
            animate={{ opacity: 0, scale: 1.5 }}
            transition={{ duration: 1.6, repeat: Infinity, ease: "easeOut" }}
          />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h3 className="truncate text-base font-bold tracking-tight text-zinc-900 dark:text-zinc-50">{headline}</h3>
          <span className="hidden shrink-0 rounded-full border border-zinc-200 bg-white/70 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.14em] text-zinc-500 sm:inline dark:border-zinc-700 dark:bg-zinc-900/60 dark:text-zinc-400">
            <CalendarDays className="mr-1 inline h-2.5 w-2.5" />
            {weekLabel}
            {isMonthly ? " · month-end" : ""}
          </span>
        </div>
        <p className="mt-0.5 truncate text-xs text-zinc-600 dark:text-zinc-300">{sub}</p>
        {/* Component breakdown — the points each dimension is contributing, so
            it's obvious what's costing the score. Hidden on the narrowest width
            where the gauge alone tells the story. */}
        <div className="mt-1.5 hidden flex-wrap items-center gap-x-3 gap-y-1 sm:flex">
          {score.components.map((c) => {
            const full = c.open === 0;
            return (
              <span
                key={c.key}
                className="inline-flex items-center gap-1 text-[10px] text-zinc-500 dark:text-zinc-400"
                title={`${c.label}: ${c.points}/${c.maxPoints} pts${c.open > 0 ? ` · ${c.open} open` : " · clear"}`}
              >
                <span
                  className={`inline-block h-1.5 w-1.5 rounded-full ${
                    full ? "bg-emerald-500" : c.key === "rate" ? "bg-rose-500" : "bg-amber-500"
                  }`}
                />
                <span className="font-medium text-zinc-600 dark:text-zinc-300">{c.label}</span>
                <span className="tabular-nums">
                  {c.points}
                  <span className="text-zinc-400 dark:text-zinc-500">/{c.maxPoints}</span>
                </span>
              </span>
            );
          })}
        </div>
      </div>

      {/* The Readiness Score dial — the headline number for the week. */}
      <ScoreGauge score={score} tone={tone} reduceMotion={reduceMotion} />
    </motion.div>
  );
}

/**
 * The Readiness Score dial — an SVG ring that fills to the 0–100 score, with the
 * number and a one-word grade in the centre. Tone matches the hero banner
 * (emerald when ready, rose when a blocker exists, amber otherwise). The ring
 * animates from empty on mount (gated on reduced motion).
 */
function ScoreGauge({
  score,
  tone,
  reduceMotion,
}: {
  score: ReadinessScore;
  tone: "emerald" | "amber" | "rose";
  reduceMotion: boolean;
}) {
  const R = 26;
  const C = 2 * Math.PI * R;
  const pct = Math.max(0, Math.min(100, score.value));
  const dash = (pct / 100) * C;
  const strokeCls: Record<string, string> = {
    emerald: "text-emerald-500 dark:text-emerald-400",
    amber: "text-amber-500 dark:text-amber-400",
    rose: "text-rose-500 dark:text-rose-400",
  };
  const gradeLabel: Record<ReadinessScore["grade"], string> = {
    ready: "Ready",
    almost: "Almost",
    at_risk: "At risk",
    blocked: "Blocked",
  };
  return (
    <div
      className="relative hidden h-[70px] w-[70px] shrink-0 sm:block"
      role="img"
      aria-label={`Readiness score ${pct} out of 100 — ${gradeLabel[score.grade]}`}
      title={`Readiness score: ${pct}/100 (${gradeLabel[score.grade]})`}
    >
      <svg viewBox="0 0 64 64" className="h-full w-full -rotate-90">
        <circle
          cx="32"
          cy="32"
          r={R}
          fill="none"
          strokeWidth="6"
          className="text-zinc-200/70 dark:text-zinc-700/60"
          stroke="currentColor"
        />
        <motion.circle
          cx="32"
          cy="32"
          r={R}
          fill="none"
          strokeWidth="6"
          strokeLinecap="round"
          className={strokeCls[tone]}
          stroke="currentColor"
          strokeDasharray={C}
          initial={{ strokeDashoffset: reduceMotion ? C - dash : C }}
          animate={{ strokeDashoffset: C - dash }}
          transition={{ duration: reduceMotion ? 0 : 0.9, ease: EASE }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-lg font-extrabold leading-none tracking-tight tabular-nums text-zinc-900 dark:text-zinc-50">
          {pct}
        </span>
        <span className="mt-0.5 text-[8px] font-semibold uppercase tracking-[0.12em] text-zinc-500 dark:text-zinc-400">
          {gradeLabel[score.grade]}
        </span>
      </div>
    </div>
  );
}

/**
 * The Readiness tab's OWN pay-period selector, driven by the Hubstaff uploads
 * (the exact list the Payroll Wizard's period dropdown shows). Picking a week
 * here latches Readiness to it — independent of the wizard — while defaulting to
 * whatever week the wizard is on. Prev/next arrows step through the uploads
 * newest→oldest; the dropdown lists every upload, badging the current one; a
 * "Current" chip resets the pick so Readiness resumes following the wizard.
 *
 * Uploads are ordered newest-first (index 0 = current). `value` is the filename
 * currently in view; `following` is true while no local pick is latched (the tab
 * is mirroring the wizard). Renders nothing when there are no uploads yet.
 */
function ReadinessWeekSelector({
  uploads,
  value,
  currentSourceFile,
  following,
  onChange,
}: {
  uploads: string[]; // Hubstaff source_files, newest-first (index 0 = current)
  value: string | null; // the filename in view (may be null before uploads load)
  currentSourceFile: string | null; // the newest upload — the live payroll week
  following: boolean; // true = no local pick latched (mirroring the wizard)
  onChange: (sourceFile: string | null) => void; // null resets to "follow wizard"
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

  // No uploads yet (fresh environment or the list failed to load) — there's
  // nothing to pick between, so the server's live-week fallback stands alone.
  if (uploads.length === 0) return null;

  const rawIdx = value ? uploads.indexOf(value) : -1;
  // A value that isn't in the uploads list (e.g. the wizard is on a just-renamed
  // or replayed file the once-fetched list hasn't caught up to) is treated as
  // the CURRENT week — index 0. That's what it effectively is (the wizard's live
  // selection), so the arrows anchor there instead of a phantom "before index 0"
  // position that would disable Newer and make Older skip the current upload.
  const idx = rawIdx >= 0 ? rawIdx : 0;
  const isCurrent = idx === 0;
  const arrowCls =
    "rounded-md border border-orange-200/80 bg-white p-1 text-zinc-500 transition-colors hover:bg-orange-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-blue-900/60 dark:bg-blue-950/30 dark:text-zinc-400 dark:hover:bg-blue-950/50";
  // Newer = a lower index (0 = current); older = a higher index. Disabled at the
  // ends of the list.
  const canOlder = idx < uploads.length - 1;
  const canNewer = idx > 0;
  const stepOlder = () => onChange(uploads[idx + 1] ?? uploads[uploads.length - 1] ?? null);
  const stepNewer = () => onChange(uploads[idx - 1] ?? uploads[0] ?? null);

  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2 px-0.5">
      <div ref={ref} className="relative inline-flex items-center gap-1">
        <button type="button" aria-label="Older period" onClick={stepOlder} disabled={!canOlder} className={arrowCls}>
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
            {periodLabelFromFilename(value)}
          </span>
          <span
            className={`rounded-full px-1.5 py-0.5 font-mono text-[8px] font-semibold tracking-wide uppercase ${
              isCurrent
                ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300"
                : "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
            }`}
          >
            {isCurrent ? "Current" : "Past"}
          </span>
          <ChevronDown className={`h-3.5 w-3.5 text-zinc-400 transition-transform ${open ? "rotate-180" : ""}`} />
        </button>

        <button type="button" aria-label="Newer period" onClick={stepNewer} disabled={!canNewer} className={arrowCls}>
          <ChevronRight className="h-3.5 w-3.5" />
        </button>

        <AnimatePresence>
          {open && (
            <motion.div
              initial={{ opacity: 0, y: -6, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -6, scale: 0.98 }}
              transition={{ duration: 0.16, ease: EASE }}
              className="absolute top-full left-0 z-30 mt-1.5 w-64 overflow-hidden rounded-xl border border-orange-200/80 bg-white shadow-xl dark:border-blue-900/60 dark:bg-[#0d1117]"
            >
              <div className="flex items-center justify-between border-b border-orange-100 px-3 py-2 dark:border-blue-950/60">
                <span className="font-mono text-[9px] font-semibold tracking-[0.16em] text-zinc-500 uppercase">
                  Hubstaff uploads
                </span>
                {!isCurrent && (
                  <button
                    type="button"
                    onClick={() => {
                      onChange(null);
                      setOpen(false);
                    }}
                    title="Reset to the current payroll week — Readiness follows the Payroll Wizard again"
                    className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-1.5 py-0.5 font-mono text-[9px] font-semibold tracking-wide text-emerald-700 uppercase transition-colors hover:bg-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-300 dark:hover:bg-emerald-950/70"
                  >
                    <Zap className="h-2.5 w-2.5" /> Current
                  </button>
                )}
              </div>
              <ul className="max-h-64 overflow-y-auto py-1">
                {uploads.map((f, i) => {
                  const selected = f === value;
                  const current = i === 0;
                  return (
                    <li key={f}>
                      <button
                        type="button"
                        onClick={() => {
                          onChange(f);
                          setOpen(false);
                        }}
                        className={`flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs transition-colors ${
                          selected
                            ? "bg-orange-50 font-semibold text-orange-700 dark:bg-blue-950/50 dark:text-orange-300"
                            : "text-zinc-700 hover:bg-orange-50/60 dark:text-zinc-200 dark:hover:bg-blue-950/40"
                        }`}
                      >
                        <span className="truncate">{periodLabelFromFilename(f)}</span>
                        {current && (
                          <span className="shrink-0 rounded-full bg-emerald-100 px-1.5 py-0.5 font-mono text-[8px] font-semibold tracking-wide text-emerald-700 uppercase dark:bg-emerald-950/50 dark:text-emerald-300">
                            Current
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

      {/* Mode chip: makes it obvious whether the tab is mirroring the wizard or
          showing a hand-picked week. */}
      <span
        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.12em] ${
          following
            ? "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-300"
            : "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300"
        }`}
        title={
          following
            ? "This tab is following the Payroll Wizard’s selected period."
            : "You picked this week here — the wizard no longer changes it. Use “Current” to follow the wizard again."
        }
      >
        {following ? (
          <>
            <Sparkles className="h-2.5 w-2.5" /> Following wizard
          </>
        ) : (
          <>
            <CalendarDays className="h-2.5 w-2.5" /> Picked week
          </>
        )}
      </span>
    </div>
  );
}

/**
 * Period selector for the notes board — prev/next arrows step one Sunday–Saturday
 * pay period at a time in either direction (back through history, forward to
 * stage upcoming weeks); the dropdown lists the live week, next week, and every
 * other week that has notes, tagged Live / Upcoming / Past. Plain-button
 * disclosure (same pattern as the QC Overview's period selector) so Tab +
 * Enter/Space work natively.
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

  const isLive = value === currentWeek;
  const isFuture = value > currentWeek;
  // Step by exactly one pay-week in either direction — the arrows roam freely
  // (back through history, forward to stage upcoming weeks), not just across
  // weeks that already have notes.
  const prevWeek = addWeeks(value, -1);
  const nextWeek = addWeeks(value, 1);

  const arrowCls =
    "rounded-md border border-orange-200/80 bg-white p-1 text-zinc-500 transition-colors hover:bg-orange-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-blue-900/60 dark:bg-blue-950/30 dark:text-zinc-400 dark:hover:bg-blue-950/50";

  return (
    <div ref={ref} className="relative inline-flex items-center gap-1">
      <button
        type="button"
        aria-label="Older week"
        onClick={() => onChange(prevWeek)}
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
              : isFuture
                ? "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300"
                : "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
          }`}
        >
          {isLive ? "Live" : isFuture ? "Upcoming" : "Past"}
        </span>
        <ChevronDown
          className={`h-3.5 w-3.5 text-zinc-400 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      <button
        type="button"
        aria-label="Newer week"
        onClick={() => onChange(nextWeek)}
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
                const upcoming = w > currentWeek;
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
                      {upcoming && (
                        <span className="rounded-full bg-amber-100 px-1.5 py-0.5 font-mono text-[8px] font-semibold tracking-wide text-amber-700 uppercase dark:bg-amber-950/50 dark:text-amber-300">
                          Upcoming
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
