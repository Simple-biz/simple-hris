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
  DollarSign,
  FileText,
  Heart,
  ListChecks,
  Loader2,
  Lock,
  Pencil,
  Plus,
  PowerOff,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  StickyNote,
  Trash2,
  Upload,
  UserPlus,
  CalendarOff,
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
import { ConfettiBurst } from "@/components/ui/confetti-burst";
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
import { parseDateOnlyLocal } from "@/lib/date-only";
import { periodLabelFromFilename } from "@/lib/hubstaff/period-label";
import type {
  PayrollReadiness,
  ReadinessKpiDept,
  ReadinessMissingRate,
  ReadinessMissingBank,
  KpiDeptStatus,
  ExceptionKind,
  ReadinessScore,
  WizardSetupStep,
} from "@/lib/payroll/payroll-readiness";
import type { OffboardedPayrollCandidate } from "@/lib/payroll/offboarded-payroll-candidates";
import { celebrationStep, type ReadyWatchState } from "@/lib/payroll/readiness-celebration";
import {
  APPLY_NOTE_ADJUSTMENTS_EVENT,
  NOTE_ADJUSTMENT_REMOVED_EVENT,
  WIZARD_CYCLE_EVENT,
  REQUEST_WIZARD_CYCLE_EVENT,
  adjustmentDupKey,
  parseAdjustmentAmount,
  payWeekStartFromSourceFile,
  type WizardCycleDetail,
} from "@/lib/payroll/adjustment-bridge";
import { MANAGER_KPI_SOURCE, READINESS_SOURCE, sourceLabel } from "@/lib/payroll/readiness-audit";
import type { ReadinessActivityLine } from "@/lib/payroll/readiness-activity";
import { readinessRingColor } from "@/lib/payroll/readiness-ring-color";
import {
  getTabCache,
  setTabCache,
  clearTabCache,
  hasFetchedThisSession,
  markFetchedThisSession,
  TAB_CACHE_KEYS,
} from "@/lib/accounting/tab-cache";

import { formatDeptLabel } from '@/lib/departments/hsl-subdept';
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

/** The three modal panes. `readiness` is the payroll-ready dashboard — leads
 *  the strip so it's the first thing an accountant sees; `checklist` is the
 *  original carry-over adjustments board (label reads "Adjustments and
 *  Notes"); `offboarded` is recently offboarded people who may still need
 *  their final pay's rate/bank set. (The read-only "Rates" Payment-Catalog
 *  glance was removed 2026-08-18 at Kane's ask — rates live in the Payment
 *  Catalog tab.) Kept left→right in this order so the directional slide reads
 *  naturally. */
type ModalTab = "readiness" | "checklist" | "offboarded";
const TAB_ORDER: ModalTab[] = ["readiness", "checklist", "offboarded"];

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

/**
 * ── Why this board caches ──────────────────────────────────────────────────
 * The FAB is mounted by App.tsx only while the Payroll Wizard tab is active, so
 * every trip to another tab unmounts it; the modal's panes also unmount on
 * each inner tab switch (AnimatePresence mode="wait"). Every dataset was
 * therefore re-pulled from scratch on the way back — the notes board, the worker
 * list, the offboarded final-pay list, the upload list, and the (expensive)
 * readiness snapshot, which was fetched TWICE over: once for the FAB's ring and
 * once for the pane.
 *
 * Each of them now seeds from the shared Accounting tab cache (in-memory +
 * sessionStorage, so it also survives a reload of this browser tab) and follows
 * stale-while-revalidate: paint what we already had instantly, then refresh
 * quietly behind it. Nothing goes stale silently — Realtime, the 30s poll, and
 * the focus refresh all still run, and they write back through the same cache.
 */

/** A readiness snapshot plus when it was pulled, so a remount can tell "seconds
 *  ago" (reuse as-is) from "a while ago" (paint it, then revalidate). */
type StampedReadiness = { readiness: PayrollReadiness; at: number };

/** Inside this window a remount reuses the cached snapshot with NO refetch — it
 *  matches the pane's own live poll, so a tab bounce can't be staler than
 *  sitting on the tab already was. */
const READINESS_FRESH_MS = 30_000;

/** Past this, a cached snapshot is too old to show even briefly (e.g. the tab
 *  sat open overnight) — such a load starts from the skeleton instead. */
const READINESS_MAX_AGE_MS = 6 * 60 * 60 * 1000;

function readCachedReadiness(sourceFile: string | null): StampedReadiness | null {
  const hit = getTabCache<StampedReadiness>(TAB_CACHE_KEYS.payrollReadiness(sourceFile));
  if (!hit?.readiness || typeof hit.at !== "number") return null;
  return Date.now() - hit.at > READINESS_MAX_AGE_MS ? null : hit;
}

/** Week keys cached this session, oldest first. A readiness snapshot is a
 *  sizeable payload, so paging back through a quarter of weeks would otherwise
 *  fill sessionStorage with snapshots nobody will look at again — only the most
 *  recent handful are kept. */
const cachedReadinessKeys: string[] = [];
const READINESS_CACHE_MAX_WEEKS = 4;

/** Share a freshly-pulled snapshot with every other reader of the same week —
 *  the FAB's ring and the Readiness pane hit the same endpoint, so whichever
 *  fetches first spares the other one the query. */
function writeCachedReadiness(sourceFile: string | null, readiness: PayrollReadiness): void {
  const key = TAB_CACHE_KEYS.payrollReadiness(sourceFile);
  setTabCache<StampedReadiness>(key, { readiness, at: Date.now() });
  const seen = cachedReadinessKeys.indexOf(key);
  if (seen >= 0) cachedReadinessKeys.splice(seen, 1);
  cachedReadinessKeys.push(key);
  while (cachedReadinessKeys.length > READINESS_CACHE_MAX_WEEKS) {
    clearTabCache(cachedReadinessKeys.shift()!);
  }
}

/** The Offboarded pane's cached pull — same stamped shape/idea as
 *  {@link StampedReadiness}, so a tab switch and back repaints instantly
 *  instead of re-running the whole final-pay assembly with a spinner. */
type StampedOffboarded = {
  people: OffboardedPayrollCandidate[];
  weekLabel: string | null;
  degraded: string[];
  at: number;
};

function readCachedOffboarded(sourceFile: string | null): StampedOffboarded | null {
  const hit = getTabCache<StampedOffboarded>(TAB_CACHE_KEYS.payrollNotesOffboarded(sourceFile));
  if (!hit?.people || typeof hit.at !== "number") return null;
  return Date.now() - hit.at > READINESS_MAX_AGE_MS ? null : hit;
}

/** Offboarded week keys cached this session, oldest first — trimmed like the
 *  readiness cache so replaying old weeks can't grow sessionStorage unbounded. */
const cachedOffboardedKeys: string[] = [];

function writeCachedOffboarded(
  sourceFile: string | null,
  value: Omit<StampedOffboarded, "at">,
): number {
  const at = Date.now();
  const key = TAB_CACHE_KEYS.payrollNotesOffboarded(sourceFile);
  setTabCache<StampedOffboarded>(key, { ...value, at });
  const seen = cachedOffboardedKeys.indexOf(key);
  if (seen >= 0) cachedOffboardedKeys.splice(seen, 1);
  cachedOffboardedKeys.push(key);
  while (cachedOffboardedKeys.length > READINESS_CACHE_MAX_WEEKS) {
    clearTabCache(cachedOffboardedKeys.shift()!);
  }
  return at;
}

/** Wall-clock of the notes board's last successful pull. Module-scoped (the
 *  rows cache stores no stamp) so it survives the FAB unmounting when the
 *  wizard tab is left, and honestly resets on a full page reload — the mount
 *  load re-earns it immediately. */
let checklistLastPullAt: number | null = null;

/** "Last data pull HH:MM:SS · Xs ago" line at the top of each pane — when the
 *  visible data last left the server. Stamped only by SUCCESSFUL loads (a
 *  failed background poll keeps the old, honest time), and ticking every 10s
 *  so the relative part can't quietly read stale. Renders nothing until the
 *  pane's first successful pull is known.
 *
 *  `live` is the pane's Realtime channel state (useLiveRefresh's
 *  onStatusChange): emerald dot = websocket subscribed, changes land in ~1s;
 *  amber dot = polling only (~30s worst case). `null` (channel not up yet)
 *  honestly reads Polling — until SUBSCRIBED fires, the poll IS the coverage.
 *  Either way the 30s poll keeps running, so the tooltips both say so. */
function PaneFreshness({
  at,
  live,
  className = "",
}: {
  at: number | null;
  live?: boolean | null;
  className?: string;
}) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 10_000);
    return () => window.clearInterval(id);
  }, []);
  if (at === null) return null;
  const ago = Math.max(0, Date.now() - at);
  const rel =
    ago < 15_000
      ? "just now"
      : ago < 60_000
        ? `${Math.round(ago / 1000)}s ago`
        : ago < 60 * 60_000
          ? `${Math.round(ago / 60_000)}m ago`
          : `${Math.round(ago / (60 * 60_000))}h ago`;
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 text-[11px] text-zinc-400 dark:text-zinc-500 ${className}`}
      title={`Last successful data pull: ${new Date(at).toLocaleString()}`}
    >
      {live !== undefined && (
        <span
          title={
            live
              ? "Live — Realtime connected: changes land in about a second (30s poll still runs as backup)"
              : "Polling — Realtime not connected: changes land within ~30s via the poll"
          }
          className="relative mr-0.5 flex h-2 w-2"
        >
          {live && (
            <span
              aria-hidden
              className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60 motion-reduce:hidden"
            />
          )}
          <span
            className={`relative inline-flex h-2 w-2 rounded-full ${
              live ? "bg-emerald-500" : "bg-amber-400"
            }`}
          />
          <span className="sr-only">{live ? "Live updates" : "Polling updates"}</span>
        </span>
      )}
      <Clock aria-hidden className="h-3 w-3" />
      Last data pull {new Date(at).toLocaleTimeString()} · {rel}
    </span>
  );
}

const RING_R = 30;
const RING_C = 2 * Math.PI * RING_R;
const GRADE_LABEL: Record<ReadinessScore["grade"], string> = {
  ready: "Ready",
  almost: "Almost",
  at_risk: "At risk",
  blocked: "Blocked",
};

export default function PayrollWizardNotesFab({
  sessionEmail,
  canEdit,
}: {
  sessionEmail: string | null;
  canEdit: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [modalTab, setModalTab] = useState<ModalTab>("readiness");
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
  // Readiness score for the closed FAB's progress ring — a lightweight,
  // independent read of the same endpoint the Readiness tab uses (score only;
  // the detail lists are irrelevant to a badge). Held for heardWizard-or-grace
  // so it never briefly shows the wrong week's score, mirroring
  // PayrollReadinessGlance's own hold. Decorative: any failure just leaves the
  // ring absent, never a toast.
  //
  // On a remount the ring is drawn from the cached snapshot for the wizard's
  // week as soon as the wizard says which week that is — no fetch, and still no
  // risk of flashing another week's number (which is why this isn't seeded
  // before `heardWizard`).
  const [fabScore, setFabScore] = useState<ReadinessScore | null>(null);
  const [fabScoreGrace, setFabScoreGrace] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setFabScoreGrace(true), 1500);
    return () => window.clearTimeout(t);
  }, []);
  const fabScoreReady = heardWizard || fabScoreGrace;
  /** `force` skips the cache — used after the modal closes, where the point is
   *  to catch a score change an inline fix just made. */
  const fetchFabScore = useCallback(
    (opts?: { force?: boolean }) => {
      if (!opts?.force) {
        // A snapshot the Readiness pane (or an earlier ring fetch) pulled seconds
        // ago answers this without a second trip to the endpoint.
        const cached = readCachedReadiness(wizardSourceFile);
        if (cached) {
          setFabScore(cached.readiness.score);
          if (Date.now() - cached.at < READINESS_FRESH_MS) return;
        }
      }
      const qs = wizardSourceFile ? `?source_file=${encodeURIComponent(wizardSourceFile)}` : "";
      fetch(`/api/payroll-wizard/readiness${qs}`, { cache: "no-store" })
        .then(async (res) => {
          const json = (await res.json()) as { readiness?: PayrollReadiness };
          if (!res.ok || !json.readiness) return;
          setFabScore(json.readiness.score);
          // Hand the whole snapshot to the Readiness pane too — opening the
          // modal now paints from this instead of re-running the query.
          writeCachedReadiness(wizardSourceFile, json.readiness);
        })
        .catch(() => {
          /* decorative only — the FAB just keeps its plain color */
        });
    },
    [wizardSourceFile],
  );
  // Mount + whenever the wizard's week settles or changes.
  useEffect(() => {
    if (!fabScoreReady) return;
    fetchFabScore();
  }, [fabScoreReady, fetchFabScore]);
  // Re-check when the Notes modal closes — a Readiness-tab inline fix
  // ("Set rate" / "Set bank") may have just changed the score, so this one
  // deliberately ignores the cache.
  const fabScoreWasOpenRef = useRef(false);
  useEffect(() => {
    if (fabScoreWasOpenRef.current && !open && fabScoreReady) fetchFabScore({ force: true });
    fabScoreWasOpenRef.current = open;
  }, [open, fabScoreReady, fetchFabScore]);
  // The closed FAB's center content alternates between the StickyNote icon and
  // the live percentage every 15s, so the number is visible without a hover —
  // runs regardless of `fabScore`; the render below just falls back to the
  // icon while there's nothing to show yet.
  const [fabShowPct, setFabShowPct] = useState(false);
  useEffect(() => {
    const id = window.setInterval(() => setFabShowPct((v) => !v), 15_000);
    return () => window.clearInterval(id);
  }, []);
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
  // Seeded from the cache so a return trip to the wizard shows the board
  // immediately; `loading` (the "Loading notes…" row) only appears on the first
  // pull of the session, never again on a remount.
  const [rows, setRows] = useState<PayrollWizardNoteRow[]>(
    () => getTabCache<PayrollWizardNoteRow[]>(TAB_CACHE_KEYS.payrollNotesRows) ?? [],
  );
  const [loading, setLoading] = useState(
    () => !hasFetchedThisSession(TAB_CACHE_KEYS.payrollNotesRows),
  );
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // When the board's rows last came back from the server — feeds the pane's
  // "Last data pull" line. Seeded from the module-level stamp so an inner tab
  // switch (or leaving the wizard tab) doesn't reset it to "unknown".
  const [notesPulledAt, setNotesPulledAt] = useState<number | null>(checklistLastPullAt);
  // Realtime channel state for the signal dot (null until SUBSCRIBED fires —
  // reads Polling, which is what's actually covering the board until then).
  const [notesRtLive, setNotesRtLive] = useState<boolean | null>(null);
  // Last-saved snapshot per row, so a blur only PATCHes cells that changed.
  // Seeded from the same cached rows, so editing a cell right after a remount
  // still compares against the real saved value rather than an empty baseline.
  const savedRef = useRef<Map<string, PayrollWizardNoteRow>>(
    new Map(
      (getTabCache<PayrollWizardNoteRow[]>(TAB_CACHE_KEYS.payrollNotesRows) ?? []).map((r) => [
        r.id,
        r,
      ]),
    ),
  );
  /** Mirror the SERVER-side truth into the cache. Driven off savedRef (which
   *  holds server copies and preserves row order), so a half-typed draft is
   *  never what a later mount seeds from — and so this runs on saves, not on
   *  keystrokes. */
  const cacheRows = useCallback(() => {
    setTabCache(TAB_CACHE_KEYS.payrollNotesRows, [...savedRef.current.values()]);
  }, []);
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
    cacheRows();
    setRows((prev) => {
      const localById = new Map(prev.map((r) => [r.id, r]));
      // Keep locally-edited cells (in-flight saves, mid-typing drafts) even
      // when a refresh lands — the server copy wins only where we're clean.
      return next.map((fresh) => {
        const local = localById.get(fresh.id);
        return local ? mergeRowPreservingDrafts(local, baseline.get(fresh.id), fresh) : fresh;
      });
    });
  }, [cacheRows]);

  const load = useCallback(async () => {
    try {
      const res = await fetch(API, { cache: "no-store" });
      const json = (await res.json()) as { rows?: PayrollWizardNoteRow[]; error?: string };
      if (!res.ok) throw new Error(json.error || `Load failed (${res.status})`);
      applyRows(json.rows ?? []);
      markFetchedThisSession(TAB_CACHE_KEYS.payrollNotesRows);
      checklistLastPullAt = Date.now();
      setNotesPulledAt(checklistLastPullAt);
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
  // Fetched once per page session on first open — cached, so a remount reuses
  // the list instead of re-pulling it; free text keeps working if the fetch
  // fails or while it's in flight.
  const [workers, setWorkers] = useState<PayrollWorkerOption[]>(
    () => getTabCache<PayrollWorkerOption[]>(TAB_CACHE_KEYS.payrollNotesWorkers) ?? [],
  );
  useEffect(() => {
    if (!open || !canEdit || workers.length > 0) return;
    if (hasFetchedThisSession(TAB_CACHE_KEYS.payrollNotesWorkers)) return;
    let alive = true;
    fetch("/api/payroll-wizard/notes/workers", { cache: "no-store" })
      .then(async (res) => (await res.json()) as { workers?: PayrollWorkerOption[] })
      .then((j) => {
        if (!alive) return;
        setWorkers(j.workers ?? []);
        setTabCache(TAB_CACHE_KEYS.payrollNotesWorkers, j.workers ?? []);
        markFetchedThisSession(TAB_CACHE_KEYS.payrollNotesWorkers);
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
    onStatusChange: (s) => setNotesRtLive(s === "live"),
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
        cacheRows();
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
    [cacheRows],
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
    // Clearing a linked row's Adjustment retracts its applied override too
    // (or, when the worker has other rows this week, subtracts just this one).
    if (field === "adjustment" && next === "" && prev !== "") {
      notifyAdjustmentRemoved(saved?.worker_email ?? row.worker_email, prev, {
        excludeRowId: id,
        weekStart: row.week_start,
      });
    }
    void saveRow(id, values);
  };

  /**
   * Whether an Adjustment cell can actually reach the wizard's Adj. column, and
   * if not, why — the same four rules the wizard's pull applies (linked worker ·
   * plain amount · present in the loaded timesheet · belongs to the week being
   * paid). Rendered under the cell, and ONLY when something is wrong: a clerk
   * used to type an amount, see it accepted, and get no hint that the row would
   * be skipped in silence.
   *
   * `null` = nothing to say (empty cell, or the row is fine).
   */
  const adjustmentIssue = useCallback(
    (row: PayrollWizardNoteRow): { label: string; title: string } | null => {
      const text = (row.adjustment ?? "").trim();
      if (text === "") return null;
      if (!parseAdjustmentAmount(text)) {
        return {
          label: "not a plain amount",
          title:
            "The wizard only auto-applies a cell that is JUST a figure — +₱500, -250.50, $50, COP 50,000. Put the reason in Notes and leave the number alone here.",
        };
      }
      const email = (row.worker_email ?? "").trim().toLowerCase();
      if (!email) {
        return {
          label: "worker not linked",
          title:
            "This row isn't tied to a person, so the amount has nowhere to land. Pick the Worker from the suggestion list (typed text that isn't an exact match unlinks the row).",
        };
      }
      // `workers` IS the loaded timesheet (same endpoint the wizard's CSV step
      // reads), so an email missing from it has no paystub to adjust this week.
      // Only meaningful once the list has loaded.
      if (workers.length > 0 && !workers.some((w) => (w.work_email ?? "").toLowerCase() === email)) {
        return {
          label: "not in this week's timesheet",
          title: `${email} has no hours in the Hubstaff CSV the wizard has loaded, so there is no paystub to adjust. The row stays open and carries over.`,
        };
      }
      // Ticked Done in a week the wizard is no longer paying: history, not a
      // pending item. It will not be re-applied (that would pay it twice).
      const cycleWeek = payWeekStartFromSourceFile(wizardSourceFile);
      if (row.done && cycleWeek !== null && row.week_start !== null && row.week_start !== cycleWeek) {
        return {
          label: "applied in an earlier week",
          title: `Filed Done under the week of ${row.week_start} — the wizard is paying ${cycleWeek}, so this amount is history and won't be applied again. Add a fresh row if it needs to be paid now.`,
        };
      }
      // Same worker, same week, several amounts. Since 2026-07-29 the wizard
      // ADDS them up — except an identical amount repeated, which it counts once
      // and treats as a suspected duplicate. Both cases are flagged, because
      // both change what the worker is paid and only the clerk can say which was
      // meant. (Before: the newest row silently won.)
      const rivals = rows.filter(
        (o) =>
          o.id !== row.id &&
          (o.worker_email ?? "").trim().toLowerCase() === email &&
          o.week_start === row.week_start &&
          parseAdjustmentAmount(o.adjustment) !== null,
      );
      if (rivals.length > 0) {
        const mine = parseAdjustmentAmount(text)!;
        const twins = rivals.filter((o) => {
          const p = parseAdjustmentAmount(o.adjustment);
          return p !== null && adjustmentDupKey(p) === adjustmentDupKey(mine);
        });
        if (twins.length > 0) {
          return {
            label: twins.length === rivals.length ? "possible duplicate" : "possible duplicate + combined",
            title: `${text} appears on ${twins.length + 1} rows for this worker this week. Identical amounts are NEVER added together — the wizard applies it once and warns, because the same figure twice is usually one item entered twice. If both are genuinely owed, put the sum in ONE cell (e.g. ${text.replace(/[\d,.]+/, (n) => String(Number(n.replace(/,/g, "")) * (twins.length + 1)))}) and delete the other row.`,
          };
        }
        // Nothing repeats MY amount, so this row is added in. Show the
        // arithmetic the wizard will do — deduped the same way (two of the OTHER
        // rows could still be twins of each other), and only totalled when every
        // amount is in pesos, since the board has no fx rates of its own.
        const group = [mine, ...rivals.map((o) => parseAdjustmentAmount(o.adjustment)!)];
        const uniq = [...new Map(group.map((p) => [adjustmentDupKey(p), p])).values()];
        const dropped = group.length - uniq.length;
        const peso = (n: number) =>
          `${n < 0 ? "-" : "+"}₱${Math.abs(n).toLocaleString("en-PH", { maximumFractionDigits: 2 })}`;
        const total = Math.round(uniq.reduce((s, p) => s + p.amount, 0) * 100) / 100;
        const tail = `${dropped > 0 ? ` (a repeated amount among the other rows is counted once)` : ""}. Delete a row instead if it was meant to REPLACE another.`;
        return {
          label: `combined with ${rivals.length} more`,
          title: uniq.every((p) => p.currency === "PHP")
            ? `This worker has ${group.length} Adjustments this week; the wizard adds the different ones up: ${uniq
                .map((p) => peso(p.amount))
                .join(" ")} = ${peso(total)}${tail}`
            : `This worker has ${group.length} Adjustments this week; the wizard adds the different ones up, converting the non-peso ones at its live fx rates${tail}`,
        };
      }
      return null;
    },
    [workers, wizardSourceFile, rows],
  );

  /** Tell the wizard a linked adjustment left the board — the row was deleted
   *  or its Adjustment cell cleared — so the Adj. override it fed comes down
   *  with it (the wizard acts only while its current value still equals the
   *  board's total before this removal; a hand-typed wizard figure is never
   *  touched).
   *
   *  `remaining` = that worker's OTHER Adjustment cells for the same pay week.
   *  Amounts are added together now, so removing one of several is a SUBTRACTION
   *  — the wizard needs the survivors to know what is still owed. Sent as raw
   *  text: only the wizard has the fx rates to total mixed currencies. */
  const notifyAdjustmentRemoved = (
    workerEmail: string | null,
    adjustment: string | null,
    opts: { excludeRowId: string; weekStart: string | null },
  ) => {
    const email = (workerEmail ?? "").trim().toLowerCase();
    const text = (adjustment ?? "").trim();
    if (!email || !text) return;
    const remaining = rows
      .filter(
        (o) =>
          o.id !== opts.excludeRowId &&
          (o.worker_email ?? "").trim().toLowerCase() === email &&
          o.week_start === opts.weekStart &&
          parseAdjustmentAmount(o.adjustment) !== null,
      )
      .map((o) => (o.adjustment ?? "").trim());
    window.dispatchEvent(
      new CustomEvent(NOTE_ADJUSTMENT_REMOVED_EVENT, {
        detail: { workerEmail: email, adjustment: text, remaining },
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
      cacheRows();
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
      cacheRows();
      // A deleted note takes its applied adjustment with it (match-checked
      // wizard-side, so only an override this row produced is cleared — and
      // when the worker has other rows this week, only THIS row's share).
      if (removed)
        notifyAdjustmentRemoved(removed.worker_email, removed.adjustment, {
          excludeRowId: removed.id,
          weekStart: removed.week_start,
        });
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

  // FAB readiness ring geometry — clamped once so the mount/animate/hover
  // states below all agree on the same fill fraction.
  const fabPct = fabScore ? Math.max(0, Math.min(100, fabScore.value)) : 0;
  const fabDash = (fabPct / 100) * RING_C;

  return (
    <>
      <div className="fixed right-5 bottom-5 z-40 h-16 w-16">
        {fabScore && (
          <svg
            viewBox="0 0 64 64"
            className="pointer-events-none absolute inset-0 h-full w-full -rotate-90"
            aria-hidden="true"
          >
            <circle
              cx="32"
              cy="32"
              r={RING_R}
              fill="none"
              strokeWidth="3"
              className="text-black/10 dark:text-white/10"
              stroke="currentColor"
            />
            <motion.circle
              cx="32"
              cy="32"
              r={RING_R}
              fill="none"
              strokeWidth="3"
              strokeLinecap="round"
              stroke={readinessRingColor(fabScore.value)}
              strokeDasharray={RING_C}
              initial={{ strokeDashoffset: reduceMotion ? RING_C - fabDash : RING_C }}
              animate={{ strokeDashoffset: RING_C - fabDash }}
              transition={{ duration: reduceMotion ? 0 : 0.9, ease: EASE }}
            />
          </svg>
        )}
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={`Open payroll notes and readiness${openCount > 0 ? ` (${openCount} open)` : ""}${fabScore ? `, readiness ${Math.round(fabPct)}% — ${GRADE_LABEL[fabScore.grade]}` : ""}`}
          title={fabScore ? `Readiness: ${Math.round(fabPct)}% (${GRADE_LABEL[fabScore.grade]})` : undefined}
          className="notes-fab-pulse absolute inset-0 m-auto flex h-13 w-13 items-center justify-center rounded-full bg-gradient-to-br from-orange-500 to-amber-500 text-white shadow-lg shadow-orange-500/30 transition-[filter] hover:brightness-110 focus-visible:ring-3 focus-visible:ring-orange-400/60 focus-visible:outline-none dark:from-orange-600 dark:to-amber-600"
        >
          <AnimatePresence mode="wait" initial={false}>
            {fabScore && fabShowPct ? (
              <motion.span
                key="pct"
                initial={{ opacity: reduceMotion ? 1 : 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: reduceMotion ? 1 : 0 }}
                transition={{ duration: reduceMotion ? 0 : 0.2 }}
                className="text-base font-extrabold tabular-nums"
              >
                {Math.round(fabPct)}%
              </motion.span>
            ) : (
              <motion.span
                key="icon"
                initial={{ opacity: reduceMotion ? 1 : 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: reduceMotion ? 1 : 0 }}
                transition={{ duration: reduceMotion ? 0 : 0.2 }}
                className="flex"
              >
                <StickyNote className="h-6 w-6" />
              </motion.span>
            )}
          </AnimatePresence>
          {openCount > 0 && (
            <span className="absolute -top-1 -right-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-blue-600 px-1 text-[11px] font-bold text-white ring-2 ring-white dark:ring-[#0d1117]">
              {openCount > 99 ? "99+" : openCount}
            </span>
          )}
        </button>
      </div>

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
                  Recently offboarded people who may still need their final paycheck&apos;s pay
                  rate or bank details set. They drop off this list automatically once their final
                  pay has gone out.
                </>
              )}
            </DialogDescription>
          </DialogHeader>

          <div className="flex items-center gap-1 border-b border-orange-100 dark:border-blue-950/60">
            {(
              [
                { id: "readiness", label: "Readiness", icon: ShieldCheck },
                { id: "checklist", label: "Adjustments and Notes", icon: ListChecks },
                { id: "offboarded", label: "Offboarded", icon: PowerOff },
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

          {/* Directional cross-fade between the panes: the slide follows
              which tab you moved toward (tabDir), and every pane keeps the same
              h-[70vh] body height so the dialog never jumps mid-swap. Gated on
              reduced motion. */}
          <div className="overflow-x-clip">
          <AnimatePresence mode="wait" initial={false} custom={tabDir}>
          {modalTab === "readiness" ? (
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
          ) : modalTab === "offboarded" ? (
            <motion.div
              key="offboarded"
              custom={tabDir}
              variants={PANE_VARIANTS}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ duration: reduceMotion ? 0 : 0.24, ease: EASE }}
            >
              <OffboardedGlance wizardSourceFile={wizardSourceFile} canEdit={canEdit} />
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
            <div className="flex flex-wrap items-center gap-3">
              <PaneFreshness at={notesPulledAt} live={notesRtLive} />
              <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-zinc-600 dark:text-zinc-300">
                Show everyone&apos;s notes
                <Switch
                  size="sm"
                  checked={showOthers}
                  onCheckedChange={(checked) => toggleShowOthers(checked === true)}
                />
              </label>
            </div>
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
                      {COLUMNS.slice(2).map(({ field }) => {
                        const issue = field === "adjustment" ? adjustmentIssue(row) : null;
                        return (
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
                          {/* Why this amount won't reach the wizard's Adj. column.
                              Shown only when there IS a problem — a clean row stays
                              quiet, so the warning means something. */}
                          {issue && (
                            <span
                              title={issue.title}
                              className="mt-0.5 flex items-center gap-1 text-[9px] font-medium leading-tight text-amber-600 dark:text-amber-400"
                            >
                              <AlertTriangle className="h-2.5 w-2.5 shrink-0" />
                              {issue.label}
                            </span>
                          )}
                        </td>
                        );
                      })}
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
  // Switched out of this week's pay in the Payroll Wizard's step-1
  // Configuration tab — listed for visibility, owes nothing, scores nothing.
  excluded: {
    label: "Excluded",
    cls: "border-red-200 bg-red-50 text-red-500 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300",
    Icon: PowerOff,
  },
};

/** A KPI dept is "settled" for the week when its manager marked it ready/locked,
 *  it isn't due this week, it has no bonus configured at all, or it's excluded
 *  from this week's pay in the wizard's Configuration tab. Draft = still
 *  left to do. */
function isKpiSettled(s: KpiDeptStatus): boolean {
  return s === "ready" || s === "locked" || s === "na" || s === "no_bonus" || s === "excluded";
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
  // Missing bank info that Accounting excused for THIS week from the Bank Info
  // tab. Violet keeps it visually distinct from the HR-pipeline kinds: it's the
  // one exception a human granted by hand, and the only one with an Undo.
  bank_exempt: {
    label: "Temp exempt",
    cls: "border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-300",
    Icon: Clock,
  },
};

/** The Readiness pane's five inner tabs — Wizard Setup (a per-week prerequisite
 *  checklist, no matching stat tile) plus one per detail list. Left→right order
 *  matches the stat-tile row for the latter four, so the directional slide
 *  reads naturally. */
type ReadinessTab = "setup" | "kpi" | "rate" | "bank" | "exc" | "hours";
const READINESS_TAB_ORDER: ReadinessTab[] = ["setup", "kpi", "rate", "bank", "exc", "hours"];

/** A single readiness stat tile (§6.3) — a read-only summary count. `tone` picks
 *  the palette. When `percent` is given (the dimension's 0–100 score from the
 *  server's readiness-score components), the tile also shows the percent and a
 *  thin progress bar, so each dimension is monitorable as a score — it moves
 *  the moment a bank account / rate / KPI submission lands (live refresh).
 *  (Switching between the four detail lists is the job of the explicit tab
 *  strip below the tiles, not the tiles themselves.) */
function ReadinessStat({
  label,
  value,
  sub,
  tone,
  Icon,
  percent,
}: {
  label: string;
  value: number | string;
  sub: string;
  tone: "emerald" | "amber" | "sky" | "orange";
  Icon: typeof CheckCircle2;
  percent?: number;
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
          <div className="mt-0.5 flex items-baseline gap-1.5">
            <span className="text-base font-bold tracking-tight tabular-nums sm:text-lg">{value}</span>
            {percent != null && (
              <span className={`text-[11px] font-bold tabular-nums ${p.text}`}>{percent}%</span>
            )}
          </div>
          <div className="mt-0.5 truncate text-[10px] text-zinc-500 dark:text-zinc-400">{sub}</div>
        </div>
        <div className={`hidden h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br ${p.icon} text-white sm:flex`}>
          <Icon className="h-4 w-4" />
        </div>
      </div>
      {/* Score bar — the dimension's percent, so progress is visible at a
          glance and moves live as items are fixed. */}
      {percent != null && (
        <div
          className="relative mt-1.5 h-1 overflow-hidden rounded-full bg-zinc-200/70 dark:bg-zinc-800"
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${label} score`}
        >
          <div
            className={`h-full rounded-full bg-gradient-to-r transition-[width] duration-500 ${p.icon}`}
            style={{ width: `${Math.max(0, Math.min(100, percent))}%` }}
          />
        </div>
      )}
    </div>
  );
}

/** Explicit tab strip for the Readiness pane — one labeled tab per detail list
 *  plus the Wizard Setup checklist, each with icon, name, and a live count
 *  badge, plus a sliding `layoutId` underline under the active tab (matching
 *  the modal's top-level tabs). This is the control the user reaches for to
 *  switch between Wizard Setup, KPI Submissions, No Pay Rate, Bank Info, and
 *  Exceptions. Horizontally scrollable on narrow widths so all five stay
 *  reachable. */
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
    { id: "setup", label: "Wizard Setup", Icon: ListChecks },
    { id: "kpi", label: "KPI Submissions", Icon: ClipboardList },
    { id: "rate", label: "No Pay Rate", Icon: Wallet, blocker: true },
    { id: "bank", label: "Bank Info", Icon: Banknote },
    { id: "exc", label: "Exceptions", Icon: UserPlus, neutral: true },
    // Neutral like Exceptions, and for the same reason: a no-hours person is
    // correctly paid nothing this week, so the count is a reconciliation prompt
    // ("still active? on leave? sick? or was nobody told they left?"), never a
    // blocker to clear before running payroll. With Lead Gen tracked (Kane's
    // 2026-08-21 ruling) it sits near 190 every week, which would make an amber
    // "fix me" badge permanent and therefore meaningless.
    { id: "hours", label: "No Hours", Icon: CalendarOff, neutral: true },
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

/** Status pill + row meta for the Wizard setup checklist. Read-only by design —
 *  fixes happen on the wizard steps themselves; the detail names which one. */
const SETUP_STATUS_PILL: Record<
  WizardSetupStep["status"],
  { label: string; cls: string; Icon: typeof CheckCircle2 }
> = {
  done: {
    label: "Done",
    cls: "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300",
    Icon: CheckCircle2,
  },
  attention: {
    label: "Attention",
    cls: "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300",
    Icon: AlertTriangle,
  },
  blocked: {
    label: "Blocked",
    cls: "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300",
    Icon: AlertTriangle,
  },
  pending: {
    label: "Pending",
    cls: "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-300",
    Icon: Clock,
  },
};

const SETUP_STEP_ICON: Record<WizardSetupStep["key"], typeof CheckCircle2> = {
  csv: Upload,
  fx: DollarSign,
  orphanage: Heart,
  kpi: Sparkles,
  notes: StickyNote,
  contractors: FileText,
  dispatch: Send,
};

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
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  shown: number;
  total: number;
  /** Wrapper class override — defaults to `mb-2` for the standalone layout;
   *  pass e.g. `min-w-0 flex-1` when the box shares a filter row. */
  className?: string;
}) {
  const active = value.trim() !== "";
  return (
    <div className={`relative ${className ?? "mb-2"}`}>
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

/**
 * Column layout for the No Pay Rate list: person · department · start · action.
 * The list wrapper ({@link RATE_GRID}) owns the four column tracks and the
 * header and every row are subgrid rows of it, so the auto-sized status column
 * resolves ONCE for the whole list — sizing it per row let the "Left" pill
 * shift the department / start-date columns from row to row. Below `sm` the
 * modal is too narrow for four columns, so the wrapper stacks normally and
 * each row collapses to a one-column grid whose cells carry inline labels.
 */
const RATE_GRID =
  "space-y-0.5 sm:grid sm:grid-cols-[minmax(0,1fr)_minmax(0,8.5rem)_minmax(0,9rem)_auto] sm:gap-x-3 sm:gap-y-0.5 sm:space-y-0";
const RATE_COLS =
  "grid grid-cols-1 items-start gap-x-3 gap-y-0.5 sm:col-span-4 sm:grid-cols-subgrid sm:items-center";

/** "Jul 20, 2026" for a `YYYY-MM-DD` start date. Parsed as a LOCAL calendar date
 *  (see parseDateOnlyLocal) so it never renders a day early west of UTC. */
function formatStartDate(iso: string | null): string {
  const d = parseDateOnlyLocal(iso);
  if (!d) return "—";
  try {
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return iso ?? "—";
  }
}

/** One row of the No Pay Rate list, in the {@link RATE_COLS} column layout.
 *  Department and start date are shown as their own columns (not squeezed into
 *  the email sub-line) because they're how Accounting triages this list: which
 *  team owes the rate, and whether the person is a brand-new hire. */
function RatePersonRow({
  person,
  canEdit,
  onFix,
}: {
  person: ReadinessMissingRate;
  canEdit: boolean;
  onFix: () => void;
}) {
  return (
    <div
      className={`${RATE_COLS} rounded-lg px-2 py-1.5 transition-colors hover:bg-orange-50/50 dark:hover:bg-blue-950/30`}
    >
      <div className="min-w-0">
        <div className="truncate text-[13px] font-medium text-zinc-800 dark:text-zinc-100">
          {person.name}
        </div>
        <div className="truncate text-[10px] text-zinc-400 dark:text-zinc-500">
          {person.email || "—"}
        </div>
      </div>
      <div className="min-w-0 truncate text-[11px] text-zinc-600 dark:text-zinc-300">
        <span className="text-zinc-400 sm:hidden dark:text-zinc-500">Dept · </span>
        {formatDeptLabel(person.department) || "—"}
      </div>
      <div className="min-w-0 text-[11px] text-zinc-600 dark:text-zinc-300">
        <span className="text-zinc-400 sm:hidden dark:text-zinc-500">Started · </span>
        {formatStartDate(person.startDate)}
        {person.recentlyOnboarded && (
          <span
            title="Onboarded within the last two payroll weeks — they already have hours, they just need a rate set in the Payment Catalog"
            className="ml-1 inline-block rounded-full border border-amber-200 bg-amber-50 px-1.5 py-0.5 align-middle text-[9px] font-semibold uppercase tracking-wide text-amber-700 sm:ml-0 sm:mt-0.5 sm:block sm:w-fit dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300"
          >
            New hire
          </span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1.5 sm:justify-end">
        {/* Off-boarded mid-week: explains the row (nothing links them to a
            department any more) without dismissing it — final hours still need
            a rate to be paid. */}
        {person.offBoardedAt && (
          <span
            title={`Off-boarded ${formatStartDate(person.offBoardedAt)} — still needs a rate if their final hours are being paid`}
            className="shrink-0 rounded-full border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-zinc-500 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-400"
          >
            Left
          </span>
        )}
        <span className="shrink-0 rounded-full border border-rose-200 bg-rose-50 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300">
          No rate
        </span>
        {canEdit && (
          <RowFixButton
            label="Set rate"
            onClick={onFix}
            disabled={!person.email}
            title={
              person.email
                ? "Set this person's pay rate"
                : "No email on the roster — set the rate from the Payment Catalog"
            }
          />
        )}
      </div>
    </div>
  );
}

/** Rows per page for the paginated people lists (No Pay Rate / Bank Info /
 *  Exceptions). Ten keeps a page short enough to scan without scrolling. */
const READINESS_PAGE_SIZE = 10;

/** Sentinel value for the Bank Info department filter selecting rows that have
 *  no department on the roster (can't be `""` — that means "all"). */
const BANK_NO_DEPT = "__no_dept__";

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
  const excluded = dept.status === "excluded";
  const pct = excluded
    ? 0
    : dept.employeeCount > 0
      ? Math.round((dept.scoredCount / dept.employeeCount) * 100)
      : settled
        ? 100
        : 0;
  const pill = KPI_STATUS_PILL[dept.status];
  const barCls = excluded
    ? "bg-zinc-300 dark:bg-zinc-700"
    : settled
      ? "bg-gradient-to-r from-emerald-400 to-teal-500"
      : "bg-gradient-to-r from-amber-400 to-orange-500";
  const rowCls = `flex w-full items-center gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-orange-50/50 dark:hover:bg-blue-950/30${excluded ? " opacity-60" : ""}`;
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
        {/* Who sent this week to Accounting (Kane, 2026-08-18) — the audit
            trail's verified actor. A pre-trail week (~before Jul 25) may know
            the who (locked_by fallback) but not the when — no timestamp is
            invented for it. "via" renders only for a non-default origin (a
            Readiness-tab fix), since "via Manager KPI tab" is the norm. */}
        {(dept.status === "ready" || dept.status === "locked") && dept.submittedBy && (
          <div
            className="mt-0.5 truncate text-[9.5px] text-zinc-400 dark:text-zinc-500"
            title={dept.submittedAt ? new Date(dept.submittedAt).toLocaleString() : undefined}
          >
            Submitted by{" "}
            <span className="font-medium text-zinc-500 dark:text-zinc-400">{dept.submittedBy}</span>
            {dept.submittedAt ? ` · ${formatSubmittedAt(dept.submittedAt)}` : ""}
            {dept.submittedVia && dept.submittedVia !== sourceLabel(MANAGER_KPI_SOURCE)
              ? ` · via ${dept.submittedVia}`
              : ""}
          </div>
        )}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-0.5">
        <span className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] ${pill.cls}`}>
          <pill.Icon className="h-2.5 w-2.5" />
          {pill.label}
        </span>
        {dept.status === "excluded" ? (
          <span className="text-[9.5px] text-red-400/80 dark:text-red-400/70">
            off in wizard Configuration
          </span>
        ) : dept.status === "no_bonus" ? (
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

/** "Aug 18, 2:31 PM" for the KPI rows' submitted stamp. Falls back to the raw
 *  ISO string rather than rendering an Invalid Date. */
function formatSubmittedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Bottom-of-pane "recent changes" strip (Kane, 2026-08-18): audited saves from
 * the last 15 minutes — rates (Payment Catalog), bank/payout, People-tab
 * edits, KPI submissions — so Accounting can tell someone is mid-fix while
 * staring at the numbers. Lines arrive fully composed from the server
 * (readiness-activity.ts) and are informational only: audited SAVES, not
 * presence — a manager mid-scoring shows up when they Mark Ready, because KPI
 * score-saves are deliberately not audited. Renders its empty state rather
 * than vanishing, so "nothing is happening" is also an answer.
 */
function ReadinessActivityFeed({ lines }: { lines: ReadinessActivityLine[] }) {
  const toneCls: Record<ReadinessActivityLine["surface"], string> = {
    kpi: "bg-sky-400",
    rates: "bg-amber-400",
    bank: "bg-emerald-400",
    people: "bg-violet-400",
  };
  return (
    <div className="mt-2 shrink-0 rounded-lg border border-orange-100 bg-orange-50/40 px-2.5 py-1.5 dark:border-blue-950/60 dark:bg-blue-950/20">
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        <Zap aria-hidden className="h-3 w-3 text-orange-400" />
        Recent changes · last 15 min
      </div>
      {lines.length === 0 ? (
        <p className="mt-0.5 text-[10.5px] text-zinc-400 dark:text-zinc-500">
          No payroll data changes in the last 15 minutes.
        </p>
      ) : (
        <ul className="mt-1 max-h-24 space-y-0.5 overflow-y-auto">
          {lines.map((l, i) => (
            <li
              key={`${l.at}-${i}`}
              className="flex items-center gap-1.5 text-[10.5px] text-zinc-500 dark:text-zinc-400"
            >
              <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${toneCls[l.surface]}`} />
              <span className="shrink-0 tabular-nums text-zinc-400 dark:text-zinc-500">
                {new Date(l.at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
              </span>
              <span className="min-w-0 truncate">
                <span className="font-medium text-zinc-600 dark:text-zinc-300">{l.actor ?? "Someone"}</span>{" "}
                {l.label}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
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
          {[formatDeptLabel(department) || null, email].filter(Boolean).join(" · ") || "—"}
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
  Icon = Pencil,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  /** Leading glyph — defaults to the pencil the edit actions share. Actions that
   *  aren't edits (e.g. a per-week exemption) pass their own so two buttons on
   *  the same row don't read as the same kind of thing. */
  Icon?: typeof Pencil;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-orange-200/80 bg-white px-2 py-1 text-[10px] font-semibold whitespace-nowrap text-orange-700 transition-colors hover:bg-orange-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-blue-900/60 dark:bg-blue-950/30 dark:text-orange-300 dark:hover:bg-blue-950/50"
    >
      <Icon className="h-3 w-3" />
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
  prefill,
  onClose,
  onSaved,
}: {
  person: ReadinessMissingBank;
  /** Seeds the form from a known-but-not-yet-saved source (e.g. an offboard
   *  snapshot) instead of starting blank. The clerk can still edit every
   *  field before saving — this only changes the initial values. */
  prefill?: {
    /** Pre-SELECTS the picker without locking it. A prefilled processor comes
     *  from a source that isn't on the live employee_ids row yet (an offboard
     *  snapshot), so `locked` must stay false — otherwise `save` skips writing
     *  `preferred_processor` and the person stays unpayable after a "successful"
     *  save. Only `person.processor` (live-resolved) locks the picker.
     *  Nullable so an `OffboardedBankPrefill` (whose `processor` is
     *  `string | null`) can be handed straight through. */
    processor?: string | null;
    walletEmail?: string;
    walletName?: string;
    bankName?: string;
    accountHolder?: string;
    accountNumber?: string;
    swiftCode?: string;
  };
  onClose: () => void;
  onSaved: () => void;
}) {
  const lockedProcessor = (person.processor ?? "") as ProcessorId | "";
  const [processor, setProcessor] = useState<string>(lockedProcessor || (prefill?.processor ?? ""));
  const [walletEmail, setWalletEmail] = useState(prefill?.walletEmail ?? "");
  const [walletName, setWalletName] = useState(prefill?.walletName ?? "");
  const [bankName, setBankName] = useState(prefill?.bankName ?? "");
  const [accountHolder, setAccountHolder] = useState(prefill?.accountHolder ?? "");
  const [accountNumber, setAccountNumber] = useState(prefill?.accountNumber ?? "");
  const [swiftCode, setSwiftCode] = useState(prefill?.swiftCode ?? "");
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
 * "Temporary Exemption" confirm for a Bank Info row — files a per-week record
 * (POST /api/payroll-wizard/bank-exemptions) that moves the person off the Bank
 * Info list and out of the readiness score's bank dimension, onto the Exceptions
 * list, for the week in view ONLY.
 *
 * Deliberately a confirm rather than a one-click action: the optional reason is
 * the only context whoever reads the Exceptions row later will have, and an
 * accidental click on a row full of near-identical names is easy.
 *
 * It changes NOTHING about payability — Payment Dispatch never reads these
 * records — so the copy says so outright rather than letting an accountant think
 * the exemption got the person paid.
 */
function ExemptBankDialog({
  person,
  weekLabel,
  weekStart,
  onClose,
  onSaved,
}: {
  person: ReadinessMissingBank;
  /** "Jul 27 – Aug 2" — the week the exemption will apply to. */
  weekLabel: string;
  weekStart: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/payroll-wizard/bank-exemptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          weekStart,
          name: person.name,
          workEmail: person.workEmail,
          personalEmail: person.personalEmail,
          department: person.department,
          reason: reason.trim() || null,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok || json.error) throw new Error(json.error || `Save failed (${res.status})`);
      toast.success(`${person.name} exempted for this week`, {
        description: `Moved to Exceptions for ${weekLabel}. They return to Bank Info next week if details are still missing.`,
      });
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not file the exemption");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-orange-500" />
            Temporary exemption
          </DialogTitle>
          <DialogDescription>
            {person.name}
            {person.email ? ` · ${person.email}` : ""} — excuses their missing bank info
            for {weekLabel} only.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="rounded-lg border border-sky-200 bg-sky-50/70 px-3 py-2 text-[11px] leading-relaxed text-sky-800 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-200">
            They move to <span className="font-semibold">Exceptions</span> straight away and
            stop counting against the readiness score. They come back on the Bank Info list
            <span className="font-semibold"> next week</span> if their details are still
            missing.
            {person.onPayroll && (
              <>
                {" "}
                This person has hours this week — the exemption clears the readiness flag,
                but it does <span className="font-semibold">not</span> make them payable.
                Payment Dispatch still can’t send money without payout details.
              </>
            )}
          </div>
          <div className="grid gap-1">
            <label className={EDITOR_LABEL_CLS} htmlFor="readiness-exempt-reason">
              Reason <span className="font-normal normal-case">(optional)</span>
            </label>
            <Input
              id="readiness-exempt-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={300}
              placeholder="e.g. waiting on her Wise handle"
              className="h-8 text-xs"
            />
            <p className="text-[10px] text-zinc-400 dark:text-zinc-500">
              Shows on the Exceptions row so whoever looks next knows why.
            </p>
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
              Exempt this week
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * KPI Calculator modal for a clicked Readiness department — the SAME calculator
 * the manager uses, mounted elevated so accounting can score and Mark Ready
 * without leaving the wizard. Being the same component, it autosaves the same
 * way, and closing this dialog unmounts it, which flushes any pending write.
 * General depts get DeptBonusCalculator with
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
            The same calculator the manager uses — entries save themselves as you score.
            Mark Ready from here; Readiness refreshes when you close this.
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
 * when everything's settled, a 4-up stat-tile row, then five tabbed sections:
 * Wizard Setup (the per-week 7-step prerequisite checklist, shown first and
 * selected by default — no matching stat tile, not part of the score), KPI
 * submission (per dept, with a "how much is left" bar), no-rate workers,
 * no-bank employees, and onboarding exceptions. Read-only; fetched from
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
  // Seeded from the cached snapshot for the week the wizard is on (see
  // readCachedReadiness): switching modal tabs — or leaving the wizard entirely
  // and coming back — unmounts this pane, and re-running the readiness query
  // behind a full "Gathering data…" skeleton each time is the reload this cache
  // exists to kill. `hasPicked` is false at mount, so the wizard's week IS the
  // effective week here.
  const [data, setData] = useState<PayrollReadiness | null>(
    () => readCachedReadiness(wizardSourceFile)?.readiness ?? null,
  );
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(() => readCachedReadiness(wizardSourceFile) === null);
  // When the snapshot on screen was actually pulled from the server — a cached
  // paint keeps the cache's own stamp (that IS when the data left the server),
  // a live load stamps "now". Feeds the pane's "Last data pull" line.
  const [pulledAt, setPulledAt] = useState<number | null>(
    () => readCachedReadiness(wizardSourceFile)?.at ?? null,
  );
  // Realtime channel state for the signal dot (null until SUBSCRIBED fires —
  // reads Polling, which is what's actually covering the pane until then).
  const [rtLive, setRtLive] = useState<boolean | null>(null);
  // Mirrors `data` for the fetch path, which needs to know whether there's a
  // snapshot on screen without taking `data` as a dependency.
  const dataRef = useRef<PayrollReadiness | null>(data);
  // One shared search box per section, filtering that list live.
  const [kpiQuery, setKpiQuery] = useState("");
  const [rateQuery, setRateQuery] = useState("");
  const [bankQuery, setBankQuery] = useState("");
  const [excQuery, setExcQuery] = useState("");
  const [hoursQuery, setHoursQuery] = useState("");
  // "Recently onboarded" filter for the No Pay Rate list — when on, only new
  // hires (started this pay week or the one before) show.
  const [rateNewOnly, setRateNewOnly] = useState(false);
  // Department filter for the Bank Info list ("" = all departments).
  const [bankDept, setBankDept] = useState("");
  // "Paying this week" filter for the Bank Info list — when on, only people
  // with hours in the week-in-view's Hubstaff file (the hard blockers) show.
  const [bankOnPayrollOnly, setBankOnPayrollOnly] = useState(false);
  // Which of the five tabs is showing (Wizard Setup + the four detail lists).
  // The explicit ReadinessTabStrip below the stat tiles is what switches it;
  // only the selected pane renders, swapped with a directional slide.
  // `readinessDir` carries the slide direction (+1 later tab / −1 earlier) so
  // switching left↔right reads like turning pages, matching the outer tabs.
  // Defaults to "setup" — the wizard-setup checklist is the first thing an
  // accountant should clear before the per-list details matter.
  const [readinessTab, setReadinessTab] = useState<ReadinessTab>("setup");
  const [readinessDir, setReadinessDir] = useState(0);
  // Person currently being fixed inline (null = no editor open). One at a time:
  // the rate editor files a Payment Catalog structure, the bank editor writes
  // payout details to employee_ids.
  const [ratePerson, setRatePerson] = useState<ReadinessMissingRate | null>(null);
  const [bankPerson, setBankPerson] = useState<ReadinessMissingBank | null>(null);
  // Person being granted a per-week Bank Info "Temporary Exemption" (null = the
  // confirm dialog is closed). Its own slot, so the two bank editors can never
  // fight over one piece of state.
  const [exemptPerson, setExemptPerson] = useState<ReadinessMissingBank | null>(null);
  // Exemption ids with an Undo request in flight, so a row's button can't be
  // double-fired while the POST is out.
  const [undoingExemptions, setUndoingExemptions] = useState<Set<string>>(new Set());
  // Dept whose KPI Calculator modal is open (null = closed).
  const [kpiDept, setKpiDept] = useState<ReadinessKpiDept | null>(null);
  // "Why this score?" breakdown modal — opened by clicking the score dial.
  const [scoreDetailsOpen, setScoreDetailsOpen] = useState(false);
  // ── "Payroll Ready" celebration ────────────────────────────────────────
  // Confetti when THIS week's score reaches a full 100/Ready while the tab is
  // open — the accountant just watched the last blocker clear (their own
  // inline fix landing, a manager marking ready over the live refresh, the
  // poll). Landing on a week that is ALREADY ready stays quiet (nothing
  // happened live), and the ref keys on the week so switching onto a clean
  // week can't fake a transition. A score that dips and clears again is a
  // real re-transition — it celebrates again. `celebration` is a counter so
  // each firing remounts the burst (key change); onDone drops it back to 0.
  const [celebration, setCelebration] = useState(0);
  const [confettiOrigins, setConfettiOrigins] = useState<{ x: number; y: number }[] | undefined>();
  const heroRef = useRef<HTMLDivElement | null>(null);
  const readyStateRef = useRef<ReadyWatchState | null>(null);
  // The cache-seeded snapshot (if this mount had one). It is a repaint of what
  // was already on screen, not something that happened in front of the
  // accountant, so it never enters the celebration watch — the first payload
  // that actually comes back from the server is still "the first of the mount",
  // which celebrationStep deliberately never celebrates. Without this, arriving
  // on a week that turned ready WHILE YOU WERE AWAY would fire confetti.
  const seededDataRef = useRef<PayrollReadiness | null>(data);
  useEffect(() => {
    if (!data || data === seededDataRef.current) return;
    // celebrationStep owns the rule (unit-tested in readiness-celebration):
    // fully-ready is the dial's own "100 · Ready" — never a degraded load.
    const { celebrate, next } = celebrationStep(
      readyStateRef.current,
      data.sourceFile ?? data.weekLabel,
      data.score,
    );
    readyStateRef.current = next;
    if (!celebrate) return;
    // Reduced motion: the hero's green flip IS the celebration — no confetti.
    if (reduceMotion) return;
    // Erupt from the hero banner (the thing that just flipped green) — its
    // rect is viewport-space, same as the burst canvas. No rect (shouldn't
    // happen; the hero is in the frozen header) → the burst's own fallback.
    const rect = heroRef.current?.getBoundingClientRect();
    setConfettiOrigins(
      rect && rect.width > 0
        ? [
            { x: rect.left + rect.width * 0.18, y: rect.top + rect.height * 0.55 },
            { x: rect.left + rect.width * 0.82, y: rect.top + rect.height * 0.55 },
          ]
        : undefined,
    );
    setCelebration((n) => n + 1);
  }, [data, reduceMotion]);
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
  // the SAME list the Payroll Wizard's period dropdown shows. Fetched once per
  // page session and cached, so the dropdown is populated the instant the pane
  // comes back; it degrades gracefully (hidden) if this fails or is empty.
  const [uploads, setUploads] = useState<string[]>(
    () => getTabCache<string[]>(TAB_CACHE_KEYS.payrollNotesUploads) ?? [],
  );
  useEffect(() => {
    if (hasFetchedThisSession(TAB_CACHE_KEYS.payrollNotesUploads)) return;
    let alive = true;
    fetch("/api/hubstaff-hours?source_files=1", { cache: "no-store" })
      .then(async (res) => (await res.json()) as { files?: string[] })
      .then((j) => {
        const files = (j.files ?? []).filter((f) => typeof f === "string" && f.trim() !== "");
        if (!alive) return;
        setUploads(files);
        setTabCache(TAB_CACHE_KEYS.payrollNotesUploads, files);
        markFetchedThisSession(TAB_CACHE_KEYS.payrollNotesUploads);
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
  /** `background` = a refresh nobody asked for (the cache revalidate, Realtime,
   *  the poll, a tab refocus). Those must never replace a snapshot that's on
   *  screen with an error card over a blip — the last good numbers plus a quiet
   *  retry beat a red box. A foreground load (first pull, week switch, Retry)
   *  still reports its failure. */
  const load = useCallback(
    async (opts?: { background?: boolean }) => {
      const seq = ++loadSeqRef.current;
      try {
        const qs = effectiveSourceFile ? `?source_file=${encodeURIComponent(effectiveSourceFile)}` : "";
        const res = await fetch(`/api/payroll-wizard/readiness${qs}`, { cache: "no-store" });
        const json = (await res.json()) as { readiness?: PayrollReadiness; error?: string };
        if (seq !== loadSeqRef.current) return; // superseded — a newer load is in charge
        if (!res.ok || !json.readiness) throw new Error(json.error || `Load failed (${res.status})`);
        setData(json.readiness);
        dataRef.current = json.readiness;
        setPulledAt(Date.now());
        // Warm the shared cache: a modal-tab switch, a trip out of the wizard,
        // or the FAB's own ring read all reuse this instead of re-querying.
        writeCachedReadiness(effectiveSourceFile, json.readiness);
        setError(null);
      } catch (e) {
        if (seq !== loadSeqRef.current) return; // superseded — don't surface a stale error
        if (opts?.background && dataRef.current) return;
        setError(e instanceof Error ? e.message : "Could not load readiness");
      } finally {
        if (seq === loadSeqRef.current) setLoading(false);
      }
    },
    [effectiveSourceFile],
  );

  // Hold the fetch until we know the wizard's week (or the grace period lapses),
  // then refetch whenever the effective week changes — the wizard switching its
  // CSV (while we're following it) or the accountant picking a week here.
  //
  // A cached snapshot for the week short-circuits the wait: paint it at once,
  // and only go back to the endpoint if it's older than the pane's own live poll
  // (READINESS_FRESH_MS) — a quick trip to another tab and back then costs no
  // query at all, and a longer one revalidates behind the visible numbers.
  useEffect(() => {
    if (!ready) return;
    const cached = readCachedReadiness(effectiveSourceFile);
    if (cached) {
      setData(cached.readiness);
      dataRef.current = cached.readiness;
      setPulledAt(cached.at);
      setError(null);
      setLoading(false);
      if (Date.now() - cached.at < READINESS_FRESH_MS) return;
      void load({ background: true });
      return;
    }
    void load();
  }, [ready, load, effectiveSourceFile]);

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

  /** Undo a Bank Info Temporary Exemption from its Exceptions row — the person
   *  goes straight back onto the Bank Info list (and the score). Soft-deleted
   *  server-side, so who granted it and who reversed it both stay on record. */
  const undoExemption = useCallback(
    async (exemptionId: string, name: string) => {
      setUndoingExemptions((prev) => new Set(prev).add(exemptionId));
      try {
        const res = await fetch("/api/payroll-wizard/bank-exemptions", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: exemptionId }),
        });
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok || json.error) throw new Error(json.error || `Undo failed (${res.status})`);
        toast.success(`Exemption removed for ${name}`, {
          description: "They're back on the Bank Info list.",
        });
        await load();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not undo the exemption");
      } finally {
        // Always released, even on failure — the row must stay retry-able.
        setUndoingExemptions((prev) => {
          const next = new Set(prev);
          next.delete(exemptionId);
          return next;
        });
      }
    },
    [load],
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
      "hubstaff_uploads",
      "orphanage_pay",
      "payroll_wizard_notes",
      "contractor_invoices",
      "app_settings",
    ],
    channel: "payroll-readiness",
    // Background: a dropped request on the poll must not blank the pane the
    // accountant is reading (it also keeps the cache warm for the next mount).
    onRefresh: () => void load({ background: true }),
    onStatusChange: (s) => setRtLive(s === "live"),
  });

  // Filter the three people lists live (name / email / dept / status). Computed
  // BEFORE the loading/error early-returns and made null-safe, so the paging
  // hooks below can run unconditionally (Rules of Hooks) — a null `data` just
  // yields empty lists. KPI isn't paginated (bounded dept list), so it's still
  // filtered inline in the render below.
  // How many missing-rate rows are recent hires — the count on the "Recently
  // onboarded" chip. Zero hides the chip, so the effect below also releases the
  // filter to keep the list from stranding empty behind an invisible control.
  const rateNewCount = useMemo(
    () => (data?.missingRates ?? []).reduce((n, r) => n + (r.recentlyOnboarded ? 1 : 0), 0),
    [data?.missingRates],
  );
  useEffect(() => {
    if (rateNewOnly && rateNewCount === 0) setRateNewOnly(false);
  }, [rateNewOnly, rateNewCount]);
  const ratesShown = (data?.missingRates ?? []).filter(
    (r) =>
      matchesQuery(rateQuery, r.name, r.email, r.department, formatStartDate(r.startDate)) &&
      (!rateNewOnly || r.recentlyOnboarded),
  );
  // Unique departments present in the Bank Info list (with row counts), powering
  // the bank pane's department dropdown. BANK_NO_DEPT stands in for rows without
  // a department so they stay reachable through the filter too.
  const bankDeptOptions = useMemo(() => {
    const counts = new Map<string, number>();
    let none = 0;
    for (const r of data?.missingBank ?? []) {
      const dept = r.department?.trim();
      if (dept) counts.set(dept, (counts.get(dept) ?? 0) + 1);
      else none += 1;
    }
    const opts = [...counts.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([dept, n]) => ({ value: dept, label: `${formatDeptLabel(dept) || dept} (${n})` }));
    if (none > 0) opts.push({ value: BANK_NO_DEPT, label: `No department (${none})` });
    return [{ value: "", label: "All departments" }, ...opts];
  }, [data?.missingBank]);
  // If a live refresh clears the selected department's last row (or a week
  // switch swaps the list), fall back to "all" so the filter never strands an
  // empty view behind a selection the dropdown no longer offers.
  useEffect(() => {
    if (bankDept !== "" && !bankDeptOptions.some((o) => o.value === bankDept)) {
      setBankDept("");
    }
  }, [bankDept, bankDeptOptions]);
  // How many missing-bank rows are on this week's payroll — the count shown on
  // the "Paying this week" toggle chip. When it drops to zero (fixed the last
  // one, or a week switch) the chip hides, so also release the filter to keep
  // the list from stranding empty behind an invisible control.
  const bankOnPayrollCount = useMemo(
    () => (data?.missingBank ?? []).reduce((n, r) => n + (r.onPayroll ? 1 : 0), 0),
    [data?.missingBank],
  );
  useEffect(() => {
    if (bankOnPayrollOnly && bankOnPayrollCount === 0) setBankOnPayrollOnly(false);
  }, [bankOnPayrollOnly, bankOnPayrollCount]);
  const bankShown = (data?.missingBank ?? []).filter(
    (r) =>
      matchesQuery(bankQuery, r.name, r.email, r.department, r.processor) &&
      (!bankOnPayrollOnly || r.onPayroll) &&
      (bankDept === "" ||
        (bankDept === BANK_NO_DEPT
          ? !r.department?.trim()
          : (r.department ?? "").trim() === bankDept)),
  );
  const excShown = (data?.exceptions ?? []).filter((r) =>
    matchesQuery(excQuery, r.name, r.email, r.department, r.detail, EXCEPTION_META[r.kind].label),
  );
  // Paginate each people list (10/page). Keyed on the search query so a new
  // search snaps back to page 1; the hook also clamps the page if a live refresh
  // shrinks the list under it.
  // The rate list narrows on the recently-onboarded toggle too, so it joins the
  // reset key (newline-joined, like the bank list's, so keys can't collide).
  const ratesPage = usePagedList(ratesShown, `${rateNewOnly ? "1" : "0"}\n${rateQuery}`);
  // The bank list narrows on the dept pick and the paying-this-week toggle too,
  // so both join the reset key (newline-joined so "a"+"b" can never collide
  // with "ab").
  const bankPage = usePagedList(bankShown, `${bankDept}\n${bankOnPayrollOnly ? "1" : "0"}\n${bankQuery}`);
  const excPage = usePagedList(excShown, excQuery);
  // `?? []` guards a cached snapshot taken before this dimension shipped.
  const hoursShown = (data?.zeroHours ?? []).filter((r) =>
    matchesQuery(hoursQuery, r.name, r.email, r.department),
  );
  const hoursPage = usePagedList(hoursShown, hoursQuery);

  // The selector header stays mounted across every body state (loading / error /
  // content) so switching weeks never yanks the control out from under the
  // cursor. The upload list drives it; if uploads couldn't load it hides itself.
  const selectorHeader = (
    <div className="shrink-0">
      <ReadinessWeekSelector
        uploads={uploads}
        value={effectiveSourceFile ?? currentSourceFile}
        currentSourceFile={currentSourceFile}
        following={!hasPicked}
        onChange={pickWeek}
      />
      {/* When the snapshot on screen was last pulled — stays up (with its old,
          honest time) while a background refresh or a week-switch load runs. */}
      <div className="-mt-2 mb-2 flex justify-end px-0.5">
        <PaneFreshness at={pulledAt} live={rtLive} />
      </div>
    </div>
  );

  // Loading takes precedence over a lingering error: when a fresh load is in
  // flight (e.g. Retry, or a week switch after a failure), show the skeleton
  // rather than the stale error card until this load settles. The skeleton
  // mirrors the real layout (hero + 4 stat tiles + the five tabbed sections) so
  // the shape is stable; over it sits the "Gathering data…" card (a foreground
  // box that walks through the four score-dimension checks — Wizard Setup
  // isn't part of the score, so it has no step there) so the wait reads as
  // active progress, not a stalled spinner.
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
  // Not-due monthly depts ('na') and Configuration-tab exclusions ('excluded')
  // leave the denominator — the tile describes only departments being paid.
  const kpiDue = data.kpi.filter((d) => d.status !== "na" && d.status !== "excluded");
  const kpiExcluded = data.kpi.filter((d) => d.status === "excluded").length;
  const kpiSubmitted = kpiDue.length - kpiPending.length;

  // Hard blockers: people whose pay CANNOT happen this week — no rate to
  // compute it, or (new) no payout rail while on this week's Hubstaff file.
  const bankBlockers = data.missingBankOnPayroll;
  const blockers = data.missingRates.length + bankBlockers;
  // Missing bank info for people NOT on this week's payroll — roster hygiene.
  // Stays visible in the Bank Info list but affects neither the score nor the
  // ready verdict (we don't need it to pay this week).
  const bankHygiene = data.missingBank.length - bankBlockers;
  // Everything else open is review work, not a payday failure.
  const warnings = kpiPending.length + bankHygiene;
  // Ready = everyone being PAID THIS WEEK is covered and every due KPI is in —
  // the same rule the server's score/grade follows.
  const isReady = blockers === 0 && kpiPending.length === 0;

  // KPI search — filter the dept list live (name / key / status). The three
  // people lists (rate/bank/exc) are filtered + paginated above, before the
  // guards, so their paging hooks can run unconditionally. Counts on the section
  // pills stay the FULL count so the readiness verdict never changes because a
  // search hid rows.
  const kpiShown = data.kpi.filter((d) =>
    matchesQuery(kpiQuery, d.name, d.key, KPI_STATUS_PILL[d.status].label),
  );

  // Per-dimension score percents (0–100) from the server's readiness score —
  // the same components the hero breakdown shows, so the tiles, the chips, and
  // the gauge always agree. `undefined` (component absent) just hides the
  // percent on that tile.
  const dimensionPercent = (key: "rate" | "kpi" | "bank") =>
    data.score.components.find((c) => c.key === key)?.percent;

  return (
    <div className="flex h-[70vh] flex-col">
      {selectorHeader}
      {/* Frozen header: the hero ("blockers to clear"), the stat tiles, and the
          tab strip stay pinned so the accountant always sees the verdict + the
          tab controls. Only the detail body below scrolls. */}
      <div className="shrink-0 space-y-3">
      {/* Hero: green when ready, amber while there's work, rose when a hard
          blocker (no-rate worker) exists. The wrapper ref anchors the 100%
          confetti burst to the banner that flips green. */}
      <div ref={heroRef}>
        <ReadinessHero
          isReady={isReady}
          rateBlockers={data.missingRates.length}
          bankBlockers={bankBlockers}
          bankHygiene={bankHygiene}
          warnings={warnings}
          weekLabel={data.weekLabel}
          isMonthly={data.isMonthlyPayWeek}
          score={data.score}
          reduceMotion={reduceMotion}
          onScoreDetails={() => setScoreDetailsOpen(true)}
        />
      </div>

      {/* Partial-data warning — the server reports any source it could NOT
          read this load (Hubstaff file, roster, employee_ids, legacy rates,
          onboarding, Configuration). A broken read reshapes the numbers
          quietly (usually to look BETTER), so it must be said out loud; the
          server also refuses to grade 'ready' while any of these are up. */}
      {(data.degraded?.length ?? 0) > 0 && (
        <div
          role="alert"
          className="rounded-xl border border-amber-300/70 bg-amber-50/80 px-3 py-2 dark:border-amber-500/30 dark:bg-amber-950/30"
        >
          <div className="flex items-center gap-1.5 text-[11px] font-semibold text-amber-800 dark:text-amber-200">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            Partial data this load — these checks couldn&apos;t run fully
          </div>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[10.5px] text-amber-700/90 dark:text-amber-300/80">
            {data.degraded.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Stat tiles — a read-only at-a-glance summary of the four dimensions.
          (Switching between the detail lists is the tab strip's job, below.) */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <ReadinessStat
          label="KPIs submitted"
          value={`${kpiSubmitted}/${kpiDue.length}`}
          sub={
            kpiPending.length > 0
              ? `${kpiPending.length} still pending`
              : kpiExcluded > 0
                ? `all in · ${kpiExcluded} excluded`
                : "all departments in"
          }
          tone={kpiPending.length === 0 ? "emerald" : "amber"}
          Icon={ClipboardList}
          percent={dimensionPercent("kpi")}
        />
        <ReadinessStat
          label="No pay rate"
          value={data.missingRates.length}
          sub={data.missingRates.length === 0 ? "everyone has a rate" : "can't be paid yet"}
          tone={data.missingRates.length === 0 ? "emerald" : "orange"}
          Icon={Wallet}
          percent={dimensionPercent("rate")}
        />
        <ReadinessStat
          label="No bank info"
          value={data.missingBank.length}
          sub={
            data.missingBank.length === 0
              ? "all payable"
              : bankBlockers > 0
                ? `${bankBlockers} on this week's payroll`
                : "none paid this week — no score impact"
          }
          tone={data.missingBank.length === 0 ? "emerald" : bankBlockers > 0 ? "orange" : "amber"}
          Icon={Banknote}
          percent={dimensionPercent("bank")}
        />
        <ReadinessStat
          label="Exceptions"
          value={data.exceptions.length}
          sub={data.exceptions.length === 0 ? "none this week" : "not paid this week"}
          tone={data.exceptions.length === 0 ? "emerald" : "sky"}
          Icon={UserPlus}
        />
      </div>

      {/* Tab strip — the explicit control for switching between Wizard Setup and
          the four detail lists (KPI Submissions / No Pay Rate / Bank Info /
          Exceptions). */}
      <ReadinessTabStrip
        active={readinessTab}
        onPick={pickReadinessTab}
        counts={{
          setup: data.wizardSetup ? data.wizardSetup.totalCount - data.wizardSetup.doneCount : 0,
          kpi: kpiPending.length,
          rate: data.missingRates.length,
          bank: data.missingBank.length,
          exc: data.exceptions.length,
          // `??` guards a cached snapshot taken before this dimension shipped.
          hours: data.zeroHoursCount ?? data.zeroHours?.length ?? 0,
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
            {readinessTab === "setup" ? (
              <PaneBody>
                {!data.wizardSetup ? (
                  // Stale in-flight response from an older API shape — the
                  // fetch already resolved (we're past the loading/!data
                  // guard), it just doesn't carry this field yet.
                  <div className="px-3 py-4 text-center text-xs text-zinc-400">
                    Setup status unavailable — refresh.
                  </div>
                ) : (
                  <>
                    {/* Slim header line — just the week + done count. The tab
                        strip above already owns the "Wizard Setup" label and
                        the live count badge, so this isn't a second title. */}
                    <div className="mb-1.5 flex items-center gap-1 text-[11px] text-zinc-500 dark:text-zinc-400">
                      <span>{data.wizardSetup.weekLabel}</span>
                      <span>·</span>
                      <span>
                        {data.wizardSetup.doneCount}/{data.wizardSetup.totalCount} done
                      </span>
                    </div>
                    {/* A newer pay week has already closed with no CSV uploaded.
                        The checklist deliberately stays on the week the selector
                        above shows — this is the only place the next cycle gets
                        mentioned, so it can't be mistaken for the week in view. */}
                    {data.wizardSetup.awaitingWeekLabel && (
                      <div className="mb-2 flex items-start gap-1.5 rounded-lg border border-amber-200 bg-amber-50/70 px-2 py-1.5 text-[11px] text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/25 dark:text-amber-300">
                        <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                        <span>
                          The{" "}
                          <span className="font-semibold">{data.wizardSetup.awaitingWeekLabel}</span>{" "}
                          week has closed and its Hubstaff CSV isn&apos;t uploaded yet. Upload it on
                          Step 1 to start that cycle — this checklist stays on{" "}
                          {data.wizardSetup.weekLabel} until you do.
                        </span>
                      </div>
                    )}
                    <ul className="space-y-0.5">
                      {data.wizardSetup.steps.map((s) => {
                        const pill = SETUP_STATUS_PILL[s.status];
                        const StepIcon = SETUP_STEP_ICON[s.key];
                        return (
                          <li
                            key={s.key}
                            className="flex items-center gap-2 rounded-lg px-1.5 py-1 hover:bg-orange-50/60 dark:hover:bg-blue-950/30"
                          >
                            <span className="w-7 shrink-0 text-center font-mono text-[10px] font-semibold text-zinc-400 dark:text-zinc-500">
                              {s.stepNo}
                            </span>
                            <StepIcon className="h-3.5 w-3.5 shrink-0 text-zinc-400 dark:text-zinc-500" />
                            <span className="shrink-0 text-xs font-medium text-zinc-800 dark:text-zinc-200">{s.label}</span>
                            <span
                              className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${pill.cls}`}
                            >
                              <pill.Icon className="h-2.5 w-2.5" />
                              {pill.label}
                            </span>
                            <span className="min-w-0 flex-1 truncate text-right text-[11px] text-zinc-500 dark:text-zinc-400" title={s.detail}>
                              {s.detail}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  </>
                )}
              </PaneBody>
            ) : readinessTab === "kpi" ? (
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
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <ReadinessSearch
                        className="min-w-0 flex-1"
                        value={rateQuery}
                        onChange={setRateQuery}
                        placeholder="Search people…"
                        shown={ratesShown.length}
                        total={data.missingRates.length}
                      />
                      {/* New-hire filter — narrows the list to people onboarded
                          this pay week or the one before (the "New hire" chip
                          rows). Hidden when none qualify; the effect above also
                          releases the filter then. */}
                      {rateNewCount > 0 && (
                        <button
                          type="button"
                          onClick={() => setRateNewOnly((v) => !v)}
                          aria-pressed={rateNewOnly}
                          title="Only show people onboarded in the last two payroll weeks — they already have hours, they just need a rate set in the Payment Catalog"
                          className={`h-7 shrink-0 rounded-md border px-2 text-[10px] font-semibold uppercase tracking-wide transition-colors ${
                            rateNewOnly
                              ? "border-amber-300 bg-amber-100 text-amber-700 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-300"
                              : "border-zinc-200 bg-white text-zinc-500 hover:border-amber-200 hover:text-amber-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:border-amber-500/30 dark:hover:text-amber-300"
                          }`}
                        >
                          Recently onboarded ({rateNewCount})
                        </button>
                      )}
                    </div>
                    {ratesShown.length === 0 ? (
                      <NoMatches query={rateQuery} />
                    ) : (
                      <>
                        <div className={RATE_GRID}>
                          {/* Column headers — sm+ only; the grid stacks below
                              that and each cell labels itself inline instead. */}
                          <div
                            className={`${RATE_COLS} hidden px-2 pb-1 text-[9px] font-semibold uppercase tracking-wide text-zinc-400 sm:grid dark:text-zinc-500`}
                            aria-hidden
                          >
                            <span>Person</span>
                            <span>Department</span>
                            <span>Start date</span>
                            <span className="text-right">Status</span>
                          </div>
                          {ratesPage.pageItems.map((r) => (
                            <RatePersonRow
                              key={r.email ?? r.name}
                              person={r}
                              canEdit={canEdit}
                              onFix={() => setRatePerson(r)}
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
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <ReadinessSearch
                        className="min-w-0 flex-1"
                        value={bankQuery}
                        onChange={setBankQuery}
                        placeholder="Search people…"
                        shown={bankShown.length}
                        total={data.missingBank.length}
                      />
                      {/* Blocker filter — narrows the list to people with hours
                          in this week's Hubstaff file (the rose-badge rows).
                          Hidden when no row qualifies; the effect above also
                          releases the filter then. */}
                      {bankOnPayrollCount > 0 && (
                        <button
                          type="button"
                          onClick={() => setBankOnPayrollOnly((v) => !v)}
                          aria-pressed={bankOnPayrollOnly}
                          title="Only show people with hours in this week's Hubstaff file — they will not be paid until payout details are set"
                          className={`h-7 shrink-0 rounded-md border px-2 text-[10px] font-semibold uppercase tracking-wide transition-colors ${
                            bankOnPayrollOnly
                              ? "border-rose-300 bg-rose-100 text-rose-700 dark:border-rose-500/40 dark:bg-rose-500/15 dark:text-rose-300"
                              : "border-zinc-200 bg-white text-zinc-500 hover:border-rose-200 hover:text-rose-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:border-rose-500/30 dark:hover:text-rose-300"
                          }`}
                        >
                          Paying this week ({bankOnPayrollCount})
                        </button>
                      )}
                      <SmoothSelect
                        value={bankDept}
                        onChange={setBankDept}
                        options={bankDeptOptions}
                        aria-label="Filter by department"
                        searchable
                        searchPlaceholder="Search departments…"
                        className="w-40 shrink-0 sm:w-48"
                        triggerClassName="h-7 rounded-md"
                      />
                    </div>
                    {bankShown.length === 0 ? (
                      bankQuery.trim() !== "" ? (
                        <NoMatches query={bankQuery} />
                      ) : (
                        // Only the dept/paying-this-week filters can empty an
                        // unsearched list, so name the culprit rather than
                        // showing a blank page.
                        <div className="px-3 py-4 text-center text-xs text-zinc-400">
                          {bankOnPayrollOnly
                            ? "No one in this department is on this week's payroll and missing bank info."
                            : "No one in this department is missing bank info."}
                        </div>
                      )
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
                                  {/* Off-boarded but still owed their final pay —
                                      explains why a leaver is on the list. They
                                      age off automatically once the week being
                                      paid starts after their off-board date. */}
                                  {r.offBoardedAt && (
                                    <span
                                      className="shrink-0 rounded-full border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-zinc-500 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-400"
                                      title={`Off-boarded ${formatStartDate(r.offBoardedAt)} — still listed because their final pay hasn't gone out; they drop off after the week that pays it`}
                                    >
                                      Left · final pay
                                    </span>
                                  )}
                                  {r.onPayroll && (
                                    <span
                                      className="shrink-0 rounded-full border border-rose-200 bg-rose-50 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300"
                                      title="Has hours in this week's Hubstaff file — will not be paid until payout details are set"
                                    >
                                      Paying this week
                                    </span>
                                  )}
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
                                  {/* Acknowledge the gap for THIS week instead of
                                      fixing it: the row moves to Exceptions and
                                      stops scoring, and comes back next week if
                                      the details are still missing. */}
                                  {canEdit && (
                                    <RowFixButton
                                      label="Temporary Exemption"
                                      Icon={Clock}
                                      onClick={() => setExemptPerson(r)}
                                      title={`Excuse this person's missing bank info for ${data.weekLabel} only — they move to Exceptions now and return to this list next week if it's still missing. Does not make them payable.`}
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
            ) : readinessTab === "exc" ? (
              <PaneBody>
                {data.exceptions.length === 0 ? (
                  <AllClear text="No exceptions this week." />
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
                            const undoing = r.exemptionId
                              ? undoingExemptions.has(r.exemptionId)
                              : false;
                            return (
                              <PersonLine
                                key={`${r.email ?? r.name}:${i}`}
                                name={r.name}
                                email={r.email}
                                // Temp-exempt rows keep the DEPARTMENT on the
                                // sub-line (their `detail` is a free-text reason
                                // that reads as a sentence, not a label) and
                                // carry the reason in the badge's tooltip.
                                department={
                                  r.kind === "bank_exempt" ? r.department : (r.detail ?? r.department)
                                }
                                right={
                                  <div className="flex shrink-0 items-center gap-1.5">
                                    <span
                                      title={
                                        r.kind === "bank_exempt"
                                          ? `No bank info — exempted for ${data.weekLabel}${r.detail ? `: ${r.detail}` : ""}. Returns to the Bank Info list next week if it's still missing.`
                                          : (r.detail ?? undefined)
                                      }
                                      className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${meta.cls}`}
                                    >
                                      <meta.Icon className="h-2.5 w-2.5" />
                                      {meta.label}
                                    </span>
                                    {/* Only a hand-granted exemption is reversible —
                                        the HR-pipeline kinds are facts about the
                                        person, not decisions made here. */}
                                    {canEdit && r.kind === "bank_exempt" && r.exemptionId && (
                                      <button
                                        type="button"
                                        onClick={() => void undoExemption(r.exemptionId!, r.name)}
                                        disabled={undoing}
                                        title="Remove the exemption — this person goes back on the Bank Info list now"
                                        className="inline-flex shrink-0 items-center gap-1 rounded-md border border-orange-200/80 bg-white px-2 py-1 text-[10px] font-semibold whitespace-nowrap text-orange-700 transition-colors hover:bg-orange-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-blue-900/60 dark:bg-blue-950/30 dark:text-orange-300 dark:hover:bg-blue-950/50"
                                      >
                                        {undoing ? (
                                          <Loader2 className="h-3 w-3 animate-spin" />
                                        ) : (
                                          <X className="h-3 w-3" />
                                        )}
                                        Undo
                                      </button>
                                    )}
                                  </div>
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
            ) : (
              /* No Hours — active roster members this week's Hubstaff file left
                 with no hours and nothing in the HRIS explaining it. A reminder
                 to reconcile a person's status, NOT a payroll blocker and NOT a
                 score input: someone with no hours is correctly paid nothing.
                 The risk it closes is the opposite one — a leaver nobody
                 offboarded sitting Active indefinitely. Read-only by design:
                 the fix is an offboarding, a leave request or a conversation,
                 none of which belong on a payroll pane. */
              <PaneBody>
                {(data.zeroHours?.length ?? 0) === 0 ? (
                  <AllClear text="Everyone on the roster logged hours this week." />
                ) : (
                  <>
                    <p className="px-1 pb-1.5 text-[10.5px] leading-snug text-zinc-500 dark:text-zinc-400">
                      No hours in{" "}
                      <span className="font-semibold text-zinc-600 dark:text-zinc-300">
                        {data.weekLabel}
                      </span>
                      , and nothing on file explains it — no untracked department, no approved
                      leave, no new-hire start date. Still working, on leave, sick, or never
                      offboarded? Expected absences are already filtered out into Exceptions.
                    </p>
                    <ReadinessSearch
                      value={hoursQuery}
                      onChange={setHoursQuery}
                      placeholder="Search people…"
                      shown={hoursShown.length}
                      total={data.zeroHours?.length ?? 0}
                    />
                    {hoursShown.length === 0 ? (
                      <NoMatches query={hoursQuery} />
                    ) : (
                      <>
                        <div className="space-y-0.5">
                          {hoursPage.pageItems.map((r, i) => (
                            <PersonLine
                              key={`${r.email ?? r.name}:${i}`}
                              name={r.name}
                              email={r.email}
                              department={r.department}
                              // Someone already off-boarded is not an unexplained
                              // silence — they are just awaiting their final pay,
                              // so the row says so instead of implying a mystery.
                              right={
                                r.leftAt ? (
                                  <span className="rounded-full bg-sky-100 px-1.5 py-0.5 text-[10px] font-semibold text-sky-700 dark:bg-sky-500/15 dark:text-sky-300">
                                    Left · final pay
                                  </span>
                                ) : undefined
                              }
                            />
                          ))}
                        </div>
                        <ReadinessPager
                          page={hoursPage.page}
                          pageCount={hoursPage.pageCount}
                          from={hoursPage.from}
                          to={hoursPage.to}
                          total={hoursPage.total}
                          onPage={hoursPage.setPage}
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

      {/* Recent-changes strip — pinned under the scroller so "is someone fixing
          data right now?" is answerable without scrolling. Server-composed off
          the audit trail; refreshes with the pane's normal load cycle
          (Realtime + 30s poll + focus). `?? []` guards a cached snapshot from
          before the field shipped. */}
      <ReadinessActivityFeed lines={data.activity ?? []} />

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
      {exemptPerson && (
        <ExemptBankDialog
          person={exemptPerson}
          weekLabel={data.weekLabel}
          weekStart={data.weekStart}
          onClose={() => setExemptPerson(null)}
          onSaved={() => void load()}
        />
      )}
      {scoreDetailsOpen && (
        <ScoreDetailsDialog data={data} onClose={() => setScoreDetailsOpen(false)} />
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
      {/* The 100%-live celebration itself — keyed on the counter so a re-clear
          fires a fresh burst; unmounts when the canvas reports done. */}
      {celebration > 0 && (
        <ConfettiBurst
          key={celebration}
          origins={confettiOrigins}
          onDone={() => setCelebration(0)}
        />
      )}
    </div>
  );
}

/**
 * "Offboarded" tab — recently offboarded people who may still need their
 * final paycheck's rate/bank set. Built on `listOffboardedPayrollCandidates`,
 * which is itself built on the same `listRecentlyOffboardedPeople` union the
 * KPI bonus calculators use, scoped to the wizard's current pay week so a
 * leaver drops off once their final pay has actually gone out. Cached per
 * week + kept live like its siblings (see the cache preamble above), with a
 * search box and department filter mirroring the Bank Info pane's; still no
 * celebration and no pagination — the list is expected to be short.
 */
function OffboardedGlance({
  wizardSourceFile,
  canEdit,
}: {
  wizardSourceFile: string | null;
  canEdit: boolean;
}) {
  // Seeded from the cached pull for the week the wizard is on (same shape as
  // the Readiness pane's cache): switching modal tabs and coming back used to
  // re-run the whole final-pay assembly behind a spinner every time.
  const [people, setPeople] = useState<OffboardedPayrollCandidate[] | null>(
    () => readCachedOffboarded(wizardSourceFile)?.people ?? null,
  );
  const [error, setError] = useState<string | null>(null);
  // Sources the server couldn't read this load (e.g. employee_ids or the
  // legacy rates sheet) — bank status below is judged against whatever DID
  // come back, so this must be said out loud rather than read as a genuine
  // "no bank on file". Mirrors PayrollReadinessGlance's own degraded banner.
  const [degraded, setDegraded] = useState<string[]>(
    () => readCachedOffboarded(wizardSourceFile)?.degraded ?? [],
  );
  // The pay week this list is scoped to. Shown in-pane like every sibling here:
  // when the wizard replays an older period the week-relevance filter can quietly
  // widen to an unfiltered 90-day list, and nothing else on screen would say so.
  const [weekLabel, setWeekLabel] = useState<string | null>(
    () => readCachedOffboarded(wizardSourceFile)?.weekLabel ?? null,
  );
  // When the list on screen was pulled — cached paints keep the cache's own
  // stamp, live loads stamp "now". Feeds the pane's "Last data pull" line.
  const [pulledAt, setPulledAt] = useState<number | null>(
    () => readCachedOffboarded(wizardSourceFile)?.at ?? null,
  );
  // Realtime channel state for the signal dot (null until SUBSCRIBED fires —
  // reads Polling, which is what's actually covering the pane until then).
  const [rtLive, setRtLive] = useState<boolean | null>(null);
  const [ratePerson, setRatePerson] = useState<ReadinessMissingRate | null>(null);
  const [bankPerson, setBankPerson] = useState<ReadinessMissingBank | null>(null);
  const [bankPrefill, setBankPrefill] = useState<OffboardedPayrollCandidate["bankPrefill"]>(null);
  // Search + department filter over the list ("" = all departments).
  const [offQuery, setOffQuery] = useState("");
  const [offDept, setOffDept] = useState("");
  // On-screen data for the fetch path (no `people` dependency), plus a
  // monotonic request token: a background refresh must never blank a visible
  // list over a blip, and a slow fetch for a week we've since left must never
  // clobber the week now in view — same shape as the Readiness pane's load().
  const peopleRef = useRef<OffboardedPayrollCandidate[] | null>(people);
  peopleRef.current = people;
  const loadSeqRef = useRef(0);

  /** `background` = a refresh nobody asked for (the cache revalidate, Realtime,
   *  the poll, a tab refocus) — those keep the last good list on a failure;
   *  a foreground load (cold pull, week switch, post-fix refresh) still
   *  reports its failure. */
  const load = useCallback(
    (opts?: { background?: boolean }) => {
      const seq = ++loadSeqRef.current;
      const qs = wizardSourceFile ? `?source_file=${encodeURIComponent(wizardSourceFile)}` : "";
      return fetch(`/api/payroll-wizard/offboarded${qs}`, { cache: "no-store" })
        .then(async (res) => {
          const json = (await res.json()) as {
            people?: OffboardedPayrollCandidate[];
            weekLabel?: string;
            degraded?: string[];
            error?: string | null;
          };
          if (seq !== loadSeqRef.current) return; // superseded — a newer load is in charge
          if (!res.ok || json.error) throw new Error(json.error || `Load failed (${res.status})`);
          const fresh = {
            people: json.people ?? [],
            weekLabel: json.weekLabel ?? null,
            degraded: json.degraded ?? [],
          };
          setPeople(fresh.people);
          setWeekLabel(fresh.weekLabel);
          setDegraded(fresh.degraded);
          setError(null);
          setPulledAt(writeCachedOffboarded(wizardSourceFile, fresh));
        })
        .catch((e) => {
          if (seq !== loadSeqRef.current) return; // superseded — don't surface a stale error
          if (opts?.background && peopleRef.current) return;
          setError(e instanceof Error ? e.message : "Could not load recently offboarded people");
        });
    },
    [wizardSourceFile],
  );

  // Paint the cached list for the (possibly new) week instantly, then
  // revalidate behind it — unless the cache is younger than the pane's own
  // 30s poll, in which case a tab switch and back costs no query at all.
  // A week with nothing cached does the one visible (spinner) load.
  useEffect(() => {
    const cached = readCachedOffboarded(wizardSourceFile);
    if (cached) {
      setPeople(cached.people);
      setWeekLabel(cached.weekLabel);
      setDegraded(cached.degraded);
      setPulledAt(cached.at);
      setError(null);
      if (Date.now() - cached.at < READINESS_FRESH_MS) return;
      void load({ background: true });
      return;
    }
    setPeople(null);
    setPulledAt(null);
    void load();
  }, [load, wizardSourceFile]);

  // Live: a Set rate / Set bank fix (from here or the Readiness tab) lands
  // without a manual reload; the 30s poll carries the offboard sources
  // themselves (master-list stamps, queue completions), which have no
  // Realtime channel. Mounted only while this pane is open — no always-on
  // channel at the FAB level.
  useLiveRefresh({
    tables: ["employee_ids", "payment_catalog_pay_structures", "employee_hourly_rates"],
    channel: "payroll-notes-offboarded",
    onRefresh: () => void load({ background: true }),
    onStatusChange: (s) => setRtLive(s === "live"),
  });

  // Unique departments present in the list (with row counts) for the dropdown;
  // BANK_NO_DEPT stands in for rows without a department so they stay reachable
  // through the filter too. Mirrors the Bank Info pane's department filter.
  const offDeptOptions = useMemo(() => {
    const counts = new Map<string, number>();
    let none = 0;
    for (const r of people ?? []) {
      const dept = r.department?.trim();
      if (dept) counts.set(dept, (counts.get(dept) ?? 0) + 1);
      else none += 1;
    }
    const opts = [...counts.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([dept, n]) => ({ value: dept, label: `${formatDeptLabel(dept) || dept} (${n})` }));
    if (none > 0) opts.push({ value: BANK_NO_DEPT, label: `No department (${none})` });
    return [{ value: "", label: "All departments" }, ...opts];
  }, [people]);
  // If a refresh (or a week switch) drops the selected department's last row,
  // fall back to "all" so the filter never strands an empty view behind a
  // selection the dropdown no longer offers.
  useEffect(() => {
    if (offDept !== "" && !offDeptOptions.some((o) => o.value === offDept)) {
      setOffDept("");
    }
  }, [offDept, offDeptOptions]);
  const peopleShown = (people ?? []).filter(
    (r) =>
      matchesQuery(offQuery, r.name, r.workEmail, r.personalEmail, r.department, r.offBoardedReasonLabel) &&
      (offDept === "" ||
        (offDept === BANK_NO_DEPT
          ? !r.department?.trim()
          : (r.department ?? "").trim() === offDept)),
  );

  if (error) {
    return (
      <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
        {error}
      </p>
    );
  }
  if (people === null) {
    return (
      <div className="flex h-[70vh] items-center justify-center text-sm text-zinc-400">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Loading recently offboarded people…
      </div>
    );
  }
  if (people.length === 0) {
    return (
      <div className="flex h-[70vh] flex-col">
        <div className="flex shrink-0 justify-end">
          <PaneFreshness at={pulledAt} live={rtLive} />
        </div>
        <div className="flex flex-1 items-center justify-center text-sm text-zinc-400">
          No one&apos;s recently left — nothing needs final-pay setup.
        </div>
      </div>
    );
  }

  const badgeCls = (ok: boolean) =>
    ok
      ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300"
      : "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300";

  return (
    <div className="flex h-[70vh] flex-col">
      {/* Frozen header: week line + freshness stamp, then the search box and
          department filter — pinned so only the people list below scrolls. */}
      <div className="shrink-0">
        <div className="mb-1 flex flex-wrap items-center justify-between gap-2 px-1">
          {/* Slim week line — which pay week these leavers are scoped to. Same
              treatment as the Wizard Setup pane's own week line; the tab strip
              already owns the "Offboarded" label, so this isn't a second title. */}
          <span className="text-[11px] text-zinc-500 dark:text-zinc-400">
            {weekLabel ? <>Final pay for payroll week {weekLabel}</> : null}
          </span>
          <PaneFreshness at={pulledAt} live={rtLive} />
        </div>
        <div className="mb-2 flex items-center gap-2">
          <ReadinessSearch
            value={offQuery}
            onChange={setOffQuery}
            placeholder="Search name, email, department…"
            shown={peopleShown.length}
            total={people.length}
            className="min-w-0 flex-1"
          />
          <SmoothSelect
            value={offDept}
            onChange={setOffDept}
            options={offDeptOptions}
            aria-label="Filter by department"
            searchable
            searchPlaceholder="Search departments…"
            className="w-40 shrink-0 sm:w-48"
            triggerClassName="h-7 rounded-md"
          />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto rounded-lg border border-orange-100 p-1 dark:border-blue-950/60">
      {/* Partial-data warning — same treatment as PayrollReadinessGlance's:
          a read that failed reshapes bank status quietly (toward "missing"),
          so it must be said out loud rather than read as a real gap. */}
      {degraded.length > 0 && (
        <div
          role="alert"
          className="mb-2 rounded-xl border border-amber-300/70 bg-amber-50/80 px-3 py-2 dark:border-amber-500/30 dark:bg-amber-950/30"
        >
          <div className="flex items-center gap-1.5 text-[11px] font-semibold text-amber-800 dark:text-amber-200">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            Partial data this load — these checks couldn&apos;t run fully
          </div>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[10.5px] text-amber-700/90 dark:text-amber-300/80">
            {degraded.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
        </div>
      )}
      {peopleShown.length === 0 ? (
        offQuery.trim() !== "" ? (
          <NoMatches query={offQuery} />
        ) : (
          // Only the department filter can empty an unsearched list, so name
          // the culprit rather than showing a blank page.
          <div className="px-3 py-4 text-center text-xs text-zinc-400">
            No recently offboarded people in this department.
          </div>
        )
      ) : (
      <div className="space-y-0.5">
        {peopleShown.map((r) => (
          <PersonLine
            key={r.workEmail ?? r.personalEmail ?? r.name}
            name={r.name}
            email={r.workEmail ?? r.personalEmail}
            department={r.department}
            right={
              <div className="flex shrink-0 items-center gap-1.5">
                {r.offBoardedAt && (
                  <span
                    className="shrink-0 rounded-full border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-zinc-500 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-400"
                    title={r.offBoardedReasonLabel ?? undefined}
                  >
                    Left {formatStartDate(r.offBoardedAt)}
                    {r.offBoardedReasonLabel ? ` · ${r.offBoardedReasonLabel}` : ""}
                  </span>
                )}
                <span className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${badgeCls(r.rateStatus === "ok")}`}>
                  {r.rateStatus === "ok" ? "Rate OK" : "No rate"}
                </span>
                <span className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${badgeCls(r.bankStatus === "ok")}`}>
                  {r.bankStatus === "ok"
                    ? "Bank OK"
                    : r.bankStatus === "missing_has_snapshot"
                      ? "Prior bank on file"
                      : "No bank"}
                </span>
                {canEdit && (
                  <>
                    <RowFixButton
                      label="Set rate"
                      disabled={!r.workEmail && !r.personalEmail}
                      onClick={() =>
                        setRatePerson({
                          name: r.name,
                          email: r.workEmail ?? r.personalEmail,
                          department: r.department,
                          startDate: null,
                          recentlyOnboarded: false,
                          offBoardedAt: r.offBoardedAt,
                        })
                      }
                    />
                    <RowFixButton
                      label="Set bank"
                      disabled={!r.workEmail && !r.personalEmail}
                      onClick={() => {
                        setBankPrefill(r.bankPrefill);
                        setBankPerson({
                          name: r.name,
                          email: r.workEmail ?? r.personalEmail,
                          department: r.department,
                          processor: r.bankProcessor,
                          workEmail: r.workEmail,
                          personalEmail: r.personalEmail,
                          onPayroll: false,
                          offBoardedAt: r.offBoardedAt,
                        });
                      }}
                    />
                  </>
                )}
              </div>
            }
          />
        ))}
      </div>
      )}
      </div>
      {ratePerson && (
        <SetRateDialog person={ratePerson} onClose={() => setRatePerson(null)} onSaved={() => void load()} />
      )}
      {bankPerson && (
        <SetBankDialog
          person={bankPerson}
          prefill={bankPrefill ?? undefined}
          onClose={() => {
            setBankPerson(null);
            setBankPrefill(null);
          }}
          onSaved={() => void load()}
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
 * banner + 4 stat tiles + the tab strip + one pane shell) with pulsing bars,
 * and NAMES each of the five tabs so the accountant sees exactly what's being
 * checked (Wizard Setup, KPIs, No pay rate, Bank info, Exceptions) rather than
 * a bare spinner. Keeping the shape identical means no layout jump when the
 * real data lands.
 */
function ReadinessSkeleton({ reduceMotion = false }: { reduceMotion?: boolean }) {
  // Pulse is gated on reduced motion so the backdrop honors it too (the card on
  // top already does) — under reduced motion the bars are static grey blocks.
  const bar = `rounded bg-zinc-200/80 dark:bg-zinc-800/80${reduceMotion ? "" : " animate-pulse"}`;
  // Stat-tile labels — unchanged at four; Wizard Setup has no matching tile (no
  // percent / score dimension), so it isn't in this row (see the tab strip
  // labels below for its placeholder).
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

      {/* Tab strip — five labeled tabs, Wizard Setup first and drawn as active
          (underline), matching the pane's default tab. */}
      <div className="flex items-center gap-1 border-b border-orange-100 pb-px dark:border-blue-950/60">
        {["Wizard Setup", "KPI Submissions", "No Pay Rate", "Bank Info", "Exceptions"].map((label, i) => (
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

      {/* Active pane — one section shell (the default Wizard Setup list). */}
      <section className="min-h-[16rem] rounded-xl border border-orange-100 bg-white/60 dark:border-blue-950/60 dark:bg-blue-950/10">
        <div className="flex items-center justify-between gap-2 border-b border-orange-100/70 px-3 py-2 dark:border-blue-950/50">
          <span className="flex items-center gap-1.5 text-xs font-semibold text-zinc-700 dark:text-zinc-200">
            <ListChecks className="h-3.5 w-3.5 text-orange-400/70" />
            Wizard setup
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
 *  when the cycle is clear. Blockers (no-rate workers, and no-bank workers on
 *  this week's payroll) read rose; warnings (pending KPI / roster-hygiene
 *  missing bank) read amber. */
function ReadinessHero({
  isReady,
  rateBlockers,
  bankBlockers,
  bankHygiene,
  warnings,
  weekLabel,
  isMonthly,
  score,
  reduceMotion,
  onScoreDetails,
}: {
  isReady: boolean;
  rateBlockers: number;
  bankBlockers: number;
  /** Missing-bank rows NOT on this week's payroll — visible review work that
   *  costs nothing (neither the score nor the ready verdict). */
  bankHygiene: number;
  warnings: number;
  weekLabel: string;
  isMonthly: boolean;
  score: ReadinessScore;
  reduceMotion: boolean;
  /** Opens the "Why this score?" breakdown modal (the dial + mobile chip). */
  onScoreDetails: () => void;
}) {
  const blockers = rateBlockers + bankBlockers;
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
    ? bankHygiene > 0
      ? `Everyone being paid this week is covered — ${bankHygiene} roster bank item${bankHygiene === 1 ? "" : "s"} to review (not paid this week, no score impact).`
      : "Every department is in and everyone can be paid."
    : [
        rateBlockers > 0 ? `${rateBlockers} worker${rateBlockers === 1 ? "" : "s"} with no rate` : null,
        bankBlockers > 0
          ? `${bankBlockers} on this week's payroll with no bank info`
          : null,
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
          {/* Mobile stand-in for the score dial (hidden below sm): a tappable
              score chip so the "why this score?" modal stays reachable. */}
          <button
            type="button"
            onClick={onScoreDetails}
            title="See how this score was calculated"
            className="inline-flex shrink-0 items-center rounded-full border border-zinc-200 bg-white/70 px-1.5 py-0.5 text-[10px] font-bold tabular-nums text-zinc-700 transition-colors hover:border-zinc-300 hover:bg-white sm:hidden dark:border-zinc-700 dark:bg-zinc-900/60 dark:text-zinc-200 dark:hover:border-zinc-600"
          >
            {Math.max(0, Math.min(100, score.value))}
            <span className="font-semibold text-zinc-400 dark:text-zinc-500">/100</span>
          </button>
        </div>
        <p className="mt-0.5 truncate text-xs text-zinc-600 dark:text-zinc-300">{sub}</p>
        {/* Component breakdown — the points each dimension is contributing, so
            it's obvious what's costing the score. Hidden on the narrowest width
            where the gauge alone tells the story. */}
        <div className="mt-1.5 hidden flex-wrap items-center gap-x-3 gap-y-1 sm:flex">
          {score.components.map((c) => {
            const full = c.open === 0;
            // A dimension with hard blockers (pinned points) reads rose; open
            // but proportional work reads amber. `blockerOpen` covers both the
            // rate pin and the new on-payroll bank pin without key checks.
            const hasBlockers = (c.blockerOpen ?? 0) > 0;
            return (
              <span
                key={c.key}
                className="inline-flex items-center gap-1 text-[10px] text-zinc-500 dark:text-zinc-400"
                title={`${c.label}: ${c.points}/${c.maxPoints} pts${
                  hasBlockers
                    ? ` · ${c.blockerOpen} blocking payday${c.open > c.blockerOpen ? ` (${c.open} open)` : ""}`
                    : c.open > 0
                      ? ` · ${c.open} open`
                      : " · clear"
                }`}
              >
                <span
                  className={`inline-block h-1.5 w-1.5 rounded-full ${
                    full ? "bg-emerald-500" : hasBlockers ? "bg-rose-500" : "bg-amber-500"
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

      {/* The Readiness Score dial — the headline number for the week. Click
          opens the full "why this score?" breakdown. */}
      <ScoreGauge score={score} tone={tone} reduceMotion={reduceMotion} onClick={onScoreDetails} />
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
  onClick,
}: {
  score: ReadinessScore;
  tone: "emerald" | "amber" | "rose";
  reduceMotion: boolean;
  /** Opens the score-details modal. The dial renders as a button so the
   *  breakdown is one click away from the headline number itself. */
  onClick: () => void;
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
    <button
      type="button"
      onClick={onClick}
      className="relative hidden h-[70px] w-[70px] shrink-0 cursor-pointer rounded-full transition-transform hover:scale-[1.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400/70 focus-visible:ring-offset-2 sm:block dark:focus-visible:ring-blue-500/60"
      aria-label={`Readiness score ${pct} out of 100 — ${gradeLabel[score.grade]}. See how this score was calculated.`}
      title={`Readiness score: ${pct}/100 (${gradeLabel[score.grade]}) — click for the breakdown`}
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
    </button>
  );
}

/**
 * "Why this score?" — the breakdown modal behind the Readiness Score dial (and
 * the mobile score chip). Explains the week's number the way the scorer built
 * it: each dimension's earned points with the exact counts behind them, the
 * hard-blocker pinning rule, what is deliberately NOT counted (anyone we
 * aren't paying this week), the grade bands, and any partial-data warnings.
 * Pure client-side read of the payload the tab already has — no extra fetch.
 */
function ScoreDetailsDialog({
  data,
  onClose,
}: {
  data: PayrollReadiness;
  onClose: () => void;
}) {
  const { score } = data;
  const gradeLabel: Record<ReadinessScore["grade"], string> = {
    ready: "Ready",
    almost: "Almost",
    at_risk: "At risk",
    blocked: "Blocked",
  };
  // The same counts the server scored with — all present on the payload.
  const kpiDue = data.kpi.filter((d) => d.status !== "na" && d.status !== "excluded").length;
  const kpiSubmitted = data.kpi.filter(
    (d) => d.status === "ready" || d.status === "locked" || d.status === "no_bonus",
  ).length;
  const kpiExcluded = data.kpi.filter((d) => d.status === "excluded").length;
  const kpiNotDue = data.kpi.filter((d) => d.status === "na").length;
  const bankHygiene = data.missingBank.length - data.missingBankOnPayroll;
  // The exceptions list holds two different things — HR-pipeline hires and
  // hand-granted bank exemptions — so the "never counted" bullets split them
  // rather than quoting one total against two different explanations.
  const bankExemptCount = data.exceptions.filter((e) => e.kind === "bank_exempt").length;
  const hrExceptionCount = data.exceptions.length - bankExemptCount;
  const plural = (n: number) => (n === 1 ? "" : "s");

  // One explainer row per score component: who was counted, what's open, and
  // the rule that produced the points shown.
  const rows = score.components.map((c) => {
    const pinned = c.blockerOpen > 0;
    if (c.key === "rate") {
      return {
        c,
        Icon: Wallet,
        counted: `${data.workerCount} worker${plural(data.workerCount)} with hours on this week's file`,
        state:
          c.open === 0
            ? "Everyone being paid this week has a pay rate."
            : `${c.open} of them ${c.open === 1 ? "has" : "have"} no resolvable rate — their pay can't even be computed.`,
        rule: pinned
          ? `Hard blocker: any missing rate pins this dimension to ${c.points}/${c.maxPoints} and grades the whole week Blocked.`
          : "A missing rate here would be a hard blocker — it pins this dimension to a fixed low score and grades the week Blocked.",
      };
    }
    if (c.key === "kpi") {
      return {
        c,
        Icon: ClipboardList,
        counted: `${kpiDue} department${plural(kpiDue)} due this week${
          kpiExcluded > 0 || kpiNotDue > 0
            ? ` (${[
                kpiExcluded > 0 ? `${kpiExcluded} excluded` : null,
                kpiNotDue > 0 ? `${kpiNotDue} not due` : null,
              ]
                .filter(Boolean)
                .join(", ")} — not counted)`
            : ""
        }`,
        state:
          c.open === 0
            ? "Every due department has submitted (or has no bonus to submit)."
            : `${kpiSubmitted}/${kpiDue} submitted — ${c.open} still pending.`,
        rule: "Proportional: each due department that hasn't marked its KPI ready costs an even share of these points.",
      };
    }
    return {
      c,
      Icon: Banknote,
      counted: `${data.bankOnPayrollCount} ${data.bankOnPayrollCount === 1 ? "person" : "people"} being paid this week`,
      state:
        c.open === 0
          ? "Everyone being paid this week has complete payout details."
          : `${c.open} of them ${c.open === 1 ? "is" : "are"} missing payout details — they will reach dispatch and not get paid.`,
      rule: pinned
        ? `Hard blocker: anyone on this week's payroll without bank info pins this dimension to ${c.points}/${c.maxPoints} and grades the week Blocked.`
        : bankHygiene > 0
          ? `${bankHygiene} more ${bankHygiene === 1 ? "person" : "people"} on the roster ${bankHygiene === 1 ? "is" : "are"} missing bank info but ${bankHygiene === 1 ? "isn't" : "aren't"} being paid this week — listed under Bank Info, zero score impact.`
          : "Only people actually on this week's payroll are judged here.",
    };
  });

  const bands: { g: ReadinessScore["grade"]; desc: string }[] = [
    {
      g: "blocked",
      desc: "Someone being paid this week can't be — a missing rate, or missing bank info with hours on the file.",
    },
    { g: "ready", desc: "Nothing open: every due KPI is in and everyone being paid this week is covered." },
    { g: "almost", desc: "No payday blockers, score 85 or higher." },
    { g: "at_risk", desc: "No payday blockers but the score is below 85 — or this load had partial data." },
  ];

  const rowTone = (open: number, blockers: number) =>
    open === 0
      ? "text-emerald-600 dark:text-emerald-400"
      : blockers > 0
        ? "text-rose-600 dark:text-rose-400"
        : "text-amber-600 dark:text-amber-400";
  const barTone = (open: number, blockers: number) =>
    open === 0 ? "bg-emerald-500" : blockers > 0 ? "bg-rose-500" : "bg-amber-500";

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-[min(96vw,34rem)] sm:max-w-[min(96vw,34rem)]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-orange-500" />
            Readiness Score — {score.value}/100
            <span className="rounded-full border border-zinc-200 bg-white/70 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.14em] text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900/60 dark:text-zinc-400">
              {gradeLabel[score.grade]}
            </span>
          </DialogTitle>
          <DialogDescription>
            {data.weekLabel} — the score only counts what&apos;s needed to pay THIS week. Anyone not
            being paid this week (excluded departments, onboarding exceptions, roster data debt)
            never moves it.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[62vh] space-y-3 overflow-y-auto overscroll-contain pr-1">
          {/* Per-dimension breakdown — the points sum exactly to the headline. */}
          <div className="space-y-2">
            {rows.map(({ c, Icon, counted, state, rule }) => (
              <div
                key={c.key}
                className="rounded-xl border border-zinc-200/80 bg-white/70 p-3 dark:border-zinc-800 dark:bg-zinc-900/50"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 text-xs font-semibold text-zinc-800 dark:text-zinc-100">
                    <Icon className="h-3.5 w-3.5 text-orange-500/80" />
                    {c.label}
                  </span>
                  <span className={`text-xs font-bold tabular-nums ${rowTone(c.open, c.blockerOpen)}`}>
                    {c.points}
                    <span className="font-semibold text-zinc-400 dark:text-zinc-500">/{c.maxPoints} pts</span>
                  </span>
                </div>
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-zinc-200/70 dark:bg-zinc-800">
                  <div
                    className={`h-full rounded-full ${barTone(c.open, c.blockerOpen)}`}
                    style={{ width: `${Math.max(2, Math.round((c.points / Math.max(1, c.maxPoints)) * 100))}%` }}
                  />
                </div>
                <div className="mt-1.5 space-y-0.5 text-[11px] leading-snug text-zinc-600 dark:text-zinc-300">
                  <p>
                    <span className="font-semibold text-zinc-500 dark:text-zinc-400">Counted:</span> {counted}
                  </p>
                  <p>{state}</p>
                  <p className="text-zinc-500 dark:text-zinc-400">{rule}</p>
                </div>
              </div>
            ))}
          </div>

          {/* What never moves the score — the deliberate exclusions. */}
          <div className="rounded-xl border border-zinc-200/80 bg-zinc-50/70 p-3 dark:border-zinc-800 dark:bg-zinc-900/30">
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500 dark:text-zinc-400">
              Never counted against the score
            </div>
            <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-[11px] leading-snug text-zinc-600 dark:text-zinc-300">
              <li>
                Departments switched off for this pay week in the wizard&apos;s Configuration tab
                {kpiExcluded > 0 ? ` (${kpiExcluded} this week)` : ""}.
              </li>
              <li>
                Onboarding exceptions — still onboarding, no-shows, or started this week
                {hrExceptionCount > 0 ? ` (${hrExceptionCount} this week)` : ""}.
              </li>
              <li>
                People missing bank info who have no hours this week
                {bankHygiene > 0 ? ` (${bankHygiene} right now)` : ""} — roster data debt, not a
                payday problem.
              </li>
              <li>
                Temporary Exemptions granted on the Bank Info tab
                {bankExemptCount > 0 ? ` (${bankExemptCount} this week)` : ""} — acknowledged for
                this week only; they return to Bank Info next week.
              </li>
              <li>US Employees (USEE) — paid off-channel, outside this pipeline.</li>
              <li>
                Contractors (provisioned in Admin → Roles) — paid per invoice in the wizard&apos;s
                Contractor Invoices step, never by hourly rate.
              </li>
            </ul>
          </div>

          {/* Grade bands, with the current one highlighted. */}
          <div className="rounded-xl border border-zinc-200/80 bg-white/70 p-3 dark:border-zinc-800 dark:bg-zinc-900/50">
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500 dark:text-zinc-400">
              How the grade is decided
            </div>
            <ul className="mt-1.5 space-y-1">
              {bands.map((b) => {
                const active = b.g === score.grade;
                return (
                  <li
                    key={b.g}
                    className={`flex items-start gap-2 rounded-lg px-2 py-1 text-[11px] leading-snug ${
                      active
                        ? "bg-orange-50 text-zinc-800 ring-1 ring-orange-200 dark:bg-blue-950/40 dark:text-zinc-100 dark:ring-blue-900/60"
                        : "text-zinc-500 dark:text-zinc-400"
                    }`}
                  >
                    <span
                      className={`mt-px shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${
                        active
                          ? "bg-orange-500 text-white dark:bg-blue-600"
                          : "bg-zinc-200/80 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
                      }`}
                    >
                      {gradeLabel[b.g]}
                    </span>
                    <span>{b.desc}</span>
                  </li>
                );
              })}
            </ul>
          </div>

          {/* Partial-data honesty — the same warnings the dashboard banner shows. */}
          {data.degraded.length > 0 && (
            <div className="rounded-xl border border-amber-300/70 bg-amber-50/80 p-3 dark:border-amber-500/30 dark:bg-amber-950/30">
              <div className="flex items-center gap-1.5 text-[11px] font-semibold text-amber-800 dark:text-amber-200">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                Partial data this load — the numbers above may be judged on incomplete reads
              </div>
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[10.5px] text-amber-700/90 dark:text-amber-300/80">
                {data.degraded.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
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
                        {[formatDeptLabel(w.department) || null, w.work_email].filter(Boolean).join(" · ") || "—"}
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
