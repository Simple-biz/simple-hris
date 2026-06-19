'use client';

import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Send, X, Sparkles, Loader2, Trash2, ThumbsUp, ThumbsDown } from 'lucide-react';

type Msg = {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  /** Stable id for an assistant reply, used as the feedback upsert key. */
  key?: string;
  /** The viewer's rating of this reply, if any. */
  rating?: 'up' | 'down' | null;
};

type Align = 'left' | 'right' | 'center';
type Segment =
  | { type: 'text'; text: string }
  | { type: 'table'; headers: string[]; aligns: Align[]; rows: string[][] };

/** Split a markdown table row into trimmed cells (tolerates missing outer pipes). */
function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

const SEP_CELL = /^:?-{1,}:?$/;
function isSeparator(line: string): boolean {
  if (!line.includes('|') && !line.includes('-')) return false;
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((c) => SEP_CELL.test(c.replace(/\s/g, '')));
}

/**
 * Parse assistant text into plain-text and GitHub-style-table segments. The
 * widget renders messages as plain text, so this is the ONLY markdown we
 * support — it turns pipe tables into real <table>s and leaves everything else
 * as text. Runs on every streamed update; a half-streamed table simply renders
 * as text until its separator row arrives, then snaps into a table.
 */
function parseSegments(input: string): Segment[] {
  const lines = input.split('\n');
  const segs: Segment[] = [];
  let buf: string[] = [];
  const flush = () => {
    if (!buf.length) return;
    const text = buf.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    if (text) segs.push({ type: 'text', text });
    buf = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const next = lines[i + 1];
    if (line.includes('|') && next != null && isSeparator(next)) {
      flush();
      const headers = splitRow(line);
      const aligns: Align[] = splitRow(next).map((c) => {
        const t = c.trim();
        const l = t.startsWith(':');
        const r = t.endsWith(':');
        return l && r ? 'center' : r ? 'right' : 'left';
      });
      const rows: string[][] = [];
      let j = i + 2;
      for (; j < lines.length; j++) {
        if (!lines[j].includes('|') || isSeparator(lines[j])) break;
        rows.push(splitRow(lines[j]));
      }
      segs.push({ type: 'table', headers, aligns, rows });
      i = j - 1;
    } else {
      buf.push(line);
    }
  }
  flush();
  return segs;
}

const ALIGN_CLASS: Record<Align, string> = {
  left: 'text-left',
  right: 'text-right',
  center: 'text-center',
};

/** Renders an assistant message: plain text, with pipe tables shown as real tables. */
function AssistantContent({ text }: { text: string }) {
  const segments = parseSegments(text);
  return (
    <div className="space-y-2">
      {segments.map((seg, idx) =>
        seg.type === 'text' ? (
          <div key={idx} className="whitespace-pre-wrap break-words">
            {seg.text}
          </div>
        ) : (
          <div key={idx} className="-mx-2 overflow-x-auto">
            <table className="w-full border-collapse text-[12px] leading-snug">
              <thead>
                <tr>
                  {seg.headers.map((h, k) => (
                    <th
                      key={k}
                      className={`whitespace-nowrap border-b border-amber-200/80 px-2 py-1 font-semibold text-zinc-600 dark:border-amber-900/50 dark:text-zinc-300 ${ALIGN_CLASS[seg.aligns[k] ?? 'left']}`}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {seg.rows.map((row, ri) => (
                  <tr key={ri} className="odd:bg-amber-50/40 dark:odd:bg-white/[0.03]">
                    {seg.headers.map((_, ci) => (
                      <td
                        key={ci}
                        className={`whitespace-nowrap border-b border-zinc-100 px-2 py-1 text-zinc-700 dark:border-zinc-800 dark:text-zinc-200 ${ALIGN_CLASS[seg.aligns[ci] ?? 'left']}`}
                      >
                        {row[ci] ?? ''}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ),
      )}
    </div>
  );
}

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
    const replyKey =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `r${replyId}-${Date.now()}`;
    setMessages((m) => [...m, { id: replyId, role: 'assistant', content: '', key: replyKey }]);

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

  function clearChat() {
    setMessages([]);
    setInput('');
    setCommentFor(null);
    setCommentText('');
  }

  // Record a thumbs up/down (and optional comment) for one reply. Optimistic;
  // the POST is best-effort so a network hiccup never disrupts the chat.
  async function rateMessage(target: Msg, rating: 'up' | 'down', comment?: string) {
    if (!target.key) return;
    setMessages((m) => m.map((x) => (x.id === target.id ? { ...x, rating } : x)));

    const idx = messages.findIndex((x) => x.id === target.id);
    let userMessage = '';
    for (let i = idx - 1; i >= 0; i--) {
      if (messages[i]!.role === 'user') {
        userMessage = messages[i]!.content;
        break;
      }
    }
    const context = (idx >= 0 ? messages.slice(Math.max(0, idx - 7), idx + 1) : []).map(
      ({ role, content }) => ({ role, content }),
    );

    try {
      await fetch('/api/ceo/chat/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message_key: target.key,
          rating,
          assistant_message: target.content,
          user_message: userMessage,
          comment: comment ?? null,
          context,
        }),
      });
    } catch {
      // best-effort — keep the optimistic UI state regardless
    }
  }

  const [commentFor, setCommentFor] = useState<number | null>(null);
  const [commentText, setCommentText] = useState('');

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
                  const isStreaming =
                    busy && m.id === lastMsg?.id && m.role === 'assistant';
                  const showRating = m.role === 'assistant' && !!m.content && !isStreaming;
                  return (
                    <div
                      key={m.id}
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
                          <AssistantContent text={m.content} />
                        ) : awaitingFirstToken ? (
                          <span className="inline-flex items-center gap-1.5 text-zinc-400">
                            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                            Thinking…
                          </span>
                        ) : null}
                      </div>

                      {showRating && (
                        <div className="flex flex-col gap-1 pl-1">
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => {
                                void rateMessage(m, 'up');
                                if (commentFor === m.id) setCommentFor(null);
                              }}
                              aria-label="Good response"
                              title="Good response"
                              className={`flex h-6 w-6 items-center justify-center rounded-md transition ${
                                m.rating === 'up'
                                  ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
                                  : 'text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800'
                              }`}
                            >
                              <ThumbsUp className="h-3.5 w-3.5" aria-hidden />
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                void rateMessage(m, 'down');
                                setCommentFor(m.id);
                                setCommentText('');
                              }}
                              aria-label="Bad response"
                              title="Bad response"
                              className={`flex h-6 w-6 items-center justify-center rounded-md transition ${
                                m.rating === 'down'
                                  ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
                                  : 'text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800'
                              }`}
                            >
                              <ThumbsDown className="h-3.5 w-3.5" aria-hidden />
                            </button>
                          </div>

                          {commentFor === m.id && (
                            <div className="flex items-center gap-1">
                              <input
                                value={commentText}
                                onChange={(e) => setCommentText(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') {
                                    void rateMessage(m, 'down', commentText.trim() || undefined);
                                    setCommentFor(null);
                                  } else if (e.key === 'Escape') {
                                    setCommentFor(null);
                                  }
                                }}
                                placeholder="What was off? (optional)"
                                className="w-48 rounded-md border border-zinc-200 bg-white px-2 py-1 text-[11.5px] text-zinc-700 outline-none focus:border-amber-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
                              />
                              <button
                                type="button"
                                onClick={() => {
                                  void rateMessage(m, 'down', commentText.trim() || undefined);
                                  setCommentFor(null);
                                }}
                                className="rounded-md bg-amber-600 px-2 py-1 text-[11.5px] font-medium text-white transition hover:bg-amber-700"
                              >
                                Send
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
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
