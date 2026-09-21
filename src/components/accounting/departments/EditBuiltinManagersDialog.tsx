'use client';

// Payment Catalog -- Departments -- "Edit" on a MASTER-LIST department card.
//
// A Sheet-synced department owns almost nothing in the app: its name and alias
// map are code, and its people are the Sheet. The one in-app fact is MANAGER
// ACCESS (department_managers), so this dialog edits exactly that --
// Managers -> Review -- and says plainly where the rest comes from. Approved by
// Kane 2026-09-03 (managers-only; the Payment Catalog may be a second write
// path for grants beside Admin -> Roles & permissions).
//
// SCOPED since 2026-09-21 (Kane: "the department created from the master list
// can be edited the same way the ones created from the app"). Manager access is
// a raw grant STRING, and HSL's strings ARE its sub-team access keys, so the
// dialog edits one manager list PER SCOPE:
//   - a flat built-in has ONE scope (its display name, claiming every alias
//     spelling) and looks exactly as it did before;
//   - HSL has one scope per sub-team, so a revoke lands on the team the
//     accountant edited instead of collapsing onto all sixteen.
// Grant labels this dialog does not manage (a bare "HSL" grant, a retired
// sub-key) are listed read-only and never written.

import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  Crown,
  Lock,
  Minus,
  Pencil,
  Plus,
  Save,
  Search,
  Trash2,
  Wallet,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  BUILTIN_MANAGERS_STAGES,
  builtinManagerScopes,
  diffBuiltinManagerScopes,
  partitionBuiltinGrants,
  validateBuiltinManagersInput,
  type BuiltinGrantRow,
  type BuiltinManagersInput,
  type BuiltinManagersSummary,
} from '@/lib/departments/registry';
import { formatDeptLabel } from '@/lib/departments/hsl-subdept';
import { EASE, firstNameOf, initialsOf, type DirectoryPerson } from './department-wizard-steps';
import { StagedProgress, useStagedRun } from './staged-run';

const STEPS = ['Managers', 'Review'] as const;

export type BuiltinManager = { email: string; name: string };

export default function EditBuiltinManagersDialog({
  open,
  dept,
  grantRows,
  roster,
  onClose,
  onChanged,
  onOpenPayStructure,
}: {
  open: boolean;
  dept: { key: string; name: string } | null;
  /** EVERY live department_managers row, raw. The dialog partitions them itself
   *  through the same shared function the route uses, so client and server can
   *  never disagree about which grant belongs to which scope. */
  grantRows: BuiltinGrantRow[];
  roster: DirectoryPerson[];
  onClose: () => void;
  onChanged: () => void;
  onOpenPayStructure: (deptKey: string) => void;
}) {
  const [step, setStep] = useState(0);
  const [dir, setDir] = useState(1);
  /** Lower-cased grantLabel -> the resulting manager list for that scope. */
  const [byScope, setByScope] = useState<Record<string, BuiltinManager[]>>({});
  const { view, running, run, reset } = useStagedRun<BuiltinManagersSummary>();
  const lastInputRef = useRef<BuiltinManagersInput | null>(null);

  const deptKey = dept?.key ?? null;
  const scopes = useMemo(() => (deptKey ? builtinManagerScopes(deptKey) : []), [deptKey]);
  const multi = scopes.length > 1;

  const partition = useMemo(
    () => (deptKey ? partitionBuiltinGrants(deptKey, grantRows) : null),
    [deptKey, grantRows],
  );

  const nameByEmail = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of roster) m.set(p.email, p.name);
    return m;
  }, [roster]);
  const nameOf = (email: string) => nameByEmail.get(email) ?? email;
  const who = (email: string) => firstNameOf(nameOf(email));

  useEffect(() => {
    if (!open || !dept || !partition) return;
    setStep(0);
    setDir(1);
    const seed: Record<string, BuiltinManager[]> = {};
    for (const s of scopes) {
      const lower = s.grantLabel.toLowerCase();
      seed[lower] = (partition.byScope.get(lower) ?? []).map((e) => ({ email: e, name: nameOf(e) }));
    }
    setByScope(seed);
    reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- prefill on open only
  }, [open, deptKey]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !running) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose, running]);

  const input: BuiltinManagersInput | null = dept
    ? {
        builtinKey: dept.key,
        scopes: scopes.map((s) => ({
          grantLabel: s.grantLabel,
          managers: (byScope[s.grantLabel.toLowerCase()] ?? []).map((m) => ({
            name: m.name,
            workEmail: m.email,
          })),
        })),
      }
    : null;

  const validation = input ? validateBuiltinManagersInput(input) : { ok: false };
  const diff = useMemo(
    () => (deptKey && partition && input ? diffBuiltinManagerScopes(deptKey, partition, input) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- input is derived from byScope
    [deptKey, partition, byScope, scopes],
  );

  const totalManagers = scopes.reduce((n, s) => n + (byScope[s.grantLabel.toLowerCase()] ?? []).length, 0);
  const canSave = validation.ok && (diff?.changed ?? false);
  const stepOk = [totalManagers > 0, canSave][step] ?? false;

  const runSave = (payload: BuiltinManagersInput) => {
    lastInputRef.current = payload;
    void run(
      () =>
        fetch('/api/payment-catalog/departments', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }),
      'Updating manager access failed',
    );
  };

  const summaryShown = view?.summary != null;
  useEffect(() => {
    if (summaryShown) onChanged();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire once per save
  }, [summaryShown]);

  const goto = (next: number) => {
    setDir(next > step ? 1 : -1);
    setStep(next);
  };

  const setScopeManagers = (grantLabel: string, v: BuiltinManager[]) =>
    setByScope((prev) => ({ ...prev, [grantLabel.toLowerCase()]: v }));

  const summary = view?.summary ?? null;
  const progressCopy = {
    runningTitle: `Updating ${dept?.name ?? 'department'} managers...`,
    runningDetail: multi
      ? 'Granting and revoking department_managers access, per sub-team.'
      : 'Granting and revoking department_managers access.',
    errorTitle: 'Updating hit a snag',
    success: summary
      ? {
          title: `${summary.name} managers updated`,
          detail:
            (summary.scopes.length > 1
              ? summary.scopes
                  .map(
                    (s) =>
                      `${s.displayName}: ${[
                        s.granted.length ? `+${s.granted.map(who).join(', ')}` : null,
                        s.revoked.length ? `-${s.revoked.map(who).join(', ')}` : null,
                      ]
                        .filter(Boolean)
                        .join(' ')}`,
                  )
                  .join(' · ')
              : [
                  summary.granted.length ? `${summary.granted.map(who).join(', ')} granted` : null,
                  summary.revoked.length ? `${summary.revoked.map(who).join(', ')} revoked` : null,
                ]
                  .filter(Boolean)
                  .join(' · ')) || 'No change.',
          warnings: summary.warnings,
          deptKey: summary.key,
        }
      : null,
  };

  return (
    <AnimatePresence>
      {open && dept && (
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
            aria-label={`Edit ${dept.name} managers`}
            className="relative z-10 flex max-h-[88vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-950"
            initial={{ opacity: 0, y: 24, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 24, scale: 0.96 }}
            transition={{ type: 'spring', stiffness: 320, damping: 30 }}
          >
            <AnimatePresence mode="wait" initial={false}>
              {view ? (
                <motion.div
                  key="progress"
                  initial={{ opacity: 0, scale: 0.98 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.98 }}
                  transition={{ duration: 0.22, ease: EASE }}
                >
                  <StagedProgress
                    view={view}
                    stageList={BUILTIN_MANAGERS_STAGES}
                    copy={progressCopy}
                    onRetry={() => lastInputRef.current && runSave(lastInputRef.current)}
                    onBackToForm={reset}
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
                  <div className="shrink-0 border-b border-zinc-100 p-4 sm:px-5 dark:border-zinc-800">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <h2 className="flex items-center gap-2 text-base font-semibold text-zinc-900 dark:text-zinc-100">
                          <Pencil className="h-4 w-4 text-orange-500" />
                          Edit {dept.name}
                        </h2>
                        <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                          Master-list department · Step {step + 1} of {STEPS.length}
                          {multi ? ` · ${scopes.length} sub-teams` : ''}
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
                        <button key={label} type="button" onClick={() => i !== step && goto(i)} className="group flex-1" title={label}>
                          <span
                            className={`block h-1 rounded-full transition-colors ${
                              i < step ? 'bg-orange-400' : i === step ? 'bg-orange-500' : 'bg-zinc-200 dark:bg-zinc-800'
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
                        {step === 0 &&
                          (multi ? (
                            <ScopedManagersStep
                              deptName={dept.name}
                              scopes={scopes}
                              byScope={byScope}
                              roster={roster}
                              onScope={setScopeManagers}
                              totalManagers={totalManagers}
                            />
                          ) : (
                            <ManagersStep
                              deptName={dept.name}
                              roster={roster}
                              managers={byScope[scopes[0]?.grantLabel.toLowerCase() ?? ''] ?? []}
                              onManagers={(v) => scopes[0] && setScopeManagers(scopes[0].grantLabel, v)}
                            />
                          ))}
                        {step === 1 && (
                          <div className="space-y-4">
                            {!diff?.changed ? (
                              <div className="rounded-lg border border-dashed border-zinc-300 p-6 text-center dark:border-zinc-700">
                                <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Nothing has changed yet</p>
                                <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">Go back to add or remove a manager.</p>
                              </div>
                            ) : (
                              <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                                <p className="flex items-center gap-1.5 text-sm font-medium text-zinc-800 dark:text-zinc-200">
                                  <Save className="h-4 w-4 text-orange-500" />
                                  What will change
                                </p>
                                <ul className="mt-2.5 space-y-1.5 text-xs text-zinc-700 dark:text-zinc-300">
                                  {diff.scopes
                                    .filter((s) => s.granted.length > 0 || s.revoked.length > 0)
                                    .flatMap((s) => [
                                      ...s.granted.map((e) => (
                                        <li key={`g-${s.grantLabel}-${e}`} className="flex items-start gap-2">
                                          <Plus className="mt-px h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                                          <span>
                                            <strong>{who(e)}</strong> ({e}) gets manager access to{' '}
                                            <strong>{s.displayName}</strong> — it shows on their dashboard.
                                          </span>
                                        </li>
                                      )),
                                      ...s.revoked.map((e) => (
                                        <li key={`r-${s.grantLabel}-${e}`} className="flex items-start gap-2">
                                          <Minus className="mt-px h-3.5 w-3.5 shrink-0 text-red-600 dark:text-red-400" />
                                          <span>
                                            <strong>{who(e)}</strong> ({e}) loses manager access to{' '}
                                            <strong>{s.displayName}</strong>
                                            {multi ? ' only — their other sub-teams are untouched.' : ', under every label it was granted as.'}
                                          </span>
                                        </li>
                                      )),
                                    ])}
                                </ul>
                              </div>
                            )}

                            {diff && diff.emptied.length > 0 && (
                              <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300">
                                <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
                                <span>
                                  <strong>{diff.emptied.join(', ')}</strong> will have no manager at all. Its KPI card has
                                  no owner and its sheet goes unscored until someone is assigned.
                                </span>
                              </div>
                            )}

                            {partition && partition.unscoped.length > 0 && (
                              <UnscopedGrants labels={[...new Set(partition.unscoped.map((u) => u.label))]} />
                            )}

                            {!validation.ok && (
                              <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-2.5 text-xs text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300">
                                <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
                                {(validation as { error?: string }).error}
                              </div>
                            )}
                            <WhatTheSheetOwns
                              deptName={dept.name}
                              multi={multi}
                              onOpenPayStructure={() => {
                                onClose();
                                onOpenPayStructure(dept.key);
                              }}
                            />
                          </div>
                        )}
                      </motion.div>
                    </AnimatePresence>
                  </div>

                  <div className="flex shrink-0 items-center justify-between gap-2 border-t border-zinc-100 p-4 sm:px-5 dark:border-zinc-800">
                    <Button type="button" size="sm" variant="outline" onClick={() => (step === 0 ? onClose() : goto(step - 1))} className="gap-1">
                      {step === 0 ? 'Cancel' : (
                        <>
                          <ArrowLeft className="h-3.5 w-3.5" />
                          Back
                        </>
                      )}
                    </Button>
                    {step < STEPS.length - 1 ? (
                      <Button type="button" size="sm" disabled={!stepOk} onClick={() => goto(step + 1)} className="gap-1 bg-orange-500 text-white hover:bg-orange-600">
                        Continue
                        <ArrowRight className="h-3.5 w-3.5" />
                      </Button>
                    ) : (
                      <Button type="button" size="sm" disabled={!canSave} onClick={() => input && runSave(input)} className="gap-1.5 bg-orange-500 text-white hover:bg-orange-600">
                        <Save className="h-3.5 w-3.5" />
                        Save changes
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

/** Multi-scope (HSL): one collapsible manager list per sub-team. Sub-team
 *  identity is the whole point — the lists never merge, so a revoke here can
 *  only ever touch the team it is under. */
function ScopedManagersStep({
  deptName,
  scopes,
  byScope,
  roster,
  onScope,
  totalManagers,
}: {
  deptName: string;
  scopes: { grantLabel: string; displayName: string }[];
  byScope: Record<string, BuiltinManager[]>;
  roster: DirectoryPerson[];
  onScope: (grantLabel: string, v: BuiltinManager[]) => void;
  totalManagers: number;
}) {
  const [openScope, setOpenScope] = useState<string | null>(null);

  return (
    <div className="space-y-3">
      <div
        className={`flex items-start gap-2 rounded-lg border p-2.5 text-xs font-medium transition-colors ${
          totalManagers > 0
            ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-300'
            : 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300'
        }`}
      >
        {totalManagers > 0 ? <CheckCircle2 className="mt-px h-4 w-4 shrink-0" /> : <Crown className="mt-px h-4 w-4 shrink-0" />}
        <span>
          {deptName} grants manager access <strong>per sub-team</strong> — each list below is its own
          access key, so removing someone from one team leaves their others alone.
        </span>
      </div>

      <ul className="space-y-1.5">
        {scopes.map((s) => {
          const lower = s.grantLabel.toLowerCase();
          const managers = byScope[lower] ?? [];
          const isOpen = openScope === lower;
          return (
            <li key={lower} className="overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800">
              <button
                type="button"
                onClick={() => setOpenScope(isOpen ? null : lower)}
                aria-expanded={isOpen}
                className="flex w-full items-center justify-between gap-2 p-2.5 text-left transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-900/60"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-zinc-800 dark:text-zinc-200">
                    {s.displayName}
                  </span>
                  <span className="block truncate text-[11px] text-zinc-400 dark:text-zinc-500">
                    {managers.length === 0
                      ? 'No manager'
                      : managers.map((m) => firstNameOf(m.name)).join(', ')}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-1.5">
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                      managers.length === 0
                        ? 'bg-zinc-100 text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400'
                        : 'bg-orange-100 text-orange-700 dark:bg-blue-950/60 dark:text-blue-300'
                    }`}
                  >
                    {managers.length}
                  </span>
                  <ChevronDown
                    className={`h-4 w-4 text-zinc-400 transition-transform ${isOpen ? 'rotate-180' : ''}`}
                  />
                </span>
              </button>
              <AnimatePresence initial={false}>
                {isOpen && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.2, ease: EASE }}
                    className="overflow-hidden border-t border-zinc-100 dark:border-zinc-800"
                  >
                    <div className="p-2.5">
                      <ManagerPicker
                        scopeName={s.displayName}
                        roster={roster}
                        managers={managers}
                        onManagers={(v) => onScope(s.grantLabel, v)}
                      />
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Single-scope (every flat built-in): unchanged from 2026-09-03. */
function ManagersStep({
  deptName,
  roster,
  managers,
  onManagers,
}: {
  deptName: string;
  roster: DirectoryPerson[];
  managers: BuiltinManager[];
  onManagers: (v: BuiltinManager[]) => void;
}) {
  return (
    <div className="space-y-4">
      <div
        className={`flex items-center gap-2 rounded-lg border p-2.5 text-xs font-medium transition-colors ${
          managers.length > 0
            ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-300'
            : 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300'
        }`}
      >
        {managers.length > 0 ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <Crown className="h-4 w-4 shrink-0" />}
        {managers.length > 0
          ? `${managers.length} manager${managers.length === 1 ? '' : 's'} for ${deptName}.`
          : 'Every department needs at least one Manager -- add one below.'}
      </div>
      <ManagerPicker scopeName={deptName} roster={roster} managers={managers} onManagers={onManagers} />
    </div>
  );
}

/** The roster typeahead + manager list, shared by both shapes so the add/remove
 *  rules can never drift between a flat department and an HSL sub-team. */
function ManagerPicker({
  scopeName,
  roster,
  managers,
  onManagers,
}: {
  scopeName: string;
  roster: DirectoryPerson[];
  managers: BuiltinManager[];
  onManagers: (v: BuiltinManager[]) => void;
}) {
  const [query, setQuery] = useState('');
  const taken = useMemo(() => new Set(managers.map((m) => m.email)), [managers]);
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return roster
      .filter((p) => !taken.has(p.email) && (p.name.toLowerCase().includes(q) || p.email.includes(q)))
      .slice(0, 6);
  }, [query, roster, taken]);

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
        <p className="mb-2 text-xs font-medium text-zinc-700 dark:text-zinc-300">Add a manager from the roster</p>
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
                    onClick={() => {
                      onManagers([...managers, { email: p.email, name: p.name }]);
                      setQuery('');
                    }}
                    className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left transition-colors hover:bg-orange-50 dark:hover:bg-blue-950/30"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-zinc-800 dark:text-zinc-200">{p.name}</span>
                      <span className="block truncate text-[11px] text-zinc-400">{p.email}</span>
                    </span>
                    <span className="shrink-0 rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-medium text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                      {formatDeptLabel(p.department) || 'No department'}
                    </span>
                  </button>
                </li>
              ))}
            </motion.ul>
          )}
        </AnimatePresence>
        <p className="mt-1.5 text-[11px] text-zinc-400 dark:text-zinc-500">
          Grants dashboard oversight of {scopeName} (department_managers). Their roster row is not touched.
        </p>
      </div>

      {managers.length === 0 ? (
        <p className="text-center text-xs text-zinc-400 dark:text-zinc-500">No managers -- add one above.</p>
      ) : (
        <motion.ul layout className="space-y-1.5">
          <AnimatePresence initial={false} mode="popLayout">
            {managers.map((m) => (
              <motion.li
                key={m.email}
                layout
                initial={{ opacity: 0, x: -12 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 12, scale: 0.97 }}
                transition={{ duration: 0.18, ease: EASE }}
                className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-white p-2.5 dark:border-zinc-800 dark:bg-zinc-950"
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-orange-100 text-[11px] font-bold text-orange-700 dark:bg-blue-950/60 dark:text-blue-300">
                  {initialsOf(m.name)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-medium text-zinc-800 dark:text-zinc-200">{m.name}</span>
                    <span className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-orange-100 px-1.5 py-px text-[9.5px] font-bold uppercase tracking-wide text-orange-700 dark:bg-blue-950/60 dark:text-blue-300">
                      <Crown className="h-2.5 w-2.5" />
                      Manager
                    </span>
                  </span>
                  <span className="block truncate text-[11px] text-zinc-400">{m.email}</span>
                </span>
                <button
                  type="button"
                  onClick={() => onManagers(managers.filter((x) => x.email !== m.email))}
                  className="shrink-0 rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40"
                  aria-label={`Remove ${m.name} from ${scopeName}`}
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

/** Grant labels that belong to this department but that no scope claims — a
 *  bare "HSL" grant, or a sub-key this build has retired. Shown so they are
 *  never a silent omission; this dialog deliberately does not write them. */
function UnscopedGrants({ labels }: { labels: string[] }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-zinc-50/60 p-3 text-xs leading-relaxed text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-400">
      <p className="flex items-center gap-1.5 font-medium text-zinc-700 dark:text-zinc-300">
        <Lock className="h-3.5 w-3.5" />
        Left untouched
      </p>
      <p className="mt-1">
        {labels.length} grant label{labels.length === 1 ? '' : 's'} on this department{' '}
        {labels.length === 1 ? 'is' : 'are'} not one of the lists above, so this dialog neither grants nor
        revokes {labels.length === 1 ? 'it' : 'them'}: <strong>{labels.join(', ')}</strong>. Change{' '}
        {labels.length === 1 ? 'it' : 'them'} in Admin → Roles &amp; permissions.
      </p>
    </div>
  );
}

function WhatTheSheetOwns({
  deptName,
  multi,
  onOpenPayStructure,
}: {
  deptName: string;
  multi: boolean;
  onOpenPayStructure: () => void;
}) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-zinc-50/60 p-3 text-xs leading-relaxed text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-400">
      <p className="font-medium text-zinc-700 dark:text-zinc-300">What this dialog cannot change</p>
      <ul className="mt-1.5 list-disc space-y-1 pl-4">
        <li>
          <strong>Name</strong> — {deptName} is a built-in payroll department; its name and aliases live in code.
        </li>
        <li>
          <strong>People</strong> — come from the Google Sheet master-list sync; moving someone is a department transfer.
        </li>
        {multi && (
          <li>
            <strong>Which sub-teams exist</strong> — {deptName}&rsquo;s sub-teams are code; this dialog edits who manages them.
          </li>
        )}
      </ul>
      <button
        type="button"
        onClick={onOpenPayStructure}
        className="mt-2 inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-semibold text-orange-600 transition-colors hover:bg-orange-50 dark:text-blue-300 dark:hover:bg-blue-950/40"
      >
        <Wallet className="h-3.5 w-3.5" />
        Rates live in Pay structure
      </button>
    </div>
  );
}
