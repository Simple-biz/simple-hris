'use client';

// Payment Catalog -- "Department" tab.
//
// A directory of every department (the built-in payroll departments plus the
// in-app ones created here) and the "Create a Department" flow:
//
//   name -> optional sub-departments (HSL-style) -> initial people (at least
//   one Manager required) -> optional department pay rate -> create.
//
// Creation POSTs to /api/payment-catalog/departments, which streams one ndjson
// event per stage; the overlay's staged animation ("Creating department,
// adding managers, adding members and setting pay rates") advances on REAL
// progress, lightly paced so the checkmarks read as steps instead of a blink.
//
// SELF-CONTAINED: in-app departments do NOT depend on the Global Master List.
// Their people live as member records on the registry entry itself; creation
// writes nothing to the roster or the master Google Sheet. The roster prop is
// used only as an autofill convenience in the people picker and for the
// built-in departments' headcounts. Managers get department_managers oversight
// rows, and the optional rate becomes a department-scoped Payment Catalog
// structure the Pay Structure tab manages from then on.

import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Building2,
  Check,
  CheckCircle2,
  ChevronRight,
  Crown,
  FolderTree,
  Loader2,
  Plus,
  Search,
  Sparkles,
  Trash2,
  UserRoundPlus,
  Users,
  Wallet,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DatePicker } from '@/components/ui/date-picker';
import { DEPARTMENTS } from '@/lib/payroll/department-bonus';
import { normalizeDeptToKey } from '@/lib/payroll/normalize-dept-key';
import {
  CREATE_DEPARTMENT_STAGES,
  slugifyDeptKey,
  validateCreateDepartmentInput,
  type CreateDepartmentEvent,
  type CreateDepartmentInput,
  type CreateDepartmentStageKey,
  type CreateDepartmentSummary,
  type DepartmentRegistryEntry,
  type NewDepartmentMember,
} from '@/lib/departments/registry';
import {
  CURRENCY_SYMBOL,
  OT_MULTIPLIER,
  PAY_CURRENCIES,
  currencyChipLabel,
  defaultOtRate,
  formatRate,
  type PayCurrency,
  type PayStructure,
} from '@/lib/payment-catalog/pay-structure';

/** Shared easing -- matches the catalog's tab transition. */
const EASE = [0.22, 1, 0.36, 1] as const;

export type DirectoryPerson = { email: string; name: string; department: string };

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Today's calendar date in Manila (the roster's timezone), YYYY-MM-DD. */
function manilaTodayIso(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function firstNameOf(nameOrEmail: string): string {
  const cleaned = nameOrEmail.includes('@') ? nameOrEmail.split('@')[0] : nameOrEmail;
  // Master-list names are often "Surname, Given" -- show the given part.
  const comma = cleaned.indexOf(',');
  const base = comma >= 0 ? cleaned.slice(comma + 1) : cleaned;
  return base.trim().split(/\s+/)[0] ?? cleaned;
}

function initialsOf(name: string): string {
  const parts = name
    .replace(/["'].*?["']/g, ' ')
    .split(/[\s,]+/)
    .filter(Boolean);
  const a = parts[0]?.[0] ?? '';
  const b = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (a + b).toUpperCase() || '?';
}

// ---------------------------------------------------------------------------
// Tab root
// ---------------------------------------------------------------------------

export default function DepartmentsTab({
  roster,
  payStructures,
  registry,
  managersByDept,
  onCreated,
  onOpenPayStructure,
}: {
  roster: DirectoryPerson[];
  payStructures: PayStructure[];
  registry: DepartmentRegistryEntry[];
  /** dept string (lower-cased, as stored in department_managers) -> manager emails. */
  managersByDept: Record<string, string[]>;
  /** Refetch catalog data after a successful creation. */
  onCreated: () => void;
  /** Jump to the Pay Structure tab focused on a department key. */
  onOpenPayStructure: (deptKey: string) => void;
}) {
  const [wizardOpen, setWizardOpen] = useState(false);

  const nameByEmail = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of roster) m.set(p.email, p.name);
    return m;
  }, [roster]);

  /** Manager emails for the BUILT-IN departments, matching how assignments
   *  are stored: raw roster strings (aliases included) -- compare via keys.
   *  In-app departments read their managers off the registry entry instead. */
  const managersForKey = useMemo(() => {
    const out = new Map<string, Set<string>>();
    for (const [deptRaw, emails] of Object.entries(managersByDept)) {
      const builtin = normalizeDeptToKey(deptRaw);
      if (!builtin) continue;
      const set = out.get(builtin) ?? new Set<string>();
      for (const e of emails) set.add(e);
      out.set(builtin, set);
    }
    return out;
  }, [managersByDept]);

  const memberCountForBuiltin = (key: string) =>
    roster.filter((p) => normalizeDeptToKey(p.department) === key).length;

  const deptRate = (key: string) =>
    payStructures.find((s) => s.scope === 'department' && s.departmentKey === key) ?? null;
  const overrideCount = (key: string) =>
    payStructures.filter((s) => s.scope === 'employee' && s.departmentKey === key).length;

  const joinNames = (names: string[]): string | null => {
    if (names.length === 0) return null;
    const shown = names.slice(0, 2);
    const extra = names.length - shown.length;
    return extra > 0 ? `${shown.join(', ')} +${extra}` : shown.join(', ');
  };

  const managerLabelForBuiltin = (key: string): string | null =>
    joinNames(
      Array.from(managersForKey.get(key) ?? []).map((e) => firstNameOf(nameByEmail.get(e) ?? e)),
    );

  const managerLabelForEntry = (entry: DepartmentRegistryEntry): string | null =>
    joinNames(entry.members.filter((m) => m.isManager).map((m) => firstNameOf(m.name)));

  const sortedRegistry = useMemo(
    () => [...registry].sort((a, b) => a.name.localeCompare(b.name)),
    [registry],
  );

  return (
    <div className="mx-auto max-w-5xl p-4 sm:p-6">
      {/* Header band: intro + the hero button */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold text-zinc-900 dark:text-zinc-100">
            <FolderTree className="h-5 w-5 text-orange-500" />
            Departments
          </h2>
          <p className="mt-0.5 max-w-xl text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
            Spin up a department with its manager, members, sub-departments and starting rate in
            one pass -- tracked right here, independent of the Global Master List.
          </p>
        </div>
        <CreateDepartmentButton onClick={() => setWizardOpen(true)} />
      </div>

      {/* Created in-app */}
      <section className="mt-6">
        <SectionHeading
          icon={Sparkles}
          title="Created in-app"
          subtitle="Departments made here, with their internal structure."
        />
        {sortedRegistry.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-300 bg-white/60 p-8 text-center dark:border-zinc-700 dark:bg-zinc-950/40">
            <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-orange-100 text-orange-600 dark:bg-blue-950/60 dark:text-blue-300">
              <Building2 className="h-5 w-5" />
            </span>
            <p className="mt-3 text-sm font-medium text-zinc-800 dark:text-zinc-200">
              No departments created here yet
            </p>
            <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
              &ldquo;Create a Department&rdquo; sets one up with its first people (a manager is
              required), optional sub-departments like HSL&rsquo;s teams, and a starting pay rate the
              Pay Structure tab manages afterwards. Everything is kept here -- nothing is written to
              the Global Master List.
            </p>
          </div>
        ) : (
          <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
            {sortedRegistry.map((entry) => {
              const rate = deptRate(entry.key);
              return (
                <div
                  key={entry.key}
                  className="group rounded-xl border border-zinc-200 bg-white p-4 transition-shadow hover:shadow-md dark:border-zinc-800 dark:bg-zinc-950"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h3 className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                        {entry.name}
                      </h3>
                      <p className="mt-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">
                        {entry.members.length} {entry.members.length === 1 ? 'person' : 'people'}
                        {managerLabelForEntry(entry)
                          ? ` · Manager: ${managerLabelForEntry(entry)}`
                          : ' · No manager assigned'}
                      </p>
                    </div>
                    <span className="shrink-0 rounded-full bg-orange-100 px-2 py-0.5 text-[10px] font-semibold text-orange-700 dark:bg-blue-950/60 dark:text-blue-300">
                      In-app
                    </span>
                  </div>

                  {entry.subDepartments.length > 0 && (
                    <div className="mt-2.5 flex flex-wrap gap-1">
                      {entry.subDepartments.map((sub) => (
                        <span
                          key={sub.key}
                          className="rounded-md bg-zinc-100 px-1.5 py-0.5 text-[10.5px] font-medium text-zinc-600 dark:bg-zinc-900 dark:text-zinc-300"
                        >
                          {sub.name}
                        </span>
                      ))}
                    </div>
                  )}

                  <div className="mt-3 flex items-center justify-between border-t border-zinc-100 pt-2.5 dark:border-zinc-900">
                    <span className="text-xs font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
                      {rate ? formatRate(rate.regularRate, rate.currency) : (
                        <span className="font-medium text-zinc-400 dark:text-zinc-500">No rate set</span>
                      )}
                      {overrideCount(entry.key) > 0 && (
                        <span className="ml-1.5 font-medium text-zinc-400">
                          +{overrideCount(entry.key)} individual
                        </span>
                      )}
                    </span>
                    <button
                      type="button"
                      onClick={() => onOpenPayStructure(entry.key)}
                      className="inline-flex items-center gap-0.5 rounded-md px-1.5 py-1 text-[11px] font-semibold text-orange-600 transition-colors hover:bg-orange-50 dark:text-blue-300 dark:hover:bg-blue-950/40"
                    >
                      Pay structure
                      <ChevronRight className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Synced from the master list */}
      <section className="mt-8">
        <SectionHeading
          icon={Users}
          title="From the master list sync"
          subtitle="Built-in payroll departments, populated by the Google Sheet sync."
        />
        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
          {DEPARTMENTS.map((d) => {
            const rate = deptRate(d.key);
            const label = managerLabelForBuiltin(d.key);
            const people = memberCountForBuiltin(d.key);
            return (
              <div
                key={d.key}
                className="group rounded-xl border border-zinc-200 bg-white p-4 transition-shadow hover:shadow-md dark:border-zinc-800 dark:bg-zinc-950"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                      {d.name}
                    </h3>
                    <p className="mt-0.5 truncate text-[11px] text-zinc-500 dark:text-zinc-400" title={label ?? undefined}>
                      {people} {people === 1 ? 'person' : 'people'}
                      {label ? ` · Manager: ${label}` : ' · No manager assigned'}
                    </p>
                  </div>
                  <span className="shrink-0 rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-semibold text-zinc-600 dark:bg-zinc-900 dark:text-zinc-300">
                    Master list
                  </span>
                </div>

                <div className="mt-3 flex items-center justify-between border-t border-zinc-100 pt-2.5 dark:border-zinc-900">
                  <span className="text-xs font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
                    {rate ? formatRate(rate.regularRate, rate.currency) : (
                      <span className="font-medium text-zinc-400 dark:text-zinc-500">No rate set</span>
                    )}
                    {overrideCount(d.key) > 0 && (
                      <span className="ml-1.5 font-medium text-zinc-400">
                        +{overrideCount(d.key)} individual
                      </span>
                    )}
                  </span>
                  <button
                    type="button"
                    onClick={() => onOpenPayStructure(d.key)}
                    className="inline-flex items-center gap-0.5 rounded-md px-1.5 py-1 text-[11px] font-semibold text-orange-600 transition-colors hover:bg-orange-50 dark:text-blue-300 dark:hover:bg-blue-950/40"
                  >
                    Pay structure
                    <ChevronRight className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-zinc-400 dark:text-zinc-500">
          In-app departments are self-contained: their people are tracked here (not on the Global
          Master List) and their rates work in Pay Structure right away. Payroll Wizard tabs and
          KPI calculators are wired per-department in code, so a new department joins those once
          engineering adds it.
        </p>
      </section>

      <CreateDepartmentWizard
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        roster={roster}
        registry={registry}
        onCreated={onCreated}
        onOpenPayStructure={onOpenPayStructure}
      />
    </div>
  );
}

function SectionHeading({
  icon: Icon,
  title,
  subtitle,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  subtitle: string;
}) {
  return (
    <div className="mb-3 flex items-start gap-2">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-orange-500" />
      <div>
        <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{title}</h3>
        <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{subtitle}</p>
      </div>
    </div>
  );
}

/** The hero CTA. Prominent but on-system: solid orange, soft glow, spring press. */
function CreateDepartmentButton({ onClick }: { onClick: () => void }) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      whileHover={{ scale: 1.02 }}
      whileTap={{ scale: 0.97 }}
      transition={{ type: 'spring', stiffness: 500, damping: 30 }}
      className="group inline-flex items-center gap-2 rounded-xl bg-gradient-to-b from-orange-500 to-orange-600 py-2.5 pl-3.5 pr-4 text-sm font-semibold text-white shadow-lg shadow-orange-500/30 transition-shadow hover:shadow-xl hover:shadow-orange-500/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-zinc-950"
    >
      <span className="flex h-5 w-5 items-center justify-center rounded-md bg-white/20 transition-transform group-hover:rotate-90">
        <Plus className="h-3.5 w-3.5" />
      </span>
      Create a Department
    </motion.button>
  );
}

// ---------------------------------------------------------------------------
// Wizard
// ---------------------------------------------------------------------------

type WizardMember = NewDepartmentMember & { id: string };

const STEPS = ['Department', 'Sub-departments', 'People', 'Pay & review'] as const;

type StageStatus = 'pending' | 'active' | 'done' | 'failed';

type CreationView =
  | null
  | {
      input: CreateDepartmentInput;
      stages: Record<CreateDepartmentStageKey, StageStatus>;
      notes: Partial<Record<CreateDepartmentStageKey, string>>;
      error: { stage: CreateDepartmentStageKey; message: string } | null;
      summary: CreateDepartmentSummary | null;
    };

function freshCreation(input: CreateDepartmentInput): NonNullable<CreationView> {
  return {
    input,
    stages: { department: 'pending', managers: 'pending', members: 'pending', rates: 'pending' },
    notes: {},
    error: null,
    summary: null,
  };
}

let wizardMemberSeq = 0;
const nextMemberId = () => `wm_${++wizardMemberSeq}`;

function CreateDepartmentWizard({
  open,
  onClose,
  roster,
  registry,
  onCreated,
  onOpenPayStructure,
}: {
  open: boolean;
  onClose: () => void;
  roster: DirectoryPerson[];
  registry: DepartmentRegistryEntry[];
  onCreated: () => void;
  onOpenPayStructure: (deptKey: string) => void;
}) {
  const reducedMotion = useReducedMotion();
  const [step, setStep] = useState(0);
  const [dir, setDir] = useState(1);

  // Step 1 -- name
  const [name, setName] = useState('');
  // Step 2 -- sub-departments
  const [wantsSubs, setWantsSubs] = useState<'no' | 'yes'>('no');
  const [subs, setSubs] = useState<string[]>([]);
  // Step 3 -- people
  const [members, setMembers] = useState<WizardMember[]>([]);
  // Step 4 -- pay
  const [wantRate, setWantRate] = useState(true);
  const [regular, setRegular] = useState('');
  const [otMode, setOtMode] = useState<'auto' | 'custom'>('auto');
  const [customOt, setCustomOt] = useState('');
  const [currency, setCurrency] = useState<PayCurrency>('PHP');

  // Creation progress (replaces the form while running)
  const [creation, setCreation] = useState<CreationView>(null);
  // Server events queue + how many are visually applied (paced reveal).
  const eventsRef = useRef<CreateDepartmentEvent[]>([]);
  const [received, setReceived] = useState(0);
  const [applied, setApplied] = useState(0);

  // Mid-creation (no success or failure on screen yet) the modal must not be
  // dismissable -- closing would hide progress the user can't get back.
  const running = creation !== null && creation.summary === null && creation.error === null;

  const reset = () => {
    setStep(0);
    setDir(1);
    setName('');
    setWantsSubs('no');
    setSubs([]);
    setMembers([]);
    setWantRate(true);
    setRegular('');
    setOtMode('auto');
    setCustomOt('');
    setCurrency('PHP');
    setCreation(null);
    eventsRef.current = [];
    setReceived(0);
    setApplied(0);
  };

  // Escape closes (unless mid-creation).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !running) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose, running]);

  // Fresh form every time the wizard opens.
  useEffect(() => {
    if (open) reset();
  }, [open]);

  // ----- validation per step -----
  const trimmedName = name.trim();
  // Collisions are checked against the things this feature owns or maps to
  // (built-in payroll departments + the in-app registry) -- deliberately NOT
  // against Global Master List department strings, which live elsewhere.
  const existingNames = useMemo(() => {
    const set = new Set<string>();
    for (const d of DEPARTMENTS) set.add(d.name.toLowerCase());
    for (const e of registry) set.add(e.name.toLowerCase());
    return set;
  }, [registry]);
  const nameCollision =
    trimmedName.length > 0 &&
    (existingNames.has(trimmedName.toLowerCase()) || normalizeDeptToKey(trimmedName) !== null);
  const nameOk = trimmedName.length > 0 && trimmedName.length <= 60 && !nameCollision && slugifyDeptKey(trimmedName) !== '';

  const subsOk = wantsSubs === 'no' || subs.length > 0;
  const managerCount = members.filter((m) => m.isManager).length;
  const peopleOk = members.length > 0 && managerCount > 0;

  const regularNum = Number(regular);
  const regularValid = regular.trim() !== '' && Number.isFinite(regularNum) && regularNum >= 0;
  const customOtNum = customOt.trim() === '' ? undefined : Number(customOt);
  const otValid = otMode === 'auto' || customOtNum === undefined || (Number.isFinite(customOtNum) && customOtNum >= 0);
  const payOk = !wantRate || (regularValid && otValid);

  const stepOk = [nameOk, subsOk, peopleOk, payOk][step] ?? false;

  const effectiveSubs = wantsSubs === 'yes' ? subs : [];

  const buildInput = (): CreateDepartmentInput => ({
    name: trimmedName,
    subDepartments: effectiveSubs,
    members: members.map(({ id: _id, ...m }) => ({
      ...m,
      // A sub-department pick is only meaningful when subs are on.
      subDepartment: wantsSubs === 'yes' ? m.subDepartment ?? null : null,
    })),
    payStructure: wantRate
      ? {
          regularRate: regularNum,
          otRate: otMode === 'auto' ? defaultOtRate(regularNum) : customOtNum,
          currency,
        }
      : null,
  });

  // ----- creation run: consume the ndjson stream -----
  const runCreate = async (input: CreateDepartmentInput) => {
    eventsRef.current = [];
    setReceived(0);
    setApplied(0);
    setCreation(freshCreation(input));
    const push = (ev: CreateDepartmentEvent) => {
      eventsRef.current.push(ev);
      setReceived(eventsRef.current.length);
    };
    try {
      const res = await fetch('/api/payment-catalog/departments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      const contentType = res.headers.get('content-type') ?? '';
      if (!res.ok || !res.body || !contentType.includes('ndjson')) {
        const json = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(json?.error ?? `Request failed (${res.status})`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let terminal = false;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl = buffer.indexOf('\n');
        while (nl >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line) {
            const ev = JSON.parse(line) as CreateDepartmentEvent;
            push(ev);
            if (ev.type === 'done' || ev.type === 'error') terminal = true;
          }
          nl = buffer.indexOf('\n');
        }
      }
      if (!terminal) {
        throw new Error(
          'The connection dropped mid-creation. Retrying is safe -- finished steps are skipped.',
        );
      }
    } catch (e) {
      // Attribute the failure to whichever stage was last underway.
      let stage: CreateDepartmentStageKey = 'department';
      for (const ev of eventsRef.current) {
        if (ev.type === 'stage') stage = ev.stage;
      }
      push({
        type: 'error',
        stage,
        message: e instanceof Error ? e.message : 'Department creation failed',
      });
    }
  };

  // Paced applier: reveal queued events one at a time so the stages read as
  // steps even when the server finishes fast. Reduced motion drops the pacing.
  useEffect(() => {
    if (applied >= received) return;
    const delay = reducedMotion ? 0 : applied === 0 ? 150 : 420;
    const t = setTimeout(() => setApplied((a) => a + 1), delay);
    return () => clearTimeout(t);
  }, [applied, received, reducedMotion]);

  // Fold visually-applied events into the creation view.
  useEffect(() => {
    if (applied === 0) return;
    setCreation((prev) => {
      if (!prev) return prev;
      const next: NonNullable<CreationView> = {
        ...prev,
        stages: { ...prev.stages },
        notes: { ...prev.notes },
      };
      for (const ev of eventsRef.current.slice(0, applied)) {
        if (ev.type === 'stage') {
          next.stages[ev.stage] = ev.status === 'start' ? 'active' : 'done';
          if (ev.note) next.notes[ev.stage] = ev.note;
        } else if (ev.type === 'error') {
          next.error = { stage: ev.stage, message: ev.message };
          if (next.stages[ev.stage] !== 'done') next.stages[ev.stage] = 'failed';
        } else {
          next.summary = ev.summary;
        }
      }
      return next;
    });
  }, [applied]);

  // Refresh catalog data once the success screen lands.
  const summaryShown = creation?.summary != null;
  useEffect(() => {
    if (summaryShown) onCreated();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire once per creation
  }, [summaryShown]);

  const goto = (next: number) => {
    setDir(next > step ? 1 : -1);
    setStep(next);
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <motion.div
            className="absolute inset-0 bg-zinc-900/40 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => {
              if (!running) onClose();
            }}
          />

          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="Create a department"
            className="relative z-10 flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-950"
            initial={{ opacity: 0, y: 24, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 24, scale: 0.96 }}
            transition={{ type: 'spring', stiffness: 320, damping: 30 }}
          >
            <AnimatePresence mode="wait" initial={false}>
              {creation ? (
                <motion.div
                  key="creation"
                  initial={{ opacity: 0, scale: 0.98 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.98 }}
                  transition={{ duration: 0.22, ease: EASE }}
                >
                  <CreationProgress
                    view={creation}
                    onRetry={() => void runCreate(creation.input)}
                    onBackToForm={() => {
                      eventsRef.current = [];
                      setReceived(0);
                      setApplied(0);
                      setCreation(null);
                    }}
                    onDone={onClose}
                    onOpenPayStructure={(key) => {
                      onClose();
                      onOpenPayStructure(key);
                    }}
                  />
                </motion.div>
              ) : (
                <motion.div
                  key="form"
                  className="flex min-h-0 flex-col"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0, scale: 0.99 }}
                  transition={{ duration: 0.18, ease: EASE }}
                >
                  {/* Header + step rail */}
                  <div className="shrink-0 border-b border-zinc-100 p-4 sm:px-5 dark:border-zinc-800">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <h2 className="flex items-center gap-2 text-base font-semibold text-zinc-900 dark:text-zinc-100">
                          <Building2 className="h-4.5 w-4.5 text-orange-500" />
                          Create a Department
                        </h2>
                        <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                          {trimmedName ? trimmedName : 'New department'} · Step {step + 1} of {STEPS.length}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={onClose}
                        className="rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-900 dark:hover:text-zinc-200"
                        aria-label="Close"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                    <div className="mt-3 flex items-center gap-1.5" aria-hidden>
                      {STEPS.map((label, i) => (
                        <button
                          key={label}
                          type="button"
                          disabled={i > step}
                          onClick={() => i < step && goto(i)}
                          className="group flex-1"
                          title={label}
                        >
                          <span
                            className={`block h-1 rounded-full transition-colors ${
                              i < step
                                ? 'bg-orange-400'
                                : i === step
                                  ? 'bg-orange-500'
                                  : 'bg-zinc-200 dark:bg-zinc-800'
                            }`}
                          />
                          <span
                            className={`mt-1 hidden text-[10px] font-medium sm:block ${
                              i === step ? 'text-orange-600 dark:text-blue-300' : 'text-zinc-400 dark:text-zinc-500'
                            }`}
                          >
                            {label}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Step body */}
                  <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">
                    <AnimatePresence mode="wait" initial={false} custom={dir}>
                      <motion.div
                        key={step}
                        custom={dir}
                        initial={{ opacity: 0, x: 24 * dir }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: -24 * dir }}
                        transition={{ duration: 0.2, ease: EASE }}
                      >
                        {step === 0 && (
                          <StepName
                            name={name}
                            onName={setName}
                            collision={nameCollision}
                          />
                        )}
                        {step === 1 && (
                          <StepSubDepartments
                            deptName={trimmedName}
                            wantsSubs={wantsSubs}
                            onWantsSubs={setWantsSubs}
                            subs={subs}
                            onSubs={setSubs}
                          />
                        )}
                        {step === 2 && (
                          <StepPeople
                            deptName={trimmedName}
                            roster={roster}
                            members={members}
                            onMembers={setMembers}
                            subs={effectiveSubs}
                            managerCount={managerCount}
                          />
                        )}
                        {step === 3 && (
                          <StepPayAndReview
                            deptName={trimmedName}
                            subs={effectiveSubs}
                            members={members}
                            wantRate={wantRate}
                            onWantRate={setWantRate}
                            regular={regular}
                            onRegular={setRegular}
                            otMode={otMode}
                            onOtMode={setOtMode}
                            customOt={customOt}
                            onCustomOt={setCustomOt}
                            currency={currency}
                            onCurrency={setCurrency}
                          />
                        )}
                      </motion.div>
                    </AnimatePresence>
                  </div>

                  {/* Footer */}
                  <div className="flex shrink-0 items-center justify-between gap-2 border-t border-zinc-100 p-4 sm:px-5 dark:border-zinc-800">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => (step === 0 ? onClose() : goto(step - 1))}
                      className="gap-1"
                    >
                      {step === 0 ? 'Cancel' : (
                        <>
                          <ArrowLeft className="h-3.5 w-3.5" />
                          Back
                        </>
                      )}
                    </Button>
                    {step < STEPS.length - 1 ? (
                      <Button
                        type="button"
                        size="sm"
                        disabled={!stepOk}
                        onClick={() => goto(step + 1)}
                        className="gap-1 bg-orange-500 text-white hover:bg-orange-600"
                      >
                        Continue
                        <ArrowRight className="h-3.5 w-3.5" />
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        size="sm"
                        disabled={!stepOk || !validateCreateDepartmentInput(buildInput()).ok}
                        onClick={() => void runCreate(buildInput())}
                        className="gap-1.5 bg-orange-500 text-white hover:bg-orange-600"
                      >
                        <Sparkles className="h-3.5 w-3.5" />
                        Create Department
                      </Button>
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ---------------------------------------------------------------------------
// Step 1 -- name
// ---------------------------------------------------------------------------

function StepName({
  name,
  onName,
  collision,
}: {
  name: string;
  onName: (v: string) => void;
  collision: boolean;
}) {
  return (
    <div className="space-y-4">
      <div>
        <label htmlFor="new-dept-name" className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
          Department name
        </label>
        <Input
          id="new-dept-name"
          autoFocus
          value={name}
          onChange={(e) => onName(e.target.value)}
          placeholder="e.g. Medical Billing"
          maxLength={60}
          className="h-10 text-[15px]"
        />
        <AnimatePresence initial={false}>
          {collision && (
            <motion.p
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="mt-1.5 flex items-center gap-1 overflow-hidden text-xs font-medium text-red-600 dark:text-red-400"
            >
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              A department with this name already exists.
            </motion.p>
          )}
        </AnimatePresence>
      </div>
      <div className="rounded-lg border border-orange-100 bg-orange-50/50 p-3 text-xs leading-relaxed text-zinc-600 dark:border-blue-950/60 dark:bg-blue-950/10 dark:text-zinc-400">
        Departments created here are self-contained: people and structure are tracked in the
        Payment Catalog (nothing is written to the Global Master List), managers get dashboard
        oversight, and the Pay Structure tab carries the rate.
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 2 -- sub-departments
// ---------------------------------------------------------------------------

function StepSubDepartments({
  deptName,
  wantsSubs,
  onWantsSubs,
  subs,
  onSubs,
}: {
  deptName: string;
  wantsSubs: 'no' | 'yes';
  onWantsSubs: (v: 'no' | 'yes') => void;
  subs: string[];
  onSubs: (v: string[]) => void;
}) {
  const [draft, setDraft] = useState('');
  const draftKey = slugifyDeptKey(draft);
  const duplicate = draftKey !== '' && subs.some((s) => slugifyDeptKey(s) === draftKey);
  const canAdd = draft.trim() !== '' && draftKey !== '' && !duplicate;

  const add = () => {
    if (!canAdd) return;
    onSubs([...subs, draft.trim()]);
    setDraft('');
  };

  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
          Does {deptName || 'this department'} need sub-departments?
        </p>
        <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
          Like HSL: one department split into internal teams (Callback Team, Case Managers,
          Medical Records...).
        </p>
        <div className="mt-2.5 inline-flex rounded-md border border-zinc-200 p-0.5 dark:border-zinc-800">
          {(['no', 'yes'] as const).map((opt) => (
            <button
              key={opt}
              type="button"
              onClick={() => onWantsSubs(opt)}
              className={`relative rounded px-4 py-1.5 text-xs font-semibold transition-colors ${
                wantsSubs === opt ? 'text-white' : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
              }`}
            >
              {wantsSubs === opt && (
                <motion.span
                  layoutId="wantsSubsPill"
                  className="absolute inset-0 rounded bg-orange-500"
                  transition={{ type: 'spring', stiffness: 500, damping: 34 }}
                />
              )}
              <span className="relative z-10">{opt === 'no' ? 'No, keep it flat' : 'Yes, add sub-departments'}</span>
            </button>
          ))}
        </div>
      </div>

      <AnimatePresence initial={false}>
        {wantsSubs === 'yes' && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.22, ease: EASE }}
            className="overflow-hidden"
          >
            <div className="space-y-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
              <div className="flex items-center gap-2">
                <Input
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      add();
                    }
                  }}
                  placeholder="Sub-department name, e.g. Intake Team"
                  maxLength={60}
                  className="h-9"
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={!canAdd}
                  onClick={add}
                  className="shrink-0 gap-1"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Add
                </Button>
              </div>
              {duplicate && (
                <p className="text-[11px] font-medium text-red-600 dark:text-red-400">
                  That sub-department is already on the list.
                </p>
              )}
              {subs.length === 0 ? (
                <p className="text-xs text-zinc-400 dark:text-zinc-500">
                  Add at least one sub-department (or switch back to &ldquo;No&rdquo;).
                </p>
              ) : (
                <motion.div layout className="flex flex-wrap gap-1.5">
                  <AnimatePresence initial={false} mode="popLayout">
                    {subs.map((sub) => (
                      <motion.span
                        key={slugifyDeptKey(sub)}
                        layout
                        initial={{ opacity: 0, scale: 0.9 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.9 }}
                        transition={{ duration: 0.15, ease: EASE }}
                        className="inline-flex items-center gap-1 rounded-md bg-orange-100 py-1 pl-2.5 pr-1 text-xs font-medium text-orange-800 dark:bg-blue-950/60 dark:text-blue-200"
                      >
                        {sub}
                        <button
                          type="button"
                          onClick={() => onSubs(subs.filter((s) => s !== sub))}
                          className="rounded p-0.5 transition-colors hover:bg-orange-200/70 dark:hover:bg-blue-900/60"
                          aria-label={`Remove ${sub}`}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </motion.span>
                    ))}
                  </AnimatePresence>
                </motion.div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 3 -- people
// ---------------------------------------------------------------------------

function StepPeople({
  deptName,
  roster,
  members,
  onMembers,
  subs,
  managerCount,
}: {
  deptName: string;
  roster: DirectoryPerson[];
  members: WizardMember[];
  onMembers: (v: WizardMember[]) => void;
  subs: string[];
  managerCount: number;
}) {
  const [mode, setMode] = useState<'existing' | 'new'>('existing');
  const [query, setQuery] = useState('');
  // New-person form
  const [newName, setNewName] = useState('');
  const [newWorkEmail, setNewWorkEmail] = useState('');
  const [newPersonalEmail, setNewPersonalEmail] = useState('');
  const [newStartDate, setNewStartDate] = useState<string>(manilaTodayIso());

  const takenEmails = useMemo(
    () => new Set(members.map((m) => m.workEmail.trim().toLowerCase())),
    [members],
  );

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return roster
      .filter(
        (p) =>
          !takenEmails.has(p.email) &&
          (p.name.toLowerCase().includes(q) || p.email.includes(q)),
      )
      .slice(0, 6);
  }, [query, roster, takenEmails]);

  const addExisting = (p: DirectoryPerson) => {
    onMembers([
      ...members,
      {
        id: nextMemberId(),
        name: p.name,
        workEmail: p.email,
        personalEmail: null,
        isManager: members.length === 0, // first person defaults to manager
        subDepartment: null,
      },
    ]);
    setQuery('');
  };

  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newWorkEmail.trim());
  const personalOk = newPersonalEmail.trim() === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newPersonalEmail.trim());
  const newTaken = takenEmails.has(newWorkEmail.trim().toLowerCase());
  const canAddNew = newName.trim() !== '' && emailOk && personalOk && !newTaken;

  const addNew = () => {
    if (!canAddNew) return;
    onMembers([
      ...members,
      {
        id: nextMemberId(),
        name: newName.trim(),
        workEmail: newWorkEmail.trim().toLowerCase(),
        personalEmail: newPersonalEmail.trim().toLowerCase() || null,
        isManager: members.length === 0,
        subDepartment: null,
        startDate: newStartDate || manilaTodayIso(),
      },
    ]);
    setNewName('');
    setNewWorkEmail('');
    setNewPersonalEmail('');
    setNewStartDate(manilaTodayIso());
  };

  const patch = (id: string, changes: Partial<WizardMember>) =>
    onMembers(members.map((m) => (m.id === id ? { ...m, ...changes } : m)));

  return (
    <div className="space-y-4">
      {/* Requirement pill */}
      <div
        className={`flex items-center gap-2 rounded-lg border p-2.5 text-xs font-medium transition-colors ${
          managerCount > 0
            ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-300'
            : 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300'
        }`}
      >
        {managerCount > 0 ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <Crown className="h-4 w-4 shrink-0" />}
        {managerCount > 0
          ? `${managerCount} manager${managerCount === 1 ? '' : 's'} set for ${deptName || 'the department'}.`
          : 'Every department needs at least one Manager -- mark one below.'}
      </div>

      {/* Add people */}
      <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
        <div className="mb-2.5 inline-flex rounded-md border border-zinc-200 p-0.5 dark:border-zinc-800">
          {(
            [
              { key: 'existing', label: 'From the roster', icon: Users },
              { key: 'new', label: 'Someone new', icon: UserRoundPlus },
            ] as const
          ).map((opt) => (
            <button
              key={opt.key}
              type="button"
              onClick={() => setMode(opt.key)}
              className={`relative flex items-center gap-1.5 rounded px-3 py-1.5 text-xs font-semibold transition-colors ${
                mode === opt.key ? 'text-white' : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
              }`}
            >
              {mode === opt.key && (
                <motion.span
                  layoutId="memberModePill"
                  className="absolute inset-0 rounded bg-orange-500"
                  transition={{ type: 'spring', stiffness: 500, damping: 34 }}
                />
              )}
              <span className="relative z-10 flex items-center gap-1.5">
                <opt.icon className="h-3.5 w-3.5" />
                {opt.label}
              </span>
            </button>
          ))}
        </div>

        {mode === 'existing' ? (
          <div>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search people by name or email"
                className="h-9 pl-8"
              />
            </div>
            <AnimatePresence initial={false}>
              {matches.length > 0 && (
                <motion.ul
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.18, ease: EASE }}
                  className="mt-1.5 overflow-hidden rounded-md border border-zinc-200 dark:border-zinc-800"
                >
                  {matches.map((p) => (
                    <li key={p.email}>
                      <button
                        type="button"
                        onClick={() => addExisting(p)}
                        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left transition-colors hover:bg-orange-50 dark:hover:bg-blue-950/30"
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium text-zinc-800 dark:text-zinc-200">
                            {p.name}
                          </span>
                          <span className="block truncate text-[11px] text-zinc-400">{p.email}</span>
                        </span>
                        <span className="shrink-0 rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-medium text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                          {p.department || 'No department'}
                        </span>
                      </button>
                    </li>
                  ))}
                </motion.ul>
              )}
            </AnimatePresence>
            <p className="mt-1.5 text-[11px] text-zinc-400 dark:text-zinc-500">
              Autofills their name and email into {deptName || 'the new department'} -- their
              roster row is not touched.
            </p>
          </div>
        ) : (
          <div className="space-y-2.5">
            <div className="grid gap-2.5 sm:grid-cols-2">
              <MiniField label="Full name">
                <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Juan Dela Cruz" className="h-9" />
              </MiniField>
              <MiniField label="Work email">
                <Input
                  value={newWorkEmail}
                  onChange={(e) => setNewWorkEmail(e.target.value)}
                  placeholder="name@simple.biz"
                  className="h-9"
                />
              </MiniField>
              <MiniField label="Personal email (optional)">
                <Input
                  value={newPersonalEmail}
                  onChange={(e) => setNewPersonalEmail(e.target.value)}
                  placeholder="name@gmail.com"
                  className="h-9"
                />
              </MiniField>
              <MiniField label="Start date">
                <DatePicker value={newStartDate} onChange={setNewStartDate} className="h-9 text-sm" />
              </MiniField>
            </div>
            {newTaken && (
              <p className="text-[11px] font-medium text-red-600 dark:text-red-400">
                That work email is already on the list below.
              </p>
            )}
            <Button type="button" size="sm" variant="outline" disabled={!canAddNew} onClick={addNew} className="gap-1">
              <Plus className="h-3.5 w-3.5" />
              Add person
            </Button>
          </div>
        )}
      </div>

      {/* Member list */}
      {members.length === 0 ? (
        <p className="text-center text-xs text-zinc-400 dark:text-zinc-500">
          No one yet -- add the manager first.
        </p>
      ) : (
        <motion.ul layout className="space-y-1.5">
          <AnimatePresence initial={false} mode="popLayout">
            {members.map((m) => (
              <motion.li
                key={m.id}
                layout
                initial={{ opacity: 0, x: -12 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 12, scale: 0.97 }}
                transition={{ duration: 0.18, ease: EASE }}
                className="flex flex-wrap items-center gap-2 rounded-lg border border-zinc-200 bg-white p-2.5 dark:border-zinc-800 dark:bg-zinc-950"
              >
                <span
                  className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${
                    m.isManager
                      ? 'bg-orange-100 text-orange-700 dark:bg-blue-950/60 dark:text-blue-300'
                      : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400'
                  }`}
                >
                  {initialsOf(m.name)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-medium text-zinc-800 dark:text-zinc-200">{m.name}</span>
                    {m.isManager && (
                      <span className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-orange-100 px-1.5 py-px text-[9.5px] font-bold uppercase tracking-wide text-orange-700 dark:bg-blue-950/60 dark:text-blue-300">
                        <Crown className="h-2.5 w-2.5" />
                        Manager
                      </span>
                    )}
                  </span>
                  <span className="block truncate text-[11px] text-zinc-400">{m.workEmail}</span>
                </span>

                {subs.length > 0 && (
                  <select
                    value={m.subDepartment ?? ''}
                    onChange={(e) => patch(m.id, { subDepartment: e.target.value || null })}
                    className="h-8 shrink-0 rounded-md border border-zinc-200 bg-white px-2 text-xs text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
                    aria-label={`Sub-department for ${m.name}`}
                  >
                    <option value="">No sub-department</option>
                    {subs.map((s) => (
                      <option key={slugifyDeptKey(s)} value={slugifyDeptKey(s)}>
                        {s}
                      </option>
                    ))}
                  </select>
                )}

                <button
                  type="button"
                  onClick={() => patch(m.id, { isManager: !m.isManager })}
                  className={`shrink-0 rounded-md border px-2 py-1.5 text-[11px] font-semibold transition-colors ${
                    m.isManager
                      ? 'border-orange-200 bg-orange-50 text-orange-700 hover:bg-orange-100 dark:border-blue-900/60 dark:bg-blue-950/40 dark:text-blue-300'
                      : 'border-zinc-200 text-zinc-500 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900'
                  }`}
                >
                  {m.isManager ? 'Manager' : 'Member'}
                </button>
                <button
                  type="button"
                  onClick={() => onMembers(members.filter((x) => x.id !== m.id))}
                  className="shrink-0 rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40"
                  aria-label={`Remove ${m.name}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </motion.li>
            ))}
          </AnimatePresence>
        </motion.ul>
      )}
    </div>
  );
}

function MiniField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium text-zinc-600 dark:text-zinc-400">{label}</span>
      {children}
    </label>
  );
}

// ---------------------------------------------------------------------------
// Step 4 -- pay structure + review
// ---------------------------------------------------------------------------

function StepPayAndReview({
  deptName,
  subs,
  members,
  wantRate,
  onWantRate,
  regular,
  onRegular,
  otMode,
  onOtMode,
  customOt,
  onCustomOt,
  currency,
  onCurrency,
}: {
  deptName: string;
  subs: string[];
  members: WizardMember[];
  wantRate: boolean;
  onWantRate: (v: boolean) => void;
  regular: string;
  onRegular: (v: string) => void;
  otMode: 'auto' | 'custom';
  onOtMode: (v: 'auto' | 'custom') => void;
  customOt: string;
  onCustomOt: (v: string) => void;
  currency: PayCurrency;
  onCurrency: (v: PayCurrency) => void;
}) {
  const regularNum = Number(regular);
  const autoOt = regular.trim() !== '' && Number.isFinite(regularNum) ? defaultOtRate(regularNum) : undefined;
  const otDisplay = otMode === 'auto' ? (autoOt != null ? String(autoOt) : '') : customOt;
  const managers = members.filter((m) => m.isManager);

  return (
    <div className="space-y-4">
      {/* Rate */}
      <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
        <div className="flex items-center justify-between gap-2">
          <div>
            <p className="flex items-center gap-1.5 text-sm font-medium text-zinc-800 dark:text-zinc-200">
              <Wallet className="h-4 w-4 text-orange-500" />
              Department pay structure
            </p>
            <p className="mt-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">
              The starting Regular &amp; OT rate for everyone here -- HR onboarding reads it as the
              source of truth. Manage it later from the Pay Structure tab.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={wantRate}
            aria-label="Set the department rate now"
            onClick={() => onWantRate(!wantRate)}
            className={`relative h-5.5 w-10 shrink-0 rounded-full p-0.5 transition-colors ${
              wantRate ? 'bg-orange-500' : 'bg-zinc-300 dark:bg-zinc-700'
            }`}
          >
            <motion.span
              layout
              transition={{ type: 'spring', stiffness: 550, damping: 32 }}
              className={`block h-4.5 w-4.5 rounded-full bg-white shadow ${wantRate ? 'ml-auto' : ''}`}
            />
          </button>
        </div>

        <AnimatePresence initial={false}>
          {wantRate && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.22, ease: EASE }}
              className="overflow-hidden"
            >
              <div className="mt-3 flex flex-wrap items-end gap-3">
                <MiniField label={`Regular rate (${CURRENCY_SYMBOL[currency]}/hr)`}>
                  <Input
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="0.01"
                    value={regular}
                    onChange={(e) => onRegular(e.target.value)}
                    placeholder="0.00"
                    className="h-9 w-32"
                  />
                </MiniField>
                <MiniField label={`OT rate (${CURRENCY_SYMBOL[currency]}/hr)`}>
                  <div className="flex items-center gap-2">
                    <Input
                      type="number"
                      inputMode="decimal"
                      min="0"
                      step="0.01"
                      value={otDisplay}
                      onChange={(e) => onCustomOt(e.target.value)}
                      disabled={otMode === 'auto'}
                      placeholder={otMode === 'auto' ? `${OT_MULTIPLIER}x regular` : '0.00'}
                      className={`h-9 w-28 ${otMode === 'auto' ? 'bg-zinc-100 text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400' : ''}`}
                    />
                    <div className="inline-flex rounded-md border border-zinc-200 p-0.5 dark:border-zinc-800">
                      {(
                        [
                          { key: 'auto', label: `${OT_MULTIPLIER}x regular` },
                          { key: 'custom', label: 'Custom' },
                        ] as const
                      ).map((o) => (
                        <button
                          key={o.key}
                          type="button"
                          onClick={() => onOtMode(o.key)}
                          className={`relative rounded px-2.5 py-1 text-xs font-semibold transition-colors ${
                            otMode === o.key ? 'text-white' : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
                          }`}
                        >
                          {otMode === o.key && (
                            <motion.span
                              layoutId="wizardOtModePill"
                              className="absolute inset-0 rounded bg-orange-500"
                              transition={{ type: 'spring', stiffness: 500, damping: 34 }}
                            />
                          )}
                          <span className="relative z-10">{o.label}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                </MiniField>
                <div className="flex flex-col gap-1">
                  <span className="text-[11px] font-medium text-zinc-600 dark:text-zinc-400">Currency</span>
                  <div className="inline-flex rounded-md border border-zinc-200 p-0.5 dark:border-zinc-800">
                    {PAY_CURRENCIES.map((c) => (
                      <button
                        key={c}
                        type="button"
                        onClick={() => onCurrency(c)}
                        className={`relative rounded px-2.5 py-1 text-xs font-semibold transition-colors ${
                          currency === c ? 'text-white' : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
                        }`}
                      >
                        {currency === c && (
                          <motion.span
                            layoutId="wizardCurrencyPill"
                            className="absolute inset-0 rounded bg-orange-500"
                            transition={{ type: 'spring', stiffness: 500, damping: 34 }}
                          />
                        )}
                        <span className="relative z-10">{currencyChipLabel(c)}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Review */}
      <div className="rounded-lg border border-orange-100 bg-orange-50/40 p-3.5 dark:border-blue-950/60 dark:bg-blue-950/10">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-orange-700/80 dark:text-blue-300/80">
          Ready to create
        </p>
        <p className="mt-1.5 text-sm font-semibold text-zinc-900 dark:text-zinc-100">{deptName}</p>
        <ul className="mt-2 space-y-1 text-xs text-zinc-600 dark:text-zinc-400">
          <li className="flex items-center gap-1.5">
            <Check className="h-3.5 w-3.5 text-emerald-500" />
            {subs.length > 0
              ? `${subs.length} sub-department${subs.length === 1 ? '' : 's'}: ${subs.join(', ')}`
              : 'No sub-departments'}
          </li>
          <li className="flex items-center gap-1.5">
            <Check className="h-3.5 w-3.5 text-emerald-500" />
            {members.length} {members.length === 1 ? 'person' : 'people'} ({managers.length}{' '}
            manager{managers.length === 1 ? '' : 's'}: {managers.map((m) => firstNameOf(m.name)).join(', ')})
          </li>
          <li className="flex items-center gap-1.5">
            <Check className="h-3.5 w-3.5 text-emerald-500" />
            {wantRate && regular.trim() !== ''
              ? `Starting rate ${formatRate(Number(regular), currency)}`
              : 'No rate yet -- set it later in Pay Structure'}
          </li>
        </ul>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Creation progress -- the staged loading animation
// ---------------------------------------------------------------------------

function CreationProgress({
  view,
  onRetry,
  onBackToForm,
  onDone,
  onOpenPayStructure,
}: {
  view: NonNullable<CreationView>;
  onRetry: () => void;
  onBackToForm: () => void;
  onDone: () => void;
  onOpenPayStructure: (deptKey: string) => void;
}) {
  const reducedMotion = useReducedMotion();
  const { stages, notes, error, summary, input } = view;

  return (
    <div className="p-6 sm:p-8">
      {/* Emblem */}
      <div className="flex justify-center">
        <AnimatePresence mode="wait" initial={false}>
          {summary ? (
            <motion.span
              key="success"
              initial={{ scale: 0.5, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: 'spring', stiffness: 380, damping: 22 }}
              className="flex h-16 w-16 items-center justify-center rounded-2xl bg-emerald-100 text-emerald-600 dark:bg-emerald-950/50 dark:text-emerald-400"
            >
              <CheckCircle2 className="h-8 w-8" />
            </motion.span>
          ) : error ? (
            <motion.span
              key="error"
              initial={{ scale: 0.5, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: 'spring', stiffness: 380, damping: 22 }}
              className="flex h-16 w-16 items-center justify-center rounded-2xl bg-red-100 text-red-600 dark:bg-red-950/50 dark:text-red-400"
            >
              <AlertTriangle className="h-8 w-8" />
            </motion.span>
          ) : (
            <motion.span
              key="building"
              className="relative flex h-16 w-16 items-center justify-center rounded-2xl bg-orange-100 text-orange-600 dark:bg-blue-950/60 dark:text-blue-300"
              animate={reducedMotion ? undefined : { scale: [1, 1.06, 1] }}
              transition={reducedMotion ? undefined : { duration: 1.6, repeat: Infinity, ease: 'easeInOut' }}
            >
              {!reducedMotion && (
                <motion.span
                  className="absolute inset-0 rounded-2xl border-2 border-orange-400/60 dark:border-blue-500/50"
                  animate={{ scale: [1, 1.35], opacity: [0.7, 0] }}
                  transition={{ duration: 1.6, repeat: Infinity, ease: 'easeOut' }}
                />
              )}
              <Building2 className="h-8 w-8" />
            </motion.span>
          )}
        </AnimatePresence>
      </div>

      {/* Headline */}
      <div className="mt-4 text-center">
        <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100" aria-live="polite">
          {summary
            ? `${summary.name} is live`
            : error
              ? 'Creation hit a snag'
              : `Creating ${input.name}...`}
        </h2>
        <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
          {summary
            ? `${summary.managersAdded} manager${summary.managersAdded === 1 ? '' : 's'} and ${summary.membersAdded} member${summary.membersAdded === 1 ? '' : 's'} added${summary.rateSet ? ', starting rate set' : ''}.`
            : error
              ? error.message
              : 'Creating department, adding managers, adding members and setting pay rates.'}
        </p>
      </div>

      {/* Stage checklist */}
      <ol className="mx-auto mt-5 max-w-sm space-y-1.5">
        {CREATE_DEPARTMENT_STAGES.map((stage) => {
          const status = stages[stage.key];
          return (
            <motion.li
              key={stage.key}
              layout
              className={`flex items-center gap-2.5 rounded-lg border px-3 py-2 transition-colors ${
                status === 'active'
                  ? 'border-orange-200 bg-orange-50/70 dark:border-blue-900/60 dark:bg-blue-950/30'
                  : status === 'failed'
                    ? 'border-red-200 bg-red-50/70 dark:border-red-900/60 dark:bg-red-950/30'
                    : 'border-zinc-100 dark:border-zinc-900'
              }`}
            >
              <span className="flex h-5 w-5 shrink-0 items-center justify-center">
                <AnimatePresence mode="wait" initial={false}>
                  {status === 'done' ? (
                    <motion.span
                      key="done"
                      initial={{ scale: 0.4, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      transition={{ type: 'spring', stiffness: 500, damping: 24 }}
                      className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500 text-white"
                    >
                      <Check className="h-3 w-3" strokeWidth={3} />
                    </motion.span>
                  ) : status === 'active' ? (
                    <motion.span key="active" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                      <Loader2 className="h-4.5 w-4.5 animate-spin text-orange-500" />
                    </motion.span>
                  ) : status === 'failed' ? (
                    <motion.span
                      key="failed"
                      initial={{ scale: 0.4, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      className="flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-white"
                    >
                      <X className="h-3 w-3" strokeWidth={3} />
                    </motion.span>
                  ) : (
                    <motion.span
                      key="pending"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      className="h-2 w-2 rounded-full bg-zinc-300 dark:bg-zinc-700"
                    />
                  )}
                </AnimatePresence>
              </span>
              <span
                className={`flex-1 text-sm ${
                  status === 'pending'
                    ? 'text-zinc-400 dark:text-zinc-500'
                    : status === 'failed'
                      ? 'font-medium text-red-700 dark:text-red-300'
                      : 'font-medium text-zinc-800 dark:text-zinc-200'
                }`}
              >
                {stage.label}
              </span>
              {notes[stage.key] && status === 'done' && (
                <span className="shrink-0 text-[10.5px] text-zinc-400 dark:text-zinc-500">{notes[stage.key]}</span>
              )}
            </motion.li>
          );
        })}
      </ol>

      {/* Warnings (success with caveats) */}
      {summary && summary.warnings.length > 0 && (
        <div className="mx-auto mt-4 max-w-sm rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900/60 dark:bg-amber-950/30">
          <p className="flex items-center gap-1.5 text-xs font-semibold text-amber-800 dark:text-amber-300">
            <AlertTriangle className="h-3.5 w-3.5" />
            Worth a look
          </p>
          <ul className="mt-1.5 max-h-28 space-y-1 overflow-y-auto text-[11px] leading-relaxed text-amber-800/90 dark:text-amber-200/90">
            {summary.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Actions */}
      <div className="mt-6 flex items-center justify-center gap-2">
        {summary ? (
          <>
            <Button type="button" size="sm" variant="outline" onClick={() => onOpenPayStructure(summary.key)} className="gap-1">
              <Wallet className="h-3.5 w-3.5" />
              Open pay structure
            </Button>
            <Button type="button" size="sm" onClick={onDone} className="bg-orange-500 text-white hover:bg-orange-600">
              Done
            </Button>
          </>
        ) : error ? (
          <>
            <Button type="button" size="sm" variant="outline" onClick={onBackToForm}>
              Back to the form
            </Button>
            <Button type="button" size="sm" onClick={onRetry} className="bg-orange-500 text-white hover:bg-orange-600">
              Try again
            </Button>
          </>
        ) : (
          <p className="text-[11px] text-zinc-400 dark:text-zinc-500" role="status">
            Hang tight -- this takes a few seconds.
          </p>
        )}
      </div>
    </div>
  );
}
