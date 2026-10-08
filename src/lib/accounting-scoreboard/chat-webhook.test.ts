import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sendChatPost } from './chat-webhook';
import type { ChatPost } from './chat-summary';

const URL_WITH_KEY = 'https://chat.googleapis.com/v1/spaces/X/messages?key=SECRET&token=SECRET';
const CARD_POST: ChatPost = {
  text: 'Current progress: 1 of 2 daily tasks have been completed.',
  cardsV2: [{ cardId: 'task-progress', card: { header: { title: 'Task progress', subtitle: 's' }, sections: [] } }],
};

/** A fetch that answers each call from `answers` in turn and records what it was sent. */
function fakeFetch(answers: Array<number | Error>) {
  const bodies: Array<Record<string, unknown>> = [];
  const impl = (async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const a = answers[bodies.length - 1];
    if (a instanceof Error) throw a;
    return new Response('{}', { status: a });
  }) as unknown as typeof fetch;
  return { impl, bodies };
}

const named = (name: string) => Object.assign(new Error(name), { name });

test('posted with the card: one request carrying the sentence and the card', async () => {
  const f = fakeFetch([200]);
  assert.deepEqual(await sendChatPost(URL_WITH_KEY, CARD_POST, f.impl), { status: 'posted', withCard: true });
  assert.equal(f.bodies.length, 1);
  assert.ok(f.bodies[0].cardsV2);
  assert.equal(f.bodies[0].text, CARD_POST.text);
});

test('a card refused with 400 is sent ONCE more as the sentence alone (a 400 posted nothing)', async () => {
  const f = fakeFetch([400, 200]);
  assert.deepEqual(await sendChatPost(URL_WITH_KEY, CARD_POST, f.impl), { status: 'posted', withCard: false });
  assert.equal(f.bodies.length, 2);
  assert.deepEqual(f.bodies[1], { text: CARD_POST.text });
});

test('a 400 on the plain re-send is a refusal, and nothing is tried a third time', async () => {
  const f = fakeFetch([400, 400]);
  assert.equal((await sendChatPost(URL_WITH_KEY, CARD_POST, f.impl)).status, 'refused');
  assert.equal(f.bodies.length, 2);
});

test('a timeout is never re-sent: it may have posted', async () => {
  for (const name of ['TimeoutError', 'AbortError']) {
    const f = fakeFetch([named(name)]);
    assert.equal((await sendChatPost(URL_WITH_KEY, CARD_POST, f.impl)).status, 'timed_out', name);
    assert.equal(f.bodies.length, 1);
  }
});

test('a timeout on the plain re-send is still a timeout (it may have posted)', async () => {
  const f = fakeFetch([400, named('TimeoutError')]);
  assert.equal((await sendChatPost(URL_WITH_KEY, CARD_POST, f.impl)).status, 'timed_out');
});

test('every other refusal is final: 403, 404, 429 and 500 are never re-sent', async () => {
  for (const status of [403, 404, 429, 500]) {
    const f = fakeFetch([status]);
    const r = await sendChatPost(URL_WITH_KEY, CARD_POST, f.impl);
    assert.deepEqual(r, { status: 'refused', httpStatus: status, detail: `Google Chat refused the post (HTTP ${status}).` });
    assert.equal(f.bodies.length, 1, String(status));
  }
});

test('a network failure is unreachable and is not re-sent', async () => {
  const f = fakeFetch([new TypeError('fetch failed')]);
  assert.equal((await sendChatPost(URL_WITH_KEY, CARD_POST, f.impl)).status, 'unreachable');
  assert.equal(f.bodies.length, 1);
});

test('a sentence with no card that Google refuses with 400 is not re-sent', async () => {
  const f = fakeFetch([400]);
  assert.equal((await sendChatPost(URL_WITH_KEY, { text: 'No tasks on the board yet.' }, f.impl)).status, 'refused');
  assert.equal(f.bodies.length, 1);
});

test('no outcome ever carries the webhook URL or its key', async () => {
  const cases: Array<Array<number | Error>> = [[200], [400, 200], [400, 400], [404], [named('TimeoutError')], [new TypeError('x')]];
  for (const answers of cases) {
    const r = await sendChatPost(URL_WITH_KEY, CARD_POST, fakeFetch(answers).impl);
    assert.ok(!JSON.stringify(r).includes('SECRET'), JSON.stringify(r));
  }
});

// Source pin: the click and the schedule send ONLY through sendChatPost, so they cannot drift apart again.
test('nothing but chat-webhook.ts calls fetch for the scoreboard Chat post', () => {
  const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), ...p), 'utf8');
  for (const file of ['src/lib/accounting-scoreboard/server.ts', 'src/lib/accounting-scoreboard/scheduled-chat.ts']) {
    const src = read(file);
    assert.ok(src.includes('sendChatPost('), `${file} sends through sendChatPost`);
    assert.ok(!/\bfetch\(/.test(src), `${file} has no fetch( of its own`);
  }
});
