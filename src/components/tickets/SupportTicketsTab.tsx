'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  AlertTriangle,
  CheckCircle2,
  Flag,
  Inbox,
  Loader2,
  MessageSquare,
  Radio,
  RefreshCw,
  Send,
  Undo2,
  UserRound,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { cleanErrorMessage } from '@/lib/clean-error-message';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';
import { formatDeptLabel } from '@/lib/departments/hsl-subdept';
import { PRIORITY_STYLES, relativeTime } from './TicketCard';
import { TICKET_PRIORITIES, TICKET_PRIORITY_LABELS, type TicketPriority } from '@/lib/tickets/types';
import {
  TICKET_LIVE_DEBOUNCE_MS,
  TICKET_LIVE_EVENT,
  TICKET_LIVE_POLL_MS,
  TICKET_LIVE_TOPIC,
  parseTicketLivePayload,
} from '@/lib/support/ticket-live';
import { canStaffAct, type Actor, type LifecycleTicket, type SupportAct } from '@/lib/support/lifecycle';
import { type SupportPriority, type TicketStage } from '@/lib/support/triage';
import {
  SUPPORT_CATEGORY_LABELS,
  SUPPORT_CONCERN_MAX,
  SUPPORT_STATUS_LABELS,
  SUPPORT_STATUS_TONE,
  isSupportCategory,
  type SupportStatus,
} from '@/lib/support/types';

/**
 * Employee Support — the STAFF board: the queueing line, the board, the counts.
 *
 * Plan: docs/superpowers/plans/2026-09-21-employee-support-tickets-board.md
 * (task 9). Routes: app/api/support/tickets (GET/PATCH),
 * .../[id]/reply (GET/POST). Sibling to `SupportChatTab.tsx`, which this file
 * copies its host wiring, cadence and Live/Connecting/Polling pill from — see
 * that file's header for the five rules both tabs hold.
 *
 * ONE DIFFERENCE FROM THE CHAT TAB: TWO GATE LEVELS ON ONE SCREEN
 * ---------------------------------------------------------------------------
 * `canEdit` (the `support_tickets` feature key) gates claim / rank / reassign
 * — the board-management acts `../route.ts` requires `edit` for. Replying,
 * closing and reopening are gated at `view` on the SERVER
 * (`[id]/reply/route.ts`'s header explains why), so this component draws
 * those controls for every viewer who can open the tab at all, and reserves
 * `canEdit` for the claim/rank/reassign row only.
 *
 * BUTTONS ARE DISABLED FROM `lifecycle.ts`, NOT FROM A SECOND GUESS HERE
 * ---------------------------------------------------------------------------
 * `canStaffAct` is pure and carries no server import, so this file calls the
 * SAME function the routes enforce their verdicts with. A control this screen
 * enables and a write the route refuses cannot happen — either both agree a
 * ticket is closed, held by somebody else, etc., or the type checker is wrong.
 *
 * THE LINE IS THE DEFAULT SECTION, NEVER A DRAWER (plan invariant)
 * ---------------------------------------------------------------------------
 * An un-triaged ticket nobody ranks never reaches the board — starvation is
 * the failure mode a hidden line produces, so this is where the tab opens.
 */

/* ─────────────────────────────── the wire ────────────────────────────────── */

/** `SupportTicketWire` in `../route.ts` and `[id]/reply/route.ts`. Restated: a route module exports only handlers. */
type SupportTicketWire = {
  id: string;
  ticket_no: number;
  label: string;
  work_email: string;
  member_name: string | null;
  department: string | null;
  category: string;
  concern: string;
  status: SupportStatus;
  priority: SupportPriority;
  stage: TicketStage;
  triaged_at: string | null;
  triaged_by: string | null;
  claimed_by: string | null;
  claimed_at: string | null;
  first_response_at: string | null;
  closed_by: string | null;
  closed_at: string | null;
  flagged_at: string | null;
  flag_reason: string | null;
  created_at: string;
  updated_at: string;
  needs_reply: boolean;
};

type SupportCounts = {
  needsReply: number | null;
  answeredToday: number | null;
  inLine: number | null;
  resolved: boolean;
};

type BoardWire = {
  migrated: boolean;
  line: SupportTicketWire[];
  board: SupportTicketWire[];
  answered: SupportTicketWire[];
  closed: SupportTicketWire[] | null;
  closed_has_more: boolean;
  counts: SupportCounts;
  me: { email: string; is_admin: boolean };
  error: string | null;
};

type MessageWire = {
  id: string;
  author_side: 'employee' | 'staff';
  author_email: string | null;
  author_name: string | null;
  body: string;
  flagged_at: string | null;
  flag_reason: string | null;
  created_at: string;
};

type ThreadWire = { migrated: boolean; ticket: SupportTicketWire | null; messages: MessageWire[] | null; error: string | null };

type Section = 'line' | 'board' | 'answered' | 'closed';

/* ─────────────────────────── cadence and live ────────────────────────────── */

const POLL_MS = TICKET_LIVE_POLL_MS;
const DEBOUNCE_MS = TICKET_LIVE_DEBOUNCE_MS;
type LiveStatus = 'connecting' | 'live' | 'degraded';

/* ──────────────────────────────── small parts ────────────────────────────── */

function Shimmer({ className }: { className?: string }) {
  return <Skeleton className={cn('inline-block h-3.5 w-8 align-middle', className)} />;
}

function personLabel(name: string | null, email: string): string {
  const trimmed = (name ?? '').trim();
  if (trimmed) return trimmed;
  const local = email.split('@')[0] ?? email;
  return local.replace(/[._-]+/g, ' ');
}

function clockLabel(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function LivePill({ status }: { status: LiveStatus }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-[11px] font-medium',
        status === 'live' ? 'text-emerald-400' : 'text-muted-foreground',
      )}
      title={
        status === 'live'
          ? 'Updates arrive as they happen — no refresh needed'
          : `Realtime unavailable — refreshing every ${POLL_MS / 1000}s`
      }
    >
      <Radio className="size-3" aria-hidden />
      {status === 'live' ? 'Live' : status === 'connecting' ? 'Connecting' : 'Polling'}
    </span>
  );
}

const STATUS_TONE_DOT: Record<'waiting' | 'active' | 'good' | 'neutral', string> = {
  waiting: 'bg-amber-500',
  active: 'bg-emerald-500',
  good: 'bg-emerald-500',
  neutral: 'bg-zinc-500',
};
const STATUS_TONE_CHIP: Record<'waiting' | 'active' | 'good' | 'neutral', string> = {
  waiting: 'bg-amber-500/15 text-amber-300',
  active: 'bg-emerald-500/15 text-emerald-300',
  good: 'bg-emerald-500/15 text-emerald-300',
  neutral: 'bg-zinc-500/15 text-zinc-400',
};

function StatusChip({ status }: { status: SupportStatus }) {
  const tone = SUPPORT_STATUS_TONE[status];
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium', STATUS_TONE_CHIP[tone])}>
      <span className={cn('size-1.5 rounded-full', STATUS_TONE_DOT[tone])} aria-hidden />
      {SUPPORT_STATUS_LABELS[status]}
    </span>
  );
}

function PriorityChip({ priority }: { priority: SupportPriority }) {
  if (priority === null) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-zinc-500/15 px-1.5 py-0.5 text-[10px] font-medium text-zinc-400">
        <span className="size-1.5 rounded-full bg-zinc-500" aria-hidden />
        In line
      </span>
    );
  }
  const s = PRIORITY_STYLES[priority];
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium', s.chip)}>
      <span className={cn('size-1.5 rounded-full', s.dot)} aria-hidden />
      {s.label}
    </span>
  );
}

/** One line of transcript. Staff sits on the right — same convention as chat's `MessageBubble`. */
function MessageBubble({ message }: { message: MessageWire }) {
  const at = clockLabel(message.created_at);
  const staff = message.author_side === 'staff';
  return (
    <div className={cn('flex w-full', staff ? 'justify-end' : 'justify-start')}>
      <div className={cn('min-w-0 max-w-[85%]', staff ? 'text-right' : 'text-left')}>
        {message.author_name && (
          <p className="mb-0.5 px-1 text-[10.5px] font-medium text-muted-foreground">{message.author_name}</p>
        )}
        <div
          className={cn(
            'inline-block whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-left text-[12.5px] leading-relaxed',
            staff ? 'bg-primary/15 text-foreground' : 'border border-border bg-background text-foreground',
          )}
        >
          {message.body}
        </div>
        <p className={cn('mt-0.5 flex items-center gap-1.5 px-1 text-[10px] text-muted-foreground', staff && 'justify-end')}>
          {message.flag_reason && (
            <span
              className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-1.5 py-px text-amber-300"
              title={`Flagged by screening: ${message.flag_reason}`}
            >
              <Flag className="size-2.5" aria-hidden />
              {message.flag_reason}
            </span>
          )}
          {at && <span className="tabular-nums">{at}</span>}
        </p>
      </div>
    </div>
  );
}

/** One row in the line/board/answered/closed list. */
function TicketRow({ ticket, selected, onSelect }: { ticket: SupportTicketWire; selected: boolean; onSelect: () => void }) {
  const deptLabel = formatDeptLabel(ticket.department);
  const categoryLabel = isSupportCategory(ticket.category) ? SUPPORT_CATEGORY_LABELS[ticket.category] : ticket.category;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? 'true' : undefined}
      className={cn(
        'w-full rounded-lg border px-2.5 py-2 text-left transition-colors',
        selected ? 'border-primary/50 bg-primary/10' : 'border-border bg-background hover:border-primary/30 hover:bg-muted/40',
      )}
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-foreground">
          {personLabel(ticket.member_name, ticket.work_email)}
        </span>
        <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">{ticket.label}</span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1.5">
        <StatusChip status={ticket.status} />
        <PriorityChip priority={ticket.priority} />
        {ticket.flag_reason && (
          <span title={`Flagged: ${ticket.flag_reason}`}>
            <Flag className="size-3 text-amber-400" aria-hidden />
          </span>
        )}
        <span className="min-w-0 truncate text-[10.5px] text-muted-foreground">
          {categoryLabel}
          {deptLabel ? ` · ${deptLabel}` : ''} · filed {relativeTime(ticket.created_at)}
        </span>
      </div>
      {ticket.claimed_by && (
        <p className="mt-1 truncate text-[10.5px] text-muted-foreground">held by {personLabel(null, ticket.claimed_by)}</p>
      )}
    </button>
  );
}

/* ─────────────────────────────── the tab itself ──────────────────────────── */

interface Props {
  /** `canEditTab('employee_support', 'support-tickets', …)` — gates claim/rank/reassign only. See file header. */
  canEdit: boolean;
}

export default function SupportTicketsTab({ canEdit }: Props) {
  const reduceMotion = useReducedMotion();

  const [board, setBoard] = useState<BoardWire | null>(null);
  const [boardKnown, setBoardKnown] = useState(false);
  const [boardError, setBoardError] = useState<string | null>(null);

  const [section, setSection] = useState<Section>('line');
  const [closedWanted, setClosedWanted] = useState(false);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [thread, setThread] = useState<ThreadWire | null>(null);
  const [threadLoading, setThreadLoading] = useState(false);

  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [busyAction, setBusyAction] = useState<SupportAct | null>(null);
  const [handoffTo, setHandoffTo] = useState('');

  const [live, setLive] = useState<LiveStatus>('connecting');

  const threadRef = useRef<HTMLDivElement | null>(null);
  const debounceRef = useRef<number | null>(null);
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;
  const closedWantedRef = useRef(closedWanted);
  closedWantedRef.current = closedWanted;

  /* ── reads ── */

  const loadBoard = useCallback(async () => {
    try {
      const res = await fetch(`/api/support/tickets${closedWantedRef.current ? '?closed=1' : ''}`, { cache: 'no-store' });
      const json = (await res.json()) as Partial<BoardWire> & { error?: string | null };
      if (!res.ok || json.error) {
        // A failed read keeps the last-known board — the last-known state stays
        // under an honest line, same rule the chat tab follows.
        setBoardError(cleanErrorMessage(json.error, 'We could not read the board just now.'));
        if (json.migrated === false) setBoard((prev) => (prev ? { ...prev, migrated: false } : null));
        return;
      }
      setBoard(json as BoardWire);
      setBoardKnown(true);
      setBoardError(null);
    } catch (e) {
      setBoardError(cleanErrorMessage(e, 'We could not read the board just now.'));
    }
  }, []);

  const loadThread = useCallback(async (id: string) => {
    setThreadLoading(true);
    try {
      const res = await fetch(`/api/support/tickets/${encodeURIComponent(id)}/reply`, { cache: 'no-store' });
      const json = (await res.json()) as ThreadWire;
      if (!res.ok) {
        toast.error(cleanErrorMessage(json.error, 'We could not open that ticket.'));
        return;
      }
      setThread(json);
    } catch (e) {
      toast.error(cleanErrorMessage(e, 'We could not open that ticket.'));
    } finally {
      setThreadLoading(false);
    }
  }, []);

  const boardRef = useRef(loadBoard);
  boardRef.current = loadBoard;
  const threadLoadRef = useRef(loadThread);
  threadLoadRef.current = loadThread;

  const refreshAll = useCallback((withThread: boolean) => {
    void boardRef.current();
    const id = selectedRef.current;
    if (withThread && id) void threadLoadRef.current(id);
  }, []);

  /* ── first load, and reload when the Closed toggle changes ── */

  useEffect(() => {
    void loadBoard();
  }, [loadBoard, closedWanted]);

  useEffect(() => {
    if (!selectedId) {
      setThread(null);
      setDraft('');
      return;
    }
    setDraft('');
    void threadLoadRef.current(selectedId);
  }, [selectedId]);

  /* ── poll floor ── */

  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      refreshAll(true);
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [refreshAll]);

  useEffect(() => {
    const onWake = () => {
      if (document.visibilityState !== 'visible') return;
      refreshAll(true);
    };
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('focus', onWake);
    return () => {
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('focus', onWake);
    };
  }, [refreshAll]);

  /* ── the live signal: a FACT, never content ── */

  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) {
      setLive('degraded');
      return;
    }

    const fire = (withThread: boolean) => {
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
      debounceRef.current = window.setTimeout(() => {
        debounceRef.current = null;
        refreshAll(withThread);
      }, DEBOUNCE_MS);
    };

    const channel = supabase.channel(TICKET_LIVE_TOPIC);
    channel.on('broadcast', { event: TICKET_LIVE_EVENT }, ({ payload }) => {
      const p = parseTicketLivePayload(payload);
      if (!p) return;
      if (p.kind === 'ticket') {
        fire(p.ticketId === selectedRef.current);
        return;
      }
      if (p.ticketId === selectedRef.current) fire(true);
    });
    channel.subscribe((state, err) => {
      if (state === 'SUBSCRIBED') setLive('live');
      else if (state === 'CHANNEL_ERROR' || state === 'TIMED_OUT' || state === 'CLOSED') {
        setLive('degraded');
        if (err) {
          // eslint-disable-next-line no-console
          console.warn(`[support-tickets] Realtime ${state} — falling back to the ${POLL_MS / 1000}s poll.`, err);
        }
      }
    });

    return () => {
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
      void supabase.removeChannel(channel);
    };
  }, [refreshAll]);

  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [thread?.messages]);

  /* ── writes: board management (claim / rank / reassign) ── */

  const patchBoard = useCallback(
    async (action: 'claim' | 'rank' | 'reassign', ticketId: string, extra: Record<string, unknown> = {}) => {
      setBusyAction(action);
      try {
        const res = await fetch('/api/support/tickets', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, ticket_id: ticketId, ...extra }),
        });
        const json = (await res.json()) as { ticket?: SupportTicketWire | null; error?: string | null };
        if (!res.ok) {
          const message = cleanErrorMessage(json.error, 'Nothing was recorded. Refresh the board.');
          if (res.status === 409) toast.warning(message);
          else toast.error(message);
          void boardRef.current();
          return;
        }
        toast.success(
          action === 'claim' ? 'Ticket claimed.' : action === 'reassign' ? 'Handed off.' : 'Priority updated.',
        );
        void boardRef.current();
        if (selectedRef.current === ticketId) void threadLoadRef.current(ticketId);
      } catch (e) {
        toast.error(cleanErrorMessage(e, 'Nothing was recorded. Refresh the board.'));
      } finally {
        setBusyAction(null);
      }
    },
    [],
  );

  /* ── writes: the thread (reply / close / reopen) ── */

  const postThread = useCallback(async (id: string, action: 'reply' | 'close' | 'reopen', body?: string) => {
    if (action === 'reply') setSending(true);
    else setBusyAction(action);
    try {
      const res = await fetch(`/api/support/tickets/${encodeURIComponent(id)}/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(action === 'reply' ? { action, body } : { action }),
      });
      const json = (await res.json()) as {
        ticket?: SupportTicketWire | null;
        message?: MessageWire | null;
        messages?: MessageWire[] | null;
        error?: string | null;
      };
      if (!res.ok) {
        const message = cleanErrorMessage(json.error, 'Nothing was changed. Refresh the ticket.');
        if (res.status === 409) toast.warning(message);
        else toast.error(message);
        void boardRef.current();
        void threadLoadRef.current(id);
        return;
      }
      if (action === 'reply') {
        setDraft('');
        setThread((prev) => (json.ticket ? { migrated: true, ticket: json.ticket, messages: json.messages ?? prev?.messages ?? [], error: null } : prev));
      } else {
        toast.success(action === 'close' ? 'Ticket closed.' : 'Ticket reopened.');
        setThread((prev) => (json.ticket ? { migrated: true, ticket: json.ticket, messages: prev?.messages ?? [], error: null } : prev));
      }
      void boardRef.current();
    } catch (e) {
      toast.error(cleanErrorMessage(e, 'Nothing was changed. Refresh the ticket.'));
    } finally {
      if (action === 'reply') setSending(false);
      else setBusyAction(null);
    }
  }, []);

  /* ── derived ── */

  const migrated = board?.migrated ?? null;
  const counts = board?.counts ?? { needsReply: null, answeredToday: null, inLine: null, resolved: false };
  const line = board?.line ?? [];
  const boardTickets = board?.board ?? [];
  const answered = board?.answered ?? [];
  const closed = board?.closed ?? null;

  const sectionRows = useMemo(() => {
    if (section === 'line') return line;
    if (section === 'board') return boardTickets;
    if (section === 'answered') return answered;
    return closed ?? [];
  }, [section, line, boardTickets, answered, closed]);

  const selectedTicket = thread?.ticket ?? null;
  const messages = thread?.messages ?? [];

  const actor: Actor | null = board?.me ? { email: board.me.email.trim().toLowerCase(), isAdmin: board.me.is_admin } : null;

  const lifecycleTicket: LifecycleTicket | null = selectedTicket
    ? { status: selectedTicket.status, priority: selectedTicket.priority, claimed_by: selectedTicket.claimed_by }
    : null;

  const verdictFor = useCallback(
    (act: SupportAct) => {
      if (!lifecycleTicket || !actor) return { allowed: false as const, reason: 'Loading…' };
      return canStaffAct(act, lifecycleTicket, actor);
    },
    [lifecycleTicket, actor],
  );

  const claimVerdict = verdictFor('claim');
  const closeVerdict = verdictFor('close');
  const reopenVerdict = verdictFor('reopen');
  const reassignVerdict = verdictFor('reassign');
  // Reply is gated at `view` on the server — every viewer of this tab already
  // has it — but the verdict still decides the auto-claim side effect and,
  // when `lifecycle.ts` ever changes, whatever new refusal it states.
  const replyVerdict = verdictFor('reply');

  const overLimit = draft.length > SUPPORT_CONCERN_MAX;

  /* ── render ── */

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-4 sm:p-6 sm:pt-4">
      {migrated === false && (
        <div className="flex items-start gap-2.5 rounded-xl border border-destructive/40 bg-destructive/10 p-3">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
          <div>
            <p className="text-[13px] font-semibold text-foreground">Employee Support tickets are not switched on yet</p>
            <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
              The ticket tables have not been migrated, so this board is empty because the feature is off — not
              because nothing has come in.
            </p>
          </div>
        </div>
      )}

      {boardError && migrated !== false && (
        <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11.5px] leading-relaxed text-amber-300">
          {boardError} Nothing was changed — what is below is the last state we could read.
        </p>
      )}

      {/* Carla signed "counts at a glance" — spanning BOTH stages, never one. */}
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-3">
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground">Needs a reply</span>
          {counts.resolved ? (
            <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[11px] font-bold tabular-nums text-amber-300">
              {counts.needsReply}
            </span>
          ) : (
            <Shimmer />
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground">Answered today</span>
          {counts.resolved ? (
            <span className="rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[11px] font-bold tabular-nums text-emerald-300">
              {counts.answeredToday}
            </span>
          ) : (
            <Shimmer />
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground">In line</span>
          {counts.resolved ? (
            <span className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] font-bold tabular-nums text-foreground">
              {counts.inLine}
            </span>
          ) : (
            <Shimmer />
          )}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" size="icon-sm" aria-label="Refresh" title="Refresh" onClick={() => refreshAll(true)}>
            <RefreshCw aria-hidden />
          </Button>
          <LivePill status={live} />
        </div>
      </div>

      <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[22rem_1fr]">
        {/* ── the sections ── */}
        <section className="flex min-h-0 flex-col rounded-xl border border-border bg-card">
          <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border p-2">
            {(
              [
                ['line', 'Line', boardKnown ? line.length : null],
                ['board', 'Board', boardKnown ? boardTickets.length : null],
                ['answered', 'Answered', boardKnown ? answered.length : null],
                ['closed', 'Closed', closed ? closed.length : null],
              ] as const
            ).map(([key, label, count]) => (
              <button
                key={key}
                type="button"
                onClick={() => {
                  setSection(key);
                  if (key === 'closed' && !closedWanted) setClosedWanted(true);
                }}
                className={cn(
                  'flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12px] font-medium transition-colors',
                  section === key ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
                )}
              >
                {label}
                {count !== null ? (
                  <span className="rounded-full bg-muted px-1.5 text-[10.5px] tabular-nums">{count}</span>
                ) : (
                  <Shimmer className="w-4" />
                )}
              </button>
            ))}
          </div>

          <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2">
            {!boardKnown ? (
              <div className="space-y-1.5">
                <Skeleton className="h-14 rounded-lg" />
                <Skeleton className="h-14 rounded-lg" />
                <Skeleton className="h-14 rounded-lg" />
              </div>
            ) : sectionRows.length === 0 ? (
              <p className="flex flex-col items-center gap-1.5 px-3 py-8 text-center text-[11.5px] text-muted-foreground">
                <Inbox className="size-5" aria-hidden />
                {section === 'line' && 'Nothing waiting to be triaged.'}
                {section === 'board' && 'Nothing ranked right now.'}
                {section === 'answered' && 'Nothing is waiting on the employee.'}
                {section === 'closed' && 'Nothing closed recently.'}
              </p>
            ) : (
              sectionRows.map((t) => (
                <TicketRow key={t.id} ticket={t} selected={selectedId === t.id} onSelect={() => setSelectedId(t.id)} />
              ))
            )}
          </div>
        </section>

        {/* ── the ticket ── */}
        <section className="flex min-h-0 flex-col rounded-xl border border-border bg-card">
          {!selectedId ? (
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
              <MessageSquare className="size-6 text-muted-foreground" aria-hidden />
              <p className="max-w-sm text-[12.5px] leading-relaxed text-muted-foreground">
                Pick a question from the line or the board to read it and reply.
              </p>
            </div>
          ) : (
            <>
              <div className="flex shrink-0 flex-col gap-2 border-b border-border px-3 py-2.5">
                <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                  {!selectedTicket ? (
                    threadLoading ? (
                      <Skeleton className="h-4 w-56" />
                    ) : (
                      <p className="text-[12px] text-muted-foreground">That ticket is no longer here.</p>
                    )
                  ) : (
                    <>
                      <span className="font-mono text-[11px] text-muted-foreground">{selectedTicket.label}</span>
                      <h2 className="truncate text-[13px] font-semibold text-foreground">
                        {personLabel(selectedTicket.member_name, selectedTicket.work_email)}
                      </h2>
                      <StatusChip status={selectedTicket.status} />
                      <span className="truncate text-[11px] text-muted-foreground">
                        {isSupportCategory(selectedTicket.category)
                          ? SUPPORT_CATEGORY_LABELS[selectedTicket.category]
                          : selectedTicket.category}{' '}
                        · filed {relativeTime(selectedTicket.created_at)}
                      </span>
                      <div className="ml-auto flex items-center gap-1.5">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label="Reload this ticket"
                          title="Reload this ticket"
                          onClick={() => void loadThread(selectedId)}
                        >
                          <RefreshCw className={cn(threadLoading && 'animate-spin')} aria-hidden />
                        </Button>
                        {selectedTicket.status !== 'closed' && closeVerdict.allowed && (
                          <Button
                            variant="destructive"
                            size="sm"
                            disabled={busyAction !== null}
                            onClick={() => void postThread(selectedId, 'close')}
                          >
                            {busyAction === 'close' ? (
                              <Loader2 className="animate-spin" data-icon="inline-start" aria-hidden />
                            ) : (
                              <CheckCircle2 data-icon="inline-start" aria-hidden />
                            )}
                            Close
                          </Button>
                        )}
                        {selectedTicket.status === 'closed' && reopenVerdict.allowed && (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busyAction !== null}
                            onClick={() => void postThread(selectedId, 'reopen')}
                          >
                            {busyAction === 'reopen' ? (
                              <Loader2 className="animate-spin" data-icon="inline-start" aria-hidden />
                            ) : (
                              <Undo2 data-icon="inline-start" aria-hidden />
                            )}
                            Reopen
                          </Button>
                        )}
                      </div>
                    </>
                  )}
                </div>

                {/* Board management — claim / rank / hand off. `edit`-gated only, per the file header. */}
                {selectedTicket && (
                  <div className="flex flex-wrap items-center gap-2">
                    <PriorityChip priority={selectedTicket.priority} />
                    {selectedTicket.department && (
                      <span className="text-[10.5px] text-muted-foreground">{formatDeptLabel(selectedTicket.department)}</span>
                    )}
                    {canEdit ? (
                      <>
                        <select
                          value={selectedTicket.priority ?? ''}
                          disabled={busyAction !== null}
                          onChange={(e) => {
                            const v = e.target.value;
                            void patchBoard('rank', selectedId, { priority: v === '' ? null : (v as TicketPriority) });
                          }}
                          className="rounded-md border border-border bg-background px-2 py-1 text-[11px] text-foreground"
                          aria-label="Set urgency"
                        >
                          <option value="">Send back to line</option>
                          {TICKET_PRIORITIES.map((p) => (
                            <option key={p} value={p}>
                              {TICKET_PRIORITY_LABELS[p]}
                            </option>
                          ))}
                        </select>
                        {claimVerdict.allowed && (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busyAction !== null}
                            onClick={() => void patchBoard('claim', selectedId)}
                          >
                            {busyAction === 'claim' ? (
                              <Loader2 className="animate-spin" data-icon="inline-start" aria-hidden />
                            ) : (
                              <UserRound data-icon="inline-start" aria-hidden />
                            )}
                            Claim
                          </Button>
                        )}
                        {reassignVerdict.allowed && (
                          <div className="flex items-center gap-1">
                            <input
                              value={handoffTo}
                              onChange={(e) => setHandoffTo(e.target.value)}
                              placeholder="Hand off to…"
                              className="w-40 rounded-md border border-border bg-background px-2 py-1 text-[11px] text-foreground placeholder:text-muted-foreground"
                            />
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={busyAction !== null || handoffTo.trim().length === 0}
                              onClick={() => {
                                const to = handoffTo.trim();
                                setHandoffTo('');
                                void patchBoard('reassign', selectedId, { to_email: to });
                              }}
                            >
                              Hand off
                            </Button>
                          </div>
                        )}
                      </>
                    ) : (
                      <span className="text-[10.5px] text-muted-foreground">
                        Claiming, ranking and handing off need the edit grant on Support Tickets.
                      </span>
                    )}
                  </div>
                )}
              </div>

              <div ref={threadRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto bg-background/40 p-3">
                {/* The opening concern is the ticket's own text — the SQL's own description of the two tables (see the reply route header). */}
                {selectedTicket && (
                  <div className="flex justify-start">
                    <div className="max-w-[85%]">
                      <p className="mb-0.5 px-1 text-[10.5px] font-medium text-muted-foreground">
                        {personLabel(selectedTicket.member_name, selectedTicket.work_email)}
                      </p>
                      <div className="inline-block whitespace-pre-wrap break-words rounded-2xl border border-border bg-background px-3 py-2 text-left text-[12.5px] leading-relaxed text-foreground">
                        {selectedTicket.concern}
                      </div>
                      <p className="mt-0.5 flex items-center gap-1.5 px-1 text-[10px] text-muted-foreground">
                        {selectedTicket.flag_reason && (
                          <span
                            className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-1.5 py-px text-amber-300"
                            title={`Flagged by screening: ${selectedTicket.flag_reason}`}
                          >
                            <Flag className="size-2.5" aria-hidden />
                            {selectedTicket.flag_reason}
                          </span>
                        )}
                        <span className="tabular-nums">{clockLabel(selectedTicket.created_at)}</span>
                      </p>
                    </div>
                  </div>
                )}
                {threadLoading && !thread ? (
                  <div className="space-y-2">
                    <Skeleton className="h-8 w-2/3 rounded-2xl" />
                    <Skeleton className="ml-auto h-8 w-1/2 rounded-2xl" />
                  </div>
                ) : (
                  <AnimatePresence initial={false}>
                    {messages.map((m) => (
                      <motion.div
                        key={m.id}
                        initial={{ opacity: 0, y: reduceMotion ? 0 : 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: reduceMotion ? 0 : 0.2, ease: [0.16, 1, 0.3, 1] }}
                      >
                        <MessageBubble message={m} />
                      </motion.div>
                    ))}
                  </AnimatePresence>
                )}
              </div>

              <div className="shrink-0 border-t border-border p-3">
                {selectedTicket && replyVerdict.allowed ? (
                  <div className="space-y-2">
                    <textarea
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          if (draft.trim() && !overLimit) void postThread(selectedId, 'reply', draft.trim());
                        }
                      }}
                      rows={2}
                      placeholder="Answer them…"
                      className="w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-[13px] leading-relaxed text-foreground placeholder:text-muted-foreground focus:border-primary/50 focus:ring-1 focus:ring-primary/30 focus:outline-none"
                    />
                    <div className="flex items-center justify-between gap-2">
                      {draft.length > SUPPORT_CONCERN_MAX - 400 ? (
                        <span className={cn('text-[11px] tabular-nums', overLimit ? 'font-semibold text-destructive' : 'text-muted-foreground')}>
                          {draft.length} / {SUPPORT_CONCERN_MAX}
                        </span>
                      ) : (
                        <span />
                      )}
                      <Button
                        size="sm"
                        disabled={sending || overLimit || draft.trim().length === 0}
                        onClick={() => void postThread(selectedId, 'reply', draft.trim())}
                      >
                        {sending ? <Loader2 className="animate-spin" data-icon="inline-start" aria-hidden /> : <Send data-icon="inline-start" aria-hidden />}
                        Send
                      </Button>
                    </div>
                  </div>
                ) : (
                  <p className="text-[11.5px] leading-relaxed text-muted-foreground">
                    {selectedTicket ? replyVerdict.allowed === false ? replyVerdict.reason : '' : 'Loading…'}
                  </p>
                )}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
