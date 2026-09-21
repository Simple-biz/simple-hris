# The Global Master List — who is active, and how to flip it back

**Shipped:** 2026-09-21 · **Spec:** `../superpowers/specs/2026-09-21-gml-active-only-sheet-retirement-design.md`
**Audit:** item 135 · **Memory:** `gml-transfer-orphan-rows`

Kane, 2026-09-21: *"I only want the active people not the offboarded in the Global Master List …
GML is different Offboarded is Different"* and *"There will be no Sheet anymore … we have our own
Global Master List."*

This document exists because Kane asked for one thing explicitly: *"just make sure to document
this in case we need to flip the switch."* Every step below names its revert.

---

## The problem this closed

Two surfaces reported two different roster sizes and both were right by their own rule:

| Surface | Rule | 2026-09-21 |
| --- | --- | --- |
| Admin → Integrations → Global Master List | `off_boarded_at IS NULL` | 1,723 rows |
| HR → Global Master List (`/api/employees` → `active_employees`) | that **AND** `last_seen_upload_id = (current upload)` | 1,215 rows |

Kane ruled the HR screen correct. The 508-row gap was **298 transfer corpses**, **185 unstamped
leavers**, **8 rows for 7 genuinely-live people**, and **17 rows for 16 unknowns**.

### The corpse engine

The master sync keys a row on `(personal_email, department)`. A transfer misses that key, so the
sync **inserted a second row and left the first active forever**. 304 of the 314 duplicate groups
differed only by Department. `active_employees` hid them (stale `last_seen_upload_id`); the
external API, which has no upload filter, served every one as a live person.

---

## Step 1 — the sync no longer forks a row *(shipped)*

`src/lib/roster/sheet-assignment.ts` — pure, tested — decides where a CSV line lands:

| The sheet lists them | They already have | Result |
| --- | --- | --- |
| under a department they already hold | that row | `update` (unchanged) |
| **once**, under a different department | **exactly one** active row | **`adopt`** — reuse the row, **keep its Department** |
| twice or more (a multi-role assertion) | anything | `insert` |
| anything | nothing active | `insert` |
| once | two or more active rows | `insert` — ambiguous, never guess |

**`adopt` is a separate action from `update` on purpose**: the caller physically cannot write the
sheet's department onto a row the HRIS owns. The sync strips `Department` from an adopted row's
payload, which is the write-once rule — the sheet may *create* a person's department, never
rewrite it.

**Retiring the rows the sheet omits was considered and rejected.** It would stamp exactly the
applied-HRIS-transfer rows the sheet has not caught up with — and
[[hris-is-dept-source-of-truth]] measured the sheet as the stale side in all 7 mismatches.
Preventing the fork cannot destroy a transfer; retiring can.

A genuine dual-role person is unaffected: `yong092734@` is Manager **and** USEE on the current
sheet, so the sheet lists them twice and both rows stand. `corpuzmachacon@` is **two different
people sharing one personal email** (Bencito, Rhocel / Corpuz, John Marc) — which is why the key
was *not* changed to personal-email-only, as that would have merged them into one row.

**The sync reports `adoptedTransfers`** in its result and in the cron's log line. A healthy sync
after this reconcile should report a small number; a large one means a batch of transfers landed.

### Flip it back

Revert the commit. The three pieces are `src/lib/roster/sheet-assignment.{ts,test.ts}`, the
`decideSheetAssignment` call plus `if (adopted) delete updatePayload["Department"]` in
`src/lib/supabase/global-master-list-db.ts`, and the `adoptedTransfers` counter. Nothing here
touches the database schema, so a revert takes effect on the next sync with no migration. The
cost of reverting is that transfers resume forking rows.

---

## Step 6.1 — the external API cursor *(shipped)*

`global_master_list.id` is a UUID. The cursor was typed and parsed as an integer, so
`page.next_cursor` returned a value the next call refused with a `400`. **No successful call had
ever returned more than 500 rows** (`external_api_requests`, `max(row_count)` on a `200` = 500).
Fixed to an opaque UUID-shaped string; fixtures converted to UUIDs first so the suite failed
before the fix.

### Flip it back

Revert the commit. The cursor is a wire contract, so a revert re-breaks paging for any client
that has started walking — coordinate with the OMS before reverting.

---

## Step 6.2 — the drift probe *(shipped)*

A diagnostics node, **Roster Definition Drift**, compares the two definitions on every panel
load. `judgeRosterDrift` is pure and tested; the read is alias-aware and paged.

No threshold — one corpse is one person the external API is wrong about, and the 508-row gap
started as one. Two shapes are **critical** rather than clever: the view exceeding the active set
(a strict subset cannot be larger — the *read* is broken), and an empty roster, which is
arithmetically "no drift" and is also exactly the 2026-08-03 incident where the view returned
zero rows with HTTP 200 and the wizard re-labelled 422 people "Unassigned".

### Flip it back

Revert the commit. Read-only; removing it removes a signal, nothing else. The node id must also
come out of `ALL_DIAGNOSTIC_NODE_IDS` — a canonical-list test enforces that pairing.

---

## Steps 2, 3, 5 — built, rehearsed, NOT APPLIED

Nothing has been written to Supabase. Both gates are real and both were exercised.

### Steps 2 + 3 — the data reconcile

`scripts/reconcile-gml-active-only.mts` — rehearsal by default, `--apply` to write.

```
node --import tsx scripts/reconcile-gml-active-only.mts           # rehearse
node --import tsx scripts/reconcile-gml-active-only.mts --apply   # write
```

Rehearsal, 2026-09-21, accounting for the gap exactly (298 + 159 + 8 + 43 = 508):

| | rows | people |
| --- | --- | --- |
| 1 corpses → `duplicate_cleanup` | 298 | 289 |
| 2 leavers → their real `offboarded_sheet` date | 159 | 142 |
| 3 **LIVE, missing from the HR screen** | 8 | **7** — no write |
| 4 needs HR review | 43 | 41 — no write |
| untouched (on the HR screen) | 1,215 | |

Leavers came in at **159, not 185**, because the re-hire guard rejects any record that does not
post-date the person's own Start Date. Those 26 rows moved to HR review rather than being
stamped — the fail-open direction.

**Flip it back:** `references/backups/2026-09-21-gml-reconcile/revert-plan.csv` names every id
with the four `off_boarded_*` values it held before. Clearing those columns on exactly those ids
restores them. The full 2,833-row snapshot sits beside it.

### Step 5 — one definition

```
node --import tsx scripts/apply-active-employees-one-definition.mts            # dry run (rolls back)
node --import tsx scripts/apply-active-employees-one-definition.mts --apply    # commit
node --import tsx scripts/apply-active-employees-one-definition.mts --verify   # checks only
node --import tsx scripts/apply-active-employees-one-definition.mts --revert   # PUT THE GATE BACK
```

**The order is enforced by the database, not by this document.** The migration's pre-flight
raises when more than 60 unstamped rows sit off the current upload. Run today it says:

```
before: active_employees 1215 · unstamped 1723 · gap 508
REFUSING: 508 unstamped rows are not on the current upload (expected <= 60 after
the reconcile). Run scripts/reconcile-gml-active-only.mts --apply first.
```

Applying before the reconcile would publish 483 dead rows to the ~40 readers of
`active_employees` at once.

**Flip it back:** `--revert` applies
`references/sql/alter/2026-09-21_active_employees_restore_upload_gate.sql`, byte-identical to the
definition live until 2026-09-21. It restores the gate and **un-stamps nobody** — undoing stamps
is `revert-plan.csv`, above. Note what comes back with the gate: the ~51-row residue (the 7 live
people and the 41 unclassified) disappears from every surface again.

### Step 4 — the 7

`cathypa@` · `berne@` · `lawangc@` · `jjr@` · `rodneys@` · `michaelsy@` · `markga@`. Live, paid,
and on no HR screen. Actionable today, independent of every other step — HR re-adds them to the
sheet, or they are re-onboarded in the HRIS.

---

## What did NOT change

- **The sheet still syncs.** Kane chose input-only: it may ADD or UPDATE a person. Sheet
  *absence* stops meaning anything, and it never overwrites `Department`.
- **`(personal_email, department)` is still the key**, and the partial unique index on
  `(LOWER("Personal Email"), LOWER("Department"))` still stands.
- **Off-boarded people are still unreachable** through the external API, enforced in SQL and
  again in `applyGmlQuery`.
- **`MAX_LIMIT` is still 500**, below the PostgREST 1000-row cap.
