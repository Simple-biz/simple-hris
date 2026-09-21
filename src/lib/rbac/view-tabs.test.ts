import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  FALLBACK_TABS,
  VIEW_TAB_IDS,
  allowedTabsForUser,
  tabFeatureKey,
  ticketsHostAccess,
} from './view-tabs';
import {
  FEATURE_CATALOG,
  ROLE_TO_FEATURE_VIEW,
  resolveFeatureAccess,
  type FeatureAccess,
  type FeaturePermissionsMap,
} from './feature-permissions';
import { ELEVATED_ROLES, RATE_VISIBLE_ROLES } from '@/lib/auth/elevated-roles';

/* Employee Support shares the /tickets ROUTE with the HRIS dev Kanban and
 * shares nothing else. Kane ruled it a new `employee_support` role + a new
 * FeatureViewKey rather than a feature key inside the `tickets` catalog
 * (docs/superpowers/plans/2026-09-19-employee-support-chat.md:26, invariant
 * :104-105), because granting a role auto-provisions `edit` on every feature in
 * that role's view — a support key under `tickets` would have handed the five
 * answerers the dev board. Carla signed "the support team only sees support
 * questions."
 *
 * These tests pin the four ways that could stop being true. */

// ---------------------------------------------------------------------------
// The server-side gate, modelled from its source.
// ---------------------------------------------------------------------------

/** What `requireFeatureAccessAnyView` does once the session is resolved:
 *  admin bypasses, otherwise each ROLE is mapped to its view and the feature is
 *  resolved only there (src/lib/auth/authorize-feature.ts:111-128). That module
 *  is `server-only`, so it cannot be imported here; the scan at the bottom of
 *  this file pins this model to the real loop. */
function grantsAnyView(
  roles: readonly string[],
  perms: FeaturePermissionsMap,
  feature: string,
  level: 'view' | 'edit',
): boolean {
  if (roles.includes('admin')) return true;
  for (const role of roles) {
    const view = ROLE_TO_FEATURE_VIEW[role];
    if (!view) continue;
    const access = resolveFeatureAccess(perms, view, feature);
    if (access === 'edit' || (level === 'view' && access === 'view')) return true;
  }
  return false;
}

/** What `provisionDashboardTabs` writes when a role is granted: `edit` on every
 *  feature of THAT role's view (app/api/employee-roles/route.ts:41-85). Built
 *  from the catalog so a persona can never be hand-typed more generously than
 *  the grant route would actually be. */
function provisioned(...roles: readonly string[]): FeaturePermissionsMap {
  const out: FeaturePermissionsMap = {};
  for (const role of roles) {
    const view = ROLE_TO_FEATURE_VIEW[role];
    if (!view) continue;
    const bucket: Record<string, FeatureAccess> = out[view] ?? {};
    for (const f of FEATURE_CATALOG[view]) bucket[f.key] = 'edit';
    out[view] = bucket;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The gate matrix: support-only, tickets-only, both, admin, neither.
// ---------------------------------------------------------------------------

describe('/tickets gate matrix — two surfaces, one route', () => {
  it('support-only: support tabs, and no dev board by click or by landing', () => {
    const roles = ['employee_support'];
    const perms = provisioned('employee_support');
    const host = ticketsHostAccess(roles, perms);

    assert.equal(host.board, false, 'a support holder must not see Overview / Board / Archived');
    assert.deepEqual(host.supportTabs, ['support-chat', 'support-tickets']);
    // The landing is the typed-URL story: /tickets is the only URL into this
    // surface (the board's three views are component state, TicketsBoard.tsx:96),
    // so "what opens on arrival" IS the typed-URL answer. Two tabs since
    // 2026-09-21 and it still opens on the chat — the landing is the FIRST
    // granted tab, and the catalog keeps chat first on purpose.
    assert.deepEqual(host.landing, { kind: 'support', tabId: 'support-chat' });

    // Server side: the board's own key stays out of reach.
    assert.equal(grantsAnyView(roles, perms, 'tickets', 'view'), false);
    assert.equal(grantsAnyView(roles, perms, 'support_chat', 'edit'), true);
    assert.equal(grantsAnyView(roles, perms, 'support_tickets', 'edit'), true);
  });

  it('tickets-only: the board, unchanged, and no support tabs', () => {
    const roles = ['tickets'];
    const perms = provisioned('tickets');
    const host = ticketsHostAccess(roles, perms);

    assert.equal(host.board, true);
    assert.deepEqual(host.supportTabs, [], 'the dev board role must not read employee questions');
    assert.deepEqual(host.landing, { kind: 'board' });

    assert.equal(grantsAnyView(roles, perms, 'tickets', 'view'), true);
    assert.equal(grantsAnyView(roles, perms, 'tickets', 'edit'), true);
    assert.equal(grantsAnyView(roles, perms, 'support_chat', 'view'), false);
    // The second support key changes nothing here: it lives in the OTHER
    // catalog, which the `tickets` role's view never resolves.
    assert.equal(grantsAnyView(roles, perms, 'support_tickets', 'view'), false);
  });

  it('both roles: both surfaces, landing where a tickets holder landed yesterday', () => {
    const roles = ['tickets', 'employee_support'];
    const perms = provisioned('tickets', 'employee_support');
    const host = ticketsHostAccess(roles, perms);

    assert.equal(host.board, true);
    assert.deepEqual(host.supportTabs, ['support-chat', 'support-tickets']);
    assert.deepEqual(host.landing, { kind: 'board' });

    assert.equal(grantsAnyView(roles, perms, 'tickets', 'edit'), true);
    assert.equal(grantsAnyView(roles, perms, 'support_chat', 'edit'), true);
    assert.equal(grantsAnyView(roles, perms, 'support_tickets', 'edit'), true);
  });

  it('admin: keys to the castle, with no overlay rows at all', () => {
    const roles = ['admin'];
    const perms: FeaturePermissionsMap = {};
    const host = ticketsHostAccess(roles, perms);

    assert.equal(host.board, true);
    assert.deepEqual(host.supportTabs, ['support-chat', 'support-tickets']);
    assert.deepEqual(host.landing, { kind: 'board' });

    assert.equal(grantsAnyView(roles, perms, 'tickets', 'edit'), true);
    assert.equal(grantsAnyView(roles, perms, 'support_chat', 'edit'), true);
  });

  it('neither: an HR coordinator gets nothing on this route', () => {
    const roles = ['hr_coordinator'];
    const perms = provisioned('hr_coordinator');
    const host = ticketsHostAccess(roles, perms);

    assert.equal(host.board, false);
    assert.deepEqual(host.supportTabs, []);
    assert.deepEqual(host.landing, { kind: 'none' });

    assert.equal(grantsAnyView(roles, perms, 'tickets', 'view'), false);
    assert.equal(grantsAnyView(roles, perms, 'support_chat', 'view'), false);
  });

  it('roleless: nothing, and no fallback landing', () => {
    const host = ticketsHostAccess([], {});
    assert.equal(host.board, false);
    assert.deepEqual(host.supportTabs, []);
    assert.deepEqual(host.landing, { kind: 'none' });
  });
});

// ---------------------------------------------------------------------------
// Failure class 2 — the FALLBACK_TABS trap.
// ---------------------------------------------------------------------------

/* `allowedTabsForUser` falls back to FALLBACK_TABS ('overview') when the overlay
 * grants a user nothing, so a dashboard is never blank. Opt a view into the
 * overlay without thinking about that and an un-provisioned holder lands on a
 * tab nobody granted them — here, the dev board's Overview. The support view is
 * immune BY CONSTRUCTION: it lists no fallback id, so "granted nothing" stays
 * nothing. */
describe('the FALLBACK_TABS trap stays shut', () => {
  it('the support view lists no fallback tab — nothing to fall back TO', () => {
    for (const tabId of VIEW_TAB_IDS.employee_support) {
      assert.ok(
        !FALLBACK_TABS.has(tabId),
        `${tabId} is a fallback tab; an un-provisioned employee_support holder would land on it`,
      );
    }
  });

  it('an un-provisioned support holder gets no tabs, not a landing', () => {
    // Role granted (the SQL widen ran, Kane assigned it) but the overlay rows
    // never arrived — or an admin hid every one of them. With two tabs the
    // second case has to hide BOTH, or the assertion would be passing for the
    // wrong reason.
    for (const perms of [
      {},
      { employee_support: { support_chat: 'hidden' as const, support_tickets: 'hidden' as const } },
    ]) {
      assert.deepEqual(allowedTabsForUser('employee_support', ['employee_support'], perms), []);
      assert.deepEqual(ticketsHostAccess(['employee_support'], perms).landing, { kind: 'none' });
    }
  });

  it('and never leaks through the `tickets` view either', () => {
    // The other half of the trap: had the support tabs been added to
    // VIEW_TAB_IDS.tickets, this call would return ['overview'] — the dev
    // board's landing — for a support holder with no tickets grants.
    assert.deepEqual(allowedTabsForUser('tickets', ['employee_support'], {}), []);
    assert.deepEqual(VIEW_TAB_IDS.tickets, [], 'VIEW_TAB_IDS.tickets must stay empty');
    // Said the other way round, because "empty" is the thing a second support
    // tab is most likely to be added to by hand: a support id parked here would
    // be gated by the `tickets` overlay, which the `tickets` role
    // auto-provisions to `edit` wholesale — the dev board would ship with it.
    for (const tabId of VIEW_TAB_IDS.employee_support) {
      assert.ok(
        !(VIEW_TAB_IDS.tickets as readonly string[]).includes(tabId),
        `${tabId} is listed under the tickets view; the tickets role would auto-provision it`,
      );
    }
  });

  it('the fallback still works for the dashboards that rely on it', () => {
    // Guard the other direction: this test file must not be satisfied by
    // someone deleting the fallback rule outright.
    assert.deepEqual(allowedTabsForUser('hr', ['hr_coordinator'], {}), ['overview']);
    assert.deepEqual([...FALLBACK_TABS], ['overview']);
  });
});

// ---------------------------------------------------------------------------
// Failure class 3 — an existing `tickets` holder's access is untouched.
// ---------------------------------------------------------------------------

describe('the existing tickets gate is not loosened', () => {
  it('the board catalog is exactly the one key it always was', () => {
    assert.deepEqual(FEATURE_CATALOG.tickets.map((f) => f.key), ['tickets']);
    assert.equal(ROLE_TO_FEATURE_VIEW.tickets, 'tickets');
  });

  it('the two catalogs share no key — the gate works in BOTH directions', () => {
    // This disjointness IS the gate. `grantsAnyView` resolves a feature only
    // under the views the caller's roles map to, so a shared key would be a
    // shared grant: `support_chat` under `tickets` would open the chat to the
    // dev board, and `tickets` under `employee_support` would open the board to
    // the five answerers.
    const board = new Set(FEATURE_CATALOG.tickets.map((f) => f.key));
    const support = new Set(FEATURE_CATALOG.employee_support.map((f) => f.key));
    for (const f of FEATURE_CATALOG.employee_support) {
      assert.ok(!board.has(f.key), `${f.key} appears in both catalogs`);
    }
    // Symmetric, so the assertion keeps its meaning if either catalog grows:
    // today the board catalog is one key, and a `tickets` key appearing in the
    // support catalog would be the same hole facing the other way.
    for (const f of FEATURE_CATALOG.tickets) {
      assert.ok(!support.has(f.key), `${f.key} appears in both catalogs`);
    }
  });

  it('a tickets holder sees the same tabs as before: none, the board renders its own rail', () => {
    for (const roles of [['tickets'], ['admin'], ['tickets', 'admin']]) {
      assert.deepEqual(allowedTabsForUser('tickets', roles, provisioned('tickets')), []);
    }
  });

  it('every support tab id resolves to a real key in the support catalog', () => {
    // A tab id whose feature key is not in the catalog is un-grantable (the
    // grant route provisions from the catalog) and would render only for admin.
    const keys = new Set(FEATURE_CATALOG.employee_support.map((f) => f.key));
    for (const tabId of VIEW_TAB_IDS.employee_support) {
      assert.ok(keys.has(tabFeatureKey(tabId)), `${tabId} -> ${tabFeatureKey(tabId)} is not in the catalog`);
    }
  });

  it('support is not elevated and never rate-visible', () => {
    // The five answerers read pay disputes; they do not read pay. Nothing in
    // this work may put them on either list.
    assert.ok(!(ELEVATED_ROLES as readonly string[]).includes('employee_support'));
    assert.ok(!(RATE_VISIBLE_ROLES as readonly string[]).includes('employee_support'));
  });
});

// ---------------------------------------------------------------------------
// Failure class 4 — an inert grant.
// ---------------------------------------------------------------------------

describe('the support grant is not inert', () => {
  it('the role maps to its own view, so the server-side loop reaches it', () => {
    // A role missing from ROLE_TO_FEATURE_VIEW is skipped by the `continue` in
    // requireFeatureAccessAnyView and the caller falls through to default-deny:
    // the grant would exist and buy nothing.
    assert.equal(ROLE_TO_FEATURE_VIEW.employee_support, 'employee_support');
    assert.notEqual(ROLE_TO_FEATURE_VIEW.employee_support, 'tickets');
  });

  it('the role string matches the one the migration makes storable', () => {
    const sql = readFileSync(
      path.join(__dirname, '..', '..', '..', 'references', 'sql', 'alter', '2026-09-19_employee_support_role.sql'),
      'utf8',
    );
    assert.match(sql, /added constant text\[\] := array\['employee_support'\]/);
  });

  it('granting the role provisions the support tabs and only those', () => {
    const perms = provisioned('employee_support');
    assert.deepEqual(Object.keys(perms), ['employee_support']);
    assert.deepEqual(perms.employee_support, { support_chat: 'edit', support_tickets: 'edit' });
  });
});

// ---------------------------------------------------------------------------
// The models above are only worth something if the source still works that way.
// ---------------------------------------------------------------------------

describe('the source still matches what these tests model', () => {
  const root = path.join(__dirname, '..', '..', '..');

  it('requireFeatureAccessAnyView still walks ROLES through ROLE_TO_FEATURE_VIEW', () => {
    const src = readFileSync(path.join(root, 'src', 'lib', 'auth', 'authorize-feature.ts'), 'utf8');
    const body = src.slice(src.indexOf('export async function requireFeatureAccessAnyView'));
    assert.match(body, /for \(const role of sess\.roles\)/, 'the gate must iterate the caller’s roles');
    assert.match(body, /ROLE_TO_FEATURE_VIEW\[role\]/, 'each role must resolve its OWN view');
    assert.match(body, /if \(!view\) continue;/, 'an unmapped role must be skipped, i.e. denied');
    assert.ok(
      body.indexOf("status: 403") > body.indexOf('for (const role of sess.roles)'),
      'the loop must end in a denial, not a fallthrough allow',
    );
  });

  it('a role grant still provisions only its own view’s catalog', () => {
    // The mechanism that made a support key under `tickets` unacceptable.
    const src = readFileSync(path.join(root, 'app', 'api', 'employee-roles', 'route.ts'), 'utf8');
    const body = src.slice(src.indexOf('async function provisionDashboardTabs'));
    assert.match(body, /const view = ROLE_TO_FEATURE_VIEW\[role\];/);
    assert.match(body, /const features = FEATURE_CATALOG\[view\]/);
    assert.match(body, /access: 'edit'/, 'every feature in that catalog is granted edit');
  });

  it('employee_support is assignable by the one writer of employee_roles.role', () => {
    const src = readFileSync(path.join(root, 'app', 'api', 'employee-roles', 'route.ts'), 'utf8');
    const list = src.slice(src.indexOf('const VALID_ROLES'), src.indexOf('] as const;'));
    assert.match(list, /'employee_support'/, 'without this, the five grants cannot be made at all');
  });
});

// ---------------------------------------------------------------------------
// The second support tab — Kane, 2026-09-21: "there should be two tabs in
// ticket for employee support one for chat and one for ticket".
// ---------------------------------------------------------------------------

/* Two SIBLING tabs in the one `employee_support` catalog, not two sections of
 * one tab (an earlier proposal said sections and he corrected it), and not a
 * second role or a second FeatureViewKey — `ticketsHostAccess` already returns
 * every granted support tab and lands on the first (view-tabs.ts:272-287).
 *
 * Everything above this line is the gate that was already proven; these pin
 * the four things the SECOND tab could break. */
describe('the second support tab is a catalog entry, not a new gate', () => {
  it('the support catalog is exactly the two keys, chat first — and order is the landing', () => {
    assert.deepEqual(FEATURE_CATALOG.employee_support.map((f) => f.key), [
      'support_chat',
      'support_tickets',
    ]);
    // Chat first is not cosmetic: the host opens on the first GRANTED tab, so
    // reordering this list silently moves where the five answerers land.
    assert.deepEqual(VIEW_TAB_IDS.employee_support, ['support-chat', 'support-tickets']);
  });

  it('tab ids and catalog keys mirror each other exactly, in the same order', () => {
    // One direction is already pinned above (an id with no key is un-grantable
    // and renders for admin only). This is the other: a key with no tab id is
    // a permission an admin can grant in the grid that opens nothing at all.
    assert.deepEqual(
      VIEW_TAB_IDS.employee_support.map(tabFeatureKey),
      FEATURE_CATALOG.employee_support.map((f) => f.key),
    );
  });

  it('a support holder with BOTH tabs still cannot reach Overview / Board / Archived', () => {
    const roles = ['employee_support'];
    const perms = provisioned('employee_support');
    const host = ticketsHostAccess(roles, perms);

    assert.equal(host.board, false, 'by click: the rail draws no board group');
    assert.equal(host.landing.kind, 'support', 'by typed URL: /tickets opens a support tab');
    for (const boardView of ['overview', 'board', 'archived']) {
      assert.ok(
        !host.supportTabs.includes(boardView),
        `${boardView} reached the support tab list`,
      );
    }
    // And the data behind the board stays shut at both levels.
    assert.equal(grantsAnyView(roles, perms, 'tickets', 'view'), false);
    assert.equal(grantsAnyView(roles, perms, 'tickets', 'edit'), false);
  });

  it('the five granted BEFORE this key existed get the chat only, and land on it', () => {
    // provisionDashboardTabs writes the catalog at GRANT time
    // (app/api/employee-roles/route.ts:41-85), so the five answerers' overlay
    // has support_chat and no row for support_tickets. A missing row resolves
    // to `hidden` — the new tab stays dark for them until an admin grants it,
    // which is the correct default-deny outcome and a deploy step, not a bug.
    const perms: FeaturePermissionsMap = { employee_support: { support_chat: 'edit' } };
    const host = ticketsHostAccess(['employee_support'], perms);
    assert.deepEqual(host.supportTabs, ['support-chat']);
    assert.deepEqual(host.landing, { kind: 'support', tabId: 'support-chat' });
    assert.equal(grantsAnyView(['employee_support'], perms, 'support_tickets', 'view'), false);
  });

  it('the landing follows the GRANT, not the hard-coded first id', () => {
    // An admin who hides Support Chat must not strand a holder on a landing
    // that no longer exists — they open on the tickets tab instead.
    const perms: FeaturePermissionsMap = {
      employee_support: { support_chat: 'hidden', support_tickets: 'edit' },
    };
    const host = ticketsHostAccess(['employee_support'], perms);
    assert.deepEqual(host.supportTabs, ['support-tickets']);
    assert.deepEqual(host.landing, { kind: 'support', tabId: 'support-tickets' });
    assert.equal(host.board, false);
  });

  it('view-level access is enough to open the tab; edit is a separate question', () => {
    // Carla's read-only reviewer: the tab is visible at `view`, and the
    // mutating routes ask for `edit` separately (canEditTab).
    const perms: FeaturePermissionsMap = {
      employee_support: { support_chat: 'view', support_tickets: 'view' },
    };
    assert.deepEqual(allowedTabsForUser('employee_support', ['employee_support'], perms), [
      'support-chat',
      'support-tickets',
    ]);
    assert.equal(grantsAnyView(['employee_support'], perms, 'support_tickets', 'view'), true);
    assert.equal(grantsAnyView(['employee_support'], perms, 'support_tickets', 'edit'), false);
  });
});

describe('the /tickets rail can actually draw every declared support tab', () => {
  it('SUPPORT_NAV has an entry for each id in VIEW_TAB_IDS.employee_support', () => {
    // TicketsSidebar skips an id it has no entry for (TicketsSidebar.tsx:184-187)
    // rather than rendering a nameless button — the honest failure, but it means
    // a granted tab can be invisible in the rail with nothing complaining. This
    // scan is what keeps that window short. The component is a client `.tsx`
    // with JSX, so it is read as text rather than imported.
    const src = readFileSync(
      path.join(__dirname, '..', '..', 'components', 'tickets', 'TicketsSidebar.tsx'),
      'utf8',
    );
    const start = src.indexOf('const SUPPORT_NAV');
    assert.ok(start > -1, 'SUPPORT_NAV must still be the rail’s support map');
    const map = src.slice(start, src.indexOf('};', start));
    for (const tabId of VIEW_TAB_IDS.employee_support) {
      assert.ok(
        map.includes(`'${tabId}'`),
        `${tabId} is granted by the catalog but the rail has no entry to draw it`,
      );
    }
    // And the union the rail navigates by must admit each id, or `onNavigate`
    // is being handed a value its own type does not contain.
    const union = src.slice(src.indexOf('export type TicketsView'), src.indexOf('interface TicketsSidebarProps'));
    for (const tabId of VIEW_TAB_IDS.employee_support) {
      assert.ok(union.includes(`'${tabId}'`), `${tabId} is missing from the TicketsView union`);
    }
  });
});
