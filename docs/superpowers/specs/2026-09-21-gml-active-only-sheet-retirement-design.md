# Global Master List — active-only, one definition, and the retirement of the Sheet's authority

**Date:** 2026-09-21
**Surfaces:** `active_employees` view · `src/lib/supabase/global-master-list-db.ts` ·
`app/api/cron/sync-master-from-sheet/route.ts` · `src/lib/external-api/{gml-query,gml-read,mcp-server}.ts` ·
`src/lib/admin/diagnostics-probes.ts`
**Skills:** `hardening` (doc-check + tightening duties) · `superpowers:brainstorming` (architectural path)
**Status:** design approved by Kane 2026-09-21 on four questions; spec awaiting review

---

## 1. What this is

Admin → Integrations → Global Master List reports **1,723 active rows**. HR → Global Master List
reports **1,215**. Kane opened this as *"the OMS pulled 1667 not 1143 … lets fix this data once
and for all."*

Both numbers are real and both are computed correctly by their own rule. There are **two
definitions of "active"** in the codebase, and the 508-row gap between them *is* the discrepancy:

| Definition | Where | Today |
| --- | --- | --- |
| any row with `off_boarded_at IS NULL` | `docs/features/external-api-integrations.md:155`, `gml-query.ts` | 1,723 rows |
| that, **and** `last_seen_upload_id = (current upload)` | `active_employees` view | 1,215 rows |

**Kane's ruling: the HR screen is correct.** *"Whatever data HR - Global Master List is showing
that is correct - because HR Dashboard knows when someone gets Promoted to the Master List and
Offboarded people."* The external API is the wrong one, and the work is to collapse the two
definitions into one so they can never diverge again.

This is a data reconcile plus one root-cause code fix. It ships no new user-facing surface.

---

## 2. Decisions recorded (Kane, 2026-09-21)

| # | Question | Ruling |
| --- | --- | --- |
| Q1 | What may the Google Sheet still do to the GML? | **Input only.** The sync may ADD or UPDATE a person. Sheet *absence* stops meaning anything, and the sync **stops writing `Department`**. HRIS wins every conflict. |
| Q2 | GML contents | **Active people only.** *"GML is different Offboarded is Different."* Offboarded people are found in the Offboarded surface. |
| Q3 | `off_boarded_at` for the unstamped leavers | **Their real departure date** from `offboarded_sheet`. |
| Q4 | The people evidence cannot classify | **Stay active, flagged for HR review.** Fails OPEN. |

Q1 settles the half that `memory/hris-is-dept-source-of-truth.md` left open — *"the master sync
still keys on `(personal_email, department)` and still writes Department from the sheet, so every
sync is a live clobber risk against HRIS. Departing from the sheet is not done until either the
sync stops writing Department or HRIS pushes to the sheet."* This spec stops it writing Department.

---

## 3. The measurement

Read-only against production, 2026-09-21, service-role, `selectAllPaged`, alias-aware (identity
folded across all four email columns by union-find, per `identity-resolution.md`).

| Verdict | Rows | People |
| --- | --- | --- |
| On the HR screen — correct | 1,215 | 1,211 |
| `DUPLICATE_transfer_leftover` | 298 | 289 |
| `LEAVER_never_stamped` | 185 | 166 |
| `LIVE_missing_from_hr_screen` | 8 | **7** |
| `UNKNOWN_needs_hr_review` | 17 | 16 |

The 7: `cathypa@` · `berne@` · `lawangc@` · `jjr@` · `rodneys@` (has a departure record) ·
`michaelsy@` · `markga@`.

Backups on disk at `references/backups/2026-09-21-gml-reconcile/` (gitignored — PII):
`00-gml-full-snapshot.csv` (2,833 rows) plus one CSV per verdict.

> **A superseded figure, recorded so it is not resurrected.** An earlier pass in this session
> reported *"217 live people missing from every HRIS screen"*. **That number is wrong.** It
> counted each stale row as a missing person without checking whether the same person also held
> a current row — 298 of them did. This is the exact failure
> `memory/active-roster-cannot-say-who-left.md` warns about: measuring the right question with a
> broken instrument. The alias-aware count is **7**, not 217. Any analysis keyed on a single
> email column against this table is unsound.

**The table is moving.** It grew 2,761 → 2,833 rows during the measurement session (active
1,652 → 1,723). The apply scripts therefore **re-derive every set at run time** and never work
from ids captured today.

---

## 4. Root cause — one mechanism, not a drift

**304 of the 314 duplicate groups carry a different `Department` on each row.**

The master sync's natural key is `(personal_email, department)`. A department transfer therefore
does not move a person — it **inserts a second row and orphans the first**. The orphan keeps
`off_boarded_at IS NULL` forever, so:

- `active_employees` is right: the orphan's `last_seen_upload_id` is stale, so it is filtered out.
- the external API is wrong: it has no upload filter, so it serves the orphan as a live person.

Worked examples: `gilduran2605@` appears as Lead Gen **and** Client VA; `tianlopera2021@` as
Lead Gen **and** `hsl:intake_specialist`; `berndonn08@` as Client VA **and**
`hsl:intake_specialist`. Every transfer ever applied left a row the API still counts.

That accounts for 298 of the 508 gap rows. Of the remaining 210, **185 are leavers** whose GML
row was never stamped — the long-running condition already recorded in
`memory/active-roster-cannot-say-who-left.md` and `memory/master-sync-never-un-offboards.md` —
and the last 25 rows are the 7 live people and the 16 unknowns from §3.

---

## 5. The plan — the order is the safety

Running step 5 before steps 1–4 would flood roughly 40 `active_employees` readers with 483 dead
rows at once.

### Step 1 — Stop making corpses *(code)*

`replaceGlobalMasterListFromCsvText` keys on **identity alone**, not
`(personal_email, department)`. Identity is resolved as **normalized personal email, falling back
to work email** when personal is blank — the same precedence `identity-resolution.md` already
defines; `rowsMissingPersonalEmail` is already tracked by the sync, so the fallback has a
measurable population rather than being hypothetical.

`Department` is then **write-once**: the sheet supplies it when it *creates* a row for a person
the HRIS has never seen, and never overwrites it on an existing row. That is the precise form of
Q1, and it is what makes a transfer update a row instead of forking it.

Without this step, every step below regrows. It ships first.

### Step 2 — Retire the 298 corpses *(data, `--apply` gated)*

Stamped `off_boarded_reason = 'duplicate_cleanup'`. That reason is **already excluded from
`DEPARTURE_REASONS`** (`src/lib/payment-catalog/catalog-roster-visibility.ts:74-75`), so not one
of those 289 living people is treated as a departure by any surface, and none appears in the
Offboarded ledger as a leaver.

A row is a corpse **only when another row for the same person is on the current upload**. A
person whose every row is stale is *not* a corpse and falls through to step 3 or 4.

### Step 3 — Stamp the 166 leavers *(data, `--apply` gated)*

`off_boarded_at` = the `offboarded_sheet` record's own date (Q3). `off_boarded_reason` carried
over from that record. Actor recorded as the reconcile, not a person.

Verified safe for money before proposing: `hasDepartedBeforeWeek` — the one shared predicate the
Payment Catalog and the QC deal use — reads the **`offboarded_sheet` ledger**
(`src/lib/roster/offboard-evidence.ts:126`), not `global_master_list.off_boarded_at`, so these
166 are **already** hidden there and nothing changes. `qc-db.ts:110` re-admits a leaver only when
`off_boarded_at >= weekStart`, and backdated June/July stamps fall outside every current week.
Past QC slots are sticky snapshots and do not recompute. Payroll weeks are snapshotted
(`memory/payroll-rule-changes-forward-only.md`).

**One visible consequence, accepted:** `OffboardingWeeklyPulse` counts separations by
`off_boarded_at` week, so it gains 166 backdated separations across June–July 2026 (one in
February 2025). The chart becomes truthful and looks different.

### Step 4 — Hand HR the 7 + 16 *(no write)*

Named lists, delivered as the CSVs plus the probe in step 6. Per Q4 they stay active. The 7 are
live people absent from the HR screen; the 16 have neither a departure record nor recent pay.

### Step 5 — One definition *(migration)*

`active_employees` becomes `SELECT * FROM global_master_list WHERE off_boarded_at IS NULL`.
The upload gate goes; `last_seen_upload_id` survives as sync provenance only.

After steps 1–4, "unstamped" and "on the current upload" describe the same set, so this migration
is a **no-op on row count** the day it runs — and from then on the external API and the HR screen
are the same query. That is the "once and for all".

Consequences, all deletions:

- `restampActiveNonSheetRows` and its call in `sync-master-from-sheet/route.ts:75` — the function
  exists only to defeat the gate. Its US-only narrowing and its comment at `:960-961`
  (*"every PH row is governed by the sheet: vanish from the sheet → drop"*) become wrong and go
  with it.
- the `last_seen_upload_id`-stamping in `add-employee`, `pending-employees/[id]/promote`,
  `reonboard` and `onboarding-bypass` — same reason.
- the US-prefix UNION in `getEmployees` (`src/lib/supabase/employees.ts`) — US employees stop
  being an exception once absence from the sheet means nothing.

### Step 6 — Close it for good *(code)*

1. **The UUID cursor.** `global_master_list.id` is a UUID; the external API types and parses the
   cursor as an integer, so `page.next_cursor` returns a value the next call rejects with a 400.
   Measured: **no successful call has ever returned more than 500 rows** — `external_api_requests`
   `max(row_count)` on a 200 is 500, and every `cursor` call is a 400. Fix per
   `memory/external-api-cursor-uuid-vs-integer.md`: the cursor becomes an opaque string, fixtures
   become UUIDs **first**, `MCP_TOOL_NAMES` stays pinned, and `MAX_LIMIT` never rises past 1000
   (`memory/postgrest-1000-cap-sweep.md`). Audit log item **133**.
2. **A diagnostics probe** in `src/lib/admin/diagnostics-probes.ts` asserting the external API's
   active set and `active_employees` return the **same count**, and listing any active person with
   neither a departure record nor recent pay. This is where the 16 live, and it is what stops the
   two definitions drifting apart again.

---

## 6. Docs and memory corrected in the same commits

Per CLAUDE.md, no commit ships carrying a doc this spec flagged as stale.

| File | What changes |
| --- | --- |
| `docs/features/external-api-integrations.md:155-156` | The rule inverts — "active" becomes the single shared definition. The stated reason for rejecting `active_employees` (*"a `security_invoker` view that goes silently empty under RLS"*) is **already stale**: `references/sql/alter/2026-08-03_restore_active_employees_definer.sql:44` set `security_invoker = false`. |
| `docs/features/external-api-integrations.md:147-149` | *"Duplicate master rows for one person are returned as-is"* — still true of the table, but the 298 corpses that made it load-bearing are gone. |
| `docs/features/external-api-integrations.md:202, :218` | The `?cursor=` contract becomes an opaque string. |
| `src/lib/supabase/global-master-list-db.ts:920-961` | The `restampActiveNonSheetRows` doc-comment and the sheet-authority claim go with the function. |
| `docs/features/INDEX.md` | Rows for Integrations and for the roster/departments family. |
| `memory/hris-is-dept-source-of-truth.md` | Its "unresolved half" is resolved by step 1. |
| `memory/external-api-cursor-uuid-vs-integer.md` | Closed by step 6.1. |
| `memory/active-roster-cannot-say-who-left.md` | Its root cause ("the root cause is untouched") is addressed; the corrected 7-vs-217 lesson is added. |

A new memory entry records the transfer-orphan mechanism, which no existing entry names.

---

## 7. Failure classes closed (tightening duty)

`hardening`'s tightening duty is active — *"fix this data once and for all"*. Each class needs a
test, a type, a DB constraint, or a cited invariant. **Nothing is closed by loosening.**

| # | Class | Proof |
| --- | --- | --- |
| 1 | A department transfer forks a row instead of moving it | unit test on the sync's natural key: same identity, different department in the sheet ⇒ **1 row, not 2**, and its `Department` **unchanged** (the HRIS value stands, per write-once) |
| 2 | Two definitions of "active" drift apart | step 5 makes them one query; the step 6.2 probe asserts equal counts |
| 3 | An unstamped leaver is served as active | step 3 + the probe's "no departure record and no recent pay" list |
| 4 | A living person is stamped as a leaver | the corpse test requires another row on the current upload; `duplicate_cleanup` sits outside `DEPARTURE_REASONS`; re-hire guard on Start Date |
| 5 | A client silently receives a partial roster | step 6.1 + a test that pages a UUID-keyed table across two pages |
| 6 | Sheet absence removes a person | steps 1 and 5; the gate no longer exists to remove them |
| 7 | The sheet clobbers an applied HRIS transfer | step 1 — the sync stops writing `Department` |

Explicitly **not** how any of these is closed: raising `MAX_LIMIT`, widening a filter so a bad row
disappears, or relaxing the departed guard (`docs/audits/audit-2026-09-16-session-log.md` item
131 — *"closing this by loosening it is exactly what `hardening` forbids"*).

---

## 8. Testing

- **Unit, pure:** the sync's natural key (class 1); the corpse predicate (class 4); the cursor as
  an opaque string, with fixtures converted to UUIDs **before** the fix so the suite fails first
  (class 5).
- **Two-page walk:** a test that pages a UUID-keyed table to exhaustion — the proof that
  `next_cursor` round-trips. The current suite is green and the feature does not work, because
  every fixture uses integer ids.
- **Migration rehearsal:** the `active_employees` row count before and after step 5 must be equal.
  Any difference means steps 1–4 did not converge, and the migration does not ship.
- **Read-only verifier**, in the shape of `scripts/verify-qc-departed-members.mts`: runs the real
  functions against production and asserts the API count equals the view count.
- **Apply scripts:** rehearsal by default, `--apply` gate, `SELECT` backup written before any
  `UPDATE` (CLAUDE.md § Data). Every set re-derived at run time.

---

## 9. Out of scope

- **Physical table separation** (`global_master_list` holding only active rows, offboarded rows
  moved to their own table). Considered as approach C and deferred: 1,109 offboarded rows are
  referenced by id from COE, termination docs, the Offboarded tab, Penny and final pay, and
  `offboarded_sheet` already exists with a different shape. It delivers the same user-visible
  outcome as step 5 at much higher risk, and deserves its own evidence.
- **Deleting the sync** — Q1 keeps it as an input.
- **The KPI calculator's departed guard** (audit item 131). Same family, its own decision, its own
  `hardening` pass.
- **Merging duplicate identities** beyond retiring the transfer corpses.
  `maria-argote-split-identity` and `lawang-rate-shadow-duplicate-identity` are separate open
  items.
