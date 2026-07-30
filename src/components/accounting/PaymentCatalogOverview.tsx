'use client';

// Payment Catalog -- Overview tab ("Live Standings").
//
// A live, auto-rotating compensation command board. On large screens five
// pinned KPI cards form a left rail that answers "who is the highest paid" at a
// glance and never moves; beside it (to the right) a single stage card rotates
// every 15 seconds through six leaderboard "scenes" (Top 10 departments, Top 10
// people, a podium, most valuable bonuses, bonus reach, and a system-bonus / pay
// map). On mobile the rail collapses to a 2x2 grid above the stage. A hairline
// shot-clock rides the top edge of the stage as a literal 15-second countdown --
// it freezes on hover and resumes mid-sweep.
//
// Design notes that matter for future edits:
//   - ALL motion is transform/opacity only; big figures animate in once and
//     then sit perfectly still (no perpetual scale -> no text blur).
//   - Cross-currency RANKING uses a PHP-equivalent; figures DISPLAY native with
//     a faint "~PHP" subscript so the ordering stays honest.
//   - Light = orange accent on warm off-white; dark = blue accent on ink.
//     Emerald is reserved for "reward / enabled" meaning only.

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  motion,
  AnimatePresence,
  useMotionValue,
  useReducedMotion,
} from 'motion/react';
import {
  ChevronLeft,
  ChevronRight,
  Building2,
  User,
  Users,
  Award,
  Star,
  Crown,
  Medal,
  Trophy,
  Sparkles,
  Wallet,
  Pause,
  Coins,
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
  OVERVIEW_DEPARTMENTS,
  type CatalogOverview,
  type DeptPayRow,
  type PersonPayRow,
  type BonusValueRow,
  type BonusReachRow,
  type CurrencyMixRow,
  type SystemBonusRow,
} from '@/lib/payment-catalog/overview-metrics';

/** Shared easing -- matches the catalog's tab transition. */
const EASE = [0.22, 1, 0.36, 1] as const;

/** Number string (no symbol) in the currency's locale, 2 decimals (COP 0). */
function amountDigits(n: number, currency: PayCurrency): string {
  const locale = CURRENCY_LOCALE[currency] ?? 'en-PH';
  const digits = currency === 'COP' ? 0 : 2;
  return n.toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** Full money string with currency symbol, always 2 decimals (COP 0). */
function money(n: number, currency: PayCurrency = 'PHP'): string {
  return `${CURRENCY_SYMBOL[currency]}${amountDigits(n, currency)}`;
}

type RosterEntry = { email: string; name: string; department: string };

// ---------------------------------------------------------------------------
// Count-up: interpolate a displayed number on data change / scene-enter. Used
// only where it reads as "instrumented" (KPI strip + the system scene), never
// on rotating hero figures, and never by scaling text.
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

function CountDecimal({ value, animate, digits = 2 }: { value: number; animate: boolean; digits?: number }) {
  const v = useCountUp(value, animate);
  return <>{v.toFixed(digits)}</>;
}

// ---------------------------------------------------------------------------
// Small shared primitives
// ---------------------------------------------------------------------------

function CurrencyTag({ currency }: { currency: PayCurrency }) {
  if (currency === 'PHP') return null;
  return (
    <span className="rounded bg-zinc-100 px-1 py-0.5 text-[10px] font-bold uppercase tracking-wide text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
      {currency}
    </span>
  );
}

function RankChip({ rank }: { rank: number }) {
  const ring =
    rank === 1
      ? 'ring-2 ring-amber-400'
      : rank === 2
        ? 'ring-2 ring-zinc-300 dark:ring-zinc-500'
        : rank === 3
          ? 'ring-2 ring-amber-700/70'
          : '';
  return (
    <span
      className={`inline-flex h-7 w-7 items-center justify-center rounded-full text-lg font-semibold tabular-nums text-zinc-300 dark:text-zinc-600 ${ring}`}
    >
      {rank}
    </span>
  );
}

/** A single grow-in fill bar (scaleX, transform-only). */
function Bar({
  frac,
  reward,
  delay,
  reduced,
}: {
  frac: number;
  reward?: boolean;
  delay: number;
  reduced: boolean;
}) {
  const color = reward ? 'bg-emerald-500' : 'bg-orange-500 dark:bg-blue-500';
  const target = Math.max(0.025, Math.min(1, Number.isFinite(frac) ? frac : 0));
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800/80">
      <motion.div
        className={`h-full rounded-full ${color}`}
        style={{ transformOrigin: 'left' }}
        initial={reduced ? false : { scaleX: 0 }}
        animate={{ scaleX: target }}
        transition={{ duration: 0.55, delay, ease: EASE }}
      />
    </div>
  );
}

/** The oversized #1 figure each leaderboard "lifts out". Static once shown. */
function Hero({
  caption,
  symbol,
  digits,
  suffix,
  sub,
  reduced,
}: {
  caption: string;
  symbol: string;
  digits: string;
  suffix?: string;
  sub: string;
  reduced: boolean;
}) {
  return (
    <motion.div
      initial={reduced ? false : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: reduced ? 0 : 0.08, ease: EASE }}
    >
      <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-zinc-400">
        {caption}
      </div>
      <div className="mt-1.5 flex items-baseline gap-1">
        <span className="text-xl font-medium text-zinc-400">{symbol}</span>
        <span className="text-4xl font-semibold tracking-tight tabular-nums text-zinc-900 sm:text-5xl dark:text-white">
          {digits}
        </span>
        {suffix && <span className="text-base font-medium text-zinc-400">{suffix}</span>}
      </div>
      <div className="mt-1.5 text-sm text-zinc-500 dark:text-zinc-400">{sub}</div>
    </motion.div>
  );
}

/** One leaderboard row (rank, name + bar, native value + ~PHP subscript). */
function LeaderRow({
  rank,
  name,
  micro,
  valueText,
  subText,
  currency,
  frac,
  reward,
  index,
  reduced,
}: {
  rank: number;
  name: string;
  micro?: string;
  valueText: string;
  subText?: string;
  currency: PayCurrency;
  frac: number;
  reward?: boolean;
  index: number;
  reduced: boolean;
}) {
  const delay = reduced ? 0 : Math.min(index * 0.04, 0.28);
  return (
    <motion.div
      className="grid grid-cols-[2rem_1fr_auto] items-center gap-3 py-1.5"
      initial={reduced ? false : { opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.3, delay, ease: EASE }}
    >
      <div className="flex justify-center">
        <RankChip rank={rank} />
      </div>
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium text-zinc-800 dark:text-zinc-100">{name}</span>
          <CurrencyTag currency={currency} />
        </div>
        <div className="mt-1">
          <Bar frac={frac} reward={reward} delay={delay} reduced={reduced} />
        </div>
        {micro && <div className="mt-0.5 truncate text-[11px] text-zinc-400">{micro}</div>}
      </div>
      <div className="text-right">
        <div className="tabular-nums text-sm font-semibold tracking-tight text-zinc-900 dark:text-white">
          {valueText}
        </div>
        {subText && <div className="text-[10px] tabular-nums text-zinc-400">{subText}</div>}
      </div>
    </motion.div>
  );
}

function SceneEmpty({ icon: Icon, text }: { icon: typeof Wallet; text: string }) {
  return (
    <div className="flex min-h-[260px] flex-col items-center justify-center text-center">
      <Icon className="mb-3 h-8 w-8 text-zinc-300 dark:text-zinc-600" />
      <p className="max-w-xs text-sm text-zinc-400">{text}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Currency mix donut (the only chart on the board -- currency is categorical).
// ---------------------------------------------------------------------------

const CUR_BG: Record<PayCurrency, string> = {
  PHP: 'bg-zinc-700 dark:bg-zinc-300',
  USD: 'bg-orange-500 dark:bg-blue-500',
  COP: 'bg-amber-500 dark:bg-amber-400',
};
const CUR_STROKE: Record<PayCurrency, string> = {
  PHP: 'stroke-zinc-700 dark:stroke-zinc-300',
  USD: 'stroke-orange-500 dark:stroke-blue-500',
  COP: 'stroke-amber-500 dark:stroke-amber-400',
};

function CurrencyDonut({ mix }: { mix: CurrencyMixRow[] }) {
  const total = mix.reduce((s, m) => s + m.count, 0);
  const R = 30;
  const C = 2 * Math.PI * R;
  let offset = 0;
  return (
    <svg viewBox="0 0 80 80" className="h-20 w-20 shrink-0 -rotate-90">
      <circle cx={40} cy={40} r={R} fill="none" strokeWidth={11} className="stroke-zinc-100 dark:stroke-zinc-800" />
      {total > 0 &&
        mix.map((m) => {
          const len = (m.count / total) * C;
          const el = (
            <circle
              key={m.currency}
              cx={40}
              cy={40}
              r={R}
              fill="none"
              strokeWidth={11}
              strokeLinecap="butt"
              className={CUR_STROKE[m.currency]}
              strokeDasharray={`${len} ${C - len}`}
              strokeDashoffset={-offset}
            />
          );
          offset += len;
          return el;
        })}
    </svg>
  );
}

function DeptDotGrid({ deptKeys, appliesToAll }: { deptKeys: string[]; appliesToAll: boolean }) {
  return (
    <div className="mt-3 grid grid-cols-9 gap-1">
      {OVERVIEW_DEPARTMENTS.map((d) => {
        const on = appliesToAll || deptKeys.includes(d.key);
        return (
          <span
            key={d.key}
            title={d.name}
            className={`h-2 w-2 rounded-full ${on ? 'bg-emerald-500' : 'bg-zinc-200 dark:bg-zinc-700'}`}
          />
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------

function DepartmentsScene({ o, reduced }: { o: CatalogOverview; reduced: boolean }) {
  const rows = o.topDepartments;
  if (rows.length === 0) {
    return <SceneEmpty icon={Building2} text="No department base rates set yet. Add rates in Pay Structure to rank departments here." />;
  }
  const top = rows[0];
  const denom = top.regularPhp || 1;
  return (
    <div className="grid gap-5 sm:grid-cols-[minmax(0,15rem)_1fr] sm:gap-8">
      <div className="flex flex-col justify-center">
        <Hero
          caption="Highest base rate"
          symbol={CURRENCY_SYMBOL[top.currency]}
          digits={amountDigits(top.regularNative, top.currency)}
          suffix="/hr"
          sub={`${top.name} leads`}
          reduced={reduced}
        />
        {o.coverage.deptsWithoutBase > 0 && (
          <p className="mt-4 text-[11px] leading-relaxed text-zinc-400">
            {o.coverage.deptsWithoutBase} of {o.coverage.deptsTotal} departments have no base rate set yet.
          </p>
        )}
      </div>
      <div>
        {rows.map((d: DeptPayRow, i) => (
          <LeaderRow
            key={d.key}
            rank={i + 1}
            name={d.name}
            micro={d.otNative != null ? `OT ${money(d.otNative, d.currency)}/hr` : `${d.peopleCount} individual rate${d.peopleCount === 1 ? '' : 's'}`}
            valueText={`${money(d.regularNative, d.currency)}/hr`}
            subText={d.currency !== 'PHP' ? `~${money(d.regularPhp, 'PHP')}/hr` : undefined}
            currency={d.currency}
            frac={d.regularPhp / denom}
            index={i}
            reduced={reduced}
          />
        ))}
      </div>
    </div>
  );
}

function PeopleScene({ o, reduced }: { o: CatalogOverview; reduced: boolean }) {
  const rows = o.topPeople;
  if (rows.length === 0) {
    return <SceneEmpty icon={User} text="No individual pay structures set yet. Add per-person rates in Pay Structure to rank top earners here." />;
  }
  const top = rows[0];
  const denom = top.regularPhp || 1;
  return (
    <div className="grid gap-5 sm:grid-cols-[minmax(0,15rem)_1fr] sm:gap-8">
      <div className="flex flex-col justify-center">
        <Hero
          caption="Top earner"
          symbol={CURRENCY_SYMBOL[top.currency]}
          digits={amountDigits(top.regularNative, top.currency)}
          suffix="/hr"
          sub={`${top.name} · ${top.deptName}`}
          reduced={reduced}
        />
      </div>
      <div>
        {rows.map((p: PersonPayRow, i) => (
          <LeaderRow
            key={p.email}
            rank={i + 1}
            name={p.name}
            micro={p.deptName}
            valueText={`${money(p.regularNative, p.currency)}/hr`}
            subText={p.currency !== 'PHP' ? `~${money(p.regularPhp, 'PHP')}/hr` : undefined}
            currency={p.currency}
            frac={p.regularPhp / denom}
            index={i}
            reduced={reduced}
          />
        ))}
      </div>
    </div>
  );
}

function PodiumScene({ o, reduced }: { o: CatalogOverview; reduced: boolean }) {
  const rows = o.topPeople;
  if (rows.length === 0) {
    return <SceneEmpty icon={Trophy} text="No individual pay structures set yet. The podium appears once people have custom rates." />;
  }
  const top3 = rows.slice(0, 3);
  const rest = rows.slice(3, 10);
  // Render order on the podium floor: 2nd, 1st, 3rd (center tallest).
  const slots = [top3[1], top3[0], top3[2]];
  const plinth = ['h-16', 'h-24', 'h-12'];
  const plinthColor = [
    'bg-zinc-200 dark:bg-zinc-700',
    'bg-amber-300/80 dark:bg-amber-500/40',
    'bg-amber-700/30 dark:bg-amber-800/40',
  ];
  const MedalIcon = [Medal, Crown, Trophy];
  const medalColor = ['text-zinc-400', 'text-amber-400', 'text-amber-700'];
  return (
    <div>
      <div className="flex items-end justify-center gap-3 sm:gap-6">
        {slots.map((p, idx) => {
          if (!p) return <div key={idx} className="w-20 sm:w-28" />;
          const rank = idx === 0 ? 2 : idx === 1 ? 1 : 3;
          const Icon = MedalIcon[idx];
          return (
            <div key={p.email} className="flex w-20 flex-col items-center sm:w-28">
              <motion.div
                className="mb-2 flex flex-col items-center text-center"
                initial={reduced ? false : { opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.35, delay: reduced ? 0 : 0.12, ease: EASE }}
              >
                <Icon className={`mb-1 h-5 w-5 ${medalColor[idx]}`} />
                <div className="max-w-full truncate text-xs font-semibold text-zinc-800 dark:text-zinc-100" title={p.name}>
                  {p.name}
                </div>
                <div className="tabular-nums text-sm font-semibold tracking-tight text-zinc-900 dark:text-white">
                  {money(p.regularNative, p.currency)}
                </div>
                <div className="text-[10px] text-zinc-400">{p.deptName}</div>
              </motion.div>
              <div className={`relative w-full ${plinth[idx]}`}>
                <motion.div
                  className={`absolute inset-0 rounded-t-md ${plinthColor[idx]}`}
                  style={{ transformOrigin: 'bottom' }}
                  initial={reduced ? false : { scaleY: 0 }}
                  animate={{ scaleY: 1 }}
                  transition={{ duration: 0.5, ease: EASE }}
                />
                {/* Rank glyph is a sibling, not a child of the scaled block, so
                    it never distorts during the plinth grow-in. */}
                <motion.div
                  className="absolute inset-x-0 top-0 pt-1 text-center text-sm font-bold tabular-nums text-zinc-500 dark:text-zinc-300"
                  initial={reduced ? false : { opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.5, ease: EASE }}
                >
                  {rank}
                </motion.div>
              </div>
            </div>
          );
        })}
      </div>
      {rest.length > 0 && (
        <div className="mx-auto mt-6 max-w-2xl border-t border-zinc-100 pt-3 dark:border-zinc-800">
          {rest.map((p, i) => (
            <LeaderRow
              key={p.email}
              rank={i + 4}
              name={p.name}
              micro={p.deptName}
              valueText={`${money(p.regularNative, p.currency)}/hr`}
              subText={p.currency !== 'PHP' ? `~${money(p.regularPhp, 'PHP')}/hr` : undefined}
              currency={p.currency}
              frac={p.regularPhp / (rows[0].regularPhp || 1)}
              index={i}
              reduced={reduced}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function BonusesScene({ o, reduced }: { o: CatalogOverview; reduced: boolean }) {
  const rows = o.topBonuses;
  const formula = o.coverage.formulaCount;
  if (rows.length === 0) {
    return (
      <SceneEmpty
        icon={Sparkles}
        text={
          formula > 0
            ? `No flat-amount bonuses yet — ${formula} formula-based bonus${formula === 1 ? '' : 'es'} compute their value at payout.`
            : 'No bonuses in the library yet. Create bonuses to rank them here.'
        }
      />
    );
  }
  const top = rows[0];
  const denom = top.amountPhp || 1;
  return (
    <div className="grid gap-5 sm:grid-cols-[minmax(0,15rem)_1fr] sm:gap-8">
      <div className="flex flex-col justify-center">
        <Hero
          caption="Most valuable bonus"
          symbol={CURRENCY_SYMBOL[top.currency]}
          digits={amountDigits(top.amountNative, top.currency)}
          sub={top.name}
          reduced={reduced}
        />
        {formula > 0 && (
          <p className="mt-4 text-[11px] leading-relaxed text-zinc-400">
            + {formula} formula-based bonus{formula === 1 ? '' : 'es'} (computed at payout).
          </p>
        )}
      </div>
      <div>
        {rows.map((b: BonusValueRow, i) => (
          <LeaderRow
            key={b.id}
            rank={i + 1}
            name={b.starred ? `★ ${b.name}` : b.name}
            valueText={money(b.amountNative, b.currency)}
            subText={b.currency !== 'PHP' ? `~${money(b.amountPhp, 'PHP')}` : undefined}
            currency={b.currency}
            frac={b.amountPhp / denom}
            reward
            index={i}
            reduced={reduced}
          />
        ))}
      </div>
    </div>
  );
}

function ReachScene({ o, reduced }: { o: CatalogOverview; reduced: boolean }) {
  const rows = o.bonusReach;
  if (rows.length === 0) {
    return <SceneEmpty icon={Users} text="No bonuses have been assigned yet. Assign library bonuses to departments or people to see their reach." />;
  }
  const maxTotal = rows[0].total || 1;
  return (
    <div>
      <div className="mb-3 flex items-center gap-4 text-[11px] text-zinc-400">
        <span className="inline-flex items-center gap-1">
          <span className="h-2 w-2 rounded-full bg-orange-500 dark:bg-blue-500" /> Departments
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="h-2 w-2 rounded-full bg-emerald-500" /> Individuals
        </span>
      </div>
      <div className="space-y-3">
        {rows.map((b: BonusReachRow, i) => {
          const delay = reduced ? 0 : Math.min(i * 0.04, 0.28);
          const deptPct = (b.deptCount / maxTotal) * 100;
          const peoplePct = (b.peopleCount / maxTotal) * 100;
          return (
            <motion.div
              key={b.id}
              initial={reduced ? false : { opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.3, delay, ease: EASE }}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate text-sm font-medium text-zinc-800 dark:text-zinc-100">{b.name}</span>
                  {b.sharedTeam && (
                    <span title="Team effort" className="inline-flex shrink-0 items-center text-emerald-600 dark:text-emerald-400">
                      <Users className="h-3.5 w-3.5" />
                    </span>
                  )}
                </div>
                <div className="shrink-0 text-right text-[11px] tabular-nums text-zinc-400">
                  <span className="inline-flex items-center gap-1">
                    <Building2 className="h-3 w-3" />
                    {b.deptCount}
                  </span>
                  <span className="mx-1">·</span>
                  <span className="inline-flex items-center gap-1">
                    <User className="h-3 w-3" />
                    {b.peopleCount}
                  </span>
                  {b.excludedCount > 0 && <span className="ml-1 text-zinc-300 dark:text-zinc-600">−{b.excludedCount}</span>}
                </div>
              </div>
              <div className="mt-1 flex h-2 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800/80">
                <motion.div
                  className="h-full bg-orange-500 dark:bg-blue-500"
                  initial={reduced ? false : { width: 0 }}
                  animate={{ width: `${deptPct}%` }}
                  transition={{ duration: 0.55, delay, ease: EASE }}
                />
                <motion.div
                  className="h-full bg-emerald-500"
                  initial={reduced ? false : { width: 0 }}
                  animate={{ width: `${peoplePct}%` }}
                  transition={{ duration: 0.55, delay: delay + 0.05, ease: EASE }}
                />
              </div>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}

function SystemTile({ row, animate }: { row: SystemBonusRow; animate: boolean }) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-xs font-medium text-zinc-500">
          <Award className="h-4 w-4 text-orange-500 dark:text-blue-400" />
          {row.label}
        </div>
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
            row.enabled
              ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
              : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400'
          }`}
        >
          {row.enabled ? 'Enabled' : 'Disabled'}
        </span>
      </div>
      <div className="mt-2 text-3xl font-semibold tracking-tight tabular-nums text-zinc-900 dark:text-white">
        <CountMoney value={row.amountNative} currency={row.currency} animate={animate} />
      </div>
      <div className="mt-1 text-xs text-zinc-400">
        {row.appliesToAll ? 'Paid to all departments' : `Paid to ${row.deptCount} of ${OVERVIEW_DEPARTMENTS.length} departments`}
      </div>
      <DeptDotGrid deptKeys={row.deptKeys} appliesToAll={row.appliesToAll} />
    </div>
  );
}

function SystemScene({ o, reduced }: { o: CatalogOverview; reduced: boolean }) {
  const animate = !reduced;
  // Built-ins first (pab, tech), then any custom currency variants.
  const [pab, tech, ...customRows] = o.systemBonuses;
  const { ot, currencyMix } = o;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="space-y-4">
        {pab && <SystemTile row={pab} animate={animate} />}
        {tech && <SystemTile row={tech} animate={animate} />}
        {customRows.map((row) => (
          <SystemTile key={row.code} row={row} animate={animate} />
        ))}
      </div>
      <div className="space-y-4">
        <div className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
          <div className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-zinc-500">
            <Coins className="h-3.5 w-3.5" /> Currency mix
          </div>
          <div className="mt-2 flex items-center gap-4">
            <CurrencyDonut mix={currencyMix} />
            <div className="space-y-1.5 text-xs">
              {currencyMix.length === 0 ? (
                <div className="text-zinc-400">No pay structures yet</div>
              ) : (
                currencyMix.map((m) => (
                  <div key={m.currency} className="flex items-center gap-2">
                    <span className={`h-2.5 w-2.5 rounded-full ${CUR_BG[m.currency]}`} />
                    <span className="w-9 font-medium text-zinc-700 dark:text-zinc-300">{m.currency}</span>
                    <span className="tabular-nums text-zinc-400">{m.count}</span>
                    <span className="tabular-nums text-zinc-300 dark:text-zinc-600">{Math.round(m.share * 100)}%</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
        <div className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
          <div className="text-[10.5px] font-semibold uppercase tracking-wide text-zinc-500">Overtime premium</div>
          {ot.avgMultiplier != null ? (
            <>
              <div className="mt-1 flex items-baseline gap-1.5">
                <span className="text-3xl font-semibold tracking-tight tabular-nums text-zinc-900 dark:text-white">
                  ×<CountDecimal value={ot.avgMultiplier} animate={animate} />
                </span>
                <span className="text-xs text-zinc-400">avg multiplier</span>
              </div>
              {ot.highest && (
                <div className="mt-1 text-xs text-zinc-400">
                  Highest OT {money(ot.highest.rateNative, ot.highest.currency)}/hr · {ot.highest.label}
                </div>
              )}
            </>
          ) : (
            <div className="mt-1 text-sm text-zinc-400">OT not configured.</div>
          )}
        </div>
      </div>
    </div>
  );
}

const SCENES = [
  { id: 'departments', title: 'Top 10 Departments by Base Rate' },
  { id: 'people', title: 'Top 10 Highest-Paid People' },
  { id: 'podium', title: 'Top Earners — Podium' },
  { id: 'bonuses', title: 'Most Valuable Bonuses' },
  { id: 'reach', title: 'Bonus Reach — Most Widely Assigned' },
  { id: 'system', title: 'System Bonuses & Pay Map' },
] as const;
const TOTAL = SCENES.length;
const DURATION = 15000;

// ---------------------------------------------------------------------------
// KPI band (Region A) -- always visible, never rotates.
// ---------------------------------------------------------------------------

function KpiCard({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={`rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950 ${className}`}
    >
      {children}
    </div>
  );
}

function KpiLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10.5px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
      {children}
    </div>
  );
}

function KpiBand({ o, animate }: { o: CatalogOverview; animate: boolean }) {
  const topDept = o.topDepartments[0] ?? null;
  const topPerson = o.topPeople[0] ?? null;
  const { coverage, ot } = o;
  // Left rail on large screens (2-col grid on mobile). Each card is an equal
  // flex-1 slice with its content vertically centered, so the five cards fill
  // the rail's full height with no leftover gaps next to the stage.
  const cardFill = 'lg:flex lg:flex-1 lg:flex-col lg:justify-center';
  return (
    <div className="grid grid-cols-2 gap-3 lg:flex lg:h-full lg:flex-col lg:gap-3">
      <KpiCard className={cardFill}>
        <KpiLabel>Highest-paid department</KpiLabel>
        <div className="mt-1 text-2xl font-semibold tracking-tight tabular-nums text-zinc-900 sm:text-[26px] dark:text-white">
          {topDept ? <CountMoney value={topDept.regularNative} currency={topDept.currency} animate={animate} /> : '—'}
        </div>
        <div className="mt-1 truncate text-xs text-zinc-400">
          {topDept
            ? `${topDept.name}${topDept.currency !== 'PHP' ? ` · ~${money(topDept.regularPhp, 'PHP')}/hr` : '/hr'}`
            : 'No department base rate yet'}
        </div>
      </KpiCard>

      <KpiCard className={cardFill}>
        <KpiLabel>Top earner</KpiLabel>
        <div className="mt-1 text-2xl font-semibold tracking-tight tabular-nums text-zinc-900 sm:text-[26px] dark:text-white">
          {topPerson ? <CountMoney value={topPerson.regularNative} currency={topPerson.currency} animate={animate} /> : '—'}
        </div>
        <div className="mt-1 truncate text-xs text-zinc-400">
          {topPerson ? `${topPerson.name} · ${topPerson.deptName}` : 'No individual rates yet'}
        </div>
      </KpiCard>

      <KpiCard className={cardFill}>
        <KpiLabel>Base-rate coverage</KpiLabel>
        <div className="mt-1 text-2xl font-semibold tracking-tight tabular-nums text-zinc-900 sm:text-[26px] dark:text-white">
          <CountInt value={coverage.deptsWithBase} animate={animate} />
          <span className="text-zinc-400">/{coverage.deptsTotal}</span>
        </div>
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
      </KpiCard>

      <KpiCard className={cardFill}>
        <KpiLabel>Bonus library</KpiLabel>
        <div className="mt-1 flex items-center gap-2">
          <div className="text-2xl font-semibold tracking-tight tabular-nums text-zinc-900 sm:text-[26px] dark:text-white">
            <CountInt value={coverage.activeBonuses} animate={animate} />
          </div>
          <span className="rounded-full bg-orange-100 px-1.5 py-0.5 text-[10px] font-bold text-orange-700 dark:bg-blue-950/60 dark:text-blue-200">
            +2 system
          </span>
        </div>
        <div className="mt-1 truncate text-xs text-zinc-400">
          {coverage.totalAssignments} assignment{coverage.totalAssignments === 1 ? '' : 's'} · {coverage.formulaCount} formula-based
          {coverage.starredBonuses > 0 ? ` · ${coverage.starredBonuses} starred` : ''}
        </div>
      </KpiCard>

      {/* col-span-2 keeps the odd 5th card full-width on the 2-col mobile grid
          (grid-column is ignored once the rail switches to flex at lg). */}
      <KpiCard className={`col-span-2 ${cardFill}`}>
        <KpiLabel>Overtime premium</KpiLabel>
        {ot.avgMultiplier != null ? (
          <>
            <div className="mt-1 flex items-baseline gap-1.5">
              <div className="text-2xl font-semibold tracking-tight tabular-nums text-zinc-900 sm:text-[26px] dark:text-white">
                ×<CountDecimal value={ot.avgMultiplier} animate={animate} />
              </div>
              <span className="text-xs text-zinc-400">avg multiplier</span>
            </div>
            <div className="mt-1 truncate text-xs text-zinc-400">
              {ot.highest
                ? `Highest ${money(ot.highest.rateNative, ot.highest.currency)}/hr · ${ot.highest.label}`
                : 'Applied to overtime hours'}
            </div>
          </>
        ) : (
          <>
            <div className="mt-1 text-2xl font-semibold tracking-tight tabular-nums text-zinc-400 sm:text-[26px]">
              —
            </div>
            <div className="mt-1 truncate text-xs text-zinc-400">No overtime rates set yet</div>
          </>
        )}
      </KpiCard>
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
  const uid = useId();

  const o = useMemo(
    () => computeCatalogOverview({ payStructures, bonuses, assignments, systemBonuses, roster, fx }),
    [payStructures, bonuses, assignments, systemBonuses, roster, fx],
  );

  const [sceneIndex, setSceneIndex] = useState(0);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [hidden, setHidden] = useState(false);
  // Pause on hover, keyboard focus, or a backgrounded tab. Focus is tracked
  // separately from hover so a click that briefly focuses a nav control (then
  // blurs) never leaves the board stuck paused on an unattended wall display.
  const paused = hovered || focused || hidden;

  const progress = useMotionValue(0);
  const startRef = useRef(0);
  const elapsedRef = useRef(0);
  const pausedRef = useRef(false);
  const rafRef = useRef(0);
  const tickRef = useRef<(now: number) => void>(() => {});

  // Single rAF loop owns the shot-clock progress + auto-advance. It parks itself
  // while paused (no idle frames); the pause effect re-arms it on resume.
  useEffect(() => {
    startRef.current = performance.now();
    elapsedRef.current = 0;
    progress.set(0);
    const tick = (now: number) => {
      const elapsed = now - startRef.current;
      const p = Math.min(1, elapsed / DURATION);
      progress.set(p);
      if (p >= 1) {
        setSceneIndex((i) => (i + 1) % TOTAL);
        startRef.current = now;
        elapsedRef.current = 0;
        progress.set(0);
      }
      if (!pausedRef.current) rafRef.current = requestAnimationFrame(tick);
    };
    tickRef.current = tick;
    cancelAnimationFrame(rafRef.current);
    if (!pausedRef.current) rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [progress]);

  // Pause freezes the sweep and stops the loop; resume continues from where it
  // held (never restarts mid-scene) and re-arms the loop.
  useEffect(() => {
    pausedRef.current = paused;
    cancelAnimationFrame(rafRef.current);
    if (paused) {
      elapsedRef.current = Math.min(DURATION, performance.now() - startRef.current);
    } else {
      startRef.current = performance.now() - elapsedRef.current;
      rafRef.current = requestAnimationFrame(tickRef.current);
    }
  }, [paused]);

  // A backgrounded tab (wall display) pauses so it doesn't churn unseen.
  useEffect(() => {
    const onVis = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', onVis);
    setHidden(document.hidden);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  const resetTimer = useCallback(() => {
    startRef.current = performance.now();
    elapsedRef.current = 0;
    progress.set(0);
  }, [progress]);

  const goTo = useCallback(
    (i: number) => {
      setSceneIndex(((i % TOTAL) + TOTAL) % TOTAL);
      resetTimer();
    },
    [resetTimer],
  );
  const step = useCallback(
    (d: number) => {
      setSceneIndex((i) => (((i + d) % TOTAL) + TOTAL) % TOTAL);
      resetTimer();
    },
    [resetTimer],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        step(1);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        step(-1);
      }
    },
    [step],
  );

  const scene = SCENES[sceneIndex];

  const renderScene = () => {
    switch (scene.id) {
      case 'departments':
        return <DepartmentsScene o={o} reduced={reduced} />;
      case 'people':
        return <PeopleScene o={o} reduced={reduced} />;
      case 'podium':
        return <PodiumScene o={o} reduced={reduced} />;
      case 'bonuses':
        return <BonusesScene o={o} reduced={reduced} />;
      case 'reach':
        return <ReachScene o={o} reduced={reduced} />;
      case 'system':
        return <SystemScene o={o} reduced={reduced} />;
      default:
        return null;
    }
  };

  if (o.isEmpty) {
    return (
      <div className="flex h-full min-h-[400px] flex-col items-center justify-center px-6 text-center">
        <Wallet className="mb-3 h-10 w-10 text-zinc-300 dark:text-zinc-600" />
        <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Nothing to show yet</p>
        <p className="mt-1 max-w-md text-xs text-zinc-500">
          Set department or individual rates in Pay Structure and create a few bonuses — the live standings board will
          fill in automatically.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[1180px] px-4 py-5 sm:px-6 sm:py-6">
      {/* Region A: masthead + KPI band (never rotates) */}
      <div className="mb-4 flex items-center justify-between gap-3 border-b border-zinc-200/70 pb-3 dark:border-zinc-800">
        <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-400">
          Payment Catalog · Live Standings
        </span>
        <span className="hidden items-center gap-2 text-[11px] tabular-nums text-zinc-400 sm:inline-flex">
          $1 = {money(fx.usdToPhp, 'PHP')} · {money(fx.usdToCop, 'COP')}
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-70" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
          </span>
        </span>
      </div>

      {/* KPI rail (left) + rotating stage (right); stacks on mobile */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,19rem)_1fr] lg:items-stretch">
        <KpiBand o={o} animate={!reduced} />

        {/* Region B: rotating stage */}
        <div
          className="relative h-full overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:border-zinc-800 dark:bg-zinc-950 dark:focus-visible:ring-blue-500 dark:focus-visible:ring-offset-zinc-950"
          style={{ minHeight: 'clamp(360px, 46vh, 500px)' }}
          tabIndex={0}
          role="region"
          aria-label="Compensation live standings"
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          onFocusCapture={() => setFocused(true)}
          onBlurCapture={() => setFocused(false)}
          onKeyDown={onKeyDown}
        >
        {/* Shot-clock countdown hairline (top edge) */}
        <div className="absolute inset-x-0 top-0 z-10 h-[3px] bg-zinc-100 dark:bg-zinc-800">
          <motion.div
            className={`h-full origin-left ${
              paused ? 'bg-zinc-300 opacity-40 dark:bg-zinc-600' : 'bg-orange-500 dark:bg-blue-500'
            }`}
            style={{ scaleX: progress, transformOrigin: 'left' }}
          />
        </div>

        {/* Header: title + controls */}
        <div className="flex items-center justify-between gap-3 px-5 pt-5 sm:px-7">
          <div className="flex min-w-0 items-center gap-2">
            <h3 className="truncate text-sm font-semibold uppercase tracking-[0.14em] text-zinc-500">
              {scene.title}
            </h3>
            <span className="shrink-0 text-[11px] tabular-nums text-zinc-400">
              {sceneIndex + 1}/{TOTAL}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <AnimatePresence>
              {paused && (
                <motion.span
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.9 }}
                  transition={{ duration: 0.15 }}
                  className="mr-1 inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-semibold text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
                >
                  <Pause className="h-2.5 w-2.5" /> Paused
                </motion.span>
              )}
            </AnimatePresence>
            <button
              type="button"
              onClick={(e) => {
                step(-1);
                e.currentTarget.blur();
              }}
              aria-label="Previous standing"
              className="rounded-md p-1 text-zinc-400 transition-colors hover:bg-orange-50 hover:text-zinc-700 dark:hover:bg-blue-950/30 dark:hover:text-zinc-200"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <div className="flex items-center gap-1.5">
              {SCENES.map((s, i) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={(e) => {
                    goTo(i);
                    e.currentTarget.blur();
                  }}
                  aria-label={`Go to ${s.title}`}
                  aria-current={i === sceneIndex ? 'true' : undefined}
                  className="relative flex h-3 items-center"
                >
                  {i === sceneIndex ? (
                    <motion.span
                      layoutId={`overviewSceneDot-${uid}`}
                      className="block h-1.5 w-5 rounded-full bg-orange-500 dark:bg-blue-500"
                      transition={{ type: 'spring', stiffness: 500, damping: 36 }}
                    />
                  ) : (
                    <span className="block h-1.5 w-1.5 rounded-full bg-zinc-300 transition-colors hover:bg-zinc-400 dark:bg-zinc-700 dark:hover:bg-zinc-600" />
                  )}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={(e) => {
                step(1);
                e.currentTarget.blur();
              }}
              aria-label="Next standing"
              className="rounded-md p-1 text-zinc-400 transition-colors hover:bg-orange-50 hover:text-zinc-700 dark:hover:bg-blue-950/30 dark:hover:text-zinc-200"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Body: the only thing that swaps on the 3s clock */}
        <div className="px-5 pb-7 pt-5 sm:px-7">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={sceneIndex}
              initial={reduced ? { opacity: 0 } : { opacity: 0, x: 14 }}
              animate={{ opacity: 1, x: 0 }}
              exit={reduced ? { opacity: 0 } : { opacity: 0, x: -14 }}
              transition={{ duration: reduced ? 0.15 : 0.28, ease: EASE }}
            >
              {renderScene()}
            </motion.div>
          </AnimatePresence>
        </div>
        </div>
      </div>
    </div>
  );
}
