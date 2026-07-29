'use client';

import { useRef, useState, type RefObject } from 'react';

/**
 * Shared conversation state + streaming logic for the CEO assistant. Both the
 * floating bubble and the full-page Penny AI tab use this hook so they talk to the
 * same `/api/ceo/chat` endpoint (Claude + read-only payroll tools) identically.
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
}) {
  const endpoint = opts?.endpoint ?? '/api/ceo/chat';
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
          messages: history.map(({ role, content }) => ({ role, content })),
        }),
      });

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
  };
}
