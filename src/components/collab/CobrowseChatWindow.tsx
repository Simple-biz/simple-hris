'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { ChevronDown, GraduationCap, MessageCircle, Send, X } from 'lucide-react';

/**
 * Floating live-chat window used by the "watch screen" tutoring flow.
 *
 * Presentational only — the message transport lives in
 * {@link ../presence/CobrowseChatProvider}. The SAME window is used by both
 * sides of a tutoring session:
 *
 *  - OBSERVER (admin): rendered by CobrowseProvider while an admin is watching
 *    someone's screen, so they can talk the person through whatever's on screen.
 *  - DRIVER (the person being helped): pops up automatically the moment the
 *    admin sends their first message, so the person can read and reply back.
 *
 * The whole window is tagged `.rr-block` so it never gets swept into the rrweb
 * screen stream — the admin watches the person's real work, not a mirror of the
 * chat they're both looking at (and no message echo / feedback loop).
 */

export interface ChatMessageView {
  id: string;
  fromSelf: boolean;
  fromName: string;
  text: string;
  ts: number;
}

function formatTime(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch {
    return '';
  }
}

export default function CobrowseChatWindow({
  title,
  subtitle,
  accent = '#f97316',
  messages,
  onSend,
  onClose,
  onOpen,
  unread = 0,
  offsetIndex = 0,
  variant = 'observer',
  placeholder = 'Type a message…',
}: {
  title: string;
  subtitle?: string;
  accent?: string;
  messages: ChatMessageView[];
  onSend: (text: string) => void;
  /** When provided, shows a dismiss (×) button — used on the driver side. */
  onClose?: () => void;
  /** Called whenever the window is expanded/focused, so the parent can clear unread. */
  onOpen?: () => void;
  unread?: number;
  /** Horizontal stacking slot when several windows are open at once. */
  offsetIndex?: number;
  variant?: 'observer' | 'driver';
  placeholder?: string;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [draft, setDraft] = useState('');
  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Keep the newest message in view.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && !collapsed) el.scrollTop = el.scrollHeight;
  }, [messages, collapsed]);

  // Clear unread whenever the window is open and messages change.
  useEffect(() => {
    if (!collapsed) onOpen?.();
  }, [collapsed, messages.length, onOpen]);

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    onSend(text);
    setDraft('');
    inputRef.current?.focus();
  };

  const right = 16 + offsetIndex * 356;

  return (
    <motion.div
      className="rr-block fixed z-[130] flex w-[336px] flex-col overflow-hidden rounded-2xl border bg-white shadow-2xl dark:bg-zinc-900"
      style={{
        right,
        bottom: 16,
        maxHeight: collapsed ? undefined : 'min(460px, calc(100vh - 32px))',
        borderColor: `${accent}55`,
      }}
      initial={{ opacity: 0, y: 24, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 24, scale: 0.96 }}
      transition={{ type: 'spring', stiffness: 400, damping: 32 }}
    >
      {/* Header */}
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="flex shrink-0 items-center gap-2.5 px-3.5 py-2.5 text-left"
        style={{ background: `linear-gradient(135deg, ${accent}, ${accent}cc)` }}
      >
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white/20">
          {variant === 'observer' ? (
            <GraduationCap className="h-4 w-4 text-white" aria-hidden />
          ) : (
            <MessageCircle className="h-4 w-4 text-white" aria-hidden />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-semibold leading-tight text-white">
            {title}
          </span>
          {subtitle && (
            <span className="block truncate text-[11px] leading-tight text-white/80">{subtitle}</span>
          )}
        </span>
        {collapsed && unread > 0 && (
          <span
            className="flex h-5 min-w-[20px] items-center justify-center rounded-full bg-white px-1.5 text-[11px] font-bold"
            style={{ color: accent }}
          >
            {unread > 9 ? '9+' : unread}
          </span>
        )}
        <ChevronDown
          className="h-4 w-4 shrink-0 text-white/90 transition-transform"
          style={{ transform: collapsed ? 'rotate(180deg)' : 'none' }}
          aria-hidden
        />
        {onClose && (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.stopPropagation();
                onClose();
              }
            }}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-white/80 transition-colors hover:bg-white/20 hover:text-white"
            title="Dismiss"
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </span>
        )}
      </button>

      {!collapsed && (
        <>
          {/* Messages */}
          <div
            ref={listRef}
            className="flex-1 space-y-2 overflow-y-auto bg-zinc-50 px-3 py-3 dark:bg-zinc-950/40"
          >
            {messages.length === 0 ? (
              <div className="flex h-full min-h-[120px] flex-col items-center justify-center gap-1.5 text-center">
                <MessageCircle className="h-6 w-6" style={{ color: `${accent}99` }} aria-hidden />
                <p className="text-[12px] font-medium text-zinc-500 dark:text-zinc-400">
                  {variant === 'observer'
                    ? 'Say hello — your message pops up on their screen.'
                    : 'Reply here to chat back.'}
                </p>
              </div>
            ) : (
              messages.map((m) => (
                <div key={m.id} className={`flex flex-col ${m.fromSelf ? 'items-end' : 'items-start'}`}>
                  <div
                    className={`max-w-[85%] rounded-2xl px-3 py-1.5 text-[13px] leading-snug ${
                      m.fromSelf
                        ? 'rounded-br-md text-white'
                        : 'rounded-bl-md bg-zinc-200 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-50'
                    }`}
                    style={m.fromSelf ? { background: accent } : undefined}
                  >
                    {!m.fromSelf && (
                      <span className="mb-0.5 block text-[10.5px] font-semibold opacity-70">
                        {m.fromName}
                      </span>
                    )}
                    <span className="whitespace-pre-wrap break-words">{m.text}</span>
                  </div>
                  <span className="mt-0.5 px-1 text-[10px] text-zinc-400 dark:text-zinc-500">
                    {formatTime(m.ts)}
                  </span>
                </div>
              ))
            )}
          </div>

          {/* Composer */}
          <div className="flex shrink-0 items-center gap-2 border-t border-zinc-200 bg-white px-2.5 py-2 dark:border-zinc-800 dark:bg-zinc-900">
            <input
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder={placeholder}
              className="h-9 flex-1 rounded-full border border-zinc-200 bg-transparent px-3.5 text-[13px] text-zinc-900 outline-none placeholder:text-zinc-400 focus:ring-2 focus:ring-orange-400/50 dark:border-zinc-700 dark:text-zinc-50 dark:placeholder:text-zinc-500"
            />
            <button
              type="button"
              onClick={send}
              disabled={!draft.trim()}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-white transition-opacity disabled:opacity-40"
              style={{ background: accent }}
              title="Send"
            >
              <Send className="h-4 w-4" aria-hidden />
            </button>
          </div>
        </>
      )}
    </motion.div>
  );
}
