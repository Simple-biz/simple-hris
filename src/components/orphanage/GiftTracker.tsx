'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  CalendarDays,
  ChevronDown,
  Gift,
  Loader2,
  Package,
  Receipt,
  RefreshCw,
  Save,
  Search,
  Sparkles,
  Users,
} from 'lucide-react';
import GiftCatalog from '@/components/orphanage/GiftCatalog';
import GiftPayments from '@/components/orphanage/GiftPayments';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { EmployeeRow } from '@/lib/supabase/employees';
import type { GiftTrackerNote } from '@/lib/supabase/gift-tracker-notes';
import type { EmployeeGiftShippingRow } from '@/lib/supabase/employee-gift-shipping';
import type { GiftCatalogItem, GiftAnniversaryTier, GiftCatalogPayload } from '@/lib/supabase/gift-catalog';
import { CheckCircle2, XCircle, Truck, Lock, Tag, Pencil, Trash2, Undo2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';

type GiftStatus = 'overdue' | 'red' | 'orange' | 'green' | 'far';

type Milestone = {
  index: number; // 1-based — 1 = first 6-month gift
  date: Date;
};

function parseStartDate(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  const d = new Date(trimmed);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function addMonths(d: Date, months: number): Date {
  const out = new Date(d.getTime());
  const targetMonth = out.getMonth() + months;
  out.setMonth(targetMonth);
  // Handle clamp (e.g. Jan 31 + 1mo)
  if (out.getMonth() !== ((targetMonth % 12) + 12) % 12) {
    out.setDate(0);
  }
  return out;
}

function startOfDay(d: Date): Date {
  const out = new Date(d.getTime());
  out.setHours(0, 0, 0, 0);
  return out;
}

function diffDays(a: Date, b: Date): number {
  const ms = startOfDay(a).getTime() - startOfDay(b).getTime();
  return Math.round(ms / (1000 * 60 * 60 * 24));
}

function formatDate(d: Date): string {
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/** Build all 6-month milestones from `start` up through `today` (history) plus
 *  the very next future one. */
function buildMilestones(start: Date, today: Date): { history: Milestone[]; next: Milestone | null } {
  const history: Milestone[] = [];
  let next: Milestone | null = null;
  // Cap at a sane upper bound — 60 milestones = 30 years.
  for (let i = 1; i <= 60; i += 1) {
    const date = addMonths(start, i * 6);
    if (startOfDay(date).getTime() <= startOfDay(today).getTime()) {
      history.push({ index: i, date });
    } else {
      next = { index: i, date };
      break;
    }
  }
  return { history, next };
}

function gradientForStatus(status: GiftStatus): string {
  switch (status) {
    case 'overdue':
      return 'border-rose-400/90 bg-gradient-to-r from-rose-100 to-rose-50 text-rose-900 dark:border-rose-700/70 dark:from-rose-950/55 dark:to-rose-950/30 dark:text-rose-100';
    case 'red':
      return 'border-rose-400/90 bg-gradient-to-r from-rose-100 to-rose-50 text-rose-900 dark:border-rose-700/70 dark:from-rose-950/55 dark:to-rose-950/30 dark:text-rose-100';
    case 'orange':
      return 'border-orange-400/90 bg-gradient-to-r from-orange-100 to-amber-50 text-orange-900 dark:border-orange-700/70 dark:from-orange-950/55 dark:to-amber-950/30 dark:text-orange-100';
    case 'green':
      return 'border-emerald-400/90 bg-gradient-to-r from-emerald-100 to-emerald-50 text-emerald-900 dark:border-emerald-700/70 dark:from-emerald-950/55 dark:to-emerald-950/30 dark:text-emerald-100';
    default:
      return 'border-zinc-200 bg-white text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300';
  }
}

function statusLabel(status: GiftStatus, daysUntil: number | null): string {
  if (daysUntil === null) return 'No upcoming gift';
  if (status === 'overdue') return `Overdue · ${Math.abs(daysUntil)} days ago`;
  if (daysUntil === 0) return 'Today';
  if (daysUntil === 1) return 'Tomorrow';
  return `In ${daysUntil} day${daysUntil === 1 ? '' : 's'}`;
}

function classifyDaysUntil(daysUntil: number | null): GiftStatus {
  if (daysUntil === null) return 'far';
  if (daysUntil < 0) return 'overdue';
  if (daysUntil <= 7) return 'red';
  if (daysUntil <= 30) return 'orange';
  if (daysUntil <= 90) return 'green';
  return 'far';
}

type Row = {
  key: string;
  name: string;
  email: string; // primary key (personal_email lower-cased)
  workEmail: string | null;
  department: string | null;
  startDate: Date | null;
  history: Milestone[];
  next: Milestone | null;
  daysUntil: number | null;
  status: GiftStatus;
};

export default function GiftTracker({ viewerEmail }: { viewerEmail: string | null }) {
  const [employees, setEmployees] = useState<EmployeeRow[]>([]);
  const [notesByEmail, setNotesByEmail] = useState<Map<string, GiftTrackerNote>>(new Map());
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [draftNotes, setDraftNotes] = useState<Map<string, string>>(new Map());
  const [savingKey, setSavingKey] = useState<string | null>(null);
  /** All shipping submissions, grouped by lowercase personal_email. */
  const [shippingByEmail, setShippingByEmail] = useState<Map<string, EmployeeGiftShippingRow[]>>(
    new Map(),
  );
  /** Row id currently being approved/rejected (for spinner state). */
  const [decidingId, setDecidingId] = useState<string | null>(null);
  /** Gift catalog items (PHP) — provide the actual price when auto-deriving the gift. */
  const [giftCatalogItems, setGiftCatalogItems] = useState<GiftCatalogItem[]>([]);
  /** Anniversary tiers — the per-milestone mapping (6mo→Tshirt, 12mo→Tumbler, …). */
  const [giftCatalogAnnivs, setGiftCatalogAnnivs] = useState<GiftAnniversaryTier[]>([]);
  /** Row being edited by the orphanage manager (shipping fields). Null = closed. */
  const [editDraft, setEditDraft] = useState<{
    row: EmployeeGiftShippingRow;
    emailKey: string;
    location: string;
    contact: string;
    notes: string;
    saving: boolean;
  } | null>(null);
  /** Row id currently being deleted (spinner state). */
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [pageDir, setPageDir] = useState<1 | -1>(1);
  const PAGE_SIZE = 10;
  const [subTab, setSubTab] = useState<'roster' | 'submissions' | 'catalog' | 'payments'>('roster');
  /** Submissions sub-tab filter: which statuses to show. */
  const [submissionsFilter, setSubmissionsFilter] = useState<'pending' | 'approved' | 'rejected' | 'all'>('pending');
  const [submissionsSearch, setSubmissionsSearch] = useState('');

  const today = useMemo(() => new Date(), []);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const [empRes, notesRes, shipRes, catRes] = await Promise.all([
        fetch('/api/employees', { cache: 'no-store' }),
        fetch('/api/gift-tracker-notes', { cache: 'no-store' }),
        fetch('/api/employee-gift-shipping', { cache: 'no-store' }),
        fetch('/api/gift-catalog', { cache: 'no-store' }),
      ]);
      const catJson = (await catRes.json()) as { catalog?: GiftCatalogPayload; error?: string };
      setGiftCatalogItems(catJson.catalog?.items ?? []);
      setGiftCatalogAnnivs(catJson.catalog?.anniversaries ?? []);
      const empJson = (await empRes.json()) as { employees?: EmployeeRow[]; error?: string };
      const notesJson = (await notesRes.json()) as { notes?: GiftTrackerNote[]; error?: string };
      const shipJson = (await shipRes.json()) as { rows?: EmployeeGiftShippingRow[]; error?: string };
      if (empJson.error) throw new Error(empJson.error);
      setEmployees(empJson.employees ?? []);
      const map = new Map<string, GiftTrackerNote>();
      for (const n of notesJson.notes ?? []) {
        map.set(n.personal_email.toLowerCase(), n);
      }
      setNotesByEmail(map);
      const shipMap = new Map<string, EmployeeGiftShippingRow[]>();
      for (const r of shipJson.rows ?? []) {
        const key = r.personal_email.toLowerCase();
        const arr = shipMap.get(key) ?? [];
        arr.push(r);
        shipMap.set(key, arr);
      }
      // Sort each employee's submissions by milestone_index ascending.
      for (const arr of shipMap.values()) arr.sort((a, b) => a.milestone_index - b.milestone_index);
      setShippingByEmail(shipMap);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not load Gift Tracker');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const rows: Row[] = useMemo(() => {
    const out: Row[] = [];
    for (const e of employees) {
      const email = (e.personal_email ?? e.work_email ?? '').toLowerCase().trim();
      if (!email) continue;
      const startDate = parseStartDate(e.start_date);
      const { history, next } = startDate
        ? buildMilestones(startDate, today)
        : { history: [], next: null };
      const daysUntil = next ? diffDays(next.date, today) : null;
      const status = classifyDaysUntil(daysUntil);
      out.push({
        key: email,
        name: e.name ?? email,
        email,
        workEmail: e.work_email ?? null,
        department: e.department ?? null,
        startDate,
        history,
        next,
        daysUntil,
        status,
      });
    }
    return out.sort((a, b) => {
      // Closest gift dates first; "far" and "no start date" sink to the bottom.
      const aRank = a.daysUntil ?? Number.POSITIVE_INFINITY;
      const bRank = b.daysUntil ?? Number.POSITIVE_INFINITY;
      return aRank - bRank;
    });
  }, [employees, today]);

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      [r.name, r.email, r.workEmail ?? '', r.department ?? '']
        .join(' ')
        .toLowerCase()
        .includes(q),
    );
  }, [rows, search]);

  const stats = useMemo(() => {
    let red = 0;
    let orange = 0;
    let green = 0;
    let overdue = 0;
    for (const r of rows) {
      if (r.status === 'red') red += 1;
      else if (r.status === 'orange') orange += 1;
      else if (r.status === 'green') green += 1;
      else if (r.status === 'overdue') overdue += 1;
    }
    return { total: rows.length, red, orange, green, overdue };
  }, [rows]);

  const toggleExpand = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const noteValue = useCallback(
    (key: string) => {
      if (draftNotes.has(key)) return draftNotes.get(key) ?? '';
      return notesByEmail.get(key)?.note ?? '';
    },
    [draftNotes, notesByEmail],
  );

  const saveNote = useCallback(
    async (row: Row) => {
      const value = noteValue(row.key);
      const original = notesByEmail.get(row.key)?.note ?? '';
      if (value === original) {
        // nothing changed
        setDraftNotes((prev) => {
          const next = new Map(prev);
          next.delete(row.key);
          return next;
        });
        return;
      }
      setSavingKey(row.key);
      try {
        const res = await fetch('/api/gift-tracker-notes', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            personal_email: row.email,
            note: value,
            updated_by: viewerEmail,
          }),
        });
        const json = (await res.json()) as { error?: string };
        if (!res.ok || json.error) throw new Error(json.error ?? 'Failed');
        setNotesByEmail((prev) => {
          const next = new Map(prev);
          next.set(row.key, {
            personal_email: row.email,
            note: value,
            updated_by: viewerEmail,
            updated_at: new Date().toISOString(),
          });
          return next;
        });
        setDraftNotes((prev) => {
          const next = new Map(prev);
          next.delete(row.key);
          return next;
        });
        toast.success('Note saved.');
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Could not save note');
      } finally {
        setSavingKey(null);
      }
    },
    [noteValue, notesByEmail, viewerEmail],
  );

  /**
   * Reject inline (prompt for an optional note). Approval is a separate flow
   * because the approver also has to pick a gift + confirm its PHP price.
   */
  const rejectShipping = useCallback(
    async (rowId: string, emailKey: string) => {
      const note =
        (window.prompt('Reason for rejection (optional, shown to the employee):') ?? '').trim() ||
        null;
      setDecidingId(rowId);
      try {
        const res = await fetch(`/api/employee-gift-shipping/${rowId}/decide`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            status: 'rejected',
            decided_by: viewerEmail,
            decision_note: note,
          }),
        });
        const json = (await res.json()) as { row?: EmployeeGiftShippingRow; error?: string };
        if (!res.ok || json.error || !json.row) throw new Error(json.error ?? 'Failed');
        setShippingByEmail((prev) => {
          const next = new Map(prev);
          const arr = (next.get(emailKey) ?? []).map((r) => (r.id === json.row!.id ? json.row! : r));
          next.set(emailKey, arr);
          return next;
        });
        toast.success('Submission rejected.');
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Could not update submission');
      } finally {
        setDecidingId(null);
      }
    },
    [viewerEmail],
  );

  /**
   * Auto-derive the gift for a given milestone:
   *  milestone_index 1 → 0.5 years, 2 → 1, 3 → 1.5, etc.
   *  Look up the anniversary tier for that year, then find the matching item
   *  in the catalog by name. Returns the catalog item id + name + PHP price.
   *  Falls back to the anniversary's `gift` string with price 0 when no
   *  matching catalog item exists.
   */
  const deriveGiftForMilestone = useCallback(
    (milestoneIndex: number): { itemId: string | null; name: string; pricePhp: number } | null => {
      const year = milestoneIndex * 0.5;
      const tier = giftCatalogAnnivs.find((a) => Math.abs(a.year - year) < 0.01);
      const giftName = tier?.gift?.trim() ?? '';
      if (!giftName) return null;

      const target = giftName.toLowerCase();
      let match = giftCatalogItems.find((i) => i.item.trim().toLowerCase() === target);
      if (!match) {
        const firstWord = target.split(/[\s&]+/)[0];
        if (firstWord) {
          match = giftCatalogItems.find((i) => i.item.trim().toLowerCase() === firstWord);
        }
      }
      return {
        itemId: match?.id ?? null,
        name: match?.item ?? giftName,
        pricePhp: match?.price_php ?? 0,
      };
    },
    [giftCatalogAnnivs, giftCatalogItems],
  );

  /** Approve with the auto-derived gift. No dialog, no manual picking. */
  const approveShipping = useCallback(
    async (rowId: string, milestoneIndex: number, emailKey: string) => {
      const gift = deriveGiftForMilestone(milestoneIndex);
      if (!gift) {
        toast.error(
          'No catalog mapping for this milestone yet. Add it in Gift Tracker → Catalog first.',
        );
        return;
      }
      setDecidingId(rowId);
      try {
        const res = await fetch(`/api/employee-gift-shipping/${rowId}/decide`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            status: 'approved',
            decided_by: viewerEmail,
            decision_note: null,
            gift_catalog_item_id: gift.itemId,
            gift_name: gift.name,
            gift_price_php: gift.pricePhp,
          }),
        });
        const json = (await res.json()) as { row?: EmployeeGiftShippingRow; error?: string };
        if (!res.ok || json.error || !json.row) throw new Error(json.error ?? 'Failed');
        const updated = json.row;
        setShippingByEmail((prev) => {
          const next = new Map(prev);
          const arr = (next.get(emailKey) ?? []).map((r) =>
            r.id === updated.id ? updated : r,
          );
          next.set(emailKey, arr);
          return next;
        });
        toast.success(
          `Approved — ${gift.name} (₱${gift.pricePhp.toLocaleString()}) sent to Accounting.`,
        );
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Could not approve submission');
      } finally {
        setDecidingId(null);
      }
    },
    [deriveGiftForMilestone, viewerEmail],
  );

  /** Open the edit-shipping dialog for an orphanage-side correction. */
  const openEditDialog = useCallback(
    (row: EmployeeGiftShippingRow, emailKey: string) => {
      setEditDraft({
        row,
        emailKey,
        location: row.preferred_delivery_location,
        contact: row.active_contact_number,
        notes: row.notes,
        saving: false,
      });
    },
    [],
  );

  const submitEditDialog = useCallback(async () => {
    if (!editDraft) return;
    setEditDraft((d) => (d ? { ...d, saving: true } : d));
    try {
      const res = await fetch(`/api/employee-gift-shipping/${editDraft.row.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          edited_by: viewerEmail,
          preferred_delivery_location: editDraft.location.trim(),
          active_contact_number: editDraft.contact.trim(),
          notes: editDraft.notes.trim(),
        }),
      });
      const json = (await res.json()) as { row?: EmployeeGiftShippingRow; error?: string };
      if (!res.ok || json.error || !json.row) throw new Error(json.error ?? 'Failed');
      const updated = json.row;
      const emailKey = editDraft.emailKey;
      setShippingByEmail((prev) => {
        const next = new Map(prev);
        const arr = (next.get(emailKey) ?? []).map((r) => (r.id === updated.id ? updated : r));
        next.set(emailKey, arr);
        return next;
      });
      toast.success('Shipping details updated.');
      setEditDraft(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not update');
      setEditDraft((d) => (d ? { ...d, saving: false } : d));
    }
  }, [editDraft, viewerEmail]);

  /** Delete a submission with confirm. */
  const deleteShipping = useCallback(
    async (rowId: string, emailKey: string, milestoneLabel: string) => {
      if (
        !window.confirm(
          `Delete the ${milestoneLabel} submission? The employee can resubmit if they're still inside the milestone window. This cannot be undone.`,
        )
      ) {
        return;
      }
      setDeletingId(rowId);
      try {
        const res = await fetch(`/api/employee-gift-shipping/${rowId}`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deleted_by: viewerEmail }),
        });
        const json = (await res.json()) as { error?: string };
        if (!res.ok || json.error) throw new Error(json.error ?? 'Failed');
        setShippingByEmail((prev) => {
          const next = new Map(prev);
          const arr = (next.get(emailKey) ?? []).filter((r) => r.id !== rowId);
          if (arr.length === 0) next.delete(emailKey);
          else next.set(emailKey, arr);
          return next;
        });
        toast.success('Submission deleted.');
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Could not delete');
      } finally {
        setDeletingId(null);
      }
    },
    [viewerEmail],
  );

  /** Single entry point passed down to RowItem / SubmissionsPanel. */
  const decideShipping = useCallback(
    (rowId: string, status: 'approved' | 'rejected', emailKey: string) => {
      if (status === 'rejected') {
        void rejectShipping(rowId, emailKey);
        return;
      }
      const candidate = shippingByEmail.get(emailKey)?.find((r) => r.id === rowId);
      if (!candidate) {
        toast.error('Could not locate submission. Refresh and retry.');
        return;
      }
      void approveShipping(rowId, candidate.milestone_index, emailKey);
    },
    [approveShipping, rejectShipping, shippingByEmail],
  );

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
      className="flex min-h-0 flex-1 flex-col overflow-y-auto"
    >
      <div className="flex flex-col gap-6 px-4 pb-10 pt-6 sm:px-6 lg:gap-8 lg:px-8 lg:pt-8">
        <header className="relative overflow-hidden rounded-2xl border border-emerald-200/80 bg-gradient-to-br from-emerald-500 via-teal-600 to-zinc-900 px-5 py-7 text-white shadow-lg shadow-emerald-600/20 dark:border-emerald-900/50 dark:from-emerald-600 dark:via-teal-900 dark:to-black sm:px-7">
          <div
            className="absolute -right-10 -top-10 h-36 w-36 rounded-full bg-white/15 blur-3xl"
            aria-hidden
          />
          <div
            className="absolute -bottom-12 left-8 h-32 w-32 rounded-full bg-teal-300/25 blur-2xl"
            aria-hidden
          />
          <div className="relative flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between lg:gap-6">
            <div className="flex min-w-0 flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.18em] text-emerald-100/95">
                <Sparkles className="h-3 w-3 shrink-0" />
                Gift tracker
              </div>
              <h1 className="text-balance text-2xl font-bold tracking-tight sm:text-3xl">
                Six-month gifts &amp; tenure milestones
              </h1>
              <p className="max-w-2xl text-sm leading-relaxed text-emerald-100/90">
                Every 6 months an employee stays with the company they earn a gift. Color-coded badges flag who&apos;s
                close — green at 3 months out, orange at 1 month, red within a week.
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="border-white/35 bg-white/10 text-white backdrop-blur-sm hover:bg-white/20 hover:text-white"
                onClick={() => void load()}
                disabled={refreshing}
              >
                <RefreshCw
                  className={refreshing ? 'mr-1.5 h-3.5 w-3.5 animate-spin' : 'mr-1.5 h-3.5 w-3.5'}
                />
                Refresh
              </Button>
            </div>
          </div>
        </header>

        {/* Sub-tab toggle — Roster vs editable Catalog. */}
        <nav
          className="inline-flex w-full flex-wrap items-center gap-1 rounded-lg border border-emerald-100/80 bg-white/80 p-1 sm:w-fit dark:border-emerald-950/45 dark:bg-zinc-950/60"
          aria-label="Gift Tracker sections"
        >
          <SubTabButton
            active={subTab === 'roster'}
            onClick={() => setSubTab('roster')}
            Icon={Users}
            label="Roster"
          />
          <SubTabButton
            active={subTab === 'submissions'}
            onClick={() => setSubTab('submissions')}
            Icon={Truck}
            label="Submissions"
            badge={
              // Pending count surfaces here so the team knows when action is needed.
              Array.from(shippingByEmail.values()).reduce(
                (n, arr) => n + arr.filter((r) => r.status === 'pending').length,
                0,
              ) || undefined
            }
          />
          <SubTabButton
            active={subTab === 'catalog'}
            onClick={() => setSubTab('catalog')}
            Icon={Package}
            label="Catalog"
          />
          <SubTabButton
            active={subTab === 'payments'}
            onClick={() => setSubTab('payments')}
            Icon={Receipt}
            label="Payments"
          />
        </nav>

        <AnimatePresence mode="wait" initial={false}>
        {subTab === 'catalog' ? (
          <motion.div
            key="catalog"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
          >
            <GiftCatalog viewerEmail={viewerEmail} />
          </motion.div>
        ) : subTab === 'payments' ? (
          <motion.div
            key="payments"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
          >
            <GiftPayments viewerEmail={viewerEmail} />
          </motion.div>
        ) : subTab === 'submissions' ? (
          <motion.div
            key="submissions"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
          >
            <SubmissionsPanel
              shippingByEmail={shippingByEmail}
              rowsByEmail={new Map(rows.map((r) => [r.key, r]))}
              filter={submissionsFilter}
              setFilter={setSubmissionsFilter}
              search={submissionsSearch}
              setSearch={setSubmissionsSearch}
              decidingId={decidingId}
              deletingId={deletingId}
              onDecide={(id, status, emailKey) => void decideShipping(id, status, emailKey)}
              onEdit={(row, emailKey) => openEditDialog(row, emailKey)}
              onDelete={(row, emailKey) =>
                void deleteShipping(row.id, emailKey, `${row.milestone_index * 6}-month`)
              }
            />
          </motion.div>
        ) : (
        <motion.div
          key="roster"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
          className="flex flex-col gap-6 lg:gap-8"
        >
        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Gift summary">
          <StatTile
            label="Tracked employees"
            value={stats.total}
            hint="From Global Master List"
            icon={Users}
            tone="pink"
          />
          <StatTile
            label="Within 1 week"
            value={stats.red + stats.overdue}
            hint={stats.overdue > 0 ? `${stats.overdue} overdue` : 'Get the gift ready'}
            icon={Gift}
            tone="red"
          />
          <StatTile
            label="Within 1 month"
            value={stats.orange}
            hint="Plan ahead this month"
            icon={CalendarDays}
            tone="orange"
          />
          <StatTile
            label="Within 3 months"
            value={stats.green}
            hint="On the horizon"
            icon={Sparkles}
            tone="green"
          />
        </section>

        <Card className="border-emerald-100/80 bg-gradient-to-br from-white via-emerald-50/30 to-white shadow-md ring-1 ring-emerald-500/8 dark:border-emerald-950/55 dark:from-zinc-950 dark:via-emerald-950/12 dark:to-zinc-950 dark:ring-emerald-400/10">
          <CardHeader className="flex flex-col gap-1 border-b border-emerald-100/60 pb-4 dark:border-emerald-900/40">
            <div className="flex items-center gap-2.5">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-500 to-teal-700 text-white shadow-sm shadow-emerald-600/25">
                <Gift className="h-4 w-4" />
              </div>
              <CardTitle className="text-base font-semibold">Tenure gift roster</CardTitle>
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">
              Sorted by closest upcoming gift. Click a row to see the full milestone history and edit the note.
            </p>
          </CardHeader>
          <CardContent className="flex flex-col gap-4 pt-4">
            <div className="relative max-w-md">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
              <Input
                value={search}
                onChange={(e) => { setSearch(e.target.value); setPage(0); }}
                placeholder="Search by name, email, or department..."
                className="border-emerald-100/70 bg-white/90 pl-9 dark:border-emerald-900/50 dark:bg-zinc-900/70"
              />
            </div>

            {loading ? (
              <div className="flex items-center justify-center gap-2 py-12 text-sm text-zinc-500">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading roster…
              </div>
            ) : filteredRows.length === 0 ? (
              <div className="rounded-xl border border-dashed border-emerald-200/80 bg-white/70 py-10 text-center text-sm text-zinc-600 dark:border-emerald-900/50 dark:bg-zinc-950/40 dark:text-zinc-400">
                {rows.length === 0 ? 'No employees in the master list yet.' : 'No rows match your search.'}
              </div>
            ) : (
              <div className="overflow-hidden rounded-xl border border-emerald-100/90 ring-1 ring-emerald-500/10 dark:border-emerald-900/60 dark:ring-emerald-400/10">
                <AnimatePresence mode="wait" initial={false} custom={pageDir}>
                <motion.table
                  key={page}
                  custom={pageDir}
                  variants={{
                    enter: (dir: number) => ({ opacity: 0, x: dir * 32 }),
                    center: { opacity: 1, x: 0 },
                    exit: (dir: number) => ({ opacity: 0, x: dir * -32 }),
                  }}
                  initial="enter"
                  animate="center"
                  exit="exit"
                  transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                  className="w-full min-w-[760px] text-left text-sm"
                >
                  <thead className="bg-gradient-to-r from-emerald-50 via-white to-emerald-50/80 text-xs text-zinc-600 dark:from-emerald-950/50 dark:via-zinc-950 dark:to-emerald-950/40 dark:text-zinc-400">
                    <tr>
                      <th className="px-4 py-3 font-semibold">Employee</th>
                      <th className="px-4 py-3 font-semibold">Start date</th>
                      <th className="px-4 py-3 font-semibold">Milestones</th>
                      <th className="px-4 py-3 font-semibold">Next gift date</th>
                      <th className="px-4 py-3 font-semibold w-[1%]" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-emerald-100/70 bg-white/80 dark:divide-emerald-900/35 dark:bg-zinc-950/40">
                    {filteredRows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((row) => {
                      const isOpen = expanded.has(row.key);
                      const noteVal = noteValue(row.key);
                      const noteDirty = draftNotes.has(row.key);
                      return (
                        <RowItem
                          key={row.key}
                          row={row}
                          isOpen={isOpen}
                          onToggle={() => toggleExpand(row.key)}
                          noteValue={noteVal}
                          noteDirty={noteDirty}
                          saving={savingKey === row.key}
                          onNoteChange={(v) =>
                            setDraftNotes((prev) => {
                              const next = new Map(prev);
                              next.set(row.key, v);
                              return next;
                            })
                          }
                          onNoteSave={() => void saveNote(row)}
                          updatedAt={notesByEmail.get(row.key)?.updated_at ?? null}
                          shippingRows={shippingByEmail.get(row.key) ?? []}
                          onDecideShipping={(id, status) => void decideShipping(id, status, row.key)}
                          decidingId={decidingId}
                          deletingId={deletingId}
                          onEditShipping={(sub) => openEditDialog(sub, row.key)}
                          onDeleteShipping={(sub) =>
                            void deleteShipping(sub.id, row.key, `${sub.milestone_index * 6}-month`)
                          }
                        />
                      );
                    })}
                  </tbody>
                </motion.table>
                </AnimatePresence>
                {filteredRows.length > PAGE_SIZE && (
                  <div className="flex items-center justify-between border-t border-emerald-100/60 bg-white/70 px-4 py-3 dark:border-emerald-900/40 dark:bg-zinc-950/40">
                    <span className="text-xs text-zinc-500 dark:text-zinc-400">
                      Page {page + 1} of {Math.ceil(filteredRows.length / PAGE_SIZE)}
                      {' · '}{filteredRows.length} total
                    </span>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 px-3 text-xs border-emerald-100/70 dark:border-emerald-900/50"
                        disabled={page === 0}
                        onClick={() => { setPageDir(-1); setPage((p) => Math.max(0, p - 1)); }}
                      >
                        ← Prev
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 px-3 text-xs border-emerald-100/70 dark:border-emerald-900/50"
                        disabled={(page + 1) * PAGE_SIZE >= filteredRows.length}
                        onClick={() => { setPageDir(1); setPage((p) => p + 1); }}
                      >
                        Next →
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
        </motion.div>
        )}
        </AnimatePresence>
      </div>

      {/* Edit shipping details dialog (orphanage-side correction) */}
      <Dialog
        open={!!editDraft}
        onOpenChange={(v) => !v && !editDraft?.saving && setEditDraft(null)}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Edit shipping details</DialogTitle>
            <DialogDescription>
              Make corrections on the employee&apos;s behalf. The gift assignment and
              approval status are not changed by this edit.
            </DialogDescription>
          </DialogHeader>
          {editDraft && (
            <div className="grid gap-3">
              <div className="rounded-md border border-emerald-100 bg-emerald-50/40 px-3 py-2 text-[11px] dark:border-emerald-900/40 dark:bg-emerald-950/15">
                <div className="font-mono text-zinc-600 dark:text-zinc-400">
                  {editDraft.row.personal_email}
                </div>
                <div className="font-semibold text-zinc-800 dark:text-zinc-200">
                  {editDraft.row.milestone_index * 6}-month gift · #
                  {editDraft.row.milestone_index}
                </div>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="edit-loc" className="text-xs font-medium">
                  Preferred delivery location
                </Label>
                <Input
                  id="edit-loc"
                  value={editDraft.location}
                  onChange={(e) =>
                    setEditDraft((d) => (d ? { ...d, location: e.target.value } : d))
                  }
                  disabled={editDraft.saving}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="edit-phone" className="text-xs font-medium">
                  Active contact number
                </Label>
                <Input
                  id="edit-phone"
                  value={editDraft.contact}
                  onChange={(e) =>
                    setEditDraft((d) => (d ? { ...d, contact: e.target.value } : d))
                  }
                  disabled={editDraft.saving}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="edit-notes" className="text-xs font-medium">
                  Notes
                </Label>
                <textarea
                  id="edit-notes"
                  value={editDraft.notes}
                  onChange={(e) =>
                    setEditDraft((d) => (d ? { ...d, notes: e.target.value } : d))
                  }
                  disabled={editDraft.saving}
                  className="min-h-[72px] w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm shadow-sm placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-emerald-400/40 disabled:opacity-60 dark:border-zinc-800 dark:bg-zinc-950"
                />
              </div>
              <div className="flex justify-end gap-2 pt-1">
                <Button
                  variant="outline"
                  onClick={() => setEditDraft(null)}
                  disabled={editDraft.saving}
                >
                  Cancel
                </Button>
                <Button
                  onClick={() => void submitEditDialog()}
                  disabled={editDraft.saving}
                  className="bg-emerald-600 text-white hover:bg-emerald-700"
                >
                  {editDraft.saving && (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  )}
                  Save changes
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </motion.div>
  );
}

function SubTabButton({
  active,
  onClick,
  Icon,
  label,
  badge,
}: {
  active: boolean;
  onClick: () => void;
  Icon: React.ComponentType<{ className?: string }>;
  label: string;
  badge?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-medium transition-colors',
        active
          ? 'bg-gradient-to-r from-emerald-500 to-teal-700 text-white shadow-sm shadow-emerald-600/25'
          : 'text-zinc-600 hover:bg-emerald-50 hover:text-emerald-900 dark:text-zinc-300 dark:hover:bg-emerald-950/40 dark:hover:text-emerald-100',
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
      {badge !== undefined && badge > 0 && (
        <span
          className={cn(
            'rounded-full px-1.5 py-0.5 text-[10px] font-bold leading-none',
            active
              ? 'bg-white text-emerald-700'
              : 'bg-emerald-600 text-white',
          )}
        >
          {badge}
        </span>
      )}
    </button>
  );
}

function RowItem({
  row,
  isOpen,
  onToggle,
  noteValue,
  noteDirty,
  saving,
  onNoteChange,
  onNoteSave,
  updatedAt,
  shippingRows,
  onDecideShipping,
  decidingId,
  deletingId,
  onEditShipping,
  onDeleteShipping,
}: {
  row: Row;
  isOpen: boolean;
  onToggle: () => void;
  noteValue: string;
  noteDirty: boolean;
  saving: boolean;
  onNoteChange: (v: string) => void;
  onNoteSave: () => void;
  updatedAt: string | null;
  shippingRows: EmployeeGiftShippingRow[];
  onDecideShipping: (id: string, status: 'approved' | 'rejected') => void;
  decidingId: string | null;
  deletingId: string | null;
  onEditShipping: (sub: EmployeeGiftShippingRow) => void;
  onDeleteShipping: (sub: EmployeeGiftShippingRow) => void;
}) {
  return (
    <>
      <tr
        className="cursor-pointer align-top transition-colors hover:bg-emerald-50/35 dark:hover:bg-emerald-950/25"
        onClick={onToggle}
      >
        <td className="px-4 py-3">
          <div className="flex flex-col">
            <span className="font-medium text-zinc-900 dark:text-zinc-100">{row.name}</span>
            <span className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400">{row.email}</span>
            {row.department ? (
              <span className="mt-0.5 text-[11px] text-emerald-600/80 dark:text-emerald-400/80">{row.department}</span>
            ) : null}
          </div>
        </td>
        <td className="whitespace-nowrap px-4 py-3 text-xs text-zinc-700 dark:text-zinc-300">
          {row.startDate ? formatDate(row.startDate) : <span className="text-zinc-400">—</span>}
        </td>
        <td className="whitespace-nowrap px-4 py-3 text-xs">
          <Badge
            variant="outline"
            className="border-zinc-200 bg-zinc-50 font-medium text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
          >
            {row.history.length} reached
          </Badge>
        </td>
        <td className="whitespace-nowrap px-4 py-3">
          {row.next ? (
            <motion.div
              key={row.status}
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
              className={cn(
                'inline-flex flex-col gap-0.5 rounded-lg border px-3 py-1.5 text-xs font-medium',
                gradientForStatus(row.status),
              )}
            >
              <span className="font-semibold">{formatDate(row.next.date)}</span>
              <span className="text-[10.5px] opacity-90">
                Milestone #{row.next.index} · {statusLabel(row.status, row.daysUntil)}
              </span>
            </motion.div>
          ) : row.startDate ? (
            <span className="text-xs text-zinc-400">—</span>
          ) : (
            <span className="text-xs italic text-zinc-400">No start date on file</span>
          )}
        </td>
        <td className="px-4 py-3 text-right">
          <motion.div
            animate={{ rotate: isOpen ? 180 : 0 }}
            transition={{ duration: 0.2 }}
            className="inline-flex"
          >
            <ChevronDown className="h-4 w-4 text-zinc-400" />
          </motion.div>
        </td>
      </tr>
      <AnimatePresence initial={false}>
        {isOpen && (
          <tr>
            <td colSpan={5} className="bg-emerald-50/30 p-0 dark:bg-emerald-950/15">
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
                className="overflow-hidden"
              >
                <div className="grid gap-5 px-5 py-5 lg:grid-cols-3">
                  {/* History */}
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-300">
                      <Sparkles className="h-3.5 w-3.5" />
                      Milestone history
                    </div>
                    {row.history.length === 0 ? (
                      <p className="rounded-md border border-dashed border-emerald-200 bg-white/60 px-3 py-3 text-xs text-zinc-500 dark:border-emerald-900/50 dark:bg-zinc-950/40">
                        No 6-month milestones reached yet.
                      </p>
                    ) : (
                      <ol className="relative ml-1 flex flex-col gap-2 border-l-2 border-emerald-200/70 pl-4 dark:border-emerald-800/70">
                        {row.history.map((m, idx) => (
                          <motion.li
                            key={m.index}
                            initial={{ x: -10, opacity: 0 }}
                            animate={{ x: 0, opacity: 1 }}
                            transition={{ delay: idx * 0.03, duration: 0.25 }}
                            className="relative"
                          >
                            <span className="absolute -left-[22px] top-1 h-3 w-3 rounded-full bg-gradient-to-br from-emerald-500 to-teal-700 ring-2 ring-white dark:ring-zinc-950" />
                            <div className="flex items-baseline justify-between gap-3 rounded-md bg-white/80 px-3 py-1.5 text-xs shadow-sm dark:bg-zinc-950/55">
                              <span className="font-medium text-zinc-800 dark:text-zinc-200">
                                {m.index * 6} months · #{m.index}
                              </span>
                              <span className="text-zinc-500 dark:text-zinc-400">{formatDate(m.date)}</span>
                            </div>
                          </motion.li>
                        ))}
                      </ol>
                    )}
                  </div>

                  {/* Notes */}
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-300">
                      <Gift className="h-3.5 w-3.5" />
                      Notes
                    </div>
                    <textarea
                      value={noteValue}
                      onChange={(e) => onNoteChange(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      rows={5}
                      placeholder="Gift preferences, allergies, sizing, delivery address quirks…"
                      className="w-full rounded-md border border-emerald-100 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-200 dark:border-emerald-900/50 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:border-emerald-700 dark:focus:ring-emerald-900/50"
                    />
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] text-zinc-500 dark:text-zinc-400">
                        {updatedAt
                          ? `Last saved ${new Date(updatedAt).toLocaleString(undefined, {
                              dateStyle: 'medium',
                              timeStyle: 'short',
                            })}`
                          : 'No note yet'}
                      </span>
                      <Button
                        size="sm"
                        className="h-8 bg-gradient-to-r from-emerald-500 to-teal-700 text-white shadow-sm shadow-emerald-600/25 hover:from-emerald-700 hover:to-teal-800"
                        onClick={(e) => {
                          e.stopPropagation();
                          onNoteSave();
                        }}
                        disabled={!noteDirty || saving}
                      >
                        {saving ? (
                          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Save className="mr-1.5 h-3.5 w-3.5" />
                        )}
                        Save note
                      </Button>
                    </div>
                  </div>

                  {/* Shipping submissions */}
                  <div className="flex flex-col gap-2" onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-300">
                      <Truck className="h-3.5 w-3.5" />
                      Shipping submissions
                    </div>
                    {shippingRows.length === 0 ? (
                      <p className="rounded-md border border-dashed border-emerald-200 bg-white/60 px-3 py-3 text-xs text-zinc-500 dark:border-emerald-900/50 dark:bg-zinc-950/40">
                        No shipping details submitted yet. Employees fill these out
                        starting 30 days before each milestone.
                      </p>
                    ) : (
                      <ul className="flex flex-col gap-2">
                        {shippingRows.map((s) => {
                          const isDeciding = decidingId === s.id;
                          const isDeleting = deletingId === s.id;
                          const isLocked = s.status === 'approved';
                          return (
                            <li
                              key={s.id}
                              className="rounded-md border border-emerald-100 bg-white/85 p-2.5 text-xs shadow-sm dark:border-emerald-900/50 dark:bg-zinc-950/55"
                            >
                              <div className="flex items-center justify-between gap-2">
                                <span className="font-semibold text-zinc-800 dark:text-zinc-200">
                                  {s.milestone_index * 6}-month · #{s.milestone_index}
                                </span>
                                {s.status === 'approved' ? (
                                  <Badge className="border-emerald-500/30 bg-emerald-500/10 text-[10px] text-emerald-700 dark:text-emerald-300">
                                    <Lock className="mr-1 h-2.5 w-2.5" /> Approved
                                  </Badge>
                                ) : s.status === 'rejected' ? (
                                  <Badge className="border-rose-500/30 bg-rose-500/10 text-[10px] text-rose-700 dark:text-rose-300">
                                    Rejected
                                  </Badge>
                                ) : (
                                  <Badge className="border-amber-500/30 bg-amber-500/10 text-[10px] text-amber-700 dark:text-amber-300">
                                    Pending
                                  </Badge>
                                )}
                              </div>
                              <div className="mt-1.5 grid gap-0.5 text-[11px] text-zinc-600 dark:text-zinc-400">
                                <div>
                                  <span className="font-semibold text-zinc-700 dark:text-zinc-300">Address:</span>{' '}
                                  {s.preferred_delivery_location || <span className="italic text-zinc-400">—</span>}
                                </div>
                                <div>
                                  <span className="font-semibold text-zinc-700 dark:text-zinc-300">Phone:</span>{' '}
                                  {s.active_contact_number || <span className="italic text-zinc-400">—</span>}
                                </div>
                                {s.notes && (
                                  <div>
                                    <span className="font-semibold text-zinc-700 dark:text-zinc-300">Notes:</span>{' '}
                                    {s.notes}
                                  </div>
                                )}
                                {s.decision_note && (
                                  <div className="mt-1 italic text-zinc-500 dark:text-zinc-500">
                                    Reviewer note: {s.decision_note}
                                  </div>
                                )}
                                {s.status === 'approved' && s.gift_name && (
                                  <div className="mt-1.5 inline-flex items-center gap-1 rounded-md border border-emerald-300/60 bg-emerald-50/80 px-1.5 py-0.5 text-[10.5px] font-semibold text-emerald-800 dark:border-emerald-800/50 dark:bg-emerald-950/30 dark:text-emerald-200">
                                    <Tag className="h-2.5 w-2.5" />
                                    {s.gift_name}
                                    {s.gift_price_php != null && (
                                      <span className="font-mono tabular-nums">
                                        · ₱{s.gift_price_php.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                      </span>
                                    )}
                                  </div>
                                )}
                              </div>
                              <div className="mt-2 flex flex-wrap justify-end gap-1.5">
                                {!isLocked && (
                                  <>
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      className="h-7 border-amber-300 text-amber-700 hover:bg-amber-50 dark:border-amber-900/50 dark:text-amber-300 dark:hover:bg-amber-950/30"
                                      disabled={isDeciding || isDeleting}
                                      onClick={() => onDecideShipping(s.id, 'rejected')}
                                    >
                                      {isDeciding ? (
                                        <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                                      ) : (
                                        <Undo2 className="mr-1 h-3 w-3" />
                                      )}
                                      Return
                                    </Button>
                                    <Button
                                      size="sm"
                                      className="h-7 bg-emerald-600 text-white hover:bg-emerald-700"
                                      disabled={isDeciding || isDeleting}
                                      onClick={() => onDecideShipping(s.id, 'approved')}
                                    >
                                      {isDeciding ? (
                                        <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                                      ) : (
                                        <CheckCircle2 className="mr-1 h-3 w-3" />
                                      )}
                                      Approve & lock
                                    </Button>
                                  </>
                                )}
                                {isLocked && !s.gift_name && (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="h-7 border-emerald-300 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-900/50 dark:text-emerald-300 dark:hover:bg-emerald-950/30"
                                    disabled={isDeciding || isDeleting}
                                    onClick={() => onDecideShipping(s.id, 'approved')}
                                  >
                                    {isDeciding ? (
                                      <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                                    ) : (
                                      <Tag className="mr-1 h-3 w-3" />
                                    )}
                                    Apply gift
                                  </Button>
                                )}
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7 border-zinc-300 text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
                                  disabled={isDeciding || isDeleting}
                                  onClick={() => onEditShipping(s)}
                                >
                                  <Pencil className="mr-1 h-3 w-3" />
                                  Edit
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7 border-rose-300 text-rose-700 hover:bg-rose-50 dark:border-rose-900/50 dark:text-rose-300 dark:hover:bg-rose-950/30"
                                  disabled={isDeciding || isDeleting}
                                  onClick={() => onDeleteShipping(s)}
                                >
                                  {isDeleting ? (
                                    <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                                  ) : (
                                    <Trash2 className="mr-1 h-3 w-3" />
                                  )}
                                  Delete
                                </Button>
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                </div>
              </motion.div>
            </td>
          </tr>
        )}
      </AnimatePresence>
    </>
  );
}

function StatTile({
  label,
  value,
  hint,
  icon: Icon,
  tone,
}: {
  label: string;
  value: number | string;
  hint: string;
  icon: React.ComponentType<{ className?: string }>;
  tone: 'pink' | 'red' | 'orange' | 'green';
}) {
  const tones: Record<'pink' | 'red' | 'orange' | 'green', string> = {
    pink: 'from-emerald-500 to-teal-700 shadow-emerald-500/30',
    red: 'from-rose-500 to-rose-800 shadow-rose-500/35',
    orange: 'from-orange-500 to-amber-600 shadow-orange-500/35',
    green: 'from-emerald-500 to-emerald-700 shadow-emerald-500/35',
  };
  return (
    <div className="group relative flex items-center gap-4 overflow-hidden rounded-xl border border-emerald-100/80 bg-white/90 px-4 py-4 ring-1 ring-emerald-500/5 backdrop-blur-sm transition-shadow hover:shadow-md hover:shadow-emerald-500/10 dark:border-emerald-950/50 dark:bg-zinc-950/75 dark:ring-emerald-400/10">
      <div
        className={cn(
          'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br text-white shadow-md',
          tones[tone],
        )}
      >
        <Icon className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-emerald-600/85 dark:text-emerald-400/85">
          {label}
        </div>
        <div className="mt-0.5 bg-gradient-to-br from-zinc-900 via-teal-900 to-zinc-800 bg-clip-text text-xl font-bold tabular-nums text-transparent dark:from-white dark:via-emerald-200 dark:to-zinc-200 sm:text-2xl">
          {value}
        </div>
        <div className="mt-1 text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">{hint}</div>
      </div>
    </div>
  );
}

/**
 * Submissions sub-tab — flat list of every employee shipping submission
 * across all milestones, with status filter + search + inline approve/reject.
 * Approved rows are visible but read-only (form is locked on the employee side).
 */
function SubmissionsPanel({
  shippingByEmail,
  rowsByEmail,
  filter,
  setFilter,
  search,
  setSearch,
  decidingId,
  deletingId,
  onDecide,
  onEdit,
  onDelete,
}: {
  shippingByEmail: Map<string, EmployeeGiftShippingRow[]>;
  rowsByEmail: Map<string, Row>;
  filter: 'pending' | 'approved' | 'rejected' | 'all';
  setFilter: (f: 'pending' | 'approved' | 'rejected' | 'all') => void;
  search: string;
  setSearch: (s: string) => void;
  decidingId: string | null;
  deletingId: string | null;
  onDecide: (id: string, status: 'approved' | 'rejected', emailKey: string) => void;
  onEdit: (row: EmployeeGiftShippingRow, emailKey: string) => void;
  onDelete: (row: EmployeeGiftShippingRow, emailKey: string) => void;
}) {
  // Flatten every employee's submissions into one array, annotated with the
  // employee display name + department for quick filtering.
  const all = useMemo(() => {
    const out: {
      sub: EmployeeGiftShippingRow;
      emailKey: string;
      name: string;
      department: string | null;
    }[] = [];
    for (const [emailKey, subs] of shippingByEmail) {
      const ref = rowsByEmail.get(emailKey);
      const name = ref?.name ?? emailKey;
      const department = ref?.department ?? null;
      for (const sub of subs) out.push({ sub, emailKey, name, department });
    }
    // Pending first, then by updated_at desc within each bucket.
    const rank = (s: EmployeeGiftShippingRow['status']) =>
      s === 'pending' ? 0 : s === 'rejected' ? 1 : 2;
    return out.sort((a, b) => {
      const r = rank(a.sub.status) - rank(b.sub.status);
      if (r !== 0) return r;
      return b.sub.updated_at.localeCompare(a.sub.updated_at);
    });
  }, [shippingByEmail, rowsByEmail]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return all.filter((item) => {
      if (filter !== 'all' && item.sub.status !== filter) return false;
      if (!needle) return true;
      return [
        item.name,
        item.emailKey,
        item.department ?? '',
        item.sub.preferred_delivery_location,
        item.sub.active_contact_number,
        item.sub.notes,
      ]
        .join(' ')
        .toLowerCase()
        .includes(needle);
    });
  }, [all, filter, search]);

  const counts = useMemo(() => {
    const c = { pending: 0, approved: 0, rejected: 0, all: all.length };
    for (const item of all) c[item.sub.status] += 1;
    return c;
  }, [all]);

  const filters: { key: typeof filter; label: string; count: number; tone: string }[] = [
    { key: 'pending',  label: 'Pending',  count: counts.pending,  tone: 'amber' },
    { key: 'approved', label: 'Approved', count: counts.approved, tone: 'emerald' },
    { key: 'rejected', label: 'Rejected', count: counts.rejected, tone: 'rose' },
    { key: 'all',      label: 'All',      count: counts.all,      tone: 'pink' },
  ];

  return (
    <div className="flex flex-col gap-4">
      {/* Filter pills + search */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {filters.map((f) => {
            const active = filter === f.key;
            const toneActive: Record<string, string> = {
              amber: 'border-amber-500/40 bg-amber-500/15 text-amber-800 dark:text-amber-200',
              emerald: 'border-emerald-500/40 bg-emerald-500/15 text-emerald-800 dark:text-emerald-200',
              rose: 'border-rose-500/40 bg-rose-500/15 text-rose-800 dark:text-rose-200',
              pink: 'border-emerald-500/40 bg-emerald-500/15 text-emerald-800 dark:text-emerald-200',
            };
            return (
              <button
                key={f.key}
                type="button"
                onClick={() => setFilter(f.key)}
                className={cn(
                  'flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                  active
                    ? toneActive[f.tone]
                    : 'border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800/60',
                )}
              >
                {f.label}
                <span
                  className={cn(
                    'rounded-full px-1.5 py-0.5 text-[10px] font-bold leading-none',
                    active ? 'bg-white/70 text-zinc-700 dark:bg-zinc-900/60 dark:text-zinc-100' : 'bg-zinc-200 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-400',
                  )}
                >
                  {f.count}
                </span>
              </button>
            );
          })}
        </div>
        <div className="relative w-full max-w-sm">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, email, address…"
            className="h-9 pl-8 text-sm"
          />
        </div>
      </div>

      {/* List */}
      <Card className="overflow-hidden ring-1 ring-emerald-200/60 dark:ring-emerald-900/40">
        <CardContent className="p-0">
          {filtered.length === 0 ? (
            <p className="px-6 py-14 text-center text-sm text-zinc-500 dark:text-zinc-400">
              {all.length === 0
                ? 'No submissions yet. Employees fill these out 30 days before each milestone.'
                : `No ${filter === 'all' ? '' : filter} submissions match your search.`}
            </p>
          ) : (
            <ul className="divide-y divide-emerald-100/70 dark:divide-emerald-900/35">
              {filtered.map(({ sub, emailKey, name, department }) => {
                const isDeciding = decidingId === sub.id;
                const isDeleting = deletingId === sub.id;
                const isLocked = sub.status === 'approved';
                return (
                  <li key={sub.id} className="grid gap-3 px-4 py-4 sm:grid-cols-[minmax(0,1.1fr)_minmax(0,1.4fr)_minmax(0,auto)] sm:items-start">
                    {/* Employee + milestone */}
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-semibold text-zinc-900 dark:text-zinc-100">{name}</span>
                        {sub.status === 'approved' ? (
                          <Badge className="border-emerald-500/30 bg-emerald-500/10 text-[10px] text-emerald-700 dark:text-emerald-300">
                            <Lock className="mr-1 h-2.5 w-2.5" /> Approved
                          </Badge>
                        ) : sub.status === 'rejected' ? (
                          <Badge className="border-rose-500/30 bg-rose-500/10 text-[10px] text-rose-700 dark:text-rose-300">
                            Rejected
                          </Badge>
                        ) : (
                          <Badge className="border-amber-500/30 bg-amber-500/10 text-[10px] text-amber-700 dark:text-amber-300">
                            Pending
                          </Badge>
                        )}
                      </div>
                      <div className="mt-0.5 font-mono text-[11px] text-zinc-500 dark:text-zinc-400 break-all">{emailKey}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px]">
                        <span className="rounded-full bg-emerald-600/10 px-2 py-0.5 font-semibold text-emerald-700 dark:text-emerald-300">
                          {sub.milestone_index * 6}-month gift · #{sub.milestone_index}
                        </span>
                        <span className="text-zinc-500 dark:text-zinc-400">
                          {new Date(sub.milestone_date).toLocaleDateString(undefined, {
                            year: 'numeric',
                            month: 'short',
                            day: 'numeric',
                          })}
                        </span>
                        {department && (
                          <span className="text-emerald-600/80 dark:text-emerald-400/80">{department}</span>
                        )}
                      </div>
                      <div className="mt-1 text-[10.5px] text-zinc-400 dark:text-zinc-500">
                        Submitted {new Date(sub.created_at).toLocaleDateString(undefined, { dateStyle: 'medium' })}
                        {sub.updated_at !== sub.created_at && (
                          <> · last edited {new Date(sub.updated_at).toLocaleDateString(undefined, { dateStyle: 'medium' })}</>
                        )}
                      </div>
                    </div>

                    {/* Shipping payload */}
                    <div className="min-w-0 rounded-lg border border-emerald-100 bg-emerald-50/40 px-3 py-2 text-xs dark:border-emerald-900/40 dark:bg-emerald-950/15">
                      <div className="grid gap-1">
                        <div>
                          <span className="font-semibold text-zinc-700 dark:text-zinc-300">Address:</span>{' '}
                          <span className="text-zinc-700 dark:text-zinc-300">
                            {sub.preferred_delivery_location || <span className="italic text-zinc-400">—</span>}
                          </span>
                        </div>
                        <div>
                          <span className="font-semibold text-zinc-700 dark:text-zinc-300">Phone:</span>{' '}
                          <span className="text-zinc-700 dark:text-zinc-300">
                            {sub.active_contact_number || <span className="italic text-zinc-400">—</span>}
                          </span>
                        </div>
                        {sub.notes && (
                          <div>
                            <span className="font-semibold text-zinc-700 dark:text-zinc-300">Notes:</span>{' '}
                            <span className="text-zinc-600 dark:text-zinc-400">{sub.notes}</span>
                          </div>
                        )}
                        {sub.decision_note && (
                          <div className="mt-0.5 italic text-zinc-500 dark:text-zinc-500">
                            Reviewer note: {sub.decision_note}
                          </div>
                        )}
                        {sub.status === 'approved' && sub.gift_name && (
                          <div className="mt-1 inline-flex items-center gap-1.5 rounded-md border border-emerald-300/60 bg-emerald-50/80 px-2 py-1 text-[11px] font-semibold text-emerald-800 dark:border-emerald-800/50 dark:bg-emerald-950/30 dark:text-emerald-200">
                            <Tag className="h-3 w-3" />
                            {sub.gift_name}
                            {sub.gift_price_php != null && (
                              <span className="font-mono tabular-nums">
                                · ₱{sub.gift_price_php.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                              </span>
                            )}
                          </div>
                        )}
                        {sub.status === 'approved' && sub.decided_at && (
                          <div className="mt-0.5 text-[10.5px] text-emerald-700/80 dark:text-emerald-300/80">
                            Approved {new Date(sub.decided_at).toLocaleDateString(undefined, { dateStyle: 'medium' })}
                            {sub.decided_by && <> by {sub.decided_by}</>}
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="flex shrink-0 flex-col items-end gap-1.5">
                      {!isLocked ? (
                        <>
                          <div className="flex flex-wrap justify-end gap-1.5">
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-8 border-amber-300 text-amber-700 hover:bg-amber-50 dark:border-amber-900/50 dark:text-amber-300 dark:hover:bg-amber-950/30"
                              disabled={isDeciding || isDeleting}
                              onClick={() => onDecide(sub.id, 'rejected', emailKey)}
                            >
                              {isDeciding ? (
                                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                              ) : (
                                <Undo2 className="mr-1 h-3 w-3" />
                              )}
                              Return to employee
                            </Button>
                            <Button
                              size="sm"
                              className="h-8 bg-emerald-600 text-white hover:bg-emerald-700"
                              disabled={isDeciding || isDeleting}
                              onClick={() => onDecide(sub.id, 'approved', emailKey)}
                            >
                              {isDeciding ? (
                                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                              ) : (
                                <CheckCircle2 className="mr-1 h-3 w-3" />
                              )}
                              Approve &amp; lock
                            </Button>
                          </div>
                        </>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-[11px] text-emerald-700 dark:text-emerald-300">
                          <Lock className="h-3 w-3" /> Locked
                        </span>
                      )}
                      {/* Edit / Delete / Apply-gift — available regardless of status. */}
                      <div className="flex flex-wrap justify-end gap-1.5">
                        {isLocked && !sub.gift_name && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 border-emerald-300 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-900/50 dark:text-emerald-300 dark:hover:bg-emerald-950/30"
                            disabled={isDeciding || isDeleting}
                            onClick={() => onDecide(sub.id, 'approved', emailKey)}
                          >
                            {isDeciding ? (
                              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                            ) : (
                              <Tag className="mr-1 h-3 w-3" />
                            )}
                            Apply gift
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 border-zinc-300 text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
                          disabled={isDeciding || isDeleting}
                          onClick={() => onEdit(sub, emailKey)}
                        >
                          <Pencil className="mr-1 h-3 w-3" />
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 border-rose-300 text-rose-700 hover:bg-rose-50 dark:border-rose-900/50 dark:text-rose-300 dark:hover:bg-rose-950/30"
                          disabled={isDeciding || isDeleting}
                          onClick={() => onDelete(sub, emailKey)}
                        >
                          {isDeleting ? (
                            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                          ) : (
                            <Trash2 className="mr-1 h-3 w-3" />
                          )}
                          Delete
                        </Button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

