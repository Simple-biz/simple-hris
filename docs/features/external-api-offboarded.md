# Offboarded dataset — outside systems read the leavers list by key, REST or MCP

The second dataset on the external read API, beside the Global Master List. A key that holds the
scope **`offboarded.read`** reads the leavers ledger. That is one row per recorded departure:
name, company work email, department, start date, when they left, a reason **category**, and
whether the HRIS or the old Google Sheet recorded it. It works over `GET /api/external/v1/offboarded`
and the MCP tool `query_offboarded`, with the same key, rate budget and request log as the roster.
An admin grants it by ticking **Offboarded** under *Datasets* on Admin → Webhooks & Integrations →
Integrations (New client or Edit). It is opt-in: a new key is roster-only unless ticked, and the live
OMS client is unchanged. Built 2026-10-07 (Kane: *"lets add the offboarded list so that a key can be
used to access this please ASAP"*). It replaced the Data catalog's Planned page of the same name.

## Key files

| Piece | File |
| --- | --- |
| The REST endpoint | `app/api/external/v1/offboarded/route.ts` — `GET` only |
| The MCP tool `query_offboarded` (registered per held scope) | `src/lib/external-api/mcp-server.ts` (+ `.test.ts`) |
| Fields, reason categories, company-domain gate, parse · filter · page · project, the shared pipeline | `src/lib/external-api/offboarded.ts` (+ `.test.ts`) |
| The scopes, one list (picker, admin validation, gate) | `src/lib/external-api/scopes.ts` (+ `.test.ts`) |
| The gate: the accepted scopes are a **required** argument | `src/lib/external-api/authenticate.ts` · `serve.ts` |
| The ledger read (`selectAllPaged`, fixed select) | `src/lib/supabase/external-api-db.ts` — `readOffboardedLedgerRows` |
| Admin: scopes on create / update, audited, 503 before the migration | `app/api/admin/external-api-clients/route.ts` · `[id]/route.ts` |
| Admin UI: Datasets step, Access column, Leavers endpoint, hand-off | `src/components/admin/AdminExternalApiClients.tsx` |
| Catalog page (now Live) and who holds it | `src/lib/external-api/datasets.ts` (`OFFBOARDED_DATASET`) · `dataset-access.ts` |
| SQL — the scope CHECK re-enumerated | `references/sql/alter/2026-10-07_external_api_offboarded_scope.sql` |
| Migration | `scripts/apply-external-api-offboarded-scope-migration.mts` · `scripts/Apply External API offboarded scope migration.cmd` |
| Plan | `docs/superpowers/plans/2026-10-07-external-api-offboarded.md` |

## Source — the ledger, not the master-list stamps

The rows come from **`offboarded_sheet`** alone, the ledger that HR → Offboarding → Offboarded lists.
`/api/hr/offboard` writes it on every offboard, so it is the superset
(`offboarded-tab-merged-origin-column`). The `global_master_list.off_boarded_*` stamps are **not**
unioned in. Measured 2026-10-07: 1,726 master rows are stamped, 355 of them have no ledger row, and
349 of those 355 are `duplicate_cleanup` markers, not departures. Serving the stamps would publish
349 people who never left. The other **6 real departures** stamped on the master list but missing
from the ledger are not served. That gap is on the catalog page as an open caveat. Also missing: the 22
leavers the 2026-08-28 import skipped on a recycled work email.

The master list starts 2026-04-21, but the ledger reaches back to **2024-01-13**, so earlier leavers
are served. The catalog's old note that the dataset "silently starts in April" applied to the
stamps and no longer applies.

## A row is history, not status

One row per ledger record. A re-hire who left twice has two rows, and a **recycled work email** can
carry a previous holder's departure. Measured 2026-10-07: 193 ledger rows share a work email with
an unstamped master row. 65 of those have the same personal email (re-hires or stale rows); the
rest are addresses now held by someone else. **Never** derive "is this person gone today" from this
list. That is the roster's job, and even the roster cannot fully answer it
(`active-roster-cannot-say-who-left`). The catalog page and the MCP description both say so.

## Not-a-departure rows are never served

`NOT_DEPARTURE` = `temporary_pause` (13 rows: suspended for approved leave, returns via re-onboard),
`active` (2 rows that say so), and the synthetic `duplicate_cleanup` / `sheet_sync` markers. They are
dropped **before any filter runs**, so no parameter reaches them, and `reason=temporary_pause` is a
`400`. This matches the Payment Catalog's departure allowlist, which also leaves `temporary_pause`
out (`catalog-roster-visibility.ts`). **This is not a second "has this person left" predicate.** It
only decides which ledger rows count as departures for this export; it never hides anyone from a pay
surface.

## The reason is a category, never the stored label

`off_boarded_reason` is free text off the old sheet: 29 distinct keys on 2026-10-07, some of them
whole sentences of performance commentary about a named person. It is **read only to categorise**.
What goes out is one of `ncns · resigned · end_of_contract · performance · attendance ·
time_manipulation · policy_violation · no_show · declined_offer · rescheduled · other`, or `null`
when the label is blank:

- Canonical keys pass through in either casing (`Performance` → `performance`).
- A short, explicit synonym table covers every sheet label with more than 10 rows:
  `no_show_during_orientation` → `no_show`, `underperformance` / `productivity` → `performance`,
  `reschedule_for_next_week` / `need_to_reschedule` → `rescheduled`.
- Anything else is `other`. **Do not add a pass-through for "unknown" labels.** That is how a
  sentence about someone's work quality would reach an outside system.

Served on 2026-10-07: performance 2,184 · no_show 858 · resigned 452 · ncns 427 · policy_violation
179 · other 106 · attendance 96 · declined_offer 60 · rescheduled 42 · time_manipulation 17 · null 10.

## Fixed fields — and only company data in them

Every holder receives exactly `OFFBOARDED_COLUMNS`: `id, name, work_email, department, start_date,
off_boarded_at, reason, origin`. **There is no per-field grant on this scope.** `granted_columns` is
the roster's grant and is never applied here (`dataset-access.ts` reports the Offboarded grant as
*whole*, which is a fact, not a guess). Per-field grants arrive only with Phase A's `granted_fields`.

`personal_email`, `off_boarded_note`, `off_boarded_by` and `synced_at` are **never selected**
(`OFFBOARDED_SELECT`), so a projection bug cannot leak them. Two columns needed one more guard,
found by running the pipeline over production before shipping:

- **`work_email` is served only on a company domain** (`COMPANY_EMAIL_DOMAINS` = `simple.biz`, the
  current `WORK_EMAIL_DOMAIN`, plus the earlier `simplesitecompany.com` and `simplebizteam.com`).
  Otherwise it is `null`. About 110 sheet-era rows hold a **personal** inbox (gmail, yahoo, outlook) in
  the `work_email` column. 125 rows serve `null` in all.
- **A name holding an `@` is `null`.** One row has a gmail address typed as the name.
- **The filters match the served values only.** `?email=someone@gmail.com` and `?search=gmail`
  return nothing, so a filter cannot confirm that a personal address is on the list. This is the same
  reason a roster filter on a hidden column is a 400.

`start_date` is stored as text in mixed formats; it is served through `normalizeMasterDate` as
`YYYY-MM-DD`, or `null` when it does not parse (the shared parser; never a guess). `off_boarded_at`
is served as stored. 774 rows have none.

## Query contract

```
GET /api/external/v1/offboarded
Authorization: Bearer hris_live_…            — the key must hold offboarded.read, else 403

?email=        exact company work email, case-insensitive
?department=   exact, case-insensitive (3,354 sheet-snapshot rows have no department)
?reason=       one category from the list above
?since= ?until=  YYYY-MM-DD, inclusive, on the UTC date of off_boarded_at; an undated row never matches
?search=       substring over the served name + work email
?limit=        1–500, default 100
?cursor=       the previous page's page.next_cursor (the ledger id as digits)
any other parameter → 400

200 { data: [...], page: { limit, max_limit, returned, total, next_cursor }, meta: { as_of, dataset: 'offboarded', client, columns, expires_at } }
400 { error: 'Invalid query', details: [{ field, message }] }
401 / 403 / 429 / 503 — the same gate and sentences as the roster route

POST /api/external/mcp   tool query_offboarded({ email?, department?, reason?, since?, until?, search?, limit?, cursor? })
```

**The cursor is the ledger's bigint id, and paging is keyset ascending.** New offboards get higher
ids, so a system that stores the last `next_cursor` and asks again later gets only the departures
recorded since. A full pull on 2026-10-07 was 4,431 rows in 9 pages of 500. The read itself is
`selectAllPaged`; `MAX_LIMIT` stays below 1000.

## Removals are not announced

HR → Restore (`/api/hr/reonboard`) **deletes** the person's ledger rows by work email, and the API
has no tombstones. A system mirroring the list sees a restored person disappear only when it
re-reads the list in full. A cursor-only incremental reader never sees the removal. The catalog page
says so.

## The gate — scopes are the route's required argument

`authenticateExternalRequest(request, accepted)` takes the scopes the route serves as a
**required** argument. It has no default and no module constant (the old `REQUIRED_SCOPE` is gone),
and an empty list admits nobody. `scopes.test.ts` pins the signature from source. The roster route passes
`[GML_SCOPE]`, this route `[OFFBOARDED_SCOPE]`, and the MCP route every scope. MCP then registers a
query tool only for a scope the key holds (`toolsFor`). A roster-only key gets exactly the two tools,
instructions and `describe_access` payload it got before 2026-10-07, pinned key-for-key in
`mcp-server.test.ts` because the live OMS client reads them.

The SQL CHECK stays an **enumeration** (`scopes <@ array[...]`), never a pattern. `scopes.ts`,
the newest dated SQL file and the catalog's live datasets are pinned equal by `datasets.test.ts`.
A new dataset means a new ALTER that re-enumerates the CHECK.

## Admin — Datasets step, and the cross-product warning

New client is now **Who → Datasets → Columns → Access → Confirm**. Roster is ticked by default;
Offboarded is opt-in, and ticking it prints what it means in amber, because a key holding both can
see who left even though the roster stays "active only". Columns apply to the roster only; a
leavers-only key skips them and stores `granted_columns = NULL`. Edit shows the same picker, and
removing the roster leaves the stored column grant untouched. The table's *Columns* header became
*Access* (`Roster · whole table` / `Offboarded`). `external_api.client.created` audits the scopes;
`updated` audits `scopes`, `was_scopes`, `added_scopes` and `removed_scopes`, so a widening reads as
one at a glance.

Until the ALTER is applied the database refuses `offboarded.read`. The admin routes turn that CHECK
violation into a **503 naming the migration script**, not a 500 (`SCOPE_MIGRATION_PENDING`).

## Not verified

No key holding `offboarded.read` exists yet, so the route has not answered a real call. That
needs the migration. The pipeline was run read-only over the full production ledger, and the panel was
typechecked but **not clicked through signed in** (Admin needs SSO). Local `curl` against the dev
server was deliberately skipped: even a denied call writes a production `external_api_requests` row,
which the panel would show as an unattributed (key-guessing) call.

## Deploy notes

- **Migration PENDING (Kane runs it)**: `scripts/Apply External API offboarded scope migration.cmd`
  (a rehearsal that always rolls back, then type `APPLY`). The rehearsal passed against production on
  2026-10-07: all 7 controls held and the one client (OMS, roster-only) kept its scopes. It changes
  only `external_api_clients_scopes_known`. No row, no table.
- Order does not matter: before the ALTER, the route and tool exist but no key can hold the scope,
  and ticking Offboarded gives the 503 above.
- **Push PENDING** (Kane).
- No env var, no n8n, no proxy change (`/api/external/` already bypasses SSO, and
  `admitExternalCall` is the gate).
- Then: Admin → Webhooks & Integrations → Integrations → New client (or Edit) → tick **Offboarded**.
