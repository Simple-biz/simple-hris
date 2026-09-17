'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  Loader2,
  Plus,
  Copy as CopyIcon,
  Check,
  Ban,
  RotateCcw,
  RefreshCw,
  ListOrdered,
  Pencil,
  Search,
  Info,
  AlertTriangle,
  ChevronRight,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { GML_CATALOG, GML_TABLE_LABEL, GROUP_LABELS, OFFERABLE_COLUMNS, SENSITIVE_COLUMNS, type CatalogGroup } from '@/lib/external-api/catalog';
import { hiddenCount, normalizeGrant, visibleColumns, type Grant } from '@/lib/external-api/grants';
import { EXPIRY_LABELS, EXPIRY_OPTIONS, describeExpiry, isExpired, type ExpiryOption } from '@/lib/external-api/expiry';
import { RATE_LIMIT_CEILING, RATE_LIMIT_DEFAULT, RATE_LIMIT_FLOOR, parseRateLimit } from '@/lib/external-api/rate-limit';
import { useAdminCachedState } from '@/hooks/useAdminCachedState';
import { ADMIN_CACHE_KEYS } from '@/lib/admin/tab-cache';

/**
 * Admin → Webhooks & Integrations → Integrations.
 *
 * The registry of OUTSIDE systems allowed to read the Global Master List — by
 * plain HTTP query or by MCP, with the same key — and the log of what they did.
 *
 * Kane, 2026-09-17: *"they only need Global Master List — I can give them the
 * whole table or hide some of those columns to protect data … give them the
 * payload and the key … set time on how long that key can survive … we should
 * have rate limiting practices on this … the option to revoke the key"*, then
 * *"simple and beautiful … like Google Console … cache practices … where it
 * doesn't go away after switching tabs or reload."*
 *
 * Shape (Operate mode, Console-plain): one title row with the primary action,
 * an endpoints strip, a filter toolbar, ONE flat table on a hairline surface,
 * dialogs only where the task needs protected focus (issue, edit, hand-off).
 * Status is a dot and a word, never a filled pill; the accent is the app's
 * orange on the single primary action and nothing else.
 *
 * Rules this panel enforces in the UI (the routes enforce them again):
 *  - The key is shown ONCE, in the hand-off dialog. The table shows a prefix.
 *  - Columns default to the WHOLE table; the admin hides by unticking. Sensitive
 *    (personal contact / address / photo) columns are marked so they stand out.
 *  - Expiry is 1 day · 15 days · 30 days · does not expire. Revoke is always there.
 *  - The rate limit is per client, REST + MCP together; the number shown IS the
 *    number enforced.
 *  - Revoke is instant and reversible (Restore). Rotate keeps the client and its
 *    history. Nothing here deletes a client.
 *  - Every change (columns, expiry, limit) takes effect on the client's NEXT call.
 *
 * Cache: the list response is held in the Admin tab cache
 * (`ADMIN_CACHE_KEYS.integrationsClients`) so a tab switch or reload paints the
 * last list instantly; the fetch still runs on every mount and overwrites it.
 * A cached value PAINTS, never DECIDES — nothing here skips the fetch, and the
 * skeleton shows only when there is nothing to paint.
 */

type ClientView = {
  id: string;
  name: string;
  system: string;
  contact_email: string | null;
  key_prefix: string;
  scopes: string[];
  granted_columns: string[] | null;
  expires_at: string | null;
  rate_limit_per_minute: number;
  created_by: string;
  created_at: string;
  revoked_at: string | null;
  revoked_by: string | null;
  rotated_at: string | null;
  rotated_by: string | null;
  last_used_at: string | null;
  calls_7d: number;
  denied_7d: number;
  throttled_7d: number;
};

type RequestRow = {
  id: number;
  client_id: string | null;
  key_prefix: string | null;
  method: string;
  path: string;
  query: Record<string, unknown> | null;
  status: number;
  row_count: number | null;
  denial: string | null;
  ip: string | null;
  user_agent: string | null;
  duration_ms: number | null;
  created_at: string;
};

type ListResponse = {
  clients: ClientView[];
  unattributed: RequestRow[];
  unattributed_7d?: number;
  configured: boolean;
  migration_applied: boolean;
  rest_path?: string;
  mcp_path?: string;
  error?: string;
};

const REST_PATH_FALLBACK = '/api/external/v1/global-master-list';
const MCP_PATH_FALLBACK = '/api/external/mcp';
const DEFAULT_EXPIRY: ExpiryOption = '30d';

function fmtWhen(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function relative(iso: string | null | number): string {
  if (iso == null) return 'never';
  const t = typeof iso === 'number' ? iso : new Date(iso).getTime();
  const ms = Date.now() - t;
  if (!Number.isFinite(ms) || ms < 0) return typeof iso === 'string' ? fmtWhen(iso) : 'just now';
  const m = Math.floor(ms / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

async function readJson<T>(res: Response): Promise<T & { error?: string }> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T & { error?: string };
  } catch {
    return { error: text.slice(0, 200) || `HTTP ${res.status}` } as T & { error?: string };
  }
}

function grantToTicked(grant: Grant): string[] {
  return grant === null ? [...OFFERABLE_COLUMNS] : OFFERABLE_COLUMNS.filter((c) => grant.includes(c));
}
function tickedToGrantBody(ticked: string[]): string[] | null {
  const n = normalizeGrant(ticked);
  return n.ok ? n.grant : ticked;
}

type ClientState = 'live' | 'revoked' | 'expired';
function stateOf(c: ClientView): ClientState {
  if (c.revoked_at) return 'revoked';
  if (isExpired(c.expires_at)) return 'expired';
  return 'live';
}

const STATE_META: Record<ClientState, { label: string; dot: string }> = {
  live: { label: 'Live', dot: 'bg-emerald-500' },
  revoked: { label: 'Revoked', dot: 'bg-zinc-400 dark:bg-zinc-500' },
  expired: { label: 'Expired', dot: 'bg-amber-500' },
};

type Filter = 'all' | ClientState;

// ─── Panel ────────────────────────────────────────────────────────────────────

export default function AdminExternalApiClients() {
  const [data, setData] = useAdminCachedState<ListResponse | null>(ADMIN_CACHE_KEYS.integrationsClients, null);
  const [settled, setSettled] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [needle, setNeedle] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<ClientView | null>(null);
  const [issued, setIssued] = useState<{ client: ClientView; apiKey: string; mode: 'created' | 'rotated' } | null>(null);
  const [callsFor, setCallsFor] = useState<ClientView | null>(null);
  const [confirmRotate, setConfirmRotate] = useState<ClientView | null>(null);

  const load = useCallback(
    async (opts?: { manual?: boolean }) => {
      if (opts?.manual) setRefreshing(true);
      try {
        const r = await fetch('/api/admin/external-api-clients', { cache: 'no-store' });
        const body = await readJson<ListResponse>(r);
        if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
        setData(body);
        setUpdatedAt(Date.now());
      } catch (e) {
        toast.error(e instanceof Error ? `Could not refresh external clients: ${e.message}` : 'Could not refresh external clients');
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

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const restUrl = `${origin}${data?.rest_path ?? REST_PATH_FALLBACK}`;
  const mcpUrl = `${origin}${data?.mcp_path ?? MCP_PATH_FALLBACK}`;

  const act = async (client: ClientView, action: 'revoke' | 'restore' | 'rotate') => {
    setBusyId(client.id);
    try {
      const r = await fetch(`/api/admin/external-api-clients/${client.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const body = await readJson<{ client: ClientView; api_key?: string }>(r);
      if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
      if (action === 'revoke') toast.success(`Revoked — ${client.name}'s key stops working on its next call`);
      if (action === 'restore') toast.success(`Restored — ${client.name}'s existing key works again`);
      if (action === 'rotate' && body.api_key) {
        setIssued({ client: { ...client, ...body.client }, apiKey: body.api_key, mode: 'rotated' });
      }
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Action failed');
    } finally {
      setBusyId(null);
      setConfirmRotate(null);
    }
  };

  const clients = data?.clients ?? [];
  const counts = useMemo(() => {
    const c = { all: clients.length, live: 0, revoked: 0, expired: 0 };
    for (const x of clients) c[stateOf(x)] += 1;
    return c;
  }, [clients]);
  const visible = useMemo(() => {
    const q = needle.trim().toLowerCase();
    return clients.filter((c) => {
      if (filter !== 'all' && stateOf(c) !== filter) return false;
      if (!q) return true;
      return [c.name, c.system, c.contact_email ?? '', c.key_prefix].some((s) => s.toLowerCase().includes(q));
    });
  }, [clients, filter, needle]);

  const ready = !!data?.migration_applied && !!data?.configured;
  const showSkeleton = !settled && !data;

  return (
    <section className="text-zinc-900 dark:text-zinc-100">
      {/* Title row */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-lg font-medium tracking-tight">External access</h2>
          <p className="mt-1 max-w-[68ch] text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
            One key per outside system that reads the {GML_TABLE_LABEL}. Choose the columns it may see, how long the key
            lives and how often it may call. It works over HTTP and MCP with the same key, and stops on its next call the
            moment you revoke it.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void load({ manual: true })}
            disabled={refreshing}
            className="gap-1.5"
            aria-label="Refresh the client list"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} /> Refresh
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => setCreateOpen(true)}
            disabled={!ready}
            className="gap-1.5 bg-orange-600 text-white hover:bg-orange-700"
          >
            <Plus className="h-4 w-4" /> New client
          </Button>
        </div>
      </div>

      {/* Endpoints strip */}
      <dl className="mt-5 divide-y divide-zinc-200 border-y border-zinc-200 text-sm dark:divide-zinc-800 dark:border-zinc-800">
        <EndpointRow label="REST" method="GET" url={restUrl} note="?department · ?email · ?search · ?limit ≤ 500 · ?cursor" />
        <EndpointRow label="MCP" method="POST" url={mcpUrl} note="tools: describe_access · query_global_master_list" />
        <div className="flex flex-col gap-1 py-2.5 sm:flex-row sm:items-center">
          <dt className="w-16 shrink-0 text-xs font-medium text-zinc-500 dark:text-zinc-400">Auth</dt>
          <dd className="min-w-0 font-mono text-[12.5px] text-zinc-700 dark:text-zinc-300">Authorization: Bearer hris_live_…</dd>
        </div>
      </dl>

      {/* Readiness notices */}
      {settled && data && !data.migration_applied && (
        <Notice tone="amber" className="mt-4">
          The <code className="font-mono">external_api_clients</code> table has not been applied yet. Run{' '}
          <code className="font-mono">scripts/Apply External API clients migration.cmd</code>, then Refresh.
        </Notice>
      )}
      {settled && data && data.migration_applied && !data.configured && (
        <Notice tone="amber" className="mt-4">
          No key pepper is configured on this deployment (set <code className="font-mono">EXTERNAL_API_KEY_PEPPER</code> or{' '}
          <code className="font-mono">NEXTAUTH_SECRET</code>). Keys cannot be issued or verified until it is.
        </Notice>
      )}
      {settled && !data && (
        <Notice tone="rose" className="mt-4">
          The client list could not be loaded. Refresh to try again.
        </Notice>
      )}

      {/* Toolbar */}
      <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-1.5">
          {(['all', 'live', 'revoked', 'expired'] as Filter[]).map((f) => {
            const on = filter === f;
            const n = counts[f];
            return (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                aria-pressed={on}
                className={cn(
                  'inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors',
                  on
                    ? 'border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900'
                    : 'border-zinc-200 text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800',
                )}
              >
                {f === 'all' ? 'All' : STATE_META[f].label}
                <span className={cn('tabular-nums', on ? 'text-white/70 dark:text-zinc-900/60' : 'text-zinc-400 dark:text-zinc-500')}>{n}</span>
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
            <Input
              value={needle}
              onChange={(e) => setNeedle(e.target.value)}
              placeholder="Filter by name, system, key…"
              aria-label="Filter clients"
              className="h-8 w-64 pl-8 text-sm"
            />
          </div>
          {updatedAt && (
            <span className="hidden whitespace-nowrap text-xs text-zinc-500 sm:inline dark:text-zinc-400" title={new Date(updatedAt).toLocaleString()}>
              Updated {relative(updatedAt)}
            </span>
          )}
        </div>
      </div>

      {/* The table */}
      <div className="mt-3 overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-left text-xs font-medium text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">
                <Th>Client</Th>
                <Th>Key</Th>
                <Th>Status</Th>
                <Th>Columns</Th>
                <Th>Expires</Th>
                <Th align="right">Limit</Th>
                <Th align="right">7-day calls</Th>
                <Th>Last used</Th>
                <Th align="right">
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
              {showSkeleton &&
                Array.from({ length: 3 }).map((_, i) => (
                  <tr key={`sk-${i}`} aria-hidden>
                    {Array.from({ length: 9 }).map((__, j) => (
                      <td key={j} className="px-3 py-3.5">
                        <div className={cn('h-3 animate-pulse rounded bg-zinc-100 dark:bg-zinc-800', j === 0 ? 'w-36' : 'w-16')} />
                      </td>
                    ))}
                  </tr>
                ))}

              {!showSkeleton && clients.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-6 py-14 text-center">
                    <p className="text-sm font-medium">No external clients yet</p>
                    <p className="mx-auto mt-1 max-w-[46ch] text-sm text-zinc-500 dark:text-zinc-400">
                      Create one per system that needs the {GML_TABLE_LABEL}. You choose its columns, its lifetime and its
                      limit; the key is shown once.
                    </p>
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => setCreateOpen(true)}
                      disabled={!ready}
                      className="mt-4 gap-1.5 bg-orange-600 text-white hover:bg-orange-700"
                    >
                      <Plus className="h-4 w-4" /> New client
                    </Button>
                  </td>
                </tr>
              )}

              {!showSkeleton && clients.length > 0 && visible.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-6 py-10 text-center text-sm text-zinc-500 dark:text-zinc-400">
                    No clients match this filter.
                  </td>
                </tr>
              )}

              {visible.map((c) => {
                const state = stateOf(c);
                const meta = STATE_META[state];
                const busy = busyId === c.id;
                const hidden = hiddenCount(c.granted_columns);
                const hiddenNames = OFFERABLE_COLUMNS.filter((col) => c.granted_columns !== null && !c.granted_columns.includes(col));
                return (
                  <tr key={c.id} className="group transition-colors hover:bg-zinc-50/80 dark:hover:bg-zinc-900/60">
                    <td className="px-3 py-3 align-top">
                      <div className="font-medium">{c.name}</div>
                      <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                        {c.system}
                        {c.contact_email ? ` · ${c.contact_email}` : ''}
                      </div>
                    </td>
                    <td className="px-3 py-3 align-top">
                      <code className="font-mono text-xs text-zinc-700 dark:text-zinc-300">{c.key_prefix}…</code>
                      {c.rotated_at && <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">rotated {relative(c.rotated_at)}</div>}
                    </td>
                    <td className="px-3 py-3 align-top">
                      <span className="inline-flex items-center gap-2">
                        <span className={cn('h-2 w-2 rounded-full', meta.dot)} aria-hidden />
                        {meta.label}
                      </span>
                    </td>
                    <td className="px-3 py-3 align-top" title={hidden > 0 ? `Hidden: ${hiddenNames.join(', ')}` : undefined}>
                      {hidden === 0 ? (
                        'Whole table'
                      ) : (
                        <>
                          {OFFERABLE_COLUMNS.length - hidden} of {OFFERABLE_COLUMNS.length}
                          <span className="text-zinc-500 dark:text-zinc-400"> · {hidden} hidden</span>
                        </>
                      )}
                    </td>
                    <td className="px-3 py-3 align-top" title={c.expires_at ?? 'Does not expire'}>
                      {describeExpiry(c.expires_at)}
                    </td>
                    <td className="px-3 py-3 text-right align-top tabular-nums">{c.rate_limit_per_minute}/min</td>
                    <td className="px-3 py-3 text-right align-top tabular-nums">
                      {c.calls_7d}
                      {(c.denied_7d > 0 || c.throttled_7d > 0) && (
                        <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                          {c.denied_7d > 0 && <span className="text-rose-600 dark:text-rose-400">{c.denied_7d} denied</span>}
                          {c.denied_7d > 0 && c.throttled_7d > 0 && ' · '}
                          {c.throttled_7d > 0 && <span className="text-amber-600 dark:text-amber-400">{c.throttled_7d} throttled</span>}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-3 align-top text-zinc-600 dark:text-zinc-400" title={c.last_used_at ?? ''}>
                      {relative(c.last_used_at)}
                    </td>
                    <td className="px-2 py-2 align-top">
                      <div className="flex justify-end gap-0.5 opacity-70 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                        <RowBtn label="Calls" onClick={() => setCallsFor(c)} disabled={busy}>
                          <ListOrdered className="h-4 w-4" />
                        </RowBtn>
                        <RowBtn label="Edit" onClick={() => setEditing(c)} disabled={busy}>
                          <Pencil className="h-4 w-4" />
                        </RowBtn>
                        <RowBtn label="Rotate key" onClick={() => setConfirmRotate(c)} disabled={busy}>
                          <RefreshCw className="h-4 w-4" />
                        </RowBtn>
                        {state === 'revoked' ? (
                          <RowBtn label="Restore" onClick={() => void act(c, 'restore')} disabled={busy}>
                            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
                          </RowBtn>
                        ) : (
                          <RowBtn label="Revoke" tone="danger" onClick={() => void act(c, 'revoke')} disabled={busy}>
                            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Ban className="h-4 w-4" />}
                          </RowBtn>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {data?.migration_applied && (data.unattributed?.length ?? 0) > 0 && (
        <Notice tone="rose" className="mt-4">
          <span className="font-medium">{data.unattributed_7d ?? data.unattributed.length}</span> call
          {(data.unattributed_7d ?? data.unattributed.length) === 1 ? '' : 's'} in the last 7 days presented a key that matches no
          client. Latest:{' '}
          {data.unattributed.slice(0, 3).map((r, i) => (
            <span key={r.id}>
              {i > 0 && ', '}
              <code className="font-mono">{r.key_prefix ?? r.denial}</code> from {r.ip ?? '?'} {relative(r.created_at)}
            </span>
          ))}
          . A revoked key being retried is normal; an unknown prefix is someone guessing.
        </Notice>
      )}

      <p className="mt-4 flex items-start gap-2 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        <span>
          Keys are stored only as a salted hash, so a key cannot be shown again after it is issued. Off-boarded people are never
          returned. A hidden column is neither returned nor filterable. Every call, allowed or denied, is logged with its IP and
          user-agent, and the rate limit is counted from that log so it holds on every server.
        </span>
      </p>

      <CreateClientDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(client, apiKey) => {
          setCreateOpen(false);
          setIssued({ client, apiKey, mode: 'created' });
          void load();
        }}
      />

      <EditClientDialog
        client={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          void load();
        }}
      />

      <HandOffDialog issued={issued} onClose={() => setIssued(null)} restUrl={restUrl} mcpUrl={mcpUrl} />

      <CallsDialog client={callsFor} onClose={() => setCallsFor(null)} />

      <Dialog open={!!confirmRotate} onOpenChange={(o) => !o && setConfirmRotate(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Rotate {confirmRotate?.name}&apos;s key?</DialogTitle>
            <DialogDescription>
              A new key is issued and shown once. The current key (<code className="font-mono text-xs">{confirmRotate?.key_prefix}…</code>)
              stops working immediately. The client, its columns, expiry, limit and history stay.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirmRotate(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              className="gap-1.5 bg-orange-600 text-white hover:bg-orange-700"
              disabled={!!busyId}
              onClick={() => confirmRotate && void act(confirmRotate, 'rotate')}
            >
              {busyId ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Rotate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

// ─── Small parts ──────────────────────────────────────────────────────────────

function Th({ children, align }: { children: React.ReactNode; align?: 'right' }) {
  return <th className={cn('px-3 py-2.5 font-medium', align === 'right' && 'text-right')}>{children}</th>;
}

function EndpointRow({ label, method, url, note }: { label: string; method: string; url: string; note: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
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
          <code className="truncate font-mono text-[12.5px] text-zinc-800 dark:text-zinc-200">{url}</code>
          <button
            type="button"
            onClick={() => void copy()}
            aria-label={`Copy ${label} URL`}
            className="rounded p-1 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <CopyIcon className="h-3.5 w-3.5" />}
          </button>
        </span>
        <span className="text-xs text-zinc-500 dark:text-zinc-400">{note}</span>
      </dd>
    </div>
  );
}

function Notice({ tone, className, children }: { tone: 'amber' | 'rose'; className?: string; children: React.ReactNode }) {
  const cls =
    tone === 'amber'
      ? 'border-amber-300/70 bg-amber-50 text-amber-900 dark:border-amber-800/50 dark:bg-amber-950/30 dark:text-amber-200'
      : 'border-rose-300/70 bg-rose-50 text-rose-900 dark:border-rose-800/50 dark:bg-rose-950/30 dark:text-rose-200';
  return (
    <div role="status" className={cn('flex items-start gap-2 rounded-md border px-3 py-2.5 text-sm', cls, className)}>
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <p className="min-w-0 [&_code]:text-xs">{children}</p>
    </div>
  );
}

function RowBtn({
  label,
  tone,
  onClick,
  disabled,
  children,
}: {
  label: string;
  tone?: 'danger';
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'inline-flex h-8 w-8 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 disabled:opacity-40',
        tone === 'danger'
          ? 'text-zinc-500 hover:bg-rose-50 hover:text-rose-700 dark:text-zinc-400 dark:hover:bg-rose-950/40 dark:hover:text-rose-300'
          : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100',
      )}
    >
      {children}
    </button>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">{label}</span>
      {children}
      {hint && <span className="text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">{hint}</span>}
    </label>
  );
}

// ─── The three access controls ────────────────────────────────────────────────

const GROUP_ORDER: CatalogGroup[] = ['identity', 'work', 'contact', 'address', 'photo', 'system'];

/** Whole table by default; untick to hide. Sensitive columns carry a quiet mark. */
function ColumnPicker({ ticked, onChange }: { ticked: string[]; onChange: (next: string[]) => void }) {
  const all = ticked.length === OFFERABLE_COLUMNS.length;
  const hidden = OFFERABLE_COLUMNS.length - ticked.length;
  const toggle = (col: string) => onChange(ticked.includes(col) ? ticked.filter((c) => c !== col) : [...ticked, col]);
  const linkCls =
    'text-xs font-medium text-zinc-700 underline-offset-2 hover:underline disabled:no-underline disabled:opacity-40 dark:text-zinc-300';
  return (
    <div className="rounded-md border border-zinc-200 dark:border-zinc-800">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
        <span className="text-xs text-zinc-600 dark:text-zinc-400">
          {all ? 'Whole table' : `${ticked.length} of ${OFFERABLE_COLUMNS.length} columns · ${hidden} hidden`}
        </span>
        <div className="flex items-center gap-3">
          <button type="button" className={linkCls} onClick={() => onChange([...OFFERABLE_COLUMNS])} disabled={all}>
            Whole table
          </button>
          <button
            type="button"
            className={linkCls}
            onClick={() => onChange(OFFERABLE_COLUMNS.filter((c) => !SENSITIVE_COLUMNS.includes(c)))}
          >
            Hide sensitive
          </button>
          <button type="button" className={linkCls} onClick={() => onChange([])} disabled={ticked.length === 0}>
            None
          </button>
        </div>
      </div>
      <div className="grid gap-x-6 gap-y-4 p-3 sm:grid-cols-2">
        {GROUP_ORDER.map((g) => {
          const cols = GML_CATALOG.filter((c) => c.group === g);
          if (!cols.length) return null;
          return (
            <div key={g}>
              <div className="mb-1.5 text-xs font-medium text-zinc-500 dark:text-zinc-400">{GROUP_LABELS[g]}</div>
              <div className="flex flex-col gap-1">
                {cols.map((c) => {
                  const on = ticked.includes(c.name);
                  return (
                    <label key={c.name} className="flex cursor-pointer items-center gap-2 py-0.5 text-sm" title={c.description}>
                      <input type="checkbox" checked={on} onChange={() => toggle(c.name)} className="h-4 w-4 rounded accent-zinc-900 dark:accent-zinc-100" />
                      <span className={cn('font-mono text-xs', on ? 'text-zinc-800 dark:text-zinc-200' : 'text-zinc-400 dark:text-zinc-500')}>
                        {c.name}
                      </span>
                      {c.sensitive && <span className="text-[11px] text-amber-700 dark:text-amber-400">sensitive</span>}
                    </label>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      <p className="border-t border-zinc-200 px-3 py-2 text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
        <code className="font-mono">id</code> always rides along (it is the page cursor). A hidden column is neither returned nor filterable.
      </p>
    </div>
  );
}

function ExpiryPicker({
  value,
  onChange,
  allowKeep,
  keepLabel,
}: {
  value: ExpiryOption | 'keep';
  onChange: (v: ExpiryOption | 'keep') => void;
  allowKeep?: boolean;
  keepLabel?: string;
}) {
  const opts: Array<ExpiryOption | 'keep'> = allowKeep ? ['keep', ...EXPIRY_OPTIONS] : [...EXPIRY_OPTIONS];
  return (
    <div role="radiogroup" className="flex flex-wrap gap-1.5">
      {opts.map((o) => {
        const on = value === o;
        return (
          <button
            key={o}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o)}
            className={cn(
              'h-8 rounded-md border px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400',
              on
                ? 'border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900'
                : 'border-zinc-200 text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800',
            )}
          >
            {o === 'keep' ? keepLabel ?? 'Keep current' : EXPIRY_LABELS[o]}
          </button>
        );
      })}
    </div>
  );
}

function RateLimitField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const parsed = parseRateLimit(value);
  return (
    <Field
      label="Calls per minute"
      hint={`${RATE_LIMIT_FLOOR}–${RATE_LIMIT_CEILING}. HTTP and MCP share one budget; a full roster pull is 8 calls. Default ${RATE_LIMIT_DEFAULT}.`}
    >
      <Input
        type="number"
        inputMode="numeric"
        min={RATE_LIMIT_FLOOR}
        max={RATE_LIMIT_CEILING}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={parsed === null}
        className={cn('w-36 tabular-nums', parsed === null && 'border-rose-400 focus-visible:ring-rose-300')}
      />
    </Field>
  );
}

// ─── Create ───────────────────────────────────────────────────────────────────

function CreateClientDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (client: ClientView, apiKey: string) => void;
}) {
  const [name, setName] = useState('');
  const [system, setSystem] = useState('');
  const [contact, setContact] = useState('');
  const [ticked, setTicked] = useState<string[]>([...OFFERABLE_COLUMNS]);
  const [expiry, setExpiry] = useState<ExpiryOption | 'keep'>(DEFAULT_EXPIRY);
  const [limit, setLimit] = useState(String(RATE_LIMIT_DEFAULT));
  const [saving, setSaving] = useState(false);
  const [step, setStep] = useState<CreateStep>('who');

  useEffect(() => {
    if (open) {
      setName('');
      setSystem('');
      setContact('');
      setTicked([...OFFERABLE_COLUMNS]);
      setExpiry(DEFAULT_EXPIRY);
      setLimit(String(RATE_LIMIT_DEFAULT));
      setStep('who');
    }
  }, [open]);

  const limitOk = parseRateLimit(limit) !== null;
  const columnsOk = ticked.length > 0;
  const canSubmit = !!name.trim() && !!system.trim() && limitOk && columnsOk && expiry !== 'keep';

  const submit = async () => {
    if (!canSubmit) {
      toast.error(!columnsOk ? 'Pick at least one column, or leave the whole table on' : 'Name, system, a valid limit and an expiry are required');
      return;
    }
    setSaving(true);
    try {
      const r = await fetch('/api/admin/external-api-clients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          system: system.trim(),
          contact_email: contact.trim() || null,
          granted_columns: tickedToGrantBody(ticked),
          expiry,
          rate_limit_per_minute: parseRateLimit(limit),
        }),
      });
      const body = await readJson<{ client: ClientView; api_key: string }>(r);
      if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
      onCreated({ ...body.client, calls_7d: 0, denied_7d: 0, throttled_7d: 0 }, body.api_key);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not create client');
    } finally {
      setSaving(false);
    }
  };

  // The slideshow (Kane, 2026-09-17: "separate them by group with a confirm at
  // the end"): one group per step, Next is gated on that step alone, and the
  // last step is a read-back — nothing is created until it is confirmed.
  const STEPS: Array<{ id: CreateStep; label: string }> = [
    { id: 'who', label: 'Who' },
    { id: 'columns', label: 'Columns' },
    { id: 'access', label: 'Access' },
    { id: 'confirm', label: 'Confirm' },
  ];
  const stepIndex = STEPS.findIndex((s) => s.id === step);
  const stepOk: Record<CreateStep, boolean> = {
    who: !!name.trim() && !!system.trim() && (!contact.trim() || contact.includes('@')),
    columns: columnsOk,
    access: limitOk && expiry !== 'keep',
    confirm: canSubmit,
  };
  const goNext = () => {
    if (!stepOk[step]) return;
    const next = STEPS[stepIndex + 1];
    if (next) setStep(next.id);
  };
  const goBack = () => {
    const prev = STEPS[stepIndex - 1];
    if (prev) setStep(prev.id);
  };
  const hidden = OFFERABLE_COLUMNS.length - ticked.length;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="max-h-[90vh] overflow-y-auto sm:max-w-2xl"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && (e.target as HTMLElement).tagName === 'INPUT') {
            e.preventDefault();
            if (step === 'confirm') void submit();
            else goNext();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>New external client</DialogTitle>
          <DialogDescription>One client per system. Everything except the key can be changed later.</DialogDescription>
        </DialogHeader>

        {/* Step rail */}
        <ol className="flex items-center gap-2 text-xs" aria-label="Steps">
          {STEPS.map((s, i) => {
            const state = i < stepIndex ? 'done' : i === stepIndex ? 'current' : 'todo';
            const reachable = i <= stepIndex;
            return (
              <li key={s.id} className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={!reachable}
                  onClick={() => reachable && setStep(s.id)}
                  aria-current={state === 'current' ? 'step' : undefined}
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-full py-0.5 pl-0.5 pr-2 transition-colors disabled:cursor-default',
                    reachable && 'hover:bg-zinc-100 dark:hover:bg-zinc-800',
                  )}
                >
                  <span
                    className={cn(
                      'inline-flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-medium tabular-nums',
                      state === 'current' && 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900',
                      state === 'done' && 'bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-100',
                      state === 'todo' && 'border border-zinc-300 text-zinc-400 dark:border-zinc-700 dark:text-zinc-500',
                    )}
                  >
                    {state === 'done' ? <Check className="h-3 w-3" /> : i + 1}
                  </span>
                  <span className={cn('font-medium', state === 'current' ? 'text-zinc-900 dark:text-zinc-100' : 'text-zinc-500 dark:text-zinc-400')}>
                    {s.label}
                  </span>
                </button>
                {i < STEPS.length - 1 && <span className="h-px w-6 bg-zinc-200 dark:bg-zinc-700" aria-hidden />}
              </li>
            );
          })}
        </ol>

        {/* One group per slide */}
        <div key={step} className="min-h-[220px] animate-in fade-in slide-in-from-right-2 duration-200 ease-out motion-reduce:animate-none">
          {step === 'who' && (
            <div className="flex flex-col gap-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Client name" hint="Who it is for, e.g. Ops team roster mirror">
                  <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus />
                </Field>
                <Field label="System" hint="What will call us, e.g. n8n · Sheets script · Claude Desktop">
                  <Input value={system} onChange={(e) => setSystem(e.target.value)} maxLength={80} />
                </Field>
              </div>
              <Field label="Contact email (optional)" hint="Whom to reach when it misbehaves">
                <Input type="email" value={contact} onChange={(e) => setContact(e.target.value)} placeholder="name@simple.biz" />
              </Field>
            </div>
          )}

          {step === 'columns' && (
            <Field label="Columns they may read" hint="Whole table by default. Untick a column to hide it from this key.">
              <ColumnPicker ticked={ticked} onChange={setTicked} />
            </Field>
          )}

          {step === 'access' && (
            <div className="grid gap-5 sm:grid-cols-2">
              <Field label="Key lives for" hint="Counted from now. It can always be revoked before then.">
                <ExpiryPicker value={expiry} onChange={setExpiry} />
              </Field>
              <RateLimitField value={limit} onChange={setLimit} />
            </div>
          )}

          {step === 'confirm' && (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-zinc-600 dark:text-zinc-400">
                Check the summary. Creating issues the key and shows it once.
              </p>
              <dl className="divide-y divide-zinc-200 rounded-md border border-zinc-200 text-sm dark:divide-zinc-800 dark:border-zinc-800">
                <SummaryRow label="Client" onEdit={() => setStep('who')}>
                  <span className="font-medium">{name.trim()}</span>
                  <span className="text-zinc-500 dark:text-zinc-400">
                    {' '}
                    · {system.trim()}
                    {contact.trim() ? ` · ${contact.trim()}` : ''}
                  </span>
                </SummaryRow>
                <SummaryRow label="Columns" onEdit={() => setStep('columns')}>
                  {hidden === 0 ? (
                    'Whole table'
                  ) : (
                    <>
                      {ticked.length} of {OFFERABLE_COLUMNS.length}
                      <span className="text-zinc-500 dark:text-zinc-400"> · hidden: </span>
                      <span className="font-mono text-xs">{OFFERABLE_COLUMNS.filter((c) => !ticked.includes(c)).join(', ')}</span>
                    </>
                  )}
                </SummaryRow>
                <SummaryRow label="Key lives for" onEdit={() => setStep('access')}>
                  {expiry === 'keep' ? '—' : EXPIRY_LABELS[expiry]}
                </SummaryRow>
                <SummaryRow label="Rate limit" onEdit={() => setStep('access')}>
                  {parseRateLimit(limit) ?? '—'} calls per minute, HTTP and MCP together
                </SummaryRow>
              </dl>
            </div>
          )}
        </div>

        <DialogFooter className="sm:justify-between">
          <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <div className="flex gap-2">
            {stepIndex > 0 && (
              <Button type="button" variant="outline" onClick={goBack} disabled={saving}>
                Back
              </Button>
            )}
            {step !== 'confirm' ? (
              <Button type="button" onClick={goNext} disabled={!stepOk[step]} className="gap-1.5">
                Next <ChevronRight className="h-4 w-4" />
              </Button>
            ) : (
              <Button
                type="button"
                className="gap-1.5 bg-orange-600 text-white hover:bg-orange-700"
                onClick={() => void submit()}
                disabled={saving || !canSubmit}
              >
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Create and show key
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type CreateStep = 'who' | 'columns' | 'access' | 'confirm';

function SummaryRow({ label, onEdit, children }: { label: string; onEdit: () => void; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 px-3 py-2.5">
      <dt className="w-28 shrink-0 text-xs font-medium text-zinc-500 dark:text-zinc-400">{label}</dt>
      <dd className="min-w-0 flex-1 break-words">{children}</dd>
      <button
        type="button"
        onClick={onEdit}
        className="shrink-0 text-xs font-medium text-zinc-600 underline-offset-2 hover:underline dark:text-zinc-300"
      >
        Edit
      </button>
    </div>
  );
}

// ─── Edit ─────────────────────────────────────────────────────────────────────

function EditClientDialog({ client, onClose, onSaved }: { client: ClientView | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState('');
  const [system, setSystem] = useState('');
  const [contact, setContact] = useState('');
  const [ticked, setTicked] = useState<string[]>([]);
  const [expiry, setExpiry] = useState<ExpiryOption | 'keep'>('keep');
  const [limit, setLimit] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (client) {
      setName(client.name);
      setSystem(client.system);
      setContact(client.contact_email ?? '');
      setTicked(grantToTicked(client.granted_columns));
      setExpiry('keep');
      setLimit(String(client.rate_limit_per_minute));
    }
  }, [client]);

  if (!client) return null;

  const limitOk = parseRateLimit(limit) !== null;
  const columnsOk = ticked.length > 0;
  const canSubmit = !!name.trim() && !!system.trim() && limitOk && columnsOk;

  const submit = async () => {
    if (!canSubmit) {
      toast.error(!columnsOk ? 'Pick at least one column, or set the whole table' : 'Name, system and a valid limit are required');
      return;
    }
    const body: Record<string, unknown> = { action: 'update' };
    if (name.trim() !== client.name) body.name = name.trim();
    if (system.trim() !== client.system) body.system = system.trim();
    if ((contact.trim() || null) !== client.contact_email) body.contact_email = contact.trim() || null;
    const nextGrant = tickedToGrantBody(ticked);
    const sameGrant =
      (nextGrant === null && client.granted_columns === null) ||
      (nextGrant !== null && client.granted_columns !== null && JSON.stringify(nextGrant) === JSON.stringify(client.granted_columns));
    if (!sameGrant) body.granted_columns = nextGrant;
    if (expiry !== 'keep') body.expiry = expiry;
    const nextLimit = parseRateLimit(limit);
    if (nextLimit !== null && nextLimit !== client.rate_limit_per_minute) body.rate_limit_per_minute = nextLimit;
    if (Object.keys(body).length === 1) {
      toast.message('Nothing changed');
      onClose();
      return;
    }
    setSaving(true);
    try {
      const r = await fetch(`/api/admin/external-api-clients/${client.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const res = await readJson<{ client: ClientView }>(r);
      if (!r.ok) throw new Error(res.error ?? `HTTP ${r.status}`);
      toast.success(`Saved — ${client.name}'s next call uses the new settings`);
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={!!client} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit {client.name}</DialogTitle>
          <DialogDescription>
            Key <code className="font-mono text-xs">{client.key_prefix}…</code> stays as it is. Changes take effect on the client&apos;s next call.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Client name">
              <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
            </Field>
            <Field label="System">
              <Input value={system} onChange={(e) => setSystem(e.target.value)} maxLength={80} />
            </Field>
          </div>
          <Field label="Contact email (optional)">
            <Input type="email" value={contact} onChange={(e) => setContact(e.target.value)} placeholder="name@simple.biz" />
          </Field>
          <Field label="Columns they may read">
            <ColumnPicker ticked={ticked} onChange={setTicked} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Key lives for"
              hint={
                client.expires_at
                  ? `Now: expires ${describeExpiry(client.expires_at)} (${fmtWhen(client.expires_at)}). A new choice counts from now.`
                  : 'Now: does not expire. A new choice counts from now.'
              }
            >
              <ExpiryPicker value={expiry} onChange={setExpiry} allowKeep keepLabel="Keep as is" />
            </Field>
            <RateLimitField value={limit} onChange={setLimit} />
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            type="button"
            className="gap-1.5 bg-orange-600 text-white hover:bg-orange-700"
            onClick={() => void submit()}
            disabled={saving || !canSubmit}
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── The hand-off ─────────────────────────────────────────────────────────────

function sampleValue(column: string): unknown {
  if (column === 'id') return 1234;
  if (column === 'created_at' || column === 'Start Date') return '2026-01-05';
  if (/email/i.test(column)) return 'name@simple.biz';
  if (/photo|url/i.test(column)) return 'https://…';
  return `<${column}>`;
}

function samplePayload(grant: Grant): string {
  const cols = visibleColumns(grant);
  const row: Record<string, unknown> = {};
  for (const c of cols) row[c] = sampleValue(c);
  return JSON.stringify(
    { data: [row], page: { limit: 100, max_limit: 500, returned: 1, total: 1, next_cursor: null }, meta: { active_only: true, columns: cols } },
    null,
    2,
  );
}

function mcpConfig(mcpUrl: string, key: string): string {
  return JSON.stringify(
    { mcpServers: { 'simple-hris': { type: 'http', url: mcpUrl, headers: { Authorization: `Bearer ${key}` } } } },
    null,
    2,
  );
}

function HandOffDialog({
  issued,
  onClose,
  restUrl,
  mcpUrl,
}: {
  issued: { client: ClientView; apiKey: string; mode: 'created' | 'rotated' } | null;
  onClose: () => void;
  restUrl: string;
  mcpUrl: string;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const [view, setView] = useState<HandOffView>('all');
  useEffect(() => {
    if (issued) {
      setCopied(null);
      setView('all');
    }
  }, [issued]);

  if (!issued) return null;
  const { client, apiKey } = issued;
  const grant = client.granted_columns;
  const cols = visibleColumns(grant);
  const masked = `${apiKey.slice(0, 16)}…`;
  const curl = `curl -H "Authorization: Bearer ${apiKey}" "${restUrl}?limit=100"`;
  const payload = samplePayload(grant);
  const mcp = mcpConfig(mcpUrl, apiKey);
  const expiryLine = client.expires_at
    ? `This key expires ${describeExpiry(client.expires_at)} (${new Date(client.expires_at).toUTCString()}).`
    : 'This key does not expire; we can revoke it at any time.';
  const handOff = [
    `Simple HRIS — ${GML_TABLE_LABEL} access for ${client.name} (${client.system})`,
    '',
    `API key (keep it private): ${apiKey}`,
    `${expiryLine} Limit: ${client.rate_limit_per_minute} calls per minute (HTTP and MCP together).`,
    '',
    `Columns you receive: ${cols.join(', ')}`,
    hiddenCount(grant) > 0 ? `(${hiddenCount(grant)} other columns are not included and cannot be filtered on.)` : '(the whole table)',
    '',
    'HTTP:',
    `  ${curl}`,
    '  Filters: department, email, search, limit (≤500), cursor. Walk pages with cursor=<next_cursor> until it is null.',
    '',
    'MCP (Streamable HTTP):',
    mcp,
    '  Tools: describe_access, query_global_master_list.',
    '',
    'Sample response:',
    payload,
  ].join('\n');

  // What each segment SHOWS (masked) and what its Copy copies (the real key).
  const VIEWS: Record<HandOffView, { label: string; shown: string; copy: string; hint: string }> = {
    all: {
      label: 'Hand-off',
      shown: handOff.split(apiKey).join(masked),
      copy: handOff,
      hint: 'Everything the system owner needs, in one paste.',
    },
    http: {
      label: 'HTTP',
      shown: `curl -H "Authorization: Bearer ${masked}" "${restUrl}?limit=100"`,
      copy: curl,
      hint: 'Filters: department · email · search · limit ≤ 500 · cursor. Walk pages with cursor until next_cursor is null.',
    },
    mcp: {
      label: 'MCP',
      shown: mcp.split(apiKey).join(masked),
      copy: mcp,
      hint: 'Paste into the MCP client’s server config. Tools: describe_access, query_global_master_list.',
    },
    sample: {
      label: 'Sample response',
      shown: payload,
      copy: payload,
      hint: `${cols.length} columns, exactly as this key will receive them.`,
    },
  };
  const current = VIEWS[view];

  const copy = async (what: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      toast.success('Copied');
    } catch {
      toast.error('Clipboard blocked — select and copy by hand');
    }
  };

  return (
    <Dialog open={!!issued} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[90vh] flex-col gap-4 overflow-hidden sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{issued.mode === 'rotated' ? 'New key issued' : 'Client created'}</DialogTitle>
          <DialogDescription>
            This is the only time the key is shown. Send it to {client.contact_email ?? 'the owner'} over a private channel. If it
            is lost, rotate.
          </DialogDescription>
        </DialogHeader>

        {/* The key */}
        <div className="min-w-0 rounded-md border border-zinc-200 dark:border-zinc-800">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-zinc-200 px-3 py-2 text-xs text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">
            <span className="min-w-0 truncate font-medium text-zinc-800 dark:text-zinc-200">
              {client.name} · {client.system}
            </span>
            <span className="whitespace-nowrap">
              {client.expires_at ? `expires ${describeExpiry(client.expires_at)}` : 'does not expire'} · {client.rate_limit_per_minute}/min ·{' '}
              {hiddenCount(grant) === 0 ? 'whole table' : `${cols.length} columns`}
            </span>
          </div>
          <div className="flex items-center gap-3 px-3 py-2.5">
            <code className="min-w-0 flex-1 select-all break-all font-mono text-xs leading-relaxed text-zinc-900 dark:text-zinc-100">{apiKey}</code>
            <Button
              type="button"
              size="sm"
              onClick={() => void copy('key', apiKey)}
              className="h-8 shrink-0 gap-1.5 bg-orange-600 text-white hover:bg-orange-700"
            >
              {copied === 'key' ? <Check className="h-3.5 w-3.5" /> : <CopyIcon className="h-3.5 w-3.5" />} Copy key
            </Button>
          </div>
        </div>

        {/* One preview at a time — no side-by-side code, so nothing can push the dialog wider */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div role="tablist" aria-label="Hand-off sections" className="flex flex-wrap gap-1">
              {(Object.keys(VIEWS) as HandOffView[]).map((k) => {
                const on = view === k;
                return (
                  <button
                    key={k}
                    type="button"
                    role="tab"
                    aria-selected={on}
                    onClick={() => setView(k)}
                    className={cn(
                      'h-7 rounded-md px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400',
                      on
                        ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                        : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800',
                    )}
                  >
                    {VIEWS[k].label}
                  </button>
                );
              })}
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void copy(view, current.copy)}
              className="h-7 shrink-0 gap-1.5 px-2.5 text-xs"
            >
              {copied === view ? <Check className="h-3.5 w-3.5" /> : <CopyIcon className="h-3.5 w-3.5" />} Copy {current.label.toLowerCase()}
            </Button>
          </div>
          <Pre className="min-h-0 flex-1">{current.shown}</Pre>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">{current.hint}</p>
        </div>

        <DialogFooter>
          <Button type="button" className="bg-zinc-900 text-white hover:bg-zinc-800 dark:bg-white dark:text-zinc-900" onClick={onClose}>
            I have copied it
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type HandOffView = 'all' | 'http' | 'mcp' | 'sample';

/** Wrapping, vertically scrolling code block — long lines fold, they never widen the dialog. */
function Pre({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <pre
      className={cn(
        'max-h-[40vh] min-w-0 overflow-y-auto whitespace-pre-wrap break-all rounded-md border border-zinc-200 bg-zinc-50 p-3 font-mono text-[11.5px] leading-relaxed text-zinc-800 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200',
        className,
      )}
    >
      {children}
    </pre>
  );
}

// ─── Calls ────────────────────────────────────────────────────────────────────

function CallsDialog({ client, onClose }: { client: ClientView | null; onClose: () => void }) {
  const [rows, setRows] = useState<RequestRow[] | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!client) {
      setRows(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const r = await fetch(`/api/admin/external-api-clients/${client.id}/requests?limit=100`, { cache: 'no-store' });
        const body = await readJson<{ requests: RequestRow[] }>(r);
        if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
        if (!cancelled) setRows(body.requests);
      } catch (e) {
        if (!cancelled) toast.error(e instanceof Error ? e.message : 'Could not load calls');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client]);

  return (
    <Dialog open={!!client} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{client?.name} — recent calls</DialogTitle>
          <DialogDescription>
            {client?.system} · key <code className="font-mono text-xs">{client?.key_prefix}…</code> · newest first, up to 100. A 429 is a
            throttled call.
          </DialogDescription>
        </DialogHeader>
        {loading ? (
          <div className="flex flex-col gap-2 py-2" aria-busy>
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-3 w-full animate-pulse rounded bg-zinc-100 dark:bg-zinc-800" />
            ))}
          </div>
        ) : !rows || rows.length === 0 ? (
          <div className="py-10 text-center text-sm text-zinc-500 dark:text-zinc-400">No calls recorded yet.</div>
        ) : (
          <div className="max-h-[60vh] overflow-auto rounded-md border border-zinc-200 dark:border-zinc-800">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-white dark:bg-zinc-950">
                <tr className="border-b border-zinc-200 text-left font-medium text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">
                  <th className="px-2.5 py-2">When</th>
                  <th className="px-2.5 py-2">Via</th>
                  <th className="px-2.5 py-2">Status</th>
                  <th className="px-2.5 py-2">Query</th>
                  <th className="px-2.5 py-2 text-right">Rows</th>
                  <th className="px-2.5 py-2 text-right">ms</th>
                  <th className="px-2.5 py-2">IP</th>
                  <th className="px-2.5 py-2">User-agent</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
                {rows.map((r) => (
                  <tr key={r.id} className="align-top">
                    <td className="whitespace-nowrap px-2.5 py-1.5 text-zinc-600 dark:text-zinc-400">{fmtWhen(r.created_at)}</td>
                    <td className="px-2.5 py-1.5 text-zinc-600 dark:text-zinc-400">{r.method === 'POST' ? 'MCP' : 'HTTP'}</td>
                    <td className="px-2.5 py-1.5">
                      <span
                        className={cn(
                          'font-mono tabular-nums',
                          r.status < 300
                            ? 'text-emerald-700 dark:text-emerald-400'
                            : r.status === 429
                              ? 'text-amber-700 dark:text-amber-400'
                              : 'text-rose-700 dark:text-rose-400',
                        )}
                      >
                        {r.status}
                        {r.denial ? ` ${r.denial}` : ''}
                      </span>
                    </td>
                    <td className="max-w-[220px] truncate px-2.5 py-1.5 font-mono text-zinc-600 dark:text-zinc-400" title={r.query ? JSON.stringify(r.query) : ''}>
                      {r.query ? JSON.stringify(r.query) : '—'}
                    </td>
                    <td className="px-2.5 py-1.5 text-right tabular-nums">{r.row_count ?? '—'}</td>
                    <td className="px-2.5 py-1.5 text-right tabular-nums text-zinc-500">{r.duration_ms ?? '—'}</td>
                    <td className="whitespace-nowrap px-2.5 py-1.5 font-mono text-zinc-600 dark:text-zinc-400">{r.ip ?? '—'}</td>
                    <td className="max-w-[220px] truncate px-2.5 py-1.5 text-zinc-500" title={r.user_agent ?? ''}>
                      {r.user_agent ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
