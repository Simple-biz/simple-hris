'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  AlertTriangle,
  CheckCircle2,
  Info,
  Loader2,
  LogOut,
  MessageCircle,
  Send,
  Ticket,
  Users,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { cleanErrorMessage } from '@/lib/clean-error-message';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';
import { SUPPORT_CLOSE_HOUR, SUPPORT_OPEN_HOUR, isSupportOpen } from '@/lib/support/hours';
import {
  SUPPORT_CONCERN_MAX,
  SUPPORT_REPLY_PROMISE,
  formatSupportTicketNo,
} from '@/lib/support/types';
import { CHAT_LIVE_EVENT, CHAT_LIVE_TOPIC, type ChatLivePayload } from '@/lib/support/chat-live';
import { isOpenChatSession, type ChatSessionStatus } from '@/lib/support/chat-types';
import { QUEUE_UNRESOLVED, type QueueState } from '@/lib/support/queue';

/**
 * Employee Support LIVE CHAT — the employee's entry point.
 *
 * Plan: docs/superpowers/plans/2026-09-19-employee-support-chat.md (task 17).
 * Routes: app/api/employee/support/chat/route.ts and .../chat/[id]/messages.
 *
 * THIS IS NOT A FLOATING BUBBLE, AND IT MUST NOT BECOME ONE
 * ---------------------------------------------------------------------------
 * The employee side has exactly ONE fixed bottom-right control and Penny owns
 * it (`docs/features/employee-penny-ai.md:143-146`), with a four-value geometry
 * chain — bubble, panel, balloon, height subtrahend — measured against that
 * corner. A second floating launcher is two support desks in one corner, and
 * the first thing it would do is cover Penny. So the entry point is a button in
 * the dashboard's header cluster, beside FAQs, in BOTH mirrored clusters, and
 * the conversation lives in a dialog. If somebody later "improves" this into a
 * launcher pinned to a corner, they are re-opening a closed decision.
 *
 * FOUR RULES THIS FILE EXISTS TO HOLD
 * ---------------------------------------------------------------------------
 * 1. **A position renders as a SKELETON until it resolves, never as `0`.**
 *    "Nobody is waiting" and "we cannot tell" are different states (plan
 *    `:91-92`), and the route says which one it means with `queue.resolved`.
 *    `resolved: false` paints {@link QueuePlaceholder}. There is no code path
 *    in this file that turns an unknown place into a number.
 * 2. **A position is NEVER clamped.** `NotificationBellButton` renders `99+`
 *    over 99 unread, and copying that here would be a lie of a different kind:
 *    100th in line is a queue the employee deserves to be told about honestly
 *    so they can decide to file a ticket instead. The badge grows; it does not
 *    round.
 * 3. **An estimate is never a promise.** The copy says "your place in the
 *    line" and says outright that it is not a time. There is no countdown and
 *    no "about N minutes" anywhere, by design (plan `:28`).
 * 4. **The queue entry survives the modal.** Closing this dialog does not leave
 *    the queue — leaving is the explicit button, which calls DELETE. The copy
 *    states that where the employee can see it, because a position that
 *    silently evaporates is the same as not having one.
 *
 * WHY THE SHIPPED AVAILABILITY SENTENCE IS NOT REUSED
 * ---------------------------------------------------------------------------
 * `describeSupportAvailability` (`src/lib/support/hours.ts:106-123`) is written
 * for the TICKET form and promises "you can still send this — someone picks it
 * up when they are back". That is TRUE of a ticket and FALSE of a live queue:
 * out of hours nobody is going to join the chat. So this surface writes its own
 * sentence from the same primitives (`isSupportOpen` + the exported hour
 * constants — NOT `describeSupportHours`, which prints a Manila zone nobody is
 * in now that Kane has ruled every employee is on EST; see
 * `describeChatAvailability` below), and the shipped formatters are left
 * exactly as the ticket form needs them. One
 * formatter covering two different promises is how one of them goes quietly
 * wrong — the same reasoning as `PayrollLockBanner`'s required per-surface
 * `detail` prop.
 *
 * WHICH COPY ENCODES WHICH RULING (so a reversal is surgical)
 * ---------------------------------------------------------------------------
 * Q1 — "an unanswered chat becomes a ticket" — is the only ruling this file
 * asserts, and it asserts it in exactly two places: {@link BecomesATicketNote}
 * and {@link AbandonedPanel}. Q2 (the transcript persists) shows up as the fact
 * that a thread is rendered at all. Q3 (the support role) and Q4 (the agent
 * toggle) are NOT visible here — the employee route hands this component no
 * agent count and no agent identity on purpose, so there is nothing on this
 * surface that would have to change if either were re-decided.
 */

/* ────────────────────────────── the wire ─────────────────────────────── */

/**
 * Exactly what `GET /api/employee/support/chat` answers with. Restated here
 * rather than imported because a route module is server-only — `SESSION_SELECT`
 * and the wire type live next to each other there, and the day they change this
 * block is the diff that has to change with them.
 */
type ChatSessionWire = {
  id: string;
  session_no: number;
  status: ChatSessionStatus;
  queued_at: string;
  claimed_at: string | null;
  ended_at: string | null;
  last_seen_at: string;
  became_ticket_id: string | null;
  became_ticket_at: string | null;
  created_at: string;
  /** The ES- number an expired chat turned into. Null until the sweep runs. */
  became_ticket_no: number | null;
};

type ChatMessageWire = {
  id: string;
  author_side: 'employee' | 'agent' | 'system';
  author_name: string | null;
  body: string;
  created_at: string;
};

/**
 * `QueueState` and `QUEUE_UNRESOLVED` come from `@/lib/support/queue` — see the
 * import above. They were declared locally here until 2026-09-21, which meant
 * three copies of one ordering rule (this file, the employee route, and the
 * module nothing called) and three chances to disagree about what a position
 * means. `resolved: false` MEANS WE CANNOT TELL: it is not "zero", and the two
 * must never render the same — rule 1 in the header.
 *
 * `isOpenChatSession` likewise comes from `chat-types.ts`, which is where the
 * status vocabulary agrees with the SQL's partial indexes.
 */

/* ──────────────────────────── poll cadences ──────────────────────────── */

/**
 * Cadences live HERE and not in `chat-live.ts` on purpose.
 *
 * The topic, the event name and the payload are a CONTRACT — the server writes
 * them and this file reads them, so they must be one shared definition. How
 * often a particular surface falls back to polling is not a contract, it is a
 * cost decision per surface, and the employee's own queue entry and the agent's
 * whole-queue board have no reason to share one. The employee's GET pages the
 * entire waiting set to work out a rank, so an idle dashboard polling it every
 * 15s would be the most expensive thing on the page.
 *
 * Hence: fast only while the dialog is open, slow while a session exists but
 * the dialog is shut (the badge still has to be honest), and NOTHING AT ALL
 * when the employee has no session — nobody can put them in a queue but
 * themselves, so there is nothing to discover. Focus and visibility still catch
 * up in every case.
 */
const POLL_OPEN_MS = 10_000;
const POLL_BACKGROUND_MS = 45_000;
/** Coalesce a burst of broadcasts (an agent claiming three chats) into one reload. */
const LIVE_DEBOUNCE_MS = 400;
/** Re-render the availability sentence so it flips at 9 AM and 5 PM Eastern without a reload. */
const CLOCK_TICK_MS = 60_000;

/* ─────────────────────────────── copy ────────────────────────────────── */

/**
 * The support window, said in the way a LIVE QUEUE has to say it.
 *
 * TWO departures from the shipped helpers, and both are deliberate.
 *
 * 1. Not `describeSupportAvailability`: it tells the employee their message is
 *    still accepted, which is true of a ticket and false of a chat nobody is
 *    sitting in. Promising a pickup that is not coming is the one thing this
 *    surface must not do.
 *
 * 2. Not `describeSupportHours`, which renders BOTH zones — "9 AM – 5 PM
 *    Eastern (9 PM – 5 AM Manila)". That string was written to protect a
 *    Manila-based reader from a bare "9 AM – 5 PM", and **Kane overturned its
 *    premise on 2026-09-19: "every employee is on EST so dont mind the time
 *    zone please"** (plan `:28`). Printing a second zone nobody in the company
 *    is in is now noise in front of someone deciding whether to wait.
 *
 * `hours.ts` is NOT edited for this. Its other caller is the ticket form, whose
 * copy is a separate decision and not this feature's to make — so the Eastern
 * sentence is built here, from the same exported constants, and the shipped
 * dual-zone formatter keeps working unchanged for whoever still wants it.
 */
function describeChatAvailability(at: Date): string {
  const hours = `${hour12(SUPPORT_OPEN_HOUR)} – ${hour12(SUPPORT_CLOSE_HOUR)} Eastern, Mon–Fri`;
  return isSupportOpen(at)
    ? `Support is open now — ${hours}.`
    : `Support is closed right now, so nobody is likely to join until we are back — ${hours}.`;
}

/** `9` → `9 AM`, `17` → `5 PM`. Local to this file; the window is whole hours. */
function hour12(hour24: number): string {
  const suffix = hour24 < 12 ? 'AM' : 'PM';
  const h = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${h} ${suffix}`;
}

/** `1st`, `2nd`, `3rd`, `11th`. Used for a place in a line, never for a count. */
function ordinal(n: number): string {
  const abs = Math.abs(Math.trunc(n));
  const tens = abs % 100;
  if (tens >= 11 && tens <= 13) return `${abs}th`;
  switch (abs % 10) {
    case 1:
      return `${abs}st`;
    case 2:
      return `${abs}nd`;
    case 3:
      return `${abs}rd`;
    default:
      return `${abs}th`;
  }
}

function clockLabel(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/* ───────────────────────── the header control ────────────────────────── */

/**
 * What the header button needs to know. Emitted by {@link EmployeeSupportChat}
 * through `onStateChange` so the two mirrored clusters and the dialog cannot
 * disagree about what is happening — the same split `GiftShippingCard` uses for
 * its bell (`GiftShippingCard.tsx:53-81`).
 */
export type SupportChatState = {
  /** `'none'` when the employee has no session at all, or before the first load lands. */
  status: ChatSessionStatus | 'none';
  /** The caller's 1-based place. Null when they are not in the line OR when we cannot tell. */
  position: number | null;
  /** FALSE means the position is UNKNOWN. The badge shows a shimmer, never a number. */
  queueResolved: boolean;
  /** Null until a route has actually established it. False = the migration has not run. */
  migrated: boolean | null;
  /**
   * Something is waiting for the employee's eyes: an agent is with them, or the
   * ES- number their chat became has arrived.
   *
   * Deliberately NOT an unread-message count. There is no `last_read_at` column
   * on the sessions table, so an unread marker could only live in this browser
   * — and one that resets on reload would paint a permanent red dot on a
   * transcript the employee has already read. A dot that means "there is a
   * state change here" is a thing this code can actually prove.
   */
  needsAttention: boolean;
};

const IDLE_STATE: SupportChatState = {
  status: 'none',
  position: null,
  queueResolved: false,
  migrated: null,
  needsAttention: false,
};

/**
 * The control that goes in the dashboard header cluster, beside FAQs.
 *
 * One component with two renderings rather than two blocks of markup: the
 * mobile cluster is icon-only 9x9 pills and the desktop cluster is labelled
 * `size="sm"` pills, and the pair has to stay in step. Two copies is how they
 * drift the first time one of them is improved.
 */
export function SupportChatButton({
  state,
  onClick,
  variant,
}: {
  state: SupportChatState;
  onClick: () => void;
  variant: 'icon' | 'labelled';
}) {
  const label = (() => {
    if (state.status === 'waiting') {
      if (!state.queueResolved || state.position === null)
        return 'Live chat — working out your place in the line';
      return `Live chat — you are ${ordinal(state.position)} in line`;
    }
    if (state.status === 'claimed' || state.status === 'live') return 'Live chat — someone is with you';
    if (state.status === 'abandoned') return 'Live chat — your chat became a support ticket';
    if (state.status === 'ended') return 'Live chat';
    return 'Live chat with Employee Support';
  })();

  const badge = (() => {
    // A place we do not know yet is a shimmer. See rule 1 — never a `0`, and
    // never an optimistic "1" while the first read is in flight.
    if (state.status === 'waiting' && (!state.queueResolved || state.position === null)) {
      return (
        <Skeleton className="pointer-events-none absolute -right-1 -top-1 h-4 min-w-[1.1rem] rounded-full ring-2 ring-white dark:ring-zinc-900" />
      );
    }
    if (state.status === 'waiting' && state.position !== null) {
      return (
        <motion.span
          key={state.position}
          initial={{ scale: 0.5, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: 'spring', stiffness: 420, damping: 14 }}
          className="pointer-events-none absolute -right-1 -top-1 inline-flex min-w-[1.1rem] items-center justify-center rounded-full bg-gradient-to-br from-orange-500 to-amber-500 px-1 py-px text-[9px] font-bold tabular-nums text-white ring-2 ring-white dark:ring-zinc-900"
          aria-hidden
        >
          {/* NO `99+` CLAMP. See rule 2 — a hundredth place is exactly the
              number somebody needs in order to decide not to wait. */}
          {state.position}
        </motion.span>
      );
    }
    if (state.needsAttention) {
      const tone = state.status === 'abandoned' ? 'bg-amber-500' : 'bg-emerald-500';
      return (
        <>
          <span
            className={cn(
              'pointer-events-none absolute right-1 top-1 inline-flex h-2.5 w-2.5 rounded-full ring-2 ring-white dark:ring-zinc-900',
              tone,
            )}
            aria-hidden
          />
          <span
            className={cn(
              'pointer-events-none absolute right-1 top-1 inline-flex h-2.5 w-2.5 animate-ping rounded-full opacity-75',
              tone,
            )}
            aria-hidden
          />
        </>
      );
    }
    return null;
  })();

  if (variant === 'icon') {
    return (
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="relative h-9 w-9 rounded-full border-zinc-200 bg-white/90 text-zinc-700 shadow-sm hover:border-orange-300 hover:bg-orange-50 hover:text-orange-600 dark:border-zinc-800 dark:bg-zinc-900/70 dark:text-zinc-300 dark:hover:border-orange-900/60 dark:hover:bg-orange-950/30 dark:hover:text-orange-400"
        title={label}
        aria-label={label}
        onClick={onClick}
      >
        <MessageCircle className="size-4.5" aria-hidden />
        {badge}
      </Button>
    );
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="relative h-8 gap-1.5 border-zinc-200 bg-white/70 text-xs font-medium text-zinc-700 hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-300 dark:hover:border-zinc-700"
      title={label}
      aria-label={label}
      onClick={onClick}
    >
      <MessageCircle className="size-3.5" aria-hidden />
      Chat
      {badge}
    </Button>
  );
}

/* ──────────────────────────── dialog blocks ──────────────────────────── */

/**
 * The cannot-tell state, in the shape of the thing it is standing in for.
 *
 * `inLine` is not decoration. This block stands in for two different unknowns —
 * "we have not read anything yet" and "you ARE waiting but the count has not
 * resolved" — and the reassurance "you are still in it" is only true of the
 * second. Told to somebody who has no session, it would be an invention.
 */
function QueuePlaceholder({ inLine }: { inLine: boolean }) {
  return (
    <div className="rounded-xl border border-orange-100/80 bg-white/80 p-3.5 dark:border-orange-900/30 dark:bg-zinc-900/50">
      <div className="flex items-center gap-3">
        <Skeleton className="h-10 w-10 rounded-xl" />
        <div className="min-w-0 flex-1 space-y-1.5">
          <Skeleton className="h-3.5 w-36" />
          <Skeleton className="h-3 w-52" />
        </div>
      </div>
      <p className="mt-2.5 text-[11.5px] leading-relaxed text-zinc-500 dark:text-zinc-400">
        {inLine
          ? 'Working out your place in the line. You are still in it — this is only the count catching up.'
          : 'Checking whether you have a chat open.'}
      </p>
    </div>
  );
}

/**
 * Q1, said to somebody who has not joined yet.
 *
 * This sentence is the ruling "an unanswered chat becomes a ticket" made
 * visible. If that ruling is ever reversed, this component and
 * {@link AbandonedPanel} are the two places to change and there are no others.
 */
function BecomesATicketNote() {
  return (
    <div className="flex items-start gap-2.5 rounded-xl border border-blue-100 bg-blue-50/60 p-3 dark:border-blue-950/60 dark:bg-blue-950/25">
      <Info className="mt-0.5 size-3.5 shrink-0 text-blue-600 dark:text-blue-300" aria-hidden />
      <p className="text-[11.5px] leading-relaxed text-blue-900/90 dark:text-blue-200/90">
        Nothing you type here is lost. If nobody is able to pick your chat up, we turn the whole
        conversation into a support ticket with its own number and answer it {SUPPORT_REPLY_PROMISE}.
      </p>
    </div>
  );
}

/**
 * Q1, said to somebody it actually happened to.
 *
 * The number may not be here yet: the conversion sweeps lazily on read and the
 * ticket tables ship in a separate migration, so `became_ticket_no` is null for
 * a window. That window gets an honest sentence rather than a blank or a
 * fabricated number.
 */
function AbandonedPanel({ ticketNo }: { ticketNo: number | null }) {
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50/70 p-3.5 dark:border-amber-900/50 dark:bg-amber-950/25">
      <div className="flex items-start gap-2.5">
        <Ticket className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-300" aria-hidden />
        <div className="min-w-0">
          <p className="text-[13px] font-semibold text-amber-900 dark:text-amber-100">
            Nobody was able to pick this up
          </p>
          {ticketNo !== null ? (
            <p className="mt-1 text-[12px] leading-relaxed text-amber-800/90 dark:text-amber-200/90">
              Your conversation is now support ticket{' '}
              <span className="font-semibold tabular-nums">{formatSupportTicketNo(ticketNo)}</span>, and
              somebody answers it {SUPPORT_REPLY_PROMISE}. Everything you wrote below went with it.
            </p>
          ) : (
            <p className="mt-1 text-[12px] leading-relaxed text-amber-800/90 dark:text-amber-200/90">
              We are turning this conversation into a support ticket so it is not lost. The number
              appears here once it is made.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/** One line of transcript. The three author sides read differently on purpose. */
function MessageBubble({ message }: { message: ChatMessageWire }) {
  const at = clockLabel(message.created_at);

  if (message.author_side === 'system') {
    return (
      <div className="flex justify-center py-0.5">
        <span className="rounded-full bg-zinc-100 px-2.5 py-1 text-[10.5px] text-zinc-500 dark:bg-zinc-800/70 dark:text-zinc-400">
          {message.body}
          {at ? ` · ${at}` : ''}
        </span>
      </div>
    );
  }

  const mine = message.author_side === 'employee';
  return (
    <div className={cn('flex w-full', mine ? 'justify-end' : 'justify-start')}>
      <div className={cn('min-w-0 max-w-[85%]', mine ? 'text-right' : 'text-left')}>
        {!mine && message.author_name && (
          <p className="mb-0.5 px-1 text-[10.5px] font-medium text-zinc-500 dark:text-zinc-400">
            {message.author_name}
          </p>
        )}
        <div
          className={cn(
            'inline-block whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-left text-[12.5px] leading-relaxed',
            mine
              ? 'bg-gradient-to-br from-orange-500 to-rose-500 text-white'
              : 'border border-zinc-200 bg-white text-zinc-800 dark:border-zinc-800 dark:bg-zinc-900/70 dark:text-zinc-100',
          )}
        >
          {message.body}
        </div>
        {at && (
          <p className="mt-0.5 px-1 text-[10px] tabular-nums text-zinc-400 dark:text-zinc-500">{at}</p>
        )}
      </div>
    </div>
  );
}

/* ─────────────────────────── the component ───────────────────────────── */

interface Props {
  /** The signed-in employee's lower-cased email — the `?email=` the route authorizes against. */
  email: string;
  /** External dialog control, so both header clusters open the same modal. */
  dialogOpen: boolean;
  onDialogOpenChange: (open: boolean) => void;
  /**
   * Emits whenever the session or the queue moves so the header buttons can
   * badge. Fires once after the first load too, exactly like
   * `GiftShippingCard`'s `onStateChange`.
   */
  onStateChange?: (state: SupportChatState) => void;
}

export default function EmployeeSupportChat({
  email,
  dialogOpen,
  onDialogOpenChange,
  onStateChange,
}: Props) {
  const [firstLoadDone, setFirstLoadDone] = useState(false);
  /** Null until a route established it. False means the migration has not run. */
  const [migrated, setMigrated] = useState<boolean | null>(null);
  const [session, setSession] = useState<ChatSessionWire | null>(null);
  const [queue, setQueue] = useState<QueueState>(QUEUE_UNRESOLVED);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [messages, setMessages] = useState<ChatMessageWire[]>([]);
  const [threadLoading, setThreadLoading] = useState(false);

  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [entering, setEntering] = useState(false);
  const [leaving, setLeaving] = useState(false);

  /** Re-rendered on a timer so the support-hours sentence flips without a reload. */
  const [clock, setClock] = useState(() => new Date());

  const sessionId = session?.id ?? null;
  const status: ChatSessionStatus | 'none' = session?.status ?? 'none';
  const canType = session !== null && isOpenChatSession(session.status) && migrated === true;

  const threadRef = useRef<HTMLDivElement | null>(null);
  const debounceRef = useRef<number | null>(null);

  /* ── reads ── */

  const loadSession = useCallback(async () => {
    try {
      const res = await fetch(`/api/employee/support/chat?email=${encodeURIComponent(email)}`, {
        cache: 'no-store',
      });
      const json = (await res.json()) as {
        migrated?: boolean;
        session?: ChatSessionWire | null;
        queue?: QueueState;
        error?: string | null;
      };
      // `migrated` is absent on the two failures that never reached the
      // database (no service client, no identity). Absent is NOT false: saying
      // "chat is not switched on" when the truth is "we could not look" sends
      // the employee to the wrong place. So the flag only moves when the route
      // actually carried one.
      if (typeof json.migrated === 'boolean') setMigrated(json.migrated);
      if (!res.ok) {
        // A FAILED READ DOES NOT CLEAR A KNOWN SESSION. The 503 shapes carry
        // `session: null` because the route could not look, not because there
        // is nothing there — writing that null through would drop the badge,
        // offer "Start a chat" to somebody already tenth in line, and make the
        // queue look like the thing it promises never to be. Last-known state
        // stays on screen under an honest error line; the next poll corrects it.
        setLoadError(cleanErrorMessage(json.error, 'We could not check your chat just now.'));
        return;
      }
      setSession(json.session ?? null);
      setQueue(json.queue ?? QUEUE_UNRESOLVED);
      setLoadError(null);
    } catch (e) {
      // A dropped request must not blank a position the employee is watching.
      // The last-known state stays on screen and the next poll corrects it.
      setLoadError(cleanErrorMessage(e, 'We could not check your chat just now.'));
    } finally {
      setFirstLoadDone(true);
    }
  }, [email]);

  const loadThread = useCallback(
    async (id: string) => {
      setThreadLoading(true);
      try {
        const res = await fetch(
          `/api/employee/support/chat/${encodeURIComponent(id)}/messages?email=${encodeURIComponent(email)}`,
          { cache: 'no-store' },
        );
        const json = (await res.json()) as { messages?: ChatMessageWire[]; error?: string | null };
        if (res.ok) setMessages(json.messages ?? []);
      } catch {
        // Same reasoning as the session read — keep what is on screen.
      } finally {
        setThreadLoading(false);
      }
    },
    [email],
  );

  const refreshRef = useRef(loadSession);
  refreshRef.current = loadSession;
  const loadThreadRef = useRef(loadThread);
  loadThreadRef.current = loadThread;

  /* ── first load ── */

  useEffect(() => {
    void refreshRef.current();
  }, [email]);

  /* ── the thread follows the session, but only while somebody is looking ── */

  useEffect(() => {
    if (!dialogOpen || !sessionId) return;
    void loadThreadRef.current(sessionId);
  }, [dialogOpen, sessionId]);

  useEffect(() => {
    if (!sessionId) setMessages([]);
  }, [sessionId]);

  /* ── poll floor ── */

  useEffect(() => {
    // Nothing to poll for: an employee with no session cannot be put into a
    // queue by anybody but themselves. Focus still catches up below.
    if (!dialogOpen && !sessionId) return;
    const period = dialogOpen ? POLL_OPEN_MS : POLL_BACKGROUND_MS;
    const id = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void refreshRef.current();
      if (dialogOpen && sessionId) void loadThreadRef.current(sessionId);
    }, period);
    return () => window.clearInterval(id);
  }, [dialogOpen, sessionId]);

  /* ── focus / visibility catch-up ── */

  useEffect(() => {
    const onWake = () => {
      if (document.visibilityState !== 'visible') return;
      void refreshRef.current();
      if (dialogOpen && sessionId) void loadThreadRef.current(sessionId);
    };
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('focus', onWake);
    return () => {
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('focus', onWake);
    };
  }, [dialogOpen, sessionId]);

  /* ── the live signal ── */

  useEffect(() => {
    if (!dialogOpen && !sessionId) return;
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;

    const fire = (withThread: boolean) => {
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
      debounceRef.current = window.setTimeout(() => {
        debounceRef.current = null;
        void refreshRef.current();
        if (withThread && sessionId) void loadThreadRef.current(sessionId);
      }, LIVE_DEBOUNCE_MS);
    };

    const channel = supabase.channel(CHAT_LIVE_TOPIC);
    channel.on('broadcast', { event: CHAT_LIVE_EVENT }, ({ payload }) => {
      const p = (payload ?? {}) as Partial<ChatLivePayload>;
      // A SESSION moving is everybody's business: somebody ahead in the line
      // being claimed or leaving changes THIS employee's place, and the payload
      // carries no email to narrow on (deliberately — the topic is anon-visible
      // and an email on it would tell every listener who just opened a chat).
      if (p.kind === 'session') {
        fire(dialogOpen);
        return;
      }
      // A MESSAGE is only worth a re-fetch when it landed in our own thread.
      if (p.kind === 'message' && p.sessionId && p.sessionId === sessionId) fire(true);
    });
    // The subscription state is deliberately not surfaced on this screen. The
    // agent board gets the honest Live / Connecting / Polling pill (plan task
    // 18) because a staffer needs to know whether the board is trustworthy; an
    // employee waiting in a line does not need a socket diagnostic, and the
    // poll floor above means a dead socket costs seconds, not correctness.
    channel.subscribe();

    return () => {
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
      void supabase.removeChannel(channel);
    };
  }, [dialogOpen, sessionId]);

  /* ── the clock behind the availability sentence ── */

  useEffect(() => {
    if (!dialogOpen) return;
    const id = window.setInterval(() => setClock(new Date()), CLOCK_TICK_MS);
    return () => window.clearInterval(id);
  }, [dialogOpen]);

  /* ── keep the thread pinned to the newest line ── */

  useEffect(() => {
    const el = threadRef.current;
    if (!el || !dialogOpen) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, dialogOpen]);

  /* ── tell the header what to draw ── */

  const becameTicketNo = session?.became_ticket_no ?? null;
  const outward: SupportChatState = useMemo(
    () => ({
      status,
      // Guarded by `resolved` here as well as at every render site: an
      // unresolved position leaves this field null, so a consumer that forgot
      // to check `queueResolved` still cannot paint a `0`.
      position: queue.resolved ? queue.position : null,
      queueResolved: queue.resolved,
      migrated,
      needsAttention:
        status === 'claimed' ||
        status === 'live' ||
        (status === 'abandoned' && becameTicketNo !== null),
    }),
    [status, queue.resolved, queue.position, migrated, becameTicketNo],
  );

  const onStateChangeRef = useRef(onStateChange);
  onStateChangeRef.current = onStateChange;
  useEffect(() => {
    onStateChangeRef.current?.(firstLoadDone ? outward : IDLE_STATE);
  }, [outward, firstLoadDone]);

  /* ── writes ── */

  const enterQueue = useCallback(async () => {
    setEntering(true);
    try {
      const res = await fetch('/api/employee/support/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const json = (await res.json()) as {
        migrated?: boolean;
        session?: ChatSessionWire | null;
        queue?: QueueState;
        created?: boolean;
        error?: string | null;
      };
      if (typeof json.migrated === 'boolean') setMigrated(json.migrated);
      if (!res.ok) {
        toast.error(cleanErrorMessage(json.error, 'We could not start the chat. Nothing was saved.'));
        return;
      }
      setSession(json.session ?? null);
      setQueue(json.queue ?? QUEUE_UNRESOLVED);
      // `created: false` is not a failure — it means they were already in the
      // line and kept the place they held. Saying "started" would suggest the
      // old place was thrown away, which is the one thing the queue promises
      // never happens.
      toast.success(json.created === false ? 'You are already in the line.' : 'You are in the line.');
      if (json.session?.id) void loadThread(json.session.id);
    } catch (e) {
      toast.error(cleanErrorMessage(e, 'We could not start the chat. Nothing was saved.'));
    } finally {
      setEntering(false);
    }
  }, [email, loadThread]);

  const leaveQueue = useCallback(async () => {
    setLeaving(true);
    try {
      const res = await fetch(`/api/employee/support/chat?email=${encodeURIComponent(email)}`, {
        method: 'DELETE',
      });
      const json = (await res.json()) as {
        migrated?: boolean;
        session?: ChatSessionWire | null;
        error?: string | null;
      };
      if (typeof json.migrated === 'boolean') setMigrated(json.migrated);
      if (!res.ok) {
        toast.error(cleanErrorMessage(json.error, 'We could not close the chat. Nothing was changed.'));
        return;
      }
      setSession(json.session ?? null);
      setQueue(QUEUE_UNRESOLVED);
      await loadSession();
      toast.success('You have left the chat.');
    } catch (e) {
      toast.error(cleanErrorMessage(e, 'We could not close the chat. Nothing was changed.'));
    } finally {
      setLeaving(false);
    }
  }, [email, loadSession]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || !sessionId || sending) return;
    setSending(true);
    try {
      const res = await fetch(`/api/employee/support/chat/${encodeURIComponent(sessionId)}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: text, email }),
      });
      const json = (await res.json()) as { message?: ChatMessageWire | null; error?: string | null };
      if (!res.ok || !json.message) {
        toast.error(cleanErrorMessage(json.error, 'That did not send. Nothing was saved.'));
        return;
      }
      // Append the row the SERVER returned rather than an optimistic copy of
      // the draft: the transcript is the ticket's content, and a line that
      // exists only in this browser would be missing from the ticket while
      // looking sent.
      const saved = json.message;
      setMessages((prev) => (prev.some((m) => m.id === saved.id) ? prev : [...prev, saved]));
      setDraft('');
    } catch (e) {
      toast.error(cleanErrorMessage(e, 'That did not send. Nothing was saved.'));
    } finally {
      setSending(false);
    }
  }, [draft, email, sending, sessionId]);

  /* ── render ── */

  const availability = describeChatAvailability(clock);
  const overLimit = draft.length > SUPPORT_CONCERN_MAX;

  return (
    <Dialog open={dialogOpen} onOpenChange={onDialogOpenChange}>
      <DialogContent
        className="flex max-h-[min(90vh,760px)] w-[calc(100vw-1.25rem)] max-w-lg flex-col gap-0 overflow-hidden border-orange-100/70 bg-gradient-to-br from-white via-orange-50/35 to-blue-50/25 p-0 sm:max-w-lg dark:border-blue-950/50 dark:from-[#0d1117] dark:via-[#0f1729] dark:to-[#0a1628]"
        showCloseButton
      >
        <DialogHeader className="shrink-0 border-b border-orange-100/60 px-4 py-3 dark:border-blue-950/50">
          <DialogTitle className="flex items-center gap-2 text-base text-zinc-900 dark:text-white">
            <MessageCircle className="size-4 text-orange-500 dark:text-orange-400" aria-hidden />
            Live chat with Employee Support
          </DialogTitle>
          <DialogDescription className="text-left text-xs text-zinc-600 dark:text-zinc-400">
            {availability}
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4">
          {/* The migration has not run. A "you cannot do this right now" notice
              with the sentence for THIS surface, the way PayrollLockBanner
              requires one per surface — and it says outright that nothing would
              be saved, because the alternative is an employee believing they
              are in a queue that does not exist. */}
          {migrated === false && (
            <div className="flex items-start gap-2.5 rounded-xl border border-rose-200 bg-rose-50/70 p-3 dark:border-rose-900/50 dark:bg-rose-950/25">
              <AlertTriangle
                className="mt-0.5 size-4 shrink-0 text-rose-600 dark:text-rose-300"
                aria-hidden
              />
              <div>
                <p className="text-[13px] font-semibold text-rose-900 dark:text-rose-100">
                  Live chat is not switched on yet
                </p>
                <p className="mt-1 text-[12px] leading-relaxed text-rose-800/90 dark:text-rose-200/90">
                  Nothing you send here would be saved. Use Employee Support to file your question
                  instead — those are answered {SUPPORT_REPLY_PROMISE}.
                </p>
              </div>
            </div>
          )}

          {loadError && migrated !== false && (
            <p className="rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-2 text-[11.5px] leading-relaxed text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/25 dark:text-amber-200">
              {loadError} Your place in the line is not affected.
            </p>
          )}

          {!firstLoadDone ? (
            <QueuePlaceholder inLine={false} />
          ) : (
            <>
              {/* ── no session: the invitation ── */}
              {status === 'none' && migrated !== false && (
                <div className="space-y-3">
                  <p className="text-[13px] leading-relaxed text-zinc-700 dark:text-zinc-300">
                    Ask Employee Support anything — pay, schedules, documents, or anything that is not
                    working. You join a single line and the next person free takes you.
                  </p>
                  {queue.resolved && queue.waiting !== null ? (
                    <p className="flex items-center gap-1.5 text-[12px] text-zinc-500 dark:text-zinc-400">
                      <Users className="size-3.5" aria-hidden />
                      {queue.waiting === 0
                        ? 'Nobody is in the line right now.'
                        : `${queue.waiting} ${queue.waiting === 1 ? 'person is' : 'people are'} in the line right now.`}
                    </p>
                  ) : (
                    // We could not read the line. That is not "nobody is
                    // waiting", so it does not get that sentence.
                    <Skeleton className="h-3.5 w-48" />
                  )}
                  <BecomesATicketNote />
                </div>
              )}

              {/* ── waiting: the place in the line ── */}
              {status === 'waiting' && (
                <div className="space-y-3">
                  {queue.resolved && queue.position !== null ? (
                    <div className="rounded-xl border border-orange-100/80 bg-white/80 p-3.5 dark:border-orange-900/30 dark:bg-zinc-900/50">
                      <div className="flex items-center gap-3">
                        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-orange-100 to-amber-100 text-[15px] font-bold tabular-nums text-orange-700 dark:from-orange-950/60 dark:to-amber-950/40 dark:text-orange-300">
                          {/* Unclamped, on purpose — see rule 2. */}
                          {queue.position}
                        </span>
                        <div className="min-w-0" aria-live="polite">
                          <p className="text-[13px] font-semibold text-zinc-900 dark:text-zinc-100">
                            You are {ordinal(queue.position)} in line
                          </p>
                          <p className="text-[11.5px] text-zinc-500 dark:text-zinc-400">
                            {queue.waiting !== null
                              ? `${queue.waiting} ${queue.waiting === 1 ? 'person' : 'people'} in the line`
                              : 'Waiting for the next person free'}
                          </p>
                        </div>
                      </div>
                      {/* An estimate is never a promise — rule 3. There is no
                          time on this screen and there must not be one. */}
                      <p className="mt-2.5 text-[11.5px] leading-relaxed text-zinc-500 dark:text-zinc-400">
                        That is your place in the line, not a time — we cannot promise when somebody
                        will be free. You can close this window; you keep your place.
                      </p>
                    </div>
                  ) : (
                    <QueuePlaceholder inLine />
                  )}
                  <BecomesATicketNote />
                </div>
              )}

              {/* ── somebody is with them ── */}
              {(status === 'claimed' || status === 'live') && (
                <div className="flex items-center gap-2.5 rounded-xl border border-emerald-200 bg-emerald-50/70 p-3 dark:border-emerald-900/50 dark:bg-emerald-950/25">
                  <span className="relative flex h-2.5 w-2.5 shrink-0" aria-hidden>
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                    <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" />
                  </span>
                  <p className="text-[12.5px] font-medium text-emerald-900 dark:text-emerald-100">
                    Somebody from Employee Support is with you.
                  </p>
                </div>
              )}

              {/* ── it expired and became a ticket (Q1) ── */}
              {status === 'abandoned' && <AbandonedPanel ticketNo={becameTicketNo} />}

              {/* ── they left ── */}
              {status === 'ended' && (
                <div className="flex items-start gap-2.5 rounded-xl border border-zinc-200 bg-white/80 p-3 dark:border-zinc-800 dark:bg-zinc-900/50">
                  <CheckCircle2
                    className="mt-0.5 size-4 shrink-0 text-zinc-400 dark:text-zinc-500"
                    aria-hidden
                  />
                  <p className="text-[12.5px] leading-relaxed text-zinc-600 dark:text-zinc-400">
                    This chat is closed. Everything below is kept. Start a new one whenever you need.
                  </p>
                </div>
              )}

              {/* ── the transcript (Q2: it persists, so it is shown) ── */}
              {session && (
                <div
                  ref={threadRef}
                  className="max-h-[38vh] min-h-[6rem] space-y-2 overflow-y-auto rounded-xl border border-zinc-200/70 bg-white/60 p-3 dark:border-zinc-800/70 dark:bg-zinc-950/30"
                >
                  {threadLoading && messages.length === 0 ? (
                    <div className="space-y-2">
                      <Skeleton className="h-8 w-2/3 rounded-2xl" />
                      <Skeleton className="ml-auto h-8 w-1/2 rounded-2xl" />
                    </div>
                  ) : messages.length === 0 ? (
                    <p className="py-4 text-center text-[11.5px] text-zinc-400 dark:text-zinc-500">
                      {isOpenChatSession(session.status)
                        ? 'Type your question now — it is waiting for whoever picks you up.'
                        : 'Nothing was written in this chat.'}
                    </p>
                  ) : (
                    <AnimatePresence initial={false}>
                      {messages.map((m) => (
                        <motion.div
                          key={m.id}
                          initial={{ opacity: 0, y: 6 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                        >
                          <MessageBubble message={m} />
                        </motion.div>
                      ))}
                    </AnimatePresence>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {/* ── the composer / the entry button ── */}
        <div className="shrink-0 border-t border-orange-100/60 bg-white/70 px-4 py-3 dark:border-blue-950/50 dark:bg-zinc-950/40">
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
                placeholder={
                  session?.status === 'waiting'
                    ? 'Type your question while you wait — it goes with you.'
                    : 'Type a message…'
                }
                className="w-full resize-y rounded-lg border border-zinc-200 bg-white px-3 py-2 text-[13px] leading-relaxed text-zinc-900 placeholder:text-zinc-400 transition-colors focus:border-orange-300 focus:outline-none focus:ring-1 focus:ring-orange-200 dark:border-zinc-800 dark:bg-zinc-950/60 dark:text-zinc-100 dark:focus:border-orange-500/40 dark:focus:ring-orange-500/20"
              />
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-8 gap-1.5 text-xs text-zinc-500 hover:text-rose-600 dark:text-zinc-400 dark:hover:text-rose-400"
                    disabled={leaving}
                    onClick={() => void leaveQueue()}
                  >
                    {leaving ? (
                      <Loader2 className="size-3.5 animate-spin" aria-hidden />
                    ) : (
                      <LogOut className="size-3.5" aria-hidden />
                    )}
                    Leave chat
                  </Button>
                  {/* The counter only appears once it is worth reading. The
                      route refuses over the bound with a sentence; this is so
                      the employee sees it coming rather than losing a long
                      message to a 400. */}
                  {draft.length > SUPPORT_CONCERN_MAX - 400 && (
                    <span
                      className={cn(
                        'text-[11px] tabular-nums',
                        overLimit
                          ? 'font-semibold text-rose-600 dark:text-rose-400'
                          : 'text-zinc-400 dark:text-zinc-500',
                      )}
                    >
                      {draft.length} / {SUPPORT_CONCERN_MAX}
                    </span>
                  )}
                </div>
                <Button
                  type="button"
                  size="sm"
                  className="h-8 gap-1.5 bg-gradient-to-br from-orange-500 to-rose-500 text-xs text-white hover:from-orange-600 hover:to-rose-600"
                  disabled={sending || overLimit || draft.trim().length === 0}
                  onClick={() => void send()}
                >
                  {sending ? (
                    <Loader2 className="size-3.5 animate-spin" aria-hidden />
                  ) : (
                    <Send className="size-3.5" aria-hidden />
                  )}
                  Send
                </Button>
              </div>
            </div>
          ) : (
            <Button
              type="button"
              className="h-9 w-full gap-1.5 bg-gradient-to-br from-orange-500 to-rose-500 text-[13px] text-white hover:from-orange-600 hover:to-rose-600"
              disabled={entering || migrated === false || !firstLoadDone}
              onClick={() => void enterQueue()}
            >
              {entering ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <MessageCircle className="size-4" aria-hidden />
              )}
              {status === 'none' ? 'Start a chat' : 'Start a new chat'}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
