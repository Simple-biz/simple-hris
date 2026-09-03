'use client';

// Payment Catalog -- "Department" tab.
//
// A directory of every department (the built-in payroll departments plus the
// in-app ones created here), the "Create a Department" flow, and -- on every
// in-app card -- "Edit" (departments/EditDepartmentDialog.tsx):
//
//   name -> optional sub-departments (HSL-style) -> initial people (at least
//   one Manager required) -> optional department pay rate -> create.
//
// Creation POSTs to /api/payment-catalog/departments, which streams one ndjson
// event per stage; the overlay's staged animation ("Creating department,
// adding managers, adding members and setting pay rates") advances on REAL
// progress, lightly paced so the checkmarks read as steps instead of a blink.
// The steps, the stream consumer and the overlay are shared with Edit
// (departments/department-wizard-steps.tsx, departments/staged-run.tsx).
//
// SELF-CONTAINED: in-app departments do NOT depend on the Global Master List.
// Their people live as member records on the registry entry itself; creation
// writes nothing to the roster or the master Google Sheet. The roster prop is
// used only as an autofill convenience in the people picker and for the
// built-in departments' headcounts. Managers get department_managers oversight
// rows, and the optional rate becomes a department-scoped Payment Catalog
// structure the Pay Structure tab manages from then on.

import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  ArrowLeft,
  ArrowRight,
  Building2,
  Check,
  ChevronRight,
  FolderTree,
  Pencil,
  Plus,
  Sparkles,
  Users,
  Wallet,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DEPARTMENTS } from '@/lib/payroll/department-bonus';
import { normalizeDeptToKey } from '@/lib/payroll/normalize-dept-key';
import {
  CREATE_DEPARTMENT_STAGES,
  slugifyDeptKey,
  subDeptStructureKey,
  validateCreateDepartmentInput,
  type CreateDepartmentInput,
  type CreateDepartmentSummary,
  type DepartmentRegistryEntry,
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
import {
  EASE,
  MiniField,
  StepName,
  StepPeople,
  StepSubDepartments,
  firstNameOf,
  type DirectoryPerson,
  type WizardMember,
  type WizardSub,
} from './departments/department-wizard-steps';
import { StagedProgress, useStagedRun } from './departments/staged-run';
import EditDepartmentDialog from './departments/EditDepartmentDialog';
import EditBuiltinManagersDialog from './departments/EditBuiltinManagersDialog';
import { isBuiltinManagersEditable } from '@/lib/departments/registry';

export type { DirectoryPerson };

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Card cover: Hogan Smith Law's own logo fills the banner; every other
 *  department gets the Simple wordmark centered on a neutral strip. */
function DeptCardCover({ deptKey }: { deptKey: string }) {
  const isHsl = deptKey === 'hogan_smith_law';
  return (
    <div className="relative -mx-4 -mt-4 mb-3 h-16 overflow-hidden rounded-t-xl">
      {isHsl ? (
        // eslint-disable-next-line @next/next/no-img-element -- fixed static asset, no need for next/image sizing
        <img src="/HSL.png" alt="Hogan Smith Law" className="h-full w-full object-cover" />
      ) : (
        <div className="flex h-full w-full items-center justify-center border-b border-zinc-200/70 bg-gradient-to-br from-zinc-50 to-zinc-100 dark:border-zinc-200/20">
          {/* Kept on a light plate in both themes -- the wordmark is navy-on-transparent
              with no light variant, so a dark backdrop would wash it out. */}
          {/* eslint-disable-next-line @next/next/no-img-element -- fixed static asset, no need for next/image sizing */}
          <img src="/simple-logo.png" alt="Simple" className="h-6 w-auto object-contain opacity-90" />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab root
// ---------------------------------------------------------------------------

export default function DepartmentsTab({
  roster,
  payStructures,
  registry,
  registryRevision,
  managersByDept,
  onChanged,
  onOpenPayStructure,
}: {
  roster: DirectoryPerson[];
  payStructures: PayStructure[];
  registry: DepartmentRegistryEntry[];
  /** app_settings revision of the registry (GET `revision`); Edit hands it back
   *  so a stale save is refused instead of clobbering a teammate's edit. */
  registryRevision: string | null;
  /** dept string (lower-cased, as stored in department_managers) -> manager emails. */
  managersByDept: Record<string, string[]>;
  /** Refetch catalog data after a successful create / edit. */
  onChanged: () => void;
  /** Jump to the Pay Structure tab focused on a department key. */
  onOpenPayStructure: (deptKey: string) => void;
}) {
  const [wizardOpen, setWizardOpen] = useState(false);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  // The live entry for the key being edited -- so a refetch mid-dialog (a
  // teammate's change arriving over realtime) is reflected, and a department
  // that disappears closes the dialog instead of editing a ghost.
  const editingEntry = useMemo(
    () => (editingKey ? registry.find((e) => e.key === editingKey) ?? null : null),
    [editingKey, registry],
  );
  useEffect(() => {
    if (editingKey && !editingEntry) setEditingKey(null);
  }, [editingKey, editingEntry]);
  // Master-list cards edit MANAGERS only (§7) -- the rest of their shape is the
  // Sheet's and code's. HSL is excluded: its grants are per-sub-team access keys.
  const [builtinEditingKey, setBuiltinEditingKey] = useState<string | null>(null);
  const builtinEditing = useMemo(
    () => (builtinEditingKey ? DEPARTMENTS.find((d) => d.key === builtinEditingKey) ?? null : null),
    [builtinEditingKey],
  );

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
  /** A sub-department's own base rate (keyed `<parentKey>:<subKey>`). */
  const subDeptRate = (parentKey: string, subKey: string) =>
    payStructures.find(
      (s) => s.scope === 'department' && s.departmentKey === subDeptStructureKey(parentKey, subKey),
    ) ?? null;
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
          subtitle="Departments made here, with their internal structure. Edit to rename, restructure or change people."
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
              const formerNames = entry.previousNames ?? [];
              return (
                <div
                  key={entry.key}
                  className="group rounded-xl border border-zinc-200 bg-white p-4 transition-shadow hover:shadow-md dark:border-zinc-800 dark:bg-zinc-950"
                >
                  <DeptCardCover deptKey={entry.key} />
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h3 className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100" title={entry.name}>
                        {entry.name}
                      </h3>
                      <p className="mt-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">
                        {entry.members.length} {entry.members.length === 1 ? 'person' : 'people'}
                        {managerLabelForEntry(entry)
                          ? ` · Manager: ${managerLabelForEntry(entry)}`
                          : ' · No manager assigned'}
                      </p>
                      {formerNames.length > 0 && (
                        <p
                          className="mt-0.5 truncate text-[10.5px] text-zinc-400 dark:text-zinc-500"
                          title={`Formerly ${formerNames.join(', ')}`}
                        >
                          Formerly {formerNames.join(', ')}
                        </p>
                      )}
                    </div>
                    <span className="shrink-0 rounded-full bg-orange-100 px-2 py-0.5 text-[10px] font-semibold text-orange-700 dark:bg-blue-950/60 dark:text-blue-300">
                      In-app
                    </span>
                  </div>

                  {entry.subDepartments.length > 0 && (
                    <div className="mt-2.5 flex flex-wrap gap-1">
                      {entry.subDepartments.map((sub) => {
                        const sr = subDeptRate(entry.key, sub.key);
                        return (
                          <span
                            key={sub.key}
                            className="rounded-md bg-zinc-100 px-1.5 py-0.5 text-[10.5px] font-medium text-zinc-600 dark:bg-zinc-900 dark:text-zinc-300"
                          >
                            {sub.name}
                            {sr && (
                              <span className="ml-1 font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
                                {formatRate(sr.regularRate, sr.currency)}
                              </span>
                            )}
                          </span>
                        );
                      })}
                    </div>
                  )}

                  <div className="mt-3 flex items-center justify-between gap-2 border-t border-zinc-100 pt-2.5 dark:border-zinc-900">
                    <span className="min-w-0 truncate text-xs font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
                      {rate ? (
                        formatRate(rate.regularRate, rate.currency)
                      ) : entry.subDepartments.length > 0 ? (
                        (() => {
                          const rated = entry.subDepartments.filter((sub) => subDeptRate(entry.key, sub.key)).length;
                          return rated > 0 ? (
                            <>{rated}/{entry.subDepartments.length} sub-department rates</>
                          ) : (
                            <span className="font-medium text-zinc-400 dark:text-zinc-500">No rate set</span>
                          );
                        })()
                      ) : (
                        <span className="font-medium text-zinc-400 dark:text-zinc-500">No rate set</span>
                      )}
                      {overrideCount(entry.key) > 0 && (
                        <span className="ml-1.5 font-medium text-zinc-400">
                          +{overrideCount(entry.key)} individual
                        </span>
                      )}
                    </span>
                    <span className="flex shrink-0 items-center gap-0.5">
                      <button
                        type="button"
                        onClick={() => setEditingKey(entry.key)}
                        className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-semibold text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-900 dark:hover:text-zinc-100"
                        aria-label={`Edit ${entry.name}`}
                      >
                        <Pencil className="h-3 w-3" />
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => onOpenPayStructure(entry.key)}
                        className="inline-flex items-center gap-0.5 rounded-md px-1.5 py-1 text-[11px] font-semibold text-orange-600 transition-colors hover:bg-orange-50 dark:text-blue-300 dark:hover:bg-blue-950/40"
                      >
                        Pay structure
                        <ChevronRight className="h-3.5 w-3.5" />
                      </button>
                    </span>
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
                <DeptCardCover deptKey={d.key} />
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
                  <span className="flex shrink-0 items-center gap-0.5">
                    {isBuiltinManagersEditable(d.key) ? (
                      <button
                        type="button"
                        onClick={() => setBuiltinEditingKey(d.key)}
                        className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-semibold text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-900 dark:hover:text-zinc-100"
                        aria-label={`Edit ${d.name} managers`}
                        title="Edit managers"
                      >
                        <Pencil className="h-3 w-3" />
                        Edit
                      </button>
                    ) : (
                      <span
                        className="px-1.5 py-1 text-[10.5px] font-medium text-zinc-400 dark:text-zinc-500"
                        title="HSL manager access is granted per sub-team in Roles & permissions"
                      >
                        Managers per sub-team
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => onOpenPayStructure(d.key)}
                      className="inline-flex items-center gap-0.5 rounded-md px-1.5 py-1 text-[11px] font-semibold text-orange-600 transition-colors hover:bg-orange-50 dark:text-blue-300 dark:hover:bg-blue-950/40"
                    >
                      Pay structure
                      <ChevronRight className="h-3.5 w-3.5" />
                    </button>
                  </span>
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
        onCreated={onChanged}
        onOpenPayStructure={onOpenPayStructure}
      />

      <EditDepartmentDialog
        open={editingEntry !== null}
        entry={editingEntry}
        registry={registry}
        registryRevision={registryRevision}
        roster={roster}
        payStructures={payStructures}
        onClose={() => setEditingKey(null)}
        onChanged={onChanged}
        onOpenPayStructure={onOpenPayStructure}
      />

      <EditBuiltinManagersDialog
        open={builtinEditing !== null}
        dept={builtinEditing ? { key: builtinEditing.key, name: builtinEditing.name } : null}
        currentManagers={
          builtinEditing
            ? Array.from(managersForKey.get(builtinEditing.key) ?? []).map((e) => ({
                email: e,
                name: nameByEmail.get(e) ?? e,
              }))
            : []
        }
        roster={roster}
        onClose={() => setBuiltinEditingKey(null)}
        onChanged={onChanged}
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

const STEPS = ['Department', 'Sub-departments', 'People', 'Pay & review'] as const;

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
  const [step, setStep] = useState(0);
  const [dir, setDir] = useState(1);

  // Step 1 -- name
  const [name, setName] = useState('');
  // Step 2 -- sub-departments (each with its own optional base rate)
  const [wantsSubs, setWantsSubs] = useState<'no' | 'yes'>('no');
  const [subs, setSubs] = useState<WizardSub[]>([]);
  // Step 3 -- people
  const [members, setMembers] = useState<WizardMember[]>([]);
  // Step 4 -- pay
  const [wantRate, setWantRate] = useState(true);
  const [regular, setRegular] = useState('');
  const [otMode, setOtMode] = useState<'auto' | 'custom'>('auto');
  const [customOt, setCustomOt] = useState('');
  const [currency, setCurrency] = useState<PayCurrency>('PHP');

  // Creation progress (replaces the form while running)
  const { view: creation, running, run, reset: resetRun } = useStagedRun<CreateDepartmentSummary>();
  const lastInputRef = useRef<CreateDepartmentInput | null>(null);

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
    resetRun();
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset on open only
  }, [open]);

  // ----- validation per step -----
  const trimmedName = name.trim();
  // Collisions are checked against the things this feature owns or maps to
  // (built-in payroll departments + the in-app registry, former names included)
  // -- deliberately NOT against Global Master List department strings, which
  // live elsewhere.
  const existingNames = useMemo(() => {
    const set = new Set<string>();
    for (const d of DEPARTMENTS) set.add(d.name.toLowerCase());
    for (const e of registry) {
      set.add(e.name.toLowerCase());
      for (const former of e.previousNames ?? []) set.add(former.toLowerCase());
    }
    return set;
  }, [registry]);
  const nameCollision =
    trimmedName.length > 0 &&
    (existingNames.has(trimmedName.toLowerCase()) || normalizeDeptToKey(trimmedName) !== null);
  const nameOk = trimmedName.length > 0 && trimmedName.length <= 60 && !nameCollision && slugifyDeptKey(trimmedName) !== '';

  // A sub row's rate is optional (blank regular = no rate yet), but whatever
  // is typed must be a valid non-negative number.
  const subRateValid = (s: WizardSub) => {
    const reg = s.regular.trim();
    if (reg === '') return true;
    const regNum = Number(reg);
    if (!Number.isFinite(regNum) || regNum < 0) return false;
    const ot = s.ot.trim();
    if (ot === '') return true;
    const otNum = Number(ot);
    return Number.isFinite(otNum) && otNum >= 0;
  };
  const subsOk = wantsSubs === 'no' || (subs.length > 0 && subs.every(subRateValid));
  const managerCount = members.filter((m) => m.isManager).length;
  const peopleOk = members.length > 0 && managerCount > 0;

  const regularNum = Number(regular);
  const regularValid = regular.trim() !== '' && Number.isFinite(regularNum) && regularNum >= 0;
  const customOtNum = customOt.trim() === '' ? undefined : Number(customOt);
  const otValid = otMode === 'auto' || customOtNum === undefined || (Number.isFinite(customOtNum) && customOtNum >= 0);
  // With sub-departments, base rates live ON the subs (set in Step 2) — the
  // department itself carries no rate, so there is nothing to validate here.
  const payOk = wantsSubs === 'yes' || !wantRate || (regularValid && otValid);

  const stepOk = [nameOk, subsOk, peopleOk, payOk][step] ?? false;

  const effectiveSubs = wantsSubs === 'yes' ? subs : [];

  const buildInput = (): CreateDepartmentInput => ({
    name: trimmedName,
    subDepartments: effectiveSubs.map((s) => {
      const reg = s.regular.trim();
      const ot = s.ot.trim();
      return {
        name: s.name,
        payStructure:
          reg === ''
            ? null
            : {
                regularRate: Number(reg),
                otRate: ot === '' ? defaultOtRate(Number(reg)) : Number(ot),
                currency: s.currency,
              },
      };
    }),
    members: members.map(({ id: _id, ...m }) => ({
      ...m,
      // A sub-department pick is only meaningful when subs are on.
      subDepartment: wantsSubs === 'yes' ? m.subDepartment ?? null : null,
    })),
    // Base rates ride the sub-departments when they exist (the HSL model).
    payStructure:
      wantsSubs === 'no' && wantRate
        ? {
            regularRate: regularNum,
            otRate: otMode === 'auto' ? defaultOtRate(regularNum) : customOtNum,
            currency,
          }
        : null,
  });

  // ----- creation run: consume the ndjson stream -----
  const runCreate = (input: CreateDepartmentInput) => {
    lastInputRef.current = input;
    void run(
      () =>
        fetch('/api/payment-catalog/departments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        }),
      'Department creation failed',
    );
  };

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

  const summary = creation?.summary ?? null;
  const progressCopy = {
    runningTitle: `Creating ${lastInputRef.current?.name ?? trimmedName}...`,
    runningDetail: 'Creating department, adding managers, adding members and setting pay rates.',
    errorTitle: 'Creation hit a snag',
    success: summary
      ? {
          title: `${summary.name} is live`,
          detail: `${summary.managersAdded} manager${summary.managersAdded === 1 ? '' : 's'} and ${summary.membersAdded} member${summary.membersAdded === 1 ? '' : 's'} added${
            summary.subRatesSet > 0
              ? `, ${summary.subRatesSet} sub-department rate${summary.subRatesSet === 1 ? '' : 's'} set`
              : summary.rateSet
                ? ', starting rate set'
                : ''
          }.`,
          warnings: summary.warnings,
          deptKey: summary.key,
        }
      : null,
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
                  <StagedProgress
                    view={creation}
                    stageList={CREATE_DEPARTMENT_STAGES}
                    copy={progressCopy}
                    onRetry={() => lastInputRef.current && runCreate(lastInputRef.current)}
                    onBackToForm={resetRun}
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
                            subs={effectiveSubs.map((s) => ({ key: slugifyDeptKey(s.name), name: s.name }))}
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
                        onClick={() => runCreate(buildInput())}
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
// Step 4 -- pay & review (create only; Edit has its own Review step)
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
  subs: WizardSub[];
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
  const hasSubs = subs.length > 0;
  const ratedSubs = subs.filter((s) => s.regular.trim() !== '');

  // With sub-departments, base rates were set per sub in Step 2 — the
  // department itself carries no rate, so the rate editor gives way to a
  // read-only recap of what Step 2 configured.
  if (hasSubs) {
    return (
      <div className="space-y-4">
        <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
          <p className="flex items-center gap-1.5 text-sm font-medium text-zinc-800 dark:text-zinc-200">
            <Wallet className="h-4 w-4 text-orange-500" />
            Sub-department base rates
          </p>
          <p className="mt-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">
            {deptName || 'This department'} carries no department-wide rate — each sub-department&apos;s
            base rate is the fallback for its people (an individual rate always wins). Manage them
            later from the Pay Structure tab.
          </p>
          <ul className="mt-2.5 space-y-1">
            {subs.map((s) => (
              <li
                key={s.id}
                className="flex items-center justify-between gap-2 rounded-md bg-zinc-50 px-2.5 py-1.5 text-xs dark:bg-zinc-900"
              >
                <span className="flex min-w-0 items-center gap-1.5 font-medium text-zinc-700 dark:text-zinc-300">
                  <FolderTree className="h-3 w-3 shrink-0 text-orange-500" />
                  <span className="truncate">{s.name}</span>
                </span>
                <span className="shrink-0 tabular-nums text-zinc-500 dark:text-zinc-400">
                  {s.regular.trim() === ''
                    ? 'No rate yet'
                    : `${formatRate(Number(s.regular), s.currency)}${
                        s.ot.trim() === '' ? ` · OT auto ${OT_MULTIPLIER}x` : ` · OT ${formatRate(Number(s.ot), s.currency)}`
                      }`}
                </span>
              </li>
            ))}
          </ul>
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
              {subs.length} sub-department{subs.length === 1 ? '' : 's'}:{' '}
              {subs.map((s) => s.name).join(', ')}
            </li>
            <li className="flex items-center gap-1.5">
              <Check className="h-3.5 w-3.5 text-emerald-500" />
              {members.length} {members.length === 1 ? 'person' : 'people'} ({managers.length}{' '}
              manager{managers.length === 1 ? '' : 's'}: {managers.map((m) => firstNameOf(m.name)).join(', ')})
            </li>
            <li className="flex items-center gap-1.5">
              <Check className="h-3.5 w-3.5 text-emerald-500" />
              {ratedSubs.length > 0
                ? `Base rates on ${ratedSubs.length} of ${subs.length} sub-department${subs.length === 1 ? '' : 's'} — no department-wide rate`
                : 'No rates yet -- set each sub-department later in Pay Structure'}
            </li>
          </ul>
        </div>
      </div>
    );
  }

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
            No sub-departments
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
