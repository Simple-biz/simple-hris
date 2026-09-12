/**
 * The OTP core.
 *
 * These pin the properties that make an emailed code safe to expose on a public
 * page. Each one corresponds to a way this goes wrong in the wild:
 *
 *  - a stored plaintext code turns a database leak into account takeover
 *  - a `===` on the hash leaks the answer through timing, one character at a time
 *  - a throttle that fails OPEN turns any transient DB fault into an email bomb
 *  - trusting a client-supplied email after verification is the salary-redirect
 *    hole (here: the redirect-my-gift hole)
 *  - distinguishing "no such person" from "no live code" makes the endpoint an
 *    employee-directory oracle
 *
 * Run:  npx tsx --test src/lib/otp/otp-core.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CODE_TTL_MS,
  MAX_ATTEMPTS,
  MAX_SENDS_PER_WINDOW,
  SESSION_TTL_MS,
  constantTimeEqualHex,
  generateOtpCode,
  hashCode,
  hashSessionToken,
  issueCode,
  resolveSession,
  verifyCode,
  type OtpStore,
} from './otp-core';

const NOW = Date.parse('2026-09-12T00:00:00Z');
const EMAIL = 'lenny@simple.biz';

interface Row {
  id: string;
  workEmail: string;
  codeHash: string;
  attempts: number;
  expiresAt: string;
  consumedAt: string | null;
  sessionTokenHash: string | null;
  sessionExpiresAt: string | null;
  createdAt: number;
}

/** An in-memory store that behaves like the real table, including its failures. */
function makeStore(opts: { countFails?: boolean; insertFails?: boolean; consumeFails?: boolean } = {}) {
  const rows: Row[] = [];
  let seq = 0;
  const store: OtpStore = {
    async countRecentSends(workEmail, sinceIso) {
      if (opts.countFails) return null;
      const since = Date.parse(sinceIso);
      return rows.filter((r) => r.workEmail === workEmail && r.createdAt >= since).length;
    },
    async insertCode({ workEmail, codeHash, expiresAt, requestIp }) {
      if (opts.insertFails) return false;
      seq += 1;
      rows.push({
        id: `r${seq}`,
        workEmail,
        codeHash,
        attempts: 0,
        expiresAt,
        consumedAt: null,
        sessionTokenHash: null,
        sessionExpiresAt: null,
        createdAt: NOW,
      });
      void requestIp;
      return true;
    },
    async findLiveCode(workEmail) {
      const live = rows.filter((r) => r.workEmail === workEmail && r.consumedAt === null);
      const row = live[live.length - 1];
      return row
        ? { id: row.id, codeHash: row.codeHash, attempts: row.attempts, expiresAt: row.expiresAt }
        : null;
    },
    async recordFailedAttempt(id, attempts, killNowIso) {
      const row = rows.find((r) => r.id === id);
      if (!row) return;
      row.attempts = attempts;
      if (killNowIso) row.expiresAt = killNowIso;
    },
    async consume({ id, consumedAtIso, sessionTokenHash, sessionExpiresAtIso }) {
      if (opts.consumeFails) return false;
      const row = rows.find((r) => r.id === id);
      if (!row) return false;
      row.consumedAt = consumedAtIso;
      row.sessionTokenHash = sessionTokenHash;
      row.sessionExpiresAt = sessionExpiresAtIso;
      return true;
    },
    async findSession(sessionTokenHash) {
      const row = rows.find((r) => r.sessionTokenHash === sessionTokenHash);
      return row
        ? {
            workEmail: row.workEmail,
            consumedAt: row.consumedAt,
            sessionExpiresAt: row.sessionExpiresAt,
          }
        : null;
    },
  };
  return { store, rows };
}

// ── The code itself ──────────────────────────────────────────────────────────

test('a generated code is always six digits, zero-padded', () => {
  for (let i = 0; i < 400; i += 1) assert.match(generateOtpCode(), /^\d{6}$/);
});

test('the plaintext code is NEVER persisted — only a hash that is not the code', () => {
  const { store, rows } = makeStore();
  return issueCode(store, EMAIL, null, NOW).then((code) => {
    assert.ok(code);
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0].codeHash, code);
    assert.match(rows[0].codeHash, /^[0-9a-f]{64}$/);
    assert.ok(!rows[0].codeHash.includes(code!));
  });
});

test('the hash is bound to the email — the same code for another person differs', () => {
  assert.notEqual(hashCode('123456', 'a@simple.biz'), hashCode('123456', 'b@simple.biz'));
});

test('constant-time compare rejects length mismatch and empty input', () => {
  assert.equal(constantTimeEqualHex('', ''), false);
  assert.equal(constantTimeEqualHex('aabb', 'aa'), false);
  assert.equal(constantTimeEqualHex('aabb', 'aabb'), true);
  assert.equal(constantTimeEqualHex('aabb', 'aabc'), false);
});

// ── Throttle ─────────────────────────────────────────────────────────────────

test('the send cap holds at MAX_SENDS_PER_WINDOW', async () => {
  const { store } = makeStore();
  for (let i = 0; i < MAX_SENDS_PER_WINDOW; i += 1) {
    assert.ok(await issueCode(store, EMAIL, null, NOW), `send ${i + 1} should succeed`);
  }
  assert.equal(await issueCode(store, EMAIL, null, NOW), null, 'the next send must be refused');
});

test('the throttle FAILS CLOSED when the count errors', async () => {
  // A null count means "we do not know". Treating it as zero would let any
  // transient database fault be used to email-bomb someone's work inbox.
  const { store } = makeStore({ countFails: true });
  assert.equal(await issueCode(store, EMAIL, null, NOW), null);
});

test('a failed insert yields no code rather than a code nobody can verify', async () => {
  const { store } = makeStore({ insertFails: true });
  assert.equal(await issueCode(store, EMAIL, null, NOW), null);
});

test('the cap is per email — one person cannot exhaust another persons budget', async () => {
  const { store } = makeStore();
  for (let i = 0; i < MAX_SENDS_PER_WINDOW; i += 1) await issueCode(store, EMAIL, null, NOW);
  assert.ok(await issueCode(store, 'someone-else@simple.biz', null, NOW));
});

// ── Verify ───────────────────────────────────────────────────────────────────

test('the right code verifies and mints a session token', async () => {
  const { store } = makeStore();
  const code = (await issueCode(store, EMAIL, null, NOW))!;
  const out = await verifyCode(store, EMAIL, code, NOW);
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.ok(out.sessionToken.length >= 32);
});

test('a wrong code fails and the code survives for another try', async () => {
  const { store } = makeStore();
  const code = (await issueCode(store, EMAIL, null, NOW))!;
  const wrong = code === '000000' ? '111111' : '000000';
  const bad = await verifyCode(store, EMAIL, wrong, NOW);
  assert.equal(bad.ok, false);
  if (bad.ok) return;
  assert.equal(bad.reason, 'invalid');
  assert.equal((await verifyCode(store, EMAIL, code, NOW)).ok, true);
});

test('the code is KILLED after MAX_ATTEMPTS, and the right code no longer works', async () => {
  const { store } = makeStore();
  const code = (await issueCode(store, EMAIL, null, NOW))!;
  const wrong = code === '000000' ? '111111' : '000000';
  let last = await verifyCode(store, EMAIL, wrong, NOW);
  for (let i = 1; i < MAX_ATTEMPTS; i += 1) last = await verifyCode(store, EMAIL, wrong, NOW);
  assert.equal(last.ok, false);
  if (last.ok) return;
  assert.equal(last.reason, 'locked');

  const after = await verifyCode(store, EMAIL, code, NOW + 1);
  assert.equal(after.ok, false, 'a killed code must not verify even with the right digits');
});

test('an expired code is refused', async () => {
  const { store } = makeStore();
  const code = (await issueCode(store, EMAIL, null, NOW))!;
  const out = await verifyCode(store, EMAIL, code, NOW + CODE_TTL_MS + 1);
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.reason, 'expired');
});

test('an email with NO code answers exactly like an expired one (no enumeration)', async () => {
  const { store } = makeStore();
  const nobody = await verifyCode(store, 'ghost@simple.biz', '123456', NOW);
  const code = (await issueCode(store, EMAIL, null, NOW))!;
  const stale = await verifyCode(store, EMAIL, code, NOW + CODE_TTL_MS + 1);
  assert.deepEqual(nobody, stale, 'the two must be indistinguishable to a caller');
});

test('a non-numeric or short code never reaches the hash compare', async () => {
  const { store } = makeStore();
  await issueCode(store, EMAIL, null, NOW);
  for (const junk of ['', '12345', '1234567', 'abcdef', '12 34 56', '  ']) {
    const out = await verifyCode(store, EMAIL, junk, NOW);
    assert.equal(out.ok, false, `${JSON.stringify(junk)} must not verify`);
  }
});

test('a code cannot be replayed once consumed', async () => {
  const { store } = makeStore();
  const code = (await issueCode(store, EMAIL, null, NOW))!;
  assert.equal((await verifyCode(store, EMAIL, code, NOW)).ok, true);
  const replay = await verifyCode(store, EMAIL, code, NOW);
  assert.equal(replay.ok, false, 'the second use must fail');
});

// ── Session ──────────────────────────────────────────────────────────────────

test('the raw session token is never stored — only its hash', async () => {
  const { store, rows } = makeStore();
  const code = (await issueCode(store, EMAIL, null, NOW))!;
  const out = await verifyCode(store, EMAIL, code, NOW);
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(rows[0].sessionTokenHash, hashSessionToken(out.sessionToken));
  assert.notEqual(rows[0].sessionTokenHash, out.sessionToken);
});

test('a session resolves to the email the CODE was minted for, whatever the client says', async () => {
  // The whole point: identity comes from the token, never from a request body.
  const { store } = makeStore();
  const code = (await issueCode(store, EMAIL, null, NOW))!;
  const out = await verifyCode(store, EMAIL, code, NOW);
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(await resolveSession(store, out.sessionToken, NOW), EMAIL);
});

test('an expired session resolves to nobody', async () => {
  const { store } = makeStore();
  const code = (await issueCode(store, EMAIL, null, NOW))!;
  const out = await verifyCode(store, EMAIL, code, NOW);
  if (!out.ok) throw new Error('verify failed');
  assert.equal(await resolveSession(store, out.sessionToken, NOW + SESSION_TTL_MS + 1), null);
});

test('a forged, blank or unknown token resolves to nobody', async () => {
  const { store } = makeStore();
  const code = (await issueCode(store, EMAIL, null, NOW))!;
  await verifyCode(store, EMAIL, code, NOW);
  for (const junk of ['', '   ', 'not-a-token', 'a'.repeat(43)]) {
    assert.equal(await resolveSession(store, junk, NOW), null, `${JSON.stringify(junk)} must not resolve`);
  }
});

test('a failed consume yields no session rather than a half-verified one', async () => {
  const { store } = makeStore({ consumeFails: true });
  const code = (await issueCode(store, EMAIL, null, NOW))!;
  const out = await verifyCode(store, EMAIL, code, NOW);
  assert.equal(out.ok, false);
});
