/**
 * The ONE place the accounting team space's Google Chat webhook is posted to: the Admin's Post to Chat click
 * (postTaskProgress) and the scheduled posts (scheduled-chat.ts) both send through here, so they cannot drift.
 *
 * The URL carries a key. It is passed in by the caller (each reads ACCOUNTING_SCOREBOARD_CHAT_WEBHOOK_URL itself) and
 * never appears in an outcome, so it cannot reach a response, an error, the posts table or the audit row.
 *
 * What each outcome means:
 *   - posted     Google answered 2xx. `withCard` says whether the bars card went with it.
 *   - refused    Google answered non-2xx: NOTHING was posted.
 *   - unreachable the request failed before Google answered: nothing was posted.
 *   - timed_out  no answer within 10 s: it MAY OR MAY NOT have posted. Never retried, here or by any caller.
 * A card Google refuses with HTTP 400 is sent ONCE more as the sentence alone. A 400 posted nothing, so this cannot
 * post twice; Google does not document cards on incoming webhooks, and this keeps the proven text post working if it
 * refuses them. No other status is re-sent.
 *
 * No `server-only`: nothing here reads a secret, and the tests pass a fake fetch.
 * Governing doc: docs/features/accounting-scoreboard-tasks.md § The progress message.
 */

import type { ChatPost } from './chat-summary';

export const CHAT_TIMEOUT_MS = 10_000;

export type SendOutcome =
  | { status: 'posted'; withCard: boolean }
  | { status: 'refused'; httpStatus: number; detail: string }
  | { status: 'unreachable' | 'timed_out'; detail: string };

type Once = { status: 'posted' } | Exclude<SendOutcome, { status: 'posted' }>;

async function postOnce(url: string, body: ChatPost, fetchImpl: typeof fetch): Promise<Once> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify(body),
      cache: 'no-store',
      signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
    });
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return timedOut
      ? { status: 'timed_out', detail: 'Google Chat did not answer within 10 seconds. The message may or may not have posted.' }
      : { status: 'unreachable', detail: 'Could not reach Google Chat. Nothing was posted.' };
  }
  if (!res.ok) return { status: 'refused', httpStatus: res.status, detail: `Google Chat refused the post (HTTP ${res.status}).` };
  return { status: 'posted' };
}

export async function sendChatPost(url: string, post: ChatPost, fetchImpl: typeof fetch = fetch): Promise<SendOutcome> {
  const first = await postOnce(url, post, fetchImpl);
  if (first.status === 'posted') return { status: 'posted', withCard: !!post.cardsV2 };
  if (first.status === 'refused' && first.httpStatus === 400 && post.cardsV2) {
    const plain = await postOnce(url, { text: post.text }, fetchImpl);
    return plain.status === 'posted' ? { status: 'posted', withCard: false } : plain;
  }
  return first;
}
