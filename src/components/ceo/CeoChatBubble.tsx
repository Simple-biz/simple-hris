'use client';

import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Send, X, Sparkles, Loader2, Trash2, Maximize2 } from 'lucide-react';
import { AssistantContent, MessageFeedback } from './ceo-chat-message';
import { useCeoChat } from './use-ceo-chat';
import {
  parseQuotaHeader,
  quotaMessage,
  type EmployeePennyQuota,
} from '@/lib/penny/employee-quota';
import { shouldShowGreeting } from '@/lib/penny/employee-faq';

const SUGGESTIONS = [
  'Pull the latest payroll report',
  'How much did we pay out last week?',
  'Help me think through a decision',
];

/**
 * Floating Penny AI assistant — the always-available chat bubble. Shares its
 * backend and logic with the full-page Penny AI tab via {@link useCeoChat}.
 * Defaults to the CEO assistant; the Admin dashboard remounts it with its own
 * `endpoint`/`subtitle`/`suggestions`, and the employee Overview mounts it with
 * `quotaEndpoint` + `feedbackEndpoint={null}` for the metered employee
 * assistant. When the full Penny AI tab is open, the shell passes `hidden` so
 * only one chat shows at once.
 */
export default function CeoChatBubble({
  hidden = false,
  onOpenFullView,
  endpoint,
  subtitle = 'Payroll & reports assistant',
  suggestions = SUGGESTIONS,
  feedbackEndpoint,
  quotaEndpoint,
  extraBody,
  markSrc = '/chatbubble.png',
  greeting,
}: {
  hidden?: boolean;
  /** When provided, shows an "expand" button that opens the full Penny AI tab. */
  onOpenFullView?: () => void;
  /** Chat backend to POST to (defaults to the CEO assistant's). */
  endpoint?: string;
  /** Small line under "Penny AI" in the panel header. */
  subtitle?: string;
  /** Empty-state starter prompts. */
  suggestions?: string[];
  /** Thumbs-rating route. `null` hides the rating controls (employee surface). */
  feedbackEndpoint?: string | null;
  /**
   * When set, this surface has a metered daily allowance: the endpoint is polled
   * on open to seed the counter, and every reply refreshes it from the response
   * header. Omit on the unmetered CEO/Admin surfaces — with no endpoint there is
   * no counter, no warning line and nothing to grey out.
   */
  quotaEndpoint?: string;
  /** Extra fields merged into every chat POST body (e.g. the viewed `email`). */
  extraBody?: Record<string, unknown>;
  /**
   * The heart mark on the closed button. Defaults to the original Penny heart so
   * CEO and Admin are untouched; the employee dashboard passes the headset heart
   * (`/Chatbubblev2.png`) — a support-desk read, which is what Penny is for an
   * employee rather than the reports assistant it is for the CEO.
   */
  markSrc?: string;
  /**
   * Opt into the proactive greeting balloon (employee dashboard only). Omit and
   * the bubble never speaks first — CEO and Admin are unchanged.
   *
   * `chips` must be questions the assistant can actually answer: the balloon is
   * Penny raising a subject on its own initiative, so an offer it cannot fulfil
   * costs the employee one of their ten prompts to hear "I can't".
   */
  greeting?: {
    text: string;
    chips: { question: string; short: string }[];
    delayMs: number;
    autoHideMs: number;
    /** Distinguishes the once-per-session dismissal between mounts. */
    storageKey: string;
  };
}) {
  const [open, setOpen] = useState(false);
  const [quota, setQuota] = useState<EmployeePennyQuota | null>(null);

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
    feedbackEnabled,
  } = useCeoChat({
    inputRef,
    endpoint,
    feedbackEndpoint,
    extraBody,
    onQuotaHeader: quotaEndpoint
      ? (raw) => {
          const q = parseQuotaHeader(raw);
          if (q) setQuota(q);
        }
      : undefined,
  });

  // Seed / re-seed the counter from the server whenever the panel opens. The
  // client never counts for itself: a refunded turn (an error that cost nothing)
  // leaves the header's number one low, and this read corrects it.
  useEffect(() => {
    if (!open || !quotaEndpoint) return;
    let cancelled = false;
    fetch(quotaEndpoint, { cache: 'no-store' })
      .then((r) => (r.ok ? r.text() : null))
      .then((body) => {
        if (cancelled) return;
        const q = parseQuotaHeader(body);
        if (q) setQuota(q);
      })
      .catch(() => {
        /* leave the last known figure — never invent headroom */
      });
    return () => {
      cancelled = true;
    };
  }, [open, quotaEndpoint]);

  const metered = !!quotaEndpoint && !!quota && !quota.exempt;
  const locked = metered && quota!.exhausted;
  const warning = metered ? quotaMessage(quota!) : null;

  /* ── The proactive greeting ─────────────────────────────────────────────── */

  const [greetOpen, setGreetOpen] = useState(false);
  // Persisted dismissal (the ✕ only) is remembered for the browser session, so
  // someone who explicitly said no is not re-asked on the next page.
  const [greetDismissed, setGreetDismissed] = useState(() => {
    if (typeof window === 'undefined' || !greeting) return false;
    try {
      return sessionStorage.getItem(greeting.storageKey) === '1';
    } catch {
      return false;
    }
  });

  // ⚠ Timer effects below depend on these PRIMITIVES, never on `greeting` itself.
  // Callers pass `greeting={{ … }}` as an inline object literal, so its identity
  // changes on every parent render — and the employee shell re-renders on its
  // notification, dispatch-lock and MESA polls, i.e. well inside five seconds.
  // An effect keyed on the object would clear and re-arm the fuse every render
  // and the greeting would, in practice, never fire at all. Extracting the
  // numbers puts that guarantee in the component rather than in every caller's
  // discipline about `useMemo`.
  const greetingDelayMs = greeting?.delayMs;
  const greetingAutoHideMs = greeting?.autoHideMs;
  const greetingStorageKey = greeting?.storageKey;

  /**
   * Stop offering for THIS page load only. Used when the employee engages —
   * taps a chip, or opens the panel — because the nudge has done its job and
   * repeating it during the same visit is noise.
   */
  const hideGreetingForNow = () => {
    setGreetOpen(false);
    setGreetDismissed(true);
  };

  /**
   * Stop offering for the whole browser session, persisted. **Only the explicit
   * ✕ does this.** Engaging with Penny is not a "no", and treating it as one meant
   * a refresh showed no greeting at all once the panel had ever been opened —
   * which defeats offering a fresh set of questions per load.
   */
  const dismissGreetingForSession = () => {
    hideGreetingForNow();
    try {
      if (greetingStorageKey) sessionStorage.setItem(greetingStorageKey, '1');
    } catch {
      /* private mode — the in-memory flag still holds for this mount */
    }
  };

  // Arm the fuse once. Deliberately NOT gated on `open` / `messages`: a five-second
  // timer outlives any of those changing, so gating it here would be a stale
  // closure either way. **`showGreeting` below is the authority** — it is
  // re-evaluated every render and so cannot go stale.
  useEffect(() => {
    if (greetingDelayMs == null || greetDismissed) return;
    const t = setTimeout(() => setGreetOpen(true), greetingDelayMs);
    return () => clearTimeout(t);
  }, [greetingDelayMs, greetDismissed]);

  // Retreat on its own; a balloon that never leaves is furniture, not an offer.
  useEffect(() => {
    if (!greetOpen || greetingAutoHideMs == null) return;
    const t = setTimeout(() => setGreetOpen(false), greetingAutoHideMs);
    return () => clearTimeout(t);
  }, [greetOpen, greetingAutoHideMs]);

  // Opening Penny at all means the nudge did its job — don't offer again this
  // page load, so closing the panel does not bring the balloon back. NOT persisted:
  // engaging is not a "no", so the next page load greets again with a fresh five.
  useEffect(() => {
    if (open && greetingStorageKey && !greetDismissed) hideGreetingForNow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // The single source of truth for whether the balloon is on screen — a pure,
  // tested predicate rather than a condition spread across the effects above.
  // If you add a new reason to stay quiet, add it THERE, not to a timer.
  const showGreeting =
    !!greeting &&
    shouldShowGreeting({
      armed: greetOpen,
      panelOpen: open,
      quotaExhausted: locked,
      widgetHidden: hidden,
      messageCount: messages.length,
    });

  /** Tapping a chip opens the panel and asks that question straight away. */
  function askFromGreeting(question: string) {
    hideGreetingForNow();
    setOpen(true);
    void send(question);
  }

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
      // Enter must respect the lock too — the disabled send button alone would
      // still let a keyboard send through to a guaranteed 429.
      if (locked) return;
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
            aria-label="Penny AI assistant"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 16 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            /* Anchors are tied to the button's size (h-16 at bottom-5 → its top edge
               is 84px): bottom-[6.5rem] = 104px keeps the 20px gap the h-14 button
               had at bottom-24, and the height subtracts 7.5rem so a short viewport
               still leaves ~16px of clearance above the panel. Resize the button and
               these two move with it — the greeting balloon shares the anchor. */
            className="fixed bottom-[6.5rem] right-4 z-50 flex h-[min(560px,calc(100dvh-7.5rem))] w-[min(380px,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border border-fuchsia-200/80 bg-white shadow-2xl shadow-fuchsia-900/15 dark:border-fuchsia-900/40 dark:bg-[#0d1117] sm:right-6"
          >
            {/* Header */}
            <div className="flex shrink-0 items-center justify-between gap-3 bg-gradient-to-br from-violet-600 via-fuchsia-600 to-fuchsia-700 px-4 py-3 text-white dark:from-violet-700 dark:via-fuchsia-800 dark:to-fuchsia-900">
              <div className="flex min-w-0 items-center gap-2.5">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/15 backdrop-blur-sm">
                  <Sparkles className="h-4 w-4" aria-hidden />
                </span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold leading-tight">Penny AI</p>
                  <p className="truncate text-[11px] leading-tight text-fuchsia-50/80">
                    {subtitle}
                  </p>
                </div>
                {/* Questions left today. Always visible on a metered surface —
                    Kane 2026-08-19: the warning has to arrive before the lock,
                    so the count is never hidden until it runs out. */}
                {metered && (
                  <span
                    aria-label={`${quota!.remaining} of ${quota!.limit} questions left today`}
                    className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums ring-1 ${
                      quota!.warnLevel === 'exhausted'
                        ? 'bg-white text-fuchsia-800 ring-white/70'
                        : quota!.warnLevel === 'last'
                          ? 'bg-amber-300 text-amber-950 ring-amber-200/80'
                          : quota!.warnLevel === 'low'
                            ? 'bg-white/25 text-white ring-white/50'
                            : 'bg-white/15 text-white ring-white/30'
                    }`}
                  >
                    {quota!.remaining}/{quota!.limit}
                  </span>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {onOpenFullView && (
                  <button
                    type="button"
                    onClick={() => {
                      onOpenFullView();
                      setOpen(false);
                    }}
                    aria-label="Open full Penny AI view"
                    title="Open full view"
                    className="flex h-8 w-8 items-center justify-center rounded-full text-white/90 transition hover:bg-white/20"
                  >
                    <Maximize2 className="h-4 w-4" aria-hidden />
                  </button>
                )}
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
              className="flex-1 space-y-3 overflow-y-auto bg-fuchsia-50/30 px-3.5 py-4 dark:bg-black/20"
            >
              {messages.length === 0 ? (
                <div className="flex flex-col gap-3 px-1 pt-2">
                  <p className="text-sm font-medium text-zinc-700 dark:text-zinc-200">
                    {locked ? "That's all my questions for today" : 'Hi 👋 What can I help you with?'}
                  </p>
                  <div className="flex flex-col gap-2">
                    {suggestions.map((s) => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => void send(s)}
                        // A starter chip on a locked panel would fire a send the
                        // server is certain to refuse.
                        disabled={locked}
                        className="rounded-xl border border-fuchsia-200/70 bg-white px-3 py-2 text-left text-[13px] text-zinc-700 shadow-sm transition hover:border-fuchsia-300 hover:bg-fuchsia-50 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-fuchsia-200/70 disabled:hover:bg-white dark:border-fuchsia-900/40 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800 dark:disabled:hover:bg-zinc-900"
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                messages.map((m) => {
                  const isStreaming = busy && m.id === lastMsg?.id && m.role === 'assistant';
                  const showRating =
                    feedbackEnabled && m.role === 'assistant' && !!m.content && !isStreaming;
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
                            ? 'max-w-[82%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-gradient-to-br from-violet-600 to-fuchsia-600 px-3.5 py-2 text-[13.5px] leading-relaxed text-white shadow-sm'
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
              {/* The escalating warning: quiet above 3 left, amber at 2–3, firm at
                  the last one, and an explanation once the composer is locked.
                  `role="status"` so a screen reader hears the countdown too. */}
              {warning && (
                <p
                  role="status"
                  className={`mb-1.5 rounded-lg px-2 py-1.5 text-[11.5px] leading-snug ${
                    locked
                      ? 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800/70 dark:text-zinc-300'
                      : quota!.warnLevel === 'last'
                        ? 'bg-amber-50 text-amber-800 ring-1 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-200 dark:ring-amber-900/60'
                        : 'bg-fuchsia-50 text-fuchsia-800 dark:bg-fuchsia-950/30 dark:text-fuchsia-200'
                  }`}
                >
                  {warning}
                </p>
              )}
              <div
                className={`flex items-end gap-2 rounded-xl border px-2.5 py-1.5 ${
                  locked
                    ? 'border-zinc-200 bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900/60'
                    : 'border-zinc-200 bg-zinc-50 focus-within:border-fuchsia-400 focus-within:ring-2 focus-within:ring-fuchsia-400/30 dark:border-zinc-700 dark:bg-zinc-900'
                }`}
              >
                <textarea
                  ref={inputRef}
                  value={locked ? '' : input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={onComposerKey}
                  rows={1}
                  disabled={locked}
                  placeholder={locked ? 'Back tomorrow — see you then' : 'Type a message…'}
                  className="max-h-28 min-h-[24px] flex-1 resize-none bg-transparent py-1 text-[13.5px] leading-relaxed text-zinc-900 outline-none placeholder:text-zinc-400 disabled:cursor-not-allowed dark:text-zinc-100"
                />
                <button
                  type="button"
                  onClick={() => void send(input)}
                  disabled={busy || locked || !input.trim()}
                  aria-label="Send message"
                  className="mb-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-violet-600 to-fuchsia-600 text-white transition hover:from-violet-700 hover:to-fuchsia-700 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {busy ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  ) : (
                    <Send className="h-4 w-4" aria-hidden />
                  )}
                </button>
              </div>
              <p className="mt-1 px-1 text-[10.5px] text-zinc-400">
                Penny AI can make mistakes. Verify important details.
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Proactive greeting balloon — a speech bubble off the chat head, the same
          shape the Payroll Wizard's guide uses. It never gates: it sits above the
          button, is dismissible, retreats on its own, and vanishes the moment the
          panel opens, a conversation starts, or the allowance runs out. */}
      <AnimatePresence>
        {showGreeting && greeting && (
          <motion.div
            key="penny-greeting"
            role="dialog"
            aria-label="Penny AI has a suggestion"
            initial={{ opacity: 0, y: 8, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.96 }}
            transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
            className="fixed bottom-[6.5rem] right-4 z-50 w-[min(19rem,calc(100vw-2rem))] origin-bottom-right rounded-2xl rounded-br-md border border-orange-200/80 bg-white p-3 shadow-xl shadow-orange-900/15 dark:border-orange-900/40 dark:bg-[#0d1117] sm:right-6"
          >
            <button
              type="button"
              onClick={dismissGreetingForSession}
              aria-label="Dismiss"
              className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800"
            >
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
            <p className="pr-6 text-[13px] font-medium leading-snug text-zinc-800 dark:text-zinc-100">
              {greeting.text}
            </p>
            <div className="mt-2 flex flex-col gap-1.5">
              {greeting.chips.map((c) => (
                <button
                  key={c.question}
                  type="button"
                  onClick={() => askFromGreeting(c.question)}
                  className="rounded-lg border border-orange-200/70 bg-orange-50/60 px-2.5 py-1.5 text-left text-[12.5px] font-medium text-orange-900 transition hover:border-orange-300 hover:bg-orange-100/70 dark:border-orange-900/40 dark:bg-orange-950/30 dark:text-orange-200 dark:hover:bg-orange-950/50"
                >
                  {c.short}
                </button>
              ))}
            </div>
            {/* Opening the panel with nothing typed is the low-commitment exit —
                the chips are shortcuts, not the only way in. */}
            <button
              type="button"
              onClick={() => {
                hideGreetingForNow();
                setOpen(true);
              }}
              className="mt-2 w-full rounded-lg px-2.5 py-1 text-[12px] text-zinc-500 transition hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
            >
              Ask something else
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Floating beating-heart button — an orange heart that beats (lub-dub)
          with a pulsing halo. Becomes a close (X) while the panel is open. */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={
          open
            ? 'Close Penny AI'
            : locked
              ? "Open Penny AI — no questions left today"
              : metered
                ? `Open Penny AI — ${quota!.remaining} of ${quota!.limit} questions left today`
                : 'Open Penny AI'
        }
        aria-expanded={open}
        className="group fixed bottom-5 right-4 z-50 flex h-16 w-16 items-center justify-center transition-transform active:scale-90 sm:right-6"
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
              className="flex h-16 w-16 items-center justify-center rounded-full border border-orange-200/70 bg-white shadow-lg shadow-orange-900/25 dark:border-orange-900/40 dark:bg-zinc-900"
            >
              <X className="h-7 w-7 text-orange-600 dark:text-orange-400" aria-hidden />
            </motion.span>
          ) : (
            <motion.span
              key="heart"
              initial={{ opacity: 0, scale: 0.6 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.6 }}
              transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
              className="relative flex h-16 w-16 items-center justify-center"
            >
              {/* Out of questions: the heart REMAINS — Kane 2026-08-19, it greys
                  out rather than vanishing, so nobody is left wondering where
                  Penny went — but it stops beating and drops its halo, which is
                  the "come back tomorrow" signal at a glance. */}
              {!locked && (
                <>
                  {/* pulsing orange halo (two staggered rings → ripple) */}
                  <span
                    aria-hidden
                    className="penny-halo absolute h-[3.25rem] w-[3.25rem] rounded-full bg-orange-500/45 blur-md"
                    style={{ animation: 'pennyHeartHalo 1.5s ease-out infinite' }}
                  />
                  <span
                    aria-hidden
                    className="penny-halo absolute h-[3.25rem] w-[3.25rem] rounded-full bg-orange-400/40"
                    style={{ animation: 'pennyHeartHalo 1.5s ease-out infinite 0.35s' }}
                  />
                </>
              )}
              {/* the beating heart — the Penny AI heart mark */}
              <img
                aria-hidden
                src={markSrc}
                alt=""
                draggable={false}
                className={`penny-heart relative h-11 w-11 object-contain drop-shadow-md ${
                  locked ? 'opacity-45 grayscale' : ''
                }`}
                style={
                  locked
                    ? undefined
                    : {
                        animation: 'pennyHeartbeat 1.3s ease-in-out infinite',
                        transformOrigin: 'center',
                      }
                }
              />
            </motion.span>
          )}
        </AnimatePresence>
      </button>
    </>
  );
}
