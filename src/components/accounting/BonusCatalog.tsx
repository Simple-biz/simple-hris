'use client';

// Bonus Catalog (Accounting tab).
//
// Two-part tool:
//   1. Library    -- create reusable custom bonuses (flat amount OR Excel-style
//                    formula). The formula editor validates live, shows the
//                    variables it references, runs a test calculator, and
//                    displays the generated TypeScript ("translate to code").
//   2. Assignments-- attach a library bonus to a whole department ("common")
//                    or to a specific employee.
//
// Persistence: dedicated tables (bonus_catalog_bonuses + bonus_catalog_assignments)
// via /api/bonus-catalog. Each row records its creator + timestamps, and the tab
// subscribes to Supabase Realtime so a teammate's new bonus appears live.
// Standalone authoring tool: it does NOT yet feed the Payroll Wizard.

import { useCallback, useEffect, useId, useMemo, useState } from 'react';
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
  Sparkles,
  CheckCircle2,
  AlertTriangle,
  X,
  Search,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DEPARTMENTS } from '@/lib/payroll/department-bonus';
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

export default function BonusCatalog({ initialData }: { initialData?: InitialAccountingData | null }) {
  const [bonuses, setBonuses] = useState<BonusDef[]>([]);
  const [assignments, setAssignments] = useState<BonusAssignment[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'library' | 'assignments'>('library');
  const instanceId = useId();

  const roster = useMemo(() => buildRoster(initialData), [initialData]);

  const refetch = useCallback(async () => {
    try {
      const res = await fetch('/api/bonus-catalog', { cache: 'no-store' });
      const json = (await res.json()) as {
        bonuses?: BonusDef[];
        assignments?: BonusAssignment[];
        error?: string | null;
      };
      setBonuses(json.bonuses ?? []);
      setAssignments(json.assignments ?? []);
    } catch {
      /* keep prior state */
    } finally {
      setLoading(false);
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
      setAssignments((prev) => [...prev, a]);
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

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#fafaf8] dark:bg-[#0d1117]">
      {/* Header */}
      <div className="shrink-0 border-b border-orange-100 bg-white px-4 py-3 sm:px-6 sm:py-5 dark:border-blue-950/60 dark:bg-[#0d1117]">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-base font-semibold tracking-tight text-zinc-900 sm:text-xl dark:text-white">
              <Sparkles className="h-5 w-5 text-orange-500" />
              Bonus Catalog
            </h1>
            <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-500">
              Create reusable bonuses with flat amounts or Excel-style formulas, then assign them to a
              department or a specific employee.
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
        <div className="mt-4 flex gap-1">
          {([
            { id: 'library', label: 'Bonus Library', icon: Sparkles },
            { id: 'assignments', label: 'Assignments', icon: Building2 },
          ] as const).map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                tab === t.id
                  ? 'bg-orange-100 text-orange-900 dark:bg-blue-950/60 dark:text-white'
                  : 'text-zinc-500 hover:bg-orange-50 hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-blue-950/30'
              }`}
            >
              <t.icon className="h-4 w-4" />
              {t.label}
              {t.id === 'library' && bonuses.length > 0 && (
                <span className="ml-1 rounded-full bg-orange-200/70 px-1.5 text-[10px] font-bold text-orange-800 dark:bg-blue-900/60 dark:text-blue-200">
                  {bonuses.length}
                </span>
              )}
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

  const assignmentCount = useCallback(
    (bonusId: string) => assignments.filter((a) => a.bonusId === bonusId).length,
    [assignments],
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
      <div className="flex items-center justify-between">
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          {bonuses.length} bonus{bonuses.length === 1 ? '' : 'es'} defined
        </p>
        <Button type="button" onClick={startCreate} className="gap-2 bg-orange-500 text-white hover:bg-orange-600">
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
      ) : (
        <motion.div layout className="grid gap-3 sm:grid-cols-2">
          <AnimatePresence mode="popLayout">
            {bonuses.map((b, i) => (
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
                  onEdit={() => {
                    setEditing(b);
                    setCreating(false);
                  }}
                  onDelete={() => remove(b.id)}
                />
              </motion.div>
            ))}
          </AnimatePresence>
        </motion.div>
      )}
    </div>
  );
}

function BonusCard({
  bonus,
  assignments,
  onEdit,
  onDelete,
}: {
  bonus: BonusDef;
  assignments: number;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [showTest, setShowTest] = useState(false);
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
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
          <IconButton title="Edit" onClick={onEdit}>
            <Pencil className="h-3.5 w-3.5" />
          </IconButton>
          <IconButton title="Delete" onClick={onDelete} danger>
            <Trash2 className="h-3.5 w-3.5" />
          </IconButton>
        </div>
      </div>

      <div className="mt-3">
        {bonus.kind === 'flat' ? (
          <div className="text-lg font-bold text-emerald-600 dark:text-emerald-400">{money(bonus.amount ?? 0)}</div>
        ) : (
          <code className="block break-words rounded bg-zinc-100 px-2 py-1.5 font-mono text-xs text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
            {bonus.formula || '(empty formula)'}
          </code>
        )}
      </div>

      <div className="mt-3 flex items-center justify-between">
        <span className="flex items-center gap-2 text-[11px] text-zinc-400">
          {assignments} assignment{assignments === 1 ? '' : 's'}
          <ByLine who={bonus.createdBy} />
        </span>
        {bonus.kind === 'formula' && (
          <button
            type="button"
            onClick={() => setShowTest((s) => !s)}
            className="flex items-center gap-1 text-[11px] font-medium text-orange-600 hover:underline dark:text-orange-400"
          >
            <Calculator className="h-3 w-3" />
            {showTest ? 'Hide test' : 'Test'}
          </button>
        )}
      </div>

      <Expand show={showTest && bonus.kind === 'formula'}>
        <InlineTester formula={bonus.formula ?? ''} />
      </Expand>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bonus editor (create / edit)
// ---------------------------------------------------------------------------

function BonusEditor({
  initial,
  onCancel,
  onSave,
}: {
  initial: BonusDef;
  onCancel: () => void;
  onSave: (b: BonusDef) => void;
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
    <div className="rounded-lg border-2 border-orange-200 bg-white p-4 shadow-sm dark:border-blue-900/60 dark:bg-zinc-950 sm:p-5">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
          {initial.name ? 'Edit bonus' : 'New bonus'}
        </h3>
        <IconButton title="Close" onClick={onCancel}>
          <X className="h-4 w-4" />
        </IconButton>
      </div>

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
          <select
            value={selectedDept}
            onChange={(e) => setSelectedDept(e.target.value)}
            className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          >
            {DEPARTMENTS.map((d) => (
              <option key={d.key} value={d.key}>
                {d.name}
              </option>
            ))}
          </select>
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
          subtitle="Applied to everyone in this department."
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
                    <AssignmentRow
                      bonus={bonusById.get(a.bonusId)}
                      by={a.createdBy}
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
      <select
        value={pick}
        onChange={(e) => setPick(e.target.value)}
        className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
      >
        <option value="">Select a bonus...</option>
        {available.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
          </option>
        ))}
      </select>
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
        <select
          value={empEmail}
          onChange={(e) => setEmpEmail(e.target.value)}
          className="min-w-[12rem] rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        >
          <option value="">Select an employee...</option>
          {list.map((r) => (
            <option key={r.email} value={r.email}>
              {r.name}
              {r.department ? ` (${r.department})` : ''}
            </option>
          ))}
        </select>
        <select
          value={bonusId}
          onChange={(e) => setBonusId(e.target.value)}
          className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        >
          <option value="">Select a bonus...</option>
          {bonuses.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
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
