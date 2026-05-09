'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  CalendarDays,
  ChevronDown,
  Gift,
  Loader2,
  Package,
  Receipt,
  RefreshCw,
  Save,
  Search,
  Sparkles,
  Users,
} from 'lucide-react';
import GiftCatalog from '@/components/orphanage/GiftCatalog';
import GiftPayments from '@/components/orphanage/GiftPayments';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { EmployeeRow } from '@/lib/supabase/employees';
import type { GiftTrackerNote } from '@/lib/supabase/gift-tracker-notes';

type GiftStatus = 'overdue' | 'red' | 'orange' | 'green' | 'far';

type Milestone = {
  index: number; // 1-based — 1 = first 6-month gift
  date: Date;
};

function parseStartDate(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  const d = new Date(trimmed);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function addMonths(d: Date, months: number): Date {
  const out = new Date(d.getTime());
  const targetMonth = out.getMonth() + months;
  out.setMonth(targetMonth);
  // Handle clamp (e.g. Jan 31 + 1mo)
  if (out.getMonth() !== ((targetMonth % 12) + 12) % 12) {
    out.setDate(0);
  }
  return out;
}

function startOfDay(d: Date): Date {
  const out = new Date(d.getTime());
  out.setHours(0, 0, 0, 0);
  return out;
}

function diffDays(a: Date, b: Date): number {
  const ms = startOfDay(a).getTime() - startOfDay(b).getTime();
  return Math.round(ms / (1000 * 60 * 60 * 24));
}

function formatDate(d: Date): string {
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/** Build all 6-month milestones from `start` up through `today` (history) plus
 *  the very next future one. */
function buildMilestones(start: Date, today: Date): { history: Milestone[]; next: Milestone | null } {
  const history: Milestone[] = [];
  let next: Milestone | null = null;
  // Cap at a sane upper bound — 60 milestones = 30 years.
  for (let i = 1; i <= 60; i += 1) {
    const date = addMonths(start, i * 6);
    if (startOfDay(date).getTime() <= startOfDay(today).getTime()) {
      history.push({ index: i, date });
    } else {
      next = { index: i, date };
      break;
    }
  }
  return { history, next };
}

function gradientForStatus(status: GiftStatus): string {
  switch (status) {
    case 'overdue':
      return 'border-rose-400/90 bg-gradient-to-r from-rose-100 to-rose-50 text-rose-900 dark:border-rose-700/70 dark:from-rose-950/55 dark:to-rose-950/30 dark:text-rose-100';
    case 'red':
      return 'border-rose-400/90 bg-gradient-to-r from-rose-100 to-rose-50 text-rose-900 dark:border-rose-700/70 dark:from-rose-950/55 dark:to-rose-950/30 dark:text-rose-100';
    case 'orange':
      return 'border-orange-400/90 bg-gradient-to-r from-orange-100 to-amber-50 text-orange-900 dark:border-orange-700/70 dark:from-orange-950/55 dark:to-amber-950/30 dark:text-orange-100';
    case 'green':
      return 'border-emerald-400/90 bg-gradient-to-r from-emerald-100 to-emerald-50 text-emerald-900 dark:border-emerald-700/70 dark:from-emerald-950/55 dark:to-emerald-950/30 dark:text-emerald-100';
    default:
      return 'border-zinc-200 bg-white text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300';
  }
}

function statusLabel(status: GiftStatus, daysUntil: number | null): string {
  if (daysUntil === null) return 'No upcoming gift';
  if (status === 'overdue') return `Overdue · ${Math.abs(daysUntil)} days ago`;
  if (daysUntil === 0) return 'Today';
  if (daysUntil === 1) return 'Tomorrow';
  return `In ${daysUntil} day${daysUntil === 1 ? '' : 's'}`;
}

function classifyDaysUntil(daysUntil: number | null): GiftStatus {
  if (daysUntil === null) return 'far';
  if (daysUntil < 0) return 'overdue';
  if (daysUntil <= 7) return 'red';
  if (daysUntil <= 30) return 'orange';
  if (daysUntil <= 90) return 'green';
  return 'far';
}

type Row = {
  key: string;
  name: string;
  email: string; // primary key (personal_email lower-cased)
  workEmail: string | null;
  department: string | null;
  startDate: Date | null;
  history: Milestone[];
  next: Milestone | null;
  daysUntil: number | null;
  status: GiftStatus;
};

export default function GiftTracker({ viewerEmail }: { viewerEmail: string | null }) {
  const [employees, setEmployees] = useState<EmployeeRow[]>([]);
  const [notesByEmail, setNotesByEmail] = useState<Map<string, GiftTrackerNote>>(new Map());
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [draftNotes, setDraftNotes] = useState<Map<string, string>>(new Map());
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [pageDir, setPageDir] = useState<1 | -1>(1);
  const PAGE_SIZE = 10;
  const [subTab, setSubTab] = useState<'roster' | 'catalog' | 'payments'>('roster');

  const today = useMemo(() => new Date(), []);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const [empRes, notesRes] = await Promise.all([
        fetch('/api/employees', { cache: 'no-store' }),
        fetch('/api/gift-tracker-notes', { cache: 'no-store' }),
      ]);
      const empJson = (await empRes.json()) as { employees?: EmployeeRow[]; error?: string };
      const notesJson = (await notesRes.json()) as { notes?: GiftTrackerNote[]; error?: string };
      if (empJson.error) throw new Error(empJson.error);
      setEmployees(empJson.employees ?? []);
      const map = new Map<string, GiftTrackerNote>();
      for (const n of notesJson.notes ?? []) {
        map.set(n.personal_email.toLowerCase(), n);
      }
      setNotesByEmail(map);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not load Gift Tracker');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const rows: Row[] = useMemo(() => {
    const out: Row[] = [];
    for (const e of employees) {
      const email = (e.personal_email ?? e.work_email ?? '').toLowerCase().trim();
      if (!email) continue;
      const startDate = parseStartDate(e.start_date);
      const { history, next } = startDate
        ? buildMilestones(startDate, today)
        : { history: [], next: null };
      const daysUntil = next ? diffDays(next.date, today) : null;
      const status = classifyDaysUntil(daysUntil);
      out.push({
        key: email,
        name: e.name ?? email,
        email,
        workEmail: e.work_email ?? null,
        department: e.department ?? null,
        startDate,
        history,
        next,
        daysUntil,
        status,
      });
    }
    return out.sort((a, b) => {
      // Closest gift dates first; "far" and "no start date" sink to the bottom.
      const aRank = a.daysUntil ?? Number.POSITIVE_INFINITY;
      const bRank = b.daysUntil ?? Number.POSITIVE_INFINITY;
      return aRank - bRank;
    });
  }, [employees, today]);

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      [r.name, r.email, r.workEmail ?? '', r.department ?? '']
        .join(' ')
        .toLowerCase()
        .includes(q),
    );
  }, [rows, search]);

  const stats = useMemo(() => {
    let red = 0;
    let orange = 0;
    let green = 0;
    let overdue = 0;
    for (const r of rows) {
      if (r.status === 'red') red += 1;
      else if (r.status === 'orange') orange += 1;
      else if (r.status === 'green') green += 1;
      else if (r.status === 'overdue') overdue += 1;
    }
    return { total: rows.length, red, orange, green, overdue };
  }, [rows]);

  const toggleExpand = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const noteValue = useCallback(
    (key: string) => {
      if (draftNotes.has(key)) return draftNotes.get(key) ?? '';
      return notesByEmail.get(key)?.note ?? '';
    },
    [draftNotes, notesByEmail],
  );

  const saveNote = useCallback(
    async (row: Row) => {
      const value = noteValue(row.key);
      const original = notesByEmail.get(row.key)?.note ?? '';
      if (value === original) {
        // nothing changed
        setDraftNotes((prev) => {
          const next = new Map(prev);
          next.delete(row.key);
          return next;
        });
        return;
      }
      setSavingKey(row.key);
      try {
        const res = await fetch('/api/gift-tracker-notes', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            personal_email: row.email,
            note: value,
            updated_by: viewerEmail,
          }),
        });
        const json = (await res.json()) as { error?: string };
        if (!res.ok || json.error) throw new Error(json.error ?? 'Failed');
        setNotesByEmail((prev) => {
          const next = new Map(prev);
          next.set(row.key, {
            personal_email: row.email,
            note: value,
            updated_by: viewerEmail,
            updated_at: new Date().toISOString(),
          });
          return next;
        });
        setDraftNotes((prev) => {
          const next = new Map(prev);
          next.delete(row.key);
          return next;
        });
        toast.success('Note saved.');
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Could not save note');
      } finally {
        setSavingKey(null);
      }
    },
    [noteValue, notesByEmail, viewerEmail],
  );

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
      className="flex min-h-0 flex-1 flex-col overflow-y-auto"
    >
      <div className="flex flex-col gap-6 px-4 pb-10 pt-6 sm:px-6 lg:gap-8 lg:px-8 lg:pt-8">
        <header className="relative overflow-hidden rounded-2xl border border-pink-100/90 bg-gradient-to-br from-pink-600 via-rose-600 to-zinc-900 px-5 py-7 text-white shadow-lg shadow-pink-600/20 dark:border-pink-900/50 dark:from-pink-700 dark:via-rose-900 dark:to-black sm:px-7">
          <div
            className="absolute -right-10 -top-10 h-36 w-36 rounded-full bg-white/15 blur-3xl"
            aria-hidden
          />
          <div
            className="absolute -bottom-12 left-8 h-32 w-32 rounded-full bg-rose-300/25 blur-2xl"
            aria-hidden
          />
          <div className="relative flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between lg:gap-6">
            <div className="flex min-w-0 flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.18em] text-pink-100/95">
                <Sparkles className="h-3 w-3 shrink-0" />
                Gift tracker
              </div>
              <h1 className="text-balance text-2xl font-bold tracking-tight sm:text-3xl">
                Six-month gifts &amp; tenure milestones
              </h1>
              <p className="max-w-2xl text-sm leading-relaxed text-pink-100/90">
                Every 6 months an employee stays with the company they earn a gift. Color-coded badges flag who&apos;s
                close — green at 3 months out, orange at 1 month, red within a week.
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="border-white/35 bg-white/10 text-white backdrop-blur-sm hover:bg-white/20 hover:text-white"
                onClick={() => void load()}
                disabled={refreshing}
              >
                <RefreshCw
                  className={refreshing ? 'mr-1.5 h-3.5 w-3.5 animate-spin' : 'mr-1.5 h-3.5 w-3.5'}
                />
                Refresh
              </Button>
            </div>
          </div>
        </header>

        {/* Sub-tab toggle — Roster vs editable Catalog. */}
        <nav
          className="inline-flex w-full flex-wrap items-center gap-1 rounded-lg border border-pink-100/80 bg-white/80 p-1 sm:w-fit dark:border-pink-950/45 dark:bg-zinc-950/60"
          aria-label="Gift Tracker sections"
        >
          <SubTabButton
            active={subTab === 'roster'}
            onClick={() => setSubTab('roster')}
            Icon={Users}
            label="Roster"
          />
          <SubTabButton
            active={subTab === 'catalog'}
            onClick={() => setSubTab('catalog')}
            Icon={Package}
            label="Catalog"
          />
          <SubTabButton
            active={subTab === 'payments'}
            onClick={() => setSubTab('payments')}
            Icon={Receipt}
            label="Payments"
          />
        </nav>

        <AnimatePresence mode="wait" initial={false}>
        {subTab === 'catalog' ? (
          <motion.div
            key="catalog"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
          >
            <GiftCatalog viewerEmail={viewerEmail} />
          </motion.div>
        ) : subTab === 'payments' ? (
          <motion.div
            key="payments"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
          >
            <GiftPayments viewerEmail={viewerEmail} />
          </motion.div>
        ) : (
        <motion.div
          key="roster"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
          className="flex flex-col gap-6 lg:gap-8"
        >
        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Gift summary">
          <StatTile
            label="Tracked employees"
            value={stats.total}
            hint="From Global Master List"
            icon={Users}
            tone="pink"
          />
          <StatTile
            label="Within 1 week"
            value={stats.red + stats.overdue}
            hint={stats.overdue > 0 ? `${stats.overdue} overdue` : 'Get the gift ready'}
            icon={Gift}
            tone="red"
          />
          <StatTile
            label="Within 1 month"
            value={stats.orange}
            hint="Plan ahead this month"
            icon={CalendarDays}
            tone="orange"
          />
          <StatTile
            label="Within 3 months"
            value={stats.green}
            hint="On the horizon"
            icon={Sparkles}
            tone="green"
          />
        </section>

        <Card className="border-pink-100/80 bg-gradient-to-br from-white via-pink-50/30 to-white shadow-md ring-1 ring-pink-500/8 dark:border-pink-950/55 dark:from-zinc-950 dark:via-pink-950/12 dark:to-zinc-950 dark:ring-pink-400/10">
          <CardHeader className="flex flex-col gap-1 border-b border-pink-100/60 pb-4 dark:border-pink-900/40">
            <div className="flex items-center gap-2.5">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-pink-600 to-rose-700 text-white shadow-sm shadow-pink-600/25">
                <Gift className="h-4 w-4" />
              </div>
              <CardTitle className="text-base font-semibold">Tenure gift roster</CardTitle>
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">
              Sorted by closest upcoming gift. Click a row to see the full milestone history and edit the note.
            </p>
          </CardHeader>
          <CardContent className="flex flex-col gap-4 pt-4">
            <div className="relative max-w-md">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
              <Input
                value={search}
                onChange={(e) => { setSearch(e.target.value); setPage(0); }}
                placeholder="Search by name, email, or department..."
                className="border-pink-100/70 bg-white/90 pl-9 dark:border-pink-900/50 dark:bg-zinc-900/70"
              />
            </div>

            {loading ? (
              <div className="flex items-center justify-center gap-2 py-12 text-sm text-zinc-500">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading roster…
              </div>
            ) : filteredRows.length === 0 ? (
              <div className="rounded-xl border border-dashed border-pink-200/80 bg-white/70 py-10 text-center text-sm text-zinc-600 dark:border-pink-900/50 dark:bg-zinc-950/40 dark:text-zinc-400">
                {rows.length === 0 ? 'No employees in the master list yet.' : 'No rows match your search.'}
              </div>
            ) : (
              <div className="overflow-hidden rounded-xl border border-pink-100/90 ring-1 ring-pink-500/10 dark:border-pink-900/60 dark:ring-pink-400/10">
                <AnimatePresence mode="wait" initial={false} custom={pageDir}>
                <motion.table
                  key={page}
                  custom={pageDir}
                  variants={{
                    enter: (dir: number) => ({ opacity: 0, x: dir * 32 }),
                    center: { opacity: 1, x: 0 },
                    exit: (dir: number) => ({ opacity: 0, x: dir * -32 }),
                  }}
                  initial="enter"
                  animate="center"
                  exit="exit"
                  transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                  className="w-full min-w-[760px] text-left text-sm"
                >
                  <thead className="bg-gradient-to-r from-pink-50 via-white to-pink-50/80 text-xs text-zinc-600 dark:from-pink-950/50 dark:via-zinc-950 dark:to-pink-950/40 dark:text-zinc-400">
                    <tr>
                      <th className="px-4 py-3 font-semibold">Employee</th>
                      <th className="px-4 py-3 font-semibold">Start date</th>
                      <th className="px-4 py-3 font-semibold">Milestones</th>
                      <th className="px-4 py-3 font-semibold">Next gift date</th>
                      <th className="px-4 py-3 font-semibold w-[1%]" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-pink-100/70 bg-white/80 dark:divide-pink-900/35 dark:bg-zinc-950/40">
                    {filteredRows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((row) => {
                      const isOpen = expanded.has(row.key);
                      const noteVal = noteValue(row.key);
                      const noteDirty = draftNotes.has(row.key);
                      return (
                        <RowItem
                          key={row.key}
                          row={row}
                          isOpen={isOpen}
                          onToggle={() => toggleExpand(row.key)}
                          noteValue={noteVal}
                          noteDirty={noteDirty}
                          saving={savingKey === row.key}
                          onNoteChange={(v) =>
                            setDraftNotes((prev) => {
                              const next = new Map(prev);
                              next.set(row.key, v);
                              return next;
                            })
                          }
                          onNoteSave={() => void saveNote(row)}
                          updatedAt={notesByEmail.get(row.key)?.updated_at ?? null}
                        />
                      );
                    })}
                  </tbody>
                </motion.table>
                </AnimatePresence>
                {filteredRows.length > PAGE_SIZE && (
                  <div className="flex items-center justify-between border-t border-pink-100/60 bg-white/70 px-4 py-3 dark:border-pink-900/40 dark:bg-zinc-950/40">
                    <span className="text-xs text-zinc-500 dark:text-zinc-400">
                      Page {page + 1} of {Math.ceil(filteredRows.length / PAGE_SIZE)}
                      {' · '}{filteredRows.length} total
                    </span>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 px-3 text-xs border-pink-100/70 dark:border-pink-900/50"
                        disabled={page === 0}
                        onClick={() => { setPageDir(-1); setPage((p) => Math.max(0, p - 1)); }}
                      >
                        ← Prev
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 px-3 text-xs border-pink-100/70 dark:border-pink-900/50"
                        disabled={(page + 1) * PAGE_SIZE >= filteredRows.length}
                        onClick={() => { setPageDir(1); setPage((p) => p + 1); }}
                      >
                        Next →
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
        </motion.div>
        )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}

function SubTabButton({
  active,
  onClick,
  Icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  Icon: React.ComponentType<{ className?: string }>;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-medium transition-colors',
        active
          ? 'bg-gradient-to-r from-pink-600 to-rose-700 text-white shadow-sm shadow-pink-600/25'
          : 'text-zinc-600 hover:bg-pink-50 hover:text-pink-900 dark:text-zinc-300 dark:hover:bg-pink-950/40 dark:hover:text-pink-100',
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}

function RowItem({
  row,
  isOpen,
  onToggle,
  noteValue,
  noteDirty,
  saving,
  onNoteChange,
  onNoteSave,
  updatedAt,
}: {
  row: Row;
  isOpen: boolean;
  onToggle: () => void;
  noteValue: string;
  noteDirty: boolean;
  saving: boolean;
  onNoteChange: (v: string) => void;
  onNoteSave: () => void;
  updatedAt: string | null;
}) {
  return (
    <>
      <tr
        className="cursor-pointer align-top transition-colors hover:bg-pink-50/35 dark:hover:bg-pink-950/25"
        onClick={onToggle}
      >
        <td className="px-4 py-3">
          <div className="flex flex-col">
            <span className="font-medium text-zinc-900 dark:text-zinc-100">{row.name}</span>
            <span className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400">{row.email}</span>
            {row.department ? (
              <span className="mt-0.5 text-[11px] text-pink-600/80 dark:text-pink-400/80">{row.department}</span>
            ) : null}
          </div>
        </td>
        <td className="whitespace-nowrap px-4 py-3 text-xs text-zinc-700 dark:text-zinc-300">
          {row.startDate ? formatDate(row.startDate) : <span className="text-zinc-400">—</span>}
        </td>
        <td className="whitespace-nowrap px-4 py-3 text-xs">
          <Badge
            variant="outline"
            className="border-zinc-200 bg-zinc-50 font-medium text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
          >
            {row.history.length} reached
          </Badge>
        </td>
        <td className="whitespace-nowrap px-4 py-3">
          {row.next ? (
            <motion.div
              key={row.status}
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
              className={cn(
                'inline-flex flex-col gap-0.5 rounded-lg border px-3 py-1.5 text-xs font-medium',
                gradientForStatus(row.status),
              )}
            >
              <span className="font-semibold">{formatDate(row.next.date)}</span>
              <span className="text-[10.5px] opacity-90">
                Milestone #{row.next.index} · {statusLabel(row.status, row.daysUntil)}
              </span>
            </motion.div>
          ) : row.startDate ? (
            <span className="text-xs text-zinc-400">—</span>
          ) : (
            <span className="text-xs italic text-zinc-400">No start date on file</span>
          )}
        </td>
        <td className="px-4 py-3 text-right">
          <motion.div
            animate={{ rotate: isOpen ? 180 : 0 }}
            transition={{ duration: 0.2 }}
            className="inline-flex"
          >
            <ChevronDown className="h-4 w-4 text-zinc-400" />
          </motion.div>
        </td>
      </tr>
      <AnimatePresence initial={false}>
        {isOpen && (
          <tr>
            <td colSpan={5} className="bg-pink-50/30 p-0 dark:bg-pink-950/15">
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
                className="overflow-hidden"
              >
                <div className="grid gap-5 px-5 py-5 lg:grid-cols-2">
                  {/* History */}
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-pink-700 dark:text-pink-300">
                      <Sparkles className="h-3.5 w-3.5" />
                      Milestone history
                    </div>
                    {row.history.length === 0 ? (
                      <p className="rounded-md border border-dashed border-pink-200 bg-white/60 px-3 py-3 text-xs text-zinc-500 dark:border-pink-900/50 dark:bg-zinc-950/40">
                        No 6-month milestones reached yet.
                      </p>
                    ) : (
                      <ol className="relative ml-1 flex flex-col gap-2 border-l-2 border-pink-200/70 pl-4 dark:border-pink-800/70">
                        {row.history.map((m, idx) => (
                          <motion.li
                            key={m.index}
                            initial={{ x: -10, opacity: 0 }}
                            animate={{ x: 0, opacity: 1 }}
                            transition={{ delay: idx * 0.03, duration: 0.25 }}
                            className="relative"
                          >
                            <span className="absolute -left-[22px] top-1 h-3 w-3 rounded-full bg-gradient-to-br from-pink-500 to-rose-700 ring-2 ring-white dark:ring-zinc-950" />
                            <div className="flex items-baseline justify-between gap-3 rounded-md bg-white/80 px-3 py-1.5 text-xs shadow-sm dark:bg-zinc-950/55">
                              <span className="font-medium text-zinc-800 dark:text-zinc-200">
                                {m.index * 6} months · #{m.index}
                              </span>
                              <span className="text-zinc-500 dark:text-zinc-400">{formatDate(m.date)}</span>
                            </div>
                          </motion.li>
                        ))}
                      </ol>
                    )}
                  </div>

                  {/* Notes */}
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-pink-700 dark:text-pink-300">
                      <Gift className="h-3.5 w-3.5" />
                      Notes
                    </div>
                    <textarea
                      value={noteValue}
                      onChange={(e) => onNoteChange(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      rows={5}
                      placeholder="Gift preferences, allergies, sizing, delivery address quirks…"
                      className="w-full rounded-md border border-pink-100 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-pink-400 focus:outline-none focus:ring-2 focus:ring-pink-200 dark:border-pink-900/50 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:border-pink-700 dark:focus:ring-pink-900/50"
                    />
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] text-zinc-500 dark:text-zinc-400">
                        {updatedAt
                          ? `Last saved ${new Date(updatedAt).toLocaleString(undefined, {
                              dateStyle: 'medium',
                              timeStyle: 'short',
                            })}`
                          : 'No note yet'}
                      </span>
                      <Button
                        size="sm"
                        className="h-8 bg-gradient-to-r from-pink-600 to-rose-700 text-white shadow-sm shadow-pink-600/25 hover:from-pink-700 hover:to-rose-800"
                        onClick={(e) => {
                          e.stopPropagation();
                          onNoteSave();
                        }}
                        disabled={!noteDirty || saving}
                      >
                        {saving ? (
                          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Save className="mr-1.5 h-3.5 w-3.5" />
                        )}
                        Save note
                      </Button>
                    </div>
                  </div>
                </div>
              </motion.div>
            </td>
          </tr>
        )}
      </AnimatePresence>
    </>
  );
}

function StatTile({
  label,
  value,
  hint,
  icon: Icon,
  tone,
}: {
  label: string;
  value: number | string;
  hint: string;
  icon: React.ComponentType<{ className?: string }>;
  tone: 'pink' | 'red' | 'orange' | 'green';
}) {
  const tones: Record<'pink' | 'red' | 'orange' | 'green', string> = {
    pink: 'from-pink-500 to-rose-700 shadow-pink-500/30',
    red: 'from-rose-500 to-rose-800 shadow-rose-500/35',
    orange: 'from-orange-500 to-amber-600 shadow-orange-500/35',
    green: 'from-emerald-500 to-emerald-700 shadow-emerald-500/35',
  };
  return (
    <div className="group relative flex items-center gap-4 overflow-hidden rounded-xl border border-pink-100/80 bg-white/90 px-4 py-4 ring-1 ring-pink-500/5 backdrop-blur-sm transition-shadow hover:shadow-md hover:shadow-pink-500/10 dark:border-pink-950/50 dark:bg-zinc-950/75 dark:ring-pink-400/10">
      <div
        className={cn(
          'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br text-white shadow-md',
          tones[tone],
        )}
      >
        <Icon className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-pink-600/85 dark:text-pink-400/85">
          {label}
        </div>
        <div className="mt-0.5 bg-gradient-to-br from-zinc-900 via-rose-900 to-zinc-800 bg-clip-text text-xl font-bold tabular-nums text-transparent dark:from-white dark:via-pink-200 dark:to-zinc-200 sm:text-2xl">
          {value}
        </div>
        <div className="mt-1 text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">{hint}</div>
      </div>
    </div>
  );
}

