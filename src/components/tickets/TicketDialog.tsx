'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  Archive,
  ArchiveRestore,
  CircleDot,
  History,
  Loader2,
  MessagesSquare,
  SendHorizontal,
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import {
  TICKET_BOARD_OWNER,
  TICKET_PRIORITIES,
  TICKET_PRIORITY_LABELS,
  TICKET_STATUSES,
  TICKET_STATUS_LABELS,
  isAssignableDeveloper,
  type TicketComment,
  type TicketEvent,
  type TicketFieldChange,
  type TicketMember,
  type TicketPriority,
  type TicketRow,
  type TicketStatus,
} from '@/lib/tickets/types';
import { PRIORITY_STYLES, STATUS_STYLES, initialsFor, relativeTime } from './TicketCard';

export interface TicketDraft {
  title: string;
  description: string;
  priority: TicketPriority;
  status: TicketStatus;
  assigned_to: string;
}

interface TicketDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null → create mode; a row → view/edit mode. */
  ticket: TicketRow | null;
  canEdit: boolean;
  /** Whether this viewer may change the ticket's column (board mover, or the
   *  ticket's assigned developer — computed by the board per ticket). */
  canMove: boolean;
  /** The signed-in viewer (lowercase). Lets the Column select unlock live
   *  when the viewer picks THEMSELVES as developer in this draft — the API
   *  allows self-assign + move in one save. */
  viewerEmail: string;
  /** Whether this viewer may archive/restore (creator or admin). */
  canArchive: boolean;
  saving: boolean;
  /** Board members (fetched once by TicketsBoard); the assignee picker offers
   *  the edit/admin subset — the "developers" pool. `null` = still loading. */
  members: TicketMember[] | null;
  onCreate: (draft: TicketDraft) => Promise<boolean>;
  onSave: (id: string, draft: TicketDraft) => Promise<boolean>;
  onArchive: (id: string) => Promise<boolean>;
  onRestore: (id: string) => Promise<boolean>;
}

const EMPTY_DRAFT: TicketDraft = {
  title: '',
  description: '',
  priority: 'medium',
  status: 'todo',
  assigned_to: '',
};

/** Entrance-cascade index (see `.ticket-field` in src/index.css). */
const fieldIndex = (i: number) => ({ '--field-i': i }) as CSSProperties;

/** One dialog for both "New ticket" and card details. Create mode stays a
 *  narrow single column; details mode goes wide with the form on the left and
 *  the live activity rail (Updates thread + edit history) on the right, so the
 *  conversation and the ticket's trackmap sit beside the fields instead of
 *  below them. Read-only viewers get the same layout with inputs disabled. */
export default function TicketDialog({
  open,
  onOpenChange,
  ticket,
  canEdit,
  canMove,
  viewerEmail,
  canArchive,
  saving,
  members,
  onCreate,
  onSave,
  onArchive,
  onRestore,
}: TicketDialogProps) {
  const isCreate = ticket === null;
  const isArchived = !isCreate && Boolean(ticket.archived_at);
  // Assignment is owner-only: only the board owner sees/uses the developer
  // picker. Everyone else's new tickets default to the owner server-side, and
  // an existing ticket's assignee shows read-only.
  const isOwner = viewerEmail === TICKET_BOARD_OWNER;
  const [draft, setDraft] = useState<TicketDraft>(EMPTY_DRAFT);
  const [confirmingArchive, setConfirmingArchive] = useState(false);

  useEffect(() => {
    if (!open) return;
    setConfirmingArchive(false);
    setDraft(
      ticket
        ? {
            title: ticket.title,
            description: ticket.description ?? '',
            priority: ticket.priority,
            status: ticket.status,
            assigned_to: ticket.assigned_to ?? '',
          }
        : // New tickets default to the owner's desk; the owner can then route to
          // a developer. Non-owners never send an assignee (picker is hidden).
          { ...EMPTY_DRAFT, assigned_to: isOwner ? viewerEmail : '' },
    );
  }, [open, ticket, isOwner, viewerEmail]);

  const titleValid = draft.title.trim().length > 0;
  // Archived tickets are frozen: restore first, then edit.
  const readOnly = !isCreate && (!canEdit || isArchived);
  // Column changes: board mover, the saved assignee (canMove prop), or a
  // draft that assigns THIS viewer — mirrors the API's effective-assignee rule.
  const canMoveThis =
    canMove || (!!draft.assigned_to && draft.assigned_to.toLowerCase() === viewerEmail);

  const submit = async () => {
    if (!titleValid || saving || readOnly) return;
    const ok = isCreate ? await onCreate(draft) : await onSave(ticket.id, draft);
    if (ok) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Pinned header + footer with a scrollable middle: on a tall ticket
          (long details + activity rail) only the panes scroll, so the close
          button and action buttons never drift out of reach. */}
      {/* `tickets-theme dark`: the dialog portals outside the board wrapper, so
          it re-opts into the /tickets black+red console palette here (the
          `.ticket-dialog` rules in src/index.css swap the shared gradient
          surface for the console black in both global themes). */}
      <DialogContent
        className={cn(
          'tickets-theme dark ticket-dialog flex max-h-[88dvh] flex-col gap-0 overflow-hidden p-0',
          // Details mode is a wide two-pane worktable; create stays a card.
          isCreate ? 'sm:max-w-md' : 'sm:max-w-2xl md:h-[min(44rem,88dvh)] lg:max-w-4xl',
        )}
      >
        <DialogHeader className="ticket-field px-4 pt-4 pb-3" style={fieldIndex(0)}>
          <DialogTitle>
            {isCreate ? 'New ticket' : (
              <span className="flex items-center gap-2">
                <span className="font-mono text-sm text-muted-foreground">#{ticket.ticket_no}</span>
                Ticket details
                {isArchived && (
                  <span className="inline-flex h-5 items-center gap-1 rounded-full bg-muted px-2 text-[11px] font-medium text-muted-foreground">
                    <Archive className="size-3" aria-hidden />
                    Archived
                  </span>
                )}
              </span>
            )}
          </DialogTitle>
          <DialogDescription>
            {isCreate
              ? 'Describe the update you need. It lands in the New column for everyone to see.'
              : isArchived
                ? `Archived ${relativeTime(ticket.archived_at as string)}${ticket.archived_by ? ` by ${ticket.archived_by.split('@')[0]}` : ''} · restore it to edit or reply`
                : `Opened by ${ticket.created_by_name ?? ticket.created_by} · ${relativeTime(ticket.created_at)}`}
          </DialogDescription>
        </DialogHeader>

        {/* Middle: single scroll column in create mode / small screens; from md
            up, details mode splits into form (left) + activity rail (right),
            each with its own scroll, so replying never loses the fields. */}
        <div
          className={cn(
            'min-h-0 flex-1 overflow-y-auto',
            !isCreate && 'md:grid md:grid-cols-[minmax(0,1fr)_minmax(17rem,21rem)] md:overflow-hidden',
          )}
        >
        <div className={cn('px-4 pb-4', !isCreate && 'md:min-h-0 md:overflow-y-auto')}>
        <form
          className="grid gap-3.5"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="ticket-field grid gap-1.5" style={fieldIndex(1)}>
            <div className="flex items-baseline justify-between">
              <Label htmlFor="ticket-title">Title</Label>
              {draft.title.length >= 160 && (
                <span
                  className={cn(
                    'text-[11px] tabular-nums',
                    draft.title.length >= 200 ? 'text-destructive' : 'text-muted-foreground',
                  )}
                >
                  {draft.title.length}/200
                </span>
              )}
            </div>
            <Input
              id="ticket-title"
              value={draft.title}
              onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
              placeholder="What needs to change?"
              maxLength={200}
              disabled={readOnly || saving}
              autoFocus={isCreate}
              required
            />
          </div>

          <div className="ticket-field grid gap-1.5" style={fieldIndex(2)}>
            <Label htmlFor="ticket-description">Details</Label>
            <textarea
              id="ticket-description"
              value={draft.description}
              onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
              placeholder="Context, links, screenshots location, expected behavior…"
              rows={isCreate ? 4 : 6}
              disabled={readOnly || saving}
              className={cn(
                'w-full resize-y rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm',
                'placeholder:text-muted-foreground outline-none transition-colors',
                'focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50',
                'disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30',
              )}
            />
          </div>

          <div className="ticket-field grid gap-1.5" style={fieldIndex(3)}>
            <Label id="ticket-priority-label">Priority</Label>
            <div
              role="radiogroup"
              aria-labelledby="ticket-priority-label"
              className="grid grid-cols-4 gap-1.5"
            >
              {TICKET_PRIORITIES.map((p) => {
                const active = draft.priority === p;
                return (
                  <button
                    key={p}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    disabled={readOnly || saving}
                    onClick={() => setDraft((d) => ({ ...d, priority: p }))}
                    className={cn(
                      'flex h-8 items-center justify-center gap-1.5 rounded-lg border text-xs font-medium outline-none select-none',
                      'transition-[background-color,border-color,color,transform,box-shadow] duration-150 ease-out motion-reduce:transition-none',
                      'focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50',
                      'disabled:pointer-events-none disabled:opacity-50',
                      active
                        ? cn('scale-[1.03] border-transparent shadow-xs', PRIORITY_STYLES[p].chip)
                        : 'border-input text-muted-foreground hover:bg-muted hover:text-foreground active:scale-[0.98]',
                    )}
                  >
                    <span className={cn('size-1.5 rounded-full', PRIORITY_STYLES[p].dot)} aria-hidden />
                    {PRIORITY_STYLES[p].label}
                  </button>
                );
              })}
            </div>
          </div>

          {isCreate ? (
            // Assignment is owner-only, so only the owner gets the picker.
            // Everyone else's ticket defaults to the owner's desk server-side.
            isOwner && (
              <div className="ticket-field grid gap-1.5" style={fieldIndex(4)}>
                <Label>Assign developer (optional)</Label>
                <DeveloperSelect
                  value={draft.assigned_to}
                  onChange={(email) => setDraft((d) => ({ ...d, assigned_to: email }))}
                  disabled={saving}
                  members={members}
                />
              </div>
            )
          ) : (
            <div className="ticket-field grid gap-3 sm:grid-cols-2" style={fieldIndex(4)}>
              <div className="grid gap-1.5">
                <Label
                  title={
                    canMoveThis
                      ? undefined
                      : "Only the board owner or this ticket's assigned developer can change the column"
                  }
                >
                  Column
                </Label>
                <Select
                  value={draft.status}
                  onValueChange={(v) =>
                    v && setDraft((d) => ({ ...d, status: v as TicketStatus }))
                  }
                >
                  <SelectTrigger className="w-full" disabled={readOnly || saving || !canMoveThis}>
                    {/* Base UI renders the raw value ('in_progress') without children. */}
                    <SelectValue>
                      <span
                        className={cn('size-2 rounded-full', STATUS_STYLES[draft.status].dot)}
                        aria-hidden
                      />
                      {STATUS_STYLES[draft.status].label}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent alignItemWithTrigger={false} className="tickets-theme dark">
                    {TICKET_STATUSES.map((s) => (
                      <SelectItem key={s} value={s}>
                        <span className={cn('size-2 rounded-full', STATUS_STYLES[s].dot)} aria-hidden />
                        {STATUS_STYLES[s].label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label
                  title={isOwner ? undefined : 'Only the board owner can assign or reassign a ticket'}
                >
                  Assigned developer
                </Label>
                <DeveloperSelect
                  value={draft.assigned_to}
                  onChange={(email) => setDraft((d) => ({ ...d, assigned_to: email }))}
                  disabled={readOnly || saving || !isOwner}
                  members={members}
                  locked={!isOwner}
                />
              </div>
            </div>
          )}
        </form>
        </div>

        {/* Activity rail: the Updates thread interleaved with the ticket's
            edit history — every save shows up here as a "changed X → Y" line,
            so the trail of who touched the ticket lives next to the replies. */}
        {!isCreate && (
          <aside
            className={cn(
              'ticket-field mt-3.5 border-t border-border',
              'md:mt-0 md:flex md:min-h-0 md:flex-col md:border-t-0 md:border-l md:bg-muted/20',
            )}
            style={fieldIndex(5)}
          >
            <ActivityRail ticketId={ticket.id} archived={isArchived} />
          </aside>
        )}
        </div>

        <DialogFooter
          className={cn('ticket-field mx-0 mb-0', !isCreate && canArchive && 'sm:justify-between')}
          style={fieldIndex(isCreate ? 5 : 6)}
        >
          {!isCreate && canArchive && !isArchived && (
            <Button
              variant="outline"
              disabled={saving}
              className={cn(confirmingArchive && 'border-red-500/50 text-red-400')}
              onClick={async () => {
                if (!confirmingArchive) {
                  setConfirmingArchive(true);
                  return;
                }
                const ok = await onArchive(ticket.id);
                if (ok) onOpenChange(false);
              }}
            >
              <Archive data-icon="inline-start" />
              {confirmingArchive ? 'Confirm archive' : 'Archive ticket'}
            </Button>
          )}
          {!isCreate && canArchive && isArchived && (
            <Button
              variant="outline"
              disabled={saving}
              onClick={async () => {
                const ok = await onRestore(ticket.id);
                if (ok) onOpenChange(false);
              }}
            >
              <ArchiveRestore data-icon="inline-start" />
              Restore ticket
            </Button>
          )}
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>
              {readOnly ? 'Close' : 'Cancel'}
            </Button>
            {!readOnly && (
              <Button disabled={!titleValid || saving} onClick={() => void submit()}>
                {saving && <Loader2 className="animate-spin" data-icon="inline-start" />}
                {isCreate ? 'Create ticket' : 'Save changes'}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Assigned-developer picker ─────────────────────────────────────────────────

/** Sentinel for "no assignee" — Base UI Select can't take '' as an item value. */
const UNASSIGNED = '__unassigned__';

/** Who can own a ticket: the members with an Edit grant on the Ticket Board
 *  (Admin → Roles & Permissions) or the admin role — never free-text emails
 *  (the API rejects anyone outside this pool). Assigning fires an instant
 *  in-app + email notification to the developer, so the caption says so. A
 *  current assignee who has since lost Edit access still renders (flagged),
 *  keeping old tickets honest without blocking edits. */
function DeveloperSelect({
  value,
  onChange,
  disabled,
  members,
  locked = false,
}: {
  value: string;
  onChange: (email: string) => void;
  disabled: boolean;
  members: TicketMember[] | null;
  /** Read-only because the viewer isn't the board owner — the picker shows the
   *  current assignee but can't change it, and the caption says why. */
  locked?: boolean;
}) {
  const developers = useMemo(() => (members ?? []).filter(isAssignableDeveloper), [members]);
  const loading = members === null;
  const selected = developers.find((m) => m.email === value) ?? null;
  // Assigned before the pool rule (or the grant was revoked since).
  const legacy = value && !selected ? value : null;

  return (
    <div className="grid gap-1.5">
      <Select
        value={value || UNASSIGNED}
        onValueChange={(v) => v && onChange(v === UNASSIGNED ? '' : v)}
      >
        <SelectTrigger className="w-full" disabled={disabled || loading}>
          {/* Base UI renders the raw value (an email) without children. */}
          <SelectValue>
            {loading
              ? 'Loading developers…'
              : selected
                ? (selected.name ?? selected.email.split('@')[0])
                : legacy
                  ? `${legacy.split('@')[0]} (no Edit access)`
                  : 'Unassigned'}
          </SelectValue>
        </SelectTrigger>
        <SelectContent alignItemWithTrigger={false} className="tickets-theme dark">
          <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
          {developers.map((m) => (
            <SelectItem key={m.email} value={m.email}>
              <span
                className="flex size-4 shrink-0 items-center justify-center rounded-full bg-muted text-[8px] font-semibold text-muted-foreground"
                aria-hidden
              >
                {initialsFor(m.name, m.email)}
              </span>
              {m.name ?? m.email.split('@')[0]}
            </SelectItem>
          ))}
          {legacy && (
            <SelectItem value={legacy}>{legacy.split('@')[0]} (no Edit access)</SelectItem>
          )}
        </SelectContent>
      </Select>
      <p className="text-[11px] leading-4 text-muted-foreground/80">
        {locked
          ? 'Only the board owner can assign or reassign a ticket.'
          : !loading && developers.length === 0
            ? 'No developers yet — grant Tickets “Edit” in Admin → Roles & Permissions.'
            : 'Developers with Edit access to the Ticket Board. Assignees are notified instantly and can move their ticket between columns.'}
      </p>
    </div>
  );
}

// ── Activity rail (Updates thread + edit history) ────────────────────────────

type FeedItem =
  | { kind: 'comment'; at: string; comment: TicketComment }
  | { kind: 'event'; at: string; event: TicketEvent };

const clip = (s: string | null, n = 40) =>
  !s ? '' : s.length > n ? `${s.slice(0, n - 1)}…` : s;

/** Human line for one field change on the history trail. */
function describeChange(c: TicketFieldChange): string {
  switch (c.field) {
    case 'title':
      return `renamed “${clip(c.from)}” → “${clip(c.to)}”`;
    case 'description':
      return 'edited the details';
    case 'priority':
      return `set priority ${TICKET_PRIORITY_LABELS[c.from as TicketPriority] ?? c.from} → ${TICKET_PRIORITY_LABELS[c.to as TicketPriority] ?? c.to}`;
    case 'status':
      return `moved ${TICKET_STATUS_LABELS[c.from as TicketStatus] ?? c.from} → ${TICKET_STATUS_LABELS[c.to as TicketStatus] ?? c.to}`;
    case 'assigned_to':
      return c.to
        ? `assigned to ${c.to.split('@')[0]}`
        : `unassigned ${(c.from ?? '').split('@')[0]}`;
  }
}

function describeEvent(e: TicketEvent): string {
  switch (e.action) {
    case 'created':
      return 'opened this ticket';
    case 'archived':
      return 'archived this ticket';
    case 'restored':
      return 'restored this ticket';
    case 'moved': {
      const c = e.changes?.find((x) => x.field === 'status');
      return c ? describeChange(c) : 'moved this ticket';
    }
    case 'updated':
      return (e.changes ?? []).map(describeChange).join(' · ') || 'edited this ticket';
  }
}

/** The ticket's conversation + trackmap in one chronological feed. Replies
 *  render as chat entries; edit-history events render as compact system lines
 *  between them. Everyone who can see the board can reply; Supabase Realtime
 *  on both tables keeps an open dialog in sync while others answer or edit. */
function ActivityRail({ ticketId, archived }: { ticketId: string; archived: boolean }) {
  const [comments, setComments] = useState<TicketComment[] | null>(null);
  const [events, setEvents] = useState<TicketEvent[] | null>(null);
  const [draft, setDraft] = useState('');
  const [posting, setPosting] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const [cRes, eRes] = await Promise.all([
        fetch(`/api/tickets/${ticketId}/comments`, { cache: 'no-store' }),
        fetch(`/api/tickets/${ticketId}/events`, { cache: 'no-store' }),
      ]);
      if (cRes.ok) {
        const j = (await cRes.json()) as { comments?: TicketComment[] };
        if (Array.isArray(j.comments)) setComments(j.comments);
      }
      if (eRes.ok) {
        const j = (await eRes.json()) as { events?: TicketEvent[] };
        if (Array.isArray(j.events)) setEvents(j.events);
      }
    } catch {
      // Realtime/poll will retry; keep whatever we have.
    }
  }, [ticketId]);

  useEffect(() => {
    void load();
  }, [load]);

  useLiveRefresh({
    tables: ['ticket_comments', 'ticket_events'],
    channel: `ticket-activity-${ticketId}`,
    onRefresh: () => void load(),
  });

  const feed = useMemo<FeedItem[]>(() => {
    const items: FeedItem[] = [
      ...(comments ?? []).map((c) => ({ kind: 'comment' as const, at: c.created_at, comment: c })),
      ...(events ?? []).map((e) => ({ kind: 'event' as const, at: e.created_at, event: e })),
    ];
    return items.sort((a, b) => a.at.localeCompare(b.at));
  }, [comments, events]);

  const loading = comments === null && events === null;
  const commentCount = comments?.length ?? 0;

  // Keep the newest entry in view as the feed grows.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [feed.length]);

  const send = async () => {
    const body = draft.trim();
    if (!body || posting) return;
    setPosting(true);
    try {
      const res = await fetch(`/api/tickets/${ticketId}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { error?: string } | null;
        toast.error(j?.error ?? 'Could not post the reply');
        return;
      }
      const j = (await res.json()) as { comment: TicketComment };
      setComments((prev) => [...(prev ?? []), j.comment]);
      setDraft('');
    } finally {
      setPosting(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-col gap-2 px-4 py-3 md:h-full">
      <div className="flex items-center gap-1.5">
        <MessagesSquare className="size-3.5 text-muted-foreground" aria-hidden />
        <Label>Updates{commentCount > 0 ? ` (${commentCount})` : ''}</Label>
        <span className="ml-auto flex items-center gap-1 text-[11px] text-muted-foreground/70">
          <History className="size-3" aria-hidden />
          history included
        </span>
      </div>

      <div
        ref={listRef}
        className="flex max-h-56 min-h-0 flex-col gap-2.5 overflow-y-auto pr-1 md:max-h-none md:flex-1"
      >
        {loading ? (
          <p className="py-1 text-xs text-muted-foreground">Loading activity…</p>
        ) : feed.length === 0 ? (
          <p className="py-1 text-xs text-muted-foreground">
            No activity yet — replies and every edit to this ticket land here.
          </p>
        ) : (
          feed.map((item) =>
            item.kind === 'comment' ? (
              <div key={`c-${item.comment.id}`} className="flex gap-2">
                <span
                  className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[9px] font-semibold text-muted-foreground"
                  aria-hidden
                >
                  {initialsFor(item.comment.author_name, item.comment.author_email)}
                </span>
                <div className="min-w-0">
                  <p className="text-xs">
                    <span className="font-medium" title={item.comment.author_email}>
                      {item.comment.author_name ?? item.comment.author_email.split('@')[0]}
                    </span>
                    <span className="ml-1.5 text-[11px] text-muted-foreground/80">
                      {relativeTime(item.comment.created_at)}
                    </span>
                  </p>
                  <p className="text-sm break-words whitespace-pre-wrap">{item.comment.body}</p>
                </div>
              </div>
            ) : (
              <div
                key={`e-${item.event.id}`}
                className="flex items-start gap-2 text-[11px] leading-4 text-muted-foreground"
              >
                <CircleDot className="mt-0.5 size-3 shrink-0 text-muted-foreground/60" aria-hidden />
                <p className="min-w-0 break-words">
                  <span className="font-medium text-foreground/80" title={item.event.actor_email}>
                    {item.event.actor_name ?? item.event.actor_email.split('@')[0]}
                  </span>{' '}
                  {describeEvent(item.event)}
                  <span className="ml-1.5 text-muted-foreground/70">
                    {relativeTime(item.event.created_at)}
                  </span>
                </p>
              </div>
            ),
          )
        )}
      </div>

      <div className="flex items-end gap-1.5">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={archived ? 'Archived — restore to reply' : 'Reply… (Shift+Enter for a new line)'}
          rows={1}
          maxLength={4000}
          disabled={posting || archived}
          aria-label="Reply to this ticket"
          className={cn(
            'min-h-8 w-full resize-none rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm',
            'placeholder:text-muted-foreground outline-none transition-colors',
            'focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50',
            'disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30',
          )}
        />
        <Button
          size="icon"
          aria-label="Send reply"
          disabled={!draft.trim() || posting || archived}
          onClick={() => void send()}
        >
          {posting ? <Loader2 className="animate-spin" /> : <SendHorizontal />}
        </Button>
      </div>
    </div>
  );
}
