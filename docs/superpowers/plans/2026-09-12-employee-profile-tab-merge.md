# Employee Profile Tab Merge — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the Employee Profile's nine in-page section chips to five, fold the People bank card into the merged Compensation tab as the payout read view, and conform the surface to the existing employee cache contract.

**Architecture:** One exported vocabulary module (`src/lib/employee/profile-tabs.ts`) becomes the single home for tab ids, section ids, deep-link intents and the intent→target table, replacing five hand-copied unions. Four render branches merge into two panes; the Compensation tab gains a bordered segmented sub-strip copied from the shipped Payroll Wizard additions pattern. Logic that needs testing is extracted into plain `.ts` modules, because this repo has no DOM testing.

**Tech Stack:** Next.js App Router, React 19, TypeScript, `motion/react` (Framer), Tailwind, `node:test` + `node:assert` via `node --import tsx --test`.

**Spec:** [`docs/superpowers/specs/2026-09-12-employee-profile-tab-merge-design.md`](../specs/2026-09-12-employee-profile-tab-merge-design.md)

## Global Constraints

- **Test runner is `node --import tsx --test <file>`.** Not vitest, not jest. `npx vitest` resolves an unrelated version and fails on `@/` aliases — that red is an artifact, not a result.
- **There is no DOM testing in this repo** — no jsdom, no testing-library, zero `.test.tsx` files. Tests are either (a) pure-logic over extracted `.ts` modules, or (b) source-scan guards in the style of `src/lib/departments/dept-label-render.test.ts`. Do not add a test framework.
- **Never loosen a type, guard, validation, limit or test to make an error go away** (CLAUDE.md). If the only way forward is to loosen something, stop and ask.
- **Stage by explicit path.** Never `git add -A` or `git add .`. Multiple sessions share this checkout. Re-run `git status` immediately before every commit.
- **Commit directly to `main`. NEVER push.** Kane handles every push.
- **`.next/` is shared by `next build` and a running `next dev`.** Check for a live dev server before building.
- **The one vocabulary, used verbatim by every task:**
  ```ts
  TabId     = 'overview' | 'compensation' | 'skills' | 'requestDocuments' | 'resign'
  SectionId = 'rates' | 'payStubs' | 'payout' | 'skillSets' | 'commendations'
  ProfileIntent = 'photo' | 'bank' | 'skillSet'
  ```
  The Skill Sets tab id is **`skills`**, never `skillsets`. There is **one** `SectionId`, never a parallel `CompensationSectionId`. There is **one** deep-link payload, `ProfileTarget = { tab; section?; nonce }`, never separate `focusTab`/`focusSection`/`focusNonce` props.
- **Two literals fail the build if they leave `EmployeeProfile.tsx`:** `label: 'Pay Stubs'` and `label: 'Request Documents'`. `src/lib/penny/employee-guides.test.ts:167` does `profile.includes(\`label: '${tab}'\`)` — a plain substring scan of the whole file, so a **section** definition satisfies it. Never loosen that assertion.
- **`/api/employee-ids` is never cached.** No `EMPLOYEE_CACHE_KEYS` entry may be sourced from it.

### Expected-red window

Task 6 rewrites the `TabId` union to its final five members while four render branches still compare against retired ids. **`tsc --noEmit` is expected to fail from Task 6 until Task 11 completes.** This is deliberate: each TS2367 error is a checklist entry for the merge tasks (spec failure class #3). Do not "fix" it by widening the union. Run `npm run lint` at the end of Task 11 and expect zero errors there.

---

## File Structure

**Created**
- `src/lib/employee/profile-tabs.ts` — the whole tab/section/intent vocabulary and the intent→target resolution. No React, no imports from components, so it is directly testable.
- `src/lib/employee/profile-tabs.test.ts` — resolution + membership guards.
- `src/lib/employee/compensation-sections.ts` — the Compensation strip's canonical array, slide-direction and derived-active-section helpers. Pure.
- `src/lib/employee/compensation-sections.test.ts`
- `src/lib/banking/preferred-bank.ts` — `pickPreferredBank`, the one cross-slot rule, shared by People and the employee surface. Carries the alt-slot SWIFT fix.
- `src/lib/banking/preferred-bank.test.ts`
- `src/lib/banking/account-mask.ts` — the one masking rule, shared by the card and the payout fields.
- `src/lib/banking/account-mask.test.ts`
- `src/lib/employee/profile-hook-order.test.ts` — source-scan guard: no hook below an early return.
- `src/lib/employee/profile-cache-conformance.test.ts` — source-scan guard: no cache key in the bank/payout path.
- `src/components/banking/bank-card.tsx` — moved via `git mv` from `src/components/people/`.
- `src/components/employee/CompensationSections.tsx` — the inner segmented strip.
- `docs/features/employee-profile.md` — the surface has no feature doc today.

**Modified**
- `src/components/employee/EmployeeProfile.tsx` — the merge itself.
- `src/components/employee/EmployeeApp.tsx` — deep-link payload.
- `src/components/employee/EmployeeDashboard.tsx`, `ProfileCompletionCard.tsx` — union copies deleted.
- `src/components/people/PeopleTab.tsx` — consumes `pickPreferredBank`, new card import path.
- `src/lib/payment-catalog/banks.ts` — three claimed spellings.
- `src/lib/departments/dept-label-render.test.ts` — one documented allow-entry.
- `src/lib/date-only.ts`, `src/lib/employee/id-card.ts` — one shared date renderer.
- `docs/features/INDEX.md`, the six doc corrections from spec §11.

---

## Task 1: Hoist the hooks above the loading bail-out

Spec §3.1. This is live on `main` and blanks the route. It goes first because every later task shifts the line anchors it depends on, and its guard becomes the invariant every later edit is checked against.

**Files:**
- Modify: `src/components/employee/EmployeeProfile.tsx:1294-1356`
- Test: `src/lib/employee/profile-hook-order.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing importable. Produces the invariant *"no hook call appears below an early return in EmployeeProfile.tsx"*, enforced by the test.

- [ ] **Step 1: Write the failing test**

Create `src/lib/employee/profile-hook-order.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * EmployeeProfile bails out with `if (loading) return <ProfileSkeleton />` while
 * the roster row is in flight. `loading` is seeded from the session cache
 * (`master === null`), so a COLD load renders short, then long. Any hook declared
 * below that bail-out is skipped on the first render and called on the second —
 * React's "Rendered more hooks than during the previous render", which blanks the
 * route because there is no error boundary anywhere in app/ or src/.
 *
 * This scans source rather than rendering because the repo has no DOM test setup.
 */
const SRC = readFileSync(
  join(process.cwd(), 'src/components/employee/EmployeeProfile.tsx'),
  'utf8',
);

const HOOK = /\b(useState|useEffect|useMemo|useCallback|useRef|useReducedMotion|useId|useLayoutEffect)\s*\(/;

test('no hook is called below the loading bail-out in EmployeeProfile', () => {
  const lines = SRC.split('\n');
  const bailIndex = lines.findIndex((l) => /if\s*\(loading\)\s*return\s*</.test(l));
  assert.notEqual(bailIndex, -1, 'the `if (loading) return <ProfileSkeleton />` bail-out is gone — update this guard deliberately, do not delete it');

  const offenders: string[] = [];
  for (let i = bailIndex + 1; i < lines.length; i += 1) {
    if (HOOK.test(lines[i])) offenders.push(`EmployeeProfile.tsx:${i + 1}  ${lines[i].trim()}`);
  }

  assert.deepEqual(
    offenders,
    [],
    'Hook(s) called after an early return. React calls a different number of hooks on the loading and loaded renders, which throws. Hoist them ABOVE the bail-out.',
  );
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --import tsx --test src/lib/employee/profile-hook-order.test.ts`
Expected: FAIL, listing `EmployeeProfile.tsx:1315  const idCard = useMemo(` and `EmployeeProfile.tsx:1338  const [savingId, setSavingId] = useState(false);`

- [ ] **Step 3: Hoist**

In `src/components/employee/EmployeeProfile.tsx`, the block at `:1294` currently begins:

```tsx
  if (loading) return <ProfileSkeleton />;

  const workEmail =
    master?.work_email?.trim() || rate?.work_email?.trim() || bankInfo?.work_email?.trim() || null;
```

Reorder so the bail-out comes **after** the hooks. Move, in this order, to immediately **above** `if (loading)`:

1. the `const workEmail = …` declaration (the memo reads it, so it must precede it),
2. the `const idCard = useMemo(…)` block **with its dependency array byte-identical**,
3. the `const [savingId, setSavingId] = useState(false);` declaration,
4. `const handleDownloadId = async () => { … };` (not a hook, but it closes over `idCard` and `savingId`).

Leave `personalEmail` and `fullAddressDisplay` **below** the bail-out — neither is a hook dependency.

Add this comment above the memo so the next reader does not undo it:

```tsx
  // This memo and the `savingId` guard below it live ABOVE `if (loading)`: a hook
  // below an early return is skipped on the loading render and called on the
  // loaded one, which is the "Rendered more hooks than during the previous
  // render" crash. Guarded by src/lib/employee/profile-hook-order.test.ts.
```

- [ ] **Step 4: Run the test and the type check**

Run: `node --import tsx --test src/lib/employee/profile-hook-order.test.ts`
Expected: PASS

Run: `npm run lint`
Expected: no new errors. (`npm run lint` is `tsc --noEmit`.)

- [ ] **Step 5: Commit**

```bash
git status
git add src/components/employee/EmployeeProfile.tsx src/lib/employee/profile-hook-order.test.ts
git commit -m "fix(employee): the Profile crashed on every cold load, and nothing caught it"
```

---

## Task 2: Close the dept-label false positive

Spec §3.2. The suite is red on `main` naming a file Task 7 edits. Clear it first so a real regression cannot hide behind it.

**Files:**
- Modify: `src/lib/departments/dept-label-render.test.ts` (the `ALLOWED_SNIPPETS` block)
- Test: the same file

**Interfaces:**
- Consumes: nothing. Produces: a green baseline for `EmployeeIdCard.tsx`.

- [ ] **Step 1: Establish the baseline and prove the finding is false**

Run: `node --import tsx --test src/lib/departments/dept-label-render.test.ts`
Expected: FAIL naming both `EmployeeIdCard.tsx:205  {card.department}` and `ManagerApp.tsx:1669  {dept || 'No department'}`.

Then open `src/lib/employee/id-card.ts` and confirm `buildIdCard` passes `department` through `formatDeptLabel` before it reaches `card.department`. **If it does not, stop — the finding is real, and the fix is to wrap the value, not to allow it.** Record what you found either way.

- [ ] **Step 2: Add one allow-entry, with its reason**

Add to `ALLOWED_SNIPPETS` in `src/lib/departments/dept-label-render.test.ts`, matching the file's existing entry format:

```ts
  // `card.department` is already through formatDeptLabel inside buildIdCard
  // (src/lib/employee/id-card.ts) — the badge renders a view model, not a raw
  // roster cell. Scanning the JSX cannot see that, so it is allowed by name.
  'src/components/employee/EmployeeIdCard.tsx:205  {card.department}',
```

Do **not** touch the assertion, the scanner, or `NOT_A_LABEL`. `ManagerApp.tsx:1669` stays failing — it is out of scope (spec §9) and stays on the open list.

- [ ] **Step 3: Run**

Run: `node --import tsx --test src/lib/departments/dept-label-render.test.ts`
Expected: still FAIL, but now naming **only** `ManagerApp.tsx:1669`. Record that as the accepted baseline in the session log.

- [ ] **Step 4: Commit**

```bash
git status
git add src/lib/departments/dept-label-render.test.ts
git commit -m "test(departments): the ID card's department was never raw, so say so by name"
```

---

## Task 3: One date renderer

Spec §10 Q1, ruled: unify on `parseDateOnlyLocal`. Runs before Task 7 because that merge is what puts both parsers on one pane.

**Files:**
- Modify: `src/lib/date-only.ts`, `src/lib/employee/id-card.ts`, `src/components/employee/EmployeeProfile.tsx:133-141`
- Test: `src/lib/date-only.test.ts`

**Interfaces:**
- Produces: `formatDateOnly(value: string | null | undefined): string` — exported from `src/lib/date-only.ts`. Renders a date-only string in Manila-safe local terms via `parseDateOnlyLocal`; returns the **raw string verbatim** when unparseable (the ID card's behaviour), and `'—'` only for null/undefined/empty.

- [ ] **Step 1: Write the failing test**

Create `src/lib/date-only.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDateOnly } from './date-only';

test('a date-only string does not shift a day west of UTC', () => {
  // `new Date('2026-09-01')` parses as UTC midnight, which is Aug 31 in Manila-
  // negative offsets and in every US zone. parseDateOnlyLocal builds a LOCAL date.
  assert.match(formatDateOnly('2026-09-01'), /Sep 1, 2026/);
});

test('an unparseable value is passed through verbatim, never swallowed', () => {
  assert.equal(formatDateOnly('sometime in March'), 'sometime in March');
});

test('an absent value renders the em-dash placeholder', () => {
  assert.equal(formatDateOnly(null), '—');
  assert.equal(formatDateOnly(undefined), '—');
  assert.equal(formatDateOnly('   '), '—');
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --import tsx --test src/lib/date-only.test.ts`
Expected: FAIL — `formatDateOnly` is not exported from `./date-only`.

- [ ] **Step 3: Implement**

Append to `src/lib/date-only.ts`:

```ts
/**
 * The ONE renderer for a date-only column (`YYYY-MM-DD`).
 *
 * `new Date('2026-09-01')` is UTC midnight, so it renders as Aug 31 for every
 * viewer west of UTC — including all of Manila-facing payroll. This builds a
 * LOCAL date instead, so the Profile's Employment row and the ID card agree.
 *
 * Unparseable input is returned VERBATIM rather than replaced: the card has
 * always shown whatever the roster holds, and hiding a malformed date behind a
 * dash hides a data problem.
 */
export function formatDateOnly(value: string | null | undefined): string {
  const raw = value?.trim();
  if (!raw) return '—';
  const parsed = parseDateOnlyLocal(raw);
  if (!parsed) return raw;
  return parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
```

Then replace `formatStartDate` at `EmployeeProfile.tsx:133-141` with a re-export/alias to `formatDateOnly`, and point `formatIdCardDate` in `src/lib/employee/id-card.ts` at it too, so there is exactly one implementation.

- [ ] **Step 4: Check every downstream caller moved correctly**

`formatStartDate` also feeds `EmployeeProfile.tsx:1789`, `:1809` (Pay Stubs pay dates) and `:2330`, `:2384`, `:2511` (resignation effective dates). Open each, confirm it now renders through `formatDateOnly`, and confirm the date it prints is the intended calendar day. **These dates are expected to shift by one day for viewers west of UTC — that is the fix, not a regression.** Note each in the commit body.

- [ ] **Step 5: Run**

Run: `node --import tsx --test src/lib/date-only.test.ts && npm run lint`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git status
git add src/lib/date-only.ts src/lib/date-only.test.ts src/lib/employee/id-card.ts src/components/employee/EmployeeProfile.tsx
git commit -m "fix(employee): the start date was a day early for everyone west of UTC"
```

---

## Task 4: Move BankCard, extract the one preferred-bank rule, and fix the alt-slot SWIFT

Spec §7.3, §7.6, §10 Q2 + Q4. The move precedes the masking work or every path anchor in Task 12 is stale. The SWIFT fix is folded in here — it belongs inside the extracted helper, not in a second module.

**Files:**
- Create: `src/components/banking/bank-card.tsx` (via `git mv`), `src/lib/banking/preferred-bank.ts`, `src/lib/banking/preferred-bank.test.ts`
- Modify: `src/components/people/PeopleTab.tsx` (import path + call site)
- Test: `src/lib/banking/preferred-bank.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type PreferredBankRow = {
    preferred_bank_slot?: string | null;
    bank_name?: string | null;        alt_bank_name?: string | null;
    account_holder_name?: string | null; alt_account_holder_name?: string | null;
    account_number?: string | null;   alt_account_number?: string | null;
    swift_code?: string | null;       alt_routing_number?: string | null;
  };
  export type PreferredBank = {
    name: string | null; holder: string | null;
    account: string | null; swift: string | null; isAlternativeSlot: boolean;
  };
  export function pickPreferredBank(row: PreferredBankRow | null | undefined): PreferredBank;
  ```
  Both `EmployeeIdRow` and People's banking row structurally satisfy `PreferredBankRow`. Do **not** widen either to `any` to make them fit.

- [ ] **Step 1: Write the failing test**

Create `src/lib/banking/preferred-bank.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { pickPreferredBank } from './preferred-bank';

test('primary slot reads the primary columns', () => {
  const b = pickPreferredBank({
    preferred_bank_slot: 'primary',
    bank_name: 'GoTyme Bank', account_holder_name: 'Ana Cruz',
    account_number: '001234567890', swift_code: 'GOTYPHM1',
  });
  assert.equal(b.name, 'GoTyme Bank');
  assert.equal(b.account, '001234567890');
  assert.equal(b.swift, 'GOTYPHM1');
  assert.equal(b.isAlternativeSlot, false);
});

test('alternative slot reads the alt columns — INCLUDING its SWIFT', () => {
  // There is no alt_swift_code column. The employee form writes alt-slot SWIFT
  // into alt_routing_number (EmployeeProfile.tsx:1208), so that is where the
  // alternative slot's wire code lives. Reading swift_code here would print the
  // PRIMARY account's code beside the ALTERNATIVE account's number, and the copy
  // button would hand over a wrong wire code.
  const b = pickPreferredBank({
    preferred_bank_slot: 'alternative',
    bank_name: 'BDO Unibank', swift_code: 'BNORPHMM',
    alt_bank_name: 'Maya Bank', alt_account_number: '9988776655',
    alt_routing_number: 'PAPHPHM1',
  });
  assert.equal(b.name, 'Maya Bank');
  assert.equal(b.account, '9988776655');
  assert.equal(b.swift, 'PAPHPHM1');
  assert.equal(b.isAlternativeSlot, true);
});

test('a preferred slot with empty fields falls back to the other slot, per field', () => {
  const b = pickPreferredBank({
    preferred_bank_slot: 'alternative',
    bank_name: 'BDO Unibank', account_number: '111122223333',
    alt_bank_name: '   ',
  });
  assert.equal(b.name, 'BDO Unibank');
  assert.equal(b.account, '111122223333');
  assert.equal(b.isAlternativeSlot, true);
});

test('an empty row yields nulls, never empty strings', () => {
  const b = pickPreferredBank({});
  assert.equal(b.name, null);
  assert.equal(b.account, null);
  assert.equal(b.swift, null);
  assert.equal(pickPreferredBank(null).name, null);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --import tsx --test src/lib/banking/preferred-bank.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement, lifting the rule verbatim from PeopleTab**

Create `src/lib/banking/preferred-bank.ts`. Lift the `prefAlt` / `firstOf` / `prefBank` logic from `PeopleTab.tsx:3192-3214` **exactly**, changing only the SWIFT line:

```ts
/**
 * The ONE cross-slot preferred-bank rule, shared by Accounting's People card and
 * the employee's own Profile. Preferred slot first, falling back to the OTHER
 * slot per field — the same pickFirst Payment Dispatch's queue row uses
 * (buildPayeeDetails in mock-queue.ts) — so a person whose details live only in
 * the non-preferred slot still shows the account PD actually pays to.
 *
 * A second copy of this rule is the drift people-bank-card.md §2 exists to
 * prevent: the card would brand an account the money is not going to.
 */
export function pickPreferredBank(row: PreferredBankRow | null | undefined): PreferredBank {
  const alt = row?.preferred_bank_slot === 'alternative';
  const firstOf = (...vals: Array<string | null | undefined>): string | null =>
    vals.find((v) => v != null && String(v).trim() !== '') ?? null;

  return {
    name: alt ? firstOf(row?.alt_bank_name, row?.bank_name) : firstOf(row?.bank_name, row?.alt_bank_name),
    holder: alt
      ? firstOf(row?.alt_account_holder_name, row?.account_holder_name)
      : firstOf(row?.account_holder_name, row?.alt_account_holder_name),
    account: alt
      ? firstOf(row?.alt_account_number, row?.account_number)
      : firstOf(row?.account_number, row?.alt_account_number),
    // There is no `alt_swift_code` column: the employee form stores alt-slot
    // SWIFT in `alt_routing_number` (EmployeeProfile.tsx:1208). Before this fix
    // PeopleTab.tsx:3212 read `swift_code` flat, so an alternative-slot payee's
    // card printed the PRIMARY slot's wire code — and the copy button handed it over.
    swift: alt ? firstOf(row?.alt_routing_number, row?.swift_code) : firstOf(row?.swift_code, row?.alt_routing_number),
    isAlternativeSlot: alt,
  };
}
```

- [ ] **Step 4: Run**

Run: `node --import tsx --test src/lib/banking/preferred-bank.test.ts`
Expected: PASS (4/4)

- [ ] **Step 5: Move the card and rewire People**

```bash
mkdir -p src/components/banking
git mv src/components/people/bank-card.tsx src/components/banking/bank-card.tsx
```

Then update every importer. Find them all first — do not assume there is only one:

```bash
grep -rn "people/bank-card\|from './bank-card'" src app
```

In `src/components/people/PeopleTab.tsx`, replace the inline `prefAlt`/`firstOf`/`prefBank` consts (`:3192-3214`) with `const prefBank = pickPreferredBank(banking);` and update the `<BankCard>` call site to read `prefBank.name / .holder / .account / .swift / .isAlternativeSlot`.

**`swift` now comes from `prefBank`, not from `banking?.swift_code`.** That is the bug fix reaching Accounting's shipped card.

- [ ] **Step 6: Verify nothing else referenced the old path**

Run: `npm run lint`
Expected: no unresolved-import errors. If any test imported the card by path, update it.

- [ ] **Step 7: Commit**

```bash
git status
git add src/lib/banking/preferred-bank.ts src/lib/banking/preferred-bank.test.ts src/components/banking/bank-card.tsx src/components/people/bank-card.tsx src/components/people/PeopleTab.tsx
git commit -m "fix(banking): an alternative-slot payee's card handed over the wrong wire code"
```

---

## Task 5: Claim three bank spellings

Spec §10 Q3, ruled: claim all three. Independent of the merge, but sequence it before the employee card ships so the GoTyme employee sees GoTyme on first render.

**Files:**
- Modify: `src/lib/payment-catalog/banks.ts`
- Test: `src/lib/payment-catalog/banks.test.ts`

**Interfaces:**
- Consumes: nothing. Produces: `resolveBankBrand` returning a non-null `key` for three previously-unclaimed spellings.

- [ ] **Step 1: Read the table before editing it**

Open `src/lib/payment-catalog/banks.ts` and find the `OFFICIAL_BANKS` entries. **Check specifically whether a `Philippine National Bank` entry already exists without the `s`.** If it does, `Philippines National Bank` is an **alias**, not a new bank. Same check for CIMB. Record what you actually find — do not assume.

- [ ] **Step 2: Write the failing test**

Append to `src/lib/payment-catalog/banks.test.ts`:

```ts
test('three live spellings that used to resolve to nothing now resolve', () => {
  // Real spellings from employee_ids. An unclaimed spelling correctly gets no
  // brand, so each of these rendered a slate card with raw text — including the
  // GoTyme variant, which is the one case the branded card was asked for.
  assert.equal(resolveBankBrand('GoTyme Bank, Inc. (GoTyme Bank Corporation)').key, 'gotyme');
  assert.ok(resolveBankBrand('CIMB Bank').key, 'CIMB Bank still unclaimed');
  assert.ok(resolveBankBrand('Philippines National Bank').key, 'PNB (plural spelling) still unclaimed');
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `node --import tsx --test src/lib/payment-catalog/banks.test.ts`
Expected: FAIL — `key` is `null` for all three.

- [ ] **Step 4: Add the aliases**

Add `'GoTyme Bank, Inc. (GoTyme Bank Corporation)'` to the `aliases` array of the existing `gotyme` entry (`banks.ts:109`). Add the CIMB and PNB spellings as aliases of their existing entries if Step 1 found them, or as new entries if it did not.

**Do not add fuzzy matching.** `payment-catalog-current-banks.md` §2: *"guessing is exactly the invented equivalence §10.1 forbids."*

- [ ] **Step 5: Run both the test and the spelling audit**

Run: `node --import tsx --test src/lib/payment-catalog/banks.test.ts`
Expected: PASS

Run: `node --import tsx scripts/audit-bank-spellings.mts`
Expected: the three spellings no longer appear in the unclaimed list. **This is read-only** — it reports, it does not write.

- [ ] **Step 6: Note what this does and does not fix**

CIMB and PNB ship no artwork in `public/banks/`. Claiming them fixes the **name**, not the colour — they still render a correct neutral card. Say so in the commit body so nobody later "fixes" the missing logo by inventing one. If any claimed bank *does* ship a logo, its colour must come from `scripts/derive-bank-brand-colors.mts`; a hand-typed hex fails `bank-card-palette.test.ts`.

- [ ] **Step 7: Commit**

```bash
git status
git add src/lib/payment-catalog/banks.ts src/lib/payment-catalog/banks.test.ts
git commit -m "fix(banks): three real spellings resolved to nothing, including a GoTyme variant"
```

---

## Task 6: The tab vocabulary, the intent deep links, and the nonce

Spec §4. This is the keystone. It ships the **final** five-tab vocabulary while the render branches still use the old ids — see *Expected-red window* above.

**Files:**
- Create: `src/lib/employee/profile-tabs.ts`, `src/lib/employee/profile-tabs.test.ts`
- Modify: `EmployeeProfile.tsx` (`:151` union, `:106` prop, `:691-693` effect, `:507-517` tabs array), `EmployeeApp.tsx:59,116,420-428,483`, `EmployeeDashboard.tsx:291`, `ProfileCompletionCard.tsx:14,33,36-38`
- Test: `src/lib/employee/profile-tabs.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type TabId = 'overview' | 'compensation' | 'skills' | 'requestDocuments' | 'resign';
  export type SectionId = 'rates' | 'payStubs' | 'payout' | 'skillSets' | 'commendations';
  export type ProfileIntent = 'photo' | 'bank' | 'skillSet';
  export const PROFILE_TAB_IDS: readonly TabId[];
  export const PROFILE_SECTIONS: Record<TabId, readonly SectionId[]>;
  export const INTENT_TARGET: Record<ProfileIntent, { tab: TabId; section?: SectionId }>;
  export type ProfileTarget = { tab: TabId; section?: SectionId; nonce: number };
  export function nextProfileTarget(prev: ProfileTarget | null, intent: ProfileIntent): ProfileTarget;
  export function profileSectionDomId(section: SectionId): string; // `profile-section-${section}`
  ```
  **`EmployeeProfile` takes exactly one new prop, `focusTarget?: ProfileTarget`.** Not three props. Its effect deps are `[focusTarget?.nonce]`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/employee/profile-tabs.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INTENT_TARGET, PROFILE_SECTIONS, PROFILE_TAB_IDS,
  nextProfileTarget, profileSectionDomId,
} from './profile-tabs';

test('every deep-link intent resolves to a real tab, and a real section when it names one', () => {
  // The render chain is a series of bare `activeTab === '…' &&` guards with NO
  // default branch, so an intent pointing at a retired id shows an EMPTY pane —
  // silently, and with no type error, because a narrow union still satisfies a
  // wide one. This is the guard that catches that.
  for (const [intent, target] of Object.entries(INTENT_TARGET)) {
    assert.ok(PROFILE_TAB_IDS.includes(target.tab), `intent "${intent}" points at unknown tab "${target.tab}"`);
    if (target.section) {
      assert.ok(
        PROFILE_SECTIONS[target.tab].includes(target.section),
        `intent "${intent}" points at section "${target.section}", which tab "${target.tab}" does not have`,
      );
    }
  }
});

test('the bank nudge lands on the payout section, not merely the tab', () => {
  assert.deepEqual(INTENT_TARGET.bank, { tab: 'compensation', section: 'payout' });
});

test('the nonce advances on EVERY call, so the same nudge fires twice', () => {
  // focusTarget is applied by a value-keyed effect and no visited tab ever
  // unmounts (EmployeeApp.tsx:613). Without a changing nonce, firing the same
  // nudge twice sets state to its current value, React bails out, and the user
  // does not move.
  const first = nextProfileTarget(null, 'bank');
  const second = nextProfileTarget(first, 'bank');
  assert.notEqual(first.nonce, second.nonce);
  assert.equal(second.tab, 'compensation');
});

test('section DOM ids are derived, never hand-written', () => {
  assert.equal(profileSectionDomId('commendations'), 'profile-section-commendations');
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --import tsx --test src/lib/employee/profile-tabs.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the vocabulary**

Create `src/lib/employee/profile-tabs.ts`:

```ts
/**
 * The ONE home for the Employee Profile's tab and section vocabulary.
 *
 * Before this module the tab union was copied by hand in five places
 * (EmployeeApp, EmployeeDashboard, ProfileCompletionCard ×2, EmployeeProfile),
 * and deep links named tab ids directly — so retiring a tab left the bank and
 * skill-set nudges pointing at ids no branch matched, with no type error.
 * Callers now name an INTENT; this module decides where that intent lands.
 */
export type TabId = 'overview' | 'compensation' | 'skills' | 'requestDocuments' | 'resign';
export type SectionId = 'rates' | 'payStubs' | 'payout' | 'skillSets' | 'commendations';
export type ProfileIntent = 'photo' | 'bank' | 'skillSet';

export const PROFILE_TAB_IDS: readonly TabId[] = [
  'overview', 'compensation', 'skills', 'requestDocuments', 'resign',
];

/**
 * Canonical section order per tab. Compensation is the only tab with a visible
 * section strip; for the stacked tabs these are SCROLL ANCHORS, and the
 * resolution test checks membership either way, so a renamed block cannot
 * silently become an unreachable deep-link target.
 */
export const PROFILE_SECTIONS: Record<TabId, readonly SectionId[]> = {
  overview: [],
  compensation: ['rates', 'payStubs', 'payout'],
  skills: ['skillSets', 'commendations'],
  requestDocuments: [],
  resign: [],
};

export const INTENT_TARGET: Record<ProfileIntent, { tab: TabId; section?: SectionId }> = {
  photo: { tab: 'overview' },
  bank: { tab: 'compensation', section: 'payout' },
  skillSet: { tab: 'skills', section: 'skillSets' },
};

export type ProfileTarget = { tab: TabId; section?: SectionId; nonce: number };

/** Always advances the nonce, so re-firing the same nudge still moves the pane. */
export function nextProfileTarget(prev: ProfileTarget | null, intent: ProfileIntent): ProfileTarget {
  const target = INTENT_TARGET[intent];
  return { tab: target.tab, section: target.section, nonce: (prev?.nonce ?? 0) + 1 };
}

export function profileSectionDomId(section: SectionId): string {
  return `profile-section-${section}`;
}
```

- [ ] **Step 4: Run the test**

Run: `node --import tsx --test src/lib/employee/profile-tabs.test.ts`
Expected: PASS (4/4)

- [ ] **Step 5: Delete all five union copies**

- `EmployeeProfile.tsx:151` — delete the local `TabId` union; `import type { TabId, SectionId, ProfileTarget } from '@/lib/employee/profile-tabs'`.
- `EmployeeProfile.tsx:106` — replace `focusTab?: TabId` with `focusTarget?: ProfileTarget`.
- `EmployeeProfile.tsx:691-693` — the effect becomes:
  ```tsx
  useEffect(() => {
    if (!focusTarget) return;
    setActiveTab(focusTarget.tab);
    if (focusTarget.section) setPendingSection(focusTarget.section);
  }, [focusTarget?.nonce]);
  ```
  Add `const [pendingSection, setPendingSection] = useState<SectionId | null>(null);` beside the other state. Tasks 10 and 12 consume it.
- `EmployeeApp.tsx:59` — delete `EmployeeProfileFocusTab`; import `ProfileIntent`, `ProfileTarget`, `nextProfileTarget`.
- `EmployeeApp.tsx:116` — `const [profileTarget, setProfileTarget] = useState<ProfileTarget | null>(null);`
- `EmployeeApp.tsx:426-428` — `navigateToProfileSetup` takes a `ProfileIntent` and calls `setProfileTarget((prev) => nextProfileTarget(prev, intent))`. Its default becomes `needsPhoto ? 'photo' : needsBank ? 'bank' : 'skillSet'`.
- `EmployeeApp.tsx:483` — `focusTarget={profileTarget}`.
- `EmployeeDashboard.tsx:291` and `ProfileCompletionCard.tsx:14,33` — replace each inline union with `ProfileIntent`.
- `ProfileCompletionCard.tsx:36-38` — the three rows become `target: 'photo'`, `target: 'bank'`, `target: 'skillSet'`.

- [ ] **Step 6: Type-check and read the errors as your checklist**

Run: `npm run lint`
Expected: **TS2367 errors in `EmployeeProfile.tsx`** at every `activeTab === 'id' | 'payStubs' | 'payment' | 'skillsets' | 'reports'` comparison. **This is correct and intended.** Copy the list into the commit body — it is the checklist for Tasks 7–11. Do not widen the union to silence it.

- [ ] **Step 7: Commit**

```bash
git status
git add src/lib/employee/profile-tabs.ts src/lib/employee/profile-tabs.test.ts src/components/employee/EmployeeProfile.tsx src/components/employee/EmployeeApp.tsx src/components/employee/EmployeeDashboard.tsx src/components/employee/ProfileCompletionCard.tsx
git commit -m "refactor(employee): one tab vocabulary, and deep links that name an intent"
```

---

## Task 7: Merge Overview + ID into one stacked pane

Spec §1, §5 (geometry). First pane merge — it carries the only measured layout constraint.

**Files:**
- Modify: `src/components/employee/EmployeeProfile.tsx:1581-1659`

**Interfaces:**
- Consumes: `TabId` from Task 6; `formatDateOnly` from Task 3.
- Produces: the `overview` pane. No new exports.

- [ ] **Step 1: Read both branches before editing**

Open `EmployeeProfile.tsx:1581-1659`. The `overview` branch renders `Section`/`Row` blocks (Personal, Employment, Address). The `id` branch at `:1637` is the only centred, chrome-less column in the file: `<div className="flex flex-col items-center gap-5 py-2">` wrapping `<EmployeeIdCard …>` and the download button.

- [ ] **Step 2: Merge**

Replace both branches with a single `{activeTab === 'overview' && ( … )}` containing, in order: **Personal → Employment → Address (still `hasAnyAddress`-gated) → ID card**.

Move the `id` branch's contents in **verbatim** as the final block. Keep its centring wrapper; do **not** put the card into a two-column grid.

```tsx
  {/* The badge is container-query sized — every dimension inside
      EmployeeIdCard.tsx is `cqw` against a `@container w-full max-w-[372px]`.
      The exported PNG is painted from data at a fixed size, so if this host
      narrows below 372px the on-screen badge and its typography shrink while
      the download does not, and the two diverge with no error. Keep this block
      full-width in the content column; never nest it in a grid track. */}
  <div className="flex flex-col items-center gap-5 py-2">
```

**Do not delete either Start Date rendering.** Task 3 unified the parser, so the Employment row and the card now agree. Deleting one would hide a value, not fix it.

- [ ] **Step 3: Verify the layout at three widths**

Start the app (check for an existing dev server first — `.next/` is shared):

Run: `npm run dev`

Open `/employee` → Profile → Overview and confirm at **400px, 768px and 1400px** that the ID card block still reaches 372px and the badge text does not shrink relative to the card. Then download the PNG and compare it to what is on screen — they must match.

- [ ] **Step 4: Type-check**

Run: `npm run lint`
Expected: the `'id'` TS2367 error from Task 6 is gone. Others remain until Task 11.

- [ ] **Step 5: Commit**

```bash
git status
git add src/components/employee/EmployeeProfile.tsx
git commit -m "feat(employee): the ID card now sits with the identity data it belongs to"
```

---

## Task 8: Merge Skill Sets + Reports into one stacked pane

**Files:**
- Modify: `src/components/employee/EmployeeProfile.tsx:2120-2298`

**Interfaces:**
- Consumes: `profileSectionDomId` from Task 6.
- Produces: the `skills` pane, with anchors `profile-section-skillSets` and `profile-section-commendations`.

- [ ] **Step 1: Merge behind the single `skills` guard**

Replace the `activeTab === 'skillsets'` and `activeTab === 'reports'` branches with one `{activeTab === 'skills' && ( … )}`, stacking the Skill Sets block over the Commendations block, each keeping its own heading.

Wrap each in an anchor derived from the registry — never hand-written:

```tsx
  <div id={profileSectionDomId('skillSets')} className="scroll-mt-24">
    {/* existing Skill Sets block, verbatim */}
  </div>
  <div id={profileSectionDomId('commendations')} className="scroll-mt-24">
    {/* existing Commendations block, verbatim */}
  </div>
```

- [ ] **Step 2: Leave the Save and the cap exactly as they are**

The Skill Sets Save keeps its **exact** disable expression `skillSetSaving || skillSetLoading || !skillSetDirty`. **The cap of 2 on Current projects is not touched** (spec §9, plan Q8). Locate it, confirm it is byte-identical after your edit, and say so in the commit body.

- [ ] **Step 3: Scroll the pending section into view**

Add, near the pane:

```tsx
  useEffect(() => {
    if (!pendingSection) return;
    if (!PROFILE_SECTIONS.skills.includes(pendingSection)) return;
    document.getElementById(profileSectionDomId(pendingSection))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setPendingSection(null);
  }, [pendingSection, activeTab]);
```

- [ ] **Step 4: Type-check and verify the deep link**

Run: `npm run lint`
Expected: the `'skillsets'` and `'reports'` TS2367 errors are gone.

Run: `npm run dev`, then from the employee dashboard trigger the "finish your profile" nudge for a missing skill set and confirm it lands on the Skill Sets block. Trigger it **twice** and confirm it moves both times (the Task 6 nonce).

- [ ] **Step 5: Commit**

```bash
git status
git add src/components/employee/EmployeeProfile.tsx
git commit -m "feat(employee): skills and commendations now read as one page"
```

---

## Task 9: The Compensation shell and its section strip

Spec §5.2. Owns the final tabs array and the nudge roll-up. **Nothing after this task touches the tabs array.**

**Files:**
- Create: `src/lib/employee/compensation-sections.ts`, `src/lib/employee/compensation-sections.test.ts`, `src/components/employee/CompensationSections.tsx`
- Modify: `src/components/employee/EmployeeProfile.tsx:507-517` (tabs array), `:528-534` (nudge dots)

**Interfaces:**
- Produces:
  ```ts
  export const COMPENSATION_SECTIONS: readonly { id: SectionId; label: string }[];
  export function resolveCompensationSection(stored: SectionId | null, available: readonly SectionId[]): SectionId;
  export function sectionSlideDirection(from: SectionId, to: SectionId): 1 | -1;
  ```
  and the component `<CompensationSections active onChange needsPayout payoutEscalated />`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/employee/compensation-sections.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { COMPENSATION_SECTIONS, resolveCompensationSection, sectionSlideDirection } from './compensation-sections';

test('the Pay Stubs label literal survives, because a build test scans for it', () => {
  // src/lib/penny/employee-guides.test.ts:167 does a plain substring scan of
  // EmployeeProfile.tsx for `label: 'Pay Stubs'` and FAILS THE BUILD if it goes.
  assert.ok(COMPENSATION_SECTIONS.some((s) => s.label === 'Pay Stubs'));
});

test('the active section is DERIVED with a fallback, never trusted blindly', () => {
  // A stored section can outlive the condition that offered it — Profile already
  // hides content by state (the Address block is hasAnyAddress-gated).
  assert.equal(resolveCompensationSection('payout', ['rates', 'payStubs']), 'rates');
  assert.equal(resolveCompensationSection('payStubs', ['rates', 'payStubs', 'payout']), 'payStubs');
  assert.equal(resolveCompensationSection(null, ['rates', 'payStubs', 'payout']), 'rates');
});

test('slide direction comes from the CANONICAL order, so a hidden section cannot reverse it', () => {
  assert.equal(sectionSlideDirection('rates', 'payout'), 1);
  assert.equal(sectionSlideDirection('payout', 'rates'), -1);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --import tsx --test src/lib/employee/compensation-sections.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helpers**

Create `src/lib/employee/compensation-sections.ts`:

```ts
import type { SectionId } from './profile-tabs';

/** Canonical order. Slide direction is computed from THIS, never from a filtered view. */
export const COMPENSATION_SECTIONS: readonly { id: SectionId; label: string }[] = [
  { id: 'rates', label: 'Rates' },
  { id: 'payStubs', label: 'Pay Stubs' },
  { id: 'payout', label: 'Payout' },
];

export function resolveCompensationSection(
  stored: SectionId | null,
  available: readonly SectionId[],
): SectionId {
  if (stored && available.includes(stored)) return stored;
  return available[0] ?? 'rates';
}

export function sectionSlideDirection(from: SectionId, to: SectionId): 1 | -1 {
  const order = COMPENSATION_SECTIONS.map((s) => s.id);
  return order.indexOf(to) >= order.indexOf(from) ? 1 : -1;
}
```

- [ ] **Step 4: Build the strip**

Create `src/components/employee/CompensationSections.tsx`. Copy the **bordered segmented control** treatment from `src/components/accounting/PayProcessorsTab.tsx:1329-1366`, whose comment states the house rule: inner tabs sit one level below the outer row and are *"quieter by design: a bordered segmented control, not a second row of pills."* The Profile's outer strip is an orange underline, so the two levels read as a hierarchy.

Requirements, all load-bearing:
- Its own `LayoutGroup id="employee-profile-compensation-sections"` and `layoutId="compensation-section-chip"`. **Never reuse `profile-tab-underline` or `employee-profile-tabs`** — Framer would animate the outer underline down into the inner strip.
- `const reduceMotion = useReducedMotion();` from `motion/react`, and skip the `motion.span` when it is true. The outer strip lacks this gate; do not propagate that gap.
- `role="tablist"`, `role="tab"`, `aria-selected`, and a visible focus ring matching the outer strip.
- An amber dot on **Payout** when `needsPayout`, escalating to rose when `payoutEscalated`.

- [ ] **Step 5: Cut the tabs array to five and roll up the nudges**

Replace `EmployeeProfile.tsx:507-517` with exactly five entries:

```tsx
  const tabs: { id: TabId; label: string; sub: string }[] = [
    { id: 'overview', label: 'Overview', sub: 'Identity, employment & ID' },
    { id: 'compensation', label: 'Compensation', sub: 'Rates, stubs & payout' },
    { id: 'skills', label: 'Skill Sets', sub: 'Skills & commendations' },
    { id: 'requestDocuments', label: 'Request Documents', sub: 'COE, pay stubs & certificates' },
    { id: 'resign', label: 'Resign', sub: 'End your employment' },
  ];
```

`label: 'Request Documents'` must stay spelled exactly that way — the Penny build test scans for it.

Then rewrite the `hasIssue` / `escalated` comparisons at `:528-534` so each nudge cause lands on the tab its intent resolves to: `needsPhoto → 'overview'`, `needsBank → 'compensation'`, `needsSkillSet → 'skills'`, `resignPending → 'resign'`.

- [ ] **Step 6: Run**

Run: `node --import tsx --test src/lib/employee/compensation-sections.test.ts && node --import tsx --test src/lib/penny/employee-guides.test.ts && node --import tsx --test src/lib/penny/pay-status.test.ts`
Expected: all PASS. The two Penny tests prove the build-pinned literals survived.

- [ ] **Step 7: Commit**

```bash
git status
git add src/lib/employee/compensation-sections.ts src/lib/employee/compensation-sections.test.ts src/components/employee/CompensationSections.tsx src/components/employee/EmployeeProfile.tsx
git commit -m "feat(employee): five chips, and a quieter strip inside Compensation"
```

---

## Task 10: Rates + Pay Stubs, with the fetch gated on the section

Spec §5.1 condition 3 — Kane's hard condition. **This task owns the paystub fetch gate. Task 11 must not touch it.**

**Files:**
- Modify: `src/components/employee/EmployeeProfile.tsx` — the lazy effect at `:828`, the `compensation` branch at `:1661-1712`, the `payStubs` branch at `:1712-1896`, `payStubPage` at `:811`

**Interfaces:**
- Consumes: `CompensationSections`, `resolveCompensationSection`, `sectionSlideDirection` (Task 9); `pendingSection` (Task 6).

- [ ] **Step 1: Render the shell, derive the active section**

Inside `{activeTab === 'compensation' && ( … )}`, add:

```tsx
  const [storedSection, setStoredSection] = useState<SectionId | null>(null);
  const activeCompensationSection = resolveCompensationSection(
    pendingSection ?? storedSection,
    PROFILE_SECTIONS.compensation,
  );
```

Render `<CompensationSections active={activeCompensationSection} onChange={setStoredSection} needsPayout={needsPayoutSetup} payoutEscalated={escalatePayment} />` above the panes, and wrap the three panes in `AnimatePresence` with `custom={sectionSlideDirection(previous, activeCompensationSection)}`.

**Do not invent a private `compSection`.** Read `activeCompensationSection`.

- [ ] **Step 2: Re-gate the lazy fetch on the SECTION**

Replace the guard at `:828`:

```tsx
    // Gated on the SECTION, not the tab. Gated on the tab, every employee who
    // opens Compensation to check a bank detail would fire the payroll query —
    // and under SHOW_UNPAID_STAGED_PAYSTUBS that path runs per-week recovery.
    if (activeCompensationSection !== 'payStubs' || payStubsRequestedRef.current) return;
```

and set its deps to `[activeTab, activeCompensationSection]`.

- [ ] **Step 3: Reset pagination on list identity change, and anchor the pager**

`payStubPage` (`:811`) currently only clamps. Add a reset when the statement list's identity changes, and scroll to `profileSectionDomId('payStubs')` on page change — today paging mutates content above the viewport while the form below stays put.

- [ ] **Step 4: Re-word the bonuses disclaimer**

`:1705-1708` currently says bonuses are not shown here. It will now sit inches from a statement list that itemises PAB and Tech. Re-scope it to the rates block — e.g. *"These are your hourly rates only. Bonuses appear on each week's statement."* Do not delete it.

- [ ] **Step 5: Verify the fetch does not fire from the wrong section**

Run: `npm run dev`, open Profile → Compensation with DevTools Network filtered to `paystub`. Landing on **Rates** must fire **no** `/api/employee/paystub?summary=1`. Clicking **Pay Stubs** must fire it exactly once, and returning to Rates and back must not re-fire it.

- [ ] **Step 6: Type-check and commit**

Run: `npm run lint`
Expected: the `'payStubs'` TS2367 error is gone.

```bash
git status
git add src/components/employee/EmployeeProfile.tsx
git commit -m "feat(employee): rates and stubs share a tab without sharing a fetch"
```

---

## Task 11: Fold in the payout form

Spec §5.1 conditions 1 and 2. **This task must not re-gate the paystub fetch (Task 10 owns it) and must not touch the tabs array (Task 9 owns it).**

**Files:**
- Modify: `src/components/employee/EmployeeProfile.tsx:1893-2120`

**Interfaces:**
- Consumes: `activeCompensationSection` (Task 10).
- Produces: the `payout` section, and one derived `payoutPaneVisible` constant.

- [ ] **Step 1: Collapse the matched guard pair into one derived constant**

Today `:1897` and `:1909` are two near-identical guards twelve lines apart — `activeTab === 'payment' && !bankInfoLoaded` and `… && bankInfoLoaded`. Re-pointing one and not the other yields two stacked cards or none. Replace with:

```tsx
  // ONE derived visibility, used by BOTH the skeleton and the form, so the pair
  // cannot drift. Note this deliberately does NOT gate on bankInfoLoaded: the
  // Rates and Pay Stubs sections paint from cache immediately and must never
  // wait on the one uncacheable call in the wave.
  const payoutPaneVisible = activeTab === 'compensation' && activeCompensationSection === 'payout';
```

Then render `{payoutPaneVisible && !bankInfoLoaded && <PayoutSkeleton />}` and `{payoutPaneVisible && bankInfoLoaded && ( … )}`.

- [ ] **Step 2: Hold the line on the three conditions**

- **Do not widen `loading`** and do not add `bankInfoLoaded` to any combined effect.
- **Do not add a cache key.** `bankInfo`, `payout`, `walletRailEffective`, `bankPreferred`, `pendingBankPreferred` stay on plain `useState`. Task 13 enforces this.
- The Save keeps its **exact** disable expression `payoutSaving || payrollLocked || !payoutEditing` and stays inside this section. `savePaymentDetails` has no client-side field validation beyond the payroll lock — the disabled button *is* the guard.

- [ ] **Step 3: Verify the skeleton wins over the empty state**

Throttle the network and open Profile → Compensation → Payout for an employee who **has** saved bank details. You must see the skeleton, never the *"add your payout details"* copy from `:2006-2011`. That copy over someone who already has details is the failure this guards.

- [ ] **Step 4: Verify the bank-preferred picker still derives from form state**

Confirm `selectableBankPreferredOptions` keys off `preferredProcessor` state, not off `banking`/cache. A pane that paints partly from cache is exactly the shape that once offered a wire-only payee the wallet rails.

- [ ] **Step 5: Type-check and commit**

Run: `npm run lint`
Expected: **zero errors.** The expected-red window from Task 6 closes here. If any TS2367 remains, a retired id is still being compared — find it, do not widen the union.

```bash
git status
git add src/components/employee/EmployeeProfile.tsx
git commit -m "feat(employee): payout joins Compensation without making it wait"
```

---

## Task 12: Mask the card, and make it the payout read view

Spec §7.1, §7.2, §7.4. Runs after both the move (Task 4, for the path) and the payout merge (Task 11, for the section that hosts it).

**Files:**
- Create: `src/lib/banking/account-mask.ts`, `src/lib/banking/account-mask.test.ts`
- Modify: `src/components/banking/bank-card.tsx`, `src/components/employee/employee-payout-fields.tsx`, `src/components/employee/EmployeeProfile.tsx`

**Interfaces:**
- Produces: `export function maskAccount(value: string | null): string | null` — all but the last four characters replaced with bullets; a value of four or fewer becomes all bullets.
- `BankCard` gains `masked?: boolean` (**default `false`**, so Accounting's shipped call site is unchanged) and owns its own reveal state.

- [ ] **Step 1: Write the failing test**

Create `src/lib/banking/account-mask.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { maskAccount } from './account-mask';

test('all but the last four are bullets', () => {
  assert.equal(maskAccount('001234567890'), '••••••••7890');
});

test('a short value reveals nothing', () => {
  assert.equal(maskAccount('1234'), '••••');
});

test('absent stays absent', () => {
  assert.equal(maskAccount(null), null);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --import tsx --test src/lib/banking/account-mask.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement, and make the payout fields use it too**

Create `src/lib/banking/account-mask.ts` with the rule lifted from `employee-payout-fields.tsx:662-663`, then change that file to import it. **One rule, two call sites** — if the card and the fields mask differently, the same number reads two ways on one pane.

- [ ] **Step 4: Add masking and reveal to the card**

In `src/components/banking/bank-card.tsx`:

```tsx
  masked = false,
```

When `masked && !revealed`, the account value renders `maskAccount(account)` and:

```tsx
  // Disabled while masked. Handing `••••••7890` to the clipboard, silently, on a
  // money field is worse than offering no button at all.
  disabled={masked && !revealed}
```

Add a small reveal control inside the card. The reveal is **client-side only** — the full value is already in `bankInfo`. Do **not** add an audit-log write: the People audit trail records viewing *someone else's* record, and a payee viewing their own is not that event. Do **not** import `maskBanking` — it is `server-only`.

Leave untouched: the `ProcessorLogo` props (`monogram=""`, `fallback="icon"`, `FallbackIcon={Landmark}`), the no-theming rule, the verbatim account formatting, and the contrast floor.

- [ ] **Step 5: Wire it as the read view, gated on the effective rail**

In the payout section: render `<BankCard masked … />` when `!payoutEditing`, and `PayoutDetailsFields` when editing. Feed it from `pickPreferredBank(bankInfo)` — **never** from the `payout` draft, which collapses `swift_code ?? routing_number` into one field.

Gate on `walletRailEffective`, the server-resolved rail — not `preferredProcessor`, not `bankPreferred`:

| rail | card | wallet fields |
|---|---|---|
| `wires` | yes | no |
| `wise` | **yes** (paid into a bank, same field set as wires) | no |
| `jeeves` | yes | **yes** |
| `hurupay`/`kolan`, `wepay`, `higlobe` | **no** | **yes — never folded away** |

Include the `(!proc && !!prefBank.name)` fallback. A missing wallet payload **fails closed** — treat it as locked, never as "no rail".

**One home per value:** the four values on the card face must not also render in the grid below. Routing number and full address stay in the grid — they are wire instructions.

- [ ] **Step 6: Fix the mount-vs-visible animation**

The card's one-shot tilt-in fires on **mount**, but no visited tab unmounts, so it would play behind a hidden pane. Trigger it on section activation instead, keyed on `activeCompensationSection === 'payout'`.

- [ ] **Step 7: Verify against real shapes**

Run: `node --import tsx --test src/lib/banking/account-mask.test.ts && npm run lint`

Then in the browser confirm: a GoTyme payee sees a GoTyme-branded card; a MariBank payee sees a correct **neutral** card with no monogram; a Kolan payee sees **no card** and their wallet address still rendered; the copy button is disabled until revealed; and `<Toaster>` is mounted exactly once (both `app/layout.tsx` and `EmployeeApp` mount one — a double toast means one must go).

- [ ] **Step 8: Commit**

```bash
git status
git add src/lib/banking/account-mask.ts src/lib/banking/account-mask.test.ts src/components/banking/bank-card.tsx src/components/employee/employee-payout-fields.tsx src/components/employee/EmployeeProfile.tsx
git commit -m "feat(employee): your payout record now looks like the bank it goes to"
```

---

## Task 13: Prove cache conformance

Spec §6. Last, so the guard tests the final tree.

**Files:**
- Create: `src/lib/employee/profile-cache-conformance.test.ts`

**Interfaces:**
- Consumes: the finished `EmployeeProfile.tsx`. Produces: a standing guard.

- [ ] **Step 1: Write the guard**

Create `src/lib/employee/profile-cache-conformance.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EMPLOYEE_CACHE_KEYS } from './tab-cache';

const SRC = readFileSync(join(process.cwd(), 'src/components/employee/EmployeeProfile.tsx'), 'utf8');

test('the bank/payout row is never cached', () => {
  // tab-cache.ts:343-345, verbatim: "Bank/payout rows are deliberately NOT
  // cached: account numbers stay out of storage."
  for (const state of ['bankInfo', 'payout', 'walletRailEffective', 'bankPreferred', 'pendingBankPreferred']) {
    const cached = new RegExp(`const\\s*\\[\\s*${state}\\b[^\\]]*\\]\\s*=\\s*useEmployeeCachedState`);
    assert.ok(!cached.test(SRC), `${state} is cached — it comes from /api/employee-ids and holds account numbers`);
  }
});

test('every declared Profile cache key still has a live call site', () => {
  // A key whose call site the merge collapsed must be DELETED, not left orphaned.
  for (const key of ['profileMaster', 'profileRate', 'paystubSummary', 'profileSkillSet'] as const) {
    assert.ok(
      SRC.includes(`EMPLOYEE_CACHE_KEYS.${key}`),
      `EMPLOYEE_CACHE_KEYS.${key} is declared but no longer used — delete the key or restore the call site`,
    );
    assert.ok(EMPLOYEE_CACHE_KEYS[key], `${key} missing from EMPLOYEE_CACHE_KEYS`);
  }
});

test('no skip/freshness flag has crept in', () => {
  // The employee store deliberately has none; tab-cache.test.ts:323 pins this at
  // the module level, and this pins it at the call site.
  assert.ok(!/hasFetchedThisSession|skipIfFresh|ttlHit/.test(SRC));
});
```

- [ ] **Step 2: Run it**

Run: `node --import tsx --test src/lib/employee/profile-cache-conformance.test.ts`
Expected: PASS. If the bank test fails, a cache key reached the payout path — remove it; do not relax the guard.

- [ ] **Step 3: Decide the SCHEMA_VERSION question on evidence**

For each of the four keys, compare what the state held **before** this plan against what it holds now. The merge relocates panes; it should not change payloads. **If any payload shape moved, bump `SCHEMA_VERSION` at `src/lib/employee/tab-cache.ts:69` in this commit** — reads validate version, identity and age but never shape, so a stale blob would be read into a new shape for up to 12h and surface as wrong pesos, not a crash. Record the finding either way in the commit body.

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: green except the known `ManagerApp.tsx:1669` dept-label failure recorded in Task 2.

- [ ] **Step 5: Commit**

```bash
git status
git add src/lib/employee/profile-cache-conformance.test.ts
git commit -m "test(employee): pin the rule that account numbers never reach storage"
```

---

## Task 14: The docs, without which this is unfinished

CLAUDE.md: *"A feature without its doc is unfinished."* Spec §11. The Profile shell has no feature doc and no INDEX row today.

**Files:**
- Create: `docs/features/employee-profile.md`
- Modify: `docs/features/INDEX.md`, `docs/implementation-plans/implementation-plan-employee-surface-and-qc.md`, `docs/meetings/2026-09-09-carla-jackie-employee-surface-and-qc.md`, `docs/features/employee-dashboard-cache.md`, `docs/features/employee-id-card.md`, `docs/features/pre-release-security-readiness.md`, `docs/reference/components.md`, `docs/audits/audit-2026-09-12-session-log.md`

- [ ] **Step 1: Write the feature doc**

`docs/features/employee-profile.md` covering: the five tabs and why Compensation is the only one with a sub-strip; the intent-based deep-link contract and the nonce; the three hard conditions on the money tab; the cache contract and the never-cached list; the bank card's masking posture and the four-way rail gate; and — explicitly — that **162 people correctly see a neutral card** and that an unclaimed spelling correctly gets no brand, so neither is reported as a bug later.

- [ ] **Step 2: Correct the superseded lines**

- `implementation-plan-employee-surface-and-qc.md:475-481, :565-568, :572-576` — Payment now folds in; Compensation now lives with Pay Stubs.
- `2026-09-09-carla-jackie-employee-surface-and-qc.md:52, :75-77` — same, noting Kane's 2026-09-12 ruling supersedes the meeting.
- `employee-dashboard-cache.md:118-126` — the Profile's never-cache list now sits inside a merged tab.
- `employee-id-card.md:217-221` — re-take the `?email=` preview-download decision; its justification (*"the card carries no bank data"*) no longer holds.
- `pre-release-security-readiness.md:92` and `audit-2026-09-10-session-log.md:309` — `SHOW_UNPAID_STAGED_PAYSTUBS` moved to `src/lib/payroll/employee-paystubs.ts:77`.
- `pre-release-security-readiness.md:104` — it claims the off-by-one hits the ID card; the code says otherwise. Correct the doc.
- `components.md:692` — still says the Profile has "three tabs".

- [ ] **Step 3: Add the INDEX row**

Add a `docs/features/INDEX.md` row for the Employee Profile, wikilinked to `employee-id-card.md`, `employee-dashboard-cache.md`, `paystub-dispatch.md`, `bank-preferred-routing.md`, `people-bank-card.md`.

- [ ] **Step 4: Update the session log and memory**

Close rows 31, 32, 33, 34, 36 in `docs/audits/audit-2026-09-12-session-log.md` with what shipped; leave 35, 37–41 open with their current state. Update the memory entries `employee-profile-tab-merge` and `employee-profile-bank-card-reuse` from "spec written, NOT built" to what actually shipped.

- [ ] **Step 5: Commit by explicit path**

```bash
git status
git add docs/features/employee-profile.md docs/features/INDEX.md docs/features/employee-dashboard-cache.md docs/features/employee-id-card.md docs/features/pre-release-security-readiness.md docs/implementation-plans/implementation-plan-employee-surface-and-qc.md docs/meetings/2026-09-09-carla-jackie-employee-surface-and-qc.md docs/reference/components.md docs/audits/audit-2026-09-12-session-log.md
git commit -m "docs(employee-profile): the merged surface gets the doc it never had"
```

**Do not push.** Kane handles every push.

---

## Self-review notes

- **Spec coverage.** All 29 failure classes in spec §8 map to a task: #1–3 → Task 6; #4, #18 → Task 10; #5, #24–25 → Task 13; #6–7 → Task 11; #8 → Task 1; #9 → Task 9 step 6; #10 → Task 14; #11 → Task 9 step 5; #12 → Tasks 8/10; #13 → Task 10; #14 → Task 7 step 3 and Task 12 step 6; #15 → Task 7; #16–17 → Task 9; #19–21 → Task 11; #22 → Task 3; #23 → Task 2; #26 → Task 12; #27 → Task 4; #28 → Task 12 step 5; #29 → Task 12 step 7.
- **Deliberately deferred, and named as such:** §10 Q5 (the "Alternative account" chip wording — ships as-is), Q6 (offboarded + card — unruled, stays open), Q7 (`bank_last_self_updated_at` — not built). These are open items in the session log, not silent omissions.
- **Known non-green baseline:** `dept-label-render.test.ts` stays red on `ManagerApp.tsx:1669` throughout, by decision (spec §9).
