# PAB Exclusion Employee Notification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When Accounting excludes (or restores) someone from a month's Perfect Attendance Bonus in the Payroll Wizard, the employee gets a notification about it in their Employee Dashboard.

**Architecture:** A new dedicated `POST /api/pab-exclusions` route replaces the Payroll Wizard's direct write to the generic `pab_period_exclusions` app-setting. The route does the read-patch-write of the exclusions blob AND fires the employee notification in the same request, mirroring how dispute decisions / bank-preferred requests already work in this codebase. The pure "what changed" and "what copy to show" logic lives in a small testable lib module the route calls into.

**Tech Stack:** Next.js App Router API routes, Supabase (service-role client for server-side writes), `node:test` for unit tests (this repo's existing convention — no Jest/Vitest).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-03-pab-exclusion-employee-notification-design.md`
- Notify BOTH directions: exclude fires `pab.excluded`, restore fires `pab.restored` (user-confirmed).
- No persistent "Excluded" badge on the Employee Dashboard's PAB calendar/pill — notification card only (user-confirmed, explicitly out of scope).
- The route, not the client, owns the exclusions-blob read-patch-write (user-confirmed architecture direction).
- Follow this repo's test convention: `node:test` + `node:assert/strict`, one `<file>.test.ts` next to the module it tests, testing pure functions directly — no mocking framework. API route files are NOT unit-tested in this codebase (zero `app/api/**/*.test.ts` exist) — routes stay thin wiring over tested lib functions.
- `employee_notifications.type` has a DB CHECK constraint. Every `ADD CONSTRAINT` must restate the FULL allowed list (a partial list silently breaks every other notification type's insert) — copy verbatim from the current authoritative list in `references/sql/alter/2026-07-22_employee_notifications_add_bank_override_type.sql`.
- Kane applies SQL himself via a Node script (`pg` client + `DATABASE_URL`), never by pasting into the Supabase SQL editor — pair every migration with an apply script matching `scripts/apply-fix-security-definer-views.mjs`'s shape.
- Never run `git push` — commit locally only.

---

### Task 1: Pure PAB-exclusion notification helpers

**Files:**
- Create: `src/lib/notifications/pab-exclusion.ts`
- Test: `src/lib/notifications/pab-exclusion.test.ts`

**Interfaces:**
- Consumes: `parseYearMonthKey`, `PabExclusionsMap` (type `Map<string, Set<string>>`) from `@/lib/pab-period-settings` (both already exported there).
- Produces (used by Task 2):
  - `formatPabMonthLabel(monthKey: string): string`
  - `type PabExclusionNotificationType = 'pab.excluded' | 'pab.restored'`
  - `interface PabExclusionNotificationContent { type: PabExclusionNotificationType; tone: 'neutral' | 'positive'; title: string; message: string }`
  - `buildPabExclusionNotification(excluded: boolean, monthKey: string): PabExclusionNotificationContent`
  - `interface PabExclusionPatchResult { nextExclusions: Record<string, string[]>; wasExcluded: boolean; changed: boolean }`
  - `applyPabExclusionPatch(currentExclusions: PabExclusionsMap, monthKey: string, email: string, excluded: boolean): PabExclusionPatchResult`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/notifications/pab-exclusion.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  formatPabMonthLabel,
  buildPabExclusionNotification,
  applyPabExclusionPatch,
} from "./pab-exclusion";

test("formatPabMonthLabel formats a YYYY-MM key as 'Month YYYY'", () => {
  assert.equal(formatPabMonthLabel("2026-08"), "August 2026");
  assert.equal(formatPabMonthLabel("2026-01"), "January 2026");
});

test("formatPabMonthLabel falls back to the raw key when unparseable", () => {
  assert.equal(formatPabMonthLabel("not-a-key"), "not-a-key");
  assert.equal(formatPabMonthLabel("2026-13"), "2026-13");
});

test("buildPabExclusionNotification: excluded=true builds the pab.excluded card", () => {
  const n = buildPabExclusionNotification(true, "2026-08");
  assert.equal(n.type, "pab.excluded");
  assert.equal(n.tone, "neutral");
  assert.equal(n.title, "Excluded from Perfect Attendance Bonus");
  assert.match(n.message, /August 2026/);
  assert.match(n.message, /₱0 PAB/);
});

test("buildPabExclusionNotification: excluded=false builds the pab.restored card", () => {
  const n = buildPabExclusionNotification(false, "2026-08");
  assert.equal(n.type, "pab.restored");
  assert.equal(n.tone, "positive");
  assert.equal(n.title, "Perfect Attendance Bonus Restored");
  assert.match(n.message, /August 2026/);
});

test("applyPabExclusionPatch: adding a new email to an empty map excludes it and reports changed", () => {
  const current = new Map();
  const result = applyPabExclusionPatch(current, "2026-08", "Jane@Example.com", true);
  assert.equal(result.wasExcluded, false);
  assert.equal(result.changed, true);
  assert.deepEqual(result.nextExclusions, { "2026-08": ["jane@example.com"] });
});

test("applyPabExclusionPatch: excluding an already-excluded email is a no-op state change", () => {
  const current = new Map([["2026-08", new Set(["jane@example.com"])]]);
  const result = applyPabExclusionPatch(current, "2026-08", "jane@example.com", true);
  assert.equal(result.wasExcluded, true);
  assert.equal(result.changed, false);
  assert.deepEqual(result.nextExclusions, { "2026-08": ["jane@example.com"] });
});

test("applyPabExclusionPatch: un-excluding removes the email and drops the month when empty", () => {
  const current = new Map([["2026-08", new Set(["jane@example.com"])]]);
  const result = applyPabExclusionPatch(current, "2026-08", "jane@example.com", false);
  assert.equal(result.wasExcluded, true);
  assert.equal(result.changed, true);
  assert.deepEqual(result.nextExclusions, {});
});

test("applyPabExclusionPatch: other months are preserved untouched", () => {
  const current = new Map([
    ["2026-07", new Set(["old@example.com"])],
    ["2026-08", new Set(["jane@example.com"])],
  ]);
  const result = applyPabExclusionPatch(current, "2026-08", "mark@example.com", true);
  assert.deepEqual(result.nextExclusions, {
    "2026-07": ["old@example.com"],
    "2026-08": ["jane@example.com", "mark@example.com"],
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import tsx --test src/lib/notifications/pab-exclusion.test.ts`
Expected: FAIL — `Cannot find module './pab-exclusion'` (the file doesn't exist yet).

- [ ] **Step 3: Write the implementation**

Create `src/lib/notifications/pab-exclusion.ts`:

```ts
import { parseYearMonthKey, type PabExclusionsMap } from '@/lib/pab-period-settings';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** "2026-08" -> "August 2026". Falls back to the raw key when it doesn't parse. */
export function formatPabMonthLabel(monthKey: string): string {
  const ym = parseYearMonthKey(monthKey);
  if (!ym) return monthKey;
  return `${MONTH_NAMES[ym.month] ?? ''} ${ym.year}`.trim();
}

export type PabExclusionNotificationType = 'pab.excluded' | 'pab.restored';

export interface PabExclusionNotificationContent {
  type: PabExclusionNotificationType;
  tone: 'neutral' | 'positive';
  title: string;
  message: string;
}

/**
 * Notification copy for a PAB exclusion state change. Pure — no I/O — so the
 * API route just calls this and inserts the result.
 */
export function buildPabExclusionNotification(
  excluded: boolean,
  monthKey: string,
): PabExclusionNotificationContent {
  const monthLabel = formatPabMonthLabel(monthKey);
  if (excluded) {
    return {
      type: 'pab.excluded',
      tone: 'neutral',
      title: 'Excluded from Perfect Attendance Bonus',
      message: `You've been excluded from the Perfect Attendance Bonus for ${monthLabel}. You'll earn ₱0 PAB for this period regardless of attendance. Reach out to Accounting if this doesn't look right.`,
    };
  }
  return {
    type: 'pab.restored',
    tone: 'positive',
    title: 'Perfect Attendance Bonus Restored',
    message: `Your Perfect Attendance Bonus exclusion for ${monthLabel} has been reversed. You're eligible again based on your attendance for the period.`,
  };
}

export interface PabExclusionPatchResult {
  /** Full month -> emails[] map, ready to JSON.stringify and save verbatim. */
  nextExclusions: Record<string, string[]>;
  /** Whether `email` was excluded for `monthKey` BEFORE this patch. */
  wasExcluded: boolean;
  /** Whether membership actually changed (wasExcluded !== excluded). */
  changed: boolean;
}

/**
 * Pure patch step: add/remove `email` from `monthKey`'s set inside the parsed
 * exclusions map, and return the FULL map ready to re-serialize. Every other
 * month is preserved untouched; a month whose set ends up empty is dropped so
 * the blob stays compact (same shape the Payroll Wizard already writes).
 */
export function applyPabExclusionPatch(
  currentExclusions: PabExclusionsMap,
  monthKey: string,
  email: string,
  excluded: boolean,
): PabExclusionPatchResult {
  const norm = email.trim().toLowerCase();
  const set = new Set(currentExclusions.get(monthKey) ?? []);
  const wasExcluded = set.has(norm);
  if (excluded) set.add(norm);
  else set.delete(norm);

  const nextExclusions: Record<string, string[]> = {};
  for (const [key, emails] of currentExclusions.entries()) {
    if (key === monthKey) continue;
    if (emails.size > 0) nextExclusions[key] = Array.from(emails);
  }
  if (set.size > 0) nextExclusions[monthKey] = Array.from(set);

  return { nextExclusions, wasExcluded, changed: wasExcluded !== excluded };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --import tsx --test src/lib/notifications/pab-exclusion.test.ts`
Expected: PASS — all 7 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/notifications/pab-exclusion.ts src/lib/notifications/pab-exclusion.test.ts
git commit -m "feat(notifications): add pure PAB exclusion notification helpers"
```

---

### Task 2: `POST /api/pab-exclusions` route + notification-views mapping

**Files:**
- Create: `app/api/pab-exclusions/route.ts`
- Modify: `src/lib/notifications/notification-views.ts`

**Interfaces:**
- Consumes (from Task 1): `applyPabExclusionPatch`, `buildPabExclusionNotification` from `@/lib/notifications/pab-exclusion`.
- Consumes (existing): `requireElevatedSession`, `deniedResponse` from `@/lib/auth/authorize-email`; `getAppSettingStrict`, `upsertAppSetting` from `@/lib/supabase/app-settings`; `parsePabPeriodExclusions`, `PAB_PERIOD_EXCLUSIONS_KEY` from `@/lib/pab-period-settings`; `normEmail` from `@/lib/email/norm-email`; `createSupabaseServiceRoleClient` from `@/lib/supabase/server`.
- Produces (used by Task 4): `POST /api/pab-exclusions` accepting `{ email: string, monthKey: string, excluded: boolean }`, returning `{ success: true, wasExcluded: boolean, notified: boolean, error: null }` on success or `{ error: string }` with a 4xx/5xx status on failure.

- [ ] **Step 1: Create the route**

Create `app/api/pab-exclusions/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { requireElevatedSession, deniedResponse } from '@/lib/auth/authorize-email';
import { getAppSettingStrict, upsertAppSetting } from '@/lib/supabase/app-settings';
import { parsePabPeriodExclusions, PAB_PERIOD_EXCLUSIONS_KEY } from '@/lib/pab-period-settings';
import { normEmail } from '@/lib/email/norm-email';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { applyPabExclusionPatch, buildPabExclusionNotification } from '@/lib/notifications/pab-exclusion';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MONTH_KEY_RE = /^\d{4}-\d{2}$/;

/**
 * Toggles a single person's PAB exclusion for one month and notifies them of
 * the change. Replaces the Payroll Wizard's previous direct write to the
 * generic `pab_period_exclusions` app-setting — this route owns both the
 * write AND the employee notification, matching how dispute decisions /
 * bank-preferred requests / resignation decisions already work.
 */
export async function POST(request: Request) {
  try {
    const authz = await requireElevatedSession();
    if (!authz.ok) return deniedResponse(authz);

    const body = (await request.json()) as {
      email?: string;
      monthKey?: string;
      excluded?: boolean;
    };
    const monthKey = (body.monthKey ?? '').trim();
    const excluded = body.excluded === true;
    const norm = normEmail(body.email ?? null);

    if (!MONTH_KEY_RE.test(monthKey)) {
      return NextResponse.json({ error: 'monthKey must be in YYYY-MM format' }, { status: 400 });
    }
    if (!norm) {
      return NextResponse.json({ error: 'Missing email' }, { status: 400 });
    }

    const currentRaw = await getAppSettingStrict(PAB_PERIOD_EXCLUSIONS_KEY);
    const currentExclusions = parsePabPeriodExclusions(currentRaw);
    const { nextExclusions, wasExcluded, changed } = applyPabExclusionPatch(
      currentExclusions,
      monthKey,
      norm,
      excluded,
    );

    const { error: writeError } = await upsertAppSetting(
      PAB_PERIOD_EXCLUSIONS_KEY,
      JSON.stringify(nextExclusions),
    );
    if (writeError) return NextResponse.json({ error: writeError }, { status: 500 });

    let notified = false;
    if (changed) {
      const supabase = createSupabaseServiceRoleClient();
      if (supabase) {
        const { data: matchRow } = await supabase
          .from('active_employees')
          .select('"Work Email","Personal Email"')
          .or(
            `"Work Email".ilike.${norm},"Personal Email".ilike.${norm},"Alternate Work Email".ilike.${norm},"Alternate Work Email 2".ilike.${norm}`,
          )
          .limit(1)
          .maybeSingle();
        const row = matchRow as Record<string, unknown> | null;
        const recipient =
          normEmail(typeof row?.['Work Email'] === 'string' ? (row['Work Email'] as string) : null) ??
          normEmail(typeof row?.['Personal Email'] === 'string' ? (row['Personal Email'] as string) : null);

        if (recipient) {
          const content = buildPabExclusionNotification(excluded, monthKey);
          const { error: notifErr } = await supabase.from('employee_notifications').insert({
            recipient_email: recipient,
            type: content.type,
            tone: content.tone,
            title: content.title,
            message: content.message,
            details: { month: monthKey },
          });
          if (notifErr) {
            console.error('[pab-exclusions] notification insert failed:', notifErr.message);
          } else {
            notified = true;
          }
        } else {
          console.warn(`[pab-exclusions] no active_employees match for ${norm} — notification skipped`);
        }
      }
    }

    return NextResponse.json({ success: true, wasExcluded, notified, error: null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
```

- [ ] **Step 2: Map the two new types to the employee dashboard**

In `src/lib/notifications/notification-views.ts`, find the block around the existing `'payroll.available': ['employee'],` entry (it has a comment above it starting `// Accounting uploaded a new Hubstaff week...`). Add immediately after that entry:

```ts
  // Accounting excluded (or restored) this employee from a month's Perfect
  // Attendance Bonus in the Payroll Wizard's PAB settings modal. Informational
  // card only, no click-through action. Employee-only, ungated.
  'pab.excluded': ['employee'],
  'pab.restored': ['employee'],
```

- [ ] **Step 3: Type-check**

Run: `npm run lint`
Expected: no new TypeScript errors from `app/api/pab-exclusions/route.ts` or `notification-views.ts`.

- [ ] **Step 4: Commit**

```bash
git add app/api/pab-exclusions/route.ts src/lib/notifications/notification-views.ts
git commit -m "feat(api): add POST /api/pab-exclusions with employee notification"
```

*(No dedicated route test — this codebase does not unit-test `app/api/**` route files; see Global Constraints. The route's non-trivial logic is already covered by Task 1's tests. Functional verification happens end-to-end in Task 5 once Task 4 wires the client to call it.)*

---

### Task 3: DB migration for the two new notification types

**Files:**
- Create: `references/sql/alter/2026-08-03_pab_exclusion_notification_types.sql`
- Create: `scripts/apply-pab-exclusion-notification-types.mjs`

**Interfaces:**
- Consumes: none (standalone SQL + script).
- Produces: `employee_notifications.type` CHECK constraint permits `pab.excluded` and `pab.restored`, required before Task 2's notification inserts stop being silently rejected.

- [ ] **Step 1: Write the migration SQL**

Create `references/sql/alter/2026-08-03_pab_exclusion_notification_types.sql`:

```sql
-- Widen employee_notifications.type CHECK to allow the PAB exclusion
-- notification types: `pab.excluded` (Accounting excluded this person from a
-- month's Perfect Attendance Bonus) and `pab.restored` (the exclusion was
-- reversed). Fired from app/api/pab-exclusions/route.ts.
--
-- ADD CONSTRAINT re-validates existing rows, so we restate the FULL
-- authoritative allowed set — the list from
-- 2026-07-22_employee_notifications_add_bank_override_type.sql (the latest
-- full list) PLUS pab.excluded and pab.restored. Restating a SUBSET would
-- silently break every other notification type's INSERT, so the whole list
-- is kept here verbatim. Run once (via the paired apply script). Idempotent.

ALTER TABLE public.employee_notifications
  DROP CONSTRAINT IF EXISTS employee_notifications_type_check;

ALTER TABLE public.employee_notifications
  ADD CONSTRAINT employee_notifications_type_check
  CHECK (type IN (
    'rate.change',
    'promotion',
    'dispute.approved',
    'dispute.denied',
    'dispute.revoked',
    'onboarding.submitted',
    'time_adjustment.approved',
    'time_adjustment.denied',
    'transfer.requested',
    'transfer.approved',
    'transfer.rejected',
    'transfer.release_requested',
    'transfer.released',
    'transfer.declined',
    'transfer.applied',
    'payroll.processing_started',
    'payroll.processing_stopped',
    'payroll.paid',
    'payroll.available',
    'special_transfer.recorded',
    'qc.scores_submitted',
    'qc.scores_returned',
    'people.banking.self_updated',
    'people.banking.overridden',
    'bank_info.requested',
    'offboarding.requested',
    'offboarding.request_completed',
    'offboarding.request_dismissed',
    'offboarding.request_returned',
    'resignation.submitted',
    'resignation.approved',
    'resignation.rejected',
    'ticket.replied',
    'ticket.assigned',
    'documents.requested',
    'documents.signed',
    'documents.rejected',
    'bank_preferred.decided',
    'pab.excluded',
    'pab.restored'
  ));

-- Verify:
-- select conname, pg_get_constraintdef(oid)
--   from pg_constraint where conname = 'employee_notifications_type_check';
```

- [ ] **Step 2: Write the apply script**

Create `scripts/apply-pab-exclusion-notification-types.mjs`:

```js
/**
 * Applies references/sql/alter/2026-08-03_pab_exclusion_notification_types.sql
 * — widens employee_notifications.type CHECK to allow pab.excluded /
 * pab.restored — then verifies it landed.
 *
 *   node scripts/apply-pab-exclusion-notification-types.mjs           # apply + verify
 *   node scripts/apply-pab-exclusion-notification-types.mjs --verify  # verify only
 *
 * Needs DATABASE_URL in .env.local (Supabase dashboard -> Project Settings ->
 * Database -> Connection string -> URI, password filled in, direct port 5432 —
 * DDL on the pooler can fail). The Supabase JS client cannot run DDL, which is
 * why this uses `pg` directly. Same shape as
 * scripts/apply-fix-security-definer-views.mjs.
 *
 * The SQL is idempotent (DROP CONSTRAINT IF EXISTS + re-ADD), so a re-run is a
 * no-op.
 */
import { readFileSync } from "node:fs";
import { Client } from "pg";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config();

const SQL_PATH = "references/sql/alter/2026-08-03_pab_exclusion_notification_types.sql";
const NEW_TYPES = ["pab.excluded", "pab.restored"];
const verifyOnly = process.argv.includes("--verify");

const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) {
  console.error(
    [
      "DATABASE_URL is not set.",
      "",
      "Add it to .env.local, e.g.:",
      "  DATABASE_URL=postgresql://postgres:<password>@db.<project-ref>.supabase.co:5432/postgres",
      "",
      "Supabase dashboard -> Project Settings -> Database -> Connection string -> URI.",
      "Use the direct connection (port 5432), not the pooler — DDL on the pooler can fail.",
    ].join("\n"),
  );
  process.exit(1);
}

// Supabase requires TLS; its cert chain is not in Node's default store.
const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });

try {
  await client.connect();
  console.log(`connected: ${connectionString.replace(/:[^:@/]+@/, ":****@")}`);

  if (!verifyOnly) {
    console.log(`\napplying ${SQL_PATH} …`);
    await client.query(readFileSync(SQL_PATH, "utf8"));
    console.log("applied.");
  }

  const { rows } = await client.query(
    `SELECT pg_get_constraintdef(oid) AS def
       FROM pg_constraint
      WHERE conname = 'employee_notifications_type_check'`,
  );

  console.log("\n=== VERIFY ===");
  const def = rows[0]?.def ?? "";
  console.log(def || "(constraint not found)");

  const missing = NEW_TYPES.filter((t) => !def.includes(`'${t}'`));
  if (missing.length > 0) {
    console.error(`\n✗ CHECK constraint still missing: ${missing.join(", ")}`);
    process.exitCode = 1;
  } else {
    console.log("\n✓ pab.excluded and pab.restored are both allowed now.");
  }
} catch (err) {
  console.error("\nmigration FAILED:", err?.message ?? err);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
```

- [ ] **Step 3: Run the script against the live database**

Run: `node scripts/apply-pab-exclusion-notification-types.mjs --verify`
Expected: prints the CURRENT constraint definition and `✗ CHECK constraint still missing: pab.excluded, pab.restored` (confirms the gate is real before applying).

Run: `node scripts/apply-pab-exclusion-notification-types.mjs`
Expected: `applied.` then `✓ pab.excluded and pab.restored are both allowed now.`

*(This step writes to the live production database — confirm with Kane before running it, per this session's standing rule that Kane applies DB migrations himself. If Kane prefers to run it himself, hand him the command instead of running it.)*

- [ ] **Step 4: Commit**

```bash
git add references/sql/alter/2026-08-03_pab_exclusion_notification_types.sql scripts/apply-pab-exclusion-notification-types.mjs
git commit -m "chore(db): widen employee_notifications type CHECK for pab.excluded/pab.restored"
```

---

### Task 4: Wire the Payroll Wizard's toggle to the new route

**Files:**
- Modify: `src/components/PayrollWizard.tsx:220` (import line)
- Modify: `src/components/PayrollWizard.tsx:2713-2757` (`writeExclusionsBlob` + `togglePabExclusion`)

**Interfaces:**
- Consumes (from Task 2): `POST /api/pab-exclusions` with body `{ email, monthKey, excluded }`, response `{ success, wasExcluded, notified, error }`.
- Produces: `togglePabExclusion(email: string, excluded: boolean): Promise<void>` — same signature as before, so its one caller (the "Exclude from PAB" checkbox list, around line 11391: `onClick={() => { if (!busy) void togglePabExclusion(p.email, !isExcl); }}`) needs no changes.

- [ ] **Step 1: Remove the now-unused import**

In `src/components/PayrollWizard.tsx` line 220, change:

```ts
import { parseLocalDateFromIso, resolvePabRangeForMonth, yearMonthKey, PAB_PERIOD_EXCLUSIONS_KEY } from '@/lib/pab-period-settings';
```

to:

```ts
import { parseLocalDateFromIso, resolvePabRangeForMonth, yearMonthKey } from '@/lib/pab-period-settings';
```

- [ ] **Step 2: Replace `writeExclusionsBlob` + `togglePabExclusion`**

Find this block (currently lines ~2713-2757):

```ts
  /**
   * Serialize the exclusions map back to the JSON shape stored in app_settings,
   * patching a single month's email list. Empty lists are dropped so the blob
   * stays compact.
   */
  const writeExclusionsBlob = React.useCallback(
    async (patchKey: string, emails: Set<string>) => {
      const next: Record<string, string[]> = {};
      for (const [k, set] of pabPeriodSettings.exclusions.entries()) {
        if (k === patchKey) continue;
        if (set.size > 0) next[k] = Array.from(set);
      }
      if (emails.size > 0) next[patchKey] = Array.from(emails);
      await savePabSetting(PAB_PERIOD_EXCLUSIONS_KEY, JSON.stringify(next));
    },
    [pabPeriodSettings.exclusions, savePabSetting],
  );

  /**
   * Toggle a single person's PAB exclusion for the month the modal is editing.
   * Excluded employees earn ₱0 PAB for that period regardless of attendance —
   * the dispatch path (`current-pay.ts`) honors the same list.
   */
  const togglePabExclusion = React.useCallback(
    async (email: string, excluded: boolean) => {
      if (isReplay) { toast.error('Replaying a past period is view-only'); return; }
      const norm = normEmail(email) ?? email.toLowerCase();
      if (!norm) return;
      const set = new Set(pabPeriodSettings.exclusions.get(editMonthKey) ?? []);
      if (excluded) set.add(norm);
      else set.delete(norm);
      setPabSaveState('saving');
      try {
        await writeExclusionsBlob(editMonthKey, set);
        await pabPeriodSettings.refresh();
        setPabSaveState('saved');
        setTimeout(() => setPabSaveState('idle'), 1500);
      } catch (e) {
        setPabSaveState('error');
        toast.error('Save failed', { description: e instanceof Error ? e.message : 'Unknown error' });
        setTimeout(() => setPabSaveState('idle'), 3000);
      }
    },
    [pabPeriodSettings, writeExclusionsBlob, editMonthKey, isReplay],
  );
```

Replace it with:

```ts
  /**
   * Toggle a single person's PAB exclusion for the month the modal is editing.
   * Excluded employees earn ₱0 PAB for that period regardless of attendance —
   * the dispatch path (`current-pay.ts`) honors the same list. The API route
   * owns the read-patch-write AND fires the employee's pab.excluded /
   * pab.restored notification, so the client only calls it and refreshes.
   */
  const togglePabExclusion = React.useCallback(
    async (email: string, excluded: boolean) => {
      if (isReplay) { toast.error('Replaying a past period is view-only'); return; }
      const norm = normEmail(email) ?? email.toLowerCase();
      if (!norm) return;
      setPabSaveState('saving');
      try {
        const res = await fetch('/api/pab-exclusions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: norm, monthKey: editMonthKey, excluded }),
        });
        const json = (await res.json()) as { error: string | null };
        if (!res.ok || json.error) throw new Error(json.error || `HTTP ${res.status}`);
        await pabPeriodSettings.refresh();
        setPabSaveState('saved');
        setTimeout(() => setPabSaveState('idle'), 1500);
      } catch (e) {
        setPabSaveState('error');
        toast.error('Save failed', { description: e instanceof Error ? e.message : 'Unknown error' });
        setTimeout(() => setPabSaveState('idle'), 3000);
      }
    },
    [pabPeriodSettings, editMonthKey, isReplay],
  );
```

- [ ] **Step 3: Type-check**

Run: `npm run lint`
Expected: no new TypeScript errors — in particular, confirm no other reference to `writeExclusionsBlob` or `PAB_PERIOD_EXCLUSIONS_KEY` remains in `PayrollWizard.tsx` (search the file for both names; there should be zero matches after this change).

- [ ] **Step 4: Commit**

```bash
git add src/components/PayrollWizard.tsx
git commit -m "refactor(payroll-wizard): route PAB exclusion toggle through /api/pab-exclusions"
```

---

### Task 5: End-to-end verification

**Files:** none (verification only).

**Interfaces:** none — this task exercises Tasks 1-4 together.

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: all tests pass, including the 7 new tests from Task 1.

- [ ] **Step 2: Full type-check**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 3: Confirm the DB migration is live**

Run: `node scripts/apply-pab-exclusion-notification-types.mjs --verify`
Expected: `✓ pab.excluded and pab.restored are both allowed now.` (If this hasn't been run yet, do Task 3 Step 3 first — the manual UI check below will otherwise show a save that succeeds but never notifies, since the insert fails silently.)

- [ ] **Step 4: Manual UI check — exclude**

With the dev server running (check first whether one is already running before starting a new one — don't clobber an existing `.next` build in progress):
1. Sign in as an elevated user (payroll_manager / accounting / admin) and open the Payroll Wizard.
2. Open the PAB settings modal, go to "Exclude from PAB", and tick a real employee for the currently-edited month.
3. Confirm the row shows the saved state (no error toast).
4. Sign in as that employee (or query `employee_notifications` directly for `type = 'pab.excluded'` and that recipient) and confirm the card reads "Excluded from Perfect Attendance Bonus" naming the correct month.

- [ ] **Step 5: Manual UI check — restore**

1. In the same PAB settings modal, untick the same employee.
2. Confirm the row shows the saved state.
3. Confirm the employee now also has a `pab.restored` notification reading "Perfect Attendance Bonus Restored" for the same month.

- [ ] **Step 6: Confirm idempotency**

Tick the same employee excluded again without unticking in between (i.e., call the toggle a second time while already excluded — e.g. via a duplicated click or a direct second POST with the same body). Confirm no second `pab.excluded` notification is created (check `employee_notifications` count for that recipient/type/month stays at 1) — this is the `changed` guard from Task 1 doing its job.
