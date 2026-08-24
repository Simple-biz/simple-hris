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
  ChevronLeft,
  ChevronRight,
  ArrowDownUp,
  ArrowLeft,
  Check,
  Download,
  FileText,
  FileSpreadsheet,
  Loader2,
  Award,
  Star,
  LayoutDashboard,
  FolderTree,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { Input } from '@/components/ui/input';
import { DEPARTMENTS } from '@/lib/payroll/department-bonus';
import { normalizeDeptToKey } from '@/lib/payroll/normalize-dept-key';
import { formatDeptLabel, hslSubDeptOptions } from '@/lib/departments/hsl-subdept';
import {
  buildDeptRail,
  assignRosterToRail,
  rollUpCounts,
  bucketSizes,
  parentOfDeptKey,
  homeKeyForStructure,
  buildStructureOwnerIndex,
  RAIL_NO_DEPARTMENT_KEY,
  RAIL_NO_DEPARTMENT_NAME,
  type DeptRailEntry,
} from '@/lib/payment-catalog/dept-rail';
import type { InitialAccountingData } from '@/lib/accounting/prefetch';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';
import {
  newId,
  validateBonus,
  type BonusDef,
  type BonusAssignment,
  type BonusCadence,
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
  currencyChipLabel,
  CURRENCY_LOCALE,
  PAY_CURRENCIES,
  OT_MULTIPLIER,
  defaultOtRate,
  isAutoOtRate,
  type PayStructure,
  type PayCurrency,
} from '@/lib/payment-catalog/pay-structure';
import {
  buildCatalogExport,
  downloadCatalogCsv,
  downloadCatalogPdf,
} from '@/lib/payment-catalog/catalog-export';
import {
  SYSTEM_BONUS_DEFAULTS,
  resolveSystemBonuses,
  isCustomSystemBonusCode,
  makeCustomSystemBonusCode,
  systemBonusBase,
  type SystemBonus,
  type SystemBonusBase,
  type SystemBonusCode,
} from '@/lib/payment-catalog/system-bonus';
import type { EmployeeHourlyRateRow } from '@/lib/supabase/employee-hourly-rates';
import { effectiveUsdToPhpRateFromStored } from '@/lib/fx/usd-php';
import {
  effectiveUsdToCopRateFromStored,
  officialFxRates,
  phpPerUnit,
  type FxRates,
} from '@/lib/fx/currency-fx';
import {
  computePersonComp,
  parseRateText,
  resolveRosterDeptKey,
  type PersonComp,
  type PersonCompIndexes,
  type SheetRate,
  winningRate,
} from '@/lib/payment-catalog/person-comp';
import PaymentCatalogOverview from './PaymentCatalogOverview';
import DepartmentsTab from './DepartmentsTab';
import { subDeptStructureKey, type DepartmentRegistryEntry } from '@/lib/departments/registry';

// Always render exactly 2 decimals so the exact amount is shown without ever
// rounding cents away to a whole number (1500 -> "₱1,500.00", 1500.5 -> "₱1,500.50").
// Currency defaults to PHP (legacy bonuses have no currency); USD bonuses render
// with a "$" prefix.
function money(n: number, currency: PayCurrency = 'PHP'): string {
  const locale = CURRENCY_LOCALE[currency] ?? 'en-PH';
  const digits = currency === 'COP' ? 0 : 2;
  return `${CURRENCY_SYMBOL[currency]}${n.toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
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

// ---------------------------------------------------------------------------
// Export menu -- download the whole catalog (rates + bonuses) as CSV or a
// branded PDF, grouped per category per department.
// ---------------------------------------------------------------------------

function ExportMenu({
  payStructures,
  bonuses,
  assignments,
  roster,
  extraDepartments,
  disabled,
}: {
  payStructures: PayStructure[];
  bonuses: BonusDef[];
  assignments: BonusAssignment[];
  roster: RosterEntry[];
  /** Custom (Department-tab) departments so their rates export with names. */
  extraDepartments: { key: string; name: string }[];
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<null | 'csv' | 'pdf'>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const buildModel = useCallback(() => {
    const nameByEmail = new Map(roster.map((r) => [r.email, r.name]));
    return buildCatalogExport({
      payStructures,
      bonuses,
      assignments,
      // Must include the HSL sub-teams: the export matches structures by
      // `dept.key`, so a sub-team's base rate would be silently ABSENT from the
      // CSV/XLSX/PDF if its key never appears in this list. Same list shape as
      // the Pay Structure rail — keep the two in step.
      departments: [
        ...DEPARTMENTS.map((d) => ({ key: d.key, name: d.name })),
        ...hslSubDeptOptions().map((o) => ({ key: o.value, name: o.label })),
        ...extraDepartments,
      ],
      resolveName: (email) => nameByEmail.get(email.toLowerCase()),
    });
  }, [payStructures, bonuses, assignments, roster, extraDepartments]);

  const onCsv = () => {
    try {
      downloadCatalogCsv(buildModel());
      toast.success('Catalog exported to CSV');
    } catch {
      toast.error('Could not export CSV');
    } finally {
      setOpen(false);
    }
  };

  const onPdf = async () => {
    setBusy('pdf');
    try {
      await downloadCatalogPdf(buildModel());
      toast.success('Catalog exported to PDF');
      setOpen(false);
    } catch {
      toast.error('Could not generate PDF');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div ref={ref} className="relative">
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={disabled || busy !== null}
        onClick={() => setOpen((o) => !o)}
        className="gap-1.5 border-orange-200 text-orange-700 hover:bg-orange-50 dark:border-blue-900/60 dark:text-blue-300 dark:hover:bg-blue-950/40"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
        Export
        <motion.span animate={{ rotate: open ? 180 : 0 }} transition={{ duration: 0.2, ease: EASE }}>
          <ChevronDown className="h-3.5 w-3.5" />
        </motion.span>
      </Button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.16, ease: EASE }}
            className="absolute right-0 z-40 mt-1 w-64 origin-top-right overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-xl dark:border-zinc-700 dark:bg-zinc-900"
          >
            <div className="border-b border-zinc-100 px-3 py-2 dark:border-zinc-800">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                Export pay by department
              </p>
              <p className="mt-0.5 text-[10.5px] text-zinc-400">
                Rates &amp; bonuses, grouped per category per department.
              </p>
            </div>
            <button
              type="button"
              onClick={onCsv}
              disabled={busy !== null}
              className="flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-orange-50 disabled:opacity-50 dark:hover:bg-blue-950/30"
            >
              <FileSpreadsheet className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
              <span>
                <span className="block text-sm font-medium text-zinc-800 dark:text-zinc-100">CSV spreadsheet</span>
                <span className="block text-[11px] text-zinc-500 dark:text-zinc-400">One flat table for Excel / Sheets.</span>
              </span>
            </button>
            <button
              type="button"
              onClick={onPdf}
              disabled={busy !== null}
              className="flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-orange-50 disabled:opacity-50 dark:hover:bg-blue-950/30"
            >
              {busy === 'pdf' ? (
                <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-orange-500" />
              ) : (
                <FileText className="mt-0.5 h-4 w-4 shrink-0 text-rose-500" />
              )}
              <span>
                <span className="block text-sm font-medium text-zinc-800 dark:text-zinc-100">PDF report</span>
                <span className="block text-[11px] text-zinc-500 dark:text-zinc-400">Branded, sectioned, print-ready.</span>
              </span>
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * Build the lookups `computePersonComp` needs. ONE builder, shared by the Search
 * tab and the Pay Structure tab's member list, because both claim to show "what
 * this person is paid" and the catalog is the rate source of truth — two builders
 * would be two chances to drift from the engine's
 * `employeeCatalog ?? sheetRate ?? departmentBase` precedence.
 *
 * Later-one-wins on duplicate structure keys (matching `buildCatalogRateIndex`
 * upsert-by-id semantics) and work-then-personal email for the sheet.
 */
function buildPersonCompIndexes(input: {
  payStructures: PayStructure[];
  hourlyRates: EmployeeHourlyRateRow[];
  systemBonuses: SystemBonus[];
  fx: FxRates;
  assignments: BonusAssignment[];
  customDepartments: { key: string; name: string }[];
}): PersonCompIndexes {
  const { payStructures, hourlyRates, systemBonuses, fx, assignments, customDepartments } = input;
  const structByEmail = new Map<string, PayStructure>();
  const deptStructByKey = new Map<string, PayStructure>();
  for (const s of payStructures) {
    if (s.scope === 'employee') {
      const em = (s.employeeEmail ?? '').trim().toLowerCase();
      if (em) structByEmail.set(em, s);
    } else if (s.scope === 'department') {
      deptStructByKey.set(s.departmentKey, s);
    }
  }
  const sheetRateByEmail = new Map<string, SheetRate>();
  for (const r of hourlyRates) {
    const entry = { reg: parseRateText(r.regular_rate), ot: parseRateText(r.ot_rate) };
    const we = (r.work_email ?? '').trim().toLowerCase();
    const pe = (r.personal_email ?? '').trim().toLowerCase();
    if (we) sheetRateByEmail.set(we, entry);
    if (pe && !sheetRateByEmail.has(pe)) sheetRateByEmail.set(pe, entry);
  }
  return {
    structByEmail,
    deptStructByKey,
    sheetRateByEmail,
    resolvedSystem: resolveSystemBonuses(systemBonuses, fx),
    systemBonuses,
    assignments,
    customDepartments,
  };
}

type RosterEntry = {
  email: string;
  name: string;
  department: string;
  /** Every email the catalog may key this person's rows under (work +
   *  personal) -- dispatch resolves structures across aliases, so surfaces
   *  that mirror it (the Search tab) must match the same way. */
  aliases: string[];
};

function buildRoster(initialData?: InitialAccountingData | null): RosterEntry[] {
  const rows = initialData?.employees ?? [];
  const seen = new Set<string>();
  const out: RosterEntry[] = [];
  for (const r of rows) {
    const work = (r.work_email || '').trim().toLowerCase();
    const personal = (r.personal_email || '').trim().toLowerCase();
    const email = work || personal;
    if (!email || seen.has(email)) continue;
    seen.add(email);
    out.push({
      email,
      name: (r.name || email).trim(),
      department: (r.department || '').trim(),
      aliases: work && personal && work !== personal ? [work, personal] : [email],
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * Drop the people who have LEFT.
 *
 * `initialData.employees` is `active_employees`, which cannot tell a leaver from
 * a current worker: HR keeps someone on the master sheet through their final pay
 * and the off-board stamp lands on a duplicate `global_master_list` row, so not
 * one of the 1,287 active rows carries an `off_boarded_at` while 294 of those
 * people are gone. The verdict is therefore computed server-side, from the
 * off-board evidence tables plus the cycle's timesheet, and arrives as
 * `catalogOffboardedEmails` (see `loadCatalogOffboardedEmails` for the four
 * guards that keep re-hires, suspensions and still-working people visible).
 *
 * Matched across EVERY alias, because the catalog keys a person's rows on any of
 * their addresses — an exclusion naming only the primary would let a hidden
 * person back in through a picker that matched on the personal one. An empty set
 * (including every degraded read) hides nobody.
 */
function withoutOffboarded(roster: RosterEntry[], offboarded: Set<string>): RosterEntry[] {
  if (offboarded.size === 0) return roster;
  return roster.filter(
    (r) => !offboarded.has(r.email) && !r.aliases.some((a) => offboarded.has(a)),
  );
}

// ---------------------------------------------------------------------------
// Top-level component
// ---------------------------------------------------------------------------

type CatalogTab = 'overview' | 'search' | 'departments' | 'pay-structure' | 'library' | 'assignments' | 'system-bonuses';

export default function BonusCatalog({ initialData }: { initialData?: InitialAccountingData | null }) {
  const [bonuses, setBonuses] = useState<BonusDef[]>([]);
  const [assignments, setAssignments] = useState<BonusAssignment[]>([]);
  const [payStructures, setPayStructures] = useState<PayStructure[]>([]);
  const [systemBonuses, setSystemBonuses] = useState<SystemBonus[]>(initialData?.systemBonuses ?? []);
  // Custom departments created from the Department tab + every active
  // department_managers assignment (dept string, lower-cased -> manager emails).
  const [deptRegistry, setDeptRegistry] = useState<DepartmentRegistryEntry[]>([]);
  const [deptManagers, setDeptManagers] = useState<Record<string, string[]>>({});
  // Set when another tab asks Pay Structure to open focused on a department.
  const [payFocusDept, setPayFocusDept] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState<CatalogTab>('overview');
  const instanceId = useId();

  // TWO rosters, deliberately. `roster` is everyone on the active view and is
  // used only to RESOLVE NAMES for rows that already exist (a leaver's
  // individual pay structure keeps its name in the export and on the Summary).
  // `visibleRoster` is who the catalog offers as a person: search results,
  // pickers, department headcounts, spend. Filtering the name map too would turn
  // an existing rate row into a bare email address.
  const roster = useMemo(() => buildRoster(initialData), [initialData]);
  const offboardedEmails = useMemo(
    () => new Set(initialData?.catalogOffboardedEmails ?? []),
    [initialData],
  );
  const visibleRoster = useMemo(() => withoutOffboarded(roster, offboardedEmails), [roster, offboardedEmails]);

  // Custom departments as {key, name} for the Pay Structure rail + exports --
  // a custom key that ever collides with a built-in is dropped defensively.
  // Sub-departments follow their parent as `<parentKey>:<subKey>` entries so
  // their per-sub base rates (the fallback when the parent carries no
  // department-wide rate) are settable/exportable like any department's.
  const customDepartments = useMemo(() => {
    const builtin = new Set(DEPARTMENTS.map((d) => d.key));
    return deptRegistry
      .filter((entry) => !builtin.has(entry.key))
      .flatMap((entry) => [
        { key: entry.key, name: entry.name },
        ...entry.subDepartments.map((sub) => ({
          key: subDeptStructureKey(entry.key, sub.key),
          name: `${entry.name} — ${sub.name}`,
        })),
      ]);
  }, [deptRegistry]);

  // Live USD-anchored FX rates — used only to sort the Bonus Library's
  // "Amount (high-low)" by PHP-equivalent so a $100 bonus outranks a ₱500 one.
  // The actual payout conversion happens at apply time in the KPI Calculator.
  const [fx, setFx] = useState<FxRates>(officialFxRates());
  useEffect(() => {
    let cancelled = false;
    fetch('/api/app-settings?keys=usd_to_php_rate,usd_to_cop_rate', { cache: 'no-store' })
      .then((r) => r.json())
      .then((json: { values?: Record<string, string | null> }) => {
        if (cancelled) return;
        const v = json.values ?? {};
        setFx({
          usdToPhp: effectiveUsdToPhpRateFromStored(v['usd_to_php_rate']),
          usdToCop: effectiveUsdToCopRateFromStored(v['usd_to_cop_rate']),
        });
      })
      .catch(() => {
        /* keep the official fallback */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // One engine-mirroring index for every tab that shows what a person is paid.
  const compIndexes = useMemo(
    () =>
      buildPersonCompIndexes({
        payStructures,
        hourlyRates: initialData?.hourlyRates ?? [],
        systemBonuses,
        fx,
        assignments,
        customDepartments,
      }),
    [payStructures, initialData, systemBonuses, fx, assignments, customDepartments],
  );

  const refetch = useCallback(async () => {
    setRefreshing(true);
    try {
      const [catRes, payRes, sysRes, deptRes] = await Promise.all([
        fetch('/api/bonus-catalog', { cache: 'no-store' }),
        fetch('/api/payment-catalog/pay-structures', { cache: 'no-store' }),
        fetch('/api/payment-catalog/system-bonuses', { cache: 'no-store' }),
        fetch('/api/payment-catalog/departments', { cache: 'no-store' }),
      ]);
      const cat = (await catRes.json()) as {
        bonuses?: BonusDef[];
        assignments?: BonusAssignment[];
        error?: string | null;
      };
      const pay = (await payRes.json()) as { structures?: PayStructure[]; error?: string | null };
      const sys = (await sysRes.json()) as { bonuses?: SystemBonus[]; error?: string | null };
      const dept = (await deptRes.json()) as {
        registry?: DepartmentRegistryEntry[];
        managers?: Record<string, string[]>;
        error?: string | null;
      };
      setBonuses(cat.bonuses ?? []);
      setAssignments(cat.assignments ?? []);
      setPayStructures(pay.structures ?? []);
      setSystemBonuses(sys.bonuses ?? []);
      setDeptRegistry(dept.registry ?? []);
      setDeptManagers(dept.managers ?? {});
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
      .on('postgres_changes', { event: '*', schema: 'public', table: 'payment_catalog_system_bonuses' }, () => void refetch())
      .on(
        'postgres_changes',
        // Department registry lives in app_settings -- filter to its one key so
        // unrelated setting bumps (payments pulse etc.) don't refetch the catalog.
        {
          event: '*',
          schema: 'public',
          table: 'app_settings',
          filter: 'key=eq.payment_catalog.departments.registry',
        },
        () => void refetch(),
      )
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

  const upsertSystemBonus = useCallback(
    async (bonus: SystemBonus) => {
      setSystemBonuses((prev) =>
        prev.some((b) => b.code === bonus.code)
          ? prev.map((b) => (b.code === bonus.code ? { ...b, ...bonus } : b))
          : [...prev, bonus],
      );
      try {
        const res = await fetch('/api/payment-catalog/system-bonuses', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bonus }),
        });
        const json = (await res.json()) as { row?: SystemBonus; error: string | null };
        if (json.error) throw new Error(json.error);
        if (json.row) setSystemBonuses((prev) => prev.map((b) => (b.code === json.row!.code ? json.row! : b)));
        toast.success(`${bonus.label} saved`);
      } catch (e) {
        toast.error(`Could not save bonus: ${failMsg(e)}`);
        void refetch();
      }
    },
    [refetch],
  );

  const deleteSystemBonus = useCallback(
    async (code: string) => {
      const removed = systemBonuses.find((b) => b.code === code);
      setSystemBonuses((prev) => prev.filter((b) => b.code !== code));
      try {
        const res = await fetch(`/api/payment-catalog/system-bonuses?code=${encodeURIComponent(code)}`, {
          method: 'DELETE',
        });
        const json = (await res.json()) as { error: string | null };
        if (json.error) throw new Error(json.error);
        toast.success(`${removed?.label ?? 'System bonus'} deleted`);
      } catch (e) {
        toast.error(`Could not delete bonus: ${failMsg(e)}`);
        void refetch();
      }
    },
    [systemBonuses, refetch],
  );

  const tabs = [
    { id: 'overview', label: 'Summary', icon: LayoutDashboard, count: 0 },
    { id: 'search', label: 'Search', icon: Search, count: 0 },
    { id: 'departments', label: 'Department', icon: FolderTree, count: deptRegistry.length },
    { id: 'pay-structure', label: 'Pay Structure', icon: Wallet, count: payStructures.length },
    { id: 'library', label: 'Bonus Library', icon: Sparkles, count: bonuses.length },
    { id: 'assignments', label: 'Assignments', icon: Building2, count: assignments.length },
    { id: 'system-bonuses', label: 'System Bonuses', icon: Award, count: 0 },
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
          <div className="flex items-center gap-2.5">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-70" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
              </span>
              Live &middot; changes save automatically
            </span>
            <ExportMenu
              payStructures={payStructures}
              bonuses={bonuses}
              assignments={assignments}
              roster={roster}
              extraDepartments={customDepartments}
              disabled={loading}
            />
          </div>
        </div>

        {/* Inner tabs — navigation stays live even in a view-only tab. */}
        <div role="tablist" aria-label="Bonus catalog views" className="mt-4 flex flex-wrap gap-1" data-readonly-allow>
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
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
          ) : tab === 'overview' ? (
            <motion.div
              key="overview"
              initial={{ opacity: 0, x: -14 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 14 }}
              transition={{ duration: 0.24, ease: EASE }}
              className="h-full"
            >
              <PaymentCatalogOverview
                payStructures={payStructures}
                bonuses={bonuses}
                assignments={assignments}
                systemBonuses={systemBonuses}
                roster={visibleRoster}
                nameRoster={roster}
                fx={fx}
              />
            </motion.div>
          ) : tab === 'search' ? (
            <motion.div
              key="search"
              initial={{ opacity: 0, x: -14 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 14 }}
              transition={{ duration: 0.24, ease: EASE }}
              className="h-full"
            >
              <SearchTab
                payStructures={payStructures}
                bonuses={bonuses}
                assignments={assignments}
                systemBonuses={systemBonuses}
                fx={fx}
                roster={visibleRoster}
                hourlyRates={initialData?.hourlyRates ?? []}
                compIndexes={compIndexes}
                customDepartments={customDepartments}
                onUpsertPay={upsertPay}
                onDeletePay={deletePay}
                onAddAssignment={addAssignment}
                onRemoveAssignment={removeAssignment}
              />
            </motion.div>
          ) : tab === 'departments' ? (
            <motion.div
              key="departments"
              initial={{ opacity: 0, x: -14 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 14 }}
              transition={{ duration: 0.24, ease: EASE }}
              className="h-full"
            >
              <DepartmentsTab
                roster={visibleRoster}
                payStructures={payStructures}
                registry={deptRegistry}
                managersByDept={deptManagers}
                onCreated={() => void refetch()}
                onOpenPayStructure={(deptKey) => {
                  setPayFocusDept(deptKey);
                  setTab('pay-structure');
                }}
              />
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
                roster={visibleRoster}
                compIndexes={compIndexes}
                extraDepartments={customDepartments}
                focusDept={payFocusDept}
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
                fx={fx}
              />
            </motion.div>
          ) : tab === 'assignments' ? (
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
                roster={visibleRoster}
                extraDepartments={customDepartments}
                onAdd={addAssignment}
                onRemove={removeAssignment}
              />
            </motion.div>
          ) : (
            <motion.div
              key="system-bonuses"
              initial={{ opacity: 0, x: 14 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -14 }}
              transition={{ duration: 0.24, ease: EASE }}
              className="h-full"
            >
              <SystemBonusesTab
                bonuses={systemBonuses}
                fx={fx}
                extraDepartments={customDepartments}
                onUpsert={upsertSystemBonus}
                onDelete={deleteSystemBonus}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// System Bonuses tab -- the two built-in bonuses (PAB + Technology) plus
// custom currency variants (`pab:*` / `tech:*` codes). A variant keeps the
// built-in engine timing but pays its own amount -- in PHP, USD, or COP -- to
// the departments in its allowlist (overriding the built-in amount there).
// Drives every dashboard via payment_catalog_system_bonuses.
// ---------------------------------------------------------------------------

const SYSTEM_BASE_TIMING: Record<SystemBonusBase, string> = {
  pab: 'Pays like PAB — final week of the PAB period, perfect attendance required.',
  tech: 'Pays like Tech — the month’s payout week (wizard System Bonus pick, default 3rd-week salary date), after 30 days of service.',
};

function SystemBonusesTab({
  bonuses,
  fx,
  extraDepartments,
  onUpsert,
  onDelete,
}: {
  bonuses: SystemBonus[];
  fx: FxRates;
  extraDepartments: { key: string; name: string }[];
  onUpsert: (b: SystemBonus) => void;
  onDelete: (code: string) => void;
}) {
  const byCode = (code: SystemBonusCode) => bonuses.find((b) => b.code === code) ?? null;
  const customBonuses = useMemo(
    () =>
      bonuses
        .filter((b) => isCustomSystemBonusCode(b.code))
        .sort((a, b) => a.code.localeCompare(b.code)),
    [bonuses],
  );
  // Built-in payroll departments + the Department-tab registry, de-duplicated.
  const deptOptions = useMemo(() => {
    const seen = new Set(DEPARTMENTS.map((d) => d.key));
    return [
      ...DEPARTMENTS.map((d) => ({ key: d.key, name: d.name })),
      ...extraDepartments.filter((d) => !seen.has(d.key)),
    ];
  }, [extraDepartments]);
  const [creating, setCreating] = useState(false);

  return (
    <div className="mx-auto max-w-3xl p-4 sm:p-6">
      <div className="mb-5 rounded-lg border border-orange-100 bg-orange-50/40 p-3 text-xs leading-relaxed text-zinc-600 dark:border-blue-950/60 dark:bg-blue-950/10 dark:text-zinc-400">
        These built-in bonuses pay automatically based on attendance and tenure. Set each
        amount and choose which departments receive it — a department that is unticked (e.g.{' '}
        <span className="font-medium">US - Manager Bonus</span>) is never paid that bonus. PAB
        pays on the final week of the PAB period; the Technology Bonus pays on the month&apos;s
        payout week — picked in the Payroll Wizard&apos;s System Bonus settings, defaulting to the
        3rd-week salary date. Changes apply across the Payroll Wizard, Payment Dispatch, Summary,
        and every employee dashboard.
      </div>
      <SystemBonusCard
        code="pab"
        row={byCode('pab')}
        deptOptions={deptOptions}
        onUpsert={onUpsert}
        subtitle="Paid on the final week of the PAB period to employees who pass perfect attendance."
      />
      <SystemBonusCard
        code="tech"
        row={byCode('tech')}
        deptOptions={deptOptions}
        onUpsert={onUpsert}
        subtitle="Paid on the month's payout week (wizard System Bonus pick; default 3rd-week salary date) to employees past 30 days of service."
      />

      {/* ---- Custom currency variants ---------------------------------- */}
      <div className="mb-3 mt-8 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-white">
            Custom system bonuses
          </h3>
          <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
            Same automatic timing as PAB / Tech, but with its own amount in PHP, USD, or COP.
            For the departments picked here it <span className="font-medium">replaces</span> the
            built-in amount; non-PHP amounts convert at the live FX rate at payout.
          </p>
        </div>
        {!creating && (
          <Button
            type="button"
            size="sm"
            onClick={() => setCreating(true)}
            className="bg-orange-500 text-white hover:bg-orange-600"
          >
            <Plus className="mr-1 h-3.5 w-3.5" /> Add system bonus
          </Button>
        )}
      </div>

      <Expand show={creating}>
        <CustomSystemBonusForm
          fx={fx}
          deptOptions={deptOptions}
          onCancel={() => setCreating(false)}
          onCreate={(b) => {
            onUpsert(b);
            setCreating(false);
          }}
        />
      </Expand>

      {customBonuses.length === 0 && !creating && (
        <div className="rounded-lg border border-dashed border-zinc-200 p-6 text-center text-xs text-zinc-400 dark:border-zinc-800">
          No custom system bonuses yet. Add one to pay a PAB- or Tech-style bonus in dollars or
          Colombian pesos to specific departments.
        </div>
      )}

      {customBonuses.map((b) => (
        <CustomSystemBonusCard
          key={b.code}
          row={b}
          fx={fx}
          deptOptions={deptOptions}
          onUpsert={onUpsert}
          onDelete={onDelete}
        />
      ))}
    </div>
  );
}

/** Shared department-allowlist chip picker for custom system bonuses. */
function SystemDeptPicker({
  options,
  selected,
  onToggle,
  onClear,
}: {
  options: { key: string; name: string }[];
  selected: Set<string>;
  onToggle: (key: string) => void;
  onClear: () => void;
}) {
  return (
    <div>
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
          Paid to{' '}
          <span className="font-semibold text-zinc-800 dark:text-zinc-200">{selected.size}</span>{' '}
          department{selected.size === 1 ? '' : 's'}
          {selected.size === 0 && (
            <span className="ml-1.5 text-amber-600 dark:text-amber-400">— pick at least one</span>
          )}
        </span>
        <button
          type="button"
          onClick={onClear}
          className="rounded px-1.5 py-0.5 text-[11px] font-medium text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
        >
          Clear
        </button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {options.map((d) => {
          const on = selected.has(d.key);
          return (
            <button
              key={d.key}
              type="button"
              onClick={() => onToggle(d.key)}
              className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ring-1 transition-colors ${
                on
                  ? 'bg-emerald-100 text-emerald-700 ring-emerald-400/40 hover:bg-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-500/30'
                  : 'bg-white text-zinc-500 ring-zinc-200 hover:bg-zinc-50 dark:bg-zinc-900 dark:text-zinc-500 dark:ring-zinc-700'
              }`}
            >
              {on && <Check className="h-3 w-3" />}
              {d.name}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** "≈ ₱X at the current rate" hint for a non-PHP amount. */
function FxPreview({ amount, currency, fx }: { amount: number; currency: PayCurrency; fx: FxRates }) {
  if (currency === 'PHP' || !Number.isFinite(amount) || amount <= 0) return null;
  return (
    <span className="text-[11px] text-sky-600 dark:text-sky-400">
      ≈ {money(amount * phpPerUnit(currency, fx))} at the current rate
    </span>
  );
}

/** Create form for a new custom system bonus (variant of PAB / Tech timing). */
function CustomSystemBonusForm({
  fx,
  deptOptions,
  onCreate,
  onCancel,
}: {
  fx: FxRates;
  deptOptions: { key: string; name: string }[];
  onCreate: (b: SystemBonus) => void;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState('');
  const [base, setBase] = useState<SystemBonusBase>('tech');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState<PayCurrency>('USD');
  const [depts, setDepts] = useState<Set<string>>(() => new Set());

  const amountNum = Number(amount);
  const amountValid = amount.trim() !== '' && Number.isFinite(amountNum) && amountNum >= 0;
  const canCreate = label.trim() !== '' && amountValid && depts.size > 0;

  const create = () => {
    if (!canCreate) return;
    onCreate({
      code: makeCustomSystemBonusCode(base, label.trim()),
      label: label.trim(),
      amount: amountNum,
      currency,
      enabled: true,
      departmentKeys: [...depts],
    });
  };

  return (
    <Section icon={Plus} title="New custom system bonus" subtitle={SYSTEM_BASE_TIMING[base]}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-end gap-4">
          <Field label="Name">
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. Technology Bonus (US)"
              className="w-56"
            />
          </Field>
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Timing</span>
            <div className="inline-flex rounded-md border border-zinc-200 p-0.5 dark:border-zinc-800">
              {(
                [
                  { key: 'pab', label: 'PAB (attendance)' },
                  { key: 'tech', label: 'Tech (tenure)' },
                ] as const
              ).map((o) => (
                <button
                  key={o.key}
                  type="button"
                  onClick={() => setBase(o.key)}
                  className={`relative rounded px-2.5 py-1 text-xs font-semibold transition-colors ${
                    base === o.key ? 'text-white' : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
                  }`}
                >
                  {base === o.key && (
                    <motion.span
                      layoutId="sysCustomBasePill"
                      className="absolute inset-0 rounded bg-orange-500"
                      transition={{ type: 'spring', stiffness: 500, damping: 34 }}
                    />
                  )}
                  <span className="relative z-10">{o.label}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-end gap-4">
          <Field label={`Amount (${CURRENCY_SYMBOL[currency]})`}>
            <div className="flex items-center gap-1.5">
              <span className="text-sm text-zinc-400">{CURRENCY_SYMBOL[currency]}</span>
              <Input
                type="number"
                inputMode="decimal"
                min="0"
                step={currency === 'COP' ? '1' : '0.01'}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder={currency === 'COP' ? '0' : '0.00'}
                className="w-32"
              />
            </div>
          </Field>
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Currency</span>
            <CurrencyToggle value={currency} onChange={setCurrency} idSuffix="sysCustomNew" />
          </div>
          {amountValid && <FxPreview amount={amountNum} currency={currency} fx={fx} />}
        </div>

        <SystemDeptPicker
          options={deptOptions}
          selected={depts}
          onToggle={(key) =>
            setDepts((prev) => {
              const next = new Set(prev);
              if (next.has(key)) next.delete(key);
              else next.add(key);
              return next;
            })
          }
          onClear={() => setDepts(new Set())}
        />
        <p className="text-[11px] leading-relaxed text-zinc-400">
          For the departments picked here this bonus replaces the built-in{' '}
          {base === 'pab' ? 'Perfect Attendance Bonus' : 'Technology Bonus'} amount; every other
          eligibility rule (attendance / tenure and timing) still applies.
        </p>

        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            disabled={!canCreate}
            onClick={create}
            className="bg-orange-500 text-white hover:bg-orange-600"
          >
            Create bonus
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    </Section>
  );
}

/** Editable card for an existing custom system bonus. */
function CustomSystemBonusCard({
  row,
  fx,
  deptOptions,
  onUpsert,
  onDelete,
}: {
  row: SystemBonus;
  fx: FxRates;
  deptOptions: { key: string; name: string }[];
  onUpsert: (b: SystemBonus) => void;
  onDelete: (code: string) => void;
}) {
  const base = systemBonusBase(row.code) ?? 'tech';
  const savedDeptsArr = useMemo(() => [...(row.departmentKeys ?? [])].sort(), [row]);
  const savedDeptsKey = savedDeptsArr.join(',');
  const savedKey = `${row.label}|${row.amount}|${row.currency}|${row.enabled}|${savedDeptsKey}`;

  const [label, setLabel] = useState(row.label);
  const [amount, setAmount] = useState(String(row.amount));
  const [currency, setCurrency] = useState<PayCurrency>(row.currency);
  const [enabled, setEnabled] = useState(row.enabled);
  const [depts, setDepts] = useState<Set<string>>(() => new Set(savedDeptsArr));
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    setLabel(row.label);
    setAmount(String(row.amount));
    setCurrency(row.currency);
    setEnabled(row.enabled);
    setDepts(new Set(savedDeptsArr));
    setConfirmDelete(false);
    // Reseed only when the persisted snapshot changes — not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey]);

  const amountNum = Number(amount);
  const amountValid = amount.trim() !== '' && Number.isFinite(amountNum) && amountNum >= 0;
  const deptsKey = [...depts].sort().join(',');
  const dirty =
    label !== row.label ||
    amount !== String(row.amount) ||
    currency !== row.currency ||
    enabled !== row.enabled ||
    deptsKey !== savedDeptsKey;
  const canSave = amountValid && label.trim() !== '' && depts.size > 0 && dirty;

  const save = () => {
    if (!canSave) return;
    onUpsert({
      ...row,
      label: label.trim(),
      amount: amountNum,
      currency,
      enabled,
      departmentKeys: [...depts],
    });
  };

  return (
    <Section
      icon={Award}
      title={row.label}
      subtitle={SYSTEM_BASE_TIMING[base]}
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-end gap-4">
          <Field label="Name">
            <Input value={label} onChange={(e) => setLabel(e.target.value)} className="w-56" />
          </Field>
          <Field label={`Amount (${CURRENCY_SYMBOL[currency]})`}>
            <div className="flex items-center gap-1.5">
              <span className="text-sm text-zinc-400">{CURRENCY_SYMBOL[currency]}</span>
              <Input
                type="number"
                inputMode="decimal"
                min="0"
                step={currency === 'COP' ? '1' : '0.01'}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="w-32"
              />
            </div>
          </Field>
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Currency</span>
            <CurrencyToggle value={currency} onChange={setCurrency} idSuffix={`sysCustom-${row.code}`} />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Status</span>
            <div className="inline-flex rounded-md border border-zinc-200 p-0.5 dark:border-zinc-800">
              {([
                { on: true, label: 'Enabled' },
                { on: false, label: 'Disabled' },
              ] as const).map((o) => (
                <button
                  key={o.label}
                  type="button"
                  onClick={() => setEnabled(o.on)}
                  className={`relative rounded px-2.5 py-1 text-xs font-semibold transition-colors ${
                    enabled === o.on
                      ? 'text-white'
                      : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
                  }`}
                >
                  {enabled === o.on && (
                    <motion.span
                      layoutId={`sysEnabledPill-${row.code}`}
                      className={`absolute inset-0 rounded ${o.on ? 'bg-emerald-500' : 'bg-zinc-400 dark:bg-zinc-600'}`}
                      transition={{ type: 'spring', stiffness: 500, damping: 34 }}
                    />
                  )}
                  <span className="relative z-10">{o.label}</span>
                </button>
              ))}
            </div>
          </div>
          {amountValid && <FxPreview amount={amountNum} currency={currency} fx={fx} />}
        </div>

        <SystemDeptPicker
          options={deptOptions}
          selected={depts}
          onToggle={(key) =>
            setDepts((prev) => {
              const next = new Set(prev);
              if (next.has(key)) next.delete(key);
              else next.add(key);
              return next;
            })
          }
          onClear={() => setDepts(new Set())}
        />

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            disabled={!canSave}
            onClick={save}
            className="bg-orange-500 text-white hover:bg-orange-600"
          >
            Save changes
          </Button>
          {dirty && <span className="text-xs text-amber-600 dark:text-amber-400">Unsaved changes</span>}
          {!dirty && (
            <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="h-3.5 w-3.5" /> Saved
            </span>
          )}
          <span className="mx-1 flex-1" />
          <ByLine who={row.createdBy} />
          {confirmDelete ? (
            <span className="inline-flex items-center gap-1.5">
              <span className="text-xs text-red-500">Delete this bonus?</span>
              <Button
                type="button"
                size="sm"
                variant="destructive"
                onClick={() => onDelete(row.code)}
              >
                Delete
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
                Keep
              </Button>
            </span>
          ) : (
            <button
              type="button"
              title="Delete this custom system bonus"
              onClick={() => setConfirmDelete(true)}
              className="rounded p-1.5 text-zinc-400 transition-colors hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-950/40"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
    </Section>
  );
}

function SystemBonusCard({
  code,
  row,
  deptOptions,
  onUpsert,
  subtitle,
}: {
  code: SystemBonusCode;
  row: SystemBonus | null;
  deptOptions: { key: string; name: string }[];
  onUpsert: (b: SystemBonus) => void;
  subtitle: string;
}) {
  const label = row?.label ?? SYSTEM_BONUS_DEFAULTS[code].label;
  const savedAmount = row?.amount ?? SYSTEM_BONUS_DEFAULTS[code].amount;
  const savedEnabled = row?.enabled ?? true;
  const savedDeptsArr = useMemo(() => [...(row?.departmentKeys ?? [])].sort(), [row]);
  const savedDeptsKey = savedDeptsArr.join(',');
  // Reseed key: changes whenever the persisted row's values change (a teammate
  // edit, or our own save reconciling) so the local draft follows the DB.
  const savedKey = `${savedAmount}|${savedEnabled}|${savedDeptsKey}`;

  const [amount, setAmount] = useState(String(savedAmount));
  const [enabled, setEnabled] = useState(savedEnabled);
  const [depts, setDepts] = useState<Set<string>>(() => new Set(savedDeptsArr));

  useEffect(() => {
    setAmount(String(savedAmount));
    setEnabled(savedEnabled);
    setDepts(new Set(savedDeptsArr));
    // Only reseed when the persisted snapshot changes — not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey]);

  const amountNum = Number(amount);
  const amountValid = amount.trim() !== '' && Number.isFinite(amountNum) && amountNum >= 0;
  const deptsKey = [...depts].sort().join(',');
  const dirty =
    amount !== String(savedAmount) || enabled !== savedEnabled || deptsKey !== savedDeptsKey;

  const toggleDept = (key: string) =>
    setDepts((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const save = () => {
    if (!amountValid || !dirty) return;
    onUpsert({
      code,
      label,
      amount: amountNum,
      currency: row?.currency ?? 'PHP',
      enabled,
      departmentKeys: [...depts],
    });
  };

  return (
    <Section icon={Award} title={label} subtitle={subtitle}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-end gap-4">
          <Field label={`Amount (${CURRENCY_SYMBOL.PHP})`}>
            <div className="flex items-center gap-1.5">
              <span className="text-sm text-zinc-400">{CURRENCY_SYMBOL.PHP}</span>
              <Input
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
                className="w-32"
              />
            </div>
          </Field>
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Status</span>
            <div className="inline-flex rounded-md border border-zinc-200 p-0.5 dark:border-zinc-800">
              {([
                { on: true, label: 'Enabled' },
                { on: false, label: 'Disabled' },
              ] as const).map((o) => (
                <button
                  key={o.label}
                  type="button"
                  onClick={() => setEnabled(o.on)}
                  className={`relative rounded px-2.5 py-1 text-xs font-semibold transition-colors ${
                    enabled === o.on
                      ? 'text-white'
                      : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
                  }`}
                >
                  {enabled === o.on && (
                    <motion.span
                      layoutId={`sysEnabledPill-${code}`}
                      className={`absolute inset-0 rounded ${o.on ? 'bg-emerald-500' : 'bg-zinc-400 dark:bg-zinc-600'}`}
                      transition={{ type: 'spring', stiffness: 500, damping: 34 }}
                    />
                  )}
                  <span className="relative z-10">{o.label}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        <div>
          <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
              Paid to{' '}
              <span className="font-semibold text-zinc-800 dark:text-zinc-200">
                {depts.size}
              </span>{' '}
              of {deptOptions.length} departments
            </span>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setDepts(new Set(deptOptions.map((d) => d.key)))}
                className="rounded px-1.5 py-0.5 text-[11px] font-medium text-orange-600 hover:bg-orange-50 dark:text-orange-400 dark:hover:bg-blue-950/30"
              >
                Select all
              </button>
              <button
                type="button"
                onClick={() => setDepts(new Set())}
                className="rounded px-1.5 py-0.5 text-[11px] font-medium text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
              >
                Clear
              </button>
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {deptOptions.map((d) => {
              const on = depts.has(d.key);
              return (
                <button
                  key={d.key}
                  type="button"
                  onClick={() => toggleDept(d.key)}
                  className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ring-1 transition-colors ${
                    on
                      ? 'bg-emerald-100 text-emerald-700 ring-emerald-400/40 hover:bg-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-500/30'
                      : 'bg-white text-zinc-500 ring-zinc-200 hover:bg-zinc-50 dark:bg-zinc-900 dark:text-zinc-500 dark:ring-zinc-700'
                  }`}
                >
                  {on && <Check className="h-3 w-3" />}
                  {d.name}
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            disabled={!amountValid || !dirty}
            onClick={save}
            className="bg-orange-500 text-white hover:bg-orange-600"
          >
            Save changes
          </Button>
          {dirty && <span className="text-xs text-amber-600 dark:text-amber-400">Unsaved changes</span>}
          {!dirty && row && (
            <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="h-3.5 w-3.5" /> Saved
            </span>
          )}
        </div>
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Pay Structure tab -- authoritative Regular + OT rates (source of truth for
// onboarding), per department ("common") or per individual.
// ---------------------------------------------------------------------------

/** Animated PHP / USD / COP segmented toggle. */
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
      {PAY_CURRENCIES.map((c) => (
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
            {currencyChipLabel(c)}
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
  compIndexes,
  extraDepartments,
  focusDept,
  onUpsert,
  onDelete,
}: {
  structures: PayStructure[];
  roster: RosterEntry[];
  /** Shared engine-mirroring lookups — the member list resolves each person's
   *  effective rate through `computePersonComp`, exactly as the Search tab does. */
  compIndexes: PersonCompIndexes;
  /** Custom departments created from the Department tab ({key, name}). */
  extraDepartments: { key: string; name: string }[];
  /** When set, the rail opens focused on this department key. */
  focusDept?: string | null;
  onUpsert: (s: PayStructure, effectiveDate?: string) => void;
  onDelete: (id: string) => void;
}) {
  // Built-in payroll departments first, then the HSL sub-teams, then the custom
  // ones (already A-Z).
  //
  // HSL sub-teams each carry their OWN base rate under the canonical
  // `hsl:<key>` department key — the same string the master Department cell
  // holds — which `resolveDeptCatalogRate` resolves BEFORE collapsing to the
  // `hogan_smith_law` parent. Without these rail entries there is no way to set
  // a sub-team rate at all, so every sub-labeled person silently rides the
  // parent base. Listed right after the built-ins so they read as sitting under
  // Hogan Smith Law.
  //
  // NOTE: deliberately NOT added to the Bonus Assignments rail — HSL
  // dept-scoped bonuses stay keyed on the parent `hogan_smith_law`, and
  // splitting them per sub-team would stop them reaching anyone.
  const allDepts = useMemo(
    () => [
      ...DEPARTMENTS.map((d) => ({ key: d.key, name: d.name })),
      ...hslSubDeptOptions().map((o) => ({ key: o.value, name: o.label })),
      ...extraDepartments,
    ],
    [extraDepartments],
  );

  const [selectedDept, setSelectedDept] = useState<string>(
    () => focusDept ?? DEPARTMENTS[0]?.key ?? '',
  );
  const [deptSearch, setDeptSearch] = useState('');
  const [editingDept, setEditingDept] = useState(false);

  // Set by a member row's "Set rate" so the adder below opens on that person —
  // the hand-off is the whole reason the member list needs no write path of its own.
  const [addingFor, setAddingFor] = useState<string | null>(null);

  // Where each person sits right now — by every alias, and by NAME for a structure
  // keyed on an address the roster row does not carry (ambiguous names are dropped).
  const owners = useMemo(() => buildStructureOwnerIndex(roster), [roster]);

  // Follow cross-tab focus requests (e.g. a Department card's "Pay structure").
  useEffect(() => {
    if (focusDept) setSelectedDept(focusDept);
  }, [focusDept]);

  // The rail entries, plus the bucket for people no department claims. The
  // sentinel is appended LAST and deliberately carries no rate slot — it is not a
  // department, it is the proof that nobody was hidden.
  const railEntries = useMemo<DeptRailEntry[]>(
    () => [...allDepts, { key: RAIL_NO_DEPARTMENT_KEY, name: RAIL_NO_DEPARTMENT_NAME }],
    [allDepts],
  );
  const rail = useMemo(() => buildDeptRail(railEntries), [railEntries]);

  // Every roster person to exactly ONE entry. A sub-team beats its parent, which
  // is why "Hogan Smith Law" no longer lists its whole 565-person family.
  const membersByDept = useMemo(() => assignRosterToRail(roster, rail), [roster, rail]);
  const members = useMemo(() => membersByDept.get(selectedDept) ?? [], [membersByDept, selectedDept]);

  // Two counts per entry: individual structures on file (the badge this rail has
  // always shown) and headcount. A collapsed parent rolls its children up, or
  // "Hogan Smith Law" reads 0 while hiding a 186-person team.
  const structureCounts = useMemo(() => {
    const own = new Map<string, number>();
    for (const s of structures) {
      if (s.scope !== 'employee') continue;
      const key = homeKeyForStructure(s, owners, rail);
      own.set(key, (own.get(key) ?? 0) + 1);
    }
    return rollUpCounts(own, rail);
  }, [structures, owners, rail]);
  const headcounts = useMemo(() => rollUpCounts(bucketSizes(membersByDept), rail), [membersByDept, rail]);

  // A group opens when the user toggles it, when the selected department is one of
  // its children, or when the search text matches a child — otherwise a
  // child-only match would vanish behind a closed parent.
  // Tri-state on purpose: absent = follow the auto-open rule, true/false = the user
  // has spoken and wins. A plain "open" Set made the chevron DEAD while one of the
  // group's children was selected — it rendered aria-expanded and a "Collapse"
  // tooltip while doing nothing, because the auto-open rule was an unconditional OR.
  const [groupOpen, setGroupOpen] = useState<Map<string, boolean>>(new Map());
  const query = deptSearch.trim().toLowerCase();
  const filteredRail = useMemo(() => {
    if (!query) return rail;
    return rail
      .map((g) => {
        const parentHit = g.parent.name.toLowerCase().includes(query);
        const kids = g.children.filter((c) => c.name.toLowerCase().includes(query));
        if (parentHit) return { parent: g.parent, children: g.children };
        if (kids.length > 0) return { parent: g.parent, children: kids };
        return null;
      })
      .filter((g): g is NonNullable<typeof g> => g !== null);
  }, [rail, query]);
  const parentOfSelected = useMemo(
    () => parentOfDeptKey(selectedDept, new Set(rail.map((g) => g.parent.key))),
    [selectedDept, rail],
  );
  const isGroupOpen = useCallback(
    (parentKey: string) => {
      // A search force-opens everything; the chevron says so by disabling itself.
      if (query) return true;
      const explicit = groupOpen.get(parentKey);
      if (explicit !== undefined) return explicit;
      return parentOfSelected === parentKey;
    },
    [query, groupOpen, parentOfSelected],
  );

  const dept = railEntries.find((d) => d.key === selectedDept) ?? allDepts[0];
  /** Set only when the SELECTED entry is a parent — i.e. it has children below it. */
  const selectedGroup = useMemo(
    () => rail.find((g) => g.parent.key === selectedDept) ?? null,
    [rail, selectedDept],
  );
  const isNoDeptBucket = selectedDept === RAIL_NO_DEPARTMENT_KEY;

  const deptStructure = structures.find(
    (s) => s.scope === 'department' && s.departmentKey === selectedDept,
  );

  // Individual structures are shown under the person's CURRENT placement, not the
  // key the row happens to be stored under (Kane 2026-08-21: "Baldonebro has a
  // subdepartment of her own so she shouldn't have appeared under hogan smith
  // law"). `normalizeDeptToKey` collapses every `hsl:*` cell to
  // `hogan_smith_law`, and that is the key the Search person card writes, so 65 of
  // the 124 rows filed on the parent belong to people who are really on a
  // sub-team. Re-homing is DISPLAY ONLY and self-heals on transfer; `onUpsert`
  // still files under `selectedDept`. Someone off the roster keeps their stored
  // key so their row never disappears.
  const individualForDept = useMemo(
    () =>
      structures.filter(
        (s) =>
          s.scope === 'employee' &&
          homeKeyForStructure(s, owners, rail) === selectedDept,
      ),
    [structures, owners, rail, selectedDept],
  );

  /**
   * Everyone who already carries an individual structure ANYWHERE.
   *
   * This — not the department-local set — is what both the member list and the
   * ADDER gate on, and getting that wrong is a money bug. The adder writes under
   * `selectedDept`, and the DB's real uniqueness is `(department_key, email)`, so a
   * department-local guard computed in RE-HOMED space stops covering the write: with
   * Hogan Smith Law selected, the 65 people whose rows are stored on the parent but
   * render under a sub-team drop out of the local set, are re-offered by the picker
   * with a BLANK editor, and saving resolves to their existing row and UPDATES it —
   * then `syncRateHistory` pushes that into `employee_rate_history`,
   * `employee_hourly_rates` and the Google rates sheet. Their real rate, overwritten
   * from an empty form.
   *
   * Keyed across every alias, because a structure can be filed under a personal or
   * alternate address (Baldonebro's stale row is a third identity) and one person
   * must never end up with two employee-scope rows.
   */
  const overriddenEmails = useMemo(() => {
    const set = new Set<string>();
    for (const st of structures) {
      if (st.scope !== 'employee') continue;
      const em = (st.employeeEmail ?? '').trim().toLowerCase();
      if (!em) continue;
      set.add(em);
      // Fold in the owner's other addresses so the guard holds whichever one a
      // picker or a member row happens to key on.
      for (const alias of owners.aliasesFor(em)) set.add(alias);
    }
    return set;
  }, [structures, owners]);

  // Clear a pending "Set rate" hand-off when the department changes, so the adder
  // never opens on someone who is no longer on screen.
  useEffect(() => {
    setAddingFor(null);
  }, [selectedDept]);

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
          {filteredRail.map((group) => {
            const open = isGroupOpen(group.parent.key);
            const hasKids = group.children.length > 0;
            return (
              <div key={group.parent.key}>
                <DeptRailRow
                  entry={group.parent}
                  selected={selectedDept === group.parent.key}
                  hasDeptRate={structures.some(
                    (x) => x.scope === 'department' && x.departmentKey === group.parent.key,
                  )}
                  structureCount={structureCounts.get(group.parent.key) ?? 0}
                  headcount={headcounts.get(group.parent.key) ?? 0}
                  onSelect={() => setSelectedDept(group.parent.key)}
                  disclosure={
                    hasKids
                      ? {
                          open,
                          // The search box force-opens every group, so the chevron
                          // is inert while a query is active rather than lying
                          // about a state it cannot change.
                          locked: query !== '',
                          onToggle: () =>
                            setGroupOpen((prev) => {
                              const next = new Map(prev);
                              // Write the negation of what is CURRENTLY shown, so the
                              // first click always visibly does something even when
                              // the auto-open rule put the group open.
                              next.set(group.parent.key, !open);
                              return next;
                            }),
                          childCount: group.children.length,
                        }
                      : undefined
                  }
                />
                {hasKids && (
                  <Expand show={open}>
                    <div className="ml-3 border-l border-zinc-200 pl-1.5 dark:border-zinc-800">
                      {group.children.map((c) => (
                        <DeptRailRow
                          key={c.key}
                          entry={c}
                          nested
                          selected={selectedDept === c.key}
                          hasDeptRate={structures.some(
                            (x) => x.scope === 'department' && x.departmentKey === c.key,
                          )}
                          structureCount={structureCounts.get(c.key) ?? 0}
                          headcount={headcounts.get(c.key) ?? 0}
                          onSelect={() => setSelectedDept(c.key)}
                        />
                      ))}
                    </div>
                  </Expand>
                )}
              </div>
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
            options={rail.flatMap((g) => [
              { value: g.parent.key, label: g.parent.name },
              // Indented rather than nested: AnimatedSelect is a flat list, and
              // dropping the children would make 565 people unreachable on mobile.
              ...g.children.map((c) => ({ value: c.key, label: `\u00A0\u00A0\u00A0${c.name}` })),
            ])}
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

        {/* Department-wide pay structure.
            Hidden for the "No department" bucket: it is not a department, and a rate
            saved there would file `department_key='@no_department'` into the rate
            source of truth, where nothing resolves it and nobody would ever find it
            again. The sentinel is documented as carrying no rate slot; this is the
            code that actually enforces it. */}
        {!isNoDeptBucket && (
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
        )}

        {/* Members of this department */}
        <Section
          icon={Users}
          title={isNoDeptBucket ? 'People no department claims' : 'Members'}
          subtitle={
            isNoDeptBucket
              ? 'Their master Department cell resolves to no department here. Rate rows for people who have left the roster land here too, so nothing is hidden.'
              : 'Everyone placed here, with the rate the engine actually pays them.'
          }
        >
          <DeptMemberList
            members={members}
            compIndexes={compIndexes}
            overriddenEmails={overriddenEmails}
            onSetRate={setAddingFor}
            subTeams={
              // A parent's own bucket is empty by design once everyone is placed on a
              // sub-team, so a flat "nobody is placed here" would flatly contradict
              // the 546 on its own badge. Hand the children over and let the empty
              // state say what is actually true, with a way to get there.
              selectedGroup && selectedGroup.children.length > 0
                ? selectedGroup.children.map((c) => ({
                    key: c.key,
                    name: stripHslPrefix(c.name),
                    count: headcounts.get(c.key) ?? 0,
                  }))
                : undefined
            }
            onPickSubTeam={setSelectedDept}
          />
        </Section>

        {/* Individual overrides. The adder is hidden for the "No department" bucket
            for the same reason as the department rate: `departmentKey` would be the
            sentinel. Existing rows still RENDER here — that is the whole point of the
            bucket — they just cannot be created here. */}
        <Section
          icon={Users}
          title="Individual pay structure"
          subtitle={
            isNoDeptBucket
              ? 'Rows that belong to people the rail cannot place. Editable here; new ones are added from a real department.'
              : 'Override the department default for a specific person.'
          }
        >
          {!isNoDeptBucket && (
          <IndividualPayAdder
            roster={roster}
            deptKey={selectedDept}
            deptName={dept?.name ?? ''}
            preselectEmail={addingFor}
            onPreselectConsumed={() => setAddingFor(null)}
            // The ALL-SCOPE set, never the department-local one: the write files
            // under `selectedDept` and the DB is unique on (department_key, email),
            // so a guard computed in re-homed space would let the picker re-offer
            // someone whose row already occupies that slot — and the save would
            // overwrite their live rate from a blank editor.
            existingEmails={overriddenEmails}
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
          )}
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

/**
 * One row of the Pay Structure department rail.
 *
 * A parent row does TWO things and there is no precedent for it in this codebase:
 * the chevron discloses its children, the label selects the department (the parent
 * has its own rate slot, so it must stay selectable). They are therefore separate
 * hit targets — nesting a button inside a button is invalid HTML, so the row is a
 * flex container holding two siblings, never one wrapping the other.
 */
function DeptRailRow({
  entry,
  selected,
  hasDeptRate,
  structureCount,
  headcount,
  onSelect,
  nested = false,
  disclosure,
}: {
  entry: DeptRailEntry;
  selected: boolean;
  hasDeptRate: boolean;
  /** Individual pay structures homed here (own + children when collapsed). */
  structureCount: number;
  /** People placed here (own + children when collapsed). */
  headcount: number;
  onSelect: () => void;
  nested?: boolean;
  disclosure?: { open: boolean; locked: boolean; onToggle: () => void; childCount: number };
}) {
  return (
    <div
      className={`flex items-center rounded-md transition-colors ${
        selected
          ? 'bg-orange-100 text-orange-900 dark:bg-blue-950/60 dark:text-white'
          : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-900'
      }`}
    >
      {disclosure ? (
        <button
          type="button"
          onClick={disclosure.onToggle}
          disabled={disclosure.locked}
          aria-expanded={disclosure.open}
          aria-label={`${disclosure.open ? 'Collapse' : 'Expand'} ${entry.name} sub-departments`}
          // Navigation, not mutation: a view-only accountant must still be able to
          // reach the 16 sub-teams, so this is carved out of ReadOnlyTab (the
          // "Set rate" button and every rate editor deliberately are NOT).
          data-readonly-allow
          title={
            disclosure.locked
              ? 'Groups stay open while searching'
              : `${disclosure.open ? 'Hide' : 'Show'} ${disclosure.childCount} sub-departments`
          }
          className="shrink-0 rounded-md py-2 pl-1.5 pr-0.5 text-zinc-400 transition-colors hover:text-zinc-700 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-orange-500 disabled:opacity-40 dark:hover:text-zinc-200 dark:focus-visible:ring-blue-400"
        >
          <ChevronRight
            className={`h-3.5 w-3.5 transition-transform duration-200 ${disclosure.open ? 'rotate-90' : ''}`}
          />
        </button>
      ) : (
        <span className={nested ? 'w-1.5' : 'w-[22px]'} aria-hidden />
      )}
      <button
        type="button"
        onClick={onSelect}
        data-readonly-allow
        className={`flex min-w-0 flex-1 items-center justify-between py-2 pr-2.5 text-left text-sm focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-orange-500 dark:focus-visible:ring-blue-400 ${
          selected ? 'font-medium' : ''
        } ${disclosure ? 'pl-0.5' : 'pl-1'}`}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          {hasDeptRate && (
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500"
              title="Department rate set"
            />
          )}
          <span className="truncate">{nested ? stripHslPrefix(entry.name) : entry.name}</span>
        </span>
        <span className="ml-1 flex shrink-0 items-center gap-1">
          {headcount > 0 && (
            <span
              className="rounded-full bg-zinc-200/80 px-1.5 text-[10px] font-semibold tabular-nums text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
              title={`${headcount} ${headcount === 1 ? 'person' : 'people'}`}
            >
              {headcount}
            </span>
          )}
          {structureCount > 0 && (
            <span
              className="rounded-full bg-orange-200/70 px-1.5 text-[10px] font-bold tabular-nums text-orange-800 dark:bg-blue-900/60 dark:text-blue-200"
              title={`${structureCount} individual pay ${structureCount === 1 ? 'structure' : 'structures'}`}
            >
              {structureCount}
            </span>
          )}
        </span>
      </button>
    </div>
  );
}

/** `HSL — Intake Specialist` reads as `Intake Specialist` once it sits visibly
 *  under Hogan Smith Law. The em dash form stays canonical everywhere else
 *  (`formatDeptLabel`), so this is presentation-local and never a value. */
function stripHslPrefix(name: string): string {
  const m = /^HSL\s+[\u2013\u2014-]\s+(.+)$/.exec(name.trim());
  return m ? m[1] : name;
}

/**
 * The department's people, with the rate the ENGINE pays each of them.
 *
 * Read-only by design (Kane's call, 2026-08-21). The rate chip resolves through
 * `computePersonComp` + `winningRate`, the same call the Search tab makes, because
 * the Payment Catalog is the rate source of truth and a naive
 * `override ?? deptBase` here would misstate pay for every sheet-rated person —
 * most tenured staff — and invite an accountant to "confirm" a department base into
 * an individual override that silently beats their sheet rate. That finding is why
 * `computePersonComp` exists (see bonus-catalog.md, Search tab).
 *
 * "Set rate" writes nothing itself; it hands the email to the adder already on this
 * tab, so there is exactly one write path and exactly one place the amber
 * sheet-override warning has to live.
 */
function DeptMemberList({
  members,
  compIndexes,
  overriddenEmails,
  onSetRate,
  subTeams,
  onPickSubTeam,
}: {
  members: RosterEntry[];
  compIndexes: PersonCompIndexes;
  overriddenEmails: ReadonlySet<string>;
  onSetRate: (email: string) => void;
  /** Set when the selected entry is a PARENT — its children and their headcounts, so
   *  an empty own-bucket can explain itself instead of denying the rolled-up badge. */
  subTeams?: { key: string; name: string; count: number }[];
  onPickSubTeam?: (key: string) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const PAGE = 25;

  const rows = useMemo(
    () =>
      members.map((m) => {
        const comp = computePersonComp(m, compIndexes);
        return { person: m, rate: winningRate(comp) };
      }),
    [members, compIndexes],
  );

  if (members.length === 0) {
    const viaSubTeams = (subTeams ?? []).filter((t) => t.count > 0);
    const total = viaSubTeams.reduce((n, t) => n + t.count, 0);
    if (total === 0) {
      return <p className="text-sm text-zinc-400">Nobody is placed in this department.</p>;
    }
    // The badge on this row says `total`. Saying "nobody is placed here" beside it
    // would be a flat contradiction, so say the true thing and offer the way in.
    return (
      <div>
        <p className="mb-2 text-sm text-zinc-500 dark:text-zinc-400">
          Nobody sits on this department directly —{' '}
          <span className="font-semibold text-zinc-700 dark:text-zinc-200">{total.toLocaleString()}</span>{' '}
          {total === 1 ? 'person is' : 'people are'} on its {viaSubTeams.length} sub-departments.
        </p>
        <div className="flex flex-wrap gap-1.5">
          {viaSubTeams.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => onPickSubTeam?.(t.key)}
              data-readonly-allow
              className="inline-flex items-center gap-1.5 rounded-full border border-zinc-200 px-2.5 py-1 text-xs text-zinc-600 transition-colors hover:border-orange-300 hover:bg-orange-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-orange-500 dark:border-zinc-700 dark:text-zinc-300 dark:hover:border-blue-800 dark:hover:bg-blue-950/40 dark:focus-visible:ring-blue-400"
            >
              {t.name}
              <span className="rounded-full bg-zinc-100 px-1.5 text-[10px] font-semibold tabular-nums text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                {t.count}
              </span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  const shown = showAll ? rows : rows.slice(0, PAGE);
  const noRate = rows.filter((r) => r.rate === null).length;

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-500 dark:text-zinc-400">
        <span>
          <span className="font-semibold tabular-nums text-zinc-700 dark:text-zinc-200">
            {members.length.toLocaleString()}
          </span>{' '}
          {members.length === 1 ? 'person' : 'people'}
        </span>
        {noRate > 0 && (
          <span className="text-amber-600 dark:text-amber-400">
            {noRate} with no rate anywhere
          </span>
        )}
      </div>
      <div className="divide-y divide-zinc-100 overflow-hidden rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
        {shown.map(({ person, rate }) => (
          <div key={person.email} className="flex items-center gap-2 px-3 py-2">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm text-zinc-800 dark:text-zinc-100">{person.name}</span>
              <span className="block truncate text-[11px] text-zinc-400">{person.email}</span>
            </span>
            <RateSourceChip rate={rate} />
            {![person.email, ...person.aliases].some((e) => overriddenEmails.has(e)) && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => onSetRate(person.email)}
                // Mutating control: deliberately NO data-readonly-allow, so a
                // view-only accountant's click is swallowed by ReadOnlyTab.
                className="shrink-0 gap-1 text-[11px]"
              >
                <Pencil className="h-3 w-3" />
                Set rate
              </Button>
            )}
          </div>
        ))}
      </div>
      {rows.length > PAGE && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          data-readonly-allow
          className="mt-2 text-xs font-medium text-orange-600 hover:underline dark:text-blue-400"
        >
          {showAll ? 'Show fewer' : `Show all ${rows.length.toLocaleString()}`}
        </button>
      )}
    </div>
  );
}

/** The effective-rate chip, in the Search tab's vocabulary: emerald individual,
 *  plain "(sheet)", muted "(dept)", amber when nothing resolves. Same four states,
 *  same order of precedence, so the two surfaces can never read differently. */
function RateSourceChip({ rate }: { rate: ReturnType<typeof winningRate> }) {
  if (!rate) {
    return (
      <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:bg-amber-950/50 dark:text-amber-300">
        No rate set
      </span>
    );
  }
  const label = formatRate(rate.regular, rate.currency);
  if (rate.source === 'individual') {
    return (
      <span className="shrink-0 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300">
        {label}
      </span>
    );
  }
  return (
    <span className="shrink-0 rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium tabular-nums text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
      {label} <span className="text-zinc-400">({rate.source === 'sheet' ? 'sheet' : 'dept'})</span>
    </span>
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
  preselectEmail,
  onPreselectConsumed,
  deptKey,
  deptName,
  existingEmails,
  onAdd,
}: {
  roster: RosterEntry[];
  deptKey: string;
  deptName: string;
  existingEmails: Set<string>;
  /** Email handed over by a member row's "Set rate" — opens the picker on that
   *  person so the member list needs no write path of its own. */
  preselectEmail?: string | null;
  onPreselectConsumed?: () => void;
  onAdd: (emp: RosterEntry, regular: number, ot: number | undefined, currency: PayCurrency, effectiveDate: string) => void;
}) {
  const [empEmail, setEmpEmail] = useState('');
  const [open, setOpen] = useState(false);
  const [filterByDept, setFilterByDept] = useState(true);
  const [effectiveDate, setEffectiveDate] = useState<string>(nextMondayIso);

  // A member row's "Set rate" hands its email over here.
  //
  // The dept filter is deliberately NOT touched. Turning it off would leave it off
  // for every later manual add on the tab — a silent mode change from one click. The
  // preselected person is admitted to `list` explicitly instead (see below), which
  // covers the case the filter would have hidden: a re-homed member sitting under a
  // sub-team while the adder is scoped to the parent.
  useEffect(() => {
    const em = (preselectEmail ?? '').trim().toLowerCase();
    if (!em) return;
    setEmpEmail(em);
    onPreselectConsumed?.();
  }, [preselectEmail, onPreselectConsumed]);

  const deptMatched = useMemo(() => {
    // Built-in departments match via the alias map; custom (Department-tab)
    // departments have no alias entry, so fall back to the exact label match.
    // Namespaced sub-teams (hsl:<key>, <parent>:<sub>) need the RAW cell match:
    // normalizeDeptToKey collapses `hsl:collections` to the parent
    // `hogan_smith_law` (≠ the selected key), and the display name
    // ("HSL — Collections") never equals the cell — so without this clause a
    // sub-team's own people read "no employees found" while the rest of the
    // catalog resolves them fine.
    const nameKey = deptName.trim().toLowerCase();
    const rawKey = deptKey.trim().toLowerCase();
    return roster.filter((r) => {
      const cell = r.department.trim().toLowerCase();
      return (
        normalizeDeptToKey(r.department) === deptKey ||
        cell === rawKey ||
        (nameKey !== '' && cell === nameKey)
      );
    });
  }, [roster, deptKey, deptName]);
  const list = useMemo(() => {
    const base = filterByDept ? deptMatched : roster;
    const filtered = base.filter((r) => !existingEmails.has(r.email.toLowerCase()));
    // A handed-over person is admitted even when the dept filter would hide them,
    // so the picker is never empty right after a "Set rate" click.
    if (empEmail && !filtered.some((r) => r.email === empEmail)) {
      const handed = roster.find((r) => r.email === empEmail);
      if (handed) return [handed, ...filtered];
    }
    return filtered;
  }, [roster, deptMatched, existingEmails, filterByDept, empEmail]);

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
            hint: r.department ? `(${formatDeptLabel(r.department)})` : undefined,
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
                  <DatePicker
                    value={effectiveDate}
                    onChange={setEffectiveDate}
                    required
                    containerClassName="w-40"
                    className="h-9 text-sm font-medium tabular-nums focus-visible:border-emerald-500 focus-visible:ring-emerald-500/20 dark:bg-zinc-900"
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

/** Rows per rate-history page — sized so the panel stays compact next to the
 *  rate editor even for people with long histories. */
const RATE_HISTORY_PAGE_SIZE = 5;

function RateHistoryPanel({ email, refreshKey = 0 }: { email: string; refreshKey?: number }) {
  const [rows, setRows] = useState<RawHistoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);

  useEffect(() => {
    if (!email) return;
    setLoading(true);
    setPage(0);
    fetch(`/api/employee-rate-history?email=${encodeURIComponent(email)}`)
      .then((r) => r.json())
      .then((json: { rows?: RawHistoryRow[] }) => setRows(json.rows ?? []))
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, [email, refreshKey]);

  const pageCount = Math.max(1, Math.ceil(rows.length / RATE_HISTORY_PAGE_SIZE));
  const start = page * RATE_HISTORY_PAGE_SIZE;
  const pageRows = rows.slice(start, start + RATE_HISTORY_PAGE_SIZE);

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
        <>
          <div className="space-y-1.5">
            {pageRows.map((r, i) => {
              // "current" = newest row overall, not the first row of every page.
              const isCurrent = start + i === 0;
              return (
                <div
                  key={start + i}
                  className={`rounded border px-2.5 py-1.5 text-xs ${
                    isCurrent
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
                    {isCurrent && (
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
              );
            })}
          </div>
          {pageCount > 1 && (
            // Pagination is read-only navigation — stays live for view-only users.
            <div data-readonly-allow className="mt-2 flex items-center justify-between">
              <button
                type="button"
                aria-label="Newer rates"
                disabled={page === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                className="rounded p-1 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-600 disabled:opacity-30 disabled:hover:bg-transparent dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </button>
              <span className="text-[10px] tabular-nums text-zinc-400">
                {page + 1} / {pageCount}
              </span>
              <button
                type="button"
                aria-label="Older rates"
                disabled={page >= pageCount - 1}
                onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                className="rounded p-1 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-600 disabled:opacity-30 disabled:hover:bg-transparent dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
        </>
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
                <DatePicker
                  value={effectiveDate}
                  onChange={setEffectiveDate}
                  required
                  containerClassName="w-40"
                  className="h-9 text-sm font-medium tabular-nums focus-visible:border-emerald-500 focus-visible:ring-emerald-500/20 dark:bg-zinc-900"
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
  fx,
}: {
  bonuses: BonusDef[];
  assignments: BonusAssignment[];
  onUpsert: (b: BonusDef) => void;
  onDelete: (id: string) => void;
  /** Live USD-anchored FX rates, used to sort by PHP-equivalent amount. */
  fx: FxRates;
}) {
  const [editing, setEditing] = useState<BonusDef | null>(null);
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<'name' | 'newest' | 'oldest' | 'amount'>('name');
  const [page, setPage] = useState(0);
  /**
   * The open detail modal: which bonus, and whether it opened straight into edit
   * mode (the card's Edit button) or view mode (View). The modal's View<->Edit
   * toggle is controlled from here, so there is still exactly ONE editor and one
   * save path — the button changes which side of the toggle you land on, nothing
   * else.
   */
  const [viewing, setViewing] = useState<{ id: string; edit: boolean } | null>(null);

  // Keep the open modal in sync with the latest bonus row (so edits show live).
  const viewingBonus = useMemo(
    () => (viewing ? bonuses.find((b) => b.id === viewing.id) ?? null : null),
    [viewing, bonuses],
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
    // PHP-equivalent so the highest-PAYING bonus sorts first regardless of
    // currency (a $100 bonus outranks a ₱500 one). Formula bonuses have no flat
    // amount, so they sort last (sentinel -1).
    const phpEquiv = (b: BonusDef) =>
      b.amount == null ? -1 : b.amount * phpPerUnit(b.currency ?? 'PHP', fx);
    switch (sort) {
      case 'newest':
        list.sort((a, b) => ts(b) - ts(a));
        break;
      case 'oldest':
        list.sort((a, b) => ts(a) - ts(b));
        break;
      case 'amount':
        list.sort((a, b) => phpEquiv(b) - phpEquiv(a));
        break;
      case 'name':
      default:
        list.sort((a, b) =>
          (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }),
        );
    }
    // Highlighted ("starred") bonuses always float to the top, preserving the
    // chosen order within each group.
    return [...list.filter((b) => b.starred), ...list.filter((b) => !b.starred)];
  }, [filteredBonuses, sort, fx]);

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
    setEditing({ id: newId('bonus'), name: '', kind: 'flat', amount: 0, formula: '', currency: 'PHP' });
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
        {/* Search stays live even in a view-only tab (see ReadOnlyTab). */}
        <div className="relative min-w-0 flex-1" data-readonly-allow>
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
                  onView={() => setViewing({ id: b.id, edit: false })}
                  onEdit={() => setViewing({ id: b.id, edit: true })}
                  onDelete={() => remove(b.id)}
                  onToggleStar={() => onUpsert({ ...b, starred: !b.starred })}
                />
              </motion.div>
            ))}
          </AnimatePresence>
        </motion.div>

        {pageCount > 1 && (
          <div data-readonly-allow className="flex items-center justify-center gap-3 pt-1">
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
        editMode={!!viewing?.edit}
        onEditModeChange={(edit) => setViewing((v) => (v ? { ...v, edit } : v))}
        onClose={() => setViewing(null)}
        onSave={(b) => onUpsert(b)}
        onDelete={(id) => {
          remove(id);
          setViewing(null);
        }}
      />
    </div>
  );
}

function BonusCard({
  bonus,
  assignments,
  onView,
  onEdit,
  onDelete,
  onToggleStar,
}: {
  bonus: BonusDef;
  assignments: number;
  onView: () => void;
  /** Opens the same detail modal already flipped to Edit (no second editor). */
  onEdit: () => void;
  onDelete: () => void;
  onToggleStar: () => void;
}) {
  const starred = !!bonus.starred;
  return (
    <div
      className={`flex h-48 flex-col rounded-lg border bg-white p-4 shadow-sm dark:bg-zinc-950 ${
        starred
          ? 'border-amber-300 ring-1 ring-amber-300/60 dark:border-amber-500/40 dark:ring-amber-500/20'
          : 'border-zinc-200 dark:border-zinc-800'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">{bonus.name || 'Untitled'}</span>
            <KindBadge kind={bonus.kind} />
            <CurrencyBadge currency={bonus.currency} />
            <CadenceBadge cadence={bonus.cadence} />
          </div>
          {bonus.description && (
            <p className="mt-0.5 truncate text-xs text-zinc-500 dark:text-zinc-500">{bonus.description}</p>
          )}
        </div>
        <div className="flex shrink-0 gap-1">
          <button
            type="button"
            title={starred ? 'Remove highlight' : 'Highlight this bonus'}
            aria-label={starred ? 'Remove highlight' : 'Highlight this bonus'}
            aria-pressed={starred}
            onClick={onToggleStar}
            className={`rounded-md p-1.5 transition-colors ${
              starred
                ? 'text-amber-500 hover:bg-amber-50 dark:hover:bg-amber-950/30'
                : 'text-zinc-300 hover:bg-amber-50 hover:text-amber-500 dark:text-zinc-600 dark:hover:bg-amber-950/30'
            }`}
          >
            <Star className={`h-3.5 w-3.5 ${starred ? 'fill-amber-400' : ''}`} />
          </button>
          <IconButton title="View" onClick={onView}>
            <Eye className="h-3.5 w-3.5" />
          </IconButton>
          {/* Mutating control — deliberately NO data-readonly-allow, so a
              view-only accountant's click is swallowed by ReadOnlyTab. */}
          <IconButton title="Edit" onClick={onEdit}>
            <Pencil className="h-3.5 w-3.5" />
          </IconButton>
          <IconButton title="Delete" onClick={onDelete} danger>
            <Trash2 className="h-3.5 w-3.5" />
          </IconButton>
        </div>
      </div>

      {/* Body grows to fill; overflow is hidden so every card is the same height. */}
      <div className="mt-3 min-h-0 flex-1 overflow-hidden">
        {bonus.kind === 'flat' ? (
          <div className="text-lg font-bold text-emerald-600 dark:text-emerald-400">{money(bonus.amount ?? 0, bonus.currency)}</div>
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
  editMode,
  onEditModeChange,
  onClose,
  onSave,
  onDelete,
}: {
  bonus: BonusDef | null;
  assignments: number;
  /**
   * Controlled by the opener, so a card can open this straight into Edit. Kept as
   * a prop rather than local state on purpose: the bonus object identity changes
   * on every Realtime refetch, so any effect that re-derived edit mode from the
   * row would drop a teammate's refetch on top of an in-progress edit.
   */
  editMode: boolean;
  onEditModeChange: (v: boolean) => void;
  onClose: () => void;
  onSave: (b: BonusDef) => void;
  onDelete: (id: string) => void;
}) {
  const open = !!bonus;
  // Cache the last bonus so the panel keeps its content during the exit animation.
  const [cache, setCache] = useState<BonusDef | null>(bonus);

  useEffect(() => {
    if (bonus) setCache(bonus);
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
                  <CurrencyBadge currency={b.currency} />
                  <CadenceBadge cadence={b.cadence} />
                </div>
                {b.description && (
                  <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{b.description}</p>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <EditToggle on={editMode} onChange={onEditModeChange} />
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
                      // Keyed by bonus id: the panel can be reopened on a DIFFERENT
                      // bonus while the previous one is still exit-animating, and the
                      // editor seeds its fields from `initial` once at mount — without
                      // this, that reopen would save bonus A's typed values onto B.
                      // Identity-only changes (a Realtime refetch) keep the same id, so
                      // an in-progress edit is never clobbered.
                      key={b.id}
                      embedded
                      initial={b}
                      onCancel={() => onEditModeChange(false)}
                      onSave={(next) => {
                        onSave(next);
                        onEditModeChange(false);
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
                          {money(b.amount ?? 0, b.currency)}
                        </div>
                        {(b.currency ?? 'PHP') !== 'PHP' && (
                          <p className="mt-1 text-[11px] text-zinc-400">
                            Converted to PHP at the live rate when applied in the KPI Calculator.
                          </p>
                        )}
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
                        {b.kind === 'formula' && <InlineTester formula={b.formula ?? ''} currency={b.currency} />}
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
  const [currency, setCurrency] = useState<PayCurrency>(initial.currency ?? 'PHP');
  const [cadence, setCadence] = useState<BonusCadence>(initial.cadence ?? 'weekly');
  const [showCode, setShowCode] = useState(false);

  const formulaCheck = useMemo(() => (kind === 'formula' ? validateFormula(formula) : null), [kind, formula]);

  const draft: BonusDef = {
    ...initial,
    name: name.trim(),
    description: description.trim() || undefined,
    kind,
    cadence,
    amount: kind === 'flat' ? Number(amount) : undefined,
    formula: kind === 'formula' ? formula.trim() : undefined,
    currency,
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

      {/* Kind + currency toggles */}
      <div className="mt-3 flex flex-wrap items-start gap-x-8 gap-y-3">
        <div>
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
                    layoutId={`bonusKindPill-${initial.id}`}
                    className="absolute inset-0 rounded bg-orange-500"
                    transition={{ type: 'spring', stiffness: 500, damping: 34 }}
                  />
                )}
                <span className="relative z-10">{k === 'flat' ? 'Flat amount' : 'Formula'}</span>
              </button>
            ))}
          </div>
        </div>
        <div>
          <span className="mb-1.5 block text-xs font-medium text-zinc-600 dark:text-zinc-400">Currency</span>
          <CurrencyToggle value={currency} onChange={setCurrency} idSuffix={`bonus-${initial.id}`} />
          {currency !== 'PHP' && (
            <p className="mt-1 max-w-[15rem] text-[10.5px] leading-snug text-zinc-400">
              Converted to PHP at the live rate when applied in the KPI Calculator.
            </p>
          )}
        </div>
        <div>
          <span className="mb-1.5 block text-xs font-medium text-zinc-600 dark:text-zinc-400">Frequency</span>
          <div className="inline-flex rounded-md border border-zinc-200 p-0.5 dark:border-zinc-800">
            {(['weekly', 'monthly'] as const).map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setCadence(c)}
                className={`relative rounded px-3 py-1 text-xs font-medium capitalize transition-colors ${
                  cadence === c ? 'text-white' : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
                }`}
              >
                {cadence === c && (
                  <motion.span
                    layoutId={`bonusCadencePill-${initial.id}`}
                    className="absolute inset-0 rounded bg-orange-500"
                    transition={{ type: 'spring', stiffness: 500, damping: 34 }}
                  />
                )}
                <span className="relative z-10">{c}</span>
              </button>
            ))}
          </div>
          {cadence === 'monthly' && (
            <p className="mt-1 max-w-[15rem] text-[10.5px] leading-snug text-zinc-400">
              Paid once a month, on the last payroll week of the month.
            </p>
          )}
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
          <Field label={`Amount (${currencyChipLabel(currency)})`}>
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

          {formulaCheck?.ok && formulaCheck.variables.length > 0 && <InlineTester formula={formula} currency={currency} />}

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
function InlineTester({ formula, currency = 'PHP' }: { formula: string; currency?: PayCurrency }) {
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
            {result == null ? '-' : money(result, currency)}
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
  extraDepartments,
  onAdd,
  onRemove,
}: {
  bonuses: BonusDef[];
  assignments: BonusAssignment[];
  roster: RosterEntry[];
  /** Custom departments created from the Department tab ({key, name}). */
  extraDepartments: { key: string; name: string }[];
  onAdd: (a: BonusAssignment) => void;
  onRemove: (id: string) => void;
}) {
  const allDepts = useMemo(
    () => [
      ...DEPARTMENTS.map((d) => ({ key: d.key, name: d.name })),
      ...extraDepartments,
    ],
    [extraDepartments],
  );

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
    return allDepts.filter((d) => !q || d.name.toLowerCase().includes(q));
  }, [deptSearch, allDepts]);

  const dept = allDepts.find((d) => d.key === selectedDept) ?? allDepts[0];

  const commonForDept = assignments.filter(
    (a) => a.scope === 'department' && a.departmentKey === selectedDept,
  );
  const employeeForDept = assignments.filter(
    (a) => a.scope === 'employee' && a.departmentKey === selectedDept,
  );

  // Members of the selected department -- the pool a common bonus can exclude
  // from. Custom (Department-tab) departments have no alias-map entry, so fall
  // back to the exact label match (same rule as the Pay Structure tab).
  const deptRoster = useMemo(() => {
    const nameKey = (dept?.name ?? '').trim().toLowerCase();
    return roster.filter(
      (r) =>
        normalizeDeptToKey(r.department) === selectedDept ||
        (nameKey !== '' && r.department.trim().toLowerCase() === nameKey),
    );
  }, [roster, selectedDept, dept]);

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
            options={allDepts.map((d) => ({ value: d.key, label: d.name }))}
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
            hint: r.department ? `(${formatDeptLabel(r.department)})` : undefined,
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
          {bonus && <CurrencyBadge currency={bonus.currency} />}
          {bonus && <CadenceBadge cadence={bonus.cadence} />}
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-xs text-zinc-500">
          {who && <span className="truncate">{who}</span>}
          {bonus?.kind === 'flat' && (
            <span className="font-medium text-emerald-600 dark:text-emerald-400">{money(bonus.amount ?? 0, bonus.currency)}</span>
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
            {bonus && <CurrencyBadge currency={bonus.currency} />}
            {bonus && <CadenceBadge cadence={bonus.cadence} />}
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-xs text-zinc-500">
            {bonus?.kind === 'flat' && (
              <span className="font-medium text-emerald-600 dark:text-emerald-400">{money(bonus.amount ?? 0, bonus.currency)}</span>
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

// ---------------------------------------------------------------------------
// Search tab -- Google-style people lookup. Type a name to find anyone on the
// roster, then View or Edit their whole compensation picture in one place: the
// effective pay rate (individual catalog rate -> rates-sheet rate -> department
// base, exactly the engine's precedence), rate history, and every bonus that
// reaches them (personal, department-wide and system). All of it derives from
// state already on the client, so results update live with Realtime like the
// rest of the tabs.
// ---------------------------------------------------------------------------

// resolveRosterDeptKey / parseRateText / computePersonComp and the types below
// now live in @/lib/payment-catalog/person-comp so the server-side Certificate
// of Engagement renderer resolves rates and bonuses through the SAME code path
// as this tab — see the imports at the top of the file.

function SearchTab({
  payStructures,
  bonuses,
  assignments,
  systemBonuses,
  fx,
  roster,
  hourlyRates,
  compIndexes,
  customDepartments,
  onUpsertPay,
  onDeletePay,
  onAddAssignment,
  onRemoveAssignment,
}: {
  payStructures: PayStructure[];
  bonuses: BonusDef[];
  assignments: BonusAssignment[];
  systemBonuses: SystemBonus[];
  fx: FxRates;
  roster: RosterEntry[];
  /** The rates-sheet table (employee_hourly_rates) -- the engine's middle rate layer. */
  hourlyRates: EmployeeHourlyRateRow[];
  /** Shared engine-mirroring lookups, built once by the host tab. */
  compIndexes: PersonCompIndexes;
  /** Custom departments created from the Department tab ({key, name}). */
  customDepartments: { key: string; name: string }[];
  onUpsertPay: (s: PayStructure, effectiveDate?: string) => void;
  onDeletePay: (id: string) => void;
  onAddAssignment: (a: BonusAssignment) => void;
  onRemoveAssignment: (id: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [selectedEmail, setSelectedEmail] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);


  // Departments that actually exist in the catalog universe (built-in payroll
  // depts + Department-tab registry). Bonus assignments filed outside this set
  // would be invisible to every calculator and never pay.
  const knownDeptKeys = useMemo(
    () => new Set([...DEPARTMENTS.map((d) => d.key), ...customDepartments.map((d) => d.key)]),
    [customDepartments],
  );

  // Ranked substring match: name prefix beats a word prefix beats anywhere in
  // the name, then email and department matches. Capped so a one-letter query
  // stays a scannable list rather than the whole roster.
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const scored: { r: RosterEntry; score: number }[] = [];
    for (const r of roster) {
      const name = r.name.toLowerCase();
      let score: number | null = null;
      if (name.startsWith(q)) score = 0;
      else if (name.split(/\s+/).some((w) => w.startsWith(q))) score = 1;
      else if (name.includes(q)) score = 2;
      else if (r.email.toLowerCase().includes(q)) score = 3;
      else if (r.department.toLowerCase().includes(q)) score = 4;
      if (score != null) scored.push({ r, score });
    }
    scored.sort((a, b) => a.score - b.score || a.r.name.localeCompare(b.r.name));
    return scored.slice(0, 30).map((s) => s.r);
  }, [roster, query]);

  const selected = selectedEmail ? (roster.find((r) => r.email === selectedEmail) ?? null) : null;
  const selectedComp = selected ? computePersonComp(selected, compIndexes) : null;

  const open = (email: string, edit: boolean) => {
    setSelectedEmail(email);
    setEditing(edit);
  };

  return (
    <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col p-4 sm:p-6">
      <AnimatePresence mode="wait" initial={false}>
        {selected && selectedComp ? (
          <motion.div
            key={`person-${selected.email}`}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.2, ease: EASE }}
          >
            <PersonCompCard
              person={selected}
              comp={selectedComp}
              bonuses={bonuses}
              knownDeptKeys={knownDeptKeys}
              editing={editing}
              onEditingChange={setEditing}
              onBack={() => setSelectedEmail(null)}
              onUpsertPay={onUpsertPay}
              onDeletePay={onDeletePay}
              onAddAssignment={onAddAssignment}
              onRemoveAssignment={onRemoveAssignment}
            />
          </motion.div>
        ) : (
          <motion.div
            key="search"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.2, ease: EASE }}
            className="flex w-full grow flex-col"
          >
            {/* Google-style landing: the Simple wordmark over a vertically
                centered bar when idle; both glide to the top once a query is
                typed. Centering rides on the flex spacers around the hero.
                Only the top spacer animates: a pair both easing to zero keeps
                their ratio (and the hero) frozen until the very end. The navy
                wordmark disappears on dark surfaces, so dark mode renders it
                as a white silhouette (brightness-0 + invert). */}
            <div
              aria-hidden
              className={`shrink-0 transition-[flex-grow] duration-500 ease-out motion-reduce:transition-none ${
                query.trim() ? 'grow-0' : 'grow-[0.85]'
              }`}
            />
            <div className="mx-auto w-full max-w-xl">
              <div
                className={`flex justify-center transition-all duration-300 motion-reduce:transition-none ${
                  query.trim() ? 'mb-4' : 'mb-7'
                }`}
              >
                <img
                  src="/simple-logo.png"
                  alt="Simple"
                  draggable={false}
                  className={`select-none object-contain transition-all duration-300 motion-reduce:transition-none dark:brightness-0 dark:invert ${
                    query.trim() ? 'h-9' : 'h-16 sm:h-20'
                  }`}
                />
              </div>
              <div className="relative">
                <Search className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-zinc-400" />
                <input
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search anyone by name, email, or department..."
                  aria-label="Search employees"
                  className="w-full rounded-full border border-zinc-200 bg-white py-3.5 pl-12 pr-10 text-sm text-zinc-800 shadow-sm outline-none transition-shadow placeholder:text-zinc-400 hover:shadow-md focus:border-orange-300 focus:shadow-md dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:shadow-blue-950/40 dark:focus:border-blue-800"
                />
                {query && (
                  <button
                    type="button"
                    aria-label="Clear search"
                    data-readonly-allow
                    onClick={() => setQuery('')}
                    className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full p-1 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>
              {/* Fixed-height slot: the hint fades instead of unmounting, so
                  nothing below it jumps mid-glide. */}
              <div className="mt-3 h-4">
                <p
                  aria-hidden={!!query.trim()}
                  className={`text-center text-xs text-zinc-400 transition-opacity duration-300 motion-reduce:transition-none dark:text-zinc-500 ${
                    query.trim() ? 'opacity-0' : 'opacity-100'
                  }`}
                >
                  {roster.length.toLocaleString()} people on the roster &middot; view or edit anyone&apos;s
                  rates and bonuses
                </p>
              </div>
            </div>

            {query.trim() &&
              (results.length === 0 ? (
                <div className="mt-4">
                  <EmptyState
                    icon={Search}
                    title={`No one matches "${query.trim()}"`}
                    hint="Try a different spelling, or search by work email or department instead."
                  />
                </div>
              ) : (
                <div className="mt-2 space-y-2">
                  <AnimatePresence initial={false} mode="popLayout">
                    {results.map((r) => (
                      <motion.div
                        key={r.email}
                        layout
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.16, ease: EASE }}
                      >
                        <SearchResultRow
                          person={r}
                          comp={computePersonComp(r, compIndexes)}
                          onView={() => open(r.email, false)}
                          onEdit={() => open(r.email, true)}
                        />
                      </motion.div>
                    ))}
                  </AnimatePresence>
                </div>
              ))}
            {/* Fixed counterweight for the animated top spacer (see above). */}
            <div aria-hidden className="grow" />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function SearchResultRow({
  person,
  comp,
  onView,
  onEdit,
}: {
  person: RosterEntry;
  comp: PersonComp;
  onView: () => void;
  onEdit: () => void;
}) {
  // The chip shows the layer the engine actually pays from.
  const rateChip =
    comp.rateSource === 'individual' && comp.override
      ? {
          text: formatRate(comp.override.regularRate, comp.override.currency),
          suffix: '',
          title: 'Individual catalog rate — overrides the rates sheet and department default',
          own: true,
        }
      : comp.rateSource === 'sheet' && comp.sheetRate
        ? {
            text: formatRate(comp.sheetRate.reg, 'PHP'),
            suffix: ' (sheet)',
            title: 'Paid from the rates sheet',
            own: false,
          }
        : comp.rateSource === 'department' && comp.deptBase
          ? {
              text: formatRate(comp.deptBase.regularRate, comp.deptBase.currency),
              suffix: ' (dept)',
              title: 'Department default rate — no individual or sheet rate',
              own: false,
            }
          : null;
  const bonusCount =
    comp.employeeAssignments.length +
    comp.commonAssignments.filter((c) => !c.excluded).length +
    comp.systemRows.length;
  const initials = person.name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
  return (
    <div className="flex items-center gap-3 rounded-lg border border-zinc-200 bg-white px-3 py-2.5 dark:border-zinc-800 dark:bg-zinc-950">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-orange-100 text-xs font-bold text-orange-700 dark:bg-blue-950/60 dark:text-blue-300">
        {initials || '?'}
      </span>
      <div className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-zinc-800 dark:text-zinc-200">
          {person.name}
        </span>
        <span className="block truncate text-xs text-zinc-500">
          {formatDeptLabel(person.department) || 'No department'} &middot; {person.email}
        </span>
      </div>
      <div className="hidden shrink-0 items-center gap-1.5 md:flex">
        {rateChip ? (
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums ${
              rateChip.own
                ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
                : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300'
            }`}
            title={rateChip.title}
          >
            {rateChip.text}
            {rateChip.suffix}
          </span>
        ) : (
          <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
            No rate set
          </span>
        )}
        {bonusCount > 0 && (
          <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
            {bonusCount} {bonusCount === 1 ? 'bonus' : 'bonuses'}
          </span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {/* View is read-only navigation, so it stays live for view-only users. */}
        <Button type="button" size="sm" variant="outline" onClick={onView} className="gap-1" data-readonly-allow>
          <Eye className="h-3.5 w-3.5" />
          View
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={onEdit}
          className="gap-1 bg-orange-500 text-white hover:bg-orange-600"
        >
          <Pencil className="h-3.5 w-3.5" />
          Edit
        </Button>
      </div>
    </div>
  );
}

function PersonCompCard({
  person,
  comp,
  bonuses,
  knownDeptKeys,
  editing,
  onEditingChange,
  onBack,
  onUpsertPay,
  onDeletePay,
  onAddAssignment,
  onRemoveAssignment,
}: {
  person: RosterEntry;
  comp: PersonComp;
  bonuses: BonusDef[];
  /** Dept keys that exist in the catalog universe (built-in + registry). */
  knownDeptKeys: Set<string>;
  editing: boolean;
  onEditingChange: (v: boolean) => void;
  onBack: () => void;
  onUpsertPay: (s: PayStructure, effectiveDate?: string) => void;
  onDeletePay: (id: string) => void;
  onAddAssignment: (a: BonusAssignment) => void;
  onRemoveAssignment: (id: string) => void;
}) {
  const [effectiveDate, setEffectiveDate] = useState<string>(nextMondayIso);
  const [pickBonus, setPickBonus] = useState('');
  // Bumped (after a beat -- the POST writes history asynchronously via
  // `void syncRateHistory`) so the panel refetches after an in-card save.
  const [historyVersion, setHistoryVersion] = useState(0);
  const scheduleHistoryRefresh = () => {
    window.setTimeout(() => setHistoryVersion((v) => v + 1), 1500);
  };

  const bonusById = useMemo(() => {
    const m = new Map<string, BonusDef>();
    for (const b of bonuses) m.set(b.id, b);
    return m;
  }, [bonuses]);

  // Writes file under the person's CURRENT roster-resolved department -- the
  // dept key is load-bearing for bonus assignments (the manager calculator
  // groups strictly by it), so a stale override key must not win. 'unassigned'
  // only when everything fails: departmentKey is required, and an honest
  // bucket beats a fabricated dept.
  const writeDeptKey = comp.deptKey ?? comp.override?.departmentKey ?? 'unassigned';

  // What the engine currently pays, for the view stats and the edit prefill.
  const shownRate =
    comp.rateSource === 'individual' && comp.override
      ? {
          reg: comp.override.regularRate as number | null,
          ot: comp.override.otRate ?? null,
          currency: comp.override.currency,
          by: comp.override.updatedBy ?? comp.override.createdBy,
        }
      : comp.rateSource === 'sheet' && comp.sheetRate
        ? { reg: comp.sheetRate.reg, ot: comp.sheetRate.ot, currency: 'PHP' as PayCurrency, by: null }
        : comp.rateSource === 'department' && comp.deptBase
          ? {
              reg: comp.deptBase.regularRate,
              ot: comp.deptBase.otRate ?? null,
              currency: comp.deptBase.currency,
              by: comp.deptBase.updatedBy ?? comp.deptBase.createdBy,
            }
          : null;
  const rateSourceText =
    comp.rateSource === 'individual'
      ? 'Individual catalog rate -- overrides the rates sheet and the department default.'
      : comp.rateSource === 'sheet'
        ? 'Paid from the rates sheet -- no individual catalog rate.'
        : comp.rateSource === 'department'
          ? `Department default${person.department ? ` for ${formatDeptLabel(person.department)}` : ''} -- no individual or sheet rate.`
          : '';
  const editorInitial =
    comp.override ??
    (comp.rateSource === 'sheet' && comp.sheetRate
      ? {
          regularRate: comp.sheetRate.reg ?? undefined,
          otRate: comp.sheetRate.ot ?? undefined,
          currency: 'PHP' as PayCurrency,
        }
      : (comp.deptBase ?? {}));

  const saveRate = (regular: number, ot: number | undefined, currency: PayCurrency) => {
    onUpsertPay(
      {
        id: comp.override?.id ?? newPayId(),
        scope: 'employee',
        departmentKey: writeDeptKey,
        employeeEmail: comp.override?.employeeEmail ?? person.email,
        employeeName: person.name,
        regularRate: regular,
        otRate: ot,
        currency,
      },
      effectiveDate,
    );
    scheduleHistoryRefresh();
  };

  const toggleExcluded = (assignment: BonusAssignment, exclude: boolean) => {
    const set = new Set((assignment.excludedEmails ?? []).map((e) => e.toLowerCase()));
    if (exclude) set.add(person.email.toLowerCase());
    else for (const a of person.aliases) set.delete(a);
    onAddAssignment({ ...assignment, excludedEmails: [...set] });
  };

  const assignableBonuses = bonuses.filter(
    (b) => !comp.employeeAssignments.some((a) => a.bonusId === b.id),
  );
  // Assignments filed outside the known-department universe are invisible to
  // every calculator and would never pay -- block them honestly.
  const canAssignBonuses = knownDeptKeys.has(writeDeptKey);
  // Realtime can invalidate a stale pick (teammate assigned the same bonus).
  const pickAssignable = !!pickBonus && assignableBonuses.some((b) => b.id === pickBonus);

  return (
    <div>
      {/* Header */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <button
            type="button"
            onClick={onBack}
            aria-label="Back to search results"
            data-readonly-allow
            className="rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold text-zinc-900 dark:text-zinc-100">
              {person.name}
            </h2>
            <p className="truncate text-xs text-zinc-500">
              {formatDeptLabel(person.department) || 'No department'} &middot; {person.email}
            </p>
          </div>
        </div>
        <EditToggle on={editing} onChange={onEditingChange} />
      </div>

      {/* Pay rate */}
      <Section
        icon={Wallet}
        title="Pay rate"
        subtitle="What this person is paid, resolved the way payroll does: individual catalog rate, else the rates-sheet rate, else the department default."
      >
        <div className="flex flex-col gap-4 sm:flex-row">
          <div className="min-w-0 flex-1">
            {editing ? (
              <>
                {comp.rateSource === 'sheet' && (
                  <p className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300">
                    Currently paid from the rates sheet (
                    {formatRate(comp.sheetRate?.reg, 'PHP')}). Saving creates an individual catalog
                    rate that overrides the sheet from the effective date.
                  </p>
                )}
                <div className="mb-3 flex flex-col gap-1">
                  <p className="text-[10px] font-medium uppercase tracking-wide text-emerald-600 dark:text-emerald-400">
                    Effective from
                  </p>
                  <DatePicker
                    value={effectiveDate}
                    onChange={setEffectiveDate}
                    required
                    containerClassName="w-40"
                    className="h-9 text-sm font-medium tabular-nums focus-visible:border-emerald-500 focus-visible:ring-emerald-500/20 dark:bg-zinc-900"
                  />
                </div>
                <PayRateEditor
                  initial={editorInitial}
                  saveLabel={comp.override ? 'Update rate' : 'Set individual rate'}
                  onSave={saveRate}
                />
                {comp.override && (
                  <button
                    type="button"
                    onClick={() => {
                      onDeletePay(comp.override!.id);
                      scheduleHistoryRefresh();
                    }}
                    className="mt-3 flex items-center gap-1.5 text-xs font-medium text-zinc-400 transition-colors hover:text-rose-600 dark:hover:text-rose-400"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Remove individual rate (falls back to the rates sheet / department default)
                  </button>
                )}
              </>
            ) : shownRate ? (
              <>
                <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
                  <RateStat label="Regular" value={formatRate(shownRate.reg, shownRate.currency)} />
                  <RateStat
                    label="OT"
                    value={shownRate.ot != null ? formatRate(shownRate.ot, shownRate.currency) : '-'}
                  />
                  <span className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                    {shownRate.currency}
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                  <span>{rateSourceText}</span>
                  <ByLine who={shownRate.by} />
                </div>
              </>
            ) : (
              <p className="text-sm text-zinc-400">
                No rate anywhere -- no individual catalog rate, no rates-sheet row, and no
                department default. Flip to edit to set one.
              </p>
            )}
          </div>
          <div className="w-full sm:w-52">
            <RateHistoryPanel email={person.email} refreshKey={historyVersion} />
          </div>
        </div>
      </Section>

      {/* Personal bonuses */}
      <Section icon={User} title="Personal bonuses" subtitle="Assigned to this person only.">
        {editing &&
          (canAssignBonuses ? (
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <AnimatedSelect
                ariaLabel="Select a bonus"
                className="min-w-[12rem]"
                value={pickBonus}
                onChange={setPickBonus}
                placeholder="Select a bonus..."
                options={assignableBonuses.map((b) => ({ value: b.id, label: b.name }))}
              />
              <Button
                type="button"
                size="sm"
                disabled={!pickAssignable}
                onClick={() => {
                  // Re-check against live state: a teammate may have assigned
                  // the same bonus since it was picked (Realtime refetch).
                  if (!pickBonus || !assignableBonuses.some((b) => b.id === pickBonus)) {
                    setPickBonus('');
                    return;
                  }
                  onAddAssignment({
                    id: newId('asg'),
                    bonusId: pickBonus,
                    scope: 'employee',
                    departmentKey: writeDeptKey,
                    employeeEmail: person.email,
                    employeeName: person.name,
                  });
                  setPickBonus('');
                }}
                className="gap-1 bg-orange-500 text-white hover:bg-orange-600"
              >
                <Plus className="h-3.5 w-3.5" />
                Assign
              </Button>
            </div>
          ) : (
            <p className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300">
              Personal bonuses can&apos;t be assigned here:{' '}
              {person.department ? `"${formatDeptLabel(person.department)}"` : "this person's department"} isn&apos;t
              wired into the bonus calculators, so a bonus filed under it would never be applied or
              paid.
            </p>
          ))}
        {comp.employeeAssignments.length === 0 ? (
          <p className="text-sm text-zinc-400">No personal bonuses.</p>
        ) : (
          <motion.div layout className="space-y-2">
            <AnimatePresence initial={false} mode="popLayout">
              {comp.employeeAssignments.map((a) => (
                <motion.div
                  key={a.id}
                  layout
                  initial={{ opacity: 0, x: -12 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 12, scale: 0.96 }}
                  transition={{ duration: 0.2, ease: EASE }}
                >
                  <PersonBonusRow
                    bonus={bonusById.get(a.bonusId)}
                    by={a.createdBy}
                    action={
                      editing ? (
                        <IconButton title="Remove" onClick={() => onRemoveAssignment(a.id)} danger>
                          <Trash2 className="h-3.5 w-3.5" />
                        </IconButton>
                      ) : undefined
                    }
                  />
                </motion.div>
              ))}
            </AnimatePresence>
          </motion.div>
        )}
      </Section>

      {/* Department bonuses */}
      <Section
        icon={Building2}
        title="Department bonuses"
        subtitle={`Common bonuses assigned to everyone in ${formatDeptLabel(person.department) || 'their department'}.`}
      >
        {comp.commonAssignments.length === 0 ? (
          <p className="text-sm text-zinc-400">No department-wide bonuses reach this person.</p>
        ) : (
          <div className="space-y-2">
            {comp.commonAssignments.map(({ assignment, excluded }) => (
              <PersonBonusRow
                key={assignment.id}
                bonus={bonusById.get(assignment.bonusId)}
                by={assignment.createdBy}
                muted={excluded}
                note={
                  excluded
                    ? 'Excluded -- does not receive this bonus'
                    : assignment.sharedTeam
                      ? 'Team effort -- one shared result for the department'
                      : undefined
                }
                action={
                  editing ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => toggleExcluded(assignment, !excluded)}
                    >
                      {excluded ? 'Include' : 'Exclude'}
                    </Button>
                  ) : undefined
                }
              />
            ))}
          </div>
        )}
      </Section>

      {/* System bonuses */}
      <Section
        icon={Award}
        title="System bonuses"
        subtitle="Built-in bonuses that apply to this person's department. Timing and eligibility stay with the payroll engine."
      >
        {comp.systemRows.length === 0 ? (
          <p className="text-sm text-zinc-400">
            No system bonuses apply to this person&apos;s department.
          </p>
        ) : (
          <div className="space-y-2">
            {comp.systemRows.map((s) => (
              <div
                key={s.code}
                className="flex items-center justify-between gap-3 rounded-md border border-zinc-200 bg-white px-3 py-2 dark:border-zinc-800 dark:bg-zinc-950"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-sm font-medium text-zinc-800 dark:text-zinc-200">
                    {s.label}
                  </span>
                  <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
                    {money(s.amount, s.currency)}
                  </span>
                </div>
                <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                  engine-timed
                </span>
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

/** One bonus row in the person card. Like AssignmentRow but with a pluggable
 *  trailing action so the same row renders read-only in view mode. */
function PersonBonusRow({
  bonus,
  note,
  by,
  muted,
  action,
}: {
  bonus: BonusDef | undefined;
  note?: string;
  by?: string | null;
  muted?: boolean;
  action?: React.ReactNode;
}) {
  return (
    <div
      className={`flex items-center justify-between gap-3 rounded-md border border-zinc-200 bg-white px-3 py-2 dark:border-zinc-800 dark:bg-zinc-950 ${muted ? 'opacity-60' : ''}`}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-zinc-800 dark:text-zinc-200">
            {bonus?.name ?? '(deleted bonus)'}
          </span>
          {bonus && <KindBadge kind={bonus.kind} />}
          {bonus && <CurrencyBadge currency={bonus.currency} />}
          {bonus && <CadenceBadge cadence={bonus.cadence} />}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
          {bonus?.kind === 'flat' && (
            <span className="font-medium text-emerald-600 dark:text-emerald-400">
              {money(bonus.amount ?? 0, bonus.currency)}
            </span>
          )}
          {bonus?.kind === 'formula' && (
            <code className="truncate font-mono text-[11px] text-zinc-500">{bonus.formula}</code>
          )}
          {note && (
            <span className={muted ? 'font-medium text-rose-500 dark:text-rose-400' : ''}>{note}</span>
          )}
          <ByLine who={by} />
        </div>
      </div>
      {action && <div className="flex shrink-0 items-center gap-1">{action}</div>}
    </div>
  );
}

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

/** Flags a monthly bonus (paid once, on the last payroll week of the month).
 *  Weekly is the default, so it renders nothing to keep the common case clean. */
function CadenceBadge({ cadence }: { cadence: BonusDef['cadence'] }) {
  if (cadence !== 'monthly') return null;
  return (
    <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300">
      monthly
    </span>
  );
}

/** Flags a non-PHP (USD/COP) bonus. PHP is the silent default, so this renders
 *  nothing for PHP to keep the common case uncluttered. */
function CurrencyBadge({ currency }: { currency?: PayCurrency }) {
  const cur = currency ?? 'PHP';
  if (cur === 'PHP') return null;
  return (
    <span
      className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide bg-sky-100 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300"
      title={`${cur}-denominated — converted to PHP at the live rate when applied`}
    >
      {currencyChipLabel(cur)}
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
