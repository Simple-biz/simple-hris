'use client';

/**
 * Setup (managers = Accounting / Admin): which sections are on and their goals, who or what each
 * section's rows are, and the extra members. Carla asked to track less than the sheet does, so
 * every section can be switched off here without a code change.
 *
 * A row picked from the roster IS that HRIS person and makes them a member. A section's people
 * come from several departments (Accounting Team, USEE, Sales, PM Team), so the department is the
 * picker's FILTER, never the section's definition (analysis note § 4).
 */

import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Loader2, Plus, UserPlus, X } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import type { ResolvedSection, SectionKey } from '@/lib/accounting-scoreboard/sections';
import { sectionDef } from '@/lib/accounting-scoreboard/sections';
import { goalText } from '@/lib/accounting-scoreboard/scoring';
import { shortNameFromRoster } from '@/lib/accounting-scoreboard/names';
import { formatDeptLabel } from '@/lib/departments/hsl-subdept';
import type { BoardPayload, BoardRow, RosterPerson } from '@/lib/accounting-scoreboard/types';
import { api, handle, TINY_CAPS } from './shared';

interface Props {
  board: BoardPayload;
  sections: ResolvedSection[];
  onChanged: () => void;
}

const INPUT = 'h-9 rounded-md border border-zinc-200 bg-white px-2.5 text-sm dark:border-zinc-800 dark:bg-zinc-950';

export function SetupPanel({ board, sections, onChanged }: Props) {
  const [area, setArea] = useState<'rows' | 'sections' | 'members'>('rows');
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">Setup</h2>
        <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
          Only Accounting and Admin see this. Changes apply to everyone on the next refresh.
        </p>
      </div>
      <div className="inline-flex rounded-lg border border-zinc-200 bg-zinc-50 p-0.5 dark:border-zinc-800 dark:bg-zinc-900">
        {(
          [
            ['rows', 'Rows'],
            ['sections', 'Sections'],
            ['members', 'Members'],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            onClick={() => setArea(k)}
            className={cn(
              'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
              area === k
                ? 'bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-zinc-100'
                : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200',
            )}
          >
            {label}
          </button>
        ))}
      </div>
      {area === 'rows' ? <RowsArea board={board} sections={sections} onChanged={onChanged} /> : null}
      {area === 'sections' ? <SectionsArea sections={sections} onChanged={onChanged} /> : null}
      {area === 'members' ? <MembersArea board={board} onChanged={onChanged} /> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

function SectionsArea({ sections, onChanged }: { sections: ResolvedSection[]; onChanged: () => void }) {
  const [busy, setBusy] = useState<SectionKey | null>(null);

  async function patch(sectionKey: SectionKey, body: { enabled?: boolean; goal?: number | null }) {
    setBusy(sectionKey);
    const res = await api('/api/accounting-scoreboard/sections', {
      method: 'PATCH',
      body: JSON.stringify({ sectionKey, ...body }),
    });
    setBusy(null);
    if (!res.ok) toast.error(res.error);
    else onChanged();
  }

  return (
    <ul className="divide-y divide-zinc-100 overflow-hidden rounded-xl border border-zinc-200 bg-white dark:divide-zinc-900 dark:border-zinc-800 dark:bg-zinc-950">
      {sections.map((s) => {
        const sheetGoal = sectionDef(s.key).goal;
        return (
          <li key={s.key} className="flex flex-wrap items-center gap-4 px-4 py-3">
            <Switch
              checked={s.enabled}
              disabled={busy === s.key}
              onCheckedChange={(checked: boolean) => void patch(s.key, { enabled: checked })}
              aria-label={`${s.title} on or off`}
            />
            <div className="min-w-0 flex-1">
              <div className={cn('text-sm font-medium', s.enabled ? 'text-zinc-900 dark:text-zinc-100' : 'text-zinc-400 line-through')}>
                {s.title}
              </div>
              <div className="text-xs text-zinc-500">{s.help}</div>
            </div>
            {s.goal && sheetGoal ? (
              <GoalEditor
                key={`${s.key}:${s.goal.value}`}
                value={s.goal.value}
                sheetValue={sheetGoal.value}
                text={goalText(s.goal)}
                disabled={busy === s.key}
                onSave={(goal) => void patch(s.key, { goal })}
              />
            ) : (
              <span className="text-xs text-zinc-400">No goal on the sheet</span>
            )}
            {busy === s.key ? <Loader2 className="size-4 animate-spin text-zinc-400" /> : null}
          </li>
        );
      })}
    </ul>
  );
}

function GoalEditor({
  value,
  sheetValue,
  text,
  disabled,
  onSave,
}: {
  value: number;
  sheetValue: number;
  text: string;
  disabled: boolean;
  onSave: (goal: number | null) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-zinc-500">Goal {text}</span>
      <input
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
        className={cn(INPUT, 'w-20 text-right font-mono tabular-nums')}
      />
      {value !== sheetValue ? (
        <Button size="xs" variant="ghost" disabled={disabled} onClick={() => onSave(null)}>
          Reset to {sheetValue}
        </Button>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

function RowsArea({ board, sections, onChanged }: Props) {
  const [sectionKey, setSectionKey] = useState<SectionKey>(sections[0]?.key ?? 'buckets');
  const section = sections.find((s) => s.key === sectionKey) ?? sections[0];
  const rows = board.rows.filter((r) => r.sectionKey === sectionKey && !r.archived);
  const [named, setNamed] = useState('');
  const [busy, setBusy] = useState(false);

  async function addRow(label: string, workEmail: string | null) {
    setBusy(true);
    const res = await api('/api/accounting-scoreboard/rows', {
      method: 'POST',
      body: JSON.stringify({ sectionKey, label, workEmail }),
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

  async function patch(id: string, body: { label?: string; sortOrder?: number; archived?: true }, refresh = true) {
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

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_22rem]">
      <div className="space-y-3">
        <label className="grid max-w-xs gap-1">
          <span className={cn(TINY_CAPS, 'text-zinc-500')}>Section</span>
          <select value={sectionKey} onChange={(e) => setSectionKey(e.target.value as SectionKey)} className={INPUT}>
            {sections.map((s) => (
              <option key={s.key} value={s.key}>
                {s.title}
                {s.enabled ? '' : ' (off)'}
              </option>
            ))}
          </select>
        </label>
        {rows.length ? (
          <ul className="divide-y divide-zinc-100 overflow-hidden rounded-xl border border-zinc-200 bg-white dark:divide-zinc-900 dark:border-zinc-800 dark:bg-zinc-950">
            {rows.map((r, i) => (
              <RowLine
                key={r.id}
                row={r}
                first={i === 0}
                last={i === rows.length - 1}
                onRename={(label) => patch(r.id, { label })}
                onMove={(dir) => void move(i, dir)}
                onArchive={() => patch(r.id, { archived: true })}
              />
            ))}
          </ul>
        ) : (
          <p className="rounded-xl border border-dashed border-zinc-200 px-4 py-6 text-center text-sm text-zinc-500 dark:border-zinc-800">
            No rows on {section.title} yet.
          </p>
        )}
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!named.trim()) return;
            if (await addRow(named.trim(), null)) setNamed('');
          }}
        >
          <label className="grid min-w-[14rem] flex-1 gap-1">
            <span className={cn(TINY_CAPS, 'text-zinc-500')}>Add a named row</span>
            <input
              value={named}
              maxLength={80}
              onChange={(e) => setNamed(e.target.value)}
              placeholder={
                section.kind === 'am_pm' && section.key === 'buckets'
                  ? "e.g. Mon (Collections), Darrell's Bucket"
                  : section.key === 'inbox'
                    ? 'e.g. Payroll Simple.biz'
                    : section.key === 'cancellations'
                      ? 'e.g. Green'
                      : 'a queue, an inbox, or someone not on the roster'
              }
              className={INPUT}
            />
          </label>
          <Button type="submit" size="lg" variant="outline" disabled={busy || !named.trim()}>
            <Plus /> Add
          </Button>
        </form>
      </div>
      <RosterPicker
        disabled={busy}
        taken={new Set(rows.map((r) => r.workEmail).filter((e): e is string => !!e))}
        onPick={(p) => void addRow(shortNameFromRoster(p.name) || p.workEmail, p.workEmail)}
      />
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
}: {
  row: BoardRow;
  first: boolean;
  last: boolean;
  onRename: (label: string) => Promise<boolean>;
  onMove: (dir: -1 | 1) => void;
  onArchive: () => Promise<boolean>;
}) {
  const [label, setLabel] = useState(row.label);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => setLabel(row.label), [row.label]);
  return (
    <li className="flex flex-wrap items-center gap-2 px-3 py-2">
      <input
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
        className={cn(INPUT, 'h-8 min-w-[10rem] flex-1')}
      />
      {row.workEmail ? (
        <span className="font-mono text-[11px] text-zinc-400" title={row.workEmail}>
          {handle(row.workEmail)}
        </span>
      ) : (
        <span className={cn(TINY_CAPS, 'text-[9px] text-zinc-400')}>named</span>
      )}
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
    </li>
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
  const [people, setPeople] = useState<RosterPerson[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dept, setDept] = useState('Accounting Team');
  const [query, setQuery] = useState('');

  useEffect(() => {
    let alive = true;
    void api<{ people: RosterPerson[] }>('/api/accounting-scoreboard/roster').then((res) => {
      if (!alive) return;
      if (res.ok) setPeople(res.data.people);
      else setError(res.error);
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
          <select value={dept} onChange={(e) => setDept(e.target.value)} className={cn(INPUT, 'w-full')}>
            <option value="">Every department</option>
            {departments.map(([d, n]) => (
              <option key={d} value={d}>
                {`${formatDeptLabel(d)} (${n})`}
              </option>
            ))}
          </select>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name or email"
            className={cn(INPUT, 'w-full')}
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

function MembersArea({ board, onChanged }: { board: BoardPayload; onChanged: () => void }) {
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
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="name@simple.biz"
            className={cn(INPUT, 'flex-1 font-mono text-[13px]')}
          />
          <Button type="submit" size="lg" variant="outline" disabled={busy || !email.trim()}>
            {busy ? <Loader2 className="animate-spin" /> : <Plus />} Add
          </Button>
        </form>
        <ul className="divide-y divide-zinc-100 overflow-hidden rounded-xl border border-zinc-200 bg-white dark:divide-zinc-900 dark:border-zinc-800 dark:bg-zinc-950">
          {members.map((m) => (
            <li key={m.workEmail} className="flex items-center gap-2 px-3 py-2">
              <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{m.workEmail}</span>
              <span className="text-[11px] text-zinc-400">added by {handle(m.addedBy)}</span>
              <Button size="icon-xs" variant="ghost" aria-label={`Remove ${m.workEmail}`} onClick={() => void remove(m.workEmail)}>
                <X />
              </Button>
            </li>
          ))}
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
