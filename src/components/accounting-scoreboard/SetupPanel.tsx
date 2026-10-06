'use client';

/**
 * Setup (managers = Accounting / Admin): which sections are on and their goals, the managers' own
 * custom sections, who or what each section's rows are, the Payroll Problems types, and the extra
 * members. Carla asked to track less than the sheet does, so every section can be switched off here
 * without a code change, and (2026-10-02) to create sections of her own.
 *
 * A row picked from the roster IS that HRIS person and makes them a member. A section's people
 * come from several departments (Accounting Team, USEE, Sales, PM Team), so the department is the
 * picker's FILTER, never the section's definition (analysis note § 4).
 */

import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { ArrowDown, ArrowUp, Loader2, Plus, UserPlus, X } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SmoothSelect } from '@/components/ui/smooth-select';
import { Switch } from '@/components/ui/switch';
import {
  CUSTOM_KIND_LABEL,
  CUSTOM_KINDS,
  MON_FRI,
  WEEKDAY_LABEL,
  sectionDef,
  type BoardSection,
  type CustomKind,
  type GoalDirection,
  type SectionKey,
  type Weekday,
} from '@/lib/accounting-scoreboard/sections';
import { goalText } from '@/lib/accounting-scoreboard/scoring';
import { shortNameFromRoster } from '@/lib/accounting-scoreboard/names';
import { readCachedRoster, writeCachedRoster } from '@/lib/accounting-scoreboard/tab-cache';
import { formatDeptLabel } from '@/lib/departments/hsl-subdept';
import type { BoardPayload, BoardRow, RosterPerson } from '@/lib/accounting-scoreboard/types';
import { api, EASE_SETTLE, EASE_TAB, handle, SlidingPill, TINY_CAPS } from './shared';

interface Props {
  board: BoardPayload;
  /** Every section, built-in and custom, switched on or off. */
  sections: BoardSection[];
  onChanged: () => void;
}

const AREAS = [
  ['rows', 'Rows'],
  ['sections', 'Sections'],
  ['types', 'Problem types'],
  ['members', 'Members'],
] as const;
type Area = (typeof AREAS)[number][0];

const AREA_VARIANTS = {
  enter: (dir: number) => ({ opacity: 0, x: dir >= 0 ? 24 : -24 }),
  center: { opacity: 1, x: 0 },
  exit: (dir: number) => ({ opacity: 0, x: dir >= 0 ? -24 : 24 }),
};

export function SetupPanel({ board, sections, onChanged }: Props) {
  const reduce = useReducedMotion() ?? false;
  const [area, setArea] = useState<Area>('rows');
  const [dir, setDir] = useState(1);
  const go = (next: Area) => {
    const from = AREAS.findIndex(([k]) => k === area);
    const to = AREAS.findIndex(([k]) => k === next);
    setDir(to >= from ? 1 : -1);
    setArea(next);
  };
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">Setup</h2>
        <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
          Only Accounting and Admin see this. Changes apply to everyone on the next refresh.
        </p>
      </div>
      <div className="inline-flex max-w-full gap-0.5 overflow-x-auto rounded-xl border border-zinc-200 bg-white/70 p-1 dark:border-zinc-800 dark:bg-zinc-900/60">
        {AREAS.map(([k, label]) => (
          <SlidingPill key={k} layoutId="acct-sb-setup-area" active={area === k} onClick={() => go(k)}>
            {label}
          </SlidingPill>
        ))}
      </div>
      <div className="overflow-x-clip">
        <AnimatePresence mode="wait" initial={false} custom={dir}>
          <motion.div
            key={area}
            custom={dir}
            variants={AREA_VARIANTS}
            initial="enter"
            animate="center"
            exit="exit"
            transition={{ duration: reduce ? 0 : 0.22, ease: EASE_TAB }}
          >
            {area === 'rows' ? <RowsArea board={board} sections={sections} onChanged={onChanged} /> : null}
            {area === 'sections' ? <SectionsArea sections={sections} onChanged={onChanged} /> : null}
            {area === 'types' ? <ProblemTypesArea board={board} onChanged={onChanged} /> : null}
            {area === 'members' ? <MembersArea board={board} onChanged={onChanged} /> : null}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function SectionsArea({ sections, onChanged }: { sections: BoardSection[]; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const builtIn = sections.filter((s) => s.key !== 'custom');
  const custom = sections.filter((s) => s.key === 'custom');

  async function patchBuiltIn(sectionKey: SectionKey, body: { enabled?: boolean; goal?: number | null }) {
    setBusy(sectionKey);
    const res = await api('/api/accounting-scoreboard/sections', {
      method: 'PATCH',
      body: JSON.stringify({ sectionKey, ...body }),
    });
    setBusy(null);
    if (!res.ok) toast.error(res.error);
    else onChanged();
  }

  async function patchCustom(
    id: string,
    body: { enabled?: boolean; title?: string; goal?: number | null; goalDirection?: GoalDirection | null; archived?: true },
  ): Promise<boolean> {
    setBusy(id);
    const res = await api('/api/accounting-scoreboard/custom-sections', { method: 'PATCH', body: JSON.stringify({ id, ...body }) });
    setBusy(null);
    if (!res.ok) toast.error(res.error);
    else onChanged();
    return res.ok;
  }

  // Kane, 2026-10-06: "Your own sections" sit ON TOP, and a new one lands at the top of them (the
  // server gives it the lowest sort order; boardSections lists lowest first).
  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Your own sections</h3>
          <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
            Each one gets a tab and an Overview card. Add its rows under Rows, like any section. Removing one hides it;
            its numbers are kept.
          </p>
        </div>
        <NewSectionForm onCreated={onChanged} />
        {custom.length ? (
          <ul className="divide-y divide-zinc-100 overflow-hidden rounded-xl border border-zinc-200 bg-white dark:divide-zinc-900 dark:border-zinc-800 dark:bg-zinc-950">
            {custom.map((s) => (
              <CustomSectionLine key={s.id} section={s} busy={busy === s.id} onPatch={(body) => patchCustom(s.customId!, body)} />
            ))}
          </ul>
        ) : null}
      </div>

      <div className="space-y-3">
        <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">The scoreboard&rsquo;s sections</h3>
        <ul className="divide-y divide-zinc-100 overflow-hidden rounded-xl border border-zinc-200 bg-white dark:divide-zinc-900 dark:border-zinc-800 dark:bg-zinc-950">
          {builtIn.map((s) => {
            const key = s.key as SectionKey;
            const sheetGoal = sectionDef(key).goal;
            return (
              <li key={s.id} className="flex flex-wrap items-center gap-4 px-4 py-3">
                <Switch
                  checked={s.enabled}
                  disabled={busy === s.id}
                  onCheckedChange={(checked: boolean) => void patchBuiltIn(key, { enabled: checked })}
                  aria-label={`${s.title} on or off`}
                />
                <div className="min-w-0 flex-1">
                  <div className={cn('text-sm font-medium', s.enabled ? 'text-zinc-900 dark:text-zinc-100' : 'text-zinc-400 line-through')}>
                    {s.hostTab ? `${s.tab} — ${s.title}` : s.title}
                  </div>
                  <div className="text-xs text-zinc-500">{s.help}</div>
                </div>
                {s.goal && sheetGoal ? (
                  <GoalEditor
                    key={`${s.id}:${s.goal.value}`}
                    value={s.goal.value}
                    resetTo={sheetGoal.value}
                    text={goalText(s.goal)}
                    disabled={busy === s.id}
                    onSave={(goal) => void patchBuiltIn(key, { goal })}
                  />
                ) : (
                  <span className="text-xs text-zinc-400">No goal on the sheet</span>
                )}
                {busy === s.id ? <Loader2 className="size-4 animate-spin text-zinc-400" /> : null}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

function CustomSectionLine({
  section,
  busy,
  onPatch,
}: {
  section: BoardSection;
  busy: boolean;
  onPatch: (body: { enabled?: boolean; title?: string; goal?: number | null; goalDirection?: GoalDirection | null; archived?: true }) => Promise<boolean>;
}) {
  const [title, setTitle] = useState(section.title);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => setTitle(section.title), [section.title]);
  const kind: CustomKind = section.kind === 'am_pm' ? 'am_pm' : 'daily';
  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-3">
      <Switch
        checked={section.enabled}
        disabled={busy}
        onCheckedChange={(checked: boolean) => void onPatch({ enabled: checked })}
        aria-label={`${section.title} on or off`}
      />
      <div className="grid min-w-[12rem] flex-1 gap-0.5">
        <Input
          value={title}
          maxLength={60}
          aria-label="Section name"
          disabled={busy}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
          }}
          onBlur={async () => {
            const next = title.trim();
            if (!next) return setTitle(section.title);
            if (next !== section.title && !(await onPatch({ title: next }))) setTitle(section.title);
          }}
          className="h-8"
        />
        <span className="text-[11px] text-zinc-500">{CUSTOM_KIND_LABEL[kind]}</span>
      </div>
      <CustomGoalEditor
        key={`${section.id}:${section.goal?.value ?? ''}:${section.goal?.direction ?? ''}`}
        kind={kind}
        value={section.goal?.value ?? null}
        direction={section.goal?.direction ?? null}
        disabled={busy}
        onSave={(goal, goalDirection) => void onPatch({ goal, goalDirection })}
      />
      {confirming ? (
        <span className="flex items-center gap-1">
          <Button size="xs" variant="destructive" disabled={busy} onClick={() => void onPatch({ archived: true })}>
            Remove
          </Button>
          <Button size="xs" variant="ghost" onClick={() => setConfirming(false)}>
            Keep
          </Button>
        </span>
      ) : (
        <Button size="icon-xs" variant="ghost" aria-label={`Remove ${section.title}`} onClick={() => setConfirming(true)}>
          <X />
        </Button>
      )}
      {busy ? <Loader2 className="size-4 animate-spin text-zinc-400" /> : null}
    </li>
  );
}

const DIRECTION_OPTIONS = [
  { value: 'at_least', label: 'at least' },
  { value: 'below', label: 'below' },
];

/** A custom section's goal: an AM/PM section's is a 0–10 score to reach; a daily one's is a week total, at least or below. */
function CustomGoalEditor({
  kind,
  value,
  direction,
  disabled,
  onSave,
}: {
  kind: CustomKind;
  value: number | null;
  direction: GoalDirection | null;
  disabled: boolean;
  onSave: (goal: number | null, direction: GoalDirection | null) => void;
}) {
  const [draft, setDraft] = useState(value === null ? '' : String(value));
  const [dirDraft, setDirDraft] = useState<GoalDirection>(direction ?? 'at_least');
  const commit = (nextDir: GoalDirection = dirDraft) => {
    if (draft.trim() === '') {
      if (value !== null) onSave(null, null);
      return;
    }
    const n = Number(draft);
    if (!Number.isFinite(n)) return setDraft(value === null ? '' : String(value));
    const d = kind === 'am_pm' ? 'at_least' : nextDir;
    if (n !== value || d !== direction) onSave(n, d);
  };
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-zinc-500">Goal</span>
      {kind === 'daily' ? (
        <SmoothSelect
          value={dirDraft}
          onChange={(v) => {
            const d = v as GoalDirection;
            setDirDraft(d);
            if (draft.trim() !== '') commit(d);
          }}
          options={DIRECTION_OPTIONS}
          disabled={disabled}
          accent="orange"
          align="start"
          portal
          aria-label="Goal direction"
          triggerClassName="h-8 text-xs"
        />
      ) : (
        <span className="text-xs text-zinc-500">score ≥</span>
      )}
      <Input
        value={draft}
        inputMode="decimal"
        disabled={disabled}
        placeholder="none"
        aria-label="Goal"
        onChange={(e) => setDraft(e.target.value.replace(/[^0-9.]/g, ''))}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
        onBlur={() => commit()}
        className="h-8 w-20 text-right font-mono tabular-nums"
      />
    </div>
  );
}

function NewSectionForm({ onCreated }: { onCreated: () => void }) {
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<CustomKind>('daily');
  const [goal, setGoal] = useState('');
  const [direction, setDirection] = useState<GoalDirection>('at_least');
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    const res = await api('/api/accounting-scoreboard/custom-sections', {
      method: 'POST',
      body: JSON.stringify({
        title,
        kind,
        goal: goal.trim() === '' ? null : Number(goal),
        goalDirection: goal.trim() === '' ? null : kind === 'am_pm' ? 'at_least' : direction,
      }),
    });
    setBusy(false);
    if (!res.ok) return toast.error(res.error);
    toast.success(`Added ${title.trim()}. Add its rows under Rows.`);
    setTitle('');
    setGoal('');
    onCreated();
  }

  return (
    <form
      className="grid gap-3 rounded-xl border border-orange-100 bg-orange-50/40 p-3 sm:grid-cols-[minmax(12rem,1fr)_minmax(12rem,16rem)] lg:grid-cols-[minmax(12rem,1fr)_16rem_auto_auto] lg:items-end dark:border-orange-950/60 dark:bg-orange-950/10"
      onSubmit={(e) => {
        e.preventDefault();
        if (title.trim()) void create();
      }}
    >
      <label className="grid min-w-0 gap-1">
        <span className={cn(TINY_CAPS, 'text-zinc-500')}>New section</span>
        <Input value={title} maxLength={60} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Refund Requests" className="bg-white dark:bg-zinc-950" />
      </label>
      <div className="grid min-w-0 gap-1">
        <span className={cn(TINY_CAPS, 'text-zinc-500')}>What is typed</span>
        <SmoothSelect
          value={kind}
          onChange={(v) => setKind(v as CustomKind)}
          options={CUSTOM_KINDS.map((k) => ({ value: k, label: CUSTOM_KIND_LABEL[k] }))}
          accent="orange"
          align="start"
          portal
          aria-label="What is typed"
          triggerClassName="text-sm"
        />
      </div>
      <div className="grid min-w-0 gap-1">
        <span className={cn(TINY_CAPS, 'text-zinc-500')}>Goal (optional)</span>
        <div className="flex items-center gap-2">
          {kind === 'daily' ? (
            <SmoothSelect
              value={direction}
              onChange={(v) => setDirection(v as GoalDirection)}
              options={DIRECTION_OPTIONS}
              accent="orange"
              align="start"
              portal
              aria-label="Goal direction"
              triggerClassName="text-sm"
            />
          ) : (
            <span className="whitespace-nowrap text-xs text-zinc-500">score ≥</span>
          )}
          <Input
            value={goal}
            inputMode="decimal"
            placeholder="none"
            aria-label="Goal"
            onChange={(e) => setGoal(e.target.value.replace(/[^0-9.]/g, ''))}
            className="w-20 bg-white text-right font-mono tabular-nums dark:bg-zinc-950"
          />
        </div>
      </div>
      <Button type="submit" size="lg" variant="outline" className="h-9" disabled={busy || !title.trim()}>
        {busy ? <Loader2 className="animate-spin" /> : <Plus />} Add section
      </Button>
    </form>
  );
}

function GoalEditor({
  value,
  resetTo,
  text,
  disabled,
  onSave,
}: {
  value: number;
  resetTo: number;
  text: string;
  disabled: boolean;
  onSave: (goal: number | null) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-zinc-500">Goal {text}</span>
      <Input
        value={draft}
        inputMode="decimal"
        disabled={disabled}
        aria-label="Goal"
        onChange={(e) => setDraft(e.target.value.replace(/[^0-9.]/g, ''))}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
        onBlur={() => {
          const n = Number(draft);
          if (draft.trim() === '' || !Number.isFinite(n)) {
            setDraft(String(value));
            return;
          }
          if (n !== value) onSave(n);
        }}
        className="w-20 text-right font-mono tabular-nums"
      />
      {value !== resetTo ? (
        <Button size="xs" variant="ghost" disabled={disabled} onClick={() => onSave(null)}>
          Reset to {resetTo}
        </Button>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

const BUCKET_DAY_OPTIONS = [
  { value: '', label: 'Every day' },
  ...MON_FRI.map((d) => ({ value: d, label: `${WEEKDAY_LABEL[d]} bucket` })),
];

function RowsArea({ board, sections, onChanged }: Props) {
  const [sectionId, setSectionId] = useState<string>(sections[0]?.id ?? 'buckets');
  const section = sections.find((s) => s.id === sectionId) ?? sections[0];
  const rows = board.rows.filter(
    (r) => !r.archived && (section.key === 'custom' ? r.sectionKey === 'custom' && r.customSectionId === section.customId : r.sectionKey === section.key),
  );
  const [named, setNamed] = useState('');
  const [busy, setBusy] = useState(false);

  async function addRow(label: string, workEmail: string | null) {
    setBusy(true);
    const res = await api('/api/accounting-scoreboard/rows', {
      method: 'POST',
      body: JSON.stringify({ sectionKey: section.key, customSectionId: section.customId, label, workEmail }),
    });
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error);
      return false;
    }
    toast.success(`Added ${label} to ${section.title}`);
    onChanged();
    return true;
  }

  async function patch(
    id: string,
    body: { label?: string; sortOrder?: number; archived?: true; bucketDay?: Weekday | null; dueSoon?: boolean },
    refresh = true,
  ) {
    const res = await api('/api/accounting-scoreboard/rows', { method: 'PATCH', body: JSON.stringify({ id, ...body }) });
    if (!res.ok) toast.error(res.error);
    else if (refresh) onChanged();
    return res.ok;
  }

  /** Swap two neighbours, then number the section 0…n−1 in the new order (only changed rows are written). */
  async function move(index: number, dir: -1 | 1) {
    const order = rows.map((r) => r.id);
    const j = index + dir;
    if (j < 0 || j >= order.length) return;
    [order[index], order[j]] = [order[j], order[index]];
    setBusy(true);
    for (let i = 0; i < order.length; i++) {
      const row = rows.find((r) => r.id === order[i]);
      if (row && row.sortOrder !== i && !(await patch(row.id, { sortOrder: i }, false))) break;
    }
    setBusy(false);
    onChanged();
  }

  const fillsItself = section.kind === 'payroll_cycle';
  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_22rem]">
      <div className="space-y-3">
        <div className="grid max-w-sm gap-1">
          <span className={cn(TINY_CAPS, 'text-zinc-500')}>Section</span>
          <SmoothSelect
            value={section.id}
            onChange={setSectionId}
            options={sections.map((s) => {
              const name = s.hostTab ? `${s.tab} — ${s.title}` : s.title;
              return { value: s.id, label: s.enabled ? name : `${name} (off)` };
            })}
            accent="orange"
            align="start"
            portal
            aria-label="Section"
            triggerClassName="text-sm"
          />
        </div>
        {fillsItself ? (
          <div className="rounded-xl border border-dashed border-zinc-200 px-4 py-5 text-sm text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">
            <p className="font-medium text-zinc-800 dark:text-zinc-200">This section fills itself from HRIS. There are no rows to add.</p>
            <p className="mt-1 text-xs leading-relaxed">
              Started is the week&rsquo;s first Start Processing in the Payroll Wizard. Closed is Close Pay Cycle in Payment
              Dispatch.
              {rows.length
                ? ` The ${rows.length} row${rows.length === 1 ? '' : 's'} from the earlier per-person timing ${rows.length === 1 ? 'is' : 'are'} kept, but no longer shown.`
                : ''}
            </p>
          </div>
        ) : rows.length ? (
          <ul className="divide-y divide-zinc-100 overflow-hidden rounded-xl border border-zinc-200 bg-white dark:divide-zinc-900 dark:border-zinc-800 dark:bg-zinc-950">
            <AnimatePresence initial={false}>
              {rows.map((r, i) => (
                <RowLine
                  key={r.id}
                  row={r}
                  first={i === 0}
                  last={i === rows.length - 1}
                  onRename={(label) => patch(r.id, { label })}
                  onMove={(dir) => void move(i, dir)}
                  onArchive={() => patch(r.id, { archived: true })}
                  onBucketDay={r.sectionKey === 'buckets' ? (day) => patch(r.id, { bucketDay: day }) : undefined}
                  onDueSoon={r.sectionKey === 'chargebacks' ? (on) => patch(r.id, { dueSoon: on }) : undefined}
                />
              ))}
            </AnimatePresence>
          </ul>
        ) : (
          <p className="rounded-xl border border-dashed border-zinc-200 px-4 py-6 text-center text-sm text-zinc-500 dark:border-zinc-800">
            No rows on {section.title} yet.
          </p>
        )}
        {fillsItself ? null : (
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!named.trim()) return;
              if (await addRow(named.trim(), null)) setNamed('');
            }}
          >
            <label className="grid min-w-[min(14rem,100%)] flex-1 gap-1">
              <span className={cn(TINY_CAPS, 'text-zinc-500')}>Add a named row</span>
              <Input
                value={named}
                maxLength={80}
                onChange={(e) => setNamed(e.target.value)}
                placeholder={
                  section.key === 'buckets'
                    ? "e.g. Mon (Collections), Darrell's Bucket"
                    : section.key === 'inbox'
                      ? 'e.g. Payroll Simple.biz'
                      : section.key === 'cancellations'
                        ? 'e.g. Green'
                        : section.key === 'chargeback_outcomes'
                          ? 'e.g. Wins'
                          : 'a queue, an inbox, or someone not on the roster'
                }
              />
            </label>
            <Button type="submit" size="lg" variant="outline" className="h-9" disabled={busy || !named.trim()}>
              <Plus /> Add
            </Button>
          </form>
        )}
      </div>
      {fillsItself ? null : (
        <RosterPicker
          disabled={busy}
          taken={new Set(rows.map((r) => r.workEmail).filter((e): e is string => !!e))}
          onPick={(p) => void addRow(shortNameFromRoster(p.name) || p.workEmail, p.workEmail)}
        />
      )}
    </div>
  );
}

function RowLine({
  row,
  first,
  last,
  onRename,
  onMove,
  onArchive,
  onBucketDay,
  onDueSoon,
}: {
  row: BoardRow;
  first: boolean;
  last: boolean;
  onRename: (label: string) => Promise<boolean>;
  onMove: (dir: -1 | 1) => void;
  onArchive: () => Promise<boolean>;
  /** Buckets: mark a weekday Collections bucket (scored once its own day's PM is in). */
  onBucketDay?: (day: Weekday | null) => Promise<boolean>;
  /** Open Disputes: mark the line that counts the disputes due in 7 days. */
  onDueSoon?: (on: boolean) => Promise<boolean>;
}) {
  const reduce = useReducedMotion() ?? false;
  const [label, setLabel] = useState(row.label);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => setLabel(row.label), [row.label]);
  return (
    <motion.li
      layout={reduce ? false : 'position'}
      initial={{ opacity: 0, y: reduce ? 0 : -4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: reduce ? 0 : -14, transition: { duration: 0.14 } }}
      transition={{ duration: reduce ? 0 : 0.22, ease: EASE_SETTLE }}
      className="flex flex-wrap items-center gap-2 bg-white px-3 py-2 dark:bg-zinc-950"
    >
      <Input
        value={label}
        maxLength={80}
        aria-label="Row name"
        onChange={(e) => setLabel(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
        onBlur={async () => {
          const next = label.trim();
          if (!next) return setLabel(row.label);
          if (next !== row.label && !(await onRename(next))) setLabel(row.label);
        }}
        className="h-8 w-auto min-w-[10rem] flex-1"
      />
      {row.workEmail ? (
        <span className="font-mono text-[11px] text-zinc-400" title={row.workEmail}>
          {handle(row.workEmail)}
        </span>
      ) : (
        <span className={cn(TINY_CAPS, 'text-[9px] text-zinc-400')}>named</span>
      )}
      {onBucketDay ? (
        <div className="w-36" title="A weekday Collections bucket is scored once its own day's PM reading is in (Pending until then)">
          <SmoothSelect
            value={row.bucketDay ?? ''}
            onChange={(v) => void onBucketDay(v === '' ? null : (v as Weekday))}
            options={BUCKET_DAY_OPTIONS}
            accent="orange"
            align="start"
            portal
            aria-label={`${row.label}: weekday Collections bucket`}
            triggerClassName="h-8 text-xs"
          />
        </div>
      ) : null}
      {onDueSoon ? (
        <label className="flex items-center gap-1.5 text-[11px] text-zinc-600 dark:text-zinc-400">
          <Switch checked={row.dueSoon} onCheckedChange={(on: boolean) => void onDueSoon(on)} aria-label={`${row.label}: due in 7 days`} />
          due in 7 days
        </label>
      ) : null}
      <Button size="icon-xs" variant="ghost" disabled={first} aria-label="Move up" onClick={() => onMove(-1)}>
        <ArrowUp />
      </Button>
      <Button size="icon-xs" variant="ghost" disabled={last} aria-label="Move down" onClick={() => onMove(1)}>
        <ArrowDown />
      </Button>
      {confirming ? (
        <span className="flex items-center gap-1">
          <Button size="xs" variant="destructive" onClick={() => void onArchive()}>
            Remove
          </Button>
          <Button size="xs" variant="ghost" onClick={() => setConfirming(false)}>
            Keep
          </Button>
        </span>
      ) : (
        <Button size="icon-xs" variant="ghost" aria-label={`Remove ${row.label}`} onClick={() => setConfirming(true)}>
          <X />
        </Button>
      )}
    </motion.li>
  );
}

function RosterPicker({
  disabled,
  taken,
  onPick,
}: {
  disabled: boolean;
  taken: Set<string>;
  onPick: (p: RosterPerson) => void;
}) {
  // Paints from the browser cache (tab-cache.ts), then reads the roster again anyway. Setup only ever
  // renders after a click, never on the server, so reading the cache in the initialiser is safe.
  const [people, setPeople] = useState<RosterPerson[] | null>(() => readCachedRoster() ?? null);
  const [error, setError] = useState<string | null>(null);
  const [dept, setDept] = useState('Accounting Team');
  const [query, setQuery] = useState('');

  useEffect(() => {
    let alive = true;
    void api<{ people: RosterPerson[] }>('/api/accounting-scoreboard/roster').then((res) => {
      if (!alive) return;
      if (res.ok) {
        setPeople(res.data.people);
        setError(null);
        writeCachedRoster(res.data.people);
      } else setError(res.error);
    });
    return () => {
      alive = false;
    };
  }, []);

  const departments = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of people ?? []) counts.set(p.department, (counts.get(p.department) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [people]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (people ?? [])
      .filter((p) => (dept === '' || p.department === dept) && (!q || p.name.toLowerCase().includes(q) || p.workEmail.includes(q)))
      .slice(0, 60);
  }, [people, dept, query]);

  return (
    <div className="space-y-2 rounded-xl border border-zinc-200 bg-zinc-50/60 p-3 dark:border-zinc-800 dark:bg-zinc-900/40">
      <div className="flex items-center gap-2">
        <UserPlus className="size-4 text-orange-500" />
        <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">Add someone from the roster</h3>
      </div>
      {error ? <p className="text-xs text-amber-700">{error}</p> : null}
      {!people && !error ? (
        <p className="flex items-center gap-2 text-xs text-zinc-500">
          <Loader2 className="size-3.5 animate-spin" /> Loading the roster…
        </p>
      ) : null}
      {people ? (
        <>
          <SmoothSelect
            value={dept}
            onChange={setDept}
            options={[
              { value: '', label: `Every department (${people.length})` },
              ...departments.map(([d, n]) => ({ value: d, label: `${formatDeptLabel(d)} (${n})` })),
            ]}
            searchable
            searchPlaceholder="Find a department…"
            accent="orange"
            align="start"
            portal
            aria-label="Department"
            triggerClassName="text-sm"
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name or email"
            aria-label="Search the roster"
          />
          <ul className="max-h-80 divide-y divide-zinc-100 overflow-y-auto rounded-lg border border-zinc-200 bg-white dark:divide-zinc-900 dark:border-zinc-800 dark:bg-zinc-950">
            {shown.map((p) => {
              const on = taken.has(p.workEmail);
              return (
                <li key={p.workEmail} className="flex items-center gap-2 px-2.5 py-1.5">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-zinc-800 dark:text-zinc-200">{p.name}</div>
                    <div className="truncate font-mono text-[11px] text-zinc-400">
                      {`${p.workEmail} · ${formatDeptLabel(p.department)}`}
                    </div>
                  </div>
                  <Button size="xs" variant="outline" disabled={disabled || on} onClick={() => onPick(p)}>
                    {on ? 'On it' : 'Add'}
                  </Button>
                </li>
              );
            })}
            {!shown.length ? <li className="px-2.5 py-3 text-center text-xs text-zinc-500">Nobody matches.</li> : null}
          </ul>
          <p className="text-[11px] text-zinc-500">
            Not on the roster? Add them as a named row on the left, and let them sign in under Members.
          </p>
        </>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * Payroll Problems types (Carla, 2026-10-02: "Admins should be able to add new types"). A removed
 * type leaves the dropdown; every problem already logged keeps it.
 */
function ProblemTypesArea({ board, onChanged }: { board: BoardPayload; onChanged: () => void }) {
  const reduce = useReducedMotion() ?? false;
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const live = board.problemTypes.filter((t) => !t.archived);

  async function add() {
    setBusy(true);
    const res = await api('/api/accounting-scoreboard/problem-types', { method: 'POST', body: JSON.stringify({ label }) });
    setBusy(false);
    if (!res.ok) return toast.error(res.error);
    setLabel('');
    onChanged();
  }

  async function remove(id: string) {
    const res = await api('/api/accounting-scoreboard/problem-types', { method: 'PATCH', body: JSON.stringify({ id, archived: true }) });
    setConfirming(null);
    if (!res.ok) return toast.error(res.error);
    onChanged();
  }

  return (
    <div className="max-w-xl space-y-3">
      <p className="text-xs leading-relaxed text-zinc-500">
        The choices in Payroll Problems&rsquo; Problem Type dropdown. Removing a type takes it off the dropdown; problems
        already logged keep it.
      </p>
      <ul className="divide-y divide-zinc-100 overflow-hidden rounded-xl border border-zinc-200 bg-white dark:divide-zinc-900 dark:border-zinc-800 dark:bg-zinc-950">
        <AnimatePresence initial={false}>
          {live.map((t) => (
            <motion.li
              key={t.id}
              layout={reduce ? false : 'position'}
              initial={{ opacity: 0, y: reduce ? 0 : -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, x: reduce ? 0 : -14, transition: { duration: 0.14 } }}
              transition={{ duration: reduce ? 0 : 0.22, ease: EASE_SETTLE }}
              className="flex items-center gap-2 bg-white px-3 py-2 dark:bg-zinc-950"
            >
              <span className="min-w-0 flex-1 truncate text-sm text-zinc-800 dark:text-zinc-200">{t.label}</span>
              {confirming === t.id ? (
                <span className="flex items-center gap-1">
                  <Button size="xs" variant="destructive" onClick={() => void remove(t.id)}>
                    Remove
                  </Button>
                  <Button size="xs" variant="ghost" onClick={() => setConfirming(null)}>
                    Keep
                  </Button>
                </span>
              ) : (
                <Button size="icon-xs" variant="ghost" aria-label={`Remove ${t.label}`} onClick={() => setConfirming(t.id)}>
                  <X />
                </Button>
              )}
            </motion.li>
          ))}
        </AnimatePresence>
        {!live.length ? <li className="px-3 py-4 text-center text-xs text-zinc-500">No problem types yet.</li> : null}
      </ul>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (label.trim()) void add();
        }}
      >
        <Input
          value={label}
          maxLength={60}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="e.g. Bank Error"
          aria-label="New problem type"
          className="flex-1"
        />
        <Button type="submit" size="lg" variant="outline" className="h-9" disabled={busy || !label.trim()}>
          {busy ? <Loader2 className="animate-spin" /> : <Plus />} Add type
        </Button>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------

function MembersArea({ board, onChanged }: { board: BoardPayload; onChanged: () => void }) {
  const reduce = useReducedMotion() ?? false;
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const members = board.members ?? [];
  const onRows = useMemo(() => {
    const set = new Set<string>();
    for (const r of board.rows) if (r.workEmail && !r.archived) set.add(r.workEmail);
    return [...set].sort();
  }, [board.rows]);

  async function add() {
    setBusy(true);
    const res = await api('/api/accounting-scoreboard/members', { method: 'POST', body: JSON.stringify({ workEmail: email }) });
    setBusy(false);
    if (!res.ok) return toast.error(res.error);
    setEmail('');
    onChanged();
  }

  async function remove(workEmail: string) {
    const res = await api(`/api/accounting-scoreboard/members?email=${encodeURIComponent(workEmail)}`, { method: 'DELETE' });
    if (!res.ok) return toast.error(res.error);
    onChanged();
  }

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <div className="space-y-3">
        <p className="text-xs leading-relaxed text-zinc-500">
          Everyone on a person row can already sign in and enter numbers. Add here anyone else who enters numbers
          without being a row, such as whoever collects the team&rsquo;s numbers, or someone not on the roster
          with a @simple.biz sign-in. Accounting and Admin always have access.
        </p>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (email.trim()) void add();
          }}
        >
          <Input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="name@simple.biz"
            aria-label="Member's work email"
            className="flex-1 font-mono md:text-[13px]"
          />
          <Button type="submit" size="lg" variant="outline" className="h-9" disabled={busy || !email.trim()}>
            {busy ? <Loader2 className="animate-spin" /> : <Plus />} Add
          </Button>
        </form>
        <ul className="divide-y divide-zinc-100 overflow-hidden rounded-xl border border-zinc-200 bg-white dark:divide-zinc-900 dark:border-zinc-800 dark:bg-zinc-950">
          <AnimatePresence initial={false}>
            {members.map((m) => (
              <motion.li
                key={m.workEmail}
                layout={reduce ? false : 'position'}
                initial={{ opacity: 0, y: reduce ? 0 : -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, x: reduce ? 0 : -14, transition: { duration: 0.14 } }}
                transition={{ duration: reduce ? 0 : 0.22, ease: EASE_SETTLE }}
                className="flex items-center gap-2 bg-white px-3 py-2 dark:bg-zinc-950"
              >
                <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{m.workEmail}</span>
                <span className="text-[11px] text-zinc-400">added by {handle(m.addedBy)}</span>
                <Button size="icon-xs" variant="ghost" aria-label={`Remove ${m.workEmail}`} onClick={() => void remove(m.workEmail)}>
                  <X />
                </Button>
              </motion.li>
            ))}
          </AnimatePresence>
          {!members.length ? <li className="px-3 py-4 text-center text-xs text-zinc-500">No extra members.</li> : null}
        </ul>
      </div>
      <div className="space-y-2">
        <h3 className={cn(TINY_CAPS, 'text-zinc-500')}>On a person row ({onRows.length})</h3>
        <ul className="max-h-96 overflow-y-auto rounded-xl border border-zinc-200 bg-white px-3 py-2 font-mono text-[12px] text-zinc-600 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400">
          {onRows.map((e) => (
            <li key={e} className="truncate py-0.5">
              {e}
            </li>
          ))}
          {!onRows.length ? <li className="py-2 text-center text-xs">Nobody yet.</li> : null}
        </ul>
      </div>
    </div>
  );
}
