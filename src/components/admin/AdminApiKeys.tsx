'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, KeyRound, Check, Trash2, Eye, EyeOff, ShieldCheck, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface KeyStatus {
  configured: boolean;
  masked: string | null;
  source: 'db' | 'env' | null;
}

export default function AdminApiKeys() {
  const [status, setStatus] = useState<KeyStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [draft, setDraft] = useState('');
  const [reveal, setReveal] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/admin/anthropic-key', { cache: 'no-store' });
      if (!r.ok) throw new Error('status fetch failed');
      setStatus((await r.json()) as KeyStatus);
    } catch {
      toast.error('Could not load API key status');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    const key = draft.trim();
    if (!key) {
      toast.error('Enter an API key first');
      return;
    }
    setSaving(true);
    try {
      const r = await fetch('/api/admin/anthropic-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
      });
      const data = (await r.json()) as KeyStatus & { error?: string };
      if (!r.ok) {
        toast.error(data.error ?? 'Failed to save key');
        return;
      }
      setStatus({ configured: data.configured, masked: data.masked, source: data.source });
      setDraft('');
      setReveal(false);
      toast.success('Anthropic API key saved');
    } catch {
      toast.error('Failed to save key');
    } finally {
      setSaving(false);
    }
  };

  const removeOverride = async () => {
    setRemoving(true);
    try {
      const r = await fetch('/api/admin/anthropic-key', { method: 'DELETE' });
      const data = (await r.json()) as KeyStatus & { error?: string };
      if (!r.ok) {
        toast.error(data.error ?? 'Failed to remove key');
        return;
      }
      setStatus({ configured: data.configured, masked: data.masked, source: data.source });
      toast.success(
        data.source === 'env'
          ? 'Removed saved key — reverted to the environment variable'
          : 'Removed saved key',
      );
    } catch {
      toast.error('Failed to remove key');
    } finally {
      setRemoving(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-white">API tokens</h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Manage the third-party API keys this workspace uses. Keys are stored server-side, shown only as a
          masked preview, and are never readable by non-admins.
        </p>
      </header>

      {/* Anthropic (Claude) API key card */}
      <div className="rounded-2xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950/60">
        <div className="flex flex-col gap-1 border-b border-zinc-100 p-5 dark:border-zinc-800/80 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-orange-50 text-orange-600 dark:bg-orange-950/40 dark:text-orange-400">
              <KeyRound className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Anthropic (Claude) API key</h2>
              <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                Powers the CEO dashboard chat assistant. A key saved here overrides the{' '}
                <code className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-[11px] text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                  ANTHROPIC_API_KEY
                </code>{' '}
                environment variable.
              </p>
            </div>
          </div>
          {!loading && status && <StatusBadge status={status} />}
        </div>

        <div className="flex flex-col gap-4 p-5">
          {loading ? (
            <div className="flex items-center gap-2 py-6 text-sm text-zinc-500 dark:text-zinc-400">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading key status…
            </div>
          ) : (
            <>
              {/* Current value */}
              <div className="flex flex-wrap items-center gap-2 rounded-xl border border-zinc-100 bg-zinc-50/70 px-3 py-2.5 dark:border-zinc-800/70 dark:bg-zinc-900/40">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
                  Current
                </span>
                {status?.configured ? (
                  <code className="font-mono text-sm text-zinc-800 dark:text-zinc-200">{status.masked}</code>
                ) : (
                  <span className="text-sm italic text-zinc-400 dark:text-zinc-500">No key configured</span>
                )}
              </div>

              {/* Set / replace */}
              <div className="flex flex-col gap-1.5">
                <label htmlFor="anthropic-key-input" className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
                  {status?.source === 'db' ? 'Replace key' : 'Set key'}
                </label>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <div className="relative flex-1">
                    <Input
                      id="anthropic-key-input"
                      type={reveal ? 'text' : 'password'}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="sk-ant-…"
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !saving) void save();
                      }}
                      className="pr-10 font-mono text-sm"
                    />
                    {draft.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setReveal((v) => !v)}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
                        aria-label={reveal ? 'Hide key' : 'Show key'}
                      >
                        {reveal ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    )}
                  </div>
                  <Button
                    type="button"
                    onClick={() => void save()}
                    disabled={saving || !draft.trim()}
                    className="shrink-0 gap-1.5 bg-orange-600 text-white hover:bg-orange-700"
                  >
                    {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                    {saving ? 'Saving…' : 'Save key'}
                  </Button>
                </div>
                <p className="text-[11px] text-zinc-400 dark:text-zinc-500">
                  Paste the full key — it&apos;s sent over HTTPS, stored server-side, and never displayed again in full.
                </p>
              </div>

              {/* Remove DB override */}
              {status?.source === 'db' && (
                <div className="flex items-center justify-between gap-3 rounded-xl border border-amber-200/70 bg-amber-50/60 px-3 py-2.5 dark:border-amber-900/40 dark:bg-amber-950/20">
                  <p className="text-xs text-amber-800 dark:text-amber-300">
                    Remove the saved key to fall back to the{' '}
                    <code className="font-mono text-[11px]">ANTHROPIC_API_KEY</code> environment variable.
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void removeOverride()}
                    disabled={removing}
                    className="shrink-0 gap-1.5 border-amber-300 text-amber-700 hover:bg-amber-100 dark:border-amber-800/60 dark:text-amber-300 dark:hover:bg-amber-950/40"
                  >
                    {removing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                    Remove
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Security note */}
      <div className="mt-4 flex items-start gap-2 px-1 text-[11px] text-zinc-400 dark:text-zinc-500">
        <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          The key is stored under a secret-scoped setting, so it&apos;s only readable by admins and is masked
          everywhere in the UI. Rotating it here takes effect immediately — no redeploy needed.
        </span>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: KeyStatus }) {
  if (!status.configured) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-300/70 bg-amber-50 px-2.5 py-1 text-[11px] font-semibold text-amber-700 dark:border-amber-800/50 dark:bg-amber-950/30 dark:text-amber-300">
        <AlertCircle className="h-3 w-3" /> Not configured
      </span>
    );
  }
  if (status.source === 'db') {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-emerald-300/70 bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-700 dark:border-emerald-800/50 dark:bg-emerald-950/30 dark:text-emerald-300">
        <Check className="h-3 w-3" /> Saved in app
      </span>
    );
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-zinc-300/70 bg-zinc-50 px-2.5 py-1 text-[11px] font-semibold text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
      <ShieldCheck className="h-3 w-3" /> From environment
    </span>
  );
}
