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
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
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
];

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

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

  const save = async () => {
    if (Object.keys(validationErrors).length) {
      toast.error('Fix validation errors before saving.');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/app-settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          key: SETTINGS_KEY,
          value: JSON.stringify(
            entries.map((e) => ({ ...e, updated_at: new Date().toISOString() })),
          ),
        }),
      });
      const json = (await res.json()) as { error: string | null };
      if (json.error) throw new Error(json.error);
      toast.success('Webhooks saved.');
      setDirty(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setSaving(false);
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
      <header className="flex items-center justify-between gap-4 border-b border-zinc-200 px-6 py-4 dark:border-zinc-800">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-to-br from-orange-500 to-orange-600 text-white shadow-md shadow-orange-500/30">
            <Webhook className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-xl font-bold text-zinc-900 dark:text-white">Webhooks &amp; Automations</h2>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Configure outbound webhooks. Set <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">slug</code> values used by code.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={add} className="gap-1.5">
            <Plus className="h-4 w-4" /> Add webhook
          </Button>
          <Button onClick={save} disabled={!dirty || saving} className="gap-1.5">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save changes
          </Button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="mb-4 grid gap-2">
          {KNOWN_SLUGS.map((k) => {
            const entry = entries.find((e) => e.slug === k.slug);
            const url = entry?.url || '';
            const isActive = !!(entry?.active && url);
            const status: 'active' | 'inactive' | 'missing' = isActive
              ? 'active'
              : url
                ? 'inactive'
                : 'missing';
            const palette = {
              active:   'border-emerald-200 bg-emerald-50/60 dark:border-emerald-900/60 dark:bg-emerald-950/30',
              inactive: 'border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/40',
              missing:  'border-amber-200 bg-amber-50/60 dark:border-amber-900/60 dark:bg-amber-950/30',
            }[status];
            const dot = {
              active:   'bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,0.25)]',
              inactive: 'bg-zinc-400',
              missing:  'bg-amber-500',
            }[status];
            const label = {
              active:   'Active',
              inactive: 'Saved (toggle off)',
              missing:  'Not set',
            }[status];
            return (
              <div key={k.slug} className={cn('flex flex-wrap items-center gap-3 rounded-lg border px-4 py-3 text-sm', palette)}>
                <div className="flex items-center gap-2">
                  <span className={cn('inline-flex h-2 w-2 rounded-full', dot)} />
                  <span className="font-mono text-xs font-semibold text-zinc-700 dark:text-zinc-300">
                    {k.slug}
                  </span>
                  <span className="rounded-full border border-zinc-300 bg-white px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400">
                    {label}
                  </span>
                </div>
                <span className="text-xs text-zinc-500 dark:text-zinc-400">→</span>
                {url ? (
                  <code
                    className={cn(
                      'flex-1 truncate rounded bg-white px-2 py-1 font-mono text-xs dark:bg-zinc-900',
                      isActive
                        ? 'text-emerald-700 dark:text-emerald-300'
                        : 'text-zinc-600 dark:text-zinc-400',
                    )}
                    title={url}
                  >
                    {url}
                  </code>
                ) : (
                  <span className="flex-1 text-xs italic text-amber-700 dark:text-amber-300">
                    No webhook URL set — falling back to N8N_DISPATCH_WEBHOOK_URL env var
                  </span>
                )}
                {url && (
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard?.writeText(url);
                      toast.success('URL copied');
                    }}
                    className="text-[11px] font-medium text-zinc-700 underline-offset-2 hover:underline dark:text-zinc-300"
                  >
                    Copy
                  </button>
                )}
              </div>
            );
          })}
        </div>

        <div className="grid gap-3">
          {entries.length === 0 && (
            <div className="rounded-lg border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
              No webhooks configured yet. Click <strong>Add webhook</strong> to create one.
            </div>
          )}
          {entries.map((entry) => {
            const err = validationErrors[entry.id];
            return (
              <Card
                key={entry.id}
                className={cn(
                  'border-zinc-200 transition dark:border-zinc-800',
                  err && 'border-red-300 dark:border-red-900/60',
                  entry.active && !err && 'border-l-4 border-l-emerald-500',
                  !entry.active && 'opacity-80',
                )}
              >
                <CardContent className="space-y-3 p-4">
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={entry.active}
                        onCheckedChange={(v) => update(entry.id, { active: !!v })}
                        aria-label="Active"
                      />
                      <span className="flex items-center gap-1 text-xs font-medium text-zinc-600 dark:text-zinc-400">
                        {entry.active ? (
                          <>
                            <Power className="h-3 w-3 text-emerald-500" /> Active
                          </>
                        ) : (
                          <>
                            <PowerOff className="h-3 w-3 text-zinc-400" /> Inactive
                          </>
                        )}
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
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => remove(entry.id)}
                        className="gap-1.5 text-red-600 hover:bg-red-500/10 hover:text-red-700"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>

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

                  <label className="block space-y-1.5">
                    <span className="flex items-center gap-1.5 text-xs font-medium text-zinc-600 dark:text-zinc-400">
                      <LinkIcon className="h-3 w-3" /> Webhook URL
                    </span>
                    <Input
                      value={entry.url}
                      onChange={(e) => update(entry.id, { url: e.target.value })}
                      placeholder="https://n8n.example.com/webhook/..."
                      className="font-mono text-sm"
                    />
                  </label>

                  {entry.description && (
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">{entry.description}</p>
                  )}

                  {err ? (
                    <div className="flex items-center gap-1.5 text-xs text-red-600">
                      <AlertCircle className="h-3.5 w-3.5" /> {err}
                    </div>
                  ) : entry.active && entry.url ? (
                    <div className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
                      <CheckCircle2 className="h-3.5 w-3.5" /> Ready
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            );
          })}
        </div>

        <div className="mt-6 rounded-lg border border-blue-200 bg-blue-50/60 p-4 text-xs text-blue-900 dark:border-blue-900/60 dark:bg-blue-950/30 dark:text-blue-200">
          <p className="font-semibold">How this works</p>
          <p className="mt-1">
            Code looks up webhooks by <code className="font-mono">slug</code>. The active URL for that slug overrides
            the <code className="font-mono">N8N_DISPATCH_WEBHOOK_URL</code> environment variable. To add a new
            automation, give it a slug here and reference it from the API route.
          </p>
        </div>
      </div>
    </div>
  );
}
