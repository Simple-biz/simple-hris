'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import {
  Archive,
  CheckCircle2,
  CheckIcon,
  ChevronDownIcon,
  ClipboardCopy,
  Download,
  Eye,
  FileText,
  Link2,
  Loader2,
  Mail,
  Plus,
  RefreshCw,
  Search,
  Send,
  Sparkles,
  Trash2,
  User,
  UserCheck,
  Wand2,
  XCircle,
} from 'lucide-react';
import { Select as SelectPrimitive } from '@base-ui/react/select';
import { splitFullName } from '@/lib/hr/work-email';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Tabs as TabsPrimitive } from '@base-ui/react/tabs';
import { AnimatePresence, motion } from 'motion/react';
import {
  AGREEMENT_TITLES,
  ContractWorkerText,
  NonSolicitationText,
  PrivacyText,
} from '@/components/onboarding/agreement-texts';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

function isPlausibleEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

type HrOnboardingStatus = 'pending' | 'submitted' | 'archived';
type PaymentMethod = 'hurupay' | 'wires';

type SubmissionRow = {
  id: string;
  token: string;
  status: HrOnboardingStatus;
  created_at: string;
  created_by: string | null;
  submitted_at: string | null;
  invite_name: string | null;
  invite_personal_email: string | null;
  invite_department: string | null;
  invite_note: string | null;
  full_name: string | null;
  phone: string | null;
  email: string | null;
  non_solicitation_signature: string | null;
  privacy_signature: string | null;
  w8ben_applicable: boolean | null;
  w8ben_file_path: string | null;
  w8ben_file_name: string | null;
  payment_method: PaymentMethod | null;
  hurupay_email: string | null;
  bank_full_name: string | null;
  bank_account_name: string | null;
  bank_account_number: string | null;
  bank_swift_code: string | null;
  bank_street: string | null;
  bank_city: string | null;
  bank_province: string | null;
  bank_postal_code: string | null;
  bank_full_address: string | null;
  contract_signature: string | null;
  contract_date: string | null;
  work_email: string | null;
  pending_employee_id: number | null;
};

type StatusFilter = 'all' | HrOnboardingStatus;

const STATUS_BADGE: Record<HrOnboardingStatus, string> = {
  pending:
    'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950/35 dark:text-amber-100',
  submitted:
    'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-100',
  archived:
    'border-zinc-300 bg-zinc-100 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400',
};

const STATUS_LABEL: Record<HrOnboardingStatus, string> = {
  pending: 'Awaiting submission',
  submitted: 'Submitted',
  archived: 'Archived',
};

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function fmtDateTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function publicLinkFor(token: string): string {
  if (typeof window === 'undefined') return `/onboarding/${token}`;
  return `${window.location.origin}/onboarding/${token}`;
}

export default function HrOnboardingForm() {
  const [rows, setRows] = useState<SubmissionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [search, setSearch] = useState('');

  const [generateOpen, setGenerateOpen] = useState(false);
  const [linkCreated, setLinkCreated] = useState<SubmissionRow | null>(null);
  const [viewRow, setViewRow] = useState<SubmissionRow | null>(null);
  const [workEmailFor, setWorkEmailFor] = useState<SubmissionRow | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<SubmissionRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SubmissionRow | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Multi-select for bulk actions. Selection is scoped to the rows currently
  // visible under the active filter + search; an effect prunes it whenever the
  // visible set changes so we never act on a hidden row.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkAction, setBulkAction] = useState<{
    type: 'archive' | 'delete' | 'send';
    rows: SubmissionRow[];
  } | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/hr/onboarding-submissions', { cache: 'no-store' });
      const json = (await res.json()) as { rows?: SubmissionRow[]; error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Failed to load');
      setRows(json.rows ?? []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load submissions');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const counts = useMemo(() => {
    const c = { pending: 0, submitted: 0, archived: 0 };
    for (const r of rows) c[r.status] += 1;
    return c;
  }, [rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (filter !== 'all' && r.status !== filter) return false;
      if (!q) return true;
      return [r.invite_name, r.invite_personal_email, r.invite_department, r.full_name, r.email]
        .filter(Boolean)
        .some((s) => s!.toLowerCase().includes(q));
    });
  }, [rows, filter, search]);

  // Drop any selected id that's no longer visible (filter/search changed, or a
  // row was archived/deleted). `filtered` is memoized, so this only fires when
  // the visible set actually changes.
  useEffect(() => {
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set<string>();
      for (const r of filtered) if (prev.has(r.id)) next.add(r.id);
      return next.size === prev.size ? prev : next;
    });
  }, [filtered]);

  const selectedRows = useMemo(
    () => filtered.filter((r) => selectedIds.has(r.id)),
    [filtered, selectedIds],
  );
  const allVisibleSelected = filtered.length > 0 && selectedRows.length === filtered.length;
  const someVisibleSelected = selectedRows.length > 0 && !allVisibleSelected;
  const selSendable = selectedRows.filter((r) => r.status === 'pending');
  const selArchivable = selectedRows.filter((r) => r.status !== 'archived');
  const selDeletable = selectedRows.filter((r) => r.status === 'archived');

  function toggleAllVisible() {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (filtered.every((r) => next.has(r.id))) {
        for (const r of filtered) next.delete(r.id);
      } else {
        for (const r of filtered) next.add(r.id);
      }
      return next;
    });
  }

  function toggleOne(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function resendLink(r: SubmissionRow) {
    const recipient = r.invite_personal_email ?? r.email;
    if (!recipient) {
      toast.error('No email address on file — cannot resend.');
      return;
    }
    setBusyId(r.id);
    try {
      const res = await fetch(`/api/hr/onboarding-submissions/${r.id}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Failed to resend');
      toast.success(`Link resent to ${recipient}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to resend');
    } finally {
      setBusyId(null);
    }
  }

  async function runBulkAction() {
    if (!bulkAction) return;
    const { type, rows: targets } = bulkAction;
    setBulkBusy(true);
    try {
      const results = await Promise.allSettled(
        targets.map(async (r) => {
          let res: Response;
          if (type === 'archive') {
            res = await fetch(`/api/hr/onboarding-submissions/${r.id}`, { method: 'DELETE' });
          } else if (type === 'delete') {
            res = await fetch(`/api/hr/onboarding-submissions/${r.id}?hard=true`, {
              method: 'DELETE',
            });
          } else {
            res = await fetch(`/api/hr/onboarding-submissions/${r.id}/send`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({}),
            });
          }
          const json = (await res.json().catch(() => ({}))) as { error?: string };
          if (!res.ok || json.error) throw new Error(json.error ?? 'Request failed');
        }),
      );
      const ok = results.filter((r) => r.status === 'fulfilled').length;
      const failed = results.length - ok;
      const verb = type === 'archive' ? 'archived' : type === 'delete' ? 'deleted' : 'sent';
      if (ok > 0) toast.success(`${ok} submission${ok === 1 ? '' : 's'} ${verb}`);
      if (failed > 0) toast.error(`${failed} failed — check and retry`);
      setSelectedIds(new Set());
      await load();
    } finally {
      setBulkBusy(false);
      setBulkAction(null);
    }
  }

  async function archive(row: SubmissionRow) {
    setBusyId(row.id);
    try {
      const res = await fetch(`/api/hr/onboarding-submissions/${row.id}`, { method: 'DELETE' });
      const json = (await res.json()) as { error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Failed to archive');
      toast.success('Submission archived');
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to archive');
    } finally {
      setBusyId(null);
      setArchiveTarget(null);
    }
  }

  async function hardDelete(row: SubmissionRow) {
    setBusyId(row.id);
    try {
      const res = await fetch(`/api/hr/onboarding-submissions/${row.id}?hard=true`, {
        method: 'DELETE',
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Failed to delete');
      toast.success('Submission deleted permanently');
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to delete');
    } finally {
      setBusyId(null);
      setDeleteTarget(null);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Hero strip */}
      <div className="rounded-2xl border border-emerald-100/80 bg-gradient-to-br from-emerald-50/80 via-white to-teal-50/60 p-5 dark:border-emerald-950/40 dark:from-emerald-950/20 dark:via-zinc-950 dark:to-teal-950/15">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-emerald-700/80">
              <Sparkles className="h-3 w-3" />
              Self-serve onboarding
            </div>
            <h2 className="mt-1 text-lg font-semibold text-zinc-900 dark:text-zinc-50">
              Send new hires a shareable form — no SSO required.
            </h2>
            <p className="mt-1 max-w-2xl text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">
              Generate a unique link and email it to the new hire. They complete the 6-step
              form (personal info, agreements, W-8BEN upload, payment method, contract) and
              the submission lands here for you to review.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              className="bg-gradient-to-r from-emerald-500 to-teal-700 text-white shadow-md shadow-emerald-600/25 hover:opacity-95"
              onClick={() => setGenerateOpen(true)}
            >
              <Plus className="mr-1.5 h-4 w-4" />
              Generate link
            </Button>
            <Button
              variant="outline"
              className="border-emerald-200 text-emerald-800"
              onClick={() => void load()}
              disabled={loading}
            >
              <RefreshCw className={cn('mr-1.5 h-3.5 w-3.5', loading && 'animate-spin')} />
              Refresh
            </Button>
          </div>
        </div>
      </div>

      {/* Filter + search */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-1">
          <FilterPill label="Submitted" count={counts.submitted} active={filter === 'submitted'} onClick={() => setFilter('submitted')} />
          <FilterPill label="Archived" count={counts.archived} active={filter === 'archived'} onClick={() => setFilter('archived')} />
          <FilterPill label="All" count={rows.length} active={filter === 'all'} onClick={() => setFilter('all')} />
        </div>
        <div className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, email, dept…"
            className="border-emerald-100/70 bg-white pl-9 dark:border-emerald-900/50 dark:bg-zinc-900"
          />
        </div>
      </div>

      {/* Bulk action bar — appears once one or more visible rows are selected.
          Each action only targets the eligible subset of the selection. */}
      {selectedRows.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50/70 px-4 py-2.5 dark:border-emerald-900/50 dark:bg-emerald-950/25">
          <span className="text-sm font-medium text-emerald-900 dark:text-emerald-200">
            {selectedRows.length} selected
          </span>
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            {selSendable.length > 0 && (
              <Button
                size="sm"
                variant="outline"
                className="h-7 gap-1 px-2 text-xs text-emerald-800 hover:bg-emerald-100 dark:text-emerald-200 dark:hover:bg-emerald-900/40"
                onClick={() => setBulkAction({ type: 'send', rows: selSendable })}
                disabled={bulkBusy}
              >
                <Send className="h-3 w-3" />
                Send ({selSendable.length})
              </Button>
            )}
            {selArchivable.length > 0 && (
              <Button
                size="sm"
                variant="outline"
                className="h-7 gap-1 px-2 text-xs text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
                onClick={() => setBulkAction({ type: 'archive', rows: selArchivable })}
                disabled={bulkBusy}
              >
                <Archive className="h-3 w-3" />
                Archive ({selArchivable.length})
              </Button>
            )}
            {selDeletable.length > 0 && (
              <Button
                size="sm"
                variant="outline"
                className="h-7 gap-1 px-2 text-xs text-rose-700 hover:bg-rose-50 hover:text-rose-800 dark:text-rose-300 dark:hover:bg-rose-950/30"
                onClick={() => setBulkAction({ type: 'delete', rows: selDeletable })}
                disabled={bulkBusy}
              >
                <Trash2 className="h-3 w-3" />
                Delete ({selDeletable.length})
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
              onClick={() => setSelectedIds(new Set())}
              disabled={bulkBusy}
            >
              Clear
            </Button>
          </div>
        </div>
      )}

      {/* Submissions table */}
      <div className="overflow-hidden rounded-xl border border-emerald-100/80 bg-white shadow-sm ring-1 ring-emerald-500/5 dark:border-emerald-950/40 dark:bg-zinc-950">
        {loading ? (
          <div className="flex items-center justify-center py-12 text-zinc-400">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-12 text-center">
            <FileText className="h-8 w-8 text-emerald-300" />
            <p className="text-sm text-zinc-500">
              {rows.length === 0
                ? 'No onboarding links yet — click "Generate link" to send your first one.'
                : 'No submissions match this filter.'}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm sm:min-w-[860px]">
              <thead className="border-b border-emerald-100/60 bg-gradient-to-r from-emerald-50 via-white to-emerald-50/80 text-xs text-zinc-600 dark:border-emerald-900/40 dark:from-emerald-950/40 dark:via-zinc-950 dark:to-emerald-950/30 dark:text-zinc-400">
                <tr>
                  <th className="w-10 px-4 py-3">
                    <Checkbox
                      checked={allVisibleSelected}
                      indeterminate={someVisibleSelected}
                      onCheckedChange={toggleAllVisible}
                      aria-label="Select all visible submissions"
                    />
                  </th>
                  <th className="px-4 py-3 font-semibold">Invitee</th>
                  <th className="px-4 py-3 font-semibold">Department</th>
                  <th className="px-4 py-3 font-semibold">Status</th>
                  <th className="px-4 py-3 font-semibold">Created</th>
                  <th className="px-4 py-3 font-semibold">Submitted</th>
                  <th className="px-4 py-3 font-semibold text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-emerald-100/60 dark:divide-emerald-900/30">
                {filtered.map((r, i) => {
                  const isBusy = busyId === r.id;
                  return (
                    // Keyed by filter so every row remounts and re-runs its
                    // stagger-in when you switch Awaiting/Submitted/Archived/All.
                    <motion.tr
                      key={`${filter}:${r.id}`}
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.18, ease: 'easeOut', delay: Math.min(i * 0.025, 0.25) }}
                      className={cn(
                        'align-top hover:bg-emerald-50/30 dark:hover:bg-emerald-950/20',
                        selectedIds.has(r.id) && 'bg-emerald-50/60 dark:bg-emerald-950/30',
                      )}
                    >
                      <td data-label="Select" className="px-4 py-3">
                        <Checkbox
                          checked={selectedIds.has(r.id)}
                          onCheckedChange={() => toggleOne(r.id)}
                          aria-label={`Select ${r.invite_name ?? r.full_name ?? 'submission'}`}
                        />
                      </td>
                      <td data-label="Invitee" className="px-4 py-3">
                        <div className="font-medium text-zinc-900 dark:text-zinc-100">
                          {r.invite_name ?? r.full_name ?? '—'}
                        </div>
                        <div className="mt-0.5 break-all font-mono text-[11px] text-zinc-500">
                          {r.invite_personal_email ?? r.email ?? '—'}
                        </div>
                      </td>
                      <td data-label="Department" className="px-4 py-3 text-xs text-zinc-700 dark:text-zinc-300">
                        {r.invite_department ?? '—'}
                      </td>
                      <td data-label="Status" className="px-4 py-3">
                        <Badge variant="outline" className={cn('text-[10px] font-medium', STATUS_BADGE[r.status])}>
                          {STATUS_LABEL[r.status]}
                        </Badge>
                      </td>
                      <td data-label="Created" className="px-4 py-3 text-xs text-zinc-500">
                        {fmtDateTime(r.created_at)}
                      </td>
                      <td data-label="Submitted" className="px-4 py-3 text-xs text-zinc-500">
                        {fmtDateTime(r.submitted_at)}
                      </td>
                      <td data-label="Actions" className="px-4 py-3 text-right">
                        <div className="flex justify-end gap-1.5">
                          {r.status === 'pending' && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 px-2 text-xs"
                              onClick={() => {
                                void navigator.clipboard.writeText(publicLinkFor(r.token));
                                toast.success('Link copied');
                              }}
                              title="Copy public link"
                            >
                              <ClipboardCopy className="mr-1 h-3 w-3" />
                              Copy link
                            </Button>
                          )}
                          {r.status === 'submitted' && (
                            <>
                              {r.pending_employee_id && r.work_email && (
                                <span
                                  className="inline-flex items-center gap-1 rounded-md border border-sky-300 bg-sky-50 px-2 py-1 font-mono text-[11px] font-medium text-sky-900 dark:border-sky-700 dark:bg-sky-950/40 dark:text-sky-100"
                                  title="Currently staged in Pending Hires"
                                >
                                  <UserCheck className="h-3 w-3 shrink-0" />
                                  {r.work_email}
                                </span>
                              )}
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 gap-1 px-2 text-xs text-emerald-800 hover:bg-emerald-50 dark:text-emerald-200 dark:hover:bg-emerald-950/30"
                                onClick={() => setWorkEmailFor(r)}
                                title={r.pending_employee_id ? 'Re-send workspace setup with updated details' : 'Mint an @simple.biz address and stage this hire'}
                              >
                                <Mail className="h-3 w-3" />
                                {r.pending_employee_id ? 'Update setup' : 'Set work email'}
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 gap-1 px-2 text-xs text-zinc-600 hover:bg-zinc-50 dark:text-zinc-300 dark:hover:bg-zinc-800/50"
                                onClick={() => void resendLink(r)}
                                disabled={isBusy}
                                title={`Resend the onboarding link to ${r.invite_personal_email ?? r.email ?? 'this hire'}`}
                              >
                                {isBusy ? (
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                ) : (
                                  <Send className="h-3 w-3" />
                                )}
                                Resend
                              </Button>
                              <Button
                                size="sm"
                                className="h-7 bg-gradient-to-r from-emerald-500 to-teal-700 px-3 text-xs text-white hover:opacity-90"
                                onClick={() => setViewRow(r)}
                              >
                                <Eye className="mr-1 h-3 w-3" />
                                View
                              </Button>
                            </>
                          )}
                          {r.status !== 'archived' ? (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 px-2 text-xs text-zinc-600 hover:bg-zinc-50"
                              onClick={() => setArchiveTarget(r)}
                              disabled={isBusy}
                              title="Archive — link will stop working but can be reviewed later"
                            >
                              <Archive className="h-3 w-3" />
                            </Button>
                          ) : (
                            // Gmail trash-bin pattern: hard-delete only reachable from the
                            // Archived view, so accidental one-clicks can't nuke a live link.
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 px-2 text-xs text-rose-700 hover:bg-rose-50 hover:text-rose-800 dark:text-rose-300 dark:hover:bg-rose-950/30"
                              onClick={() => setDeleteTarget(r)}
                              disabled={isBusy}
                              title="Permanently delete this archived submission"
                            >
                              <Trash2 className="h-3 w-3" />
                            </Button>
                          )}
                        </div>
                      </td>
                    </motion.tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <GenerateLinkDialog
        open={generateOpen}
        onClose={() => setGenerateOpen(false)}
        onCreated={(row) => {
          setGenerateOpen(false);
          setLinkCreated(row);
          void load();
        }}
      />

      <LinkCreatedDialog
        row={linkCreated}
        onClose={() => setLinkCreated(null)}
        onSent={() => void load()}
      />

      <SubmissionDetailDialog
        row={viewRow}
        onClose={() => setViewRow(null)}
      />

      <SetOnboardingWorkEmailDialog
        row={workEmailFor}
        onClose={() => setWorkEmailFor(null)}
        onConverted={() => {
          setWorkEmailFor(null);
          void load();
        }}
      />

      <Dialog open={!!archiveTarget} onOpenChange={(o) => !o && setArchiveTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base">Archive this submission?</DialogTitle>
            <DialogDescription className="text-xs">
              The link will stop working. You can still see archived submissions under the
              Archived filter, but the new hire won't be able to open or submit the form.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" size="sm" onClick={() => setArchiveTarget(null)}>
              Keep
            </Button>
            <Button
              size="sm"
              className="bg-zinc-700 hover:bg-zinc-800"
              onClick={() => archiveTarget && void archive(archiveTarget)}
              disabled={busyId === archiveTarget?.id}
            >
              {busyId === archiveTarget?.id ? (
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              ) : (
                <Archive className="mr-1 h-3 w-3" />
              )}
              Archive
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base">Permanently delete this submission?</DialogTitle>
            <DialogDescription className="text-xs">
              <strong>{deleteTarget?.invite_name ?? deleteTarget?.full_name ?? 'This row'}</strong>
              {' '}
              ({deleteTarget?.invite_personal_email ?? deleteTarget?.email ?? '—'}) will be
              removed from the database, along with any signatures and W-8BEN file uploaded
              with it. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" size="sm" onClick={() => setDeleteTarget(null)} disabled={busyId === deleteTarget?.id}>
              Keep
            </Button>
            <Button
              size="sm"
              className="bg-rose-600 hover:bg-rose-700"
              onClick={() => deleteTarget && void hardDelete(deleteTarget)}
              disabled={busyId === deleteTarget?.id}
            >
              {busyId === deleteTarget?.id ? (
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              ) : (
                <Trash2 className="mr-1 h-3 w-3" />
              )}
              Delete permanently
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!bulkAction} onOpenChange={(o) => !o && !bulkBusy && setBulkAction(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base">
              {bulkAction?.type === 'send'
                ? `Send ${bulkAction.rows.length} onboarding email${bulkAction.rows.length === 1 ? '' : 's'}?`
                : bulkAction?.type === 'archive'
                  ? `Archive ${bulkAction.rows.length} submission${bulkAction.rows.length === 1 ? '' : 's'}?`
                  : `Permanently delete ${bulkAction?.rows.length ?? 0} submission${bulkAction?.rows.length === 1 ? '' : 's'}?`}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {bulkAction?.type === 'send'
                ? 'Each recipient gets a fresh, unique link — any previous link for that row stops working. Emails go out via the configured webhook.'
                : bulkAction?.type === 'archive'
                  ? "Their links will stop working. You can still review them under the Archived filter, but new hires won't be able to open or submit the form."
                  : 'These archived submissions and any signatures / W-8BEN files uploaded with them will be removed from the database. This cannot be undone.'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" size="sm" onClick={() => setBulkAction(null)} disabled={bulkBusy}>
              Cancel
            </Button>
            <Button
              size="sm"
              className={cn(
                bulkAction?.type === 'send' && 'bg-emerald-600 hover:bg-emerald-700',
                bulkAction?.type === 'archive' && 'bg-zinc-700 hover:bg-zinc-800',
                bulkAction?.type === 'delete' && 'bg-rose-600 hover:bg-rose-700',
              )}
              onClick={() => void runBulkAction()}
              disabled={bulkBusy}
            >
              {bulkBusy ? (
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              ) : bulkAction?.type === 'send' ? (
                <Send className="mr-1 h-3 w-3" />
              ) : bulkAction?.type === 'archive' ? (
                <Archive className="mr-1 h-3 w-3" />
              ) : (
                <Trash2 className="mr-1 h-3 w-3" />
              )}
              {bulkAction?.type === 'send'
                ? 'Send all'
                : bulkAction?.type === 'archive'
                  ? 'Archive all'
                  : 'Delete all'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Generate link dialog ─────────────────────────────────────────────────

/** Parses a blob of pasted text (Excel rows, comma-lists, etc.) into distinct
 *  email addresses. Returns { valid, invalid } where invalid are tokens that
 *  look like they were meant to be emails but failed the plausibility check. */
function parseBulkEmails(raw: string): { valid: string[]; invalid: string[] } {
  const tokens = raw
    .split(/[\n\r\t,;|]+/)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  const seen = new Set<string>();
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const t of tokens) {
    if (seen.has(t)) continue;
    seen.add(t);
    if (isPlausibleEmail(t)) valid.push(t);
    else if (t.includes('@') || t.includes('.')) invalid.push(t);
  }
  return { valid, invalid };
}

type BulkResult = { email: string; ok: boolean; error?: string };

function GenerateLinkDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (row: SubmissionRow) => void;
}) {
  const [email, setEmail] = useState('');
  const [dept, setDept] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  // Lead Gen bulk state
  const [bulkText, setBulkText] = useState('');
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null);
  const [bulkResults, setBulkResults] = useState<BulkResult[] | null>(null);

  const [departments, setDepartments] = useState<string[]>([]);
  const [deptsLoading, setDeptsLoading] = useState(false);

  const isLeadGen = ['lead gen', 'lead generation'].includes(dept.trim().toLowerCase());
  const { valid: parsedEmails, invalid: invalidTokens } = useMemo(
    () => (isLeadGen ? parseBulkEmails(bulkText) : { valid: [], invalid: [] }),
    [isLeadGen, bulkText],
  );

  useEffect(() => {
    if (!open) return;
    if (departments.length > 0 || deptsLoading) return;
    setDeptsLoading(true);
    fetch('/api/departments', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j: { departments?: string[]; error?: string }) => {
        if (j.error) throw new Error(j.error);
        setDepartments(j.departments ?? []);
      })
      .catch((e) =>
        toast.error(e instanceof Error ? e.message : 'Could not load departments'),
      )
      .finally(() => setDeptsLoading(false));
  }, [open, departments.length, deptsLoading]);

  useEffect(() => {
    if (!open) {
      setEmail(''); setDept(''); setNote('');
      setBulkText(''); setBulkProgress(null); setBulkResults(null);
    }
  }, [open]);

  const emailInvalid = !isLeadGen && email.trim().length > 0 && !isPlausibleEmail(email);

  // ── Single-hire submit ──
  async function submitSingle() {
    if (emailInvalid) { toast.error("Personal email doesn't look right."); return; }
    setBusy(true);
    try {
      const res = await fetch('/api/hr/onboarding-submissions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          invite_name: null,
          invite_personal_email: email.trim() || null,
          invite_department: dept.trim() || null,
          invite_note: note.trim() || null,
        }),
      });
      const json = (await res.json()) as { row?: SubmissionRow; error?: string };
      if (!res.ok || json.error || !json.row) throw new Error(json.error ?? 'Failed to create link');
      onCreated(json.row);
      toast.success('Onboarding link created');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to create link');
    } finally {
      setBusy(false);
    }
  }

  // ── Lead Gen bulk submit: create + send for every parsed email ──
  async function submitBulk() {
    if (parsedEmails.length === 0) return;
    setBusy(true);
    setBulkProgress({ done: 0, total: parsedEmails.length });
    setBulkResults(null);
    const results: BulkResult[] = [];

    for (let i = 0; i < parsedEmails.length; i++) {
      const e = parsedEmails[i]!;
      try {
        // 1. Create submission
        const createRes = await fetch('/api/hr/onboarding-submissions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            invite_name: null,
            invite_personal_email: e,
            invite_department: dept.trim(),
            invite_note: note.trim() || null,
          }),
        });
        const createJson = (await createRes.json()) as { row?: SubmissionRow; error?: string };
        if (!createRes.ok || createJson.error || !createJson.row) {
          throw new Error(createJson.error ?? 'Failed to create');
        }
        const rowId = createJson.row.id;

        // 2. Send the onboarding link immediately
        const sendRes = await fetch(`/api/hr/onboarding-submissions/${rowId}/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        const sendJson = (await sendRes.json()) as { error?: string };
        if (!sendRes.ok || sendJson.error) {
          throw new Error(sendJson.error ?? 'Created but send failed');
        }

        results.push({ email: e, ok: true });
      } catch (err) {
        results.push({ email: e, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
      setBulkProgress({ done: i + 1, total: parsedEmails.length });
    }

    setBulkResults(results);
    setBusy(false);
    const sent = results.filter((r) => r.ok).length;
    const failed = results.length - sent;
    if (failed === 0) {
      toast.success(`${sent} onboarding link${sent !== 1 ? 's' : ''} sent`);
    } else {
      toast.warning(`${sent} sent, ${failed} failed — see results below`);
    }
    // Refresh the submissions list
    onCreated(results.find((r) => r.ok) ? { id: '' } as unknown as SubmissionRow : { id: '' } as unknown as SubmissionRow);
  }

  // ── Bulk results view (shown after generation) ──
  if (bulkResults) {
    const sent = bulkResults.filter((r) => r.ok).length;
    const failed = bulkResults.length - sent;
    return (
      <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-lg">
          <div className="-mx-6 -mt-6 mb-4 overflow-hidden rounded-t-lg border-b border-emerald-100/80 bg-gradient-to-br from-emerald-50 via-white to-teal-50/60 px-6 py-5 dark:border-emerald-950/40 dark:from-emerald-950/30 dark:via-zinc-950 dark:to-teal-950/20">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2.5 text-base font-semibold">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-500 to-teal-700 text-white shadow-md shadow-emerald-600/25">
                  <Send className="h-4 w-4" />
                </span>
                Bulk send complete
              </DialogTitle>
              <p className="mt-1 text-[12px] text-zinc-500 dark:text-zinc-400">
                <span className="font-semibold text-emerald-700 dark:text-emerald-400">{sent} sent</span>
                {failed > 0 && <>, <span className="font-semibold text-rose-600 dark:text-rose-400">{failed} failed</span></>}
                {' '}— Lead Gen batch
              </p>
            </DialogHeader>
          </div>
          <div className="max-h-72 overflow-y-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
            {bulkResults.map((r) => (
              <div key={r.email} className={cn(
                'flex items-start gap-2.5 border-b px-3 py-2 text-xs last:border-b-0 dark:border-zinc-800',
                r.ok ? 'border-zinc-100' : 'border-rose-100 bg-rose-50/50 dark:border-rose-900/30 dark:bg-rose-950/20',
              )}>
                {r.ok
                  ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />
                  : <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-500" />}
                <div className="min-w-0">
                  <p className="truncate font-mono text-zinc-800 dark:text-zinc-200">{r.email}</p>
                  {r.error && <p className="text-rose-600 dark:text-rose-400">{r.error}</p>}
                </div>
              </div>
            ))}
          </div>
          <DialogFooter className="mt-4 gap-2 sm:gap-0">
            <Button size="sm" onClick={onClose}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className={cn('max-h-[92vh] overflow-y-auto', isLeadGen ? 'sm:max-w-2xl' : 'sm:max-w-md')}>
        <div className="-mx-6 -mt-6 mb-1 overflow-hidden rounded-t-lg border-b border-emerald-100/80 bg-gradient-to-br from-emerald-50 via-white to-teal-50/60 px-6 py-5 dark:border-emerald-950/40 dark:from-emerald-950/30 dark:via-zinc-950 dark:to-teal-950/20">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2.5 text-base font-semibold">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-500 to-teal-700 text-white shadow-md shadow-emerald-600/25">
                <Link2 className="h-4 w-4" />
              </span>
              {isLeadGen ? 'Bulk onboarding — Lead Gen' : 'Generate onboarding link'}
            </DialogTitle>
            <p className="mt-1.5 text-[12px] leading-relaxed text-zinc-600 dark:text-zinc-400">
              {isLeadGen
                ? 'Paste personal emails from your Excel sheet. Each hire gets their own one-time link sent immediately — they fill in their own name and sign the contracts on the form.'
                : 'Mint a one-time, no-SSO link. The new hire fills in their name, signs contracts, and submits payment details directly on the form.'}
            </p>
          </DialogHeader>
        </div>

        {/* Department — always on top */}
        <DialogSection label="Where will they work?">
          <DialogField label="Department" hint={deptsLoading ? 'Loading…' : isLeadGen ? 'Bulk mode active — paste emails below.' : 'Optional — helps HR sort submissions.'}>
            <DepartmentSelect
              value={dept}
              onChange={setDept}
              departments={departments}
              loading={deptsLoading}
            />
          </DialogField>
        </DialogSection>

        {isLeadGen ? (
          /* ── Lead Gen bulk mode ── */
          <>
            <DialogSection label="Paste emails">
              <div className="flex flex-col gap-2">
                <textarea
                  value={bulkText}
                  onChange={(e) => setBulkText(e.target.value)}
                  placeholder={'Paste from Excel — one email per row, or comma/tab separated:\n\njane@gmail.com\njohn@yahoo.com\nrose@gmail.com'}
                  rows={10}
                  disabled={busy}
                  className="w-full rounded-lg border border-zinc-300 bg-transparent px-3 py-2 font-mono text-xs leading-relaxed outline-none transition-colors placeholder:text-zinc-400 focus-visible:border-emerald-500 focus-visible:ring-2 focus-visible:ring-emerald-500/20 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900/40 dark:placeholder:text-zinc-600"
                />

                {/* Parsed summary */}
                {bulkText.trim() && (
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
                    {parsedEmails.length > 0 && (
                      <span className="font-medium text-emerald-700 dark:text-emerald-400">
                        ✓ {parsedEmails.length} valid email{parsedEmails.length !== 1 ? 's' : ''}
                      </span>
                    )}
                    {invalidTokens.length > 0 && (
                      <span className="text-amber-600 dark:text-amber-400">
                        ⚠ {invalidTokens.length} skipped (not valid emails)
                      </span>
                    )}
                    {parsedEmails.length === 0 && invalidTokens.length === 0 && (
                      <span className="text-zinc-400">No emails detected yet</span>
                    )}
                  </div>
                )}

                {/* Scrollable parsed email list */}
                {parsedEmails.length > 0 && (
                  <div className="max-h-36 overflow-y-auto rounded-lg border border-emerald-200/80 bg-emerald-50/40 px-3 py-2 dark:border-emerald-900/40 dark:bg-emerald-950/20">
                    <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-widest text-emerald-600 dark:text-emerald-400">Will receive a link</p>
                    <div className="flex flex-wrap gap-1.5">
                      {parsedEmails.map((e) => (
                        <span key={e} className="inline-flex items-center rounded-full border border-emerald-200 bg-white px-2 py-0.5 font-mono text-[11px] text-emerald-900 dark:border-emerald-800/60 dark:bg-emerald-950/40 dark:text-emerald-200">
                          {e}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {invalidTokens.length > 0 && (
                  <div className="rounded-lg border border-amber-200/80 bg-amber-50/40 px-3 py-2 dark:border-amber-900/40 dark:bg-amber-950/20">
                    <p className="mb-1 text-[10px] font-semibold uppercase tracking-widest text-amber-600 dark:text-amber-400">Skipped</p>
                    <p className="font-mono text-[11px] text-amber-800 dark:text-amber-300">{invalidTokens.join(', ')}</p>
                  </div>
                )}
              </div>
            </DialogSection>

            <DialogSection label="Cover note" last>
              <DialogField label="Note for all hires (optional)" hint="Shown at the top of each form.">
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Welcome! Please complete this form before your first day."
                  rows={2}
                  disabled={busy}
                  className="w-full rounded-lg border border-zinc-300 bg-transparent px-2.5 py-1.5 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-emerald-500 focus-visible:ring-2 focus-visible:ring-emerald-500/20 disabled:opacity-50 dark:border-input dark:bg-input/30"
                />
              </DialogField>
            </DialogSection>

            <DialogFooter className="gap-2 pt-2 sm:gap-0">
              <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>Cancel</Button>
              <Button
                size="sm"
                className="bg-gradient-to-br from-emerald-500 to-teal-700 text-white shadow-md shadow-emerald-600/25 hover:from-emerald-500 hover:to-teal-600 disabled:opacity-60"
                onClick={() => void submitBulk()}
                disabled={busy || parsedEmails.length === 0}
              >
                {busy ? (
                  <>
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    {bulkProgress ? `Sending ${bulkProgress.done} / ${bulkProgress.total}…` : 'Working…'}
                  </>
                ) : (
                  <>
                    <Send className="mr-1.5 h-3.5 w-3.5" />
                    {parsedEmails.length > 0
                      ? `Generate & send ${parsedEmails.length} link${parsedEmails.length !== 1 ? 's' : ''}`
                      : 'Paste emails above'}
                  </>
                )}
              </Button>
            </DialogFooter>
          </>
        ) : (
          /* ── Single-hire mode ── */
          <>
            <DialogSection label="Who is this for?">
              <DialogField
                label="Personal email"
                icon={<Mail className="h-3 w-3" />}
                error={emailInvalid ? "Doesn't look like an email" : undefined}
                hint={!emailInvalid ? 'Used to pre-fill the send link. The hire enters their own name on the form.' : undefined}
              >
                <Input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="jane@gmail.com"
                  aria-invalid={emailInvalid || undefined}
                />
              </DialogField>
            </DialogSection>

            <DialogSection label="Cover note" last>
              <DialogField label="Note for the new hire (optional)" hint="Shown at the top of their form.">
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Welcome! Please complete this before your first day so payroll can set you up."
                  rows={3}
                  className="w-full rounded-lg border border-zinc-300 bg-transparent px-2.5 py-1.5 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-emerald-500 focus-visible:ring-2 focus-visible:ring-emerald-500/20 dark:border-input dark:bg-input/30"
                />
              </DialogField>
            </DialogSection>

            <DialogFooter className="gap-2 pt-2 sm:gap-0">
              <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>Cancel</Button>
              <Button
                size="sm"
                className="bg-gradient-to-br from-emerald-500 to-teal-700 text-white shadow-md shadow-emerald-600/25 hover:from-emerald-500 hover:to-teal-600"
                onClick={() => void submitSingle()}
                disabled={busy || emailInvalid}
              >
                {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Send className="mr-1 h-3.5 w-3.5" />}
                {busy ? 'Generating…' : 'Generate link'}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// --- Set-work-email dialog (mints @simple.biz + stages a pending hire) -----

function SetOnboardingWorkEmailDialog({
  row,
  onClose,
  onConverted,
}: {
  row: SubmissionRow | null;
  onClose: () => void;
  onConverted: () => void;
}) {
  const [departments, setDepartments] = useState<string[]>([]);
  const [deptsLoading, setDeptsLoading] = useState(false);
  const [deptRates, setDeptRates] = useState<Map<string, { regular_rate: string | null; ot_rate: string | null }>>(new Map());
  const [dept, setDept] = useState('');
  const [workEmail, setWorkEmail] = useState('');
  const [suggesting, setSuggesting] = useState(false);
  const [checking, setChecking] = useState(false);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [regularRate, setRegularRate] = useState('');
  const [otRate, setOtRate] = useState('');
  const [projectNames, setProjectNames] = useState<string[]>([]);
  const [projectOptions, setProjectOptions] = useState<string[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  // Track which dept we last prefilled rates for so we only prefill on real
  // dept changes, not every time deptRates finishes loading.
  const lastPrefillDept = useRef<string>('');

  const fullName = row?.full_name?.trim() || row?.invite_name?.trim() || '';
  const { first, last } = useMemo(() => splitFullName(fullName), [fullName]);

  // Ask the server for the next free address derived from the hire's name.
  const reSuggest = useCallback(async () => {
    if (!fullName) return;
    setSuggesting(true);
    try {
      const res = await fetch('/api/hr/work-email/suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fullName }),
      });
      const j = (await res.json()) as {
        suggestion?: { email: string } | null;
        error?: string;
      };
      if (j.error) throw new Error(j.error);
      if (j.suggestion?.email) {
        setWorkEmail(j.suggestion.email);
        // Let the debounced useEffect run the real availability check —
        // don't blindly set available=true here.
        setAvailable(null);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not suggest a work email');
    } finally {
      setSuggesting(false);
    }
  }, [fullName]);

  // Seed the form (and a fresh suggestion) whenever a row opens.
  useEffect(() => {
    if (!row) return;
    lastPrefillDept.current = ''; // reset so the initial dept always gets prefilled
    setDept(row.invite_department?.trim() ?? '');
    setWorkEmail('');
    setAvailable(null);
    setRegularRate('');
    setOtRate('');
    setProjectNames([]);
    void reSuggest();
  }, [row, reSuggest]);

  const removeProject = useCallback((name: string) => {
    setProjectNames((prev) => prev.filter((p) => p !== name));
  }, []);

  // Department list + department rates — fetched together when the dialog opens.
  useEffect(() => {
    if (!row) return;
    if (departments.length > 0 || deptsLoading) return;
    setDeptsLoading(true);
    Promise.all([
      fetch('/api/departments', { cache: 'no-store' }).then((r) => r.json()),
      fetch('/api/hr/department-rates', { cache: 'no-store' }).then((r) => r.json()),
    ])
      .then(([dj, rj]: [
        { departments?: string[]; error?: string },
        { departments?: Array<{ department: string; regular_rate: string | null; ot_rate: string | null }>; error?: string },
      ]) => {
        if (dj.error) throw new Error(dj.error);
        setDepartments(dj.departments ?? []);
        const m = new Map<string, { regular_rate: string | null; ot_rate: string | null }>();
        for (const d of rj.departments ?? []) {
          m.set(d.department.trim().toLowerCase(), {
            regular_rate: d.regular_rate,
            ot_rate: d.ot_rate,
          });
        }
        setDeptRates(m);
      })
      .catch((e) =>
        toast.error(e instanceof Error ? e.message : 'Could not load departments'),
      )
      .finally(() => setDeptsLoading(false));
  }, [row, departments.length, deptsLoading]);

  // Prefill rates when dept changes. Uses a ref to distinguish a real dept
  // change from deptRates finishing loading (to avoid stomping user edits).
  useEffect(() => {
    const key = dept.trim().toLowerCase();
    if (!key || key === lastPrefillDept.current) return;
    const rates = deptRates.get(key);
    if (!rates) return;
    lastPrefillDept.current = key;
    if (rates.regular_rate) setRegularRate(rates.regular_rate);
    if (rates.ot_rate) setOtRate(rates.ot_rate);
    else setOtRate('');
  }, [dept, deptRates]);

  // Hubstaff project list — from the secondary Supabase `hubstaff_projects` table.
  useEffect(() => {
    if (!row) return;
    if (projectOptions.length > 0 || projectsLoading) return;
    setProjectsLoading(true);
    fetch('/api/secondary/hubstaff-projects', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j: { projects?: Array<{ name?: string | null }>; error?: string }) => {
        if (j.error) throw new Error(j.error);
        const names = (j.projects ?? [])
          .map((p) => (p?.name ?? '').trim())
          .filter(Boolean);
        setProjectOptions(Array.from(new Set(names)));
      })
      .catch((e) =>
        toast.error(e instanceof Error ? e.message : 'Could not load projects'),
      )
      .finally(() => setProjectsLoading(false));
  }, [row, projectOptions.length, projectsLoading]);

  // Debounced availability check as HR edits the address.
  useEffect(() => {
    if (!row) return;
    const email = workEmail.trim().toLowerCase();
    if (!email) {
      setAvailable(null);
      setChecking(false);
      return;
    }
    let active = true;
    setChecking(true);
    const t = setTimeout(async () => {
      try {
        const res = await fetch('/api/hr/work-email/suggest', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ candidate: email }),
        });
        const j = (await res.json()) as {
          candidate?: { available: boolean } | null;
        };
        if (active) setAvailable(j.candidate ? j.candidate.available : null);
      } catch {
        if (active) setAvailable(null);
      } finally {
        if (active) setChecking(false);
      }
    }, 350);
    return () => {
      active = false;
      clearTimeout(t);
    };
  }, [workEmail, row]);

  const emailNorm = workEmail.trim().toLowerCase();
  const emailValid = isPlausibleEmail(emailNorm) && emailNorm.endsWith('@simple.biz');
  const regularRateNum = Number(regularRate);
  const regularRateValid =
    regularRate.trim() !== '' && Number.isFinite(regularRateNum) && regularRateNum > 0;
  const otRateNum = Number(otRate);
  const otRateValid =
    otRate.trim() === '' || (Number.isFinite(otRateNum) && otRateNum >= 0);
  const canSave =
    !!row &&
    !busy &&
    emailValid &&
    available === true &&
    dept.trim().length > 0 &&
    regularRateValid &&
    otRateValid &&
    projectNames.length > 0;

  async function save() {
    if (!row) return;
    setBusy(true);
    try {
      const res = await fetch(
        `/api/hr/onboarding-submissions/${row.id}/set-work-email`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            work_email: emailNorm,
            department: dept.trim(),
            project_names: projectNames,
            regular_rate: regularRate.trim(),
            ot_rate: otRate.trim() || null,
          }),
        },
      );
      const json = (await res.json()) as {
        ok?: boolean;
        error?: string;
        workspace_account?: { ok?: boolean; error?: string };
      };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Failed to set work email');
      if (json.workspace_account && json.workspace_account.ok === false) {
        toast.warning(`${emailNorm} staged — workspace setup failed`, {
          description: json.workspace_account.error
            ? `${json.workspace_account.error}. Create the Workspace account and Hubstaff invite manually.`
            : 'The onboarding webhook did not fire. Create the Workspace account and Hubstaff invite manually.',
        });
      } else {
        toast.success(
          row.pending_employee_id ? `${emailNorm} updated` : `${emailNorm} assigned`,
          {
            description: row.pending_employee_id
              ? 'Pending hire updated. Workspace account + Hubstaff invite re-sent.'
              : 'Staged in Pending Hires. Workspace account + Hubstaff invite requested.',
          },
        );
      }
      onConverted();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to set work email');
    } finally {
      setBusy(false);
    }
  }

  if (!row) return null;

  const deptKey = dept.trim().toLowerCase();
  const typicalRegular = deptKey ? deptRates.get(deptKey)?.regular_rate : null;
  const typicalOt = deptKey ? deptRates.get(deptKey)?.ot_rate : null;

  return (
    <Dialog open={!!row} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-3xl">
        {/* Header */}
        <div className="-mx-6 -mt-6 mb-4 overflow-hidden rounded-t-lg border-b border-emerald-100/80 bg-gradient-to-br from-emerald-50 via-white to-teal-50/60 px-6 py-5 dark:border-emerald-950/40 dark:from-emerald-950/30 dark:via-zinc-950 dark:to-teal-950/20">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2.5 text-base font-semibold">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-500 to-teal-700 text-white shadow-md shadow-emerald-600/25">
                <Mail className="h-4 w-4" />
              </span>
              Set work email
            </DialogTitle>
            <p className="mt-1 text-[12px] leading-relaxed text-zinc-500 dark:text-zinc-400">
              Suggest an @simple.biz address, pick department and projects, then save to stage in Pending Hires.
            </p>
          </DialogHeader>
        </div>

        {/* Two-column body */}
        <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2">

          {/* ── Left column: identity + department + work email ── */}
          <div className="flex flex-col gap-4">

            {/* New hire info */}
            <div className="flex flex-col gap-1.5">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-zinc-400 dark:text-zinc-500">New hire</p>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs">
                <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-100 bg-emerald-50/60 px-2 py-0.5 text-emerald-900 dark:border-emerald-900/40 dark:bg-emerald-950/40 dark:text-emerald-200">
                  <User className="h-3 w-3 shrink-0" />
                  {fullName || '(no name)'}
                </span>
                {(row.email || row.invite_personal_email) && (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-zinc-200 bg-zinc-50 px-2 py-0.5 font-mono text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
                    <Mail className="h-3 w-3 shrink-0" />
                    {row.email ?? row.invite_personal_email}
                  </span>
                )}
              </div>
              {(first || last) && (
                <p className="text-[11px] text-zinc-400 dark:text-zinc-500">
                  First <span className="font-medium text-zinc-600 dark:text-zinc-300">{first || '-'}</span>
                  {' · '}last <span className="font-medium text-zinc-600 dark:text-zinc-300">{last || '-'}</span>
                </p>
              )}
            </div>

            {/* Department */}
            <div className="flex flex-col gap-1.5">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-zinc-400 dark:text-zinc-500">Department</p>
              <DepartmentSelect
                value={dept}
                onChange={setDept}
                departments={departments}
                loading={deptsLoading}
              />
              <p className="text-[11px] text-zinc-400 dark:text-zinc-500">
                {deptsLoading ? 'Loading…' : 'Required — carried into the staged hire.'}
              </p>
            </div>

            {/* Work email */}
            <div className="flex flex-col gap-1.5">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-zinc-400 dark:text-zinc-500">Work email</p>
              <div className="relative">
                <Input
                  value={workEmail}
                  onChange={(e) => setWorkEmail(e.target.value)}
                  placeholder={suggesting ? 'Suggesting...' : 'namel@simple.biz'}
                  className="pr-9 font-mono"
                  spellCheck={false}
                  autoCapitalize="none"
                />
                <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2">
                  {suggesting || checking ? (
                    <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />
                  ) : available === true ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                  ) : available === false ? (
                    <XCircle className="h-4 w-4 text-rose-500" />
                  ) : null}
                </span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <p className={cn(
                  'text-[11px]',
                  available === false ? 'text-rose-600 dark:text-rose-400'
                    : available === true ? 'text-emerald-600 dark:text-emerald-400'
                    : 'text-zinc-400',
                )}>
                  {available === false
                    ? 'Already in use — try another.'
                    : available === true
                      ? 'Available.'
                      : emailNorm && !emailValid
                        ? 'Must be a valid @simple.biz address.'
                        : 'Checking availability as you type.'}
                </p>
                <button
                  type="button"
                  onClick={() => void reSuggest()}
                  className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-700 hover:underline disabled:opacity-50 dark:text-emerald-300"
                  disabled={suggesting || !fullName}
                >
                  <Wand2 className="h-3 w-3" /> Suggest
                </button>
              </div>
            </div>

          </div>

          {/* ── Right column: rates + projects ── */}
          <div className="flex flex-col gap-4">

            {/* Rates */}
            <div className="flex flex-col gap-1.5">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-zinc-400 dark:text-zinc-500">Compensation</p>
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1">
                  <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300">Regular rate (USD/hr)</label>
                  <Input
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="0.01"
                    value={regularRate}
                    onChange={(e) => setRegularRate(e.target.value)}
                    placeholder="35.50"
                    aria-invalid={regularRate.trim() !== '' && !regularRateValid ? true : undefined}
                  />
                  <p className="text-[11px] text-zinc-400 dark:text-zinc-500">
                    {typicalRegular ? `Dept. typical: $${typicalRegular}` : 'Required'}
                  </p>
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300">OT rate (USD/hr)</label>
                  <Input
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="0.01"
                    value={otRate}
                    onChange={(e) => setOtRate(e.target.value)}
                    placeholder="53.25"
                    aria-invalid={otRate.trim() !== '' && !otRateValid ? true : undefined}
                  />
                  <p className="text-[11px] text-zinc-400 dark:text-zinc-500">
                    {typicalOt ? `Dept. typical: $${typicalOt}` : 'Optional'}
                  </p>
                </div>
              </div>
            </div>

            {/* Projects — takes all remaining space so the dropdown opens downward with room */}
            <div className="flex flex-1 flex-col gap-1.5">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-zinc-400 dark:text-zinc-500">Hubstaff project(s)</p>
              <ProjectMultiSelect
                selected={projectNames}
                onChange={setProjectNames}
                options={projectOptions}
                loading={projectsLoading}
              />
              <p className="text-[11px] text-zinc-400 dark:text-zinc-500">
                Required — the hire is invited to these projects when the workspace account is created.
              </p>
              {projectNames.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {projectNames.map((p) => (
                    <span
                      key={p}
                      className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50/70 px-2 py-0.5 text-[11px] font-medium text-emerald-900 dark:border-emerald-900/40 dark:bg-emerald-950/40 dark:text-emerald-200"
                    >
                      {p}
                      <button
                        type="button"
                        onClick={() => removeProject(p)}
                        className="text-emerald-600 hover:text-emerald-800 dark:text-emerald-400"
                        aria-label={`Remove ${p}`}
                      >
                        <XCircle className="h-3.5 w-3.5" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>

          </div>
        </div>

        <DialogFooter className="mt-4 gap-2 border-t border-zinc-100 pt-4 sm:gap-0 dark:border-zinc-800">
          <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            size="sm"
            className="bg-gradient-to-br from-emerald-500 to-teal-700 text-white shadow-md shadow-emerald-600/25 hover:from-emerald-500 hover:to-teal-600"
            onClick={() => void save()}
            disabled={!canSave}
          >
            {busy ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <UserCheck className="mr-1 h-3.5 w-3.5" />
            )}
            {busy ? 'Saving...' : 'Save and stage hire'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DepartmentSelect({
  value,
  onChange,
  departments,
  loading,
}: {
  value: string;
  onChange: (v: string) => void;
  departments: string[];
  loading: boolean;
}) {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return departments;
    return departments.filter((d) => d.toLowerCase().includes(q));
  }, [departments, query]);

  return (
    <SelectPrimitive.Root
      value={value}
      onValueChange={(v) => onChange(v ?? '')}
      disabled={loading}
      onOpenChange={(open) => { if (!open) setQuery(''); }}
    >
      <SelectPrimitive.Trigger
        className={cn(
          'flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-zinc-300 bg-transparent px-3 py-2 text-sm whitespace-nowrap transition-colors outline-none select-none dark:border-input',
          'data-placeholder:text-muted-foreground',
          'hover:border-zinc-400 dark:hover:border-zinc-500',
          'focus-visible:border-emerald-500 focus-visible:ring-2 focus-visible:ring-emerald-500/20',
          'disabled:cursor-not-allowed disabled:opacity-50',
          'dark:bg-input/30',
        )}
      >
        <SelectPrimitive.Value
          placeholder={loading ? 'Loading departments…' : 'Select department'}
          className="flex-1 text-left"
        />
        <ChevronDownIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Positioner side="bottom" sideOffset={4} alignItemWithTrigger className="isolate z-50">
          <SelectPrimitive.Popup className="w-(--anchor-width) min-w-56 overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-lg shadow-black/8 dark:border-zinc-700 dark:bg-zinc-900 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95">
            {/* Sticky search input — stopPropagation keeps Base UI's typeahead off
                so the user types into the input, not against item keys. */}
            <div className="sticky top-0 z-[1] border-b border-zinc-100 bg-white p-2 dark:border-zinc-800 dark:bg-zinc-900">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter' && filtered.length === 1) {
                      e.preventDefault();
                      onChange(filtered[0]);
                    }
                  }}
                  placeholder="Search departments…"
                  autoFocus
                  className="h-8 w-full rounded-md border border-zinc-200 bg-white pl-8 pr-2 text-xs outline-none transition-colors placeholder:text-zinc-400 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                />
              </div>
            </div>
            <SelectPrimitive.List className="max-h-64 overflow-y-auto p-1">
              {filtered.length === 0 ? (
                <div className="px-3 py-4 text-center text-xs italic text-muted-foreground">
                  {loading
                    ? 'Loading…'
                    : query.trim()
                      ? `No departments match "${query.trim()}".`
                      : 'No departments on file yet.'}
                </div>
              ) : (
                filtered.map((d) => (
                  <SelectPrimitive.Item
                    key={d}
                    value={d}
                    className={cn(
                      'relative flex w-full cursor-default items-center justify-between rounded-lg px-3 py-2 text-sm outline-none select-none',
                      'focus:bg-emerald-50 focus:text-emerald-900 dark:focus:bg-emerald-950/50 dark:focus:text-emerald-100',
                      'data-highlighted:bg-emerald-50 data-highlighted:text-emerald-900 dark:data-highlighted:bg-emerald-950/50 dark:data-highlighted:text-emerald-100',
                    )}
                  >
                    <SelectPrimitive.ItemText className="flex-1 truncate pr-2">
                      {d}
                    </SelectPrimitive.ItemText>
                    <SelectPrimitive.ItemIndicator className="flex h-4 w-4 items-center justify-center">
                      <CheckIcon className="h-3.5 w-3.5 text-emerald-600" />
                    </SelectPrimitive.ItemIndicator>
                  </SelectPrimitive.Item>
                ))
              )}
            </SelectPrimitive.List>
          </SelectPrimitive.Popup>
        </SelectPrimitive.Positioner>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

// --- Hubstaff project multi-select dropdown ------------------------------

/**
 * Multi-select of Hubstaff project names (selected names are sent as
 * `projectNames` to the create-workspace-account webhook). Options are fetched
 * live from the secondary Supabase `hubstaff_projects` table via
 * `/api/secondary/hubstaff-projects`.
 */
function ProjectMultiSelect({
  selected,
  onChange,
  options,
  loading,
}: {
  selected: string[];
  onChange: (next: string[]) => void;
  options: string[];
  loading: boolean;
}) {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((p) => p.toLowerCase().includes(q));
  }, [options, query]);

  const summary =
    selected.length === 0
      ? ''
      : selected.length === 1
        ? selected[0]
        : `${selected.length} projects selected`;

  return (
    <SelectPrimitive.Root
      multiple
      value={selected}
      onValueChange={(v) => onChange((v ?? []) as string[])}
      disabled={loading}
      onOpenChange={(open) => { if (!open) setQuery(''); }}
    >
      <SelectPrimitive.Trigger
        className={cn(
          'flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-zinc-300 bg-transparent px-3 py-2 text-sm whitespace-nowrap transition-colors outline-none select-none dark:border-input',
          'data-placeholder:text-muted-foreground',
          'hover:border-zinc-400 dark:hover:border-zinc-500',
          'focus-visible:border-emerald-500 focus-visible:ring-2 focus-visible:ring-emerald-500/20',
          'disabled:cursor-not-allowed disabled:opacity-50',
          'dark:bg-input/30',
        )}
      >
        <span className={cn('flex-1 truncate text-left', summary ? '' : 'text-muted-foreground')}>
          {loading ? 'Loading projects…' : summary || 'Select project(s)'}
        </span>
        <ChevronDownIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Positioner side="bottom" sideOffset={4} alignItemWithTrigger className="isolate z-50">
          <SelectPrimitive.Popup className="w-(--anchor-width) min-w-56 overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-lg shadow-black/8 dark:border-zinc-700 dark:bg-zinc-900 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95">
            <div className="sticky top-0 z-[1] border-b border-zinc-100 bg-white p-2 dark:border-zinc-800 dark:bg-zinc-900">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => e.stopPropagation()}
                  placeholder="Search projects…"
                  autoFocus
                  className="h-8 w-full rounded-md border border-zinc-200 bg-white pl-8 pr-2 text-xs outline-none transition-colors placeholder:text-zinc-400 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                />
              </div>
            </div>
            <SelectPrimitive.List className="max-h-64 overflow-y-auto p-1">
              {filtered.length === 0 ? (
                <div className="px-3 py-4 text-center text-xs italic text-muted-foreground">
                  {loading
                    ? 'Loading…'
                    : query.trim()
                      ? `No projects match "${query.trim()}".`
                      : 'No projects found.'}
                </div>
              ) : (
                filtered.map((p) => (
                  <SelectPrimitive.Item
                    key={p}
                    value={p}
                    className={cn(
                      'relative flex w-full cursor-default items-center justify-between rounded-lg px-3 py-2 text-sm outline-none select-none',
                      'focus:bg-emerald-50 focus:text-emerald-900 dark:focus:bg-emerald-950/50 dark:focus:text-emerald-100',
                      'data-highlighted:bg-emerald-50 data-highlighted:text-emerald-900 dark:data-highlighted:bg-emerald-950/50 dark:data-highlighted:text-emerald-100',
                    )}
                  >
                    <SelectPrimitive.ItemText className="flex-1 truncate pr-2">
                      {p}
                    </SelectPrimitive.ItemText>
                    <SelectPrimitive.ItemIndicator className="flex h-4 w-4 items-center justify-center">
                      <CheckIcon className="h-3.5 w-3.5 text-emerald-600" />
                    </SelectPrimitive.ItemIndicator>
                  </SelectPrimitive.Item>
                ))
              )}
            </SelectPrimitive.List>
          </SelectPrimitive.Popup>
        </SelectPrimitive.Positioner>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

function DialogSection({
  label,
  last,
  children,
}: {
  label: string;
  last?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={cn('space-y-3 pt-4', !last && 'border-b border-zinc-200 pb-4 dark:border-zinc-800')}>
      <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-500">
        {label}
      </p>
      {children}
    </div>
  );
}

function DialogField({
  label,
  icon,
  hint,
  error,
  children,
}: {
  label: string;
  icon?: ReactNode;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="flex items-center gap-1.5 text-xs font-medium text-zinc-700 dark:text-zinc-400">
        {icon && <span className="text-zinc-400">{icon}</span>}
        {label}
      </Label>
      {children}
      {error ? (
        <p className="text-[11px] text-rose-500">{error}</p>
      ) : hint ? (
        <p className="text-[11px] text-zinc-500 dark:text-zinc-500">{hint}</p>
      ) : null}
    </div>
  );
}

// ─── Link-created dialog (shows the URL with a Copy button) ───────────────

function LinkCreatedDialog({
  row,
  onClose,
  onSent,
}: {
  row: SubmissionRow | null;
  onClose: () => void;
  onSent?: () => void;
}) {
  const [justCopied, setJustCopied] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  // Send rotates the token server-side, so cache the post-send token locally
  // and prefer it for the displayed URL — otherwise Copy link would keep
  // handing out the pre-rotation URL that's now a 404.
  const [rotatedToken, setRotatedToken] = useState<string | null>(null);
  useEffect(() => {
    if (!row) {
      setJustCopied(false);
      setSending(false);
      setSent(false);
      setRotatedToken(null);
    } else {
      setRotatedToken(null);
    }
  }, [row]);

  const displayToken = rotatedToken ?? row?.token ?? '';
  const url = row ? publicLinkFor(displayToken) : '';
  const firstName = row?.invite_name ? row.invite_name.split(/\s+/)[0] : null;
  const mailtoSubject = encodeURIComponent('Your Simple.biz onboarding form');
  const mailtoBodyRaw = `Hi${firstName ? ` ${firstName}` : ''},\n\nWelcome to Simple.biz! Please complete your onboarding form here — it should take about 10 minutes:\n\n${url}\n\nNo account needed; the link is private to you.\n\nLet me know if you hit any issues.\n`;

  const copy = () => {
    void navigator.clipboard.writeText(url);
    setJustCopied(true);
    toast.success('Link copied to clipboard');
    setTimeout(() => setJustCopied(false), 1500);
  };

  const sendViaWebhook = async () => {
    if (!row) return;
    setSending(true);
    try {
      const res = await fetch(`/api/hr/onboarding-submissions/${row.id}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        to?: string;
        token?: string;
        error?: string;
      };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Send failed');
      setSent(true);
      if (json.token) setRotatedToken(json.token);
      toast.success(`Email sent to ${json.to ?? row.invite_personal_email ?? 'recipient'}`);
      onSent?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Send failed');
    } finally {
      setSending(false);
    }
  };

  if (!row) return null;

  return (
    <Dialog open={!!row} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-lg">
        {/* Header strip — mirrors the GenerateLinkDialog so the two feel like one flow. */}
        <div className="-mx-6 -mt-6 mb-1 overflow-hidden rounded-t-lg border-b border-emerald-100/80 bg-gradient-to-br from-emerald-50 via-white to-teal-50/60 px-6 py-5 dark:border-emerald-950/40 dark:from-emerald-950/30 dark:via-zinc-950 dark:to-teal-950/20">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2.5 text-base font-semibold">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-500 to-teal-700 text-white shadow-md shadow-emerald-600/25">
                <CheckCircle2 className="h-4 w-4" />
              </span>
              Link ready to share
            </DialogTitle>
            <p className="mt-1.5 text-[12px] leading-relaxed text-zinc-600 dark:text-zinc-400">
              Send it to {row.invite_name ?? 'the new hire'}. No SSO needed — anyone with this
              link can complete the form one time.
            </p>
          </DialogHeader>
        </div>

        {/* Invitee context (only renders if HR filled any of the fields) */}
        {(row.invite_name || row.invite_personal_email || row.invite_department) && (
          <DialogSection label="For">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
              {row.invite_name && (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-100 bg-emerald-50/60 px-2 py-0.5 text-emerald-900 dark:border-emerald-900/40 dark:bg-emerald-950/40 dark:text-emerald-200">
                  <User className="h-3 w-3" />
                  {row.invite_name}
                </span>
              )}
              {row.invite_personal_email && (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-zinc-200 bg-zinc-50 px-2 py-0.5 font-mono text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
                  <Mail className="h-3 w-3" />
                  {row.invite_personal_email}
                </span>
              )}
              {row.invite_department && (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-zinc-200 bg-zinc-50 px-2 py-0.5 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
                  {row.invite_department}
                </span>
              )}
            </div>
          </DialogSection>
        )}

        <DialogSection label="Shareable link">
          <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 p-3 dark:border-emerald-900/40 dark:bg-emerald-950/30">
            <div className="flex items-start gap-2">
              <Link2 className="mt-[3px] h-4 w-4 shrink-0 text-emerald-700 dark:text-emerald-400" />
              <code
                className="flex-1 break-all font-mono text-[12px] leading-[1.55] text-emerald-900 dark:text-emerald-100"
                aria-label="Onboarding link"
              >
                {url}
              </code>
            </div>
            <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 border-t border-emerald-200/60 pt-2.5 dark:border-emerald-900/40">
              <p className="text-[11px] text-emerald-800/80 dark:text-emerald-300/80">
                Single-use — flips to "Submitted" the moment they finish.
              </p>
              <Button
                size="sm"
                variant="outline"
                className={cn(
                  'h-7 border-emerald-300 text-xs transition-colors',
                  justCopied
                    ? 'bg-emerald-600 text-white hover:bg-emerald-600'
                    : 'text-emerald-800 hover:bg-emerald-100 dark:text-emerald-200 dark:hover:bg-emerald-900/40',
                )}
                onClick={copy}
              >
                {justCopied ? (
                  <>
                    <CheckIcon className="mr-1 h-3 w-3" />
                    Copied
                  </>
                ) : (
                  <>
                    <ClipboardCopy className="mr-1 h-3 w-3" />
                    Copy link
                  </>
                )}
              </Button>
            </div>
          </div>
        </DialogSection>

        <DialogSection label="Send via email" last>
          <div className="space-y-2 rounded-lg border border-zinc-200 bg-zinc-50/60 p-3 dark:border-zinc-800 dark:bg-zinc-900/40">
            <div className="flex items-center gap-2 text-[11px]">
              <span className="rounded bg-white px-1.5 py-0.5 font-mono text-zinc-500 ring-1 ring-zinc-200 dark:bg-zinc-950 dark:text-zinc-400 dark:ring-zinc-700">
                To
              </span>
              <span className="truncate text-zinc-800 dark:text-zinc-200">
                {row.invite_personal_email ?? <span className="italic text-zinc-400">no recipient — you'll fill it in</span>}
              </span>
            </div>
            <div className="flex items-center gap-2 text-[11px]">
              <span className="rounded bg-white px-1.5 py-0.5 font-mono text-zinc-500 ring-1 ring-zinc-200 dark:bg-zinc-950 dark:text-zinc-400 dark:ring-zinc-700">
                Subject
              </span>
              <span className="truncate text-zinc-800 dark:text-zinc-200">
                Your Simple.biz onboarding form
              </span>
            </div>
            <pre className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-zinc-200 bg-white p-2 font-mono text-[11px] leading-relaxed text-zinc-700 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300">
              {mailtoBodyRaw.trim()}
            </pre>
            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
              <p className="text-[11px] italic text-zinc-500 dark:text-zinc-500">
                "Send via webhook" delivers this server-side. The buttons below are manual fallbacks.
              </p>
              <div className="flex flex-wrap gap-1.5">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={() => {
                    void navigator.clipboard.writeText(mailtoBodyRaw.trim());
                    toast.success('Email body copied');
                  }}
                >
                  <ClipboardCopy className="mr-1 h-3 w-3" />
                  Copy body
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={() => {
                    const to = row.invite_personal_email ?? '';
                    const gmail = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(to)}&su=${mailtoSubject}&body=${encodeURIComponent(mailtoBodyRaw)}`;
                    window.open(gmail, '_blank', 'noopener,noreferrer');
                  }}
                >
                  <Mail className="mr-1 h-3 w-3" />
                  Open in Gmail
                </Button>
              </div>
            </div>
          </div>
        </DialogSection>

        <DialogFooter className="gap-2 pt-2 sm:gap-0">
          <Button variant="outline" size="sm" onClick={onClose}>
            Done
          </Button>
          <Button
            size="sm"
            disabled={sending || sent || !row.invite_personal_email}
            className={cn(
              'shadow-md shadow-emerald-600/25 transition-colors',
              sent
                ? 'bg-emerald-600 text-white hover:bg-emerald-600'
                : 'bg-gradient-to-br from-emerald-500 to-teal-700 text-white hover:from-emerald-500 hover:to-teal-600',
            )}
            onClick={() => void sendViaWebhook()}
            title={!row.invite_personal_email ? 'Add a recipient email to enable this.' : undefined}
          >
            {sending ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : sent ? (
              <CheckIcon className="mr-1 h-3.5 w-3.5" />
            ) : (
              <Send className="mr-1 h-3.5 w-3.5" />
            )}
            {sending ? 'Sending…' : sent ? 'Sent' : 'Send via webhook'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Submission detail dialog ─────────────────────────────────────────────

// Left-to-right order of the detail tabs — drives the directional slide so a
// jump to a later tab enters from the right, an earlier tab from the left.
const DETAIL_TAB_ORDER = ['summary', 'non_solicitation', 'privacy', 'contract'] as const;

function SubmissionDetailDialog({
  row: rowProp,
  onClose,
}: {
  row: SubmissionRow | null;
  onClose: () => void;
}) {
  const [w8benUrl, setW8benUrl] = useState<string | null>(null);
  const [tab, setTab] = useState('summary');
  const [tabDirection, setTabDirection] = useState(0);
  const [downloadingW8Ben, setDownloadingW8Ben] = useState(false);

  // Switch tabs while recording which way we moved (1 = rightward, -1 = left)
  // so the panel can slide in the matching direction.
  function selectTab(next: string) {
    const from = DETAIL_TAB_ORDER.indexOf(tab as (typeof DETAIL_TAB_ORDER)[number]);
    const to = DETAIL_TAB_ORDER.indexOf(next as (typeof DETAIL_TAB_ORDER)[number]);
    setTabDirection(to >= from ? 1 : -1);
    setTab(next);
  }

  // Keep the last-opened submission rendered while the dialog plays its close
  // animation. Without this, `row` flips to null on close and the early return
  // unmounts the whole dialog synchronously — Base UI never runs the
  // data-closed:animate-out exit, so the modal just blinks out.
  const [cachedRow, setCachedRow] = useState<SubmissionRow | null>(rowProp);
  useEffect(() => {
    if (rowProp) setCachedRow(rowProp);
  }, [rowProp]);

  const open = !!rowProp;
  const row = rowProp ?? cachedRow;

  // Reset to the Summary tab each time a submission is opened — guarded so it
  // doesn't snap back to Summary mid-close (rowProp is null while closing).
  useEffect(() => {
    if (rowProp) {
      setTab('summary');
      setTabDirection(0);
    }
  }, [rowProp?.id]);

  useEffect(() => {
    if (!row?.w8ben_file_path) {
      setW8benUrl(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/hr/onboarding-submissions/${row.id}`, { cache: 'no-store' });
        const json = (await res.json()) as { w8benUrl?: string };
        if (!cancelled) setW8benUrl(json.w8benUrl ?? null);
      } catch {
        if (!cancelled) setW8benUrl(null);
      }
    })();
    return () => { cancelled = true; };
  }, [row]);

  if (!row) return null;

  // Force a real download (save file) rather than opening it in the browser.
  // The `download` attribute is ignored cross-origin, so fetch the signed URL
  // into a blob and trigger a same-origin object-URL download instead.
  async function handleDownloadW8Ben() {
    if (!w8benUrl) return;
    setDownloadingW8Ben(true);
    try {
      const res = await fetch(w8benUrl);
      if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`);
      const blob = await res.blob();
      const objUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objUrl;
      a.download = row?.w8ben_file_name || 'FW8BEN.pdf';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objUrl);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Download failed');
    } finally {
      setDownloadingW8Ben(false);
    }
  }

  const detailTabs = [
    { value: 'summary', label: 'Summary' },
    { value: 'non_solicitation', label: 'Non-Solicitation', signed: !!row.non_solicitation_signature },
    { value: 'privacy', label: 'Privacy', signed: !!row.privacy_signature },
    { value: 'contract', label: 'Contract', signed: !!row.contract_signature },
  ] as const;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[88vh] w-[min(94vw,920px)] max-w-[min(94vw,920px)] flex-col gap-0 overflow-hidden p-0 data-closed:slide-out-to-bottom-4 data-closed:duration-200 sm:max-w-[min(94vw,920px)]">
        <DialogHeader className="shrink-0 px-6 pt-5 pr-12">
          <DialogTitle className="text-base">
            {row.full_name ?? row.invite_name ?? 'Onboarding submission'}
          </DialogTitle>
          <DialogDescription className="text-xs">
            Submitted {fmtDateTime(row.submitted_at)} · {row.invite_department ?? '—'}
          </DialogDescription>
        </DialogHeader>

        {/* Folder-style tabs: the active tab connects seamlessly into the
            panel below it (shared white edge, broken baseline). */}
        <div className="flex min-h-0 flex-1 flex-col px-6 pb-6 pt-4">
          <TabsPrimitive.Root value={tab} onValueChange={(v) => selectTab(v as string)} className="shrink-0">
            <TabsPrimitive.List className="flex flex-wrap items-end gap-1 border-b border-zinc-200/80 dark:border-zinc-700/70">
              {detailTabs.map((t) => (
                <TabsPrimitive.Tab
                  key={t.value}
                  value={t.value}
                  className={cn(
                    'relative -mb-px flex items-center gap-1.5 rounded-t-lg border px-4 py-2 text-sm font-medium',
                    'transition-[background-color,color,border-color,box-shadow] duration-200 ease-out',
                    'cursor-pointer select-none border-transparent text-zinc-500 outline-none',
                    'hover:bg-white/50 hover:text-zinc-800 focus-visible:ring-2 focus-visible:ring-emerald-500/40',
                    'dark:text-zinc-400 dark:hover:bg-zinc-800/40 dark:hover:text-zinc-200',
                    'data-[active]:z-10 data-[active]:border-zinc-200/90 data-[active]:border-b-white data-[active]:bg-white data-[active]:text-zinc-900 data-[active]:shadow-[0_-1px_8px_-2px_rgba(16,24,40,0.08)]',
                    'dark:data-[active]:border-zinc-700/80 dark:data-[active]:border-b-zinc-950 dark:data-[active]:bg-zinc-950 dark:data-[active]:text-white',
                  )}
                >
                  {t.label}
                  {'signed' in t ? <SignedDot signed={t.signed} /> : null}
                </TabsPrimitive.Tab>
              ))}
            </TabsPrimitive.List>
          </TabsPrimitive.Root>

          {/* Connected content panel. overflow-x-hidden clips the horizontal
              slide so it never spawns a scrollbar mid-transition. */}
          <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden rounded-b-xl rounded-tr-xl border border-t-0 border-zinc-200/90 bg-white p-5 shadow-sm dark:border-zinc-700/80 dark:bg-zinc-950">
            <AnimatePresence mode="wait" initial={false} custom={tabDirection}>
              <motion.div
                key={tab}
                custom={tabDirection}
                variants={{
                  enter: (dir: number) => ({ opacity: 0, x: dir >= 0 ? 36 : -36 }),
                  center: { opacity: 1, x: 0 },
                  exit: (dir: number) => ({ opacity: 0, x: dir >= 0 ? -36 : 36 }),
                }}
                initial="enter"
                animate="center"
                exit="exit"
                transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
              >
                {tab === 'summary' ? (
                  <div className="grid gap-x-8 gap-y-5 md:grid-cols-2">
                    {/* Left column — text-based details */}
                    <div className="space-y-5">
                      <DetailSection title="Personal info">
                        <DetailRow label="Full name" value={row.full_name} />
                        <DetailRow label="Phone" value={row.phone} />
                        <DetailRow label="Email" value={row.email} mono />
                      </DetailSection>

                      <DetailSection title="W-8BEN">
                        <DetailRow
                          label="Applicable?"
                          value={row.w8ben_applicable === null ? '—' : row.w8ben_applicable ? 'Yes — non-US' : 'No — US-based'}
                        />
                        {row.w8ben_file_name && (
                          <div className="flex items-center justify-between gap-2 rounded-lg border border-emerald-100 bg-emerald-50/40 px-3 py-2 text-xs">
                            <div className="flex items-center gap-2 truncate">
                              <FileText className="h-4 w-4 shrink-0 text-emerald-700" />
                              <span className="truncate">{row.w8ben_file_name}</span>
                            </div>
                            {w8benUrl ? (
                              <div className="flex shrink-0 items-center gap-1.5">
                                <a
                                  href={w8benUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center gap-1 rounded-md border border-emerald-300 bg-white px-2 py-1 text-[11px] font-medium text-emerald-800 transition-colors hover:bg-emerald-50"
                                  title="Open the W-8BEN in a new tab"
                                >
                                  <Eye className="h-3 w-3" />
                                  View
                                </a>
                                <button
                                  type="button"
                                  onClick={handleDownloadW8Ben}
                                  disabled={downloadingW8Ben}
                                  className="inline-flex items-center gap-1 rounded-md border border-emerald-600 bg-emerald-600 px-2 py-1 text-[11px] font-medium text-white transition-colors hover:bg-emerald-700 disabled:opacity-60"
                                  title="Download the W-8BEN file"
                                >
                                  {downloadingW8Ben ? (
                                    <Loader2 className="h-3 w-3 animate-spin" />
                                  ) : (
                                    <Download className="h-3 w-3" />
                                  )}
                                  Download
                                </button>
                              </div>
                            ) : (
                              <Loader2 className="h-3 w-3 animate-spin text-emerald-700" />
                            )}
                          </div>
                        )}
                      </DetailSection>

                      <DetailSection title="Payment method">
                        <DetailRow
                          label="Method"
                          value={row.payment_method === 'hurupay' ? 'Hurupay' : row.payment_method === 'wires' ? 'Wire transfer' : '—'}
                        />
                        {row.payment_method === 'hurupay' && (
                          <DetailRow label="Hurupay email" value={row.hurupay_email} />
                        )}
                        {row.payment_method === 'wires' && (
                          <div className="grid gap-1.5 sm:grid-cols-2">
                            <DetailRow label="Bank" value={row.bank_full_name} />
                            <DetailRow label="Account name" value={row.bank_account_name} />
                            <DetailRow label="Account number" value={row.bank_account_number} mono />
                            <DetailRow label="SWIFT" value={row.bank_swift_code} mono />
                            <DetailRow label="Street" value={row.bank_street} />
                            <DetailRow label="City" value={row.bank_city} />
                            <DetailRow label="Province" value={row.bank_province} />
                            <DetailRow label="Postal code" value={row.bank_postal_code} />
                            <DetailRow label="Full address" value={row.bank_full_address} className="sm:col-span-2" />
                          </div>
                        )}
                      </DetailSection>
                    </div>

                    {/* Right column — signatures */}
                    <div className="space-y-5">
                      <DetailSection title="Agreement signatures">
                        <SignaturePreview label="Non-solicitation" src={row.non_solicitation_signature} />
                        <SignaturePreview label="Privacy" src={row.privacy_signature} />
                        <SignaturePreview label="Contract worker agreement" src={row.contract_signature} />
                        <DetailRow label="Contract date" value={fmtDate(row.contract_date)} />
                      </DetailSection>
                    </div>
                  </div>
                ) : tab === 'non_solicitation' ? (
                  <AgreementTab
                    title={AGREEMENT_TITLES.nonSolicitation}
                    signatureSrc={row.non_solicitation_signature}
                  >
                    <NonSolicitationText />
                  </AgreementTab>
                ) : tab === 'privacy' ? (
                  <AgreementTab title={AGREEMENT_TITLES.privacy} signatureSrc={row.privacy_signature}>
                    <PrivacyText />
                  </AgreementTab>
                ) : (
                  <AgreementTab
                    title={AGREEMENT_TITLES.contract}
                    signatureSrc={row.contract_signature}
                    signedOn={row.contract_signature ? fmtDate(row.contract_date) : null}
                  >
                    <ContractWorkerText />
                  </AgreementTab>
                )}
              </motion.div>
            </AnimatePresence>
          </div>
        </div>

        {/* mx-0/mb-0 cancel DialogFooter's default -mx-4/-mb-4 (those assume the
            dialog's default p-4; this modal is p-0, so without resetting them the
            footer overflows and the Close button hugs the corner). */}
        <DialogFooter className="mx-0 mb-0 shrink-0 rounded-b-xl border-t border-zinc-200/70 bg-white/70 px-6 py-4 backdrop-blur-sm dark:border-zinc-800/70 dark:bg-zinc-950/50 sm:justify-end sm:gap-0">
          <Button variant="outline" size="sm" onClick={onClose}>
            <CheckCircle2 className="mr-1 h-3 w-3" />
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-emerald-700/80">
        {title}
      </h3>
      <div className="space-y-1.5">{children}</div>
    </section>
  );
}

function DetailRow({
  label,
  value,
  mono,
  className,
}: {
  label: string;
  value: string | null | undefined;
  mono?: boolean;
  className?: string;
}) {
  return (
    <div className={cn('flex items-baseline justify-between gap-3 text-xs', className)}>
      <span className="shrink-0 text-zinc-500">{label}</span>
      <span className={cn('min-w-0 flex-1 truncate text-right text-zinc-800 dark:text-zinc-200', mono && 'font-mono')}>
        {value ?? '—'}
      </span>
    </div>
  );
}

function SignaturePreview({ label, src }: { label: string; src: string | null }) {
  if (!src) {
    return (
      <div className="flex items-center justify-between text-xs">
        <span className="text-zinc-500">{label}</span>
        <span className="text-zinc-400">No signature</span>
      </div>
    );
  }
  return (
    // Signatures are dark ink, so the canvas stays white in both themes — which
    // means the label must be dark (not the default light-on-dark) to stay
    // readable against it.
    <div className="rounded-lg border border-zinc-200 bg-white p-2 dark:border-zinc-300">
      <div className="mb-1 text-[11px] font-medium text-zinc-600 dark:text-zinc-900">{label}</div>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={`${label} signature`} className="max-h-24 w-full object-contain" />
    </div>
  );
}

// Small colored dot in a tab trigger — green when that agreement has a
// signature on file, amber when it's still unsigned.
function SignedDot({ signed }: { signed: boolean }) {
  return (
    <span
      className={cn('ml-1.5 h-1.5 w-1.5 rounded-full', signed ? 'bg-emerald-500' : 'bg-amber-400')}
      aria-label={signed ? 'Signed' : 'Not signed'}
    />
  );
}

// One granular agreement tab: the legal copy the hiree saw, a signed/not-signed
// badge, and the captured signature image (or a clear "not signed" notice).
function AgreementTab({
  title,
  signatureSrc,
  signedOn,
  children,
}: {
  title: string;
  signatureSrc: string | null;
  signedOn?: string | null;
  children: React.ReactNode;
}) {
  const signed = !!signatureSrc;
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{title}</h3>
        <span
          className={cn(
            'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold',
            signed
              ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
              : 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300',
          )}
        >
          {signed ? <CheckCircle2 className="h-3 w-3" /> : null}
          {signed ? 'Signed' : 'Not signed'}
        </span>
      </div>

      <div className="max-h-64 overflow-y-auto rounded-lg border border-zinc-200 bg-zinc-50/50 p-4 dark:border-zinc-800 dark:bg-zinc-900/40">
        {children}
      </div>

      <div className="rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-300">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-600">
            Signature
          </span>
          {signedOn ? (
            <span className="text-[11px] text-zinc-500 dark:text-zinc-600">Dated {signedOn}</span>
          ) : null}
        </div>
        {signed ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={signatureSrc!}
            alt={`${title} signature`}
            className="max-h-32 w-full object-contain"
          />
        ) : (
          <p className="py-4 text-center text-xs text-zinc-400">
            No signature captured — the hiree has not signed this agreement.
          </p>
        )}
      </div>
    </div>
  );
}

// ─── Filter pill ──────────────────────────────────────────────────────────

function FilterPill({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors',
        active
          ? 'bg-gradient-to-r from-emerald-500 to-teal-700 text-white shadow-sm shadow-emerald-600/25'
          : 'text-zinc-600 hover:bg-emerald-50 hover:text-emerald-900 dark:text-zinc-300 dark:hover:bg-emerald-950/40 dark:hover:text-emerald-100',
      )}
    >
      {label}
      <span
        className={cn(
          'rounded-full px-1.5 text-[10px] tabular-nums',
          active ? 'bg-white/20 text-white' : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400',
        )}
      >
        {count}
      </span>
    </button>
  );
}
