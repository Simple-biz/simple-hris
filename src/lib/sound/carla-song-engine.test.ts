import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/**
 * The sign-in song player, driven through a fake <audio> element and fake
 * timers. Each test loads a FRESH copy of the module (the player is a
 * module-level singleton). Failure classes: docs/features/login-carla-song.md
 * § How it can fail.
 */

type Listener = () => void;

class FakeAudio {
  static made: FakeAudio[] = [];
  src: string;
  preload = '';
  volume = 1;
  muted = false;
  /** currentTime at the moment play() was called — proves a resume seeks first. */
  timeAtPlay: number | null = null;
  playCalls = 0;
  private t = 0;
  private listeners = new Map<string, Set<Listener>>();
  private pending: { resolve: () => void; reject: (e: Error) => void } | null = null;

  constructor(src: string) {
    this.src = src;
    FakeAudio.made.push(this);
  }
  get currentTime(): number {
    return this.t;
  }
  set currentTime(v: number) {
    this.t = v;
  }
  addEventListener(type: string, fn: Listener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: Listener): void {
    this.listeners.get(type)?.delete(fn);
  }
  emit(type: string): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn();
  }
  play(): Promise<void> {
    this.playCalls += 1;
    this.timeAtPlay = this.t;
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
    });
  }
  /** Like a browser that lets play() settle on its own after a pause. */
  pause(): void {}
  resolvePlay(): void {
    const p = this.pending;
    this.pending = null;
    p?.resolve();
  }
  rejectPlay(name: string): void {
    const p = this.pending;
    this.pending = null;
    const e = new Error(name);
    e.name = name;
    p?.reject(e);
  }
}

type Player = typeof import('./carla-song');
type Status = ReturnType<Player['getCarlaSongState']>['status'];

const RUN_KEY = 'carla_song_run_v2';
const NOW = 1_000_000_000;

const req = createRequire(import.meta.url);
/** A fresh copy of the player — its state is module-level, so each test drops the cached one. */
function freshPlayer(): Player {
  delete req.cache[req.resolve('./carla-song')];
  return req('./carla-song') as Player;
}

async function setup(t: TestContext, pathname = '/employee') {
  FakeAudio.made = [];
  const store = new Map<string, string>();
  const win = Object.assign(new EventTarget(), { location: { pathname } });
  Object.assign(globalThis, {
    window: win,
    Audio: FakeAudio,
    sessionStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
    },
  });
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: NOW });
  const errors = t.mock.method(console, 'error', () => {});
  const warns = t.mock.method(console, 'warn', () => {});
  const m = freshPlayer();
  const seen: Status[] = [];
  m.subscribeCarlaSong(() => seen.push(m.getCarlaSongState().status));
  const status = () => m.getCarlaSongState().status;
  const pillEverShown = () => seen.some((s) => m.isCarlaSongPillVisible(s));
  const storedRun = () => {
    const raw = store.get(RUN_KEY);
    return raw ? (JSON.parse(raw) as { t0: number; muted: boolean; email: string }) : null;
  };
  return { m, win, store, seen, status, pillEverShown, storedRun, errors, warns };
}

/**
 * Move the fake clock in 50ms steps. A single mock tick never runs a timer
 * that was created during that same tick (the fade's setInterval is created by
 * the fade-start setTimeout), so one big tick would under-run real time.
 */
function advance(t: TestContext, ms: number): void {
  for (let left = ms; left > 0; left -= 50) t.mock.timers.tick(Math.min(50, left));
}

/** Let settled play() promises run their handlers (setImmediate is not mocked). */
const flush = () => new Promise<void>((r) => setImmediate(r));

test('class 1: a pending clip is inert — nothing fetched, no pill, a warning naming the file', async (t) => {
  const { m, pillEverShown, warns, status } = await setup(t);
  const pending = m.SIGNIN_SONGS.find((s) => s.clip.status === 'pending');
  if (!pending) {
    t.skip('no pending rows');
    return;
  }
  m.startCarlaSongIfEligible(pending.email);
  assert.equal(FakeAudio.made.length, 0);
  assert.equal(status(), 'idle');
  assert.equal(pillEverShown(), false);
  assert.equal(warns.mock.callCount(), 1);
  assert.ok(String(warns.mock.calls[0].arguments[0]).includes(pending.clip.src));
});

test('class 2: the pill waits for sound — starting is live but hidden, playing shows it', async (t) => {
  const { m, status } = await setup(t);
  m.startCarlaSongIfEligible('carla@simple.biz');
  assert.equal(status(), 'starting');
  assert.equal(m.isCarlaSongPillVisible(status()), false);
  assert.equal(m.isCarlaSongActive(), true);
  FakeAudio.made[0].resolvePlay();
  await flush();
  assert.equal(status(), 'playing');
  assert.equal(m.isCarlaSongPillVisible(status()), true);
});

test('class 2+3: a clip that fails to load never shows the pill, is logged, and is not reused', async (t) => {
  const { m, status, pillEverShown, errors } = await setup(t);
  m.startCarlaSongIfEligible('carla@simple.biz');
  FakeAudio.made[0].emit('error');
  await flush();
  assert.equal(status(), 'done');
  assert.equal(pillEverShown(), false);
  assert.equal(errors.mock.callCount(), 1);
  assert.match(String(errors.mock.calls[0].arguments[0]), /carla-song\.mp3/);

  m.startCarlaSongIfEligible('carla@simple.biz');
  assert.equal(FakeAudio.made.length, 2, 'a failed element must be rebuilt, not reused');
  FakeAudio.made[1].rejectPlay('NotSupportedError');
  await flush();
  assert.equal(status(), 'done');
  assert.equal(pillEverShown(), false);
  assert.equal(errors.mock.callCount(), 2);

  m.startCarlaSongIfEligible('carla@simple.biz');
  assert.equal(FakeAudio.made.length, 3);
});

test('class 4: stopping while play() is pending stays stopped when it resolves late', async (t) => {
  const { m, status, seen } = await setup(t);
  m.startCarlaSongIfEligible('carla@simple.biz');
  m.stopCarlaSong();
  FakeAudio.made[0].resolvePlay();
  await flush();
  assert.equal(status(), 'done');
  assert.ok(!seen.includes('playing'));
});

test('class 5: a resume seeks BEFORE play() and stops at 0:30 from the original start', async (t) => {
  const { m, store, status } = await setup(t);
  store.set(RUN_KEY, JSON.stringify({ t0: NOW - 10_000, muted: false, email: 'carla@simple.biz' }));
  m.resumeCarlaSongIfPending();
  const a = FakeAudio.made[0];
  assert.equal(a.timeAtPlay, 10);
  a.resolvePlay();
  await flush();
  assert.equal(status(), 'playing');
  advance(t, 19_900); // 29.9s from t0
  assert.equal(status(), 'playing');
  advance(t, 200); // 30.1s
  assert.equal(status(), 'done');
});

test('class 6: a slow load never stretches a resume past 0:30', async (t) => {
  const { m, store, status } = await setup(t);
  store.set(RUN_KEY, JSON.stringify({ t0: NOW - 10_000, muted: false, email: 'carla@simple.biz' }));
  m.resumeCarlaSongIfPending();
  advance(t, 3_000); // 3s to load
  const a = FakeAudio.made[0];
  a.resolvePlay();
  await flush();
  assert.equal(a.currentTime, 13, 're-seeked to where the run is now');
  advance(t, 16_900); // 29.9s from t0
  assert.equal(status(), 'playing');
  advance(t, 200);
  assert.equal(status(), 'done');
});

test('class 6: a slow load never shortens a fresh run — the 30s start when sound does', async (t) => {
  const { m, status, storedRun } = await setup(t);
  m.startCarlaSongIfEligible('carla@simple.biz');
  advance(t, 5_000); // 5s to load
  FakeAudio.made[0].resolvePlay();
  await flush();
  assert.equal(storedRun()?.t0, NOW + 5_000);
  advance(t, 29_900);
  assert.equal(status(), 'playing');
  advance(t, 200);
  assert.equal(status(), 'done');
});

test('class 6: a resume whose window ran out while loading never plays', async (t) => {
  const { m, store, status, seen } = await setup(t);
  store.set(RUN_KEY, JSON.stringify({ t0: NOW - 29_000, muted: false, email: 'carla@simple.biz' }));
  m.resumeCarlaSongIfPending();
  advance(t, 2_000);
  FakeAudio.made[0].resolvePlay();
  await flush();
  assert.equal(status(), 'done');
  assert.ok(!seen.includes('playing'));
});

test('class 7: someone else signing in stops the live run; the same person again is a no-op', async (t) => {
  const { m, status } = await setup(t);
  m.startCarlaSongIfEligible('carla@simple.biz');
  FakeAudio.made[0].resolvePlay();
  await flush();
  m.startCarlaSongIfEligible(' Carla@simple.biz '); // the hand-off firing twice
  assert.equal(status(), 'playing');
  assert.equal(FakeAudio.made[0].playCalls, 1);

  m.startCarlaSongIfEligible('kaner@simple.biz');
  assert.equal(status(), 'done');

  m.startCarlaSongIfEligible('carla@simple.biz');
  FakeAudio.made[0].resolvePlay();
  await flush();
  m.startCarlaSongIfEligible('aliviah@simple.biz');
  assert.equal(status(), 'done', "Carla's song never carries over to Aliviah");
});

test('class 8: the jam bubble treats a starting song as a playing one', async (t) => {
  const { m } = await setup(t);
  assert.equal(m.isCarlaSongActive('starting'), true);
  assert.equal(m.isCarlaSongActive('blocked'), true);
  assert.equal(m.isCarlaSongActive('playing'), true);
  assert.equal(m.isCarlaSongActive('done'), false);
  assert.equal(m.isCarlaSongActive('idle'), false);
  const jam = fs.readFileSync(path.join(process.cwd(), 'src', 'lib', 'sound', 'carla-jam.ts'), 'utf8');
  assert.match(jam, /return isCarlaSongActive\(\);/);
});

test('autoplay refusal shows the tap prompt, and a tap resumes at the anchored offset', async (t) => {
  const { m, win, status } = await setup(t);
  m.startCarlaSongIfEligible('carla@simple.biz');
  FakeAudio.made[0].rejectPlay('NotAllowedError');
  await flush();
  assert.equal(status(), 'blocked');
  assert.equal(m.isCarlaSongPillVisible(status()), true);
  advance(t, 4_000);
  win.dispatchEvent(new Event('pointerdown'));
  const a = FakeAudio.made[0];
  assert.equal(a.playCalls, 2);
  assert.equal(a.timeAtPlay, 4);
  a.resolvePlay();
  await flush();
  assert.equal(status(), 'playing');
});

test('a fresh document on /login never resumes, and drops the stored run', async (t) => {
  const { m, store, storedRun } = await setup(t, '/login');
  store.set(RUN_KEY, JSON.stringify({ t0: NOW - 5_000, muted: false, email: 'carla@simple.biz' }));
  m.resumeCarlaSongIfPending();
  assert.equal(FakeAudio.made.length, 0);
  assert.equal(storedRun(), null);
});

test('a stored run for an unlisted email, or with no email, is never resumed', async (t) => {
  const { m, store, storedRun } = await setup(t);
  store.set(RUN_KEY, JSON.stringify({ t0: NOW - 5_000, muted: false, email: 'kaner@simple.biz' }));
  m.resumeCarlaSongIfPending();
  assert.equal(FakeAudio.made.length, 0);
  assert.equal(storedRun(), null);
  store.set(RUN_KEY, JSON.stringify({ t0: NOW - 5_000, muted: false }));
  m.resumeCarlaSongIfPending();
  assert.equal(FakeAudio.made.length, 0);
});
