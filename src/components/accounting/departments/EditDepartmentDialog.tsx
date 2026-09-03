'use client';

// Payment Catalog -- Departments -- "Edit" on an in-app department card.
//
// The Create a Department shell, prefilled: rename, add / rename / remove
// sub-departments (a NEW one may carry an initial base rate exactly as in
// Create; an EXISTING one's rate is read-only here -- Pay Structure is the one
// write path for a live rate), add / remove people, toggle Manager, reassign
// sub-departments, then a Review step listing the exact diff, and the same
// staged progress overlay fed by PATCH /api/payment-catalog/departments.
//
// THE RENAME RULE (docs/features/payment-catalog-departments.md §6): the key
// never changes. A rename files the old name in `previousNames`, every resolver
// keeps answering to it, and the manager grant stays on the ORIGINAL label. It
// is still the one edit that touches how live cells resolve, so it goes through
// an explicit warning layer before the save runs (Kane, 2026-09-03).
//
// Stale edits: the dialog carries the registry revision it loaded and the
// server refuses (409) a save against a newer one -- the overlay then offers
// "Reload and start over" instead of a retry that would fail the same way.

import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  Crown,
  FolderTree,
  Minus,
  Pencil,
  Plus,
  Save,
  Users,
  Wallet,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DEPARTMENTS } from '@/lib/payroll/department-bonus';
import { normalizeDeptToKey } from '@/lib/payroll/normalize-dept-key';
import {
  EDIT_DEPARTMENT_STAGES,
  diffDepartmentEdit,
  managerGrantLabel,
  rawDeptMatchesEntry,
  slugifyDeptKey,
  subDeptStructureKey,
  validateEditDepartmentInput,
  type DepartmentEditDiff,
  type DepartmentRegistryEntry,
  type EditDepartmentInput,
  type EditDepartmentSummary,
} from '@/lib/departments/registry';
import { defaultOtRate, formatRate, type PayStructure } from '@/lib/payment-catalog/pay-structure';
import {
  EASE,
  StepName,
  StepPeople,
  StepSubDepartments,
  firstNameOf,
  nextMemberId,
  nextSubId,
  type DirectoryPerson,
  type WizardMember,
  type WizardSub,
} from './department-wizard-steps';
import { StagedProgress, useStagedRun } from './staged-run';

const STEPS = ['Department', 'Sub-departments', 'People', 'Review'] as const;

export default function EditDepartmentDialog({
  open,
  entry,
  registry,
  registryRevision,
  roster,
  payStructures,
  onClose,
  onChanged,
  onOpenPayStructure,
}: {
  open: boolean;
  /** The department being edited (null while closed). */
  entry: DepartmentRegistryEntry | null;
  registry: DepartmentRegistryEntry[];
  /** GET `revision` -- handed back so a stale save is refused. */
  registryRevision: string | null;
  roster: DirectoryPerson[];
  payStructures: PayStructure[];
  onClose: () => void;
  /** Refetch catalog data after a successful save (or a stale-edit reload). */
  onChanged: () => void;
  onOpenPayStructure: (deptKey: string) => void;
}) {
  const reducedMotion = useReducedMotion();
  const [step, setStep] = useState(0);
  const [dir, setDir] = useState(1);

  const [name, setName] = useState('');
  const [wantsSubs, setWantsSubs] = useState<'no' | 'yes'>('no');
  const [subs, setSubs] = useState<WizardSub[]>([]);
  const [members, setMembers] = useState<WizardMember[]>([]);
  const [confirmRename, setConfirmRename] = useState(false);

  const { view, running, run, reset } = useStagedRun<EditDepartmentSummary>();
  const lastInputRef = useRef<EditDepartmentInput | null>(null);

  const subRate = (parentKey: string, subKey: string) =>
    payStructures.find(
      (s) => s.scope === 'department' && s.departmentKey === subDeptStructureKey(parentKey, subKey),
    ) ?? null;
  const deptRate = entry
    ? payStructures.find((s) => s.scope === 'department' && s.departmentKey === entry.key) ?? null
    : null;

  // Prefill from the entry every time the dialog opens.
  const entryKey = entry?.key ?? null;
  useEffect(() => {
    if (!open || !entry) return;
    setStep(0);
    setDir(1);
    setName(entry.name);
    setWantsSubs(entry.subDepartments.length > 0 ? 'yes' : 'no');
    setSubs(
      entry.subDepartments.map((s) => ({
        id: nextSubId(),
        name: s.name,
        regular: '',
        ot: '',
        currency: 'PHP',
        existingKey: s.key,
        existingRate: subRate(entry.key, s.key),
      })),
    );
    setMembers(
      entry.members.map((m) => ({
        id: nextMemberId(),
        name: m.name,
        workEmail: m.workEmail,
        personalEmail: m.personalEmail ?? null,
        isManager: m.isManager,
        subDepartment: m.subDepartment ?? null,
        startDate: m.startDate ?? null,
      })),
    );
    setConfirmRename(false);
    reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- prefill on open only
  }, [open, entryKey]);

  // Escape closes (unless mid-save).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !running) {
        if (confirmRename) setConfirmRename(false);
        else onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose, running, confirmRename]);

  // ----- derived -----
  const trimmedName = name.trim();
  const renamed = !!entry && trimmedName !== '' && trimmedName !== entry.name.trim();
  const nameCollision = useMemo(() => {
    if (!entry || !renamed) return false;
    if (normalizeDeptToKey(trimmedName)) return true;
    if (DEPARTMENTS.some((d) => d.key === slugifyDeptKey(trimmedName))) return true;
    return registry.some((other) => other.key !== entry.key && rawDeptMatchesEntry(trimmedName, other));
  }, [entry, renamed, trimmedName, registry]);
  const nameOk = trimmedName.length > 0 && trimmedName.length <= 60 && !nameCollision && slugifyDeptKey(trimmedName) !== '';

  const subRateValid = (s: WizardSub) => {
    if (s.existingKey) return true;
    const reg = s.regular.trim();
    if (reg === '') return true;
    const regNum = Number(reg);
    if (!Number.isFinite(regNum) || regNum < 0) return false;
    const ot = s.ot.trim();
    if (ot === '') return true;
    const otNum = Number(ot);
    return Number.isFinite(otNum) && otNum >= 0;
  };
  const effectiveSubs = wantsSubs === 'yes' ? subs : [];
  const subKeyOf = (s: WizardSub) => s.existingKey ?? slugifyDeptKey(s.name);
  const subKeysUnique = new Set(effectiveSubs.map(subKeyOf)).size === effectiveSubs.length;
  const subsOk =
    wantsSubs === 'no' ||
    (subs.length > 0 && subs.every((s) => s.name.trim() !== '' && slugifyDeptKey(s.name) !== '' && subRateValid(s)) && subKeysUnique);
  const managerCount = members.filter((m) => m.isManager).length;
  const subKeySet = new Set(effectiveSubs.map(subKeyOf));
  const peopleOk =
    members.length > 0 &&
    managerCount > 0 &&
    members.every((m) => wantsSubs === 'no' || !m.subDepartment || subKeySet.has(m.subDepartment));

  const buildInput = (): EditDepartmentInput => ({
    key: entry?.key ?? '',
    expectedRevision: registryRevision,
    name: trimmedName,
    subDepartments: effectiveSubs.map((s) => {
      if (s.existingKey) return { key: s.existingKey, name: s.name.trim(), payStructure: null };
      const reg = s.regular.trim();
      const ot = s.ot.trim();
      return {
        key: null,
        name: s.name.trim(),
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
      subDepartment: wantsSubs === 'yes' ? m.subDepartment ?? null : null,
    })),
  });

  const input = entry ? buildInput() : null;
  const validation = entry && input ? validateEditDepartmentInput(input, entry, registry) : { ok: false };
  const diff: DepartmentEditDiff | null = entry && input ? diffDepartmentEdit(entry, input) : null;
  const stepOk = [nameOk, subsOk, peopleOk, validation.ok && !!diff?.changed][step] ?? false;
  const canSave = validation.ok && !!diff?.changed;

  /** Members still pointing at a sub-department that is being removed -- the
   *  reason People can't continue, said out loud on the People step. */
  const strandedMembers = useMemo(() => {
    if (wantsSubs === 'no') return [];
    return members.filter((m) => m.subDepartment && !subKeySet.has(m.subDepartment)).map((m) => m.name);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- subKeySet derives from effectiveSubs
  }, [members, wantsSubs, effectiveSubs]);

  // The Create rule says a department with sub-departments carries no
  // department-wide rate; an edit that ADDS subs to a flat rated department
  // keeps the row as the fallback and says so on Review.
  const fallbackRateWarning =
    entry && entry.subDepartments.length === 0 && effectiveSubs.length > 0 && deptRate
      ? `${trimmedName || entry.name} keeps its department-wide rate (${formatRate(deptRate.regularRate, deptRate.currency)}) as the fallback for sub-departments without their own rate. Remove it in Pay Structure if you don't want that.`
      : null;

  const runSave = (payload: EditDepartmentInput) => {
    lastInputRef.current = payload;
    void run(
      () =>
        fetch('/api/payment-catalog/departments', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }),
      'Saving the department failed',
    );
  };

  const onSaveClick = () => {
    if (!input || !canSave) return;
    if (renamed) {
      setConfirmRename(true);
      return;
    }
    runSave(input);
  };

  // Refresh catalog data once the success screen lands.
  const summaryShown = view?.summary != null;
  useEffect(() => {
    if (summaryShown) onChanged();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire once per save
  }, [summaryShown]);

  const goto = (next: number) => {
    setDir(next > step ? 1 : -1);
    setStep(next);
  };

  const summary = view?.summary ?? null;
  const progressCopy = {
    runningTitle: `Saving ${trimmedName || entry?.name || 'department'}...`,
    runningDetail: 'Saving changes, updating manager access and updating base rates.',
    errorTitle: 'Saving hit a snag',
    success: summary
      ? {
          title: `${summary.name} is updated`,
          detail: describeSummary(summary),
          warnings: summary.warnings,
          deptKey: summary.key,
        }
      : null,
  };

  return (
    <AnimatePresence>
      {open && entry && (
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
              if (!running && !confirmRename) onClose();
            }}
          />

          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label={`Edit ${entry.name}`}
            className="relative z-10 flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-950"
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
                    stageList={EDIT_DEPARTMENT_STAGES}
                    copy={progressCopy}
                    onRetry={() => lastInputRef.current && runSave(lastInputRef.current)}
                    onBackToForm={reset}
                    onReload={() => {
                      onChanged();
                      onClose();
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
                          <Pencil className="h-4 w-4 text-orange-500" />
                          Edit {entry.name}
                        </h2>
                        <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                          Step {step + 1} of {STEPS.length} · key{' '}
                          <span className="font-mono text-zinc-400 dark:text-zinc-500">{entry.key}</span>
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
                          onClick={() => i !== step && goto(i)}
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
                            mode="edit"
                            originalName={entry.name}
                          />
                        )}
                        {step === 1 && (
                          <StepSubDepartments
                            deptName={trimmedName}
                            wantsSubs={wantsSubs}
                            onWantsSubs={setWantsSubs}
                            subs={subs}
                            onSubs={setSubs}
                            mode="edit"
                            parentKey={entry.key}
                            onOpenPayStructure={(key) => {
                              onClose();
                              onOpenPayStructure(key);
                            }}
                          />
                        )}
                        {step === 2 && (
                          <div className="space-y-3">
                            {strandedMembers.length > 0 && (
                              <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300">
                                <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
                                <span>
                                  {strandedMembers.join(', ')} {strandedMembers.length === 1 ? 'is' : 'are'} in a
                                  sub-department you removed — pick another one before saving.
                                </span>
                              </div>
                            )}
                            <StepPeople
                              deptName={trimmedName}
                              roster={roster}
                              members={members}
                              onMembers={setMembers}
                              subs={effectiveSubs.map((s) => ({ key: subKeyOf(s), name: s.name.trim() || '…' }))}
                              managerCount={managerCount}
                            />
                          </div>
                        )}
                        {step === 3 && diff && (
                          <StepEditReview
                            entry={entry}
                            nextName={trimmedName}
                            diff={diff}
                            members={members}
                            subs={effectiveSubs}
                            validationError={validation.ok ? null : (validation as { error?: string }).error ?? null}
                            fallbackRateWarning={fallbackRateWarning}
                            subRate={(k) => subRate(entry.key, k)}
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
                        disabled={!canSave}
                        onClick={onSaveClick}
                        className="gap-1.5 bg-orange-500 text-white hover:bg-orange-600"
                      >
                        <Save className="h-3.5 w-3.5" />
                        Save changes
                      </Button>
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Rename warning layer */}
            <AnimatePresence>
              {confirmRename && input && diff?.renamed && (
                <RenameWarning
                  from={diff.renamed.from}
                  to={diff.renamed.to}
                  grantLabel={managerGrantLabel(entry)}
                  reducedMotion={!!reducedMotion}
                  onKeepOld={() => {
                    setName(entry.name);
                    setConfirmRename(false);
                  }}
                  onCancel={() => setConfirmRename(false)}
                  onConfirm={() => {
                    setConfirmRename(false);
                    runSave(input);
                  }}
                />
              )}
            </AnimatePresence>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function describeSummary(s: EditDepartmentSummary): string {
  const d = s.diff;
  const parts: string[] = [];
  if (d.renamed) parts.push(`renamed from “${d.renamed.from}”`);
  if (d.subsAdded.length) parts.push(`${d.subsAdded.length} sub-department${d.subsAdded.length === 1 ? '' : 's'} added`);
  if (d.subsRenamed.length) parts.push(`${d.subsRenamed.length} renamed`);
  if (d.subsRemoved.length) parts.push(`${d.subsRemoved.length} removed`);
  if (d.membersAdded.length) parts.push(`${d.membersAdded.length} ${d.membersAdded.length === 1 ? 'person' : 'people'} added`);
  if (d.membersRemoved.length) parts.push(`${d.membersRemoved.length} removed`);
  if (d.managersGranted.length || d.managersRevoked.length) {
    parts.push(`manager access +${d.managersGranted.length} / -${d.managersRevoked.length}`);
  }
  if (s.ratesSet) parts.push(`${s.ratesSet} base rate${s.ratesSet === 1 ? '' : 's'} set`);
  if (s.ratesDeleted) parts.push(`${s.ratesDeleted} base rate${s.ratesDeleted === 1 ? '' : 's'} deleted`);
  if (parts.length === 0) return 'Saved.';
  const text = parts.join(', ');
  return text.charAt(0).toUpperCase() + text.slice(1) + '.';
}

// ---------------------------------------------------------------------------
// Review step -- the diff, said plainly
// ---------------------------------------------------------------------------

function StepEditReview({
  entry,
  nextName,
  diff,
  members,
  subs,
  validationError,
  fallbackRateWarning,
  subRate,
}: {
  entry: DepartmentRegistryEntry;
  nextName: string;
  diff: DepartmentEditDiff;
  members: WizardMember[];
  subs: WizardSub[];
  validationError: string | null;
  fallbackRateWarning: string | null;
  subRate: (subKey: string) => PayStructure | null;
}) {
  const managers = members.filter((m) => m.isManager);
  const nameByEmail = new Map<string, string>();
  for (const m of entry.members) nameByEmail.set(m.workEmail, m.name);
  for (const m of members) nameByEmail.set(m.workEmail.trim().toLowerCase(), m.name);
  const who = (email: string) => firstNameOf(nameByEmail.get(email) ?? email);

  type Line = { icon: React.ComponentType<{ className?: string }>; tone: 'add' | 'remove' | 'change' | 'warn'; text: React.ReactNode };
  const lines: Line[] = [];
  if (diff.renamed) {
    lines.push({
      icon: Pencil,
      tone: 'warn',
      text: (
        <>
          Rename <strong>{diff.renamed.from}</strong> → <strong>{diff.renamed.to}</strong>. Key{' '}
          <span className="font-mono">{entry.key}</span> stays; the old name keeps working as an alias.
        </>
      ),
    });
  }
  for (const s of diff.subsAdded) {
    const row = subs.find((x) => !x.existingKey && slugifyDeptKey(x.name) === s.key);
    lines.push({
      icon: Plus,
      tone: 'add',
      text: (
        <>
          New sub-department <strong>{s.name}</strong>
          {row && row.regular.trim() !== ''
            ? ` with base rate ${formatRate(Number(row.regular), row.currency)}`
            : ' (no rate yet — set it in Pay Structure)'}
        </>
      ),
    });
  }
  for (const s of diff.subsRenamed) {
    lines.push({
      icon: Pencil,
      tone: 'change',
      text: (
        <>
          Rename sub-department <strong>{s.from}</strong> → <strong>{s.to}</strong> (key <span className="font-mono">{s.key}</span> stays)
        </>
      ),
    });
  }
  for (const s of diff.subsRemoved) {
    const rate = subRate(s.key);
    lines.push({
      icon: Minus,
      tone: 'remove',
      text: (
        <>
          Remove sub-department <strong>{s.name}</strong>
          {rate ? ` and delete its ${formatRate(rate.regularRate, rate.currency)} base rate` : ''}
        </>
      ),
    });
  }
  for (const e of diff.membersAdded) {
    lines.push({ icon: Plus, tone: 'add', text: <>Add <strong>{who(e)}</strong> ({e}){diff.managersGranted.includes(e) ? ' as Manager' : ''}</> });
  }
  for (const e of diff.membersRemoved) {
    lines.push({ icon: Minus, tone: 'remove', text: <>Remove <strong>{who(e)}</strong> ({e}){diff.managersRevoked.includes(e) ? ' — manager access revoked' : ''}</> });
  }
  for (const e of diff.managersGranted.filter((x) => !diff.membersAdded.includes(x))) {
    lines.push({ icon: Crown, tone: 'change', text: <><strong>{who(e)}</strong> becomes Manager (dashboard access granted)</> });
  }
  for (const e of diff.managersRevoked.filter((x) => !diff.membersRemoved.includes(x))) {
    lines.push({ icon: Crown, tone: 'change', text: <><strong>{who(e)}</strong> is no longer Manager (dashboard access revoked)</> });
  }
  if (diff.subReassigned > 0) {
    lines.push({
      icon: FolderTree,
      tone: 'change',
      text: <>{diff.subReassigned} {diff.subReassigned === 1 ? 'person moves' : 'people move'} to a different sub-department</>,
    });
  }

  const toneClass: Record<Line['tone'], string> = {
    add: 'text-emerald-600 dark:text-emerald-400',
    remove: 'text-red-600 dark:text-red-400',
    change: 'text-orange-600 dark:text-blue-300',
    warn: 'text-amber-600 dark:text-amber-300',
  };

  return (
    <div className="space-y-4">
      {!diff.changed ? (
        <div className="rounded-lg border border-dashed border-zinc-300 p-6 text-center dark:border-zinc-700">
          <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Nothing has changed yet</p>
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
            Go back a step to rename, adjust sub-departments or change people.
          </p>
        </div>
      ) : (
        <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
          <p className="flex items-center gap-1.5 text-sm font-medium text-zinc-800 dark:text-zinc-200">
            <Save className="h-4 w-4 text-orange-500" />
            What will change
          </p>
          <ul className="mt-2.5 space-y-1.5">
            {lines.map((l, i) => (
              <li key={i} className="flex items-start gap-2 text-xs text-zinc-700 dark:text-zinc-300">
                <l.icon className={`mt-px h-3.5 w-3.5 shrink-0 ${toneClass[l.tone]}`} />
                <span className="leading-relaxed">{l.text}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {validationError && (
        <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-2.5 text-xs text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300">
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
          {validationError}
        </div>
      )}

      {fallbackRateWarning && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300">
          <Wallet className="mt-px h-3.5 w-3.5 shrink-0" />
          {fallbackRateWarning}
        </div>
      )}

      {/* Resulting shape */}
      <div className="rounded-lg border border-orange-100 bg-orange-50/40 p-3.5 dark:border-blue-950/60 dark:bg-blue-950/10">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-orange-700/80 dark:text-blue-300/80">
          After saving
        </p>
        <p className="mt-1.5 text-sm font-semibold text-zinc-900 dark:text-zinc-100">{nextName || entry.name}</p>
        <ul className="mt-2 space-y-1 text-xs text-zinc-600 dark:text-zinc-400">
          <li className="flex items-center gap-1.5">
            <Check className="h-3.5 w-3.5 text-emerald-500" />
            {subs.length === 0
              ? 'No sub-departments'
              : `${subs.length} sub-department${subs.length === 1 ? '' : 's'}: ${subs.map((s) => s.name.trim()).join(', ')}`}
          </li>
          <li className="flex items-center gap-1.5">
            <Users className="h-3.5 w-3.5 text-emerald-500" />
            {members.length} {members.length === 1 ? 'person' : 'people'} ({managers.length}{' '}
            manager{managers.length === 1 ? '' : 's'}: {managers.map((m) => firstNameOf(m.name)).join(', ') || 'none'})
          </li>
        </ul>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rename warning -- an explicit layer before a rename saves
// ---------------------------------------------------------------------------

function RenameWarning({
  from,
  to,
  grantLabel,
  reducedMotion,
  onKeepOld,
  onCancel,
  onConfirm,
}: {
  from: string;
  to: string;
  grantLabel: string;
  reducedMotion: boolean;
  onKeepOld: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <motion.div
      className="absolute inset-0 z-20 flex items-center justify-center bg-white/70 p-4 backdrop-blur-sm dark:bg-zinc-950/70"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
      onClick={onCancel}
    >
      <motion.div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="rename-warning-title"
        className="w-full max-w-md rounded-2xl border border-amber-200 bg-white p-5 shadow-2xl dark:border-amber-900/60 dark:bg-zinc-950"
        initial={{ opacity: 0, y: 16, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 12, scale: 0.97 }}
        transition={{ type: 'spring', stiffness: 380, damping: 28 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-center">
          <motion.span
            className="relative flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-100 text-amber-600 dark:bg-amber-950/50 dark:text-amber-300"
            animate={reducedMotion ? undefined : { rotate: [0, -4, 4, -2, 0] }}
            transition={reducedMotion ? undefined : { duration: 0.6, delay: 0.15, ease: 'easeInOut' }}
          >
            {!reducedMotion && (
              <motion.span
                className="absolute inset-0 rounded-2xl border-2 border-amber-400/60"
                animate={{ scale: [1, 1.3], opacity: [0.6, 0] }}
                transition={{ duration: 1.4, repeat: Infinity, ease: 'easeOut' }}
              />
            )}
            <AlertTriangle className="h-7 w-7" />
          </motion.span>
        </div>
        <h3 id="rename-warning-title" className="mt-3 text-center text-base font-semibold text-zinc-900 dark:text-zinc-100">
          Rename &ldquo;{from}&rdquo; to &ldquo;{to}&rdquo;?
        </h3>
        <p className="mt-1 text-center text-xs text-zinc-500 dark:text-zinc-400">
          A department&rsquo;s name is how payroll finds it. This is safe, but read what moves.
        </p>
        <ul className="mt-3.5 space-y-2 text-xs leading-relaxed text-zinc-700 dark:text-zinc-300">
          {[
            <>Every picker, the Payroll Wizard, Readiness and the Pay Structure rail switch to <strong>{to}</strong>.</>,
            <>&ldquo;{from}&rdquo; keeps working as an alias — people already labelled with it stay here and keep their rate.</>,
            <>The department&rsquo;s key and its rate rows do not change.</>,
            <>Managers&rsquo; dashboards keep showing <strong>{grantLabel}</strong> until engineering re-keys their access.</>,
          ].map((text, i) => (
            <motion.li
              key={i}
              className="flex items-start gap-2"
              initial={reducedMotion ? false : { opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.1 + i * 0.07, duration: 0.25, ease: EASE }}
            >
              <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />
              <span>{text}</span>
            </motion.li>
          ))}
        </ul>
        <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={onKeepOld} className="mr-auto text-zinc-500">
            Keep &ldquo;{from}&rdquo;
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={onCancel}>
            Back
          </Button>
          <Button type="button" size="sm" onClick={onConfirm} className="gap-1.5 bg-amber-500 text-white hover:bg-amber-600">
            <Pencil className="h-3.5 w-3.5" />
            Rename and save
          </Button>
        </div>
      </motion.div>
    </motion.div>
  );
}
