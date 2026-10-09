import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  SLOT_WINDOW_HOURS,
  describeWhen,
  dueChatSlots,
  easternClock,
  hourLabel,
  nextPostAt,
  ordinal,
  postsOnDate,
  slotLabel,
  slotsOn,
  withoutPostedToday,
  type ChatSlot,
  type PostSchedule,
} from './chat-schedule';
import { DEFAULT_POST_TEMPLATE } from './chat-template';
import { addDays } from './week';

const CRON_PATH = '/api/cron/accounting-scoreboard-chat';
const LONG_AGO = '2026-01-01T00:00:00Z';

const post = (over: Partial<PostSchedule> & Pick<PostSchedule, 'id'>): PostSchedule => ({
  label: over.id,
  repeat: 'every_day',
  weekdays: [],
  monthDays: [],
  hour: 9,
  frequencies: ['daily'],
  template: DEFAULT_POST_TEMPLATE,
  paused: false,
  timingChangedAt: LONG_AGO,
  ...over,
});

/** The three posts the migration seeds: Carla's schedule from 2026-10-08, exactly. */
const DAILY = post({ id: 'daily', label: 'Daily', hour: 15, frequencies: ['daily'] });
const WEEKLY = post({ id: 'weekly', label: 'Weekly', repeat: 'weekdays', weekdays: ['wed', 'fri'], hour: 9, frequencies: ['weekly'] });
const MONTHLY = post({ id: 'monthly', label: 'Monthly', repeat: 'month_days', monthDays: [1, 30], hour: 9, frequencies: ['monthly'] });
const SEED = [DAILY, WEEKLY, MONTHLY];

const brief = (slots: ChatSlot[]) => slots.map((s) => `${s.hour}:${s.frequencies.join('+')}`);

test('the Eastern clock follows daylight saving', () => {
  assert.deepEqual(easternClock(new Date('2026-10-08T19:00:00Z')), { date: '2026-10-08', hour: 15, minute: 0 }); // EDT
  assert.deepEqual(easternClock(new Date('2026-12-08T20:00:00Z')), { date: '2026-12-08', hour: 15, minute: 0 }); // EST
  assert.deepEqual(easternClock(new Date('2026-12-08T19:00:00Z')), { date: '2026-12-08', hour: 14, minute: 0 });
  assert.deepEqual(easternClock(new Date('2026-10-09T03:30:00Z')), { date: '2026-10-08', hour: 23, minute: 30 });
  assert.deepEqual(easternClock(new Date('2026-10-09T04:00:00Z')), { date: '2026-10-09', hour: 0, minute: 0 });
});

test('the seeded posts keep Carla schedule: daily at 3 PM every day, weekly on Wednesday and Friday mornings', () => {
  assert.deepEqual(brief(slotsOn('2026-10-08', SEED)), ['15:daily']); // Thursday
  assert.deepEqual(brief(slotsOn('2026-10-07', SEED)), ['9:weekly', '15:daily']); // Wednesday
  assert.deepEqual(brief(slotsOn('2026-10-09', SEED)), ['9:weekly', '15:daily']); // Friday
  assert.deepEqual(brief(slotsOn('2026-10-10', SEED)), ['15:daily']); // Saturday
  assert.deepEqual(brief(slotsOn('2026-10-11', SEED)), ['15:daily']); // Sunday
  assert.deepEqual(brief(slotsOn('2026-10-12', SEED)), ['15:daily']); // Monday
});

test('monthly on the 1st and the 30th, in ONE slot with weekly when they share a morning', () => {
  assert.deepEqual(brief(slotsOn('2026-10-01', SEED)), ['9:monthly', '15:daily']); // Thursday the 1st
  assert.deepEqual(brief(slotsOn('2026-10-30', SEED)), ['9:weekly+monthly', '15:daily']); // Friday the 30th
  assert.deepEqual(brief(slotsOn('2026-07-01', SEED)), ['9:weekly+monthly', '15:daily']); // Wednesday the 1st
  assert.deepEqual(brief(slotsOn('2026-10-31', SEED)), ['15:daily']); // the 31st is not a monthly day
  const morning = slotsOn('2026-10-30', SEED)[0];
  assert.deepEqual(morning.schedules.map((s) => s.id), ['weekly', 'monthly']); // the order given
});

test('a month day past the month end posts on its last day, once', () => {
  assert.equal(postsOnDate(MONTHLY, '2027-02-28'), true);
  assert.equal(postsOnDate(MONTHLY, '2028-02-28'), false); // a leap year
  assert.equal(postsOnDate(MONTHLY, '2028-02-29'), true);
  assert.equal(postsOnDate(MONTHLY, '2026-04-30'), true);
  assert.equal(postsOnDate(MONTHLY, '2026-10-29'), false);
  const lastDay = post({ id: 'end', repeat: 'month_days', monthDays: [31] });
  assert.equal(postsOnDate(lastDay, '2026-04-30'), true);
  assert.equal(postsOnDate(lastDay, '2026-02-28'), true);
  assert.equal(postsOnDate(lastDay, '2026-03-30'), false);
  const crowded = post({ id: 'crowd', repeat: 'month_days', monthDays: [29, 30, 31] });
  assert.deepEqual(brief(slotsOn('2027-02-28', [crowded])), ['9:daily']); // three days fold into one post
});

test('every month has exactly two monthly posts', () => {
  for (let y = 2026; y <= 2028; y++) {
    for (let m = 1; m <= 12; m++) {
      let date = `${y}-${String(m).padStart(2, '0')}-01`;
      let n = 0;
      while (date.slice(5, 7) === String(m).padStart(2, '0')) {
        if (slotsOn(date, [MONTHLY]).length) n++;
        date = addDays(date, 1);
      }
      assert.equal(n, 2, `${y}-${m}`);
    }
  }
});

test('posts at the same hour are one slot: everything they count, in the board order, each once', () => {
  const a = post({ id: 'a', hour: 9, frequencies: ['monthly', 'daily'] });
  const b = post({ id: 'b', hour: 9, frequencies: ['weekly', 'daily'] });
  const c = post({ id: 'c', hour: 17, frequencies: ['quarterly'] });
  const slots = slotsOn('2026-10-09', [a, b, c]);
  assert.deepEqual(brief(slots), ['9:daily+weekly+monthly', '17:quarterly']);
  assert.deepEqual(slots[0].schedules.map((s) => s.id), ['a', 'b']);
});

test('a paused post never goes out', () => {
  assert.deepEqual(brief(slotsOn('2026-10-09', [{ ...DAILY, paused: true }])), []);
  assert.equal(nextPostAt({ ...DAILY, paused: true }, new Date('2026-10-09T12:00:00Z')), null);
});

test('a post never goes out late on the day its timing changed after its hour began', () => {
  // Friday 2026-10-09, EDT: 9:00 AM ET = 13:00Z.
  const at = (iso: string) => slotsOn('2026-10-09', [{ ...WEEKLY, timingChangedAt: iso }]).length;
  assert.equal(at('2026-10-09T12:59:59Z'), 1); // 8:59 AM: before the hour, it goes out
  assert.equal(at('2026-10-09T13:00:00Z'), 0); // 9:00 AM sharp: the hour had begun
  assert.equal(at('2026-10-09T13:15:00Z'), 0); // 9:15 AM: not at 10:00 for 9:00
  assert.equal(slotsOn('2026-10-14', [{ ...WEEKLY, timingChangedAt: '2026-10-09T13:15:00Z' }]).length, 1); // next Wednesday
  // The cron's second call inside the window (10:xx) does not post it either.
  assert.deepEqual(brief(dueChatSlots(new Date('2026-10-09T14:30:00Z'), [{ ...WEEKLY, timingChangedAt: '2026-10-09T13:15:00Z' }])), []);
});

test('a slot is due from its hour for two hours, never before and never after', () => {
  const at = (iso: string) => brief(dueChatSlots(new Date(iso), SEED));
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

test('at most once a day: a post retimed after it went out is dropped from its new slot, a repeat call of the same slot is not', () => {
  const retimed = { ...WEEKLY, hour: 15 };
  const slots = slotsOn('2026-10-09', [DAILY, retimed]); // 15: daily + weekly
  assert.deepEqual(brief(slots), ['15:daily+weekly']);
  const wentOutAt9 = [{ hour: 9, scheduleIds: ['weekly'] }];
  assert.deepEqual(brief(withoutPostedToday(slots, wentOutAt9)), ['15:daily']);
  // The same slot's own claim is left for the claim to answer (already_claimed), never silently dropped.
  assert.deepEqual(brief(withoutPostedToday(slots, [{ hour: 15, scheduleIds: ['daily', 'weekly'] }])), ['15:daily+weekly']);
  // The rows from before Setup → Scheduled Posts carry no posts.
  assert.deepEqual(brief(withoutPostedToday(slots, [{ hour: 9, scheduleIds: null }])), ['15:daily+weekly']);
  // Nothing left: no slot at all.
  assert.deepEqual(withoutPostedToday(slotsOn('2026-10-09', [retimed]), wentOutAt9), []);
});

test('the next post', () => {
  // Friday 2026-10-09 9:30 AM ET: this morning's weekly has passed, the next is Wednesday.
  assert.deepEqual(nextPostAt(WEEKLY, new Date('2026-10-09T13:30:00Z')), { date: '2026-10-14', hour: 9 });
  assert.deepEqual(nextPostAt(DAILY, new Date('2026-10-09T18:00:00Z')), { date: '2026-10-09', hour: 15 }); // 2 PM
  assert.deepEqual(nextPostAt(DAILY, new Date('2026-10-09T19:00:00Z')), { date: '2026-10-10', hour: 15 }); // 3 PM sharp
  assert.deepEqual(nextPostAt(MONTHLY, new Date('2026-10-09T13:30:00Z')), { date: '2026-10-30', hour: 9 });
  assert.deepEqual(nextPostAt(MONTHLY, new Date('2027-02-02T13:30:00Z')), { date: '2027-02-28', hour: 9 });
});

test('how a post is described', () => {
  assert.equal(describeWhen(DAILY), 'Every day at 3:00 PM ET');
  assert.equal(describeWhen(WEEKLY), 'Wednesday and Friday at 9:00 AM ET');
  assert.equal(describeWhen(MONTHLY), 'The 1st and 30th of the month at 9:00 AM ET');
  assert.equal(describeWhen(post({ id: 'w', repeat: 'weekdays', weekdays: ['fri', 'mon', 'wed', 'tue', 'thu'] })), 'Weekdays at 9:00 AM ET');
  assert.equal(describeWhen(post({ id: 'm', repeat: 'weekdays', weekdays: ['mon', 'wed', 'fri'], hour: 0 })), 'Monday, Wednesday and Friday at 12:00 AM ET');
  assert.equal(hourLabel(12), '12:00 PM');
  assert.equal(hourLabel(23), '11:00 PM');
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 31].map(ordinal), ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '31st']);
  assert.equal(slotLabel({ date: '2026-10-07', hour: 9 }), '2026-10-07 09:00 ET');
});

// vercel.json is UTC-only, and on Hobby each entry runs once a day and lands anywhere in its hour. A post may be set to
// any whole Eastern hour, so EVERY hour of every day must have a cron call inside its window, on time and 59 minutes
// late, on both sides of daylight saving.
test('vercel.json reaches every Eastern hour of every day, in EDT and EST, on time and up to 59 minutes late', () => {
  const config = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'vercel.json'), 'utf8')) as {
    crons?: Array<{ path: string; schedule: string }>;
  };
  const crons = config.crons ?? [];
  assert.ok(crons.length <= 100, 'Vercel allows 100 cron jobs per project');
  const hours = crons
    .filter((c) => c.path === CRON_PATH)
    .map((c) => {
      const m = /^0 (\d{1,2}) \* \* \*$/.exec(c.schedule);
      assert.ok(m, `each entry runs once a day at :00 (Hobby-safe): ${c.schedule}`);
      return Number(m[1]);
    });
  assert.deepEqual([...hours].sort((a, b) => a - b), Array.from({ length: 24 }, (_, h) => h), 'one entry per UTC hour');

  for (const lateMin of [0, 59]) {
    const reached = new Set<string>();
    let day = '2025-12-31';
    for (let i = 0; i < 366 * 3 + 2; i++, day = addDays(day, 1)) {
      for (const h of hours) {
        const c = easternClock(new Date(`${day}T${String(h).padStart(2, '0')}:${String(lateMin).padStart(2, '0')}:00Z`));
        for (let slot = c.hour - SLOT_WINDOW_HOURS + 1; slot <= c.hour; slot++) if (slot >= 0) reached.add(`${c.date} ${slot}`);
      }
    }
    let date = '2026-01-01';
    for (let i = 0; i < 366 * 3; i++, date = addDays(date, 1)) {
      for (let hour = 0; hour < 24; hour++) {
        // The spring-forward 2 AM does not exist on the Eastern clock, so nothing can be due in it.
        const twoAmExists = ['06', '07'].some((h) => {
          const c = easternClock(new Date(`${date}T${h}:30:00Z`));
          return c.date === date && c.hour === 2;
        });
        if (hour === 2 && !twoAmExists) continue;
        assert.ok(reached.has(`${date} ${hour}`), `${date} ${hour}:00 ET is reached (+${lateMin} min)`);
      }
    }
  }
});
