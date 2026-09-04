'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  Mail,
  Paperclip,
  Plus,
  RotateCcw,
  Save,
  Send,
  ShieldCheck,
  Workflow,
  X,
} from 'lucide-react';
import { DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import {
  applyRecipientOverride,
  mergePayloadOverrides,
  normalizeEmail,
  validateAutomationConfig,
  type EffectiveRecipient,
  type WebhookAutomationConfig,
  type WebhookAutomationDescriptor,
  type WebhookRecipient,
  type WebhookRecipientOverride,
} from '@/lib/webhooks/webhook-config';

/**
 * Admin → Webhooks → "Open automation" (2026-09-04).
 *
 * A mimicry of the automation as it will fire: WHO it mails (the role's holders,
 * as adjusted here), WHAT it sends (the exact payload, attachments listed by
 * name) and the ONE thing that fires it. Recipients and top-level payload keys
 * are editable; the week's facts are not — protected keys are refused by the
 * server and shown greyed here so nobody wonders why.
 *
 * Saves go through PUT /api/admin/webhooks/automation (admin-only, strict
 * validation), never through the page's generic Save — that path is for URLs.
 * "Send test run" mails the signed-in admin only, from a fictional record.
 */

interface AutomationResponse {
  slug: string;
  descriptor: WebhookAutomationDescriptor;
  entry: {
    url: string;
    active: boolean;
    label: string | null;
    recipients: WebhookRecipientOverride | null;
    payload_overrides: Record<string, unknown> | null;
    updated_at: string | null;
  } | null;
  delivery: { url: string; source: string } | null;
  defaults: WebhookRecipient[];
  effective: EffectiveRecipient[];
  payload: Record<string, unknown>;
  basePayload: Record<string, unknown>;
  protectedKeys: string[];
  error: string | null;
}

export interface WebhookAutomationDialogProps {
  slug: string;
  label: string;
  /** Called after a successful save with the persisted config, so the parent's
   *  entry list carries the same fields its own Save will write back. */
  onSaved?: (slug: string, config: WebhookAutomationConfig, updatedAt: string) => void;
}

type Draft = {
  mode: 'role' | 'custom';
  add: string[];
  remove: string[];
  custom: string[];
  overridesText: string;
};

function draftFrom(data: AutomationResponse): Draft {
  const r = data.entry?.recipients;
  return {
    mode: r?.mode ?? 'role',
    add: r?.add ?? [],
    remove: r?.remove ?? [],
    // Custom mode starts from the effective list so switching modes keeps the people.
    custom: r?.custom?.length ? r.custom : data.defaults.map((d) => d.email),
    overridesText: data.entry?.payload_overrides
      ? JSON.stringify(data.entry.payload_overrides, null, 2)
      : '{\n  \n}',
  };
}

function parseOverrides(text: string): { value: Record<string, unknown> | null; error: string | null } {
  const t = text.trim();
  if (!t || t === '{}' || /^\{\s*\}$/.test(t)) return { value: null, error: null };
  try {
    const v = JSON.parse(t) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return { value: null, error: 'Overrides must be a JSON object' };
    return { value: v as Record<string, unknown>, error: null };
  } catch (e) {
    return { value: null, error: e instanceof Error ? e.message : 'Invalid JSON' };
  }
}

export default function WebhookAutomationDialog({ slug, label, onSaved }: WebhookAutomationDialogProps) {
  const [data, setData] = useState<AutomationResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saved, setSaved] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [serverErrors, setServerErrors] = useState<string[]>([]);
  const [newEmail, setNewEmail] = useState('');

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await fetch(`/api/admin/webhooks/automation?slug=${encodeURIComponent(slug)}`, { cache: 'no-store' });
      const json = (await res.json()) as AutomationResponse;
      if (!res.ok || json.error) throw new Error(json.error ?? `HTTP ${res.status}`);
      setData(json);
      const d = draftFrom(json);
      setDraft(d);
      setSaved(d);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not load the automation');
    }
  }, [slug]);

  useEffect(() => {
    void load();
  }, [load]);

  const override: WebhookRecipientOverride | null = useMemo(() => {
    if (!draft) return null;
    if (draft.mode === 'custom') return { mode: 'custom', add: [], remove: [], custom: draft.custom };
    if (draft.add.length === 0 && draft.remove.length === 0) return null;
    return { mode: 'role', add: draft.add, remove: draft.remove, custom: [] };
  }, [draft]);

  const effective = useMemo(
    () => (data ? applyRecipientOverride(data.defaults, override).effective : []),
    [data, override],
  );

  const overrides = useMemo(() => parseOverrides(draft?.overridesText ?? ''), [draft?.overridesText]);

  const validation = useMemo(() => {
    if (!draft) return null;
    if (overrides.error) return { ok: false as const, errors: [overrides.error] };
    return validateAutomationConfig({ recipients: override, payload_overrides: overrides.value });
  }, [draft, override, overrides]);

  const preview = useMemo(() => {
    if (!data) return null;
    const base = { ...data.basePayload, recipients: effective.map((r) => ({ email: r.email, name: r.name })) };
    return mergePayloadOverrides(base, overrides.value);
  }, [data, effective, overrides.value]);

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(saved), [draft, saved]);

  const setD = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));

  const removeRecipient = (email: string) => {
    if (!draft) return;
    if (draft.mode === 'custom') {
      setD({ custom: draft.custom.filter((e) => e !== email) });
      return;
    }
    if (draft.add.includes(email)) setD({ add: draft.add.filter((e) => e !== email) });
    else if (!draft.remove.includes(email)) setD({ remove: [...draft.remove, email] });
  };

  const restoreRecipient = (email: string) => {
    if (!draft) return;
    setD({ remove: draft.remove.filter((e) => e !== email) });
  };

  const addRecipient = () => {
    if (!draft) return;
    const e = normalizeEmail(newEmail);
    if (!e) {
      toast.error('Enter a valid email address.');
      return;
    }
    if (draft.mode === 'custom') {
      if (!draft.custom.includes(e)) setD({ custom: [...draft.custom, e] });
    } else if (draft.remove.includes(e)) {
      setD({ remove: draft.remove.filter((x) => x !== e) });
    } else if (!effective.some((r) => r.email === e)) {
      setD({ add: [...draft.add, e] });
    }
    setNewEmail('');
  };

  const resetToRole = () => {
    if (!data) return;
    setD({ mode: 'role', add: [], remove: [], custom: data.defaults.map((d) => d.email) });
  };

  const save = async () => {
    if (!draft || !validation?.ok) return;
    setSaving(true);
    setServerErrors([]);
    try {
      const res = await fetch('/api/admin/webhooks/automation', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug, recipients: override, payload_overrides: overrides.value }),
      });
      const json = (await res.json()) as AutomationResponse & { errors?: string[] };
      if (!res.ok || json.error) {
        setServerErrors(json.errors ?? [json.error ?? `HTTP ${res.status}`]);
        toast.error(json.errors?.length ? 'The server refused the save — see the errors.' : json.error ?? 'Save failed');
        return;
      }
      setData(json);
      const d = draftFrom(json);
      setDraft(d);
      setSaved(d);
      onSaved?.(
        slug,
        { recipients: json.entry?.recipients ?? null, payload_overrides: json.entry?.payload_overrides ?? null },
        json.entry?.updated_at ?? new Date().toISOString(),
      );
      toast.success('Automation saved.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const sendTest = async () => {
    setTesting(true);
    try {
      const res = await fetch('/api/admin/webhooks/automation', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug }),
      });
      const json = (await res.json()) as { ok?: boolean; to?: string; status?: number | null; error?: string | null };
      if (!res.ok || !json.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      toast.success(`Test run sent to ${json.to} (n8n answered ${json.status}). Check your inbox for the three files.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Test run failed');
    } finally {
      setTesting(false);
    }
  };

  const removedRole = draft?.mode === 'role' ? draft.remove : [];
  const status = data?.entry && data.entry.active && /^https?:\/\//i.test(data.entry.url) ? 'active' : data?.delivery ? 'env' : 'off';

  return (
    <div className="flex max-h-[88dvh] flex-col">
      <DialogHeader className="border-b border-zinc-100 px-6 pt-6 pb-4 dark:border-zinc-800">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-gradient-to-br from-orange-500 to-orange-600 text-white">
            <Workflow className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <DialogTitle className="text-base">{data?.descriptor.title ?? label}</DialogTitle>
            <span className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400">{slug}</span>
          </div>
          <span
            className={cn(
              'ml-auto shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
              status === 'active'
                ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300'
                : status === 'env'
                  ? 'border-sky-300 bg-sky-50 text-sky-700 dark:border-sky-900/60 dark:bg-sky-950/40 dark:text-sky-300'
                  : 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300',
            )}
          >
            {status === 'active' ? 'Active' : status === 'env' ? 'Env URL' : 'No URL'}
          </span>
        </div>
      </DialogHeader>

      {!data && !loadError && (
        <div className="flex flex-1 items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-orange-500" />
        </div>
      )}
      {loadError && (
        <div className="m-6 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300">
          <AlertCircle className="h-4 w-4 shrink-0" /> {loadError}
          <Button variant="outline" size="sm" className="ml-auto" onClick={() => void load()}>
            Retry
          </Button>
        </div>
      )}

      {data && draft && (
        <>
          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-4">
            {/* The one trigger */}
            <div className="rounded-lg border border-orange-200 bg-orange-50/70 p-3 text-xs text-orange-950 dark:border-orange-900/50 dark:bg-orange-950/20 dark:text-orange-100">
              <div className="flex items-center gap-1.5 font-semibold">
                <ShieldCheck className="h-3.5 w-3.5" /> Fires only when
              </div>
              <p className="mt-1 leading-relaxed">{data.descriptor.trigger}</p>
            </div>

            <div className="grid gap-5 lg:grid-cols-2">
              {/* Recipients */}
              <section className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="flex items-center gap-1.5 text-sm font-semibold text-zinc-900 dark:text-white">
                    <Mail className="h-4 w-4 text-orange-500" /> Recipients
                    <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                      {effective.length}
                    </span>
                  </h3>
                  <div className="flex items-center gap-1 rounded-md border border-zinc-200 p-0.5 text-[11px] dark:border-zinc-700">
                    {(['role', 'custom'] as const).map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => setD({ mode: m, ...(m === 'custom' && draft.custom.length === 0 ? { custom: effective.map((r) => r.email) } : {}) })}
                        className={cn(
                          'rounded px-2 py-1 font-medium transition',
                          draft.mode === m
                            ? 'bg-zinc-900 text-white dark:bg-white dark:text-zinc-900'
                            : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-white',
                        )}
                      >
                        {m === 'role' ? 'Role ± changes' : 'Fixed list'}
                      </button>
                    ))}
                  </div>
                </div>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  {draft.mode === 'role'
                    ? data.descriptor.audience + ' Removing someone here keeps them out even while they hold the role; adding someone mails them even without it.'
                    : 'A fixed list REPLACES the role: a revoked role no longer removes anyone, and a new hire must be typed in here.'}
                </p>

                <ul className="divide-y divide-zinc-100 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
                  {effective.map((r) => (
                    <li key={r.email} className="flex items-center gap-2 px-3 py-2 text-sm">
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium text-zinc-900 dark:text-white">{r.name ?? r.email}</div>
                        {r.name && <div className="truncate font-mono text-[11px] text-zinc-500">{r.email}</div>}
                      </div>
                      <span
                        className={cn(
                          'shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium',
                          r.source === 'role'
                            ? 'border-zinc-200 text-zinc-500 dark:border-zinc-700 dark:text-zinc-400'
                            : 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300',
                        )}
                      >
                        {r.source === 'role' ? 'accounting role' : r.source === 'added' ? 'added here' : 'fixed list'}
                      </span>
                      <button
                        type="button"
                        onClick={() => removeRecipient(r.email)}
                        aria-label={`Remove ${r.email}`}
                        title="Remove from this automation"
                        className="rounded p-1 text-zinc-400 transition hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </li>
                  ))}
                  {removedRole.map((email) => (
                    <li key={`removed-${email}`} className="flex items-center gap-2 bg-zinc-50/70 px-3 py-2 text-sm dark:bg-zinc-900/40">
                      <div className="min-w-0 flex-1 truncate font-mono text-[12px] text-zinc-600 line-through dark:text-zinc-300">{email}</div>
                      <span className="shrink-0 rounded-full border border-red-200 bg-red-50 px-1.5 py-0.5 text-[10px] font-medium text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300">
                        removed
                      </span>
                      <button
                        type="button"
                        onClick={() => restoreRecipient(email)}
                        className="rounded p-1 text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800"
                        title="Restore"
                        aria-label={`Restore ${email}`}
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                      </button>
                    </li>
                  ))}
                  {effective.length === 0 && (
                    <li className="px-3 py-3 text-xs text-amber-700 dark:text-amber-300">
                      Nobody would be mailed. The automation refuses to fire with no recipients — and the week&apos;s one celebration is NOT burned by that.
                    </li>
                  )}
                </ul>

                <div className="flex items-center gap-2">
                  <Input
                    value={newEmail}
                    onChange={(e) => setNewEmail(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        addRecipient();
                      }
                    }}
                    placeholder="name@simple.biz"
                    className="font-mono text-sm"
                    aria-label="Add recipient email"
                  />
                  <Button variant="outline" size="sm" onClick={addRecipient} className="gap-1.5">
                    <Plus className="h-3.5 w-3.5" /> Add
                  </Button>
                  <Button variant="ghost" size="sm" onClick={resetToRole} className="gap-1.5 text-zinc-500" title="Back to the role's holders, no changes">
                    <RotateCcw className="h-3.5 w-3.5" /> Reset
                  </Button>
                </div>
              </section>

              {/* Payload */}
              <section className="space-y-3">
                <h3 className="flex items-center gap-1.5 text-sm font-semibold text-zinc-900 dark:text-white">
                  <Paperclip className="h-4 w-4 text-orange-500" /> Payload
                </h3>
                <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                  <div className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Attached files (built from the filed close-out record)</div>
                  <ul className="mt-1.5 space-y-1">
                    {data.descriptor.attachments.map((a) => (
                      <li key={a} className="flex items-center gap-1.5 text-xs text-zinc-700 dark:text-zinc-300">
                        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" /> {a}
                      </li>
                    ))}
                  </ul>
                </div>

                <label className="block space-y-1.5">
                  <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
                    Extra top-level keys (JSON) — merged into the payload
                  </span>
                  <textarea
                    value={draft.overridesText}
                    onChange={(e) => setD({ overridesText: e.target.value })}
                    spellCheck={false}
                    rows={6}
                    className={cn(
                      'w-full rounded-md border bg-white px-3 py-2 font-mono text-xs text-zinc-900 outline-none transition focus:ring-2 focus:ring-orange-500/40 dark:bg-zinc-950 dark:text-zinc-100',
                      overrides.error ? 'border-red-400' : 'border-zinc-200 dark:border-zinc-700',
                    )}
                  />
                </label>
                <div className="flex flex-wrap items-center gap-1">
                  <span className="text-[11px] text-zinc-500">Protected, cannot be overridden:</span>
                  {data.protectedKeys.map((k) => (
                    <code key={k} className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-[10px] text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                      {k}
                    </code>
                  ))}
                </div>
                {validation && !validation.ok && (
                  <ul className="space-y-1 rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300">
                    {validation.errors.map((e) => (
                      <li key={e} className="flex items-start gap-1.5">
                        <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" /> {e}
                      </li>
                    ))}
                  </ul>
                )}
                {serverErrors.length > 0 && (
                  <ul className="space-y-1 rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300">
                    {serverErrors.map((e) => (
                      <li key={e} className="flex items-start gap-1.5">
                        <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" /> Server: {e}
                      </li>
                    ))}
                  </ul>
                )}

                <div className="space-y-1.5">
                  <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
                    Effective payload — exactly what n8n receives (sample week; <code className="font-mono">content_base64</code> elided)
                  </span>
                  <pre className="max-h-72 overflow-auto rounded-lg border border-zinc-200 bg-zinc-50 p-3 font-mono text-[11px] leading-relaxed text-zinc-800 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200">
                    {preview ? JSON.stringify(preview.payload, null, 2) : ''}
                  </pre>
                </div>
              </section>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 border-t border-zinc-100 px-6 py-3 dark:border-zinc-800">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void sendTest()}
              disabled={testing || !data.delivery}
              title={data.delivery ? 'Sends the production payload, built from a fictional week, to YOUR email only' : 'Add and activate a URL first'}
              className="gap-1.5"
            >
              {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
              Send test run to me
            </Button>
            <span className="text-[11px] text-zinc-500">Test runs never go to the recipients above.</span>
            <div className="ml-auto flex items-center gap-2">
              {dirty && <span className="text-[11px] text-amber-600 dark:text-amber-400">Unsaved changes</span>}
              <Button onClick={() => void save()} disabled={!dirty || saving || !validation?.ok} className="gap-1.5">
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                Save automation
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
