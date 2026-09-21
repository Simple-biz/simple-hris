import test from 'node:test';
import assert from 'node:assert/strict';
import {
  staffReplyRecipient,
  employeeReplyRecipient,
  ticketFiledRecipient,
} from './recipients';
import type { SupportCategory, SupportStatus } from './types';

const EMPLOYEE = 'mariac@simple.biz';
const STAFFER = 'carla@simple.biz';

test('a staff reply always reaches the employee who asked', () => {
  assert.equal(staffReplyRecipient({ work_email: EMPLOYEE, claimed_by: STAFFER }), EMPLOYEE);
  assert.equal(staffReplyRecipient({ work_email: EMPLOYEE, claimed_by: null }), EMPLOYEE);
});

test('an employee reply reaches the staffer holding the ticket', () => {
  assert.equal(employeeReplyRecipient({ work_email: EMPLOYEE, claimed_by: STAFFER }), STAFFER);
});

test('an employee reply on an unclaimed ticket emails nobody', () => {
  // Deliberate: the staff section's "needs reply" filter already surfaces it.
  // Widening this to all five answerers is the thing not to do.
  assert.equal(employeeReplyRecipient({ work_email: EMPLOYEE, claimed_by: null }), null);
});

test('a missing support inbox sends nothing rather than an empty To', () => {
  assert.equal(ticketFiledRecipient(null), null);
  assert.equal(ticketFiledRecipient(undefined), null);
  assert.equal(ticketFiledRecipient(''), null);
  assert.equal(ticketFiledRecipient('   '), null);
});

test('a configured support inbox is used as given, normalised', () => {
  assert.equal(ticketFiledRecipient('  Support@Simple.biz '), 'support@simple.biz');
});

test('every function returns null rather than an empty string', () => {
  // The Gmail node is stop-on-error: an empty To fails the whole run instead of
  // skipping one message. Null is the contract; '' is the incident.
  const blanks = [null, undefined, '', '   '];
  for (const b of blanks) {
    assert.equal(staffReplyRecipient({ work_email: b as string, claimed_by: STAFFER }), null);
    assert.equal(employeeReplyRecipient({ work_email: EMPLOYEE, claimed_by: b as string }), null);
    assert.equal(ticketFiledRecipient(b as string), null);
  }
});

test('casing and whitespace never decide who gets mailed', () => {
  assert.equal(
    staffReplyRecipient({ work_email: '  MariaC@Simple.BIZ ', claimed_by: null }),
    EMPLOYEE,
  );
  assert.equal(
    employeeReplyRecipient({ work_email: EMPLOYEE, claimed_by: ' CARLA@simple.biz' }),
    STAFFER,
  );
});

// ── The ticket side: the same three answers, from a ticket row ───────────────
// Kane, 2026-09-21: the Employee dashboard's Help button opens on Chat Support
// or Raise a ticket. The chat already resolves its recipients through this
// module (app/api/support/chat/[id]/messages/route.ts:261, :532). The ticket
// routes must get the same answers from the same functions, so these run every
// rule against a row shaped exactly like employee_support_tickets
// (references/sql/create/2026-09-16_employee_support.sql:39-145). A superset of
// SupportTicketParties is the contract; this is what proves the DDL is one.

type TicketRow = {
  id: string;
  ticket_no: number;
  work_email: string;
  filed_by_email: string;
  member_name: string | null;
  department: string | null;
  category: SupportCategory;
  concern: string;
  status: SupportStatus;
  claimed_by: string | null;
  claimed_at: string | null;
  first_response_at: string | null;
  closed_by: string | null;
  closed_at: string | null;
  flagged_at: string | null;
  flag_reason: string | null;
  created_at: string;
  updated_at: string;
};

const ADMIN = 'kaner@simple.biz';
const T_FILED = '2026-09-21T13:00:00.000Z';
const T_CLAIMED = '2026-09-21T13:05:00.000Z';
const T_ANSWERED = '2026-09-21T14:00:00.000Z';
const T_CLOSED = '2026-09-21T15:00:00.000Z';

function ticketRow(overrides: Partial<TicketRow> = {}): TicketRow {
  return {
    id: '4b6a2c2e-0000-4000-8000-000000000001',
    ticket_no: 1043,
    work_email: EMPLOYEE,
    filed_by_email: EMPLOYEE,
    member_name: 'Maria C',
    department: 'hsl:intake_specialist',
    category: 'pay_payslip',
    concern: 'My 9/13 payslip is short by four hours.',
    status: 'open',
    claimed_by: null,
    claimed_at: null,
    first_response_at: null,
    closed_by: null,
    closed_at: null,
    flagged_at: null,
    flag_reason: null,
    created_at: T_FILED,
    updated_at: T_FILED,
    ...overrides,
  };
}

test('a full employee_support_tickets row is accepted by every rule as-is', () => {
  // No mapping layer between the row and the rule. If a column is renamed the
  // compiler says so here, not the route.
  const fresh = ticketRow();
  assert.equal(staffReplyRecipient(fresh), EMPLOYEE);
  assert.equal(employeeReplyRecipient(fresh), null);

  const held = ticketRow({ status: 'claimed', claimed_by: STAFFER, claimed_at: T_CLAIMED });
  assert.equal(staffReplyRecipient(held), EMPLOYEE);
  assert.equal(employeeReplyRecipient(held), STAFFER);
});

test('a staff reply goes to the MASTER work email, never the alias they filed from', () => {
  // The DDL keeps both because they answer different questions — who this is,
  // and how they got here (2026-09-16_employee_support.sql:48-54). Only the
  // first is a recipient; filed_by_email is not even in SupportTicketParties.
  const viaAlias = ticketRow({ filed_by_email: 'maria.c.personal@gmail.com' });
  assert.equal(staffReplyRecipient(viaAlias), EMPLOYEE);
});

test("a colleague's reply on a ticket someone else holds still goes to the employee", () => {
  // canStaffAct('reply') admits any answerer on a held ticket
  // (lifecycle.ts:113-119). The holder is not told about a colleague's reply;
  // the employee is, because the employee is who the reply is for.
  const held = ticketRow({ status: 'claimed', claimed_by: STAFFER, claimed_at: T_CLAIMED });
  assert.equal(staffReplyRecipient(held), EMPLOYEE);
  assert.notEqual(staffReplyRecipient(held), STAFFER);
});

test('the reply that reopens a closed ticket goes to its holder', () => {
  // lifecycle.ts:174-177: an employee reply to a closed ticket reopens it. The
  // recipient does not change on the way — the person who worked it hears that
  // the employee disagrees with the closure.
  const closedByHolder = ticketRow({
    status: 'closed',
    claimed_by: STAFFER,
    claimed_at: T_CLAIMED,
    first_response_at: T_ANSWERED,
    closed_by: STAFFER,
    closed_at: T_CLOSED,
  });
  assert.equal(employeeReplyRecipient(closedByHolder), STAFFER);
});

test('a reopen on a ticket nobody holds mails nobody — not the admin who closed it', () => {
  // An unheld ticket can be closed by anyone with the key (lifecycle.ts:126),
  // and an admin can close over the holder's head. closed_by is not a party
  // (SupportTicketParties) and never a recipient: mailing the admin about
  // support work would put Kane in a loop he is explicitly not in
  // (lifecycle.ts:139-141). The reopened ticket lands back in the line, which
  // the five already watch — the same cheap channel as any unclaimed reply.
  const closedByAdmin = ticketRow({
    status: 'closed',
    claimed_by: null,
    closed_by: ADMIN,
    closed_at: T_CLOSED,
  });
  assert.equal(employeeReplyRecipient(closedByAdmin), null);

  // And when the admin closed a HELD ticket, the holder still hears — not the admin.
  const heldClosedByAdmin = ticketRow({
    status: 'closed',
    claimed_by: STAFFER,
    claimed_at: T_CLAIMED,
    closed_by: ADMIN,
    closed_at: T_CLOSED,
  });
  assert.equal(employeeReplyRecipient(heldClosedByAdmin), STAFFER);
});

test('no rule ever answers with more than one address, in any status', () => {
  // The Gmail node takes one To, and "all five" is the widening this module
  // refuses. Every function returns one address or null — never a list — for
  // every status the DDL admits, held and unheld.
  const statuses: SupportStatus[] = ['open', 'claimed', 'answered', 'closed'];
  for (const status of statuses) {
    for (const claimed_by of [null, STAFFER]) {
      // The DDL forbids a claimed ticket with no claimant; do not build one.
      if (status === 'claimed' && claimed_by === null) continue;
      const row = ticketRow({
        status,
        claimed_by,
        claimed_at: claimed_by ? T_CLAIMED : null,
        closed_by: status === 'closed' ? ADMIN : null,
        closed_at: status === 'closed' ? T_CLOSED : null,
      });
      for (const got of [staffReplyRecipient(row), employeeReplyRecipient(row)]) {
        assert.ok(
          got === null || (typeof got === 'string' && got.length > 0 && !got.includes(',')),
          `${status}/${claimed_by ?? 'unheld'}: expected one address or null, got ${JSON.stringify(got)}`,
        );
      }
    }
  }
});
