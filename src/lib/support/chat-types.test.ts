import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CHAT_AUTHOR_SIDES,
  CHAT_MESSAGE_MAX,
  CHAT_OPEN_STATUSES,
  CHAT_SESSION_STATUSES,
  CHAT_SESSION_STATUS_LABELS,
  CHAT_SESSION_STATUS_LABELS_AGENT,
  CHAT_SESSION_STATUS_TONE,
  formatChatSessionNo,
  isChatAuthorSide,
  isChatSessionStatus,
  isOpenChatSession,
  needsAnAgent,
} from './chat-types';
import { formatSupportTicketNo } from './types';

/**
 * chat-types.ts is the one vocabulary module for Employee Support live chat,
 * and plan task 7 calls it "pinned by a test". This is that pin.
 *
 * It reads the SQL rather than restating it, the way view-tabs.test.ts reads the
 * role migration. A test that hardcodes the same list twice proves the list
 * equals itself; this one fails when the TABLE and the TYPESCRIPT drift, which
 * is the only failure worth catching here. The drift is otherwise silent: an
 * INSERT with a status the CHECK rejects is a 500 at runtime, and a status the
 * CHECK allows but the union omits is a row nothing can render.
 */

const SQL = readFileSync(
  join(process.cwd(), 'references/sql/create/2026-09-19_employee_support_chat.sql'),
  'utf8',
);

/** Pull the quoted values out of a `check (<col> in ('a', 'b'))` clause. */
function checkValues(column: string): string[] {
  const re = new RegExp(`check\\s*\\(\\s*${column}\\s+in\\s*\\(([^)]*)\\)`, 'i');
  const m = SQL.match(re);
  assert.ok(m, `no \`check (${column} in (...))\` found in the chat migration`);
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

describe('chat-types agrees with the table it describes', () => {
  it('CHAT_SESSION_STATUSES is exactly the status CHECK', () => {
    assert.deepEqual([...CHAT_SESSION_STATUSES].sort(), checkValues('status').sort());
  });

  it('CHAT_AUTHOR_SIDES is exactly the author_side CHECK', () => {
    assert.deepEqual([...CHAT_AUTHOR_SIDES].sort(), checkValues('author_side').sort());
  });

  it('CHAT_OPEN_STATUSES is the set the partial indexes are scoped to', () => {
    // The open reads ride these indexes. If this list grows a status the index
    // predicate does not have, the query silently stops using the index — no
    // error, just a scan that gets slower as the table fills.
    const indexPredicates = [
      ...SQL.matchAll(/where\s+status\s+in\s*\(([^)]*)\)/gi),
    ].map((m) => [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort());

    assert.ok(indexPredicates.length > 0, 'expected at least one partial index on the open statuses');
    for (const predicate of indexPredicates) {
      assert.deepEqual(predicate, [...CHAT_OPEN_STATUSES].sort());
    }
  });

  it('CHAT_MESSAGE_MAX does not exceed the body length CHECK', () => {
    const m = SQL.match(/check\s*\(\s*length\(body\)\s*<=\s*(\d+)\s*\)/i);
    assert.ok(m, 'no body length CHECK found');
    // The composer may stop EARLIER than the database — a refusal the employee
    // can read beats a 500 — but never later, which would be a save that fails
    // after they pressed send.
    assert.ok(
      CHAT_MESSAGE_MAX <= Number(m[1]),
      `CHAT_MESSAGE_MAX ${CHAT_MESSAGE_MAX} exceeds the DB bound ${m[1]}`,
    );
  });
});

describe('the label and tone records are total', () => {
  it('every status has an employee label, an agent label and a tone', () => {
    for (const status of CHAT_SESSION_STATUSES) {
      assert.equal(typeof CHAT_SESSION_STATUS_LABELS[status], 'string');
      assert.equal(typeof CHAT_SESSION_STATUS_LABELS_AGENT[status], 'string');
      assert.ok(CHAT_SESSION_STATUS_TONE[status]);
    }
  });

  it('no label is blank — a missing key renders as empty, not as an error', () => {
    for (const status of CHAT_SESSION_STATUSES) {
      assert.notEqual(CHAT_SESSION_STATUS_LABELS[status].trim(), '');
      assert.notEqual(CHAT_SESSION_STATUS_LABELS_AGENT[status].trim(), '');
    }
  });

  it('the employee never reads the word "abandoned"', () => {
    // Nobody abandoned them. The queue closed and their question became a
    // ticket, which is a promise being kept.
    assert.ok(!/abandon/i.test(CHAT_SESSION_STATUS_LABELS.abandoned));
  });
});

describe('the open-session predicates', () => {
  it('isOpenChatSession is true for exactly the open statuses', () => {
    for (const status of CHAT_SESSION_STATUSES) {
      assert.equal(
        isOpenChatSession(status),
        (CHAT_OPEN_STATUSES as readonly string[]).includes(status),
        status,
      );
    }
  });

  it('needsAnAgent is true only while waiting', () => {
    // A claimed or live session has an agent; ended and abandoned are shut.
    for (const status of CHAT_SESSION_STATUSES) {
      assert.equal(needsAnAgent(status), status === 'waiting', status);
    }
  });
});

describe('the session number cannot be mistaken for a ticket number', () => {
  it('ESC- and ES- never produce the same string for the same number', () => {
    // These two are discussed in the same sentence by the same five people, and
    // a converted chat has BOTH. One prefix would make "did you see 1043?"
    // ambiguous in exactly the conversation where it matters.
    for (const n of [1, 7, 42, 1043, 99999]) {
      assert.notEqual(formatChatSessionNo(n), formatSupportTicketNo(n));
    }
  });

  it('a chat number never parses as a ticket number by prefix', () => {
    // `ES-1043`.startsWith('ES-') is true of `ESC-1043` too if somebody strips
    // the wrong number of characters, so the guard is that ESC- is not ES-
    // followed by a digit.
    assert.match(formatChatSessionNo(1043), /^ESC-\d+$/);
    assert.match(formatSupportTicketNo(1043), /^ES-\d+$/);
    assert.ok(!/^ES-\d/.test(formatChatSessionNo(1043)));
  });

  it('a missing number renders as a placeholder, never as 0 or NaN', () => {
    for (const bad of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      const out = formatChatSessionNo(bad as number | null | undefined);
      assert.ok(!/\d/.test(out), `${String(bad)} produced ${out}`);
    }
  });
});

describe('the type guards refuse everything that is not in the union', () => {
  it('isChatSessionStatus', () => {
    for (const status of CHAT_SESSION_STATUSES) assert.ok(isChatSessionStatus(status));
    for (const bad of ['', 'WAITING', 'open', 'closed', null, undefined, 3, {}]) {
      assert.ok(!isChatSessionStatus(bad), String(bad));
    }
  });

  it('isChatAuthorSide', () => {
    for (const side of CHAT_AUTHOR_SIDES) assert.ok(isChatAuthorSide(side));
    for (const bad of ['', 'staff', 'Agent', null, undefined, 0, []]) {
      assert.ok(!isChatAuthorSide(bad), String(bad));
    }
  });
});
