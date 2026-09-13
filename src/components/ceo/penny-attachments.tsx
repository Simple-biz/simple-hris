'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ExternalLink, FileText, ImageIcon, Loader2, Paperclip, X } from 'lucide-react';
import { ATTACHMENT_SOURCES, parseAttachmentRef } from '@/lib/penny/attachment-refs';
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
 * Images open in the viewer below; PDFs and anything else open in a new tab,
 * because a PDF viewer belongs to the browser.
 */

type OpenState = { ref: string; label: string; url: string; expiresIn: number | null } | null;

const ICON = {
  image: ImageIcon,
  pdf: FileText,
  file: Paperclip,
} as const;

const TONE_CLASS: Record<ChatTone, { chip: string; note: string }> = {
  penny: {
    chip:
      'border-zinc-200 bg-white text-zinc-600 hover:border-fuchsia-300 hover:text-fuchsia-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:border-fuchsia-700',
    note: 'text-zinc-500 dark:text-zinc-400',
  },
  console: {
    chip:
      'border-[#ff7a1a]/25 bg-[#ff7a1a]/[0.06] font-mono text-[#e8ded2] hover:border-[#ff7a1a]/60 hover:bg-[#ff7a1a]/[0.12] hover:text-[#ffa24d]',
    note: 'font-mono text-[#a89a8d]',
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
        const body = (await res.json().catch(() => null)) as
          | { url?: string; expires_in?: number | null; error?: string }
          | null;
        if (!res.ok || !body?.url) {
          // Say what the server said. "Could not open" on a file that was
          // deleted, and on one the storage layer is down for, sends an admin
          // looking in two different wrong places.
          setFailed((f) => ({ ...f, [att.ref]: body?.error ?? 'Could not open that file.' }));
          return;
        }
        if (att.kind === 'image') {
          setOpen({
            ref: att.ref,
            label: att.label,
            url: body.url,
            expiresIn: typeof body.expires_in === 'number' ? body.expires_in : null,
          });
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
      {open && <ImageViewer state={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/* The viewer                                                                */
/* ────────────────────────────────────────────────────────────────────────── */

/** "3600" → "60 min". The console prints durations, not seconds since epoch. */
function expiryLabel(seconds: number | null): string | null {
  if (seconds == null) return null;
  if (seconds < 90) return `${seconds}s`;
  return `${Math.round(seconds / 60)} min`;
}

/**
 * One image, opened inside the console rather than over it.
 *
 * It borrows the console's own window chrome — the same hairline, title bar,
 * status dot and mono register — so opening a file reads as the terminal
 * bringing something up, not as a photo viewer arriving from another app. The
 * corner brackets around the plate are the one authored decoration: a framing
 * reticle, which is the vocabulary this surface already lives in.
 *
 * Two rules inherited from the console proper:
 *
 *  - **It never narrates work that isn't happening.** The status word is the
 *    real state of the `<img>` — `loading` until it decodes, then the file's
 *    actual provenance. No "decrypting", no fake progress.
 *  - **It is a real modal**, so it behaves like one: focus moves in, Tab is
 *    trapped, Escape and the backdrop close it, the page behind cannot scroll,
 *    and focus returns to the chip that opened it.
 *
 * Rendered through a portal because the console panel animates on a transform,
 * and a `position: fixed` descendant of a transformed ancestor is positioned
 * against that ancestor instead of the viewport.
 */
function ImageViewer({ state, onClose }: { state: NonNullable<OpenState>; onClose: () => void }) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  /**
   * True only while the acquire sequence is playing. It gates the two emissive
   * layers so they UNMOUNT when they are done rather than sitting over the
   * picture for the rest of the session.
   */
  const [acquiring, setAcquiring] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  // The reveal is driven by DECODE, not by mount. Playing it on mount meant the
  // raster opened on an empty plate and the picture simply appeared afterwards —
  // the signature gesture firing over nothing.
  const onDecoded = useCallback(() => {
    setStatus('ready');
    setAcquiring(true);
  }, []);

  useEffect(() => {
    if (!acquiring) return;
    const id = window.setTimeout(() => setAcquiring(false), 480);
    return () => window.clearTimeout(id);
  }, [acquiring]);

  const ref = parseAttachmentRef(state.ref);
  const source = ref ? ATTACHMENT_SOURCES[ref.source] : null;
  const expires = expiryLabel(state.expiresIn);

  // Escape closes, and Tab cannot leave. Claiming `aria-modal` without actually
  // trapping focus is the version of this that tests clean and strands a
  // keyboard user behind the overlay.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const focusable = panelRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled])',
      );
      if (!focusable || focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKey, true);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = prevOverflow;
      opener?.focus?.();
    };
  }, [onClose]);

  if (typeof document === 'undefined') return null;

  return createPortal(
    // `penny-console` carries the scoped selection colour and scrollbar into
    // the portal, which sits outside the console's own subtree.
    <div className="penny-console fixed inset-0 z-[70] flex items-center justify-center p-3 sm:p-6">
      {/* ── The entrance ───────────────────────────────────────────────────
          A third CRT gesture, deliberately distinct from the console's other
          two: the power-on opens from the centre over 700ms, the `/clear` erase
          sweeps top-to-bottom in 300ms, and this one ACQUIRES — the frame
          arrives, a raster line strikes across it, and the picture opens out of
          that line. Reusing the power-on here would read as the same event
          happening twice.

          Transforms, opacity and clip-path only, so the whole sequence stays on
          the compositor. The emissive layers unmount when they finish, the way
          `CrtPowerOn` does, so nothing costs anything once the picture is up. */}
      <style>{`
        @keyframes pennyViewerIn {
          from { opacity: 0; transform: translateY(8px) scale(0.965); }
          to   { opacity: 1; transform: none; }
        }
        /* The picture opens out of the raster line, with a touch of horizontal
           overscan settling inward — what a tube does when the deflection
           coils catch up. */
        @keyframes pennyPlateIn {
          0%   { clip-path: inset(50% 0 50% 0); transform: scaleX(1.03); }
          55%  { clip-path: inset(0 0 0 0);     transform: scaleX(1.008); }
          100% { clip-path: inset(0 0 0 0);     transform: scaleX(1); }
        }
        /* Before vertical deflection there is one bright streak across the
           middle. It is the signature of the gesture, so it leads. */
        @keyframes pennyRaster {
          0%   { opacity: 0;   transform: scaleX(0.18); }
          16%  { opacity: 1;   transform: scaleX(1.02); }
          52%  { opacity: 0.5; transform: scaleX(1); }
          100% { opacity: 0;   transform: scaleX(1); }
        }
        /* Phosphor bloom as the high voltage overshoots. It rises and falls
           ONCE and peaks well below a white-out — a repeating flash at panel
           size would be a photosensitivity hazard. */
        @keyframes pennyBloom {
          0%   { opacity: 0; }
          24%  { opacity: 0.30; }
          100% { opacity: 0; }
        }
        @keyframes pennyTick {
          from { opacity: 0; transform: scale(0.5); }
          to   { opacity: 1; transform: none; }
        }
        .penny-viewer { animation: pennyViewerIn 220ms cubic-bezier(0.16,1,0.3,1) both; }
        .penny-plate  { animation: pennyPlateIn 440ms cubic-bezier(0.16,1,0.3,1) both; }
        .penny-raster { animation: pennyRaster 360ms ease-out both; }
        .penny-bloom  { animation: pennyBloom 440ms ease-out both; }
        .penny-tick   { animation: pennyTick 260ms cubic-bezier(0.16,1,0.3,1) both; }
        @media (prefers-reduced-motion: reduce) {
          .penny-viewer, .penny-plate, .penny-tick { animation: none; }
          /* The emissive layers are REMOVED, not stilled. \`animation: none\`
             would leave the bloom and the streak parked at full opacity — a
             white wash over the picture that never clears, which is worse than
             the motion it was meant to spare. */
          .penny-acquire { display: none; }
        }
      `}</style>

      {/* Backdrop. A flat scrim with a faint scanline field rather than a blur:
          the console is a tube, and blur here would read as consumer glass. */}
      <button
        type="button"
        aria-label="Close the viewer"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-black/88"
        tabIndex={-1}
      />
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.35]"
        style={{
          backgroundImage:
            'repeating-linear-gradient(to bottom, rgba(255,122,26,0.05) 0 1px, transparent 1px 3px)',
        }}
      />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={state.label}
        /* `min-w-0` is load-bearing, not tidiness: this panel is a flex item,
           and a flex item's default `min-width: auto` is its CONTENT's minimum —
           which here is the image's intrinsic width. Without it a 1100px
           screenshot pushes the whole window past the right edge of a phone. */
        className="penny-viewer relative flex max-h-full w-full min-w-0 max-w-[1100px] flex-col overflow-hidden rounded-lg border border-[#26262d] bg-[#101014] shadow-[0_28px_80px_-24px_rgba(0,0,0,0.95)]"
      >
        {/* The panel catching the accent — the same hairline the console wears. */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[#ff7a1a]/40 to-transparent"
        />

        <header className="flex shrink-0 items-center gap-2.5 border-b border-[#1c1c22] bg-[#0d0d11] px-3 py-2 sm:px-4">
          <ImageIcon className="h-3.5 w-3.5 shrink-0 text-[#ff7a1a]" aria-hidden />
          <h2 className="min-w-0 truncate font-mono text-[12.5px] text-[#e8ded2]">
            <span className="text-[#4f4842]">~/</span>
            {state.label}
          </h2>
          <span
            aria-hidden
            className={`ml-1 h-1.5 w-1.5 shrink-0 rounded-full ${
              status === 'ready'
                ? 'bg-[#2f6b3d]'
                : status === 'error'
                  ? 'bg-[#a33a2a]'
                  : 'bg-[#ff7a1a]'
            }`}
          />
          <span className="hidden shrink-0 font-mono text-[10.5px] uppercase tracking-[0.14em] text-[#8a7f73] sm:inline">
            {status === 'ready' ? 'open' : status === 'error' ? 'failed' : 'loading'}
          </span>

          <div className="ml-auto flex shrink-0 items-center gap-2">
            <kbd className="hidden rounded border border-[#2a2a31] bg-[#141418] px-1.5 py-px font-mono text-[9.5px] text-[#a89a8d] sm:inline">
              esc
            </kbd>
            <button
              ref={closeRef}
              type="button"
              onClick={onClose}
              className="rounded border border-[#2a2a31] px-2 py-1 font-mono text-[10.5px] uppercase tracking-[0.1em] text-[#8a7f73] transition-colors hover:border-[#ff7a1a]/50 hover:text-[#ffa24d] focus-visible:border-[#ff7a1a] focus-visible:text-[#ffa24d] focus-visible:outline-none"
            >
              <X className="mr-1 inline h-3 w-3 align-[-1px]" aria-hidden />
              close
            </button>
          </div>
        </header>

        {/* ── The plate ──────────────────────────────────────────────────── */}
        {/* The padding is sized so the reticle always has its own gutter — the
            brackets frame the plate, and an image that reached under them would
            read as four stray ticks rather than a frame. */}
        <div className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center bg-[#08080a] p-7 sm:p-8">
          {status === 'loading' && (
            <span className="pointer-events-none absolute inset-0 flex items-center justify-center font-mono text-[11px] uppercase tracking-[0.14em] text-[#8a7f73]">
              loading
            </span>
          )}

          {status === 'error' ? (
            <div className="max-w-[46ch] text-center">
              <p className="font-mono text-[12px] text-[#e8ded2]">
                The image did not load.
              </p>
              <p className="mt-1.5 font-mono text-[11px] leading-relaxed text-[#a89a8d]">
                The link is short-lived{expires ? ` (${expires})` : ''} and may have expired.
                Close this and click the file again for a fresh one.
              </p>
            </div>
          ) : (
            /* eslint-disable-next-line @next/next/no-img-element -- a signed
               storage URL is not a configured next/image host, and the link is
               deliberately short-lived. */
            <img
              src={state.url}
              alt={state.label}
              onLoad={onDecoded}
              onError={() => setStatus('error')}
              className={`max-h-[calc(100vh-16rem)] min-w-0 max-w-full object-contain ${
                status === 'ready' ? 'penny-plate opacity-100' : 'opacity-0'
              }`}
            />
          )}

          {/* The light half of the gesture. A dark panel cannot fake light, so
              the streak and the bloom are their own layers — and they unmount
              the moment the sequence ends. */}
          {acquiring && (
            <span
              aria-hidden
              className="penny-acquire pointer-events-none absolute inset-0 overflow-hidden"
            >
              <span className="penny-bloom absolute inset-0 bg-[#ffd9b8]" />
              <span
                className="penny-raster absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-white"
                style={{
                  boxShadow:
                    '0 0 8px 2px rgba(255,255,255,0.8), 0 0 28px 8px rgba(255,122,26,0.55)',
                }}
              />
            </span>
          )}

          {/* Framing reticle — four corner ticks, the one authored decoration.
              Hidden while the plate is empty so it never frames nothing, and
              snapping in LAST so the sequence finishes on the frame closing
              around the picture. */}
          {status === 'ready' && <Reticle />}
        </div>

        {/* ── Provenance ─────────────────────────────────────────────────── */}
        <footer className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-[#1c1c22] bg-[#0d0d11] px-3 py-2 font-mono text-[10.5px] uppercase tracking-[0.12em] text-[#8a7f73] sm:px-4">
          {/* Separators are glued to the segment that follows them, so a wrap
              can never strand a lone "·" at the end of a line. The origin is
              the first thing to go on a narrow screen — it is the least
              load-bearing of the three. */}
          {source && <span className="text-[#a89a8d]">{source.label}</span>}
          {source && (
            <span className="hidden sm:inline">
              <span aria-hidden="true">· </span>
              {source.origin}
            </span>
          )}
          {expires && (
            <span>
              <span aria-hidden="true">· </span>
              link valid {expires}
            </span>
          )}
          <a
            href={state.url}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto inline-flex items-center gap-1 text-[#8a7f73] transition-colors hover:text-[#ffa24d] focus-visible:text-[#ffa24d] focus-visible:outline-none"
          >
            open raw
            <ExternalLink className="h-3 w-3" aria-hidden />
          </a>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

/** Four corner ticks framing the plate. Drawn, not a border. */
function Reticle() {
  const common = 'penny-tick pointer-events-none absolute h-4 w-4 border-[#ff7a1a]/55';
  // Corners land clockwise from the top-left, after the picture has opened. The
  // stagger is short and capped — four ticks reading as one frame closing, not
  // as a list animating in.
  const corners = [
    { at: 'left-2.5 top-2.5 border-l border-t sm:left-3 sm:top-3', delay: 300 },
    { at: 'right-2.5 top-2.5 border-r border-t sm:right-3 sm:top-3', delay: 340 },
    { at: 'bottom-2.5 right-2.5 border-b border-r sm:bottom-3 sm:right-3', delay: 380 },
    { at: 'bottom-2.5 left-2.5 border-b border-l sm:bottom-3 sm:left-3', delay: 420 },
  ];
  return (
    <span aria-hidden>
      {corners.map((c) => (
        <span key={c.at} className={`${common} ${c.at}`} style={{ animationDelay: `${c.delay}ms` }} />
      ))}
    </span>
  );
}
