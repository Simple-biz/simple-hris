import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  buildReportsView,
  normalizeReportNote,
  parseAccountReportsView,
  reportableAccounts,
  staffTrackDisplay,
  validateReportInput,
  type StoredAccountReport,
} from './payout-account-reports';

const fp = (s: string) => `fp(${s})`; // stand-in for the server HMAC

const row = {
  preferred_processor: 'wires',
  preferred_bank_slot: 'primary',
  bank_name: 'BPI',
  account_holder_name: 'Juan Santos',
  account_number: '1234-5678-90',
  alt_bank_name: 'GCash',
  alt_account_number: '09171234567',
  hurupay_email: 'juan@kolan.test',
};

// ── Which accounts can be reported ──────────────────────────────────────────

test('both bank slots are reportable; the PAID one leads and is flagged', () => {
  const a = reportableAccounts(row, 'wires');
  assert.deepEqual(a.map((x) => [x.kind, x.paysHere, x.label]), [
    ['bank_primary', true, 'BPI'],
    ['bank_alternative', false, 'GCash'],
  ]);
  assert.equal(a[0].hint, '••••••7890');
  assert.equal(a[0].fingerprintInput, 'account:1234567890');
});

test('paid from the alternative slot → that one pays here', () => {
  const a = reportableAccounts({ ...row, preferred_bank_slot: 'alternative' }, 'wires');
  assert.deepEqual(a.map((x) => [x.kind, x.paysHere]), [
    ['bank_alternative', true],
    ['bank_primary', false],
  ]);
});

test('a wallet rail adds the paid wallet, and no bank slot pays', () => {
  const a = reportableAccounts(row, 'hurupay');
  assert.deepEqual(a.map((x) => [x.kind, x.paysHere, x.label]), [
    ['wallet', true, 'Kolan'],
    ['bank_primary', false, 'BPI'],
    ['bank_alternative', false, 'GCash'],
  ]);
  assert.equal(a[0].fingerprintInput, 'wallet:juan@kolan.test');
  assert.ok(!a[0].hint.includes('juan@'), 'the wallet is masked');
});

test('the same account in both slots is listed once', () => {
  const a = reportableAccounts({ ...row, alt_bank_name: 'BPI', alt_account_number: '1234567890' }, 'wires');
  assert.equal(a.length, 1);
});

test('no row, or no account, means nothing to report', () => {
  assert.deepEqual(reportableAccounts(null, 'wires'), []);
  assert.deepEqual(reportableAccounts({ bank_name: 'BPI' }, 'wires'), []);
});

// ── Input ───────────────────────────────────────────────────────────────────

test('input: kind and status are closed lists; "other" needs a note', () => {
  assert.equal(validateReportInput({ account_kind: 'card', status: 'closed' }).ok, false);
  assert.equal(validateReportInput({ account_kind: 'bank_primary', status: 'Closed' }).ok, false);
  assert.equal(validateReportInput({ account_kind: 'bank_primary', status: 'other' }).ok, false);
  assert.equal(validateReportInput({ account_kind: 'bank_primary', status: 'other', note: ' x ' }).ok, false);
  const ok = validateReportInput({ account_kind: 'wallet', status: 'frozen', note: '  bank   hold \n since Monday ' });
  assert.deepEqual(ok, { ok: true, kind: 'wallet', status: 'frozen', note: 'bank hold since Monday' });
});

test('a note never keeps a full account number, and is capped', () => {
  assert.equal(normalizeReportNote('new acct 0012 3456 7890 at BDO'), 'new acct ••••7890 at BDO');
  assert.equal(normalizeReportNote('call 09171234567'), 'call ••••4567');
  assert.equal(normalizeReportNote('closed since 2026'), 'closed since 2026', 'a year is not an account');
  assert.equal(normalizeReportNote('x'.repeat(900))?.length, 500);
  assert.equal(normalizeReportNote('   '), null);
  assert.equal(normalizeReportNote(42), null);
});

// ── Matching reports to the current record ──────────────────────────────────

const report = (over: Partial<StoredAccountReport>): StoredAccountReport => ({
  id: 'r1',
  account_kind: 'bank_primary',
  account_fingerprint: fp('account:1234567890'),
  account_hint: '••••••7890',
  account_label: 'BPI',
  status: 'closed',
  note: null,
  reported_at: '2026-10-08T01:00:00Z',
  reported_via: 'employee_dashboard',
  ...over,
});

test('a report attaches to the account it names, and says whether payroll pays it', () => {
  const v = buildReportsView(reportableAccounts(row, 'wires'), [report({})], fp);
  assert.equal(v.accounts[0].report?.status, 'closed');
  assert.equal(v.accounts[0].report?.paysHere, true);
  assert.equal(v.accounts[1].report, null);
  assert.deepEqual(v.staleReports, []);
});

test('a report follows the ACCOUNT when it moves slot', () => {
  const moved = { ...row, account_number: '5550001112', alt_account_number: '1234567890' };
  const v = buildReportsView(reportableAccounts(moved, 'wires'), [report({})], fp);
  const alt = v.accounts.find((a) => a.kind === 'bank_alternative');
  assert.equal(alt?.report?.appliesTo, 'bank_alternative');
  assert.equal(alt?.report?.reportedKind, 'bank_primary');
});

test('a replaced account leaves its report STALE, never attached to the new one', () => {
  const replaced = { ...row, account_number: '5550001112' };
  const v = buildReportsView(reportableAccounts(replaced, 'wires'), [report({})], fp);
  assert.equal(v.accounts.every((a) => a.report === null), true);
  assert.equal(v.staleReports.length, 1);
  assert.equal(v.staleReports[0].appliesTo, null);
  assert.equal(v.staleReports[0].paysHere, false);
});

test('no view ever carries a fingerprint or a full number', () => {
  const v = buildReportsView(reportableAccounts(row, 'hurupay'), [report({})], fp);
  const blob = JSON.stringify(v);
  assert.equal(blob.includes('fp('), false, 'fingerprint leaked');
  assert.equal(blob.includes('1234567890'), false, 'full account leaked');
  assert.equal(blob.includes('juan@kolan.test'), false, 'full wallet leaked');
});

test('a payload round-trips; a malformed one is unavailable, an absent one null', () => {
  const v = buildReportsView(reportableAccounts(row, 'wires'), [report({})], fp);
  assert.deepEqual(parseAccountReportsView(JSON.parse(JSON.stringify(v))), v);
  assert.equal(parseAccountReportsView(undefined), null);
  assert.deepEqual(parseAccountReportsView({ status: 'ok' }), { status: 'unavailable' });
  assert.deepEqual(parseAccountReportsView({ status: 'ok', accounts: [{ kind: 'card' }], staleReports: [] }), { status: 'unavailable' });
});

// ── A report never re-routes pay ────────────────────────────────────────────

const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

test('no report route or the report data layer writes employee_ids', () => {
  const files = [
    'src/lib/supabase/payout-account-reports.ts',
    'app/api/bank-update/report-account/route.ts',
    'app/api/employee/payout-account-reports/route.ts',
    'app/api/payout-account-reports/route.ts',
  ];
  // Negative control: the scan sees a write when one exists.
  const write = /from\(\s*["']employee_ids["']\s*\)[\s\S]{0,80}?\.(update|insert|upsert|delete)\(/;
  assert.match('supabase.from("employee_ids").update(x)', write);
  for (const f of files) {
    const src = stripComments(readFileSync(path.join(process.cwd(), f), 'utf8'));
    assert.doesNotMatch(src, write, `${f} writes employee_ids`);
    assert.doesNotMatch(src, /bank_preferred\s*:/, `${f} names the sending bank in a payload`);
  }
});

// ── Accounting's People → Banking track line (people-bank-card.md §10) ──────

test('staff track line: shown and NAMED on People, never on a reported paid account, never without showTrack', () => {
  const clean = buildReportsView(reportableAccounts(row, 'wires'), [], fp);
  assert.deepEqual(staffTrackDisplay(clean, true), { show: true, accountName: 'BPI ••••••7890' });
  assert.equal(staffTrackDisplay(clean, false).show, false, 'Mark Paid does not pass showTrack');
  const reportedPaid = buildReportsView(reportableAccounts(row, 'wires'), [report({})], fp);
  assert.equal(staffTrackDisplay(reportedPaid, true).show, false, 'a reported paid account is never "no problems on record"');
  const reportedBackup = buildReportsView(
    reportableAccounts(row, 'wires'),
    [report({ account_fingerprint: fp('account:09171234567'), account_kind: 'bank_alternative' })],
    fp,
  );
  assert.equal(staffTrackDisplay(reportedBackup, true).show, true, 'a reported BACKUP does not hide the paid record');
  assert.deepEqual(staffTrackDisplay({ status: 'unavailable' }, true), { show: true, accountName: 'the account on file' });
});

test('both People hosts mount the staff status WITH the track; Mark Paid without', () => {
  const read = (f: string) => readFileSync(path.join(process.cwd(), f), 'utf8');
  for (const f of ['src/components/people/PeopleTab.tsx', 'src/components/people/PeopleBankSearch.tsx']) {
    assert.match(read(f), /<StaffPayoutAccountStatus[^>]*\bshowTrack\b/, `${f} must show the track record`);
  }
  assert.doesNotMatch(read('src/components/payroll-clerk/MarkPaidDialog.tsx'), /<StaffPayoutAccountStatus[^>]*\bshowTrack\b/);
});
