'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { ChevronDown, GraduationCap, MessageCircle, Send, Smile, X } from 'lucide-react';

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

/**
 * Curated emoji set for the composer picker. Native characters — they're
 * inserted verbatim into the draft and stored/rendered as plain text (message
 * bubbles use whitespace-pre-wrap), exactly like the emoji reactions elsewhere.
 */
const EMOJI_GROUPS: { label: string; emojis: string[] }[] = [
  {
    label: 'Smileys',
    emojis: ['😀', '😄', '😁', '😊', '🙂', '😉', '😍', '😘', '😎', '🤩', '🥳', '😇', '🤔', '🤗', '😅', '😂', '🤣', '🙃', '😌', '😴'],
  },
  {
    label: 'Gestures',
    emojis: ['👍', '👎', '👏', '🙌', '🙏', '👌', '🤝', '💪', '🤙', '✌️', '🤞', '👋', '🫡', '🫶'],
  },
  {
    label: 'Love & hype',
    emojis: ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '💯', '🔥', '✨', '⭐', '🎉', '🎊', '💫'],
  },
  {
    label: 'Work',
    emojis: ['✅', '❌', '⚠️', '❓', '❗', '📌', '📎', '📝', '💡', '⏰', '🚀', '👀', '🆗', '🔒'],
  },
];

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
  closeTitle = 'Dismiss',
}: {
  title: string;
  subtitle?: string;
  accent?: string;
  messages: ChatMessageView[];
  onSend: (text: string) => void;
  /** When provided, shows a close (×) button. */
  onClose?: () => void;
  /** Tooltip for the close button (e.g. "End chat" for the admin side). */
  closeTitle?: string;
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
  const [emojiOpen, setEmojiOpen] = useState(false);
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

  // Insert an emoji at the caret (or append), keeping the input focused so the
  // user can keep typing / adding more.
  const insertEmoji = (emoji: string) => {
    const el = inputRef.current;
    const start = el?.selectionStart ?? draft.length;
    const end = el?.selectionEnd ?? draft.length;
    const next = draft.slice(0, start) + emoji + draft.slice(end);
    setDraft(next);
    requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      const pos = start + emoji.length;
      input.setSelectionRange(pos, pos);
    });
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
            title={closeTitle}
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

          {/* Emoji picker — sits in-flow above the composer so it stays inside
              the window (the root is overflow-hidden, so a floating popover
              would be clipped). */}
          {emojiOpen && (
            <div className="max-h-[172px] shrink-0 overflow-y-auto border-t border-zinc-200 bg-white px-2 py-2 dark:border-zinc-800 dark:bg-zinc-900">
              {EMOJI_GROUPS.map((group) => (
                <div key={group.label} className="mb-1.5 last:mb-0">
                  <div className="px-1 pb-0.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
                    {group.label}
                  </div>
                  <div className="grid grid-cols-8 gap-0.5">
                    {group.emojis.map((emoji) => (
                      <button
                        key={emoji}
                        type="button"
                        onClick={() => insertEmoji(emoji)}
                        className="flex h-8 w-8 items-center justify-center rounded-lg text-[18px] leading-none transition-transform hover:scale-125 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                        title={`Add ${emoji}`}
                      >
                        {emoji}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Composer */}
          <div className="flex shrink-0 items-center gap-1.5 border-t border-zinc-200 bg-white px-2.5 py-2 dark:border-zinc-800 dark:bg-zinc-900">
            <button
              type="button"
              onClick={() => setEmojiOpen((o) => !o)}
              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors ${
                emojiOpen
                  ? 'text-white'
                  : 'text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-300'
              }`}
              style={emojiOpen ? { background: accent } : undefined}
              title="Emoji"
              aria-label="Insert emoji"
              aria-expanded={emojiOpen}
            >
              <Smile className="h-4 w-4" aria-hidden />
            </button>
            <input
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send();
                } else if (e.key === 'Escape' && emojiOpen) {
                  e.preventDefault();
                  setEmojiOpen(false);
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
