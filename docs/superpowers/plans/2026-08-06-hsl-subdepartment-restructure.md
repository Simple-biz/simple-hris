# HSL Sub-Department Restructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make HSL sub-departments first-class: per-sub-department base rates in the Payment Catalog (main HSL base rate removed after cutover), correct transfers into/out of/within HSL, a bulk "hard transfer" tool so Carla/Olivia can assign all ~510 HSL people to sub-departments in the UI, and forensic attribution for the "HRS" service-account writes.

**Architecture:** HSL sub-departments already exist as three keyspaces that this plan unifies around ONE canonical label: the master-list `Department` cell `hsl:<HslDeptKey>` (e.g. `hsl:intake_specialist`). The rate engine learns to resolve that label to its own catalog structure *before* collapsing to the `hogan_smith_law` parent; transfer matching becomes HSL-family-aware (a cell reading `hsl:intake_specialist` IS an "HSL" row for source-matching, but a sub-department *target* requires an exact cell); the Google-Sheet write-back and master-list sync stop fighting each other over stale labels.

**Tech Stack:** Next.js (App Router) + Supabase (PostgREST, service-role) + Google Sheets API (service account). Tests: `node:test` + `node:assert/strict` via tsx.

## Global Constraints

- **Never `git push`.** Commit locally only — Kane handles all pushes (`do-not-push-user-handles-git`). Ship direct to `main`, no PR.
- **Shared checkout:** other sessions may be working in this repo. `git add` ONLY the files your task names — never `git add -A`/`git add .`. Re-check `git status` before every commit.
- **`.env.local` holds PRODUCTION service-role credentials.** Any script that writes must: default to dry-run, require an explicit `--apply` flag, and write a SELECT-backup JSON of affected rows to `exports/` before mutating. Node scripts only — never hand Kane raw SQL to paste.
- **Canonical sub-department label** = `hsl:<key>` where `<key>` ∈ `HSL_DEPT_KEYS` (src/lib/hsl-bonus/schema.ts:99-112), stored lowercase. Display form = `HSL — <Name>` (em-dash), never `HSL: <Name>`.
- Tests: `npm test` runs `node --import tsx --test "src/**/*.test.ts"`. Single file: `node --import tsx --test <path>`. Type gate: `npm run lint` (= `tsc --noEmit`).
- Do NOT run `npm run build` if a dev server is running (shared `.next/`).
- Tasks 1–9 are safe to ship immediately (pure code; no behavior change until sub-department catalog rows exist / labels are written). Tasks 10–12 are the Saturday-cutover tooling. **The parent HSL base rate is deleted only at cutover, by script, after every sub-department has its own row** — the code keeps parent fallback forever.

---

## Status / re-scope (2026-08-06, Kane)

Kane redirected the starting point: **the Payment Catalog pipeline leads.** Create a Department (Department tab) Step 2 "Sub-departments" now carries a base rate PER sub-department; a department with sub-departments carries NO department-wide rate (the HSL model); Payroll Wizard grouping stays parent-level (hsl:* still lands under the HSL step).

**SHIPPED (first increment):**
- `NewSubDepartment` (name + optional `payStructure`) in `CreateDepartmentInput`; validation rejects a department-wide rate when sub-departments exist (src/lib/departments/registry.ts).
- `subDeptStructureKey(parentKey, subKey)` → `<parentKey>:<subKey>` — same namespacing as the built-in `hsl:<key>` convention.
- Create route stage 4 writes one dept-scope `payment_catalog_pay_structures` row per rated sub (app/api/payment-catalog/departments/route.ts); audit details + summary carry `sub_rates_set`/`subRatesSet`.
- `resolveDeptCatalogRate` resolves ANY namespaced key (`hsl:intake_specialist`, `medical_billing:intake_team`) BEFORE `normalizeDeptToKey` collapses it — parent base is now strictly the fallback (src/lib/payroll/resolve-rate.ts). This GENERALIZES and supersedes Task 2 Step 3's hsl-only branch; Task 1's matching helpers are still needed for transfers.
- Wizard Step 2 rate inputs per sub; Pay & review becomes a read-only sub-rate recap when subs exist; dept cards show per-sub rate chips + "N/M sub-department rates"; Pay Structure rail/exports list registry sub-departments as `Parent — Sub` entries (DepartmentsTab.tsx, BonusCatalog.tsx).

**Still pending from the task list below:** Task 2's call-site label preference (current-pay.ts:959 / disbursement-reports.ts:1189 must prefer the MASTER label over the rates-row "Hogan Smith Law"), Task 3's mirrors (person-comp deptBase, accounting-transfers deptStructure — both still miss namespaced keys), Task 4's rail entries for the BUILT-IN HSL sub-teams (`hsl:<key>` — the registry expansion shipped, the HSL_DEPT_KEYS expansion did not) + the pay-structures route Hogan special-case widening, and Tasks 1, 5–12 unchanged.

## Current-system study (what exists today)

**Three HSL sub-department keyspaces:**
1. **KPI/access keys** — `HSL_DEPT_KEYS` (12 sub-teams) + `HSL_DEPTS` configs in src/lib/hsl-bonus/schema.ts:99-336. Access grants are namespaced strings `hsl:<key>` stored in `department_managers` (`hslAccessKey`, schema.ts:118-120), ticked per-sub-team in AdminRoles.tsx:526-535, 1275-1287.
2. **Master-list Department labels** — transfers into an HSL sub-team write the access key (e.g. `hsl:intake_specialist`) into `global_master_list."Department"` (documented at src/lib/payroll/normalize-dept-key.ts:8-11). `normalizeDeptToKey` collapses every `hsl:*` label to the single payroll key `hogan_smith_law` (normalize-dept-key.ts:11).
3. **Payment Catalog registry sub-departments** — in-app custom departments (`app_settings` key `payment_catalog.departments.registry`) support `subDepartments` (src/lib/departments/registry.ts:27-66) but are SELF-CONTAINED: they never touch the master list, and built-in departments like HSL cannot be re-created there (registry.ts:161).

**Rate resolution** (`effective = employeeCatalog ?? sheetRate ?? departmentBase`, src/lib/payroll/resolve-rate.ts:4-30): `resolveDeptCatalogRate` (resolve-rate.ts:131-150) calls `normalizeDeptToKey` FIRST, which returns non-null for any `hsl:*` label — so the raw-key/slug fallbacks are unreachable and **all HSL people resolve the one `hogan_smith_law` department-scope row** in `payment_catalog_pay_structures`. There is exactly one dept-scope row per `department_key` (natural key, pay-structure.ts:125-131), and the Pay Structure rail (BonusCatalog.tsx:1961-1967) lists only `DEPARTMENTS` + registry customs — no UI exists to set a sub-department base. All six pay-affecting call sites pass the RAW roster label (PayrollWizard.tsx:3748,3770,3876; people-roster.ts:170; current-pay.ts:957-961; disbursement-reports.ts:1189; member-monthly-pay.ts:569), so fixing the resolver is centralized — with one caveat: `current-pay.ts:959` and `disbursement-reports.ts:1189` prefer `deptByEmail` built from `employee_hourly_rates."Department"`, which the HSL rates mirror **hardcodes to `"Hogan Smith Law"`** (src/lib/supabase/hsl-upload-db.ts:11,269), shadowing the sub-label.

**Transfers** (`department_transfer_requests`, v2 release flow): apply writes `global_master_list."Department" = to_department` via `planDepartmentApply` (src/lib/supabase/department-transfer-requests.ts:507-546) with RAW lowercased dept comparison, then best-effort writes the Google Sheet cell via `updateMasterSheetDepartment` (src/lib/google-sheets/update-master-sheet-department.ts:121: `rowDept === from` EXACT match). **The out-of-HSL failure loop:** request says `from: "HSL"` but the sheet cell says `hsl:intake_specialist` (or vice versa) → sheet matcher misses (`updated: 0`) → transfer still marked applied (apply-transfer.ts:115) → next master sync re-imports the row keyed `(personal_email, department)` (global-master-list-db.ts:301-303), finds no match under either stale key, and **INSERTS a new row carrying the old HSL department** — the person "snaps back" into HSL. The daily 01:00 UTC cron (`vercel.json`, actor `Transfer Scheduler`) plus `planDepartmentApply`'s rule-3 fallback (moves ALL of a multi-row person's rows, :541-545) are the other unintended-write vectors.

**"HSL: Intake Specialist" appearing erroneously:** ManagerTransferDialog's target list IS the manager's raw `department_managers` grants (`myDepartments` = `teamGate.departments`, ManagerApp.tsx:455-463) — the access-control keyspace leaks into the roster keyspace. A TL whose sole grant is `hsl:intake_specialist` gets it as the SILENT DEFAULT target (ManagerTransferDialog.tsx:57,65), so people they pull in are labeled `hsl:intake_specialist` regardless of real sub-team, and the raw key renders everywhere un-prettified.

**"HRS" identity:** the Google service account `global-master-list-hris@global-master-list-hris.iam.gserviceaccount.com` (`GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL`, src/lib/google-sheets/auth.ts:40-49). It holds no logic — it is the credential under which the app's 10 sheet write-back modules act, so Google Sheets edit history attributes every Department cell flip to it. All five in-app sheet syncs stamp the SAME audit actor `GSheets Sync` and log only aggregate counters — a department flip is forensically invisible today.

**Weekend-premium day-scoping landmine:** `buildHslTransferEffectiveMap` (src/lib/payroll/hsl-transfer-effective.ts:32-48) counts ANY applied/approved transfer whose `to_department` normalizes to `hogan_smith_law` as an entry INTO HSL. A within-family move (`hsl:a` → `hsl:b`, or `HSL` → `hsl:a`) resets the person's HSL-effective date and mis-scopes their +₱15/h weekend premium. Any bulk relabel through the transfer table would poison this map — which is why Task 10's tool does NOT write transfer rows, and Task 6 fixes the map itself.

**Problem → root cause → task map:**

| Meeting problem | Root cause | Task |
|---|---|---|
| "HSL: Intake Specialist" appears erroneously | Access grants leak in as transfer targets + silent sole-grant default + raw keys rendered | 7 |
| Midweek transfers fail to move people out of HSL | Sheet write-back exact-match miss → sync re-inserts old-dept row | 5, 8, 9 |
| Main dept base rate vs sub-department rates confusion | Resolver collapses `hsl:*` → parent before sub keys can match; no sub-rate UI | 1–4, 11 |
| HRS making unintended changes | Sync identity key embeds Department; rule-3 all-rows fallback; one shared audit actor, no per-person detail | 5, 8, 9 |
| 510-person reorganization ("hard transfer") | No bulk assignment surface | 10, 11, 12 |

---

### Task 1: HSL sub-department helpers module

**Files:**
- Create: `src/lib/departments/hsl-subdept.ts`
- Test: `src/lib/departments/hsl-subdept.test.ts`

**Interfaces:**
- Consumes: `HSL_DEPT_KEYS`, `HSL_DEPTS`, `HslDeptKey` from `@/lib/hsl-bonus/schema`; `normalizeDeptToKey` from `@/lib/payroll/normalize-dept-key`.
- Produces (used by Tasks 2–10): `hslSubDeptLabel(key: HslDeptKey): string`, `hslSubKeyFromRaw(raw: string | null | undefined): HslDeptKey | null`, `isHslSubDeptLabel(raw: string | null | undefined): boolean`, `formatDeptLabel(raw: string | null | undefined): string`, `deptCellMatchesSource(cellRaw: string | null | undefined, fromRaw: string | null | undefined): boolean`, `deptCellSatisfiesTarget(cellRaw: string | null | undefined, toRaw: string | null | undefined): boolean`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/departments/hsl-subdept.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hslSubDeptLabel,
  hslSubKeyFromRaw,
  isHslSubDeptLabel,
  formatDeptLabel,
  deptCellMatchesSource,
  deptCellSatisfiesTarget,
} from './hsl-subdept';

test('hslSubKeyFromRaw parses canonical and sloppy labels', () => {
  assert.equal(hslSubKeyFromRaw('hsl:intake_specialist'), 'intake_specialist');
  assert.equal(hslSubKeyFromRaw('  HSL:Intake_Specialist '), 'intake_specialist');
  assert.equal(hslSubKeyFromRaw('hsl:not_a_team'), null); // unknown sub-key
  assert.equal(hslSubKeyFromRaw('HSL'), null); // family label, not a sub-team
  assert.equal(hslSubKeyFromRaw(null), null);
});

test('hslSubDeptLabel round-trips through hslSubKeyFromRaw', () => {
  assert.equal(hslSubDeptLabel('collections'), 'hsl:collections');
  assert.equal(hslSubKeyFromRaw(hslSubDeptLabel('case_managers')), 'case_managers');
});

test('formatDeptLabel prettifies sub-teams and passes everything else through', () => {
  assert.equal(formatDeptLabel('hsl:intake_specialist'), 'HSL — Intake Specialist');
  assert.equal(formatDeptLabel('hsl:ssd_medical_records'), 'HSL — SSD Medical Records');
  assert.equal(formatDeptLabel('Lead Gen'), 'Lead Gen');
  assert.equal(formatDeptLabel('Hogan Smith Law'), 'Hogan Smith Law');
  assert.equal(formatDeptLabel(null), '');
});

test('deptCellMatchesSource is HSL-family-aware and synonym-aware', () => {
  // A sub-team cell IS an HSL row when moving someone out of "HSL".
  assert.ok(deptCellMatchesSource('hsl:intake_specialist', 'HSL'));
  assert.ok(deptCellMatchesSource('HSL', 'hsl:collections'));
  assert.ok(deptCellMatchesSource('Hogan Smith Law', 'hsl:intake_specialist'));
  // Existing synonym behavior (deptMatchKey parity).
  assert.ok(deptCellMatchesSource('Callbacks', 'Callback Team'));
  // Different families never match.
  assert.equal(deptCellMatchesSource('Lead Gen', 'HSL'), false);
  // Unknown labels compare raw.
  assert.ok(deptCellMatchesSource('Medical Billing', 'medical billing'));
  assert.equal(deptCellMatchesSource('Medical Billing', 'Site Building'), false);
});

test('deptCellSatisfiesTarget requires EXACT cell for a sub-team target', () => {
  assert.ok(deptCellSatisfiesTarget('hsl:intake_specialist', 'hsl:intake_specialist'));
  assert.ok(deptCellSatisfiesTarget('HSL:Intake_Specialist', 'hsl:intake_specialist'));
  // Plain-HSL cell does NOT satisfy a sub-team target (that's the relabel we want).
  assert.equal(deptCellSatisfiesTarget('HSL', 'hsl:intake_specialist'), false);
  assert.equal(deptCellSatisfiesTarget('hsl:collections', 'hsl:intake_specialist'), false);
  // A sub-team cell DOES satisfy a plain-HSL target (never clobber a sub label
  // back to the generic family label).
  assert.ok(deptCellSatisfiesTarget('hsl:intake_specialist', 'HSL'));
  assert.ok(deptCellSatisfiesTarget('hsl:intake_specialist', 'Hogan Smith Law'));
  // Non-HSL targets keep family semantics.
  assert.ok(deptCellSatisfiesTarget('Callbacks', 'Callback Team'));
  assert.equal(deptCellSatisfiesTarget('Lead Gen', 'Callback Team'), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test src/lib/departments/hsl-subdept.test.ts`
Expected: FAIL — cannot find module `./hsl-subdept`.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/departments/hsl-subdept.ts
// HSL sub-department identity helpers.
//
// ONE canonical label unifies the three HSL keyspaces: the master-list
// Department cell `hsl:<HslDeptKey>` (same string as the department_managers
// access grant). These helpers are the single place that knows:
//   - which raw strings name a SPECIFIC sub-team vs the HSL family,
//   - how to display them ("HSL — Intake Specialist", never the raw key),
//   - how transfer/sheet matching treats them: family-aware on the SOURCE
//     side (an `hsl:*` cell is an "HSL" row when moving someone out), but
//     EXACT on a sub-team TARGET (sub-team identity is the whole point).
// Client-safe: constants + pure functions only.

import { HSL_DEPT_KEYS, HSL_DEPTS, type HslDeptKey } from '@/lib/hsl-bonus/schema';
import { normalizeDeptToKey } from '@/lib/payroll/normalize-dept-key';

/** Canonical master-list Department label for an HSL sub-department. */
export function hslSubDeptLabel(key: HslDeptKey): string {
  return `hsl:${key}`;
}

/** The HslDeptKey inside a raw `hsl:*` label, or null when the label is not a
 *  known sub-team (plain "HSL", unknown key, non-HSL label). */
export function hslSubKeyFromRaw(raw: string | null | undefined): HslDeptKey | null {
  const s = (raw ?? '').trim().toLowerCase();
  if (!s.startsWith('hsl:')) return null;
  const key = s.slice(4);
  return (HSL_DEPT_KEYS as readonly string[]).includes(key) ? (key as HslDeptKey) : null;
}

/** True when `raw` names a SPECIFIC HSL sub-team (not just the family). */
export function isHslSubDeptLabel(raw: string | null | undefined): boolean {
  return hslSubKeyFromRaw(raw) !== null;
}

/** Display label: `hsl:intake_specialist` → "HSL — Intake Specialist".
 *  Every other label passes through trimmed. */
export function formatDeptLabel(raw: string | null | undefined): string {
  const sub = hslSubKeyFromRaw(raw);
  if (sub) return `HSL — ${HSL_DEPTS[sub].name}`;
  return (raw ?? '').trim();
}

/** Family key for comparison: payroll synonym map first, raw lowercased label
 *  for departments the map doesn't know (mirrors stale-transfers deptMatchKey). */
function familyKey(raw: string | null | undefined): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return '';
  return normalizeDeptToKey(trimmed) ?? trimmed.toLowerCase();
}

/** SOURCE matching for transfers / sheet write-backs: does this Department
 *  cell count as a row in `fromRaw`? Family-aware — `hsl:intake_specialist`
 *  matches a move out of "HSL" and vice versa; "Callbacks" matches
 *  "Callback Team". */
export function deptCellMatchesSource(
  cellRaw: string | null | undefined,
  fromRaw: string | null | undefined,
): boolean {
  const cell = (cellRaw ?? '').trim().toLowerCase();
  const from = (fromRaw ?? '').trim().toLowerCase();
  if (!from || !cell) return false;
  if (cell === from) return true;
  const fk = familyKey(from);
  return !!fk && familyKey(cell) === fk;
}

/** TARGET satisfaction: is this Department cell already the requested target?
 *  A sub-team target demands the EXACT cell (a plain "HSL" cell still needs
 *  the relabel). A non-sub target keeps family semantics — notably, an
 *  `hsl:*` cell already satisfies a plain-"HSL" target, so a generic
 *  into-HSL transfer never clobbers an existing sub-team assignment. */
export function deptCellSatisfiesTarget(
  cellRaw: string | null | undefined,
  toRaw: string | null | undefined,
): boolean {
  const cell = (cellRaw ?? '').trim().toLowerCase();
  const to = (toRaw ?? '').trim().toLowerCase();
  if (!to || !cell) return false;
  if (cell === to) return true;
  if (isHslSubDeptLabel(to)) return false;
  const tk = familyKey(to);
  return !!tk && familyKey(cell) === tk;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test src/lib/departments/hsl-subdept.test.ts` → PASS. Then `npm run lint` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/departments/hsl-subdept.ts src/lib/departments/hsl-subdept.test.ts
git commit -m "feat(hsl): sub-department identity helpers (canonical hsl:<key> label)"
```

---

### Task 2: Rate engine — sub-department base rates resolve before the parent collapse

**Files:**
- Modify: `src/lib/payroll/resolve-rate.ts:131-150` (`resolveDeptCatalogRate`)
- Modify: `src/lib/payroll/current-pay.ts:957-961` (dept-label preference)
- Modify: `src/lib/payroll/disbursement-reports.ts:1002-1009` (build master dept map) and `:1189` (prefer it)
- Test: `src/lib/payroll/resolve-rate.test.ts` (extend)

**Interfaces:**
- Consumes: `hslSubKeyFromRaw`, `hslSubDeptLabel` from Task 1.
- Produces: `resolveDeptCatalogRate` now resolves a `payment_catalog_pay_structures` dept-scope row keyed `hsl:<sub>` for people whose raw label is that sub-team, falling back to `hogan_smith_law`. Signature unchanged — all 6 call sites inherit.

- [ ] **Step 1: Write the failing test** — append to `src/lib/payroll/resolve-rate.test.ts` (reuse its existing `FX` and structure-list pattern; add two structures to the `STRUCTURES` array):

```ts
// Add to STRUCTURES:
//   { id: 'd_hsl', scope: 'department', departmentKey: 'hogan_smith_law', regularRate: 100, currency: 'PHP' },
//   { id: 'd_hsl_intake', scope: 'department', departmentKey: 'hsl:intake_specialist', regularRate: 140, otRate: 155, currency: 'PHP' },

test('an hsl:<sub> label resolves its OWN base rate ahead of the parent', () => {
  const r = resolveDeptCatalogRate(index, 'hsl:intake_specialist', FX);
  assert.equal(r?.regNative, 140);
  assert.equal(r?.otNative, 155);
});

test('sub-team labels without their own structure fall back to the parent HSL base', () => {
  assert.equal(resolveDeptCatalogRate(index, 'hsl:collections', FX)?.regNative, 100);
});

test('plain HSL labels still resolve the parent base', () => {
  assert.equal(resolveDeptCatalogRate(index, 'HSL', FX)?.regNative, 100);
  assert.equal(resolveDeptCatalogRate(index, 'Hogan Smith Law', FX)?.regNative, 100);
});

test('with the parent base removed, sub rows still resolve and plain HSL is null', () => {
  const noParent = buildCatalogRateIndex(STRUCTURES.filter((s) => s.id !== 'd_hsl'));
  assert.equal(resolveDeptCatalogRate(noParent, 'hsl:intake_specialist', FX)?.regNative, 140);
  assert.equal(resolveDeptCatalogRate(noParent, 'HSL', FX), null);
});
```

- [ ] **Step 2: Run** `node --import tsx --test src/lib/payroll/resolve-rate.test.ts` — the first and last new tests FAIL (sub label collapses to parent).

- [ ] **Step 3: Implement.** In `resolveDeptCatalogRate`, before the existing `normalizeDeptToKey` chain, add:

```ts
import { hslSubKeyFromRaw, hslSubDeptLabel } from '@/lib/departments/hsl-subdept';
// ...inside resolveDeptCatalogRate, after the `if (!deptRaw) return null;` guard:
  // An HSL sub-team label (`hsl:<key>`) carries its OWN base rate; the parent
  // hogan_smith_law base is only the fallback. Must run BEFORE
  // normalizeDeptToKey, which collapses every hsl:* label to the parent key
  // and would make sub-team structures unreachable.
  const subKey = hslSubKeyFromRaw(deptRaw);
  if (subKey) {
    const sub = index.byDeptKey.get(hslSubDeptLabel(subKey));
    if (sub) return toResolved(sub, fx);
  }
```

(The rest of the function is unchanged; `hsl:collections` without a row falls through to `normalizeDeptToKey` → `hogan_smith_law`.)

- [ ] **Step 4: Thread the RAW master label to the engines that shadow it.** The HSL rates mirror hardcodes `employee_hourly_rates."Department" = "Hogan Smith Law"` (hsl-upload-db.ts:269), so the rates-row dept map must not win over the master label:
  - `current-pay.ts:959`: change `deptByEmail.get(em) ?? masterDeptByEmail.get(em) ?? null` → `masterDeptByEmail.get(em) ?? deptByEmail.get(em) ?? null`, with a one-line comment: `// Master label first: the HSL rates mirror stamps a flattened "Hogan Smith Law" onto rates rows, which would hide the hsl:<sub> label.`
  - `disbursement-reports.ts`: inside the existing `for (const m of masterRows)` loop at :1003-1009, also record `masterDeptByEmail` (new `Map<string, string>`; set for `we`/`pe` when `m["Department"]` is non-empty, first write wins). At :1189 change to `resolveDeptCatalogRate(catalogIndex, masterDeptByEmail.get(email) ?? deptByEmail.get(email) ?? null, fx)`.
  - `PayrollWizard.tsx:3748` (`row.department` from the rates row) is a known, acceptable residue: it only fires when the rates row has NO rates (`hasSheet` false), and an unresolved person surfaces on Readiness "No Pay Rate" rather than silently zero-paying. Note it in the Task 12 doc; do not touch the wizard here.

- [ ] **Step 5: Run** `node --import tsx --test src/lib/payroll/resolve-rate.test.ts` → PASS; `npm test` → no regressions; `npm run lint` → clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/payroll/resolve-rate.ts src/lib/payroll/resolve-rate.test.ts src/lib/payroll/current-pay.ts src/lib/payroll/disbursement-reports.ts
git commit -m "feat(catalog): per-sub-department HSL base rates resolve ahead of the parent"
```

---

### Task 3: Mirror the sub-first precedence in the Search-tab comp card and Accounting Transfers

The person comp card MUST mirror engine precedence exactly (that is its contract), and the Transfers "Rate change" column compares from/to dept bases.

**Files:**
- Modify: `src/lib/payment-catalog/person-comp.ts:128-130` (deptBase lookup only — `resolveRosterDeptKey` itself must keep returning `hogan_smith_law` because `deptKey` also drives dept-scope BONUS assignment matching at :147, and HSL bonuses stay keyed on the parent)
- Modify: `src/lib/transfers/accounting-transfers.ts:46-55` (`deptStructure`)
- Test: `src/lib/payment-catalog/person-comp.test.ts` (extend if present; create with the minimal harness below if not)

**Interfaces:**
- Consumes: `hslSubKeyFromRaw`, `hslSubDeptLabel` from Task 1.
- Produces: `computePersonComp(...).deptBase` prefers the `hsl:<sub>` structure; `resolveDeptRateChange` shows sub-team bases on transfer rows.

- [ ] **Step 1: Failing test** (person-comp): build a `PersonCompSubject` with `department: 'hsl:intake_specialist'` and indexes whose `deptStructByKey` has BOTH `hogan_smith_law` (reg 100) and `hsl:intake_specialist` (reg 140); assert `comp.deptBase?.regularRate === 140` and `comp.rateSource === 'department'`; assert a second subject labeled `'HSL'` gets 100. Mirror the shapes used by existing tests/types in person-comp.ts (aliases: `['x@simple.biz']`, no override, no sheet rate, `assignments: []`, `systemRows` inputs empty).

- [ ] **Step 2: Run it** — FAIL (deptBase = parent 100 for the sub-labeled person).

- [ ] **Step 3: Implement.**

person-comp.ts — replace line 130:

```ts
  // Sub-team base first, parent as fallback — MUST mirror resolveDeptCatalogRate
  // (Task 2). deptKey stays the PARENT key on purpose: dept-scoped bonus
  // assignments (below) remain keyed on hogan_smith_law.
  const subKey = hslSubKeyFromRaw(person.department);
  const deptBase =
    (subKey ? idx.deptStructByKey.get(hslSubDeptLabel(subKey)) : undefined) ??
    (deptKey ? idx.deptStructByKey.get(deptKey) : undefined);
```

accounting-transfers.ts — in `deptStructure`, before the existing `key` computation:

```ts
  const subKey = hslSubKeyFromRaw(deptRaw);
  if (subKey) {
    const sub = index.byDeptKey.get(hslSubDeptLabel(subKey));
    if (sub) return sub;
  }
```

- [ ] **Step 4: Run** the new test + `npm test` → PASS; `npm run lint` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/payment-catalog/person-comp.ts src/lib/payment-catalog/person-comp.test.ts src/lib/transfers/accounting-transfers.ts
git commit -m "feat(catalog): comp card + transfer rate-change mirror sub-department base precedence"
```

---

### Task 4: Pay Structure rail — HSL sub-departments become settable departments

**Files:**
- Modify: `src/components/accounting/BonusCatalog.tsx:1961-1967` (`allDepts` in `PayStructureTab`)
- Modify: `src/lib/supabase/department-rates.ts:94-105` (key→name map used by HR onboarding prefill)

**Interfaces:**
- Consumes: `HSL_DEPT_KEYS`, `HSL_DEPTS` (already imported in BonusCatalog for other tabs — check imports), `hslSubDeptLabel`, `formatDeptLabel` from Task 1.
- Produces: rail entries `{ key: 'hsl:<sub>', name: 'HSL — <Name>' }`; saving one writes a dept-scope `PayStructure` with `departmentKey: 'hsl:<sub>'` through the EXISTING `saveDept` path (BonusCatalog.tsx:2005-2015) — no API change needed, `pay_structures_dept_uniq` keys on `department_key` so each sub-team gets exactly one row.

- [ ] **Step 1: Implement the rail.** In `PayStructureTab`, extend `allDepts`:

```ts
  const allDepts = useMemo(
    () => [
      ...DEPARTMENTS.map((d) => ({ key: d.key, name: d.name })),
      // HSL sub-teams: each carries its own base rate (departmentKey = the
      // canonical `hsl:<key>` label). Listed right after the built-ins so they
      // sit visually under Hogan Smith Law in the rail.
      ...HSL_DEPT_KEYS.map((k) => ({ key: hslSubDeptLabel(k), name: `HSL — ${HSL_DEPTS[k].name}` })),
      ...extraDepartments,
    ],
    [extraDepartments],
  );
```

- [ ] **Step 2: HR onboarding prefill names.** In `department-rates.ts`, where dept keys resolve to display names (the map the agent-report pinned at :94-105), add the same `hsl:<key>` → `HSL — <Name>` entries so a sub-keyed structure surfaces with a human name instead of a raw slug. Follow the file's existing map-building idiom.

- [ ] **Step 2b: Hogan Payplan sheet special-case.** `app/api/payment-catalog/pay-structures/route.ts:30` defines `HOGAN_DEPT_KEY = 'hogan_smith_law'` and (per the rate-history sync at :119-127) mirrors employee-scope saves to the Hogan Agents Pay Plan sheet only when `departmentKey === HOGAN_DEPT_KEY`. Once the rail exposes sub-team keys, an INDIVIDUAL structure saved under `hsl:<sub>` must count as Hogan too: change that check to `departmentKey === HOGAN_DEPT_KEY || isHslSubDeptLabel(departmentKey)` (import from `@/lib/departments/hsl-subdept`). Grep the route for every other `HOGAN_DEPT_KEY` comparison and apply the same widening.

- [ ] **Step 3: Manual verification.** `npm run dev` (or use the running dev server): Payment Catalog → Pay Structure → rail shows 12 "HSL — …" entries; set a rate on one; confirm it appears with the green "Department rate set" dot and survives reload. Delete it afterwards (this is production data — or leave it if Kane wants the seed to start now).

- [ ] **Step 4: Lint + commit**

```bash
npm run lint
git add src/components/accounting/BonusCatalog.tsx src/lib/supabase/department-rates.ts "app/api/payment-catalog/pay-structures/route.ts"
git commit -m "feat(catalog): HSL sub-departments settable on the Pay Structure rail"
```

---

### Task 5: Transfer apply — family-aware source matching, exact sub-team targets, no more all-rows collapse

**Files:**
- Modify: `src/lib/supabase/department-transfer-requests.ts:507-546` (`planDepartmentApply`)
- Modify: `src/lib/transfers/apply-transfer.ts:84` (cancel note covers the new ambiguous case)
- Test: `src/lib/supabase/department-transfer-requests.test.ts` (extend)

**Interfaces:**
- Consumes: `deptCellMatchesSource`, `deptCellSatisfiesTarget` from Task 1.
- Produces: same `ApplyPlan` shape; `applyDepartmentTransfer` and both its callers unchanged.

- [ ] **Step 1: Failing tests** (append; follow the file's existing row-builder helpers):

```ts
test('out-of-HSL: a sub-team cell matches a from:"HSL" request', () => {
  const rows = [{ id: 1, dept: 'hsl:intake_specialist', workEmail: 'a@simple.biz' }];
  assert.deepEqual(planDepartmentApply(rows, 'HSL', 'Lead Gen'), {
    resolution: 'moved', moveIds: [1], deleteIds: [],
  });
});

test('into a sub-team: plain-HSL cell is a source row, not "satisfied"', () => {
  const rows = [{ id: 1, dept: 'HSL', workEmail: 'a@simple.biz' }];
  assert.deepEqual(planDepartmentApply(rows, 'HSL', 'hsl:intake_specialist'), {
    resolution: 'moved', moveIds: [1], deleteIds: [],
  });
});

test('within HSL: already in the exact sub-team is satisfied', () => {
  const rows = [{ id: 1, dept: 'hsl:intake_specialist', workEmail: 'a@simple.biz' }];
  assert.equal(
    planDepartmentApply(rows, 'hsl:collections', 'hsl:intake_specialist').resolution,
    'satisfied',
  );
});

test('generic into-HSL never clobbers an existing sub-team label', () => {
  const rows = [{ id: 1, dept: 'hsl:intake_specialist', workEmail: 'a@simple.biz' }];
  assert.equal(planDepartmentApply(rows, 'Lead Gen', 'Hogan Smith Law').resolution, 'satisfied');
});

test('two family source rows moving to one target: one moves, dupes are pruned', () => {
  const rows = [
    { id: 1, dept: 'HSL', workEmail: 'a@simple.biz' },
    { id: 2, dept: 'hsl:collections', workEmail: 'a@simple.biz' },
  ];
  const plan = planDepartmentApply(rows, 'HSL', 'hsl:intake_specialist');
  assert.equal(plan.resolution, 'moved');
  assert.equal(plan.moveIds.length, 1);
  assert.equal(plan.deleteIds.length, 1);
});

test('reconcile fallback only relabels a SINGLE-row person; multi-row is notFound', () => {
  const single = [{ id: 1, dept: 'Edit Team', workEmail: 'a@simple.biz' }];
  assert.equal(planDepartmentApply(single, 'Lead Gen', 'QC').resolution, 'moved');
  const dual = [
    { id: 1, dept: 'Edit Team', workEmail: 'a@simple.biz' },
    { id: 2, dept: 'Devs', workEmail: 'a2@simple.biz' },
  ];
  assert.equal(planDepartmentApply(dual, 'Lead Gen', 'QC').resolution, 'notFound');
});
```

- [ ] **Step 2: Run** `node --import tsx --test src/lib/supabase/department-transfer-requests.test.ts` — new tests FAIL.

- [ ] **Step 3: Reimplement `planDepartmentApply`** (keep the doc comment, updating rules 1–4):

```ts
export function planDepartmentApply(
  candidates: CandidateMasterRow[],
  fromDepartment: string,
  toDepartment: string,
): ApplyPlan {
  const weKey = (v: string | null | undefined) => (v ?? '').trim().toLowerCase();
  if (candidates.length === 0) return { resolution: 'notFound', moveIds: [], deleteIds: [] };

  // Rows already satisfying the target. Sub-team targets need the EXACT cell;
  // everything else matches by family, so "Callbacks" satisfies "Callback Team"
  // and an hsl:<sub> cell satisfies a generic "HSL" target (no clobber).
  const satisfied = candidates.filter((r) => deptCellSatisfiesTarget(r.dept, toDepartment));

  // Source rows: family-aware — an `hsl:*` cell IS an "HSL" row when moving the
  // person out (and vice versa). Rows already satisfying the target are not
  // source rows even when the same family (within-HSL moves).
  const sourceRows = candidates.filter(
    (r) =>
      !deptCellSatisfiesTarget(r.dept, toDepartment) &&
      deptCellMatchesSource(r.dept, fromDepartment),
  );

  if (sourceRows.length > 0) {
    const moveIds: Array<string | number> = [];
    const deleteIds: Array<string | number> = [];
    // (work email, target) slots already taken — by a row sitting in the target
    // OR by an earlier source row in this same plan (two source rows moving to
    // one target would collide on global_master_list_work_email_dept_uniq).
    const claimed = new Set(satisfied.map((r) => weKey(r.workEmail)).filter(Boolean));
    for (const r of sourceRows) {
      const we = weKey(r.workEmail);
      if (we && claimed.has(we)) deleteIds.push(r.id);
      else {
        if (we) claimed.add(we);
        moveIds.push(r.id);
      }
    }
    if (moveIds.length === 0) return { resolution: 'satisfied', moveIds: [], deleteIds };
    return { resolution: 'moved', moveIds, deleteIds };
  }

  if (satisfied.length > 0) return { resolution: 'satisfied', moveIds: [], deleteIds: [] };

  // Reconcile fallback (label drift): ONLY safe for a single-row person.
  // Relabeling every row of a multi-department person collapsed dual-role
  // people into one department (the "HRS unintended changes" incident class).
  if (candidates.length === 1) {
    return { resolution: 'moved', moveIds: [candidates[0].id], deleteIds: [] };
  }
  return { resolution: 'notFound', moveIds: [], deleteIds: [] };
}
```

Import the two helpers at the top of the file: `import { deptCellMatchesSource, deptCellSatisfiesTarget } from '@/lib/departments/hsl-subdept';`

- [ ] **Step 4: Update the auto-cancel note** in apply-transfer.ts:84 so `notFound` no longer claims off-boarding as the only cause:

```ts
    const note = `Auto-cancelled: ${who} can't be moved to ${row.to_department} automatically — either they're no longer on the active roster (off-boarded / email changed), or they hold rows in multiple departments none of which matches ${row.from_department}. Resolve on the People roster, then re-raise if needed.`;
```

- [ ] **Step 5: Run** the file's tests + `npm test` (existing cases like the Ivan Lead Gen→hsl:intake_specialist reconcile must still pass — that person is single-row) → PASS. `npm run lint` → clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/supabase/department-transfer-requests.ts src/lib/supabase/department-transfer-requests.test.ts src/lib/transfers/apply-transfer.ts
git commit -m "fix(transfers): HSL-family-aware apply; exact sub-team targets; no multi-row collapse"
```

---

### Task 6: Weekend-premium map — within-family moves are NOT entries into HSL

**Files:**
- Modify: `src/lib/payroll/hsl-transfer-effective.ts` (`HslTransferRowLike`, `buildHslTransferEffectiveMap`, `fetchHslTransferEffectiveByEmail` select)
- Test: `src/lib/payroll/hsl-week-model.test.ts` or a new `src/lib/payroll/hsl-transfer-effective.test.ts` (preferred — the builder is pure)

**Interfaces:**
- Produces: `buildHslTransferEffectiveMap` ignores rows whose `from_department` already normalizes to `hogan_smith_law` (a sub-team reshuffle or plain→sub relabel must not reset the person's weekend-premium effective date). `HslTransferRowLike` gains `from_department: string | null`.

- [ ] **Step 1: Failing test**

```ts
// src/lib/payroll/hsl-transfer-effective.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHslTransferEffectiveMap } from './hsl-transfer-effective';

const base = { employee_work_email: null, status: 'applied' };

test('a genuine entry into HSL sets the effective date', () => {
  const m = buildHslTransferEffectiveMap([
    { ...base, employee_email: 'a@x.com', from_department: 'Lead Gen', to_department: 'hsl:intake_specialist', effective_date: '2026-08-05' },
  ]);
  assert.equal(m.get('a@x.com'), '2026-08-05');
});

test('a within-HSL reshuffle does NOT reset the effective date', () => {
  const m = buildHslTransferEffectiveMap([
    { ...base, employee_email: 'a@x.com', from_department: 'Lead Gen', to_department: 'HSL', effective_date: '2026-01-05' },
    { ...base, employee_email: 'a@x.com', from_department: 'HSL', to_department: 'hsl:intake_specialist', effective_date: '2026-08-05' },
    { ...base, employee_email: 'a@x.com', from_department: 'hsl:intake_specialist', to_department: 'hsl:collections', effective_date: '2026-08-12' },
  ]);
  assert.equal(m.get('a@x.com'), '2026-01-05');
});
```

- [ ] **Step 2: Run it** — FAIL (compile error on `from_department`, then value mismatch).

- [ ] **Step 3: Implement.** Add `from_department: string | null;` to `HslTransferRowLike`; in the builder's loop, after the `to_department` check, add:

```ts
    // A move that STARTED inside the HSL family (sub-team reshuffle, plain→sub
    // relabel) is not an entry into HSL — counting it would reset the weekend
    // premium's day-scoping for a long-tenured HSL person.
    if (normalizeDeptToKey(r.from_department ?? '') === 'hogan_smith_law') continue;
```

Add `from_department` to the `.select(...)` in `fetchHslTransferEffectiveByEmail`. Check the OTHER consumer of this map's fetch path (`GET /api/payroll/hsl-transfers-bulk`, per the file header) — if that route does its own select, add the column there too.

- [ ] **Step 4: Run** new test + `npm test` (hsl-week-model / prorate tests must stay green) → PASS. `npm run lint`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/payroll/hsl-transfer-effective.ts src/lib/payroll/hsl-transfer-effective.test.ts
git commit -m "fix(hsl): within-family transfers no longer reset weekend-premium effective dates"
```

Also `git add` the bulk API route file if it needed the select change.

---

### Task 7: Transfer surfaces — labeled sub-team targets, no raw access-key leakage, family-aware release queues

**Files:**
- Modify: `src/components/manager/ManagerTransferDialog.tsx` (target options/labels lines 104-107, 204-208, 246-260, 264-279; candidate dept rendering 171, 231-234)
- Modify: `src/lib/supabase/department-transfer-requests.ts:194-243` (`listIncomingTransfersForDepartments`, `listResolvedTransfersForDepartments`)
- Modify (display-only, `formatDeptLabel` on dept strings): `src/components/manager/ManagerTransfers.tsx`, `src/components/hr/HrTransfers.tsx`, `src/components/accounting/AccountingTransfers.tsx`
- Test: extend `src/lib/supabase/department-transfer-requests.test.ts` with the pure queue-ownership helper

**Interfaces:**
- Consumes: `hslSubKeyFromRaw`, `hslSubDeptLabel`, `formatDeptLabel`, `deptCellMatchesSource` from Task 1; `HSL_DEPT_KEYS`, `HSL_DEPTS`, `normalizeDeptToKey`.
- Produces: `managerOwnsSourceDept(managedDepts: string[], fromDepartment: string): boolean` exported from `department-transfer-requests.ts` (pure, testable) and used by both list functions in place of the raw `Set.has` filter.

- [ ] **Step 1: Failing tests** for the ownership rule:

```ts
test('managerOwnsSourceDept: raw match, parent-HSL sees all family, sub grant sees its own', () => {
  // Raw/exact.
  assert.ok(managerOwnsSourceDept(['Lead Gen'], 'lead gen'));
  // Parent grant sees any HSL-family source, whatever the label variant.
  assert.ok(managerOwnsSourceDept(['Hogan Smith Law'], 'hsl:intake_specialist'));
  assert.ok(managerOwnsSourceDept(['HSL'], 'Hogan Smith Law'));
  // A sub grant sees exactly its own sub-team…
  assert.ok(managerOwnsSourceDept(['hsl:intake_specialist'], 'HSL:Intake_Specialist'));
  // …but not siblings, and not the whole family.
  assert.equal(managerOwnsSourceDept(['hsl:intake_specialist'], 'hsl:collections'), false);
  assert.equal(managerOwnsSourceDept(['hsl:intake_specialist'], 'HSL'), false);
  assert.equal(managerOwnsSourceDept(['Lead Gen'], 'HSL'), false);
});
```

- [ ] **Step 2: Run** — FAIL (function doesn't exist).

- [ ] **Step 3: Implement the helper + wire the two list functions.**

```ts
/** Does one of the manager's department grants own release requests whose
 *  source is `fromDepartment`? Raw match first; a PARENT Hogan Smith Law
 *  grant owns every HSL-family source (sub-teams included); an `hsl:<sub>`
 *  grant owns exactly that sub-team. */
export function managerOwnsSourceDept(managedDepts: string[], fromDepartment: string): boolean {
  const from = fromDepartment.trim().toLowerCase();
  if (!from) return false;
  const fromSub = hslSubKeyFromRaw(from);
  const fromIsHslFamily = normalizeDeptToKey(from) === 'hogan_smith_law';
  for (const d of managedDepts) {
    const g = d.trim().toLowerCase();
    if (!g) continue;
    if (g === from) return true;
    const grantSub = hslSubKeyFromRaw(g);
    if (grantSub && fromSub && grantSub === fromSub) return true; // label-case variants
    // Parent grant (any alias of Hogan Smith Law that is NOT itself a sub grant).
    if (!grantSub && normalizeDeptToKey(g) === 'hogan_smith_law' && fromIsHslFamily) return true;
  }
  return false;
}
```

In `listIncomingTransfersForDepartments` and `listResolvedTransfersForDepartments`, replace the `wanted.has(r.from_department...)` filters with `managerOwnsSourceDept(departments, r.from_department)` (drop the `wanted` sets; keep the early return when `departments` is empty).

- [ ] **Step 4: Fix the dialog.** In `ManagerTransferDialog.tsx`:
  1. **Expand parent grants into labeled sub-team targets.** Above `targetOptions`, derive the option list from `myDepartments`: map each grant `d` → if `hslSubKeyFromRaw(d)` → `{ value: hslSubDeptLabel(sub), label: formatDeptLabel(d) }`; if `normalizeDeptToKey(d) === 'hogan_smith_law'` and it is not a sub grant → expand to ALL twelve `{ value: hslSubDeptLabel(k), label: 'HSL — ' + HSL_DEPTS[k].name }` entries (a transfer INTO HSL must now land in a specific sub-team; the plain family label stays out of the target list); otherwise `{ value: d, label: d }`. Dedupe by value.
  2. **Kill the silent raw default.** `soleDept` (line 57): compute from the EXPANDED option list — default only when exactly one option remains; a parent-HSL manager (12 options) now always picks explicitly.
  3. **Labels everywhere:** target `SmoothSelect` options use `label`; the current→target preview chips (lines 248, 258) and candidate department lines (171, 231-234) render through `formatDeptLabel(...)`. Submitted `to_department` remains the option's canonical `value`.
- [ ] **Step 5: Display labels on the three list surfaces.** In `ManagerTransfers.tsx`, `HrTransfers.tsx`, `AccountingTransfers.tsx`: wrap every rendered `from_department` / `to_department` (and the dept filter option labels — keep option values raw so filtering still matches rows) in `formatDeptLabel(...)`. Search/`localeCompare` logic stays on raw values.
- [ ] **Step 6: Run** `npm test` + `npm run lint`; manual check on dev: an admin-viewed transfer list shows "HSL — Intake Specialist" chips; the dialog for a multi-dept manager lists labeled options.
- [ ] **Step 7: Commit**

```bash
git add src/lib/supabase/department-transfer-requests.ts src/lib/supabase/department-transfer-requests.test.ts src/components/manager/ManagerTransferDialog.tsx src/components/manager/ManagerTransfers.tsx src/components/hr/HrTransfers.tsx src/components/accounting/AccountingTransfers.tsx
git commit -m "fix(transfers): labeled HSL sub-team targets, explicit selection, family-aware release queues"
```

---

### Task 8: Sheet write-back — family-aware source matching

**Files:**
- Modify: `src/lib/google-sheets/update-master-sheet-department.ts:115-125`
- Test: `src/lib/google-sheets/update-master-sheet-department.test.ts` (new — test the extracted pure matcher)

**Interfaces:**
- Consumes: `deptCellMatchesSource`, `deptCellSatisfiesTarget` from Task 1.
- Produces: exported pure helper `sheetRowNeedsDeptFlip(rowDept: string, from: string, to: string): boolean`; the fetch loop uses it in place of `rowDept === from`.

- [ ] **Step 1: Failing test**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { sheetRowNeedsDeptFlip } from './update-master-sheet-department';

test('sheet cell flips on family match, skips rows already at the target', () => {
  // Out of HSL: cell holds a sub label the request never knew about.
  assert.ok(sheetRowNeedsDeptFlip('hsl:intake_specialist', 'hsl', 'lead gen'));
  assert.ok(sheetRowNeedsDeptFlip('hogan smith law', 'hsl:collections', 'lead gen'));
  // Into a sub-team: plain-HSL cell must flip…
  assert.ok(sheetRowNeedsDeptFlip('hsl', 'hsl', 'hsl:intake_specialist'));
  // …but a cell already at the exact sub-team must not be rewritten.
  assert.equal(sheetRowNeedsDeptFlip('hsl:intake_specialist', 'hsl', 'hsl:intake_specialist'), false);
  // Unrelated rows never flip.
  assert.equal(sheetRowNeedsDeptFlip('lead gen', 'hsl', 'edit team'), false);
});
```

- [ ] **Step 2: Run** — FAIL. **Step 3: Implement:**

```ts
/** Should this sheet row's Department cell flip to `to`? Family-aware on the
 *  source (an hsl:* cell IS an "HSL" row) and target-aware so a cell already
 *  satisfying the target — e.g. already the exact sub-team — is left alone.
 *  Inputs arrive lowercased/trimmed by the caller (`norm`). Exported for tests. */
export function sheetRowNeedsDeptFlip(rowDept: string, from: string, to: string): boolean {
  return deptCellMatchesSource(rowDept, from) && !deptCellSatisfiesTarget(rowDept, to);
}
```

In the row loop (:121), replace `if (matchEmail && rowDept === from)` with `if (matchEmail && sheetRowNeedsDeptFlip(rowDept, from, norm(to)))`.

- [ ] **Step 4: Run** test + `npm run lint`. **Step 5: Commit**

```bash
git add src/lib/google-sheets/update-master-sheet-department.ts src/lib/google-sheets/update-master-sheet-department.test.ts
git commit -m "fix(sheets): dept write-back matches source rows family-aware (unsticks out-of-HSL moves)"
```

---

### Task 9: Master sync — stop re-inserting stale-dept rows for freshly transferred people; forensic audit detail

**Files:**
- Modify: `src/lib/supabase/global-master-list-db.ts` (`replaceGlobalMasterListFromCsvText` — insert-candidate stage ~:794-803; dept-change collection in the update stage; new pure helper near the top)
- Modify: `app/api/cron/sync-master-from-sheet/route.ts:9` (actor) and `:123-145` (audit details)
- Modify (actors only): `app/api/cron/sync-hsl-from-sheet/route.ts:8`, `sync-rates-from-sheet/route.ts:8`, `sync-offboarded-from-sheet/route.ts:10`, `sync-screening-from-sheet/route.ts:9`
- Test: `src/lib/supabase/global-master-list-db.test.ts` (extend or create for the pure helper)

**Interfaces:**
- Produces: pure `isStaleTransferredSheetRow(args: { sheetDept: string; existingDeptsForPerson: string[]; recentTransfers: Array<{ from_department: string; to_department: string }> }): boolean`; sync counters gain `skipped_stale_transferred`; audit details gain `department_changes: Array<{ email, name, from, to }>` (capped at 200 entries).

- [ ] **Step 1: Failing test** for the pure decision:

```ts
test('a sheet row matching a recent transfer\'s FROM dept, when the person already sits in its TO dept, is stale', () => {
  assert.ok(isStaleTransferredSheetRow({
    sheetDept: 'hsl:intake_specialist',
    existingDeptsForPerson: ['Lead Gen'],
    recentTransfers: [{ from_department: 'HSL', to_department: 'Lead Gen' }],
  }));
  // No matching transfer → not stale (a genuinely new second role must insert).
  assert.equal(isStaleTransferredSheetRow({
    sheetDept: 'Edit Team',
    existingDeptsForPerson: ['Lead Gen'],
    recentTransfers: [{ from_department: 'HSL', to_department: 'Lead Gen' }],
  }), false);
  // Person not yet in the transfer's target → not stale either.
  assert.equal(isStaleTransferredSheetRow({
    sheetDept: 'HSL',
    existingDeptsForPerson: ['Edit Team'],
    recentTransfers: [{ from_department: 'HSL', to_department: 'Lead Gen' }],
  }), false);
});
```

- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.**

```ts
import { deptCellMatchesSource, deptCellSatisfiesTarget } from '@/lib/departments/hsl-subdept';

/** True when a sheet row that WOULD insert as a "new" person+dept row is
 *  really the pre-transfer echo of a recently APPLIED transfer: the sheet
 *  still shows the transfer's source dept while the DB row already sits in
 *  its target. Inserting it would resurrect the old department (the classic
 *  "the system moved them back into HSL" report). */
export function isStaleTransferredSheetRow(args: {
  sheetDept: string;
  existingDeptsForPerson: string[];
  recentTransfers: Array<{ from_department: string; to_department: string }>;
}): boolean {
  for (const t of args.recentTransfers) {
    if (!deptCellMatchesSource(args.sheetDept, t.from_department)) continue;
    if (args.existingDeptsForPerson.some((d) => deptCellSatisfiesTarget(d, t.to_department))) return true;
  }
  return false;
}
```

Wire-up inside `replaceGlobalMasterListFromCsvText`:
  1. Load once per sync: applied transfers from the last 30 days — `department_transfer_requests` where `status = 'applied'` and `applied_at >= now()-30d`, selecting `employee_email, employee_work_email, employee_personal_email, from_department, to_department`; index by each lowercased email.
  2. Before pushing a row into `insertCandidates`: if any of its emails matches an ACTIVE existing person (reuse the maps the function already builds for its two identity passes), call the helper with that person's current dept labels and their recent transfers; on `true`, skip the insert, increment `skippedStaleTransferred`, and record `{ email, name, sheetDept, transferTo }` in a capped (≤200) `stale_transferred` details array.
  3. In the update stage, wherever an existing row's `"Department"` is about to change, push `{ email, name, from, to }` into a capped (≤200) `departmentChanges` array.
  4. Return both arrays + the counter to the route; the route includes them in the audit `details` (:123-145).
- [ ] **Step 4: Distinct actors.** Change the five routes' actor constants to `GSheets Master Sync`, `GSheets HSL Sync`, `GSheets Rates Sync`, `GSheets Offboarded Sync`, `GSheets Screening Sync` (keep `user_role: 'System'`). Grep first for any dashboard filtering on the literal `'GSheets Sync'` (`grep -r "GSheets Sync" src app`) and update those match sites to prefix-match `GSheets` so history remains visible.
- [ ] **Step 5: Run** tests + `npm run lint`; trigger one manual master sync from Admin CSV Imports on dev and confirm the audit row shows the new actor + `department_changes`.
- [ ] **Step 6: Commit**

```bash
git add src/lib/supabase/global-master-list-db.ts src/lib/supabase/global-master-list-db.test.ts "app/api/cron/sync-master-from-sheet/route.ts" "app/api/cron/sync-hsl-from-sheet/route.ts" "app/api/cron/sync-rates-from-sheet/route.ts" "app/api/cron/sync-offboarded-from-sheet/route.ts" "app/api/cron/sync-screening-from-sheet/route.ts"
git commit -m "fix(sync): transfer-aware stale-row guard + per-person dept-change audit + distinct sync actors"
```

---

### Task 10: Bulk sub-department assignment tool (the Saturday "hard transfer" surface)

**Files:**
- Create: `app/api/hr/hsl-subdept-assignments/route.ts`
- Create: `src/components/accounting/HslSubDeptAssignPanel.tsx`
- Modify: `src/components/accounting/DepartmentsTab.tsx` (mount the panel as a pinned "Hogan Smith Law — sub-departments" section above the custom-department cards)

**Interfaces:**
- Consumes: `applyDepartmentTransfer` + `updateMasterSheetDepartment` (Tasks 5/8 make both sub-team-correct), `hslSubDeptLabel`, `formatDeptLabel`, `HSL_DEPT_KEYS`, `HSL_DEPTS`, `insertAuditLogs`.
- Produces: `POST /api/hr/hsl-subdept-assignments` with body `{ dryRun: boolean, assignments: Array<{ workEmail: string | null; personalEmail: string | null; name: string; subDeptKey: HslDeptKey }> }` → ndjson stream of per-person results `{ email, name, target, resolution: 'moved'|'satisfied'|'notFound'|'error', sheetSynced: boolean, error?: string }`; `GET` returns the HSL pool `{ people: Array<{ name, workEmail, personalEmail, department, subDeptKey: HslDeptKey | null, hslRole: string | null }> }`.

**Design rules (all load-bearing):**
- **Never writes `department_transfer_requests`** — a hard relabel is not a transfer request, and inserting applied rows would poison the weekend-premium effective-date map even after Task 6 (a plain→sub relabel is within-family, but keep the ledger clean).
- Auth: copy the gate used by `app/api/department-transfers/route.ts` (read that file first and mirror its session/role check exactly), additionally allowing the elevated accounting/admin roles that can already see the Payment Catalog.
- Per person: call `applyDepartmentTransfer({ personalEmail, workEmail, fromDepartment: currentDept, toDepartment: hslSubDeptLabel(subDeptKey) })` where `currentDept` is the person's live master label fetched server-side (do NOT trust a client-sent from-dept); then `updateMasterSheetDepartment` with the same args; then one `audit_log` row per person: `action: 'hsl.subdept.assign'`, `resource: 'global_master_list'`, `resource_id: workEmail ?? personalEmail`, details `{ from, to, sheetSynced, dryRun: false }`, actor = the signed-in user (NOT a system actor — this is Olivia's action).
- `dryRun: true` runs the same candidate fetch + `planDepartmentApply` and streams what WOULD happen (`resolution`, current label) without writing DB, Sheet, or audit.
- GET pool = active master rows whose Department normalizes to `hogan_smith_law`, joined best-effort to `active_hsl_agents` for `hsl_role` (the existing opt-in join in `/api/manager/department-members` shows the pattern — reuse its query shape); `subDeptKey` = `hslSubKeyFromRaw(department)`.

**UI (`HslSubDeptAssignPanel`):** header with counts (`assigned` = rows with `subDeptKey`, `unassigned` = plain-HSL rows); a table of unassigned people (name, work email, `hsl_role` hint) with a per-row sub-team `SmoothSelect` (options = the 12 labeled sub-teams) plus a "set all filtered to…" bulk selector and a search box; footer buttons **Preview** (dryRun POST, renders per-person planned resolutions inline) and **Apply** (disabled until a Preview ran on the current selection; confirmation dialog stating the count and that the Google Sheet will be updated as `global-master-list-hris@…`); streams results row-by-row (the ndjson pattern used by `CREATE_DEPARTMENT_STAGES` in DepartmentsTab is the reference). An "Assigned" collapsed section lists current sub-team membership with per-person "Move to…" using the same POST. Export CSV button downloads the GET pool as `hsl-subdept-assignments.csv`.

- [ ] **Step 1:** Read `app/api/department-transfers/route.ts` and `/api/manager/department-members` for the auth gate + HSL join patterns; build the API route (GET + POST, dryRun first-class). Type-check.
- [ ] **Step 2:** Build the panel; wire into DepartmentsTab.
- [ ] **Step 3:** Manual dev verification: GET pool loads (>0 people, counts sane); dry-run Preview on 2–3 test people shows `moved` with correct targets; **do NOT Apply against production** outside the cutover window unless Kane says so.
- [ ] **Step 4:** `npm run lint`; commit:

```bash
git add "app/api/hr/hsl-subdept-assignments/route.ts" src/components/accounting/HslSubDeptAssignPanel.tsx src/components/accounting/DepartmentsTab.tsx
git commit -m "feat(hsl): bulk sub-department assignment tool (dry-run + sheet write-back + audit)"
```

---

### Task 11: Cutover scripts — seed sub-department base rates, then remove the parent rate

**Files:**
- Create: `scripts/seed-hsl-subdept-rates.mts`
- Create: `scripts/remove-hsl-parent-base-rate.mts`

**Interfaces:**
- Consumes: `payment_catalog_pay_structures` via the service-role client pattern used by existing `scripts/*.mts` (copy the env-loading preamble from `scripts/clear-stuck-transfers.mts`); `HSL_DEPT_KEYS`.
- Produces: dept-scope rows keyed `hsl:<key>`; backups under `exports/`.

**seed-hsl-subdept-rates.mts:**
- Rates come from a JSON file passed as `--rates <path>`: `{ "intake_specialist": { "regularRate": 0, "otRate": 0, "currency": "PHP" }, ... }` — the script REFUSES to run if any of the 12 `HSL_DEPT_KEYS` is missing from the file or any rate is not a positive finite number (Kane fills in the real figures; NO invented defaults).
- Flow: backup all `scope='department'` rows to `exports/pay-structures-dept-backup-<ISO>.json` → for each key, upsert `{ scope:'department', department_key: 'hsl:'+key, regular_rate, ot_rate, currency }` respecting the natural-key slot (SELECT existing dept row for that key; reuse its `id` if present, else a fresh id via the same `pay_<ts><rand>` shape as `newPayId`).
- Dry-run default (prints the plan table); `--apply` writes.

**remove-hsl-parent-base-rate.mts:**
- Preconditions (hard-fail without `--force`): (1) every one of the 12 `hsl:<key>` dept-scope rows exists; (2) the count of ACTIVE `global_master_list` rows whose Department is a plain-family label (`normalizeDeptToKey(dept)==='hogan_smith_law'` AND not an `hsl:*` sub label) is printed, and must be 0 — anyone still unassigned would lose their base-rate fallback.
- Flow: backup the `hogan_smith_law` dept-scope row to `exports/`, then DELETE it. Dry-run default; `--apply` writes.
- Both scripts print a re-verification epilogue (row counts after write).

- [ ] **Step 1:** Write both scripts following the repo's `.mts` script conventions (check `scripts/clear-stuck-transfers.mts` for the supabase client + argv pattern).
- [ ] **Step 2:** Verify DRY-RUN ONLY against production: `npx tsx scripts/seed-hsl-subdept-rates.mts --rates <sample>` with a complete sample file → plan table prints, no writes; `npx tsx scripts/remove-hsl-parent-base-rate.mts` → precondition report prints (expected: sub-rows missing, unassigned count ≈ full HSL headcount — correct refusal).
- [ ] **Step 3: Commit**

```bash
git add scripts/seed-hsl-subdept-rates.mts scripts/remove-hsl-parent-base-rate.mts
git commit -m "feat(hsl): cutover scripts — seed sub-dept base rates, gated parent-rate removal"
```

---

### Task 12: Feature doc + Saturday cutover runbook

**Files:**
- Create: `docs/features/hsl-subdepartments.md`

Contents (write it fully, not as stubs): the canonical-label model (`hsl:<key>` = dept label = access grant, display `HSL — <Name>`); the rate resolution chain with the sub-first rule and the parent-fallback guarantee; the transfer matching semantics (family-aware source / exact sub target / single-row reconcile rule); what the HRS service account is and how to read the new audit actors + `department_changes` details; the wizard 3748 residue note from Task 2; adding a NEW sub-team checklist (2 edits in `hsl-bonus/schema.ts` + `hsl_team_members.dept_key` SQL + Payplan sync + grants + catalog rate row); and this runbook:

**Saturday cutover runbook (system quiet):**
1. Confirm Tasks 1–11 are deployed. Manual master-sheet sync; verify audit actor `GSheets Master Sync` and zero unexplained `department_changes`.
2. Kane prepares the rates JSON; run `seed-hsl-subdept-rates.mts` dry → review → `--apply`. Verify the 12 rows on the Pay Structure rail.
3. Olivia assigns everyone via the new panel: Preview (dry-run) → export CSV for the record → Apply. Spot-check 5 people in the Google Sheet (cells flipped to `hsl:<key>` by the service account) and on People/My Team (label reads `HSL — …`).
4. Run one manual master sync and confirm `skipped_stale_transferred = 0` and no new plain-HSL inserts.
5. `remove-hsl-parent-base-rate.mts` dry → preconditions green (unassigned = 0) → `--apply`.
6. Post-checks: Payroll Readiness "No Pay Rate" count unchanged or explained; Payment Catalog Search comp card for one person per sub-team shows `rateSource: department` with the sub-team rate; Overview PAB calendar + wizard tabs still group everyone under HSL.
7. Rollback: re-insert the parent row from the `exports/` backup (single upsert) — everything falls back to the parent instantly; assignments are non-destructive (labels can be re-flipped by the same tool).

Also: update `docs/features/offboarding-automation.md`-style cross-links if the docs index expects one, and note in the doc that **HSL-as-separate-organization (QuickBooks-style org toggle) is explicitly out of scope** — recorded as the long-term direction from the 2026-08 meeting.

- [ ] Write the doc, then commit:

```bash
git add docs/features/hsl-subdepartments.md
git commit -m "docs(hsl): sub-department model, HRS attribution, Saturday cutover runbook"
```

---

## Self-review checklist (run after all tasks)

1. **Spec coverage:** sub-dept base rates + parent removal (2,3,4,11); Intake-Specialist mislabeling (7); midweek out-of-HSL failures (5,8,9); HRS attribution/behavior (5,9); hard-transfer tooling for Carla/Olivia (10,12); Saturday scheduling (12 runbook); long-term org split noted out of scope (12).
2. **Ordering:** 1 → 2/3 (need helpers) → 4 (UI) → 5/6/7/8/9 in any order (all need Task 1) → 10 (needs 5+8) → 11 → 12. Tasks 1–9 deployable any weekday; 10–12 gate the Saturday cutover.
3. **Type consistency:** helpers exported exactly as named in Task 1's Produces block; `planDepartmentApply`/`ApplyPlan` signatures unchanged; `HslTransferRowLike.from_department` added everywhere the type is constructed (grep `HslTransferRowLike` after Task 6).
