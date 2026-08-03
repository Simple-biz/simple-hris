# HSL KPI Calculator: source branch rosters from Global Master List

**Date:** 2026-08-03
**Status:** Approved

## Problem

The HSL KPI Calculator (`src/components/manager/HslBonusCalculator.tsx`) shows
each branch's roster (Case Managers, Attestation, SSD Medical Records, etc.)
from `hsl_team_members` only. That table is populated exclusively by
`/api/cron/sync-hsl-from-sheet`, a sync job pulling the "HOGAN SMITH AGENT PAY
PLAN" Google Sheet — last run 2026-07-09.

`global_master_list` (GML) is the actual system of record for who's employed
and in what department (HR Pipeline intake, Department Transfers). It has no
wiring into the KPI Calculator at all. A person onboarded into GML with an HSL
department tag has no way to appear on any branch until someone manually adds
them via "+ Add Member" on that specific branch, or a Hogan sheet sync happens
to have them.

Concrete case: Dangie Galo (`dangieg@simple.biz`), started 2026-07-27, onboarded
via the HR Pipeline into GML with `Department: "HSL"`. Zero rows in
`hsl_team_members`. Last Hogan sheet sync predates her hire by 18 days. She
cannot appear on any branch today.

## Decisions (user-confirmed)

1. **GML is the identity source of truth.** The fix reads GML directly rather
   than routing everything back through the Hogan sheet / `hsl_team_members`.
2. **Merge, don't replace.** Branches keep showing existing `hsl_team_members`
   rows (the ~340 people already classified there via the Hogan sheet) *and*
   gain GML-derived rows. Nobody currently on a branch loses their spot.
3. **Normalize using the app's own canonical list.** `HSL_DEPTS`/`HSL_DEPT_KEYS`
   in `src/lib/hsl-bonus/schema.ts` already enumerate every valid branch — a
   raw `Department` string should resolve against that list directly (plain
   display name, e.g. `"Case Managers"`) rather than requiring a separate
   dropdown or a new intake-form field. The existing namespaced form
   (`hsl:case_managers`, already written today by Department Transfers) is
   recognized too.
4. **`hsl_team_members` keeps its existing job for pay rates** (mirrored into
   `employee_hourly_rates`) — untouched. The Hogan sheet sync is untouched.

## Approach

### 1. Normalization helper — `matchHslSubDeptKey` (new, `src/lib/hsl-bonus/schema.ts`)

```ts
export function matchHslSubDeptKey(raw: string | null | undefined): HslDeptKey | null
```

Recognizes a raw `Department` string as one of the 14 `HSL_DEPT_KEYS` two ways:

- Namespaced form `hsl:<key>` (already written by Department Transfers into
  an HSL sub-team) — validated against `HSL_DEPT_KEYS`, not just prefix-stripped.
- Plain display name (`HSL_DEPTS[key].name`), trimmed/lower-cased for a tolerant
  exact match — e.g. `"Case Managers"`, `"SSD Medical Records"`.

Returns `null` for anything else, **including the generic `"HSL"` / `"Hogan
Smith Law"` / `"Hogan"` tags** — those identify someone as Hogan Smith Law at
the payroll-department level but don't specify which branch, so they
deliberately do not resolve to a specific `HslDeptKey`. (Dangie's current
`Department: "HSL"` falls in this bucket — see "Data backfill" below.)

Lives in `schema.ts` (not `normalize-dept-key.ts`) because it's HSL-specific
and needs `HSL_DEPTS`/`HSL_DEPT_KEYS`, which already live there; `schema.ts`
has no imports today, so this stays a leaf module.

### 2. Keep Payroll Wizard department routing intact — `normalize-dept-key.ts`

`normalizeDeptToKey` currently special-cases `s.startsWith('hsl:')` →
`'hogan_smith_law'`. Replace that narrow check with a call to
`matchHslSubDeptKey(raw)`: if it resolves to any `HslDeptKey`, still return
`'hogan_smith_law'`. This is a strict superset of the current behavior (same
namespaced form, plus plain display names now also route correctly instead of
falling through to `null` → "Unassigned"). The existing generic
`hsl`/`hogan`/`hogan smith law` map entries are unaffected.

### 3. Roster merge — `/api/hsl-bonus/team-members/route.ts`

Today: one query against `hsl_team_members`, optionally `.eq('dept_key', dept)`.

Add a second source, merged by lower-cased email (existing `hsl_team_members`
row wins on conflict — it carries `is_manager`/`sub_team` GML has no concept
of):

1. Call `listActiveMasterListPeople()` (`src/lib/supabase/global-master-list-db.ts`)
   — the same active-roster reader the Transfer picker already uses. Reusing it
   avoids re-implementing the `active_employees`/pagination handling that's
   already been the site of a real incident (empty-roster-under-RLS, fixed
   2026-08-03).
2. For each active person, resolve `matchHslSubDeptKey(person.department)`.
   Skip anyone with no match (including the generic HSL tag), and anyone with
   no `work_email` (HSL keys people by work email only — see the existing
   comment in `HslBonusCalculator.tsx` on `candidateEmail`).
3. Synthesize an `HslMember`-shaped row per match:
   `{ email, full_name: person.name, hsl_name: null, role_raw: null, dept_key: resolvedKey, sub_team: null, is_manager: false }`
   — same defaults a manually-added external member gets today.
4. Merge with the `hsl_team_members` rows (`Map` keyed by lower-cased email,
   `hsl_team_members` inserted last so it overwrites a GML synthesis on
   collision).
5. Apply the existing `?dept=` filter to the **merged** set (not just the
   `hsl_team_members` query) so both the per-branch fetch
   (`HslBonusCalculator.loadDept`) and the full/dept-less fetch (Payroll
   Wizard's `hslDeptByEmail`, which reads `{ email, dept_key }` off every row)
   both see GML-derived people correctly bucketed. Without this, a GML-tagged
   person would show up correctly in the KPI Calculator but still land in
   Payroll Wizard's Hogan Smith Law tab "Unassigned" rail — the same
   inconsistency this change is meant to close.

No change to `HslBonusCalculator.tsx` itself — it already treats every row
`/api/hsl-bonus/team-members` returns as roster (`rosterEmails`), regardless of
which source produced it.

### 4. Data backfill (not code)

Dangie's `Department` is `"HSL"` — generic, matches no branch. Getting her
onto a specific branch requires her `Department` to be set to that branch's
tag (via a Department Transfer, or a direct profile edit) — a one-time manual
data correction, separate from this change, once it's known which branch she
belongs to. Same applies to any other GML person currently tagged only
generically as HSL.

## Error handling

- `listActiveMasterListPeople()` failure (its existing `{ error }` return) —
  the route logs and falls back to `hsl_team_members`-only results (today's
  behavior), rather than failing the whole roster fetch.
- GML rows with no `work_email`, or whose `department` doesn't resolve via
  `matchHslSubDeptKey`, are silently excluded (not an error — most GML rows
  aren't HSL at all).
- Duplicate GML rows for the same person (e.g. a stray leftover row from a
  transfer) — last one read wins; this is a display roster, not a payroll
  source of truth.

## Testing

- Unit: `matchHslSubDeptKey` — every `HSL_DEPT_KEYS` display name resolves
  (case/whitespace-tolerant); every `hsl:<key>` namespaced form resolves;
  generic `"HSL"` / `"Hogan Smith Law"` / unrelated strings return `null`.
- Unit: `normalizeDeptToKey` — a plain HSL branch display name now resolves to
  `'hogan_smith_law'` (regression: existing `hsl:`-prefixed and generic-tag
  cases still resolve the same as before).
- Route-level (read-only DB check, mirroring `scripts/verify-*.mts` patterns):
  seed/point at a known GML person tagged `hsl:case_managers` or `"Case
  Managers"` and confirm `/api/hsl-bonus/team-members?dept=case_managers`
  includes them; confirm a person already in `hsl_team_members` isn't
  duplicated.
- Manual: after backfilling Dangie's `Department` to her actual branch, confirm
  she appears on that branch's calculator and in Payroll Wizard's Hogan Smith
  Law rail (not "Unassigned").

## Out of scope

- Deriving `is_manager` for GML-sourced rows from `department_managers`
  grants — defaults to `false`, same as a manually-added external member
  today. Can be revisited later if it turns out to matter in practice.
- Any change to the HR Pipeline intake form's Department combobox (e.g.
  suggesting branch names). The combobox already accepts free text; typing an
  exact branch name now resolves correctly with this change. Adding
  suggestions is a separate, smaller follow-up if it turns out to be needed.
- Changing or retiring the Hogan Sheet sync / `hsl_team_members` — both
  untouched.
- Backfilling Dangie's or anyone else's `Department` — a data action, not
  covered by this change (see "Data backfill").
