'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence, useSpring, useTransform, useReducedMotion } from 'motion/react';
import { toast } from 'sonner';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Loader2,
  Mail,
  MailQuestion,
  Pencil,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2,
  Undo2,
  Users,
  XCircle,
  Zap,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import React from 'react';
import DeptFilter from './DeptFilter';
import HrOnboardingForm from './HrOnboardingForm';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';
import { getHrTabCache, hasHrTabCache, setHrTabCache, HR_TAB_CACHE_KEYS } from '@/lib/hr/tab-cache';
import type {
  HrPendingEmployeeRow,
  HrPendingStatus,
} from '@/lib/supabase/hr-pending-employees';

type TabFilter = 'pending' | 'ready' | 'promoted' | 'failed' | 'cancelled' | 'no_show' | 'all';
type SubTab = 'pending-hires' | 'onboarding-form';

/**
 * A "jump to a submission" request handed down from a notification click (see
 * HrApp). `nonce` changes on every click so the same target re-triggers the
 * effects even when the tab/submission is unchanged.
 */
export type OnboardingDeepLink = {
  subTab?: SubTab;
  submissionId?: string | null;
  nonce: number;
};

// Left-to-right order of the sub-tabs, so the panel can slide in the direction
// that matches the pill the user moved toward.
const SUB_TAB_ORDER: Record<SubTab, number> = { 'onboarding-form': 0, 'pending-hires': 1 };

// Directional crossfade for the sub-tab panels. `dir` is +1 when moving to a
// later tab, -1 when moving back — the incoming panel enters from that side.
const SUB_TAB_VARIANTS = {
  enter: (dir: number) => ({ opacity: 0, x: dir >= 0 ? 28 : -28 }),
  center: { opacity: 1, x: 0 },
  exit: (dir: number) => ({ opacity: 0, x: dir >= 0 ? -28 : 28 }),
};

const STATUS_LABEL: Record<HrPendingStatus, string> = {
  pending_work_email: 'Awaiting work email',
  ready: 'Ready to promote',
  promoted: 'Promoted',
  cancelled: 'Cancelled',
  no_show: 'No-show',
  failed_to_promote: 'Failed to promote',
};

const STATUS_BADGE: Record<HrPendingStatus, string> = {
  pending_work_email:
    'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950/35 dark:text-amber-100',
  ready:
    'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-100',
  promoted:
    'border-sky-300 bg-sky-50 text-sky-900 dark:border-sky-700 dark:bg-sky-950/40 dark:text-sky-100',
  cancelled:
    'border-zinc-300 bg-zinc-100 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400',
  no_show:
    'border-rose-300 bg-rose-50 text-rose-900 dark:border-rose-700 dark:bg-rose-950/40 dark:text-rose-100',
  // Loud red so a hire that didn't make it end-to-end can't be mistaken for done.
  failed_to_promote:
    'border-red-400 bg-red-100 text-red-900 dark:border-red-600 dark:bg-red-950/50 dark:text-red-100',
};

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export default function HrOnboarding({ deepLink }: { deepLink?: OnboardingDeepLink | null } = {}) {
  const reduceMotion = useReducedMotion();
  const [subTab, setSubTab] = useState<SubTab>('onboarding-form');
  // Direction of the last sub-tab move (+1 forward, -1 back) so the panel
  // slides toward the pill the user clicked.
  const [subDir, setSubDir] = useState(1);
  const selectSubTab = useCallback(
    (next: SubTab) => {
      setSubTab((cur) => {
        if (next !== cur) setSubDir(SUB_TAB_ORDER[next] >= SUB_TAB_ORDER[cur] ? 1 : -1);
        return next;
      });
    },
    [],
  );

  // A notification click asked us to open a specific submission: switch to the
  // requested sub-tab and forward the id to the form, which opens its drawer.
  // Keyed on `nonce` so re-clicking the same notification fires again.
  const [openSubmission, setOpenSubmission] = useState<{ id: string; nonce: number } | null>(null);
  useEffect(() => {
    if (!deepLink) return;
    if (deepLink.subTab) selectSubTab(deepLink.subTab);
    if (deepLink.submissionId) {
      setOpenSubmission({ id: deepLink.submissionId, nonce: deepLink.nonce });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepLink?.nonce]);
  const [pending, setPending] = useState<HrPendingEmployeeRow[]>(
    () => getHrTabCache<HrPendingEmployeeRow[]>(HR_TAB_CACHE_KEYS.pendingEmployees) ?? [],
  );
  const [pendingLoading, setPendingLoading] = useState(
    () => !hasHrTabCache(HR_TAB_CACHE_KEYS.pendingEmployees),
  );

  const [search, setSearch] = useState('');
  const [dept, setDept] = useState('');
  const [tab, setTab] = useState<TabFilter>('pending');
  const [setEmailFor, setSetEmailFor] = useState<HrPendingEmployeeRow | null>(null);
  const [confirmCancel, setConfirmCancel] = useState<HrPendingEmployeeRow | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<HrPendingEmployeeRow | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [busyRetryId, setBusyRetryId] = useState<number | null>(null);
  const [bulkPromoting, setBulkPromoting] = useState(false);
  const [bulkResult, setBulkResult] = useState<{
    promoted: number; failed: number; total: number;
  } | null>(null);
  // Multi-select promote (Ready tab). Holds the ids ticked in the table.
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [promotingSelected, setPromotingSelected] = useState(false);
  const [confirmPromoteRows, setConfirmPromoteRows] = useState<HrPendingEmployeeRow[] | null>(null);
  // Multi-select "Back to Ready" (Promoted tab) — bulk unpromote.
  const [unpromotingSelected, setUnpromotingSelected] = useState(false);
  const [confirmBackToReadyRows, setConfirmBackToReadyRows] = useState<HrPendingEmployeeRow[] | null>(null);
  // Live state for the bulk-promote progress modal (null when closed). Updated
  // after every chunk so the bar + the Promoted/Failed KPI counters move in
  // real time as the batch lands.
  const [promoteModal, setPromoteModal] = useState<{
    total: number;
    done: number;
    promoted: number;
    failed: number;
    status: 'running' | 'done';
    firstErr?: string;
  } | null>(null);

  const fetchPending = useCallback(async () => {
    setPendingLoading(true);
    try {
      const res = await fetch('/api/hr/pending-employees', { cache: 'no-store' });
      const json = (await res.json()) as {
        rows?: HrPendingEmployeeRow[];
        error?: string;
      };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Failed to load');
      setPending(json.rows ?? []);
      setHrTabCache(HR_TAB_CACHE_KEYS.pendingEmployees, json.rows ?? []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load pending hires');
      setPending([]);
    } finally {
      setPendingLoading(false);
    }
  }, []);

  useEffect(() => {
    // Seeded from the in-session cache on remount — skip the initial fetch when
    // warm so switching back to this tab doesn't re-query / re-flash the table.
    // Realtime (below) + mutations + the Refresh button keep the cache fresh.
    if (hasHrTabCache(HR_TAB_CACHE_KEYS.pendingEmployees)) return;
    void fetchPending();
  }, [fetchPending]);

  const fetchPendingRef = useRef(fetchPending);
  fetchPendingRef.current = fetchPending;
  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const channel = supabase
      .channel('hr-pending-employees-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'hr_pending_employees' }, () => {
        void fetchPendingRef.current();
      })
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, []);

  // Drop any selection whenever the tab changes. Each tab's bulk action differs
  // (Ready/Failed → Promote/Retry; Promoted → Back to Ready), so a selection must
  // never carry into a tab where a different action would apply to it — or onto
  // rows the user can no longer see. (Search / dept filter / page change keep the
  // selection so bulk ticks survive narrowing, per the persistent-multiselect
  // convention.)
  useEffect(() => {
    setSelected(new Set());
  }, [tab]);

  const filteredPending = useMemo(() => {
    const q = search.trim().toLowerCase();
    return pending.filter((r) => {
      if (tab !== 'all') {
        if (tab === 'pending' && r.status !== 'pending_work_email') return false;
        if (tab === 'ready' && r.status !== 'ready') return false;
        if (tab === 'promoted' && r.status !== 'promoted') return false;
        if (tab === 'failed' && r.status !== 'failed_to_promote') return false;
        if (tab === 'cancelled' && r.status !== 'cancelled') return false;
        if (tab === 'no_show' && r.status !== 'no_show') return false;
      }
      if (dept && (r.department ?? '').trim() !== dept) return false;
      if (!q) return true;
      return [r.name, r.display_name, r.personal_email, r.work_email, r.department, r.source]
        .filter(Boolean)
        .some((s) => s!.toLowerCase().includes(q));
    });
  }, [pending, search, tab, dept]);

  const counts = useMemo(() => {
    const c = {
      pending: 0,
      ready: 0,
      promoted: 0,
      failed: 0,
      cancelled: 0,
      no_show: 0,
    };
    for (const r of pending) {
      if (r.status === 'pending_work_email') c.pending += 1;
      else if (r.status === 'ready') c.ready += 1;
      else if (r.status === 'promoted') c.promoted += 1;
      else if (r.status === 'failed_to_promote') c.failed += 1;
      else if (r.status === 'cancelled') c.cancelled += 1;
      else if (r.status === 'no_show') c.no_show += 1;
    }
    return c;
  }, [pending]);

  // The Promoted tab accumulates every hire that ever made it to the master
  // list, so it pages 10 at a time. Every other tab shows all matching rows.
  const PROMOTED_PAGE_SIZE = 10;
  const [promotedPage, setPromotedPage] = useState(0);
  useEffect(() => {
    setPromotedPage(0);
  }, [tab, search, dept]);
  const promotedPaged = tab === 'promoted';
  const promotedTotalPages = Math.max(1, Math.ceil(filteredPending.length / PROMOTED_PAGE_SIZE));
  const promotedSafePage = Math.min(promotedPage, promotedTotalPages - 1);
  const displayPending = promotedPaged
    ? filteredPending.slice(
        promotedSafePage * PROMOTED_PAGE_SIZE,
        (promotedSafePage + 1) * PROMOTED_PAGE_SIZE,
      )
    : filteredPending;

  const isPromotedTab = tab === 'promoted';
  // Rows in the CURRENT VIEW that can be ticked. On Ready/Failed that's any
  // promotable row (orientation confirmed; both 'ready' and 'failed_to_promote'
  // already have a work email). On Promoted, every promoted row is selectable for
  // bulk "Back to Ready" — there's no orientation gate. Scoped to the visible
  // rows (displayPending) so "select all" on the paged Promoted tab toggles just
  // this page; individual ticks still persist across pages via the `selected` set.
  const selectableIds = useMemo(
    () =>
      displayPending
        .filter((r) =>
          isPromotedTab
            ? r.status === 'promoted'
            : (r.status === 'ready' || r.status === 'failed_to_promote') &&
              !!r.orientation_attended_at,
        )
        .map((r) => r.id),
    [displayPending, isPromotedTab],
  );
  const selectedCount = selectableIds.filter((id) => selected.has(id)).length;
  const allSelected = selectableIds.length > 0 && selectedCount === selectableIds.length;
  const someSelected = selectedCount > 0 && !allSelected;
  const canMultiSelect = tab === 'ready' || tab === 'failed' || isPromotedTab;
  const showSelect = canMultiSelect && selectableIds.length > 0;

  function toggleOne(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleAll() {
    setSelected((prev) => {
      const next = new Set(prev);
      // If every selectable row in the current view is ticked, clear just those
      // (keeping any ticks made on other paged views); otherwise add them all.
      const everything = selectableIds.every((id) => next.has(id));
      for (const id of selectableIds) {
        if (everything) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  }

  async function promote(row: HrPendingEmployeeRow) {
    setBusyId(row.id);
    try {
      const res = await fetch(`/api/hr/pending-employees/${row.id}/promote`, {
        method: 'POST',
      });
      const json = (await res.json()) as {
        error?: string;
        sheet?: { appended?: boolean; reason?: string } | null;
      };
      // A promote is only a success when it landed on the master list AND the
      // Google Sheet end-to-end. Any failure (incl. the Sheet write) comes back
      // as an error and leaves the row 'failed_to_promote' (red, retryable).
      if (!res.ok || json.error) throw new Error(json.error ?? 'Failed to promote');
      toast.success(`${row.name} added to the master list`, {
        description: 'Now visible across Payroll, Manager, and Orphanage views.',
      });
      await fetchPending();
    } catch (e) {
      toast.error(`Could not promote ${row.name}`, {
        description: e instanceof Error ? e.message : 'Failed to promote. Retry from the Failed tab.',
      });
      // Refresh so the row's red "Failed to promote" pill shows up.
      await fetchPending();
    } finally {
      setBusyId(null);
    }
  }

  async function bulkPromoteLeadGen() {
    setBulkPromoting(true);
    setBulkResult(null);
    try {
      const res = await fetch('/api/hr/pending-employees/bulk-promote', { method: 'POST' });
      const json = (await res.json()) as {
        promoted?: number; failed?: number; total?: number;
        message?: string; error?: string;
      };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Bulk promote failed');
      const promoted = json.promoted ?? 0;
      const failed = json.failed ?? 0;
      const total = json.total ?? 0;
      setBulkResult({ promoted, failed, total });
      if (total === 0) {
        toast.info(json.message ?? 'No Lead Gen hires are ready to promote.');
      } else if (failed === 0) {
        toast.success(`${promoted} Lead Gen hire${promoted !== 1 ? 's' : ''} promoted`, {
          description: 'All added to the master list. Hubstaff invites sent.',
        });
      } else {
        toast.warning(`${promoted} promoted, ${failed} failed`, {
          description: 'Check the console for per-hire details.',
        });
      }
      await fetchPending();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Bulk promote failed');
    } finally {
      setBulkPromoting(false);
    }
  }

  async function promoteSelected() {
    const ids = [...selected];
    if (ids.length === 0) return;
    setPromotingSelected(true);
    setPromoteModal({ total: ids.length, done: 0, promoted: 0, failed: 0, status: 'running' });

    // Send the selection in chunks so a large batch never lands in a single
    // long request (the server batches each chunk's Sheet write into one call,
    // but chunking on the client keeps every request comfortably under the
    // function time limit and lets us show progress as it goes).
    const CHUNK = 15;
    let promoted = 0;
    let failed = 0;
    let firstErr: { name: string; error: string } | null = null;

    try {
      for (let i = 0; i < ids.length; i += CHUNK) {
        const chunk = ids.slice(i, i + CHUNK);
        const res = await fetch('/api/hr/pending-employees/bulk-promote', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: chunk }),
        });
        const json = (await res.json()) as {
          promoted?: number; failed?: number; total?: number;
          results?: Array<{ name: string; ok: boolean; error: string | null; sheetAppended: boolean | null }>;
          error?: string;
        };
        if (!res.ok || json.error) throw new Error(json.error ?? 'Bulk promote failed');
        // The server now only counts a hire 'promoted' when it landed on the
        // master list AND the Google Sheet. A Sheet miss is a failure (the row
        // is left 'failed_to_promote'), not a silent warning.
        promoted += json.promoted ?? 0;
        failed += json.failed ?? 0;
        for (const r of json.results ?? []) {
          if (!r.ok && r.error && !firstErr) firstErr = { name: r.name, error: r.error };
        }
        const done = Math.min(i + CHUNK, ids.length);
        setPromoteModal((m) => (m ? { ...m, done, promoted, failed } : m));
      }

      setPromoteModal((m) =>
        m
          ? {
              ...m,
              status: 'done',
              done: ids.length,
              promoted,
              failed,
              firstErr: firstErr ? `${firstErr.name}: ${firstErr.error}` : undefined,
            }
          : m,
      );
      setSelected(new Set());
      // Table updates live via Realtime; this is a belt-and-braces refresh.
      await fetchPending();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Bulk promote failed';
      toast.error(msg);
      // Some rows in the chunk may already be 'failed_to_promote' — refresh so
      // their red pills + the Failed tab show up for retry.
      setPromoteModal((m) => (m ? { ...m, status: 'done', firstErr: msg } : m));
      await fetchPending();
    } finally {
      setPromotingSelected(false);
    }
  }

  async function backToReadySelected() {
    const ids = pending
      .filter((r) => selected.has(r.id) && r.status === 'promoted')
      .map((r) => r.id);
    if (ids.length === 0) return;
    setUnpromotingSelected(true);
    try {
      const res = await fetch('/api/hr/pending-employees/bulk-unpromote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      const json = (await res.json()) as {
        reverted?: number;
        failed?: number;
        total?: number;
        results?: Array<{ id: number; name: string; ok: boolean; error: string | null }>;
        error?: string;
      };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Failed to send back to Ready');
      const reverted = json.reverted ?? 0;
      const failed = json.failed ?? 0;
      if (failed === 0) {
        toast.success(`${reverted} hire${reverted !== 1 ? 's' : ''} sent back to Ready`, {
          description: 'Removed from the master list + Google Sheet; promote again after any fixes.',
        });
      } else {
        const firstErr = json.results?.find((r) => !r.ok && r.error);
        toast.warning(`${reverted} sent back, ${failed} failed`, {
          description: firstErr
            ? `${firstErr.name}: ${firstErr.error}`
            : 'Some hires could not be sent back to Ready.',
        });
      }
      setSelected(new Set());
      // Table updates live via Realtime; this is a belt-and-braces refresh.
      await fetchPending();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to send back to Ready');
      await fetchPending();
    } finally {
      setUnpromotingSelected(false);
    }
  }

  async function sendBackToReady(row: HrPendingEmployeeRow) {
    setBusyId(row.id);
    try {
      const res = await fetch(`/api/hr/pending-employees/${row.id}/unpromote`, {
        method: 'POST',
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Failed to send back to Ready');
      toast.success(`${row.name} sent back to Ready`, {
        description: 'Removed from the master list + Google Sheet; promote again after any fixes.',
      });
      await fetchPending();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to send back to Ready');
    } finally {
      setBusyId(null);
    }
  }

  async function cancel(row: HrPendingEmployeeRow) {
    setBusyId(row.id);
    try {
      const res = await fetch(`/api/hr/pending-employees/${row.id}`, {
        method: 'DELETE',
      });
      const json = (await res.json()) as {
        error?: string;
        webhook?: { fired: boolean; status: number | null; error: string | null } | null;
        onboarding_archived?: boolean;
      };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Failed to cancel');

      const hadAccount = !!row.work_email;
      const webhookFailed =
        hadAccount && (!json.webhook || !json.webhook.fired || json.webhook.error != null);

      if (webhookFailed) {
        // Row is cancelled, but the Workspace deletion didn't fire — HR must
        // tear the account down by hand so it doesn't linger.
        toast.warning(`Cancelled ${row.name} - Workspace account may NOT have been deleted`, {
          description: `${json.webhook?.error ?? 'The deletion webhook did not fire'}. Delete ${row.work_email} in Google Workspace + Hubstaff manually.`,
        });
      } else {
        const bits: string[] = [];
        if (hadAccount) bits.push('Workspace account + Hubstaff deleted');
        if (json.onboarding_archived) bits.push('onboarding form archived');
        toast.success(`Cancelled ${row.name}`, {
          description: bits.length ? `${bits.join(' and ')}.` : undefined,
        });
      }
      await fetchPending();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to cancel');
    } finally {
      setBusyId(null);
      setConfirmCancel(null);
    }
  }

  async function hardDelete(row: HrPendingEmployeeRow) {
    setBusyId(row.id);
    try {
      const res = await fetch(`/api/hr/pending-employees/${row.id}?hard=true`, {
        method: 'DELETE',
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Failed to delete');
      toast.success(`Deleted ${row.name}`);
      await fetchPending();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to delete');
    } finally {
      setBusyId(null);
      setConfirmDelete(null);
    }
  }

  async function saveWorkEmail(row: HrPendingEmployeeRow, workEmail: string) {
    setBusyId(row.id);
    try {
      const res = await fetch(`/api/hr/pending-employees/${row.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ work_email: workEmail.trim() || null }),
      });
      const json = (await res.json()) as {
        error?: string;
        workspace?: { ok: boolean; error?: string } | null;
      };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Failed to save');
      if (json.workspace && !json.workspace.ok) {
        toast.warning(`Work email saved for ${row.name} — workspace setup failed`, {
          description: json.workspace.error
            ? `${json.workspace.error}. Create the Workspace account and Hubstaff invite manually.`
            : 'The onboarding webhook did not fire. Create the Workspace account and Hubstaff invite manually.',
        });
      } else {
        toast.success(`Work email saved for ${row.name}`, {
          description: json.workspace?.ok ? 'Workspace account + Hubstaff invite requested.' : undefined,
        });
      }
      await fetchPending();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setBusyId(null);
      setSetEmailFor(null);
    }
  }

  async function retryWorkspace(row: HrPendingEmployeeRow) {
    setBusyRetryId(row.id);
    try {
      const res = await fetch(`/api/hr/pending-employees/${row.id}/retry-workspace`, {
        method: 'POST',
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Workspace retry failed');
      toast.success(`Workspace setup re-sent for ${row.name}`, {
        description: `Hubstaff invite + Roboform emails will be delivered to ${row.work_email}.`,
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Workspace retry failed', {
        description: 'Check the n8n logs. You may need to create the account manually.',
      });
    } finally {
      setBusyRetryId(null);
    }
  }

  return (
    <div className="flex flex-col gap-6 px-4 pb-10 pt-6 sm:px-6 lg:gap-8 lg:px-8 lg:pt-8">
      {/* Hero header */}
      <header className="relative overflow-hidden rounded-2xl border border-emerald-200/80 bg-gradient-to-br from-emerald-500 via-teal-600 to-zinc-900 px-5 py-7 text-white shadow-lg shadow-emerald-600/20 dark:border-emerald-900/50 dark:from-emerald-600 dark:via-teal-900 dark:to-black sm:px-7">
        <div className="absolute -right-10 -top-10 h-36 w-36 rounded-full bg-white/10 blur-3xl" aria-hidden />
        <div className="absolute -bottom-12 left-8 h-32 w-32 rounded-full bg-teal-300/20 blur-2xl" aria-hidden />
        <div className="relative flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between lg:gap-6">
          <div className="flex min-w-0 flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.18em] text-emerald-100/95">
              <Users className="h-3 w-3 shrink-0" />
              Onboarding
            </div>
            <h1 className="text-balance text-2xl font-bold tracking-tight sm:text-3xl">
              Stage new hires before they hit the master list.
            </h1>
            <p className="max-w-2xl text-sm leading-relaxed text-emerald-100/85">
              Add interview-stage hires here. Once Payroll provides the @simple.biz
              work email and orientation is confirmed, promote the row — it lands
              in the Global Master List and flows into every other dashboard.
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="border-white/35 bg-white/10 text-white backdrop-blur-sm hover:bg-white/20 hover:text-white"
              onClick={() => void bulkPromoteLeadGen()}
              disabled={bulkPromoting || pendingLoading}
              title="Promote all ready Lead Gen hires at once (orientation confirmed + work email required)"
            >
              {bulkPromoting ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Zap className="mr-1.5 h-3.5 w-3.5" />
              )}
              Bulk promote (Lead Gen)
            </Button>
          </div>
          {bulkResult && bulkResult.total > 0 && (
            <div className="mt-2 text-xs text-emerald-100/80">
              Last bulk: {bulkResult.promoted} promoted
              {bulkResult.failed > 0 && `, ${bulkResult.failed} failed`}
            </div>
          )}
        </div>
      </header>

      {/* Sub-tabs */}
      <div role="tablist" aria-label="Onboarding views" className="-mb-2 flex flex-wrap items-center gap-1.5 border-b border-emerald-100/60 pb-2 dark:border-emerald-900/40">
        <SubTabPill
          label="Onboarding Form"
          active={subTab === 'onboarding-form'}
          onClick={() => selectSubTab('onboarding-form')}
        />
        <SubTabPill
          label="Pending Hires"
          active={subTab === 'pending-hires'}
          onClick={() => selectSubTab('pending-hires')}
        />
      </div>

      {/* overflow-x-clip contains the horizontal slide without spawning a page
          scrollbar (and, unlike overflow-x-hidden, never turns this into a
          scroll container — the table's sticky header keeps working). */}
      <div className="overflow-x-clip">
        <AnimatePresence mode="wait" initial={false} custom={subDir}>
          <motion.div
            key={subTab}
            custom={subDir}
            variants={SUB_TAB_VARIANTS}
            initial="enter"
            animate="center"
            exit="exit"
            transition={{ duration: reduceMotion ? 0 : 0.22, ease: [0.22, 1, 0.36, 1] }}
            className="flex flex-col gap-6 lg:gap-8"
          >
            {subTab === 'onboarding-form' ? (
              <HrOnboardingForm openSubmission={openSubmission} />
            ) : (
            <>
      {/* Stat tiles */}
      <section className="grid gap-3 sm:grid-cols-3" aria-label="Pending hire counts">
        <StatTile
          label="Awaiting work email"
          value={counts.pending}
          icon={MailQuestion}
          accent="amber"
          onClick={() => setTab('pending')}
          active={tab === 'pending'}
        />
        <StatTile
          label="Ready to promote"
          value={counts.ready}
          icon={CheckCircle2}
          accent="emerald"
          onClick={() => setTab('ready')}
          active={tab === 'ready'}
        />
        <StatTile
          label="Promoted"
          value={counts.promoted}
          icon={ClipboardList}
          accent="sky"
          onClick={() => setTab('promoted')}
          active={tab === 'promoted'}
        />
      </section>

      {/* Pending hires card */}
      <Card className="border-emerald-100/80 bg-gradient-to-br from-white via-emerald-50/30 to-white shadow-md ring-1 ring-emerald-500/8 dark:border-emerald-950/55 dark:from-zinc-950 dark:via-emerald-950/12 dark:to-zinc-950 dark:ring-emerald-400/10">
        <CardHeader className="flex flex-col gap-1 border-b border-emerald-100/60 pb-4 dark:border-emerald-900/40">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="flex items-center gap-2.5">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-500 to-teal-700 text-white shadow-sm shadow-emerald-600/25">
                  <ClipboardList className="h-4 w-4" />
                </div>
                <CardTitle className="text-base font-semibold">
                  Pending hires queue
                </CardTitle>
              </div>
              <p className="mt-1.5 text-xs text-muted-foreground">
                New hires staged from this dashboard. Promote a row to copy it into the master list.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <DeptFilter rows={pending} getDept={(r) => r.department} value={dept} onChange={setDept} />
              <div className="relative w-full sm:w-60">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search name, email…"
                  className="border-emerald-100/70 bg-white pl-9 dark:border-emerald-900/50 dark:bg-zinc-900"
                />
              </div>
              <Button
                variant="outline"
                size="sm"
                className="shrink-0 gap-1.5 border-emerald-200/70 text-emerald-800 hover:bg-emerald-50 dark:border-emerald-900/50 dark:text-emerald-200 dark:hover:bg-emerald-950/30"
                onClick={() => void fetchPending()}
                disabled={pendingLoading}
                title="Refresh the pending hires table (it also updates live automatically)"
              >
                <RefreshCw className={cn('h-3.5 w-3.5', pendingLoading && 'animate-spin')} />
                <span className="hidden sm:inline">Refresh</span>
              </Button>
            </div>
          </div>

          {/* Tab pills */}
          <div role="tablist" aria-label="Pending hire status" className="mt-3 flex flex-wrap items-center gap-1">
            <TabPill label="Awaiting email" count={counts.pending} active={tab === 'pending'} onClick={() => setTab('pending')} />
            <TabPill label="Ready" count={counts.ready} active={tab === 'ready'} onClick={() => setTab('ready')} />
            {counts.failed > 0 && (
              <TabPill label="Failed" count={counts.failed} active={tab === 'failed'} onClick={() => setTab('failed')} tone="danger" />
            )}
            <TabPill label="Promoted" count={counts.promoted} active={tab === 'promoted'} onClick={() => setTab('promoted')} />
            <TabPill label="No-show" count={counts.no_show} active={tab === 'no_show'} onClick={() => setTab('no_show')} />
            <TabPill label="Cancelled" count={counts.cancelled} active={tab === 'cancelled'} onClick={() => setTab('cancelled')} />
            <TabPill label="All" count={pending.length} active={tab === 'all'} onClick={() => setTab('all')} />
          </div>
        </CardHeader>

        <CardContent className="pt-4">
          {canMultiSelect && selected.size > 0 && (
            <div
              className={cn(
                'mb-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border px-3 py-2',
                isPromotedTab
                  ? 'border-amber-200 bg-amber-50/80 dark:border-amber-800/60 dark:bg-amber-950/30'
                  : 'border-emerald-200 bg-emerald-50/80 dark:border-emerald-800/60 dark:bg-emerald-950/30',
              )}
            >
              <span
                className={cn(
                  'text-xs font-medium',
                  isPromotedTab
                    ? 'text-amber-900 dark:text-amber-100'
                    : 'text-emerald-900 dark:text-emerald-100',
                )}
              >
                {selected.size} selected
              </span>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={() => setSelected(new Set())}
                  disabled={promotingSelected || unpromotingSelected}
                >
                  Clear
                </Button>
                {isPromotedTab ? (
                  <Button
                    size="sm"
                    className="h-7 gap-1.5 bg-gradient-to-r from-amber-500 to-orange-600 px-3 text-xs text-white hover:opacity-90"
                    onClick={() =>
                      setConfirmBackToReadyRows(
                        pending.filter((r) => selected.has(r.id) && r.status === 'promoted'),
                      )
                    }
                    disabled={unpromotingSelected}
                    title="Send all selected hires back to Ready (removes them from the master list + Google Sheet)"
                  >
                    {unpromotingSelected ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Undo2 className="h-3 w-3" />
                    )}
                    {unpromotingSelected
                      ? 'Sending back…'
                      : `Back to Ready (${selected.size})`}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    className="h-7 gap-1.5 bg-gradient-to-r from-emerald-500 to-teal-700 px-3 text-xs text-white hover:opacity-90"
                    onClick={() => setConfirmPromoteRows(pending.filter((r) => selected.has(r.id)))}
                    disabled={promotingSelected}
                    title="Promote all selected hires to the master list"
                  >
                    {promotingSelected ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <CheckCircle2 className="h-3 w-3" />
                    )}
                    {promotingSelected && promoteModal
                      ? `${tab === 'failed' ? 'Retrying' : 'Promoting'} ${promoteModal.done}/${promoteModal.total}`
                      : `${tab === 'failed' ? 'Retry' : 'Promote'} selected (${selected.size})`}
                  </Button>
                )}
              </div>
            </div>
          )}
          {pendingLoading ? (
            <div className="overflow-x-auto rounded-xl border border-emerald-100/90 ring-1 ring-emerald-500/10 dark:border-emerald-900/60 dark:ring-emerald-400/10">
              <table className="w-full text-left text-sm sm:min-w-[860px]">
                <thead className="bg-gradient-to-r from-emerald-50 via-white to-emerald-50/80 text-xs text-zinc-600 dark:from-emerald-950/50 dark:via-zinc-950 dark:to-emerald-950/40 dark:text-zinc-400">
                  <tr>
                    <th className="px-4 py-3 font-semibold">Name</th>
                    <th className="px-4 py-3 font-semibold">Department</th>
                    <th className="px-4 py-3 font-semibold">Country</th>
                    <th className="px-4 py-3 font-semibold">Personal</th>
                    <th className="px-4 py-3 font-semibold">Work email</th>
                    <th className="px-4 py-3 font-semibold">Start</th>
                    <th className="px-4 py-3 font-semibold">Status</th>
                    <th className="px-4 py-3 font-semibold text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-emerald-100/70 bg-white/85 dark:divide-emerald-900/35 dark:bg-zinc-950/40">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <tr key={i} className="align-top">
                      <td className="px-4 py-3">
                        <Skeleton className="h-4 w-28" />
                        <Skeleton className="mt-1.5 h-3 w-20" />
                      </td>
                      <td className="px-4 py-3"><Skeleton className="h-3.5 w-20" /></td>
                      <td className="px-4 py-3"><Skeleton className="h-3.5 w-16" /></td>
                      <td className="px-4 py-3"><Skeleton className="h-3.5 w-36" /></td>
                      <td className="px-4 py-3"><Skeleton className="h-3.5 w-36" /></td>
                      <td className="px-4 py-3"><Skeleton className="h-3.5 w-16" /></td>
                      <td className="px-4 py-3"><Skeleton className="h-5 w-24 rounded-full" /></td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex justify-end gap-1.5">
                          <Skeleton className="h-7 w-16 rounded-md" />
                          <Skeleton className="h-7 w-16 rounded-md" />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : filteredPending.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-emerald-200/80 bg-white/70 py-10 text-center dark:border-emerald-900/50 dark:bg-zinc-950/40">
              <Users className="h-8 w-8 text-emerald-400/60" />
              <p className="text-sm text-zinc-600 dark:text-zinc-400">
                {pending.length === 0
                  ? 'No pending hires yet — use the Onboarding Form tab to stage your first one.'
                  : 'No pending hires match this filter.'}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-emerald-100/90 ring-1 ring-emerald-500/10 dark:border-emerald-900/60 dark:ring-emerald-400/10">
              <table className="w-full text-left text-sm sm:min-w-[860px]">
                <thead className="sticky top-0 z-[1] bg-gradient-to-r from-emerald-50 via-white to-emerald-50/80 text-xs text-zinc-600 dark:from-emerald-950/50 dark:via-zinc-950 dark:to-emerald-950/40 dark:text-zinc-400">
                  <tr>
                    {canMultiSelect && (
                      <th className="w-10 px-4 py-3">
                        <input
                          type="checkbox"
                          aria-label={isPromotedTab ? 'Select all promoted hires on this page' : 'Select all ready hires'}
                          className="h-4 w-4 cursor-pointer accent-emerald-600 disabled:cursor-not-allowed disabled:opacity-40"
                          checked={allSelected}
                          ref={(el) => {
                            if (el) el.indeterminate = someSelected;
                          }}
                          onChange={toggleAll}
                          disabled={!showSelect}
                        />
                      </th>
                    )}
                    <th className="px-4 py-3 font-semibold">Name</th>
                    <th className="px-4 py-3 font-semibold">Department</th>
                    <th className="px-4 py-3 font-semibold">Country</th>
                    <th className="px-4 py-3 font-semibold">Personal</th>
                    <th className="px-4 py-3 font-semibold">Work email</th>
                    <th className="px-4 py-3 font-semibold">Start</th>
                    <th className="px-4 py-3 font-semibold">Status</th>
                    <th className="px-4 py-3 font-semibold text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-emerald-100/70 bg-white/85 dark:divide-emerald-900/35 dark:bg-zinc-950/40">
                  <AnimatePresence initial={false}>
                    {displayPending.map((row, i) => {
                      const isBusy = busyId === row.id;
                      // A row can be ticked (and clicking anywhere on it toggles
                      // the tick, not just the tiny checkbox). On Ready/Failed that
                      // needs orientation confirmed; on Promoted every promoted row
                      // is selectable for bulk "Back to Ready".
                      const rowSelectable =
                        canMultiSelect &&
                        (isPromotedTab
                          ? row.status === 'promoted'
                          : (row.status === 'ready' || row.status === 'failed_to_promote') &&
                            !!row.orientation_attended_at);
                      const isSelected = selected.has(row.id);
                      return (
                        <motion.tr
                          key={row.id}
                          initial={{ opacity: 0, y: 4 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: -4, transition: { duration: 0.12 } }}
                          transition={{
                            duration: 0.18,
                            ease: 'easeOut',
                            delay: reduceMotion ? 0 : Math.min(i * 0.02, 0.2),
                          }}
                          onClick={
                            rowSelectable
                              ? (e) => {
                                  // Ignore clicks that land on a button/link/input
                                  // (Promote, Set work email, the checkbox itself).
                                  if ((e.target as HTMLElement).closest('button, a, input, label')) return;
                                  toggleOne(row.id);
                                }
                              : undefined
                          }
                          className={cn(
                            'align-top transition-colors hover:bg-emerald-50/35 dark:hover:bg-emerald-950/25',
                            rowSelectable && 'cursor-pointer',
                            isSelected && 'bg-emerald-50/70 dark:bg-emerald-950/40',
                          )}
                        >
                          {canMultiSelect && (
                            <td data-label="Select" className="px-4 py-3">
                              <input
                                type="checkbox"
                                aria-label={`Select ${row.name}`}
                                className="h-4 w-4 cursor-pointer accent-emerald-600 disabled:cursor-not-allowed disabled:opacity-40"
                                checked={selected.has(row.id)}
                                onChange={() => toggleOne(row.id)}
                                disabled={!rowSelectable}
                                title={
                                  rowSelectable
                                    ? undefined
                                    : 'Orientation must be confirmed before this hire can be promoted.'
                                }
                              />
                            </td>
                          )}
                          <td data-label="Name" className="px-4 py-3">
                            <div className="font-medium text-zinc-900 dark:text-zinc-100">
                              {row.display_name ?? row.name}
                            </div>
                            {row.job_description && (
                              <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-500">
                                {row.job_description}
                              </div>
                            )}
                          </td>
                          <td data-label="Department" className="px-4 py-3 text-xs text-zinc-700 dark:text-zinc-300">
                            {row.department}
                          </td>
                          <td data-label="Country" className="px-4 py-3 text-xs text-zinc-700 dark:text-zinc-300">
                            {row.country ?? '—'}
                          </td>
                          <td data-label="Personal" className="px-4 py-3 break-all font-mono text-xs text-zinc-600 dark:text-zinc-400">
                            {row.personal_email}
                          </td>
                          <td data-label="Work email" className="px-4 py-3 break-all font-mono text-xs">
                            {row.work_email ? (
                              <span className="text-zinc-800 dark:text-zinc-200">
                                {row.work_email}
                              </span>
                            ) : (
                              <button
                                type="button"
                                onClick={() => setSetEmailFor(row)}
                                className="inline-flex items-center gap-1 rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] font-medium text-amber-900 hover:bg-amber-100 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100"
                              >
                                <Mail className="h-3 w-3" /> Set work email
                              </button>
                            )}
                          </td>
                          <td data-label="Start" className="px-4 py-3 text-xs text-zinc-600 dark:text-zinc-400">
                            {formatDate(row.start_date)}
                          </td>
                          <td data-label="Status" className="px-4 py-3">
                            <div className="flex flex-col items-start gap-1">
                              {row.status !== 'pending_work_email' && (
                                <Badge
                                  variant="outline"
                                  className={cn(
                                    'text-[10px] font-medium',
                                    row.status === 'ready' && !row.orientation_attended_at
                                      ? STATUS_BADGE['pending_work_email']
                                      : STATUS_BADGE[row.status],
                                  )}
                                >
                                  {row.status === 'ready' && !row.orientation_attended_at
                                    ? 'Awaiting orientation'
                                    : STATUS_LABEL[row.status]}
                                </Badge>
                              )}
                              {(row.status === 'ready' || row.status === 'pending_work_email') &&
                                row.orientation_attended_at && (
                                  <Badge
                                    variant="outline"
                                    className="border-emerald-300 bg-emerald-50 text-[10px] font-medium text-emerald-900 dark:border-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-100"
                                    title={`Marked ${formatDate(row.orientation_attended_at)} by ${row.orientation_attended_by ?? '—'}${row.orientation_note ? ` — "${row.orientation_note}"` : ''}`}
                                  >
                                    Orientation ✓
                                  </Badge>
                                )}
                            </div>
                          </td>
                          <td data-label="Actions" className="px-4 py-3 text-right">
                            <div className="flex justify-end gap-1.5">
                              {row.work_email && (row.status === 'ready' || row.status === 'promoted') && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7 px-2 text-xs text-sky-700 hover:bg-sky-50 hover:text-sky-800 dark:text-sky-300 dark:hover:bg-sky-950/30"
                                  onClick={() => void retryWorkspace(row)}
                                  disabled={busyRetryId === row.id || isBusy}
                                  title="Retry workspace setup — re-fires the n8n webhook. Note: Hubstaff invite + Roboform emails are sent to the work email inbox, so confirm the Google Workspace account exists first before retrying."
                                >
                                  {busyRetryId === row.id ? (
                                    <Loader2 className="h-3 w-3 animate-spin" />
                                  ) : (
                                    <RotateCcw className="h-3 w-3" />
                                  )}
                                </Button>
                              )}
                              {(row.status === 'ready' || row.status === 'failed_to_promote') && (
                                <Button
                                  size="sm"
                                  className={cn(
                                    'h-7 px-3 text-xs text-white hover:opacity-90 disabled:opacity-60',
                                    row.status === 'failed_to_promote'
                                      ? 'bg-gradient-to-r from-red-500 to-rose-700'
                                      : 'bg-gradient-to-r from-emerald-500 to-teal-700',
                                  )}
                                  onClick={() => void promote(row)}
                                  disabled={isBusy || !row.orientation_attended_at}
                                  title={
                                    !row.orientation_attended_at
                                      ? 'The department manager must mark orientation attended first.'
                                      : row.status === 'failed_to_promote'
                                        ? 'Retry — re-attempt the master list + Google Sheet write'
                                        : 'Promote to master list'
                                  }
                                >
                                  {isBusy ? (
                                    <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                                  ) : row.status === 'failed_to_promote' ? (
                                    <RotateCcw className="mr-1 h-3 w-3" />
                                  ) : (
                                    <CheckCircle2 className="mr-1 h-3 w-3" />
                                  )}
                                  {row.status === 'failed_to_promote' ? 'Retry' : 'Promote'}
                                </Button>
                              )}
                              {row.status === 'pending_work_email' && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7 px-2 text-xs"
                                  onClick={() => setSetEmailFor(row)}
                                  disabled={isBusy}
                                >
                                  <Pencil className="mr-1 h-3 w-3" /> Edit
                                </Button>
                              )}
                              {row.status === 'promoted' && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7 px-2 text-xs text-amber-700 hover:bg-amber-50 hover:text-amber-800 dark:text-amber-300 dark:hover:bg-amber-950/30"
                                  onClick={() => void sendBackToReady(row)}
                                  disabled={isBusy}
                                  title="Send back to Ready (removes them from the master list + Google Sheet; re-promote to re-add)"
                                >
                                  {isBusy ? (
                                    <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                                  ) : (
                                    <Undo2 className="mr-1 h-3 w-3" />
                                  )}
                                  Back to Ready
                                </Button>
                              )}
                              {(row.status === 'ready' ||
                                row.status === 'pending_work_email' ||
                                row.status === 'failed_to_promote') && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7 px-2 text-xs text-rose-700 hover:bg-rose-50 hover:text-rose-800 dark:text-rose-300 dark:hover:bg-rose-950/30"
                                  onClick={() => setConfirmCancel(row)}
                                  disabled={isBusy}
                                  title="Cancel hire - deletes their Workspace account + Hubstaff and archives their onboarding form"
                                >
                                  <XCircle className="h-3 w-3" />
                                </Button>
                              )}
                              {(row.status === 'cancelled' || row.status === 'no_show') && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7 px-2 text-xs text-rose-700 hover:bg-rose-50 hover:text-rose-800 dark:text-rose-300 dark:hover:bg-rose-950/30"
                                  onClick={() => setConfirmDelete(row)}
                                  disabled={isBusy}
                                  title="Permanently delete this record"
                                >
                                  <Trash2 className="h-3 w-3" />
                                </Button>
                              )}
                            </div>
                          </td>
                        </motion.tr>
                      );
                    })}
                  </AnimatePresence>
                </tbody>
              </table>
              {promotedPaged && promotedTotalPages > 1 && (
                <div data-readonly-allow className="flex items-center justify-between border-t border-emerald-100/60 px-4 py-2.5 dark:border-emerald-900/30">
                  <p className="text-[11px] text-zinc-400">
                    {promotedSafePage * PROMOTED_PAGE_SIZE + 1}–
                    {Math.min((promotedSafePage + 1) * PROMOTED_PAGE_SIZE, filteredPending.length)} of{' '}
                    {filteredPending.length}
                  </p>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-7 w-7"
                      disabled={promotedSafePage === 0}
                      onClick={() => setPromotedPage(0)}
                      aria-label="First page"
                    >
                      <ChevronLeft className="h-3 w-3" />
                      <ChevronLeft className="-ml-2 h-3 w-3" />
                    </Button>
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-7 w-7"
                      disabled={promotedSafePage === 0}
                      onClick={() => setPromotedPage((p) => Math.max(0, p - 1))}
                      aria-label="Previous page"
                    >
                      <ChevronLeft className="h-3 w-3" />
                    </Button>
                    <span className="min-w-[4rem] text-center text-[11px] text-zinc-500">
                      {promotedSafePage + 1} / {promotedTotalPages}
                    </span>
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-7 w-7"
                      disabled={promotedSafePage >= promotedTotalPages - 1}
                      onClick={() => setPromotedPage((p) => Math.min(promotedTotalPages - 1, p + 1))}
                      aria-label="Next page"
                    >
                      <ChevronRight className="h-3 w-3" />
                    </Button>
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-7 w-7"
                      disabled={promotedSafePage >= promotedTotalPages - 1}
                      onClick={() => setPromotedPage(promotedTotalPages - 1)}
                      aria-label="Last page"
                    >
                      <ChevronRight className="h-3 w-3" />
                      <ChevronRight className="-ml-2 h-3 w-3" />
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
            </>
            )}
          </motion.div>
        </AnimatePresence>
      </div>

      {/* Set work email dialog */}
      <SetWorkEmailDialog
        row={setEmailFor}
        onClose={() => setSetEmailFor(null)}
        onSubmit={(email) => setEmailFor && void saveWorkEmail(setEmailFor, email)}
        busy={busyId === setEmailFor?.id}
      />

      {/* Cancel confirm dialog */}
      <Dialog open={!!confirmCancel} onOpenChange={(o) => !o && setConfirmCancel(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base">Cancel pending hire?</DialogTitle>
            <DialogDescription className="text-xs">
              <strong>{confirmCancel?.name}</strong> ({confirmCancel?.personal_email}) will
              move to the Cancelled tab.
              {confirmCancel?.work_email ? (
                <>
                  {' '}Their Workspace account{' '}
                  <span className="font-mono">{confirmCancel.work_email}</span> and Hubstaff
                  access will be permanently deleted.
                </>
              ) : null}
              {confirmCancel?.onboarding_submission_id
                ? ' Their onboarding form will be archived.'
                : null}
              {' '}This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirmCancel(null)}
              disabled={busyId === confirmCancel?.id}
            >
              Keep
            </Button>
            <Button
              size="sm"
              className="bg-rose-600 hover:bg-rose-700"
              onClick={() => confirmCancel && void cancel(confirmCancel)}
              disabled={busyId === confirmCancel?.id}
            >
              {busyId === confirmCancel?.id ? (
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              ) : (
                <XCircle className="mr-1 h-3 w-3" />
              )}
              Cancel hire
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Hard delete confirm dialog */}
      <Dialog open={!!confirmDelete} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base">Permanently delete this record?</DialogTitle>
            <DialogDescription className="text-xs">
              <strong>{confirmDelete?.name}</strong> ({confirmDelete?.personal_email}) will be
              removed entirely — this cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirmDelete(null)}
              disabled={busyId === confirmDelete?.id}
            >
              Keep
            </Button>
            <Button
              size="sm"
              className="bg-rose-600 hover:bg-rose-700"
              onClick={() => confirmDelete && void hardDelete(confirmDelete)}
              disabled={busyId === confirmDelete?.id}
            >
              {busyId === confirmDelete?.id ? (
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              ) : (
                <Trash2 className="mr-1 h-3 w-3" />
              )}
              Delete permanently
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk-promote confirmation dialog */}
      <BulkActionConfirmDialog
        rows={confirmPromoteRows}
        action={tab === 'failed' ? 'retry' : 'promote'}
        onClose={() => setConfirmPromoteRows(null)}
        onConfirm={() => {
          setConfirmPromoteRows(null);
          void promoteSelected();
        }}
      />

      {/* Bulk "Back to Ready" confirmation dialog (Promoted tab) */}
      <BulkActionConfirmDialog
        rows={confirmBackToReadyRows}
        action="backToReady"
        onClose={() => setConfirmBackToReadyRows(null)}
        onConfirm={() => {
          setConfirmBackToReadyRows(null);
          void backToReadySelected();
        }}
      />

      {/* Bulk-promote progress modal */}
      <BulkPromoteProgressDialog
        state={promoteModal}
        isFailedTab={tab === 'failed'}
        onClose={() => setPromoteModal(null)}
        onViewFailed={() => {
          setPromoteModal(null);
          setTab('failed');
        }}
      />
    </div>
  );
}

/**
 * Confirmation dialog shown before a multi-select bulk promote runs.
 * Rows are grouped by department; when more than one department is present
 * each gets its own tab so the reviewer can verify per-department before committing.
 */
function BulkActionConfirmDialog({
  rows,
  action,
  onClose,
  onConfirm,
}: {
  rows: HrPendingEmployeeRow[] | null;
  // 'promote' (Ready) + 'retry' (Failed) write to the master list; 'backToReady'
  // (Promoted) removes from it. The verb, copy, and button colour follow the action.
  action: 'promote' | 'retry' | 'backToReady';
  onClose: () => void;
  onConfirm: () => void;
}) {
  const isBack = action === 'backToReady';
  const verb = action === 'retry' ? 'Retry' : isBack ? 'Send back' : 'Promote';

  const deptGroups = useMemo(() => {
    if (!rows) return [];
    const map = new Map<string, HrPendingEmployeeRow[]>();
    for (const r of rows) {
      const key = r.department ?? '(No department)';
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(r);
    }
    return Array.from(map.entries()).map(([dept, members]) => ({ dept, members }));
  }, [rows]);

  const [activeDept, setActiveDept] = useState<string>('');

  useEffect(() => {
    if (deptGroups.length > 0) setActiveDept(deptGroups[0].dept);
  }, [deptGroups]);

  const activeMembers = deptGroups.find((g) => g.dept === activeDept)?.members ?? [];
  const total = rows?.length ?? 0;

  return (
    <Dialog open={!!rows} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            {isBack ? (
              <Undo2 className="h-4 w-4 text-amber-600" />
            ) : (
              <CheckCircle2 className="h-4 w-4 text-emerald-600" />
            )}
            {isBack
              ? `Send ${total} hire${total !== 1 ? 's' : ''} back to Ready?`
              : `${verb} ${total} hire${total !== 1 ? 's' : ''}?`}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {isBack
              ? 'These hires will be removed from the master list and the Google Sheet and returned to the Ready tab. You can promote them again afterward.'
              : 'Review the hires below, then confirm to write them to the master list and Google Sheet.'}
          </DialogDescription>
        </DialogHeader>

        {deptGroups.length > 1 && (
          <div className="flex flex-wrap gap-1 border-b border-zinc-100 pb-3 dark:border-zinc-800">
            {deptGroups.map(({ dept, members }) => (
              <button
                key={dept}
                type="button"
                onClick={() => setActiveDept(dept)}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[11.5px] font-medium transition-colors',
                  activeDept === dept
                    ? 'bg-emerald-600 text-white'
                    : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700',
                )}
              >
                {dept}
                <span className={cn(
                  'rounded-full px-1.5 py-0.5 text-[10px] font-semibold',
                  activeDept === dept
                    ? 'bg-white/20 text-white'
                    : 'bg-zinc-200 text-zinc-500 dark:bg-zinc-700 dark:text-zinc-400',
                )}>
                  {members.length}
                </span>
              </button>
            ))}
          </div>
        )}

        <div className="max-h-64 overflow-y-auto rounded-lg border border-zinc-100 dark:border-zinc-800">
          <table className="w-full text-left text-xs">
            <thead className="bg-zinc-50 text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
              <tr>
                <th className="px-3 py-2 font-medium">Name</th>
                {deptGroups.length === 1 && <th className="px-3 py-2 font-medium">Department</th>}
                <th className="px-3 py-2 font-medium">Work email</th>
                <th className="px-3 py-2 font-medium">Start</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {(deptGroups.length === 1 ? (rows ?? []) : activeMembers).map((r) => (
                <tr key={r.id} className="bg-white dark:bg-zinc-950">
                  <td className="px-3 py-2 font-medium text-zinc-800 dark:text-zinc-100">{r.display_name ?? r.name}</td>
                  {deptGroups.length === 1 && (
                    <td className="px-3 py-2 text-zinc-500 dark:text-zinc-400">{r.department ?? '—'}</td>
                  )}
                  <td className="px-3 py-2 font-mono text-zinc-600 dark:text-zinc-400">{r.work_email ?? '—'}</td>
                  <td className="px-3 py-2 text-zinc-500 dark:text-zinc-400">{formatDate(r.start_date)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            className={cn(
              'text-white hover:opacity-90',
              isBack
                ? 'bg-gradient-to-r from-amber-500 to-orange-600'
                : 'bg-gradient-to-r from-emerald-500 to-teal-700',
            )}
            onClick={onConfirm}
          >
            {isBack ? (
              <Undo2 className="mr-1.5 h-3.5 w-3.5" />
            ) : (
              <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />
            )}
            {isBack ? `Send all ${total} back` : `${verb} all ${total}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Live progress modal for the chunked bulk promote. The bar + the Promoted /
 * Failed KPI counters update after every chunk (spring-animated so the numbers
 * roll smoothly), and the dialog can only be dismissed once the run finishes.
 */
function BulkPromoteProgressDialog({
  state,
  isFailedTab,
  onClose,
  onViewFailed,
}: {
  state: {
    total: number;
    done: number;
    promoted: number;
    failed: number;
    status: 'running' | 'done';
    firstErr?: string;
  } | null;
  isFailedTab: boolean;
  onClose: () => void;
  onViewFailed: () => void;
}) {
  const total = state?.total ?? 0;
  const done = state?.done ?? 0;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const running = state?.status === 'running';
  const verb = isFailedTab ? 'Retry' : 'Promotion';

  // Spring-drive the bar width so it glides between chunk updates instead of
  // snapping.
  const widthSpring = useSpring(pct, { stiffness: 120, damping: 24, mass: 0.5 });
  const widthPct = useTransform(widthSpring, (v) => `${Math.max(0, Math.min(100, v))}%`);
  useEffect(() => {
    widthSpring.set(pct);
  }, [pct, widthSpring]);

  const allGood = !running && (state?.failed ?? 0) === 0;

  return (
    <Dialog
      open={!!state}
      onOpenChange={(o) => {
        // Block dismiss while the batch is still in flight.
        if (!o && !running) onClose();
      }}
    >
      <DialogContent className="max-w-md" showCloseButton={!running}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            {running ? (
              <Loader2 className="h-4 w-4 animate-spin text-emerald-600" />
            ) : allGood ? (
              <CheckCircle2 className="h-4 w-4 text-emerald-600" />
            ) : (
              <XCircle className="h-4 w-4 text-red-600" />
            )}
            {running
              ? `${verb} in progress…`
              : allGood
                ? `${verb} complete`
                : `${verb} finished with errors`}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {running
              ? `Writing hires to the master list and Google Sheet. ${done} of ${total} processed.`
              : `${done} of ${total} processed.`}
          </DialogDescription>
        </DialogHeader>

        {/* Progress bar */}
        <div className="mt-1">
          <div className="mb-1.5 flex items-center justify-between text-[11px] font-medium text-zinc-500 dark:text-zinc-400">
            <span>{done} / {total}</span>
            <AnimatedNumber value={pct} suffix="%" className="tabular-nums" />
          </div>
          <div className="relative h-2.5 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
            <motion.div
              className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-emerald-500 to-teal-600"
              style={{ width: widthPct }}
            />
            {/* Indeterminate shimmer over the filled edge while a chunk is mid-flight. */}
            {running && (
              <motion.div
                className="absolute inset-y-0 w-1/3 bg-gradient-to-r from-transparent via-white/40 to-transparent"
                initial={{ x: '-100%' }}
                animate={{ x: '350%' }}
                transition={{ duration: 1.1, repeat: Infinity, ease: 'easeInOut' }}
              />
            )}
          </div>
        </div>

        {/* KPI cards */}
        <div className="mt-3 grid grid-cols-2 gap-3">
          <div className="rounded-xl border border-emerald-200 bg-emerald-50/70 px-3 py-2.5 dark:border-emerald-800/60 dark:bg-emerald-950/30">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">
              <CheckCircle2 className="h-3.5 w-3.5" /> Promoted
            </div>
            <AnimatedNumber
              value={state?.promoted ?? 0}
              className="mt-0.5 block text-2xl font-bold tabular-nums text-emerald-700 dark:text-emerald-200"
            />
          </div>
          <div
            className={cn(
              'rounded-xl border px-3 py-2.5 transition-colors',
              (state?.failed ?? 0) > 0
                ? 'border-red-300 bg-red-50/80 dark:border-red-700/60 dark:bg-red-950/30'
                : 'border-zinc-200 bg-zinc-50/70 dark:border-zinc-700/60 dark:bg-zinc-900/40',
            )}
          >
            <div
              className={cn(
                'flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide',
                (state?.failed ?? 0) > 0
                  ? 'text-red-700 dark:text-red-300'
                  : 'text-zinc-500 dark:text-zinc-400',
              )}
            >
              <XCircle className="h-3.5 w-3.5" /> Failed
            </div>
            <AnimatedNumber
              value={state?.failed ?? 0}
              className={cn(
                'mt-0.5 block text-2xl font-bold tabular-nums',
                (state?.failed ?? 0) > 0
                  ? 'text-red-700 dark:text-red-200'
                  : 'text-zinc-400 dark:text-zinc-600',
              )}
            />
          </div>
        </div>

        {!running && (state?.failed ?? 0) > 0 && state?.firstErr && (
          <p className="mt-2 rounded-lg border border-red-200 bg-red-50/60 px-2.5 py-1.5 text-[11px] text-red-700 dark:border-red-800/50 dark:bg-red-950/30 dark:text-red-300">
            {state.firstErr}
          </p>
        )}

        <DialogFooter className="mt-1 gap-2 sm:gap-2">
          {running ? (
            <Button size="sm" variant="outline" disabled className="gap-1.5">
              <Loader2 className="h-3 w-3 animate-spin" /> Working…
            </Button>
          ) : (
            <>
              {(state?.failed ?? 0) > 0 && (
                <Button
                  size="sm"
                  variant="outline"
                  className="text-red-700 hover:bg-red-50 hover:text-red-800 dark:text-red-300 dark:hover:bg-red-950/30"
                  onClick={onViewFailed}
                >
                  <RotateCcw className="mr-1 h-3 w-3" /> View {state?.failed} failed
                </Button>
              )}
              <Button
                size="sm"
                className="bg-gradient-to-r from-emerald-500 to-teal-700 text-white hover:opacity-90"
                onClick={onClose}
              >
                Done
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A number that springs smoothly from its previous value to the next instead of
 * jumping — used for the bulk-promote KPI counters + the percent readout.
 */
function AnimatedNumber({
  value,
  suffix = '',
  className,
}: {
  value: number;
  suffix?: string;
  className?: string;
}) {
  const spring = useSpring(value, { stiffness: 140, damping: 22, mass: 0.5 });
  const text = useTransform(spring, (v) => `${Math.round(v)}${suffix}`);
  useEffect(() => {
    spring.set(value);
  }, [spring, value]);
  return <motion.span className={className}>{text}</motion.span>;
}

const DEPT_COLORS = [
  '#10b981','#0d9488','#0891b2','#7c3aed','#db2777',
  '#ea580c','#ca8a04','#4f46e5','#16a34a','#be185d',
  '#0369a1','#6d28d9','#b45309','#047857','#9d174d',
];

function PendingDeptDonut({ data }: { data: HrPendingEmployeeRow[] }) {
  const [hovered, setHovered] = useState<string | null>(null);

  const sliceData = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of data) {
      const d = (r.department ?? '—').trim() || '—';
      map.set(d, (map.get(d) ?? 0) + 1);
    }
    return [...map.entries()]
      .map(([dept, count]) => ({ dept, count }))
      .sort((a, b) => b.count - a.count);
  }, [data]);

  const total = sliceData.reduce((s, d) => s + d.count, 0);
  const SIZE = 130; const cx = SIZE / 2; const cy = SIZE / 2;
  const outerR = 56; const innerR = 33;

  function polar(deg: number, r: number) {
    const rad = ((deg - 90) * Math.PI) / 180;
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
  }

  function slicePath(s: number, e: number) {
    if (e - s >= 359.99) {
      const t = polar(0, outerR); const b = polar(180, outerR);
      const it = polar(0, innerR); const ib = polar(180, innerR);
      return `M ${t.x} ${t.y} A ${outerR} ${outerR} 0 1 1 ${b.x} ${b.y} A ${outerR} ${outerR} 0 1 1 ${t.x} ${t.y} M ${it.x} ${it.y} A ${innerR} ${innerR} 0 1 0 ${ib.x} ${ib.y} A ${innerR} ${innerR} 0 1 0 ${it.x} ${it.y} Z`;
    }
    const large = e - s > 180 ? 1 : 0;
    const s1 = polar(s, outerR); const e1 = polar(e, outerR);
    const s2 = polar(e, innerR); const e2 = polar(s, innerR);
    return `M ${s1.x} ${s1.y} A ${outerR} ${outerR} 0 ${large} 1 ${e1.x} ${e1.y} L ${s2.x} ${s2.y} A ${innerR} ${innerR} 0 ${large} 0 ${e2.x} ${e2.y} Z`;
  }

  let cum = 0;
  const slices = sliceData.map((d, i) => {
    const start = cum;
    cum += total > 0 ? (d.count / total) * 360 : 0;
    return { ...d, start, end: cum, color: DEPT_COLORS[i % DEPT_COLORS.length]! };
  });

  const hovSlice = slices.find((s) => s.dept === hovered);

  if (total === 0) return (
    <div className="flex h-[130px] w-[130px] items-center justify-center rounded-full border-2 border-dashed border-zinc-200 dark:border-zinc-700">
      <span className="text-[10px] text-zinc-400">No data</span>
    </div>
  );

  return (
    <div className="flex flex-col items-center gap-2">
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} style={{ overflow: 'visible' }}>
        {slices.map((s, i) => (
          <motion.path
            key={s.dept}
            d={slicePath(s.start, s.end)}
            fill={s.color}
            initial={{ opacity: 0 }}
            animate={{ opacity: hovered && hovered !== s.dept ? 0.28 : 1 }}
            transition={{ duration: 0.2, delay: hovered ? 0 : i * 0.04 }}
            onMouseEnter={() => setHovered(s.dept)}
            onMouseLeave={() => setHovered(null)}
            style={{ cursor: 'default' }}
          />
        ))}
        <text x={cx} y={cy - 4} textAnchor="middle" fontSize="15" fontWeight="700" fill="#18181b">{hovSlice ? hovSlice.count : total}</text>
        <text x={cx} y={cy + 9} textAnchor="middle" fontSize="7.5" fill="#a1a1aa">{hovSlice ? hovSlice.dept.slice(0, 11) : 'pending'}</text>
      </svg>
      <div className="w-[160px] space-y-0.5">
        {slices.map((s) => (
          <div
            key={s.dept}
            className={cn('flex items-center gap-1.5 rounded px-1 py-0.5 text-[10px] transition-colors', hovered === s.dept ? 'bg-zinc-100 dark:bg-zinc-800' : '')}
            onMouseEnter={() => setHovered(s.dept)}
            onMouseLeave={() => setHovered(null)}
          >
            <span className="h-1.5 w-1.5 shrink-0 rounded-sm" style={{ background: s.color }} />
            <span className="min-w-0 flex-1 truncate text-zinc-500 dark:text-zinc-400">{s.dept}</span>
            <span className="shrink-0 tabular-nums font-medium text-zinc-700 dark:text-zinc-300">{s.count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const PIPELINE_SLICES = [
  { key: 'pending'   as TabFilter, label: 'Awaiting email', color: '#f59e0b' },
  { key: 'ready'     as TabFilter, label: 'Ready',          color: '#10b981' },
  { key: 'promoted'  as TabFilter, label: 'Promoted',       color: '#0ea5e9' },
  { key: 'no_show'   as TabFilter, label: 'No-show',        color: '#f43f5e' },
  { key: 'cancelled' as TabFilter, label: 'Cancelled',      color: '#a1a1aa' },
];

function PipelinePieChart({
  counts,
  onSliceClick,
  activeTab,
}: {
  counts: { pending: number; ready: number; promoted: number; cancelled: number; no_show: number };
  onSliceClick: (tab: TabFilter) => void;
  activeTab: TabFilter;
}) {
  const [hovered, setHovered] = useState<TabFilter | null>(null);
  const SIZE = 150; const cx = SIZE / 2; const cy = SIZE / 2;
  const outerR = 64; const innerR = 38;

  const total = counts.pending + counts.ready + counts.promoted + counts.cancelled;

  function polar(deg: number, r: number) {
    const rad = ((deg - 90) * Math.PI) / 180;
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
  }

  function slicePath(s: number, e: number) {
    if (e - s >= 359.99) {
      const t = polar(0, outerR); const b = polar(180, outerR);
      const it = polar(0, innerR); const ib = polar(180, innerR);
      return `M ${t.x} ${t.y} A ${outerR} ${outerR} 0 1 1 ${b.x} ${b.y} A ${outerR} ${outerR} 0 1 1 ${t.x} ${t.y} M ${it.x} ${it.y} A ${innerR} ${innerR} 0 1 0 ${ib.x} ${ib.y} A ${innerR} ${innerR} 0 1 0 ${it.x} ${it.y} Z`;
    }
    const large = e - s > 180 ? 1 : 0;
    const s1 = polar(s, outerR); const e1 = polar(e, outerR);
    const s2 = polar(e, innerR); const e2 = polar(s, innerR);
    return `M ${s1.x} ${s1.y} A ${outerR} ${outerR} 0 ${large} 1 ${e1.x} ${e1.y} L ${s2.x} ${s2.y} A ${innerR} ${innerR} 0 ${large} 0 ${e2.x} ${e2.y} Z`;
  }

  let cum = 0;
  const slices = PIPELINE_SLICES.map((s) => {
    const count = counts[s.key as keyof typeof counts] ?? 0;
    const start = cum;
    cum += total > 0 ? (count / total) * 360 : 0;
    return { ...s, count, start, end: cum };
  }).filter((s) => s.count > 0);

  const active = hovered ?? (activeTab !== 'all' ? activeTab : null);
  const activeSlice = slices.find((s) => s.key === active);

  if (total === 0) {
    return (
      <div className="flex flex-col items-center gap-1 py-4">
        <div className="flex h-[150px] w-[150px] items-center justify-center rounded-full border-4 border-dashed border-zinc-200 dark:border-zinc-700">
          <span className="text-[11px] text-zinc-400">No data</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-2.5">
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} style={{ overflow: 'visible' }}>
        {slices.map((s, i) => (
          <motion.path
            key={s.key}
            d={slicePath(s.start, s.end)}
            fill={s.color}
            initial={{ opacity: 0 }}
            animate={{ opacity: active && active !== s.key ? 0.28 : 1 }}
            transition={{ duration: 0.2, delay: hovered ? 0 : i * 0.04 }}
            onMouseEnter={() => setHovered(s.key)}
            onMouseLeave={() => setHovered(null)}
            onClick={() => onSliceClick(s.key)}
            style={{ cursor: 'pointer' }}
          />
        ))}
        <text x={cx} y={cy - 5} textAnchor="middle" fontSize="17" fontWeight="700" fill="#18181b">
          {activeSlice ? activeSlice.count : total}
        </text>
        <text x={cx} y={cy + 10} textAnchor="middle" fontSize="8.5" fill="#a1a1aa">
          {activeSlice ? activeSlice.label.slice(0, 12) : 'total'}
        </text>
      </svg>
      <div className="w-full space-y-0.5 px-2">
        {PIPELINE_SLICES.map((s) => {
          const count = counts[s.key as keyof typeof counts] ?? 0;
          return (
            <button
              key={s.key}
              type="button"
              onClick={() => onSliceClick(s.key)}
              onMouseEnter={() => setHovered(s.key)}
              onMouseLeave={() => setHovered(null)}
              className={cn(
                'flex w-full items-center gap-1.5 rounded px-1.5 py-0.5 text-[11px] transition-colors',
                active === s.key ? 'bg-zinc-100 dark:bg-zinc-800' : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/50',
              )}
            >
              <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: s.color }} />
              <span className="min-w-0 flex-1 truncate text-left text-zinc-600 dark:text-zinc-400">{s.label}</span>
              <span className="shrink-0 tabular-nums font-medium text-zinc-800 dark:text-zinc-200">{count}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SubTabPill({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  const reduce = useReducedMotion();
  return (
    <button
      type="button"
      onClick={onClick}
      role="tab"
      aria-selected={active}
      className={cn(
        'relative rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors',
        active
          ? 'text-white'
          : 'text-zinc-600 hover:bg-emerald-50 hover:text-emerald-900 dark:text-zinc-300 dark:hover:bg-emerald-950/40 dark:hover:text-emerald-100',
      )}
    >
      {/* Shared indicator — glides between pills via layoutId. */}
      {active && (
        <motion.span
          layoutId="hr-onboarding-subtab"
          className="absolute inset-0 rounded-md bg-gradient-to-r from-emerald-500 to-teal-700 shadow-sm shadow-emerald-600/25"
          transition={{ duration: reduce ? 0 : 0.28, ease: [0.22, 1, 0.36, 1] }}
        />
      )}
      <span className="relative z-10">{label}</span>
    </button>
  );
}

function TabPill({
  label,
  count,
  active,
  onClick,
  tone = 'emerald',
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  // 'danger' paints the Failed tab red so unfinished promotes stand out even
  // when the tab isn't selected.
  tone?: 'emerald' | 'danger';
}) {
  const reduce = useReducedMotion();
  const isDanger = tone === 'danger';
  return (
    <button
      type="button"
      onClick={onClick}
      role="tab"
      aria-selected={active}
      className={cn(
        'relative flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors',
        active && 'text-white',
        !active && isDanger && 'text-red-700 hover:bg-red-50 hover:text-red-900 dark:text-red-300 dark:hover:bg-red-950/40 dark:hover:text-red-100',
        !active && !isDanger && 'text-zinc-600 hover:bg-emerald-50 hover:text-emerald-900 dark:text-zinc-300 dark:hover:bg-emerald-950/40 dark:hover:text-emerald-100',
      )}
    >
      {/* Shared indicator — glides between pills via layoutId. Its tone follows
          the active tab so the Failed pill stays red. */}
      {active && (
        <motion.span
          layoutId="hr-pending-tab"
          className={cn(
            'absolute inset-0 rounded-md shadow-sm',
            isDanger
              ? 'bg-gradient-to-r from-red-500 to-rose-700 shadow-rose-600/25'
              : 'bg-gradient-to-r from-emerald-500 to-teal-700 shadow-emerald-600/25',
          )}
          transition={{ duration: reduce ? 0 : 0.28, ease: [0.22, 1, 0.36, 1] }}
        />
      )}
      <span className="relative z-10">{label}</span>
      <span
        className={cn(
          'relative z-10 rounded-full px-1.5 text-[10px] tabular-nums',
          active && 'bg-white/20 text-white',
          !active && isDanger && 'bg-red-200 text-red-800 dark:bg-red-900/60 dark:text-red-200',
          !active && !isDanger && 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400',
        )}
      >
        {count}
      </span>
    </button>
  );
}

function StatTile({
  label,
  value,
  icon: Icon,
  accent,
  active,
  onClick,
}: {
  label: string;
  value: number;
  icon: React.ComponentType<{ className?: string }>;
  accent: 'amber' | 'emerald' | 'sky' | 'teal';
  active?: boolean;
  onClick?: () => void;
}) {
  const accentMap = {
    amber: 'from-amber-400 to-amber-600 shadow-amber-500/30',
    emerald: 'from-emerald-500 to-teal-700 shadow-emerald-500/30',
    sky: 'from-sky-500 to-sky-700 shadow-sky-500/30',
    teal: 'from-teal-500 to-emerald-700 shadow-emerald-500/30',
  } as const;

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group flex items-center gap-3 overflow-hidden rounded-xl border bg-white/90 px-4 py-3.5 text-left ring-1 backdrop-blur-sm transition-all hover:shadow-md dark:bg-zinc-950/75',
        active
          ? 'border-emerald-300 ring-emerald-500/20 dark:border-emerald-700 dark:ring-emerald-400/20'
          : 'border-emerald-100/80 ring-emerald-500/5 hover:border-emerald-200 dark:border-emerald-950/50 dark:ring-emerald-400/10',
      )}
    >
      <div
        className={cn(
          'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br text-white shadow-md',
          accentMap[accent],
        )}
      >
        <Icon className="h-4.5 w-4.5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-500">
          {label}
        </div>
        <div className="mt-0.5 text-xl font-bold tabular-nums text-zinc-900 dark:text-zinc-100">
          {value}
        </div>
      </div>
    </button>
  );
}

function SetWorkEmailDialog({
  row,
  onClose,
  onSubmit,
  busy,
}: {
  row: HrPendingEmployeeRow | null;
  onClose: () => void;
  onSubmit: (email: string) => void;
  busy: boolean;
}) {
  const [val, setVal] = useState('');
  const [licenseInfo, setLicenseInfo] = useState<{
    available_licenses: number | null;
    total_licenses: number | null;
    last_updated: string | null;
    note?: string;
    error?: string;
  } | null>(null);

  useEffect(() => {
    setVal(row?.work_email ?? '');
  }, [row]);

  useEffect(() => {
    if (!row) return;
    fetch('/api/hr/workspace-license-info', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => setLicenseInfo(j))
      .catch(() => setLicenseInfo({ available_licenses: null, total_licenses: null, last_updated: null, error: 'Could not fetch license info' }));
  }, [row]);

  const licenseColor = licenseInfo === null ? 'border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/40' : licenseInfo.available_licenses === null
    ? 'border-amber-200/60 bg-amber-50/60 dark:border-amber-900/40 dark:bg-amber-950/20'
    : licenseInfo.available_licenses === 0
      ? 'border-red-200/60 bg-red-50/60 dark:border-red-900/40 dark:bg-red-950/20'
      : licenseInfo.available_licenses <= 2
        ? 'border-orange-200/60 bg-orange-50/60 dark:border-orange-900/40 dark:bg-orange-950/20'
        : 'border-emerald-200/60 bg-emerald-50/60 dark:border-emerald-900/40 dark:bg-emerald-950/20';

  return (
    <Dialog open={!!row} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">Set work email</DialogTitle>
          <DialogDescription className="text-xs">
            Once Payroll mints the email, paste it here. Check your available licenses below before assigning.
          </DialogDescription>
        </DialogHeader>

        <div className={'rounded-lg border px-3 py-2.5 text-xs ' + licenseColor}>
          {!licenseInfo && (
            <div className="flex items-center gap-2 text-zinc-500 dark:text-zinc-400">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span>Loading license info...</span>
            </div>
          )}
          {licenseInfo && (
            <>
              <div className="mb-1 flex items-center gap-1.5 font-medium">
                {licenseInfo.available_licenses === null && (
                  <>
                    <AlertTriangle className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
                    <span className="text-amber-900 dark:text-amber-100">License info unavailable</span>
                  </>
                )}
                {licenseInfo.available_licenses === 0 && (
                  <>
                    <XCircle className="h-3.5 w-3.5 text-red-600 dark:text-red-400" />
                    <span className="text-red-900 dark:text-red-100">No licenses available</span>
                  </>
                )}
                {licenseInfo.available_licenses && licenseInfo.available_licenses <= 2 && (
                  <>
                    <AlertTriangle className="h-3.5 w-3.5 text-orange-600 dark:text-orange-400" />
                    <span className="text-orange-900 dark:text-orange-100">Low on licenses</span>
                  </>
                )}
                {licenseInfo.available_licenses && licenseInfo.available_licenses > 2 && (
                  <>
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                    <span className="text-emerald-900 dark:text-emerald-100">Licenses available</span>
                  </>
                )}
              </div>
              {licenseInfo.available_licenses !== null && licenseInfo.total_licenses && (
                <div>
                  <div className="mb-2">
                    <div className="flex items-baseline gap-1.5">
                      <strong className="text-3xl font-bold text-zinc-900 dark:text-zinc-100">
                        {licenseInfo.available_licenses}
                      </strong>
                      <span className="text-sm text-zinc-600 dark:text-zinc-400">/ {licenseInfo.total_licenses}</span>
                    </div>
                    <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-500">
                      {licenseInfo.total_licenses - licenseInfo.available_licenses} assigned
                    </div>
                  </div>
                  <div className="mb-2 h-2 w-full overflow-hidden rounded-full bg-zinc-300 dark:bg-zinc-600">
                    <div
                      className={licenseInfo.available_licenses === 0 ? 'h-full bg-red-500 dark:bg-red-600' : licenseInfo.available_licenses <= 2 ? 'h-full bg-orange-500 dark:bg-orange-600' : 'h-full bg-emerald-500 dark:bg-emerald-600'}
                      style={{ width: ((licenseInfo.total_licenses - licenseInfo.available_licenses) / licenseInfo.total_licenses) * 100 + '%' }}
                    />
                  </div>
                  {licenseInfo.last_updated && (
                    <div className="text-[9px] text-zinc-400 dark:text-zinc-500">
                      Updated: {new Date(licenseInfo.last_updated).toLocaleDateString()}
                    </div>
                  )}
                </div>
              )}
              {licenseInfo.available_licenses === null && (
                <div className="text-[9px] leading-relaxed text-zinc-600 dark:text-zinc-400">
                  <div className="mb-1 font-medium text-zinc-900 dark:text-zinc-100">Not configured</div>
                  <div className="text-[8px] text-zinc-500 dark:text-zinc-500">
                    See "How do I configure it?" for setup instructions
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <Label className="text-xs">Work email</Label>
          <Input
            type="email"
            value={val}
            onChange={(e) => setVal(e.target.value)}
            placeholder="namel@simple.biz"
            autoFocus
          />
        </div>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            size="sm"
            className="bg-gradient-to-r from-emerald-500 to-teal-700 text-white hover:opacity-90"
            onClick={() => onSubmit(val)}
            disabled={busy}
          >
            {busy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Mail className="mr-1 h-3 w-3" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
