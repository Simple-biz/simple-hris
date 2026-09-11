/**
 * The sheet-to-roster resolver.
 *
 * The bug this closes: matching on work_email alone stranded 13 people's gift
 * receipts under an address the roster never looks up, and the tracker rendered
 * them as "Not recorded" — the state that means nobody has assessed this person.
 * A silent failure that reads as its own opposite.
 *
 * The property these protect: the ladder never GUESSES. Every tier is an exact
 * match on an independent field, ambiguity is a refusal rather than a pick, and
 * personal_email is never a matching key because it is not injective on this
 * roster.
 *
 * Run:  npx tsx --test src/lib/gift-tracker/roster-match.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRosterIndex,
  isEmailShaped,
  matchRosterPerson,
  normName,
  normStartDate,
  type RosterPerson,
} from './roster-match';


function person(over: Partial<RosterPerson> = {}): RosterPerson {
  return {
    name: 'Tesalona, Maria Linda "Lenny"',
    workEmail: 'lenny@simple.biz',
    personalEmail: 'marialinda.csc@gmail.com',
    alternateWorkEmails: [],
    startDate: '4/10/23',
    employeeId: null,
    isActive: true,
    ...over,
  };
}

function index(people: RosterPerson[]) {
  return buildRosterIndex(people);
}

function match(people: RosterPerson[], query: Parameters<typeof matchRosterPerson>[1]) {
  return matchRosterPerson(index(people), query);
}

// ── Normalisation ────────────────────────────────────────────────────────────

test('normName drops the go-by nickname and is order-insensitive', () => {
  assert.equal(normName('Tesalona, Maria Linda "Lenny"'), 'linda maria tesalona');
  assert.equal(normName('Maria Linda Tesalona'), 'linda maria tesalona');
  assert.equal(normName('  TESALONA,   maria  linda  '), 'linda maria tesalona');
});

test('normName does not conflate different people', () => {
  assert.notEqual(
    normName('Tesalona, Maria Linda "Lenny"'),
    normName('Tesalona, Isaac John "Isaac"'),
  );
});

test('a middle name present in one source and absent in the other does NOT match', () => {
  // Deliberate: tier 3 must not silently equate "Arem Badajos" with
  // "Arem Jay Badajos". If they are the same person, an email tier should carry
  // it; if nothing does, an unresolved row is the honest outcome.
  assert.notEqual(normName('Badajos, Arem "Arem"'), normName('Badajos, Arem Jay "Arem"'));
});

test('normStartDate agrees across spellings and never enters a timezone', () => {
  // The exact trap: parseStartDate reads the ISO form as UTC midnight and the
  // slash form as LOCAL midnight, so west of UTC these two spellings of one day
  // used to normalise a day apart and tier 3 silently failed.
  assert.equal(normStartDate('4/10/23'), '2023-04-10');
  assert.equal(normStartDate('4/10/2023'), '2023-04-10');
  assert.equal(normStartDate('2023-04-10'), '2023-04-10');
  assert.equal(normStartDate('04/10/2023'), '2023-04-10');
});

test('normStartDate REFUSES a spelling it does not understand rather than guessing', () => {
  assert.equal(normStartDate('not a date'), null);
  assert.equal(normStartDate('10 April 2023'), null);
  assert.equal(normStartDate('2023/04/10'), null);
  assert.equal(normStartDate('13/45/2023'), null);
  assert.equal(normStartDate(null), null);
  assert.equal(normStartDate('  '), null);
});

// ── Tier 1: work email ───────────────────────────────────────────────────────

test('an exact work-email match wins and reports tier 1', () => {
  const r = match([person()], { workEmail: 'LENNY@simple.biz', name: null, startDate: null });
  assert.equal(r.status, 'matched');
  if (r.status !== 'matched') return;
  assert.equal(r.method, 'work_email');
  assert.equal(r.key, 'lenny@simple.biz');
});

// ── Tier 2: alternate work email ─────────────────────────────────────────────

test('the sheet spelling resolves via the alternate work email', () => {
  const r = match(
    [person({ alternateWorkEmails: ['lennyt@simple.biz'] })],
    { workEmail: 'lennyt@simple.biz', name: null, startDate: null },
  );
  assert.equal(r.status, 'matched');
  if (r.status !== 'matched') return;
  assert.equal(r.method, 'alternate_work_email');
  // The stored key is the MASTER LIST's address, never the sheet's.
  assert.equal(r.key, 'lenny@simple.biz');
});

test('an alternate that merely repeats the primary is not treated as corroboration', () => {
  const idx = index([person({ alternateWorkEmails: ['lenny@simple.biz'] })]);
  assert.equal(idx.byAlternateEmail.size, 0);
});

test('one alternate address claimed by TWO master rows is ambiguous, not a pick', () => {
  const r = match(
    [
      person({ workEmail: 'a@simple.biz', alternateWorkEmails: ['shared@simple.biz'] }),
      person({ workEmail: 'b@simple.biz', alternateWorkEmails: ['shared@simple.biz'] }),
    ],
    { workEmail: 'shared@simple.biz', name: null, startDate: null },
  );
  assert.equal(r.status, 'ambiguous');
  if (r.status !== 'ambiguous') return;
  assert.equal(r.method, 'alternate_work_email');
  assert.equal(r.candidates.length, 2);
});

// ── Tier 3: name AND start date ──────────────────────────────────────────────

test('name plus start date resolves the 5 who have no alternate on record', () => {
  const r = match([person()], {
    workEmail: 'lennyt@simple.biz',
    name: 'Tesalona, Maria Linda "Lenny"',
    startDate: '4/10/2023',
  });
  assert.equal(r.status, 'matched');
  if (r.status !== 'matched') return;
  assert.equal(r.method, 'name_and_start_date');
  assert.equal(r.key, 'lenny@simple.biz');
});

test('the same name with a DIFFERENT start date does not match', () => {
  const r = match([person()], {
    workEmail: 'lennyt@simple.biz',
    name: 'Tesalona, Maria Linda "Lenny"',
    startDate: '4/11/2023',
  });
  assert.equal(r.status, 'unmatched');
});

test('the same start date with a different name does not match', () => {
  const r = match([person()], {
    workEmail: 'someoneelse@simple.biz',
    name: 'Tesalona, Isaac John "Isaac"',
    startDate: '4/10/2023',
  });
  assert.equal(r.status, 'unmatched');
});

test('a name alone never matches — start date is required', () => {
  const r = match([person()], {
    workEmail: 'lennyt@simple.biz',
    name: 'Tesalona, Maria Linda "Lenny"',
    startDate: null,
  });
  assert.equal(r.status, 'unmatched');
});

test('a start date alone never matches — one cohort shares it', () => {
  const r = match([person()], {
    workEmail: 'lennyt@simple.biz',
    name: null,
    startDate: '4/10/2023',
  });
  assert.equal(r.status, 'unmatched');
});

test('two people sharing a name AND a start date refuse rather than pick', () => {
  const r = match(
    [
      person({ workEmail: 'first@simple.biz' }),
      person({ workEmail: 'second@simple.biz' }),
    ],
    {
      workEmail: 'lennyt@simple.biz',
      name: 'Tesalona, Maria Linda "Lenny"',
      startDate: '4/10/2023',
    },
  );
  assert.equal(r.status, 'ambiguous');
  if (r.status !== 'ambiguous') return;
  assert.equal(r.method, 'name_and_start_date');
  assert.equal(r.candidates.length, 2);
});

test('a person with no start date is not bucketed into a shared wildcard', () => {
  const idx = index([person({ startDate: null }), person({ workEmail: 'x@simple.biz', startDate: null })]);
  assert.equal(idx.byNameAndStart.size, 0);
});

// ── Personal email is never a key ────────────────────────────────────────────

test('personal_email never resolves a match — it is not injective on this roster', () => {
  // russell@ and johnc@ genuinely share corpuzmachacon@gmail.com in production.
  const r = match(
    [
      person({ workEmail: 'russell@simple.biz', personalEmail: 'shared@gmail.com', name: 'A, One' }),
      person({ workEmail: 'johnc@simple.biz', personalEmail: 'shared@gmail.com', name: 'B, Two' }),
    ],
    { workEmail: 'shared@gmail.com', name: null, startDate: null },
  );
  assert.equal(r.status, 'unmatched');
});

// ── Tier ordering and refusal semantics ──────────────────────────────────────

test('a work-email hit beats an alternate-email hit on a different person', () => {
  const r = match(
    [
      person({ workEmail: 'target@simple.biz', name: 'Right, Person' }),
      person({ workEmail: 'other@simple.biz', alternateWorkEmails: ['target@simple.biz'], name: 'Wrong, Person' }),
    ],
    { workEmail: 'target@simple.biz', name: null, startDate: null },
  );
  assert.equal(r.status, 'matched');
  if (r.status !== 'matched') return;
  assert.equal(r.method, 'work_email');
  assert.equal(r.key, 'target@simple.biz');
});

test('an ambiguous tier STOPS the ladder — it never falls through to a looser one', () => {
  // Two rows claim the alternate address, and a clean name+date match also
  // exists. Falling through would "resolve" it; that is exactly the silent
  // wrong answer this refuses to give.
  const r = match(
    [
      person({ workEmail: 'a@simple.biz', alternateWorkEmails: ['sheet@simple.biz'], name: 'X, One', startDate: '1/1/20' }),
      person({ workEmail: 'b@simple.biz', alternateWorkEmails: ['sheet@simple.biz'], name: 'Y, Two', startDate: '2/2/21' }),
      person({ workEmail: 'c@simple.biz', name: 'Tesalona, Maria Linda "Lenny"', startDate: '4/10/23' }),
    ],
    {
      workEmail: 'sheet@simple.biz',
      name: 'Tesalona, Maria Linda "Lenny"',
      startDate: '4/10/2023',
    },
  );
  assert.equal(r.status, 'ambiguous');
  if (r.status !== 'ambiguous') return;
  assert.equal(r.method, 'alternate_work_email');
});

test('a matched person with no work email is refused, not keyed on the sheet spelling', () => {
  const r = match([person({ workEmail: null, alternateWorkEmails: ['lennyt@simple.biz'] })], {
    workEmail: 'lennyt@simple.biz',
    name: null,
    startDate: null,
  });
  assert.equal(r.status, 'unmatched');
});

test('nothing matching anything is unmatched, never a nearest guess', () => {
  const r = match([person()], {
    workEmail: 'nobody@simple.biz',
    name: 'Nobody, At All',
    startDate: '1/1/2020',
  });
  assert.equal(r.status, 'unmatched');
});

// ── The real production cases ────────────────────────────────────────────────

test('the 13 live orphan shapes all resolve to the master work email', () => {
  const live: Array<[RosterPerson, string]> = [
    [person({ name: 'Allego, Gary "Gary"', workEmail: 'gary@simple.biz', startDate: '2/17/25', alternateWorkEmails: ['garya@simple.biz'] }), 'garya@simple.biz'],
    [person({ name: 'Dacara, Ramil Ordeneza "Ram"', workEmail: 'reid@simple.biz', startDate: '7/29/24', alternateWorkEmails: ['ramd@simple.biz'] }), 'ramd@simple.biz'],
    [person({ name: 'Baldonebro, Joycel "Joy"', workEmail: 'joy@hogansmith.com', startDate: '10/28/24', alternateWorkEmails: ['joyb@simple.biz'] }), 'joyb@simple.biz'],
    // No alternate on record — these rest on tier 3.
    [person({ name: 'Tesalona, Maria Linda "Lenny"', workEmail: 'lenny@simple.biz', startDate: '4/10/23' }), 'lennyt@simple.biz'],
    [person({ name: 'Vergara, Jo Benson "Jo"', workEmail: 'joe@simple.biz', startDate: '12/16/24' }), 'jo@simple.biz'],
  ];
  for (const [p, sheetEmail] of live) {
    const r = match([p], { workEmail: sheetEmail, name: p.name, startDate: p.startDate });
    assert.equal(r.status, 'matched', `${sheetEmail} should resolve`);
    if (r.status !== 'matched') continue;
    assert.equal(r.key, (p.workEmail ?? '').toLowerCase());
  }
});

test("Lenny's sibling on the roster does not capture her row", () => {
  // Both Tesalonas are active. Only the start date separates them at tier 3.
  const lenny = person({ name: 'Tesalona, Maria Linda "Lenny"', workEmail: 'lenny@simple.biz', startDate: '4/10/23' });
  const isaac = person({ name: 'Tesalona, Isaac John "Isaac"', workEmail: 'isaact@simple.biz', startDate: '8/5/24' });
  const r = match([lenny, isaac], {
    workEmail: 'lennyt@simple.biz',
    name: 'Tesalona, Maria Linda "Lenny"',
    startDate: '4/10/2023',
  });
  assert.equal(r.status, 'matched');
  if (r.status !== 'matched') return;
  assert.equal(r.key, 'lenny@simple.biz');
});

// ── employee_id (tier 2) ─────────────────────────────────────────────────────

test('employee_id resolves ahead of the alternate-email and name tiers', () => {
  const r = match([person({ employeeId: '2304-0010' })], {
    workEmail: 'lennyt@simple.biz',
    name: null,
    startDate: null,
    employeeId: '2304-0010',
  });
  assert.equal(r.status, 'matched');
  if (r.status !== 'matched') return;
  assert.equal(r.method, 'employee_id');
  assert.equal(r.key, 'lenny@simple.biz');
});

test('employee_id is compared case- and space-insensitively', () => {
  const r = match([person({ employeeId: '2304-0010' })], {
    workEmail: 'nobody@simple.biz',
    name: null,
    startDate: null,
    employeeId: '  2304-0010  ',
  });
  assert.equal(r.status, 'matched');
});

test('two people sharing an employee_id refuse rather than pick', () => {
  const r = match(
    [
      person({ workEmail: 'a@simple.biz', name: 'A, One', employeeId: 'DUP' }),
      person({ workEmail: 'b@simple.biz', name: 'B, Two', employeeId: 'DUP' }),
    ],
    { workEmail: 'sheet@simple.biz', name: null, startDate: null, employeeId: 'DUP' },
  );
  assert.equal(r.status, 'ambiguous');
  if (r.status !== 'ambiguous') return;
  assert.equal(r.method, 'employee_id');
});

// ── The stale-primary rule ───────────────────────────────────────────────────

test('a tier-1 hit on a NON-ACTIVE row yields to the live row for the same human', () => {
  // teodya@ is a ghost master row; Teody is active at james@, which the ghost
  // lists as its alternate. A work-email-only ladder stops at the ghost.
  const ghost = person({
    name: 'Amaro, Teody',
    workEmail: 'teodya@simple.biz',
    startDate: '6/17/24',
    alternateWorkEmails: ['james@simple.biz'],
    isActive: false,
  });
  const live = person({
    name: 'Amaro, Teody',
    workEmail: 'james@simple.biz',
    startDate: '6/17/24',
    alternateWorkEmails: ['teodya@simple.biz'],
    isActive: true,
  });
  const r = match([ghost, live], {
    workEmail: 'teodya@simple.biz',
    name: 'Amaro, Teody',
    startDate: '6/17/24',
  });
  assert.equal(r.status, 'matched');
  if (r.status !== 'matched') return;
  assert.equal(r.key, 'james@simple.biz');
  assert.equal(r.supersededStaleKey, 'teodya@simple.biz');
});

test('a tier-1 hit on an ACTIVE row is never second-guessed', () => {
  const r = match([person({ isActive: true })], {
    workEmail: 'lenny@simple.biz',
    name: 'Tesalona, Maria Linda "Lenny"',
    startDate: '4/10/23',
  });
  assert.equal(r.status, 'matched');
  if (r.status !== 'matched') return;
  assert.equal(r.method, 'work_email');
  assert.equal(r.supersededStaleKey, undefined);
});

test('a stale row with nobody live elsewhere still resolves to itself', () => {
  // A genuinely offboarded person must keep their own key — this rule exists to
  // find live people behind ghosts, not to strand leavers.
  const r = match([person({ isActive: false })], {
    workEmail: 'lenny@simple.biz',
    name: 'Tesalona, Maria Linda "Lenny"',
    startDate: '4/10/23',
  });
  assert.equal(r.status, 'matched');
  if (r.status !== 'matched') return;
  assert.equal(r.key, 'lenny@simple.biz');
  assert.equal(r.supersededStaleKey, undefined);
});

test('a stale primary with TWO live candidates refuses rather than picking', () => {
  const ghost = person({ name: 'Ghost, Person', workEmail: 'ghost@simple.biz', startDate: '1/1/24', isActive: false });
  const liveA = person({ name: 'A, One', workEmail: 'a@simple.biz', startDate: '1/1/24', alternateWorkEmails: ['ghost@simple.biz'], isActive: true });
  const liveB = person({ name: 'B, Two', workEmail: 'b@simple.biz', startDate: '1/1/24', alternateWorkEmails: ['ghost@simple.biz'], isActive: true });
  const r = match([ghost, liveA, liveB], {
    workEmail: 'ghost@simple.biz',
    name: 'Ghost, Person',
    startDate: '1/1/24',
  });
  assert.equal(r.status, 'ambiguous');
});

// ── Duplicate master rows for ONE human ──────────────────────────────────────

test('two master rows for the same human collapse instead of going ambiguous', () => {
  // teodya@ really has two gml rows, same name and start date, different
  // employee ids. Treating that as two people would refuse a placeable person.
  const a = person({ name: 'Amaro, Teody', workEmail: 'teodya@simple.biz', startDate: '6/17/24', employeeId: '2406-0037', isActive: false });
  const b = person({ name: 'Amaro, Teody', workEmail: 'teodya@simple.biz', startDate: '6/17/24', employeeId: '2406-0002', isActive: false });
  const r = match([a, b], { workEmail: 'teodya@simple.biz', name: 'Amaro, Teody', startDate: '6/17/24' });
  assert.equal(r.status, 'matched');
});

test('the ACTIVE row wins when duplicates for one human collapse', () => {
  const stale = person({ name: 'Dup, Person', workEmail: 'dup@simple.biz', startDate: '1/1/24', isActive: false });
  const live = person({ name: 'Dup, Person', workEmail: 'dup@simple.biz', startDate: '1/1/24', isActive: true });
  const idx = index([stale, live]);
  assert.equal(idx.byWorkEmail.get('dup@simple.biz')?.length, 1);
  assert.equal(idx.byWorkEmail.get('dup@simple.biz')?.[0].isActive, true);
});

test('a RECYCLED address held by two different humans stays ambiguous', () => {
  // josephr@ really was Robles (left) then Ramos (active). Collapsing these
  // would put one man's gift history on another.
  const first = person({ name: 'Robles, Joseph', workEmail: 'josephr@simple.biz', startDate: '3/31/25', isActive: false });
  const second = person({ name: 'Ramos, Joseph Rommel', workEmail: 'josephr@simple.biz', startDate: '6/8/26', isActive: true });
  const r = match([first, second], { workEmail: 'josephr@simple.biz', name: null, startDate: null });
  assert.equal(r.status, 'ambiguous');
  if (r.status !== 'ambiguous') return;
  assert.equal(r.method, 'work_email');
  assert.equal(r.candidates.length, 2);
});

// ── Garbage in the work-email column ─────────────────────────────────────────

test('a work email that is a note, not an address, is refused', () => {
  // global_master_list really holds these two values.
  assert.equal(isEmailShaped('waiting on ppwk'), false);
  assert.equal(isEmailShaped('issues with automation'), false);
  assert.equal(isEmailShaped('a@b'), true);
  assert.equal(isEmailShaped('@b.com'), false);
  assert.equal(isEmailShaped('a@'), false);
  assert.equal(isEmailShaped('a@@b'), false);
  assert.equal(isEmailShaped('a b@c.com'), false);
});

test('a person whose work email is a note is never used as a storage key', () => {
  const r = match(
    [person({ workEmail: 'issues with automation', alternateWorkEmails: [] })],
    {
      workEmail: 'sheet@simple.biz',
      name: 'Tesalona, Maria Linda "Lenny"',
      startDate: '4/10/23',
    },
  );
  assert.equal(r.status, 'unmatched');
});

test('a note in the work-email column never becomes an index bucket', () => {
  const idx = index([person({ workEmail: 'waiting on ppwk' })]);
  assert.equal(idx.byWorkEmail.has('waiting on ppwk'), false);
});

// ── An ambiguous tier falls through to a STRICTER key, never a looser one ────

test('an address held by two DIFFERENT humans is settled by employee_id', () => {
  // jamesc@simple.biz really is Ceballos, James Ryan AND Chan, James Edward.
  const ceballos = person({ name: 'Ceballos, James Ryan "James"', workEmail: 'jamesc@simple.biz', startDate: '1/5/24', employeeId: '2401-0001' });
  const chan = person({ name: 'Chan, James Edward "James"', workEmail: 'jamesc@simple.biz', startDate: '6/3/25', employeeId: '2506-0009' });
  const r = match([ceballos, chan], {
    workEmail: 'jamesc@simple.biz',
    name: 'Ceballos, James Ryan "James"',
    startDate: '1/5/24',
    employeeId: '2401-0001',
  });
  assert.equal(r.status, 'matched');
  if (r.status !== 'matched') return;
  assert.equal(r.method, 'employee_id');
  assert.equal(r.person.name, 'Ceballos, James Ryan "James"');
});

test('two master rows for one person spelled differently are settled by employee_id', () => {
  // kylam@ carries both "Montano" and "Montaño"; normName cannot equate them.
  const a = person({ name: 'Montano, Eunice Marie Kyla "Kyla"', workEmail: 'kylam@simple.biz', startDate: '3/4/24', employeeId: '2403-0007' });
  const b = person({ name: 'Montaño, Eunice Marie Kyla "Kyla"', workEmail: 'kylam@simple.biz', startDate: '3/4/24', employeeId: '2403-0008' });
  const r = match([a, b], {
    workEmail: 'kylam@simple.biz',
    name: 'Montano, Eunice Marie Kyla "Kyla"',
    startDate: '3/4/24',
    employeeId: '2403-0007',
  });
  assert.equal(r.status, 'matched');
  if (r.status !== 'matched') return;
  assert.equal(r.key, 'kylam@simple.biz');
});

test('name AND start date can settle an ambiguous tier when no employee_id exists', () => {
  const a = person({ name: 'Ceballos, James Ryan', workEmail: 'jamesc@simple.biz', startDate: '1/5/24', employeeId: null });
  const b = person({ name: 'Chan, James Edward', workEmail: 'jamesc@simple.biz', startDate: '6/3/25', employeeId: null });
  const r = match([a, b], {
    workEmail: 'jamesc@simple.biz',
    name: 'Chan, James Edward',
    startDate: '6/3/25',
  });
  assert.equal(r.status, 'matched');
  if (r.status !== 'matched') return;
  assert.equal(r.method, 'name_and_start_date');
  assert.equal(r.person.name, 'Chan, James Edward');
});

test('disambiguation NEVER reaches outside the ambiguous candidate set', () => {
  // The employee_id belongs to a third person who is not a candidate for this
  // address. Narrowing must find nobody and the tier must stay refused.
  const a = person({ name: 'A, One', workEmail: 'shared@simple.biz', startDate: '1/1/24', employeeId: 'ID-A' });
  const b = person({ name: 'B, Two', workEmail: 'shared@simple.biz', startDate: '2/2/24', employeeId: 'ID-B' });
  const outsider = person({ name: 'C, Three', workEmail: 'other@simple.biz', startDate: '3/3/24', employeeId: 'ID-C' });
  const r = match([a, b, outsider], {
    workEmail: 'shared@simple.biz',
    name: null,
    startDate: null,
    employeeId: 'ID-C',
  });
  assert.equal(r.status, 'ambiguous');
});

test('an ambiguous tier with nothing to narrow it by stays refused', () => {
  const a = person({ name: 'A, One', workEmail: 'shared@simple.biz', startDate: '1/1/24', employeeId: null });
  const b = person({ name: 'B, Two', workEmail: 'shared@simple.biz', startDate: '2/2/24', employeeId: null });
  const r = match([a, b], { workEmail: 'shared@simple.biz', name: null, startDate: null });
  assert.equal(r.status, 'ambiguous');
  if (r.status !== 'ambiguous') return;
  assert.equal(r.candidates.length, 2);
});

test('an employee_id matching BOTH candidates does not resolve', () => {
  const a = person({ name: 'A, One', workEmail: 'shared@simple.biz', startDate: '1/1/24', employeeId: 'SAME' });
  const b = person({ name: 'B, Two', workEmail: 'shared@simple.biz', startDate: '2/2/24', employeeId: 'SAME' });
  const r = match([a, b], { workEmail: 'shared@simple.biz', name: null, startDate: null, employeeId: 'SAME' });
  assert.equal(r.status, 'ambiguous');
});
