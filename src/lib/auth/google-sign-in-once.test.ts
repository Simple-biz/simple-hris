/**
 * Guard: "Continue with Google" calls next-auth's `signIn('google')` exactly ONCE.
 *
 * `login-google-sso.md` § The click — next-auth v4's client `signIn()` ALWAYS
 * navigates for an OAuth provider: it ignores `redirect: false` and returns
 * `undefined`. The old popup flow read that `undefined` as "no URL" and fired a
 * SECOND `signIn('google')` while the first navigation to Google was in flight.
 * Chrome lets the second call's fetches run; Safari/WebKit cancels them, and
 * next-auth answers a failed `/api/auth/providers` fetch by sending the tab to
 * `/api/auth/error` — which replaces the navigation to Google. Every Safari and
 * every iPhone sign-in ended on "Server error" (reproduced 3/3 in WebKit 26.5
 * against production, 2026-10-09).
 *
 * Two halves:
 *   1. pin the library behavior the rule rests on, so an upgrade that changes it
 *      fails here and sends the next session to the doc instead of to a popup;
 *   2. a source scan: one `signIn('google'` in the whole app, never with
 *      `redirect: false`, and no `window.open` on the login page.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../../..');
const SCAN_DIRS = ['app', 'src', 'components'];
const GOOGLE_SIGN_IN = /signIn\(\s*['"`]google['"`]/g;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      out.push(...sourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

test('next-auth client signIn still navigates for OAuth providers (the rule rests on this)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'node_modules/next-auth/react/index.js'), 'utf8');
  // `if (redirect || !isSupportingReturn) { window.location.href = url; return }` — OAuth is
  // never "supporting return", so `redirect: false` cannot stop the navigation.
  assert.match(src, /isSupportingReturn = isCredentials \|\| isEmail/);
  assert.match(src, /if \(!\(redirect \|\| !isSupportingReturn\)\)/);
});

test("exactly one signIn('google') in the app, on the login page", () => {
  const hits: string[] = [];
  for (const dir of SCAN_DIRS) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    for (const file of sourceFiles(abs)) {
      const text = fs.readFileSync(file, 'utf8');
      const n = text.match(GOOGLE_SIGN_IN)?.length ?? 0;
      for (let i = 0; i < n; i++) hits.push(path.relative(ROOT, file).replace(/\\/g, '/'));
    }
  }
  assert.deepEqual(hits, ['app/login/page.tsx']);
});

test('the Google sign-in never asks for redirect:false and the login page opens no popup', () => {
  const page = fs.readFileSync(path.join(ROOT, 'app/login/page.tsx'), 'utf8');
  const call = page.slice(page.search(GOOGLE_SIGN_IN));
  const args = call.slice(0, call.indexOf(')') + 1);
  assert.doesNotMatch(args, /redirect\s*:\s*false/);
  assert.doesNotMatch(page, /window\.open\(/);
});
