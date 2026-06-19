'use client';

import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Send, X, Sparkles, Loader2 } from 'lucide-react';

type Msg = { id: number; role: 'user' | 'assistant'; content: string };

const SUGGESTIONS = [
  'Draft a company-wide announcement',
  'Summarize this for me',
  'Help me think through a decision',
];

export default function CeoChatBubble() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const idRef = useRef(0);
  const nextId = () => ++idRef.current;

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

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || busy) return;

    const userMsg: Msg = { id: nextId(), role: 'user', content: trimmed };
    const history = [...messages, userMsg];
    setMessages(history);
    setInput('');
    setBusy(true);

    const replyId = nextId();
    setMessages((m) => [...m, { id: replyId, role: 'assistant', content: '' }]);

    try {
      const res = await fetch('/api/ceo/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: history.map(({ role, content }) => ({ role, content })),
        }),
      });

      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => null);
        const errText =
          (j && typeof j.error === 'string' && j.error) ||
          'Sorry — I could not reach the assistant just now.';
        setMessages((m) =>
          m.map((msg) => (msg.id === replyId ? { ...msg, content: errText } : msg)),
        );
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        if (!chunk) continue;
        setMessages((m) =>
          m.map((msg) =>
            msg.id === replyId ? { ...msg, content: msg.content + chunk } : msg,
          ),
        );
      }
    } catch {
      setMessages((m) =>
        m.map((msg) =>
          msg.id === replyId
            ? { ...msg, content: 'Sorry — something went wrong. Please try again.' }
            : msg,
        ),
      );
    } finally {
      setBusy(false);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }

  function onComposerKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send(input);
    }
  }

  const lastMsg = messages[messages.length - 1];
  const awaitingFirstToken =
    busy && lastMsg?.role === 'assistant' && lastMsg.content.length === 0;

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
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close chat"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-white/90 transition hover:bg-white/20"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
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
                messages.map((m) => (
                  <div
                    key={m.id}
                    className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}
                  >
                    <div
                      className={
                        m.role === 'user'
                          ? 'max-w-[82%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-amber-600 px-3.5 py-2 text-[13.5px] leading-relaxed text-white shadow-sm'
                          : 'max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-bl-md border border-zinc-200/80 bg-white px-3.5 py-2 text-[13.5px] leading-relaxed text-zinc-800 shadow-sm dark:border-zinc-700/60 dark:bg-zinc-900 dark:text-zinc-100'
                      }
                    >
                      {m.content || (m.role === 'assistant' && awaitingFirstToken ? (
                        <span className="inline-flex items-center gap-1.5 text-zinc-400">
                          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                          Thinking…
                        </span>
                      ) : (
                        m.content
                      ))}
                    </div>
                  </div>
                ))
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

      {/* Floating bubble button */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={open ? 'Close assistant' : 'Open assistant'}
        aria-expanded={open}
        className="fixed bottom-5 right-4 z-50 flex h-14 w-14 items-center justify-center rounded-full border border-amber-200/70 bg-white shadow-lg shadow-amber-900/25 transition-transform duration-200 hover:scale-105 active:scale-95 dark:border-amber-900/40 dark:bg-zinc-900 sm:right-6"
      >
        <AnimatePresence mode="wait" initial={false}>
          {open ? (
            <motion.span
              key="close"
              initial={{ opacity: 0, rotate: -90 }}
              animate={{ opacity: 1, rotate: 0 }}
              exit={{ opacity: 0, rotate: 90 }}
              transition={{ duration: 0.15 }}
              className="flex items-center justify-center"
            >
              <X className="h-6 w-6 text-amber-700 dark:text-amber-400" aria-hidden />
            </motion.span>
          ) : (
            <motion.img
              key="bubble"
              src="/chatbubble.png"
              alt=""
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="h-8 w-8 object-contain"
              draggable={false}
            />
          )}
        </AnimatePresence>
      </button>
    </>
  );
}
