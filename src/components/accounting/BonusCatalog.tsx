'use client';

// Payment Catalog (Accounting tab).
//
// Three-part tool:
//   1. Pay Structure -- the authoritative starting compensation (Regular Rate +
//                    OT Rate) per department ("common") or per individual.
//                    This is the SOURCE OF TRUTH for HR onboarding prefill
//                    (see src/lib/supabase/department-rates.ts). Each entry has
//                    its own currency (PHP default, switchable to USD).
//   2. Bonus Library -- create reusable custom bonuses (flat amount OR Excel-style
//                    formula). The formula editor validates live, shows the
//                    variables it references, runs a test calculator, and
//                    displays the generated TypeScript ("translate to code").
//   3. Assignments-- attach a library bonus to a whole department ("common")
//                    or to a specific employee.
//
// Persistence: dedicated tables (payment_catalog_pay_structures,
// bonus_catalog_bonuses + bonus_catalog_assignments) via
// /api/payment-catalog/pay-structures + /api/bonus-catalog. Each row records its
// creator + timestamps, and the tab subscribes to Supabase Realtime so a
// teammate's change appears live.

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { toast } from 'sonner';
import {
  Plus,
  Trash2,
  Pencil,
  Calculator,
  Code2,
  Building2,
  User,
  Users,
  Sparkles,
  CheckCircle2,
  AlertTriangle,
  X,
  Search,
  Eye,
  Wallet,
  ChevronDown,
  ArrowDownUp,
  Check,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DEPARTMENTS } from '@/lib/payroll/department-bonus';
import { normalizeDeptToKey } from '@/lib/payroll/normalize-dept-key';
import type { InitialAccountingData } from '@/lib/accounting/prefetch';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';
import {
  newId,
  validateBonus,
  type BonusDef,
  type BonusAssignment,
} from '@/lib/bonus-catalog/types';
import {
  validateFormula,
  evaluateFormula,
  compileToTypeScript,
} from '@/lib/bonus-catalog/formula';
import {
  newPayId,
  formatRate,
  CURRENCY_SYMBOL,
  OT_MULTIPLIER,
  defaultOtRate,
  isAutoOtRate,
  type PayStructure,
  type PayCurrency,
} from '@/lib/payment-catalog/pay-structure';

const PESO = '₱';

function money(n: number): string {
  return `${PESO}${n.toLocaleString('en-PH', { maximumFractionDigits: 2 })}`;
}

/** Shared easing — matches the app's tab transition (App.tsx). */
const EASE = [0.22, 1, 0.36, 1] as const;

/** Short "name part" of an email for compact attribution chips. */
function shortWho(email?: string | null): string {
  if (!email) return 'someone';
  const at = email.indexOf('@');
  return at > 0 ? email.slice(0, at) : email;
}

/** Compact "Added by X" attribution line. */
function ByLine({ who }: { who?: string | null }) {
  if (!who) return null;
  return (
    <span className="inline-flex items-center gap-1 text-[10.5px] text-zinc-400" title={who}>
      <User className="h-3 w-3" />
      {who === 'migrated' ? 'imported' : `by ${shortWho(who)}`}
    </span>
  );
}

/** Smoothly expands/collapses its children (height + opacity). */
function Expand({ show, children }: { show: boolean; children: React.ReactNode }) {
  return (
    <AnimatePresence initial={false}>
      {show && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.25, ease: EASE }}
          className="overflow-hidden"
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ---------------------------------------------------------------------------
// Reusable animated UI bits (dropdowns + loading bar)
// ---------------------------------------------------------------------------

type SelectOption = { value: string; label: string; hint?: string };

/**
 * A custom dropdown that animates open/closed with a staggered option reveal.
 * Replaces native <select> so the whole tab shares one motion language.
 */
function AnimatedSelect({
  value,
  onChange,
  options,
  placeholder = 'Select...',
  className = '',
  disabled = false,
  ariaLabel,
  searchable = false,
  searchPlaceholder = 'Search...',
}: {
  value: string;
  onChange: (v: string) => void;
  options: SelectOption[];
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  ariaLabel?: string;
  /** Show a filter box at the top of the dropdown (good for long lists). */
  searchable?: boolean;
  searchPlaceholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) {
      setQuery('');
      return;
    }
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    // Focus the filter box so you can type a name immediately.
    if (searchable) requestAnimationFrame(() => searchRef.current?.focus());
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, searchable]);

  const selected = options.find((o) => o.value === value);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!searchable || !q) return options;
    return options.filter(
      (o) => o.label.toLowerCase().includes(q) || (o.hint ?? '').toLowerCase().includes(q),
    );
  }, [options, query, searchable]);

  return (
    <div ref={ref} className={`relative ${className}`}>
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => !disabled && setOpen((o) => !o)}
        className={`flex w-full items-center justify-between gap-2 rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-left text-sm text-zinc-900 outline-none transition-colors hover:border-orange-300 focus:border-orange-400 focus:ring-2 focus:ring-orange-200 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:border-blue-800 dark:focus:ring-blue-900/40 ${
          open ? 'border-orange-400 ring-2 ring-orange-200 dark:ring-blue-900/40' : ''
        }`}
      >
        <span className={`truncate ${selected ? '' : 'text-zinc-400'}`}>
          {selected ? selected.label : placeholder}
        </span>
        <motion.span animate={{ rotate: open ? 180 : 0 }} transition={{ duration: 0.2, ease: EASE }}>
          <ChevronDown className="h-4 w-4 shrink-0 text-zinc-400" />
        </motion.span>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.16, ease: EASE }}
            className="absolute z-30 mt-1 flex max-h-72 w-full origin-top flex-col overflow-hidden rounded-md border border-zinc-200 bg-white shadow-lg dark:border-zinc-700 dark:bg-zinc-900"
          >
            {searchable && (
              <div className="shrink-0 border-b border-zinc-100 p-1.5 dark:border-zinc-800">
                <div className="relative">
                  <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
                  <input
                    ref={searchRef}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={searchPlaceholder}
                    className="w-full rounded border border-zinc-200 bg-white py-1.5 pl-7 pr-2 text-sm text-zinc-900 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-200 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:focus:ring-blue-900/40"
                  />
                </div>
              </div>
            )}
            <ul role="listbox" className="min-h-0 flex-1 overflow-auto py-1">
              {filtered.length === 0 ? (
                <li className="px-3 py-2 text-xs text-zinc-400">
                  {query.trim() ? 'No matches' : 'No options'}
                </li>
              ) : (
                filtered.map((o, i) => {
                  const active = o.value === value;
                  return (
                    <motion.li
                      key={o.value || `opt-${i}`}
                      initial={{ opacity: 0, x: -6 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ duration: 0.14, delay: Math.min(i * 0.018, 0.14), ease: EASE }}
                    >
                      <button
                        type="button"
                        role="option"
                        aria-selected={active}
                        onClick={() => {
                          onChange(o.value);
                          setOpen(false);
                        }}
                        className={`flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm transition-colors ${
                          active
                            ? 'bg-orange-50 font-medium text-orange-900 dark:bg-blue-950/50 dark:text-white'
                            : 'text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800'
                        }`}
                      >
                        <span className="min-w-0 truncate">
                          {o.label}
                          {o.hint && <span className="ml-1 text-[11px] text-zinc-400">{o.hint}</span>}
                        </span>
                        {active && <Check className="h-3.5 w-3.5 shrink-0 text-orange-500" />}
                      </button>
                    </motion.li>
                  );
                })
              )}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Indeterminate top loading bar -- a gradient sweep while data loads. */
function LoadingBar({ show }: { show: boolean }) {
  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="absolute inset-x-0 top-0 z-40 h-0.5 overflow-hidden bg-orange-100 dark:bg-blue-950/40"
        >
          <motion.div
            className="h-full w-1/3 rounded-full bg-gradient-to-r from-transparent via-orange-500 to-transparent"
            animate={{ x: ['-100%', '350%'] }}
            transition={{ duration: 1.1, ease: 'easeInOut', repeat: Infinity }}
          />
        </motion.div>
      )}
    </AnimatePresence>
  );
}

type RosterEntry = { email: string; name: string; department: string };

function buildRoster(initialData?: InitialAccountingData | null): RosterEntry[] {
  const rows = initialData?.employees ?? [];
  const seen = new Set<string>();
  const out: RosterEntry[] = [];
  for (const r of rows) {
    const email = (r.work_email || r.personal_email || '').trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    out.push({ email, name: (r.name || email).trim(), department: (r.department || '').trim() });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// ---------------------------------------------------------------------------
// Top-level component
// ---------------------------------------------------------------------------

type CatalogTab = 'pay-structure' | 'library' | 'assignments';

export default function BonusCatalog({ initialData }: { initialData?: InitialAccountingData | null }) {
  const [bonuses, setBonuses] = useState<BonusDef[]>([]);
  const [assignments, setAssignments] = useState<BonusAssignment[]>([]);
  const [payStructures, setPayStructures] = useState<PayStructure[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState<CatalogTab>('pay-structure');
  const instanceId = useId();

  const roster = useMemo(() => buildRoster(initialData), [initialData]);

  const refetch = useCallback(async () => {
    setRefreshing(true);
    try {
      const [catRes, payRes] = await Promise.all([
        fetch('/api/bonus-catalog', { cache: 'no-store' }),
        fetch('/api/payment-catalog/pay-structures', { cache: 'no-store' }),
      ]);
      const cat = (await catRes.json()) as {
        bonuses?: BonusDef[];
        assignments?: BonusAssignment[];
        error?: string | null;
      };
      const pay = (await payRes.json()) as { structures?: PayStructure[]; error?: string | null };
      setBonuses(cat.bonuses ?? []);
      setAssignments(cat.assignments ?? []);
      setPayStructures(pay.structures ?? []);
    } catch {
      /* keep prior state */
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Initial load.
  useEffect(() => {
    void refetch();
  }, [refetch]);

  // Realtime: a teammate's create/edit/delete refetches the list live.
  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const channel = supabase
      .channel(`bonus-catalog${instanceId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bonus_catalog_bonuses' }, () => void refetch())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bonus_catalog_assignments' }, () => void refetch())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'payment_catalog_pay_structures' }, () => void refetch())
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [refetch, instanceId]);

  // Refetch when the tab regains focus (covers Realtime gaps).
  useEffect(() => {
    const onFocus = () => void refetch();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refetch]);

  const failMsg = (e: unknown) => (e instanceof Error ? e.message : 'unknown error');

  const upsertBonus = useCallback(
    async (bonus: BonusDef) => {
      // Optimistic: reflect immediately, reconcile from the server row.
      setBonuses((prev) =>
        prev.some((b) => b.id === bonus.id)
          ? prev.map((b) => (b.id === bonus.id ? { ...b, ...bonus } : b))
          : [...prev, bonus],
      );
      try {
        const res = await fetch('/api/bonus-catalog', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'bonus', bonus }),
        });
        const json = (await res.json()) as { row?: BonusDef; error: string | null };
        if (json.error) throw new Error(json.error);
        if (json.row) setBonuses((prev) => prev.map((b) => (b.id === json.row!.id ? json.row! : b)));
        toast.success('Bonus saved');
      } catch (e) {
        toast.error(`Could not save bonus: ${failMsg(e)}`);
        void refetch();
      }
    },
    [refetch],
  );

  const deleteBonus = useCallback(
    async (id: string) => {
      setBonuses((prev) => prev.filter((b) => b.id !== id));
      setAssignments((prev) => prev.filter((a) => a.bonusId !== id));
      try {
        const res = await fetch(`/api/bonus-catalog?type=bonus&id=${encodeURIComponent(id)}`, {
          method: 'DELETE',
        });
        const json = (await res.json()) as { error: string | null };
        if (json.error) throw new Error(json.error);
      } catch (e) {
        toast.error(`Could not delete bonus: ${failMsg(e)}`);
        void refetch();
      }
    },
    [refetch],
  );

  const addAssignment = useCallback(
    async (a: BonusAssignment) => {
      // Upsert in state: a brand-new assignment appends; editing a common
      // bonus's exclusion list reuses the same id and replaces it in place.
      setAssignments((prev) =>
        prev.some((x) => x.id === a.id) ? prev.map((x) => (x.id === a.id ? a : x)) : [...prev, a],
      );
      try {
        const res = await fetch('/api/bonus-catalog', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'assignment', assignment: a }),
        });
        const json = (await res.json()) as { row?: BonusAssignment; error: string | null };
        if (json.error) throw new Error(json.error);
        if (json.row) setAssignments((prev) => prev.map((x) => (x.id === json.row!.id ? json.row! : x)));
      } catch (e) {
        toast.error(`Could not assign bonus: ${failMsg(e)}`);
        void refetch();
      }
    },
    [refetch],
  );

  const removeAssignment = useCallback(
    async (id: string) => {
      setAssignments((prev) => prev.filter((x) => x.id !== id));
      try {
        const res = await fetch(`/api/bonus-catalog?type=assignment&id=${encodeURIComponent(id)}`, {
          method: 'DELETE',
        });
        const json = (await res.json()) as { error: string | null };
        if (json.error) throw new Error(json.error);
      } catch (e) {
        toast.error(`Could not remove assignment: ${failMsg(e)}`);
        void refetch();
      }
    },
    [refetch],
  );

  const upsertPay = useCallback(
    async (s: PayStructure, effectiveDate?: string) => {
      setPayStructures((prev) =>
        prev.some((p) => p.id === s.id)
          ? prev.map((p) => (p.id === s.id ? { ...p, ...s } : p))
          : [...prev, s],
      );
      try {
        const res = await fetch('/api/payment-catalog/pay-structures', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ structure: s, effectiveDate: effectiveDate ?? null }),
        });
        const json = (await res.json()) as { row?: PayStructure; error: string | null };
        if (json.error) throw new Error(json.error);
        if (json.row) setPayStructures((prev) => prev.map((p) => (p.id === json.row!.id ? json.row! : p)));
        toast.success('Pay structure saved');
      } catch (e) {
        toast.error(`Could not save pay structure: ${failMsg(e)}`);
        void refetch();
      }
    },
    [refetch],
  );

  const deletePay = useCallback(
    async (id: string) => {
      setPayStructures((prev) => prev.filter((p) => p.id !== id));
      try {
        const res = await fetch(`/api/payment-catalog/pay-structures?id=${encodeURIComponent(id)}`, {
          method: 'DELETE',
        });
        const json = (await res.json()) as { error: string | null };
        if (json.error) throw new Error(json.error);
      } catch (e) {
        toast.error(`Could not delete pay structure: ${failMsg(e)}`);
        void refetch();
      }
    },
    [refetch],
  );

  const tabs = [
    { id: 'pay-structure', label: 'Pay Structure', icon: Wallet, count: payStructures.length },
    { id: 'library', label: 'Bonus Library', icon: Sparkles, count: bonuses.length },
    { id: 'assignments', label: 'Assignments', icon: Building2, count: assignments.length },
  ] as const;

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-[#fafaf8] dark:bg-[#0d1117]">
      <LoadingBar show={loading || refreshing} />
      {/* Header */}
      <div className="shrink-0 border-b border-orange-100 bg-white px-4 py-3 sm:px-6 sm:py-5 dark:border-blue-950/60 dark:bg-[#0d1117]">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-base font-semibold tracking-tight text-zinc-900 sm:text-xl dark:text-white">
              <Wallet className="h-5 w-5 text-orange-500" />
              Payment Catalog
            </h1>
            <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-500">
              The source of truth for starting pay. Set Regular &amp; OT rates per department or person,
              and define reusable bonuses to assign across the team.
            </p>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-70" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
            </span>
            Live &middot; changes save automatically
          </span>
        </div>

        {/* Inner tabs */}
        <div className="mt-4 flex flex-wrap gap-1">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`relative flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                tab === t.id
                  ? 'text-orange-900 dark:text-white'
                  : 'text-zinc-500 hover:bg-orange-50 hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-blue-950/30'
              }`}
            >
              {tab === t.id && (
                <motion.span
                  layoutId="catalogTabPill"
                  className="absolute inset-0 rounded-md bg-orange-100 dark:bg-blue-950/60"
                  transition={{ type: 'spring', stiffness: 500, damping: 36 }}
                />
              )}
              <span className="relative z-10 flex items-center gap-1.5">
                <t.icon className="h-4 w-4" />
                {t.label}
                {t.count > 0 && (
                  <span className="ml-0.5 rounded-full bg-orange-200/70 px-1.5 text-[10px] font-bold text-orange-800 dark:bg-blue-900/60 dark:text-blue-200">
                    {t.count}
                  </span>
                )}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <AnimatePresence mode="wait" initial={false}>
          {loading ? (
            <motion.div
              key="loading"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="p-10 text-center text-sm text-zinc-400"
            >
              Loading catalog...
            </motion.div>
          ) : tab === 'pay-structure' ? (
            <motion.div
              key="pay-structure"
              initial={{ opacity: 0, x: -14 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 14 }}
              transition={{ duration: 0.24, ease: EASE }}
              className="h-full"
            >
              <PayStructureTab
                structures={payStructures}
                roster={roster}
                onUpsert={upsertPay}
                onDelete={deletePay}
              />
            </motion.div>
          ) : tab === 'library' ? (
            <motion.div
              key="library"
              initial={{ opacity: 0, x: -14 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 14 }}
              transition={{ duration: 0.24, ease: EASE }}
              className="h-full"
            >
              <LibraryTab
                bonuses={bonuses}
                assignments={assignments}
                onUpsert={upsertBonus}
                onDelete={deleteBonus}
              />
            </motion.div>
          ) : (
            <motion.div
              key="assignments"
              initial={{ opacity: 0, x: 14 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -14 }}
              transition={{ duration: 0.24, ease: EASE }}
              className="h-full"
            >
              <AssignmentsTab
                bonuses={bonuses}
                assignments={assignments}
                roster={roster}
                onAdd={addAssignment}
                onRemove={removeAssignment}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pay Structure tab -- authoritative Regular + OT rates (source of truth for
// onboarding), per department ("common") or per individual.
// ---------------------------------------------------------------------------

/** Animated PHP / USD segmented toggle. */
function CurrencyToggle({
  value,
  onChange,
  idSuffix,
}: {
  value: PayCurrency;
  onChange: (c: PayCurrency) => void;
  idSuffix: string;
}) {
  return (
    <div className="inline-flex rounded-md border border-zinc-200 p-0.5 dark:border-zinc-800">
      {(['PHP', 'USD'] as const).map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => onChange(c)}
          className={`relative rounded px-2.5 py-1 text-xs font-semibold transition-colors ${
            value === c ? 'text-white' : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
          }`}
        >
          {value === c && (
            <motion.span
              layoutId={`currencyPill-${idSuffix}`}
              className="absolute inset-0 rounded bg-orange-500"
              transition={{ type: 'spring', stiffness: 500, damping: 34 }}
            />
          )}
          <span className="relative z-10">
            {CURRENCY_SYMBOL[c]} {c}
          </span>
        </button>
      ))}
    </div>
  );
}

/** Animated "1.5x regular" / "Custom" segmented toggle for the OT rate. */
function OtModeToggle({
  value,
  onChange,
  idSuffix,
}: {
  value: 'auto' | 'custom';
  onChange: (m: 'auto' | 'custom') => void;
  idSuffix: string;
}) {
  const opts: { key: 'auto' | 'custom'; label: string }[] = [
    { key: 'auto', label: `${OT_MULTIPLIER}x regular` },
    { key: 'custom', label: 'Custom' },
  ];
  return (
    <div className="inline-flex rounded-md border border-zinc-200 p-0.5 dark:border-zinc-800">
      {opts.map((o) => (
        <button
          key={o.key}
          type="button"
          onClick={() => onChange(o.key)}
          className={`relative rounded px-2.5 py-1 text-xs font-semibold transition-colors ${
            value === o.key ? 'text-white' : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
          }`}
        >
          {value === o.key && (
            <motion.span
              layoutId={`otModePill-${idSuffix}`}
              className="absolute inset-0 rounded bg-orange-500"
              transition={{ type: 'spring', stiffness: 500, damping: 34 }}
            />
          )}
          <span className="relative z-10">{o.label}</span>
        </button>
      ))}
    </div>
  );
}

/** Shared Regular + OT + currency form used by both dept and individual rows.
 *  OT defaults to 1.5x the regular rate (auto, live-updating); "Custom" mode
 *  unlocks the field for a manual override. */
function PayRateEditor({
  initial,
  onSave,
  onCancel,
  saveLabel = 'Save rate',
}: {
  initial: { regularRate?: number; otRate?: number; currency?: PayCurrency };
  onSave: (regular: number, ot: number | undefined, currency: PayCurrency) => void;
  onCancel?: () => void;
  saveLabel?: string;
}) {
  const [regular, setRegular] = useState(initial.regularRate != null ? String(initial.regularRate) : '');
  const [currency, setCurrency] = useState<PayCurrency>(initial.currency ?? 'PHP');

  // Start in custom mode only when the stored OT rate isn't the auto 1.5x value.
  const initialCustom =
    initial.otRate != null &&
    !(initial.regularRate != null && isAutoOtRate(initial.regularRate, initial.otRate));
  const [otMode, setOtMode] = useState<'auto' | 'custom'>(initialCustom ? 'custom' : 'auto');
  const [customOt, setCustomOt] = useState(
    initialCustom && initial.otRate != null ? String(initial.otRate) : '',
  );

  const regularNum = Number(regular);
  const regularValid = regular.trim() !== '' && Number.isFinite(regularNum) && regularNum >= 0;

  const autoOt = regularValid ? defaultOtRate(regularNum) : undefined;
  const customOtNum = customOt.trim() === '' ? undefined : Number(customOt);
  const otNum = otMode === 'auto' ? autoOt : customOtNum;

  const customValid =
    customOtNum === undefined || (Number.isFinite(customOtNum) && customOtNum >= 0);
  const valid = regularValid && (otMode === 'auto' || customValid);

  // What the OT input shows: the live auto value when locked, the typed value otherwise.
  const otDisplay = otMode === 'auto' ? (autoOt != null ? String(autoOt) : '') : customOt;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <Field label={`Regular rate (${CURRENCY_SYMBOL[currency]}/hr)`}>
          <Input
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            value={regular}
            onChange={(e) => setRegular(e.target.value)}
            placeholder="0.00"
            className="w-32"
          />
        </Field>
        <Field label={`OT rate (${CURRENCY_SYMBOL[currency]}/hr)`}>
          <div className="flex items-center gap-2">
            <Input
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              value={otDisplay}
              onChange={(e) => setCustomOt(e.target.value)}
              disabled={otMode === 'auto'}
              placeholder={otMode === 'auto' ? `${OT_MULTIPLIER}x regular` : '0.00'}
              className={`w-28 ${otMode === 'auto' ? 'bg-zinc-100 text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400' : ''}`}
            />
            <OtModeToggle value={otMode} onChange={setOtMode} idSuffix={saveLabel} />
          </div>
        </Field>
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Currency</span>
          <CurrencyToggle value={currency} onChange={setCurrency} idSuffix={saveLabel} />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          disabled={!valid}
          onClick={() => valid && onSave(regularNum, otNum, currency)}
          className="bg-orange-500 text-white hover:bg-orange-600"
        >
          {saveLabel}
        </Button>
        {onCancel && (
          <Button type="button" size="sm" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
}

function PayStructureTab({
  structures,
  roster,
  onUpsert,
  onDelete,
}: {
  structures: PayStructure[];
  roster: RosterEntry[];
  onUpsert: (s: PayStructure, effectiveDate?: string) => void;
  onDelete: (id: string) => void;
}) {
  const [selectedDept, setSelectedDept] = useState<string>(DEPARTMENTS[0]?.key ?? '');
  const [deptSearch, setDeptSearch] = useState('');
  const [editingDept, setEditingDept] = useState(false);

  const countsByDept = useMemo(() => {
    const m: Record<string, number> = {};
    for (const s of structures) m[s.departmentKey] = (m[s.departmentKey] ?? 0) + 1;
    return m;
  }, [structures]);

  const filteredDepts = useMemo(() => {
    const q = deptSearch.trim().toLowerCase();
    return DEPARTMENTS.filter((d) => !q || d.name.toLowerCase().includes(q));
  }, [deptSearch]);

  const dept = DEPARTMENTS.find((d) => d.key === selectedDept) ?? DEPARTMENTS[0];

  const deptStructure = structures.find(
    (s) => s.scope === 'department' && s.departmentKey === selectedDept,
  );
  const individualForDept = structures.filter(
    (s) => s.scope === 'employee' && s.departmentKey === selectedDept,
  );

  // Collapse the dept editor when switching departments.
  useEffect(() => {
    setEditingDept(false);
  }, [selectedDept]);

  const saveDept = (regular: number, ot: number | undefined, currency: PayCurrency) => {
    onUpsert({
      id: deptStructure?.id ?? newPayId(),
      scope: 'department',
      departmentKey: selectedDept,
      regularRate: regular,
      otRate: ot,
      currency,
    });
    setEditingDept(false);
  };

  return (
    <div className="flex h-full min-h-0">
      {/* Dept rail */}
      <aside className="hidden w-60 shrink-0 flex-col border-r border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950 sm:flex">
        <div className="border-b border-zinc-100 p-2 dark:border-zinc-800">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
            <input
              value={deptSearch}
              onChange={(e) => setDeptSearch(e.target.value)}
              placeholder="Search departments"
              className="w-full rounded-md border border-zinc-200 bg-white py-1.5 pl-7 pr-2 text-xs dark:border-zinc-700 dark:bg-zinc-900"
            />
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {filteredDepts.map((d) => {
            const hasDeptRate = structures.some(
              (s) => s.scope === 'department' && s.departmentKey === d.key,
            );
            return (
              <button
                key={d.key}
                type="button"
                onClick={() => setSelectedDept(d.key)}
                className={`flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left text-sm transition-colors ${
                  selectedDept === d.key
                    ? 'bg-orange-100 font-medium text-orange-900 dark:bg-blue-950/60 dark:text-white'
                    : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-900'
                }`}
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  {hasDeptRate && (
                    <span
                      className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500"
                      title="Department rate set"
                    />
                  )}
                  <span className="truncate">{d.name}</span>
                </span>
                {countsByDept[d.key] ? (
                  <span className="ml-1 shrink-0 rounded-full bg-orange-200/70 px-1.5 text-[10px] font-bold text-orange-800 dark:bg-blue-900/60 dark:text-blue-200">
                    {countsByDept[d.key]}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </aside>

      {/* Detail */}
      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        {/* Mobile dept select */}
        <div className="mb-4 sm:hidden">
          <AnimatedSelect
            ariaLabel="Select department"
            value={selectedDept}
            onChange={setSelectedDept}
            options={DEPARTMENTS.map((d) => ({ value: d.key, label: d.name }))}
          />
        </div>

        <AnimatePresence mode="wait" initial={false}>
          <motion.h2
            key={selectedDept}
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            transition={{ duration: 0.18, ease: EASE }}
            className="mb-4 text-lg font-semibold text-zinc-900 dark:text-zinc-100"
          >
            {dept?.name}
          </motion.h2>
        </AnimatePresence>

        {/* Department-wide pay structure */}
        <Section
          icon={Building2}
          title="Department pay structure"
          subtitle="Default starting Regular & OT rate for everyone in this department. Used as the source of truth when HR onboards a new hire."
        >
          <AnimatePresence mode="wait" initial={false}>
            {editingDept || !deptStructure ? (
              <motion.div
                key="edit"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.22, ease: EASE }}
                className="overflow-hidden"
              >
                <PayRateEditor
                  initial={deptStructure ?? {}}
                  onSave={saveDept}
                  onCancel={deptStructure ? () => setEditingDept(false) : undefined}
                  saveLabel={deptStructure ? 'Update rate' : 'Set department rate'}
                />
              </motion.div>
            ) : (
              <motion.div
                key="view"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.2, ease: EASE }}
                className="flex flex-wrap items-center justify-between gap-3"
              >
                <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
                  <RateStat label="Regular" value={formatRate(deptStructure.regularRate, deptStructure.currency)} />
                  <RateStat
                    label="OT"
                    value={deptStructure.otRate != null ? formatRate(deptStructure.otRate, deptStructure.currency) : '-'}
                  />
                  <span className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                    {deptStructure.currency}
                  </span>
                  <ByLine who={deptStructure.updatedBy ?? deptStructure.createdBy} />
                </div>
                <div className="flex items-center gap-1">
                  <Button type="button" size="sm" variant="outline" onClick={() => setEditingDept(true)} className="gap-1">
                    <Pencil className="h-3.5 w-3.5" />
                    Edit
                  </Button>
                  <IconButton title="Remove department rate" onClick={() => onDelete(deptStructure.id)} danger>
                    <Trash2 className="h-3.5 w-3.5" />
                  </IconButton>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </Section>

        {/* Individual overrides */}
        <Section
          icon={Users}
          title="Individual pay structure"
          subtitle="Override the department default for a specific person."
        >
          <IndividualPayAdder
            roster={roster}
            deptKey={selectedDept}
            deptName={dept?.name ?? ''}
            existingEmails={new Set(individualForDept.map((s) => (s.employeeEmail ?? '').toLowerCase()))}
            onAdd={(emp, regular, ot, currency, effectiveDate) =>
              onUpsert({
                id: newPayId(),
                scope: 'employee',
                departmentKey: selectedDept,
                employeeEmail: emp.email,
                employeeName: emp.name,
                regularRate: regular,
                otRate: ot,
                currency,
              }, effectiveDate)
            }
          />
          {individualForDept.length === 0 ? (
            <p className="text-sm text-zinc-400">No individual overrides in this department.</p>
          ) : (
            <motion.div layout className="space-y-2">
              <AnimatePresence initial={false} mode="popLayout">
                {individualForDept.map((s) => (
                  <motion.div
                    key={s.id}
                    layout
                    initial={{ opacity: 0, x: -12 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 12, scale: 0.96 }}
                    transition={{ duration: 0.2, ease: EASE }}
                  >
                    <IndividualPayRow
                      structure={s}
                      onSave={(regular, ot, currency, effectiveDate) =>
                        onUpsert({ ...s, regularRate: regular, otRate: ot, currency }, effectiveDate)
                      }
                      onRemove={() => onDelete(s.id)}
                    />
                  </motion.div>
                ))}
              </AnimatePresence>
            </motion.div>
          )}
        </Section>
      </div>
    </div>
  );
}

function RateStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="block text-[11px] font-medium uppercase tracking-wide text-zinc-400">{label}</span>
      <span className="text-lg font-bold tabular-nums text-emerald-600 dark:text-emerald-400">{value}</span>
    </div>
  );
}

function nextMondayIso(): string {
  const d = new Date();
  const dow = d.getDay();
  const daysToMon = ((1 - dow + 7) % 7) || 7;
  d.setDate(d.getDate() + daysToMon);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function IndividualPayAdder({
  roster,
  deptKey,
  deptName,
  existingEmails,
  onAdd,
}: {
  roster: RosterEntry[];
  deptKey: string;
  deptName: string;
  existingEmails: Set<string>;
  onAdd: (emp: RosterEntry, regular: number, ot: number | undefined, currency: PayCurrency, effectiveDate: string) => void;
}) {
  const [empEmail, setEmpEmail] = useState('');
  const [open, setOpen] = useState(false);
  const [filterByDept, setFilterByDept] = useState(true);
  const [effectiveDate, setEffectiveDate] = useState<string>(nextMondayIso);

  const deptMatched = useMemo(
    () => roster.filter((r) => normalizeDeptToKey(r.department) === deptKey),
    [roster, deptKey],
  );
  const list = useMemo(() => {
    const base = filterByDept ? deptMatched : roster;
    return base.filter((r) => !existingEmails.has(r.email.toLowerCase()));
  }, [roster, deptMatched, existingEmails, filterByDept]);

  const emp = roster.find((r) => r.email === empEmail);

  return (
    <div className="mb-3">
      {/* Dept filter toggle */}
      <button
        type="button"
        onClick={() => { setFilterByDept((v) => !v); setEmpEmail(''); }}
        className="mb-2 flex items-center gap-2 text-xs text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
      >
        <span
          className={`relative inline-flex h-4 w-7 shrink-0 rounded-full transition-colors duration-200 ${
            filterByDept ? 'bg-orange-500 dark:bg-blue-500' : 'bg-zinc-300 dark:bg-zinc-600'
          }`}
        >
          <motion.span
            layout
            transition={{ type: 'spring', stiffness: 500, damping: 35 }}
            className="absolute top-0.5 h-3 w-3 rounded-full bg-white shadow"
            style={{ left: filterByDept ? '14px' : '2px' }}
          />
        </span>
        Show employees under this department
        {filterByDept && deptName && (
          <span className={`rounded-full px-1.5 py-px text-[10px] font-semibold ${
            deptMatched.length > 0
              ? 'bg-orange-100 text-orange-700 dark:bg-blue-900/50 dark:text-blue-300'
              : 'bg-zinc-100 text-zinc-400 dark:bg-zinc-800 dark:text-zinc-500'
          }`}>
            {deptMatched.length > 0 ? deptName : `${deptName} — no employees found`}
          </span>
        )}
      </button>
      <div className="flex flex-wrap items-center gap-2">
        <AnimatedSelect
          ariaLabel="Select an employee"
          className="w-full max-w-sm"
          searchable
          searchPlaceholder="Search by name or department..."
          value={empEmail}
          onChange={(v) => {
            setEmpEmail(v);
            setOpen(true);
          }}
          placeholder="Search for a person..."
          options={list.map((r) => ({
            value: r.email,
            label: r.name,
            hint: r.department ? `(${r.department})` : undefined,
          }))}
        />
        {!open && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!emp}
            onClick={() => setOpen(true)}
            className="gap-1"
          >
            <Plus className="h-3.5 w-3.5" />
            Add override
          </Button>
        )}
      </div>

      <Expand show={open && !!emp}>
        {open && emp && (
          <div className="mt-3 rounded-md border border-orange-200 bg-orange-50/40 p-3 dark:border-blue-900/60 dark:bg-blue-950/20">
            <p className="mb-2 text-xs font-medium text-zinc-700 dark:text-zinc-300">
              Rate for <span className="font-semibold">{emp.name}</span>
            </p>
            <div className="flex flex-col gap-4 sm:flex-row">
              <div className="flex-1">
                <div className="mb-3 flex flex-col gap-1">
                  <p className="text-[10px] font-medium uppercase tracking-wide text-emerald-600 dark:text-emerald-400">
                    Effective from
                  </p>
                  <Input
                    type="date"
                    value={effectiveDate}
                    onChange={(e) => setEffectiveDate(e.target.value)}
                    className="h-9 w-40 border-zinc-200 bg-white tabular-nums text-sm font-medium text-zinc-900 transition-colors hover:border-zinc-300 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20 dark:border-zinc-800 dark:bg-zinc-900 dark:text-white"
                  />
                </div>
                <PayRateEditor
                  initial={{}}
                  saveLabel="Add override"
                  onCancel={() => {
                    setOpen(false);
                    setEmpEmail('');
                  }}
                  onSave={(regular, ot, currency) => {
                    onAdd(emp, regular, ot, currency, effectiveDate);
                    setOpen(false);
                    setEmpEmail('');
                  }}
                />
              </div>
              <div className="w-full sm:w-52">
                <RateHistoryPanel email={emp.email} />
              </div>
            </div>
          </div>
        )}
      </Expand>
    </div>
  );
}

type RawHistoryRow = {
  regular_rate: string | null;
  ot_rate: string | null;
  effective_from: string;
  note: string | null;
  created_by: string | null;
};

function RateHistoryPanel({ email }: { email: string }) {
  const [rows, setRows] = useState<RawHistoryRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!email) return;
    setLoading(true);
    fetch(`/api/employee-rate-history?email=${encodeURIComponent(email)}`)
      .then((r) => r.json())
      .then((json: { rows?: RawHistoryRow[] }) => setRows(json.rows ?? []))
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, [email]);

  return (
    <div className="min-w-0 flex-1">
      <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
        Rate history
      </p>
      {loading ? (
        <p className="text-xs text-zinc-400">Loading...</p>
      ) : rows.length === 0 ? (
        <p className="text-xs text-zinc-400">No history yet.</p>
      ) : (
        <div className="space-y-1.5">
          {rows.map((r, i) => (
            <div
              key={i}
              className={`rounded border px-2.5 py-1.5 text-xs ${
                i === 0
                  ? 'border-emerald-200 bg-emerald-50/60 dark:border-emerald-900/40 dark:bg-emerald-950/20'
                  : 'border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold tabular-nums text-zinc-800 dark:text-zinc-200">
                  {r.regular_rate ?? '—'}
                  {r.ot_rate ? (
                    <span className="ml-1.5 font-normal text-zinc-500">/ OT {r.ot_rate}</span>
                  ) : null}
                </span>
                {i === 0 && (
                  <span className="rounded-full bg-emerald-100 px-1.5 py-px text-[9px] font-bold uppercase tracking-wide text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400">
                    current
                  </span>
                )}
              </div>
              <div className="mt-0.5 text-[10px] text-zinc-400">
                {r.effective_from}
                {r.created_by && <span> &middot; {r.created_by}</span>}
                {r.note && r.note !== 'Set via Payment Catalog' && (
                  <span> &middot; {r.note}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function IndividualPayRow({
  structure,
  onSave,
  onRemove,
}: {
  structure: PayStructure;
  onSave: (regular: number, ot: number | undefined, currency: PayCurrency, effectiveDate: string) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [effectiveDate, setEffectiveDate] = useState<string>(nextMondayIso);
  return (
    <div className="rounded-md border border-zinc-200 bg-white px-3 py-2 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <span className="block truncate text-sm font-medium text-zinc-800 dark:text-zinc-200">
            {structure.employeeName || structure.employeeEmail}
          </span>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-zinc-500">
            <span className="font-medium text-emerald-600 dark:text-emerald-400">
              {formatRate(structure.regularRate, structure.currency)}
            </span>
            {structure.otRate != null && (
              <span>OT {formatRate(structure.otRate, structure.currency)}</span>
            )}
            <span className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
              {structure.currency}
            </span>
            <ByLine who={structure.updatedBy ?? structure.createdBy} />
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <IconButton title={editing ? 'Close' : 'Edit'} onClick={() => setEditing((e) => !e)}>
            {editing ? <X className="h-3.5 w-3.5" /> : <Pencil className="h-3.5 w-3.5" />}
          </IconButton>
          <IconButton title="Remove" onClick={onRemove} danger>
            <Trash2 className="h-3.5 w-3.5" />
          </IconButton>
        </div>
      </div>
      <Expand show={editing}>
        <div className="mt-3 border-t border-zinc-100 pt-3 dark:border-zinc-800">
          <div className="flex flex-col gap-4 sm:flex-row">
            <div className="flex-1">
              <div className="mb-3 flex flex-col gap-1">
                <p className="text-[10px] font-medium uppercase tracking-wide text-emerald-600 dark:text-emerald-400">
                  Effective from
                </p>
                <Input
                  type="date"
                  value={effectiveDate}
                  onChange={(e) => setEffectiveDate(e.target.value)}
                  className="h-9 w-40 border-zinc-200 bg-white tabular-nums text-sm font-medium text-zinc-900 transition-colors hover:border-zinc-300 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20 dark:border-zinc-800 dark:bg-zinc-900 dark:text-white"
                />
              </div>
              <PayRateEditor
                initial={structure}
                saveLabel="Update"
                onCancel={() => setEditing(false)}
                onSave={(regular, ot, currency) => {
                  onSave(regular, ot, currency, effectiveDate);
                  setEditing(false);
                }}
              />
            </div>
            {structure.employeeEmail && (
              <div className="w-full sm:w-52">
                <RateHistoryPanel email={structure.employeeEmail} />
              </div>
            )}
          </div>
        </div>
      </Expand>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Library tab
// ---------------------------------------------------------------------------

function LibraryTab({
  bonuses,
  assignments,
  onUpsert,
  onDelete,
}: {
  bonuses: BonusDef[];
  assignments: BonusAssignment[];
  onUpsert: (b: BonusDef) => void;
  onDelete: (id: string) => void;
}) {
  const [editing, setEditing] = useState<BonusDef | null>(null);
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<'name' | 'newest' | 'oldest' | 'amount'>('name');
  const [page, setPage] = useState(0);
  const [viewingId, setViewingId] = useState<string | null>(null);

  // Keep the open modal in sync with the latest bonus row (so edits show live).
  const viewingBonus = useMemo(
    () => (viewingId ? bonuses.find((b) => b.id === viewingId) ?? null : null),
    [viewingId, bonuses],
  );

  // 3 per row x 3 rows.
  const PAGE_SIZE = 9;

  const assignmentCount = useCallback(
    (bonusId: string) => assignments.filter((a) => a.bonusId === bonusId).length,
    [assignments],
  );

  const filteredBonuses = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return bonuses;
    return bonuses.filter(
      (b) =>
        b.name.toLowerCase().includes(q) ||
        (b.description ?? '').toLowerCase().includes(q) ||
        (b.formula ?? '').toLowerCase().includes(q) ||
        b.kind.includes(q),
    );
  }, [bonuses, search]);

  const sortedBonuses = useMemo(() => {
    const list = [...filteredBonuses];
    const ts = (b: BonusDef) => (b.createdAt ? Date.parse(b.createdAt) : 0);
    switch (sort) {
      case 'newest':
        return list.sort((a, b) => ts(b) - ts(a));
      case 'oldest':
        return list.sort((a, b) => ts(a) - ts(b));
      case 'amount':
        return list.sort((a, b) => (b.amount ?? -1) - (a.amount ?? -1));
      case 'name':
      default:
        return list.sort((a, b) =>
          (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }),
        );
    }
  }, [filteredBonuses, sort]);

  const pageCount = Math.max(1, Math.ceil(sortedBonuses.length / PAGE_SIZE));

  // Reset to the first page whenever the result set shrinks past the current page.
  useEffect(() => {
    setPage((p) => Math.min(p, pageCount - 1));
  }, [pageCount]);

  // Jump back to page 1 when the search query or sort changes.
  useEffect(() => {
    setPage(0);
  }, [search, sort]);

  const pagedBonuses = useMemo(
    () => sortedBonuses.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE),
    [sortedBonuses, page],
  );

  const startCreate = () => {
    setEditing({ id: newId('bonus'), name: '', kind: 'flat', amount: 0, formula: '' });
    setCreating(true);
  };

  const upsert = (bonus: BonusDef) => {
    onUpsert(bonus);
    setEditing(null);
    setCreating(false);
  };

  const remove = (bonusId: string) => onDelete(bonusId);

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-center gap-2">
        <p className="shrink-0 text-sm text-zinc-500 dark:text-zinc-400">
          {bonuses.length} bonus{bonuses.length === 1 ? '' : 'es'} defined
        </p>
        <div className="relative min-w-0 flex-1">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search bonuses by name, formula..."
            className="w-full rounded-md border border-zinc-200 bg-white py-1.5 pl-8 pr-8 text-sm text-zinc-900 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-200 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:ring-blue-900/40"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200"
              aria-label="Clear search"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <ArrowDownUp className="h-3.5 w-3.5 text-zinc-400" />
          <AnimatedSelect
            ariaLabel="Sort bonuses"
            className="w-40"
            value={sort}
            onChange={(v) => setSort(v as typeof sort)}
            options={[
              { value: 'name', label: 'Name (A-Z)' },
              { value: 'newest', label: 'Newest first' },
              { value: 'oldest', label: 'Oldest first' },
              { value: 'amount', label: 'Amount (high-low)' },
            ]}
          />
        </div>
        <Button type="button" onClick={startCreate} className="shrink-0 gap-2 bg-orange-500 text-white hover:bg-orange-600">
          <Plus className="h-4 w-4" />
          New bonus
        </Button>
      </div>

      <Expand show={!!(creating || editing)}>
        {(creating || editing) && (
          <div className="pb-1">
            <BonusEditor
              key={editing?.id ?? 'new'}
              initial={editing!}
              onCancel={() => {
                setEditing(null);
                setCreating(false);
              }}
              onSave={upsert}
            />
          </div>
        )}
      </Expand>

      {bonuses.length === 0 && !creating ? (
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, ease: EASE }}>
          <EmptyState
            icon={Sparkles}
            title="No bonuses yet"
            hint='Click "New bonus" to define your first reusable bonus. Use a flat amount, or an Excel formula like IF(tickets >= 10, 500, 250) * tickets.'
          />
        </motion.div>
      ) : filteredBonuses.length === 0 ? (
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, ease: EASE }}>
          <EmptyState
            icon={Search}
            title={`No bonuses match "${search}"`}
            hint="Try a different name, keyword, or formula snippet. Clear the search to see all bonuses."
          />
        </motion.div>
      ) : (
        <>
        <motion.div layout className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <AnimatePresence mode="popLayout">
            {pagedBonuses.map((b, i) => (
              <motion.div
                key={b.id}
                layout
                initial={{ opacity: 0, y: 14, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                whileHover={{ y: -2 }}
                transition={{ duration: 0.24, delay: Math.min(i * 0.03, 0.18), ease: EASE }}
              >
                <BonusCard
                  bonus={b}
                  assignments={assignmentCount(b.id)}
                  onView={() => setViewingId(b.id)}
                  onDelete={() => remove(b.id)}
                />
              </motion.div>
            ))}
          </AnimatePresence>
        </motion.div>

        {pageCount > 1 && (
          <div className="flex items-center justify-center gap-3 pt-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={page === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
            >
              Previous
            </Button>
            <span className="text-xs text-zinc-500 dark:text-zinc-400">
              Page {page + 1} of {pageCount}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={page >= pageCount - 1}
              onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
            >
              Next
            </Button>
          </div>
        )}
        </>
      )}

      <BonusDetailModal
        bonus={viewingBonus}
        assignments={viewingBonus ? assignmentCount(viewingBonus.id) : 0}
        onClose={() => setViewingId(null)}
        onSave={(b) => onUpsert(b)}
        onDelete={(id) => {
          remove(id);
          setViewingId(null);
        }}
      />
    </div>
  );
}

function BonusCard({
  bonus,
  assignments,
  onView,
  onDelete,
}: {
  bonus: BonusDef;
  assignments: number;
  onView: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex h-48 flex-col rounded-lg border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">{bonus.name || 'Untitled'}</span>
            <KindBadge kind={bonus.kind} />
          </div>
          {bonus.description && (
            <p className="mt-0.5 truncate text-xs text-zinc-500 dark:text-zinc-500">{bonus.description}</p>
          )}
        </div>
        <div className="flex shrink-0 gap-1">
          <IconButton title="View" onClick={onView}>
            <Eye className="h-3.5 w-3.5" />
          </IconButton>
          <IconButton title="Delete" onClick={onDelete} danger>
            <Trash2 className="h-3.5 w-3.5" />
          </IconButton>
        </div>
      </div>

      {/* Body grows to fill; overflow is hidden so every card is the same height. */}
      <div className="mt-3 min-h-0 flex-1 overflow-hidden">
        {bonus.kind === 'flat' ? (
          <div className="text-lg font-bold text-emerald-600 dark:text-emerald-400">{money(bonus.amount ?? 0)}</div>
        ) : (
          <code className="block overflow-hidden rounded bg-zinc-100 px-2 py-1.5 font-mono text-xs leading-relaxed text-zinc-700 [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:3] dark:bg-zinc-900 dark:text-zinc-300">
            {bonus.formula || '(empty formula)'}
          </code>
        )}
      </div>

      <div className="mt-3 flex items-center justify-between">
        <span className="flex min-w-0 items-center gap-2 text-[11px] text-zinc-400">
          {assignments} assignment{assignments === 1 ? '' : 's'}
          <ByLine who={bonus.createdBy} />
        </span>
        <button
          type="button"
          onClick={onView}
          className="flex shrink-0 items-center gap-1 text-[11px] font-medium text-orange-600 hover:underline dark:text-orange-400"
        >
          <Eye className="h-3 w-3" />
          View
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bonus detail modal (view + inline edit toggle)
// ---------------------------------------------------------------------------

/** Animated View <-> Edit toggle switch (track + sliding knob with icon morph). */
function EditToggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center gap-2">
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={on ? 'editing' : 'viewing'}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.16, ease: EASE }}
          className={`text-xs font-medium ${on ? 'text-orange-600 dark:text-orange-400' : 'text-zinc-500 dark:text-zinc-400'}`}
        >
          {on ? 'Editing' : 'Viewing'}
        </motion.span>
      </AnimatePresence>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={on ? 'Switch to view mode' : 'Switch to edit mode'}
        onClick={() => onChange(!on)}
        className={`relative h-6 w-11 shrink-0 rounded-full transition-colors duration-300 ${
          on ? 'bg-orange-500' : 'bg-zinc-300 dark:bg-zinc-700'
        }`}
      >
        <motion.span
          className="absolute left-0.5 top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-white shadow-sm dark:bg-zinc-100"
          animate={{ x: on ? 20 : 0 }}
          transition={{ type: 'spring', stiffness: 500, damping: 34 }}
        >
          <AnimatePresence mode="wait" initial={false}>
            <motion.span
              key={on ? 'pencil' : 'eye'}
              initial={{ opacity: 0, rotate: -90, scale: 0.5 }}
              animate={{ opacity: 1, rotate: 0, scale: 1 }}
              exit={{ opacity: 0, rotate: 90, scale: 0.5 }}
              transition={{ duration: 0.18, ease: EASE }}
              className="flex items-center justify-center"
            >
              {on ? (
                <Pencil className="h-3 w-3 text-orange-600" />
              ) : (
                <Eye className="h-3 w-3 text-zinc-500" />
              )}
            </motion.span>
          </AnimatePresence>
        </motion.span>
      </button>
    </div>
  );
}

function BonusDetailModal({
  bonus,
  assignments,
  onClose,
  onSave,
  onDelete,
}: {
  bonus: BonusDef | null;
  assignments: number;
  onClose: () => void;
  onSave: (b: BonusDef) => void;
  onDelete: (id: string) => void;
}) {
  const open = !!bonus;
  const [editMode, setEditMode] = useState(false);
  // Cache the last bonus so the panel keeps its content during the exit animation.
  const [cache, setCache] = useState<BonusDef | null>(bonus);

  useEffect(() => {
    if (bonus) setCache(bonus);
    else setEditMode(false);
  }, [bonus]);

  // Close on Escape; lock body scroll while open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const b = bonus ?? cache;
  const formulaCheck = b?.kind === 'formula' ? validateFormula(b.formula ?? '') : null;

  return (
    <AnimatePresence>
      {open && b && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          {/* Backdrop */}
          <motion.div
            className="absolute inset-0 bg-zinc-900/40 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />

          {/* Panel */}
          <motion.div
            className="relative z-10 flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-950"
            initial={{ opacity: 0, y: 24, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 24, scale: 0.96 }}
            transition={{ type: 'spring', stiffness: 320, damping: 30 }}
          >
            {/* Header */}
            <div className="flex shrink-0 items-start justify-between gap-3 border-b border-zinc-100 p-4 dark:border-zinc-800 sm:p-5">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h2 className="truncate text-base font-semibold text-zinc-900 dark:text-zinc-100">
                    {b.name || 'Untitled'}
                  </h2>
                  <KindBadge kind={b.kind} />
                </div>
                {b.description && (
                  <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{b.description}</p>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <EditToggle on={editMode} onChange={setEditMode} />
                <IconButton title="Close" onClick={onClose}>
                  <X className="h-4 w-4" />
                </IconButton>
              </div>
            </div>

            {/* Body */}
            <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">
              <AnimatePresence mode="wait" initial={false}>
                {editMode ? (
                  <motion.div
                    key="edit"
                    initial={{ opacity: 0, x: 24 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -24 }}
                    transition={{ duration: 0.22, ease: EASE }}
                  >
                    <BonusEditor
                      embedded
                      initial={b}
                      onCancel={() => setEditMode(false)}
                      onSave={(next) => {
                        onSave(next);
                        setEditMode(false);
                      }}
                    />
                  </motion.div>
                ) : (
                  <motion.div
                    key="view"
                    initial={{ opacity: 0, x: -24 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 24 }}
                    transition={{ duration: 0.22, ease: EASE }}
                    className="space-y-4"
                  >
                    {b.kind === 'flat' ? (
                      <div>
                        <span className="mb-1 block text-xs font-medium text-zinc-500 dark:text-zinc-400">Amount</span>
                        <div className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">
                          {money(b.amount ?? 0)}
                        </div>
                      </div>
                    ) : (
                      <div>
                        <span className="mb-1 block text-xs font-medium text-zinc-500 dark:text-zinc-400">Formula</span>
                        <code className="block break-words rounded-md bg-zinc-100 px-3 py-2 font-mono text-sm text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
                          {b.formula || '(empty formula)'}
                        </code>
                        {formulaCheck?.ok && formulaCheck.variables.length > 0 && (
                          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
                            Variables:
                            {formulaCheck.variables.map((v) => (
                              <code
                                key={v}
                                className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-[11px] text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                              >
                                {v}
                              </code>
                            ))}
                          </div>
                        )}
                        {b.kind === 'formula' && <InlineTester formula={b.formula ?? ''} />}
                      </div>
                    )}

                    <div className="flex items-center justify-between border-t border-zinc-100 pt-3 dark:border-zinc-800">
                      <span className="flex items-center gap-2 text-[11px] text-zinc-400">
                        {assignments} assignment{assignments === 1 ? '' : 's'}
                        <ByLine who={b.createdBy} />
                      </span>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => onDelete(b.id)}
                        className="gap-1 border-rose-200 text-rose-600 hover:bg-rose-50 dark:border-rose-900/60 dark:text-rose-400 dark:hover:bg-rose-950/40"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        Delete
                      </Button>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ---------------------------------------------------------------------------
// Bonus editor (create / edit)
// ---------------------------------------------------------------------------

function BonusEditor({
  initial,
  onCancel,
  onSave,
  embedded = false,
}: {
  initial: BonusDef;
  onCancel: () => void;
  onSave: (b: BonusDef) => void;
  /** When rendered inside the detail modal, hide the framing chrome (header + border). */
  embedded?: boolean;
}) {
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description ?? '');
  const [kind, setKind] = useState(initial.kind);
  const [amount, setAmount] = useState<string>(initial.amount != null ? String(initial.amount) : '');
  const [formula, setFormula] = useState(initial.formula ?? '');
  const [showCode, setShowCode] = useState(false);

  const formulaCheck = useMemo(() => (kind === 'formula' ? validateFormula(formula) : null), [kind, formula]);

  const draft: BonusDef = {
    ...initial,
    name: name.trim(),
    description: description.trim() || undefined,
    kind,
    amount: kind === 'flat' ? Number(amount) : undefined,
    formula: kind === 'formula' ? formula.trim() : undefined,
  };

  const valid = name.trim().length > 0 && validateBonus(draft).ok;

  return (
    <div
      className={
        embedded
          ? ''
          : 'rounded-lg border-2 border-orange-200 bg-white p-4 shadow-sm dark:border-blue-900/60 dark:bg-zinc-950 sm:p-5'
      }
    >
      {!embedded && (
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            {initial.name ? 'Edit bonus' : 'New bonus'}
          </h3>
          <IconButton title="Close" onClick={onCancel}>
            <X className="h-4 w-4" />
          </IconButton>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Tickets Completed" />
        </Field>
        <Field label="Description (optional)">
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Short note for the team"
          />
        </Field>
      </div>

      {/* Kind toggle */}
      <div className="mt-3">
        <span className="mb-1.5 block text-xs font-medium text-zinc-600 dark:text-zinc-400">Bonus type</span>
        <div className="inline-flex rounded-md border border-zinc-200 p-0.5 dark:border-zinc-800">
          {(['flat', 'formula'] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              className={`relative rounded px-3 py-1 text-xs font-medium capitalize transition-colors ${
                kind === k ? 'text-white' : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
              }`}
            >
              {kind === k && (
                <motion.span
                  layoutId="bonusKindPill"
                  className="absolute inset-0 rounded bg-orange-500"
                  transition={{ type: 'spring', stiffness: 500, damping: 34 }}
                />
              )}
              <span className="relative z-10">{k === 'flat' ? 'Flat amount' : 'Formula'}</span>
            </button>
          ))}
        </div>
      </div>

      <motion.div layout className="relative">
      <AnimatePresence mode="popLayout" initial={false}>
      {kind === 'flat' ? (
        <motion.div
          key="flat"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.2, ease: EASE }}
          className="mt-3 max-w-xs"
        >
          <Field label={`Amount (${PESO})`}>
            <Input
              type="number"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0"
            />
          </Field>
        </motion.div>
      ) : (
        <motion.div
          key="formula"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.2, ease: EASE }}
          className="mt-3 space-y-2"
        >
          <Field label="Formula (Excel-style)">
            <textarea
              value={formula}
              onChange={(e) => setFormula(e.target.value)}
              rows={2}
              spellCheck={false}
              placeholder="IF(tickets >= 10, 500, 250) * tickets"
              className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 font-mono text-sm text-zinc-900 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-200 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:ring-blue-900/40"
            />
          </Field>

          {formulaCheck && !formulaCheck.ok ? (
            <p className="flex items-center gap-1.5 text-xs text-rose-600 dark:text-rose-400">
              <AlertTriangle className="h-3.5 w-3.5" />
              {formulaCheck.error}
            </p>
          ) : formulaCheck && formulaCheck.ok ? (
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Valid.
              {formulaCheck.variables.length > 0 ? (
                <span className="text-zinc-500 dark:text-zinc-400">
                  Variables:
                  {formulaCheck.variables.map((v) => (
                    <code
                      key={v}
                      className="ml-1 rounded bg-zinc-100 px-1 py-0.5 font-mono text-[11px] text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                    >
                      {v}
                    </code>
                  ))}
                </span>
              ) : (
                <span className="text-zinc-500 dark:text-zinc-400">No variables (constant amount).</span>
              )}
            </div>
          ) : null}

          <FormulaHelp />

          {formulaCheck?.ok && formulaCheck.variables.length > 0 && <InlineTester formula={formula} />}

          <button
            type="button"
            onClick={() => setShowCode((s) => !s)}
            className="flex items-center gap-1 text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
          >
            <Code2 className="h-3.5 w-3.5" />
            {showCode ? 'Hide generated TypeScript' : 'Show generated TypeScript'}
          </button>
          <Expand show={showCode}>
            <pre className="mt-1 overflow-x-auto rounded-md bg-zinc-900 p-3 text-[11px] leading-relaxed text-zinc-100">
              <code>{compileToTypeScript(formula)}</code>
            </pre>
          </Expand>
        </motion.div>
      )}
      </AnimatePresence>
      </motion.div>

      <div className="mt-4 flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="button"
          disabled={!valid}
          onClick={() => onSave(draft)}
          className="bg-orange-500 text-white hover:bg-orange-600"
        >
          Save bonus
        </Button>
      </div>
    </div>
  );
}

function FormulaHelp() {
  return (
    <details className="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900/50 dark:text-zinc-400">
      <summary className="cursor-pointer font-medium text-zinc-700 dark:text-zinc-300">
        Formula syntax help
      </summary>
      <div className="mt-2 space-y-1.5">
        <p>
          Type a name (e.g. <code className="font-mono">tickets</code>) to use it as a variable. Operators:
          <code className="font-mono"> + - * / ^</code> and comparisons <code className="font-mono">{'>= <= > < = <>'}</code>.
        </p>
        <p className="text-zinc-500">
          A leading <code className="font-mono">=</code> is optional, so pasting <code className="font-mono">=A+B</code> from
          Excel works. Note: names are variables you fill in, not spreadsheet cells &mdash; there is no{' '}
          <code className="font-mono">A1</code>/<code className="font-mono">B2</code> grid.
        </p>
        <p>
          Functions: <code className="font-mono">IF, MIN, MAX, SUM, ROUND, ROUNDUP, ROUNDDOWN, FLOOR, CEILING, ABS, MOD, AND, OR, NOT</code>.
        </p>
        <p className="text-zinc-500">
          Tiers via nested IF, e.g. <code className="font-mono">IF(collected {'>='} 30, 450, IF(collected {'>='} 22, 300, 0))</code>.
        </p>
      </div>
    </details>
  );
}

/** Live test calculator: an input per variable, computing the result. */
function InlineTester({ formula }: { formula: string }) {
  const check = useMemo(() => validateFormula(formula), [formula]);
  const [vals, setVals] = useState<Record<string, string>>({});

  const result = useMemo(() => {
    if (!check.ok) return null;
    const numVars: Record<string, number> = {};
    for (const v of check.variables) numVars[v] = Number(vals[v] ?? '') || 0;
    try {
      return evaluateFormula(formula, numVars);
    } catch {
      return null;
    }
  }, [check, formula, vals]);

  if (!check.ok) return null;

  return (
    <div className="mt-2 rounded-md border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-900/50">
      <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
        <Calculator className="h-3.5 w-3.5" />
        Test calculator
      </div>
      {check.variables.length === 0 ? (
        <p className="text-xs text-zinc-500">No variables to set.</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {check.variables.map((v) => (
            <label key={v} className="flex flex-col gap-0.5">
              <span className="font-mono text-[11px] text-zinc-500">{v}</span>
              <input
                type="number"
                inputMode="decimal"
                value={vals[v] ?? ''}
                onChange={(e) => setVals((prev) => ({ ...prev, [v]: e.target.value }))}
                placeholder="0"
                className="w-24 rounded border border-zinc-200 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
              />
            </label>
          ))}
        </div>
      )}
      <div className="mt-2 flex items-baseline gap-1 text-sm">
        <span className="text-zinc-500">Result: </span>
        <AnimatePresence mode="popLayout">
          <motion.span
            key={String(result)}
            initial={{ opacity: 0, y: 8, scale: 0.92 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.92 }}
            transition={{ type: 'spring', stiffness: 420, damping: 26 }}
            className="inline-block font-bold tabular-nums text-emerald-600 dark:text-emerald-400"
          >
            {result == null ? '-' : money(result)}
          </motion.span>
        </AnimatePresence>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Assignments tab
// ---------------------------------------------------------------------------

function AssignmentsTab({
  bonuses,
  assignments,
  roster,
  onAdd,
  onRemove,
}: {
  bonuses: BonusDef[];
  assignments: BonusAssignment[];
  roster: RosterEntry[];
  onAdd: (a: BonusAssignment) => void;
  onRemove: (id: string) => void;
}) {
  const [selectedDept, setSelectedDept] = useState<string>(DEPARTMENTS[0]?.key ?? '');
  const [deptSearch, setDeptSearch] = useState('');

  const bonusById = useMemo(() => {
    const m = new Map<string, BonusDef>();
    for (const b of bonuses) m.set(b.id, b);
    return m;
  }, [bonuses]);

  const countsByDept = useMemo(() => {
    const m: Record<string, number> = {};
    for (const a of assignments) m[a.departmentKey] = (m[a.departmentKey] ?? 0) + 1;
    return m;
  }, [assignments]);

  const filteredDepts = useMemo(() => {
    const q = deptSearch.trim().toLowerCase();
    return DEPARTMENTS.filter((d) => !q || d.name.toLowerCase().includes(q));
  }, [deptSearch]);

  const dept = DEPARTMENTS.find((d) => d.key === selectedDept) ?? DEPARTMENTS[0];

  const commonForDept = assignments.filter(
    (a) => a.scope === 'department' && a.departmentKey === selectedDept,
  );
  const employeeForDept = assignments.filter(
    (a) => a.scope === 'employee' && a.departmentKey === selectedDept,
  );

  // Members of the selected department -- the pool a common bonus can exclude from.
  const deptRoster = useMemo(
    () => roster.filter((r) => normalizeDeptToKey(r.department) === selectedDept),
    [roster, selectedDept],
  );

  const addAssignment = (a: BonusAssignment) => onAdd(a);
  const removeAssignment = (id: string) => onRemove(id);

  if (bonuses.length === 0) {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <EmptyState
          icon={Building2}
          title="No bonuses to assign yet"
          hint="Create at least one bonus in the Bonus Library tab, then come back here to assign it to a department or an employee."
        />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0">
      {/* Dept rail */}
      <aside className="hidden w-60 shrink-0 flex-col border-r border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950 sm:flex">
        <div className="border-b border-zinc-100 p-2 dark:border-zinc-800">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
            <input
              value={deptSearch}
              onChange={(e) => setDeptSearch(e.target.value)}
              placeholder="Search departments"
              className="w-full rounded-md border border-zinc-200 bg-white py-1.5 pl-7 pr-2 text-xs dark:border-zinc-700 dark:bg-zinc-900"
            />
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {filteredDepts.map((d) => (
            <button
              key={d.key}
              type="button"
              onClick={() => setSelectedDept(d.key)}
              className={`flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left text-sm transition-colors ${
                selectedDept === d.key
                  ? 'bg-orange-100 font-medium text-orange-900 dark:bg-blue-950/60 dark:text-white'
                  : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-900'
              }`}
            >
              <span className="truncate">{d.name}</span>
              {countsByDept[d.key] ? (
                <span className="ml-1 shrink-0 rounded-full bg-orange-200/70 px-1.5 text-[10px] font-bold text-orange-800 dark:bg-blue-900/60 dark:text-blue-200">
                  {countsByDept[d.key]}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      </aside>

      {/* Detail */}
      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        {/* Mobile dept select */}
        <div className="mb-4 sm:hidden">
          <AnimatedSelect
            ariaLabel="Select department"
            value={selectedDept}
            onChange={setSelectedDept}
            options={DEPARTMENTS.map((d) => ({ value: d.key, label: d.name }))}
          />
        </div>

        <AnimatePresence mode="wait" initial={false}>
          <motion.h2
            key={selectedDept}
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            transition={{ duration: 0.18, ease: EASE }}
            className="mb-4 text-lg font-semibold text-zinc-900 dark:text-zinc-100"
          >
            {dept?.name}
          </motion.h2>
        </AnimatePresence>

        {/* Common bonuses */}
        <Section
          icon={Building2}
          title="Common bonuses"
          subtitle="Applied to everyone in this department -- unless you exclude specific people."
        >
          <CommonBonusAdder
            bonuses={bonuses}
            existingBonusIds={new Set(commonForDept.map((a) => a.bonusId))}
            onAdd={(bonusId) =>
              addAssignment({ id: newId('asg'), bonusId, scope: 'department', departmentKey: selectedDept })
            }
          />
          {commonForDept.length === 0 ? (
            <p className="text-sm text-zinc-400">No common bonuses assigned.</p>
          ) : (
            <motion.div layout className="space-y-2">
              <AnimatePresence initial={false} mode="popLayout">
                {commonForDept.map((a) => (
                  <motion.div
                    key={a.id}
                    layout
                    initial={{ opacity: 0, x: -12 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 12, scale: 0.96 }}
                    transition={{ duration: 0.2, ease: EASE }}
                  >
                    <CommonAssignmentRow
                      bonus={bonusById.get(a.bonusId)}
                      assignment={a}
                      deptRoster={deptRoster}
                      onUpdate={addAssignment}
                      onRemove={() => removeAssignment(a.id)}
                    />
                  </motion.div>
                ))}
              </AnimatePresence>
            </motion.div>
          )}
        </Section>

        {/* Employee-specific bonuses */}
        <Section
          icon={User}
          title="Employee-specific bonuses"
          subtitle="Assigned to one person only."
        >
          <EmployeeBonusAdder
            bonuses={bonuses}
            roster={roster}
            deptName={dept?.name ?? ''}
            onAdd={(emp, bonusId) =>
              addAssignment({
                id: newId('asg'),
                bonusId,
                scope: 'employee',
                departmentKey: selectedDept,
                employeeEmail: emp.email,
                employeeName: emp.name,
              })
            }
          />
          {employeeForDept.length === 0 ? (
            <p className="text-sm text-zinc-400">No employee-specific bonuses assigned.</p>
          ) : (
            <motion.div layout className="space-y-2">
              <AnimatePresence initial={false} mode="popLayout">
                {employeeForDept.map((a) => (
                  <motion.div
                    key={a.id}
                    layout
                    initial={{ opacity: 0, x: -12 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 12, scale: 0.96 }}
                    transition={{ duration: 0.2, ease: EASE }}
                  >
                    <AssignmentRow
                      bonus={bonusById.get(a.bonusId)}
                      who={a.employeeName || a.employeeEmail}
                      by={a.createdBy}
                      onRemove={() => removeAssignment(a.id)}
                    />
                  </motion.div>
                ))}
              </AnimatePresence>
            </motion.div>
          )}
        </Section>
      </div>
    </div>
  );
}

function CommonBonusAdder({
  bonuses,
  existingBonusIds,
  onAdd,
}: {
  bonuses: BonusDef[];
  existingBonusIds: Set<string>;
  onAdd: (bonusId: string) => void;
}) {
  const [pick, setPick] = useState('');
  const available = bonuses.filter((b) => !existingBonusIds.has(b.id));
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <AnimatedSelect
        ariaLabel="Select a bonus"
        className="min-w-[12rem]"
        value={pick}
        onChange={setPick}
        placeholder="Select a bonus..."
        options={available.map((b) => ({ value: b.id, label: b.name }))}
      />
      <Button
        type="button"
        size="sm"
        disabled={!pick}
        onClick={() => {
          if (pick) {
            onAdd(pick);
            setPick('');
          }
        }}
        className="gap-1 bg-orange-500 text-white hover:bg-orange-600"
      >
        <Plus className="h-3.5 w-3.5" />
        Add common
      </Button>
    </div>
  );
}

function EmployeeBonusAdder({
  bonuses,
  roster,
  deptName,
  onAdd,
}: {
  bonuses: BonusDef[];
  roster: RosterEntry[];
  deptName: string;
  onAdd: (emp: RosterEntry, bonusId: string) => void;
}) {
  const [empEmail, setEmpEmail] = useState('');
  const [bonusId, setBonusId] = useState('');
  const [onlyDept, setOnlyDept] = useState(true);

  const normDept = deptName.trim().toLowerCase();
  const list = useMemo(() => {
    if (!onlyDept) return roster;
    const matched = roster.filter((r) => r.department.trim().toLowerCase() === normDept);
    return matched.length > 0 ? matched : roster;
  }, [roster, onlyDept, normDept]);

  const emp = roster.find((r) => r.email === empEmail);

  return (
    <div className="mb-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <AnimatedSelect
          ariaLabel="Select an employee"
          className="min-w-[14rem]"
          searchable
          searchPlaceholder="Search by name or department..."
          value={empEmail}
          onChange={setEmpEmail}
          placeholder="Search for a person..."
          options={list.map((r) => ({
            value: r.email,
            label: r.name,
            hint: r.department ? `(${r.department})` : undefined,
          }))}
        />
        <AnimatedSelect
          ariaLabel="Select a bonus"
          className="min-w-[12rem]"
          value={bonusId}
          onChange={setBonusId}
          placeholder="Select a bonus..."
          options={bonuses.map((b) => ({ value: b.id, label: b.name }))}
        />
        <Button
          type="button"
          size="sm"
          disabled={!emp || !bonusId}
          onClick={() => {
            if (emp && bonusId) {
              onAdd(emp, bonusId);
              setEmpEmail('');
              setBonusId('');
            }
          }}
          className="gap-1 bg-orange-500 text-white hover:bg-orange-600"
        >
          <Plus className="h-3.5 w-3.5" />
          Assign
        </Button>
      </div>
      {roster.length > 0 && (
        <label className="flex items-center gap-1.5 text-[11px] text-zinc-500">
          <input type="checkbox" checked={onlyDept} onChange={(e) => setOnlyDept(e.target.checked)} />
          Only show employees in this department
        </label>
      )}
    </div>
  );
}

function AssignmentRow({
  bonus,
  who,
  by,
  onRemove,
}: {
  bonus: BonusDef | undefined;
  who?: string;
  by?: string | null;
  onRemove: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-zinc-200 bg-white px-3 py-2 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-zinc-800 dark:text-zinc-200">
            {bonus?.name ?? '(deleted bonus)'}
          </span>
          {bonus && <KindBadge kind={bonus.kind} />}
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-xs text-zinc-500">
          {who && <span className="truncate">{who}</span>}
          {bonus?.kind === 'flat' && (
            <span className="font-medium text-emerald-600 dark:text-emerald-400">{money(bonus.amount ?? 0)}</span>
          )}
          {bonus?.kind === 'formula' && (
            <code className="truncate font-mono text-[11px] text-zinc-500">{bonus.formula}</code>
          )}
          <ByLine who={by} />
        </div>
      </div>
      <IconButton title="Remove" onClick={onRemove} danger>
        <Trash2 className="h-3.5 w-3.5" />
      </IconButton>
    </div>
  );
}

/**
 * A common (department-wide) bonus row with an "applies to all / exclude some"
 * switch. When excluding, a searchable checklist of department members lets the
 * accountant tick the people who should NOT receive this bonus.
 */
function CommonAssignmentRow({
  bonus,
  assignment,
  deptRoster,
  onUpdate,
  onRemove,
}: {
  bonus: BonusDef | undefined;
  assignment: BonusAssignment;
  deptRoster: RosterEntry[];
  onUpdate: (a: BonusAssignment) => void;
  onRemove: () => void;
}) {
  const excluded = useMemo(
    () => new Set((assignment.excludedEmails ?? []).map((e) => e.toLowerCase())),
    [assignment.excludedEmails],
  );
  const [excludeMode, setExcludeMode] = useState(excluded.size > 0);
  const [query, setQuery] = useState('');

  // Reflect realtime/remote changes: if exclusions appear, open the picker.
  useEffect(() => {
    if (excluded.size > 0) setExcludeMode(true);
  }, [excluded.size]);

  const total = deptRoster.length;
  const includedCount = deptRoster.filter((r) => !excluded.has(r.email.toLowerCase())).length;

  const commit = (next: Set<string>) =>
    onUpdate({ ...assignment, excludedEmails: Array.from(next) });

  const toggleEmail = (email: string) => {
    const key = email.toLowerCase();
    const next = new Set(excluded);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    commit(next);
  };

  const setMode = (exclude: boolean) => {
    setExcludeMode(exclude);
    // Switching back to "everyone" clears the exclusion list.
    if (!exclude && excluded.size > 0) commit(new Set());
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return deptRoster;
    return deptRoster.filter(
      (r) => r.name.toLowerCase().includes(q) || r.email.toLowerCase().includes(q),
    );
  }, [deptRoster, query]);

  return (
    <div className="overflow-hidden rounded-md border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      {/* Summary row */}
      <div className="flex items-center justify-between gap-3 px-3 py-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-zinc-800 dark:text-zinc-200">
              {bonus?.name ?? '(deleted bonus)'}
            </span>
            {bonus && <KindBadge kind={bonus.kind} />}
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-xs text-zinc-500">
            {bonus?.kind === 'flat' && (
              <span className="font-medium text-emerald-600 dark:text-emerald-400">{money(bonus.amount ?? 0)}</span>
            )}
            {bonus?.kind === 'formula' && (
              <code className="truncate font-mono text-[11px] text-zinc-500">{bonus.formula}</code>
            )}
            <ByLine who={assignment.createdBy} />
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
              excludeMode && excluded.size > 0
                ? 'bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300'
                : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300'
            }`}
            title={
              excludeMode && excluded.size > 0
                ? `${includedCount} of ${total} receive this`
                : 'Everyone in the department receives this'
            }
          >
            <Users className="h-3 w-3" />
            {excludeMode && excluded.size > 0 ? `${includedCount}/${total}` : 'All'}
          </span>
          <IconButton title="Remove" onClick={onRemove} danger>
            <Trash2 className="h-3.5 w-3.5" />
          </IconButton>
        </div>
      </div>

      {/* Applies-to switch */}
      <div className="flex flex-wrap items-center gap-2 border-t border-zinc-100 px-3 py-2 dark:border-zinc-800">
        <div className="inline-flex rounded-md border border-zinc-200 p-0.5 dark:border-zinc-800">
          {([
            { v: false, label: 'Everyone' },
            { v: true, label: 'Exclude some' },
          ] as const).map((opt) => (
            <button
              key={String(opt.v)}
              type="button"
              onClick={() => setMode(opt.v)}
              className={`relative rounded px-2.5 py-1 text-xs font-semibold transition-colors ${
                excludeMode === opt.v
                  ? 'text-white'
                  : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
              }`}
            >
              {excludeMode === opt.v && (
                <motion.span
                  layoutId={`appliesPill-${assignment.id}`}
                  className={`absolute inset-0 rounded ${opt.v ? 'bg-amber-500' : 'bg-emerald-500'}`}
                  transition={{ type: 'spring', stiffness: 500, damping: 34 }}
                />
              )}
              <span className="relative z-10">{opt.label}</span>
            </button>
          ))}
        </div>
        <span className="text-[11px] text-zinc-400">
          {excludeMode
            ? excluded.size > 0
              ? `${excluded.size} excluded — they won't receive this bonus`
              : 'Tick the people who should NOT receive this bonus'
            : 'All department members receive this bonus'}
        </span>
      </div>

      {/* Team-effort toggle: one shared entry for the whole team vs per-person */}
      <label className="flex flex-wrap items-center gap-2 border-t border-zinc-100 px-3 py-2 dark:border-zinc-800">
        <input
          type="checkbox"
          className="h-4 w-4 shrink-0 rounded accent-orange-500"
          checked={!!assignment.sharedTeam}
          onChange={(e) => onUpdate({ ...assignment, sharedTeam: e.target.checked })}
        />
        <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">Team effort</span>
        <span className="text-[11px] text-zinc-400">
          {assignment.sharedTeam
            ? 'Entered once for the whole team in the KPI Calculator — if achieved, every member gets it'
            : 'Each member is entered individually in the KPI Calculator'}
        </span>
      </label>

      {/* Exclusion picker */}
      <Expand show={excludeMode}>
        <div className="border-t border-zinc-100 px-3 py-2.5 dark:border-zinc-800">
          {total === 0 ? (
            <p className="text-xs text-zinc-400">No employees found for this department.</p>
          ) : (
            <>
              <div className="relative mb-2">
                <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search people in this department..."
                  className="w-full rounded-md border border-zinc-200 bg-white py-1.5 pl-8 pr-8 text-sm text-zinc-900 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-200 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:ring-blue-900/40"
                />
                {query && (
                  <button
                    type="button"
                    onClick={() => setQuery('')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200"
                    aria-label="Clear search"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
              <div className="max-h-56 space-y-0.5 overflow-y-auto pr-0.5">
                {filtered.length === 0 ? (
                  <p className="px-1 py-2 text-xs text-zinc-400">No matches.</p>
                ) : (
                  filtered.map((r) => {
                    const isExcluded = excluded.has(r.email.toLowerCase());
                    return (
                      <button
                        key={r.email}
                        type="button"
                        onClick={() => toggleEmail(r.email)}
                        className={`flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
                          isExcluded
                            ? 'bg-amber-50 text-amber-900 dark:bg-amber-950/30 dark:text-amber-200'
                            : 'text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-900'
                        }`}
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <span
                            className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors ${
                              isExcluded
                                ? 'border-amber-500 bg-amber-500 text-white'
                                : 'border-zinc-300 dark:border-zinc-600'
                            }`}
                            aria-hidden
                          >
                            {isExcluded && <Check className="h-3 w-3" />}
                          </span>
                          <span className="truncate">{r.name}</span>
                        </span>
                        {isExcluded && (
                          <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400">
                            excluded
                          </span>
                        )}
                      </button>
                    );
                  })
                )}
              </div>
              {excluded.size > 0 && (
                <button
                  type="button"
                  onClick={() => commit(new Set())}
                  className="mt-2 text-[11px] font-medium text-zinc-400 underline-offset-2 hover:text-zinc-600 hover:underline dark:hover:text-zinc-200"
                >
                  Clear all exclusions
                </button>
              )}
            </>
          )}
        </div>
      </Expand>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small shared bits
// ---------------------------------------------------------------------------

function KindBadge({ kind }: { kind: BonusDef['kind'] }) {
  return (
    <span
      className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
        kind === 'flat'
          ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300'
          : 'bg-blue-100 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300'
      }`}
    >
      {kind}
    </span>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">{label}</span>
      {children}
    </label>
  );
}

function Section({
  icon: Icon,
  title,
  subtitle,
  children,
}: {
  icon: typeof Building2;
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-6 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="mb-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
          <Icon className="h-4 w-4 text-orange-500" />
          {title}
        </h3>
        <p className="mt-0.5 text-xs text-zinc-500">{subtitle}</p>
      </div>
      {children}
    </section>
  );
}

function IconButton({
  title,
  onClick,
  danger,
  children,
}: {
  title: string;
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className={`rounded-md p-1.5 transition-colors ${
        danger
          ? 'text-zinc-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950/40 dark:hover:text-rose-400'
          : 'text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200'
      }`}
    >
      {children}
    </button>
  );
}

function EmptyState({
  icon: Icon,
  title,
  hint,
}: {
  icon: typeof Building2;
  title: string;
  hint: string;
}) {
  return (
    <div className="rounded-lg border border-dashed border-zinc-300 bg-white/50 px-6 py-12 text-center dark:border-zinc-700 dark:bg-zinc-950/50">
      <Icon className="mx-auto mb-3 h-8 w-8 text-zinc-300 dark:text-zinc-600" />
      <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{title}</p>
      <p className="mx-auto mt-1 max-w-md text-xs text-zinc-500">{hint}</p>
    </div>
  );
}
