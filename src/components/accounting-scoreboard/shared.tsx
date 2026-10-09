'use client';

/**
 * Accounting Scoreboard UI pieces shared by every panel: the API helper, number formatting, and
 * the autosaving cells. Governing doc: docs/features/accounting-scoreboard.md § The page.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { toast } from 'sonner';
import {
  FolderKanban,
  HandCoins,
  Handshake,
  Headphones,
  Layers,
  LayoutList,
  Loader2,
  Mail,
  Scale,
  ShieldAlert,
  ShieldCheck,
  Timer,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { BoardSection, GoalRule, SectionKey } from '@/lib/accounting-scoreboard/sections';
import {
  goalText,
  minutesToTimeInput,
  timeInputToMinutes,
  type RowScoreStatus,
} from '@/lib/accounting-scoreboard/scoring';
import { LIGHT_LABEL, type Light } from '@/lib/accounting-scoreboard/stoplight';
import { SCOREBOARD_TAB_HEADER } from '@/lib/accounting-scoreboard/live';
import { getScoreboardTabId } from '@/lib/accounting-scoreboard/live-client';

/** One icon per KPI card (Kane: "add like icons that match the kpi card"). */
export const SECTION_ICON: Record<SectionKey, LucideIcon> = {
  buckets: Layers,
  collections: HandCoins,
  pm_buckets: FolderKanban,
  onboarding: Handshake,
  inbox: Mail,
  chargebacks: ShieldAlert,
  chargeback_outcomes: Scale,
  compliance: ShieldCheck,
  cancellations: Headphones,
  payroll_timing: Timer,
  payroll_problems: TriangleAlert,
};

/** A built-in section's own icon; a custom section's is a plain list. */
export function sectionIcon(section: Pick<BoardSection, 'key'>): LucideIcon {
  return section.key === 'custom' ? LayoutList : SECTION_ICON[section.key];
}

/**
 * What a row's score cell says when it has no number (Carla, 2026-10-02): "N/A" for a bucket that
 * was 0 all week, "Pending" for a weekday Collections bucket before its own day's PM is in. Neither
 * is a 0, and neither is in the overall.
 */
export const SCORE_STATUS_TEXT: Record<Exclude<RowScoreStatus, 'scored'>, string> = {
  na: 'N/A',
  pending: 'Pending',
  pm_missing: 'PM missing',
  due_soon: 'Called out',
  empty: '—',
};

export const SCORE_STATUS_TITLE: Record<Exclude<RowScoreStatus, 'scored'>, string> = {
  na: 'Nothing in this bucket all week: no score, and left out of the overall',
  pending: "Waiting for this bucket's own day's PM reading. Left out of the overall until then",
  pm_missing: "This bucket's own day is over and its PM reading was never typed. Left out of the overall",
  due_soon: 'These disputes are already counted in the open disputes: called out, never scored or added to the overall',
  empty: 'Nothing typed this week',
};

/**
 * The Simple wordmark on a white plate, the dashboards' sidebar logo (`SidebarLogoHeader`), in place of the
 * old trophy-in-a-gradient tile (Kane, 2026-10-09). The plate stays white in dark mode: the navy wordmark has
 * no dark variant, and the sidebar plate does the same.
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex shrink-0 items-center rounded-md border border-zinc-200 bg-white px-1 dark:border-zinc-700', className)}>
      <img src="/simple-logo.png" alt="Simple" draggable={false} className="h-6 w-auto sm:h-7" />
    </span>
  );
}

/**
 * The stop light's tones (stoplight.ts): emerald = on track, amber = close (the stop light's middle,
 * ui-standards § 6.3 "caution"), rose = behind. `none` stays neutral: absence is not a colour.
 */
export const LIGHT_STYLE: Record<Light, { tile: string; number: string; icon: string; chip: string; text: string; dot: string }> = {
  green: {
    tile: 'border-emerald-200 bg-emerald-50/70 hover:bg-emerald-50 dark:border-emerald-900/70 dark:bg-emerald-950/25 dark:hover:bg-emerald-950/40',
    number: 'text-emerald-700 dark:text-emerald-300',
    icon: 'text-emerald-600 dark:text-emerald-400',
    chip: 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300',
    text: 'text-emerald-700 dark:text-emerald-300',
    dot: 'bg-emerald-500',
  },
  amber: {
    tile: 'border-amber-200 bg-amber-50/70 hover:bg-amber-50 dark:border-amber-900/70 dark:bg-amber-950/25 dark:hover:bg-amber-950/40',
    number: 'text-amber-700 dark:text-amber-300',
    icon: 'text-amber-600 dark:text-amber-400',
    chip: 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300',
    text: 'text-amber-700 dark:text-amber-300',
    dot: 'bg-amber-400',
  },
  red: {
    tile: 'border-rose-200 bg-rose-50/80 hover:bg-rose-50 dark:border-rose-900/70 dark:bg-rose-950/30 dark:hover:bg-rose-950/45',
    number: 'text-rose-700 dark:text-rose-300',
    icon: 'text-rose-600 dark:text-rose-400',
    chip: 'border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300',
    text: 'text-rose-700 dark:text-rose-300',
    dot: 'bg-rose-500',
  },
  none: {
    tile: 'border-zinc-200 bg-white/80 hover:bg-orange-50/40 dark:border-zinc-800 dark:bg-zinc-950/70 dark:hover:bg-zinc-900/60',
    number: 'text-zinc-900 dark:text-zinc-100',
    icon: 'text-zinc-500 dark:text-zinc-400',
    chip: 'border-zinc-200 bg-zinc-50 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400',
    text: 'text-zinc-500 dark:text-zinc-400',
    dot: 'bg-zinc-300 dark:bg-zinc-700',
  },
};

/**
 * A literal stop light: a dark housing with red, amber and green lamps; the live one glows.
 * Colour is never the only signal: the label is in aria-label and printed beside it.
 */
export function StopLight({ light, className }: { light: Light; className?: string }) {
  const lamps: { key: Exclude<Light, 'none'>; on: string; glow: string }[] = [
    { key: 'red', on: 'bg-rose-500', glow: 'shadow-[0_0_10px_2px_rgba(244,63,94,0.65)]' },
    { key: 'amber', on: 'bg-amber-400', glow: 'shadow-[0_0_10px_2px_rgba(251,191,36,0.6)]' },
    { key: 'green', on: 'bg-emerald-500', glow: 'shadow-[0_0_10px_2px_rgba(16,185,129,0.6)]' },
  ];
  return (
    <span
      role="img"
      aria-label={LIGHT_LABEL[light]}
      title={LIGHT_LABEL[light]}
      className={cn(
        'inline-flex shrink-0 flex-col items-center gap-1 rounded-full bg-zinc-900 px-1 py-1.5 shadow-inner ring-1 ring-zinc-800 dark:bg-black dark:ring-zinc-800',
        className,
      )}
    >
      {lamps.map((l) => (
        <span
          key={l.key}
          className={cn(
            'size-2.5 rounded-full transition-[background-color,box-shadow] duration-300',
            light === l.key ? cn(l.on, l.glow) : 'bg-zinc-700/80 dark:bg-zinc-800',
          )}
        />
      ))}
    </span>
  );
}

// How a card prints its number, shared by the Overview and the History tab so a week reads the same in both.

/** How a card's number prints: a cycle score or a win ratio as %, a 0–10 score with one decimal, else by its goal. */
export function headlineFormat(s: BoardSection): (n: number | null) => string {
  if (s.kind === 'payroll_cycle' || s.kind === 'amount_count') return fmtPct;
  if (s.score) return fmtScore;
  return goalFormat(s.goal);
}

/** A card names its tab where the section's own title would not say it (Chargebacks holds two). */
export function cardTitle(s: BoardSection): string {
  if (s.key === 'chargebacks') return 'Chargebacks — Open Disputes';
  if (s.key === 'chargeback_outcomes') return 'Chargebacks — Outcomes';
  return s.title;
}

export function headlineUnit(s: BoardSection): string {
  if (s.key === 'custom') return s.kind === 'am_pm' ? 'score' : 'this week';
  switch (s.key) {
    case 'buckets':
      return 'overall score';
    case 'inbox':
      return 'avg score';
    case 'chargebacks':
      return 'score';
    case 'chargeback_outcomes':
      return 'won';
    case 'collections':
      return 'points';
    case 'pm_buckets':
      return 'avg in buckets';
    case 'payroll_timing':
      return 'cycle score';
    case 'onboarding':
      return 'payments';
    case 'compliance':
      return 'done';
    case 'cancellations':
      return 'reviewed';
    case 'payroll_problems':
      return 'problems';
    default:
      return 'this week';
  }
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string; code: string };

/** JSON fetch that never throws and never hands back an HTML page as data. Every call names this browser tab
 *  (`SCOREBOARD_TAB_HEADER`), so the live channel's echo of this tab's own write is skipped (`live-client.ts`). */
export async function api<T>(url: string, init?: RequestInit): Promise<ApiResult<T>> {
  try {
    const res = await fetch(url, {
      cache: 'no-store',
      ...init,
      headers: {
        'Content-Type': 'application/json',
        [SCOREBOARD_TAB_HEADER]: getScoreboardTabId(),
        ...(init?.headers ?? {}),
      },
    });
    const body = (await res.json().catch(() => null)) as (T & { error?: string; code?: string }) | null;
    if (!res.ok || body === null) {
      return {
        ok: false,
        status: res.status,
        error: body?.error ?? `The server answered ${res.status}.`,
        code: body?.code ?? 'http_error',
      };
    }
    return { ok: true, data: body };
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : 'Network error', code: 'network' };
  }
}

/** "—" for absence, never 0 (ui-standards § 12.5). Up to 2 decimals, trailing zeros dropped. */
export function fmtNum(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return Number.isInteger(n) ? n.toLocaleString('en-US') : n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/** A percentage (Outcomes' win ratio): up to one decimal, "—" for absence. */
export function fmtPct(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return `${(Math.round(n * 10) / 10).toLocaleString('en-US', { maximumFractionDigits: 1 })}%`;
}

/** How a goal's number prints: a score with one decimal, a percentage with %, anything else as a number. */
export function goalFormat(goal: Pick<GoalRule, 'measure' | 'unit'> | undefined): (n: number | null) => string {
  if (goal?.measure === 'score') return fmtScore;
  if (goal?.measure === 'ratio' || goal?.unit === '%') return fmtPct;
  return fmtNum;
}

/** Scores print with one decimal, as the sheet does (8.3, 10.0). */
export function fmtScore(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return (Math.round(n * 10) / 10).toFixed(1);
}

export function fmtPhp(n: number): string {
  return `₱${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

export function fmtUsd(n: number | null): string {
  return n === null ? '—' : `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Dollars with their sign in front of the "$": "−$244.00" (a true minus sign), and with `plus` "+$19.00" (the
 * Chargebacks Net). 0 is "$0.00", never signed. Nothing typed is "—".
 */
export function fmtSignedUsd(n: number | null, plus = false): string {
  if (n === null) return '—';
  const abs = fmtUsd(Math.abs(n));
  return n < 0 ? `−${abs}` : plus && n > 0 ? `+${abs}` : abs;
}

export function handle(email: string): string {
  return email.split('@')[0];
}

export const DIM = 'text-zinc-400 dark:text-zinc-600';
export const TINY_CAPS = 'text-[10px] font-semibold uppercase tracking-[0.14em]';

// ---------------------------------------------------------------------------
// Motion (ui-standards § 11.1, § 14). Two curves only: [0.22, 1, 0.36, 1] for tab swaps and
// the gliding indicator, [0.16, 1, 0.3, 1] for things that settle. Movement is gated on
// useReducedMotion(); colour feedback is not, because it IS the confirmation (§ 14.3).
// ---------------------------------------------------------------------------

export const EASE_TAB = [0.22, 1, 0.36, 1] as const;
export const EASE_SETTLE = [0.16, 1, 0.3, 1] as const;

/**
 * A pill whose ONE indicator glides between siblings (shared `layoutId`), the house pattern for
 * in-page tab rows (§ 11.1). Every pill in a row passes the same `layoutId`. Use a different id
 * per row, or the indicator flies between rows. The indicator is solid orange-700, not the house
 * orange-to-amber gradient (2026-10-09): white on orange-500 is 2.9:1, under AA; on orange-700 it is 5.2:1.
 */
export function SlidingPill({
  layoutId,
  active,
  onClick,
  children,
  className,
}: {
  layoutId: string;
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  className?: string;
}) {
  const reduce = useReducedMotion() ?? false;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'relative inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400/60',
        active
          ? 'text-white'
          : 'text-zinc-600 hover:bg-orange-50 hover:text-orange-900 dark:text-zinc-400 dark:hover:bg-orange-950/30 dark:hover:text-orange-200',
        className,
      )}
    >
      {active ? (
        <motion.span
          layoutId={layoutId}
          aria-hidden
          className="absolute inset-0 rounded-lg bg-orange-700"
          transition={{ duration: reduce ? 0 : 0.28, ease: EASE_TAB }}
        />
      ) : null}
      <span className="relative z-10 inline-flex items-center gap-1.5">{children}</span>
    </button>
  );
}

/**
 * Which ends of a sideways-scrolling box still hide content. A callback ref (the box can mount after a load), and the
 * box AND its first child are observed, so a column added later (a new key) shows its edge without a scroll.
 */
export function useScrollEdges<T extends HTMLElement>(): [(el: T | null) => void, { left: boolean; right: boolean }, T | null] {
  const [el, setEl] = useState<T | null>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  useEffect(() => {
    if (!el) return;
    const update = () => {
      const left = el.scrollLeft > 1;
      const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
      setEdges((e) => (e.left === left && e.right === right ? e : { left, right }));
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null;
    ro?.observe(el);
    if (el.firstElementChild) ro?.observe(el.firstElementChild);
    return () => {
      el.removeEventListener('scroll', update);
      ro?.disconnect();
    };
  }, [el]);
  return [setEl, edges, el];
}

/**
 * The soft edge on a sideways-scrolling box: shown only on a side that still hides content, so a row cut in half reads
 * as "there is more" instead of a clipped edge. Sits inside a `relative` wrapper around the box; never takes a click.
 */
export function ScrollEdgeFade({
  side,
  shown,
  className,
}: {
  side: 'left' | 'right';
  shown: boolean;
  /** The colour the box sits on, as the gradient's `from-` (light and dark). */
  className: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        'pointer-events-none absolute inset-y-px z-20 w-8 transition-opacity duration-200',
        side === 'left' ? 'left-px rounded-l-[inherit] bg-gradient-to-r' : 'right-px rounded-r-[inherit] bg-gradient-to-l',
        'to-transparent',
        shown ? 'opacity-100' : 'opacity-0',
        className,
      )}
    />
  );
}

/** How long each loading line stays before the next (a load usually lands inside the first two or three). */
export const LOADING_LINE_MS = 1600;

/**
 * A tab's loading state (ui-standards § 5.5): a centered spinner over a tiny-caps caption that cycles through what the
 * tab is really fetching (Kane, 2026-10-09: *"random texts while its loading like 'Fetching data' … depending on the
 * tab"*). Each line names a read that is genuinely in flight; none ticks or claims "done" (that is the load modal's
 * job, with real steps). Screen readers hear the stable `label` once, never the cycling lines. Reduced motion keeps
 * the lines changing and drops only the crossfade. Shown ONLY when there is nothing to paint: a cached tab never
 * shows it (§ Browser cache).
 */
export function LoadingLines({ label, lines, className }: { label: string; lines: readonly string[]; className?: string }) {
  const reduce = useReducedMotion() ?? false;
  const [i, setI] = useState(0);
  useEffect(() => {
    if (lines.length < 2) return;
    const id = window.setInterval(() => setI((n) => (n + 1) % lines.length), LOADING_LINE_MS);
    return () => window.clearInterval(id);
  }, [lines.length]);
  const line = lines[i % Math.max(1, lines.length)] ?? label;
  return (
    <div role="status" className={cn('flex flex-col items-center justify-center gap-2.5 py-10 text-zinc-400', className)}>
      <Loader2 className="size-4 animate-spin text-orange-500" aria-hidden />
      <span className="sr-only">{label}</span>
      <span aria-hidden className="relative block h-4 w-full overflow-hidden text-center">
        <AnimatePresence initial={false} mode="popLayout">
          <motion.span
            key={line}
            initial={reduce ? { opacity: 1 } : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduce ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, y: -6 }}
            transition={{ duration: reduce ? 0 : 0.26, ease: EASE_TAB }}
            className="absolute inset-x-0 text-[10px] uppercase tracking-[0.22em]"
          >
            {line}
          </motion.span>
        </AnimatePresence>
      </span>
    </div>
  );
}

function isDark(): boolean {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
}

/** One background sweep that settles to transparent: the Issues-tab flash, as a Web Animation. */
function sweep(el: HTMLElement, color: string, durationMs: number): void {
  if (typeof el.animate !== 'function') return;
  el.animate(
    [{ backgroundColor: color }, { backgroundColor: color, offset: 0.22 }, { backgroundColor: 'transparent' }],
    { duration: durationMs, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
  );
}

/**
 * A computed number that sweeps orange once when it changes, so typing a count shows WHICH
 * totals it moved (and a teammate's save shows up on the next refresh). No sweep on first paint
 * or when `scope` changes: a new week is new data, not a change.
 */
export function Flash({
  value,
  scope,
  children,
  className,
}: {
  value: number | string | null;
  scope: string;
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const last = useRef<{ value: number | string | null; scope: string }>({ value, scope });
  useEffect(() => {
    const prev = last.current;
    last.current = { value, scope };
    if (prev.scope !== scope || Object.is(prev.value, value)) return;
    if (ref.current) sweep(ref.current, isDark() ? 'rgb(251 146 60 / 0.22)' : 'rgb(249 115 22 / 0.16)', 1500);
  }, [value, scope]);
  return (
    <span ref={ref} className={cn('-mx-1 rounded px-1', className)}>
      {children}
    </span>
  );
}

/** Goal chip: the sheet's goal, this week's number, and the stop light's call on it. */
export function GoalChip({
  goal,
  light,
  value,
  unitFormat,
}: {
  goal?: GoalRule;
  light: Light;
  value: number | null;
  unitFormat: (n: number | null) => string;
}) {
  if (!goal) return null;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors duration-300',
        LIGHT_STYLE[light].chip,
      )}
    >
      <span className="font-mono tabular-nums">{unitFormat(value)}</span>
      <span className="opacity-70">goal {goalText(goal)}</span>
      {light !== 'none' ? <span className="font-semibold">· {LIGHT_LABEL[light]}</span> : null}
    </span>
  );
}

export function SectionHeader({ title, help, right }: { title: string; help: string; right?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">{title}</h2>
        <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{help}</p>
      </div>
      {right ? <div className="flex flex-wrap items-center gap-2">{right}</div> : null}
    </div>
  );
}

/** Tracks how many cells are being edited, so a background refresh never lands mid-typing. */
export type EditingSignal = (delta: 1 | -1) => void;

const CELL =
  'h-8 rounded-md border border-zinc-200 bg-white px-1.5 text-right font-mono text-[13px] tabular-nums text-zinc-900 outline-none transition-[color,background-color,border-color,opacity] duration-150 placeholder:text-zinc-300 focus:border-orange-400 focus:ring-2 focus:ring-orange-200 disabled:cursor-not-allowed disabled:bg-zinc-50 disabled:text-zinc-400 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100 dark:placeholder:text-zinc-700 dark:focus:ring-orange-900/60 dark:disabled:bg-zinc-900';

/** The cell's answer to a save: a ring that settles out. Emerald = saved, rose = refused. */
function ringOut(el: HTMLElement | null, outcome: 'saved' | 'failed'): void {
  if (!el || typeof el.animate !== 'function') return;
  const rgb = outcome === 'saved' ? '16 185 129' : '244 63 94';
  el.animate(
    [{ boxShadow: `0 0 0 2px rgb(${rgb} / 0.55)` }, { boxShadow: `0 0 0 2px rgb(${rgb} / 0)` }],
    { duration: outcome === 'saved' ? 900 : 1300, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
  );
}

/**
 * A count that saves itself on blur or Enter. Empty = no number (the entry is deleted), never 0.
 * While focused it keeps its own draft, so a refresh from someone else never overwrites typing.
 */
export function NumberCell({
  value,
  label,
  onCommit,
  onEditing,
  disabled,
  warn,
  title,
  className,
}: {
  value: number | null;
  label: string;
  onCommit: (next: number | null) => Promise<boolean>;
  onEditing: EditingSignal;
  disabled?: boolean;
  warn?: boolean;
  title?: string;
  className?: string;
}) {
  const shown = value === null ? '' : String(value);
  const [draft, setDraft] = useState(shown);
  const [saving, setSaving] = useState(false);
  const focused = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!focused.current && !saving) setDraft(shown);
  }, [shown, saving]);

  async function commit() {
    const text = draft.trim();
    const next = text === '' ? null : Number(text);
    if (next !== null && (!Number.isFinite(next) || next < 0)) {
      toast.error(`${label}: type a number, or leave it empty`);
      setDraft(shown);
      ringOut(inputRef.current, 'failed');
      return;
    }
    if (next === value) {
      setDraft(shown);
      return;
    }
    setSaving(true);
    const ok = await onCommit(next);
    setSaving(false);
    if (!ok) setDraft(shown);
    ringOut(inputRef.current, ok ? 'saved' : 'failed');
  }

  return (
    <input
      ref={inputRef}
      type="text"
      inputMode="decimal"
      aria-label={label}
      title={title ?? label}
      value={draft}
      disabled={disabled}
      placeholder="—"
      onFocus={(e) => {
        focused.current = true;
        onEditing(1);
        e.currentTarget.select();
      }}
      onBlur={() => {
        focused.current = false;
        onEditing(-1);
        void commit();
      }}
      onChange={(e) => setDraft(e.target.value.replace(/[^0-9.]/g, ''))}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          setDraft(shown);
          requestAnimationFrame(() => (e.target as HTMLInputElement).blur());
        }
      }}
      className={cn(
        CELL,
        // A box holds up to 100,000 (validate.ts MAX_COUNT); it widens past 4 characters so a big
        // number is never cut off. Most counts are 1–3 digits (measured max 94 on 10-01).
        draft.length > 4 ? 'w-20' : 'w-14',
        warn && 'border-amber-400 bg-amber-50/60 dark:border-amber-700 dark:bg-amber-950/30',
        saving && 'opacity-70',
        className,
      )}
    />
  );
}

/** A clock time that saves itself (stored as minutes after midnight). */
export function TimeCell({
  value,
  label,
  onCommit,
  onEditing,
  disabled,
  warn,
}: {
  value: number | null;
  label: string;
  onCommit: (next: number | null) => Promise<boolean>;
  onEditing: EditingSignal;
  disabled?: boolean;
  warn?: boolean;
}) {
  const shown = minutesToTimeInput(value);
  const [draft, setDraft] = useState(shown);
  const [saving, setSaving] = useState(false);
  const focused = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!focused.current && !saving) setDraft(shown);
  }, [shown, saving]);

  async function commit() {
    const next = draft === '' ? null : timeInputToMinutes(draft);
    if (draft !== '' && next === null) {
      setDraft(shown);
      ringOut(inputRef.current, 'failed');
      return;
    }
    if (next === value) return;
    setSaving(true);
    const ok = await onCommit(next);
    setSaving(false);
    if (!ok) setDraft(shown);
    ringOut(inputRef.current, ok ? 'saved' : 'failed');
  }

  return (
    <input
      ref={inputRef}
      type="time"
      aria-label={label}
      title={label}
      value={draft}
      disabled={disabled}
      onFocus={() => {
        focused.current = true;
        onEditing(1);
      }}
      onBlur={() => {
        focused.current = false;
        onEditing(-1);
        void commit();
      }}
      onChange={(e) => setDraft(e.target.value)}
      className={cn(
        CELL,
        'w-[6.5rem] text-left',
        warn && 'border-amber-400 bg-amber-50/60 dark:border-amber-700 dark:bg-amber-950/30',
        saving && 'opacity-70',
      )}
    />
  );
}

/** A small rounded tag beside a row name ("Mon bucket", "due in 7 days"). */
export function RowTag({ children, tone = 'zinc', title }: { children: ReactNode; tone?: 'zinc' | 'amber'; title?: string }) {
  return (
    <span
      title={title}
      className={cn(
        TINY_CAPS,
        'rounded px-1 text-[9px]',
        tone === 'amber'
          ? 'bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300'
          : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800',
      )}
    >
      {children}
    </span>
  );
}

export function EmptyRows({ noun, canEditSetup }: { noun: string; canEditSetup: boolean }) {
  return (
    <div className="rounded-xl border border-dashed border-zinc-200 px-6 py-10 text-center dark:border-zinc-800">
      <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">No {noun}s on this section yet</p>
      <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
        {canEditSetup ? 'Add them under Setup → Rows.' : 'Carla or Claire can add them under Setup.'}
      </p>
    </div>
  );
}
