/** [TERMINATION-DOCS]
 * The guard→test map, and the two gates that are greps by nature.
 *
 * Contract §7 requires that "guard proofs G1–G9 each have a named test or a grep
 * assertion". Round-1 audit: G9 had NOTHING, several G7 assertions had no owning
 * file, and G8's own stated gate — `grep -rn "termination" app/api/employee/
 * src/lib/documents/requests.ts` must return zero — was written down in the
 * contract and run by nobody. A checkbox nobody can execute is not a proof.
 *
 * So this file is the map itself, mechanically: every guard must be NAMED by the
 * title of at least one test in this directory, and G8's grep runs here as a
 * test that reads the real paths off disk. It also guards the harness that makes
 * the other behavioural files possible — the `server-only` markers it stands in
 * for, and the rule that its stubs never reach production code.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SERVER_ONLY_MODULES } from './test-support/stub-server-modules';

const ROOT = process.cwd();
const DIR = path.resolve(ROOT, 'src/lib/documents/termination');

function featureTestFiles(): string[] {
  return fs.readdirSync(DIR).filter((f) => f.endsWith('.test.ts')).sort();
}

/** Source with comments removed, so a rule quoted in prose can neither satisfy
 *  nor break an assertion about the code. Same helper as
 *  `termination-writeback.test.ts`. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** Every `test('…')` title in the feature's test files, with its file. */
function testTitles(): Array<{ file: string; title: string }> {
  const out: Array<{ file: string; title: string }> = [];
  for (const file of featureTestFiles()) {
    const src = fs.readFileSync(path.join(DIR, file), 'utf8');
    for (const m of src.matchAll(/^test\(\s*(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/gm)) {
      out.push({ file, title: m[2] });
    }
  }
  return out;
}

/** Files under a directory tree, recursively. */
function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

// ── The map ─────────────────────────────────────────────────────────────────

test('every contract guard is NAMED by the title of at least one test in this feature', () => {
  // The contract's own checkbox, made executable. A guard whose tests are
  // deleted, renamed away, or never written fails HERE, with the guard named —
  // instead of being noticed by the next adversarial audit.
  const titles = testTitles();
  assert.ok(titles.length > 100, `only ${titles.length} test titles found — the scan is broken`);
  // This test's OWN title must name no guard: a map that counts itself proves
  // nothing. Every other title in this file is a real gate.
  assert.equal(
    titles.filter((t) => t.file === 'termination-guard-map.test.ts' && /G[1-9]/.test(t.title))
      .every((t) => /^G[89]:/.test(t.title)),
    true,
    'the guard-map file gained a guard-named title that is not one of its own G8/G9 gates',
  );

  const guards = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9'] as const;
  const coverage = new Map<string, string[]>();
  for (const g of guards) {
    const owning = titles.filter((t) => new RegExp(`\\b${g}\\b`).test(t.title));
    coverage.set(g, [...new Set(owning.map((t) => t.file))]);
  }

  const uncovered = guards.filter((g) => (coverage.get(g) ?? []).length === 0);
  assert.deepEqual(
    uncovered,
    [],
    `no test names ${uncovered.join(', ')} — contract §5 requires one per guard`,
  );

  // G1, G3, G7 and G9 are the four the contract marks UNMISSABLE or where the
  // audit found a live breach; each must be named by tests in MORE THAN ONE
  // file, so no single deleted file can take a whole guard's proof with it.
  for (const g of ['G1', 'G3', 'G7', 'G9'] as const) {
    assert.ok(
      (coverage.get(g) ?? []).length >= 2,
      `${g} is proved only in ${(coverage.get(g) ?? []).join(', ')} — one file away from unproved`,
    );
  }
});

test('the behavioural read/write files exist and drive the SERVER modules', () => {
  // The round-1 audit's MAJOR: six server functions — every read and write this
  // feature performs — had zero behavioural tests, and all coverage sat on the
  // extracted pure cores plus source greps. A pure core that is correct proves
  // nothing about the query that feeds it, so the files below are the proof that
  // the queries themselves are still asserted.
  const expected: Array<{ file: string; drives: string }> = [
    { file: 'termination-facts-reads.test.ts', drives: './termination-facts' },
    { file: 'termination-search-reads.test.ts', drives: './termination-search' },
    { file: 'termination-rates-reads.test.ts', drives: './termination-rates' },
    { file: 'termination-log-reads.test.ts', drives: './termination-log' },
    { file: 'termination-writeback-behaviour.test.ts', drives: './termination-writeback' },
  ];
  for (const e of expected) {
    const full = path.join(DIR, e.file);
    assert.ok(fs.existsSync(full), `${e.file} is gone — a server module lost its behavioural tests`);
    const src = fs.readFileSync(full, 'utf8');
    assert.ok(
      src.includes(`await import('${e.drives}')`),
      `${e.file} no longer imports ${e.drives} — it is testing something else`,
    );
    assert.ok(
      src.includes('installTerminationServerStubs()'),
      `${e.file} does not install the resolution hook, so it cannot load a server-only module`,
    );
    assert.ok(
      src.includes('setTestSupabaseClient('),
      `${e.file} never installs a client double — it would run against a real client`,
    );
  }
});

// ── G8: the gate the contract wrote down and nobody ran ─────────────────────

test('G8: nothing under app/api/employee/ or documents/requests.ts mentions termination', () => {
  // The contract's own words: this grep "must return zero matches". The leak
  // proof is that `GET /api/employee/documents` can only ever name the literal
  // `document_requests`, so the single-file edit that breaks it — a `termination`
  // case in the employee route, or a table option threaded into
  // `listDocumentRequests` — leaves tsc clean and every other test green.
  const targets = [
    ...walk(path.resolve(ROOT, 'app/api/employee')),
    path.resolve(ROOT, 'src/lib/documents/requests.ts'),
  ];
  assert.ok(
    targets.length > 5,
    `only ${targets.length} files scanned — app/api/employee/ was not found`,
  );

  const hits: string[] = [];
  for (const file of targets) {
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) continue;
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      if (/termination/i.test(line)) {
        hits.push(`${path.relative(ROOT, file)}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(hits, [], `the employee surface now mentions termination:\n${hits.join('\n')}`);
});

test('G8: listDocumentRequests still takes no table or type option', () => {
  // `TABLE` at requests.ts:32 is the only table name that code path can name,
  // and that literal IS the proof. A `table`/`type` option turns the proof back
  // into a policy.
  const src = fs.readFileSync(path.resolve(ROOT, 'src/lib/documents/requests.ts'), 'utf8');
  const body = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.match(body, /const TABLE = ['"]document_requests['"]/);
  assert.equal(
    /table\s*[?:]\s*string/.test(body),
    false,
    'the employee documents reader accepted a table name',
  );
  // Every `.from(` in that path names TABLE, the bucket const, or a quoted
  // literal — `Array.from(` and the storage bucket are the only other spellings.
  const named = [...body.matchAll(/supabase(?:\.storage)?\.from\(([^)]*)\)/g)].map((m) => m[1].trim());
  const unexpected = named.filter(
    (arg) => !['TABLE', 'DOCUMENT_REQUESTS_BUCKET'].includes(arg) && !/^['"`]/.test(arg),
  );
  assert.deepEqual(
    unexpected,
    [],
    `a variable-named table appeared in the employee documents path: ${unexpected.join(', ')}`,
  );
});

// ── The harness earns its keep without weakening anything ───────────────────

test('every server-only module still declares server-only', () => {
  // The harness resolves `server-only` to an empty module INSIDE A TEST PROCESS,
  // exactly as Next's own alias does for a server bundle. That is only
  // acceptable while the production modules still carry the marker: it is what
  // keeps the service-role client from being bundled toward a browser.
  for (const file of SERVER_ONLY_MODULES) {
    const full = path.join(DIR, file);
    assert.ok(fs.existsSync(full), `${file} is gone`);
    assert.match(
      fs.readFileSync(full, 'utf8'),
      /^import 'server-only';$/m,
      `${file} lost its server-only marker`,
    );
  }
});

test('the test-support stubs are imported by TEST FILES ONLY', () => {
  // A production module importing `./test-support/supabase-server-stub` would
  // replace the real client factory in the shipped app — every read would come
  // back null. Nothing in the feature may reach into the harness.
  const offenders: string[] = [];
  for (const file of fs.readdirSync(DIR)) {
    if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
    const src = fs.readFileSync(path.join(DIR, file), 'utf8');
    if (/test-support/.test(src)) offenders.push(file);
  }
  assert.deepEqual(offenders, [], `production code imports the test harness: ${offenders.join(', ')}`);

  // And the reverse direction: the harness must never build a real client.
  const support = path.join(DIR, 'test-support');
  for (const file of fs.readdirSync(support)) {
    const body = code(fs.readFileSync(path.join(support, file), 'utf8'));
    assert.equal(
      /createClient\(/.test(body),
      false,
      `${file} builds a real Supabase client — a test could reach PRODUCTION data`,
    );
    assert.equal(
      /process\.env|dotenv/.test(body),
      false,
      `${file} reads env — .env.local holds PRODUCTION service-role credentials`,
    );
  }
});

test('no test in this feature can reach a database', () => {
  // `.env.local` is PRODUCTION service-role (CLAUDE.md). The behavioural files
  // are safe because the client factory is REPLACED, not because no credentials
  // happen to be loaded — but a future test that pulled in env or built its own
  // client would quietly cross that line, so this refuses the ingredients.
  // The rule is about what a test can REACH, so it is keyed on imports: a test
  // may legitimately assert on a SCRIPT's own `dotenv.config()` line, and
  // `termination-writeback.test.ts:844` does exactly that.
  for (const file of featureTestFiles()) {
    const body = code(fs.readFileSync(path.join(DIR, file), 'utf8'));
    const clientImports = [...body.matchAll(/^\s*import[^;]*?from\s+['"]([^'"]+)['"]/gm)]
      .map((m) => m[1])
      .filter((spec) => /^dotenv|@supabase\/supabase-js$|\/supabase\/server$/.test(spec));
    assert.deepEqual(
      clientImports,
      [],
      `${file} imports ${clientImports.join(', ')} — a test must never be able to reach production data`,
    );
    assert.equal(
      /createClient\(/.test(body),
      false,
      `${file} builds a Supabase client of its own`,
    );
  }
});

// ── G9: the signer is the SESSION's, on both sides of the wire ──────────────

test("G9: the signature comes from the session — the client cannot name a signer", async () => {
  // `termination-route-rules.test.ts` owns the check LADDER (error → no row →
  // disabled) against the extracted gate. This is the other half of G9, and it
  // spans two files no single test could: the route reads the signature from
  // `authz.sessionEmail` and NEVER from the request, and the panel does not even
  // have a field for one. A body-supplied signer would let a rep sign as someone
  // else on a legal document.
  const route = fs.readFileSync(
    path.resolve(ROOT, 'app/api/accounting/documents/termination/route.ts'),
    'utf8',
  );
  const routeBody = code(route);
  assert.match(routeBody, /getDocumentSignature\(authz\.sessionEmail\)/);
  const calls = [...routeBody.matchAll(/getDocumentSignature\(([^)]*)\)/g)].map((m) => m[1].trim());
  assert.deepEqual(
    [...new Set(calls)],
    ['authz.sessionEmail'],
    `the route loaded a signature from something other than the session: ${calls.join(', ')}`,
  );
  for (const forbidden of ['body.signature', 'body.signed_by', 'body.generated_by']) {
    assert.equal(
      routeBody.includes(forbidden),
      false,
      `the route read ${forbidden} — the signer must be the session's`,
    );
  }
  // The generating rep's own address is what the row and the audit entries carry.
  assert.match(routeBody, /generatedBy: authz\.sessionEmail/);

  const panel = code(
    fs.readFileSync(
      path.resolve(ROOT, 'src/components/accounting/termination-docs/TerminationDocsPanel.tsx'),
      'utf8',
    ),
  );
  // The POST body is pinned by `satisfies TerminationGenerateRequest`, and that
  // type has no signature field — so the assertion here is that the panel never
  // starts sending one under any name.
  const sentBodies = panel
    .split('JSON.stringify({')
    .slice(1)
    .map((chunk) => chunk.slice(0, chunk.indexOf('})')));
  assert.ok(sentBodies.length > 0, 'the panel sends no request body at all');
  for (const forbidden of ['signature', 'signed_by', 'generated_by']) {
    for (const body of sentBodies) {
      assert.equal(
        body.includes(forbidden),
        false,
        `the panel sends ${forbidden} in a request body: ${body.replace(/\s+/g, ' ').trim()}`,
      );
    }
  }
  // And the 412 steer the gate's two messages exist for is still wired up.
  assert.match(panel, /res\.status === 412/);
});
