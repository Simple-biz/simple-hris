# HSL KPI Roster from Global Master List Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The HSL KPI Calculator's per-branch rosters currently come only from `hsl_team_members` (populated exclusively by a Hogan Smith Law Google Sheet sync). This plan merges in people from `global_master_list` — the actual system of record — so an HR-Pipeline-onboarded HSL hire appears on the correct branch without waiting on a sheet sync.

**Architecture:** A pure normalization function (`matchHslSubDeptKey`) recognizes a raw `Department` string as one of the 14 HSL branches. A pure merge function (`mergeHslRoster`) combines `hsl_team_members` rows with GML people whose department resolves via that normalizer. `/api/hsl-bonus/team-members` wires both into its existing response; `normalizeDeptToKey` (Payroll Wizard's department bucketing) is extended so the same branch names still route to the `hogan_smith_law` payroll tab.

**Tech Stack:** TypeScript, Next.js route handlers, Supabase (service-role reads), `node:test` / `node:assert/strict` (existing test runner: `node --import tsx --test "src/**/*.test.ts"`).

**Spec:** `docs/superpowers/specs/2026-08-03-hsl-kpi-gml-roster-design.md`

## Global Constraints

- `hsl_team_members` keeps its existing role for pay-rate mirroring into `employee_hourly_rates` — do not touch that code path.
- The Hogan Sheet sync (`/api/cron/sync-hsl-from-sheet`) is untouched.
- No changes to the HR Pipeline intake form UI — its Department combobox already accepts free text.
- GML-derived roster rows default `is_manager: false`, `sub_team: null` — same defaults a manually-added external member gets today. Do not attempt to infer `is_manager` from `department_managers` grants (explicitly out of scope per the spec).
- On email collision between the two sources, `hsl_team_members` wins **except** `dept_key`: if the `hsl_team_members` row's `dept_key` is `null` (unclassified) but GML resolves a specific branch, keep GML's resolution rather than regressing to `null`.
- Every new/modified pure-logic file gets `node:test` coverage in a co-located `*.test.ts`. Do not attempt to unit-test the Next.js route handler itself (session/Supabase mocking is disproportionate) — verify it via a read-only script + manual smoke test instead, matching this repo's existing `scripts/verify-*.mts` convention.
- Commit locally after each task (`git commit`, no `git push` — the user handles pushing).

---

### Task 1: `matchHslSubDeptKey` normalizer

**Files:**
- Modify: `src/lib/hsl-bonus/schema.ts` (insert after the `HSL_DEPTS` object closes, ~line 363, before the `// ── Calculation engine` comment)
- Test: `src/lib/hsl-bonus/schema.test.ts` (new file)

**Interfaces:**
- Consumes: `HSL_DEPT_KEYS: readonly HslDeptKey[]`, `HSL_DEPTS: Record<HslDeptKey, DeptConfig>` (both already exported by this file).
- Produces: `export function matchHslSubDeptKey(raw: string | null | undefined): HslDeptKey | null` — used by Task 2 (`normalize-dept-key.ts`) and Task 3 (`roster-merge.ts`).

- [ ] **Step 1: Write the failing test**

Create `src/lib/hsl-bonus/schema.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { matchHslSubDeptKey, HSL_DEPT_KEYS, HSL_DEPTS } from './schema';

test('matchHslSubDeptKey resolves every branch display name, case/whitespace-tolerant', () => {
  for (const key of HSL_DEPT_KEYS) {
    const name = HSL_DEPTS[key].name;
    assert.equal(matchHslSubDeptKey(name), key);
    assert.equal(matchHslSubDeptKey(name.toUpperCase()), key);
    assert.equal(matchHslSubDeptKey(`  ${name}  `), key);
  }
});

test('matchHslSubDeptKey resolves the namespaced hsl:<key> form', () => {
  assert.equal(matchHslSubDeptKey('hsl:case_managers'), 'case_managers');
  assert.equal(matchHslSubDeptKey('HSL:CASE_MANAGERS'), 'case_managers');
  assert.equal(matchHslSubDeptKey('hsl:not_a_real_branch'), null);
});

test('matchHslSubDeptKey returns null for generic HSL tags and unrelated strings', () => {
  assert.equal(matchHslSubDeptKey('HSL'), null);
  assert.equal(matchHslSubDeptKey('Hogan Smith Law'), null);
  assert.equal(matchHslSubDeptKey('Hogan'), null);
  assert.equal(matchHslSubDeptKey('Accounting'), null);
  assert.equal(matchHslSubDeptKey(null), null);
  assert.equal(matchHslSubDeptKey(undefined), null);
  assert.equal(matchHslSubDeptKey('   '), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test src/lib/hsl-bonus/schema.test.ts`
Expected: FAIL — `matchHslSubDeptKey` is not exported by `./schema`.

- [ ] **Step 3: Write minimal implementation**

In `src/lib/hsl-bonus/schema.ts`, find this block (the end of the `HSL_DEPTS` object):

```ts
  hsl_managers: {
    key: 'hsl_managers',
    name: 'Managers Weekly',
    cadence: 'weekly',
    color: '#a855f7',
    headerBg: 'bg-purple-950/40',
    badgeCls: 'bg-purple-900/60 text-purple-300',
    // Bespoke per-manager incentive sets — see HSL_MANAGERS / calcManagerBonus.
    // No uniform rules; the calculator renders each manager's own checklist.
    perEmployee: true,
    rules: [],
  },
};

// ── Calculation engine ───────────────────────────────────────────────────────
```

Replace it with (only the part between `};` and the calculation-engine comment changes):

```ts
  hsl_managers: {
    key: 'hsl_managers',
    name: 'Managers Weekly',
    cadence: 'weekly',
    color: '#a855f7',
    headerBg: 'bg-purple-950/40',
    badgeCls: 'bg-purple-900/60 text-purple-300',
    // Bespoke per-manager incentive sets — see HSL_MANAGERS / calcManagerBonus.
    // No uniform rules; the calculator renders each manager's own checklist.
    perEmployee: true,
    rules: [],
  },
};

// ── HSL sub-department normalization ─────────────────────────────────────────

/**
 * Recognizes a raw `Department` string (from `global_master_list`) as one of
 * the 14 `HSL_DEPT_KEYS` branches, two ways:
 *   - The namespaced access-key form Department Transfers already write into
 *     the master list (`hsl:case_managers`) — validated against
 *     `HSL_DEPT_KEYS`, not just prefix-stripped.
 *   - The branch's plain display name (`HSL_DEPTS[key].name`), trimmed and
 *     matched case-insensitively (`"Case Managers"`, `"SSD Medical Records"`).
 *
 * Returns null for anything else — including the generic `"HSL"` / `"Hogan
 * Smith Law"` / `"Hogan"` tags, which identify someone as Hogan Smith Law at
 * the payroll-department level but don't say which specific branch.
 */
export function matchHslSubDeptKey(raw: string | null | undefined): HslDeptKey | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  if (s.startsWith('hsl:')) {
    const candidate = s.slice(4);
    return (HSL_DEPT_KEYS as readonly string[]).includes(candidate)
      ? (candidate as HslDeptKey)
      : null;
  }
  for (const key of HSL_DEPT_KEYS) {
    if (HSL_DEPTS[key].name.trim().toLowerCase() === s) return key;
  }
  return null;
}

// ── Calculation engine ───────────────────────────────────────────────────────
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test src/lib/hsl-bonus/schema.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/hsl-bonus/schema.ts src/lib/hsl-bonus/schema.test.ts
git commit -m "feat(hsl): add matchHslSubDeptKey department-string normalizer"
```

---

### Task 2: Route HSL branch names through `normalizeDeptToKey`

**Files:**
- Modify: `src/lib/payroll/normalize-dept-key.ts`
- Test: `src/lib/payroll/normalize-dept-key.test.ts` (append)

**Interfaces:**
- Consumes: `matchHslSubDeptKey` from Task 1 (`@/lib/hsl-bonus/schema`).
- Produces: no new exports — `normalizeDeptToKey`'s existing signature/behavior is a strict superset of today's.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/payroll/normalize-dept-key.test.ts` (after the existing `'long-standing folds still hold'` test):

```ts
test('plain HSL branch display names resolve to hogan_smith_law too', () => {
  assert.equal(normalizeDeptToKey('Case Managers'), 'hogan_smith_law');
  assert.equal(normalizeDeptToKey('case managers'), 'hogan_smith_law');
  assert.equal(normalizeDeptToKey('SSD Medical Records'), 'hogan_smith_law');
  // Regression: the namespaced form and the generic tag must still resolve.
  assert.equal(normalizeDeptToKey('hsl:intake_specialist'), 'hogan_smith_law');
  assert.equal(normalizeDeptToKey('HSL'), 'hogan_smith_law');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test src/lib/payroll/normalize-dept-key.test.ts`
Expected: FAIL — `normalizeDeptToKey('Case Managers')` currently returns `null`, not `'hogan_smith_law'`.

- [ ] **Step 3: Write minimal implementation**

In `src/lib/payroll/normalize-dept-key.ts`, add the import at the top of the file:

```ts
import { matchHslSubDeptKey } from '@/lib/hsl-bonus/schema';

/**
 * Maps a raw Supabase `Department` string to payroll department keys (Payroll Wizard tabs).
 * Case-insensitive; trims whitespace.
 */
```

Then replace:

```ts
  const s = raw.trim().toLowerCase();
  // Department transfers into an HSL sub-team write the namespaced access key
  // (e.g. "hsl:intake_specialist") into the master list's Department column.
  // Whatever the sub-team, those people belong to Hogan Smith Law.
  if (s.startsWith('hsl:')) return 'hogan_smith_law';
```

with:

```ts
  const s = raw.trim().toLowerCase();
  // Department transfers into an HSL sub-team write the namespaced access key
  // (e.g. "hsl:intake_specialist") into the master list's Department column;
  // HR Pipeline intake or a direct profile edit may instead use the branch's
  // plain display name (e.g. "Intake Specialist"). Either way, whatever the
  // sub-team, those people belong to Hogan Smith Law.
  if (matchHslSubDeptKey(raw)) return 'hogan_smith_law';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test src/lib/payroll/normalize-dept-key.test.ts`
Expected: PASS (all tests in the file, old and new).

- [ ] **Step 5: Commit**

```bash
git add src/lib/payroll/normalize-dept-key.ts src/lib/payroll/normalize-dept-key.test.ts
git commit -m "feat(payroll): route plain HSL branch names through normalizeDeptToKey"
```

---

### Task 3: `mergeHslRoster` pure merge function

**Files:**
- Create: `src/lib/hsl-bonus/roster-merge.ts`
- Test: `src/lib/hsl-bonus/roster-merge.test.ts`

**Interfaces:**
- Consumes: `matchHslSubDeptKey` from Task 1 (`./schema`).
- Produces:
  ```ts
  export interface HslRosterRow {
    email: string;
    full_name: string | null;
    hsl_name: string | null;
    role_raw: string | null;
    dept_key: string | null;
    sub_team: string | null;
    is_manager: boolean;
  }
  export interface GmlRosterCandidate {
    name: string;
    department: string | null;
    work_email: string | null;
  }
  export function mergeHslRoster(
    hslTeamMembers: HslRosterRow[],
    gmlPeople: GmlRosterCandidate[],
    deptFilter: string | null,
  ): HslRosterRow[]
  ```
  Used by Task 4 (`app/api/hsl-bonus/team-members/route.ts`). `GmlRosterCandidate` is a structural subset of `ActiveMasterListPerson` (`src/lib/supabase/global-master-list-db.ts`) — any object with `{ name, department, work_email }` satisfies it, so Task 4 can pass `ActiveMasterListPerson[]` directly with no mapping step.

- [ ] **Step 1: Write the failing test**

Create `src/lib/hsl-bonus/roster-merge.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeHslRoster, type HslRosterRow, type GmlRosterCandidate } from './roster-merge';

const hslRow = (overrides: Partial<HslRosterRow> = {}): HslRosterRow => ({
  email: 'sheet@simple.biz',
  full_name: 'Sheet Person',
  hsl_name: 'Sheety',
  role_raw: 'Case Manager',
  dept_key: 'case_managers',
  sub_team: null,
  is_manager: false,
  ...overrides,
});

const gmlPerson = (overrides: Partial<GmlRosterCandidate> = {}): GmlRosterCandidate => ({
  name: 'GML Person',
  department: 'Case Managers',
  work_email: 'gml@simple.biz',
  ...overrides,
});

test('a GML-only person with a resolvable branch name is included', () => {
  const merged = mergeHslRoster([], [gmlPerson()], null);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]!.email, 'gml@simple.biz');
  assert.equal(merged[0]!.dept_key, 'case_managers');
  assert.equal(merged[0]!.is_manager, false);
  assert.equal(merged[0]!.sub_team, null);
});

test('a GML person is excluded when deptFilter does not match their branch', () => {
  const merged = mergeHslRoster([], [gmlPerson({ department: 'Case Managers' })], 'attestation');
  assert.equal(merged.length, 0);
});

test('a GML person with no work_email is excluded even if department resolves', () => {
  const merged = mergeHslRoster([], [gmlPerson({ work_email: null })], null);
  assert.equal(merged.length, 0);
});

test('a GML person with an unresolvable department (generic "HSL") is excluded', () => {
  const merged = mergeHslRoster([], [gmlPerson({ department: 'HSL' })], null);
  assert.equal(merged.length, 0);
});

test('hsl_team_members wins on is_manager/sub_team when the same email exists in both sources', () => {
  const merged = mergeHslRoster(
    [hslRow({ email: 'both@simple.biz', is_manager: true, sub_team: 'BLUE' as never, dept_key: 'ssd_medical_records' })],
    [gmlPerson({ work_email: 'both@simple.biz', department: 'SSD Medical Records' })],
    null,
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0]!.is_manager, true);
  assert.equal(merged[0]!.sub_team, 'BLUE');
  assert.equal(merged[0]!.dept_key, 'ssd_medical_records');
});

test('an unclassified hsl_team_members row (dept_key null) keeps the GML-resolved dept_key', () => {
  const merged = mergeHslRoster(
    [hslRow({ email: 'both@simple.biz', dept_key: null })],
    [gmlPerson({ work_email: 'both@simple.biz', department: 'hsl:filing_specialist' })],
    null,
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0]!.dept_key, 'filing_specialist');
});

test('email de-dup is case-insensitive', () => {
  const merged = mergeHslRoster(
    [hslRow({ email: 'foo@simple.biz' })],
    [gmlPerson({ work_email: 'FOO@SIMPLE.BIZ', department: 'Case Managers' })],
    null,
  );
  assert.equal(merged.length, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test src/lib/hsl-bonus/roster-merge.test.ts`
Expected: FAIL — `./roster-merge` doesn't exist yet.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/hsl-bonus/roster-merge.ts`:

```ts
import { matchHslSubDeptKey } from './schema';

/** Roster row shape returned by `hsl_team_members` (and by /api/hsl-bonus/team-members). */
export interface HslRosterRow {
  email: string;
  full_name: string | null;
  hsl_name: string | null;
  role_raw: string | null;
  dept_key: string | null;
  sub_team: string | null;
  is_manager: boolean;
}

/** The subset of an active Global-Master-List person this merge needs. */
export interface GmlRosterCandidate {
  name: string;
  department: string | null;
  work_email: string | null;
}

/**
 * Merges the Hogan-sheet-synced `hsl_team_members` roster with people who are
 * active on the Global Master List and tagged into an HSL branch (via
 * `matchHslSubDeptKey`) — so someone onboarded through the HR Pipeline shows
 * up without waiting on a Hogan sheet sync. Merged by lower-cased email;
 * `hslTeamMembers` wins on conflict (it carries `is_manager`/`sub_team`, which
 * GML has no concept of) — EXCEPT `dept_key`: if the sheet row hasn't been
 * classified yet (`dept_key: null`) but GML resolves a specific branch, the
 * GML resolution is kept rather than regressing back to unclassified.
 *
 * `deptFilter` mirrors the API's `?dept=` param: when set, only GML people
 * whose resolved key matches are included (the caller is expected to have
 * already filtered `hslTeamMembers` the same way, e.g. via `.eq('dept_key', ...)`).
 */
export function mergeHslRoster(
  hslTeamMembers: HslRosterRow[],
  gmlPeople: GmlRosterCandidate[],
  deptFilter: string | null,
): HslRosterRow[] {
  const byEmail = new Map<string, HslRosterRow>();

  for (const p of gmlPeople) {
    const key = matchHslSubDeptKey(p.department);
    if (!key) continue;
    if (deptFilter && key !== deptFilter) continue;
    const email = (p.work_email ?? '').trim().toLowerCase();
    if (!email) continue;
    byEmail.set(email, {
      email,
      full_name: p.name,
      hsl_name: null,
      role_raw: null,
      dept_key: key,
      sub_team: null,
      is_manager: false,
    });
  }

  for (const r of hslTeamMembers) {
    const email = (r.email ?? '').trim().toLowerCase();
    if (!email) continue;
    const existing = byEmail.get(email);
    byEmail.set(email, {
      ...r,
      email,
      dept_key: r.dept_key ?? existing?.dept_key ?? null,
    });
  }

  return Array.from(byEmail.values()).sort((a, b) =>
    (a.full_name ?? '').localeCompare(b.full_name ?? ''),
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test src/lib/hsl-bonus/roster-merge.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/hsl-bonus/roster-merge.ts src/lib/hsl-bonus/roster-merge.test.ts
git commit -m "feat(hsl): add mergeHslRoster pure roster-merge function"
```

---

### Task 4: Wire the merge into `/api/hsl-bonus/team-members`

**Files:**
- Modify: `app/api/hsl-bonus/team-members/route.ts` (full-file rewrite; currently 49 lines)

**Interfaces:**
- Consumes: `mergeHslRoster` (Task 3, `@/lib/hsl-bonus/roster-merge`), `listActiveMasterListPeople` + `ActiveMasterListPerson` (existing, `@/lib/supabase/global-master-list-db`).
- Produces: no new exports — same `GET` route contract (`{ rows: [...] }` on success, `{ error }` on failure) as today, with more rows in the merged case.

- [ ] **Step 1: Replace the route file**

Replace the full contents of `app/api/hsl-bonus/team-members/route.ts` with:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth/auth-options';
import { hasElevatedRole } from '@/lib/auth/elevated-roles';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { listActiveMasterListPeople, type ActiveMasterListPerson } from '@/lib/supabase/global-master-list-db';
import { mergeHslRoster } from '@/lib/hsl-bonus/roster-merge';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Short in-memory cache for the GML active-roster read: this route is polled
// every ~30s per visible branch by the KPI Calculator's live-refresh
// (useLiveRefresh), and an elevated session loads all 14 branches on boot —
// without this, each poll would re-run a full paginated active_employees scan
// per branch. Same TTL-cache shape as invalidateRateProfilesCache in
// employee-rate-profiles.ts. Scoped to this route only (not shared with
// listActiveMasterListPeople's other callers, e.g. the transfer picker, which
// may want fresher reads).
const GML_CACHE_TTL_MS = 30_000;
let cachedGmlPeople: { ts: number; people: ActiveMasterListPerson[] } | null = null;

async function getActiveMasterListPeopleCached(): Promise<ActiveMasterListPerson[]> {
  if (cachedGmlPeople && Date.now() - cachedGmlPeople.ts < GML_CACHE_TTL_MS) {
    return cachedGmlPeople.people;
  }
  const { people, error } = await listActiveMasterListPeople();
  if (error) {
    console.error('[hsl-bonus/team-members] listActiveMasterListPeople failed:', error);
    return cachedGmlPeople?.people ?? [];
  }
  cachedGmlPeople = { ts: Date.now(), people };
  return people;
}

// GET /api/hsl-bonus/team-members              -> all rows (manager/elevated)
// GET /api/hsl-bonus/team-members?dept=KEY     -> filtered by dept_key
//
// Consumers: the manager HSL KPI Calculator and the accounting Payroll Wizard.
// Rows come from TWO sources, merged by lower-cased email (see mergeHslRoster
// in src/lib/hsl-bonus/roster-merge.ts):
//   1. hsl_team_members — the Hogan Smith Law sheet-synced roster (manually
//      dept_key-classified). Wins on conflict for is_manager/sub_team/dept_key
//      (when it has one).
//   2. global_master_list — active people whose Department resolves to an HSL
//      branch via matchHslSubDeptKey (the namespaced `hsl:<key>` tag written
//      by Department Transfers, or the branch's plain display name). Lets
//      someone onboarded through the HR Pipeline appear without waiting on a
//      Hogan sheet sync. See docs/superpowers/specs/2026-08-03-hsl-kpi-gml-roster-design.md.
//
// SECURITY: this used to run on the service-role client with NO auth gate, so
// any authenticated employee could read the HSL roster — including the
// `hourly_rate`/`ot_rate` columns, which neither consumer renders. The rate
// columns are dropped from the SELECT (pay rates are Accounting/CEO only) and
// the read is gated to managers + elevated (accounting/admin) sessions.
export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  const user = session?.user as { email?: string | null; roles?: string[] } | undefined;
  if (!user?.email) {
    return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  }
  const roles = (user.roles ?? []) as string[];
  if (!roles.includes('manager') && !hasElevatedRole(roles)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const dept = searchParams.get('dept');

  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) {
    return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });
  }

  let query = supabase
    .from('hsl_team_members')
    .select('email, full_name, hsl_name, role_raw, dept_key, sub_team, is_manager')
    .order('full_name');

  if (dept) query = query.eq('dept_key', dept);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const gmlPeople = await getActiveMasterListPeopleCached();
  const rows = mergeHslRoster(data ?? [], gmlPeople, dept);
  return NextResponse.json({ rows });
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run lint`
Expected: no new type errors from this file (pre-existing errors elsewhere, if any, are not this task's concern — confirm none originate from `app/api/hsl-bonus/team-members/route.ts` or the files touched in Tasks 1–3).

- [ ] **Step 3: Commit**

```bash
git add app/api/hsl-bonus/team-members/route.ts
git commit -m "feat(hsl): merge Global Master List into the team-members roster API"
```

---

### Task 5: Read-only live verification + manual smoke test

**Files:**
- Create: `scripts/verify-hsl-gml-roster.mts`

**Interfaces:**
- Consumes: `matchHslSubDeptKey` (Task 1), `mergeHslRoster` (Task 3) — imported directly, no HTTP calls.
- Produces: nothing consumed by later tasks — this is the final acceptance check.

- [ ] **Step 1: Write the verification script**

Create `scripts/verify-hsl-gml-roster.mts`:

```ts
/**
 * READ-ONLY verification for the HSL KPI Calculator's GML-merged roster.
 * See docs/superpowers/specs/2026-08-03-hsl-kpi-gml-roster-design.md.
 *
 * Confirms, against LIVE data:
 *   1. Every real hsl:<key>-tagged global_master_list row resolves via
 *      matchHslSubDeptKey (sanity: the namespaced form Department Transfers
 *      write is actually recognized).
 *   2. mergeHslRoster, given the real active roster + real hsl_team_members
 *      rows, produces no duplicate emails and never regresses an
 *      already-classified hsl_team_members dept_key to null.
 *   3. Whether dangieg@simple.biz resolves to a branch today (expected: no,
 *      until her Department is set to a specific branch — this script
 *      documents that; it does not fix her data).
 *
 * This script performs SELECT-only operations. Run:
 *   npx tsx scripts/verify-hsl-gml-roster.mts
 */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });
dotenv.config();

const { matchHslSubDeptKey } = await import('../src/lib/hsl-bonus/schema');
const { mergeHslRoster } = await import('../src/lib/hsl-bonus/roster-merge');

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!url || !key) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

let failed = false;

console.log('=== 1. Real hsl:<key> Department tags resolve ===');
{
  const { data, error } = await supabase
    .from('global_master_list')
    .select('"Work Email", "Department"')
    .ilike('"Department"', 'hsl:%')
    .limit(20);
  if (error) {
    console.error('ERROR', error.message);
    failed = true;
  } else {
    for (const row of (data ?? []) as Record<string, string | null>[]) {
      const dept = row['Department'];
      const resolved = matchHslSubDeptKey(dept);
      console.log(`${row['Work Email']}: "${dept}" -> ${resolved ?? 'NULL (unexpected!)'}`);
      if (!resolved) failed = true;
    }
    if ((data ?? []).length === 0) console.log('(no hsl:<key>-tagged rows found today)');
  }
}

console.log('\n=== 2. mergeHslRoster sanity over live data (no dept filter) ===');
{
  const { data: hslRows, error: hslErr } = await supabase
    .from('hsl_team_members')
    .select('email, full_name, hsl_name, role_raw, dept_key, sub_team, is_manager')
    .range(0, 9999);
  const { data: gmlRows, error: gmlErr } = await supabase
    .from('global_master_list')
    .select('"Name", "Department", "Work Email"')
    .range(0, 9999);
  if (hslErr || gmlErr) {
    console.error('ERROR', hslErr?.message, gmlErr?.message);
    failed = true;
  } else {
    const gmlPeople = (gmlRows ?? []).map((r) => {
      const rec = r as Record<string, string | null>;
      return { name: rec['Name'] ?? '', department: rec['Department'], work_email: rec['Work Email'] };
    });
    const merged = mergeHslRoster((hslRows ?? []) as never, gmlPeople, null);
    const emails = merged.map((m) => m.email);
    const dupes = emails.filter((e, i) => emails.indexOf(e) !== i);
    console.log(`hsl_team_members rows: ${hslRows?.length ?? 0}`);
    console.log(`global_master_list rows scanned: ${gmlRows?.length ?? 0}`);
    console.log(`merged roster size: ${merged.length}`);
    console.log(dupes.length === 0 ? 'OK: no duplicate emails in merged roster' : `FAIL: ${dupes.length} duplicate emails`);
    if (dupes.length > 0) failed = true;

    const regressed = ((hslRows ?? []) as { email: string; dept_key: string | null }[]).filter((r) => {
      if (!r.dept_key) return false;
      const m = merged.find((x) => x.email === r.email.toLowerCase());
      return m && m.dept_key !== r.dept_key;
    });
    console.log(
      regressed.length === 0
        ? 'OK: no classified hsl_team_members dept_key was overwritten'
        : `FAIL: ${regressed.length} rows had their dept_key changed: ${JSON.stringify(regressed)}`,
    );
    if (regressed.length > 0) failed = true;
  }
}

console.log('\n=== 3. dangieg@simple.biz today ===');
{
  const { data, error } = await supabase
    .from('global_master_list')
    .select('"Department"')
    .ilike('"Work Email"', 'dangieg@simple.biz');
  if (error) {
    console.error('ERROR', error.message);
  } else {
    const dept = (data?.[0] as Record<string, string | null> | undefined)?.['Department'] ?? null;
    const resolved = matchHslSubDeptKey(dept);
    console.log(
      `Department: "${dept}" -> matchHslSubDeptKey: ${resolved ?? 'null (expected until her Department is set to a specific branch)'}`,
    );
  }
}

if (failed) {
  console.error('\nFAILED — see above.');
  process.exit(1);
}
console.log('\nAll checks passed.');
```

- [ ] **Step 2: Run the script**

Run: `npx tsx scripts/verify-hsl-gml-roster.mts`
Expected: `All checks passed.` (exit code 0). If section 1 or 2 reports a FAIL, stop and re-open Task 3/4 — do not proceed to manual testing with a known-broken merge.

- [ ] **Step 3: Manual smoke test**

1. Start the dev server (check first whether one is already running — see `nextjs-build-vs-dev-shared-dir` note: both `next build` and `next dev` share `.next/`, don't clobber a running dev server).
2. Sign in as a manager or admin with access to at least one HSL branch.
3. Find (or temporarily set, in a scratch/test row — not Dangie's real row) a GML person's `Department` to an exact HSL branch display name (e.g. `"Case Managers"`) or `hsl:<key>` form.
4. Open the HSL KPI Calculator, navigate to that branch, and confirm the person now appears in the roster table without ever touching `hsl_team_members`.
5. As an elevated/admin session, open the Payroll Wizard's Hogan Smith Law tab and confirm the same person is bucketed under the correct branch in the rail (not "Unassigned").
6. Confirm a person who was already on a branch via `hsl_team_members` (a pre-existing, previously-classified person) still appears, unchanged, alongside the new GML-derived entry.

- [ ] **Step 4: Commit**

```bash
git add scripts/verify-hsl-gml-roster.mts
git commit -m "test(hsl): add read-only live verification for the GML-merged roster"
```

---

## Follow-up (not part of this plan)

Once this ships, Dangie's `Department` (currently the generic `"HSL"`) still
needs to be set to her actual branch — via a Department Transfer or a direct
profile edit — before she'll appear anywhere. That's a data action for
whoever knows which branch she belongs to, not a code change.
