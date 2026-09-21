'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { motion } from 'motion/react';
import { ChevronRight, LifeBuoy, MessageCircle, Ticket } from 'lucide-react';
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@/components/ui/popover';
import { buttonVariants } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { SUPPORT_CLOSE_HOUR, SUPPORT_OPEN_HOUR, isSupportOpen } from '@/lib/support/hours';
import { SUPPORT_REPLY_PROMISE } from '@/lib/support/types';
import type { SupportChatState } from './EmployeeSupportChat';

/**
 * Employee Support — HELP, the one control an employee sees.
 *
 * Ruling: Kane, 2026-09-21 — *"Instead of Chat change that to Help where they
 * can choose between a Chat Support or a Ticket"* — recorded in
 * docs/superpowers/plans/2026-09-21-employee-support-tickets-board.md:14-16.
 * Plan tasks: docs/superpowers/plans/2026-09-14-employee-support.md (16, 28).
 *
 * The button beside FAQs in the dashboard header used to open the live chat
 * directly (`SupportChatButton`, EmployeeSupportChat.tsx). It now opens THIS: a
 * small chooser with exactly two doors — **Chat Support**, which opens the
 * shipped `EmployeeSupportChat` dialog, and **Raise a ticket**, which opens
 * `EmployeeSupportTickets`. The dialogs are mounted at the dashboard root; this
 * file owns only the button, its badge, and the two doors.
 *
 * NOT A FLOATING BUBBLE, AND IT MUST NOT BECOME ONE
 * ---------------------------------------------------------------------------
 * Penny owns the employee side's one fixed bottom-right control
 * (`docs/features/employee-penny-ai.md:143-146`), and the reason the chat
 * button went into the header cluster rather than a corner
 * (EmployeeSupportChat.tsx:45-54) applies twice over to a chooser that fronts
 * two support desks. So: a popover anchored to the header button, rendered in
 * BOTH mirrored clusters through one component with two renderings — the
 * mobile cluster's 9x9 icon pill and the desktop cluster's labelled `sm` pill
 * — so the pair cannot drift. The doors close the popover and hand off to a
 * dialog; nothing here is positioned against the viewport.
 *
 * EXACTLY TWO DOORS
 * ---------------------------------------------------------------------------
 * Kane named two. A third door — FAQs, Penny, a status page — is a different
 * ruling. The **track map** Kane asked for on 2026-09-18 lives BEHIND the
 * ticket door (it is a view of the employee's own tickets, and the tickets
 * dialog owns that read); this chooser only tells them whether a reply is
 * waiting, so they know which door to open.
 *
 * THE BADGE COMPOSES BOTH SURFACES, UNDER THE CHAT BUTTON'S RULES
 * ---------------------------------------------------------------------------
 * `helpBadgeFor` is the one place the two states are folded into one mark, and
 * it keeps the rules the chat button held (EmployeeSupportChat.tsx:56-74):
 *
 * 1. **An unknown place in the line is a SKELETON, never a `0`.** `resolved:
 *    false` means we cannot tell, and "cannot tell" and "nobody is waiting"
 *    must never render alike.
 * 2. **A position is NEVER clamped.** `NotificationBellButton` prints `99+`
 *    over 99 unread (EmployeeDashboard.tsx); a hundredth place in a queue is
 *    exactly the number somebody needs in order to decide to raise a ticket
 *    instead. There is no `99+` in this file and there must not be one.
 * 3. **A dot means "there is a state change here", not "N unread".** Neither
 *    table carries a `last_read_at`, so an unread count would live only in
 *    this browser and paint a permanent dot on a thread already read. The
 *    tickets route says the same (app/api/employee/support/route.ts:76-96): it
 *    reports what it can PROVE — the last word on a ticket is staff's — and
 *    that is what `needsAttention` means here.
 *
 * Precedence: a live queue position outranks everything, because it changes
 * while they watch. Then a dot: emerald when somebody is with them or a staff
 * reply waits; amber only when the sole news is that an unanswered chat became
 * a ticket, which is the chat dialog's own tone for that state.
 *
 * ONE HONEST LINE PER DOOR
 * ---------------------------------------------------------------------------
 * The chat door says whether support is open and that an unanswered chat
 * becomes a ticket. It is built here from `isSupportOpen` and the exported
 * hour constants — NOT `describeSupportHours`, which prints a Manila zone
 * nobody is in (Kane, 2026-09-19: every employee is on EST), and NOT
 * `describeSupportAvailability`, which promises a pickup that is true of a
 * ticket and false of a live queue. EmployeeSupportChat.tsx:76-89 gives the
 * same reasoning for the same choice; `hours.ts` is left exactly as the ticket
 * form needs it. The ticket door states the one-working-day promise
 * (`SUPPORT_REPLY_PROMISE`, Carla's Decision 5) and nothing else.
 *
 * THE TICKETS CONTRACT IS DELIBERATELY THE MINIMUM
 * ---------------------------------------------------------------------------
 * {@link SupportTicketsBadgeState} is two fields. The tickets dialog emits
 * whatever it needs for its own screen; this button needs only "is a reply
 * waiting" and "has the migration run", and a wider contract here would make
 * the badge depend on things it does not draw. Anything structurally carrying
 * these two fields satisfies it.
 *
 * `migrated === false` on a door is a HINT, not a lock. The door stays open so
 * the dialog behind it can say, in full, that nothing would be saved (the chat
 * dialog does so at EmployeeSupportChat.tsx:871-887). Disabling the door would
 * hide the only sentence that explains why.
 *
 * THE STAFF-ONLY TRIAL GATE GATES THIS COMPONENT
 * ---------------------------------------------------------------------------
 * Carla signed *"You and the support team try it before any employee sees
 * it"*, and the 2026-09-21 plan (:22-24) says that gate is about the Help
 * button, the single thing an employee sees. It is not built here. When it
 * lands it belongs around the mount of this component in EmployeeDashboard,
 * not inside either dialog — gating a door and leaving the button is a button
 * that leads nowhere.
 */

/* ─────────────────────────── the tickets contract ────────────────────────── */

/**
 * What the tickets dialog tells the Help badge. See the header — two fields,
 * on purpose. The emitting component may carry more; this is what is read.
 */
export type SupportTicketsBadgeState = {
  /**
   * The last word on at least one of the employee's tickets is staff's — a
   * reply is waiting on them. A state the server can prove
   * (app/api/employee/support/route.ts:84-86), never an unread count.
   */
  needsAttention: boolean;
  /** Null until a route has established it. False = the ticket migration has not run. */
  migrated: boolean | null;
};

/** Before the tickets dialog's first load lands. Frozen: it is a shared default. */
export const IDLE_TICKETS_BADGE: Readonly<SupportTicketsBadgeState> = Object.freeze({
  needsAttention: false,
  migrated: null,
});

/* ────────────────────────────────── copy ─────────────────────────────────── */

/** `9` → `9 AM`, `17` → `5 PM`. Local to this file; the window is whole hours. */
function hour12(hour24: number): string {
  const suffix = hour24 < 12 ? 'AM' : 'PM';
  const h = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${h} ${suffix}`;
}

/** `1st`, `2nd`, `3rd`, `11th`. A place in a line, never a count. */
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

/** The window, Eastern only — see "ONE HONEST LINE PER DOOR" in the header. */
export function supportHoursLine(): string {
  return `${hour12(SUPPORT_OPEN_HOUR)} – ${hour12(SUPPORT_CLOSE_HOUR)} Eastern, Mon–Fri`;
}

/**
 * The chat door's one line: is anybody there, and what happens if nobody is.
 * Q1 ("an unanswered chat becomes a ticket") is asserted in both branches, so
 * the door never implies that a chat sent into a closed window is lost.
 */
export function describeChatDoor(at: Date): string {
  const hours = supportHoursLine();
  return isSupportOpen(at)
    ? `Open now, ${hours}. If nobody picks your chat up, it becomes a ticket.`
    : `Closed right now — ${hours}. Nobody is likely to join; an unanswered chat becomes a ticket.`;
}

/** The ticket door's one line: a number and the promise. Carla's Decision 5, displayed. */
export const TICKET_DOOR_COPY = `Ask in writing. You get a ticket number and an answer ${SUPPORT_REPLY_PROMISE}.`;

/* ─────────────────────────── badge and label rules ───────────────────────── */

/** What the Help button draws in its corner. One of four things, never a `0`. */
export type HelpBadge =
  | { kind: 'none' }
  /** In the line, place unknown. Rule 1 — a shimmer, never a number. */
  | { kind: 'skeleton' }
  /** In the line at this place. Rule 2 — rendered as-is, never clamped. */
  | { kind: 'position'; position: number }
  /** Something changed on one surface. `amber` only for "your chat became a ticket". */
  | { kind: 'dot'; tone: 'emerald' | 'amber' };

/**
 * Fold both surfaces into one mark. Pure, so the precedence in the header is
 * something a test can pin rather than something a render implies.
 */
export function helpBadgeFor(chat: SupportChatState, tickets: SupportTicketsBadgeState): HelpBadge {
  if (chat.status === 'waiting') {
    if (!chat.queueResolved || chat.position === null) return { kind: 'skeleton' };
    return { kind: 'position', position: chat.position };
  }
  // The chat dialog's `needsAttention` is true for "somebody is with you" and
  // for "your chat became ticket ES-n"; the status tells the two apart.
  const chatBecameTicket = chat.needsAttention && chat.status === 'abandoned';
  const chatLive = chat.needsAttention && !chatBecameTicket;
  if (chatLive || tickets.needsAttention) return { kind: 'dot', tone: 'emerald' };
  if (chatBecameTicket) return { kind: 'dot', tone: 'amber' };
  return { kind: 'none' };
}

/**
 * The accessible name and tooltip. Says everything that is true, most urgent
 * first, so a screen-reader user hears the same thing the badge shows.
 */
export function helpLabelFor(chat: SupportChatState, tickets: SupportTicketsBadgeState): string {
  const news: string[] = [];
  if (chat.status === 'waiting') {
    news.push(
      !chat.queueResolved || chat.position === null
        ? 'working out your place in the chat line'
        : `you are ${ordinal(chat.position)} in the chat line`,
    );
  } else if (chat.status === 'claimed' || chat.status === 'live') {
    news.push('someone is with you in chat');
  } else if (chat.status === 'abandoned' && chat.needsAttention) {
    news.push('your chat became a support ticket');
  }
  if (tickets.needsAttention) news.push('a reply is waiting on a ticket');
  return news.length > 0 ? `Help — ${news.join('; ')}` : 'Help — chat with Employee Support or raise a ticket';
}

/** A short status under a door's copy. `null` when there is nothing to say. */
export type DoorHint = { text: string; tone: 'good' | 'waiting' | 'muted' };

export function chatDoorHint(chat: SupportChatState): DoorHint | null {
  if (chat.status === 'waiting') {
    if (!chat.queueResolved || chat.position === null)
      return { text: 'Working out your place in the line — you are still in it.', tone: 'waiting' };
    return { text: `You are ${ordinal(chat.position)} in line. Your place is kept.`, tone: 'waiting' };
  }
  if (chat.status === 'claimed' || chat.status === 'live')
    return { text: 'Someone is with you now.', tone: 'good' };
  if (chat.status === 'abandoned' && chat.needsAttention)
    return { text: 'Your last chat became a support ticket.', tone: 'waiting' };
  if (chat.migrated === false) return { text: 'Not switched on yet.', tone: 'muted' };
  return null;
}

export function ticketDoorHint(tickets: SupportTicketsBadgeState): DoorHint | null {
  if (tickets.needsAttention) return { text: 'A reply is waiting for you.', tone: 'good' };
  if (tickets.migrated === false) return { text: 'Not switched on yet.', tone: 'muted' };
  return null;
}

/* ───────────────────────────────── pieces ────────────────────────────────── */

/** Re-render the chat door's line so it flips at 9 AM and 5 PM Eastern while open. */
const CLOCK_TICK_MS = 60_000;

const HINT_TONE: Record<DoorHint['tone'], string> = {
  good: 'text-emerald-700 dark:text-emerald-300',
  waiting: 'text-amber-700 dark:text-amber-300',
  muted: 'text-zinc-400 dark:text-zinc-500',
};

/** The corner mark. Classes copied from `SupportChatButton` so the pill reads unchanged. */
function HelpBadgeMark({ badge }: { badge: HelpBadge }) {
  if (badge.kind === 'skeleton') {
    return (
      <Skeleton className="pointer-events-none absolute -right-1 -top-1 h-4 min-w-[1.1rem] rounded-full ring-2 ring-white dark:ring-zinc-900" />
    );
  }
  if (badge.kind === 'position') {
    return (
      <motion.span
        key={badge.position}
        initial={{ scale: 0.5, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: 'spring', stiffness: 420, damping: 14 }}
        className="pointer-events-none absolute -right-1 -top-1 inline-flex min-w-[1.1rem] items-center justify-center rounded-full bg-gradient-to-br from-orange-500 to-amber-500 px-1 py-px text-[9px] font-bold tabular-nums text-white ring-2 ring-white dark:ring-zinc-900"
        aria-hidden
      >
        {/* Unclamped, on purpose — rule 2 in the header. */}
        {badge.position}
      </motion.span>
    );
  }
  if (badge.kind === 'dot') {
    const tone = badge.tone === 'amber' ? 'bg-amber-500' : 'bg-emerald-500';
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
}

/** One door. A full-width button: title, one honest line, an optional hint. */
function HelpDoor({
  icon,
  title,
  copy,
  hint,
  accent,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  copy: string;
  hint: DoorHint | null;
  accent: 'chat' | 'ticket';
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group flex w-full items-start gap-3 rounded-xl border p-3 text-left transition-colors outline-none',
        'border-zinc-200/80 bg-white/80 hover:bg-zinc-50 focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-offset-white',
        'dark:border-zinc-800 dark:bg-zinc-900/50 dark:hover:bg-zinc-900 dark:focus-visible:ring-offset-zinc-950',
        accent === 'chat'
          ? 'hover:border-orange-300 focus-visible:ring-orange-300 dark:hover:border-orange-900/60'
          : 'hover:border-blue-300 focus-visible:ring-blue-300 dark:hover:border-blue-900/60',
      )}
    >
      <span
        className={cn(
          'mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
          accent === 'chat'
            ? 'bg-gradient-to-br from-orange-100 to-amber-100 text-orange-600 dark:from-orange-950/60 dark:to-amber-950/40 dark:text-orange-300'
            : 'bg-gradient-to-br from-blue-100 to-sky-100 text-blue-600 dark:from-blue-950/60 dark:to-sky-950/40 dark:text-blue-300',
        )}
        aria-hidden
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-semibold text-zinc-900 dark:text-zinc-100">{title}</span>
        <span className="mt-0.5 block text-[11.5px] leading-relaxed text-zinc-500 dark:text-zinc-400">
          {copy}
        </span>
        {hint && (
          <span className={cn('mt-1 block text-[11px] font-medium', HINT_TONE[hint.tone])}>
            {hint.text}
          </span>
        )}
      </span>
      <ChevronRight
        className="mt-2.5 size-3.5 shrink-0 text-zinc-300 transition-transform group-hover:translate-x-0.5 group-hover:text-zinc-500 dark:text-zinc-600 dark:group-hover:text-zinc-400"
        aria-hidden
      />
    </button>
  );
}

/* ─────────────────────────────── the control ─────────────────────────────── */

interface Props {
  /** Emitted by `EmployeeSupportChat` through `onStateChange`. */
  chatState: SupportChatState;
  /** Emitted by `EmployeeSupportTickets` through `onStateChange`; see {@link SupportTicketsBadgeState}. */
  ticketsState: SupportTicketsBadgeState;
  /** The chat door. Opens the `EmployeeSupportChat` dialog mounted at the dashboard root. */
  onOpenChat: () => void;
  /** The ticket door. Opens the `EmployeeSupportTickets` dialog mounted at the dashboard root. */
  onOpenTickets: () => void;
  /** `icon` is the mobile cluster's 9x9 pill; `labelled` is the desktop cluster's `sm` pill. */
  variant: 'icon' | 'labelled';
}

/**
 * The HELP button and its chooser. Rendered twice by `EmployeeDashboard` —
 * once per header cluster, with the matching `variant` — and never anywhere
 * else.
 */
export function EmployeeHelpMenu({ chatState, ticketsState, onOpenChat, onOpenTickets, variant }: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [clock, setClock] = useState(() => new Date());

  useEffect(() => {
    if (!menuOpen) return;
    setClock(new Date());
    const id = window.setInterval(() => setClock(new Date()), CLOCK_TICK_MS);
    return () => window.clearInterval(id);
  }, [menuOpen]);

  const badge = helpBadgeFor(chatState, ticketsState);
  const label = helpLabelFor(chatState, ticketsState);

  // Close the chooser, then open the door. The dialogs live at the dashboard
  // root, so the handoff is a state flip in the parent and nothing is nested.
  const choose = (door: 'chat' | 'ticket') => {
    setMenuOpen(false);
    if (door === 'chat') onOpenChat();
    else onOpenTickets();
  };

  return (
    <Popover open={menuOpen} onOpenChange={setMenuOpen}>
      <PopoverTrigger
        title={label}
        aria-label={label}
        className={cn(
          variant === 'icon'
            ? cn(
                buttonVariants({ variant: 'outline', size: 'icon' }),
                'relative h-9 w-9 rounded-full border-zinc-200 bg-white/90 text-zinc-700 shadow-sm hover:border-orange-300 hover:bg-orange-50 hover:text-orange-600 dark:border-zinc-800 dark:bg-zinc-900/70 dark:text-zinc-300 dark:hover:border-orange-900/60 dark:hover:bg-orange-950/30 dark:hover:text-orange-400',
              )
            : cn(
                buttonVariants({ variant: 'outline', size: 'sm' }),
                'relative h-8 gap-1.5 border-zinc-200 bg-white/70 text-xs font-medium text-zinc-700 hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-300 dark:hover:border-zinc-700',
              ),
          'data-popup-open:border-orange-300 data-popup-open:bg-orange-50 data-popup-open:text-orange-600 dark:data-popup-open:border-orange-900/60 dark:data-popup-open:bg-orange-950/30 dark:data-popup-open:text-orange-400',
        )}
      >
        <LifeBuoy className={variant === 'icon' ? 'size-4.5' : 'size-3.5'} aria-hidden />
        {variant === 'labelled' && 'Help'}
        <HelpBadgeMark badge={badge} />
      </PopoverTrigger>

      <PopoverContent
        align="end"
        sideOffset={8}
        className="w-[min(20rem,calc(100vw-1.5rem))] rounded-2xl border border-orange-100/70 bg-white p-2 text-zinc-900 shadow-xl ring-0 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100"
      >
        <div className="px-2 pb-2 pt-1">
          <PopoverTitle className="text-[13px] font-semibold text-zinc-900 dark:text-zinc-100">
            How can we help?
          </PopoverTitle>
          <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
            Two ways to reach Employee Support.
          </p>
        </div>
        <div className="space-y-1.5">
          <HelpDoor
            accent="chat"
            icon={<MessageCircle className="size-4.5" aria-hidden />}
            title="Chat Support"
            copy={describeChatDoor(clock)}
            hint={chatDoorHint(chatState)}
            onClick={() => choose('chat')}
          />
          <HelpDoor
            accent="ticket"
            icon={<Ticket className="size-4.5" aria-hidden />}
            title="Raise a ticket"
            copy={TICKET_DOOR_COPY}
            hint={ticketDoorHint(ticketsState)}
            onClick={() => choose('ticket')}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}
