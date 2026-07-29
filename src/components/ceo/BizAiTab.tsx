'use client';

import { useEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowUp, Loader2, Sparkles, Trash2 } from 'lucide-react';
import BizAiBadge from './BizAiBadge';
import { AssistantContent, MessageFeedback } from './ceo-chat-message';
import { useCeoChat } from './use-ceo-chat';

/**
 * Full-page Penny AI tab — a ChatGPT/Claude-style conversation surface for the CEO
 * dashboard. Same backend as the floating bubble (`/api/ceo/chat`: Claude + the
 * read-only payroll tools), but laid out as a dedicated workspace. When this tab
 * is active, `CeoApp` hides the floating bubble so there's only one chat at a time.
 */

// Payroll/data-oriented prompts — this assistant answers from live records, so
// the starters nudge toward what it can actually pull.
const SUGGESTIONS: { title: string; sub: string }[] = [
  { title: 'Pull the latest payroll report', sub: 'Company-wide totals for the most recent cycle' },
  { title: 'How much did we pay out last week?', sub: 'Disbursed vs. still outstanding' },
  { title: "Show a person's last 4 paychecks", sub: 'Per-week hours, pay, and status' },
  { title: 'Who still has outstanding pay this cycle?', sub: 'Owed but not yet sent' },
];

export type BizAiTabProps = {
  /** Chat backend to POST to (defaults to the CEO assistant's). */
  endpoint?: string;
  /** Small line under the "Penny AI" heading. */
  subtitle?: string;
  /** Empty-state paragraph under "How can I help today?". */
  emptyBlurb?: string;
  /** Empty-state starter prompts. */
  suggestions?: { title: string; sub: string }[];
};

export default function BizAiTab({
  endpoint,
  subtitle = 'Conversational payroll & reports — reads your live data',
  emptyBlurb = 'Ask me anything about payroll, a person’s pay, or company-wide reports. I pull from your live disbursement data — no guessing.',
  suggestions = SUGGESTIONS,
}: BizAiTabProps = {}) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

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
  } = useCeoChat({ inputRef, endpoint });

  const empty = messages.length === 0;

  // Keep the transcript pinned to the latest message. Jump instantly while a
  // reply is streaming (so it keeps up token-by-token), but glide smoothly when
  // a message lands or the user sends — which reads much calmer.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: busy ? 'auto' : 'smooth' });
  }, [messages, busy]);

  // Focus the composer on mount.
  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 150);
    return () => clearTimeout(t);
  }, []);

  // Auto-grow the textarea up to a cap.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [input]);

  function onComposerKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send(input);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-gradient-to-b from-white via-fuchsia-50/20 to-white dark:from-[#0d1117] dark:via-fuchsia-950/10 dark:to-[#0d1117]">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-zinc-200/70 bg-white/80 px-4 py-3 backdrop-blur-md sm:px-6 dark:border-zinc-800 dark:bg-[#0d1117]/80">
        <div className="flex min-w-0 items-center gap-2.5">
          <BizAiBadge size="md" />
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold tracking-tight text-zinc-900 sm:text-lg dark:text-white">
              Penny AI
            </h1>
            <p className="truncate text-[11px] leading-tight text-zinc-500 dark:text-zinc-400">
              {subtitle}
            </p>
          </div>
        </div>
        {!empty && (
          <button
            type="button"
            onClick={clearChat}
            className="flex shrink-0 items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-[12px] font-medium text-zinc-600 transition hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden />
            <span className="hidden sm:inline">New chat</span>
          </button>
        )}
      </div>

      {/* Conversation */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <AnimatePresence mode="wait" initial={false}>
          {empty ? (
            <motion.div
              key="empty"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6, transition: { duration: 0.12 } }}
              transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
              className="mx-auto flex min-h-full max-w-2xl flex-col items-center justify-center gap-6 px-4 py-10 text-center"
            >
              <BizAiBadge size="lg" />
              <div className="space-y-1.5">
                <h2 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-white">
                  How can I help today?
                </h2>
                <p className="mx-auto max-w-md text-sm leading-relaxed text-zinc-500 dark:text-zinc-400">
                  {emptyBlurb}
                </p>
              </div>
              <div className="grid w-full grid-cols-1 gap-2.5 sm:grid-cols-2">
                {suggestions.map((s, i) => (
                  <motion.button
                    key={s.title}
                    type="button"
                    onClick={() => void send(s.title)}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.32, delay: 0.1 + i * 0.06, ease: [0.22, 1, 0.36, 1] }}
                    whileTap={{ scale: 0.97 }}
                    className="group flex flex-col gap-0.5 rounded-xl border border-zinc-200/80 bg-white px-3.5 py-3 text-left shadow-sm transition hover:border-fuchsia-300 hover:shadow-md dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-fuchsia-700/60"
                  >
                    <span className="flex items-center gap-1.5 text-[13.5px] font-medium text-zinc-800 dark:text-zinc-100">
                      <Sparkles className="h-3.5 w-3.5 shrink-0 text-fuchsia-500" aria-hidden />
                      {s.title}
                    </span>
                    <span className="pl-5 text-[11.5px] leading-snug text-zinc-400 dark:text-zinc-500">
                      {s.sub}
                    </span>
                  </motion.button>
                ))}
              </div>
            </motion.div>
          ) : (
            <motion.div
              key="chat"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0, transition: { duration: 0.15 } }}
              transition={{ duration: 0.25 }}
              className="mx-auto w-full max-w-3xl space-y-5 px-4 py-6 sm:px-6"
            >
              {messages.map((m) => {
                const isStreaming = busy && m.id === lastMsg?.id && m.role === 'assistant';
                const showRating = m.role === 'assistant' && !!m.content && !isStreaming;
                return (
                  <motion.div
                    key={m.id}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
                    className={m.role === 'user' ? 'flex justify-end' : 'flex items-start gap-3'}
                  >
                    {m.role === 'assistant' && (
                      <div className="mt-0.5 hidden sm:block">
                        <BizAiBadge size="sm" />
                      </div>
                    )}
                    <div className={m.role === 'user' ? 'flex max-w-[85%] flex-col items-end' : 'flex min-w-0 flex-1 flex-col gap-1.5'}>
                      <div
                        className={
                          m.role === 'user'
                            ? 'whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-gradient-to-br from-violet-600 to-fuchsia-600 px-4 py-2.5 text-[14px] leading-relaxed text-white shadow-sm'
                            : 'break-words rounded-2xl rounded-tl-md border border-zinc-200/80 bg-white px-4 py-3 text-[14px] leading-relaxed text-zinc-800 shadow-sm dark:border-zinc-700/60 dark:bg-zinc-900 dark:text-zinc-100'
                        }
                      >
                        {m.role === 'user' ? (
                          m.content
                        ) : m.content ? (
                          <AssistantContent text={m.content} streaming={isStreaming} />
                        ) : awaitingFirstToken ? (
                          <span className="inline-flex items-center gap-1.5 text-zinc-400">
                            <motion.span
                              initial={{ opacity: 0.4 }}
                              animate={{ opacity: [0.4, 1, 0.4] }}
                              transition={{ duration: 1.3, repeat: Infinity, ease: 'easeInOut' }}
                              className="inline-flex items-center gap-1.5"
                            >
                              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                              Thinking…
                            </motion.span>
                          </span>
                        ) : null}
                      </div>
                      {showRating && (
                        <MessageFeedback
                          rating={m.rating}
                          onRate={(rating, comment) => void rateMessage(m, rating, comment)}
                        />
                      )}
                    </div>
                  </motion.div>
                );
              })}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Composer */}
      <div className="shrink-0 border-t border-zinc-200/70 bg-white/85 px-3 py-3 backdrop-blur-md sm:px-6 dark:border-zinc-800 dark:bg-[#0d1117]/85">
        <div className="mx-auto w-full max-w-3xl">
          <div className="flex items-end gap-2 rounded-2xl border border-zinc-200 bg-zinc-50 px-3 py-2 shadow-sm transition focus-within:border-fuchsia-400 focus-within:ring-2 focus-within:ring-fuchsia-400/25 dark:border-zinc-700 dark:bg-zinc-900">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onComposerKey}
              rows={1}
              placeholder="Ask about payroll, a paycheck, or a report…"
              className="max-h-[200px] min-h-[28px] flex-1 resize-none bg-transparent py-1 text-[14.5px] leading-relaxed text-zinc-900 outline-none placeholder:text-zinc-400 dark:text-zinc-100"
            />
            <motion.button
              type="button"
              onClick={() => void send(input)}
              disabled={busy || !input.trim()}
              aria-label="Send message"
              whileTap={{ scale: 0.88 }}
              transition={{ type: 'spring', stiffness: 500, damping: 30 }}
              className="mb-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-violet-600 to-fuchsia-600 text-white shadow-sm transition-colors hover:from-violet-700 hover:to-fuchsia-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <ArrowUp className="h-4 w-4" aria-hidden strokeWidth={2.5} />
              )}
            </motion.button>
          </div>
          <p className="mt-1.5 px-1 text-center text-[10.5px] text-zinc-400">
            Penny AI reads live payroll data and can make mistakes. Verify important figures before acting.
          </p>
        </div>
      </div>
    </div>
  );
}
