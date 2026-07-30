'use client';

// Payment Catalog -- Summary tab (internal tab id / file name stay "overview").
//
// Redesigned (2026-07-30) from the auto-rotating "Live Standings" board into a
// static compensation dashboard:
//   - A four-card KPI band on soft gradient surfaces: estimated hourly
//     payroll, highest-paid department, top earner, and a Rate Spotlight card
//     that rotates through a random person's resolved rate every 8 seconds
//     (pauses on hover; the shuffle button re-rolls immediately).
//   - A pay-mix donut (share of hourly payroll by department, top 8 + Other)
//     beside a per-department bar graph. Cross-currency figures are summed on
//     a PHP-equivalent -- the same honesty rule overview-metrics uses for
//     ranking -- and the card says so when non-PHP rates are in the mix.
//   - A quiet secondary band keeps base-rate coverage, the bonus library and
//     the OT premium figures from the old board.
//
// The categorical department palette is the dataviz reference palette (eight
// slots, FIXED order, separate light/dark steps) validated with the
// six-checks script against these exact surfaces (white / zinc-950) in both
// modes. Departments beyond the eighth fold into a gray "Other" slice; every
// slice and bar carries a visible text label, so identity never rides on
// color alone. All motion is transform/opacity only and enters once.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import {
  Award,
  BarChart3,
  Building2,
  Crown,
  PieChart,
  Shuffle,
  Sparkles,
  Timer,
  LayoutGrid,
  Wallet,
} from 'lucide-react';
import {
  CURRENCY_SYMBOL,
  CURRENCY_LOCALE,
  type PayCurrency,
  type PayStructure,
} from '@/lib/payment-catalog/pay-structure';
import type { BonusDef, BonusAssignment } from '@/lib/bonus-catalog/types';
import type { SystemBonus } from '@/lib/payment-catalog/system-bonus';
import type { FxRates } from '@/lib/fx/currency-fx';
import {
  computeCatalogOverview,
  type CatalogOverview,
  type DeptSpendRow,
  type SpotlightPerson,
} from '@/lib/payment-catalog/overview-metrics';

/** Shared easing -- matches the catalog's tab transition. */
const EASE = [0.22, 1, 0.36, 1] as const;

/** How long the Rate Spotlight lingers on one person. */
const SPOTLIGHT_MS = 8000;

// ---------------------------------------------------------------------------
// Money formatting
// ---------------------------------------------------------------------------

/** Full money string with currency symbol, always 2 decimals (COP 0). */
function money(n: number, currency: PayCurrency = 'PHP'): string {
  const locale = CURRENCY_LOCALE[currency] ?? 'en-PH';
  const digits = currency === 'COP' ? 0 : 2;
  return `${CURRENCY_SYMBOL[currency]}${n.toLocaleString(locale, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

/** Whole-peso money string for chart figures and totals (no cents noise). */
function moneyWhole(n: number, currency: PayCurrency = 'PHP'): string {
  const locale = CURRENCY_LOCALE[currency] ?? 'en-PH';
  return `${CURRENCY_SYMBOL[currency]}${Math.round(n).toLocaleString(locale)}`;
}

type RosterEntry = { email: string; name: string; department: string; aliases?: string[] };

// ---------------------------------------------------------------------------
// Count-up: interpolate a displayed number on data change. Numbers animate in
// once and then sit perfectly still (no perpetual scale -> no text blur).
// ---------------------------------------------------------------------------

function useCountUp(target: number, enabled: boolean, duration = 700): number {
  const [val, setVal] = useState(enabled ? 0 : target);
  const fromRef = useRef(0);
  useEffect(() => {
    if (!enabled) {
      setVal(target);
      fromRef.current = target;
      return;
    }
    const from = fromRef.current;
    const start = performance.now();
    let raf = requestAnimationFrame(function tick(now) {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setVal(from + (target - from) * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
      else fromRef.current = target;
    });
    return () => cancelAnimationFrame(raf);
  }, [target, enabled, duration]);
  return enabled ? val : target;
}

function CountInt({ value, animate }: { value: number; animate: boolean }) {
  const v = useCountUp(value, animate);
  return <>{Math.round(v).toLocaleString('en-US')}</>;
}

function CountMoney({
  value,
  currency,
  animate,
}: {
  value: number;
  currency: PayCurrency;
  animate: boolean;
}) {
  const v = useCountUp(value, animate);
  return <>{money(v, currency)}</>;
}

function CountMoneyWhole({ value, animate }: { value: number; animate: boolean }) {
  const v = useCountUp(value, animate);
  return <>{moneyWhole(v)}</>;
}

function CountDecimal({ value, animate, digits = 2 }: { value: number; animate: boolean; digits?: number }) {
  const v = useCountUp(value, animate);
  return <>{v.toFixed(digits)}</>;
}

// ---------------------------------------------------------------------------
// Department palette -- dataviz reference categorical palette, fixed order,
// light/dark steps. Validated (six checks) on white and zinc-950 surfaces.
// Static literal class strings so Tailwind JIT sees every arbitrary value.
// ---------------------------------------------------------------------------

const SLOTS = [
  { swatch: 'bg-[#2a78d6] dark:bg-[#3987e5]', stroke: 'stroke-[#2a78d6] dark:stroke-[#3987e5]' },
  { swatch: 'bg-[#eb6834] dark:bg-[#d95926]', stroke: 'stroke-[#eb6834] dark:stroke-[#d95926]' },
  { swatch: 'bg-[#1baf7a] dark:bg-[#199e70]', stroke: 'stroke-[#1baf7a] dark:stroke-[#199e70]' },
  { swatch: 'bg-[#eda100] dark:bg-[#c98500]', stroke: 'stroke-[#eda100] dark:stroke-[#c98500]' },
  { swatch: 'bg-[#e87ba4] dark:bg-[#d55181]', stroke: 'stroke-[#e87ba4] dark:stroke-[#d55181]' },
  { swatch: 'bg-[#008300]', stroke: 'stroke-[#008300]' },
  { swatch: 'bg-[#4a3aa7] dark:bg-[#9085e9]', stroke: 'stroke-[#4a3aa7] dark:stroke-[#9085e9]' },
  { swatch: 'bg-[#e34948] dark:bg-[#e66767]', stroke: 'stroke-[#e34948] dark:stroke-[#e66767]' },
] as const;

const SLOT_OTHER = {
  swatch: 'bg-zinc-300 dark:bg-zinc-600',
  stroke: 'stroke-zinc-300 dark:stroke-zinc-600',
} as const;

/** Color slot for a department by its spend rank (fixed order, never cycled;
 *  9th and beyond fold to the gray "Other" treatment). */
function slotFor(rank: number) {
  return rank < SLOTS.length ? SLOTS[rank] : SLOT_OTHER;
}

// ---------------------------------------------------------------------------
// KPI cards (gradient band)
// ---------------------------------------------------------------------------

type Tone = 'accent' | 'violet' | 'amber' | 'teal';

/** Soft two-stop gradients -- deliberately quiet (tint fades into the card
 *  surface) so the band reads instrumented, not flashy. */
const TONES: Record<Tone, { card: string; chip: string }> = {
  accent: {
    card: 'border-orange-200/70 bg-gradient-to-br from-orange-100/90 via-amber-50/60 to-white dark:border-blue-900/50 dark:from-blue-950/60 dark:via-blue-950/20 dark:to-zinc-950',
    chip: 'bg-orange-500/15 text-orange-600 dark:bg-blue-500/15 dark:text-blue-300',
  },
  violet: {
    card: 'border-violet-200/70 bg-gradient-to-br from-violet-100/80 via-violet-50/40 to-white dark:border-violet-900/50 dark:from-violet-950/50 dark:via-violet-950/15 dark:to-zinc-950',
    chip: 'bg-violet-500/15 text-violet-600 dark:bg-violet-500/15 dark:text-violet-300',
  },
  amber: {
    card: 'border-amber-200/70 bg-gradient-to-br from-amber-100/80 via-yellow-50/40 to-white dark:border-amber-900/50 dark:from-amber-950/40 dark:via-amber-950/10 dark:to-zinc-950',
    chip: 'bg-amber-500/15 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300',
  },
  teal: {
    card: 'border-teal-200/70 bg-gradient-to-br from-teal-100/80 via-cyan-50/40 to-white dark:border-teal-900/50 dark:from-teal-950/50 dark:via-teal-950/15 dark:to-zinc-950',
    chip: 'bg-teal-500/15 text-teal-600 dark:bg-teal-500/15 dark:text-teal-300',
  },
};

function KpiLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10.5px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
      {children}
    </div>
  );
}

function StatCard({
  tone,
  icon: Icon,
  label,
  headerExtra,
  children,
}: {
  tone: Tone;
  icon: typeof Wallet;
  label: string;
  /** Optional element rendered in place of the icon chip (e.g. a button). */
  headerExtra?: React.ReactNode;
  children: React.ReactNode;
}) {
  const t = TONES[tone];
  return (
    <div className={`relative overflow-hidden rounded-2xl border p-4 shadow-sm ${t.card}`}>
      <div className="flex items-start justify-between gap-2">
        <KpiLabel>{label}</KpiLabel>
        {headerExtra ?? (
          <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${t.chip}`}>
            <Icon className="h-4 w-4" />
          </span>
        )}
      </div>
      <div className="mt-2">{children}</div>
    </div>
  );
}

/** The big figure inside a stat card. */
function StatValue({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[26px] font-semibold leading-8 tracking-tight tabular-nums text-zinc-900 dark:text-white">
      {children}
    </div>
  );
}

function StatSub({ children }: { children: React.ReactNode }) {
  return <div className="mt-1 truncate text-xs text-zinc-500 dark:text-zinc-400">{children}</div>;
}

// ---------------------------------------------------------------------------
// Rate Spotlight -- one KPI card that rotates through a random person's rate.
// ---------------------------------------------------------------------------

function SpotlightCard({ pool, reduced }: { pool: SpotlightPerson[]; reduced: boolean }) {
  const [idx, setIdx] = useState(0);
  const [hovered, setHovered] = useState(false);

  /** Jump to a random person guaranteed different from the current one. */
  const shuffle = useCallback(() => {
    setIdx((i) => {
      if (pool.length <= 1) return 0;
      return (i + 1 + Math.floor(Math.random() * (pool.length - 1))) % pool.length;
    });
  }, [pool.length]);

  // Random opening pick happens after mount (never during render) so the
  // first paint is deterministic.
  useEffect(() => {
    if (pool.length > 1) setIdx(Math.floor(Math.random() * pool.length));
  }, [pool.length]);

  // Auto-rotate; hover pauses so a figure being read never swaps mid-glance.
  useEffect(() => {
    if (hovered || pool.length <= 1) return;
    const t = setInterval(shuffle, SPOTLIGHT_MS);
    return () => clearInterval(t);
  }, [hovered, shuffle, pool.length]);

  const p = pool.length > 0 ? pool[Math.min(idx, pool.length - 1)] : null;
  const chip = TONES.teal.chip;

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="contents"
    >
      <StatCard
        tone="teal"
        icon={Sparkles}
        label="Rate spotlight"
        headerExtra={
          <button
            type="button"
            onClick={shuffle}
            disabled={pool.length <= 1}
            title="Show someone else"
            aria-label="Show another random person's rate"
            className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-transform hover:scale-110 active:scale-95 disabled:opacity-40 ${chip}`}
          >
            <Shuffle className="h-4 w-4" />
          </button>
        }
      >
        {p ? (
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={p.email}
              initial={reduced ? { opacity: 0 } : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduced ? { opacity: 0 } : { opacity: 0, y: -8 }}
              transition={{ duration: 0.25, ease: EASE }}
            >
              <StatValue>
                {money(p.rateNative, p.currency)}
                <span className="text-sm font-medium text-zinc-400">/hr</span>
              </StatValue>
              <StatSub>
                <span className="font-medium text-zinc-700 dark:text-zinc-200">{p.name}</span>
                {' · '}
                {p.deptName}
              </StatSub>
              <div className="mt-1.5 flex items-center gap-1.5">
                <span
                  className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
                    p.source === 'individual'
                      ? 'bg-teal-500/15 text-teal-700 dark:text-teal-300'
                      : 'bg-zinc-500/10 text-zinc-500 dark:bg-zinc-500/20 dark:text-zinc-400'
                  }`}
                >
                  {p.source === 'individual' ? 'Individual rate' : 'Dept base rate'}
                </span>
                {p.currency !== 'PHP' && (
                  <span className="text-[10px] tabular-nums text-zinc-400">
                    ~{money(p.ratePhp, 'PHP')}/hr
                  </span>
                )}
              </div>
            </motion.div>
          </AnimatePresence>
        ) : (
          <>
            <StatValue>—</StatValue>
            <StatSub>No resolvable rates yet</StatSub>
          </>
        )}
      </StatCard>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pay-share donut (share of estimated hourly payroll by department)
// ---------------------------------------------------------------------------

interface DonutSlice {
  key: string;
  name: string;
  valuePhp: number;
  share: number;
  /** 0..7 palette slot, or -1 for the gray "Other" fold. */
  slotIdx: number;
  /** Departments folded into this slice (1 for a real department). */
  deptCount: number;
}

/** Fold spend rows into at most 8 colored slices + one gray "Other". */
function buildSlices(rows: DeptSpendRow[]): DonutSlice[] {
  const named = rows.filter((r) => r.hourlyPhp > 0);
  const head = named.slice(0, SLOTS.length);
  const rest = named.slice(SLOTS.length);
  const slices: DonutSlice[] = head.map((r, i) => ({
    key: r.key,
    name: r.name,
    valuePhp: r.hourlyPhp,
    share: r.share,
    slotIdx: i,
    deptCount: 1,
  }));
  if (rest.length > 0) {
    const value = rest.reduce((s, r) => s + r.hourlyPhp, 0);
    const share = rest.reduce((s, r) => s + r.share, 0);
    slices.push({
      key: '__other__',
      name: `Other (${rest.length} dept${rest.length === 1 ? '' : 's'})`,
      valuePhp: value,
      share,
      slotIdx: -1,
      deptCount: rest.length,
    });
  }
  return slices;
}

function PayShareDonut({
  slices,
  totalPhp,
  hoveredKey,
  onHover,
  reduced,
}: {
  slices: DonutSlice[];
  totalPhp: number;
  hoveredKey: string | null;
  onHover: (key: string | null) => void;
  reduced: boolean;
}) {
  const R = 70;
  const C = 2 * Math.PI * R;
  // 2px-equivalent surface gap between segments (only when there are >= 2).
  const gap = slices.length > 1 ? 3 : 0;
  let offset = 0;
  const hovered = hoveredKey ? slices.find((s) => s.key === hoveredKey) : null;
  return (
    <motion.div
      className="relative mx-auto h-44 w-44 shrink-0"
      initial={reduced ? false : { opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.45, ease: EASE }}
    >
      <svg viewBox="0 0 200 200" className="h-full w-full -rotate-90">
        <circle
          cx={100}
          cy={100}
          r={R}
          fill="none"
          strokeWidth={26}
          className="stroke-zinc-100 dark:stroke-zinc-800/80"
        />
        {slices.map((s) => {
          const raw = s.share * C;
          const len = Math.max(1, raw - gap);
          const slot = s.slotIdx >= 0 ? SLOTS[s.slotIdx] : SLOT_OTHER;
          const dim = hoveredKey !== null && hoveredKey !== s.key;
          const el = (
            <circle
              key={s.key}
              cx={100}
              cy={100}
              r={R}
              fill="none"
              strokeWidth={hoveredKey === s.key ? 30 : 26}
              strokeLinecap="butt"
              className={`${slot.stroke} cursor-pointer transition-[opacity,stroke-width] duration-200 ${dim ? 'opacity-30' : ''}`}
              strokeDasharray={`${len} ${C - len}`}
              strokeDashoffset={-(offset + gap / 2)}
              onMouseEnter={() => onHover(s.key)}
              onMouseLeave={() => onHover(null)}
            >
              <title>{`${s.name}: ${moneyWhole(s.valuePhp)}/hr (${(s.share * 100).toFixed(1)}%)`}</title>
            </circle>
          );
          offset += raw;
          return el;
        })}
      </svg>
      {/* Center readout: the hovered slice, or the org total. */}
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-8 text-center">
        {hovered ? (
          <>
            <div className="w-full truncate text-[10px] font-semibold uppercase tracking-wide text-zinc-400">
              {hovered.name}
            </div>
            <div className="text-lg font-semibold tracking-tight tabular-nums text-zinc-900 dark:text-white">
              {moneyWhole(hovered.valuePhp)}
            </div>
            <div className="text-[10px] tabular-nums text-zinc-400">
              {(hovered.share * 100).toFixed(1)}% of total
            </div>
          </>
        ) : (
          <>
            <div className="text-lg font-semibold tracking-tight tabular-nums text-zinc-900 dark:text-white">
              {moneyWhole(totalPhp)}
            </div>
            <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-400">
              est. total / hr
            </div>
          </>
        )}
      </div>
    </motion.div>
  );
}

function PayShareCard({
  rows,
  totalPhp,
  hasFxMix,
  reduced,
}: {
  rows: DeptSpendRow[];
  totalPhp: number;
  hasFxMix: boolean;
  reduced: boolean;
}) {
  const slices = useMemo(() => buildSlices(rows), [rows]);
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  return (
    <div className="flex h-full flex-col rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex items-center gap-1.5">
        <PieChart className="h-3.5 w-3.5 text-zinc-400" />
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500">
          Pay share by department
        </h3>
      </div>
      <div className="mt-4 flex flex-1 flex-col gap-4">
        <PayShareDonut
          slices={slices}
          totalPhp={totalPhp}
          hoveredKey={hoveredKey}
          onHover={setHoveredKey}
          reduced={reduced}
        />
        {/* Legend doubles as the table view: name + value + share per slice. */}
        <div className="space-y-0.5">
          {slices.map((s) => {
            const slot = s.slotIdx >= 0 ? SLOTS[s.slotIdx] : SLOT_OTHER;
            const active = hoveredKey === s.key;
            return (
              <div
                key={s.key}
                onMouseEnter={() => setHoveredKey(s.key)}
                onMouseLeave={() => setHoveredKey(null)}
                className={`flex cursor-default items-center gap-2 rounded-lg px-2 py-1 transition-colors ${
                  active ? 'bg-zinc-50 dark:bg-zinc-900/70' : ''
                }`}
              >
                <span className={`h-2.5 w-2.5 shrink-0 rounded-sm ${slot.swatch}`} />
                <span className="min-w-0 flex-1 truncate text-xs font-medium text-zinc-700 dark:text-zinc-200">
                  {s.name}
                </span>
                <span className="tabular-nums text-xs font-semibold text-zinc-900 dark:text-white">
                  {moneyWhole(s.valuePhp)}
                  <span className="font-normal text-zinc-400">/hr</span>
                </span>
                <span className="w-10 text-right tabular-nums text-[11px] text-zinc-400">
                  {(s.share * 100).toFixed(1)}%
                </span>
              </div>
            );
          })}
        </div>
      </div>
      {hasFxMix && (
        <p className="mt-3 text-[10px] leading-relaxed text-zinc-400">
          Non-PHP rates converted at today&apos;s FX (PHP-equivalent).
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-department bar graph (estimated hourly payroll, all departments)
// ---------------------------------------------------------------------------

function DeptBarsCard({ rows, reduced }: { rows: DeptSpendRow[]; reduced: boolean }) {
  const max = rows.length > 0 ? rows[0].hourlyPhp : 1;
  return (
    <div className="flex h-full flex-col rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <BarChart3 className="h-3.5 w-3.5 text-zinc-400" />
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500">
            Hourly pay by department
          </h3>
        </div>
        <span className="text-[10px] tabular-nums text-zinc-400">
          {rows.length} department{rows.length === 1 ? '' : 's'}
        </span>
      </div>
      <div className="mt-4 space-y-0.5">
        {rows.map((r, i) => {
          const slot = slotFor(i);
          const frac = Math.max(0.02, Math.min(1, r.hourlyPhp / (max || 1)));
          const delay = reduced ? 0 : Math.min(i * 0.035, 0.35);
          const missing = r.headcount - r.covered;
          return (
            <motion.div
              key={r.key}
              title={`${r.name}: ${moneyWhole(r.hourlyPhp)}/hr estimated across ${r.covered} of ${r.headcount} people`}
              className="grid grid-cols-[minmax(0,9.5rem)_1fr_auto] items-center gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-900/60"
              initial={reduced ? false : { opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.3, delay, ease: EASE }}
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-zinc-800 dark:text-zinc-100">{r.name}</div>
                <div className="truncate text-[10px] text-zinc-400">
                  {r.headcount} {r.headcount === 1 ? 'person' : 'people'}
                  {missing > 0 ? ` · ${missing} no rate` : ''}
                </div>
              </div>
              <div className="h-2.5 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800/80">
                <motion.div
                  className={`h-full rounded-full ${slot.swatch}`}
                  style={{ transformOrigin: 'left' }}
                  initial={reduced ? false : { scaleX: 0 }}
                  animate={{ scaleX: frac }}
                  transition={{ duration: 0.55, delay, ease: EASE }}
                />
              </div>
              <div className="text-right">
                <div className="tabular-nums text-sm font-semibold tracking-tight text-zinc-900 dark:text-white">
                  {moneyWhole(r.hourlyPhp)}
                  <span className="text-[10px] font-normal text-zinc-400">/hr</span>
                </div>
                <div className="text-[10px] tabular-nums text-zinc-400">{(r.share * 100).toFixed(1)}%</div>
              </div>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Secondary band -- quiet cards carried over from the old board.
// ---------------------------------------------------------------------------

function QuietCard({
  icon: Icon,
  label,
  children,
}: {
  icon: typeof Wallet;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex items-center gap-1.5">
        <Icon className="h-3.5 w-3.5 text-zinc-400" />
        <KpiLabel>{label}</KpiLabel>
      </div>
      <div className="mt-2">{children}</div>
    </div>
  );
}

function SecondaryBand({ o, animate }: { o: CatalogOverview; animate: boolean }) {
  const { coverage, ot } = o;
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <QuietCard icon={LayoutGrid} label="Base-rate coverage">
        <StatValue>
          <CountInt value={coverage.deptsWithBase} animate={animate} />
          <span className="text-zinc-400">/{coverage.deptsTotal}</span>
        </StatValue>
        <div className="mt-2 flex gap-0.5">
          {Array.from({ length: coverage.deptsTotal }).map((_, i) => (
            <span
              key={i}
              className={`h-1 flex-1 rounded-full ${
                i < coverage.deptsWithBase ? 'bg-orange-500 dark:bg-blue-500' : 'bg-zinc-200 dark:bg-zinc-800'
              }`}
            />
          ))}
        </div>
        <StatSub>
          {coverage.peopleWithRate} individual rate{coverage.peopleWithRate === 1 ? '' : 's'} on top
        </StatSub>
      </QuietCard>

      <QuietCard icon={Award} label="Bonus library">
        <div className="flex items-center gap-2">
          <StatValue>
            <CountInt value={coverage.activeBonuses} animate={animate} />
          </StatValue>
          <span className="rounded-full bg-orange-100 px-1.5 py-0.5 text-[10px] font-bold text-orange-700 dark:bg-blue-950/60 dark:text-blue-200">
            +2 system
          </span>
        </div>
        <StatSub>
          {coverage.totalAssignments} assignment{coverage.totalAssignments === 1 ? '' : 's'} ·{' '}
          {coverage.formulaCount} formula-based
          {coverage.starredBonuses > 0 ? ` · ${coverage.starredBonuses} starred` : ''}
        </StatSub>
      </QuietCard>

      <QuietCard icon={Timer} label="Overtime premium">
        {ot.avgMultiplier != null ? (
          <>
            <div className="flex items-baseline gap-1.5">
              <StatValue>
                ×<CountDecimal value={ot.avgMultiplier} animate={animate} />
              </StatValue>
              <span className="text-xs text-zinc-400">avg multiplier</span>
            </div>
            <StatSub>
              {ot.highest
                ? `Highest ${money(ot.highest.rateNative, ot.highest.currency)}/hr · ${ot.highest.label}`
                : 'Applied to overtime hours'}
            </StatSub>
          </>
        ) : (
          <>
            <StatValue>
              <span className="text-zinc-400">—</span>
            </StatValue>
            <StatSub>No overtime rates set yet</StatSub>
          </>
        )}
      </QuietCard>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Top-level Overview tab
// ---------------------------------------------------------------------------

export default function PaymentCatalogOverview({
  payStructures,
  bonuses,
  assignments,
  systemBonuses,
  roster,
  fx,
}: {
  payStructures: PayStructure[];
  bonuses: BonusDef[];
  assignments: BonusAssignment[];
  systemBonuses: SystemBonus[];
  roster: RosterEntry[];
  fx: FxRates;
}) {
  const reducedRaw = useReducedMotion();
  const reduced = !!reducedRaw;

  const o = useMemo(
    () => computeCatalogOverview({ payStructures, bonuses, assignments, systemBonuses, roster, fx }),
    [payStructures, bonuses, assignments, systemBonuses, roster, fx],
  );

  const topDept = o.topDepartments[0] ?? null;
  const topPerson = o.topPeople[0] ?? null;
  const { spend } = o;
  const hasFxMix = o.currencyMix.some((m) => m.currency !== 'PHP' && m.count > 0);
  const animate = !reduced;

  if (o.isEmpty) {
    return (
      <div className="flex h-full min-h-[400px] flex-col items-center justify-center px-6 text-center">
        <Wallet className="mb-3 h-10 w-10 text-zinc-300 dark:text-zinc-600" />
        <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Nothing to show yet</p>
        <p className="mt-1 max-w-md text-xs text-zinc-500">
          Set department or individual rates in Pay Structure and create a few bonuses — the overview dashboard will
          fill in automatically.
        </p>
      </div>
    );
  }

  /** Section entrance: fade + rise once, staggered top to bottom. */
  const section = (delay: number) => ({
    initial: reduced ? false : ({ opacity: 0, y: 10 } as const),
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.4, delay: reduced ? 0 : delay, ease: EASE },
  });

  return (
    <div className="mx-auto w-full max-w-[1180px] px-4 py-5 sm:px-6 sm:py-6">
      {/* Masthead */}
      <div className="mb-4 flex items-center justify-between gap-3 border-b border-zinc-200/70 pb-3 dark:border-zinc-800">
        <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-400">
          Payment Catalog · Summary
        </span>
        <span className="hidden items-center gap-2 text-[11px] tabular-nums text-zinc-400 sm:inline-flex">
          $1 = {money(fx.usdToPhp, 'PHP')} · {money(fx.usdToCop, 'COP')}
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-70" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
          </span>
        </span>
      </div>

      {/* KPI band (gradient cards) */}
      <motion.div {...section(0)} className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard tone="accent" icon={Wallet} label="Est. hourly payroll">
          <StatValue>
            <CountMoneyWhole value={spend.totalHourlyPhp} animate={animate} />
            <span className="text-sm font-medium text-zinc-400">/hr</span>
          </StatValue>
          <StatSub>
            {spend.peopleCovered} of {spend.rosterTotal} people with a set rate
          </StatSub>
        </StatCard>

        <StatCard tone="violet" icon={Building2} label="Highest-paid department">
          <StatValue>
            {topDept ? <CountMoney value={topDept.regularNative} currency={topDept.currency} animate={animate} /> : '—'}
          </StatValue>
          <StatSub>
            {topDept
              ? `${topDept.name}${topDept.currency !== 'PHP' ? ` · ~${money(topDept.regularPhp, 'PHP')}/hr` : '/hr base rate'}`
              : 'No department base rate yet'}
          </StatSub>
        </StatCard>

        <StatCard tone="amber" icon={Crown} label="Top earner">
          <StatValue>
            {topPerson ? (
              <CountMoney value={topPerson.regularNative} currency={topPerson.currency} animate={animate} />
            ) : (
              '—'
            )}
          </StatValue>
          <StatSub>{topPerson ? `${topPerson.name} · ${topPerson.deptName}` : 'No individual rates yet'}</StatSub>
        </StatCard>

        <SpotlightCard pool={o.spotlight} reduced={reduced} />
      </motion.div>

      {/* Charts: pay-share donut + per-department bars */}
      {spend.rows.length > 0 ? (
        <motion.div
          {...section(0.08)}
          className="mt-4 grid items-stretch gap-4 lg:grid-cols-[minmax(0,24rem)_1fr]"
        >
          <PayShareCard
            rows={spend.rows}
            totalPhp={spend.totalHourlyPhp}
            hasFxMix={hasFxMix}
            reduced={reduced}
          />
          <DeptBarsCard rows={spend.rows} reduced={reduced} />
        </motion.div>
      ) : (
        <motion.div
          {...section(0.08)}
          className="mt-4 flex min-h-[220px] flex-col items-center justify-center rounded-2xl border border-zinc-200 bg-white p-6 text-center shadow-sm dark:border-zinc-800 dark:bg-zinc-950"
        >
          <PieChart className="mb-3 h-8 w-8 text-zinc-300 dark:text-zinc-600" />
          <p className="max-w-sm text-sm text-zinc-400">
            No pay data to chart yet — set department base rates (or individual rates) in Pay Structure and the pay
            mix will appear here.
          </p>
        </motion.div>
      )}

      {/* Secondary band */}
      <motion.div {...section(0.16)} className="mt-4">
        <SecondaryBand o={o} animate={animate} />
      </motion.div>
    </div>
  );
}
