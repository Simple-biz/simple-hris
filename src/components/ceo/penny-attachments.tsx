'use client';

import { useCallback, useEffect, useState } from 'react';
import { FileText, ImageIcon, Loader2, Paperclip, X } from 'lucide-react';
import type { PennyAttachment } from './use-ceo-chat';
import type { ChatTone } from './ceo-chat-message';

/**
 * The files Penny found, offered as things you can open.
 *
 * ── Why a chip and not a thumbnail grid ──────────────────────────────────────
 * A thumbnail needs a URL up front, and for these buckets a URL is a signed
 * bearer credential. Rendering twelve thumbnails would mint twelve live links
 * for files nobody asked to see and start every clock at once. A chip costs
 * nothing until it is clicked, which is also the moment the open is audited —
 * so what the audit log records and what the admin actually looked at are the
 * same set.
 *
 * Images open in a lightbox over the console; PDFs and anything else open in a
 * new tab, because a PDF viewer belongs to the browser.
 */

type OpenState = { ref: string; label: string; url: string } | null;

const ICON = {
  image: ImageIcon,
  pdf: FileText,
  file: Paperclip,
} as const;

const TONE_CLASS: Record<ChatTone, { chip: string; note: string; caption: string }> = {
  penny: {
    chip:
      'border-zinc-200 bg-white text-zinc-600 hover:border-fuchsia-300 hover:text-fuchsia-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:border-fuchsia-700',
    note: 'text-zinc-400',
    caption: 'text-zinc-500 dark:text-zinc-400',
  },
  console: {
    chip:
      'border-[#ff7a1a]/25 bg-[#ff7a1a]/[0.06] font-mono text-[#e8ded2] hover:border-[#ff7a1a]/60 hover:bg-[#ff7a1a]/[0.12] hover:text-[#ffa24d]',
    note: 'font-mono text-[#8a7f73]',
    caption: 'font-mono text-[#a89a8d]',
  },
};

export default function PennyAttachments({
  attachments,
  tone = 'penny',
}: {
  attachments: PennyAttachment[];
  tone?: ChatTone;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const [failed, setFailed] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<OpenState>(null);
  const t = TONE_CLASS[tone];

  const openAttachment = useCallback(
    async (att: PennyAttachment) => {
      if (pending) return;
      setPending(att.ref);
      // Clear only THIS chip's error — a retry must not wipe the explanation
      // sitting under a different file that failed for a different reason.
      setFailed((f) => {
        if (!(att.ref in f)) return f;
        const next = { ...f };
        delete next[att.ref];
        return next;
      });
      try {
        const res = await fetch(
          `/api/admin/penny-chat/attachment?ref=${encodeURIComponent(att.ref)}`,
          { cache: 'no-store' },
        );
        const body = (await res.json().catch(() => null)) as { url?: string; error?: string } | null;
        if (!res.ok || !body?.url) {
          // Say what the server said. "Could not open" on a file that was
          // deleted, and on one the storage layer is down for, sends an admin
          // looking in two different wrong places.
          setFailed((f) => ({ ...f, [att.ref]: body?.error ?? 'Could not open that file.' }));
          return;
        }
        if (att.kind === 'image') {
          setOpen({ ref: att.ref, label: att.label, url: body.url });
        } else {
          window.open(body.url, '_blank', 'noopener,noreferrer');
        }
      } catch {
        setFailed((f) => ({ ...f, [att.ref]: 'Could not reach the server.' }));
      } finally {
        setPending(null);
      }
    },
    [pending],
  );

  if (attachments.length === 0) return null;

  return (
    <div className="mt-2">
      <ul className="flex flex-wrap gap-1.5">
        {attachments.map((att) => {
          const Icon = ICON[att.kind] ?? Paperclip;
          const busy = pending === att.ref;
          const error = failed[att.ref];
          return (
            <li key={att.ref} className="max-w-full">
              <button
                type="button"
                onClick={() => void openAttachment(att)}
                disabled={!!pending}
                title={att.label}
                className={`flex max-w-full items-center gap-1.5 rounded-md border px-2 py-1 text-[11.5px] transition-colors disabled:opacity-60 ${t.chip}`}
              >
                {busy ? (
                  <Loader2 className="h-3 w-3 shrink-0 animate-spin" aria-hidden />
                ) : (
                  <Icon className="h-3 w-3 shrink-0" aria-hidden />
                )}
                <span className="truncate">{att.label}</span>
              </button>
              {error && <p className={`mt-0.5 px-1 text-[11px] ${t.note}`}>{error}</p>}
            </li>
          );
        })}
      </ul>
      {open && <Lightbox state={open} tone={tone} onClose={() => setOpen(null)} />}
    </div>
  );
}

/** Full-size view of one image, over the surface that offered it. */
function Lightbox({
  state,
  tone,
  onClose,
}: {
  state: NonNullable<OpenState>;
  tone: ChatTone;
  onClose: () => void;
}) {
  const t = TONE_CLASS[tone];

  // Escape closes. Registered on the document because the overlay is not a
  // focus trap — the transcript behind it stays readable on purpose.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={state.label}
      className="fixed inset-0 z-[60] flex flex-col items-center justify-center gap-3 bg-black/80 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-full max-w-full flex-col items-center gap-2"
        onClick={(e) => e.stopPropagation()}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- a signed
            storage URL is not a configured next/image host, and the link is
            short-lived by design. */}
        <img
          src={state.url}
          alt={state.label}
          className="max-h-[80vh] max-w-full rounded-md object-contain shadow-2xl"
        />
        <p className={`max-w-[70ch] text-center text-[12px] ${t.caption}`}>{state.label}</p>
      </div>
      <button
        type="button"
        onClick={onClose}
        className="absolute right-4 top-4 rounded-md border border-white/20 bg-black/40 p-1.5 text-white/80 transition-colors hover:bg-black/70 hover:text-white"
        aria-label="Close"
      >
        <X className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}
