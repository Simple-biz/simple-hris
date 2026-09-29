import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import { joinSharedBroadcast, sharedBroadcastListenerCount } from './shared-broadcast';

type Handler = (msg: { payload?: unknown }) => void;

function fakeClient() {
  const opened: string[] = [];
  const removed: string[] = [];
  let handler: Handler | null = null;
  let onState: ((s: string) => void) | null = null;
  const client = {
    channel(topic: string) {
      opened.push(topic);
      const ch = {
        topic,
        on(_type: string, _filter: unknown, h: Handler) {
          handler = h;
          return ch;
        },
        subscribe(cb: (s: string) => void) {
          onState = cb;
          return ch;
        },
      };
      return ch;
    },
    async removeChannel(ch: { topic: string }) {
      removed.push(ch.topic);
      return 'ok';
    },
  };
  return {
    // The real client's types are far wider than the two calls this module makes.
    client: client as unknown as Pick<SupabaseClient, 'channel' | 'removeChannel'>,
    opened,
    removed,
    emit: (payload: unknown) => handler?.({ payload }),
    state: (s: string) => onState?.(s),
  };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

test('two listeners share ONE channel and both hear a message', async () => {
  const f = fakeClient();
  const got: unknown[] = [];
  const a = joinSharedBroadcast('t-share', 'changed', (p) => got.push(['a', p]), () => f.client);
  const b = joinSharedBroadcast('t-share', 'changed', (p) => got.push(['b', p]), () => f.client);
  assert.deepEqual(f.opened, ['t-share']);
  f.emit({ x: 1 });
  assert.deepEqual(got, [['a', { x: 1 }], ['b', { x: 1 }]]);
  a();
  b();
  await tick();
});

test('the first listener leaving does NOT tear the channel down for the rest', async () => {
  const f = fakeClient();
  let heard = 0;
  const a = joinSharedBroadcast('t-leave', 'changed', () => {}, () => f.client);
  const b = joinSharedBroadcast('t-leave', 'changed', () => { heard += 1; }, () => f.client);
  a();
  await tick();
  assert.deepEqual(f.removed, []);
  f.emit({});
  assert.equal(heard, 1);
  b();
  await tick();
  assert.deepEqual(f.removed, ['t-leave']);
  assert.equal(sharedBroadcastListenerCount('t-leave'), 0);
});

test('a RE-subscribe (after a drop) sends every listener a null catch-up; the first subscribe does not', async () => {
  const f = fakeClient();
  const got: unknown[] = [];
  const a = joinSharedBroadcast('t-resub', 'changed', (p) => got.push(p), () => f.client);
  f.state('SUBSCRIBED');
  assert.deepEqual(got, []);
  f.state('CHANNEL_ERROR');
  f.state('SUBSCRIBED');
  assert.deepEqual(got, [null]);
  a();
  await tick();
});

test('leave-then-rejoin in the same tick reuses the channel (StrictMode remount)', async () => {
  const f = fakeClient();
  const a = joinSharedBroadcast('t-remount', 'changed', () => {}, () => f.client);
  a();
  const b = joinSharedBroadcast('t-remount', 'changed', () => {}, () => f.client);
  await tick();
  assert.deepEqual(f.opened, ['t-remount']);
  assert.deepEqual(f.removed, []);
  b();
  await tick();
  assert.deepEqual(f.removed, ['t-remount']);
});

test('joining one topic for a different event is refused loudly', async () => {
  const f = fakeClient();
  const a = joinSharedBroadcast('t-event', 'changed', () => {}, () => f.client);
  assert.throws(() => joinSharedBroadcast('t-event', 'other', () => {}, () => f.client), /already joined/);
  a();
  await tick();
});

test('no client (Supabase unconfigured) is inert and leaves nothing behind', () => {
  const leave = joinSharedBroadcast('t-none', 'changed', () => {}, () => null);
  assert.equal(sharedBroadcastListenerCount('t-none'), 1);
  leave();
  assert.equal(sharedBroadcastListenerCount('t-none'), 0);
});
