'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  CheckCircle2,
  Copy,
  History,
  Info,
  Loader2,
  MessageSquareText,
  Plus,
  RotateCcw,
  Send,
  Ticket,
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
import { describeSteeredSubjects, steerForCategory } from '@/lib/support/routing';
import {
  SUPPORT_CATEGORIES,
  SUPPORT_CATEGORY_LABELS,
  SUPPORT_CONCERN_MAX,
  SUPPORT_REPLY_PROMISE,
  SUPPORT_STATUSES,
  SUPPORT_STATUS_LABELS,
  SUPPORT_STATUS_TONE,
  type SupportAuthorSide,
  type SupportCategory,
  type SupportStatus,
} from '@/lib/support/types';

/**
 * Employee Support TICKETS — the employee's side: file one, read the history,
 * follow each ticket along its track.
 *
 * Plan: docs/superpowers/plans/2026-09-14-employee-support.md (tasks 8, 9, 15,
 * 16, 25, 28). Governing doc: docs/features/employee-support.md.
 * Routes: app/api/employee/support/route.ts and .../support/[id]/messages.
 * Sibling: EmployeeSupportChat.tsx — same dialog shell, same prop shape, same
 * skeleton-not-zero discipline, same "closing the dialog loses nothing" rule.
 *
 * WHERE THIS SITS — KANE, 2026-09-21
 * ---------------------------------------------------------------------------
 * "Instead of Chat change that to Help where they can choose between a Chat
 * Support or a Ticket." The dashboard's HELP control (beside FAQs, in BOTH
 * mirrored header clusters, never a floating launcher — Penny owns the one
 * fixed corner, `docs/features/employee-penny-ai.md:143-146`) opens a chooser
 * with two doors. This dialog is the "Raise a ticket" door. It does not own
 * the header button; it tells the header what to badge through
 * `onStateChange`, exactly as `EmployeeSupportChat` does, and the chooser
 * decides how to draw the two summaries as one control.
 *
 * WHAT CARLA SIGNED, AND WHERE EACH LINE IS HONOURED (2026-09-15)
 * ---------------------------------------------------------------------------
 * - "A short form: what it is about, and what happened. Their name and work
 *    email fill in automatically."  → {@link FileForm}: a category picker and
 *    one textarea. Name and email are READ-ONLY and come from the server's
 *    `me` — the form never asks, and the route never trusts a body address.
 * - "A ticket number, so the question exists as a record."  → {@link FiledPanel}:
 *    the ES- number, large and copyable, the moment the row exists.
 * - "A list of all their past questions and the answers they were given."
 *    → the My tickets pane: every ticket, newest first, and its whole thread.
 * - "Either side can reply again. Nothing is deleted — closed questions stay
 *    readable by both."  → a closed ticket opens and reads like any other, and
 *    the composer stays. An employee reply to a CLOSED ticket REOPENS it
 *    (`lifecycle.ts` `canEmployeeReply`); the composer SAYS SO BEFORE they send.
 * - Reply promise "within one working day"  → `SUPPORT_REPLY_PROMISE`, shown at
 *    filing and restated on success. Displayed, not enforced.
 * - NO per-day cap (Decision 6): nothing here counts today's tickets.
 * - NO attachments (Decision 8): there is no file input and must not be one.
 *
 * THE TRACK MAP — KANE, 2026-09-18
 * ---------------------------------------------------------------------------
 * "In the employee side they can have a track map on what is the status of
 * their tickets depending on the status in Kanban." The stops are
 * `SUPPORT_STATUS_LABELS` — Waiting → Being looked at → Answered → Closed —
 * and nothing else: the label the employee reads is the label the staff board
 * reads (`types.ts:58-63`), so the two surfaces cannot describe one ticket two
 * ways. {@link SupportTrackMap} lights every stop up to the current one and
 * shows the time each lit stop was reached, from the three stamp columns the
 * wire carries (`claimed_at`, `first_response_at`, `closed_at`). A ticket that
 * has been reopened (a `closed_at` with a status that is not `closed` — the
 * SQL says this is "a legitimate state this table allows") is drawn back at
 * its current stop with a one-line note, not with a lit Closed.
 *
 * FOUR RULES THIS FILE HOLDS
 * ---------------------------------------------------------------------------
 * 1. **A count renders as a SKELETON until it resolves, never as `0`.** The
 *    route says which one it means with `counts.resolved` and with
 *    `thread: null` per ticket ("we could not read the replies", never "no
 *    replies"). There is no code path here that turns an unknown into a number,
 *    and the My tickets pane never paints "you have none" while a load is in
 *    flight or has failed.
 * 2. **The badge is honest about what it knows.** The server has no
 *    `last_read_at` and this build adds no migration, so "unread" cannot be a
 *    server fact. What it CAN prove it hands over: `awaiting_you` (the last
 *    word on a thread is staff's) and `latest_staff_reply_at`. The dot that
 *    must clear on "I read it" is per-device: this browser stamps
 *    `latest_staff_reply_at` into localStorage when the employee looks at
 *    their tickets, and `unseenStaffReply` compares against that stamp. Same
 *    conclusion `EmployeeSupportChat` reached for its `needsAttention` dot
 *    (`:253-258`), reached independently by the route header ("LAST LOOKED").
 * 3. **Closing the dialog loses nothing.** The dialog hides; the component
 *    stays mounted. A half-written concern, a chosen category and every
 *    per-ticket reply draft survive a close and come back on reopen. Only the
 *    reading position resets — the chooser's door decides which pane opens.
 * 4. **The ticket's own `concern` is the opening message.** The route does not
 *    duplicate it into `messages`, so this file renders `concern` first and
 *    the thread after it. Rendering it twice, or not at all, is the bug.
 *
 * WHY THE HOURS ARE EASTERN ONLY, AND WHY `hours.ts` IS NOT CALLED FOR IT
 * ---------------------------------------------------------------------------
 * `describeSupportHours` renders both zones — "9 AM – 5 PM Eastern (9 PM – 5 AM
 * Manila)" — to protect a Manila reader. Kane overturned that premise on
 * 2026-09-19: "every employee is on EST so dont mind the time zone please". So
 * this surface builds its sentence from the exported constants
 * (`SUPPORT_OPEN_HOUR` / `SUPPORT_CLOSE_HOUR` / `isSupportOpen`) and keeps the
 * TICKET half of `describeSupportAvailability`'s promise — "you can still send
 * this; someone picks it up when they are back" — which is TRUE of a ticket
 * (and was false of the chat, which is why the sibling wrote its own). The
 * form never refuses on the window: a question filed at 2 AM is answered at
 * 9 AM, and that beats making somebody remember to come back.
 *
 * WHAT IS DELIBERATELY NOT HERE
 * ---------------------------------------------------------------------------
 * * No file input (Decision 8). No "you have filed N today" (Decision 6).
 * * No staff address anywhere: a staffer's name reaches the employee through
 *   `author_name` on the thread and that is all the wire carries.
 * * No edit and no delete on a message. The messages table has no update
 *   path; a support thread is a record of what was said.
 * * No `99+` clamp on any count, and no "about N minutes" anywhere — an
 *   estimate is never a promise (the sibling's rules 2 and 3, kept here).
 */

/* ────────────────────────────── the wire ─────────────────────────────── */

/**
 * Exactly what the two employee ticket routes answer with. Restated here rather
 * than imported because a route module is server-only — `TICKET_SELECT` and
 * these shapes live next to each other there, and the day they change this
 * block is the diff that has to change with them.
 */
type ThreadSummary = {
  /** Replies on the thread. The ticket's own `concern` is not counted — it is the ticket. */
  messages: number;
  staff_replies: number;
  last_message_at: string | null;
  last_message_side: SupportAuthorSide | null;
  last_staff_reply_at: string | null;
  /** The last word is staff's. A state, not an unread count. */
  awaiting_you: boolean;
};

type EmployeeTicketWire = {
  id: string;
  ticket_no: number;
  /** `ES-1043`, from the one formatter. */
  label: string;
  category: string;
  category_label: string;
  concern: string;
  status: SupportStatus;
  /** Waiting / Being looked at / Answered / Closed — the track stops. */
  status_label: string;
  created_at: string;
  updated_at: string;
  claimed_at: string | null;
  first_response_at: string | null;
  closed_at: string | null;
  needs_staff_reply: boolean;
  /** `null` means the thread read FAILED — unknown, never "no replies". */
  thread: ThreadSummary | null;
};

/** `null` anywhere means WE COULD NOT TELL. `resolved: false` owes a skeleton, never a 0. */
type EmployeeCounts = {
  total: number | null;
  open: number | null;
  awaiting_you: number | null;
  resolved: boolean;
};

const COUNTS_UNRESOLVED: EmployeeCounts = {
  total: null,
  open: null,
  awaiting_you: null,
  resolved: false,
};

type MessageWire = {
  id: string;
  author_side: SupportAuthorSide;
  author_name: string | null;
  body: string;
  created_at: string;
};

/** Who the server says the caller is. The form's auto-fill is THIS, never the browser's guess. */
type Me = { work_email: string; member_name: string | null };

/* ───────────────────────────── the live signal ───────────────────────── */

/**
 * The live topic. MUST match `app/api/employee/support/route.ts` and
 * `.../[id]/messages/route.ts` byte for byte. All three carry the literals
 * locally because a route module may export only handlers; they belong in a
 * `src/lib/support/ticket-live.ts` twin of `chat-live.ts` the moment somebody
 * owns that file, and this block is the third copy that file retires.
 *
 * Content-free by contract: a kind, a uuid and a server stamp. Anything more
 * on an anon-readable topic is the defect `chat-live.ts` documents.
 */
const TICKET_LIVE_TOPIC = 'employee-support-tickets-sync';
const TICKET_LIVE_EVENT = 'changed';
type TicketLivePayload = { kind: 'ticket' | 'message'; ticketId: string; ts: number };

/** A broadcast payload is untrusted input like any other. Parse, never render raw. */
function parseTicketLivePayload(raw: unknown): TicketLivePayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Partial<TicketLivePayload>;
  if (p.kind !== 'ticket' && p.kind !== 'message') return null;
  if (typeof p.ticketId !== 'string' || p.ticketId.length === 0) return null;
  if (typeof p.ts !== 'number' || !Number.isFinite(p.ts)) return null;
  return { kind: p.kind, ticketId: p.ticketId, ts: p.ts };
}

/* ──────────────────────────── poll cadences ──────────────────────────── */

/**
 * Cadences are a per-surface cost decision, not a contract, so they live here
 * (the sibling's reasoning at `EmployeeSupportChat.tsx:147-163`).
 *
 * Slower than the chat's on purpose. A queue position moves by the second; a
 * ticket answered "within one working day" does not. Fast-ish while somebody
 * is looking, slow while a ticket is still open but the dialog is shut (the
 * badge still has to be honest), and NOTHING when every ticket is closed or
 * there are none — nothing can move that this employee would need to see.
 * Focus and visibility still catch up in every case.
 */
const POLL_OPEN_MS = 15_000;
const POLL_BACKGROUND_MS = 60_000;
/** Coalesce a burst (a staffer ranking three tickets) into one reload. */
const LIVE_DEBOUNCE_MS = 400;
/** Re-render the availability sentence so it flips at 9 AM and 5 PM Eastern without a reload. */
const CLOCK_TICK_MS = 60_000;

/* ─────────────────────────────── copy ────────────────────────────────── */

/** `9` → `9 AM`, `17` → `5 PM`. Local to this file; the window is whole hours. */
function hour12(hour24: number): string {
  const suffix = hour24 < 12 ? 'AM' : 'PM';
  const h = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${h} ${suffix}`;
}

/**
 * The support window, said the way a TICKET form has to say it: Eastern only
 * (see the header), and it never says "come back later" — the ticket is
 * accepted at any hour and answered when somebody is back.
 */
function describeTicketAvailability(at: Date): string {
  const hours = `${hour12(SUPPORT_OPEN_HOUR)} – ${hour12(SUPPORT_CLOSE_HOUR)} Eastern, Mon–Fri`;
  return isSupportOpen(at)
    ? `Support is open now — ${hours}.`
    : `Support is closed right now, but you can still send this — someone picks it up when they are back. ${hours}.`;
}

function clockLabel(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function dateLabel(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** `Sep 21, 3:40 PM` — the thread's timestamps, where a date alone is not enough. */
function whenLabel(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/* ───────────────────────── status: two parallel Records ──────────────── */

/**
 * The label is `SUPPORT_STATUS_LABELS` (imported, never restated); the colour
 * is keyed off `SUPPORT_STATUS_TONE`. Two parallel Records rather than one
 * object — `TimeAdjustmentDialog.tsx:59-76` and `RequestDocumentsTab.tsx:59-69`
 * keep the same habit — so the wording and the colour are edited apart and
 * cannot drift into disagreeing about what a status means.
 */
type SupportTone = (typeof SUPPORT_STATUS_TONE)[SupportStatus];

const TONE_CHIP: Record<SupportTone, string> = {
  waiting:
    'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300',
  active:
    'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-300',
  good: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300',
  neutral:
    'border-zinc-200 bg-zinc-50 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-300',
};

const TONE_FILL: Record<SupportTone, string> = {
  waiting: 'bg-amber-500',
  active: 'bg-blue-500',
  good: 'bg-emerald-500',
  neutral: 'bg-zinc-400 dark:bg-zinc-500',
};

const TONE_RING: Record<SupportTone, string> = {
  waiting: 'ring-amber-200 dark:ring-amber-500/30',
  active: 'ring-blue-200 dark:ring-blue-500/30',
  good: 'ring-emerald-200 dark:ring-emerald-500/30',
  neutral: 'ring-zinc-200 dark:ring-zinc-700',
};

const TONE_TEXT: Record<SupportTone, string> = {
  waiting: 'text-amber-700 dark:text-amber-300',
  active: 'text-blue-700 dark:text-blue-300',
  good: 'text-emerald-700 dark:text-emerald-300',
  neutral: 'text-zinc-600 dark:text-zinc-300',
};

/** The status chip. One place, so a row and a thread header read the same chip. */
function StatusChip({ status }: { status: SupportStatus }) {
  const tone = SUPPORT_STATUS_TONE[status];
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] font-semibold',
        TONE_CHIP[tone],
      )}
    >
      <span className={cn('inline-flex h-1.5 w-1.5 rounded-full', TONE_FILL[tone])} aria-hidden />
      {SUPPORT_STATUS_LABELS[status]}
    </span>
  );
}

/* ───────────────────────────── the track map ─────────────────────────── */

/**
 * Kane's track map. Exported so the Help chooser can draw one for a ticket
 * without importing the whole dialog.
 *
 * Every stop up to the current one is lit in the CURRENT status's tone (one
 * colour per ticket, so the map reads as one state rather than a rainbow),
 * the current stop carries a ring, and stops not yet reached are hollow.
 * `compact` drops the timestamps for the list rows; the thread header shows
 * them. A reopened ticket is drawn at its current stop — the wire's
 * `closed_at` survives the reopen, so the Closed stop is NOT lit from it, and
 * the caller adds the "reopened" note (the thread view does).
 */
export function SupportTrackMap({
  ticket,
  compact = false,
}: {
  ticket: Pick<EmployeeTicketWire, 'status' | 'created_at' | 'claimed_at' | 'first_response_at' | 'closed_at'>;
  compact?: boolean;
}) {
  const current = SUPPORT_STATUSES.indexOf(ticket.status);
  const tone = SUPPORT_STATUS_TONE[ticket.status];
  const stampFor: Record<SupportStatus, string | null> = {
    open: ticket.created_at,
    claimed: ticket.claimed_at,
    answered: ticket.first_response_at,
    closed: ticket.closed_at,
  };
  const last = SUPPORT_STATUSES.length - 1;

  return (
    <ol
      className="flex w-full items-start"
      aria-label={`Ticket status: ${SUPPORT_STATUS_LABELS[ticket.status]}`}
    >
      {SUPPORT_STATUSES.map((stop, i) => {
        const reached = i <= current;
        const isCurrent = i === current;
        const nextReached = i + 1 <= current;
        const stamp = reached ? stampFor[stop] : null;
        return (
          <li
            key={stop}
            className="relative flex min-w-0 flex-1 flex-col items-center"
            aria-current={isCurrent ? 'step' : undefined}
          >
            {/* The two half-connectors. The left half belongs to this stop
                and lights with it; the right half lights with the NEXT stop,
                so a lit line never runs past the last lit dot. */}
            {i > 0 && (
              <span
                className={cn(
                  'absolute left-0 right-1/2 top-[6px] h-0.5',
                  reached ? TONE_FILL[tone] : 'bg-zinc-200 dark:bg-zinc-800',
                )}
                aria-hidden
              />
            )}
            {i < last && (
              <span
                className={cn(
                  'absolute left-1/2 right-0 top-[6px] h-0.5',
                  nextReached ? TONE_FILL[tone] : 'bg-zinc-200 dark:bg-zinc-800',
                )}
                aria-hidden
              />
            )}
            <span
              className={cn(
                'relative z-10 inline-flex h-3.5 w-3.5 items-center justify-center rounded-full',
                reached
                  ? cn(TONE_FILL[tone], isCurrent && cn('ring-4', TONE_RING[tone]))
                  : 'border-2 border-zinc-300 bg-white dark:border-zinc-700 dark:bg-zinc-900',
              )}
              aria-hidden
            >
              {reached && !isCurrent && <Check className="size-2.5 text-white" strokeWidth={3} />}
            </span>
            <span
              className={cn(
                'mt-1.5 px-0.5 text-center leading-tight',
                compact ? 'text-[9.5px]' : 'text-[10.5px]',
                isCurrent
                  ? cn('font-semibold', TONE_TEXT[tone])
                  : reached
                    ? 'font-medium text-zinc-600 dark:text-zinc-300'
                    : 'text-zinc-400 dark:text-zinc-500',
              )}
            >
              {SUPPORT_STATUS_LABELS[stop]}
            </span>
            {!compact && stamp && (
              <span className="mt-0.5 text-[9.5px] tabular-nums text-zinc-400 dark:text-zinc-500">
                {dateLabel(stamp)}
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/* ───────────────────────── the header contract ───────────────────────── */

export type SupportTicketsPane = 'file' | 'history';

/**
 * What the Help control needs to know about the ticket door. Emitted through
 * `onStateChange` so the header and the dialog cannot disagree — the same split
 * `EmployeeSupportChat` and `GiftShippingCard` use.
 *
 * BADGE GUIDANCE, so the consumer does not re-derive it wrongly:
 * - `countsResolved: false` → a shimmer, never a number and never nothing.
 * - `awaitingYou > 0` → the ball is in the employee's court on that many
 *   tickets. A provable state; it clears when they reply.
 * - `unseenStaffReply` → staff spoke after this DEVICE last looked. Clears the
 *   moment the employee opens My tickets here. This is the "I read it" dot.
 * - Never derive "unread" from `newestStatus` alone: a ticket stays `answered`
 *   after an employee follow-up (`nextStatus` returns null for it).
 */
export type SupportTicketsState = {
  /**
   * THE FIELD `EmployeeHelpMenu` READS, and it is that file's definition, not
   * a second one: "the last word on at least one of the employee's tickets is
   * staff's — a reply is waiting on them. A state the server can prove, never
   * an unread count" (`EmployeeHelpMenu.tsx:114-123`). So it is
   * `awaitingYou > 0`, and FALSE whenever the counts did not resolve — its
   * contract has no third value, and a badge that cannot tell must be quiet
   * rather than invent a mark.
   *
   * Note the consequence, and it is deliberate rather than overlooked: this
   * does NOT clear when the employee reads the reply. It clears when they
   * REPLY, because that is when the ball leaves their court — which is the
   * right rule for a ticket and the wrong one for a chat transcript (the
   * sibling's `needsAttention`, `EmployeeSupportChat.tsx:249-259`, is a
   * different kind of dot for that reason). If a "clears on read" mark is
   * ever wanted on the Help button instead, {@link unseenStaffReply} below is
   * already the honest version of it and nothing new has to be computed.
   */
  needsAttention: boolean;
  /** Null until a route has established it. False = the migrations have not run. */
  migrated: boolean | null;
  /** Every ticket the employee has ever filed. Null = not loaded / could not tell. */
  total: number | null;
  /** Tickets not yet closed. Null = could not tell. */
  open: number | null;
  /** Tickets where the last word is staff's. Null = could not tell. */
  awaitingYou: number | null;
  /** FALSE means the three counts above are UNKNOWN. A badge owes a skeleton, never a 0. */
  countsResolved: boolean;
  /** Staff replied after this browser last opened My tickets. Per-device, and honest about it. */
  unseenStaffReply: boolean;
  /** The newest ticket's status, or 'none'. */
  newestStatus: SupportStatus | 'none';
};

export const SUPPORT_TICKETS_IDLE_STATE: SupportTicketsState = {
  needsAttention: false,
  migrated: null,
  total: null,
  open: null,
  awaitingYou: null,
  countsResolved: false,
  unseenStaffReply: false,
  newestStatus: 'none',
};

/* ───────────────────────── the per-device seen stamp ─────────────────── */

/**
 * The email is in the key so an elevated `?email=` preview cannot inherit or
 * overwrite the employee's own stamp on a shared machine (the
 * `EmployeeMyHours` dismissal key makes the same choice, `:1259-1262`).
 * localStorage rather than sessionStorage because the dot is meant to stay
 * cleared across reloads on the device where the reply was read.
 */
function seenKey(email: string): string {
  return `emp-support-tickets-seen:${email}`;
}

function readSeenStamp(email: string): string | null {
  try {
    return window.localStorage.getItem(seenKey(email));
  } catch {
    return null;
  }
}

function writeSeenStamp(email: string, iso: string): void {
  try {
    window.localStorage.setItem(seenKey(email), iso);
  } catch {
    // Private mode or blocked storage: the dot simply stays honest-but-sticky.
  }
}

/* ──────────────────────────── dialog blocks ──────────────────────────── */

/** One of the two pane tabs. A plain button pair with tab semantics; the dialog owns the state. */
function PaneTab({
  active,
  onClick,
  icon: Icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof Plus;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'relative inline-flex h-9 items-center justify-center gap-1.5 rounded-lg px-3 text-[12.5px] font-medium transition-colors',
        active
          ? 'bg-white text-zinc-900 shadow-sm ring-1 ring-orange-200/70 dark:bg-zinc-900 dark:text-white dark:ring-orange-900/40'
          : 'text-zinc-600 hover:bg-white/60 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-900/50 dark:hover:text-zinc-100',
      )}
    >
      <Icon className={cn('size-3.5', active ? 'text-orange-500 dark:text-orange-400' : '')} aria-hidden />
      {children}
    </button>
  );
}

/**
 * The migration has not run. A per-surface sentence (the `PayrollLockBanner`
 * rule) that says outright nothing would be saved — the alternative is an
 * employee believing a question exists somewhere when it does not.
 */
function NotSwitchedOnNotice() {
  return (
    <div className="flex items-start gap-2.5 rounded-xl border border-rose-200 bg-rose-50/70 p-3 dark:border-rose-900/50 dark:bg-rose-950/25">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-rose-600 dark:text-rose-300" aria-hidden />
      <div>
        <p className="text-[13px] font-semibold text-rose-900 dark:text-rose-100">
          Support tickets are not switched on yet
        </p>
        <p className="mt-1 text-[12px] leading-relaxed text-rose-800/90 dark:text-rose-200/90">
          Nothing you send here would be saved. Use Live chat from the Help menu instead — an
          unanswered chat still becomes a ticket with its own number.
        </p>
      </div>
    </div>
  );
}

/**
 * "Their name and work email fill in automatically." Shown filled-in and
 * read-only; a skeleton until the server has said who they are. The route
 * resolves identity from the session on POST regardless, so a slow `me` does
 * not block filing — it only delays the reassurance.
 */
function IdentityCard({ me, loaded }: { me: Me | null; loaded: boolean }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-zinc-200/80 bg-white/70 px-3 py-2.5 dark:border-zinc-800 dark:bg-zinc-900/50">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-orange-100 to-amber-100 text-[13px] font-bold text-orange-700 dark:from-orange-950/60 dark:to-amber-950/40 dark:text-orange-300">
        {me?.member_name?.trim().charAt(0).toUpperCase() || me?.work_email.charAt(0).toUpperCase() || '·'}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[10.5px] font-medium uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
          Filed as
        </p>
        {me ? (
          <>
            <p className="truncate text-[13px] font-semibold text-zinc-900 dark:text-zinc-100">
              {me.member_name ?? me.work_email}
            </p>
            {me.member_name && (
              <p className="truncate text-[11.5px] text-zinc-500 dark:text-zinc-400">{me.work_email}</p>
            )}
          </>
        ) : loaded ? (
          <p className="text-[12px] text-zinc-500 dark:text-zinc-400">
            Your name and work email are added when you send.
          </p>
        ) : (
          <div className="space-y-1.5 pt-0.5">
            <Skeleton className="h-3.5 w-36" />
            <Skeleton className="h-3 w-44" />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The nine categories, as a radio group. The order is Carla's Decision 4
 * order (`SUPPORT_CATEGORIES`), and the labels are the shared vocabulary —
 * nothing here is a string of its own.
 */
function CategoryPicker({
  value,
  onChange,
  disabled,
}: {
  value: SupportCategory | null;
  onChange: (c: SupportCategory) => void;
  disabled: boolean;
}) {
  return (
    <div role="radiogroup" aria-label="What is this about?" className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
      {SUPPORT_CATEGORIES.map((c) => {
        const active = value === c;
        return (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(c)}
            className={cn(
              'rounded-lg border px-2.5 py-2 text-left text-[12px] leading-snug transition-colors disabled:cursor-not-allowed disabled:opacity-60',
              active
                ? 'border-orange-300 bg-orange-50 font-semibold text-orange-800 ring-1 ring-orange-200 dark:border-orange-700/60 dark:bg-orange-950/30 dark:text-orange-200 dark:ring-orange-900/50'
                : 'border-zinc-200 bg-white/70 text-zinc-700 hover:border-orange-200 hover:bg-orange-50/50 dark:border-zinc-800 dark:bg-zinc-900/50 dark:text-zinc-300 dark:hover:border-orange-900/50 dark:hover:bg-orange-950/20',
            )}
          >
            {SUPPORT_CATEGORY_LABELS[c]}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Carla's Decision 4 steer, shown THE MOMENT a category is chosen and BEFORE
 * the textarea — so somebody asking to REQUEST an adjustment reads "file it
 * from My Hours" before writing a paragraph. `routing.ts` owns the words;
 * nothing here refuses the ticket.
 */
function SteerNotice({ category }: { category: SupportCategory | null }) {
  const steer = category ? steerForCategory(category) : null;
  return (
    <AnimatePresence initial={false}>
      {steer && steer.kind === 'accept_with_notice' && (
        <motion.div
          key={category}
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
          className="overflow-hidden"
        >
          <div className="flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50/70 p-3 dark:border-amber-900/50 dark:bg-amber-950/25">
            <Info className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-300" aria-hidden />
            <p className="text-[11.5px] leading-relaxed text-amber-900/90 dark:text-amber-200/90">{steer.notice}</p>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/**
 * The ticket number, large and copyable, and the promise restated — the two
 * things Carla signed the employee is owed at filing. `aria-live` so a screen
 * reader hears the number arrive.
 */
function FiledPanel({
  ticket,
  onTrack,
  onAnother,
}: {
  ticket: EmployeeTicketWire;
  onTrack: () => void;
  onAnother: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(ticket.label);
      setCopied(true);
      toast.success(`Copied ${ticket.label}`);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      toast.error('Copy did not work here — select the number and copy it by hand.');
    }
  }, [ticket.label]);

  return (
    <div className="space-y-3" aria-live="polite">
      <div className="rounded-xl border border-emerald-200 bg-emerald-50/70 p-4 dark:border-emerald-900/50 dark:bg-emerald-950/25">
        <div className="flex items-start gap-2.5">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-300" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-semibold text-emerald-900 dark:text-emerald-100">
              Your ticket is in
            </p>
            <p className="mt-0.5 text-[12px] leading-relaxed text-emerald-800/90 dark:text-emerald-200/90">
              Somebody from Employee Support replies {SUPPORT_REPLY_PROMISE}. Keep this number — it is
              how your question exists as a record.
            </p>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="select-all rounded-xl border border-emerald-300/70 bg-white px-3.5 py-2 font-mono text-[22px] font-bold tabular-nums tracking-wide text-emerald-800 dark:border-emerald-800/60 dark:bg-zinc-950/60 dark:text-emerald-200">
            {ticket.label}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 border-emerald-200 bg-white/80 text-xs text-emerald-800 hover:bg-emerald-50 dark:border-emerald-800/60 dark:bg-zinc-950/40 dark:text-emerald-200 dark:hover:bg-emerald-950/40"
            onClick={() => void copy()}
          >
            {copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
            {copied ? 'Copied' : 'Copy number'}
          </Button>
        </div>
        <div className="mt-3 rounded-lg border border-emerald-200/60 bg-white/60 px-3 py-2 dark:border-emerald-900/40 dark:bg-zinc-950/30">
          <p className="mb-2 text-[10.5px] font-medium uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
            {ticket.category_label}
          </p>
          <SupportTrackMap ticket={ticket} compact />
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          className="h-8 gap-1.5 bg-gradient-to-br from-orange-500 to-rose-500 text-xs text-white hover:from-orange-600 hover:to-rose-600"
          onClick={onTrack}
        >
          <History className="size-3.5" aria-hidden />
          Track it under My tickets
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5 text-xs text-zinc-600 dark:text-zinc-400"
          onClick={onAnother}
        >
          <Plus className="size-3.5" aria-hidden />
          Raise another
        </Button>
      </div>
    </div>
  );
}

/** Three shimmering rows — never an empty state while the list is in flight or failed. */
function ListSkeleton() {
  return (
    <div className="space-y-2" aria-busy>
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="rounded-xl border border-zinc-200/70 bg-white/70 p-3 dark:border-zinc-800/70 dark:bg-zinc-900/50"
        >
          <div className="flex items-center justify-between gap-2">
            <Skeleton className="h-3.5 w-16" />
            <Skeleton className="h-4 w-20 rounded-full" />
          </div>
          <Skeleton className="mt-2 h-3 w-4/5" />
          <Skeleton className="mt-1.5 h-3 w-3/5" />
          <div className="mt-3 flex items-center gap-2">
            <Skeleton className="h-3.5 w-3.5 rounded-full" />
            <Skeleton className="h-0.5 flex-1" />
            <Skeleton className="h-3.5 w-3.5 rounded-full" />
            <Skeleton className="h-0.5 flex-1" />
            <Skeleton className="h-3.5 w-3.5 rounded-full" />
            <Skeleton className="h-0.5 flex-1" />
            <Skeleton className="h-3.5 w-3.5 rounded-full" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** One ticket in the history: number, category, when, a two-line preview, and its track. */
function TicketRow({ ticket, onOpen }: { ticket: EmployeeTicketWire; onOpen: () => void }) {
  const awaiting = ticket.thread?.awaiting_you === true;
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        'w-full rounded-xl border bg-white/70 p-3 text-left transition-colors hover:border-orange-200 hover:bg-orange-50/40 dark:bg-zinc-900/50 dark:hover:border-orange-900/50 dark:hover:bg-orange-950/15',
        awaiting
          ? 'border-emerald-200 dark:border-emerald-900/50'
          : 'border-zinc-200/80 dark:border-zinc-800/80',
      )}
      aria-label={`${ticket.label}, ${ticket.category_label}, ${ticket.status_label}${awaiting ? ', a reply is waiting for you' : ''}`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="font-mono text-[12px] font-bold tabular-nums text-zinc-800 dark:text-zinc-100">
            {ticket.label}
          </span>
          <span className="truncate text-[11px] text-zinc-500 dark:text-zinc-400">{ticket.category_label}</span>
        </div>
        <StatusChip status={ticket.status} />
      </div>
      <p className="mt-1.5 line-clamp-2 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-zinc-700 dark:text-zinc-300">
        {ticket.concern}
      </p>
      <div className="mt-3">
        <SupportTrackMap ticket={ticket} compact />
      </div>
      <div className="mt-2.5 flex items-center justify-between gap-2 text-[10.5px] text-zinc-500 dark:text-zinc-400">
        <span className="tabular-nums">Filed {dateLabel(ticket.created_at)}</span>
        {ticket.thread === null ? (
          // We could not count the replies. That is not "no replies", so it
          // does not get that sentence — rule 1.
          <Skeleton className="h-3 w-20" title="We could not count the replies just now." />
        ) : awaiting ? (
          <span className="inline-flex items-center gap-1.5 font-semibold text-emerald-700 dark:text-emerald-300">
            <span className="relative flex h-2 w-2" aria-hidden>
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
            </span>
            Support replied {ticket.thread.last_staff_reply_at ? dateLabel(ticket.thread.last_staff_reply_at) : ''}
          </span>
        ) : ticket.thread.messages === 0 ? (
          <span>No replies yet</span>
        ) : (
          <span className="tabular-nums">
            {ticket.thread.messages} {ticket.thread.messages === 1 ? 'reply' : 'replies'}
          </span>
        )}
      </div>
    </button>
  );
}

/** One line of the thread. The employee's own words read on the right, staff's on the left. */
function MessageBubble({
  side,
  authorName,
  body,
  at,
  opening = false,
}: {
  side: SupportAuthorSide;
  authorName: string | null;
  body: string;
  at: string;
  /** The ticket's `concern` — labelled so it is recognisable as the question. */
  opening?: boolean;
}) {
  const mine = side === 'employee';
  const when = whenLabel(at);
  return (
    <div className={cn('flex w-full', mine ? 'justify-end' : 'justify-start')}>
      <div className={cn('min-w-0 max-w-[88%]', mine ? 'text-right' : 'text-left')}>
        {(opening || (!mine && authorName)) && (
          <p className="mb-0.5 px-1 text-[10.5px] font-medium text-zinc-500 dark:text-zinc-400">
            {opening ? 'Your question' : authorName}
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
          {body}
        </div>
        {when && (
          <p className="mt-0.5 px-1 text-[10px] tabular-nums text-zinc-400 dark:text-zinc-500">{when}</p>
        )}
      </div>
    </div>
  );
}

/* ─────────────────────────── the component ───────────────────────────── */

interface Props {
  /** The signed-in employee's lower-cased email — the `?email=` the routes authorize against. */
  email: string;
  /** External dialog control, so the Help chooser (in both header clusters) opens the same modal. */
  dialogOpen: boolean;
  onDialogOpenChange: (open: boolean) => void;
  /**
   * Emits whenever the tickets or the counts move so the Help control can
   * badge. Fires once after the first load too, like `EmployeeSupportChat`.
   */
  onStateChange?: (state: SupportTicketsState) => void;
  /**
   * The pane the dialog lands on each time it opens. The chooser's "Raise a
   * ticket" door leaves this at its default; a tap on a "reply waiting" badge
   * can pass `'history'`. Drafts survive either way — only the reading
   * position follows the door.
   */
  initialPane?: SupportTicketsPane;
}

type ThreadState = { ticketId: string; messages: MessageWire[] };

export default function EmployeeSupportTickets({
  email,
  dialogOpen,
  onDialogOpenChange,
  onStateChange,
  initialPane = 'file',
}: Props) {
  /* ── what the server said ── */
  const [firstLoadDone, setFirstLoadDone] = useState(false);
  /** Null until a route established it. False means the migrations have not run. */
  const [migrated, setMigrated] = useState<boolean | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [tickets, setTickets] = useState<EmployeeTicketWire[]>([]);
  const [counts, setCounts] = useState<EmployeeCounts>(COUNTS_UNRESOLVED);
  const [latestStaffReplyAt, setLatestStaffReplyAt] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  /* ── where the employee is looking ── */
  const [pane, setPane] = useState<SupportTicketsPane>(initialPane);
  const [openTicketId, setOpenTicketId] = useState<string | null>(null);
  const [thread, setThread] = useState<ThreadState | null>(null);
  const [threadLoading, setThreadLoading] = useState(false);
  const [threadError, setThreadError] = useState<string | null>(null);

  /* ── the form (survives a close — rule 3) ── */
  const [category, setCategory] = useState<SupportCategory | null>(null);
  const [concern, setConcern] = useState('');
  const [filing, setFiling] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [filed, setFiled] = useState<EmployeeTicketWire | null>(null);

  /* ── reply drafts, one per ticket, so leaving a thread loses nothing ── */
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);

  /** Re-rendered on a timer so the support-hours sentence flips without a reload. */
  const [clock, setClock] = useState(() => new Date());
  /** This device's "I looked" stamp. Null until read from storage, or when none exists. */
  const [seenStamp, setSeenStamp] = useState<string | null>(null);

  const threadRef = useRef<HTMLDivElement | null>(null);
  const debounceRef = useRef<number | null>(null);

  const openTicket = useMemo(
    () => (openTicketId ? tickets.find((t) => t.id === openTicketId) ?? null : null),
    [openTicketId, tickets],
  );
  const hasOpenTickets = tickets.some((t) => t.status !== 'closed');

  /**
   * The ids we hold, and the ticket being read, as REFS rather than effect
   * dependencies.
   *
   * Every poll replaces the tickets array, so a `Set` derived from it is a new
   * object every 15 seconds. Depending on it would tear the Broadcast channel
   * down and rebuild it on that cadence — and a channel that is re-subscribing
   * is a channel that is not listening, which is exactly the window a reply
   * lands in. The subscription therefore depends only on whether it should
   * exist at all; what it does when a frame arrives is read live from here.
   */
  const ticketIdsRef = useRef<Set<string>>(new Set());
  ticketIdsRef.current = useMemo(() => new Set(tickets.map((t) => t.id)), [tickets]);
  const openTicketIdRef = useRef<string | null>(null);
  openTicketIdRef.current = openTicketId;

  /* ── reads ── */

  const mergeTicket = useCallback((t: EmployeeTicketWire) => {
    setTickets((prev) => {
      const i = prev.findIndex((x) => x.id === t.id);
      if (i === -1) return [t, ...prev];
      const next = prev.slice();
      next[i] = t;
      return next;
    });
  }, []);

  const loadTickets = useCallback(async () => {
    try {
      const res = await fetch(`/api/employee/support?email=${encodeURIComponent(email)}`, {
        cache: 'no-store',
      });
      const json = (await res.json()) as {
        migrated?: boolean;
        me?: Me | null;
        tickets?: EmployeeTicketWire[];
        counts?: EmployeeCounts;
        latest_staff_reply_at?: string | null;
        error?: string | null;
      };
      // `migrated` is absent on the failures that never reached the database
      // (no client, no identity, no grant). Absent is NOT false: saying "not
      // switched on" when the truth is "we could not look" sends the employee
      // to the wrong sentence. The flag only moves when the route carried one.
      if (typeof json.migrated === 'boolean') setMigrated(json.migrated);
      // `me` rides along on every body that resolved an identity — including
      // a 500 — and the form's auto-fill is better late than guessed.
      if (json.me) setMe(json.me);
      if (!res.ok) {
        // A FAILED READ DOES NOT CLEAR A KNOWN LIST. Last-known tickets stay on
        // screen under an honest error line; the next poll corrects them.
        setLoadError(cleanErrorMessage(json.error, 'We could not load your tickets just now.'));
        return;
      }
      setTickets(json.tickets ?? []);
      setCounts(json.counts ?? COUNTS_UNRESOLVED);
      setLatestStaffReplyAt(json.latest_staff_reply_at ?? null);
      setLoadError(null);
    } catch (e) {
      setLoadError(cleanErrorMessage(e, 'We could not load your tickets just now.'));
    } finally {
      setFirstLoadDone(true);
    }
  }, [email]);

  const loadThread = useCallback(
    async (id: string) => {
      setThreadLoading(true);
      try {
        const res = await fetch(
          `/api/employee/support/${encodeURIComponent(id)}/messages?email=${encodeURIComponent(email)}`,
          { cache: 'no-store' },
        );
        const json = (await res.json()) as {
          migrated?: boolean;
          ticket?: EmployeeTicketWire | null;
          messages?: MessageWire[];
          error?: string | null;
        };
        if (typeof json.migrated === 'boolean') setMigrated(json.migrated);
        if (res.status === 404) {
          // Malformed, missing, or not theirs — the route answers all three
          // the same way, on purpose, and so does this sentence.
          setThreadError('That ticket is not here. It may have been filed under a different address.');
          return;
        }
        if (!res.ok) {
          setThreadError(cleanErrorMessage(json.error, 'We could not load this conversation just now.'));
          return;
        }
        setThread({ ticketId: id, messages: json.messages ?? [] });
        // The thread route's ticket carries a summary computed from the FULL
        // thread — fresher than the list's fold, so it wins.
        if (json.ticket) mergeTicket(json.ticket);
        setThreadError(null);
      } catch (e) {
        setThreadError(cleanErrorMessage(e, 'We could not load this conversation just now.'));
      } finally {
        setThreadLoading(false);
      }
    },
    [email, mergeTicket],
  );

  const refreshRef = useRef(loadTickets);
  refreshRef.current = loadTickets;
  const loadThreadRef = useRef(loadThread);
  loadThreadRef.current = loadThread;

  /* ── first load ── */

  useEffect(() => {
    void refreshRef.current();
  }, [email]);

  /* ── the seen stamp follows the email ── */

  useEffect(() => {
    setSeenStamp(readSeenStamp(email));
  }, [email]);

  /* ── the door decides the pane; drafts stay put (rule 3) ── */

  useEffect(() => {
    if (!dialogOpen) return;
    setPane(initialPane);
    setOpenTicketId(null);
    setFiled(null);
    setThreadError(null);
    // Catch up the moment somebody looks, whatever the poll floor is doing.
    void refreshRef.current();
  }, [dialogOpen, initialPane]);

  /* ── the thread follows the open ticket, but only while somebody is looking ── */

  useEffect(() => {
    if (!dialogOpen || !openTicketId) return;
    void loadThreadRef.current(openTicketId);
  }, [dialogOpen, openTicketId]);

  /* ── looking at My tickets IS reading them: stamp this device ── */

  useEffect(() => {
    if (!dialogOpen || pane !== 'history' || !firstLoadDone) return;
    if (latestStaffReplyAt === null) return;
    if (seenStamp !== null && latestStaffReplyAt <= seenStamp) return;
    writeSeenStamp(email, latestStaffReplyAt);
    setSeenStamp(latestStaffReplyAt);
  }, [dialogOpen, pane, firstLoadDone, latestStaffReplyAt, seenStamp, email]);

  /* ── poll floor ── */

  useEffect(() => {
    // Nothing to poll for: every ticket is closed, or there are none. A
    // staff reply can only land on an open ticket, and a new ticket can only
    // come from this employee. Focus still catches up below.
    if (!dialogOpen && !hasOpenTickets) return;
    const period = dialogOpen ? POLL_OPEN_MS : POLL_BACKGROUND_MS;
    const id = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void refreshRef.current();
      if (dialogOpen && openTicketId) void loadThreadRef.current(openTicketId);
    }, period);
    return () => window.clearInterval(id);
  }, [dialogOpen, hasOpenTickets, openTicketId]);

  /* ── focus / visibility catch-up ── */

  useEffect(() => {
    const onWake = () => {
      if (document.visibilityState !== 'visible') return;
      void refreshRef.current();
      if (dialogOpen && openTicketId) void loadThreadRef.current(openTicketId);
    };
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('focus', onWake);
    return () => {
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('focus', onWake);
    };
  }, [dialogOpen, openTicketId]);

  /* ── the live signal ── */

  useEffect(() => {
    if (!dialogOpen && !hasOpenTickets) return;
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;

    const fire = (withThread: boolean) => {
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
      debounceRef.current = window.setTimeout(() => {
        debounceRef.current = null;
        void refreshRef.current();
        const reading = openTicketIdRef.current;
        if (withThread && reading) void loadThreadRef.current(reading);
      }, LIVE_DEBOUNCE_MS);
    };

    const channel = supabase.channel(TICKET_LIVE_TOPIC);
    channel.on('broadcast', { event: TICKET_LIVE_EVENT }, ({ payload }) => {
      const p = parseTicketLivePayload(payload);
      if (!p) return;
      const mine = ticketIdsRef.current.has(p.ticketId);
      const reading = p.ticketId === openTicketIdRef.current;
      // The payload carries no email — deliberately, the topic is anon-visible
      // — so a frame about a ticket we do not hold is somebody else's and is
      // ignored. One exception: a `ticket` frame for an id we do not know yet
      // could be OUR OWN new ticket filed from another device, so `ticket`
      // frames always re-read the list (it is this employee's own list;
      // bounded and cheap). A `message` frame only matters on our own thread.
      if (p.kind === 'ticket') {
        fire(mine && reading);
        return;
      }
      if (mine) fire(reading);
    });
    // The subscription state is not surfaced here, for the sibling's reason:
    // the poll floor makes a dead socket cost seconds, not correctness.
    channel.subscribe();

    return () => {
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
      void supabase.removeChannel(channel);
    };
  }, [dialogOpen, hasOpenTickets]);

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
  }, [thread, dialogOpen, openTicketId]);

  /* ── tell the header what to draw ── */

  const newestStatus: SupportStatus | 'none' = tickets[0]?.status ?? 'none';
  const unseenStaffReply =
    latestStaffReplyAt !== null && (seenStamp === null || latestStaffReplyAt > seenStamp);
  const outward: SupportTicketsState = useMemo(
    () => ({
      // `EmployeeHelpMenu`'s field, by its definition: provable, and quiet
      // when the counts did not resolve. See the type.
      needsAttention: counts.resolved && (counts.awaiting_you ?? 0) > 0,
      migrated,
      total: counts.total,
      open: counts.open,
      // Guarded by `resolved` here as well as at every render site: an
      // unresolved count leaves this null, so a consumer that forgot to check
      // `countsResolved` still cannot paint a `0`.
      awaitingYou: counts.resolved ? counts.awaiting_you : null,
      countsResolved: counts.resolved,
      unseenStaffReply,
      newestStatus,
    }),
    [migrated, counts, unseenStaffReply, newestStatus],
  );

  const onStateChangeRef = useRef(onStateChange);
  onStateChangeRef.current = onStateChange;
  useEffect(() => {
    onStateChangeRef.current?.(firstLoadDone ? outward : SUPPORT_TICKETS_IDLE_STATE);
  }, [outward, firstLoadDone]);

  /* ── writes ── */

  const concernText = concern.trim();
  const concernOver = concern.length > SUPPORT_CONCERN_MAX;
  const canFile =
    category !== null && concernText.length > 0 && !concernOver && !filing && migrated !== false;

  const file = useCallback(async () => {
    if (!canFile || category === null) return;
    setFiling(true);
    setFormError(null);
    try {
      const res = await fetch('/api/employee/support', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Name and work email are NOT sent. The route resolves them from the
        // session, which is what makes "fill in automatically" a fact.
        body: JSON.stringify({ category, concern: concernText, email }),
      });
      const json = (await res.json()) as {
        migrated?: boolean;
        ticket?: EmployeeTicketWire | null;
        promise?: string;
        error?: string | null;
      };
      if (typeof json.migrated === 'boolean') setMigrated(json.migrated);
      if (!res.ok || !json.ticket) {
        // The route's sentences are written for the employee ("Choose what
        // this is about.", "…Nothing was saved."). Shown as they came.
        setFormError(cleanErrorMessage(json.error, 'We could not send that. Nothing was saved.'));
        return;
      }
      // The row the SERVER returned, never an optimistic copy: the number on
      // screen must be the number in the table.
      setFiled(json.ticket);
      mergeTicket(json.ticket);
      setConcern('');
      setCategory(null);
      void loadTickets();
    } catch (e) {
      setFormError(cleanErrorMessage(e, 'We could not send that. Nothing was saved.'));
    } finally {
      setFiling(false);
    }
  }, [canFile, category, concernText, email, loadTickets, mergeTicket]);

  const replyDraft = openTicket ? replyDrafts[openTicket.id] ?? '' : '';
  const replyText = replyDraft.trim();
  const replyOver = replyDraft.length > SUPPORT_CONCERN_MAX;
  const canReply =
    openTicket !== null && replyText.length > 0 && !replyOver && !sending && migrated !== false;

  const reply = useCallback(async () => {
    if (!canReply || !openTicket) return;
    const target = openTicket;
    setSending(true);
    try {
      const res = await fetch(`/api/employee/support/${encodeURIComponent(target.id)}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: replyText, email }),
      });
      const json = (await res.json()) as {
        migrated?: boolean;
        ticket?: EmployeeTicketWire | null;
        message?: MessageWire | null;
        messages?: MessageWire[] | null;
        reopened?: boolean;
        error?: string | null;
      };
      if (typeof json.migrated === 'boolean') setMigrated(json.migrated);
      if (!res.ok || !json.message) {
        toast.error(cleanErrorMessage(json.error, 'That reply did not send. Nothing was saved.'));
        return;
      }
      const saved = json.message;
      if (json.messages) {
        // The whole thread, re-read by the server after the write.
        setThread({ ticketId: target.id, messages: json.messages });
      } else {
        // `null` = the re-read failed. Append the SAVED row (never the draft)
        // so what was said is on screen, and re-fetch for the truth.
        setThread((prev) =>
          prev && prev.ticketId === target.id
            ? {
                ticketId: prev.ticketId,
                messages: prev.messages.some((m) => m.id === saved.id) ? prev.messages : [...prev.messages, saved],
              }
            : prev,
        );
        void loadThread(target.id);
      }
      // The ticket AFTER the write — `open` again if the reply reopened it.
      if (json.ticket) mergeTicket(json.ticket);
      setReplyDrafts((prev) => {
        const next = { ...prev };
        delete next[target.id];
        return next;
      });
      toast.success(
        json.reopened ? `${target.label} is open again — it is back in the line.` : 'Reply sent.',
      );
      void loadTickets();
    } catch (e) {
      toast.error(cleanErrorMessage(e, 'That reply did not send. Nothing was saved.'));
    } finally {
      setSending(false);
    }
  }, [canReply, openTicket, replyText, email, loadThread, loadTickets, mergeTicket]);

  /* ── render ── */

  const availability = describeTicketAvailability(clock);
  const showThread = pane === 'history' && openTicket !== null;
  const threadMessages = thread && openTicket && thread.ticketId === openTicket.id ? thread.messages : null;
  const reopenedSinceClose = openTicket !== null && openTicket.closed_at !== null && openTicket.status !== 'closed';

  return (
    <Dialog open={dialogOpen} onOpenChange={onDialogOpenChange}>
      <DialogContent
        className="flex max-h-[min(90vh,800px)] w-[calc(100vw-1.25rem)] max-w-xl flex-col gap-0 overflow-hidden border-orange-100/70 bg-gradient-to-br from-white via-orange-50/35 to-blue-50/25 p-0 sm:max-w-xl dark:border-blue-950/50 dark:from-[#0d1117] dark:via-[#0f1729] dark:to-[#0a1628]"
        showCloseButton
      >
        <DialogHeader className="shrink-0 border-b border-orange-100/60 px-4 py-3 dark:border-blue-950/50">
          <DialogTitle className="flex items-center gap-2 text-base text-zinc-900 dark:text-white">
            <Ticket className="size-4 text-orange-500 dark:text-orange-400" aria-hidden />
            Employee Support tickets
          </DialogTitle>
          <DialogDescription className="text-left text-xs text-zinc-600 dark:text-zinc-400">
            {availability}
          </DialogDescription>
        </DialogHeader>

        {/* ── the two panes (v1 plan task 15: two, not three) ── */}
        <div
          role="tablist"
          aria-label="Employee Support tickets"
          className="grid shrink-0 grid-cols-2 gap-1 border-b border-orange-100/60 bg-orange-50/30 px-3 py-2 dark:border-blue-950/50 dark:bg-zinc-950/30"
        >
          <PaneTab active={pane === 'file'} onClick={() => setPane('file')} icon={Plus}>
            Raise a ticket
          </PaneTab>
          <PaneTab
            active={pane === 'history'}
            onClick={() => {
              setPane('history');
              setOpenTicketId(null);
            }}
            icon={History}
          >
            My tickets
            {/* The count is a SKELETON until the server has said it. `total`
                resolves even when the threads did not, so it is the one
                number that can appear before `counts.resolved`. */}
            {counts.total !== null ? (
              <span className="rounded-full bg-zinc-100 px-1.5 py-px text-[10px] font-semibold tabular-nums text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                {counts.total}
              </span>
            ) : firstLoadDone && migrated === false ? null : (
              <Skeleton className="h-3.5 w-5 rounded-full" />
            )}
            {counts.resolved && (counts.awaiting_you ?? 0) > 0 && (
              <span
                className="inline-flex h-2 w-2 rounded-full bg-emerald-500 ring-2 ring-white dark:ring-zinc-900"
                aria-label={`${counts.awaiting_you} ${counts.awaiting_you === 1 ? 'reply is' : 'replies are'} waiting for you`}
              />
            )}
          </PaneTab>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4">
          {migrated === false && <NotSwitchedOnNotice />}

          {loadError && migrated !== false && (
            <p className="rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-2 text-[11.5px] leading-relaxed text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/25 dark:text-amber-200">
              {loadError} Anything you already filed is still on record.
            </p>
          )}

          <AnimatePresence mode="wait" initial={false}>
            {pane === 'file' ? (
              <motion.div
                key={filed ? 'filed' : 'form'}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                className="space-y-3"
              >
                {filed ? (
                  <FiledPanel
                    ticket={filed}
                    onTrack={() => {
                      setPane('history');
                      setOpenTicketId(filed.id);
                    }}
                    onAnother={() => setFiled(null)}
                  />
                ) : (
                  <>
                    <IdentityCard me={me} loaded={firstLoadDone} />

                    <div className="space-y-1.5">
                      <p className="text-[12px] font-semibold text-zinc-800 dark:text-zinc-200">
                        What is this about?
                      </p>
                      <CategoryPicker
                        value={category}
                        onChange={(c) => {
                          setCategory(c);
                          setFormError(null);
                        }}
                        disabled={filing || migrated === false}
                      />
                      <SteerNotice category={category} />
                    </div>

                    {/* Rendered ONCE on the form, not attached to a category:
                        the person heading for "Something else" is exactly who
                        needs it (routing.ts). */}
                    <p className="flex items-start gap-2 px-0.5 text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">
                      <Info className="mt-0.5 size-3 shrink-0" aria-hidden />
                      <span className="first-letter:uppercase">{describeSteeredSubjects()}</span>
                    </p>

                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <label
                          htmlFor="employee-support-concern"
                          className="text-[12px] font-semibold text-zinc-800 dark:text-zinc-200"
                        >
                          What happened?
                        </label>
                        <span
                          className={cn(
                            'text-[11px] tabular-nums',
                            concernOver
                              ? 'font-semibold text-rose-600 dark:text-rose-400'
                              : 'text-zinc-400 dark:text-zinc-500',
                          )}
                          aria-live={concernOver ? 'polite' : undefined}
                        >
                          {concern.length} / {SUPPORT_CONCERN_MAX}
                        </span>
                      </div>
                      <textarea
                        id="employee-support-concern"
                        value={concern}
                        onChange={(e) => {
                          setConcern(e.target.value);
                          if (formError) setFormError(null);
                        }}
                        rows={5}
                        disabled={filing || migrated === false}
                        placeholder="Say what happened, when, and what you expected instead. Dates, amounts and names of documents help."
                        className="w-full resize-y rounded-lg border border-zinc-200 bg-white px-3 py-2 text-[13px] leading-relaxed text-zinc-900 placeholder:text-zinc-400 transition-colors focus:border-orange-300 focus:outline-none focus:ring-1 focus:ring-orange-200 disabled:opacity-60 dark:border-zinc-800 dark:bg-zinc-950/60 dark:text-zinc-100 dark:focus:border-orange-500/40 dark:focus:ring-orange-500/20"
                      />
                      {concernOver && (
                        <p className="text-[11px] text-rose-600 dark:text-rose-400">
                          That is too long — shorten it to {SUPPORT_CONCERN_MAX} characters or fewer. Nothing
                          is sent until you do.
                        </p>
                      )}
                    </div>

                    {formError && (
                      <p
                        role="alert"
                        className="rounded-lg border border-rose-200 bg-rose-50/70 px-3 py-2 text-[11.5px] leading-relaxed text-rose-800 dark:border-rose-900/50 dark:bg-rose-950/25 dark:text-rose-200"
                      >
                        {formError}
                      </p>
                    )}
                  </>
                )}
              </motion.div>
            ) : (
              <motion.div
                key={showThread ? `thread:${openTicket.id}` : 'list'}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                className="flex min-h-0 flex-col gap-3"
              >
                {showThread && openTicket ? (
                  <>
                    {/* ── one ticket: header, track, thread ── */}
                    <div className="flex items-center justify-between gap-2">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 gap-1 px-1.5 text-xs text-zinc-600 dark:text-zinc-400"
                        onClick={() => setOpenTicketId(null)}
                      >
                        <ArrowLeft className="size-3.5" aria-hidden />
                        All tickets
                      </Button>
                      <StatusChip status={openTicket.status} />
                    </div>

                    <div className="rounded-xl border border-zinc-200/80 bg-white/70 p-3 dark:border-zinc-800/80 dark:bg-zinc-900/50">
                      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                        <span className="font-mono text-[15px] font-bold tabular-nums text-zinc-900 dark:text-zinc-100">
                          {openTicket.label}
                        </span>
                        <span className="text-[11px] text-zinc-500 dark:text-zinc-400">
                          {openTicket.category_label} · filed {whenLabel(openTicket.created_at)}
                        </span>
                      </div>
                      <div className="mt-3">
                        <SupportTrackMap ticket={openTicket} />
                      </div>
                      {reopenedSinceClose && (
                        <p className="mt-2.5 flex items-center gap-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">
                          <RotateCcw className="size-3" aria-hidden />
                          Reopened — it is back in the line, and everything below is kept.
                        </p>
                      )}
                    </div>

                    <div
                      ref={threadRef}
                      className="max-h-[36vh] min-h-[7rem] space-y-2 overflow-y-auto rounded-xl border border-zinc-200/70 bg-white/60 p-3 dark:border-zinc-800/70 dark:bg-zinc-950/30"
                    >
                      {/* Rule 4: the concern IS the opening message. Once. */}
                      <MessageBubble
                        side="employee"
                        authorName={null}
                        body={openTicket.concern}
                        at={openTicket.created_at}
                        opening
                      />
                      {threadError ? (
                        <p className="rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-2 text-[11.5px] leading-relaxed text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/25 dark:text-amber-200">
                          {threadError}
                        </p>
                      ) : threadMessages === null ? (
                        // The replies have not arrived. Not "no replies" — rule 1.
                        <div className="space-y-2 pt-1" aria-busy>
                          <Skeleton className="h-8 w-2/3 rounded-2xl" />
                          <Skeleton className="ml-auto h-8 w-1/2 rounded-2xl" />
                        </div>
                      ) : threadMessages.length === 0 ? (
                        <p className="py-3 text-center text-[11.5px] text-zinc-400 dark:text-zinc-500">
                          {openTicket.status === 'closed'
                            ? 'This was closed without a written reply. Reply below if it is not settled.'
                            : `No reply yet — somebody answers ${SUPPORT_REPLY_PROMISE}.`}
                        </p>
                      ) : (
                        <AnimatePresence initial={false}>
                          {threadMessages.map((m) => (
                            <motion.div
                              key={m.id}
                              initial={{ opacity: 0, y: 6 }}
                              animate={{ opacity: 1, y: 0 }}
                              transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                            >
                              <MessageBubble
                                side={m.author_side}
                                authorName={m.author_name}
                                body={m.body}
                                at={m.created_at}
                              />
                            </motion.div>
                          ))}
                        </AnimatePresence>
                      )}
                      {threadLoading && threadMessages !== null && (
                        <p className="flex items-center justify-center gap-1.5 pt-1 text-[10.5px] text-zinc-400 dark:text-zinc-500">
                          <Loader2 className="size-3 animate-spin" aria-hidden />
                          Checking for new replies
                        </p>
                      )}
                    </div>
                  </>
                ) : (
                  <>
                    {/* ── the history ── */}
                    {!firstLoadDone ? (
                      <ListSkeleton />
                    ) : migrated === false ? null : loadError && tickets.length === 0 ? (
                      // We could not read the list. That is NOT "you have
                      // none", so it does not get that sentence — rule 1.
                      <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-4 text-center dark:border-amber-900/50 dark:bg-amber-950/25">
                        <p className="text-[12.5px] font-medium text-amber-900 dark:text-amber-100">
                          We could not load your tickets just now.
                        </p>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="mt-2.5 h-8 gap-1.5 text-xs"
                          onClick={() => void loadTickets()}
                        >
                          <RotateCcw className="size-3.5" aria-hidden />
                          Try again
                        </Button>
                      </div>
                    ) : tickets.length === 0 && !loadError ? (
                      <div className="rounded-xl border border-dashed border-zinc-300 bg-white/50 p-5 text-center dark:border-zinc-700 dark:bg-zinc-900/40">
                        <MessageSquareText
                          className="mx-auto size-6 text-zinc-300 dark:text-zinc-600"
                          aria-hidden
                        />
                        <p className="mt-2 text-[13px] font-medium text-zinc-700 dark:text-zinc-300">
                          You have not raised a ticket yet
                        </p>
                        <p className="mt-1 text-[11.5px] leading-relaxed text-zinc-500 dark:text-zinc-400">
                          Everything you file shows up here with its number, its status on the track, and
                          every reply — including closed ones. Nothing is deleted.
                        </p>
                        <Button
                          type="button"
                          size="sm"
                          className="mt-3 h-8 gap-1.5 bg-gradient-to-br from-orange-500 to-rose-500 text-xs text-white hover:from-orange-600 hover:to-rose-600"
                          onClick={() => setPane('file')}
                        >
                          <Plus className="size-3.5" aria-hidden />
                          Raise a ticket
                        </Button>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        <p className="px-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">
                          Newest first. Open one to read the whole conversation and reply — closed tickets
                          stay readable.
                        </p>
                        <AnimatePresence initial={false}>
                          {tickets.map((t) => (
                            <motion.div
                              key={t.id}
                              layout
                              initial={{ opacity: 0, y: 6 }}
                              animate={{ opacity: 1, y: 0 }}
                              transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                            >
                              <TicketRow ticket={t} onOpen={() => setOpenTicketId(t.id)} />
                            </motion.div>
                          ))}
                        </AnimatePresence>
                      </div>
                    )}
                  </>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* ── the footer: the send, or the composer ── */}
        {pane === 'file' && !filed && (
          <div className="shrink-0 border-t border-orange-100/60 bg-white/70 px-4 py-3 dark:border-blue-950/50 dark:bg-zinc-950/40">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="flex items-center gap-1.5 text-[11.5px] text-zinc-500 dark:text-zinc-400">
                <CheckCircle2 className="size-3.5 text-emerald-500" aria-hidden />
                We reply {SUPPORT_REPLY_PROMISE}.
              </p>
              <Button
                type="button"
                size="sm"
                className="h-8 gap-1.5 bg-gradient-to-br from-orange-500 to-rose-500 text-xs text-white hover:from-orange-600 hover:to-rose-600"
                disabled={!canFile}
                onClick={() => void file()}
              >
                {filing ? (
                  <Loader2 className="size-3.5 animate-spin" aria-hidden />
                ) : (
                  <Send className="size-3.5" aria-hidden />
                )}
                Send ticket
              </Button>
            </div>
          </div>
        )}

        {showThread && openTicket && (
          <div className="shrink-0 border-t border-orange-100/60 bg-white/70 px-4 py-3 dark:border-blue-950/50 dark:bg-zinc-950/40">
            <div className="space-y-2">
              {/* Carla: "Either side can reply again." The reopen is SAID
                  BEFORE they send, not discovered after — lifecycle.ts owns
                  the rule; this is the employee reading it. */}
              {openTicket.status === 'closed' ? (
                <p className="flex items-start gap-2 text-[11.5px] leading-relaxed text-zinc-600 dark:text-zinc-400">
                  <RotateCcw className="mt-0.5 size-3 shrink-0" aria-hidden />
                  This ticket is closed. Sending a reply reopens it and puts it back in the line — nothing
                  written before is lost.
                </p>
              ) : openTicket.status === 'answered' ? (
                <p className="text-[11.5px] leading-relaxed text-zinc-500 dark:text-zinc-400">
                  Answered. Reply if this does not settle it — the same person sees it.
                </p>
              ) : null}
              <textarea
                value={replyDraft}
                onChange={(e) => {
                  const v = e.target.value;
                  setReplyDrafts((prev) => ({ ...prev, [openTicket.id]: v }));
                }}
                onKeyDown={(e) => {
                  // Ctrl/Cmd+Enter sends. Plain Enter is a newline: a ticket
                  // reply is a letter, not a chat line, and the sibling's
                  // Enter-to-send would swallow paragraphs here.
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    void reply();
                  }
                }}
                rows={2}
                disabled={sending || migrated === false}
                placeholder={
                  openTicket.status === 'closed' ? 'Reply to reopen this ticket…' : 'Add to this ticket…'
                }
                aria-label={`Reply on ${openTicket.label}`}
                className="w-full resize-y rounded-lg border border-zinc-200 bg-white px-3 py-2 text-[13px] leading-relaxed text-zinc-900 placeholder:text-zinc-400 transition-colors focus:border-orange-300 focus:outline-none focus:ring-1 focus:ring-orange-200 disabled:opacity-60 dark:border-zinc-800 dark:bg-zinc-950/60 dark:text-zinc-100 dark:focus:border-orange-500/40 dark:focus:ring-orange-500/20"
              />
              <div className="flex items-center justify-between gap-2">
                {/* The counter appears once it is worth reading; the route
                    refuses over the bound with a sentence, and this is so the
                    employee sees it coming rather than losing a long reply. */}
                <span
                  className={cn(
                    'text-[11px] tabular-nums',
                    replyOver
                      ? 'font-semibold text-rose-600 dark:text-rose-400'
                      : replyDraft.length > SUPPORT_CONCERN_MAX - 400
                        ? 'text-zinc-400 dark:text-zinc-500'
                        : 'invisible',
                  )}
                >
                  {replyDraft.length} / {SUPPORT_CONCERN_MAX}
                </span>
                <Button
                  type="button"
                  size="sm"
                  className="h-8 gap-1.5 bg-gradient-to-br from-orange-500 to-rose-500 text-xs text-white hover:from-orange-600 hover:to-rose-600"
                  disabled={!canReply}
                  onClick={() => void reply()}
                >
                  {sending ? (
                    <Loader2 className="size-3.5 animate-spin" aria-hidden />
                  ) : openTicket.status === 'closed' ? (
                    <RotateCcw className="size-3.5" aria-hidden />
                  ) : (
                    <Send className="size-3.5" aria-hidden />
                  )}
                  {openTicket.status === 'closed' ? 'Reply and reopen' : 'Send reply'}
                </Button>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
