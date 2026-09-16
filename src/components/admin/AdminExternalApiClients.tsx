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
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

/**
 * Admin → API tokens → "External access".
 *
 * The registry of OUTSIDE systems allowed to read the Global Master List through
 * /api/external/v1/global-master-list, and the log of what they did with it.
 *
 * Rules this panel enforces in the UI (the routes enforce them again):
 *  - The key is shown ONCE, in the dialog that created or rotated it. Closing
 *    that dialog is the last time anyone sees it; the table shows a prefix only.
 *  - Revoke is instant and reversible (Restore). Rotate keeps the client and its
 *    history and hands out a new key. Nothing here deletes a client.
 *  - The Calls view is the answer to "what system is using this and when".
 */

type ClientView = {
  id: string;
  name: string;
  system: string;
  contact_email: string | null;
  key_prefix: string;
  scopes: string[];
  created_by: string;
  created_at: string;
  revoked_at: string | null;
  revoked_by: string | null;
  rotated_at: string | null;
  rotated_by: string | null;
  last_used_at: string | null;
  calls_7d: number;
  denied_7d: number;
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
  error?: string;
};

const ENDPOINT_PATH = '/api/external/v1/global-master-list';

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

export default function AdminExternalApiClients() {
  const [data, setData] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
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
  const live = useMemo(() => clients.filter((c) => !c.revoked_at).length, [clients]);

  return (
    <section className="mt-8">
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-zinc-900 dark:text-white">External access</h2>
          <p className="mt-0.5 text-sm text-zinc-500 dark:text-zinc-400">
            Keys for outside systems that read the Global Master List through our API. Read-only, active people
            only, one table. Revoke any key here and it stops working on its next call.
          </p>
        </div>
        <Button
          type="button"
          onClick={() => setCreateOpen(true)}
          disabled={loading || !data?.migration_applied || !data?.configured}
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
              <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Global Master List — read API</h3>
              <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                <code className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-[11px] text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                  GET {origin}
                  {ENDPOINT_PATH}
                </code>{' '}
                with{' '}
                <code className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-[11px] text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                  Authorization: Bearer hris_live_…
                </code>
                . Filters: <code className="font-mono text-[11px]">department</code>,{' '}
                <code className="font-mono text-[11px]">email</code>, <code className="font-mono text-[11px]">search</code>,{' '}
                <code className="font-mono text-[11px]">limit</code> (≤500), <code className="font-mono text-[11px]">cursor</code>.
                60 calls per minute per key.
              </p>
            </div>
          </div>
          {!loading && data && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-zinc-300/70 bg-zinc-50 px-2.5 py-1 text-[11px] font-semibold text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
              {live} live · {clients.length - live} revoked
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
                    <th className="py-2 pr-3">System</th>
                    <th className="py-2 pr-3">Key</th>
                    <th className="py-2 pr-3">Status</th>
                    <th className="py-2 pr-3">Last used</th>
                    <th className="py-2 pr-3 text-right">7d calls</th>
                    <th className="py-2 pl-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {clients.map((c) => {
                    const revoked = !!c.revoked_at;
                    const busy = busyId === c.id;
                    return (
                      <tr key={c.id} className="border-b border-zinc-50 last:border-0 dark:border-zinc-800/60">
                        <td className="py-2.5 pr-3">
                          <div className="font-medium text-zinc-900 dark:text-zinc-100">{c.name}</div>
                          <div className="text-[11px] text-zinc-400 dark:text-zinc-500">
                            {c.contact_email ?? 'no contact'} · by {c.created_by.split('@')[0]} {relative(c.created_at)}
                          </div>
                        </td>
                        <td className="py-2.5 pr-3 text-zinc-700 dark:text-zinc-300">{c.system}</td>
                        <td className="py-2.5 pr-3">
                          <code className="font-mono text-xs text-zinc-700 dark:text-zinc-300">{c.key_prefix}…</code>
                          {c.rotated_at && (
                            <div className="text-[11px] text-zinc-400 dark:text-zinc-500">rotated {relative(c.rotated_at)}</div>
                          )}
                        </td>
                        <td className="py-2.5 pr-3">
                          {revoked ? (
                            <span className="inline-flex items-center gap-1 rounded-full border border-rose-300/70 bg-rose-50 px-2 py-0.5 text-[11px] font-semibold text-rose-700 dark:border-rose-800/50 dark:bg-rose-950/30 dark:text-rose-300">
                              <Ban className="h-3 w-3" /> Revoked
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
                        </td>
                        <td className="py-2.5 pl-3">
                          <div className="flex justify-end gap-1">
                            <IconBtn label="Calls" onClick={() => setCallsFor(c)} disabled={busy}>
                              <ListOrdered className="h-3.5 w-3.5" />
                            </IconBtn>
                            <IconBtn label="Rotate key" onClick={() => setConfirmRotate(c)} disabled={busy}>
                              <RefreshCw className="h-3.5 w-3.5" />
                            </IconBtn>
                            {revoked ? (
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
          returned, whatever the caller asks for. Every call, allowed or denied, is logged with its IP and user-agent.
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

      <IssuedKeyDialog issued={issued} onClose={() => setIssued(null)} endpoint={`${origin}${ENDPOINT_PATH}`} />

      <CallsDialog client={callsFor} onClose={() => setCallsFor(null)} />

      <Dialog open={!!confirmRotate} onOpenChange={(o) => !o && setConfirmRotate(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Rotate {confirmRotate?.name}&apos;s key?</DialogTitle>
            <DialogDescription>
              A new key is issued and shown once. The current key (
              <code className="font-mono text-[11px]">{confirmRotate?.key_prefix}…</code>) stops working immediately. The client,
              its history and its 7-day counts stay.
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
      <span className="hidden lg:inline">{label}</span>
    </button>
  );
}

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
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setName('');
      setSystem('');
      setContact('');
    }
  }, [open]);

  const submit = async () => {
    if (!name.trim() || !system.trim()) {
      toast.error('Name and system are both required');
      return;
    }
    setSaving(true);
    try {
      const r = await fetch('/api/admin/external-api-clients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), system: system.trim(), contact_email: contact.trim() || null }),
      });
      const body = await readJson<{ client: ClientView; api_key: string }>(r);
      if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
      onCreated({ ...body.client, calls_7d: 0, denied_7d: 0 }, body.api_key);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not create client');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New external client</DialogTitle>
          <DialogDescription>
            One client per system. The name is who it is for; the system is what will be calling — that is what the log
            reports back to you.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Field label="Client name" hint="e.g. Ops team roster mirror">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Who is this for?" maxLength={80} autoFocus />
          </Field>
          <Field label="System" hint="e.g. n8n · Google Sheets script · Retool">
            <Input value={system} onChange={(e) => setSystem(e.target.value)} placeholder="What will call us?" maxLength={80} />
          </Field>
          <Field label="Contact email (optional)" hint="Whom to reach when it misbehaves">
            <Input
              type="email"
              value={contact}
              onChange={(e) => setContact(e.target.value)}
              placeholder="name@simple.biz"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !saving) void submit();
              }}
            />
          </Field>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            type="button"
            className="gap-1.5 bg-orange-600 text-white hover:bg-orange-700"
            onClick={() => void submit()}
            disabled={saving || !name.trim() || !system.trim()}
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Create &amp; show key
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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

function IssuedKeyDialog({
  issued,
  onClose,
  endpoint,
}: {
  issued: { client: ClientView; apiKey: string; mode: 'created' | 'rotated' } | null;
  onClose: () => void;
  endpoint: string;
}) {
  const [copied, setCopied] = useState<'key' | 'curl' | null>(null);
  useEffect(() => {
    if (issued) setCopied(null);
  }, [issued]);

  const copy = async (what: 'key' | 'curl') => {
    if (!issued) return;
    const text =
      what === 'key' ? issued.apiKey : `curl -H "Authorization: Bearer ${issued.apiKey}" "${endpoint}?limit=100"`;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      toast.success(what === 'key' ? 'Key copied' : 'curl example copied');
    } catch {
      toast.error('Clipboard blocked — select and copy by hand');
    }
  };

  return (
    <Dialog open={!!issued} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{issued?.mode === 'rotated' ? 'New key issued' : 'Client created'}</DialogTitle>
          <DialogDescription>
            This is the <span className="font-semibold text-zinc-800 dark:text-zinc-100">only time</span> the key is shown. Copy it
            now and send it to {issued?.client.contact_email ?? 'the owner'} over a private channel. If it is lost, rotate.
          </DialogDescription>
        </DialogHeader>
        {issued && (
          <div className="flex flex-col gap-3">
            <div className="rounded-xl border border-amber-200/70 bg-amber-50/60 p-3 dark:border-amber-900/40 dark:bg-amber-950/20">
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-300">
                {issued.client.name} · {issued.client.system}
              </div>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 break-all rounded bg-white/80 px-2 py-1.5 font-mono text-xs text-zinc-900 dark:bg-zinc-950/60 dark:text-zinc-100">
                  {issued.apiKey}
                </code>
                <Button type="button" size="sm" variant="outline" onClick={() => void copy('key')} className="shrink-0 gap-1">
                  {copied === 'key' ? <Check className="h-3.5 w-3.5" /> : <CopyIcon className="h-3.5 w-3.5" />} Copy
                </Button>
              </div>
            </div>
            <div>
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">Try it</div>
              <div className="flex items-start gap-2">
                <pre className="min-w-0 flex-1 overflow-x-auto rounded-lg bg-zinc-900 p-2.5 font-mono text-[11px] leading-relaxed text-zinc-100">
                  {`curl -H "Authorization: Bearer ${issued.apiKey.slice(0, 16)}…" \\\n  "${endpoint}?limit=100"`}
                </pre>
                <Button type="button" size="sm" variant="outline" onClick={() => void copy('curl')} className="shrink-0 gap-1">
                  {copied === 'curl' ? <Check className="h-3.5 w-3.5" /> : <CopyIcon className="h-3.5 w-3.5" />} Copy
                </Button>
              </div>
              <p className="mt-1.5 text-[11px] text-zinc-400 dark:text-zinc-500">
                Response: <code className="font-mono">{'{ data: [...], page: { next_cursor }, meta }'}</code>. Pass{' '}
                <code className="font-mono">cursor=&lt;next_cursor&gt;</code> until it is null. 60 calls/min.
              </p>
            </div>
          </div>
        )}
        <DialogFooter>
          <Button type="button" className="bg-zinc-900 text-white hover:bg-zinc-800 dark:bg-white dark:text-zinc-900" onClick={onClose}>
            I have copied it
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

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
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Eye className="h-4 w-4" /> {client?.name} — recent calls
          </DialogTitle>
          <DialogDescription>
            {client?.system} · key <code className="font-mono text-[11px]">{client?.key_prefix}…</code> · newest first, up to 100.
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
