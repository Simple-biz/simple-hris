'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { AlertTriangle, ArrowLeft, Check, ChevronRight, Copy as CopyIcon, Info, RefreshCw, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import {
  DATASETS,
  DATASET_DOMAINS,
  FIELD_GROUP_LABELS,
  SENSITIVITY_LABELS,
  STATUS_LABELS,
  datasetBySlug,
  type Dataset,
  type DatasetCaveat,
  type DatasetField,
  type DatasetFieldGroup,
  type DatasetStatus,
  type LiveDataset,
  type Sensitivity,
} from '@/lib/external-api/datasets';
import { clientAccess, describeAccess, type AccessClient, type AccessRow, type AccessState } from '@/lib/external-api/dataset-access';
import { describeExpiry } from '@/lib/external-api/expiry';
import { useAdminCachedState } from '@/hooks/useAdminCachedState';
import { ADMIN_CACHE_KEYS } from '@/lib/admin/tab-cache';

/**
 * Admin → Webhooks & Integrations → Data catalog.
 *
 * Kane, 2026-09-25: *"the documentation of the Data we can let people have access
 * to … the first one would be Global Master List … we should know which clients
 * have access … other Data like Bank Info … Offboarded … arrange them properly."*
 *
 * Every dataset, grouped by area, in three states: **Live** (a key can read it
 * today), **Planned** (documented, proposed fields, NO key can reach it) and
 * **Never offered** (on record as a no). The content is `datasets.ts`; the GML page's
 * fields are `catalog.ts` itself. Doc: `docs/features/integrations-data-catalog.md`.
 *
 * Rules this panel keeps:
 *  - **Access is computed, never stored.** "Clients with access" is the Integrations
 *    client list (same route, same Admin cache key `integrations:clients`) filtered
 *    by scope, on every render. The cache paints; the fetch always runs.
 *  - **A list that was not read is unknown, not zero** (`describeAccess(null)`).
 *  - **A planned page never looks reachable** — no endpoint, no copy button, and a
 *    notice saying no key can reach it.
 *  - **Names only.** No row data and no bank value ever reaches this tab.
 */

type ListResponse = {
  clients: AccessClient[];
  migration_applied: boolean;
  error?: string;
};

type StatusFilter = 'all' | DatasetStatus;

const STATUS_DOT: Record<DatasetStatus, string> = {
  live: 'bg-emerald-500',
  planned: 'border border-zinc-400 bg-transparent dark:border-zinc-500',
  never: 'bg-zinc-300 dark:bg-zinc-600',
};

const ACCESS_META: Record<AccessState, { label: string; dot: string }> = {
  live: { label: 'Live', dot: 'bg-emerald-500' },
  expired: { label: 'Expired', dot: 'bg-amber-500' },
  revoked: { label: 'Revoked', dot: 'bg-zinc-400 dark:bg-zinc-500' },
};

function sensitivityClass(s: Sensitivity): string {
  if (s === 'restricted') return 'text-rose-700 dark:text-rose-300';
  if (s === 'money' || s === 'personal') return 'text-amber-700 dark:text-amber-300';
  return 'text-zinc-600 dark:text-zinc-400';
}

async function readJson<T>(res: Response): Promise<T & { error?: string }> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T & { error?: string };
  } catch {
    return { error: text.slice(0, 200) || `HTTP ${res.status}` } as T & { error?: string };
  }
}

function relative(iso: string | null): string {
  if (!iso) return 'never';
  const t = new Date(iso).getTime();
  const ms = Date.now() - t;
  if (!Number.isFinite(ms)) return '—';
  if (ms < 0) return 'just now';
  const m = Math.floor(ms / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ─── Panel ────────────────────────────────────────────────────────────────────

export default function AdminDataCatalog({ onOpenIntegrations }: { onOpenIntegrations?: () => void }) {
  // The SAME key and the SAME whole response the Integrations panel caches, so the
  // two tabs paint each other's last read and never store different shapes.
  const [data, setData] = useAdminCachedState<ListResponse | null>(ADMIN_CACHE_KEYS.integrationsClients, null);
  const [settled, setSettled] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [openSlug, setOpenSlug] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusFilter>('all');
  const [needle, setNeedle] = useState('');

  const load = useCallback(
    async (opts?: { manual?: boolean }) => {
      if (opts?.manual) setRefreshing(true);
      try {
        const r = await fetch('/api/admin/external-api-clients', { cache: 'no-store' });
        const body = await readJson<ListResponse>(r);
        if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
        setData(body);
      } catch (e) {
        toast.error(e instanceof Error ? `Could not load who holds each dataset: ${e.message}` : 'Could not load who holds each dataset');
      } finally {
        setSettled(true);
        setRefreshing(false);
      }
    },
    [setData],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // null = not read. A table that is not applied yet genuinely has no clients.
  const clients: AccessClient[] | null = data ? (data.migration_applied ? data.clients ?? [] : []) : null;

  const accessFor = useCallback(
    (d: LiveDataset): AccessRow[] | null => (clients === null ? null : clientAccess(clients, d)),
    [clients],
  );

  const counts = useMemo(() => {
    const c: Record<StatusFilter, number> = { all: DATASETS.length, live: 0, planned: 0, never: 0 };
    for (const d of DATASETS) c[d.status] += 1;
    return c;
  }, []);

  const open = openSlug ? datasetBySlug(openSlug) : undefined;

  if (open) {
    return (
      <DatasetPage
        dataset={open}
        access={open.status === 'live' ? accessFor(open) : null}
        settled={settled}
        onBack={() => setOpenSlug(null)}
        onOpenIntegrations={onOpenIntegrations}
      />
    );
  }

  const q = needle.trim().toLowerCase();
  const matches = (d: Dataset) => {
    if (status !== 'all' && d.status !== status) return false;
    if (!q) return true;
    const hay = [d.label, d.summary, ...d.sources, ...(d.status === 'never' ? [] : d.fields.map((x) => x.name))];
    return hay.some((s) => s.toLowerCase().includes(q));
  };
  const anyMatch = DATASETS.some(matches);

  return (
    <section className="text-zinc-900 dark:text-zinc-100">
      {/* Title row */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-lg font-medium tracking-tight">Data catalog</h2>
          <p className="mt-1 max-w-[68ch] text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
            Every dataset an outside system can read, may one day read, or never will. Only a Live dataset can be reached
            with a key; which clients hold it, and which fields they see, is read from the Integrations tab.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void load({ manual: true })}
          disabled={refreshing}
          className="shrink-0 gap-1.5"
          aria-label="Refresh who holds each dataset"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} /> Refresh
        </Button>
      </div>

      {settled && !data && (
        <Notice tone="rose" announce className="mt-4">
          The client list could not be loaded, so who holds each dataset is unknown. Refresh to try again.
        </Notice>
      )}

      {/* Toolbar */}
      <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-1.5">
          {(['all', 'live', 'planned', 'never'] as StatusFilter[]).map((s) => {
            const on = status === s;
            return (
              <button
                key={s}
                type="button"
                onClick={() => setStatus(s)}
                aria-pressed={on}
                className={cn(
                  'inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors',
                  on
                    ? 'border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900'
                    : 'border-zinc-200 text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800',
                )}
              >
                {s === 'all' ? 'All' : STATUS_LABELS[s]}
                <span className={cn('tabular-nums', on ? 'text-white/70 dark:text-zinc-900/60' : 'text-zinc-400 dark:text-zinc-500')}>
                  {counts[s]}
                </span>
              </button>
            );
          })}
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
          <Input
            value={needle}
            onChange={(e) => setNeedle(e.target.value)}
            placeholder="Filter by dataset, table, field…"
            aria-label="Filter datasets"
            className="h-8 w-full pl-8 text-sm sm:w-64"
          />
        </div>
      </div>

      {!anyMatch && (
        <div className="mt-6 rounded-lg border border-zinc-200 px-6 py-10 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
          No dataset matches this filter.
        </div>
      )}

      {/* One hairline table per area */}
      {DATASET_DOMAINS.map((dom) => {
        const rows = DATASETS.filter((d) => d.domain === dom.id && matches(d));
        if (rows.length === 0) return null;
        return (
          <div key={dom.id} className="mt-6">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
              <h3 className="text-sm font-medium">{dom.label}</h3>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">{dom.blurb}</p>
            </div>
            <div className="mt-2 overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
              <ul className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
                {rows.map((d) => (
                  <li key={d.slug}>
                    <button
                      type="button"
                      onClick={() => setOpenSlug(d.slug)}
                      className="group flex w-full items-center gap-4 px-4 py-3 text-left transition-colors hover:bg-zinc-50/80 focus-visible:bg-zinc-50 focus-visible:outline-none dark:hover:bg-zinc-900/60 dark:focus-visible:bg-zinc-900"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                          <span className="font-medium">{d.label}</span>
                          <StatusWord status={d.status} />
                        </div>
                        <p className="mt-0.5 truncate text-xs text-zinc-500 dark:text-zinc-400">{d.summary}</p>
                      </div>
                      <span className={cn('hidden w-20 shrink-0 text-xs md:block', sensitivityClass(d.sensitivity))}>
                        {SENSITIVITY_LABELS[d.sensitivity]}
                      </span>
                      <span className="hidden w-56 shrink-0 text-right text-xs sm:block">
                        <AccessLine dataset={d} access={d.status === 'live' ? accessFor(d) : null} settled={settled} />
                      </span>
                      <ChevronRight className="h-4 w-4 shrink-0 text-zinc-300 transition-colors group-hover:text-zinc-500 dark:text-zinc-600" />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        );
      })}
    </section>
  );
}

function AccessLine({ dataset, access, settled }: { dataset: Dataset; access: AccessRow[] | null; settled: boolean }) {
  if (dataset.status === 'planned') return <span className="text-zinc-500 dark:text-zinc-400">No key can reach this</span>;
  if (dataset.status === 'never') return <span className="text-zinc-400 dark:text-zinc-500">—</span>;
  if (access === null && !settled) {
    return <span className="inline-block h-3 w-28 animate-pulse rounded bg-zinc-100 align-middle dark:bg-zinc-800" aria-label="Loading" />;
  }
  const a = describeAccess(access);
  return (
    <span
      className={cn(
        a.tone === 'some' && 'text-zinc-800 dark:text-zinc-200',
        a.tone === 'none' && 'text-zinc-500 dark:text-zinc-400',
        a.tone === 'unknown' && 'text-rose-700 dark:text-rose-300',
      )}
    >
      {a.text}
    </span>
  );
}

function StatusWord({ status }: { status: DatasetStatus }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-400">
      <span className={cn('h-2 w-2 rounded-full', STATUS_DOT[status])} aria-hidden />
      {STATUS_LABELS[status]}
    </span>
  );
}

// ─── One dataset ──────────────────────────────────────────────────────────────

function DatasetPage({
  dataset: d,
  access,
  settled,
  onBack,
  onOpenIntegrations,
}: {
  dataset: Dataset;
  access: AccessRow[] | null;
  settled: boolean;
  onBack: () => void;
  onOpenIntegrations?: () => void;
}) {
  const domain = DATASET_DOMAINS.find((x) => x.id === d.domain);
  const origin = typeof window !== 'undefined' ? window.location.origin : '';

  return (
    <section className="text-zinc-900 dark:text-zinc-100">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-1.5 rounded text-sm text-zinc-600 transition-colors hover:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:text-zinc-400 dark:hover:text-zinc-100"
      >
        <ArrowLeft className="h-4 w-4" /> Data catalog
      </button>

      <div className="mt-4">
        <p className="text-xs text-zinc-500 dark:text-zinc-400">{domain?.label}</p>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1">
          <h2 className="text-lg font-medium tracking-tight">{d.label}</h2>
          <StatusWord status={d.status} />
          <span className={cn('text-xs', sensitivityClass(d.sensitivity))}>{SENSITIVITY_LABELS[d.sensitivity]}</span>
        </div>
        <p className="mt-1 max-w-[68ch] text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">{d.summary}</p>
      </div>

      {d.status === 'planned' && (
        <Notice tone="neutral" className="mt-4">
          Planned. No key can reach this yet. The fields below are a proposal; the final list is decided when the dataset is
          built, with its own scope and route.
          {d.tracking ? <> Tracked in {d.tracking}.</> : null}
        </Notice>
      )}
      {d.status === 'never' && (
        <Notice tone="neutral" className="mt-4">
          Never offered. {d.reason}
        </Notice>
      )}

      {/* How it is read — live only */}
      {d.status === 'live' && (
        <dl className="mt-5 divide-y divide-zinc-200 border-y border-zinc-200 text-sm dark:divide-zinc-800 dark:border-zinc-800">
          <CopyRow label="REST" method="GET" value={`${origin}${d.restPath}`} />
          <CopyRow label="MCP" method="POST" value={`${origin}/api/external/mcp`} note={`tool: ${d.mcpTool}`} />
          <FactRow label="Scope" value={<code className="font-mono text-[12.5px]">{d.scope}</code>} />
          <FactRow label="Filters" value={<span className="font-mono text-[12.5px]">{d.filters.map((x) => `?${x}`).join(' · ')}</span>} />
          <FactRow label="Paging" value={d.paging} />
        </dl>
      )}

      {/* Facts */}
      <dl className="mt-5 grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
        {d.status !== 'never' && <Fact label="One row is" value={d.grain} />}
        {d.status !== 'never' && <Fact label="Leavers" value={d.leavers} />}
        <Fact
          label="Comes from"
          value={
            <ul className="space-y-0.5">
              {d.sources.map((s) => (
                <li key={s} className="font-mono text-[12.5px] text-zinc-700 dark:text-zinc-300">
                  {s}
                </li>
              ))}
            </ul>
          }
        />
      </dl>

      {d.caveats.length > 0 && (
        <div className="mt-5 space-y-2">
          {d.caveats.map((c) => (
            <CaveatNotice key={c.text} caveat={c} />
          ))}
        </div>
      )}

      {/* Who holds it — live only */}
      {d.status === 'live' && (
        <ClientsBlock dataset={d} access={access} settled={settled} onOpenIntegrations={onOpenIntegrations} />
      )}

      {/* Fields */}
      {d.status !== 'never' && (
        <FieldsBlock
          fields={d.fields}
          always={d.status === 'live' ? d.always : []}
          neverServed={d.neverServed}
          proposed={d.status === 'planned'}
        />
      )}
    </section>
  );
}

function ClientsBlock({
  dataset,
  access,
  settled,
  onOpenIntegrations,
}: {
  dataset: LiveDataset;
  access: AccessRow[] | null;
  settled: boolean;
  onOpenIntegrations?: () => void;
}) {
  const total = dataset.fields.length;
  return (
    <div className="mt-7">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-medium">Clients with access</h3>
        {onOpenIntegrations && (
          <button
            type="button"
            onClick={onOpenIntegrations}
            className="rounded text-xs text-zinc-600 underline-offset-2 hover:text-zinc-900 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:text-zinc-400 dark:hover:text-zinc-100"
          >
            Manage keys on Integrations
          </button>
        )}
      </div>
      <div className="mt-2 overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-left text-xs font-medium text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">
                <th className="px-3 py-2.5 font-medium">Client</th>
                <th className="px-3 py-2.5 font-medium">Key</th>
                <th className="px-3 py-2.5 font-medium">Status</th>
                <th className="px-3 py-2.5 font-medium">Fields</th>
                <th className="px-3 py-2.5 font-medium">Expires</th>
                <th className="px-3 py-2.5 text-right font-medium">7-day calls</th>
                <th className="px-3 py-2.5 font-medium">Last used</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
              {access === null && !settled &&
                Array.from({ length: 2 }).map((_, i) => (
                  <tr key={`sk-${i}`} aria-hidden>
                    {Array.from({ length: 7 }).map((__, j) => (
                      <td key={j} className="px-3 py-3.5">
                        <div className={cn('h-3 animate-pulse rounded bg-zinc-100 dark:bg-zinc-800', j === 0 ? 'w-32' : 'w-14')} />
                      </td>
                    ))}
                  </tr>
                ))}
              {access === null && settled && (
                <tr>
                  <td colSpan={7} className="px-6 py-8 text-center text-sm text-rose-700 dark:text-rose-300">
                    The client list could not be loaded, so who holds this dataset is unknown.
                  </td>
                </tr>
              )}
              {access !== null && access.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-6 py-8 text-center text-sm text-zinc-500 dark:text-zinc-400">
                    No client holds this dataset. Keys are issued on the Integrations tab.
                  </td>
                </tr>
              )}
              {access?.map(({ client: c, state, fields }) => {
                const meta = ACCESS_META[state];
                return (
                  <tr key={c.id} className={cn(state !== 'live' && 'text-zinc-500 dark:text-zinc-400')}>
                    <td className="px-3 py-3 align-top">
                      <div className="font-medium">{c.name}</div>
                      <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                        {c.system}
                        {c.contact_email ? ` · ${c.contact_email}` : ''}
                      </div>
                    </td>
                    <td className="px-3 py-3 align-top">
                      <code className="font-mono text-xs">{c.key_prefix}…</code>
                    </td>
                    <td className="px-3 py-3 align-top">
                      <span className="inline-flex items-center gap-2">
                        <span className={cn('h-2 w-2 rounded-full', meta.dot)} aria-hidden />
                        {meta.label}
                      </span>
                    </td>
                    <td
                      className="px-3 py-3 align-top"
                      title={fields.kind === 'partial' ? `Hidden: ${fields.hidden.join(', ')}` : undefined}
                    >
                      {fields.kind === 'whole' && 'Whole table'}
                      {fields.kind === 'unknown' && <span className="text-zinc-500 dark:text-zinc-400">Not recorded</span>}
                      {fields.kind === 'partial' && (
                        <>
                          {fields.visible.length} of {total}
                          <span className="text-zinc-500 dark:text-zinc-400"> · {fields.hidden.length} hidden</span>
                        </>
                      )}
                    </td>
                    <td className="px-3 py-3 align-top" title={c.expires_at ?? 'Does not expire'}>
                      {describeExpiry(c.expires_at)}
                    </td>
                    <td className="px-3 py-3 text-right align-top tabular-nums">{c.calls_7d}</td>
                    <td className="px-3 py-3 align-top">{relative(c.last_used_at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function FieldsBlock({
  fields,
  always,
  neverServed,
  proposed,
}: {
  fields: readonly DatasetField[];
  always: readonly string[];
  neverServed: readonly string[];
  proposed: boolean;
}) {
  const groups = useMemo(() => {
    const order: DatasetFieldGroup[] = [];
    const by = new Map<DatasetFieldGroup, DatasetField[]>();
    for (const f of fields) {
      if (!by.has(f.group)) {
        by.set(f.group, []);
        order.push(f.group);
      }
      by.get(f.group)!.push(f);
    }
    return order.map((g) => ({ group: g, fields: by.get(g)! }));
  }, [fields]);

  return (
    <div className="mt-7">
      <div className="flex items-baseline gap-3">
        <h3 className="text-sm font-medium">{proposed ? 'Proposed fields' : 'Fields a key can be granted'}</h3>
        <span className="text-xs text-zinc-500 dark:text-zinc-400">{fields.length}</span>
      </div>
      <div className="mt-2 overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <table className="w-full text-sm">
          <tbody>
            {groups.map(({ group, fields: gf }) => (
              <FieldGroupRows key={group} label={FIELD_GROUP_LABELS[group]} fields={gf} />
            ))}
          </tbody>
        </table>
      </div>

      {(always.length > 0 || neverServed.length > 0) && (
        <dl className="mt-4 grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
          {always.length > 0 && (
            <Fact
              label="Always sent"
              value={
                <span className="font-mono text-[12.5px] text-zinc-700 dark:text-zinc-300">
                  {always.join(' · ')} <span className="font-sans text-xs text-zinc-500 dark:text-zinc-400">(the page cursor)</span>
                </span>
              }
            />
          )}
          {neverServed.length > 0 && (
            <Fact
              label="Never leaves the HRIS"
              value={
                <ul className="flex flex-wrap gap-x-3 gap-y-0.5">
                  {neverServed.map((n) => (
                    <li key={n} className="font-mono text-[12.5px] text-zinc-700 dark:text-zinc-300">
                      {n}
                    </li>
                  ))}
                </ul>
              }
            />
          )}
        </dl>
      )}
    </div>
  );
}

function FieldGroupRows({ label, fields }: { label: string; fields: DatasetField[] }) {
  return (
    <>
      <tr className="border-b border-zinc-100 bg-zinc-50/70 dark:border-zinc-800/70 dark:bg-zinc-900/40">
        <th colSpan={3} scope="colgroup" className="px-3 py-1.5 text-left text-[11px] font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          {label}
        </th>
      </tr>
      {fields.map((f) => (
        <tr key={f.name} className="border-b border-zinc-100 last:border-b-0 dark:border-zinc-800/70">
          <td className="w-56 px-3 py-2 align-top">
            <code className="font-mono text-[12.5px]">{f.name}</code>
          </td>
          <td className="px-3 py-2 align-top text-zinc-600 dark:text-zinc-400">{f.description}</td>
          <td className="w-24 px-3 py-2 text-right align-top">
            {f.sensitive && <span className="text-[11px] text-amber-700 dark:text-amber-400">sensitive</span>}
          </td>
        </tr>
      ))}
    </>
  );
}

// ─── Small pieces ─────────────────────────────────────────────────────────────

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-zinc-500 dark:text-zinc-400">{label}</dt>
      <dd className="mt-0.5 text-zinc-800 dark:text-zinc-200">{value}</dd>
    </div>
  );
}

function FactRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 py-2.5 sm:flex-row sm:items-center">
      <dt className="w-16 shrink-0 text-xs font-medium text-zinc-500 dark:text-zinc-400">{label}</dt>
      <dd className="min-w-0 text-zinc-700 dark:text-zinc-300">{value}</dd>
    </div>
  );
}

function CopyRow({ label, method, value, note }: { label: string; method: string; value: string; note?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Clipboard blocked — select and copy by hand');
    }
  };
  return (
    <div className="flex flex-col gap-1 py-2.5 sm:flex-row sm:items-center">
      <dt className="w-16 shrink-0 text-xs font-medium text-zinc-500 dark:text-zinc-400">{label}</dt>
      <dd className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
        <span className="inline-flex min-w-0 items-center gap-2">
          <span className="rounded border border-zinc-200 px-1.5 font-mono text-[10.5px] font-medium leading-5 text-zinc-600 dark:border-zinc-700 dark:text-zinc-300">
            {method}
          </span>
          <code className="truncate font-mono text-[12.5px] text-zinc-800 dark:text-zinc-200">{value}</code>
          <button
            type="button"
            onClick={() => void copy()}
            aria-label={`Copy the ${label} URL`}
            className="rounded p-1 text-zinc-400 transition-colors hover:text-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:hover:text-zinc-200"
          >
            {copied ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <CopyIcon className="h-3.5 w-3.5" />}
          </button>
        </span>
        {note && <span className="text-xs text-zinc-500 dark:text-zinc-400">{note}</span>}
      </dd>
    </div>
  );
}

function CaveatNotice({ caveat: c }: { caveat: DatasetCaveat }) {
  return (
    <Notice tone={c.kind === 'open' ? 'amber' : 'neutral'}>
      {c.kind === 'open' && <span className="font-medium">Open · </span>}
      {c.text}
      {c.ref && <span className="mt-0.5 block text-xs opacity-75">{c.ref}</span>}
    </Notice>
  );
}

/** `announce` makes it a live region — for a load failure, never for a static caveat. */
function Notice({
  tone,
  announce,
  className,
  children,
}: {
  tone: 'amber' | 'rose' | 'neutral';
  announce?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const cls =
    tone === 'amber'
      ? 'border-amber-300/70 bg-amber-50 text-amber-900 dark:border-amber-800/50 dark:bg-amber-950/30 dark:text-amber-200'
      : tone === 'rose'
        ? 'border-rose-300/70 bg-rose-50 text-rose-900 dark:border-rose-800/50 dark:bg-rose-950/30 dark:text-rose-200'
        : 'border-zinc-200 bg-zinc-50 text-zinc-800 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-200';
  const Icon = tone === 'neutral' ? Info : AlertTriangle;
  return (
    <div role={announce ? 'status' : undefined} className={cn('flex items-start gap-2 rounded-md border px-3 py-2.5 text-sm', cls, className)}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div className="min-w-0 [&_code]:text-xs">{children}</div>
    </div>
  );
}
