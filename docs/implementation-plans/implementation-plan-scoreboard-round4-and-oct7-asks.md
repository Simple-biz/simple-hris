# Accounting Scoreboard round 4 + the other Oct 7 asks: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **And per `CLAUDE.md`:** every task marked `hardening` runs through the `hardening` skill, and every task marked
> `blueprint` runs through the `blueprint` skill. This plan does not replace either of them. It gives them their scope,
> their tests, and their order.

> **Status: AWAITING KANE'S REVIEW (2026-10-07). Nothing is written to `src/`, `app/`, `references/` or `scripts/`.**
> Source record: [the Oct 7 meeting](../meetings/2026-10-07-carla-alivia-scoreboard-tasks-roles-and-interns.md).
> Tracked as Open items **391–397**, with this plan as **398**, in the
> [Sep 29 log](../audits/audit-2026-09-29-session-log.md).

**Goal:** Ship every ask from the 2026-10-07 call that can be built today: the scoreboard's round 4, the offboarding
queue's return notification and the interns' popup label. Then do the blocked ones as their rulings arrive.

**Architecture:** Everything stays inside the existing Accounting Scoreboard (`src/lib/accounting-scoreboard/`,
`app/api/accounting-scoreboard/`, `src/components/accounting-scoreboard/`). Each new behaviour gets one pure module with
`node:test` tests, a server read/write in `server.ts`, and a migration with a dry-run / apply / verify script. Two new
foundations go first: **board-local roles** and **an Admin-only weekly lock**. Every later table is born lock-aware and
role-gated, so nothing has to be retrofitted.

**Tech Stack:** Next.js (App Router) + TypeScript, Supabase Postgres through PostgREST (service role, server only),
`node --import tsx --test` for tests, `tsc --noEmit` for types, migration scripts in `scripts/*.mts` run with
`node --import tsx`.

**Spec:** `docs/meetings/2026-10-07-carla-alivia-scoreboard-tasks-roles-and-interns.md` (the asks, the quotes, the open
questions) and Open items 391–397. Governing doc: `docs/features/accounting-scoreboard.md`.

**How this plan was written, and its one weakness.** It comes from the governing docs and memory: the scoreboard's
feature doc (read in full), `orphanage-interns.md`, `offboarding-automation.md`, `external-api-offboarded.md`, and the
memory files `accounting-scoreboard`, `carla-accounting-scoreboard-sheet`, `orphanage-interns`,
`compliance-portal-pab-disqualifications`, `arriola-lead-gen-master-row-name-as-email` and
`orientation-noshow-never-reaches-offboarded`. **The scoreboard's source was not read in this session**: the permission
check refused a grep on `src/lib/accounting-scoreboard/`. So:
- **New modules** (roles, week lock, timing, tasks, chat message, pills) have full test and implementation code below,
  because this plan defines their interfaces.
- **Changes to existing functions** (`overviewSections`, `winRatio`, the Team Score, `entryAllowed`, the queue route)
  have exact test cases, written against the names the feature doc gives. The signatures are confirmed in each task's
  **Step 0**.
- **Every task starts with Step 0: read the named files and cite `file:line`.** If the code disagrees with this plan,
  the code wins. Fix the plan in the same commit and say so in the commit message.
- Table and column names in the SQL (`accounting_scoreboard_entries.day`, `..._collections.day`, `..._problems.day`)
  come from the docs. Step 0 of Task 5 confirms them against `references/sql/create/2026-10-01_accounting_scoreboard.sql`
  and the round-3 SQL before any trigger is written.

## Global Constraints

- Commit **directly to `main`**, by explicit path (`git add <path>`; never `-A` or `.`). Re-run `git status` before
  every commit. **Never push**: Kane pushes.
- `.env.local` is **production**. Every script is read-only unless Kane approves a write. Data writes ship as a Node
  script with an `--apply` gate. Every bulk write is preceded by a `SELECT` backup written to
  `docs/audits/backups/` (gitignored).
- **Migration FIRST, then the push** (scoreboard Deploy notes). The board selects every new column, and a missing one
  makes every read answer 503 "not set up yet" (it happened on 2026-10-07).
- Every new table: RLS on, `anon` and `authenticated` revoked, service role only. Each apply script's `--verify` proves
  `42501` for the anon key.
- Every read pages (`selectAllPaged`). PostgREST truncates at 1000 rows even with `.range()`.
- **A new read inside `readBoard()` must join a `BOARD_READS` group** in `load-progress.ts`. The load-progress test
  greps `server.ts` both ways, and fails otherwise.
- Logs are **append-only**: a trigger refuses every UPDATE except the one soft delete (or the one uncheck stamp), and
  refuses DELETE. Rows and types are **archived, never deleted**.
- **Absence is not zero**: never typed prints "—", a cleared cell is deleted, never stored as 0.
- Weeks are keyed by their **Sunday**; days are **US Eastern** (`todayEastern()`); the board keeps **Mon–Fri** only.
- **What a line counts as is marked on the row, never read from its label** (`bucket_day`, `due_soon`, `outcome`).
- UI: `SmoothSelect accent="orange" align="start" portal` (never a native `<select>`), `table-keep` on every
  `<table>`, motion gated on `useReducedMotion()`, `ui-standards.md`.
- The board **writes no pay**. Anything that would is a money path (Open item 315).
- Feature doc, `docs/features/INDEX.md` row, and memory are updated **in the same commit** as the code they describe.
- `next build` and `next dev` share `.next/`. Check for a running dev server before building.
- Test command: `node --import tsx --test <file>` for one file, `npm test` for all (two known pre-existing failures in
  `ManagerApp.tsx` guard tests are not this work's). Types: `npm run lint` (`tsc --noEmit`).

## Review Focus

The meeting implies these, no single task's happy path exercises them, and each would bite a real person. Each one has
its test in the owning task.

1. **A board cached in the browser before a deploy has none of the new fields** (`showOnOverview`, the `pre_arb` flag,
   payment runs). Expected: an old cache paints as "shown / unmarked / no runs", never a crash or a blank card, then the
   fetch replaces it. Tests: Task 1 Step 1 (case 4), Task 6 Step 1 (case 6).
2. **A save on a week that was locked while the cell was open.** Expected: the server answers 409 `week_locked`. The
   cell keeps the typed draft and says *"This week is locked. An Admin can reopen it."*, never a bare rose ring.
   Test: Task 5 Step 1 (`describeWriteRefusal`).
3. **The last Admin removes themselves** (or Carla leaves and nobody else holds Admin). Expected: revoking the last live
   Admin grant is refused, and an HRIS `admin` is always a board Admin, so the board can never be locked out of Setup or
   reopen. Test: Task 4 Step 1 (`canRevokeGrant`).
4. **A typo'd payment time** (start 10:00, end 19:00) turns the week's average red. Expected: a run over 60 minutes, or
   ending before it starts, is refused at save with the rule named. Test: Task 6 Step 1 (case 3).
5. **A queue row raised by someone outside the department is returned.** In the Arriola case Carla raised it and Jackie
   (Lead Gen's manager) is the one who wanted to know. Expected: the requester **and** the managers of the person's
   department are notified, de-duplicated, never the person who did the return. Test: Task 13 Step 1.

---

## 0. Scope

| Task | What | Open item | Kind | Migration | Blocked by |
|---|---|---|---|---|---|
| 1 | Hide a section from the Overview (and from the Team Score) | 391 (2) | `hardening` | yes (2 columns) | none |
| 2 | No Meeting Streak as date pills | 391 (3) | `hardening` (display) | no | none |
| 3 | Chargebacks: signs, a Pre-arb flag, a Net; then the ratio ruling | 392 | `hardening` | yes (CHECK + 1 row) | Net: none. Ratio: **W0.1** |
| 4 | Board-local roles: Team member / Assistant / Admin | 393 | `blueprint` | yes (1 table) | seed: **W0.6** (2nd Admin) |
| 5 | Admin-only weekly lock-in and reopen | 393 | `blueprint` | yes (1 table + triggers) | Task 4 |
| 6 | Sales Onboarding becomes a per-payment timing log | 391 (1) | `hardening` | yes (2 tables) | Task 5; import: **W0.5** |
| 7 | Per-person task boards | 393 | `blueprint` | yes (2 tables) + import | Tasks 4, 5 |
| 8 | Progress message: copy button, then Google Chat | 393 | `blueprint` | no | Task 7; Chat: **W0.4** |
| 9 | Monday's untyped Payroll Problems | 391 (4) | script or `hardening` | maybe | **W0.2** |
| 10 | Compliance filled from Kentshin's portal | 394 | `blueprint` | no | **W0.7** |
| 11 | Prove the job portal reads the Offboarded list | 395 | read-only probe | no | Kane runs it |
| 12 | Interns: measure, label the popup, then Ralph's ruling | 396 | probe + `hardening`; money | later | label: none. Money: **W0.8** |
| 13 | Notify on a returned offboarding queue row | 397 | `hardening` | no | none |

Not in scope: Open item 384's ruling on the Arriola ghost row (Kane's, unchanged). The heart icons (391 (5)) wait for
W0.3 (h). They are probably emoji typed into section names, which is not code.

## 1. Wave 0: decisions and values (no code)

| # | What | Who | Unblocks |
|---|---|---|---|
| W0.1 | **Pre-arb in the win ratio.** **RULED (a) 2026-10-07: counts as a loss.** | Kane | Task 3 Step 6 (unblocked) |
| W0.2 | **Monday 10-05's untyped Payroll Problems.** **RULED (a) 2026-10-07:** a script removes that week's old-grid counts after a backup, then the team re-logs them typed | Kane | Task 9 branch (a) (unblocked) |
| W0.3 | Carla confirms the CHOSEN defaults: (a) a card hidden from the Overview is out of the Team Score; (b) she hides the second section herself; (c) a payment run keeps Scheduled/Urgent as an optional field, duration = end − accounting start, times may carry seconds, runs over 60 min are refused; (d) the $25 fee is not added to the Net until she says so; (e) "bimonthly" = every two months; (f) as-needed tasks are listed but never counted; (g) a locked week also refuses Payment Verified ticks; (h) the hearts are emoji typed in names; (i) only an Admin adds or removes tasks | Carla (via Alivia) | Confirms; blocks nothing |
| W0.4 | The Google Chat **incoming webhook URL** for the accounting space, set as `ACCOUNTING_SCOREBOARD_CHAT_WEBHOOK_URL` in `.env.local` and Vercel. Kane started this on the call | Kane / Carla | Task 8 Steps 5–8 |
| W0.5 | The link to **Joana's sales sheet** (shared with the HRIS service account on the call) | Carla | Task 6 Steps 9–10 |
| W0.6 | **The second Admin** besides Carla ("Claire" in the transcript) | Carla | Task 4 seed |
| W0.7 | Ask Kentshin for the endpoint specified in Task 10 | Kane → Kentshin | Task 10 |
| W0.8 | Ralph: are hours over 5 payable; the monthly payout's rules; the PAB amount. Then Kane: the adjustment. **Kane: HOLD (2026-10-07)** | Alivia → Ralph, then Kane | Task 12 Steps 6+ |
| W0.9 | Run the Task 11 probe | Kane | Task 11 |

## 2. Build order, and why

1. **Wave 1, small and independent (`hardening`):** Tasks 1, 2, 3 (Net only), 12 (label only), 13. None depends on
   another. Tasks 1 and 3 each carry a small migration; apply and verify each one before its push.
2. **Wave 2, the foundations (`blueprint`):** Task 4, then Task 5. Roles come first because the lock's buttons are
   Admin-only. The lock comes before every new table, so Tasks 6 and 7 are born lock-aware: each one's migration attaches
   the same trigger, and each route calls the same `assertWeekOpen`.
3. **Wave 3, Task 6 (`hardening`).** It converts a built-in section, so it **deploys at a week boundary** (apply
   Saturday or Sunday Eastern, push before Monday). Round 3 converted Payroll Problems mid-week, and that is exactly
   why Carla's Monday entries are stranded as "No type" (Task 9). Never split a week across two models again.
4. **Wave 4, Tasks 7 then 8 (`blueprint`).**
5. **When unblocked:** Task 3 Step 6 (W0.1), Task 9 (W0.2), Task 10 (W0.7), Task 12 Steps 6+ (W0.8).

---

### Task 1: Hide a section from the Overview (391 (2))

`hardening`. Carla: *"I don't want this one on the overview, but I don't have a hide option."* Kane: *"setup will have
an option to hide it from the overview."* Carla: *"Under sections."*

**Files:**
- Create: `references/sql/create/2026-10-08_accounting_scoreboard_overview_visibility.sql`
- Create: `scripts/apply-accounting-scoreboard-overview-visibility-migration.mts` (copy the shape of
  `scripts/apply-accounting-scoreboard-outcomes-zero-migration.mts`: dry by default, `--apply`, `--verify`, batched,
  `lock_timeout = 10s`)
- Modify: `src/lib/accounting-scoreboard/sections.ts` (`overviewSections`), `team-score.ts`, `types.ts`, `validate.ts`
  (`parseSectionPatch` and the custom-section PATCH), `server.ts` (select the column),
  `src/components/accounting-scoreboard/SetupPanel.tsx` (the switch), the `Overview` component
- Test: `src/lib/accounting-scoreboard/sections.test.ts`, `team-score.test.ts`, `validate.test.ts`
- Docs: `docs/features/accounting-scoreboard.md` (new § "Hidden from the Overview"; the Team Score § gains one line)

**Interfaces:**
- Produces: `showOnOverview: boolean` on each section in the board payload (built-in and custom). Absent means `true`.
- Consumes: the existing `overviewSections`, `tabIdFor`, Team Score grouping.

- [ ] **Step 0: Read and cite.** `sections.ts` (`overviewSections`, `tabSections`, `boardSections`), `team-score.ts`
  (where cards are gathered), `validate.ts` (`parseSectionPatch`), the Setup → Sections UI, and how
  `accounting_scoreboard_sections` stores a built-in's switch and goal: one row per overridden section, or one per
  section. Write the `file:line`s into the commit message.

- [ ] **Step 1: Write the failing tests.** Use the existing fixtures in each file. Cases:
  1. `overviewSections` leaves out a built-in section whose `showOnOverview` is `false`. `tabSections` still includes
     its tab.
  2. A hosted custom section with `showOnOverview: false` has no card, and its grid still renders inside the host's tab
     (assert on the `withHosted` input or the tab's section list, whichever Step 0 found).
  3. Team Score: the 2026-10-07 production fixture that gives 87.1 gives the Team Score **without** a card once that
     card is hidden (compute the expected number by removing the card from the fixture, not by hand).
  4. **Review Focus 1:** a section object with no `showOnOverview` key at all is treated as shown.
  5. `parseSectionPatch({ showOnOverview: 'no' })` is refused with a message naming the field;
     `{ showOnOverview: false }` is accepted. The same for the custom-section PATCH.

- [ ] **Step 2: Run, and see them fail.**
  Run: `node --import tsx --test src/lib/accounting-scoreboard/sections.test.ts src/lib/accounting-scoreboard/team-score.test.ts src/lib/accounting-scoreboard/validate.test.ts`
  Expected: the new cases FAIL (an unknown field, or the card is still present).

- [ ] **Step 3: Write the migration.**

```sql
-- 2026-10-08: a section can be left off the Overview (Carla, 2026-10-07 meeting, Open item 391).
-- Absent row / NULL is never read: the column is NOT NULL DEFAULT true, so every existing section stays shown.
alter table public.accounting_scoreboard_sections
  add column if not exists show_on_overview boolean not null default true;
alter table public.accounting_scoreboard_custom_sections
  add column if not exists show_on_overview boolean not null default true;
```

  The apply script's `--verify`: both columns exist, are NOT NULL, and default to true; every existing row reads
  `true`; the anon key is still refused (`42501`) on both tables.

- [ ] **Step 4: Implement.** Add `showOnOverview` to the section types and the board payload (`server.ts` selects
  `show_on_overview`). Filter it in `overviewSections` with `s.showOnOverview !== false` (so a missing key is shown).
  Team Score gathers its cards from `overviewSections`, so a hidden card leaves the score. If Step 0 found it gathers
  from somewhere else, apply the same filter there. Setup → Sections: a "Show on Overview" switch on every built-in and
  custom section, next to the existing on/off switch, PATCHing `{ showOnOverview }`.

- [ ] **Step 5: Run the tests and see them pass.** Same command as Step 2, then `npm test` and `npm run lint`.

- [ ] **Step 6: Dry-run the migration** (`node --import tsx scripts/apply-accounting-scoreboard-overview-visibility-migration.mts`).
  **Stop for Kane's go**, then `--apply` and `--verify`.

- [ ] **Step 7: Commit** (doc + INDEX + memory in the same commit).

```bash
git add references/sql/create/2026-10-08_accounting_scoreboard_overview_visibility.sql scripts/apply-accounting-scoreboard-overview-visibility-migration.mts src/lib/accounting-scoreboard/sections.ts src/lib/accounting-scoreboard/team-score.ts src/lib/accounting-scoreboard/types.ts src/lib/accounting-scoreboard/validate.ts src/lib/accounting-scoreboard/server.ts src/lib/accounting-scoreboard/sections.test.ts src/lib/accounting-scoreboard/team-score.test.ts src/lib/accounting-scoreboard/validate.test.ts src/components/accounting-scoreboard/SetupPanel.tsx docs/features/accounting-scoreboard.md docs/features/INDEX.md
git commit -m "feat(accounting-scoreboard): a section can be hidden from the Overview and the Team Score (item 391)"
```

---

### Task 2: The No Meeting Streak as date pills (391 (3))

`hardening`, display only. Carla: *"Can you make this prettier? Just like we want it to be like, yes, five days, no
meeting. Keep it going, guys."* Kane: *"date pills"*. Use the `impeccable` skill for the visual pass.

**Files:**
- Create: `src/lib/accounting-scoreboard/meeting-pills.ts`, `meeting-pills.test.ts`
- Modify: the PM Buckets header where `noMeetingStreak` renders (Step 0 finds it: `SectionGrid.tsx` or `ScoreboardApp`)
- Docs: `accounting-scoreboard.md` § PM Buckets

**Interfaces:**
- Produces: `weekMeetingPills(weekStart: string, meetingDays: ReadonlySet<string>, todayEastern: string): MeetingPill[]`,
  `type MeetingPill = { day: string; state: 'clear' | 'meeting' | 'future' }`
- Consumes: the board's PM meeting ticks (the days with any meeting ticked this week), `todayEastern()`.

- [ ] **Step 0: Read and cite** where the streak is computed and rendered, and how the week's meeting ticks reach the
  client. If `week.ts` already has an add-days helper, use it instead of `addDaysIso` below.

- [ ] **Step 1: Write the failing test.**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { weekMeetingPills } from './meeting-pills';

test('Mon–Fri pills: clear, meeting, and the days still ahead', () => {
  const pills = weekMeetingPills('2026-10-04', new Set(['2026-10-06']), '2026-10-07');
  assert.deepEqual(pills, [
    { day: '2026-10-05', state: 'clear' },
    { day: '2026-10-06', state: 'meeting' },
    { day: '2026-10-07', state: 'clear' },
    { day: '2026-10-08', state: 'future' },
    { day: '2026-10-09', state: 'future' },
  ]);
});

test('a past week has no future pills', () => {
  const pills = weekMeetingPills('2026-09-27', new Set(), '2026-10-07');
  assert.ok(pills.every((p) => p.state === 'clear'));
});
```

- [ ] **Step 2: Run** `node --import tsx --test src/lib/accounting-scoreboard/meeting-pills.test.ts`. Expected: FAIL,
  module not found.

- [ ] **Step 3: Implement.**

```ts
export type MeetingPill = { day: string; state: 'clear' | 'meeting' | 'future' };

function addDaysIso(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Mon–Fri of the week keyed by its Sunday. Today counts as clear until a meeting is ticked. */
export function weekMeetingPills(
  weekStart: string,
  meetingDays: ReadonlySet<string>,
  todayEastern: string,
): MeetingPill[] {
  return [1, 2, 3, 4, 5].map((i) => {
    const day = addDaysIso(weekStart, i);
    const state = day > todayEastern ? 'future' : meetingDays.has(day) ? 'meeting' : 'clear';
    return { day, state };
  });
}
```

- [ ] **Step 4: Run, and see it pass.**

- [ ] **Step 5: Render.** The header reads *"5 days, no meeting. Keep it going!"* (the streak number stays the
  computed `noMeetingStreak`, all-time). Under it are five date pills: `clear` filled emerald with the weekday and date,
  `meeting` neutral with a small calendar icon, `future` dashed outline. The pill's text says the state too (colour is
  never the only signal), it gets `aria-label="Mon Oct 5: no meeting"`, and it is amber once the streak passes 7 days
  (the existing rule). Run `impeccable` on it. Verify in the esbuild + Playwright harness (memory
  `accounting-scoreboard` § Verifying the UI) at 1360 px and 390 px, light and dark, and under reduced motion.

- [ ] **Step 6: Commit** the module, test, component and doc by explicit path:
  `feat(accounting-scoreboard): the No Meeting Streak as this week's date pills (item 391)`.

---

### Task 3: Chargebacks: signs, a Pre-arb flag, and a Net (392)

`hardening`. Carla: *"a loss is a negative, but I can't put a dash right here"*. Kane: *"Wins positive. PR losses have
negative."* Carla: *"Yes."* **CHOSEN: the sign comes from the line's flag, never typed.** That is the board's rule
("what a line counts as is marked on the row") and it keeps the 0–100,000 rule on every box. A typed minus beside a
"loss" flag would double-negate. People keep typing positive amounts, and the board shows Losses and Pre-arb with a
minus and adds a **Net** line.

**Files:**
- Create: `references/sql/create/2026-10-08_accounting_scoreboard_pre_arb_flag.sql`,
  `scripts/apply-accounting-scoreboard-pre-arb-flag-migration.mts`
- Modify: `src/lib/accounting-scoreboard/scoring.ts` (add `outcomesNet`; later `winRatio`), `types.ts`, `validate.ts`
  (accept `pre_arb` in the row's outcome), `SetupPanel.tsx` (Rows → "Counts as Pre-arb"), the Outcomes grid footer in
  `SectionGrid.tsx`
- Test: `src/lib/accounting-scoreboard/scoring.test.ts`, `validate.test.ts`, `sections.test.ts` (if it pins the CHECK)
- Docs: `accounting-scoreboard.md` § Chargebacks (the "Not built … item 317 (a)" line becomes built)

**Interfaces:**
- Produces: `type OutcomeFlag = 'win' | 'loss' | 'pre_arb' | null`;
  `outcomesNet(lines: readonly { outcome: OutcomeFlag; weekUsd: number | null }[]): number | null`
- Consumes: `rows.outcome`, each Outcomes line's week `usd`.

- [ ] **Step 0: Read and cite** `winRatio` and its test, the live text of CHECK `acct_sb_rows_outcome_valid` (from
  `references/sql/create/2026-10-07_accounting_scoreboard_outcomes_and_zero_problems.sql`), how the Outcomes footer is
  built, and where a line's week `usd` is summed.

- [ ] **Step 1: Write the failing tests** (add to `scoring.test.ts`):

```ts
test('Net = wins minus losses minus pre-arb, by dollars', () => {
  assert.equal(outcomesNet([
    { outcome: 'win', weekUsd: 99 },
    { outcome: 'loss', weekUsd: 50 },
    { outcome: 'pre_arb', weekUsd: 30 },
  ]), 19);
});
test('all losses is a real negative, never hidden', () => {
  assert.equal(outcomesNet([{ outcome: 'loss', weekUsd: 50 }]), -50);
});
test('nothing marked, or nothing typed, is "—" (null), never 0', () => {
  assert.equal(outcomesNet([{ outcome: null, weekUsd: 80 }]), null);
  assert.equal(outcomesNet([{ outcome: 'win', weekUsd: null }]), null);
});
test('cents survive', () => {
  assert.equal(outcomesNet([{ outcome: 'win', weekUsd: 10.1 }, { outcome: 'loss', weekUsd: 0.2 }]), 9.9);
});
test('until W0.1 is ruled, pre-arb stays out of the win ratio', () => {
  // existing winRatio signature, confirmed in Step 0; 3 wins, 1 loss, 1 pre-arb → 75.0
});
```

  In `validate.test.ts`: a row PATCH with `outcome: 'pre_arb'` is accepted on an Outcomes line and refused on any
  other section.

- [ ] **Step 2: Run** `node --import tsx --test src/lib/accounting-scoreboard/scoring.test.ts src/lib/accounting-scoreboard/validate.test.ts`.
  Expected: FAIL (`outcomesNet` not exported; `pre_arb` refused).

- [ ] **Step 3: Write the migration.** Copy the live CHECK from Step 0 **verbatim** and add only `'pre_arb'` to its
  value list. If the live CHECK reads as below, the change is:

```sql
alter table public.accounting_scoreboard_rows drop constraint acct_sb_rows_outcome_valid;
alter table public.accounting_scoreboard_rows add constraint acct_sb_rows_outcome_valid
  check (outcome is null or (outcome in ('win', 'loss', 'pre_arb') and section_key = 'chargeback_outcomes'));
-- Data step (backed up first by the apply script): flag the live "Pre-arb" Outcomes line.
-- The script selects it by section + live + label, refuses unless exactly ONE row matches, writes the backup, then:
-- update public.accounting_scoreboard_rows set outcome = 'pre_arb' where id = '<the one id>';
```

  `--verify`: `'pre_arb'` accepted on an Outcomes row inside a rolled-back transaction, refused on another section,
  `'draw'` refused, the live Pre-arb row flagged, Wins/Losses unchanged, anon `42501`.

- [ ] **Step 4: Implement** `outcomesNet` in `scoring.ts`:

```ts
export type OutcomeFlag = 'win' | 'loss' | 'pre_arb' | null;

export function outcomesNet(
  lines: readonly { outcome: OutcomeFlag; weekUsd: number | null }[],
): number | null {
  const marked = lines.filter((l) => l.outcome !== null && l.weekUsd !== null);
  if (marked.length === 0) return null;
  const cents = marked.reduce(
    (sum, l) => sum + Math.round((l.weekUsd as number) * 100) * (l.outcome === 'win' ? 1 : -1),
    0,
  );
  return cents / 100;
}
```

  Footer: each Loss and Pre-arb week $ prints with a leading minus in rose (`−$50.00`). A **Net** line prints
  `+$19.00` / `−$31.00`, emerald when ≥ 0 and rose when below, with the word "Net". The win-ratio footer is unchanged.
  Setup → Rows gets "Counts as Pre-arb" beside win / loss / not counted. The Amount box hint: *"Type the amount. A loss
  shows as negative."*

- [ ] **Step 5: Run the tests, `npm test`, `npm run lint`; dry-run the migration; stop for Kane's go; `--apply`,
  `--verify`; commit** by explicit path:
  `feat(accounting-scoreboard): Losses and Pre-arb show negative, with a Net, by flag never by typed sign (item 392)`.

- [ ] **Step 6 (only after W0.1 = (a)):** change `winRatio` to count `pre_arb` lines as losses. Change the Step 1 test to
  `3 wins, 1 loss, 1 pre-arb → 60.0`, and rewrite the doc's CHOSEN line as *"Pre-arb counts as a loss (Carla, 2026-10-07;
  ruled by Kane on <date>)"*. If W0.1 = (b), add one line to the doc that Carla's reading was heard and declined, and
  change nothing else. Commit separately.

---

### Task 4: Board-local roles: Team member / Assistant / Admin (393)

`blueprint`. Carla: *"I would love for this not to be available to anybody except Claire. I don't want anybody to change
anything."* Team member edits everything except Setup; Assistant sees Setup but can't change it and sees everyone's
tasks; Admin has full write. Not an edit/view/hidden matrix (Carla: *"Nah."*).

**This changes a documented rule, and says so:** today "Managers are the `admin` and `accounting` roles". After this, an
HRIS `admin` is always a board Admin (break glass), and **HRIS `accounting` alone makes a Team member, not a manager**.
That is Carla's ask, but it removes Setup and delete-anyone's-line from about 9 `accounting` holders. Memory says **2 of
the 11 `accounting` holders are not on the GML**, so they would lose access entirely unless added under Setup →
Members. The blueprint brief lists them by count, and the migration's dry run prints them.

**Files:**
- Create: `src/lib/accounting-scoreboard/roles.ts`, `roles.test.ts`,
  `references/sql/create/2026-10-09_accounting_scoreboard_roles.sql`,
  `scripts/apply-accounting-scoreboard-roles-migration.mts`, `app/api/accounting-scoreboard/roles/route.ts`
  (GET / POST grant / DELETE revoke, Admin only)
- Modify: `server.ts` (the member check returns a `BoardRole`; every write route asks `can(role, action)` instead of
  `isManager`), `app/accounting-scoreboard/page.tsx` (passes `viewer.role`), `types.ts` (`viewer.isManager` →
  `viewer.role`), `SetupPanel.tsx` (read-only for Assistant; a new **Access** area for Admin), `ScoreboardApp.tsx`
- Test: `roles.test.ts`; update the route tests that assert manager behaviour
- Docs: `accounting-scoreboard.md` § Who may open it (rewritten), memory, INDEX

**Interfaces:**
- Produces: `type BoardRole = 'admin' | 'assistant' | 'member'`; `type BoardAction`;
  `can(role: BoardRole, action: BoardAction): boolean`;
  `resolveBoardRole(i: { hrisRoles: readonly string[]; grant: 'admin' | 'assistant' | null; isMember: boolean }): BoardRole | null`;
  `canRevokeGrant(grant: { role: 'admin' | 'assistant' }, liveAdminGrants: number): boolean`
- Consumes: the existing member check (`expandWorkEmailAliases`, `accounting_scoreboard_members`).

- [ ] **Step 0: Read and cite** `server.ts`'s member check and every place that reads `isManager` (routes and
  components). List them in the brief: each one becomes a named `BoardAction`.

- [ ] **Step 1: Write the failing tests.**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { can, canRevokeGrant, resolveBoardRole, type BoardAction, type BoardRole } from './roles';

test('an HRIS admin is always a board Admin (break glass)', () => {
  assert.equal(resolveBoardRole({ hrisRoles: ['admin'], grant: null, isMember: false }), 'admin');
});
test('HRIS accounting alone is a Team member, not a manager', () => {
  assert.equal(resolveBoardRole({ hrisRoles: ['accounting'], grant: null, isMember: true }), 'member');
  assert.equal(resolveBoardRole({ hrisRoles: ['accounting'], grant: null, isMember: false }), null);
});
test('a grant is the role, and it is membership', () => {
  assert.equal(resolveBoardRole({ hrisRoles: [], grant: 'assistant', isMember: false }), 'assistant');
  assert.equal(resolveBoardRole({ hrisRoles: [], grant: 'admin', isMember: false }), 'admin');
});
test('nobody else gets in', () => {
  assert.equal(resolveBoardRole({ hrisRoles: [], grant: null, isMember: false }), null);
});
test('the permission table', () => {
  const cases: Array<[BoardRole, BoardAction, boolean]> = [
    ['member', 'edit_cells', true], ['member', 'log_lines', true], ['member', 'view_setup', false],
    ['member', 'delete_any_line', false], ['member', 'lock_week', false], ['member', 'view_all_tasks', false],
    ['assistant', 'view_setup', true], ['assistant', 'edit_setup', false], ['assistant', 'view_all_tasks', true],
    ['assistant', 'manage_tasks', false], ['assistant', 'reopen_week', false],
    ['admin', 'edit_setup', true], ['admin', 'delete_any_line', true], ['admin', 'lock_week', true],
    ['admin', 'reopen_week', true], ['admin', 'manage_tasks', true], ['admin', 'manage_roles', true],
  ];
  for (const [role, action, expected] of cases) assert.equal(can(role, action), expected, `${role} ${action}`);
});
test('Review Focus 3: the last Admin grant cannot be revoked', () => {
  assert.equal(canRevokeGrant({ role: 'admin' }, 1), false);
  assert.equal(canRevokeGrant({ role: 'admin' }, 2), true);
  assert.equal(canRevokeGrant({ role: 'assistant' }, 1), true);
});
```

- [ ] **Step 2: Run** `node --import tsx --test src/lib/accounting-scoreboard/roles.test.ts`. Expected: FAIL, module not found.

- [ ] **Step 3: Implement `roles.ts`.**

```ts
export type BoardRole = 'admin' | 'assistant' | 'member';
export type BoardAction =
  | 'edit_cells' | 'log_lines' | 'delete_any_line'
  | 'view_setup' | 'edit_setup'
  | 'view_all_tasks' | 'manage_tasks'
  | 'lock_week' | 'reopen_week' | 'manage_roles';

const MEMBER: readonly BoardAction[] = ['edit_cells', 'log_lines'];
const ASSISTANT: readonly BoardAction[] = [...MEMBER, 'view_setup', 'view_all_tasks'];
const ADMIN: readonly BoardAction[] = [
  ...ASSISTANT, 'delete_any_line', 'edit_setup', 'manage_tasks', 'lock_week', 'reopen_week', 'manage_roles',
];
const TABLE: Record<BoardRole, ReadonlySet<BoardAction>> = {
  member: new Set(MEMBER),
  assistant: new Set(ASSISTANT),
  admin: new Set(ADMIN),
};

export function can(role: BoardRole, action: BoardAction): boolean {
  return TABLE[role].has(action);
}

export function resolveBoardRole(i: {
  hrisRoles: readonly string[];
  grant: 'admin' | 'assistant' | null;
  isMember: boolean;
}): BoardRole | null {
  if (i.hrisRoles.includes('admin')) return 'admin';
  if (i.grant) return i.grant;
  return i.isMember ? 'member' : null;
}

/** The board must always keep one granted Admin; an HRIS admin is the break glass on top. */
export function canRevokeGrant(grant: { role: 'admin' | 'assistant' }, liveAdminGrants: number): boolean {
  return grant.role !== 'admin' || liveAdminGrants > 1;
}
```

- [ ] **Step 4: Run, and see it pass.**

- [ ] **Step 5: The migration.**

```sql
create table if not exists public.accounting_scoreboard_roles (
  id uuid primary key default gen_random_uuid(),
  email text not null check (email = lower(btrim(email)) and email like '%_@_%'),
  role text not null check (role in ('admin', 'assistant')),
  granted_by text not null,
  granted_at timestamptz not null default now(),
  revoked_by text,
  revoked_at timestamptz,
  constraint acct_sb_roles_revoke_pair check ((revoked_at is null) = (revoked_by is null))
);
create unique index if not exists acct_sb_roles_one_live
  on public.accounting_scoreboard_roles (email) where revoked_at is null;

-- Append-only: the only UPDATE is the revoke stamp, once. No DELETE.
create or replace function public.acct_sb_roles_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'acct_sb_roles: grants are revoked, never deleted'; end if;
  if old.revoked_at is not null
     or new.email is distinct from old.email or new.role is distinct from old.role
     or new.granted_by is distinct from old.granted_by or new.granted_at is distinct from old.granted_at then
    raise exception 'acct_sb_roles: only the revoke stamp may change, once';
  end if;
  return new;
end $$;
create trigger acct_sb_roles_guard before update or delete on public.accounting_scoreboard_roles
  for each row execute function public.acct_sb_roles_guard();

alter table public.accounting_scoreboard_roles enable row level security;
revoke all on public.accounting_scoreboard_roles from anon, authenticated;

-- Seed: Carla, and the second Admin from W0.6 (the script takes both as arguments; it refuses to apply without them).
```

  The apply script prints, read-only, **how many** current `accounting` holders lose manager rights, and how many lose
  access entirely (not on the GML and not on `accounting_scoreboard_members`). It prints counts, never names.

- [ ] **Step 6: Wire it.** `server.ts` resolves `BoardRole` once per request. Every route that checked `isManager` now
  checks `can(role, <action>)` (Step 0's list). The roles route refuses with `canRevokeGrant` and writes
  `accounting_scoreboard.role_granted` / `role_revoked` to the audit log, registered in `src/lib/audit/registry.ts`.
  Setup is read-only for Assistant (inputs disabled, with *"Only an Admin can change Setup"*). Admin gets an **Access**
  area: grant Admin or Assistant by email (picked from the board's people, or typed), and revoke.

- [ ] **Step 7: Run everything.** `npm test` and `npm run lint`. Then the harness checks: a member sees no Setup, an
  Assistant sees it disabled, an Admin edits it. Dry-run, **stop for Kane's go**, apply, verify.

- [ ] **Step 8: Commit** by explicit path:
  `feat(accounting-scoreboard): board-local roles, Admin / Assistant / Team member, HRIS accounting no longer manages (item 393)`.

---

### Task 5: Admin-only weekly lock-in and reopen (393)

`blueprint`. Carla: *"If I've locked it in, it's you can't change it anymore, but I can still change all this stuff."*
Kane: *"Lock in weekly results. Only Carla, our admin. Reopen."* Carla: *"reopen and it would have to be only admin
only."*

CHOSEN, each confirmable under W0.3:
- A week can be locked from its **Friday** (Eastern) on, never earlier, because locking mid-week would stop today's
  typing.
- A lock refuses **every** dated write in that week (cells, collections and their soft delete, Payment Verified ticks,
  problems, payment runs), **for everyone, Admin included**. An Admin reopens first.
- Setup is never locked (*"I can still change all this stuff"*), and neither are task ticks (tasks are not the week's
  results).
- Lock and reopen are stamps, never deletes. The history of who locked and reopened stays.

**Files:**
- Create: `src/lib/accounting-scoreboard/week-lock.ts`, `week-lock.test.ts`,
  `references/sql/create/2026-10-09_accounting_scoreboard_week_locks.sql`,
  `scripts/apply-accounting-scoreboard-week-locks-migration.mts`, `app/api/accounting-scoreboard/week-lock/route.ts`
  (POST lock / POST reopen, Admin only)
- Modify: `server.ts` (`readBoard` reads the live lock and joins a `BOARD_READS` group; every dated write calls
  `assertWeekOpen`), `load-progress.ts` (+ its test), `types.ts` (`week.lock`), `ScoreboardApp.tsx` (the header's lock
  pill and Admin buttons; every input disabled when locked)
- Docs: `accounting-scoreboard.md` new § "Locking a week"

**Interfaces:**
- Produces: `canLockWeek(weekStart: string, todayEastern: string): boolean`;
  `type WeekLockRow = { week_start: string; locked_by: string; locked_at: string; reopened_at: string | null }`;
  `liveLock(rows: readonly WeekLockRow[], weekStart: string): WeekLockRow | null`;
  `describeWriteRefusal(status: number, body: { error?: string; lockedBy?: string; lockedAt?: string }): string`;
  the SQL function `public.acct_sb_refuse_locked_week()` (Tasks 6 and 7 attach it to their tables)
- Consumes: `can(role, 'lock_week' | 'reopen_week')` from Task 4; `week.ts`'s Sunday key.

- [ ] **Step 0: Read and cite** the exact table and date-column names of every dated write (expected:
  `accounting_scoreboard_entries.day`, `accounting_scoreboard_collections.day`,
  `accounting_scoreboard_problems.day`; `accounting_scoreboard_collection_verifications` → its collection's day) from
  the 2026-10-01 and round-3 SQL, and every write route under `app/api/accounting-scoreboard/`.

- [ ] **Step 1: Write the failing tests.**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canLockWeek, describeWriteRefusal, liveLock } from './week-lock';

test('a week can be locked from its Friday on, never before', () => {
  assert.equal(canLockWeek('2026-10-04', '2026-10-08'), false); // Thursday
  assert.equal(canLockWeek('2026-10-04', '2026-10-09'), true);  // Friday
  assert.equal(canLockWeek('2026-09-27', '2026-10-07'), true);  // a past week
  assert.equal(canLockWeek('2026-10-11', '2026-10-09'), false); // a future week
});
test('the live lock is the one not reopened', () => {
  const rows = [
    { week_start: '2026-10-04', locked_by: 'a', locked_at: '2026-10-09T21:00:00Z', reopened_at: '2026-10-10T13:00:00Z' },
    { week_start: '2026-10-04', locked_by: 'a', locked_at: '2026-10-10T14:00:00Z', reopened_at: null },
  ];
  assert.equal(liveLock(rows, '2026-10-04')?.locked_at, '2026-10-10T14:00:00Z');
  assert.equal(liveLock(rows.slice(0, 1), '2026-10-04'), null);
  assert.equal(liveLock(rows, '2026-09-27'), null);
});
test('Review Focus 2: a locked-week refusal says so, in words', () => {
  assert.equal(
    describeWriteRefusal(409, { error: 'week_locked', lockedBy: 'Carla', lockedAt: 'Fri Oct 9' }),
    'This week is locked (Carla, Fri Oct 9). An Admin can reopen it.',
  );
});
```

- [ ] **Step 2: Run** `node --import tsx --test src/lib/accounting-scoreboard/week-lock.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement `week-lock.ts`.**

```ts
export type WeekLockRow = { week_start: string; locked_by: string; locked_at: string; reopened_at: string | null };

function addDaysIso(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** From the week's Friday (Eastern) on. weekStart is the Sunday key. */
export function canLockWeek(weekStart: string, todayEastern: string): boolean {
  return todayEastern >= addDaysIso(weekStart, 5);
}

export function liveLock(rows: readonly WeekLockRow[], weekStart: string): WeekLockRow | null {
  return rows.find((r) => r.week_start === weekStart && r.reopened_at === null) ?? null;
}

export function describeWriteRefusal(
  status: number,
  body: { error?: string; lockedBy?: string; lockedAt?: string },
): string {
  if (status === 409 && body.error === 'week_locked') {
    const who = [body.lockedBy, body.lockedAt].filter(Boolean).join(', ');
    return `This week is locked${who ? ` (${who})` : ''}. An Admin can reopen it.`;
  }
  return body.error ?? 'The save was refused.';
}
```

  (If `week.ts` already exports an add-days helper, import it and delete the local one.)

- [ ] **Step 4: Run, and see it pass.**

- [ ] **Step 5: The migration** (names from Step 0):

```sql
create table if not exists public.accounting_scoreboard_week_locks (
  id uuid primary key default gen_random_uuid(),
  week_start date not null check (extract(dow from week_start) = 0),
  locked_by text not null,
  locked_at timestamptz not null default now(),
  reopened_by text,
  reopened_at timestamptz,
  constraint acct_sb_week_locks_reopen_pair check ((reopened_at is null) = (reopened_by is null))
);
create unique index if not exists acct_sb_week_locks_one_live
  on public.accounting_scoreboard_week_locks (week_start) where reopened_at is null;
-- (+ the same append-only guard as the roles table: only the reopen stamp may change, once; no DELETE)

create or replace function public.acct_sb_week_is_locked(d date) returns boolean language sql stable as $$
  select exists (
    select 1 from public.accounting_scoreboard_week_locks l
    where l.reopened_at is null and l.week_start = d - extract(dow from d)::int
  );
$$;

-- The last line of defence for any table with a `day` column. Checks the old day too, so a row can't be moved out.
create or replace function public.acct_sb_refuse_locked_week() returns trigger language plpgsql as $$
begin
  if tg_op in ('UPDATE', 'DELETE') and public.acct_sb_week_is_locked(old.day) then
    raise exception 'week_locked' using errcode = 'P0001', detail = old.day::text;
  end if;
  if tg_op in ('INSERT', 'UPDATE') and public.acct_sb_week_is_locked(new.day) then
    raise exception 'week_locked' using errcode = 'P0001', detail = new.day::text;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;

create trigger acct_sb_entries_week_lock before insert or update or delete on public.accounting_scoreboard_entries
  for each row execute function public.acct_sb_refuse_locked_week();
create trigger acct_sb_collections_week_lock before insert or update or delete on public.accounting_scoreboard_collections
  for each row execute function public.acct_sb_refuse_locked_week();
create trigger acct_sb_problems_week_lock before insert or update or delete on public.accounting_scoreboard_problems
  for each row execute function public.acct_sb_refuse_locked_week();
-- Verifications have no day: a separate trigger looks up its collection's day (column name from Step 0).

alter table public.accounting_scoreboard_week_locks enable row level security;
revoke all on public.accounting_scoreboard_week_locks from anon, authenticated;
```

  `--verify`, each case inside a rolled-back transaction: lock a past week, then an entry insert, a collection soft
  delete, a verification insert and a problem insert into it each raise `week_locked`. A write into the week after
  succeeds. A reopen lets the write through. A second live lock on the same week is refused. Anon `42501`.

- [ ] **Step 6: Wire it.** `assertWeekOpen(day)` in `server.ts` reads the live lock and answers **409**
  `{ error: 'week_locked', lockedBy, lockedAt }` before the database is touched. The trigger's `week_locked` is mapped
  to the same 409 if it ever fires first. The lock route: POST `{ weekStart, action: 'lock' | 'reopen' }`,
  `can(role, 'lock_week')` / `'reopen_week'`, `canLockWeek` for a lock, audit `accounting_scoreboard.week_locked` /
  `week_reopened` (registered). UI: the week header shows *"Locked by Carla, Fri Oct 9"* with a lock icon. Every input
  in that week is disabled with that sentence as its title. The Admin gets **Lock week** (only when `canLockWeek`) or
  **Reopen**, each behind a confirm dialog (never `window.confirm`). A save that loses the race shows
  `describeWriteRefusal` and keeps the draft.

- [ ] **Step 7: `npm test`, `npm run lint`, harness** (lock, a typed cell refused with the sentence, reopen, the same
  save succeeds). Dry-run, **stop for Kane's go**, apply, verify. **Commit** by explicit path:
  `feat(accounting-scoreboard): Admins lock a finished week, and reopen it; a DB trigger refuses writes into a locked week (item 393)`.

---

### Task 6: Sales Onboarding becomes a per-payment timing log (391 (1))

`hardening` (it converts the built-in `onboarding` section, the way round 3 converted Payroll Problems). Carla:
*"As long as payments stay with under three minutes average a week per payment, that's good. […] Three is like bottom.
Two is like wow. One is perfect."*

CHOSEN, confirmable under W0.3 (c):
- One line per payment: **day, sales rep (a row of the section), amount (USD, optional), kind (Scheduled / Urgent,
  optional), time the sales message came in (optional), billing rep (a board member), time started, time ended,
  result (a Setup-managed list, like Problem types)**. Duration = ended − started.
- **The headline is the week's average duration** (`m:ss`), goal **below 3:00**, judged whole and never paced (an
  average). The tier word: ≤ 1:00 *Perfect*, ≤ 2:00 *Wow*, ≤ 3:00 *Good*, above *Slow*. Payments logged this week is a
  chip.
- Times are Eastern clock times with optional seconds. A run that ends before it starts, or lasts over 60 minutes, is
  refused, with the rule named (Review Focus 4).
- **The old daily grid becomes read-only**, exactly like Payroll Problems: its typed counts still count as payments
  for their weeks, labelled *"Typed before the log"*. **Deploy at a week boundary** (§ 2).
- Sales reps never get access (Carla). Joana logs, or the sheet import below does.

**Files:**
- Create: `src/lib/accounting-scoreboard/payment-timing.ts`, `payment-timing.test.ts`,
  `references/sql/create/2026-10-10_accounting_scoreboard_payment_runs.sql`,
  `scripts/apply-accounting-scoreboard-payment-runs-migration.mts`,
  `app/api/accounting-scoreboard/payment-runs/route.ts` (POST / DELETE soft),
  `app/api/accounting-scoreboard/run-results/route.ts` (POST / PATCH archive, Admin),
  `src/components/accounting-scoreboard/PaymentRunsPanel.tsx`,
  `scripts/import-accounting-scoreboard-payment-runs.mts` (after W0.5)
- Modify: `sections.ts` (`onboarding`: no slots, a log kind, goal below 180 s `average`), `server.ts` (+ `BOARD_READS`),
  `load-progress.ts` (+ test), `board.ts` (headline), `team-score.ts` (below-average form already exists),
  `validate.ts`, `types.ts`, `ScoreboardApp.tsx` (the tab renders `PaymentRunsPanel`), `SetupPanel.tsx` (Result types)
- Docs: `accounting-scoreboard.md` new § "Sales Onboarding: a payment-timing log"; the sections table row

**Interfaces:**
- Produces: `parseClock(s: string): number | null`;
  `runDurationSeconds(r: { started_at: string | null; ended_at: string | null }): number | null`;
  `timingTier(avgSeconds: number): 'perfect' | 'wow' | 'good' | 'slow'`;
  `weekTimingStats(runs): { count: number; timed: number; averageSeconds: number | null; tier: TimingTier | null }`;
  `MAX_RUN_SECONDS = 3600`
- Consumes: `assertWeekOpen` and `acct_sb_refuse_locked_week()` (Task 5); `can(role, 'log_lines' | 'delete_any_line' | 'edit_setup')` (Task 4).

- [ ] **Step 0: Read and cite** how round 3 turned Payroll Problems into a log: the section definition, `entryAllowed`,
  the problems route, `problemsWeekStats`, and how old-grid counts are read as "No type". Copy that path, not a new one.

- [ ] **Step 1: Write the failing tests.**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_RUN_SECONDS, parseClock, runDurationSeconds, timingTier, weekTimingStats } from './payment-timing';

test('1. clock times, with or without seconds', () => {
  assert.equal(parseClock('9:05'), 32700);
  assert.equal(parseClock('09:05:30'), 32730);
  for (const bad of ['', '24:00', '9:5', '9:60', 'noon', '9:05:60']) assert.equal(parseClock(bad), null, bad);
});
test('2. duration = ended − started; incomplete runs have none', () => {
  assert.equal(runDurationSeconds({ started_at: '10:00:00', ended_at: '10:02:15' }), 135);
  assert.equal(runDurationSeconds({ started_at: '10:00:00', ended_at: null }), null);
});
test('3. Review Focus 4: backwards or over an hour is not a duration', () => {
  assert.equal(runDurationSeconds({ started_at: '10:05:00', ended_at: '10:00:00' }), null);
  assert.equal(runDurationSeconds({ started_at: '10:00:00', ended_at: '19:00:00' }), null);
  assert.equal(MAX_RUN_SECONDS, 3600);
});
test("4. Carla's tiers: one is perfect, two is wow, three is the bottom", () => {
  assert.equal(timingTier(60), 'perfect');
  assert.equal(timingTier(61), 'wow');
  assert.equal(timingTier(120), 'wow');
  assert.equal(timingTier(180), 'good');
  assert.equal(timingTier(181), 'slow');
});
test('5. the week average skips untimed runs and counts every run', () => {
  const s = weekTimingStats([
    { started_at: '10:00:00', ended_at: '10:01:00' },
    { started_at: '11:00:00', ended_at: '11:02:00' },
    { started_at: '12:00:00', ended_at: '12:03:00' },
    { started_at: '13:00:00', ended_at: null },
  ]);
  assert.deepEqual(s, { count: 4, timed: 3, averageSeconds: 120, tier: 'wow' });
});
test('6. Review Focus 1: no runs (or an old cached board) is "—", never 0:00', () => {
  assert.deepEqual(weekTimingStats([]), { count: 0, timed: 0, averageSeconds: null, tier: null });
});
```

  In `validate.test.ts`: a POST with `ended_at` before `started_at` is refused with *"The end time is before the start
  time."*; a 61-minute run is refused with *"Over an hour. Check the times."*; a Saturday is refused; a missing sales
  rep is refused.

- [ ] **Step 2: Run** `node --import tsx --test src/lib/accounting-scoreboard/payment-timing.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement `payment-timing.ts`.**

```ts
export const MAX_RUN_SECONDS = 3600;
export type TimingTier = 'perfect' | 'wow' | 'good' | 'slow';
type RunTimes = { started_at: string | null; ended_at: string | null };

export function parseClock(s: string): number | null {
  const m = /^(\d{1,2}):([0-5]\d)(?::([0-5]\d))?$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  if (h > 23) return null;
  return h * 3600 + Number(m[2]) * 60 + Number(m[3] ?? 0);
}

export function runDurationSeconds(r: RunTimes): number | null {
  if (!r.started_at || !r.ended_at) return null;
  const a = parseClock(r.started_at);
  const b = parseClock(r.ended_at);
  if (a === null || b === null || b < a || b - a > MAX_RUN_SECONDS) return null;
  return b - a;
}

export function timingTier(avgSeconds: number): TimingTier {
  if (avgSeconds <= 60) return 'perfect';
  if (avgSeconds <= 120) return 'wow';
  if (avgSeconds <= 180) return 'good';
  return 'slow';
}

export function weekTimingStats(runs: readonly RunTimes[]) {
  const durations = runs.map(runDurationSeconds).filter((d): d is number => d !== null);
  const averageSeconds = durations.length
    ? Math.round(durations.reduce((sum, d) => sum + d, 0) / durations.length)
    : null;
  return {
    count: runs.length,
    timed: durations.length,
    averageSeconds,
    tier: averageSeconds === null ? null : timingTier(averageSeconds),
  };
}
```

- [ ] **Step 4: Run, and see it pass.**

- [ ] **Step 5: The migration.**

```sql
create table if not exists public.accounting_scoreboard_run_results (
  id uuid primary key default gen_random_uuid(),
  label text not null check (length(btrim(label)) between 1 and 60),
  created_by text not null, created_at timestamptz not null default now(),
  archived_by text, archived_at timestamptz,
  constraint acct_sb_run_results_archive_pair check ((archived_at is null) = (archived_by is null))
);
create unique index if not exists acct_sb_run_results_live_label
  on public.accounting_scoreboard_run_results (lower(label)) where archived_at is null;

create table if not exists public.accounting_scoreboard_payment_runs (
  id uuid primary key default gen_random_uuid(),
  day date not null check (extract(isodow from day) between 1 and 5),
  sales_rep_row_id uuid not null references public.accounting_scoreboard_rows(id),
  amount_usd numeric(12, 2) check (amount_usd is null or (amount_usd >= 0 and amount_usd <= 10000000)),
  kind text check (kind is null or kind in ('scheduled', 'urgent')),
  message_at time(0),
  billing_rep_email text not null check (billing_rep_email = lower(billing_rep_email)),
  started_at time(0),
  ended_at time(0),
  result_id uuid references public.accounting_scoreboard_run_results(id),
  logged_by text not null,
  logged_at timestamptz not null default now(),
  deleted_by text, deleted_at timestamptz,
  constraint acct_sb_runs_delete_pair check ((deleted_at is null) = (deleted_by is null)),
  constraint acct_sb_runs_order check (started_at is null or ended_at is null or ended_at >= started_at),
  constraint acct_sb_runs_max_hour check (
    started_at is null or ended_at is null or ended_at - started_at <= interval '1 hour')
);
-- Append-only (the collections log's trigger, copied: only the soft delete, once) + the lock trigger from Task 5:
create trigger acct_sb_payment_runs_week_lock before insert or update or delete
  on public.accounting_scoreboard_payment_runs for each row execute function public.acct_sb_refuse_locked_week();
alter table public.accounting_scoreboard_payment_runs enable row level security;
alter table public.accounting_scoreboard_run_results enable row level security;
revoke all on public.accounting_scoreboard_payment_runs, public.accounting_scoreboard_run_results from anon, authenticated;
```

  Also: whatever round 3 did to give Payroll Problems "no slots" (Step 0), done for `onboarding`, with the
  `sections.test.ts` ↔ SQL pin updated.

- [ ] **Step 6: Wire it.** POST validates in `validate.ts` (times through `parseClock`, the rules from Step 1), calls
  `assertWeekOpen(day)`, and inserts. DELETE is the soft delete by the logger or `can(role, 'delete_any_line')`. The
  board's onboarding headline is `weekTimingStats(...).averageSeconds` as `m:ss`, with the tier word and *"N payments"*
  (runs + typed-before-the-log counts). Overview card and Team Score: below 180 average, using the existing below-average
  form `MIN(goal ÷ actual, 1) × 100`. `PaymentRunsPanel` copies `CollectionsPanel`'s form and list: SmoothSelect for
  the rep, billing rep, kind and result; time inputs as text with an `HH:MM[:SS]` hint (no native time input: memory
  `picker-popups-escape-clipping`); the duration shown live as you type; `table-keep`.

- [ ] **Step 7: `npm test`, `npm run lint`, harness** (log three runs → average and tier; a backwards run refused with
  the sentence; a locked week refuses; a cached board with no `runs` paints "—"). Dry-run, **stop for Kane's go**, then
  apply on a **Saturday or Sunday Eastern** and verify. Kane pushes before Monday. **Commit** by explicit path:
  `feat(accounting-scoreboard): Sales Onboarding is a payment-timing log, average under 3:00 (item 391)`.

- [ ] **Step 8 (after W0.5): read Joana's sheet** with the HRIS service account, read-only (`spreadsheets.readonly`).
  Print only column headers, row counts per week, distinct Result values, and the time format. No names. Write the
  layout into the feature doc.

- [ ] **Step 9 (after Step 8): `scripts/import-accounting-scoreboard-payment-runs.mts`**, dry by default: maps each sheet
  row to a run (rep → row by a mapping file kept in `docs/audits/backups/`, gitignored, since it holds names), prints
  counts and refusals (backwards, over an hour, unknown rep), seeds Result types from the distinct values, writes a
  backup, and only inserts with `--apply` after Kane's go. Commit the script (never the mapping):
  `feat(accounting-scoreboard): import Joana's sales-timing sheet into the payment log (item 391)`.

---

### Task 7: Per-person task boards (393)

`blueprint`. Carla: *"every person has a task board […] daily task, weekly task, bi-weekly, monthly, bimonthly,
quarterly, annually. And then there's tasks that just come up on our desk and we do them as they are needed."* And:
*"I just want to replace that where everybody's task board is on our scoreboard, but somehow get it to where like we have
this as a drop down or like a switch that says scoreboard task"*.

CHOSEN, confirmable under W0.3 (e), (f), (i):
- A **Scoreboard | Tasks** switch in the header. Tasks shows **your own board**. An Admin or Assistant gets a person
  picker (*"mine would have a view of everybody's taskboard"*).
- A task has an owner, a title and a frequency. **Only an Admin adds, renames, reorders or archives tasks.** The owner
  ticks their own. An Admin may untick anyone's (the Payment Verified pattern: stamps, never deletes).
- A tick belongs to the task's **current period**: the day, the week (Sunday key), a two-week block anchored on Sunday
  2026-01-04, the month, a two-month block starting Jan / Mar / May / Jul / Sep / Nov, the quarter, or the year, all in
  US Eastern.
- **As-needed tasks are listed, never counted** (*"if it's needed, cool, do it. If it's not, okay, whatever"*).
- Changing a task's frequency = archive it and add a new one, so old ticks never change meaning.
- Tasks are not week results, so the weekly lock does not apply to them.

**Files:**
- Create: `src/lib/accounting-scoreboard/tasks.ts`, `tasks.test.ts`,
  `references/sql/create/2026-10-12_accounting_scoreboard_tasks.sql`,
  `scripts/apply-accounting-scoreboard-tasks-migration.mts`,
  `app/api/accounting-scoreboard/tasks/route.ts` (GET mine or a person's · POST/PATCH/archive, Admin),
  `app/api/accounting-scoreboard/tasks/checks/route.ts` (POST tick · DELETE = the uncheck stamp),
  `src/components/accounting-scoreboard/TasksPanel.tsx`,
  `scripts/import-accounting-scoreboard-tasks.mts`
- Modify: `ScoreboardApp.tsx` (the switch), `types.ts`, `validate.ts`, `server.ts` (tasks read on their own route, NOT
  in `readBoard`, so the board's load is unchanged)
- Docs: a new `docs/features/accounting-scoreboard-tasks.md` + INDEX row; `accounting-scoreboard.md` § Not built loses
  "task checklists"

**Interfaces:**
- Produces: `TASK_FREQUENCIES`, `type TaskFrequency`, `taskPeriodKey(freq: TaskFrequency, dayEastern: string): string | null`,
  `type FrequencyProgress = { frequency: Exclude<TaskFrequency, 'as_needed'>; total: number; done: number }`,
  `taskProgress(tasks, checks, todayEastern): FrequencyProgress[]`
- Consumes: `can(role, 'manage_tasks' | 'view_all_tasks')` (Task 4); the member identity bridge (`expandWorkEmailAliases`).

- [ ] **Step 0: Read and cite** the member check's alias handling (so a person signed in under an alternate address
  sees their own board), and the Payment Verified tick/untick routes (the pattern for task checks).

- [ ] **Step 1: Write the failing tests.**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taskPeriodKey, taskProgress } from './tasks';

test('period keys on Wednesday 2026-10-07 (Eastern)', () => {
  assert.equal(taskPeriodKey('daily', '2026-10-07'), '2026-10-07');
  assert.equal(taskPeriodKey('weekly', '2026-10-07'), '2026-10-04');
  assert.equal(taskPeriodKey('biweekly', '2026-10-07'), '2026-09-27');
  assert.equal(taskPeriodKey('monthly', '2026-10-07'), '2026-10-01');
  assert.equal(taskPeriodKey('bimonthly', '2026-10-07'), '2026-09-01');
  assert.equal(taskPeriodKey('quarterly', '2026-10-07'), '2026-10-01');
  assert.equal(taskPeriodKey('annually', '2026-10-07'), '2026-01-01');
  assert.equal(taskPeriodKey('as_needed', '2026-10-07'), null);
});
test('week edges: Sunday starts a week, Saturday ends it', () => {
  assert.equal(taskPeriodKey('weekly', '2026-10-04'), '2026-10-04');
  assert.equal(taskPeriodKey('weekly', '2026-10-10'), '2026-10-04');
  assert.equal(taskPeriodKey('biweekly', '2026-10-10'), '2026-09-27');
  assert.equal(taskPeriodKey('biweekly', '2026-10-11'), '2026-10-11');
});
test('progress: live tasks, live ticks, this period only, as-needed never counted', () => {
  const tasks = [
    { id: 'd1', frequency: 'daily' as const, archived_at: null },
    { id: 'd2', frequency: 'daily' as const, archived_at: null },
    { id: 'd3', frequency: 'daily' as const, archived_at: '2026-10-01T00:00:00Z' },
    { id: 'w1', frequency: 'weekly' as const, archived_at: null },
    { id: 'n1', frequency: 'as_needed' as const, archived_at: null },
  ];
  const checks = [
    { task_id: 'd1', period_key: '2026-10-07', unchecked_at: null },
    { task_id: 'd2', period_key: '2026-10-07', unchecked_at: '2026-10-07T15:00:00Z' },
    { task_id: 'd2', period_key: '2026-10-06', unchecked_at: null },
    { task_id: 'w1', period_key: '2026-10-04', unchecked_at: null },
  ];
  assert.deepEqual(taskProgress(tasks, checks, '2026-10-07'), [
    { frequency: 'daily', total: 2, done: 1 },
    { frequency: 'weekly', total: 1, done: 1 },
  ]);
});
```

- [ ] **Step 2: Run** `node --import tsx --test src/lib/accounting-scoreboard/tasks.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement `tasks.ts`.**

```ts
export const TASK_FREQUENCIES = [
  'daily', 'weekly', 'biweekly', 'monthly', 'bimonthly', 'quarterly', 'annually', 'as_needed',
] as const;
export type TaskFrequency = (typeof TASK_FREQUENCIES)[number];
export type FrequencyProgress = { frequency: Exclude<TaskFrequency, 'as_needed'>; total: number; done: number };

/** A Sunday. CHOSEN; confirm the two-week rhythm against Carla's sheet when importing. */
const BIWEEKLY_ANCHOR = '2026-01-04';
const DAY_MS = 86_400_000;
const pad = (n: number) => String(n).padStart(2, '0');

function addDaysIso(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function sundayOf(iso: string): string {
  return addDaysIso(iso, -new Date(`${iso}T00:00:00Z`).getUTCDay());
}

export function taskPeriodKey(freq: TaskFrequency, day: string): string | null {
  const y = Number(day.slice(0, 4));
  const m = Number(day.slice(5, 7));
  switch (freq) {
    case 'daily': return day;
    case 'weekly': return sundayOf(day);
    case 'biweekly': {
      const weeks = Math.round((Date.parse(sundayOf(day)) - Date.parse(BIWEEKLY_ANCHOR)) / DAY_MS / 7);
      return addDaysIso(BIWEEKLY_ANCHOR, Math.floor(weeks / 2) * 14);
    }
    case 'monthly': return `${y}-${pad(m)}-01`;
    case 'bimonthly': return `${y}-${pad(m - ((m - 1) % 2))}-01`;
    case 'quarterly': return `${y}-${pad(m - ((m - 1) % 3))}-01`;
    case 'annually': return `${y}-01-01`;
    case 'as_needed': return null;
  }
}

export function taskProgress(
  tasks: readonly { id: string; frequency: TaskFrequency; archived_at: string | null }[],
  checks: readonly { task_id: string; period_key: string; unchecked_at: string | null }[],
  todayEastern: string,
): FrequencyProgress[] {
  const live = new Set(checks.filter((c) => c.unchecked_at === null).map((c) => `${c.task_id}|${c.period_key}`));
  const counted = TASK_FREQUENCIES.filter((f): f is FrequencyProgress['frequency'] => f !== 'as_needed');
  return counted
    .map((frequency) => {
      const own = tasks.filter((t) => t.archived_at === null && t.frequency === frequency);
      const key = taskPeriodKey(frequency, todayEastern);
      return { frequency, total: own.length, done: own.filter((t) => live.has(`${t.id}|${key}`)).length };
    })
    .filter((p) => p.total > 0);
}
```

  (If `week.ts` exports a Sunday-key or add-days helper, import it instead.)

- [ ] **Step 4: Run, and see it pass.**

- [ ] **Step 5: The migration.**

```sql
create table if not exists public.accounting_scoreboard_tasks (
  id uuid primary key default gen_random_uuid(),
  owner_email text not null check (owner_email = lower(btrim(owner_email))),
  title text not null check (length(btrim(title)) between 1 and 300),
  frequency text not null check (frequency in
    ('daily', 'weekly', 'biweekly', 'monthly', 'bimonthly', 'quarterly', 'annually', 'as_needed')),
  sort_order integer not null default 0,
  created_by text not null, created_at timestamptz not null default now(),
  archived_by text, archived_at timestamptz,
  constraint acct_sb_tasks_archive_pair check ((archived_at is null) = (archived_by is null))
);
create index if not exists acct_sb_tasks_owner on public.accounting_scoreboard_tasks (owner_email) where archived_at is null;
-- Guard: UPDATE may change title / sort_order on a live task, or set the archive stamp once. Never owner or frequency. No DELETE.

create table if not exists public.accounting_scoreboard_task_checks (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.accounting_scoreboard_tasks(id),
  period_key date not null,
  checked_by text not null, checked_at timestamptz not null default now(),
  unchecked_by text, unchecked_at timestamptz,
  constraint acct_sb_task_checks_uncheck_pair check ((unchecked_at is null) = (unchecked_by is null))
);
create unique index if not exists acct_sb_task_checks_one_live
  on public.accounting_scoreboard_task_checks (task_id, period_key) where unchecked_at is null;
-- Guard: the only UPDATE is the uncheck stamp, once. No DELETE. (The Payment Verified pattern.)

alter table public.accounting_scoreboard_tasks enable row level security;
alter table public.accounting_scoreboard_task_checks enable row level security;
revoke all on public.accounting_scoreboard_tasks, public.accounting_scoreboard_task_checks from anon, authenticated;
```

  The server computes `period_key` from `taskPeriodKey(task.frequency, todayEastern())`. The client never sends it.
  An as-needed task refuses a tick.

- [ ] **Step 6: Wire it.** The routes check `can(role, …)`. A member may GET only their own tasks (resolved through the
  alias bridge) and tick only their own. `TasksPanel`: sections per frequency in Carla's order, each with
  *"done of total this period"*, tickable rows, the as-needed list last and greyed. Admin: add / rename / reorder /
  archive inline. Admin and Assistant: the person picker plus an **All** view (each person's done/total per frequency).

- [ ] **Step 7: The import** (`scripts/import-accounting-scoreboard-tasks.mts`), dry by default. It reads the
  scoreboard sheet (`1JqLyLtO…`, already shared with the HRIS service account) read-only. **Detect each tab's layout by
  finding its header cells** (the frequency words and the day columns), never by fixed column letters: the **Florida
  tabs carry an extra column with Monday in a different place** (Carla). It prints, per tab: the detected layout,
  tasks per frequency, and anything it could not place. Tab → person mapping lives in a gitignored file under
  `docs/audits/backups/`. It imports **tasks only, never ticks** (the sheet's ticks are this week's state). Inserts
  happen only with `--apply` after Kane's go.

- [ ] **Step 8: `npm test`, `npm run lint`, harness** (a member's own board and tick; an Assistant sees everyone and
  can't edit; an Admin adds and archives; a weekly tick still counts on Thursday; an as-needed row has no checkbox).
  Dry-run, **stop for Kane's go**, apply, verify, import dry run → Kane → `--apply`. **Commit** by explicit path:
  `feat(accounting-scoreboard): per-person task boards with daily → annual frequencies (item 393)`.

---

### Task 8: The progress message: a copy button, then Google Chat (393)

`blueprint`. The team chat gets this by hand today: *"Current progress, 98 out of 170 daily tasks and 13 of 80 weekly
tasks have been completed. As you complete your task, remember to check them off"*. Carla is fine with a copy-paste
note. Kane: *"Connect accounting scoreboard to accounting group chat."*

CHOSEN: ship the **Copy message** button first (needs nothing). Then a **Post to Chat** button (Admin) once W0.4's URL
exists. A **scheduled** post comes only after Kane names the time, and only once the scheduler is proven to fire: a Vercel
cron in this project never ran (memory `scheduled-deletion-cron-never-ran`), so the first scheduled post is watched.

**Files:**
- Create: `src/lib/accounting-scoreboard/chat-summary.ts`, `chat-summary.test.ts`,
  `app/api/accounting-scoreboard/tasks/post-progress/route.ts`
- Modify: `TasksPanel.tsx` (the two buttons), `.env.example` (`ACCOUNTING_SCOREBOARD_CHAT_WEBHOOK_URL=`, server-only),
  `src/lib/audit/registry.ts` (`accounting_scoreboard.tasks_progress_posted`)

**Interfaces:**
- Produces: `buildProgressMessage(progress: readonly FrequencyProgress[]): string`
- Consumes: `taskProgress` (Task 7) over every person's tasks.

- [ ] **Step 1: Write the failing test.**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProgressMessage } from './chat-summary';

test("the team chat's message, in its own words", () => {
  assert.equal(
    buildProgressMessage([
      { frequency: 'daily', total: 170, done: 98 },
      { frequency: 'weekly', total: 80, done: 13 },
    ]),
    'Current progress: 98 of 170 daily tasks and 13 of 80 weekly tasks have been completed. ' +
      'As you complete your tasks, remember to check them off.',
  );
});
test('three or more frequencies are a list', () => {
  assert.match(
    buildProgressMessage([
      { frequency: 'daily', total: 2, done: 1 },
      { frequency: 'weekly', total: 2, done: 2 },
      { frequency: 'monthly', total: 1, done: 0 },
    ]),
    /^Current progress: 1 of 2 daily tasks, 2 of 2 weekly tasks and 0 of 1 monthly tasks have been completed\./,
  );
});
test('no tasks', () => {
  assert.equal(buildProgressMessage([]), 'No tasks on the board yet.');
});
```

- [ ] **Step 2: Run** `node --import tsx --test src/lib/accounting-scoreboard/chat-summary.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.**

```ts
import type { FrequencyProgress } from './tasks';

const WORD: Record<FrequencyProgress['frequency'], string> = {
  daily: 'daily', weekly: 'weekly', biweekly: 'bi-weekly', monthly: 'monthly',
  bimonthly: 'bimonthly', quarterly: 'quarterly', annually: 'annual',
};

export function buildProgressMessage(progress: readonly FrequencyProgress[]): string {
  if (progress.length === 0) return 'No tasks on the board yet.';
  const parts = progress.map((p) => `${p.done} of ${p.total} ${WORD[p.frequency]} tasks`);
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return `Current progress: ${list} have been completed. As you complete your tasks, remember to check them off.`;
}
```

- [ ] **Step 4: Run, and see it pass. Then the Copy button**: Admin and Assistant see **Copy message** in Tasks → All,
  which copies `buildProgressMessage` over the whole team. **Commit**:
  `feat(accounting-scoreboard): a copy-ready team task progress message (item 393)`.

- [ ] **Step 5 (after W0.4): the post route.** `POST /api/accounting-scoreboard/tasks/post-progress`,
  `can(role, 'manage_tasks')`. It reads the URL from `process.env.ACCOUNTING_SCOREBOARD_CHAT_WEBHOOK_URL` (unset → 503
  *"Google Chat isn't connected yet"*, and the button is disabled with that reason). It POSTs
  `{ "text": <message> }` with `Content-Type: application/json; charset=UTF-8` and a 10 s abort. A non-2xx answer becomes
  a 502 naming Google's status. It **never echoes the URL**, which carries a key. It writes the audit row.

- [ ] **Step 6: Test the route's refusal paths** (no env → 503; a member → 403) in the repo's route-test style (Step 0
  of Task 4 found it).

- [ ] **Step 7: Post once for real, with Kane watching the space**, and record the time in the doc.

- [ ] **Step 8: Commit**:
  `feat(accounting-scoreboard): post the team's task progress to the accounting Google Chat (item 393)`.
  A scheduled post is a separate, later commit (time from Kane, scheduler proven first).

---

### Task 9: Monday's untyped Payroll Problems (391 (4)), after W0.2

**Contradiction until ruled:** *"the grid takes no writes"* (feature doc § Payroll Problems) vs Carla's *"I don't have an
option to edit or delete the Monday problems"*.

- **If (a):** `scripts/clear-accounting-scoreboard-problem-grid-week.mts --week 2026-10-04`, dry by default. It lists the
  old-grid Payroll Problems entries in that week (count per day and row, no names in the output), refuses if the week
  holds no grid entries or if any entry is newer than the round-3 apply (2026-10-06 18:04Z), and writes a backup to
  `docs/audits/backups/`. With `--apply` it **deletes** them (a cleared cell is a deleted entry, by the board's rule), and
  `--revert <backup>` restores them. Then Carla's team re-logs them with types. Commit:
  `fix(accounting-scoreboard): script to clear one week's untyped Payroll Problems grid counts (item 391, Kane ruled (a))`.
- **If (b):** `hardening` on `entryAllowed` for `payroll_problems`: Admin only, weeks before the round-3 cutover only,
  tests for both limits. This loosens a documented rule, so the hardening skill records it as Kane's ruling.
- **If (c):** one line in the feature doc that Carla asked and the answer was no. No code.

---

### Task 10: Compliance from Kentshin's portal (394), after W0.7

`blueprint`. Precedent: the PAB-disqualifications design for the same portal (memory
`compliance-portal-pab-disqualifications`, item 312), which follows the OMS pull: env vars, a server-only route, a
**manual Load button**, never polling.

**What to ask Kentshin for (W0.7):** `GET https://compliance-violation-portal.vercel.app/api/webhooks/hris-compliance-week?week_start=YYYY-MM-DD`,
header `x-webhook-secret` (the portal's existing scheme), answering
`{ week_start, generated_at, violations: [{ id, worker_email, violation_date, offense_number, offboarded }] }`, with
`offense_number` = 1, 2, 3… counted over the worker's whole history (not just the week), and `offboarded` true when the
violation led to an offboarding. Week = Sunday–Saturday, dates US Eastern.

**Then build:** env `COMPLIANCE_PORTAL_URL` + `COMPLIANCE_PORTAL_SECRET` (shared with item 312). Route
`GET /api/accounting-scoreboard/compliance/pull?week=` (Admin), which calls the portal server-side. A pure
`complianceDayCounts(violations)` → per weekday `{ first, second, thirdPlus, offboardings }` (tests: offense 1/2/3/5 land
in 1st/2nd/3+/3+; a weekend date is reported as outside the board, never dropped; an empty week is all "—", not 0). The
Compliance tab gets **Load from compliance portal**, a side-by-side of portal vs typed per day, and **Apply**, which writes
only through the existing entries path (stamped, lock-aware) into four Compliance lines marked on the row (a new
`compliance_kind` flag, never the label). Open for Carla (W0.3): which of the four counts the ≥ 30 goal judges.

---

### Task 11: Prove the job portal reads the Offboarded list (395)

Read-only. Kane runs it (this session's attempt was refused by the permission check). It **reads tables directly**.
Never curl `/api/external/*` on local dev: even a denied call writes a production `external_api_requests` row (memory
`external-api-offboarded`).

- [ ] **Step 1: Create `scripts/probe-external-api-offboarded-usage.mts`.**

```ts
// READ-ONLY. Which external API keys hold offboarded.read, and have they called the offboarded route since 10-06?
// Prints key names, scopes and counts. Never prints key hashes or prefixes.
import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';

const env = Object.fromEntries(
  fs.readFileSync('.env.local', 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => {
    const i = l.indexOf('=');
    return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')];
  }),
);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const { data: clients, error } = await sb
  .from('external_api_clients')
  .select('id,name,system,scopes,revoked_at,last_used_at')
  .order('created_at');
if (error) throw new Error(error.message);
for (const c of clients) {
  console.log(`${c.name} (${c.system}) scopes=${c.scopes.join(',')} revoked=${!!c.revoked_at} last_used=${c.last_used_at ?? 'never'}`);
}

const { data: reqs, error: e2 } = await sb
  .from('external_api_requests')
  .select('client_id,status,denial,created_at')
  .ilike('path', '%offboarded%')
  .gte('created_at', '2026-10-06T00:00:00Z')
  .limit(1000);
if (e2) throw new Error(e2.message);
const byClient = new Map<string, number>();
for (const r of reqs) {
  const name = clients.find((c) => c.id === r.client_id)?.name ?? '(no key)';
  const k = `${name} ${r.status}${r.denial ? ` ${r.denial}` : ''}`;
  byClient.set(k, (byClient.get(k) ?? 0) + 1);
}
console.log(`offboarded-route requests since 2026-10-06: ${reqs.length}${reqs.length === 1000 ? ' (capped at 1000)' : ''}`);
for (const [k, n] of byClient) console.log(`  ${k}: ${n}`);
```

- [ ] **Step 2: Kane runs** `node --import tsx scripts/probe-external-api-offboarded-usage.mts`.
  **Expected if Kane's claim holds:** the job portal's key lists `offboarded.read`, and at least one `200` from it.
- [ ] **Step 3: If the scope is missing,** Kane ticks Offboarded on that key (Admin → Webhooks & Integrations →
  Integrations, the Datasets step) and tells Rainer. **If the scope is there but there are no calls,** ask Rainer whether
  the portal's reapply check is live ("Unless Rainer is not done with us yet").
- [ ] **Step 4: Record the result** on Open items 395 and 343 and in memory `external-api-offboarded`; commit the probe
  script and the log edit by explicit path.

---

### Task 12: Interns (396): measure, label the popup, then Ralph's ruling

**Steps 1–5 need no ruling. Everything after waits on W0.8, and it is money.**

- [ ] **Step 1: Read and cite** `src/lib/interns/intern-week-pay.ts` (the **daily and weekly cap values** and where they
  come from), `intern-pab.ts`, and `InternLockConfirmDialog.tsx` (the *"to the interns"* figure).
- [ ] **Step 2: A read-only measurement script** (`scripts/measure-intern-capped-hours.mts`). Per locked or accepted
  week, it prints: interns, raw hours, paid hours, **hours removed by the cap**, and gross paid. It prints totals only;
  per-intern detail goes to a gitignored file under `docs/audits/backups/`. Kane runs it. Its output is what Ralph and
  Kane rule on, instead of the call's "we owe them / we overpaid".
- [ ] **Step 3: The popup label (`hardening`, display only).** Write a pure `internLockSummary(rows)` that returns
  `{ internCount, totalPhp, lines: [{ name, hoursPaid, hoursCapped, amountPhp }] }`. Test it: three interns sum to the
  total, and an intern with capped hours shows them. The dialog's headline becomes *"To the interns, this week:
  ₱4,164.00 across 7 interns"*, with the per-intern lines under it. Alivia read the lump sum as all weeks.
- [ ] **Step 4: `npm test`, `npm run lint`**, then render the dialog in the harness at 1360 and 390 px.
- [ ] **Step 5: Commit** the script, the summary, its test, the dialog and the `orphanage-interns.md` update by explicit
  path: `feat(interns): the lock-in popup says it is one week, split per intern (item 396)`.
- [ ] **After W0.8:** (i) if hours over 5 are payable, the cap change is a `hardening` money change on
  `intern-week-pay.ts` and its 15 tests, with Kane's go; (ii) a **monthly payout** is a `blueprint` (a pay month grouping
  accepted weeks, with dispatch per month), because the hand-off is weekly by design today; (iii) any catch-up or
  recovery for past weeks is Kane's ruling, paid through the existing one-off payment path, never by editing an accepted
  week.

---

### Task 13: Notify on a returned offboarding queue row (397)

`hardening`. Carla: *"he returned it to manager. Jackie didn't get a notification on that and that's she wants one set
up."* **Doc gap found while planning:** `docs/features/offboarding-automation.md` never mentions a return-to-manager
action. Its pipeline goes queue → HR offboard. The action exists (memory item 384: the row was returned on 10-06), so the
doc gets a section in this commit.

**Files:**
- Create: `src/lib/hr/offboarding-return-notify.ts`, `offboarding-return-notify.test.ts`
- Modify: the route that sets a queue row to returned (Step 0 finds it: the HR side of `/api/offboarding-queue` or
  `HrOffboardQueueProcessor.tsx`'s endpoint), `docs/features/offboarding-automation.md` (new § "Returned to the
  manager"), `docs/features/notification-alerts.md` (the new type)

**Interfaces:**
- Produces: `buildReturnedNotifications(i: { personName: string; requestedBy: string | null; departmentManagers: readonly string[]; returnedBy: string; note: string | null }): Array<{ recipient: string; type: 'offboarding.returned'; title: string; body: string }>`
- Consumes: the existing `employee_notifications` insert (the `offboarding.requested` precedent) and the inverse of
  `listDepartmentsForManager` (the managers of the person's department; Step 0 finds or writes it).

- [ ] **Step 0: Read and cite** the return action (route, status value, whether a note is stored), the
  `offboarding.requested` notification insert (columns), and how a department's managers are listed.

- [ ] **Step 1: Write the failing test.**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReturnedNotifications } from './offboarding-return-notify';

test("Review Focus 5: the requester AND the department's managers, deduped, never the returner", () => {
  const out = buildReturnedNotifications({
    personName: 'Sample Person',
    requestedBy: 'Requester@simple.biz',
    departmentManagers: ['manager@simple.biz', 'requester@simple.biz', 'returner@simple.biz'],
    returnedBy: 'returner@simple.biz',
    note: 'No work email on file',
  });
  assert.deepEqual(out.map((n) => n.recipient).sort(), ['manager@simple.biz', 'requester@simple.biz']);
  assert.ok(out.every((n) => n.type === 'offboarding.returned'));
  assert.match(out[0].body, /Sample Person/);
  assert.match(out[0].body, /No work email on file/);
});
test('an old row with no requester still reaches the managers', () => {
  const out = buildReturnedNotifications({
    personName: 'Sample Person', requestedBy: null, departmentManagers: ['manager@simple.biz'],
    returnedBy: 'returner@simple.biz', note: null,
  });
  assert.deepEqual(out.map((n) => n.recipient), ['manager@simple.biz']);
});
```

- [ ] **Step 2: Run** `node --import tsx --test src/lib/hr/offboarding-return-notify.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.**

```ts
export function buildReturnedNotifications(i: {
  personName: string;
  requestedBy: string | null;
  departmentManagers: readonly string[];
  returnedBy: string;
  note: string | null;
}) {
  const returner = i.returnedBy.trim().toLowerCase();
  const recipients = [...new Set(
    [i.requestedBy, ...i.departmentManagers]
      .filter((e): e is string => !!e)
      .map((e) => e.trim().toLowerCase()),
  )].filter((e) => e !== returner);
  const body = `${i.personName}'s offboarding request was sent back to the manager.` +
    (i.note ? ` Note: ${i.note}` : '');
  return recipients.map((recipient) => ({
    recipient,
    type: 'offboarding.returned' as const,
    title: 'Offboarding request returned',
    body,
  }));
}
```

- [ ] **Step 4: Run, and see it pass. Wire it** into the return route **after** the status write succeeds, best-effort
  (a failed notification is logged and reported in the response, and never undoes the return). Map `recipient` to the
  `employee_notifications` columns from Step 0. Add the type to the notification docs and to whatever type registry
  Step 0 found.
- [ ] **Step 5: `npm test`, `npm run lint`. Commit** by explicit path:
  `feat(offboarding): notify the requester and the department's managers when a queue row is returned (item 397)`.

---

## 3. Self-review (done while writing)

- **Spec coverage.** Every ask in the meeting note maps to a task: timing log (6), hide (1), pills (2), old grid (9),
  hearts (W0.3 h), chargebacks (3), tasks (7), chat (8), roles (4), lock (5), compliance (10), NCNS (11), interns (12),
  queue notification (13). Not HRIS, so not here: billing terms, the PAB month boundary, Wise, bank-name forms (all
  decided "no change" on the call).
- **Placeholders.** New modules carry full code. Changes to existing functions carry exact cases plus a Step 0. That is
  this plan's known limit (the code was not readable this session), stated at the top, not hidden.
- **Type consistency.** `FrequencyProgress` (Task 7) is consumed by `buildProgressMessage` (Task 8).
  `acct_sb_refuse_locked_week()` (Task 5) is attached by Task 6. `can()` / `BoardAction` (Task 4) is used by Tasks 5–8.
  `OutcomeFlag` (Task 3) adds `pre_arb` to `rows.outcome`.
- **Review Focus.** All five have a test in an owning task: 1 → Tasks 1 and 6, 2 → Task 5, 3 → Task 4, 4 → Task 6,
  5 → Task 13.

## TL;DR

Wave 0 is decisions: Kane rules Pre-arb (W0.1) and the old grid (W0.2), and Carla sends the Chat URL, Joana's sheet and
the second Admin. Wave 1 is five small independent fixes (hide from Overview, pills, chargeback signs + Net, the intern
popup label, the queue notification). Wave 2 is roles, then the weekly lock: the foundation every new table builds on.
Wave 3 is the Sales timing log, deployed on a weekend. Wave 4 is task boards and the Chat message. Compliance, the old
grid and the interns' money wait on Kentshin, Kane and Ralph. Every migration is applied before its push.
