'use client';

import { useRef, useState, type RefObject } from 'react';

/**
 * Shared conversation state + streaming logic for every Penny surface. The CEO
 * bubble and full-page tab, the Admin bubble and tab, and the employee bubble all
 * use this hook, differing only by `endpoint` (and, for the employee, a metered
 * allowance reported back through `onQuotaHeader`).
 *
 * Defaults are the CEO assistant's, so a caller that passes nothing behaves
 * exactly as it did before the other surfaces existed.
 *
 * The transcript is per-mount and client-only — there is no server persistence,
 * so each surface keeps its own thread.
 */

export type CeoMsg = {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  /** Stable id for an assistant reply, used as the feedback upsert key. */
  key?: string;
  /** The viewer's rating of this reply, if any. */
  rating?: 'up' | 'down' | null;
};

export function useCeoChat(opts?: {
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  /** Chat backend to POST to. Defaults to the CEO assistant; the Admin
   *  dashboard passes its own admin-gated endpoint. */
  endpoint?: string;
  /**
   * Where thumbs-up/down go. Defaults to the CEO feedback route (which admits
   * ceo/admin only). Pass `null` on a surface whose viewers that route would
   * reject — the employee assistant — so no rating is silently 403'd.
   */
  feedbackEndpoint?: string | null;
  /** Extra fields merged into every POST body (e.g. the viewed `email`). */
  extraBody?: Record<string, unknown>;
  /**
   * Called with the raw `X-Penny-Quota` header after every send, and with null
   * when a send failed before the server could report one. Only the employee
   * assistant meters prompts; the header is absent elsewhere, so this never
   * fires for CEO/Admin.
   */
  onQuotaHeader?: (raw: string | null) => void;
}) {
  const endpoint = opts?.endpoint ?? '/api/ceo/chat';
  const feedbackEndpoint =
    opts?.feedbackEndpoint === undefined ? '/api/ceo/chat/feedback' : opts.feedbackEndpoint;
  const [messages, setMessages] = useState<CeoMsg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);

  const idRef = useRef(0);
  const nextId = () => ++idRef.current;

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || busy) return;

    const userMsg: CeoMsg = { id: nextId(), role: 'user', content: trimmed };
    const history = [...messages, userMsg];
    setMessages(history);
    setInput('');
    setBusy(true);

    const replyId = nextId();
    const replyKey =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `r${replyId}-${replyId}`;
    setMessages((m) => [...m, { id: replyId, role: 'assistant', content: '', key: replyKey }]);

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(opts?.extraBody ?? {}),
          messages: history.map(({ role, content }) => ({ role, content })),
        }),
      });

      // Report the server's count on every outcome — a 429 ("you've used all
      // ten") carries the header too, and that response is exactly when the
      // indicator most needs to be right.
      opts?.onQuotaHeader?.(res.headers.get('X-Penny-Quota'));

      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => null);
        const errText =
          (j && typeof j.error === 'string' && j.error) ||
          'Sorry — I could not reach the assistant just now.';
        setMessages((m) => m.map((msg) => (msg.id === replyId ? { ...msg, content: errText } : msg)));
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
          m.map((msg) => (msg.id === replyId ? { ...msg, content: msg.content + chunk } : msg)),
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
      setTimeout(() => opts?.inputRef?.current?.focus(), 0);
    }
  }

  function clearChat() {
    setMessages([]);
    setInput('');
  }

  // Record a thumbs up/down (and optional comment) for one reply. Optimistic;
  // the POST is best-effort so a network hiccup never disrupts the chat.
  async function rateMessage(target: CeoMsg, rating: 'up' | 'down', comment?: string) {
    if (!target.key || !feedbackEndpoint) return;
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
      await fetch(feedbackEndpoint, {
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

  const lastMsg = messages[messages.length - 1];
  const awaitingFirstToken = busy && lastMsg?.role === 'assistant' && lastMsg.content.length === 0;

  return {
    messages,
    input,
    setInput,
    busy,
    send,
    clearChat,
    rateMessage,
    lastMsg,
    awaitingFirstToken,
    /** False when the surface has no feedback route — hide the thumbs entirely
     *  rather than showing controls whose POST is dropped. */
    feedbackEnabled: !!feedbackEndpoint,
  };
}
