'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  AlertTriangle,
  CheckCircle2,
  Flag,
  Inbox,
  Loader2,
  MessageCircle,
  Radio,
  RefreshCw,
  Send,
  Ticket,
  Undo2,
  UserRound,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { cleanErrorMessage } from '@/lib/clean-error-message';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';
import { SUPPORT_CONCERN_MAX } from '@/lib/support/types';
import {
  CHAT_LIVE_DEBOUNCE_MS,
  CHAT_LIVE_EVENT,
  CHAT_LIVE_POLL_MS,
  CHAT_LIVE_TOPIC,
  parseChatLivePayload,
} from '@/lib/support/chat-live';
import {
  CHAT_SESSION_STATUS_LABELS_AGENT,
  CHAT_SESSION_STATUS_TONE,
  formatChatSessionNo,
  type ChatAuthorSide,
  type ChatSessionStatus,
} from '@/lib/support/chat-types';
import {
  AGENT_HEARTBEAT_MS,
  CHAT_AVAILABILITY_LABELS_AGENT,
  CHAT_AVAILABILITY_TONE,
  type ChatAvailability,
} from '@/lib/support/availability';
import { compareQueueRank } from '@/lib/support/queue';
import { formatDeptLabel } from '@/lib/departments/hsl-subdept';
import { relativeTime } from './TicketCard';

/**
 * Employee Support LIVE CHAT — the AGENT's side, hosted at /tickets.
 *
 * Plan: docs/superpowers/plans/2026-09-19-employee-support-chat.md (task 18).
 * Routes: app/api/support/chat/queue, .../availability, .../[id]/messages.
 * The employee's side of the same conversation: EmployeeSupportChat.tsx — the
 * two agree about every wire shape and every status word because both read
 * `chat-types.ts`, which is where they agree.
 *
 * WHY IT LIVES HERE AND NOT ON ITS OWN ROUTE
 * ---------------------------------------------------------------------------
 * Kane's Q3: a new `employee_support` role and FeatureViewKey, **hosted at
 * /tickets as its own tabs**. `ticketsHostAccess` (view-tabs.ts:272-287) is the
 * one function that decides who sees this; TicketsBoard asks it and renders
 * this component only for a holder, and TicketsSidebar draws its nav from the
 * same answer. A support-only holder never sees Overview / Board / Archived —
 * not in the rail, and not as a landing, which is the only way a typed /tickets
 * URL could have reached them.
 *
 * FIVE RULES THIS FILE EXISTS TO HOLD
 * ---------------------------------------------------------------------------
 * 1. **"Nobody is waiting" and "we cannot tell" are different states** (plan
 *    `:91-92`). Every count here is nullable, `null` paints a {@link Shimmer},
 *    and there is no path that turns an unread queue into a `0`. The same rule
 *    the employee's position obeys, on the other side of the desk.
 * 2. **The order is `compareQueueRank` and nothing else** (`queue.ts`). The
 *    route already sorts with it; this file re-applies the SAME comparator
 *    rather than trusting array order, so the board and the number the employee
 *    is watching cannot come from two different orderings.
 * 3. **A 409 is the answer, not an error to swallow.** The claim is a
 *    compare-and-set on NULL (queue route `:775-784`) and a lost race comes
 *    back as a 409 whose own copy states that nothing was recorded. That
 *    sentence is shown verbatim and the board re-reads. Nothing here retries a
 *    write, and nothing here widens one.
 * 4. **The on-queue toggle is a DECLARATION, never presence** (Kane's Q4).
 *    Nothing on this screen infers availability from a tab being open: the
 *    switch writes `employee_support_chat_agents.on_queue` and a heartbeat
 *    keeps it honest. See {@link OnQueueCard} for what the agent is told they
 *    are promising by flipping it.
 * 5. **The pill never claims "Live" when the socket is down.** Three states,
 *    the shipped wording from `HrFpuEnrollments.tsx:444` — Live / Connecting /
 *    Polling — because a staffer deciding whether to trust this board needs to
 *    know which one of the three it is.
 *
 * THEME: EVERY PORTALED SURFACE RE-APPLIES `tickets-theme dark`
 * ---------------------------------------------------------------------------
 * `docs/design/ui-standards.md` § 1.4. The console is a CSS custom-property
 * override carried on the board root, and a Dialog portals OUTSIDE that
 * subtree — so {@link ConfirmDialog} carries `tickets-theme dark ticket-dialog`
 * exactly as `TicketDialog.tsx:166-167` does. Both halves are needed:
 * `.ticket-dialog` (index.css:1423-1425) is what replaces DialogContent's
 * hard-coded orange/blue gradient with the console surface, and the theme class
 * alone would leave that gradient sitting there.
 *
 * WHAT IS DELIBERATELY NOT HERE
 * ---------------------------------------------------------------------------
 * * **No per-row claim button.** An agent takes THE NEXT WAITER (plan
 *   `:30-31`). A board where agents pick is a board where the employee's
 *   position — the one number they are shown — stops meaning anything.
 * * **No countdown and no wait estimate, anywhere** (plan `:28`).
 * * **No pay figures and no path to one** (plan `:101-102`).
 */

/* ────────────────────────────── the wire ─────────────────────────────── */

/**
 * `toWire` in app/api/support/chat/queue/route.ts:133-144. Restated rather than
 * imported because a route module is server-only; the day that projection
 * changes, this block is the diff that has to change with it.
 */
type QueueSessionWire = {
  id: string;
  session_no: number;
  status: ChatSessionStatus;
  work_email: string;
  member_name: string | null;
  department: string | null;
  queued_at: string;
  last_seen_at: string;
  claimed_by: string | null;
  claimed_at: string | null;
};

/** What one queue read's lazy sweep actually did (queue route `:147-156`). */
type SweepReport = {
  converted: number;
  completed: number;
  released: number;
  ended: number;
  /** Acts the caps pushed to the next read. Still stale, not lost. */
  deferred: number;
  /** Conversions that could not be finished. Also written to `audit_log`. */
  failed: number;
};

type QueueWire = {
  migrated: boolean;
  waiting: QueueSessionWire[];
  engaged: QueueSessionWire[];
  availability: ChatAvailability;
  me: { email: string; on_queue: boolean | null; holding: string | null };
  sweep: SweepReport | null;
  error: string | null;
};

/** The STAFF message projection — `author_email` and both flag columns. */
type ChatMessageWire = {
  id: string;
  author_side: ChatAuthorSide;
  author_email: string | null;
  author_name: string | null;
  body: string;
  flagged_at: string | null;
  flag_reason: string | null;
  created_at: string;
};

/** `sessionWire` in app/api/support/chat/[id]/messages/route.ts:227-237. */
type ThreadSessionWire = {
  id: string;
  session_no: number;
  status: ChatSessionStatus;
  work_email: string;
  member_name: string | null;
  department: string | null;
  queued_at: string;
  claimed_by: string | null;
  claimed_at: string | null;
};

/** `MeWire` in app/api/support/chat/availability/route.ts:90-104. */
type AvailabilityMeWire = {
  email: string;
  /** `null` means the agents table could not be read — NOT "off the queue". */
  on_queue: boolean | null;
  on_queue_since: string | null;
  last_heartbeat_at: string | null;
  /** Declared on, and the beat has gone quiet. The queue offers them nobody. */
  stale: boolean;
};

type AvailabilityWire = {
  migrated: boolean;
  me: AvailabilityMeWire;
  availability: ChatAvailability;
  /** SERVER-supplied cadence, so the browser cannot beat on its own clock. */
  heartbeat_ms: number;
  stale_after_ms: number;
  error: string | null;
};

/* ─────────────────────────── cadence and live ─────────────────────────── */

/**
 * The poll floor and the burst debounce come from `chat-live.ts`, the module
 * that owns the channel. `EmployeeSupportChat` declares its own pair instead
 * because it needs TWO cadences (fast with the dialog open, slow with it shut);
 * this board has one cadence and no reason to invent a third number.
 */
const POLL_MS = CHAT_LIVE_POLL_MS;
const DEBOUNCE_MS = CHAT_LIVE_DEBOUNCE_MS;

/** The honest channel state. The same three words the FPU surfaces ship. */
type LiveStatus = 'connecting' | 'live' | 'degraded';

/* ──────────────────────────────── tone ───────────────────────────────── */

/**
 * Status colour, keyed off `CHAT_SESSION_STATUS_TONE` rather than off the
 * status itself, so wording and colour keep the one mapping the vocabulary
 * module declares (`chat-types.ts:78-96`).
 *
 * Amber / emerald / zinc, matching the ramps the board already uses for ticket
 * status (`STATUS_STYLES`, TicketCard.tsx:37-42). § 1.4's "the accent is red
 * only" is about the ACTION accent — every button here is red; a state dot is
 * not an action.
 */
const TONE_DOT: Record<'waiting' | 'active' | 'good' | 'neutral', string> = {
  waiting: 'bg-amber-500',
  active: 'bg-emerald-500',
  good: 'bg-emerald-500',
  neutral: 'bg-zinc-500',
};

const TONE_CHIP: Record<'waiting' | 'active' | 'good' | 'neutral', string> = {
  waiting: 'bg-amber-500/15 text-amber-300',
  active: 'bg-emerald-500/15 text-emerald-300',
  good: 'bg-emerald-500/15 text-emerald-300',
  neutral: 'bg-zinc-500/15 text-zinc-400',
};

/**
 * Availability colour. FOUR entries, because `availability.ts` declares four
 * states and gives `unknown` its own tone on purpose — a component must write
 * the skeleton branch rather than discover that grey happened to be handy.
 * `unknown` is therefore never drawn as a dot at all: {@link OnQueueCard}
 * paints a shimmer for it.
 */
const AVAILABILITY_DOT: Record<'good' | 'waiting' | 'neutral' | 'unknown', string> = {
  good: 'bg-emerald-500',
  waiting: 'bg-amber-500',
  neutral: 'bg-zinc-600',
  unknown: 'bg-zinc-700',
};

/* ───────────────────────────── small parts ───────────────────────────── */

/**
 * The cannot-tell mark. A shimmer where a number would be — never a `0`, and
 * never a dash, which reads as "none".
 */
function Shimmer({ className }: { className?: string }) {
  return <Skeleton className={cn('inline-block h-3.5 w-8 align-middle', className)} />;
}

/** A readable name. Never a bare address in prose. */
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

/** Live / Connecting / Polling — the shipped wording (HrFpuEnrollments:444). */
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

function StatusChip({ status }: { status: ChatSessionStatus }) {
  const tone = CHAT_SESSION_STATUS_TONE[status];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium',
        TONE_CHIP[tone],
      )}
    >
      <span className={cn('size-1.5 rounded-full', TONE_DOT[tone])} aria-hidden />
      {CHAT_SESSION_STATUS_LABELS_AGENT[status]}
    </span>
  );
}

/**
 * Kane's Q4 made visible: an explicit declaration with a heartbeat behind it.
 *
 * The copy states what the agent is PROMISING, because that is the whole point
 * of the ruling — an agent toggled on is telling employees somebody is there.
 * `stale` gets its own sentence: the switch still looks on, and without being
 * told outright they would sit watching an empty board believing they were
 * available.
 */
function OnQueueCard({
  me,
  availability,
  staleAfterMs,
  canEdit,
  pending,
  migrated,
  onToggle,
  live,
}: {
  me: AvailabilityMeWire | null;
  availability: ChatAvailability | null;
  staleAfterMs: number;
  canEdit: boolean;
  pending: boolean;
  /** `null` until a route establishes it. `false` = the migration has not run. */
  migrated: boolean | null;
  onToggle: (next: boolean) => void;
  live: LiveStatus;
}) {
  // `null` is UNKNOWN, not off. An unread agents table must not render as a
  // switch sitting confidently in the off position.
  const known = me !== null && me.on_queue !== null;
  const on = known && me.on_queue === true;
  // The switch is off-limits for three separable reasons — no edit grant, no
  // table, a write already in flight — and each gets its own sentence below
  // rather than one grey "unavailable". In particular, a permanent
  // "Checking the queue…" sitting over a database that has no chat tables
  // would be the same lie as rendering an unknown count as zero.
  const disabled = migrated === false;
  const availabilityTone = availability ? CHAT_AVAILABILITY_TONE[availability.state] : 'unknown';

  return (
    <div className="rounded-xl border border-border bg-card p-3.5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="flex items-center gap-3">
          <Switch
            checked={on}
            disabled={!canEdit || disabled || pending || !known}
            onCheckedChange={(next) => onToggle(next)}
            aria-label="I'm on the queue"
          />
          <div className="leading-tight">
            <p className="text-[13px] font-semibold text-foreground">
              {migrated === false
                ? 'The queue is not switched on'
                : known
                  ? on
                    ? "You're on the queue"
                    : "You're off the queue"
                  : 'Checking the queue…'}
            </p>
            <div className="text-[11px] text-muted-foreground">
              {migrated === false ? (
                'There is no queue to join until the chat migration runs.'
              ) : !known ? (
                <Shimmer className="w-44" />
              ) : on ? (
                me?.on_queue_since ? (
                  `Employees are being told somebody is here. On since ${clockLabel(me.on_queue_since)}.`
                ) : (
                  'Employees are being told somebody is here.'
                )
              ) : (
                'Employees are told nobody is on. Nothing is routed to you.'
              )}
            </div>
          </div>
          {pending && <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-hidden />}
        </div>

        <div className="ml-auto flex items-center gap-3">
          {/* The desk-wide answer. `unknown` is a shimmer and never one of the
              other three borrowed — `availability.ts` keeps `nobody_on` and
              `unknown` apart, and this is where that distinction gets spent. */}
          {availability && availabilityTone !== 'unknown' ? (
            <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span
                className={cn('size-1.5 rounded-full', AVAILABILITY_DOT[availabilityTone])}
                aria-hidden
              />
              {CHAT_AVAILABILITY_LABELS_AGENT[availability.state]}
              {availability.onQueue !== null && (
                <span className="tabular-nums">
                  · {availability.onQueue} on
                  {availability.free !== null ? `, ${availability.free} free` : ''}
                </span>
              )}
            </span>
          ) : (
            <Shimmer className="w-32" />
          )}
          <LivePill status={live} />
        </div>
      </div>

      {/* Declared on, evidence run out. Said outright — see the docstring. */}
      {me?.stale && (
        <p className="mt-2.5 flex items-start gap-2 rounded-lg bg-amber-500/10 px-2.5 py-1.5 text-[11.5px] leading-relaxed text-amber-300">
          <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
          <span>
            Your browser stopped checking in, so the queue is not offering you anybody even though
            this switch is on. A check-in from this tab clears it; we stop believing one after{' '}
            <span className="tabular-nums">{Math.round(staleAfterMs / 1000)}</span> seconds of
            silence.
          </span>
        </p>
      )}

      {!canEdit && (
        <p className="mt-2.5 text-[11.5px] leading-relaxed text-muted-foreground">
          You can read the queue but not answer it. Declaring yourself available needs the edit
          grant on Support Chat.
        </p>
      )}
    </div>
  );
}

/** One row in the line, or one conversation already in progress. */
function SessionRow({
  session,
  rank,
  mine,
  selected,
  onSelect,
}: {
  session: QueueSessionWire;
  /** 1-based place in the line, or `null` for a session already being held. */
  rank: number | null;
  mine: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  // NEVER the raw cell: `department` holds `hsl:filing_specialist` and a human
  // must read "HSL — Filing Specialist" (hsl-subdepartments.md:32, pinned by
  // src/lib/departments/dept-label-render.test.ts).
  const deptLabel = formatDeptLabel(session.department);

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? 'true' : undefined}
      className={cn(
        'w-full rounded-lg border px-2.5 py-2 text-left transition-colors',
        selected
          ? 'border-primary/50 bg-primary/10'
          : 'border-border bg-background hover:border-primary/30 hover:bg-muted/40',
      )}
    >
      <div className="flex items-center gap-2">
        {rank !== null && (
          <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-[11px] font-bold tabular-nums text-foreground">
            {/* Unclamped, exactly like the employee's own badge: a hundredth
                place is precisely the number somebody needs in order to act. */}
            {rank}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-foreground">
          {personLabel(session.member_name, session.work_email)}
        </span>
        <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">
          {formatChatSessionNo(session.session_no)}
        </span>
      </div>
      <div className="mt-1 flex items-center gap-2">
        <StatusChip status={session.status} />
        <span className="min-w-0 truncate text-[10.5px] text-muted-foreground">
          {deptLabel ? `${deptLabel} · ` : ''}
          joined {relativeTime(session.queued_at)}
        </span>
        {mine && (
          <span className="ml-auto shrink-0 rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
            You
          </span>
        )}
      </div>
    </button>
  );
}

/** One line of transcript. The staff side sits on the right. */
function MessageBubble({ message }: { message: ChatMessageWire }) {
  const at = clockLabel(message.created_at);

  if (message.author_side === 'system') {
    return (
      <div className="flex justify-center py-0.5">
        <span className="rounded-full bg-muted px-2.5 py-1 text-[10.5px] text-muted-foreground">
          {message.body}
          {at ? ` · ${at}` : ''}
        </span>
      </div>
    );
  }

  const staff = message.author_side === 'agent';
  return (
    <div className={cn('flex w-full', staff ? 'justify-end' : 'justify-start')}>
      <div className={cn('min-w-0 max-w-[85%]', staff ? 'text-right' : 'text-left')}>
        {message.author_name && (
          <p className="mb-0.5 px-1 text-[10.5px] font-medium text-muted-foreground">
            {message.author_name}
          </p>
        )}
        <div
          className={cn(
            'inline-block whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-left text-[12.5px] leading-relaxed',
            staff
              ? 'bg-primary/15 text-foreground'
              : 'border border-border bg-background text-foreground',
          )}
        >
          {message.body}
        </div>
        <p
          className={cn(
            'mt-0.5 flex items-center gap-1.5 px-1 text-[10px] text-muted-foreground',
            staff && 'justify-end',
          )}
        >
          {/* Screening RECORDS, it never refuses (`screening.ts`, untouched by
              this work). A flag nobody is shown is a flag that did nothing, so
              the reason rides on the row. */}
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

/**
 * The one portaled surface on this tab, and therefore the one that has to
 * re-opt into the console palette — see the file docstring and § 1.4.
 */
function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  destructive,
  busy,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  destructive: boolean;
  busy: boolean;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* `tickets-theme dark ticket-dialog`: a Dialog portals outside the board
          wrapper, so it re-applies the console theme here. `.ticket-dialog`
          (index.css:1423-1425) is the half that replaces DialogContent's
          hard-coded orange/blue gradient — the theme class alone leaves it. */}
      <DialogContent className="tickets-theme dark ticket-dialog sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant={destructive ? 'destructive' : 'default'}
            disabled={busy}
            onClick={onConfirm}
          >
            {busy && <Loader2 className="animate-spin" data-icon="inline-start" aria-hidden />}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ─────────────────────────── the tab itself ──────────────────────────── */

interface Props {
  /**
   * `canEditTab('employee_support', 'support-chat', …)`. The server gates every
   * write at `edit` on its own (queue route `:558-570`); this only decides
   * whether to DRAW a control whose fetch would be refused anyway.
   */
  canEdit: boolean;
}

export default function SupportChatTab({ canEdit }: Props) {
  const reduceMotion = useReducedMotion();

  const [queue, setQueue] = useState<QueueWire | null>(null);
  /** A read actually landed. Until then every count is UNKNOWN, not zero. */
  const [queueKnown, setQueueKnown] = useState(false);
  const [queueError, setQueueError] = useState<string | null>(null);

  const [avail, setAvail] = useState<AvailabilityWire | null>(null);
  const [togglePending, setTogglePending] = useState(false);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [thread, setThread] = useState<{
    session: ThreadSessionWire | null;
    messages: ChatMessageWire[];
  } | null>(null);
  const [threadLoading, setThreadLoading] = useState(false);

  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [actioning, setActioning] = useState(false);
  const [confirm, setConfirm] = useState<'release' | 'end' | null>(null);

  const [live, setLive] = useState<LiveStatus>('connecting');
  /**
   * The last queue read whose sweep actually moved something, with the moment
   * it happened. Kept in state because the sweep report is a fact about ONE
   * read: rendering it straight from `queue` would blink a conversion out of
   * existence ten seconds later, and a chat that became a ticket is exactly the
   * event an agent needs to still be able to see.
   */
  const [lastSweep, setLastSweep] = useState<{ at: string; report: SweepReport } | null>(null);

  const threadRef = useRef<HTMLDivElement | null>(null);
  const debounceRef = useRef<number | null>(null);
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;
  /** The last `sweep.failed` this screen announced. See {@link loadQueue}. */
  const failedToastedRef = useRef(0);

  /* ── reads ── */

  const loadQueue = useCallback(async () => {
    try {
      const res = await fetch('/api/support/chat/queue', { cache: 'no-store' });
      const json = (await res.json()) as Partial<QueueWire> & { error?: string | null };
      if (!res.ok || json.error) {
        // A FAILED READ DOES NOT CLEAR A KNOWN QUEUE. The 500 shape carries
        // empty arrays because the route could not look, not because the line
        // is empty — writing that through would paint "nobody is waiting" over
        // people who are. The last-known state stays under an honest line.
        setQueueError(cleanErrorMessage(json.error, 'We could not read the queue just now.'));
        // `migrated: false` is the one thing a failed read still establishes.
        if (json.migrated === false) {
          setQueue((prev) => (prev ? { ...prev, migrated: false } : null));
        }
        return;
      }
      const next = json as QueueWire;
      setQueue(next);
      setQueueKnown(true);
      setQueueError(null);

      const s = next.sweep;
      if (s && s.converted + s.completed + s.released + s.ended + s.deferred + s.failed > 0) {
        setLastSweep({ at: new Date().toISOString(), report: s });
      }
      // A conversion that could not be finished is already an audit row
      // (`employee_support.chat.sweep_failed`); it is told to a human here as
      // well, because a backlog nobody is shown is a backlog nobody clears.
      //
      // ONCE PER DISTINCT COUNT, not once per read. A failed conversion is not
      // swept away — the row stays stale and the NEXT read tries it again, so
      // an unguarded toast here would fire every ten seconds for as long as the
      // problem lasted and bury the rest of the screen. The standing line under
      // the toggle keeps reporting it either way.
      const failed = s?.failed ?? 0;
      if (failed > 0 && failed !== failedToastedRef.current) {
        toast.error(
          `${failed} chat${failed === 1 ? '' : 's'} could not be turned into a ticket. It is recorded in the audit log.`,
        );
      }
      failedToastedRef.current = failed;
    } catch (e) {
      setQueueError(cleanErrorMessage(e, 'We could not read the queue just now.'));
    }
  }, []);

  const loadAvailability = useCallback(async () => {
    try {
      const res = await fetch('/api/support/chat/availability', { cache: 'no-store' });
      const json = (await res.json()) as Partial<AvailabilityWire> & { error?: string | null };
      // Keep the last-known toggle on a failure: a dropped request must not
      // flip the switch the agent is looking at. The next poll corrects it.
      if (!res.ok) return;
      setAvail(json as AvailabilityWire);
    } catch {
      // Same reasoning.
    }
  }, []);

  const loadThread = useCallback(async (id: string) => {
    setThreadLoading(true);
    try {
      const res = await fetch(`/api/support/chat/${encodeURIComponent(id)}/messages`, {
        cache: 'no-store',
      });
      const json = (await res.json()) as {
        session?: ThreadSessionWire | null;
        messages?: ChatMessageWire[];
        error?: string | null;
      };
      if (!res.ok) {
        toast.error(cleanErrorMessage(json.error, 'We could not open that chat.'));
        return;
      }
      setThread({ session: json.session ?? null, messages: json.messages ?? [] });
    } catch (e) {
      toast.error(cleanErrorMessage(e, 'We could not open that chat.'));
    } finally {
      setThreadLoading(false);
    }
  }, []);

  // Latest-closure refs, so the timers and the Realtime channel below are never
  // torn down just because a callback's identity changed.
  const queueRef = useRef(loadQueue);
  queueRef.current = loadQueue;
  const availRef = useRef(loadAvailability);
  availRef.current = loadAvailability;
  const threadLoadRef = useRef(loadThread);
  threadLoadRef.current = loadThread;

  const refreshAll = useCallback((withThread: boolean) => {
    void queueRef.current();
    void availRef.current();
    const id = selectedRef.current;
    if (withThread && id) void threadLoadRef.current(id);
  }, []);

  /* ── the heartbeat behind the declaration ── */

  /**
   * One beat. **A guarded UPDATE, never an upsert** — the route's own rule
   * (`availability/route.ts:353-362`): a beat from a tab that has not noticed
   * the agent toggled off in another one must not put them back on the queue.
   *
   * A 409 is therefore not a failure to retry past: it carries the TRUE state,
   * adopting it is what stops the beat, and the interval below tears itself
   * down as a consequence.
   */
  const beat = useCallback(async () => {
    try {
      const res = await fetch('/api/support/chat/availability', { method: 'POST' });
      const json = (await res.json()) as Partial<AvailabilityWire> & { error?: string | null };
      if (res.status === 409) {
        setAvail(json as AvailabilityWire);
        toast.error(cleanErrorMessage(json.error, 'You are not on the queue.'));
        return;
      }
      if (res.ok) setAvail(json as AvailabilityWire);
    } catch {
      // One dropped beat is survivable BY DESIGN: a 30s beat inside a 90s
      // window (`availability.ts`) means two have to be missed outright, and a
      // third be late, before the queue stops offering this agent anybody.
    }
  }, []);
  const beatRef = useRef(beat);
  beatRef.current = beat;

  const onQueueNow = avail?.me.on_queue === true;
  const heartbeatMs = avail && avail.heartbeat_ms > 0 ? avail.heartbeat_ms : AGENT_HEARTBEAT_MS;

  useEffect(() => {
    if (!onQueueNow) return;
    // Deliberately NOT gated on visibility, unlike the poll: the declaration is
    // explicit and it survives a backgrounded tab. Browsers throttle background
    // timers to roughly a minute, which is exactly what the 3:1 beat-to-window
    // ratio is sized to absorb.
    const id = window.setInterval(() => void beatRef.current(), heartbeatMs);
    return () => window.clearInterval(id);
  }, [onQueueNow, heartbeatMs]);

  /* ── first load ── */

  useEffect(() => {
    refreshAll(false);
  }, [refreshAll]);

  /* ── the thread follows the selection ── */

  useEffect(() => {
    // Clear BOTH before loading, on every change of selection. A failed load
    // keeps whatever it already had (see {@link loadThread}) so a dropped poll
    // does not blank a conversation mid-sentence — which would mean the
    // PREVIOUS employee's transcript sitting under the new one's header if the
    // new read 404s. And a half-typed reply must never follow the agent into
    // somebody else's chat.
    setThread(null);
    setDraft('');
    if (!selectedId) return;
    void threadLoadRef.current(selectedId);
  }, [selectedId]);

  /**
   * A chat this agent just took opens itself. Only on a CHANGE of what they
   * hold, so a deliberate click on somebody else's row is not yanked back on
   * the next poll.
   */
  const holding = queue?.me.holding ?? null;
  const lastHoldingRef = useRef<string | null>(null);
  useEffect(() => {
    if (holding === lastHoldingRef.current) return;
    lastHoldingRef.current = holding;
    if (holding) setSelectedId(holding);
  }, [holding]);

  /* ── poll floor: the guarantee underneath the socket ── */

  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      refreshAll(true);
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [refreshAll]);

  /* ── focus / visibility catch-up ── */

  useEffect(() => {
    const onWake = () => {
      if (document.visibilityState !== 'visible') return;
      refreshAll(true);
      // Beat immediately on return: a backgrounded tab's timers are throttled,
      // so the stamp may be older than the agent believes it is.
      if (onQueueNow) void beatRef.current();
    };
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('focus', onWake);
    return () => {
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('focus', onWake);
    };
  }, [refreshAll, onQueueNow]);

  /* ── the live signal: a FACT, never content (chat-live.ts) ── */

  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) {
      // No client at all: the poll above is carrying this board on its own, and
      // the pill has to say so rather than sit on "Connecting" forever.
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

    const channel = supabase.channel(CHAT_LIVE_TOPIC);
    channel.on('broadcast', { event: CHAT_LIVE_EVENT }, ({ payload }) => {
      // Untrusted input: the topic is readable AND writable by any holder of
      // the public anon key. Parse it into the typed shape; never render it.
      const p = parseChatLivePayload(payload);
      if (!p) return;
      // Any SESSION moving is this board's business — somebody joined the line,
      // an agent claimed, the sweep converted one.
      if (p.kind === 'session') {
        fire(p.sessionId === selectedRef.current);
        return;
      }
      // A MESSAGE only matters when it landed in the thread on screen.
      if (p.sessionId === selectedRef.current) fire(true);
    });
    channel.subscribe((state, err) => {
      if (state === 'SUBSCRIBED') setLive('live');
      else if (state === 'CHANNEL_ERROR' || state === 'TIMED_OUT' || state === 'CLOSED') {
        setLive('degraded');
        if (err) {
          // eslint-disable-next-line no-console
          console.warn(
            `[support-chat] Realtime ${state} — falling back to the ${POLL_MS / 1000}s poll.`,
            err,
          );
        }
      }
    });

    return () => {
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
      void supabase.removeChannel(channel);
    };
  }, [refreshAll]);

  /* ── keep the transcript pinned to the newest line ── */

  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [thread?.messages]);

  /* ── writes ── */

  const toggleOnQueue = useCallback(async (next: boolean) => {
    setTogglePending(true);
    try {
      const res = await fetch('/api/support/chat/availability', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ on_queue: next }),
      });
      const json = (await res.json()) as Partial<AvailabilityWire> & { error?: string | null };
      if (!res.ok) {
        toast.error(cleanErrorMessage(json.error, 'We could not change that. Nothing was saved.'));
        return;
      }
      setAvail(json as AvailabilityWire);
      toast.success(
        next
          ? "You're on the queue. Employees are being told somebody is here."
          : "You're off the queue.",
      );
      void queueRef.current();
    } catch (e) {
      toast.error(cleanErrorMessage(e, 'We could not change that. Nothing was saved.'));
    } finally {
      setTogglePending(false);
    }
  }, []);

  /**
   * Take the next waiter — never a specific one (see the file docstring).
   *
   * Rule 3: a 409 is the answer. The route's own sentence already states that
   * nothing was recorded, so it is shown as-is and the board re-reads. There is
   * no retry: the next click claims whoever is at the front by then.
   */
  const claimNext = useCallback(async () => {
    setClaiming(true);
    try {
      const res = await fetch('/api/support/chat/queue', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'claim' }),
      });
      const json = (await res.json()) as {
        session?: QueueSessionWire | null;
        error?: string | null;
      };
      if (!res.ok) {
        const message = cleanErrorMessage(json.error, 'Nothing was recorded. Refresh the queue.');
        if (res.status === 409) toast.warning(message);
        else toast.error(message);
        // Whatever the refusal was, this board is now behind the truth.
        void queueRef.current();
        // A 409 that came WITH a session is "you already hold this one" — open
        // it, rather than leaving the agent hunting for the chat they hold.
        if (json.session?.id) setSelectedId(json.session.id);
        return;
      }
      if (json.session?.id) {
        setSelectedId(json.session.id);
        toast.success(`You have ${formatChatSessionNo(json.session.session_no)}.`);
      }
      void queueRef.current();
    } catch (e) {
      toast.error(cleanErrorMessage(e, 'Nothing was recorded. Refresh the queue.'));
    } finally {
      setClaiming(false);
    }
  }, []);

  const runAction = useCallback(async (action: 'release' | 'end', sessionId: string) => {
    setActioning(true);
    try {
      const res = await fetch('/api/support/chat/queue', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, session_id: sessionId }),
      });
      const json = (await res.json()) as { error?: string | null };
      if (!res.ok) {
        const message = cleanErrorMessage(json.error, 'Nothing was changed. Refresh the queue.');
        if (res.status === 409) toast.warning(message);
        else toast.error(message);
        void queueRef.current();
        return;
      }
      toast.success(
        action === 'release'
          ? 'Handed back. They keep the place they already had.'
          : 'Chat closed.',
      );
      setConfirm(null);
      void queueRef.current();
      void threadLoadRef.current(sessionId);
    } catch (e) {
      toast.error(cleanErrorMessage(e, 'Nothing was changed. Refresh the queue.'));
    } finally {
      setActioning(false);
    }
  }, []);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || !selectedId || sending) return;
    setSending(true);
    try {
      const res = await fetch(`/api/support/chat/${encodeURIComponent(selectedId)}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: text }),
      });
      const json = (await res.json()) as { message?: ChatMessageWire | null; error?: string | null };
      if (!res.ok || !json.message) {
        toast.error(cleanErrorMessage(json.error, 'That did not send. Nothing was saved.'));
        // Every refusal on this route is a STATE one — "claim this chat first",
        // "somebody else is holding it", "this chat has ended" — so re-read
        // instead of leaving the screen disagreeing with the server.
        void queueRef.current();
        void threadLoadRef.current(selectedId);
        return;
      }
      // The row the SERVER returned, never an optimistic copy of the draft: the
      // transcript IS the ticket's content if this chat is ever converted, and
      // a line that existed only in this browser would be missing from it while
      // looking sent.
      const saved = json.message;
      setThread((prev) =>
        prev
          ? {
              ...prev,
              messages: prev.messages.some((m) => m.id === saved.id)
                ? prev.messages
                : [...prev.messages, saved],
            }
          : prev,
      );
      setDraft('');
      // The first reply flips `claimed` → `live` server-side; re-read so the
      // status chip and the Hand-back button agree with the row.
      void queueRef.current();
    } catch (e) {
      toast.error(cleanErrorMessage(e, 'That did not send. Nothing was saved.'));
    } finally {
      setSending(false);
    }
  }, [draft, selectedId, sending]);

  /* ── derived ── */

  const migrated = queue?.migrated ?? null;

  /**
   * Rule 2: THE comparator. The route already sorted with it (`sortQueue`);
   * re-applying it here means the board and the place the employee is watching
   * cannot come from two different orderings, whatever order the JSON arrived
   * in. `QueueSessionWire` carries `id` and `queued_at`, which is exactly the
   * `QueueRank` this takes.
   */
  const line = useMemo(() => (queue ? [...queue.waiting].sort(compareQueueRank) : []), [queue]);
  const engaged = queue?.engaged ?? [];
  const myEmail = (queue?.me.email ?? avail?.me.email ?? '').trim().toLowerCase();
  const holdingId = queue?.me.holding ?? null;

  const selected = thread?.session ?? null;
  // Same rule as {@link SessionRow}: the display form, never the storage key.
  const selectedDeptLabel = formatDeptLabel(selected?.department ?? null);
  const selectedIsMine =
    selected !== null &&
    !!selected.claimed_by &&
    selected.claimed_by.trim().toLowerCase() === myEmail &&
    myEmail !== '';
  const canType =
    canEdit &&
    migrated === true &&
    selectedIsMine &&
    (selected?.status === 'claimed' || selected?.status === 'live');
  // RELEASE is guarded on `status = 'claimed'` (queue route `:846`): once the
  // first reply has flipped the row to `live` there is nothing to hand back, so
  // the button is not drawn rather than drawn to 409.
  const canRelease = canEdit && selectedIsMine && selected?.status === 'claimed';
  const canEnd =
    canEdit && selectedIsMine && (selected?.status === 'claimed' || selected?.status === 'live');
  const overLimit = draft.length > SUPPORT_CONCERN_MAX;

  /* ── render ── */

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-4 sm:p-6 sm:pt-4">
      {/* The migration has not run. Said in this surface's own words: nothing
          here would be saved, and an agent must not sit watching an empty board
          believing the queue is simply quiet. */}
      {migrated === false && (
        <div className="flex items-start gap-2.5 rounded-xl border border-destructive/40 bg-destructive/10 p-3">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
          <div>
            <p className="text-[13px] font-semibold text-foreground">
              Live chat is not switched on yet
            </p>
            <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
              The chat tables have not been migrated, so nobody can start a chat and nothing sent
              from here would be saved. This board is empty because the feature is off — not
              because the queue is.
            </p>
          </div>
        </div>
      )}

      {queueError && migrated !== false && (
        <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11.5px] leading-relaxed text-amber-300">
          {queueError} Nothing was changed — what is below is the last state we could read.
        </p>
      )}

      <OnQueueCard
        me={avail?.me ?? null}
        availability={avail?.availability ?? null}
        staleAfterMs={avail?.stale_after_ms ?? 0}
        canEdit={canEdit}
        pending={togglePending}
        migrated={migrated}
        onToggle={(next) => void toggleOnQueue(next)}
        live={live}
      />

      {/* What the lazy sweep did (Kane's Q1). `INDEX.md:42` — never a cron — so
          this runs on the queue READ, and its result is reported here rather
          than left to be discovered in the audit log. */}
      {lastSweep && (
        <p className="flex items-start gap-2 rounded-lg border border-border bg-card px-3 py-1.5 text-[11.5px] leading-relaxed text-muted-foreground">
          <Ticket className="mt-px size-3.5 shrink-0" aria-hidden />
          <span>
            <span className="tabular-nums">{clockLabel(lastSweep.at)}</span>
            {' — '}
            {lastSweep.report.converted > 0 &&
              `${lastSweep.report.converted} unanswered chat${lastSweep.report.converted === 1 ? '' : 's'} became a support ticket. `}
            {lastSweep.report.released > 0 &&
              `${lastSweep.report.released} claim${lastSweep.report.released === 1 ? '' : 's'} went back to the line at their original place. `}
            {lastSweep.report.ended > 0 && `${lastSweep.report.ended} closed. `}
            {lastSweep.report.completed > 0 && `${lastSweep.report.completed} finished. `}
            {lastSweep.report.deferred > 0 &&
              `${lastSweep.report.deferred} left for the next read. `}
            {lastSweep.report.failed > 0 && (
              <span className="text-amber-300">
                {lastSweep.report.failed} could not be converted — recorded in the audit log.
              </span>
            )}
          </span>
        </p>
      )}

      <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[21rem_1fr]">
        {/* ── the line ── */}
        <section className="flex min-h-0 flex-col rounded-xl border border-border bg-card">
          <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2.5">
            <h2 className="text-[13px] font-semibold text-foreground">In line</h2>
            {/* Rule 1: a count we have not read is a shimmer, never a 0. */}
            {queueKnown ? (
              <span className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] font-bold tabular-nums text-foreground">
                {line.length}
              </span>
            ) : (
              <Shimmer className="w-6" />
            )}
            <Button
              size="sm"
              className="ml-auto"
              disabled={
                !canEdit || claiming || migrated === false || !queueKnown || line.length === 0
              }
              title={
                canEdit
                  ? 'Take the person who has waited longest'
                  : 'Answering needs the edit grant on Support Chat'
              }
              onClick={() => void claimNext()}
            >
              {claiming ? (
                <Loader2 className="animate-spin" data-icon="inline-start" aria-hidden />
              ) : (
                <UserRound data-icon="inline-start" aria-hidden />
              )}
              Take next
            </Button>
          </div>

          <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2">
            {!queueKnown ? (
              // Cold paint: a skeleton, NOT "nobody is waiting". That sentence
              // is a claim, and we have not earned it until a read lands.
              <div className="space-y-1.5">
                <Skeleton className="h-12 rounded-lg" />
                <Skeleton className="h-12 rounded-lg" />
                <Skeleton className="h-12 rounded-lg" />
              </div>
            ) : line.length === 0 ? (
              <p className="flex flex-col items-center gap-1.5 px-3 py-8 text-center text-[11.5px] text-muted-foreground">
                <Inbox className="size-5" aria-hidden />
                Nobody is waiting right now.
              </p>
            ) : (
              line.map((session, index) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  rank={index + 1}
                  mine={false}
                  selected={selectedId === session.id}
                  onSelect={() => setSelectedId(session.id)}
                />
              ))
            )}

            {engaged.length > 0 && (
              <>
                <p className="px-1 pt-3 pb-1 text-[10.5px] font-semibold tracking-wide text-muted-foreground uppercase">
                  In conversation
                </p>
                {engaged.map((session) => (
                  <SessionRow
                    key={session.id}
                    session={session}
                    rank={null}
                    mine={session.id === holdingId}
                    selected={selectedId === session.id}
                    onSelect={() => setSelectedId(session.id)}
                  />
                ))}
              </>
            )}
          </div>
        </section>

        {/* ── the conversation ── */}
        <section className="flex min-h-0 flex-col rounded-xl border border-border bg-card">
          {!selectedId ? (
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
              <MessageCircle className="size-6 text-muted-foreground" aria-hidden />
              <p className="max-w-sm text-[12.5px] leading-relaxed text-muted-foreground">
                Pick somebody from the line to read what they have written, or take the next waiter
                to start answering.
              </p>
            </div>
          ) : (
            <>
              <div className="flex shrink-0 flex-wrap items-center gap-x-2.5 gap-y-1 border-b border-border px-3 py-2.5">
                {!selected ? (
                  threadLoading ? (
                    <Skeleton className="h-4 w-56" />
                  ) : (
                    <p className="text-[12px] text-muted-foreground">That chat is no longer here.</p>
                  )
                ) : (
                  <>
                    <span className="font-mono text-[11px] text-muted-foreground">
                      {formatChatSessionNo(selected.session_no)}
                    </span>
                    <h2 className="truncate text-[13px] font-semibold text-foreground">
                      {personLabel(selected.member_name, selected.work_email)}
                    </h2>
                    <StatusChip status={selected.status} />
                    <span className="truncate text-[11px] text-muted-foreground">
                      {selectedDeptLabel ? `${selectedDeptLabel} · ` : ''}
                      joined {relativeTime(selected.queued_at)}
                    </span>
                    {selected.claimed_by && !selectedIsMine && (
                      <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10.5px] text-muted-foreground">
                        held by {personLabel(null, selected.claimed_by)}
                      </span>
                    )}
                    <div className="ml-auto flex items-center gap-1.5">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Reload this chat"
                        title="Reload this chat"
                        onClick={() => void loadThread(selectedId)}
                      >
                        <RefreshCw className={cn(threadLoading && 'animate-spin')} aria-hidden />
                      </Button>
                      {canRelease && (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={actioning}
                          onClick={() => setConfirm('release')}
                        >
                          <Undo2 data-icon="inline-start" aria-hidden />
                          Hand back
                        </Button>
                      )}
                      {canEnd && (
                        <Button
                          variant="destructive"
                          size="sm"
                          disabled={actioning}
                          onClick={() => setConfirm('end')}
                        >
                          <CheckCircle2 data-icon="inline-start" aria-hidden />
                          End chat
                        </Button>
                      )}
                    </div>
                  </>
                )}
              </div>

              <div
                ref={threadRef}
                className="min-h-0 flex-1 space-y-2 overflow-y-auto bg-background/40 p-3"
              >
                {threadLoading && !thread ? (
                  <div className="space-y-2">
                    <Skeleton className="h-8 w-2/3 rounded-2xl" />
                    <Skeleton className="ml-auto h-8 w-1/2 rounded-2xl" />
                    <Skeleton className="h-8 w-3/5 rounded-2xl" />
                  </div>
                ) : (thread?.messages.length ?? 0) === 0 ? (
                  <p className="py-6 text-center text-[11.5px] text-muted-foreground">
                    Nothing has been written in this chat yet.
                  </p>
                ) : (
                  <AnimatePresence initial={false}>
                    {(thread?.messages ?? []).map((m) => (
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
                {canType ? (
                  <div className="space-y-2">
                    <textarea
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          void send();
                        }
                      }}
                      rows={2}
                      placeholder="Answer them…"
                      className="w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-[13px] leading-relaxed text-foreground placeholder:text-muted-foreground focus:border-primary/50 focus:ring-1 focus:ring-primary/30 focus:outline-none"
                    />
                    <div className="flex items-center justify-between gap-2">
                      {/* The route refuses over the bound with a sentence; this
                          counter is so a long answer never dies in a 400. */}
                      {draft.length > SUPPORT_CONCERN_MAX - 400 ? (
                        <span
                          className={cn(
                            'text-[11px] tabular-nums',
                            overLimit ? 'font-semibold text-destructive' : 'text-muted-foreground',
                          )}
                        >
                          {draft.length} / {SUPPORT_CONCERN_MAX}
                        </span>
                      ) : (
                        <span />
                      )}
                      <Button
                        size="sm"
                        disabled={sending || overLimit || draft.trim().length === 0}
                        onClick={() => void send()}
                      >
                        {sending ? (
                          <Loader2 className="animate-spin" data-icon="inline-start" aria-hidden />
                        ) : (
                          <Send data-icon="inline-start" aria-hidden />
                        )}
                        Send
                      </Button>
                    </div>
                  </div>
                ) : (
                  <p className="text-[11.5px] leading-relaxed text-muted-foreground">
                    {!canEdit
                      ? 'You can read this conversation but not answer it. Replying needs the edit grant on Support Chat.'
                      : selected?.status === 'waiting'
                        ? 'Nobody has taken this chat yet. Use "Take next" — it gives you whoever has waited longest, which may not be this person.'
                        : selectedIsMine
                          ? 'This conversation is closed. Everything written in it is kept.'
                          : 'Somebody else is holding this conversation. You are reading it, not in it.'}
                  </p>
                )}
              </div>
            </>
          )}
        </section>
      </div>

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        title={confirm === 'release' ? 'Hand this chat back?' : 'End this chat?'}
        description={
          confirm === 'release'
            ? 'They return to the line at the place they already had — a position never rises. You are then free to take the next waiter.'
            : 'The conversation closes and the whole transcript is kept. It does not become a ticket: only a chat nobody ever answered earns an ES- number.'
        }
        confirmLabel={confirm === 'release' ? 'Hand back' : 'End chat'}
        destructive={confirm === 'end'}
        busy={actioning}
        onConfirm={() => {
          if (!confirm || !selectedId) return;
          void runAction(confirm, selectedId);
        }}
      />
    </div>
  );
}
