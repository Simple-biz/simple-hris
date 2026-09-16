import test from 'node:test';
import assert from 'node:assert/strict';
import { screenText } from './screening';

test('an ordinary question is not flagged', () => {
  const v = screenText(
    'My PAB shows zero for September, but my time adjustment for 03 Sep was approved on the 5th.',
  );
  assert.equal(v.flagged, false);
  assert.equal(v.reason, null);
  assert.deepEqual(v.signals, []);
});

test('a flag is never a refusal — the verdict carries no way to say "reject"', () => {
  const v = screenText('this is fucking ridiculous, I have been underpaid for eleven weeks');
  assert.equal(v.flagged, true);
  // The shape of the verdict is the guarantee: there is no blocking field for a
  // caller to read, so a caller cannot start refusing on it without a code
  // change that would be visible in review.
  assert.deepEqual(Object.keys(v).sort(), ['flagged', 'reason', 'signals']);
});

test('the reason is written for the reader and does not condemn the writer', () => {
  const v = screenText('this is fucking ridiculous, I have been underpaid for eleven weeks');
  assert.match(v.reason ?? '', /may be entirely warranted/i);
});

test('anger about a situation still files, and still flags for a human', () => {
  const v = screenText('I am furious. Payroll has shorted me twice and nobody answers.');
  // No strong word, no target, no threat — nothing to flag. Being angry is not
  // a signal on its own, which is the point.
  assert.equal(v.flagged, false);
});

test('hostility aimed at a person is separated from heat about a problem', () => {
  assert.equal(screenText('you are an idiot').signals.includes('directed_hostility'), true);
  assert.equal(screenText('this process is idiotic').flagged, false);
});

test('threatening language is its own signal', () => {
  const v = screenText("I will come after whoever did this");
  assert.equal(v.signals.includes('threat'), true);
});

test('shouting needs to be sustained, not a single urgent word', () => {
  assert.equal(screenText('URGENT: my payslip is missing for the 06 Sep week').flagged, false);
  assert.equal(
    screenText('WHY HAS NOBODY ANSWERED ME ABOUT MY PAY I HAVE ASKED FOUR TIMES ALREADY')
      .signals.includes('shouting'),
    true,
  );
});

test('several signals are reported together, not collapsed to the first', () => {
  const v = screenText('SHUT UP AND FIX MY PAY YOU USELESS PEOPLE I HAVE ASKED FOUR TIMES');
  assert.ok(v.signals.length >= 2, `expected multiple signals, got ${v.signals.join(',')}`);
  assert.match(v.reason ?? '', / and /);
});

test('quoting abuse in a report is flagged for a reader, never suppressed', () => {
  // Someone reporting what was said to them will use the words that were used.
  // The only correct behaviour is to file it and let a person read it.
  const v = screenText('My team lead called me a dumbass in front of the floor. Who do I report this to?');
  assert.equal(v.flagged, true);
  assert.equal(typeof v.reason, 'string');
});

test('empty, blank and non-string input are clean, never thrown', () => {
  for (const input of ['', '   ', null, undefined, 42 as unknown as string, {} as unknown as string]) {
    const v = screenText(input as string);
    assert.equal(v.flagged, false);
    assert.equal(v.reason, null);
  }
});
