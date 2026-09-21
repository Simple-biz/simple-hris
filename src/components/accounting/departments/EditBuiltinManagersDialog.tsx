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
  ArrowLeftRight,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  Crown,
  Layers,
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
  BUILTIN_EDIT_STAGES,
  builtinManagerScopes,
  diffBuiltinPeople,
  diffBuiltinManagerScopes,
  partitionBuiltinGrants,
  validateBuiltinManagersInput,
  validateBuiltinPeopleInput,
  type BuiltinGrantRow,
  type BuiltinPersonMove,
  type BuiltinManagersInput,
  slugifyDeptKey,
  type BuiltinManagersSummary,
  type DepartmentSubUnit,
} from '@/lib/departments/registry';
import {
  builtinSubLabel,
  builtinSubsFor,
  diffBuiltinSubs,
  pinnedSubDepartments,
  placeableSubIndex,
  supportsDataSubDepartments,
  validateBuiltinSubsInput,
  builtinSubOccupancy,
  type BuiltinSubMap,
} from '@/lib/departments/builtin-subs';
import { formatDeptLabel } from '@/lib/departments/hsl-subdept';
import { normalizeDeptToKey } from '@/lib/payroll/normalize-dept-key';
import { EASE, firstNameOf, initialsOf, type DirectoryPerson } from './department-wizard-steps';
import { StagedProgress, useStagedRun } from './staged-run';

const STEPS = ['Managers', 'Sub-departments', 'People', 'Review'] as const;

export type BuiltinManager = { email: string; name: string };

export default function EditBuiltinManagersDialog({
  open,
  dept,
  grantRows,
  roster,
  departmentOptions,
  builtinSubs,
  builtinSubsRevision,
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
  /** Every PLACEABLE destination label (built-ins, HSL sub-teams, in-app
   *  departments). A bare family label is deliberately absent — it is not a
   *  placement. */
  departmentOptions: { value: string; label: string }[];
  /** Built-in sub-departments as stored, plus the app_settings revision the
   *  editor hands back so a stale save is a 409 and never a silent overwrite. */
  builtinSubs: BuiltinSubMap;
  builtinSubsRevision: string | null;
  onClose: () => void;
  onChanged: () => void;
  onOpenPayStructure: (deptKey: string) => void;
}) {
  const [step, setStep] = useState(0);
  const [dir, setDir] = useState(1);
  /** Lower-cased grantLabel -> the resulting manager list for that scope. */
  const [byScope, setByScope] = useState<Record<string, BuiltinManager[]>>({});
  const [moves, setMoves] = useState<BuiltinPersonMove[]>([]);
  const [subs, setSubs] = useState<DepartmentSubUnit[]>([]);
  const { view, running, run, reset } = useStagedRun<BuiltinManagersSummary>();
  const lastInputRef = useRef<BuiltinManagersInput | null>(null);

  const deptKey = dept?.key ?? null;

  const nameByEmail = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of roster) m.set(p.email, p.name);
    return m;
  }, [roster]);
  const nameOf = (email: string) => nameByEmail.get(email) ?? email;
  const who = (email: string) => firstNameOf(nameOf(email));

  useEffect(() => {
    if (!open || !dept) return;
    setStep(0);
    setDir(1);
    // Seed from the STORED sub map, never from `subs` state: that state is []
    // until this effect sets it, and scopes built from [] would seed every HSL
    // data sub-team's manager list EMPTY -- a save would then revoke them.
    const storedSubs = builtinSubsFor(builtinSubs, dept.key);
    const storedIndex = placeableSubIndex({ ...builtinSubs, [dept.key]: storedSubs });
    const seedScopes = builtinManagerScopes(dept.key, storedIndex);
    const seedPartition = partitionBuiltinGrants(dept.key, grantRows, storedIndex);
    const seed: Record<string, BuiltinManager[]> = {};
    for (const s of seedScopes) {
      const lower = s.grantLabel.toLowerCase();
      seed[lower] = (seedPartition.byScope.get(lower) ?? []).map((e) => ({ email: e, name: nameOf(e) }));
    }
    setByScope(seed);
    setMoves([]);
    setSubs(storedSubs);
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

  const subsEditable = deptKey ? supportsDataSubDepartments(deptKey) : false;
  const subsValidation =
    deptKey && subsEditable ? validateBuiltinSubsInput({ builtinKey: deptKey, subDepartments: subs }) : { ok: true as const };
  const subsDiff = deptKey ? diffBuiltinSubs(builtinSubsFor(builtinSubs, deptKey), subs) : null;
  /** The sub map as it will be AFTER this save — a sub added in this same save
   *  has to be a legal destination for a move in this same save. */
  const prospectiveSubs = useMemo(
    () => (deptKey ? placeableSubIndex({ ...builtinSubs, [deptKey]: subs }) : {}),
    [builtinSubs, deptKey, subs],
  );
  /** How many roster people sit in each sub right now — a populated sub cannot
   *  be removed, mirrored server-side against the live master list. */
  const subOccupancy = useMemo(
    () => (deptKey ? builtinSubOccupancy(deptKey, roster.map((p) => p.department)) : new Map<string, number>()),
    [deptKey, roster],
  );
  /** Sub-teams that exist in code (HSL's 16): shown pinned, never edited here. */
  const pinnedSubs = useMemo(() => (deptKey ? pinnedSubDepartments(deptKey) : []), [deptKey]);

  // Manager scopes follow the PROSPECTIVE sub map: an HSL data sub-team is a
  // scope of its own, so a team added on step 2 can be given a manager on
  // step 1 by going back.
  const scopes = useMemo(
    () => (deptKey ? builtinManagerScopes(deptKey, prospectiveSubs) : []),
    [deptKey, prospectiveSubs],
  );
  const multi = scopes.length > 1;
  const partition = useMemo(
    () => (deptKey ? partitionBuiltinGrants(deptKey, grantRows, prospectiveSubs) : null),
    [deptKey, grantRows, prospectiveSubs],
  );

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
        people: moves,
        ...(subsEditable ? { subDepartments: subs, expectedSubsRevision: builtinSubsRevision } : {}),
      }
    : null;

  const validation = input ? validateBuiltinManagersInput(input, prospectiveSubs) : { ok: false };
  const peopleValidation = deptKey
    ? validateBuiltinPeopleInput({ builtinKey: deptKey, moves }, prospectiveSubs)
    : { ok: true as const };
  const peopleDiff = deptKey ? diffBuiltinPeople(deptKey, { builtinKey: deptKey, moves }) : null;
  const diff = useMemo(
    () =>
      deptKey && partition && input ? diffBuiltinManagerScopes(deptKey, partition, input, prospectiveSubs) : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- input is derived from byScope
    [deptKey, partition, byScope, scopes, prospectiveSubs],
  );

  const totalManagers = scopes.reduce((n, s) => n + (byScope[s.grantLabel.toLowerCase()] ?? []).length, 0);
  const canSave =
    validation.ok &&
    peopleValidation.ok &&
    subsValidation.ok &&
    ((diff?.changed ?? false) || (peopleDiff?.changed ?? false) || (subsDiff?.changed ?? false));
  const stepOk = [totalManagers > 0, subsValidation.ok, peopleValidation.ok, canSave][step] ?? false;

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
    runningTitle: `Updating ${dept?.name ?? 'department'}...`,
    runningDetail: peopleDiff?.changed
      ? 'Updating manager access, then moving people on the master list and the Sheet.'
      : multi
        ? 'Granting and revoking department_managers access, per sub-team.'
        : 'Granting and revoking department_managers access.',
    errorTitle: 'Updating hit a snag',
    success: summary
      ? {
          title: summary.people?.moved
            ? `${summary.name} updated — ${summary.people.moved} moved`
            : summary.subs
              ? `${summary.name} sub-departments updated`
              : `${summary.name} managers updated`,
          detail:
            [
              summary.subs
                ? [
                    summary.subs.added ? `+${summary.subs.added} sub-dept` : null,
                    summary.subs.removed ? `-${summary.subs.removed} sub-dept` : null,
                    summary.subs.renamed ? `${summary.subs.renamed} renamed` : null,
                  ]
                    .filter(Boolean)
                    .join(' ')
                : null,
            ]
              .filter(Boolean)
              .concat(
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
                  .join(' · ')) || [],
              )
              .filter(Boolean)
              .join(' · ') || 'No change.',
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
                    stageList={BUILTIN_EDIT_STAGES}
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
                        {step === 1 && dept && (
                          <SubDepartmentsStep
                            deptKey={dept.key}
                            deptName={dept.name}
                            subs={subs}
                            onSubs={setSubs}
                            pinned={pinnedSubs}
                            occupancy={subOccupancy}
                            error={(subsValidation as { error?: string }).error}
                          />
                        )}
                        {step === 2 && dept && (
                          <PeopleStep
                            deptKey={dept.key}
                            deptName={dept.name}
                            roster={roster}
                            moves={moves}
                            onMoves={setMoves}
                            departmentOptions={departmentOptions}
                          />
                        )}
                        {step === 3 && (
                          <div className="space-y-4">
                            {!diff?.changed && !peopleDiff?.changed && !subsDiff?.changed ? (
                              <div className="rounded-lg border border-dashed border-zinc-300 p-6 text-center dark:border-zinc-700">
                                <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Nothing has changed yet</p>
                                <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">Go back to change a manager, a sub-department, or move someone.</p>
                              </div>
                            ) : diff?.changed ? (
                              <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                                <p className="flex items-center gap-1.5 text-sm font-medium text-zinc-800 dark:text-zinc-200">
                                  <Save className="h-4 w-4 text-orange-500" />
                                  Manager access
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
                            ) : null}

                            {subsDiff && subsDiff.changed && (
                              <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                                <p className="flex items-center gap-1.5 text-sm font-medium text-zinc-800 dark:text-zinc-200">
                                  <Layers className="h-4 w-4 text-orange-500" />
                                  Sub-departments
                                </p>
                                <ul className="mt-2.5 space-y-1.5 text-xs text-zinc-700 dark:text-zinc-300">
                                  {subsDiff.added.map((sub) => (
                                    <li key={`sa-${sub.key}`} className="flex items-start gap-2">
                                      <Plus className="mt-px h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                                      <span>
                                        <strong>{sub.name}</strong> is added. People can be placed in it as{' '}
                                        <code className="text-[10px]">{builtinSubLabel(dept.key, sub.key)}</code>, and it
                                        can carry its own base rate in Pay structure
                                        {pinnedSubs.length > 0 ? ' — no KPI calculator of its own' : ''}.
                                      </span>
                                    </li>
                                  ))}
                                  {subsDiff.renamed.map((r) => (
                                    <li key={`sr-${r.key}`} className="flex items-start gap-2">
                                      <Pencil className="mt-px h-3.5 w-3.5 shrink-0 text-orange-500" />
                                      <span>
                                        <strong>{r.from}</strong> is renamed to <strong>{r.to}</strong> — the label only.
                                        Its rate row and everyone in it stay attached.
                                      </span>
                                    </li>
                                  ))}
                                  {subsDiff.removed.map((sub) => (
                                    <li key={`sx-${sub.key}`} className="flex items-start gap-2">
                                      <Minus className="mt-px h-3.5 w-3.5 shrink-0 text-red-600 dark:text-red-400" />
                                      <span>
                                        <strong>{sub.name}</strong> is removed, and its own base rate row goes with it.
                                      </span>
                                    </li>
                                  ))}
                                </ul>
                                {subsDiff.added.length > 0 &&
                                  builtinSubsFor(builtinSubs, dept.key).length === 0 &&
                                  pinnedSubs.length === 0 && (
                                    <p className="mt-2 rounded-md bg-amber-50 p-2 text-[11px] text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
                                      {dept.name} has no sub-departments today. Once it has them,{' '}
                                      <strong>new</strong> people must be placed in one — everyone already in{' '}
                                      {dept.name} stays exactly where they are.
                                    </p>
                                  )}
                              </div>
                            )}

                            {peopleDiff && peopleDiff.changed && (
                              <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                                <p className="flex items-center gap-1.5 text-sm font-medium text-zinc-800 dark:text-zinc-200">
                                  <ArrowLeftRight className="h-4 w-4 text-orange-500" />
                                  People moving ({peopleDiff.moves.length})
                                </p>
                                <p className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">
                                  Each one writes the master list, mirrors the Google Sheet and files an
                                  applied transfer record.
                                </p>
                                <ul className="mt-2 space-y-1.5 text-xs text-zinc-700 dark:text-zinc-300">
                                  {peopleDiff.moves.map((m) => (
                                    <li key={`mv-${m.workEmail}`} className="flex items-start gap-2">
                                      <ArrowRight className="mt-px h-3.5 w-3.5 shrink-0 text-orange-500" />
                                      <span>
                                        <strong>{m.name || m.workEmail}</strong>:{' '}
                                        {formatDeptLabel(m.fromDepartment)} →{' '}
                                        <strong>{formatDeptLabel(m.toDepartment)}</strong>
                                        {m.kind === 'within' ? ' (same department, different team)' : ''}
                                      </span>
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )}

                            {!peopleValidation.ok && (
                              <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-2.5 text-xs text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300">
                                <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
                                {(peopleValidation as { error?: string }).error}
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
                              pinnedCount={pinnedSubs.length}
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
  pinnedCount,
  onOpenPayStructure,
}: {
  deptName: string;
  multi: boolean;
  pinnedCount: number;
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
        {pinnedCount > 0 && (
          <li>
            <strong>The {pinnedCount} teams defined in code</strong> — they carry KPI calculators, so they are pinned; teams you add here can be edited freely.
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

/**
 * People on a MASTER-LIST department (Kane, 2026-09-21).
 *
 * Every change here is a REAL department transfer — master list, then the
 * master Google Sheet, recorded as an `applied` transfer row. It is NOT a
 * registry member list: registry members are invisible to pay and to the
 * missing-bank check, so "adding" someone that way would show them on the card
 * and pay them nothing.
 *
 * Two consequences the UI has to carry honestly:
 *  - Removing somebody is a move OUT, so it needs a destination. There is no
 *    "no department" to drop them into.
 *  - A bare family label is not a placement, so HSL arrivals must name a
 *    sub-team. `isPlaceableDeptLabel` refuses the rest server-side.
 */
function PeopleStep({
  deptKey,
  deptName,
  roster,
  moves,
  onMoves,
  departmentOptions,
}: {
  deptKey: string;
  deptName: string;
  roster: DirectoryPerson[];
  moves: BuiltinPersonMove[];
  onMoves: (v: BuiltinPersonMove[]) => void;
  departmentOptions: { value: string; label: string }[];
}) {
  const [query, setQuery] = useState('');
  const [pendingAdd, setPendingAdd] = useState<DirectoryPerson | null>(null);
  const [movingOut, setMovingOut] = useState<DirectoryPerson | null>(null);

  const current = useMemo(
    () => roster.filter((p) => normalizeDeptToKey(p.department) === deptKey),
    [roster, deptKey],
  );
  const movedEmails = useMemo(() => new Set(moves.map((m) => m.workEmail)), [moves]);

  /** Where someone can land IN this department. For HSL that is its sub-teams;
   *  for a flat built-in it is the single department label. */
  const inboundOptions = useMemo(
    () => departmentOptions.filter((o) => normalizeDeptToKey(o.value) === deptKey),
    [departmentOptions, deptKey],
  );
  /** Where someone can go when they leave — anywhere but here. */
  const outboundOptions = useMemo(
    () => departmentOptions.filter((o) => normalizeDeptToKey(o.value) !== deptKey),
    [departmentOptions, deptKey],
  );

  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return roster
      .filter(
        (p) =>
          normalizeDeptToKey(p.department) !== deptKey &&
          !movedEmails.has(p.email) &&
          (p.name.toLowerCase().includes(q) || p.email.includes(q)),
      )
      .slice(0, 6);
  }, [query, roster, deptKey, movedEmails]);

  const addMove = (m: BuiltinPersonMove) => {
    onMoves([...moves.filter((x) => x.workEmail !== m.workEmail), m]);
    setPendingAdd(null);
    setMovingOut(null);
    setQuery('');
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2 rounded-lg border border-zinc-200 bg-zinc-50/60 p-2.5 text-xs text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-400">
        <ArrowLeftRight className="mt-px h-4 w-4 shrink-0 text-orange-500" />
        <span>
          {deptName}&rsquo;s people come from the master list, so every change here is a real{' '}
          <strong>department transfer</strong> — it writes the master list, mirrors the Google Sheet
          and files an applied transfer record. There is no way to add someone without moving them.
        </span>
      </div>

      {/* Move someone IN */}
      <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
        <p className="mb-2 text-xs font-medium text-zinc-700 dark:text-zinc-300">Move someone into {deptName}</p>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search people in other departments"
            className="h-9 pl-8"
          />
        </div>
        <AnimatePresence initial={false}>
          {candidates.length > 0 && !pendingAdd && (
            <motion.ul
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.18, ease: EASE }}
              className="mt-1.5 overflow-hidden rounded-md border border-zinc-200 dark:border-zinc-800"
            >
              {candidates.map((p) => (
                <li key={p.email}>
                  <button
                    type="button"
                    onClick={() => {
                      if (inboundOptions.length === 1) {
                        addMove({
                          name: p.name,
                          workEmail: p.email,
                          personalEmail: null,
                          fromDepartment: p.department,
                          toDepartment: inboundOptions[0]!.value,
                        });
                      } else {
                        setPendingAdd(p);
                      }
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

        {pendingAdd && (
          <DestinationPicker
            title={`Which team does ${firstNameOf(pendingAdd.name)} join?`}
            options={inboundOptions}
            onCancel={() => setPendingAdd(null)}
            onPick={(value) =>
              addMove({
                name: pendingAdd.name,
                workEmail: pendingAdd.email,
                personalEmail: null,
                fromDepartment: pendingAdd.department,
                toDepartment: value,
              })
            }
          />
        )}
      </div>

      {/* Current people */}
      <div>
        <p className="mb-1.5 text-xs font-medium text-zinc-700 dark:text-zinc-300">
          {current.length} {current.length === 1 ? 'person' : 'people'} on the master list
        </p>
        {current.length === 0 ? (
          <p className="rounded-lg border border-dashed border-zinc-300 p-4 text-center text-xs text-zinc-400 dark:border-zinc-700 dark:text-zinc-500">
            Nobody is placed in {deptName} yet.
          </p>
        ) : (
          <ul className="max-h-64 space-y-1 overflow-y-auto pr-1">
            {current.map((p) => {
              const queued = moves.find((m) => m.workEmail === p.email);
              return (
                <li
                  key={p.email}
                  className={`flex items-center gap-2 rounded-lg border p-2 ${
                    queued
                      ? 'border-orange-300 bg-orange-50/60 dark:border-blue-900/60 dark:bg-blue-950/20'
                      : 'border-zinc-200 dark:border-zinc-800'
                  }`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-zinc-800 dark:text-zinc-200">{p.name}</span>
                    <span className="block truncate text-[11px] text-zinc-400">
                      {queued ? (
                        <>
                          {formatDeptLabel(p.department)} → <strong>{formatDeptLabel(queued.toDepartment)}</strong>
                        </>
                      ) : (
                        formatDeptLabel(p.department)
                      )}
                    </span>
                  </span>
                  {queued ? (
                    <button
                      type="button"
                      onClick={() => onMoves(moves.filter((m) => m.workEmail !== p.email))}
                      className="shrink-0 rounded-md px-1.5 py-1 text-[11px] font-semibold text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800 dark:hover:bg-zinc-900 dark:hover:text-zinc-200"
                    >
                      Undo
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setMovingOut(p)}
                      className="shrink-0 rounded-md px-1.5 py-1 text-[11px] font-semibold text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800 dark:hover:bg-zinc-900 dark:hover:text-zinc-200"
                      aria-label={`Move ${p.name} out of ${deptName}`}
                    >
                      Move…
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {movingOut && (
        <DestinationPicker
          title={`Where does ${firstNameOf(movingOut.name)} go?`}
          options={[
            // Inside a department with sub-teams (HSL), a reshuffle to a SIBLING
            // team is a legitimate move, so offer them alongside every other
            // department. A FLAT department has exactly one inbound label and
            // must offer none of it: the person's cell may hold an alias
            // spelling ("Lead Generation" vs "Lead Gen"), which would slip past
            // the validator's literal from-equals-to check and write a pointless
            // relabel nobody asked for.
            ...(inboundOptions.length > 1
              ? inboundOptions.filter(
                  (o) => o.value.trim().toLowerCase() !== movingOut.department.trim().toLowerCase(),
                )
              : []),
            ...outboundOptions,
          ]}
          onCancel={() => setMovingOut(null)}
          onPick={(value) =>
            addMove({
              name: movingOut.name,
              workEmail: movingOut.email,
              personalEmail: null,
              fromDepartment: movingOut.department,
              toDepartment: value,
            })
          }
        />
      )}
    </div>
  );
}

function DestinationPicker({
  title,
  options,
  onPick,
  onCancel,
}: {
  title: string;
  options: { value: string; label: string }[];
  onPick: (value: string) => void;
  onCancel: () => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: EASE }}
      className="mt-2 rounded-lg border border-orange-200 bg-orange-50/60 p-2.5 dark:border-blue-900/60 dark:bg-blue-950/20"
    >
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-zinc-800 dark:text-zinc-200">{title}</p>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md p-1 text-zinc-400 transition-colors hover:bg-white/60 hover:text-zinc-700 dark:hover:bg-zinc-900"
          aria-label="Cancel"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <ul className="max-h-48 space-y-0.5 overflow-y-auto">
        {options.map((o) => (
          <li key={o.value}>
            <button
              type="button"
              onClick={() => onPick(o.value)}
              className="w-full truncate rounded-md px-2 py-1.5 text-left text-xs font-medium text-zinc-700 transition-colors hover:bg-white dark:text-zinc-300 dark:hover:bg-zinc-900"
            >
              {o.label}
            </button>
          </li>
        ))}
      </ul>
    </motion.div>
  );
}

/**
 * Sub-departments on a MASTER-LIST department (Kane, 2026-09-21).
 *
 * HSL's sub-teams are CODE — they carry KPI calculators and a Readiness row, so
 * they are shown read-only here and the validator refuses them server-side too.
 * Every other built-in gets add / rename / remove.
 *
 * An existing sub's KEY IS PINNED: renaming changes the label only, so its
 * `<parent>:<sub>` rate row and every master cell pointing at it stay attached.
 */
function SubDepartmentsStep({
  deptKey,
  deptName,
  subs,
  onSubs,
  pinned,
  occupancy,
  error,
}: {
  deptKey: string;
  deptName: string;
  subs: DepartmentSubUnit[];
  onSubs: (v: DepartmentSubUnit[]) => void;
  /** Sub-teams defined in CODE (HSL's 16). Shown locked -- they carry KPI
   *  calculators, so they are never renamed or removed here. */
  pinned: DepartmentSubUnit[];
  /** subKey -> how many roster people sit in it right now. */
  occupancy: Map<string, number>;
  error?: string;
}) {
  const [draft, setDraft] = useState('');

  const add = () => {
    const name = draft.trim();
    if (!name) return;
    const key = slugifyDeptKey(name);
    if (!key || subs.some((s) => s.key === key)) return;
    onSubs([...subs, { key, name }]);
    setDraft('');
  };

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2 rounded-lg border border-zinc-200 bg-zinc-50/60 p-2.5 text-xs text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-400">
        <Layers className="mt-px h-4 w-4 shrink-0 text-orange-500" />
        <span>
          Internal teams inside {deptName}. Each one becomes a placement
          (<code className="text-[10px]">{builtinSubLabel(deptKey, '<team>')}</code>) and can carry its own
          base rate in Pay structure. <strong>Once {deptName} has sub-teams, new people must be placed in one</strong> —
          existing placements are untouched.
          {pinned.length > 0 && (
            <>
              {' '}A team added here is like Simple Texting: people can be placed in it and it can be priced,
              but it has <strong>no KPI calculator of its own</strong>.
            </>
          )}
        </span>
      </div>

      {pinned.length > 0 && (
        <div>
          <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-zinc-700 dark:text-zinc-300">
            <Lock className="h-3.5 w-3.5" />
            Defined in code — {pinned.length} teams with their own KPI calculator or scoring
          </p>
          <ul className="max-h-40 space-y-1 overflow-y-auto pr-1">
            {pinned.map((sub) => {
              const held = occupancy.get(sub.key) ?? 0;
              return (
                <li
                  key={`pin-${sub.key}`}
                  className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50/60 p-2 text-sm text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-300"
                >
                  <span className="min-w-0 flex-1 truncate">{sub.name}</span>
                  <span className="shrink-0 rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-medium text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                    {held} {held === 1 ? 'person' : 'people'}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {pinned.length > 0 && (
        <p className="text-xs font-medium text-zinc-700 dark:text-zinc-300">Added here</p>
      )}

      <div className="flex gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
          placeholder="Add a sub-department, e.g. Nurture"
          className="h-9"
        />
        <Button type="button" size="sm" onClick={add} disabled={!draft.trim()} className="shrink-0 gap-1">
          <Plus className="h-3.5 w-3.5" />
          Add
        </Button>
      </div>

      {subs.length === 0 ? (
        <p className="rounded-lg border border-dashed border-zinc-300 p-4 text-center text-xs text-zinc-400 dark:border-zinc-700 dark:text-zinc-500">
          {pinned.length > 0 ? `No teams added beyond the ${pinned.length} in code.` : `${deptName} is flat — no sub-departments.`}
        </p>
      ) : (
        <motion.ul layout className="space-y-1.5">
          <AnimatePresence initial={false} mode="popLayout">
            {subs.map((sub, i) => {
              const held = occupancy.get(sub.key) ?? 0;
              return (
                <motion.li
                  key={sub.key}
                  layout
                  initial={{ opacity: 0, x: -12 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 12, scale: 0.97 }}
                  transition={{ duration: 0.18, ease: EASE }}
                  className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-white p-2 dark:border-zinc-800 dark:bg-zinc-950"
                >
                  <Input
                    value={sub.name}
                    onChange={(e) => {
                      const next = [...subs];
                      // The KEY is pinned — renaming moves the label only, so the
                      // rate row and every master cell stay attached.
                      next[i] = { key: sub.key, name: e.target.value };
                      onSubs(next);
                    }}
                    className="h-8 flex-1"
                    aria-label={`Sub-department ${i + 1} name`}
                  />
                  <span className="shrink-0 rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-medium text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                    {held} {held === 1 ? 'person' : 'people'}
                  </span>
                  <button
                    type="button"
                    disabled={held > 0}
                    onClick={() => onSubs(subs.filter((x) => x.key !== sub.key))}
                    title={held > 0 ? 'Move its people out first' : `Remove ${sub.name}`}
                    className="shrink-0 rounded-md p-1.5 text-zinc-400 transition-colors enabled:hover:bg-red-50 enabled:hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-40 dark:enabled:hover:bg-red-950/40"
                    aria-label={`Remove ${sub.name}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </motion.li>
              );
            })}
          </AnimatePresence>
        </motion.ul>
      )}

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-2.5 text-xs text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300">
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
          {error}
        </div>
      )}
    </div>
  );
}
