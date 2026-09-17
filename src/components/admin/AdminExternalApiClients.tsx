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
  Globe2,
  AlertTriangle,
  ShieldCheck,
  Eye,
  Pencil,
  Clock,
  Gauge,
  Columns3,
  Lock,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { GML_CATALOG, GML_TABLE_LABEL, GROUP_LABELS, OFFERABLE_COLUMNS, SENSITIVE_COLUMNS, type CatalogGroup } from '@/lib/external-api/catalog';
import { hiddenCount, normalizeGrant, visibleColumns, type Grant } from '@/lib/external-api/grants';
import { EXPIRY_LABELS, EXPIRY_OPTIONS, describeExpiry, isExpired, type ExpiryOption } from '@/lib/external-api/expiry';
import { RATE_LIMIT_CEILING, RATE_LIMIT_DEFAULT, RATE_LIMIT_FLOOR, parseRateLimit } from '@/lib/external-api/rate-limit';

/**
 * Admin → Webhooks & Integrations → Integrations.
 *
 * The registry of OUTSIDE systems allowed to read the Global Master List — by
 * plain HTTP query or by MCP, with the same key — and the log of what they did.
 *
 * Kane, 2026-09-17: *"they only need Global Master List — I can give them the
 * whole table or hide some of those columns to protect data … give them the
 * payload and the key … set time on how long that key can survive … we should
 * have rate limiting practices on this … the option to revoke the key."*
 *
 * Rules this panel enforces in the UI (the routes enforce them again):
 *  - The key is shown ONCE, in the hand-off dialog that created or rotated it.
 *    Closing that dialog is the last time anyone sees it; the table shows a prefix.
 *  - Columns default to the WHOLE table; the admin hides by unticking. Sensitive
 *    (personal contact / address / photo) columns are marked so they stand out.
 *  - Expiry is 1 day · 15 days · 30 days · does not expire. Revoke is always there.
 *  - The rate limit is per client, REST + MCP together, and the number shown IS the
 *    number enforced.
 *  - Revoke is instant and reversible (Restore). Rotate keeps the client and its
 *    history and hands out a new key. Nothing here deletes a client.
 *  - Every change (columns, expiry, limit) takes effect on the client's NEXT call.
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

function relative(iso: string | null): string {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return fmtWhen(iso);
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

/** The grant a picker holds: the OFFERABLE columns ticked. Whole table = all of them. */
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

export default function AdminExternalApiClients() {
  const [data, setData] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<ClientView | null>(null);
  const [issued, setIssued] = useState<{ client: ClientView; apiKey: string; mode: 'created' | 'rotated' } | null>(null);
  const [callsFor, setCallsFor] = useState<ClientView | null>(null);
  const [confirmRotate, setConfirmRotate] = useState<ClientView | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/admin/external-api-clients', { cache: 'no-store' });
      const body = await readJson<ListResponse>(r);
      if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
      setData(body);
    } catch (e) {
      toast.error(e instanceof Error ? `Could not load external clients: ${e.message}` : 'Could not load external clients');
    } finally {
      setLoading(false);
    }
  }, []);

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
  const live = useMemo(() => clients.filter((c) => stateOf(c) === 'live').length, [clients]);
  const ready = !!data?.migration_applied && !!data?.configured;

  return (
    <section>
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-zinc-900 dark:text-white">External access</h2>
          <p className="mt-0.5 text-sm text-zinc-500 dark:text-zinc-400">
            One key per outside system that reads the {GML_TABLE_LABEL}. Give them the whole table or hide columns, set how
            long the key lives and how often it may call. They pull by plain HTTP query or by MCP — same key, same columns,
            same limit. Revoke any key here and it stops on its next call.
          </p>
        </div>
        <Button
          type="button"
          onClick={() => setCreateOpen(true)}
          disabled={loading || !ready}
          className="shrink-0 gap-1.5 bg-orange-600 text-white hover:bg-orange-700"
        >
          <Plus className="h-4 w-4" /> New client
        </Button>
      </div>

      <div className="rounded-2xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950/60">
        <div className="flex flex-col gap-1 border-b border-zinc-100 p-5 dark:border-zinc-800/80 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-sky-50 text-sky-600 dark:bg-sky-950/40 dark:text-sky-400">
              <Globe2 className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{GML_TABLE_LABEL} — read API + MCP</h3>
              <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                REST{' '}
                <code className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-[11px] text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                  GET {restUrl}
                </code>{' '}
                · MCP{' '}
                <code className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-[11px] text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                  POST {mcpUrl}
                </code>{' '}
                · both with{' '}
                <code className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-[11px] text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                  Authorization: Bearer hris_live_…
                </code>
                . Active people only, never off-boarded ones.
              </p>
            </div>
          </div>
          {!loading && data && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-zinc-300/70 bg-zinc-50 px-2.5 py-1 text-[11px] font-semibold text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
              {live} live · {clients.length - live} revoked or expired
            </span>
          )}
        </div>

        <div className="p-5">
          {loading ? (
            <div className="flex items-center gap-2 py-6 text-sm text-zinc-500 dark:text-zinc-400">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading external clients…
            </div>
          ) : !data ? (
            <div className="py-6 text-sm text-zinc-500">Could not load. Retry from the browser.</div>
          ) : !data.migration_applied ? (
            <Notice tone="amber" icon={<AlertTriangle className="h-4 w-4" />}>
              The <code className="font-mono text-[11px]">external_api_clients</code> table has not been applied yet. Run{' '}
              <code className="font-mono text-[11px]">scripts/Apply External API clients migration.cmd</code>, then reload this
              tab.
            </Notice>
          ) : !data.configured ? (
            <Notice tone="amber" icon={<AlertTriangle className="h-4 w-4" />}>
              No key pepper is configured on this deployment (set <code className="font-mono text-[11px]">EXTERNAL_API_KEY_PEPPER</code>{' '}
              or <code className="font-mono text-[11px]">NEXTAUTH_SECRET</code>). Keys cannot be issued or verified until it is.
            </Notice>
          ) : clients.length === 0 ? (
            <div className="rounded-xl border border-dashed border-zinc-200 px-4 py-8 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
              No external clients yet. Create one per system that needs the roster — the key is shown once.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-zinc-100 text-left text-[11px] font-semibold uppercase tracking-wider text-zinc-400 dark:border-zinc-800 dark:text-zinc-500">
                    <th className="py-2 pr-3">Client</th>
                    <th className="py-2 pr-3">Key</th>
                    <th className="py-2 pr-3">Columns</th>
                    <th className="py-2 pr-3">Expires</th>
                    <th className="py-2 pr-3">Limit</th>
                    <th className="py-2 pr-3">Status</th>
                    <th className="py-2 pr-3">Last used</th>
                    <th className="py-2 pr-3 text-right">7d calls</th>
                    <th className="py-2 pl-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {clients.map((c) => {
                    const state = stateOf(c);
                    const busy = busyId === c.id;
                    const hidden = hiddenCount(c.granted_columns);
                    const hiddenNames = OFFERABLE_COLUMNS.filter((col) => c.granted_columns !== null && !c.granted_columns.includes(col));
                    return (
                      <tr key={c.id} className="border-b border-zinc-50 last:border-0 dark:border-zinc-800/60">
                        <td className="py-2.5 pr-3">
                          <div className="font-medium text-zinc-900 dark:text-zinc-100">{c.name}</div>
                          <div className="text-[11px] text-zinc-400 dark:text-zinc-500">
                            {c.system} · {c.contact_email ?? 'no contact'} · by {c.created_by.split('@')[0]} {relative(c.created_at)}
                          </div>
                        </td>
                        <td className="py-2.5 pr-3">
                          <code className="font-mono text-xs text-zinc-700 dark:text-zinc-300">{c.key_prefix}…</code>
                          {c.rotated_at && (
                            <div className="text-[11px] text-zinc-400 dark:text-zinc-500">rotated {relative(c.rotated_at)}</div>
                          )}
                        </td>
                        <td className="py-2.5 pr-3">
                          {hidden === 0 ? (
                            <span className="inline-flex items-center gap-1 rounded-full border border-zinc-300/70 bg-zinc-50 px-2 py-0.5 text-[11px] font-semibold text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
                              <Columns3 className="h-3 w-3" /> Whole table
                            </span>
                          ) : (
                            <span
                              title={`Hidden: ${hiddenNames.join(', ')}`}
                              className="inline-flex items-center gap-1 rounded-full border border-sky-300/70 bg-sky-50 px-2 py-0.5 text-[11px] font-semibold text-sky-700 dark:border-sky-800/50 dark:bg-sky-950/30 dark:text-sky-300"
                            >
                              <Lock className="h-3 w-3" /> {OFFERABLE_COLUMNS.length - hidden} of {OFFERABLE_COLUMNS.length} · {hidden} hidden
                            </span>
                          )}
                        </td>
                        <td className="py-2.5 pr-3 text-zinc-700 dark:text-zinc-300" title={c.expires_at ?? 'Does not expire'}>
                          <span className="inline-flex items-center gap-1">
                            <Clock className="h-3 w-3 text-zinc-400" /> {describeExpiry(c.expires_at)}
                          </span>
                        </td>
                        <td className="py-2.5 pr-3 tabular-nums text-zinc-700 dark:text-zinc-300">
                          <span className="inline-flex items-center gap-1">
                            <Gauge className="h-3 w-3 text-zinc-400" /> {c.rate_limit_per_minute}/min
                          </span>
                        </td>
                        <td className="py-2.5 pr-3">
                          {state === 'revoked' ? (
                            <span className="inline-flex items-center gap-1 rounded-full border border-rose-300/70 bg-rose-50 px-2 py-0.5 text-[11px] font-semibold text-rose-700 dark:border-rose-800/50 dark:bg-rose-950/30 dark:text-rose-300">
                              <Ban className="h-3 w-3" /> Revoked
                            </span>
                          ) : state === 'expired' ? (
                            <span className="inline-flex items-center gap-1 rounded-full border border-amber-300/70 bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700 dark:border-amber-800/50 dark:bg-amber-950/30 dark:text-amber-300">
                              <Clock className="h-3 w-3" /> Expired
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 rounded-full border border-emerald-300/70 bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 dark:border-emerald-800/50 dark:bg-emerald-950/30 dark:text-emerald-300">
                              <Check className="h-3 w-3" /> Live
                            </span>
                          )}
                        </td>
                        <td className="py-2.5 pr-3 text-zinc-600 dark:text-zinc-400" title={c.last_used_at ?? ''}>
                          {relative(c.last_used_at)}
                        </td>
                        <td className="py-2.5 pr-3 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
                          {c.calls_7d}
                          {c.denied_7d > 0 && (
                            <span className="ml-1 text-[11px] text-rose-600 dark:text-rose-400">({c.denied_7d} denied)</span>
                          )}
                          {c.throttled_7d > 0 && (
                            <span className="ml-1 text-[11px] text-amber-600 dark:text-amber-400">({c.throttled_7d} throttled)</span>
                          )}
                        </td>
                        <td className="py-2.5 pl-3">
                          <div className="flex justify-end gap-1">
                            <IconBtn label="Calls" onClick={() => setCallsFor(c)} disabled={busy}>
                              <ListOrdered className="h-3.5 w-3.5" />
                            </IconBtn>
                            <IconBtn label="Edit" onClick={() => setEditing(c)} disabled={busy}>
                              <Pencil className="h-3.5 w-3.5" />
                            </IconBtn>
                            <IconBtn label="Rotate key" onClick={() => setConfirmRotate(c)} disabled={busy}>
                              <RefreshCw className="h-3.5 w-3.5" />
                            </IconBtn>
                            {state === 'revoked' ? (
                              <IconBtn label="Restore" tone="emerald" onClick={() => void act(c, 'restore')} disabled={busy}>
                                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                              </IconBtn>
                            ) : (
                              <IconBtn label="Revoke" tone="rose" onClick={() => void act(c, 'revoke')} disabled={busy}>
                                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Ban className="h-3.5 w-3.5" />}
                              </IconBtn>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {data?.migration_applied && (data.unattributed?.length ?? 0) > 0 && (
            <div className="mt-4">
              <Notice tone="rose" icon={<AlertTriangle className="h-4 w-4" />}>
                <span className="font-semibold">{data.unattributed_7d ?? data.unattributed.length}</span> call
                {(data.unattributed_7d ?? data.unattributed.length) === 1 ? '' : 's'} in the last 7 days presented a key that
                matches no client. Latest:{' '}
                {data.unattributed.slice(0, 3).map((r, i) => (
                  <span key={r.id}>
                    {i > 0 && ', '}
                    <code className="font-mono text-[11px]">{r.key_prefix ?? r.denial}</code> from {r.ip ?? '?'} {relative(r.created_at)}
                  </span>
                ))}
                . A revoked key being retried is normal; an unknown prefix is someone guessing.
              </Notice>
            </div>
          )}
        </div>
      </div>

      <div className="mt-3 flex items-start gap-2 px-1 text-[11px] text-zinc-400 dark:text-zinc-500">
        <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          Keys are stored only as a salted hash — we cannot show a key again after it is issued. Off-boarded people are never
          returned, whatever the caller asks for. A hidden column is neither returned nor filterable. Every call, allowed or
          denied, is logged with its IP and user-agent, and the rate limit is counted from that log so it holds everywhere.
        </span>
      </div>

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
              A new key is issued and shown once. The current key (
              <code className="font-mono text-[11px]">{confirmRotate?.key_prefix}…</code>) stops working immediately. The client,
              its columns, expiry, limit and history stay.
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

function Notice({ tone, icon, children }: { tone: 'amber' | 'rose'; icon: React.ReactNode; children: React.ReactNode }) {
  const cls =
    tone === 'amber'
      ? 'border-amber-200/70 bg-amber-50/60 text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/20 dark:text-amber-300'
      : 'border-rose-200/70 bg-rose-50/60 text-rose-800 dark:border-rose-900/40 dark:bg-rose-950/20 dark:text-rose-300';
  return (
    <div className={cn('flex items-start gap-2 rounded-xl border px-3 py-2.5 text-xs', cls)}>
      <span className="mt-0.5 shrink-0">{icon}</span>
      <p className="min-w-0">{children}</p>
    </div>
  );
}

function IconBtn({
  label,
  tone,
  onClick,
  disabled,
  children,
}: {
  label: string;
  tone?: 'rose' | 'emerald';
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  const toneCls =
    tone === 'rose'
      ? 'border-rose-200 text-rose-700 hover:bg-rose-50 dark:border-rose-900/50 dark:text-rose-300 dark:hover:bg-rose-950/40'
      : tone === 'emerald'
        ? 'border-emerald-200 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-900/50 dark:text-emerald-300 dark:hover:bg-emerald-950/40'
        : 'border-zinc-200 text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800';
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'inline-flex h-7 items-center gap-1 rounded-md border px-2 text-[11px] font-medium transition disabled:opacity-50',
        toneCls,
      )}
    >
      {children}
      <span className="hidden xl:inline">{label}</span>
    </button>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">{label}</span>
      {children}
      {hint && <span className="text-[11px] text-zinc-400 dark:text-zinc-500">{hint}</span>}
    </label>
  );
}

// ─── The three access controls ────────────────────────────────────────────────

const GROUP_ORDER: CatalogGroup[] = ['identity', 'work', 'contact', 'address', 'photo', 'system'];

/** Whole table by default; untick to hide. Sensitive columns carry a badge. */
function ColumnPicker({ ticked, onChange }: { ticked: string[]; onChange: (next: string[]) => void }) {
  const all = ticked.length === OFFERABLE_COLUMNS.length;
  const hidden = OFFERABLE_COLUMNS.length - ticked.length;
  const toggle = (col: string) => onChange(ticked.includes(col) ? ticked.filter((c) => c !== col) : [...ticked, col]);
  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-800">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-100 bg-zinc-50/70 px-3 py-2 dark:border-zinc-800/80 dark:bg-zinc-900/40">
        <div className="text-xs">
          <span className="font-semibold text-zinc-800 dark:text-zinc-100">{GML_TABLE_LABEL}</span>{' '}
          <span className="text-zinc-500 dark:text-zinc-400">
            {all ? '· whole table' : `· ${ticked.length} of ${OFFERABLE_COLUMNS.length} columns, ${hidden} hidden`}
          </span>
        </div>
        <div className="flex gap-1">
          <button
            type="button"
            onClick={() => onChange([...OFFERABLE_COLUMNS])}
            className="rounded-md border border-zinc-200 px-2 py-0.5 text-[11px] font-medium text-zinc-600 hover:bg-white dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            Whole table
          </button>
          <button
            type="button"
            onClick={() => onChange(OFFERABLE_COLUMNS.filter((c) => !SENSITIVE_COLUMNS.includes(c)))}
            className="rounded-md border border-zinc-200 px-2 py-0.5 text-[11px] font-medium text-zinc-600 hover:bg-white dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            Hide sensitive
          </button>
          <button
            type="button"
            onClick={() => onChange([])}
            className="rounded-md border border-zinc-200 px-2 py-0.5 text-[11px] font-medium text-zinc-600 hover:bg-white dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            None
          </button>
        </div>
      </div>
      <div className="grid gap-3 p-3 sm:grid-cols-2">
        {GROUP_ORDER.map((g) => {
          const cols = GML_CATALOG.filter((c) => c.group === g);
          if (!cols.length) return null;
          return (
            <div key={g}>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">{GROUP_LABELS[g]}</div>
              <div className="flex flex-col gap-1">
                {cols.map((c) => {
                  const on = ticked.includes(c.name);
                  return (
                    <label key={c.name} className="flex cursor-pointer items-center gap-2 text-xs text-zinc-700 dark:text-zinc-300" title={c.description}>
                      <input type="checkbox" checked={on} onChange={() => toggle(c.name)} className="h-3.5 w-3.5 accent-orange-600" />
                      <span className={cn('font-mono text-[11px]', !on && 'text-zinc-400 line-through dark:text-zinc-500')}>{c.name}</span>
                      {c.sensitive && (
                        <span className="rounded-full border border-amber-300/70 bg-amber-50 px-1.5 text-[9px] font-semibold uppercase tracking-wide text-amber-700 dark:border-amber-800/50 dark:bg-amber-950/30 dark:text-amber-300">
                          sensitive
                        </span>
                      )}
                    </label>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      <div className="border-t border-zinc-100 px-3 py-1.5 text-[11px] text-zinc-400 dark:border-zinc-800/80 dark:text-zinc-500">
        <code className="font-mono">id</code> always rides along (it is the page cursor). A hidden column is neither returned nor
        filterable.
      </div>
    </div>
  );
}

function ExpiryPicker({ value, onChange, allowKeep, keepLabel }: { value: ExpiryOption | 'keep'; onChange: (v: ExpiryOption | 'keep') => void; allowKeep?: boolean; keepLabel?: string }) {
  const opts: Array<ExpiryOption | 'keep'> = allowKeep ? ['keep', ...EXPIRY_OPTIONS] : [...EXPIRY_OPTIONS];
  return (
    <div className="flex flex-wrap gap-1.5">
      {opts.map((o) => {
        const on = value === o;
        return (
          <button
            key={o}
            type="button"
            onClick={() => onChange(o)}
            aria-pressed={on}
            className={cn(
              'rounded-full border px-2.5 py-1 text-[11px] font-medium transition',
              on
                ? 'border-orange-600 bg-orange-600 text-white'
                : 'border-zinc-200 text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800',
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
      label="Rate limit (calls per minute)"
      hint={`${RATE_LIMIT_FLOOR}–${RATE_LIMIT_CEILING}. REST and MCP share one budget; a full roster pull is 8 calls. Default ${RATE_LIMIT_DEFAULT}.`}
    >
      <Input
        type="number"
        inputMode="numeric"
        min={RATE_LIMIT_FLOOR}
        max={RATE_LIMIT_CEILING}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn('w-40 font-mono text-sm', parsed === null && 'border-rose-400')}
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

  useEffect(() => {
    if (open) {
      setName('');
      setSystem('');
      setContact('');
      setTicked([...OFFERABLE_COLUMNS]);
      setExpiry(DEFAULT_EXPIRY);
      setLimit(String(RATE_LIMIT_DEFAULT));
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

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New external client</DialogTitle>
          <DialogDescription>
            One client per system. Who it is for, what will call, which columns it may read, how long the key lives and how
            often it may call. Everything but the key can be changed later.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Client name" hint="e.g. Ops team roster mirror">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Who is this for?" maxLength={80} autoFocus />
            </Field>
            <Field label="System" hint="e.g. n8n · Google Sheets script · Claude Desktop (MCP)">
              <Input value={system} onChange={(e) => setSystem(e.target.value)} placeholder="What will call us?" maxLength={80} />
            </Field>
          </div>
          <Field label="Contact email (optional)" hint="Whom to reach when it misbehaves">
            <Input type="email" value={contact} onChange={(e) => setContact(e.target.value)} placeholder="name@simple.biz" />
          </Field>
          <Field label="Columns they may read">
            <ColumnPicker ticked={ticked} onChange={setTicked} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Key lives for" hint="Counted from now. It can always be revoked before then.">
              <ExpiryPicker value={expiry} onChange={setExpiry} />
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
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Create &amp; show key
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
            Key <code className="font-mono text-[11px]">{client.key_prefix}…</code> stays as it is. Columns, expiry and limit
            take effect on the client&apos;s next call.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-2">
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
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="Key lives for"
              hint={`Now: ${client.expires_at ? `expires ${describeExpiry(client.expires_at)} (${fmtWhen(client.expires_at)})` : 'does not expire'}. A new choice counts from now.`}
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
  useEffect(() => {
    if (issued) setCopied(null);
  }, [issued]);

  if (!issued) return null;
  const { client, apiKey } = issued;
  const grant = client.granted_columns;
  const cols = visibleColumns(grant);
  const curl = `curl -H "Authorization: Bearer ${apiKey}" "${restUrl}?limit=100"`;
  const payload = samplePayload(grant);
  const mcp = mcpConfig(mcpUrl, apiKey);
  const expiryLine = client.expires_at ? `This key expires ${describeExpiry(client.expires_at)} (${new Date(client.expires_at).toUTCString()}).` : 'This key does not expire; we can revoke it at any time.';
  const handOff = [
    `Simple HRIS — ${GML_TABLE_LABEL} access for ${client.name} (${client.system})`,
    '',
    `API key (keep it private): ${apiKey}`,
    `${expiryLine} Limit: ${client.rate_limit_per_minute} calls per minute (REST and MCP together).`,
    '',
    `Columns you receive: ${cols.join(', ')}`,
    hiddenCount(grant) > 0 ? `(${hiddenCount(grant)} other columns are not included and cannot be filtered on.)` : '(the whole table)',
    '',
    'REST:',
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

  const copy = async (what: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      toast.success('Copied');
    } catch {
      toast.error('Clipboard blocked — select and copy by hand');
    }
  };

  const CopyBtn = ({ what, text }: { what: string; text: string }) => (
    <Button type="button" size="sm" variant="outline" onClick={() => void copy(what, text)} className="shrink-0 gap-1">
      {copied === what ? <Check className="h-3.5 w-3.5" /> : <CopyIcon className="h-3.5 w-3.5" />} Copy
    </Button>
  );

  return (
    <Dialog open={!!issued} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{issued.mode === 'rotated' ? 'New key issued' : 'Client created'} — the hand-off</DialogTitle>
          <DialogDescription>
            This is the <span className="font-semibold text-zinc-800 dark:text-zinc-100">only time</span> the key is shown. Send the
            hand-off to {client.contact_email ?? 'the owner'} over a private channel. If it is lost, rotate.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="rounded-xl border border-amber-200/70 bg-amber-50/60 p-3 dark:border-amber-900/40 dark:bg-amber-950/20">
            <div className="mb-1 flex flex-wrap items-center justify-between gap-2 text-[11px] font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-300">
              <span>
                {client.name} · {client.system}
              </span>
              <span className="normal-case tracking-normal">
                {client.expires_at ? `expires ${describeExpiry(client.expires_at)}` : 'does not expire'} · {client.rate_limit_per_minute}/min ·{' '}
                {hiddenCount(grant) === 0 ? 'whole table' : `${cols.length} columns`}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 break-all rounded bg-white/80 px-2 py-1.5 font-mono text-xs text-zinc-900 dark:bg-zinc-950/60 dark:text-zinc-100">
                {apiKey}
              </code>
              <CopyBtn what="key" text={apiKey} />
            </div>
          </div>

          <Block title="Everything, ready to paste to them" action={<CopyBtn what="all" text={handOff} />}>
            <pre className="max-h-40 overflow-auto rounded-lg bg-zinc-900 p-2.5 font-mono text-[11px] leading-relaxed text-zinc-100">
              {handOff.replace(apiKey, `${apiKey.slice(0, 16)}…`)}
            </pre>
          </Block>

          <div className="grid gap-3 sm:grid-cols-2">
            <Block title="REST — try it" action={<CopyBtn what="curl" text={curl} />}>
              <pre className="overflow-x-auto rounded-lg bg-zinc-900 p-2.5 font-mono text-[11px] leading-relaxed text-zinc-100">
                {`curl -H "Authorization: Bearer ${apiKey.slice(0, 16)}…" \\\n  "${restUrl}?limit=100"`}
              </pre>
            </Block>
            <Block title="MCP — client config" action={<CopyBtn what="mcp" text={mcp} />}>
              <pre className="overflow-x-auto rounded-lg bg-zinc-900 p-2.5 font-mono text-[11px] leading-relaxed text-zinc-100">
                {mcp.replace(apiKey, `${apiKey.slice(0, 16)}…`)}
              </pre>
            </Block>
          </div>

          <Block title={`Sample payload — ${cols.length} columns`} action={<CopyBtn what="payload" text={payload} />}>
            <pre className="max-h-48 overflow-auto rounded-lg bg-zinc-900 p-2.5 font-mono text-[11px] leading-relaxed text-zinc-100">{payload}</pre>
          </Block>
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

function Block({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">{title}</div>
        {action}
      </div>
      {children}
    </div>
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
          <DialogTitle className="flex items-center gap-2">
            <Eye className="h-4 w-4" /> {client?.name} — recent calls
          </DialogTitle>
          <DialogDescription>
            {client?.system} · key <code className="font-mono text-[11px]">{client?.key_prefix}…</code> · newest first, up to 100.
            GET = REST, POST = MCP. A 429 is a throttled call.
          </DialogDescription>
        </DialogHeader>
        {loading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-zinc-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : !rows || rows.length === 0 ? (
          <div className="py-6 text-center text-sm text-zinc-500">No calls recorded yet.</div>
        ) : (
          <div className="max-h-[60vh] overflow-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-white dark:bg-zinc-950">
                <tr className="border-b border-zinc-100 text-left text-[10px] font-semibold uppercase tracking-wider text-zinc-400 dark:border-zinc-800">
                  <th className="py-1.5 pr-2">When</th>
                  <th className="py-1.5 pr-2">Via</th>
                  <th className="py-1.5 pr-2">Status</th>
                  <th className="py-1.5 pr-2">Query</th>
                  <th className="py-1.5 pr-2 text-right">Rows</th>
                  <th className="py-1.5 pr-2 text-right">ms</th>
                  <th className="py-1.5 pr-2">IP</th>
                  <th className="py-1.5">User-agent</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-zinc-50 align-top last:border-0 dark:border-zinc-800/60">
                    <td className="whitespace-nowrap py-1.5 pr-2 text-zinc-600 dark:text-zinc-400">{fmtWhen(r.created_at)}</td>
                    <td className="py-1.5 pr-2 font-mono text-[10px] text-zinc-500">{r.method === 'POST' ? 'MCP' : 'REST'}</td>
                    <td className="py-1.5 pr-2">
                      <span
                        className={cn(
                          'rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold',
                          r.status < 300
                            ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
                            : r.status === 429
                              ? 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300'
                              : 'bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300',
                        )}
                      >
                        {r.status}
                        {r.denial ? ` ${r.denial}` : ''}
                      </span>
                    </td>
                    <td className="max-w-[220px] truncate py-1.5 pr-2 font-mono text-[10px] text-zinc-600 dark:text-zinc-400" title={r.query ? JSON.stringify(r.query) : ''}>
                      {r.query ? JSON.stringify(r.query) : '—'}
                    </td>
                    <td className="py-1.5 pr-2 text-right tabular-nums text-zinc-700 dark:text-zinc-300">{r.row_count ?? '—'}</td>
                    <td className="py-1.5 pr-2 text-right tabular-nums text-zinc-500">{r.duration_ms ?? '—'}</td>
                    <td className="whitespace-nowrap py-1.5 pr-2 font-mono text-[10px] text-zinc-600 dark:text-zinc-400">{r.ip ?? '—'}</td>
                    <td className="max-w-[220px] truncate py-1.5 text-zinc-500" title={r.user_agent ?? ''}>
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
