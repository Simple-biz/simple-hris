'use client';

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { Loader2, MessagesSquare, SendHorizontal, Trash2 } from 'lucide-react';
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
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  type TicketComment,
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
  /** Whether this viewer may change the ticket's column (movers allowlist). */
  canMove: boolean;
  canDelete: boolean;
  saving: boolean;
  onCreate: (draft: TicketDraft) => Promise<boolean>;
  onSave: (id: string, draft: TicketDraft) => Promise<boolean>;
  onDelete: (id: string) => Promise<boolean>;
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

/** One dialog for both "New ticket" and card details. Read-only viewers get
 *  the same layout with inputs disabled, so the board never forks its UI. */
export default function TicketDialog({
  open,
  onOpenChange,
  ticket,
  canEdit,
  canMove,
  canDelete,
  saving,
  onCreate,
  onSave,
  onDelete,
}: TicketDialogProps) {
  const isCreate = ticket === null;
  const [draft, setDraft] = useState<TicketDraft>(EMPTY_DRAFT);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  useEffect(() => {
    if (!open) return;
    setConfirmingDelete(false);
    setDraft(
      ticket
        ? {
            title: ticket.title,
            description: ticket.description ?? '',
            priority: ticket.priority,
            status: ticket.status,
            assigned_to: ticket.assigned_to ?? '',
          }
        : EMPTY_DRAFT,
    );
  }, [open, ticket]);

  const titleValid = draft.title.trim().length > 0;
  const readOnly = !isCreate && !canEdit;

  const submit = async () => {
    if (!titleValid || saving) return;
    const ok = isCreate ? await onCreate(draft) : await onSave(ticket.id, draft);
    if (ok) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Pinned header + footer with a scrollable middle: on a tall ticket
          (long details + reply thread) only the fields scroll, so the close
          button and action buttons never drift out of reach. */}
      {/* `tickets-theme dark`: the dialog portals outside the board wrapper, so
          it re-opts into the /tickets black+red console palette here (the
          `.ticket-dialog` rules in src/index.css swap the shared gradient
          surface for the console black in both global themes). */}
      <DialogContent className="tickets-theme dark ticket-dialog flex max-h-[88dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-md">
        <DialogHeader className="ticket-field px-4 pt-4 pb-3" style={fieldIndex(0)}>
          <DialogTitle>
            {isCreate ? 'New ticket' : (
              <span className="flex items-center gap-2">
                <span className="font-mono text-sm text-muted-foreground">#{ticket.ticket_no}</span>
                Ticket details
              </span>
            )}
          </DialogTitle>
          <DialogDescription>
            {isCreate
              ? 'Describe the update you need. It lands in the New column for everyone to see.'
              : `Opened by ${ticket.created_by_name ?? ticket.created_by} · ${relativeTime(ticket.created_at)}`}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
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
              rows={4}
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

          {!isCreate && (
            <div className="ticket-field grid gap-3 sm:grid-cols-2" style={fieldIndex(4)}>
              <div className="grid gap-1.5">
                <Label title={canMove ? undefined : 'Only the board owner can move tickets for now'}>
                  Column
                </Label>
                <Select
                  value={draft.status}
                  onValueChange={(v) =>
                    v && setDraft((d) => ({ ...d, status: v as TicketStatus }))
                  }
                >
                  <SelectTrigger className="w-full" disabled={readOnly || saving || !canMove}>
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
                <Label htmlFor="ticket-assignee">Assigned to</Label>
                <Input
                  id="ticket-assignee"
                  type="email"
                  value={draft.assigned_to}
                  onChange={(e) => setDraft((d) => ({ ...d, assigned_to: e.target.value }))}
                  placeholder="name@simple.biz"
                  disabled={readOnly || saving}
                />
              </div>
            </div>
          )}
        </form>

        {!isCreate && (
          <div className="ticket-field mt-3.5 grid gap-2 border-t border-border pt-3" style={fieldIndex(5)}>
            <CommentsThread ticketId={ticket.id} />
          </div>
        )}
        </div>

        <DialogFooter
          className={cn('ticket-field mx-0 mb-0', !isCreate && canDelete && 'sm:justify-between')}
          style={fieldIndex(isCreate ? 4 : 6)}
        >
          {!isCreate && canDelete && (
            <Button
              variant="destructive"
              disabled={saving}
              onClick={async () => {
                if (!confirmingDelete) {
                  setConfirmingDelete(true);
                  return;
                }
                const ok = await onDelete(ticket.id);
                if (ok) onOpenChange(false);
              }}
            >
              <Trash2 data-icon="inline-start" />
              {confirmingDelete ? 'Confirm delete' : 'Delete ticket'}
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

// ── Updates thread ────────────────────────────────────────────────────────────

/** The ticket's reply thread. Everyone who can see the board can reply (the
 *  thread is the conversation around a request); Supabase Realtime on
 *  `ticket_comments` keeps an open dialog in sync while others answer. */
function CommentsThread({ ticketId }: { ticketId: string }) {
  const [comments, setComments] = useState<TicketComment[] | null>(null);
  const [draft, setDraft] = useState('');
  const [posting, setPosting] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/tickets/${ticketId}/comments`, { cache: 'no-store' });
      if (!res.ok) return;
      const j = (await res.json()) as { comments?: TicketComment[] };
      if (Array.isArray(j.comments)) setComments(j.comments);
    } catch {
      // Realtime/poll will retry; keep whatever we have.
    }
  }, [ticketId]);

  useEffect(() => {
    void load();
  }, [load]);

  useLiveRefresh({
    tables: ['ticket_comments'],
    channel: `ticket-comments-${ticketId}`,
    onRefresh: () => void load(),
  });

  // Keep the newest reply in view as the thread grows.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [comments?.length]);

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
    <div className="grid gap-2">
      <div className="flex items-center gap-1.5">
        <MessagesSquare className="size-3.5 text-muted-foreground" aria-hidden />
        <Label>Updates{comments && comments.length > 0 ? ` (${comments.length})` : ''}</Label>
      </div>

      <div ref={listRef} className="flex max-h-44 flex-col gap-2.5 overflow-y-auto pr-1">
        {comments === null ? (
          <p className="py-1 text-xs text-muted-foreground">Loading replies…</p>
        ) : comments.length === 0 ? (
          <p className="py-1 text-xs text-muted-foreground">
            No replies yet — questions and progress notes on this ticket go here.
          </p>
        ) : (
          comments.map((c) => (
            <div key={c.id} className="flex gap-2">
              <span
                className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[9px] font-semibold text-muted-foreground"
                aria-hidden
              >
                {initialsFor(c.author_name, c.author_email)}
              </span>
              <div className="min-w-0">
                <p className="text-xs">
                  <span className="font-medium" title={c.author_email}>
                    {c.author_name ?? c.author_email.split('@')[0]}
                  </span>
                  <span className="ml-1.5 text-[11px] text-muted-foreground/80">
                    {relativeTime(c.created_at)}
                  </span>
                </p>
                <p className="text-sm break-words whitespace-pre-wrap">{c.body}</p>
              </div>
            </div>
          ))
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
          placeholder="Reply… (Shift+Enter for a new line)"
          rows={1}
          maxLength={4000}
          disabled={posting}
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
          disabled={!draft.trim() || posting}
          onClick={() => void send()}
        >
          {posting ? <Loader2 className="animate-spin" /> : <SendHorizontal />}
        </Button>
      </div>
    </div>
  );
}
