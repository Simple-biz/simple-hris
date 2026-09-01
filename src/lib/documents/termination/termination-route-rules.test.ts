/** [TERMINATION-DOCS]
 * The generate route's ORDERED decisions, pinned.
 *
 * `npm test` is `node --import tsx --test "src/**\/*.test.ts"`
 * (package.json:13), so a test placed under `app/` would never run. G9 — the
 * guard that the signature is the generating rep's OWN and LIVE, and that the
 * check ORDER is right — therefore had ZERO automated proof: a later edit
 * collapsing the ladder to `if (!signature || sigErr)` turned a service-role
 * outage into a 412 'No saved signature', which the panel answers by
 * force-opening the signature dialog so the rep re-draws a signature they
 * already have, while the real config failure never surfaces. Every assertion
 * below runs the code the route runs.
 *
 * The four G9 cases the contract §5 demands are `ok`, 500, 412-no-row and
 * 412-disabled, each including the exact substrings the UI matches on. The rest
 * pin the other order-sensitive branches (the blanks admission, G2 layer 3, G4's
 * merged-date re-check) plus risk 4 — a rep-filled rate keeps the currency the
 * record holds — and the DDL's agreement with the code's allowlists.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  TERMINATION_CURRENCIES,
  TERMINATION_DEPARTURE_REASONS,
  isTerminationCurrency,
  type TerminationBlankField,
  type TerminationGenerateRequest,
} from './types';
import {
  TERMINATION_FILLED_CURRENCY_KEY_TO_RATE,
  TERMINATION_FILLED_KEY_TO_BLANK,
  TERMINATION_REHIRE_MESSAGE,
  TERMINATION_REQUIRED_FACTS,
  TERMINATION_SIGNATURE_DISABLED_MESSAGE,
  TERMINATION_SIGNATURE_MISSING_MESSAGE,
  TERMINATION_SIGNATURE_READ_FAILED_MESSAGE,
  admitFilledFields,
  admitFilledDay,
  admitFilledReason,
  checkMergedTerminationDates,
  decideTerminationSignatureGate,
  describeMissingRequiredFacts,
  resolveFilledRateCurrency,
  terminationThrownStatus,
} from './termination-route-rules';

const ROUTE_SRC = fs.readFileSync(
  path.resolve(process.cwd(), 'app/api/accounting/documents/termination/route.ts'),
  'utf8',
);
const DOCUMENT_SRC = fs.readFileSync(
  path.resolve(process.cwd(), 'src/lib/documents/termination/termination-document.ts'),
  'utf8',
);
const MIGRATION_SQL = fs.readFileSync(
  path.resolve(process.cwd(), 'references/sql/migrate/2026-08-31_termination_docs.sql'),
  'utf8',
);

/** Source with comments removed, so a rule quoted in prose cannot satisfy — or
 *  break — an assertion about the code. Same helper as
 *  termination-writeback.test.ts. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const ROUTE_CODE = code(ROUTE_SRC);

// ─── G9 · the signature is the generating rep's OWN and LIVE ─────────────────

test("G9: a read failure is a 500 — 'Supabase not configured' is not a revoked signer", () => {
  const out = decideTerminationSignatureGate({ row: null, error: 'Supabase not configured' });
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.rejection.status, 500);
  assert.equal(out.rejection.message, 'Supabase not configured');
  // The inversion this guard exists to prevent: the rep must NOT be steered into
  // re-drawing a signature they already have.
  assert.equal(out.rejection.message.includes('No saved signature'), false);
  assert.equal(out.rejection.message.includes('switched off'), false);
  assert.equal(out.rejection.blocked, null);
});

test('G9: no saved signature is a 412 carrying the substring the panel matches', () => {
  const out = decideTerminationSignatureGate({ row: null, error: null });
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.rejection.status, 412);
  assert.ok(out.rejection.message.includes('No saved signature'));
  assert.equal(out.rejection.message, TERMINATION_SIGNATURE_MISSING_MESSAGE);
});

test("G9: a revoked signature is a 412 carrying 'switched off'", () => {
  const out = decideTerminationSignatureGate({ row: { enabled: false }, error: null });
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.rejection.status, 412);
  assert.ok(out.rejection.message.includes('switched off'));
  assert.equal(out.rejection.message, TERMINATION_SIGNATURE_DISABLED_MESSAGE);
  // Distinct from the missing-row message: the two states get different steers.
  assert.notEqual(TERMINATION_SIGNATURE_DISABLED_MESSAGE, TERMINATION_SIGNATURE_MISSING_MESSAGE);
});

test('G9: a live signature passes', () => {
  assert.deepEqual(decideTerminationSignatureGate({ row: { enabled: true }, error: null }), {
    ok: true,
  });
});

test('G9: the ORDER is error → no row → disabled, and an error always wins', () => {
  // The failure mode: `if (!signature || sigErr)` — or any reorder that reads
  // the row before the error — answers 412 during a service-role outage.
  const bothFaults = decideTerminationSignatureGate({
    row: { enabled: false },
    error: 'connection terminated unexpectedly',
  });
  assert.equal(bothFaults.ok, false);
  if (bothFaults.ok) return;
  assert.equal(bothFaults.rejection.status, 500);
  assert.equal(bothFaults.rejection.message, 'connection terminated unexpectedly');
});

test('G9: an error with no message of its own is STILL a 500, never a 412', () => {
  // `if (err)` is false for '', which would fall through to "no signature" and
  // tell the rep to re-draw. The gate tests `!== null`, so it cannot.
  const out = decideTerminationSignatureGate({ row: null, error: '' });
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.rejection.status, 500);
  assert.equal(out.rejection.message, TERMINATION_SIGNATURE_READ_FAILED_MESSAGE);
  assert.equal(out.rejection.message.includes('No saved signature'), false);
});

test('G9: the catch-block mapping agrees with the two 412 messages', () => {
  // The route catches a message thrown deeper in the stack and re-derives the
  // status by substring. If a message is reworded without this pair, a thrown
  // signature fault silently becomes a 500 and the panel stops steering.
  assert.equal(terminationThrownStatus(TERMINATION_SIGNATURE_MISSING_MESSAGE), 412);
  assert.equal(terminationThrownStatus(TERMINATION_SIGNATURE_DISABLED_MESSAGE), 412);
  assert.equal(terminationThrownStatus('Saved signature is not a valid data URL'), 500);
  assert.equal(terminationThrownStatus('date/time field value out of range'), 500);
  assert.equal(terminationThrownStatus(TERMINATION_SIGNATURE_READ_FAILED_MESSAGE), 500);
});

test('G9: the route loads the signature from the SESSION, calls the gate, and hardcodes no ladder', () => {
  // The three source facts the pure gate cannot prove about its own caller.
  assert.ok(ROUTE_CODE.includes('getDocumentSignature(authz.sessionEmail)'));
  assert.equal(/getDocumentSignature\(\s*body/.test(ROUTE_CODE), false);
  assert.equal(/body\.signature|body\.signed_by|signature:\s*body/.test(ROUTE_CODE), false);
  assert.ok(ROUTE_CODE.includes('decideTerminationSignatureGate(loaded)'));
  // The ladder must not be restated beside the call — two copies drift.
  assert.equal(/if\s*\(\s*sigErr\s*\)/.test(ROUTE_CODE), false);
  assert.equal(/if\s*\(\s*!signature\.enabled\s*\)/.test(ROUTE_CODE), false);
});

test('G9: the renderer takes a REQUIRED signature — a missing one is a type error', () => {
  const params = DOCUMENT_SRC.slice(DOCUMENT_SRC.indexOf('TerminationRenderParams'));
  assert.ok(params.includes('signature: {'));
  assert.equal(params.includes('signature?:'), false);
});

// ─── The blanks admission — a client may only fill a hole the SERVER found ───

const NO_BLANKS: readonly TerminationBlankField[] = [];

test('an unrecognised filled key is refused before any value is read', () => {
  const out = admitFilledFields({ nope: 'x', reason: 'resigned' }, ['reason']);
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.rejection.status, 400);
  assert.equal(out.rejection.message, "'nope' is not a fillable field");
});

test('a key the SERVER did not report blank is refused', () => {
  const out = admitFilledFields({ start_date: '2026-01-05' }, ['reason']);
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.rejection.status, 400);
  assert.equal(
    out.rejection.message,
    'start_date was resolved from the record and cannot be supplied by hand',
  );
});

test('an empty value is not a fill, and a filled field must be in blanks', () => {
  const empty = admitFilledFields({ reason: '', start_date: null, ending_rate: undefined }, NO_BLANKS);
  assert.equal(empty.ok, true);
  if (!empty.ok) return;
  assert.deepEqual(empty.value, []);
});

test('the admitted fields come back in the module order, not the JSON order', () => {
  const out = admitFilledFields(
    { ending_rate: 300, termination_date: '2026-08-18', reason: 'resigned' },
    ['reason', 'termination_date', 'ending_rate'],
  );
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.deepEqual(out.value, ['termination_date', 'reason', 'ending_rate']);
});

// ─── G5 · a rep-typed date is a PRINTED date ──────────────────────────

/** Fixed clock: 2026-08-31, the day this feature was built. */
const DAY_NOW = new Date('2026-08-31T04:00:00.000Z');

test('G5: a rep-supplied day the panel would send is admitted, sanitised', () => {
  const out = admitFilledDay({ label: 'Termination date', raw: '2026-06-03', now: DAY_NOW });
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.value, '2026-06-03');
});

test('G5: the route REFUSES every shape normalizeMasterDate would fabricate', () => {
  // The blocker. `sanitizeOffboardDay(normalizeMasterDate(v))` — the contract's
  // ordering, and all the route used to run — turns each of these into a
  // well-formed PAST day that no sanitizer can distinguish from a real one, so a
  // crafted POST printed a date the record never stated onto a signed letter
  // while the refusal string claimed the value "must be a real calendar day".
  // The right-hand column is what the old pair produced.
  const fabricated: Array<[string, string]> = [
    ['Aug-24', '2001-08-24'],
    ['August 2024', '2024-08-01'],
    ['2024 August', '2024-08-01'],
    ['March2024', '2024-03-01'],
    ['2024?', '2024-01-01'],
    ['2026', '2026-01-01'],
    ['0', '2000-01-01'],
    ['Aug 18', '2001-08-18'],
    ['Feb 30 2026', '2026-03-02'],
  ];
  for (const [raw, wouldHavePrinted] of fabricated) {
    for (const label of ['Termination date', 'Start date']) {
      const out = admitFilledDay({ label, raw, now: DAY_NOW });
      assert.equal(out.ok, false, `${label} accepted ${JSON.stringify(raw)}`);
      if (out.ok) continue;
      assert.equal(out.rejection.status, 400);
      assert.equal(out.rejection.blocked, null);
      assert.equal(
        out.rejection.message.includes(wouldHavePrinted),
        false,
        'the refusal must not echo the fabricated day back as if it were the record',
      );
    }
  }
});

test('G5: an impossible calendar day is refused, not rolled forward', () => {
  // Both outcomes the old path produced: '2026-02-30' passed the shape regex and
  // the sanitizer, then either printed as March 2 or died as
  // `date/time field value out of range` AFTER the storage object was uploaded.
  for (const raw of ['2026-02-30', '2026-04-31', '2025-02-29', '2026-13-05', '2026-00-10']) {
    const out = admitFilledDay({ label: 'Start date', raw, now: DAY_NOW });
    assert.equal(out.ok, false, `${raw} was admitted`);
  }
  // The leap day that DOES exist stays admitted — the check is the calendar, not
  // a blanket suspicion of February.
  const leap = admitFilledDay({ label: 'Start date', raw: '2024-02-29', now: DAY_NOW });
  assert.equal(leap.ok, true);
});

test("G5: the sanitizer's future bound still applies on the POST path", () => {
  // franm@'s real year typo. The panel's DatePicker can emit it and the shape is
  // valid, so only sanitizeOffboardDay refuses it.
  const out = admitFilledDay({ label: 'Termination date', raw: '2027-04-20', now: DAY_NOW });
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.match(out.rejection.message, /not in the future/);
  // One day's grace is the sanitizer's own rule and is not tightened here.
  const tomorrow = admitFilledDay({ label: 'Termination date', raw: '2026-09-01', now: DAY_NOW });
  assert.equal(tomorrow.ok, true);
});

test('G5: a non-ISO shape is refused BEFORE any parser sees it', () => {
  // The panel validates ISO_DAY before submit (TerminationDocsPanel.tsx:283) and
  // feeds the field from a DatePicker, so requiring the same shape server-side
  // costs a real rep nothing. '5/4/2026' is the sheet's format, not the panel's.
  for (const raw of ['5/4/2026', '2026-6-3', '2026-06-03T00:00:00Z', 'n/a', 'TBD', '', '   ']) {
    const out = admitFilledDay({ label: 'Start date', raw, now: DAY_NOW });
    assert.equal(out.ok, false, `${JSON.stringify(raw)} was admitted`);
    if (out.ok) continue;
    assert.equal(out.rejection.status, 400);
  }
  // A missing value is refused too, rather than becoming the string 'undefined'.
  for (const raw of [undefined, null, 20260603, {}]) {
    assert.equal(admitFilledDay({ label: 'Start date', raw, now: DAY_NOW }).ok, false);
  }
});

test('G5: the route validates BOTH supplied dates through the admitter, not the raw pair', () => {
  // The source pin. `sanitizeOffboardDay(normalizeMasterDate(...))` on a
  // rep-supplied value is the hole; it must not come back, and neither date may
  // reach `merged` by any other path.
  assert.equal(
    /sanitizeOffboardDay|normalizeMasterDate/.test(ROUTE_CODE),
    false,
    'the route reached for the raw sanitizer pair again',
  );
  for (const label of ['Termination date', 'Start date']) {
    assert.ok(
      ROUTE_CODE.includes(`admitFilledDay({ label: '${label}'`),
      `${label} no longer goes through the admitter`,
    );
  }
  assert.equal((ROUTE_CODE.match(/admitFilledDay\(/g) ?? []).length, 2);
  // One clock for both, so a request straddling midnight cannot judge the two
  // dates against different "todays".
  assert.match(ROUTE_CODE, /const now = new Date\(\);/);
});

test('a rate currency is refused unless its amount is filled in the same request', () => {
  const alone = admitFilledFields({ starting_rate_currency: 'COP' }, ['starting_rate']);
  assert.equal(alone.ok, false);
  if (alone.ok) return;
  assert.equal(alone.rejection.status, 400);
  assert.equal(
    alone.rejection.message,
    "'starting_rate_currency' cannot be supplied without starting_rate",
  );

  const paired = admitFilledFields({ starting_rate: 225, starting_rate_currency: 'PHP' }, [
    'starting_rate',
  ]);
  assert.equal(paired.ok, true);
  if (!paired.ok) return;
  // The currency is a MODIFIER, not a fill: it must not appear in filled_by_rep.
  assert.deepEqual(paired.value, ['starting_rate']);
});

test('every key of the request type has a home — a new one cannot be silently ignored', () => {
  // The type-level half is `FILLED_KEY_HOMES: Record<keyof filled, …>` in the
  // module; this is the value-level half, so a key added to the type and the map
  // but never wired still shows up here.
  const keys: Array<keyof TerminationGenerateRequest['filled']> = [
    'termination_date',
    'reason',
    'ending_department',
    'start_date',
    'starting_rate',
    'ending_rate',
    'starting_rate_currency',
    'ending_rate_currency',
  ];
  assert.deepEqual(
    [
      ...Object.keys(TERMINATION_FILLED_KEY_TO_BLANK),
      ...Object.keys(TERMINATION_FILLED_CURRENCY_KEY_TO_RATE),
    ].sort(),
    [...keys].sort(),
  );
  for (const key of keys) {
    const out = admitFilledFields({ [key]: 'x' }, []);
    assert.equal(out.ok, false);
    if (out.ok) continue;
    assert.notEqual(
      out.rejection.message,
      `'${key}' is not a fillable field`,
      `${key} is a documented request key and must be recognised`,
    );
  }
});

// ─── G2 layer 3 · a rep-supplied reason ─────────────────────────────────────

test('G2 layer 3: a paused reason is refused in either spelling; a departure passes', () => {
  for (const paused of ['temporary_pause', 'Temporary Pause']) {
    const out = admitFilledReason(paused);
    assert.equal(out.ok, false);
    if (out.ok) continue;
    assert.equal(out.rejection.status, 400);
    assert.equal(out.rejection.message, `'${paused}' is not a termination reason`);
  }
  const good = admitFilledReason('resigned');
  assert.equal(good.ok, true);
  if (!good.ok) return;
  assert.equal(good.value, 'resigned');
});

test('G2 layer 3: a mis-cased or absent reason is refused, never coerced', () => {
  for (const bad of ['Resigned', 'duplicate_cleanup', '', undefined, null, 7]) {
    const out = admitFilledReason(bad);
    assert.equal(out.ok, false, `${String(bad)} must not be admitted`);
  }
});

// ─── Risk 4 · the native currency, carried end to end ───────────────────────

test('risk 4: a rep fill with no stated currency keeps the currency the RECORD holds', () => {
  for (const resolved of TERMINATION_CURRENCIES) {
    const out = resolveFilledRateCurrency({
      label: 'Ending rate',
      supplied: undefined,
      resolved,
    });
    assert.equal(out.ok, true);
    if (!out.ok) continue;
    assert.equal(out.value, resolved);
  }
});

test('risk 4: a COP carrier stays COP — the old hardcoded PHP is gone from the route', () => {
  const out = resolveFilledRateCurrency({ label: 'Ending rate', supplied: 'COP', resolved: 'COP' });
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.value, 'COP');
  // The defect verbatim: `merged.endingRate = { amount, currency: 'PHP', … }`
  // printed ₱320,000.00 for a 320,000 COP salary and stored 'PHP' beside it.
  assert.equal(/currency:\s*'PHP'/.test(ROUTE_CODE), false);
  assert.ok(ROUTE_CODE.includes('resolved: facts.startingRate.currency'));
  assert.ok(ROUTE_CODE.includes('resolved: facts.endingRate.currency'));
});

test('risk 4: a currency outside the union is refused, never defaulted', () => {
  for (const bad of ['EUR', 'php', 'Php', 'PHP ', 1, {}]) {
    const out = resolveFilledRateCurrency({ label: 'Starting rate', supplied: bad, resolved: 'PHP' });
    assert.equal(out.ok, false, `${JSON.stringify(bad)} must not be admitted`);
    if (out.ok) continue;
    assert.equal(out.rejection.status, 400);
    assert.ok(out.rejection.message.includes('is not a currency this document can state'));
  }
});

test('risk 4: a currency that disagrees with the record is a 400 and a reload', () => {
  const out = resolveFilledRateCurrency({
    label: 'Starting rate',
    supplied: 'PHP',
    resolved: 'COP',
  });
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.rejection.status, 400);
  assert.equal(
    out.rejection.message,
    'Starting rate was confirmed in PHP but the record now says COP — reload the facts sheet before generating',
  );
});

test('the currency union has exactly three members, and the guard agrees with it', () => {
  assert.deepEqual([...TERMINATION_CURRENCIES], ['PHP', 'USD', 'COP']);
  for (const c of TERMINATION_CURRENCIES) assert.equal(isTerminationCurrency(c), true);
  for (const c of ['EUR', 'php', '', null, undefined, 0]) {
    assert.equal(isTerminationCurrency(c), false);
  }
});

// ─── G4 · the re-hire guard, on the MERGED dates ─────────────────────────────

test('G4: a termination date equal to the start date is a 409 re-hire refusal', () => {
  const out = checkMergedTerminationDates('2026-08-20', '2026-08-20');
  if (!out) return assert.fail('a same-day start and departure must be refused');
  assert.equal(out.status, 409);
  assert.equal(out.message, TERMINATION_REHIRE_MESSAGE);
  assert.deepEqual(out.blocked, {
    code: 'rehire_after_offboard',
    message: TERMINATION_REHIRE_MESSAGE,
    offDate: '2026-08-20',
    startDate: '2026-08-20',
  });
});

test('G4: before the start date refuses; after it passes; a missing date passes', () => {
  assert.ok(checkMergedTerminationDates('2026-06-15', '2026-07-01'));
  assert.equal(checkMergedTerminationDates('2026-08-01', '2026-07-01'), null);
  assert.equal(checkMergedTerminationDates('2026-08-01', null), null);
  assert.equal(checkMergedTerminationDates(null, '2026-07-01'), null);
  // One day either side of the boundary — the `<=` the DDL restates as
  // `check (start_date is null or termination_date > start_date)`.
  assert.equal(checkMergedTerminationDates('2026-07-02', '2026-07-01'), null);
  assert.ok(checkMergedTerminationDates('2026-06-30', '2026-07-01'));
});

// ─── The NOT NULL facts ─────────────────────────────────────────────────────

test('a still-blank NOT NULL fact is a 400 naming every one of them, in DDL order', () => {
  assert.equal(describeMissingRequiredFacts(['start_date', 'starting_rate']), null);
  const out = describeMissingRequiredFacts(['reason', 'ending_department', 'start_date']);
  if (!out) return assert.fail('a missing NOT NULL fact must be refused');
  assert.equal(out.status, 400);
  assert.equal(out.message, 'Fill in reason, ending_department before generating');
  assert.deepEqual([...TERMINATION_REQUIRED_FACTS], [
    'termination_date',
    'reason',
    'ending_department',
  ]);
});

// ─── The DDL and the code say the same thing ────────────────────────────────

test('the DDL currency CHECK lists exactly TERMINATION_CURRENCIES', () => {
  // Nothing else keeps these in sync: the allowlist is written twice, once in
  // TypeScript and once as a CHECK, and only one of them is what a bad row hits.
  const listed = [...MIGRATION_SQL.matchAll(/_rate_currency\s+in \(([^)]*)\)/g)].map((m) =>
    m[1].split(',').map((v) => v.trim().replace(/^'|'$/g, '')),
  );
  assert.equal(listed.length, 2, 'both rate currencies are constrained');
  for (const set of listed) assert.deepEqual(set, [...TERMINATION_CURRENCIES]);
});

test('the DDL requires a currency whenever a rate is present', () => {
  // D2: the value-only CHECK accepted `starting_rate = 225, currency = null` —
  // money with no unit on a legal document.
  assert.ok(MIGRATION_SQL.includes('termination_documents_currency_present_with_rate'));
  assert.ok(MIGRATION_SQL.includes('starting_rate is null or starting_rate_currency is not null'));
  assert.ok(MIGRATION_SQL.includes('ending_rate   is null or ending_rate_currency   is not null'));
  // The reverse must stay LEGAL: a BLANK rate still records which carrier's
  // currency was consulted, so an equality form would refuse the app's own row.
  // Strip SQL line comments FIRST — this file's own comment names the equality
  // form in order to reject it, and an unstripped scan would read that as code.
  const ddl = MIGRATION_SQL.replace(/^\s*--.*$/gm, '');
  assert.equal(
    /\(starting_rate is null\)\s*=\s*\(starting_rate_currency is null\)/.test(ddl),
    false,
  );
  assert.ok(/starting_rate is null or starting_rate_currency is not null/.test(ddl));
});

test('the DDL reason CHECK lists exactly TERMINATION_DEPARTURE_REASONS (G2, layer 4)', () => {
  const m = MIGRATION_SQL.match(/check \(reason_key in \(([\s\S]*?)\)\)/);
  if (!m) return assert.fail('the reason allowlist CHECK is missing from the migration');
  const listed = m[1]
    .split(',')
    .map((v) => v.trim().replace(/^'|'$/g, ''))
    .filter(Boolean);
  // The pause check comes FIRST: node:assert/strict's deepEqual is
  // `asserts actual is T`, so once `listed` has been proved equal to
  // TERMINATION_DEPARTURE_REASONS it is narrowed to that union and asking it
  // about 'temporary_pause' no longer compiles. Both assertions still run.
  assert.equal(listed.includes('temporary_pause'), false);
  assert.deepEqual(listed, [...TERMINATION_DEPARTURE_REASONS]);
});

test('the PII table enables row level security with no policies (G8 in the database)', () => {
  // The house precedent for a PII-bearing table is
  // references/sql/create/create_screening.sql:96-101 — RLS ENABLED, no
  // policies, because Supabase's default privileges otherwise grant
  // anon/authenticated SELECT and NEXT_PUBLIC_SUPABASE_ANON_KEY ships in the
  // client bundle.
  assert.ok(
    /alter table public\.termination_documents enable row level security;/i.test(MIGRATION_SQL),
  );
  assert.equal(/create policy/i.test(MIGRATION_SQL), false);
});
