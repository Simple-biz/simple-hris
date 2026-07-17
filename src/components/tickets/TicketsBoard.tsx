'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MeasuringStrategy,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Archive, ArrowLeft, Eye, Menu, Plus, RefreshCw, Search, SquareKanban } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { cn } from '@/lib/utils';
import {
  TICKET_BOARD_MOVERS,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  TICKET_STATUS_LABELS,
  type TicketMember,
  type TicketPriority,
  type TicketRow,
  type TicketStatus,
} from '@/lib/tickets/types';
import { PRIORITY_STYLES, STATUS_STYLES, TicketCard, initialsFor, relativeTime } from './TicketCard';
import TicketDialog, { type TicketDraft } from './TicketDialog';
import TicketsOverview from './TicketsOverview';
import TicketsSidebar, { type TicketsView } from './TicketsSidebar';

const byPosition = (a: TicketRow, b: TicketRow) =>
  a.position - b.position || a.created_at.localeCompare(b.created_at);

const columnDroppableId = (status: TicketStatus) => `column:${status}`;

/** Midpoint between the sorted neighbors at `index` in `list` (active card
 *  excluded by the caller) — fractional indexing, no mass renumbering. */
function positionBetween(before: number | undefined, after: number | undefined): number {
  if (before === undefined && after === undefined) return 0;
  if (before === undefined) return (after as number) - 1;
  if (after === undefined) return before + 1;
  return (before + after) / 2;
}

interface BoardData {
  tickets: TicketRow[];
  access: 'view' | 'edit';
  viewer: string;
  isAdmin: boolean;
}

export default function TicketsBoard() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const reduceMotion = useReducedMotion();
  const [tickets, setTickets] = useState<TicketRow[]>([]);
  const [access, setAccess] = useState<'view' | 'edit'>('view');
  const [viewer, setViewer] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // Optimistic until the Realtime channel reports otherwise; 'degraded' means
  // the websocket is down and the 30s poll / focus refresh are carrying us.
  const [liveStatus, setLiveStatus] = useState<'live' | 'degraded'>('live');
  // Below `md` the sidebar is a drawer toggled by the header hamburger.
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  // Which tickets surface is showing: the Kanban board or the stats Overview.
  // Overview is the default landing view on load/refresh.
  const [activeView, setActiveView] = useState<TicketsView>('overview');

  const [search, setSearch] = useState('');
  const [priorityFilter, setPriorityFilter] = useState<'all' | TicketPriority>('all');

  const [activeTicket, setActiveTicket] = useState<TicketRow | null>(null);
  const [overColumn, setOverColumn] = useState<TicketStatus | null>(null);
  const draggingRef = useRef(false);
  const snapshotRef = useRef<TicketRow[] | null>(null);
  // Browsers fire a click on the source card right after a drop; without this
  // guard every drag would end by popping the details dialog open.
  const justDroppedRef = useRef(false);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogTicket, setDialogTicket] = useState<TicketRow | null>(null);
  const [saving, setSaving] = useState(false);

  // ── Data ────────────────────────────────────────────────────────────────────
  const fetchBoard = useCallback(async () => {
    // Never clobber an in-flight drag with a refetch — the poll retries in 30s
    // and our own PATCH triggers a realtime refresh right after the drop anyway.
    if (draggingRef.current) return;
    setRefreshing(true);
    try {
      const res = await fetch('/api/tickets', { cache: 'no-store' });
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(j?.error ?? `Request failed (${res.status})`);
      }
      const j = (await res.json()) as BoardData;
      if (draggingRef.current) return;
      setTickets(j.tickets ?? []);
      setAccess(j.access ?? 'view');
      setViewer(j.viewer ?? '');
      setIsAdmin(Boolean(j.isAdmin));
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not load the board');
    } finally {
      setLoaded(true);
      setRefreshing(false);
    }
  }, []);

  // Board members — powers the assignee pickers (dialog + admin), the card's
  // "assigned developer" label, and the Overview Members rail. Grants change
  // rarely; one fetch per mount plus the header refresh button is enough.
  const [members, setMembers] = useState<TicketMember[] | null>(null);
  const [membersError, setMembersError] = useState<string | null>(null);
  const fetchMembers = useCallback(async () => {
    try {
      const res = await fetch('/api/tickets/members', { cache: 'no-store' });
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(j?.error ?? `Request failed (${res.status})`);
      }
      const j = (await res.json()) as { members?: TicketMember[] };
      setMembers(j.members ?? []);
      setMembersError(null);
    } catch (e) {
      setMembers((prev) => prev ?? []);
      setMembersError(e instanceof Error ? e.message : 'Could not load members');
    }
  }, []);

  // The Archived view's list — fetched lazily when the view opens, refreshed
  // alongside the board so a restore/archive elsewhere shows up live.
  const [archivedTickets, setArchivedTickets] = useState<TicketRow[]>([]);
  const [archivedLoaded, setArchivedLoaded] = useState(false);
  const fetchArchived = useCallback(async () => {
    try {
      const res = await fetch('/api/tickets?archived=1', { cache: 'no-store' });
      if (!res.ok) return;
      const j = (await res.json()) as { tickets?: TicketRow[] };
      setArchivedTickets(j.tickets ?? []);
      setArchivedLoaded(true);
    } catch {
      // Best-effort; the view shows a retry via the header refresh button.
    }
  }, []);

  useEffect(() => {
    void fetchBoard();
    void fetchMembers();
  }, [fetchBoard, fetchMembers]);

  useEffect(() => {
    if (activeView === 'archived') void fetchArchived();
  }, [activeView, fetchArchived]);

  useLiveRefresh({
    tables: ['tickets', 'ticket_comments'],
    channel: 'tickets-board',
    onRefresh: () => {
      void fetchBoard();
      // useLiveRefresh always runs the latest closure, so this sees the
      // current view; the archive list only refetches while it's on screen.
      if (activeView === 'archived') void fetchArchived();
    },
    enabled: loaded,
    onStatusChange: setLiveStatus,
  });

  // Deep link: /tickets?ticket=<id> (from a "View & reply" notification)
  // auto-opens that ticket's details + Updates thread once the board loads.
  const deepLinkedRef = useRef(false);
  useEffect(() => {
    if (!loaded || deepLinkedRef.current) return;
    deepLinkedRef.current = true;
    const id = searchParams?.get('ticket');
    if (!id) return;
    const target = tickets.find((t) => t.id === id);
    if (target) {
      setDialogTicket(target);
      setDialogOpen(true);
    } else {
      toast.error('That ticket is no longer on the board.');
    }
  }, [loaded, searchParams, tickets]);

  const canEdit = access === 'edit';
  // Moving cards: the board movers allowlist can move anything; a ticket's
  // assigned developer can move THAT ticket (the API enforces the same rule).
  // Everyone else creates tickets and replies.
  const isMover = (TICKET_BOARD_MOVERS as readonly string[]).includes(viewer.toLowerCase());
  const canMoveTicket = useCallback(
    (t: TicketRow) =>
      isMover || (!!t.assigned_to && t.assigned_to.toLowerCase() === viewer.toLowerCase()),
    [isMover, viewer],
  );

  // email → display name for the cards' "assigned developer" label. Emails are
  // normalized lowercase on both sides (the API lowers assigned_to on write,
  // members come back canonical).
  const memberNameByEmail = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const m of members ?? []) map.set(m.email, m.name);
    return map;
  }, [members]);
  const assigneeNameFor = useCallback(
    (t: TicketRow) => (t.assigned_to ? (memberNameByEmail.get(t.assigned_to) ?? null) : null),
    [memberNameByEmail],
  );
  const filtersActive = search.trim() !== '' || priorityFilter !== 'all';
  // Dragging a filtered subset would compute positions against hidden
  // neighbors, so sorting pauses while a filter narrows the board. Whether a
  // GIVEN card can then be picked up is canMoveTicket, per card.
  const dragActive = canEdit && !filtersActive;
  // Does this viewer move anything at all? (drives the filters-pause banner)
  const viewerMovesSomething =
    isMover || tickets.some((t) => (t.assigned_to ?? '').toLowerCase() === viewer.toLowerCase());

  // ── Derived columns ─────────────────────────────────────────────────────────
  const columns = useMemo(() => {
    const q = search.trim().toLowerCase();
    const visible = tickets.filter((t) => {
      if (priorityFilter !== 'all' && t.priority !== priorityFilter) return false;
      if (!q) return true;
      return (
        t.title.toLowerCase().includes(q) ||
        (t.description ?? '').toLowerCase().includes(q) ||
        `#${t.ticket_no}`.includes(q) ||
        t.created_by.toLowerCase().includes(q) ||
        (t.created_by_name ?? '').toLowerCase().includes(q)
      );
    });
    const map = Object.fromEntries(TICKET_STATUSES.map((s) => [s, [] as TicketRow[]])) as Record<
      TicketStatus,
      TicketRow[]
    >;
    for (const t of [...visible].sort(byPosition)) map[t.status]?.push(t);
    return map;
  }, [tickets, search, priorityFilter]);

  const columnOf = useCallback(
    (id: string): TicketStatus | null => {
      if (id.startsWith('column:')) return id.slice('column:'.length) as TicketStatus;
      return tickets.find((t) => t.id === id)?.status ?? null;
    },
    [tickets],
  );

  // ── Mutations (optimistic, revert by refetch) ───────────────────────────────
  const patchTicket = useCallback(
    async (id: string, patch: Partial<TicketRow>): Promise<boolean> => {
      const res = await fetch(`/api/tickets/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { error?: string } | null;
        toast.error(j?.error ?? 'Could not update the ticket');
        void fetchBoard();
        return false;
      }
      const j = (await res.json()) as { ticket: TicketRow };
      // Single-row writes don't carry the comment aggregate — keep the count.
      setTickets((prev) =>
        prev.map((t) => (t.id === id ? { ...j.ticket, comment_count: t.comment_count } : t)),
      );
      return true;
    },
    [fetchBoard],
  );

  const createTicket = useCallback(async (draft: TicketDraft): Promise<boolean> => {
    setSaving(true);
    try {
      const res = await fetch('/api/tickets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: draft.title,
          description: draft.description,
          priority: draft.priority,
          assigned_to: draft.assigned_to || null,
        }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { error?: string } | null;
        toast.error(j?.error ?? 'Could not create the ticket');
        return false;
      }
      const j = (await res.json()) as { ticket: TicketRow };
      setTickets((prev) => [{ ...j.ticket, comment_count: 0 }, ...prev]);
      toast.success(`Ticket #${j.ticket.ticket_no} created`);
      return true;
    } finally {
      setSaving(false);
    }
  }, []);

  const saveTicket = useCallback(
    async (id: string, draft: TicketDraft): Promise<boolean> => {
      setSaving(true);
      try {
        return await patchTicket(id, {
          title: draft.title,
          description: draft.description,
          priority: draft.priority,
          status: draft.status,
          assigned_to: draft.assigned_to || null,
        });
      } finally {
        setSaving(false);
      }
    },
    [patchTicket],
  );

  // Archive = soft delete: the ticket leaves the board but keeps its history
  // and Updates thread, and stays restorable from the Archived view.
  const archiveTicket = useCallback(
    async (id: string): Promise<boolean> => {
      setSaving(true);
      try {
        const res = await fetch(`/api/tickets/${id}`, { method: 'DELETE' });
        if (!res.ok) {
          const j = (await res.json().catch(() => null)) as { error?: string } | null;
          toast.error(j?.error ?? 'Could not archive the ticket');
          return false;
        }
        setTickets((prev) => prev.filter((t) => t.id !== id));
        toast.success('Ticket archived');
        void fetchArchived();
        return true;
      } finally {
        setSaving(false);
      }
    },
    [fetchArchived],
  );

  const restoreTicket = useCallback(
    async (id: string): Promise<boolean> => {
      setSaving(true);
      try {
        const res = await fetch(`/api/tickets/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ archived: false }),
        });
        if (!res.ok) {
          const j = (await res.json().catch(() => null)) as { error?: string } | null;
          toast.error(j?.error ?? 'Could not restore the ticket');
          return false;
        }
        setArchivedTickets((prev) => prev.filter((t) => t.id !== id));
        toast.success('Ticket restored to the board');
        void fetchBoard();
        return true;
      } finally {
        setSaving(false);
      }
    },
    [fetchBoard],
  );

  // ── Drag and drop ───────────────────────────────────────────────────────────
  const sensors = useSensors(
    // 5px of travel before a drag starts, so plain clicks still open the card.
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const onDragStart = (event: DragStartEvent) => {
    const t = tickets.find((x) => x.id === event.active.id);
    if (!t) return;
    draggingRef.current = true;
    snapshotRef.current = tickets;
    setActiveTicket(t);
    setOverColumn(t.status);
  };

  const onDragOver = (event: DragOverEvent) => {
    const overId = event.over?.id as string | undefined;
    if (!overId) return;
    const activeId = event.active.id as string;
    const from = columnOf(activeId);
    const to = columnOf(overId);
    if (!to) return;
    setOverColumn(to);
    if (!from || from === to) return;
    // Cross-column hover: move the card into the hovered column immediately so
    // the board reflows under the pointer instead of waiting for the drop.
    setTickets((prev) => {
      const overTicket = prev.find((t) => t.id === overId);
      const target = prev.filter((t) => t.status === to && t.id !== activeId).sort(byPosition);
      const transient = overTicket
        ? overTicket.position - 0.5
        : (target[target.length - 1]?.position ?? 0) + 1;
      return prev.map((t) => (t.id === activeId ? { ...t, status: to, position: transient } : t));
    });
  };

  const finishDrag = () => {
    draggingRef.current = false;
    snapshotRef.current = null;
    setActiveTicket(null);
    setOverColumn(null);
    justDroppedRef.current = true;
    window.setTimeout(() => {
      justDroppedRef.current = false;
    }, 150);
  };

  const onDragCancel = () => {
    if (snapshotRef.current) setTickets(snapshotRef.current);
    finishDrag();
  };

  const onDragEnd = (event: DragEndEvent) => {
    const activeId = event.active.id as string;
    const overId = event.over?.id as string | undefined;
    const started = snapshotRef.current ?? tickets;
    const startedTicket = started.find((t) => t.id === activeId);
    const current = tickets.find((t) => t.id === activeId);

    if (!overId || !current || !startedTicket) {
      onDragCancel();
      return;
    }

    const status = current.status; // onDragOver already parked it in the target column
    let column = tickets.filter((t) => t.status === status).sort(byPosition);

    // Same-column reorder lands on a card: replay the visual arrayMove.
    if (!overId.startsWith('column:') && overId !== activeId) {
      const overIndex = column.findIndex((t) => t.id === overId);
      const activeIndex = column.findIndex((t) => t.id === activeId);
      if (overIndex >= 0 && activeIndex >= 0) column = arrayMove(column, activeIndex, overIndex);
    }

    const index = column.findIndex((t) => t.id === activeId);
    const position = positionBetween(column[index - 1]?.position, column[index + 1]?.position);
    const moved = startedTicket.status !== status;
    const reordered = position !== startedTicket.position;

    setTickets((prev) => prev.map((t) => (t.id === activeId ? { ...t, status, position } : t)));
    finishDrag();

    if (moved || reordered) {
      void patchTicket(activeId, { status, position });
    }
  };

  const openTicket = (t: TicketRow) => {
    if (draggingRef.current || justDroppedRef.current) return;
    setDialogTicket(t);
    setDialogOpen(true);
  };

  const canArchiveDialogTicket =
    dialogTicket !== null &&
    canEdit &&
    (isAdmin || dialogTicket.created_by.toLowerCase() === viewer.toLowerCase());

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    // `dark` is forced here (and on every portaled surface below): /tickets is a
    // fixed black + red console in both global themes, so shared components
    // always render their dark variants while tickets-theme recolors the tokens.
    <div className="tickets-theme dark flex h-screen bg-background text-foreground">
      {/* Mobile drawer backdrop — tap to close */}
      {mobileNavOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 md:hidden"
          aria-label="Close navigation menu"
          onClick={() => setMobileNavOpen(false)}
        />
      )}

      <TicketsSidebar
        mobileOpen={mobileNavOpen}
        viewerEmail={viewer || null}
        active={activeView}
        onNavigate={(v) => {
          setActiveView(v);
          setMobileNavOpen(false);
        }}
      />

      <div className="flex h-full min-w-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-3 sm:px-6">
        <div className="flex items-center gap-2.5">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Open navigation menu"
            title="Menu"
            className="md:hidden"
            onClick={() => setMobileNavOpen(true)}
          >
            <Menu />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Back to dashboard"
            title="Back to dashboard"
            className="hidden md:inline-flex"
            onClick={() => router.push('/')}
          >
            <ArrowLeft />
          </Button>
          <span className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <SquareKanban className="size-4.5" />
          </span>
          <div className="leading-tight">
            <h1 className="text-[15px] font-semibold">HRIS Updates</h1>
            <p className="text-xs text-muted-foreground">
              {activeView === 'overview'
                ? 'Overview'
                : activeView === 'archived'
                  ? 'Archive'
                  : 'Request board'}{' '}
              · {tickets.length} ticket{tickets.length === 1 ? '' : 's'}
            </p>
          </div>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {loaded && !loadError && (
            <span
              className="mr-1 hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex"
              title={
                liveStatus === 'live'
                  ? 'Connected to Supabase Realtime — changes appear instantly'
                  : 'Realtime connection lost — auto-refreshing every 30s'
              }
            >
              <span className="relative flex size-2" aria-hidden>
                {liveStatus === 'live' && (
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-60 motion-reduce:animate-none" />
                )}
                <span
                  className={cn(
                    'relative inline-flex size-2 rounded-full',
                    liveStatus === 'live' ? 'bg-red-500' : 'bg-amber-500',
                  )}
                />
              </span>
              {liveStatus === 'live' ? 'Live' : 'Auto-refresh'}
            </span>
          )}
          <Button
            variant="outline"
            size="icon"
            aria-label="Refresh board"
            title="Refresh board"
            disabled={!loaded}
            onClick={() => {
              void fetchBoard();
              void fetchMembers();
              if (activeView === 'archived') void fetchArchived();
            }}
          >
            <RefreshCw className={cn(refreshing && 'animate-spin')} />
          </Button>
          {loaded && !canEdit && (
            <span className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-border px-2.5 text-xs font-medium text-muted-foreground">
              <Eye className="size-3.5" />
              View only
            </span>
          )}
          {activeView === 'board' && (
          <>
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search tickets…"
              className="h-8 w-44 pl-8 sm:w-56"
              aria-label="Search tickets"
            />
          </div>
          <Select
            value={priorityFilter}
            onValueChange={(v) => v && setPriorityFilter(v as 'all' | TicketPriority)}
          >
            <SelectTrigger aria-label="Filter by priority">
              {/* Base UI renders the raw value ('all', 'high') without children. */}
              <SelectValue>
                {priorityFilter === 'all' ? (
                  'All priorities'
                ) : (
                  <>
                    <span
                      className={cn('size-2 rounded-full', PRIORITY_STYLES[priorityFilter].dot)}
                      aria-hidden
                    />
                    {PRIORITY_STYLES[priorityFilter].label}
                  </>
                )}
              </SelectValue>
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false} className="tickets-theme dark">
              <SelectItem value="all">All priorities</SelectItem>
              {TICKET_PRIORITIES.map((p) => (
                <SelectItem key={p} value={p}>
                  <span className={cn('size-2 rounded-full', PRIORITY_STYLES[p].dot)} aria-hidden />
                  {PRIORITY_STYLES[p].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          </>
          )}
          {canEdit && (
            <Button
              onClick={() => {
                setDialogTicket(null);
                setDialogOpen(true);
              }}
            >
              <Plus data-icon="inline-start" />
              New ticket
            </Button>
          )}
        </div>
      </header>

      {activeView === 'board' && canEdit && viewerMovesSomething && filtersActive && (
        <p className="border-b border-border bg-muted/40 px-4 py-1.5 text-xs text-muted-foreground sm:px-6">
          Drag-to-move is paused while a search or filter is narrowing the board.
        </p>
      )}

      {/* View swap: quick fade + drift on one exponential ease. `mode="wait"`
          lets the leaving surface clear before the next one lands; distances
          collapse under prefers-reduced-motion. */}
      <AnimatePresence mode="wait" initial={false}>
      {activeView === 'overview' ? (
        <motion.main
          key="overview"
          initial={{ opacity: 0, y: reduceMotion ? 0 : 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: reduceMotion ? 0 : -6 }}
          transition={{ duration: reduceMotion ? 0 : 0.2, ease: [0.22, 1, 0.36, 1] }}
          className="min-h-0 flex-1 overflow-y-auto"
        >
          <TicketsOverview
            tickets={tickets}
            loaded={loaded}
            onOpenTicket={openTicket}
            members={members}
            membersError={membersError}
          />
        </motion.main>
      ) : activeView === 'archived' ? (
        <motion.main
          key="archived"
          initial={{ opacity: 0, y: reduceMotion ? 0 : 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: reduceMotion ? 0 : -6 }}
          transition={{ duration: reduceMotion ? 0 : 0.2, ease: [0.22, 1, 0.36, 1] }}
          className="min-h-0 flex-1 overflow-y-auto"
        >
          <ArchivedPanel tickets={archivedTickets} loaded={archivedLoaded} onOpen={openTicket} />
        </motion.main>
      ) : (
      <motion.main
        key="board"
        initial={{ opacity: 0, y: reduceMotion ? 0 : 10 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: reduceMotion ? 0 : -6 }}
        transition={{ duration: reduceMotion ? 0 : 0.2, ease: [0.22, 1, 0.36, 1] }}
        className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden"
      >
        {!loaded ? (
          <BoardSkeleton />
        ) : loadError && tickets.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
            <p className="text-sm text-muted-foreground">{loadError}</p>
            <Button variant="outline" onClick={() => void fetchBoard()}>
              <RefreshCw data-icon="inline-start" />
              Try again
            </Button>
          </div>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCorners}
            measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
            onDragStart={onDragStart}
            onDragOver={onDragOver}
            onDragEnd={onDragEnd}
            onDragCancel={onDragCancel}
          >
            <div className="flex h-full min-w-max gap-3 p-4 sm:min-w-0 sm:p-6 sm:pt-4">
              {TICKET_STATUSES.map((status) => (
                <BoardColumn
                  key={status}
                  status={status}
                  tickets={columns[status]}
                  dragActive={dragActive}
                  canMoveTicket={canMoveTicket}
                  highlighted={activeTicket !== null && overColumn === status}
                  activeId={activeTicket?.id ?? null}
                  onOpen={openTicket}
                  assigneeNameFor={assigneeNameFor}
                />
              ))}
            </div>
            <DragOverlay
              dropAnimation={{ duration: 220, easing: 'cubic-bezier(0.2, 0, 0, 1)' }}
            >
              {activeTicket ? (
                <TicketCard
                  ticket={activeTicket}
                  overlay
                  assigneeName={assigneeNameFor(activeTicket)}
                  className="w-72"
                />
              ) : null}
            </DragOverlay>
          </DndContext>
        )}
      </motion.main>
      )}
      </AnimatePresence>
      </div>

      <TicketDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        ticket={dialogTicket}
        canEdit={canEdit}
        canMove={dialogTicket ? canMoveTicket(dialogTicket) : isMover}
        viewerEmail={viewer.toLowerCase()}
        canArchive={canArchiveDialogTicket}
        saving={saving}
        members={members}
        onCreate={createTicket}
        onSave={saveTicket}
        onArchive={archiveTicket}
        onRestore={restoreTicket}
      />
    </div>
  );
}

// ── Column ────────────────────────────────────────────────────────────────────

function BoardColumn({
  status,
  tickets,
  dragActive,
  canMoveTicket,
  highlighted,
  activeId,
  onOpen,
  assigneeNameFor,
}: {
  status: TicketStatus;
  tickets: TicketRow[];
  /** Board-wide drag preconditions (edit access, no filters). */
  dragActive: boolean;
  /** Per-card rule: board mover, or that ticket's assigned developer. */
  canMoveTicket: (t: TicketRow) => boolean;
  highlighted: boolean;
  activeId: string | null;
  onOpen: (t: TicketRow) => void;
  assigneeNameFor: (t: TicketRow) => string | null;
}) {
  const { setNodeRef } = useDroppable({ id: columnDroppableId(status) });
  const style = STATUS_STYLES[status];

  return (
    <section
      ref={setNodeRef}
      aria-label={`${TICKET_STATUS_LABELS[status]} column, ${tickets.length} tickets`}
      className={cn(
        'flex h-full w-72 shrink-0 flex-col rounded-xl bg-muted/30 sm:w-auto sm:min-w-56 sm:flex-1',
        'transition-[box-shadow,background-color] duration-150 motion-reduce:transition-none',
        highlighted && 'bg-red-500/[0.07] ring-1 ring-red-500/40',
      )}
    >
      <header className="flex items-center gap-2 px-3 pt-3 pb-2">
        <span className={cn('size-2 rounded-full', style.dot)} aria-hidden />
        <h2 className="text-[13px] font-semibold">{style.label}</h2>
        <span className="ml-auto rounded-full bg-background px-1.5 py-px font-mono text-[11px] text-muted-foreground tabular-nums dark:bg-muted">
          {tickets.length}
        </span>
      </header>

      <SortableContext
        items={tickets.map((t) => t.id)}
        strategy={verticalListSortingStrategy}
        disabled={!dragActive}
      >
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
          {tickets.length === 0 ? (
            <div className="mx-1 mt-1 flex h-20 items-center justify-center rounded-lg border border-dashed border-border text-xs text-muted-foreground">
              {status === 'todo' ? 'New requests land here' : 'No tickets'}
            </div>
          ) : (
            tickets.map((t) => (
              <SortableTicketCard
                key={t.id}
                ticket={t}
                dragEnabled={dragActive && canMoveTicket(t)}
                ghosted={t.id === activeId}
                onOpen={onOpen}
                assigneeName={assigneeNameFor(t)}
              />
            ))
          )}
        </div>
      </SortableContext>
    </section>
  );
}

// ── Sortable card wrapper ─────────────────────────────────────────────────────

function SortableTicketCard({
  ticket,
  dragEnabled,
  ghosted,
  onOpen,
  assigneeName,
}: {
  ticket: TicketRow;
  dragEnabled: boolean;
  ghosted: boolean;
  onOpen: (t: TicketRow) => void;
  assigneeName: string | null;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: ticket.id,
    disabled: !dragEnabled,
  });

  return (
    <TicketCard
      ref={setNodeRef}
      ticket={ticket}
      canDrag={dragEnabled}
      ghosted={ghosted || isDragging}
      assigneeName={assigneeName}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      onClick={() => onOpen(ticket)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen(ticket);
      }}
      {...attributes}
      {...listeners}
    />
  );
}

// ── Archived view ─────────────────────────────────────────────────────────────

/** Flat list of archived tickets. Rows open the same details dialog in its
 *  frozen (archived) state, where the creator or an admin can restore. */
function ArchivedPanel({
  tickets,
  loaded,
  onOpen,
}: {
  tickets: TicketRow[];
  loaded: boolean;
  onOpen: (t: TicketRow) => void;
}) {
  if (!loaded) {
    return (
      <div className="mx-auto grid w-full max-w-3xl gap-2 p-4 sm:p-6">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full rounded-lg" />
        ))}
      </div>
    );
  }
  if (tickets.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <Archive className="size-6 text-muted-foreground/60" aria-hidden />
        <p className="text-sm text-muted-foreground">
          Nothing archived yet — archiving a ticket parks it here instead of deleting it.
        </p>
      </div>
    );
  }
  return (
    <div className="mx-auto grid w-full max-w-3xl gap-2 p-4 sm:p-6">
      {tickets.map((t) => {
        const prio = PRIORITY_STYLES[t.priority] ?? PRIORITY_STYLES.medium;
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => onOpen(t)}
            className={cn(
              'group flex w-full items-center gap-3 rounded-lg border border-border bg-card p-3 text-left outline-none',
              'transition-[border-color,transform] duration-150 ease-out motion-reduce:transition-none',
              'hover:border-red-500/45 focus-visible:ring-2 focus-visible:ring-ring/60',
            )}
          >
            <span
              className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-muted-foreground"
              aria-hidden
            >
              {initialsFor(t.created_by_name, t.created_by)}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">
                <span className="font-mono text-[11px] text-muted-foreground">#{t.ticket_no}</span>
                <span className="truncate text-sm font-medium">{t.title}</span>
                <span
                  className={cn(
                    'inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-2 text-[11px] font-medium',
                    prio.chip,
                  )}
                >
                  <span className={cn('size-1.5 rounded-full', prio.dot)} aria-hidden />
                  {prio.label}
                </span>
              </span>
              <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                Archived {t.archived_at ? relativeTime(t.archived_at) : ''}
                {t.archived_by ? ` by ${t.archived_by.split('@')[0]}` : ''} · was in{' '}
                {STATUS_STYLES[t.status].label}
              </span>
            </span>
            <span className="shrink-0 text-[11px] text-muted-foreground/70 opacity-0 transition-opacity group-hover:opacity-100">
              View &amp; restore
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ── Loading skeleton ──────────────────────────────────────────────────────────

function BoardSkeleton() {
  return (
    <div className="flex h-full min-w-max gap-3 p-4 sm:min-w-0 sm:p-6 sm:pt-4">
      {TICKET_STATUSES.map((status) => (
        <div
          key={status}
          className="flex h-full w-72 shrink-0 flex-col rounded-xl bg-muted/30 sm:w-auto sm:min-w-56 sm:flex-1"
        >
          <div className="flex items-center gap-2 px-3 pt-3 pb-2">
            <span className={cn('size-2 rounded-full', STATUS_STYLES[status].dot)} aria-hidden />
            <Skeleton className="h-4 w-16" />
          </div>
          <div className="flex flex-col gap-2 px-2 pb-2">
            {Array.from({ length: status === 'done' ? 1 : 2 + (status === 'todo' ? 1 : 0) }).map((_, i) => (
              <div key={i} className="rounded-lg border border-border bg-card p-3">
                <div className="flex items-center justify-between">
                  <Skeleton className="h-3 w-8" />
                  <Skeleton className="h-4 w-14 rounded-full" />
                </div>
                <Skeleton className="mt-2 h-4 w-full" />
                <Skeleton className="mt-1 h-4 w-2/3" />
                <div className="mt-3 flex items-center gap-2">
                  <Skeleton className="size-5 rounded-full" />
                  <Skeleton className="h-3 w-20" />
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
