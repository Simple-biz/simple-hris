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

## Steps still to come

| Step | What | Revert |
| --- | --- | --- |
| 2 | retire the 298 corpses as `duplicate_cleanup` | the stamped ids are written to `references/backups/2026-09-21-gml-reconcile/`; clearing `off_boarded_*` on exactly those ids restores them |
| 3 | stamp the 166 leavers with their real `offboarded_sheet` date | same — the backup names every id and its prior value |
| 4 | hand HR the 7 + 16 | no write |
| 5 | `active_employees` drops the upload gate | paired down-migration restores the gate in one statement |
| 6.2 | diagnostics probe asserting the two definitions agree | read-only |

**Order is the safety.** Steps 1–4 must land before step 5: flipping the view first would put
483 dead rows in front of ~40 `active_employees` readers at once.

---

## What did NOT change

- **The sheet still syncs.** Kane chose input-only: it may ADD or UPDATE a person. Sheet
  *absence* stops meaning anything, and it never overwrites `Department`.
- **`(personal_email, department)` is still the key**, and the partial unique index on
  `(LOWER("Personal Email"), LOWER("Department"))` still stands.
- **Off-boarded people are still unreachable** through the external API, enforced in SQL and
  again in `applyGmlQuery`.
- **`MAX_LIMIT` is still 500**, below the PostgREST 1000-row cap.
