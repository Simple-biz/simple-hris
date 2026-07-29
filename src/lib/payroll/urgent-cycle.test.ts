import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  URGENT_SOURCE_FILE_PREFIX,
  isUrgentSourceFile,
  sundayWeekRange,
  urgentCycleSourceFile,
} from './urgent-cycle';

describe('sundayWeekRange', () => {
  it('buckets a midweek date into its Sun→Sat week', () => {
    assert.deepEqual(sundayWeekRange('2026-07-29'), {
      start: '2026-07-26',
      end: '2026-08-01',
    });
  });

  it('keeps a Sunday as its own week start', () => {
    assert.deepEqual(sundayWeekRange('2026-07-26'), {
      start: '2026-07-26',
      end: '2026-08-01',
    });
  });

  it('keeps a Saturday in the week that began the previous Sunday', () => {
    assert.deepEqual(sundayWeekRange('2026-08-01'), {
      start: '2026-07-26',
      end: '2026-08-01',
    });
  });

  it('spans a year boundary', () => {
    assert.deepEqual(sundayWeekRange('2027-01-01'), {
      start: '2026-12-27',
      end: '2027-01-02',
    });
  });

  it('accepts a full ISO timestamp, reading only the date part', () => {
    assert.deepEqual(sundayWeekRange('2026-07-29T13:45:00.000Z'), {
      start: '2026-07-26',
      end: '2026-08-01',
    });
  });

  it('returns null for unparseable input', () => {
    assert.equal(sundayWeekRange(''), null);
    assert.equal(sundayWeekRange('not-a-date'), null);
    assert.equal(sundayWeekRange('07/29/2026'), null);
  });
});

describe('urgentCycleSourceFile', () => {
  it('names the bucket after the Sun→Sat week the payment was sent', () => {
    assert.equal(urgentCycleSourceFile('2026-07-29'), 'urgent_2026-07-26_to_2026-08-01');
  });

  // The invariant that matters: getDisbursementReportDetail locates an urgent
  // report solely by `sourceFile.startsWith('urgent_')`. A bucket name that
  // fails this is invisible in the report detail view — which is exactly what
  // the old 'mesa_urgent' / 'oneoff_urgent' fallbacks did.
  it('always produces a name the report detail lookup recognizes', () => {
    for (const sent of ['2026-07-29', '2026-07-26', '2027-01-01', '', 'not-a-date', '07/29/2026']) {
      const name = urgentCycleSourceFile(sent);
      assert.equal(
        isUrgentSourceFile(name),
        true,
        `urgentCycleSourceFile(${JSON.stringify(sent)}) = ${JSON.stringify(name)} is not recognized as urgent`,
      );
    }
  });

  it('falls back to a recognizable bucket when the sent date is unusable', () => {
    assert.equal(urgentCycleSourceFile('not-a-date'), `${URGENT_SOURCE_FILE_PREFIX}unbucketed`);
  });
});

describe('isUrgentSourceFile', () => {
  it('rejects a regular Hubstaff payroll cycle', () => {
    assert.equal(
      isUrgentSourceFile('simple-biz_daily_report_2026-07-19_to_2026-07-25.csv'),
      false,
    );
  });

  it('rejects the legacy sentinels that never matched the report lookup', () => {
    assert.equal(isUrgentSourceFile('mesa_urgent'), false);
    assert.equal(isUrgentSourceFile('oneoff_urgent'), false);
  });

  it('rejects null/empty', () => {
    assert.equal(isUrgentSourceFile(null), false);
    assert.equal(isUrgentSourceFile(''), false);
  });
});
