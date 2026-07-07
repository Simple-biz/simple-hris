'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  ArrowLeft,
  Check,
  Construction,
  Crown,
  Eye,
  EyeOff,
  Loader2,
  RotateCcw,
  Search,
  TriangleAlert,
  Users,
  UserCog,
  Wallet,
  Briefcase,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  DASHBOARD_PAGES,
  PAGES_VISIBILITY_KEY,
  parsePagesVisibility,
  pageVisibility,
  serializePagesVisibility,
  withPageVisibility,
  type DashboardAccent,
  type DashboardKey,
  type DashboardPages,
  type PagesVisibilityConfig,
  type PageVisibility,
} from '@/lib/pages/visibility';

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

const ACCENT: Record<
  DashboardAccent,
  { dot: string; ring: string; soft: string; text: string; icon: typeof Crown }
> = {
  amber: {
    dot: 'bg-amber-500',
    ring: 'ring-amber-200/70 dark:ring-amber-500/20',
    soft: 'bg-amber-50 dark:bg-amber-500/10',
    text: 'text-amber-700 dark:text-amber-300',
    icon: Crown,
  },
  emerald: {
    dot: 'bg-emerald-500',
    ring: 'ring-emerald-200/70 dark:ring-emerald-500/20',
    soft: 'bg-emerald-50 dark:bg-emerald-500/10',
    text: 'text-emerald-700 dark:text-emerald-300',
    icon: Users,
  },
  orange: {
    dot: 'bg-orange-500',
    ring: 'ring-orange-200/70 dark:ring-orange-500/20',
    soft: 'bg-orange-50 dark:bg-orange-500/10',
    text: 'text-orange-700 dark:text-orange-300',
    icon: Wallet,
  },
  blue: {
    dot: 'bg-blue-500',
    ring: 'ring-blue-200/70 dark:ring-blue-500/20',
    soft: 'bg-blue-50 dark:bg-blue-500/10',
    text: 'text-blue-700 dark:text-blue-300',
    icon: Briefcase,
  },
};

const ICON_BY_DASHBOARD: Record<DashboardKey, typeof Crown> = {
  ceo: Crown,
  hr: Users,
  accounting: Wallet,
  manager: Briefcase,
  employee: UserCog,
};

const STATES: { value: PageVisibility; label: string; icon: typeof Eye; active: string }[] = [
  {
    value: 'visible',
    label: 'Visible',
    icon: Eye,
    active: 'bg-emerald-500 text-white shadow-sm shadow-emerald-600/30',
  },
  {
    value: 'construction',
    label: 'Under construction',
    icon: Construction,
    active: 'bg-amber-500 text-white shadow-sm shadow-amber-600/30',
  },
  {
    value: 'hidden',
    label: 'Hidden',
    icon: EyeOff,
    active: 'bg-zinc-800 text-white shadow-sm dark:bg-zinc-200 dark:text-zinc-900',
  },
];

export default function AdminPages({ onBack }: { onBack?: () => void }) {
  const [config, setConfig] = useState<PagesVisibilityConfig>({});
  const [loaded, setLoaded] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [search, setSearch] = useState('');
  const [activeDash, setActiveDash] = useState<DashboardKey>('ceo');
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Initial load.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/app-settings?key=${encodeURIComponent(PAGES_VISIBILITY_KEY)}`, {
          cache: 'no-store',
        });
        const json = (await res.json()) as { value?: string | null };
        if (!cancelled) setConfig(parsePagesVisibility(json.value));
      } catch {
        /* leave empty (all visible) */
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => () => {
    if (savedTimer.current) clearTimeout(savedTimer.current);
  }, []);

  const persist = useCallback(async (next: PagesVisibilityConfig, prev: PagesVisibilityConfig) => {
    setSaveState('saving');
    try {
      const res = await fetch('/api/app-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: PAGES_VISIBILITY_KEY, value: serializePagesVisibility(next) }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { error?: string | null };
      if (json.error) throw new Error(json.error);
      setSaveState('saved');
      if (savedTimer.current) clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setSaveState('idle'), 1800);
    } catch {
      // Roll back so the UI never lies about what's persisted.
      setConfig(prev);
      setSaveState('error');
    }
  }, []);

  const setState = useCallback(
    (dash: DashboardKey, key: string, state: PageVisibility) => {
      setConfig((prev) => {
        if (pageVisibility(prev, dash, key) === state) return prev;
        const next = withPageVisibility(prev, dash, key, state);
        void persist(next, prev);
        return next;
      });
    },
    [persist],
  );

  const resetDashboard = useCallback(
    (dash: DashboardKey) => {
      setConfig((prev) => {
        if (!prev[dash]) return prev;
        const next: PagesVisibilityConfig = { ...prev };
        delete next[dash];
        void persist(next, prev);
        return next;
      });
    },
    [persist],
  );

  const q = search.trim().toLowerCase();
  const current = DASHBOARD_PAGES.find((d) => d.key === activeDash) ?? DASHBOARD_PAGES[0]!;
  // The active dashboard's pages, narrowed by the in-tab search box.
  const currentFiltered = useMemo(
    () => (!q ? current : { ...current, pages: current.pages.filter((p) => p.label.toLowerCase().includes(q)) }),
    [q, current],
  );
  // Per-dashboard count of non-default (construction/hidden) pages, for tab badges.
  const overrideCounts = useMemo(() => {
    const counts: Partial<Record<DashboardKey, number>> = {};
    for (const d of DASHBOARD_PAGES) {
      counts[d.key] = d.pages.reduce(
        (n, p) => n + (pageVisibility(config, d.key, p.key) !== 'visible' ? 1 : 0),
        0,
      );
    }
    return counts;
  }, [config]);

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col overflow-y-auto px-4 py-6 sm:px-6 lg:px-8">
      {/* Back */}
      {onBack && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onBack}
          className="mb-4 self-start text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
        >
          <ArrowLeft className="mr-1.5 h-3.5 w-3.5" />
          Back
        </Button>
      )}

      {/* Header */}
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight text-zinc-900 dark:text-white">
            <Construction className="h-5 w-5 text-amber-500" />
            Pages
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-zinc-500 dark:text-zinc-400">
            Control which sidebar pages each dashboard shows. Mark a page{' '}
            <span className="font-medium text-amber-600 dark:text-amber-400">Under construction</span> to
            replace it with a placeholder, or <span className="font-medium text-zinc-700 dark:text-zinc-200">Hidden</span>{' '}
            to remove it from the menu entirely. Changes apply to <strong>everyone</strong> on that
            dashboard, instantly.
          </p>
        </div>
        <SaveBadge state={saveState} />
      </div>

      {/* Dashboard tabs */}
      <div className="mb-5 flex items-end gap-1 overflow-x-auto border-b border-[#ececec] dark:border-zinc-800">
        {DASHBOARD_PAGES.map((d) => {
          const a = ACCENT[d.accent];
          const active = d.key === activeDash;
          const overrides = overrideCounts[d.key] ?? 0;
          return (
            <button
              key={d.key}
              type="button"
              onClick={() => setActiveDash(d.key)}
              aria-current={active}
              className={cn(
                'relative flex shrink-0 items-center gap-2 px-3.5 py-2.5 text-[13.5px] font-medium transition-colors',
                active
                  ? 'text-zinc-900 dark:text-zinc-100'
                  : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200',
              )}
            >
              <span className={cn('h-2 w-2 rounded-full', active ? a.dot : 'bg-zinc-300 dark:bg-zinc-700')} />
              {d.label}
              {overrides > 0 && (
                <span className="rounded-full bg-amber-100 px-1.5 text-[10px] font-semibold leading-[16px] text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">
                  {overrides}
                </span>
              )}
              {active && (
                <motion.span
                  layoutId="admin-pages-tab"
                  className="absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-zinc-900 dark:bg-zinc-100"
                />
              )}
            </button>
          );
        })}
      </div>

      {/* In-tab search */}
      <div className="relative mb-4 max-w-xs">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={`Filter ${current.label} pages…`}
          className="h-9 w-full rounded-md border border-[#ececec] bg-white pl-8 pr-3 text-sm text-zinc-900 outline-none transition-colors placeholder:text-zinc-400 focus:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
        />
      </div>

      {!loaded ? (
        <div className="flex flex-1 items-center justify-center py-20 text-zinc-400">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : (
        <div className="pb-10">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={activeDash}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
            >
              {currentFiltered.pages.length === 0 ? (
                <p className="py-16 text-center text-sm text-zinc-400">No pages match “{search}”.</p>
              ) : (
                <DashboardCard
                  dash={currentFiltered}
                  config={config}
                  onSet={setState}
                  onReset={resetDashboard}
                />
              )}
            </motion.div>
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}

function SaveBadge({ state }: { state: SaveState }) {
  if (state === 'idle') return null;
  const map = {
    saving: { icon: <Loader2 className="h-3.5 w-3.5 animate-spin" />, text: 'Saving…', cls: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300' },
    saved: { icon: <Check className="h-3.5 w-3.5" />, text: 'All changes saved', cls: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300' },
    error: { icon: <TriangleAlert className="h-3.5 w-3.5" />, text: 'Couldn’t save — reverted', cls: 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300' },
  } as const;
  const m = map[state];
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium', m.cls)}>
      {m.icon}
      {m.text}
    </span>
  );
}

function DashboardCard({
  dash,
  config,
  onSet,
  onReset,
}: {
  dash: DashboardPages;
  config: PagesVisibilityConfig;
  onSet: (dash: DashboardKey, key: string, state: PageVisibility) => void;
  onReset: (dash: DashboardKey) => void;
}) {
  const accent = ACCENT[dash.accent];
  const Icon = ICON_BY_DASHBOARD[dash.key] ?? accent.icon;

  const counts = useMemo(() => {
    let construction = 0;
    let hidden = 0;
    for (const p of dash.pages) {
      const v = pageVisibility(config, dash.key, p.key);
      if (v === 'construction') construction += 1;
      else if (v === 'hidden') hidden += 1;
    }
    return { construction, hidden, visible: dash.pages.length - construction - hidden };
  }, [config, dash]);

  const hasOverrides = counts.construction > 0 || counts.hidden > 0;

  return (
    <section className="overflow-hidden rounded-xl border border-[#ececec] bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
      <header className="flex items-center gap-3 border-b border-[#f1f1f1] px-4 py-3 dark:border-zinc-800/80">
        <div className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ring-1', accent.soft, accent.ring)}>
          <Icon className={cn('h-[18px] w-[18px]', accent.text)} />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{dash.label} dashboard</h2>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">
            <span className="inline-flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />{counts.visible} visible</span>
            {counts.construction > 0 && (
              <span className="inline-flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-amber-500" />{counts.construction} under construction</span>
            )}
            {counts.hidden > 0 && (
              <span className="inline-flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-zinc-800 dark:bg-zinc-300" />{counts.hidden} hidden</span>
            )}
          </p>
        </div>
        {hasOverrides && (
          <button
            type="button"
            onClick={() => onReset(dash.key)}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
          >
            <RotateCcw className="h-3 w-3" />
            Reset all
          </button>
        )}
      </header>

      <ul className="divide-y divide-[#f5f5f5] dark:divide-zinc-800/60">
        {dash.pages.map((page) => {
          const current = pageVisibility(config, dash.key, page.key);
          return (
            <li key={page.key} className="flex flex-col gap-2 px-4 py-2.5 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-sm font-medium text-zinc-800 dark:text-zinc-200">{page.label}</span>
                {page.home && (
                  <span className="shrink-0 rounded-full bg-zinc-100 px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-wide text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                    Landing
                  </span>
                )}
                {page.home && current === 'hidden' && (
                  <span className="inline-flex shrink-0 items-center gap-1 text-[10.5px] font-medium text-amber-600 dark:text-amber-400" title="Hiding the landing page sends users to the next visible page.">
                    <TriangleAlert className="h-3 w-3" />
                  </span>
                )}
              </div>
              <SegmentedControl value={current} onChange={(v) => onSet(dash.key, page.key, v)} />
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function SegmentedControl({
  value,
  onChange,
}: {
  value: PageVisibility;
  onChange: (v: PageVisibility) => void;
}) {
  return (
    <div className="inline-flex shrink-0 rounded-lg border border-[#ececec] bg-[#fafaf8] p-0.5 dark:border-zinc-800 dark:bg-zinc-900">
      {STATES.map((s) => {
        const StateIcon = s.icon;
        const active = value === s.value;
        return (
          <button
            key={s.value}
            type="button"
            onClick={() => onChange(s.value)}
            aria-pressed={active}
            title={s.label}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-all',
              active
                ? s.active
                : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200',
            )}
          >
            <StateIcon className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">{s.label}</span>
          </button>
        );
      })}
    </div>
  );
}
