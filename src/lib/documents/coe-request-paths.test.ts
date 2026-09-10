/**
 * The Certificate of Engagement is rendered TWICE — as the watermarked draft at
 * request time and re-rendered from live facts at signing — and the two must be
 * the same certificate apart from the signature block. These source scans pin
 * the shape that guarantees it:
 *
 *   • both paths in requests.ts call the SAME resolveCoeFacts and the SAME
 *     renderCoeDocument (no second renderer, no private facts read);
 *   • neither certificate path opts out of the recent-bonus read — the
 *     `recentBonuses: false` escape exists for Penny's profile tool ONLY.
 *
 * Written 2026-09-10 after a signed copy came back without the role and the
 * earned row while its draft had both. That instance was a stale compiled route
 * in the dev server, not code — but it is exactly the regression a future edit
 * to the sign path could reintroduce for real, so the invariant gets a guard.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const REQUESTS = 'src/lib/documents/requests.ts';

/** Every `resolveCoeFacts(` call in a source, with the raw argument list. */
function coeFactsCalls(src: string): string[] {
  const out: string[] = [];
  const re = /resolveCoeFacts\(([^)]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) out.push(m[1].trim());
  return out;
}

test('requests.ts resolves facts exactly twice — request and signing — through the one resolver', () => {
  const src = read(REQUESTS);
  const calls = coeFactsCalls(src);
  assert.equal(calls.length, 2, `expected the create + sign calls, found ${calls.length}: ${JSON.stringify(calls)}`);
  for (const args of calls) {
    // One argument each: the email. A second argument is where an opt-out would
    // hide, and a certificate must never be rendered from partial facts.
    assert.equal(args.split(',').length, 1, `resolveCoeFacts(${args}) passes options on a certificate path`);
  }
});

test('requests.ts renders through renderCoeDocument on both paths and nothing else draws a certificate', () => {
  const src = read(REQUESTS);
  const renders = src.match(/renderCoeDocument\(/g) ?? [];
  assert.equal(renders.length, 2, `expected the draft + signed renders, found ${renders.length}`);
  // The signed render must carry a signature and the draft must not — that is
  // the ONLY difference the two calls are allowed to have.
  const signIdx = src.indexOf('signature: {\n          dataUrl: signature.image_data_url');
  assert.ok(signIdx > 0, 'the signing render passes the approver signature into the certificate block');
  // No second module renders a COE.
  const others = walk(path.join(ROOT, 'src'))
    .concat(walk(path.join(ROOT, 'app')))
    .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f))
    .filter((f) => !f.endsWith(path.normalize(REQUESTS)) && !f.endsWith(path.normalize('src/lib/documents/coe-document.ts')))
    .filter((f) => /renderCoeDocument\(/.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(others.map((f) => path.relative(ROOT, f)), [], 'only requests.ts may render a Certificate of Engagement');
});

test('the recent-bonus opt-out is used by Penny\'s profile tool and nowhere else', () => {
  const hits = walk(path.join(ROOT, 'src'))
    .concat(walk(path.join(ROOT, 'app')))
    .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f))
    .filter((f) => /recentBonuses:\s*false/.test(fs.readFileSync(f, 'utf8')))
    .map((f) => path.relative(ROOT, f).replace(/\\/g, '/'));
  assert.deepEqual(hits, ['src/lib/anthropic/employee-tools.ts']);
});

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}
