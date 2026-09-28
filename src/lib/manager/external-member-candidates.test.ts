import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  addressesOf,
  externalPickMatches,
  mergeExternalPicks,
  rosterExternalCandidates,
  type RosterPerson,
} from './external-member-candidates';

/* 2026-09-28: cjm@ (granted Client VA AND Lead Gen) could not find rjq@, johnpaulc@ or
 * charlesla@ in the Client VA card's Add External Member picker. The endpoint drops every
 * department she holds; these rules put her own roster back, minus whoever is on the card. */

const rj: RosterPerson = {
  name: 'Quijano, Ronnel Joshua "RJ" ',
  department: 'Lead Gen',
  personal_email: 'ronneljoshuaquijano@gmail.com',
  work_email: 'rjq@simple.biz',
};
const charles: RosterPerson = {
  name: 'Lacorte, Charles Stephen "Charles"',
  department: 'Lead Gen',
  personal_email: 'charles.lacorte07@gmail.com',
  work_email: 'charlesla@simple.biz',
};
const johnPaul: RosterPerson = {
  name: 'Ceredon, John Paul Mateo "John"',
  department: 'Client VA',
  personal_email: 'paulceredon@gmail.com',
  work_email: 'johnpaulc@simple.biz',
};
const onCardVa: RosterPerson = {
  name: 'Santos, Maria',
  department: 'Client VA',
  personal_email: 'maria.santos@gmail.com',
  work_email: 'marias@simple.biz',
  alternate_work_email: 'maria@simple.biz',
};

const NONE: ReadonlySet<string> = new Set();

describe('rosterExternalCandidates', () => {
  it('offers people from the manager’s OTHER departments on this card', () => {
    const picks = rosterExternalCandidates([rj, charles], NONE, NONE);
    assert.deepEqual(
      picks.map((p) => p.work_email),
      ['charlesla@simple.biz', 'rjq@simple.biz'],
    );
    assert.equal(picks[0]!.department, 'Lead Gen');
  });

  it('never offers someone already on the card, under ANY of their addresses', () => {
    // The card keys personal-first; an alternate work address still counts.
    for (const key of ['maria.santos@gmail.com', 'marias@simple.biz', 'maria@simple.biz']) {
      const picks = rosterExternalCandidates([onCardVa, rj], new Set([key]), NONE);
      assert.deepEqual(picks.map((p) => p.work_email), ['rjq@simple.biz'], key);
    }
  });

  it('offers a same-department person the departed guard hid, and flags them', () => {
    // johnpaulc@ is Client VA but not on the Client VA card for 2026-09-20.
    const card = new Set(['maria.santos@gmail.com']);
    const departed = new Set(['johnpaulc@simple.biz', 'paulceredon@gmail.com']);
    const picks = rosterExternalCandidates([onCardVa, johnPaul, rj], card, departed);
    assert.deepEqual(
      picks.map((p) => [p.work_email, p.hiddenThisWeek]),
      [
        ['johnpaulc@simple.biz', true],
        ['rjq@simple.biz', false],
      ],
    );
  });

  it('keeps both addresses so the caller keys personal-first, like every roster row', () => {
    const [p] = rosterExternalCandidates([{ ...rj, personal_email: '  RonnelJoshuaQuijano@Gmail.com ' }], NONE, NONE);
    assert.equal(p!.personal_email, 'ronneljoshuaquijano@gmail.com');
    assert.equal(p!.work_email, 'rjq@simple.biz');
    assert.equal(p!.name, 'Quijano, Ronnel Joshua "RJ"');
  });

  it('offers one human once when the roster holds two rows for them', () => {
    const orphan: RosterPerson = { ...johnPaul, department: 'Lead Gen', name: 'Ceredon, John Paul Mateo' };
    const picks = rosterExternalCandidates([johnPaul, orphan], NONE, NONE);
    assert.equal(picks.length, 1);
  });

  it('skips rows with no name or no address', () => {
    const picks = rosterExternalCandidates(
      [
        { name: '  ', department: 'Lead Gen', personal_email: 'x@gmail.com' },
        { name: 'No Email', department: 'Lead Gen', personal_email: null, work_email: '  ' },
      ],
      NONE,
      NONE,
    );
    assert.deepEqual(picks, []);
  });
});

describe('externalPickMatches', () => {
  const [p] = rosterExternalCandidates([rj], NONE, NONE);

  it('matches what the server’s ?q= matches: name, department, work and personal email', () => {
    for (const q of ['quijano', 'RJ', 'lead gen', 'rjq@simple.biz', 'ronneljoshua', '']) {
      assert.equal(externalPickMatches(p!, q), true, q);
    }
    assert.equal(externalPickMatches(p!, 'lacorte'), false);
  });
});

describe('mergeExternalPicks', () => {
  it('drops server results already on the card', () => {
    // Server rows carry only work + personal (the endpoint returns no alternates).
    const server = rosterExternalCandidates([onCardVa, rj], NONE, NONE);
    for (const key of ['maria.santos@gmail.com', 'marias@simple.biz']) {
      const merged = mergeExternalPicks(server, [], new Set([key]));
      assert.deepEqual(merged.map((p) => p.work_email), ['rjq@simple.biz'], key);
    }
  });

  it('keeps the roster copy of a person both lists hold', () => {
    const roster = rosterExternalCandidates([johnPaul], NONE, new Set(['johnpaulc@simple.biz']));
    const server = rosterExternalCandidates([johnPaul, charles], NONE, NONE);
    const merged = mergeExternalPicks(server, roster, NONE);
    assert.equal(merged.length, 2);
    assert.equal(merged.find((p) => p.work_email === 'johnpaulc@simple.biz')!.hiddenThisWeek, true);
  });

  it('keeps a server result with no email (the picker shows it disabled)', () => {
    const merged = mergeExternalPicks(
      [{ name: 'Nobody', department: 'Sales', work_email: null, personal_email: null }],
      [],
      NONE,
    );
    assert.equal(merged.length, 1);
  });
});

describe('addressesOf', () => {
  it('normalizes and de-duplicates all four address columns', () => {
    assert.deepEqual(
      addressesOf({ personal_email: 'A@x.com', work_email: 'a@x.com ', alternate_work_email: 'b@x.com', alternate_work_email_2: null }),
      ['a@x.com', 'b@x.com'],
    );
  });
});
