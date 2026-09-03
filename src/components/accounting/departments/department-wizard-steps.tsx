'use client';

// Shared steps of the Payment Catalog department dialogs -- Create a Department
// (DepartmentsTab.tsx) and Edit Department (EditDepartmentDialog.tsx) render
// the SAME name / sub-departments / people controls, so a rule fixed here is
// fixed in both. Pure presentation: state lives in the owning dialog.
//
// Edit mode differences (see docs/features/payment-catalog-departments.md §6):
//   - an EXISTING sub-department's key is pinned (rename = label only) and its
//     rate is read-only here -- Pay Structure is the one write path for a live
//     rate; a NEW sub-department may carry an initial rate exactly as in Create.

import { useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  AlertTriangle,
  ChevronRight,
  CheckCircle2,
  Crown,
  FolderTree,
  Plus,
  Search,
  Trash2,
  UserRoundPlus,
  Users,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DatePicker } from '@/components/ui/date-picker';
import { slugifyDeptKey, subDeptStructureKey, type NewDepartmentMember } from '@/lib/departments/registry';
import {
  CURRENCY_SYMBOL,
  OT_MULTIPLIER,
  PAY_CURRENCIES,
  currencyChipLabel,
  formatRate,
  type PayCurrency,
  type PayStructure,
} from '@/lib/payment-catalog/pay-structure';
import { formatDeptLabel } from '@/lib/departments/hsl-subdept';

/** Shared easing -- matches the catalog's tab transition. */
export const EASE = [0.22, 1, 0.36, 1] as const;

export type DirectoryPerson = { email: string; name: string; department: string };

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Today's calendar date in Manila (the roster's timezone), YYYY-MM-DD. */
export function manilaTodayIso(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

export function firstNameOf(nameOrEmail: string): string {
  const cleaned = nameOrEmail.includes('@') ? nameOrEmail.split('@')[0] : nameOrEmail;
  // Master-list names are often "Surname, Given" -- show the given part.
  const comma = cleaned.indexOf(',');
  const base = comma >= 0 ? cleaned.slice(comma + 1) : cleaned;
  return base.trim().split(/\s+/)[0] ?? cleaned;
}

export function initialsOf(name: string): string {
  const parts = name
    .replace(/["'].*?["']/g, ' ')
    .split(/[\s,]+/)
    .filter(Boolean);
  const a = parts[0]?.[0] ?? '';
  const b = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (a + b).toUpperCase() || '?';
}

// ---------------------------------------------------------------------------
// Dialog-local row types
// ---------------------------------------------------------------------------

export type WizardMember = NewDepartmentMember & { id: string };

/** A sub-department row: name + its own OPTIONAL base rate. Blank `regular` = no
 *  rate yet (settable later from Pay Structure under the `<parentKey>:<subKey>`
 *  entry). Blank `ot` = auto 1.5x regular.
 *
 *  Edit mode: `existingKey` pins an already-saved sub-department (its key never
 *  changes; the name may) and `existingRate` is its live base structure, shown
 *  read-only -- the rate inputs are for NEW rows only. */
export type WizardSub = {
  id: string;
  name: string;
  regular: string;
  ot: string;
  currency: PayCurrency;
  existingKey?: string | null;
  existingRate?: PayStructure | null;
};

let wizardMemberSeq = 0;
export const nextMemberId = () => `wm_${++wizardMemberSeq}`;
let wizardSubSeq = 0;
export const nextSubId = () => `ws_${++wizardSubSeq}`;

// ---------------------------------------------------------------------------
// Step 1 -- name
// ---------------------------------------------------------------------------

export function StepName({
  name,
  onName,
  collision,
  mode = 'create',
  originalName,
}: {
  name: string;
  onName: (v: string) => void;
  collision: boolean;
  mode?: 'create' | 'edit';
  /** Edit mode: the saved name, to flag a pending rename. */
  originalName?: string;
}) {
  const renaming = mode === 'edit' && !!originalName && name.trim() !== '' && name.trim() !== originalName.trim();
  return (
    <div className="space-y-4">
      <div>
        <label htmlFor="dept-name" className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
          Department name
        </label>
        <Input
          id="dept-name"
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
              key="collision"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="mt-1.5 flex items-center gap-1 overflow-hidden text-xs font-medium text-red-600 dark:text-red-400"
            >
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              A department with this name already exists.
            </motion.p>
          )}
          {!collision && renaming && (
            <motion.p
              key="renaming"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="mt-1.5 flex items-center gap-1 overflow-hidden text-xs font-medium text-amber-700 dark:text-amber-300"
            >
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              Renaming from &ldquo;{originalName}&rdquo; &mdash; you&rsquo;ll confirm before it saves.
            </motion.p>
          )}
        </AnimatePresence>
      </div>
      {mode === 'create' ? (
        <div className="rounded-lg border border-orange-100 bg-orange-50/50 p-3 text-xs leading-relaxed text-zinc-600 dark:border-blue-950/60 dark:bg-blue-950/10 dark:text-zinc-400">
          Departments created here are self-contained: people and structure are tracked in the
          Payment Catalog (nothing is written to the Global Master List), managers get dashboard
          oversight, and the Pay Structure tab carries the rate.
        </div>
      ) : (
        <div className="rounded-lg border border-zinc-200 bg-zinc-50/60 p-3 text-xs leading-relaxed text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-400">
          Renaming keeps the department&rsquo;s key, its rate rows and its people. The old name
          keeps working as an alias, so anyone already labelled with it stays here.
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 2 -- sub-departments
// ---------------------------------------------------------------------------

export function StepSubDepartments({
  deptName,
  wantsSubs,
  onWantsSubs,
  subs,
  onSubs,
  mode = 'create',
  parentKey,
  onOpenPayStructure,
}: {
  deptName: string;
  wantsSubs: 'no' | 'yes';
  onWantsSubs: (v: 'no' | 'yes') => void;
  subs: WizardSub[];
  onSubs: (v: WizardSub[]) => void;
  mode?: 'create' | 'edit';
  /** Edit mode: the department key, for the sub-department Pay Structure links. */
  parentKey?: string;
  onOpenPayStructure?: (deptKey: string) => void;
}) {
  const [draft, setDraft] = useState('');
  const draftKey = slugifyDeptKey(draft);
  const keyOf = (s: WizardSub) => s.existingKey ?? slugifyDeptKey(s.name);
  const duplicate = draftKey !== '' && subs.some((s) => keyOf(s) === draftKey);
  const canAdd = draft.trim() !== '' && draftKey !== '' && !duplicate;
  const existingCount = subs.filter((s) => s.existingKey).length;

  const add = () => {
    if (!canAdd) return;
    onSubs([...subs, { id: nextSubId(), name: draft.trim(), regular: '', ot: '', currency: 'PHP' }]);
    setDraft('');
  };

  const patch = (id: string, p: Partial<WizardSub>) =>
    onSubs(subs.map((s) => (s.id === id ? { ...s, ...p } : s)));

  /** Non-blank but not a valid non-negative number. */
  const badNumber = (v: string) => {
    const t = v.trim();
    if (t === '') return false;
    const n = Number(t);
    return !Number.isFinite(n) || n < 0;
  };

  /** Two rows would end up on the same key (a renamed row colliding with another). */
  const keyCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of subs) m.set(keyOf(s), (m.get(keyOf(s)) ?? 0) + 1);
    return m;
  }, [subs]);

  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
          Does {deptName || 'this department'} need sub-departments?
        </p>
        <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
          Like HSL: one department split into internal teams (Callback Team, Case Managers,
          Medical Records...). Each sub-department carries its <strong>own base rate</strong> —
          the fallback for its people unless someone gets an individual rate. The department
          itself then has no department-wide rate.
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
        <AnimatePresence initial={false}>
          {mode === 'edit' && wantsSubs === 'no' && existingCount > 0 && (
            <motion.p
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="mt-2 flex items-center gap-1 overflow-hidden text-xs font-medium text-amber-700 dark:text-amber-300"
            >
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              Saving flat removes all {existingCount} existing sub-department{existingCount === 1 ? '' : 's'}{' '}
              and deletes their own base rates.
            </motion.p>
          )}
        </AnimatePresence>
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
                <motion.div layout className="space-y-2">
                  <AnimatePresence initial={false} mode="popLayout">
                    {subs.map((sub) => {
                      const isExisting = mode === 'edit' && !!sub.existingKey;
                      const invalid = !isExisting && (badNumber(sub.regular) || badNumber(sub.ot));
                      const nameEmpty = sub.name.trim() === '' || slugifyDeptKey(sub.name) === '';
                      const keyClash = (keyCounts.get(keyOf(sub)) ?? 0) > 1;
                      return (
                        <motion.div
                          key={sub.id}
                          layout
                          initial={{ opacity: 0, scale: 0.97 }}
                          animate={{ opacity: 1, scale: 1 }}
                          exit={{ opacity: 0, scale: 0.97 }}
                          transition={{ duration: 0.15, ease: EASE }}
                          className="rounded-lg border border-zinc-200 p-2.5 dark:border-zinc-800"
                        >
                          <div className="flex items-center justify-between gap-2">
                            {mode === 'edit' ? (
                              <span className="flex min-w-0 flex-1 items-center gap-1.5">
                                <FolderTree className="h-3.5 w-3.5 shrink-0 text-orange-500" />
                                <Input
                                  value={sub.name}
                                  onChange={(e) => patch(sub.id, { name: e.target.value })}
                                  maxLength={60}
                                  aria-label="Sub-department name"
                                  className="h-8 text-sm font-medium"
                                />
                              </span>
                            ) : (
                              <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium text-zinc-800 dark:text-zinc-200">
                                <FolderTree className="h-3.5 w-3.5 shrink-0 text-orange-500" />
                                <span className="truncate">{sub.name}</span>
                              </span>
                            )}
                            <button
                              type="button"
                              onClick={() => onSubs(subs.filter((s) => s.id !== sub.id))}
                              className="shrink-0 rounded-md p-1 text-zinc-400 transition-colors hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40"
                              aria-label={`Remove ${sub.name}`}
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </div>

                          {mode === 'edit' && (
                            <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10.5px] text-zinc-400 dark:text-zinc-500">
                              {isExisting ? (
                                <>
                                  <span className="rounded bg-zinc-100 px-1 py-px font-mono text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                                    {sub.existingKey}
                                  </span>
                                  key stays &mdash; renaming is label-only
                                </>
                              ) : (
                                <>
                                  <span className="rounded bg-emerald-50 px-1 py-px font-semibold uppercase tracking-wide text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
                                    new
                                  </span>
                                  key will be{' '}
                                  <span className="font-mono">{slugifyDeptKey(sub.name) || '…'}</span>
                                </>
                              )}
                            </p>
                          )}

                          {isExisting ? (
                            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md bg-zinc-50 px-2.5 py-1.5 text-xs dark:bg-zinc-900">
                              <span className="text-zinc-600 dark:text-zinc-300">
                                Base rate:{' '}
                                {sub.existingRate ? (
                                  <span className="font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
                                    {formatRate(sub.existingRate.regularRate, sub.existingRate.currency)}
                                    {sub.existingRate.otRate != null && (
                                      <span className="font-medium text-zinc-500 dark:text-zinc-400">
                                        {' '}· OT {formatRate(sub.existingRate.otRate, sub.existingRate.currency)}
                                      </span>
                                    )}
                                  </span>
                                ) : (
                                  <span className="text-zinc-400 dark:text-zinc-500">none yet</span>
                                )}
                              </span>
                              {parentKey && onOpenPayStructure && sub.existingKey && (
                                <button
                                  type="button"
                                  onClick={() => onOpenPayStructure(subDeptStructureKey(parentKey, sub.existingKey!))}
                                  className="inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[11px] font-semibold text-orange-600 transition-colors hover:bg-orange-50 dark:text-blue-300 dark:hover:bg-blue-950/40"
                                >
                                  Pay structure
                                  <ChevronRight className="h-3.5 w-3.5" />
                                </button>
                              )}
                            </div>
                          ) : (
                            <div className="mt-2 flex flex-wrap items-end gap-2.5">
                              <MiniField label={`Base rate (${CURRENCY_SYMBOL[sub.currency]}/hr)`}>
                                <Input
                                  type="number"
                                  inputMode="decimal"
                                  min="0"
                                  step="0.01"
                                  value={sub.regular}
                                  onChange={(e) => patch(sub.id, { regular: e.target.value })}
                                  placeholder="Skip for now"
                                  className="h-8 w-32"
                                />
                              </MiniField>
                              <MiniField label={`OT rate (${CURRENCY_SYMBOL[sub.currency]}/hr)`}>
                                <Input
                                  type="number"
                                  inputMode="decimal"
                                  min="0"
                                  step="0.01"
                                  value={sub.ot}
                                  onChange={(e) => patch(sub.id, { ot: e.target.value })}
                                  placeholder={`${OT_MULTIPLIER}x regular`}
                                  className="h-8 w-28"
                                />
                              </MiniField>
                              <MiniField label="Currency">
                                <select
                                  value={sub.currency}
                                  onChange={(e) => patch(sub.id, { currency: e.target.value as PayCurrency })}
                                  className="h-8 rounded-md border border-zinc-200 bg-white px-2 text-xs text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
                                  aria-label={`Currency for ${sub.name}`}
                                >
                                  {PAY_CURRENCIES.map((c) => (
                                    <option key={c} value={c}>
                                      {currencyChipLabel(c)}
                                    </option>
                                  ))}
                                </select>
                              </MiniField>
                            </div>
                          )}
                          {(invalid || nameEmpty || keyClash) && (
                            <p className="mt-1.5 flex items-center gap-1 text-[11px] font-medium text-red-600 dark:text-red-400">
                              <AlertTriangle className="h-3 w-3 shrink-0" />
                              {nameEmpty
                                ? 'Give this sub-department a name with at least one letter or number.'
                                : keyClash
                                  ? 'Two sub-departments would share the same key.'
                                  : 'Rates must be non-negative numbers.'}
                            </p>
                          )}
                        </motion.div>
                      );
                    })}
                  </AnimatePresence>
                  <p className="text-[11px] text-zinc-400 dark:text-zinc-500">
                    {mode === 'edit'
                      ? 'Removing a sub-department also deletes its own base rate; its people must be reassigned first.'
                      : 'A blank rate just means “set it later” — each sub-department gets its own entry on the Pay Structure tab either way.'}
                  </p>
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

export function StepPeople({
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
  /** The sub-departments a person can be placed in (key + label). */
  subs: { key: string; name: string }[];
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
                          {formatDeptLabel(p.department) || 'No department'}
                        </span>
                      </button>
                    </li>
                  ))}
                </motion.ul>
              )}
            </AnimatePresence>
            <p className="mt-1.5 text-[11px] text-zinc-400 dark:text-zinc-500">
              Autofills their name and email into {deptName || 'the department'} -- their
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
                      <option key={s.key} value={s.key}>
                        {s.name}
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

export function MiniField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium text-zinc-600 dark:text-zinc-400">{label}</span>
      {children}
    </label>
  );
}
