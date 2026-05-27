'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Webhook,
  Plus,
  Trash2,
  Save,
  Link as LinkIcon,
  Loader2,
  Power,
  PowerOff,
  Send,
  CheckCircle2,
  AlertCircle,
  Copy as CopyIcon,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

const SETTINGS_KEY = 'webhooks.config';

interface WebhookEntry {
  id: string;
  slug: string;          // stable identifier used by code, e.g. 'paystub_dispatch'
  label: string;         // human label
  url: string;
  active: boolean;
  description?: string;
  updated_at?: string;
}

const KNOWN_SLUGS: Array<{ slug: string; label: string; description: string }> = [
  {
    slug: 'paystub_dispatch',
    label: 'Paystub Dispatch (n8n)',
    description: 'Used by Payroll Wizard Step 5 to dispatch paystubs.',
  },
  {
    slug: 'create_workspace_account',
    label: 'Create Workspace Account (n8n)',
    description:
      'Used by HR Onboarding "Save and stage hire" to provision the Hubstaff workspace account.',
  },
  {
    slug: 'hubstaff_invite_user',
    label: 'Hubstaff Invite User (n8n)',
    description:
      'Fired by the HR Pending-Hires "Promote" button to invite the new hire to Hubstaff.',
  },
  {
    slug: 'onboarding_send',
    label: 'Onboarding Email Send (n8n)',
    description:
      'Sends the onboarding invite email. Used by HR Onboarding "Send" (falls back to the legacy hr.onboarding_webhook_url key).',
  },
  {
    slug: 'offboarding',
    label: 'Offboarding (n8n)',
    description:
      'Fired by the HR Offboarding "Confirm offboard" button to deactivate the workspace account and send the termination notice.',
  },
];

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

type WebhookStatus = 'active' | 'inactive' | 'missing';

/** active = toggled on + valid URL; inactive = URL saved but toggle off;
 *  missing = no URL yet. */
function entryStatus(entry: { url: string; active: boolean }): WebhookStatus {
  const url = entry.url.trim();
  if (entry.active && /^https?:\/\//i.test(url)) return 'active';
  return url ? 'inactive' : 'missing';
}

const STATUS_META: Record<
  WebhookStatus,
  { label: string; dot: string; pill: string; border: string }
> = {
  active: {
    label: 'Active',
    dot: 'bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,0.25)]',
    pill: 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300',
    border: 'border-l-emerald-500',
  },
  inactive: {
    label: 'Toggle off',
    dot: 'bg-zinc-400',
    pill: 'border-zinc-300 bg-zinc-100 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-400',
    border: 'border-l-zinc-300 dark:border-l-zinc-700',
  },
  missing: {
    label: 'No URL set',
    dot: 'bg-amber-500',
    pill: 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300',
    border: 'border-l-amber-400',
  },
};

function makeDefault(): WebhookEntry[] {
  return KNOWN_SLUGS.map((k) => ({
    id: uid(),
    slug: k.slug,
    label: k.label,
    description: k.description,
    url: '',
    active: false,
  }));
}

export default function AdminWebhooks() {
  const [entries, setEntries] = useState<WebhookEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/app-settings?key=${SETTINGS_KEY}`);
        const json = (await res.json()) as { value: string | null };
        if (cancelled) return;
        let parsed: WebhookEntry[] = [];
        if (json.value) {
          try {
            const raw = JSON.parse(json.value) as WebhookEntry[];
            parsed = Array.isArray(raw) ? raw : [];
          } catch {
            parsed = [];
          }
        }
        // Ensure known slugs are present (add missing as inactive defaults).
        const present = new Set(parsed.map((p) => p.slug));
        const merged = [
          ...parsed,
          ...KNOWN_SLUGS.filter((k) => !present.has(k.slug)).map((k) => ({
            id: uid(),
            slug: k.slug,
            label: k.label,
            description: k.description,
            url: '',
            active: false,
          })),
        ];
        setEntries(merged.length ? merged : makeDefault());
      } catch {
        if (!cancelled) setEntries(makeDefault());
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const update = (id: string, patch: Partial<WebhookEntry>) => {
    setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch } : e)));
    setDirty(true);
  };

  const remove = (id: string) => {
    setEntries((prev) => prev.filter((e) => e.id !== id));
    setDirty(true);
  };

  const add = () => {
    setEntries((prev) => [
      ...prev,
      { id: uid(), slug: '', label: '', url: '', active: true },
    ]);
    setDirty(true);
  };

  const copyUrl = (url: string) => {
    if (!url) return;
    navigator.clipboard?.writeText(url);
    toast.success('URL copied');
  };

  const activeCount = entries.filter((e) => entryStatus(e) === 'active').length;

  const validationErrors = useMemo(() => {
    const errs: Record<string, string> = {};
    const slugs = new Set<string>();
    for (const e of entries) {
      if (!e.slug.trim()) errs[e.id] = 'Slug required';
      else if (slugs.has(e.slug)) errs[e.id] = 'Duplicate slug';
      else slugs.add(e.slug);
      if (e.active && !/^https?:\/\//i.test(e.url)) {
        errs[e.id] = errs[e.id] || 'URL must start with http(s)://';
      }
    }
    return errs;
  }, [entries]);

  const persist = async (list: WebhookEntry[], opts?: { silent?: boolean }) => {
    const res = await fetch('/api/app-settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        key: SETTINGS_KEY,
        value: JSON.stringify(
          list.map((e) => ({ ...e, updated_at: new Date().toISOString() })),
        ),
      }),
    });
    const json = (await res.json()) as { error: string | null };
    if (json.error) throw new Error(json.error);
    if (!opts?.silent) toast.success('Webhooks saved.');
    setDirty(false);
  };

  const save = async () => {
    if (Object.keys(validationErrors).length) {
      toast.error('Fix validation errors before saving.');
      return;
    }
    setSaving(true);
    try {
      await persist(entries);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  };

  // Toggling Active persists immediately so it survives a refresh.
  const toggleActive = async (entry: WebhookEntry) => {
    const next = !entry.active;
    if (next && !/^https?:\/\//i.test(entry.url.trim())) {
      toast.error('Add a valid http(s):// URL before activating.');
      return;
    }
    const list = entries.map((e) =>
      e.id === entry.id ? { ...e, active: next } : e,
    );
    setEntries(list);
    setTogglingId(entry.id);
    try {
      await persist(list, { silent: true });
      toast.success(next ? `${entry.label || entry.slug} activated` : `${entry.label || entry.slug} turned off`);
    } catch (err) {
      // Roll back on failure.
      setEntries((prev) => prev.map((e) => (e.id === entry.id ? { ...e, active: entry.active } : e)));
      toast.error(err instanceof Error ? err.message : 'Could not save toggle.');
    } finally {
      setTogglingId(null);
    }
  };

  const sendTest = async (entry: WebhookEntry) => {
    if (!entry.url) return;
    setTesting(entry.id);
    try {
      const res = await fetch(entry.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ test: true, source: 'simple-hris-admin', slug: entry.slug, at: new Date().toISOString() }),
      });
      if (res.ok) toast.success(`Test ping → ${entry.label || entry.slug} OK (${res.status})`);
      else toast.error(`Test ping failed: ${res.status}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Network error');
    } finally {
      setTesting(null);
    }
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-orange-500" />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-zinc-200 px-6 py-4 dark:border-zinc-800">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-to-br from-orange-500 to-orange-600 text-white shadow-md shadow-orange-500/30">
            <Webhook className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-xl font-bold text-zinc-900 dark:text-white">Webhooks &amp; Automations</h2>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Each automation finds its endpoint by <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">slug</code>. Toggle <strong>Active</strong> to make this URL win over the code default.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="hidden items-center gap-1.5 rounded-full border border-zinc-200 bg-zinc-50 px-3 py-1 text-xs font-medium text-zinc-600 sm:inline-flex dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400">
            <span className="inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
            {activeCount} of {entries.length} active
          </span>
          <Button variant="outline" onClick={add} className="gap-1.5">
            <Plus className="h-4 w-4" /> Add webhook
          </Button>
          <Button onClick={save} disabled={!dirty || saving} className="gap-1.5">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {dirty ? 'Save changes' : 'Saved'}
          </Button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="grid gap-3">
          {entries.length === 0 && (
            <div className="rounded-lg border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
              No webhooks configured yet. Click <strong>Add webhook</strong> to create one.
            </div>
          )}
          {entries.map((entry) => {
            const err = validationErrors[entry.id];
            const status = entryStatus(entry);
            const meta = STATUS_META[status];
            const title = entry.label || entry.slug || 'New webhook';
            return (
              <Card
                key={entry.id}
                className={cn(
                  'overflow-hidden border-l-4 border-zinc-200 transition dark:border-zinc-800',
                  err ? 'border-l-red-500' : meta.border,
                )}
              >
                <CardContent className="p-0">
                  {/* Header band: identity + status + primary actions */}
                  <div className="flex flex-wrap items-center gap-3 border-b border-zinc-100 bg-zinc-50/70 px-4 py-3 dark:border-zinc-800/80 dark:bg-zinc-900/40">
                    <span className={cn('inline-flex h-2.5 w-2.5 shrink-0 rounded-full', meta.dot)} />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-semibold text-zinc-900 dark:text-white">
                          {title}
                        </span>
                        <span
                          className={cn(
                            'shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                            meta.pill,
                          )}
                        >
                          {meta.label}
                        </span>
                      </div>
                      <span className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
                        {entry.slug || 'no-slug'}
                      </span>
                    </div>

                    <div className="ml-auto flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!entry.url || testing === entry.id}
                        onClick={() => sendTest(entry)}
                        className="gap-1.5"
                      >
                        {testing === entry.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Send className="h-3.5 w-3.5" />
                        )}
                        Test
                      </Button>

                      {/* Prominent Active toggle — single clickable pill, persists on click */}
                      <button
                        type="button"
                        role="switch"
                        aria-checked={entry.active}
                        aria-label={entry.active ? 'Active — click to turn off' : 'Off — click to activate'}
                        disabled={togglingId === entry.id}
                        onClick={() => toggleActive(entry)}
                        className={cn(
                          'flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs font-semibold transition disabled:opacity-60',
                          entry.active
                            ? 'border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300'
                            : 'border-zinc-300 bg-white text-zinc-500 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800',
                        )}
                      >
                        {togglingId === entry.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : entry.active ? (
                          <Power className="h-3.5 w-3.5" />
                        ) : (
                          <PowerOff className="h-3.5 w-3.5" />
                        )}
                        {entry.active ? 'Active' : 'Off'}
                        {/* Visible track + thumb so the on/off state always reads clearly */}
                        <span
                          className={cn(
                            'relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors',
                            entry.active ? 'bg-emerald-500' : 'bg-zinc-300 dark:bg-zinc-600',
                          )}
                        >
                          <span
                            className={cn(
                              'inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform',
                              entry.active ? 'translate-x-3.5' : 'translate-x-0.5',
                            )}
                          />
                        </span>
                      </button>

                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => remove(entry.id)}
                        className="text-red-600 hover:bg-red-500/10 hover:text-red-700"
                        aria-label="Delete webhook"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>

                  {/* Body */}
                  <div className="space-y-3 p-4">
                    <label className="block space-y-1.5">
                      <span className="flex items-center gap-1.5 text-xs font-medium text-zinc-600 dark:text-zinc-400">
                        <LinkIcon className="h-3 w-3" /> Endpoint URL
                      </span>
                      <div className="relative">
                        <Input
                          value={entry.url}
                          onChange={(e) => update(entry.id, { url: e.target.value })}
                          placeholder="https://n8n.example.com/webhook/..."
                          className="pr-9 font-mono text-sm"
                        />
                        {entry.url && (
                          <button
                            type="button"
                            onClick={() => copyUrl(entry.url)}
                            title="Copy URL"
                            className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-1.5 text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                          >
                            <CopyIcon className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    </label>

                    <div className="grid gap-3 md:grid-cols-2">
                      <label className="space-y-1.5">
                        <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Label</span>
                        <Input
                          value={entry.label}
                          onChange={(e) => update(entry.id, { label: e.target.value })}
                          placeholder="e.g. Paystub Dispatch (n8n)"
                        />
                      </label>
                      <label className="space-y-1.5">
                        <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
                          Slug <span className="text-zinc-400">(stable code identifier)</span>
                        </span>
                        <Input
                          value={entry.slug}
                          onChange={(e) =>
                            update(entry.id, { slug: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })
                          }
                          placeholder="paystub_dispatch"
                          className="font-mono text-sm"
                        />
                      </label>
                    </div>

                    {entry.description && (
                      <p className="text-xs text-zinc-500 dark:text-zinc-400">{entry.description}</p>
                    )}

                    {err ? (
                      <div className="flex items-center gap-1.5 text-xs font-medium text-red-600">
                        <AlertCircle className="h-3.5 w-3.5" /> {err}
                      </div>
                    ) : status === 'active' ? (
                      <div className="flex items-center gap-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                        <CheckCircle2 className="h-3.5 w-3.5" /> Live &mdash; this URL is in use.
                      </div>
                    ) : status === 'inactive' ? (
                      <div className="flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
                        <PowerOff className="h-3.5 w-3.5" /> Saved but off &mdash; code falls back to its built-in default.
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
                        <AlertCircle className="h-3.5 w-3.5" /> No URL yet &mdash; code uses its built-in default.
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>

        <div className="mt-6 rounded-lg border border-blue-200 bg-blue-50/60 p-4 text-xs text-blue-900 dark:border-blue-900/60 dark:bg-blue-950/30 dark:text-blue-200">
          <p className="font-semibold">How this works</p>
          <p className="mt-1">
            Code looks up each webhook by its <code className="font-mono">slug</code>. When a slug is set to
            <strong> Active</strong>, that URL is used; otherwise the automation falls back to the URL hardcoded in
            its API route. Use <strong>Test</strong> to fire a sample ping before relying on an endpoint. Don&apos;t
            forget to <strong>Save changes</strong> &mdash; toggles and edits aren&apos;t persisted until you do.
          </p>
        </div>
      </div>
    </div>
  );
}
