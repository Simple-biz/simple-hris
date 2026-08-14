import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  COMPANY_WIDE_POLICIES,
  departmentsWithPublishedPolicies,
  groupPolicies,
  policiesForDeptKey,
} from './team-policies';
import { normalizeDeptToKey } from '@/lib/payroll/normalize-dept-key';

describe('team policies — department resolution', () => {
  it('the AI/API Team roster label reaches the AI/Automation page', () => {
    // The roster says "AI/API Team"; the website calls the same team
    // "AI/Automation". The hop goes through normalizeDeptToKey -> "devs".
    const key = normalizeDeptToKey('AI/API Team');
    assert.equal(key, 'devs');
    const set = policiesForDeptKey(key);
    assert.equal(set.teamLabel, 'AI/Automation');
    assert.match(set.sourceUrl ?? '', /AI-Automation-Team-Company-Policies$/);
  });

  it('every published set is reachable from a real roster label', () => {
    // Guards against a set keyed on a slug no department actually resolves to.
    const reachable = new Map<string, string>([
      ['AI/API Team', 'devs'],
      ['Accounting Team', 'accounting'],
      ['Callback Team', 'callback'],
      ['Discovery', 'discovery'],
      ['Edit Team', 'edit'],
      ['Lead Gen', 'lead_gen'],
      ['PM Team', 'pm_team'],
      ['QC', 'qc'],
      ['Sales Assistant', 'sales_assistant'],
      ['Social Media Team', 'smm'],
    ]);
    for (const [label, expectedKey] of reachable) {
      assert.equal(normalizeDeptToKey(label), expectedKey, `${label} no longer maps to ${expectedKey}`);
      assert.notEqual(
        policiesForDeptKey(expectedKey).sourceUrl,
        null,
        `${label} fell back to company-wide — its published page became unreachable`,
      );
    }
    assert.deepEqual(
      departmentsWithPublishedPolicies().sort(),
      [...reachable.values()].sort(),
      'a published set exists that no roster label reaches (or vice versa)',
    );
  });

  it('a department with no published page falls back, never throws or blanks', () => {
    for (const key of ['hogan_smith_law', 'client_va', 'hr', 'site_building', 'smart_staff', null]) {
      const set = policiesForDeptKey(key);
      assert.equal(set.sourceUrl, null);
      assert.equal(set.deptKey, null);
      assert.ok(set.policies.length > 0, `${key} rendered an empty policy list`);
    }
  });
});

describe('team policies — the fallback tells no lies', () => {
  it('omits the workday window and the notice period', () => {
    // These are the two policies that genuinely differ per team. Showing a
    // default would tell someone the wrong shift.
    const ids = COMPANY_WIDE_POLICIES.policies.map((p) => p.id);
    assert.ok(!ids.includes('workday'), 'the fallback must not assert working hours');
    assert.ok(!ids.includes('attendance'), 'the fallback must not assert a notice period');
  });

  it('still carries the rules that are identical everywhere', () => {
    const ids = COMPANY_WIDE_POLICIES.policies.map((p) => p.id);
    for (const id of ['english', 'cameras', 'overtime', 'tracking', 'humble', 'flirting']) {
      assert.ok(ids.includes(id), `the fallback dropped the universal policy "${id}"`);
    }
  });
});

describe('team policies — per-team differences are real', () => {
  it('the two workday shapes stay distinct', () => {
    const devsWorkday = policiesForDeptKey('devs').policies.find((p) => p.id === 'workday');
    const qcWorkday = policiesForDeptKey('qc').policies.find((p) => p.id === 'workday');
    assert.match(devsWorkday?.title ?? '', /9 AM to 5 PM/);
    assert.match(qcWorkday?.title ?? '', /7:50 AM to 4:00 PM/);
  });

  it('only AI/Automation carries the zero-inbox rule', () => {
    const withInbox = departmentsWithPublishedPolicies().filter((k) =>
      policiesForDeptKey(k).policies.some((p) => p.id === 'inbox'),
    );
    assert.deepEqual(withInbox, ['devs']);
  });

  it('AI/Automation asks for two weeks notice, everyone else one', () => {
    assert.match(
      policiesForDeptKey('devs').policies.find((p) => p.id === 'attendance')?.body ?? '',
      /two weeks in advance/,
    );
    assert.match(
      policiesForDeptKey('accounting').policies.find((p) => p.id === 'attendance')?.body ?? '',
      /at least one week in advance/,
    );
  });

  it('every published page states the 40-hour overtime threshold', () => {
    // Display copy only — NOT the payroll engine's threshold. Pinned so a future
    // edit can't quietly reintroduce the retired "45 hours" wording that still
    // lives in SWall's CompanyPoliciesPanel.
    for (const key of departmentsWithPublishedPolicies()) {
      const overtime = policiesForDeptKey(key).policies.find((p) => p.id === 'overtime');
      assert.match(overtime?.body ?? '', /beyond 40 hours per week/, `${key} drifted off 40 hours`);
    }
  });
});

describe('team policies — grouping', () => {
  it('groups into non-empty sections in a stable order', () => {
    const groups = groupPolicies(policiesForDeptKey('devs'));
    assert.deepEqual(groups.map((g) => g.id), ['schedule', 'communication', 'conduct']);
    for (const g of groups) assert.ok(g.policies.length > 0);
  });

  it('every policy lands in exactly one section — none are dropped', () => {
    for (const key of [...departmentsWithPublishedPolicies(), null]) {
      const set = policiesForDeptKey(key);
      const grouped = groupPolicies(set).flatMap((g) => g.policies);
      assert.equal(
        grouped.length,
        set.policies.length,
        `${key ?? 'company-wide'} lost a policy in grouping`,
      );
    }
  });

  it('no duplicate policy ids within a set', () => {
    for (const key of [...departmentsWithPublishedPolicies(), null]) {
      const ids = policiesForDeptKey(key).policies.map((p) => p.id);
      assert.equal(new Set(ids).size, ids.length, `${key ?? 'company-wide'} has a duplicate policy`);
    }
  });
});
