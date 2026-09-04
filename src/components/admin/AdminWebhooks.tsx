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
  Search,
  X,
  Eye,
  Workflow,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { WEBHOOK_SAMPLE_PAYLOADS, genericTestPayload } from '@/lib/webhooks/sample-payloads';
import {
  WEBHOOK_AUTOMATIONS,
  type WebhookRecipientOverride,
} from '@/lib/webhooks/webhook-config';
import WebhookAutomationDialog from './WebhookAutomationDialog';

const SETTINGS_KEY = 'webhooks.config';

interface WebhookEntry {
  id: string;
  slug: string;          // stable identifier used by code, e.g. 'paystub_dispatch'
  label: string;         // human label
  url: string;
  active: boolean;
  description?: string;
  updated_at?: string;
  /** Automation overrides (2026-09-04) — written ONLY by the "Open automation"
   *  dialog via /api/admin/webhooks/automation. Carried here so this page's
   *  Save (URLs/labels) writes them back unchanged instead of dropping them. */
  recipients?: WebhookRecipientOverride | null;
  payload_overrides?: Record<string, unknown> | null;
}

const KNOWN_SLUGS: Array<{ slug: string; label: string; description: string }> = [
  {
    slug: 'paystub_dispatch',
    label: 'Paystub Dispatch (n8n)',
    description: 'Used by Payroll Wizard Step 8 (Dispatch) to dispatch paystubs.',
  },
  {
    slug: 'create_workspace_account',
    label: 'Create Workspace Account (n8n)',
    description:
      'Used by HR Onboarding "Save and stage hire" to provision the Hubstaff workspace account.',
  },
  {
    slug: 'verify_workspace_account',
    label: 'Verify Workspace Account (n8n)',
    description:
      'Read-only lookup used by the HR Onboarding "Verify" button to check whether a hire\'s Google Workspace account exists (POST { work_email } -> { exists: true|false }). Never creates anything.',
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
      'Sends the onboarding invite email — now also carries the matching pay-plan PDF (by department + country) as an attachment + download link. Used by HR Onboarding "Send" (falls back to the legacy hr.onboarding_webhook_url key).',
  },
  {
    slug: 'offboarding_deactivate',
    label: 'Offboarding - Deactivate (n8n)',
    description:
      'The suspend/temporary pathway ONLY: fired for the HR temporary_pause reason (and by Manager Suspend via its own slug) with deletion_mode "none" — disables the Workspace account, nothing is ever deleted. Real offboards never ride this flow.',
  },
  {
    slug: 'offboarding_delete',
    label: 'Offboarding - Delete (n8n)',
    description:
      'The offboard pathway: fired immediately for EVERY offboard, no matter the reason or department (HR offboard, manager queue processing, no-shows) — permanently deletes the Workspace account. The scheduled-deletion cron only drains rows stamped before the 2026-08-07 routing change.',
  },
  {
    slug: 'manager_suspend',
    label: 'Manager Suspend — Temp Pause (n8n)',
    description:
      'Fired by the Manager → My Team list "Suspend" button (per-row, confirm dialog). Rides the offboarding-deactivate flow with the HR temporary_pause envelope (event employee.offboarded, deletion_mode "none", source manager_suspend): the Workspace account is disabled only — nothing is deleted and no offboard stamps are written. Audit-logged as manager.suspended.',
  },
  {
    slug: 'manager_reactivate',
    label: 'Manager Reactivation — Temp Pause (n8n)',
    description:
      'Fired by the Manager → My Team list "Reactivation" button. POSTs an employees[1] envelope (event employee.reactivate, phase "reactivate", reactivated_by / reactivated_at) to the hris-reactivate-suspended flow, which re-enables a Workspace account disabled by a temporary pause / suspend and emails a confirmation. No reason / note required. Audit-logged as manager.reactivated.',
  },
  {
    slug: 'new_hire_checklist_lock',
    label: 'New Hire Checklist - Lock in (n8n)',
    description:
      'Fired by the HR New Hire Checklist "Lock in" button. POSTs the locked week\'s full payload (every row + all fields + lock metadata) to n8n.',
  },
  {
    slug: 'manager_offboard_notify',
    label: 'Manager Offboard Request → Notify (n8n)',
    description:
      'Fired when a manager submits team members to the HR offboarding queue. POSTs { count, manager } and emails alissar@simple.biz the count only (no names) so HR knows a manager wants to offboard someone.',
  },
  {
    slug: 'call_tools_creation',
    label: 'Call Tools Creation (n8n)',
    description:
      'Fired when a manager marks a LEAD GEN hire as having attended orientation (Manager → Newly Hired; bulk fires one event per hire; other departments fire nothing). Payload carries the hire\'s identity — including the split first_name + last_name alongside the combined name — calltools_nickname + calltools_username from their paperwork (e.g. "Mikey J. T.", minted at mark time for pre-feature paperwork), and pay_rate / regular_rate / ot_rate so n8n can provision the CallTools agent. Re-marks (date edits) re-fire with already_marked: true — the flow must not create a second account.',
  },
  {
    slug: 'bank_info_notify',
    label: 'Missing Bank Info → Notify Employee (n8n)',
    description:
      'Fired by the People tab (Accounting/CEO) "Missing bank info → Notify" button, on top of the in-app nudge. POSTs { recipients: [{ email, name }] } (single or batch); the n8n flow emails each person a red-alarm alert with a button to the /update-bank-info self-service page. Carries no account numbers.',
  },
  {
    slug: 'urgent_payment_notify',
    label: 'Urgent Payment Filed → Alert Accounting (n8n)',
    description:
      'Fired the moment a one-off Urgent Payment is filed from the People tab "Pay" button and lands in Payment Dispatch → Urgent. POSTs the request details (name, work email, amount, department, note, filed-by); the n8n flow emails carla@, claire@ and lennyt@simple.biz to check the HRIS. Recipients + copy are fixed inside the n8n workflow.',
  },
  {
    slug: 'ticket_created',
    label: 'Ticket Created → Email Admin (n8n)',
    description:
      'Fired when a ticket is created on the /tickets HRIS-updates board. POSTs the full request (ticket #, title, details, priority, requester); the n8n flow emails the board owner.',
  },
  {
    slug: 'ticket_done',
    label: 'Ticket Done → Email Creator (n8n)',
    description:
      'Fired when a ticket is moved into the Done column. POSTs the ticket + creator email; the n8n flow emails the creator that they can refresh the HRIS and test the change.',
  },
  {
    slug: 'ticket_replied',
    label: 'Ticket Replied → Email Counterparty (n8n)',
    description:
      "Fired when a comment lands on a /tickets ticket. POSTs the full reply text plus send_to — the ONE person the reply concerns: the ticket's creator, or the assigned developer when the creator is the one who typed it. Never the person who wrote the comment. Pairs with the in-app ticket.replied notification, which goes to both parties; the email is deliberately the narrower of the two.",
  },
  {
    slug: 'ticket_moved',
    label: 'Ticket Moved → Email Creator (n8n)',
    description:
      "Fired when a ticket changes column. POSTs from/to statuses, a forward/backward direction flag, and send_to = the ticket's CREATOR (never the developer, who is usually the one moving the card; nothing is sent when the creator moves it themselves). Every move fires, including a backward Testing → In Progress bounce — except Done, which has its own richer ticket_done email so one move never sends two.",
  },
  {
    slug: 'ticket_assigned',
    label: 'Ticket Assigned → Email Assignee (n8n)',
    description:
      'Fired when a ticket gets a (new) assignee. POSTs the ticket + assignee email (send_to); the n8n flow emails them the full ask. Pairs with the in-app assignment notification.',
  },
  {
    slug: 'payment_cycle_complete',
    label: 'Payment Cycle Closed → Celebrate Accounting (n8n)',
    description:
      'Fired ONCE per pay cycle, by the server, the moment Payment Dispatch → Stop processing → "Close the pay cycle" files the close-out record — nothing else fires it (the 100%-strip trigger was removed 2026-09-04 after two false firings). POSTs { cycle, stats, recipients, attachments } read off the filed record; recipients = everyone holding the accounting role, adjustable in Open automation; attachments = the close-out CSV, XLSX and PDF. The n8n flow emails each recipient the confetti congratulations with the three files.',
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
  const [query, setQuery] = useState('');
  const [viewingId, setViewingId] = useState<string | null>(null);
  const [automationId, setAutomationId] = useState<string | null>(null);

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

  const copyText = (text: string, label: string) => {
    navigator.clipboard?.writeText(text);
    toast.success(`${label} copied`);
  };

  const viewingEntry = entries.find((e) => e.id === viewingId) ?? null;
  const automationEntry = entries.find((e) => e.id === automationId) ?? null;

  const activeCount = entries.filter((e) => entryStatus(e) === 'active').length;

  const filteredEntries = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((e) =>
      [e.label, e.slug, e.url, e.description]
        .filter(Boolean)
        .some((field) => field!.toLowerCase().includes(q)),
    );
  }, [entries, query]);

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

      <div className="border-b border-zinc-200 px-6 py-3 dark:border-zinc-800">
        <div className="relative max-w-md">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search webhooks by name, slug, URL…"
            className="pl-9 pr-9"
            aria-label="Search webhooks"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              title="Clear search"
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="grid gap-3">
          {entries.length === 0 && (
            <div className="rounded-lg border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
              No webhooks configured yet. Click <strong>Add webhook</strong> to create one.
            </div>
          )}
          {entries.length > 0 && filteredEntries.length === 0 && (
            <div className="rounded-lg border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
              No webhooks match <strong className="text-zinc-700 dark:text-zinc-300">“{query}”</strong>.
            </div>
          )}
          {filteredEntries.map((entry) => {
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
                      {WEBHOOK_AUTOMATIONS[entry.slug] && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setAutomationId(entry.id)}
                          className="gap-1.5 border-orange-300 text-orange-700 hover:bg-orange-50 dark:border-orange-900/60 dark:text-orange-300 dark:hover:bg-orange-950/40"
                          title="Open the automation: recipients, payload, test run"
                        >
                          <Workflow className="h-3.5 w-3.5" />
                          Open automation
                        </Button>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setViewingId(entry.id)}
                        className="gap-1.5"
                      >
                        <Eye className="h-3.5 w-3.5" />
                        View
                      </Button>

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

      <Dialog open={!!viewingEntry} onOpenChange={(o) => !o && setViewingId(null)}>
        <DialogContent className="overflow-hidden p-0 sm:max-w-2xl">
          {viewingEntry && (
            <ViewWebhookModal entry={viewingEntry} onCopy={copyText} />
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={!!automationEntry} onOpenChange={(o) => !o && setAutomationId(null)}>
        <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-5xl">
          {automationEntry && (
            <WebhookAutomationDialog
              slug={automationEntry.slug}
              label={automationEntry.label || automationEntry.slug}
              onSaved={(slug, config, updatedAt) =>
                // Mirror the server's write into local state so this page's own
                // Save (URLs/labels) writes the same automation fields back.
                setEntries((prev) =>
                  prev.map((e) => (e.slug === slug ? { ...e, ...config, updated_at: updatedAt } : e)),
                )
              }
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ViewWebhookModal({
  entry,
  onCopy,
}: {
  entry: WebhookEntry;
  onCopy: (text: string, label: string) => void;
}) {
  const status = entryStatus(entry);
  const meta = STATUS_META[status];
  const sample = WEBHOOK_SAMPLE_PAYLOADS[entry.slug] ?? genericTestPayload(entry.slug);
  const isDocumented = entry.slug in WEBHOOK_SAMPLE_PAYLOADS;
  const payloadText = JSON.stringify(sample, null, 2);

  return (
    <>
      <DialogHeader className="border-b border-zinc-100 px-6 pt-6 pb-4 dark:border-zinc-800">
        <div className="flex items-center gap-2">
          <DialogTitle className="text-base">{entry.label || entry.slug || 'New webhook'}</DialogTitle>
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
      </DialogHeader>

      <div className="max-h-[70vh] space-y-4 overflow-y-auto px-6 py-4">
        <div className="space-y-1">
          <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Endpoint URL</span>
          <div className="flex items-center gap-2">
            <code className="flex-1 truncate rounded bg-zinc-100 px-2 py-1.5 font-mono text-xs text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
              {entry.url || '—'}
            </code>
            {entry.url && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => onCopy(entry.url, 'URL')}
                className="shrink-0 gap-1.5"
              >
                <CopyIcon className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </div>

        {entry.description && (
          <div className="space-y-1">
            <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Description</span>
            <p className="text-sm text-zinc-700 dark:text-zinc-300">{entry.description}</p>
          </div>
        )}

        {entry.updated_at && (
          <div className="space-y-1">
            <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Last updated</span>
            <p className="text-sm text-zinc-700 dark:text-zinc-300">
              {new Date(entry.updated_at).toLocaleString()}
            </p>
          </div>
        )}

        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
              Sample JSON payload
              {!isDocumented && (
                <span className="ml-1.5 font-normal text-zinc-400 dark:text-zinc-500">
                  (no documented sample yet &mdash; matches what Test sends)
                </span>
              )}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => onCopy(payloadText, 'Payload')}
              className="gap-1.5"
            >
              <CopyIcon className="h-3.5 w-3.5" /> Copy
            </Button>
          </div>
          <pre className="max-h-80 overflow-auto rounded-lg border border-zinc-200 bg-zinc-50 p-3 font-mono text-xs text-zinc-800 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200">
            {payloadText}
          </pre>
        </div>
      </div>
    </>
  );
}
