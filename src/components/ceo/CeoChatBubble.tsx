'use client';

import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Send, X, Sparkles, Loader2, Trash2 } from 'lucide-react';
import { AssistantContent, MessageFeedback } from './ceo-chat-message';
import { useCeoChat } from './use-ceo-chat';

const SUGGESTIONS = [
  'Pull the latest payroll report',
  'How much did we pay out last week?',
  'Help me think through a decision',
];

/**
 * Floating CEO assistant — the always-available chat bubble. Shares its backend
 * and logic with the full-page Penny AI tab via {@link useCeoChat}. When the CEO
 * is on the Penny AI tab, `CeoApp` passes `hidden` so only one chat shows at once.
 */
export default function CeoChatBubble({ hidden = false }: { hidden?: boolean }) {
  const [open, setOpen] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const {
    messages,
    input,
    setInput,
    busy,
    send,
    clearChat,
    rateMessage,
    lastMsg,
    awaitingFirstToken,
  } = useCeoChat({ inputRef });

  // Collapse the panel whenever the bubble is hidden (e.g. switched to Penny AI).
  useEffect(() => {
    if (hidden) setOpen(false);
  }, [hidden]);

  // Keep the transcript pinned to the latest message as it streams in.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, busy]);

  // Focus the composer when the panel opens; Escape closes it.
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => inputRef.current?.focus(), 120);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(t);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function onComposerKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send(input);
    }
  }

  // On the Penny AI tab the dedicated chat takes over — don't render the bubble.
  if (hidden) return null;

  return (
    <>
      {/* Chat panel */}
      <AnimatePresence>
        {open && (
          <motion.div
            key="ceo-chat-panel"
            role="dialog"
            aria-label="CEO assistant"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 16 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            className="fixed bottom-24 right-4 z-50 flex h-[min(560px,calc(100dvh-7rem))] w-[min(380px,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border border-amber-200/80 bg-white shadow-2xl shadow-amber-900/15 dark:border-amber-900/40 dark:bg-[#0d1117] sm:right-6"
          >
            {/* Header */}
            <div className="flex shrink-0 items-center justify-between gap-3 bg-gradient-to-br from-yellow-500 via-amber-600 to-amber-700 px-4 py-3 text-white dark:from-yellow-600 dark:via-amber-800 dark:to-amber-900">
              <div className="flex min-w-0 items-center gap-2.5">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/15 backdrop-blur-sm">
                  <Sparkles className="h-4 w-4" aria-hidden />
                </span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold leading-tight">Assistant</p>
                  <p className="truncate text-[11px] leading-tight text-amber-50/80">
                    Here to help, anytime
                  </p>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {messages.length > 0 && (
                  <button
                    type="button"
                    onClick={clearChat}
                    aria-label="Clear chat"
                    title="Clear chat"
                    className="flex h-8 w-8 items-center justify-center rounded-full text-white/90 transition hover:bg-white/20"
                  >
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label="Close chat"
                  className="flex h-8 w-8 items-center justify-center rounded-full text-white/90 transition hover:bg-white/20"
                >
                  <X className="h-4 w-4" aria-hidden />
                </button>
              </div>
            </div>

            {/* Messages */}
            <div
              ref={scrollRef}
              className="flex-1 space-y-3 overflow-y-auto bg-amber-50/30 px-3.5 py-4 dark:bg-black/20"
            >
              {messages.length === 0 ? (
                <div className="flex flex-col gap-3 px-1 pt-2">
                  <p className="text-sm font-medium text-zinc-700 dark:text-zinc-200">
                    Hi 👋 What can I help you with?
                  </p>
                  <div className="flex flex-col gap-2">
                    {SUGGESTIONS.map((s) => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => void send(s)}
                        className="rounded-xl border border-amber-200/70 bg-white px-3 py-2 text-left text-[13px] text-zinc-700 shadow-sm transition hover:border-amber-300 hover:bg-amber-50 dark:border-amber-900/40 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                messages.map((m) => {
                  const isStreaming = busy && m.id === lastMsg?.id && m.role === 'assistant';
                  const showRating = m.role === 'assistant' && !!m.content && !isStreaming;
                  return (
                    <motion.div
                      key={m.id}
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
                      className={
                        m.role === 'user' ? 'flex justify-end' : 'flex flex-col items-start gap-1'
                      }
                    >
                      <div
                        className={
                          m.role === 'user'
                            ? 'max-w-[82%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-amber-600 px-3.5 py-2 text-[13.5px] leading-relaxed text-white shadow-sm'
                            : 'max-w-[92%] break-words rounded-2xl rounded-bl-md border border-zinc-200/80 bg-white px-3.5 py-2 text-[13.5px] leading-relaxed text-zinc-800 shadow-sm dark:border-zinc-700/60 dark:bg-zinc-900 dark:text-zinc-100'
                        }
                      >
                        {m.role === 'user' ? (
                          m.content
                        ) : m.content ? (
                          <AssistantContent text={m.content} streaming={isStreaming} />
                        ) : awaitingFirstToken ? (
                          <span className="inline-flex items-center gap-1.5 text-zinc-400">
                            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                            Thinking…
                          </span>
                        ) : null}
                      </div>

                      {showRating && (
                        <div className="pl-1">
                          <MessageFeedback
                            rating={m.rating}
                            onRate={(rating, comment) => void rateMessage(m, rating, comment)}
                          />
                        </div>
                      )}
                    </motion.div>
                  );
                })
              )}
            </div>

            {/* Composer */}
            <div className="shrink-0 border-t border-zinc-200/70 bg-white px-3 py-2.5 dark:border-zinc-800 dark:bg-[#0d1117]">
              <div className="flex items-end gap-2 rounded-xl border border-zinc-200 bg-zinc-50 px-2.5 py-1.5 focus-within:border-amber-400 focus-within:ring-2 focus-within:ring-amber-400/30 dark:border-zinc-700 dark:bg-zinc-900">
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={onComposerKey}
                  rows={1}
                  placeholder="Type a message…"
                  className="max-h-28 min-h-[24px] flex-1 resize-none bg-transparent py-1 text-[13.5px] leading-relaxed text-zinc-900 outline-none placeholder:text-zinc-400 dark:text-zinc-100"
                />
                <button
                  type="button"
                  onClick={() => void send(input)}
                  disabled={busy || !input.trim()}
                  aria-label="Send message"
                  className="mb-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-600 text-white transition hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {busy ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  ) : (
                    <Send className="h-4 w-4" aria-hidden />
                  )}
                </button>
              </div>
              <p className="mt-1 px-1 text-[10.5px] text-zinc-400">
                Assistant can make mistakes. Verify important details.
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Floating beating-heart button — an orange heart that beats (lub-dub)
          with a pulsing halo. Becomes a close (X) while the panel is open. */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={open ? 'Close Penny AI' : 'Open Penny AI'}
        aria-expanded={open}
        className="group fixed bottom-5 right-4 z-50 flex h-14 w-14 items-center justify-center transition-transform active:scale-90 sm:right-6"
      >
        <style>{`
          @keyframes pennyHeartbeat {
            0%, 28%, 70%, 100% { transform: scale(1); }
            14% { transform: scale(1.22); }
            42% { transform: scale(1.1); }
          }
          @keyframes pennyHeartHalo {
            0%   { transform: scale(0.7);  opacity: 0.55; }
            70%  { transform: scale(1.95); opacity: 0; }
            100% { transform: scale(1.95); opacity: 0; }
          }
          @media (prefers-reduced-motion: reduce) {
            .penny-heart, .penny-halo { animation: none !important; }
          }
        `}</style>
        <AnimatePresence mode="wait" initial={false}>
          {open ? (
            <motion.span
              key="close"
              initial={{ opacity: 0, rotate: -90 }}
              animate={{ opacity: 1, rotate: 0 }}
              exit={{ opacity: 0, rotate: 90 }}
              transition={{ duration: 0.15 }}
              className="flex h-14 w-14 items-center justify-center rounded-full border border-orange-200/70 bg-white shadow-lg shadow-orange-900/25 dark:border-orange-900/40 dark:bg-zinc-900"
            >
              <X className="h-6 w-6 text-orange-600 dark:text-orange-400" aria-hidden />
            </motion.span>
          ) : (
            <motion.span
              key="heart"
              initial={{ opacity: 0, scale: 0.6 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.6 }}
              transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
              className="relative flex h-14 w-14 items-center justify-center"
            >
              {/* pulsing orange halo (two staggered rings → ripple) */}
              <span
                aria-hidden
                className="penny-halo absolute h-11 w-11 rounded-full bg-orange-500/45 blur-md"
                style={{ animation: 'pennyHeartHalo 1.5s ease-out infinite' }}
              />
              <span
                aria-hidden
                className="penny-halo absolute h-11 w-11 rounded-full bg-orange-400/40"
                style={{ animation: 'pennyHeartHalo 1.5s ease-out infinite 0.35s' }}
              />
              {/* the beating heart — the Penny AI heart mark */}
              <img
                aria-hidden
                src="/chatbubble.png"
                alt=""
                draggable={false}
                className="penny-heart relative h-9 w-9 object-contain drop-shadow-md"
                style={{ animation: 'pennyHeartbeat 1.3s ease-in-out infinite', transformOrigin: 'center' }}
              />
            </motion.span>
          )}
        </AnimatePresence>
      </button>
    </>
  );
}
