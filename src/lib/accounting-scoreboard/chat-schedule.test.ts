import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  AFTERNOON_HOUR,
  MORNING_HOUR,
  dueChatSlots,
  easternClock,
  isMonthlyPostDay,
  slotLabel,
  slotsOn,
  type ChatSlot,
} from './chat-schedule';
import { addDays } from './week';

const CRON_PATH = '/api/cron/accounting-scoreboard-chat';
const brief = (slots: ChatSlot[]) => slots.map((s) => `${s.hour}:${s.frequencies.join('+')}`);

test('the Eastern clock follows daylight saving', () => {
  assert.deepEqual(easternClock(new Date('2026-10-08T19:00:00Z')), { date: '2026-10-08', hour: 15, minute: 0 }); // EDT
  assert.deepEqual(easternClock(new Date('2026-12-08T20:00:00Z')), { date: '2026-12-08', hour: 15, minute: 0 }); // EST
  assert.deepEqual(easternClock(new Date('2026-12-08T19:00:00Z')), { date: '2026-12-08', hour: 14, minute: 0 });
  assert.deepEqual(easternClock(new Date('2026-10-09T03:30:00Z')), { date: '2026-10-08', hour: 23, minute: 30 });
  assert.deepEqual(easternClock(new Date('2026-10-09T04:00:00Z')), { date: '2026-10-09', hour: 0, minute: 0 });
});

test('daily at 3 PM every day, weekends included; weekly on Wednesday and Friday mornings', () => {
  assert.deepEqual(brief(slotsOn('2026-10-08')), ['15:daily']); // Thursday
  assert.deepEqual(brief(slotsOn('2026-10-07')), ['9:weekly', '15:daily']); // Wednesday
  assert.deepEqual(brief(slotsOn('2026-10-09')), ['9:weekly', '15:daily']); // Friday
  assert.deepEqual(brief(slotsOn('2026-10-10')), ['15:daily']); // Saturday
  assert.deepEqual(brief(slotsOn('2026-10-11')), ['15:daily']); // Sunday
  assert.deepEqual(brief(slotsOn('2026-10-12')), ['15:daily']); // Monday
});

test('monthly on the 1st and the 30th, in one message with weekly when they share a morning', () => {
  assert.deepEqual(brief(slotsOn('2026-10-01')), ['9:monthly', '15:daily']); // Thursday the 1st
  assert.deepEqual(brief(slotsOn('2026-10-30')), ['9:weekly+monthly', '15:daily']); // Friday the 30th
  assert.deepEqual(brief(slotsOn('2026-07-01')), ['9:weekly+monthly', '15:daily']); // Wednesday the 1st
  assert.deepEqual(brief(slotsOn('2026-10-31')), ['15:daily']); // the 31st is not a monthly day
  assert.equal(isMonthlyPostDay('2026-04-30'), true); // a 30-day month: the 30th is its last day
  assert.equal(isMonthlyPostDay('2026-10-29'), false);
});

test('February has no 30th: its second monthly post is on its last day', () => {
  assert.equal(isMonthlyPostDay('2027-02-28'), true);
  assert.equal(isMonthlyPostDay('2028-02-28'), false); // a leap year
  assert.equal(isMonthlyPostDay('2028-02-29'), true);
  assert.equal(isMonthlyPostDay('2026-03-01'), true);
});

test('every month has exactly two monthly posts', () => {
  for (let y = 2026; y <= 2028; y++) {
    for (let m = 1; m <= 12; m++) {
      let date = `${y}-${String(m).padStart(2, '0')}-01`;
      let n = 0;
      while (date.slice(5, 7) === String(m).padStart(2, '0')) {
        if (isMonthlyPostDay(date)) n++;
        date = addDays(date, 1);
      }
      assert.equal(n, 2, `${y}-${m}`);
    }
  }
});

test('only daily, weekly and monthly are ever posted', () => {
  let date = '2026-01-01';
  for (let i = 0; i < 366 * 2; i++, date = addDays(date, 1)) {
    for (const s of slotsOn(date)) {
      assert.ok(s.frequencies.length > 0);
      for (const f of s.frequencies) assert.ok(['daily', 'weekly', 'monthly'].includes(f), f);
    }
  }
});

test('a slot is due from its hour for two hours, never before and never after', () => {
  const at = (iso: string) => brief(dueChatSlots(new Date(iso)));
  // Thursday 2026-10-08, EDT (UTC-4).
  assert.deepEqual(at('2026-10-08T18:59:00Z'), []); // 2:59 PM
  assert.deepEqual(at('2026-10-08T19:00:00Z'), ['15:daily']); // 3:00 PM
  assert.deepEqual(at('2026-10-08T20:59:00Z'), ['15:daily']); // 4:59 PM
  assert.deepEqual(at('2026-10-08T21:00:00Z'), []); // 5:00 PM
  assert.deepEqual(at('2026-10-08T13:00:00Z'), []); // Thursday morning: nothing
  // Wednesday 2026-10-07 morning.
  assert.deepEqual(at('2026-10-07T12:59:00Z'), []); // 8:59 AM
  assert.deepEqual(at('2026-10-07T13:00:00Z'), ['9:weekly']); // 9:00 AM
  assert.deepEqual(at('2026-10-07T14:59:00Z'), ['9:weekly']); // 10:59 AM
  assert.deepEqual(at('2026-10-07T15:00:00Z'), []); // 11:00 AM
  // Wednesday 2026-12-09, EST (UTC-5): 13:00 UTC is 8 AM, 14:00 UTC is 9 AM.
  assert.deepEqual(at('2026-12-09T13:00:00Z'), []);
  assert.deepEqual(at('2026-12-09T14:00:00Z'), ['9:weekly']);
  assert.deepEqual(at('2026-12-09T19:00:00Z'), []); // 2 PM
  assert.deepEqual(at('2026-12-09T20:00:00Z'), ['15:daily']);
});

test('the slot label', () => {
  assert.equal(slotLabel({ date: '2026-10-07', hour: MORNING_HOUR }), '2026-10-07 09:00 ET');
  assert.equal(slotLabel({ date: '2026-10-07', hour: AFTERNOON_HOUR }), '2026-10-07 15:00 ET');
});

// vercel.json is UTC-only. Every slot of every day must have a cron call inside its window, both on time (Pro) and
// 59 minutes late (Hobby lands anywhere in the hour), across both sides of daylight saving.
test('vercel.json reaches every slot of every day, in EDT and EST, on time and up to 59 minutes late', () => {
  const config = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'vercel.json'), 'utf8')) as {
    crons?: Array<{ path: string; schedule: string }>;
  };
  const hours = (config.crons ?? [])
    .filter((c) => c.path === CRON_PATH)
    .map((c) => {
      const m = /^0 (\d{1,2}) \* \* \*$/.exec(c.schedule);
      assert.ok(m, `each entry runs once a day at :00 (Hobby-safe): ${c.schedule}`);
      return Number(m[1]);
    });
  assert.deepEqual(hours.sort((a, b) => a - b), [13, 14, 19, 20]);

  let date = '2026-01-01';
  for (let i = 0; i < 366 * 3; i++, date = addDays(date, 1)) {
    for (const slot of slotsOn(date)) {
      for (const lateMin of [0, 59]) {
        const reached = hours.some((h) => {
          const fired = new Date(`${date}T${String(h).padStart(2, '0')}:${String(lateMin).padStart(2, '0')}:00Z`);
          return dueChatSlots(fired).some((d) => d.date === slot.date && d.hour === slot.hour);
        });
        assert.ok(reached, `${slotLabel(slot)} is reached (+${lateMin} min)`);
      }
    }
  }
});
