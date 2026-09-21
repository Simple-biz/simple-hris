import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTO_CLAIM_ACTS,
  SUPPORT_ACTS,
  autoClaimsOn,
  canEmployeeReply,
  canStaffAct,
  holds,
  nextStatus,
  type Actor,
  type LifecycleTicket,
} from './lifecycle';

const CARLA = 'carla@simple.biz';
const CLAIRE = 'claire@simple.biz';

const ticket = (over: Partial<LifecycleTicket> = {}): LifecycleTicket => ({
  status: 'open',
  priority: null,
  claimed_by: null,
  ...over,
});

const carla: Actor = { email: CARLA, isAdmin: false };
const claire: Actor = { email: CLAIRE, isAdmin: false };
const admin: Actor = { email: 'kaner@simple.biz', isAdmin: true };

const ok = (v: ReturnType<typeof canStaffAct>) => v.allowed === true;

describe('a touch is an ACTION, never a read', () => {
  it('rank, reply and claim auto-claim; close, reopen and reassign do not', () => {
    assert.deepEqual([...AUTO_CLAIM_ACTS].sort(), ['claim', 'rank', 'reply']);
    for (const act of SUPPORT_ACTS) {
      assert.equal(autoClaimsOn(act), (['rank', 'reply', 'claim'] as string[]).includes(act), act);
    }
  });

  it('ranking an unheld ticket takes it; ranking a held one does not steal it', () => {
    const free = canStaffAct('rank', ticket(), carla);
    assert.ok(ok(free) && free.allowed && free.claims);
    const held = canStaffAct('rank', ticket({ claimed_by: CLAIRE }), carla);
    assert.ok(ok(held) && held.allowed && !held.claims);
  });

  it('replying to an unheld ticket takes it', () => {
    const v = canStaffAct('reply', ticket(), carla);
    assert.ok(v.allowed && v.claims);
  });

  it('closing never claims — it would misreport who did the work', () => {
    const v = canStaffAct('close', ticket(), carla);
    assert.ok(v.allowed && !v.claims);
  });
});

describe('claim is a race, so it refuses what is already taken', () => {
  it('an unheld open ticket can be claimed', () => {
    assert.ok(canStaffAct('claim', ticket(), carla).allowed);
  });

  it('a ticket you already hold cannot be claimed again', () => {
    const v = canStaffAct('claim', ticket({ claimed_by: CARLA }), carla);
    assert.ok(!v.allowed);
  });

  it('somebody else holding it is refused, and the refusal names them', () => {
    const v = canStaffAct('claim', ticket({ claimed_by: CLAIRE }), carla);
    assert.ok(!v.allowed);
    assert.match(v.allowed === false ? v.reason : '', /claire@simple\.biz/);
  });

  it('a closed ticket cannot be claimed without reopening it', () => {
    assert.ok(!canStaffAct('claim', ticket({ status: 'closed' }), carla).allowed);
  });

  it('holds() is exact, not a prefix or a case-insensitive guess', () => {
    assert.ok(holds(ticket({ claimed_by: CARLA }), carla));
    assert.ok(!holds(ticket({ claimed_by: null }), carla));
    assert.ok(!holds(ticket({ claimed_by: CLAIRE }), carla));
  });
});

describe('ranking belongs to the team, not to the holder', () => {
  it('anyone may re-rank a ticket somebody else is handling', () => {
    // Urgency is a property of the QUESTION. A line only the holder can
    // re-prioritise cannot be re-prioritised when something turns out urgent.
    assert.ok(canStaffAct('rank', ticket({ claimed_by: CLAIRE }), carla).allowed);
  });

  it('a closed ticket is not in the line', () => {
    assert.ok(!canStaffAct('rank', ticket({ status: 'closed' }), carla).allowed);
  });
});

describe('close and reassign are the holder or an admin', () => {
  it('the holder may close', () => {
    assert.ok(canStaffAct('close', ticket({ claimed_by: CARLA }), carla).allowed);
  });

  it('a non-holder may not close somebody else work', () => {
    const v = canStaffAct('close', ticket({ claimed_by: CLAIRE }), carla);
    assert.ok(!v.allowed);
  });

  it('an admin may close anything — the stuck-ticket override', () => {
    assert.ok(canStaffAct('close', ticket({ claimed_by: CLAIRE }), admin).allowed);
  });

  it('an unheld ticket may be closed by anyone on the team', () => {
    assert.ok(canStaffAct('close', ticket(), carla).allowed);
  });

  it('already-closed refuses rather than closing twice', () => {
    assert.ok(!canStaffAct('close', ticket({ status: 'closed', claimed_by: CARLA }), carla).allowed);
  });

  it('reassign needs a current holder', () => {
    assert.ok(!canStaffAct('reassign', ticket(), carla).allowed);
  });

  it('the holder passes it on; a bystander cannot', () => {
    assert.ok(canStaffAct('reassign', ticket({ claimed_by: CARLA }), carla).allowed);
    assert.ok(!canStaffAct('reassign', ticket({ claimed_by: CLAIRE }), carla).allowed);
    assert.ok(canStaffAct('reassign', ticket({ claimed_by: CLAIRE }), admin).allowed);
  });
});

describe('a reply to a CLOSED ticket — the asymmetry is deliberate', () => {
  it('an employee reply reopens it: they are saying it was not resolved', () => {
    const v = canEmployeeReply(ticket({ status: 'closed' }));
    assert.ok(v.allowed && v.reopens);
  });

  it('an employee reply to an open ticket changes nothing', () => {
    const v = canEmployeeReply(ticket({ status: 'open' }));
    assert.ok(v.allowed && !v.reopens);
  });

  it('a STAFF reply to a closed ticket does NOT reopen it — it is a postscript', () => {
    const v = canStaffAct('reply', ticket({ status: 'closed' }), carla);
    assert.ok(v.allowed && !v.reopens);
  });

  it('neither side is ever refused — closed threads stay readable and answerable', () => {
    // Carla signed "Either side can reply again. Nothing is deleted."
    assert.ok(canEmployeeReply(ticket({ status: 'closed' })).allowed);
    assert.ok(canStaffAct('reply', ticket({ status: 'closed' }), carla).allowed);
  });
});

describe('nextStatus', () => {
  it('a first staff reply answers an open or claimed ticket', () => {
    assert.equal(nextStatus('reply', ticket({ status: 'open' }), 'staff'), 'answered');
    assert.equal(nextStatus('reply', ticket({ status: 'claimed' }), 'staff'), 'answered');
  });

  it('a staff reply leaves an already-answered ticket alone', () => {
    assert.equal(nextStatus('reply', ticket({ status: 'answered' }), 'staff'), null);
  });

  it('a staff reply leaves a closed ticket closed', () => {
    assert.equal(nextStatus('reply', ticket({ status: 'closed' }), 'staff'), null);
  });

  it('an employee reply reopens a closed ticket and otherwise changes nothing', () => {
    assert.equal(nextStatus('reply', ticket({ status: 'closed' }), 'employee'), 'open');
    assert.equal(nextStatus('reply', ticket({ status: 'answered' }), 'employee'), null);
  });

  it('claim moves open to claimed, and does not disturb answered', () => {
    assert.equal(nextStatus('claim', ticket({ status: 'open' }), 'staff'), 'claimed');
    assert.equal(nextStatus('claim', ticket({ status: 'answered' }), 'staff'), null);
  });

  it('close and reopen are what they say', () => {
    assert.equal(nextStatus('close', ticket(), 'staff'), 'closed');
    assert.equal(nextStatus('reopen', ticket({ status: 'closed' }), 'staff'), 'open');
  });

  it('rank and reassign never move the status', () => {
    assert.equal(nextStatus('rank', ticket(), 'staff'), null);
    assert.equal(nextStatus('reassign', ticket({ claimed_by: CARLA }), 'staff'), null);
  });
});
