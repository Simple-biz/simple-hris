# External API — Payroll Wizard resources, per-field grants, and a write path

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:executing-plans` or
> `superpowers:subagent-driven-development`. Steps use `- [ ]` syntax.
> **This plan covers PHASE A only.** Phase B (the remaining eight resources) gets its own plan
> once Kane has seen Phase A working.

**Goal:** the Integrations tab stops serving one table and starts serving *resources*. An admin
picks which resources a client may reach and **which fields within each**, read-only by default,
over REST and MCP alike. Phase A lands the spine plus one read resource (`orphanage_pay`, so OMS
can pull what Abad earned for the orphanage) and one **write** target that cannot move money.

**Spec:** the `BLUEPRINT` brief rev 2, posted in session `1918c98d` on 2026-09-21, and Kane's five
rulings on it. Audit log rows: `docs/audits/audit-2026-09-16-session-log.md` items **123** (the
brief), **133** (the cursor bug, fixed here), **134** (the filename drift, worked around here),
**136** (the anon-readable GML, *not* fixed here).

**Architecture:** one declaration file per resource under `src/lib/external-api/resources/`, read
by a generic route, a generated MCP tool, the Admin picker, the grant validator and a conformance
test. `serve.ts`, `keys.ts`, `expiry.ts`, `rate-limit.ts` and the request log are reused unchanged.
`executeGmlRead`, `applyGmlQuery`, `catalog.ts` and `grants.ts`'s projection rules survive — the
GML resource is re-expressed in the new shape, never rewritten.

---

## Kane's rulings — the fixed points

| # | Ruling | Consequence |
|---|---|---|
| 1 | Every wizard step, separated per step, admin controls which fields | resources, not one table; grants become per-resource |
| 2 | Only steps with a first-class table get a resource | steps 2/4/5/7/9 expose side-tables; the doc says what is missing |
| 3 | Off-boarded people **are** included in `orphanage_pay` | a documented exception to `external-api-integrations.md:150` |
| 4 | Serve the amount **plus a per-row verdict** | the reconciliation block below |
| 5 | Any admin may grant; **audit must be realtime in the Admin view** | server Broadcast + poll floor |
| 6 | **Build a write function** | the write spine, with a target that is not a paying carrier |
| 7 | Fix the cursor bug in the same pass | item 133 |

## Global constraints

- **Never loosen to make it fit.** The load-bearing guards stay: the select is built from the
  grant and never `*`; `projectRow` is the belt to that brace; `[]` is refused in code **and** SQL;
  a list covering everything collapses to `null`; fields store in catalog order; a filter on a
  hidden field is `400 column_not_granted`; no key cache; one rate budget across REST and MCP; the
  request log is the meter; nothing under `/api/external/` may rely on a session.
- **Keep the SQL scope CHECK ENUMERATED.** Do **not** replace `scopes <@ array[...]` with a shape
  regex. Regenerate the enumeration from the registry in each migration instead. A new resource
  needs a deploy anyway, so the ALTER is not a real tax — and the enumeration is the only control
  that lives outside the repo. A regex here would be a loosening, and CLAUDE.md forbids buying
  convenience with one.
- **`requiredScope` has no default.** Turning `REQUIRED_SCOPE` (`authenticate.ts:23`) from a module
  constant into a parameter is the one genuine edit to a proven guard. It must be a **required**
  positional. An optional parameter defaulting to `'global_master_list.read'` would make a
  forgotten argument on a future route silently grant the roster to any key.
- **Widening on error is the one thing this must not do** (`serve.ts:100-106`). A grant that does
  not validate is a 503, never "whole resource".
- **PostgREST truncates at 1000 rows even with `.range()`** — `selectAllPaged`, always.
- **`MAX_LIMIT` stays below 1000** and its test stays.
- `.env.local` is **production** service-role. Read-only unless Kane approves a write. Every bulk
  `UPDATE` gets a `SELECT` backup on disk first.
- Kane cannot paste SQL — every migration ships as a Node script with an `--apply` gate, dry by
  default, `DATABASE_URL` = the **session pooler** on 5432.
- Test command: `npm test`. Single file: `node --import tsx --test <path>`. Typecheck:
  `npx tsc --noEmit` before every commit.
- `next build` and a running `next dev` share `.next/` — **check for a live dev server first.**
- Stage by explicit path. Commit direct to `main`. **NEVER push.**

## Corrections to carry into the docs

- `docs/features/external-api-integrations.md` claims a new `global_master_list` column "fails the
  suite until someone classifies it". **It does not.** `catalog.test.ts` deep-equals the catalog
  against `LIVE_COLUMNS_2026_09_17`, a hand-copied snapshot — so the suite fails when the
  *catalog* changes, not when the *table* does. Re-measure the snapshot in this pass and correct
  the sentence; do not propagate the claim to the new resources.
- The doc's `:258-262` "Migration PENDING — neither table exists in production yet" is **stale**.
  Both tables exist and `external_api_clients` holds one live client.

---

## File structure

**New**
- `src/lib/external-api/resources/index.ts` — the registry; maps scope → `ResourceDef`.
- `src/lib/external-api/resources/types.ts` — `ResourceDef`, `FieldDef`, `FieldGroup`, `WriteIntent`.
- `src/lib/external-api/resources/global-master-list.ts` — today's catalog re-expressed.
- `src/lib/external-api/resources/orphanage-pay.ts` — the new read resource.
- `src/lib/external-api/resources/orphanage-oms-hours.ts` — the write target.
- `src/lib/external-api/resources.test.ts` — the conformance suite (see task 4).
- `src/lib/external-api/cursor.ts` (+ `.test.ts`) — opaque, resource-stamped, composite-key cursor.
- `src/lib/external-api/resource-query.ts` (+ `.test.ts`) — generic parse · filter · page.
- `src/lib/external-api/resource-read.ts` (+ `.test.ts`) — the one pipeline REST and MCP share.
- `src/lib/external-api/orphanage-reconcile.ts` (+ `.test.ts`) — the per-row verdict.
- `src/lib/external-api/write-intent.ts` (+ `.test.ts`) — idempotency, caps, the promote contract.
- `app/api/external/v1/[resource]/route.ts` — generic `GET`.
- `app/api/external/v1/[resource]/[intent]/route.ts` — generic `POST` (writes only).
- `references/sql/alter/2026-09-21_external_api_resources.sql`
- `references/sql/create/2026-09-21_external_api_write_intents.sql`
- `scripts/apply-external-api-resources-migration.mts` (+ `.cmd`)
- `scripts/verify-external-api-resources.mts` — read-only post-apply verifier.

**Modify**
- `src/lib/external-api/authenticate.ts` — `requiredScope` as a required parameter.
- `src/lib/external-api/serve.ts` — takes `{ resource, operation }`; write branch.
- `src/lib/external-api/grants.ts` — grant becomes per-scope; existing rules preserved verbatim.
- `src/lib/external-api/gml-query.ts` — `id` becomes `string`; the `/^\d+$/` cursor gate goes.
- `src/lib/external-api/gml-read.ts` — unchanged logic, new cursor type.
- `src/lib/external-api/mcp-server.ts` — tools generated per granted scope; `describe_access` grows.
- `src/lib/supabase/external-api-db.ts` — paged resource reads; a leaver-inclusive GML reader.
- `src/components/admin/AdminExternalApiClients.tsx` — Resources step, per-resource fields, the
  realtime rail.
- `app/api/admin/external-api-clients/route.ts`, `[id]/route.ts` — resources + fields + write caps.
- `src/lib/audit/registry.ts` — `external_api.write.*` and the grant-delta details.
- `app/api/external/v1/global-master-list/route.ts` — kept as a thin alias so OMS's URL is
  byte-identical (see task 13).

---

## Task 1 — Measure the preconditions (READ-ONLY, before any code)

- [ ] Re-measure `global_master_list`'s live column list and update `LIVE_COLUMNS_2026_09_17` to a
      dated `LIVE_COLUMNS_2026_09_21`, correcting the doc sentence above.
- [ ] Measure `orphanage_pay`'s live column list; it becomes the resource's own dated pin.
- [ ] Confirm `external_api_clients` still holds exactly one client and record its
      `granted_columns` length (expected 12 of 22) — the migration must be a no-op for it.
- [ ] Confirm RLS state from `pg_policies`, not from the DDL files. **Already measured 2026-09-21:**
      RLS on for all twelve payroll tables; two policies total, both on `global_master_list`
      (item 136). `create_orphanage_pay.sql` has no `enable row level security` line and RLS is on
      anyway — **the DDL is not evidence of the RLS state.**
- [ ] Write the findings into the plan before writing code. A precondition measured after the fact
      is folklore ([[migration-pending-claims-are-folklore]]).

## Task 2 — The resource declaration type

- [ ] `resources/types.ts`. A `ResourceDef` must declare, with no optional escape:
      `scope`, `slug`, `table`, `label`, `liveColumns` (dated snapshot), `always`, `fields`
      (each with `group` and `sensitive`), `never`, `cursor` (columns + direction),
      `paging` mode, `leaverPolicy` (`'hide' | 'include' | 'n/a'`), `filters`, and `writes` (may be
      an empty list, never absent).
- [ ] `FieldGroup` includes `'money'` and `'identity'`. This is not cosmetic — task 11 keys the
      picker's default off it.

## Task 3 — The three resource files

- [ ] `global-master-list.ts` — today's `catalog.ts` content, `leaverPolicy: 'hide'`, cursor on
      `id` (**string**, UUID), `writes: []`. `catalog.ts` stays and is imported by it, so the
      existing picker and tests keep working during the transition.
- [ ] `orphanage-pay.ts` — cursor on the **composite** `(source_file, employee_email)`
      (`create_orphanage_pay.sql:35`), `leaverPolicy: 'include'` (ruling 3), `writes: []`.
      Fields: `employee_email`, `employee_name`, `source_file`, `week_start`, `week_end`, `hours`,
      `reg_hours`, `ot_hours` in the default groups; **`regular_rate_php`, `ot_rate_php`,
      `amount_php` in group `money`**. `locked_by`, `locked_at`, `created_at`, `updated_at` →
      `never`.
- [ ] `orphanage-oms-hours.ts` — the write target. `writes: [submitHours]`.

## Task 4 — The conformance suite (`resources.test.ts`)

- [ ] Assert every `ResourceDef` declares every required key — a resource that forgets
      `leaverPolicy` or `cursor` fails the suite.
- [ ] **Assert `always ∪ fields ∪ never === liveColumns` per resource**, exactly as
      `catalog.test.ts:58` does for the GML. This is the part that makes the pin real: a resource
      whose table grows a column fails until someone classifies it.
- [ ] Assert scope strings match `^[a-z_]+\.(read|write)$` and are unique.
- [ ] **Negative control:** a resource declaring a `money` field and an absent grant key must
      resolve to a refusal, not to whole-resource. A SQL CHECK cannot express this, so the test
      *is* the control — say so in the migration comment.
- [ ] Assert the enumerated SQL CHECK list in the migration equals the registry's scope list, so
      the two cannot drift.

## Task 5 — The cursor (item 133)

- [ ] `cursor.ts`: encode/decode an opaque string carrying the resource slug and the key tuple.
      Arity-checked; a cursor minted for one resource is refused by another.
- [ ] `gml-query.ts`: `GmlRow.id` becomes `string`; delete the `/^\d+$/` gate; replace
      `a.id - b.id` with a string compare. **Keep `readActiveGmlRows`'s SQL `.order('id')`** — the
      NaN comparator was being carried by it, and removing it now would break ordering for real.
- [ ] `mcp-server.ts`: `cursor` becomes `z.string()`.
- [ ] **Change the fixtures to UUIDs first** in `gml-query.test.ts`, `gml-read.test.ts`,
      `mcp-server.test.ts`, `grants.test.ts`. The green suite is the reason this shipped.
- [ ] Add the test that would have caught it: page a UUID-keyed table across two pages and assert
      the second call **accepts the `next_cursor` the first call issued** and returns disjoint rows.
- [ ] Correct the contract lines in `docs/features/external-api-integrations.md` (`:202`, `:204`).

## Task 6 — Grants become per-scope

- [ ] `granted_fields` is `jsonb`, keys are **exactly** scope strings, values are `null` (whole
      resource) or a field list. `[]` refused, in code and in SQL.
- [ ] **Backfill writes an explicit `{"global_master_list.read": null}`** for whole-table rows —
      not `{}`. An absent key must be distinguishable from a deliberate "everything", or
      "never written" and "admin chose all" become the same thing.
- [ ] A `granted_fields` key whose scope is not in `scopes` is refused on write **and** ignored on
      read. Both.
- [ ] For any resource declaring a `money` field, an **absent** grant key is a **503**, never
      whole-resource.
- [ ] Preserve verbatim: collapse-to-null, catalog-order storage, the `[]` reasoning.

## Task 7 — `authenticate.ts` / `serve.ts`

- [ ] `authenticateExternalRequest(request, requiredScope)` — required parameter, no default.
- [ ] `admitExternalCall(request, { resource, operation, ... })`.
- [ ] The write branch adds: a method allow-list, a body size cap, an `Idempotency-Key` header,
      and a **separate daily write cap**.
- [ ] **The daily write cap is counted from `external_api_write_intents`, NOT from
      `external_api_requests`.** The request log is the per-minute rate meter and gets exactly one
      row per call at the end (`serve.ts:63-77, :144`); a second pre-flight row would double-count
      the meter and would violate the table's own outcome CHECK, which requires a known status.

## Task 8 — The read pipeline

- [ ] `resource-query.ts` / `resource-read.ts`: generic versions of `applyGmlQuery` /
      `executeGmlRead`, same projection-after-query discipline.
- [ ] `external-api-db.ts`: `readResourceRows(def, select)` via `selectAllPaged`, refusing a select
      containing `*`.
- [ ] **A leaver-inclusive GML reader.** `readActiveGmlRows` hard-filters `off_boarded_at IS NULL`
      (`:338`); reusing it for the orphanage resource's leaver flag would return nothing for
      exactly the nine leavers ruling 3 exists to include, and a lazy coalesce would print
      `off_boarded: false` for them. Add a distinct reader selecting `id`, `Work Email`,
      `off_boarded_at` with **no** leaver filter, paged. An unmatched email serves
      `off_boarded: null` **with a reason** — a missing mark is a third state and it fails closed.

## Task 9 — The orphanage verdict (ruling 4)

- [ ] Two axes, and **neither is called `paid`**:
      - `self` — does `amount_php` equal its own hours × rates? Computed by the wizard's own
        `reconcileLockedOrphanageAmount` so the API and the wizard screen cannot disagree.
        `ok | ot_underpriced | amount_mismatch`.
      - `column` — does the Additions Orphanage column agree? `matches | differs | uncompared`.
        It is **not** named `paid`: `payment-dispatch.md` §4.2.2 gives three carriers with
        precedence B→A→C, and a row falling through to carrier C loses the orphanage money
        entirely. A field called `paid` that never reads `payment_dispatches` is a misnaming an
        integrator would act on. A `dispatched` axis is **Phase B**.
- [ ] **Resolve the period by parsed date range, never by filename string** —
      `parseDateRangeFromFilename` (`src/lib/hubstaff/calendar-column-dedupe.ts:857`). Item 134
      measured `orphanage_pay` holding `…2026-08-29 (1).csv` while every other carrier uses the
      plain name; filename equality would report all 80 of those rows unvouched when they agree to
      the centavo. A week resolving to zero or more than one source file is `uncompared`, stated.
- [ ] **`uncompared` is a first-class state, not a pass.** It is the whole lesson of item 134.
- [ ] **Surface what the resource cannot see.** A hand-typed amount writes no `orphanage_pay` row,
      so the resource structurally under-reports — ₱3,847.50 on the 2026-08-23 week (eugeneg@),
      ₱5,373.00 on 2026-08-09 (erict@). Add a period-scoped `meta`:
      `{ record_total_php, column_total_php, column_only_rows, column_only_php }`, off the same
      date-range-resolved blob. Without it a consumer summing a week gets a number that is wrong
      low with nothing on the wire saying so.

## Task 10 — The write path (ruling 6)

- [ ] **Target: `orphanage_oms_hours` only.** Its own DDL says it is **NOT MONEY** and that no
      UPDATE or DELETE path exists. An external POST is the same class of object as a human Save;
      money still only moves when a clerk clicks Lock in.
- [ ] **No write may land in a carrier a pricing or lock-in function owns.** Not `orphanage_pay`,
      not the additions blob, not `payment_dispatches`, not `disbursement_records`. A second
      pricing path is exactly the 2026-08 incident, rebuilt from outside.
- [ ] Rows arriving by API are resolved and priced by `resolveOrphanageHourRows` →
      `priceOrphanageHours`, the same pair the paste and the OMS pull run. Never a second loop.
- [ ] `external_api_write_intents`: append-only, one row per accepted intent, `idempotency_key`
      unique per client — the constraint doubles as the concurrency lock.
- [ ] `write_limit_per_day` defaults to **0** on every client, new and existing. "Holds the scope
      but writes nothing" is the ship-day state.
- [ ] Audit family `external_api.write.*`; actor from `auditFrom`, **never** the body.
- [ ] The dispatch-lock check resolves its period by parsed date range too — same discipline as
      task 9, same reason.

## Task 11 — Admin UI

- [ ] The slideshow gains **Resources** before Fields: Who → Resources → Fields → Access → Confirm.
      Nothing is created until Confirm; that rule does not bend.
- [ ] **Money and identity fields default UNTICKED.** Whole-resource-by-default is safe for the one
      roster table Kane ruled on; it is not safe as a rule across ten. A stray four-click pass
      through the slideshow must not export ₱4,065,967.05 across 156 people. Pin it: the default
      payload for a newly-ticked `orphanage_pay` contains **no** field whose group is `money`.
- [ ] The **write toggle** renders only where the resource declares a `writes` entry, carries a red
      one-liner, and shows its daily cap **inline** — granting the scope and capping it at 0 must be
      read in one glance, not on two screens.
- [ ] **The leaver cross-product warning fires on the Resources step**, where the two toggles meet.
      The GML row's "Off-boarded people are never returned" becomes false the moment
      `orphanage_pay` is also ticked — that key can then derive who left, for anyone with orphanage
      hours (nine people, ₱117,418.29). A disclosure that lives only in the doc is invisible.
- [ ] The Edit dialog reads back **changes**, not state: added scopes, added fields, raised caps,
      marked as widenings. Removing a scope visibly drops its `granted_fields` key.
- [ ] The `[]`-refused message names **which resource** has nothing ticked; Next is gated per
      resource or an admin meets a dead button with no explanation.
- [ ] The list table's `Columns` cell becomes `Access` — `GML 12/22 · Orph-pay 5/11 · +write`.
- [ ] Console-plain vocabulary holds: dot status never a filled pill, one primary, hairline borders.

## Task 12 — Realtime audit (ruling 5)

- [ ] **Server Broadcast, own topic, never `postgres_changes`.** `payment_dispatches` has RLS with
      zero policies and `app_settings` is admins-only, so row events never reach the browser
      ([[supabase-realtime-anon-rls-dead]]). Use `broadcastFromServer`
      (`src/lib/supabase/realtime-broadcast.ts`), fire-and-forget, never awaited on the request
      path, plus a **15s poll floor** — the `useFpuLive` shape.
- [ ] **The payload is a pointer, never the audit row.** Broadcast has no RLS and the anon key
      ships in the bundle; audit `details` name granted columns, key prefix, expiry and limit. Send
      an id; the panel re-fetches through the admin-gated route. Pin the payload shape in a test —
      the "optimisation" that inlines the row to save a fetch is the leak.
- [ ] **The rail shows the DELTA, not the event.** "kaner@ · updated · OMS · 2s ago" proves
      something happened, not that it was bad. Render "OMS · Orphanage pay · 3 fields → whole
      resource", widenings marked. The audit row already carries before/after. This is the thing
      ruling 5 is actually buying.
- [ ] The rail lives **in the Integrations tab**, where the grant is made — not only in the Audit
      Log panel.
- [ ] Cache contract holds: a cached value paints, it never decides.

## Task 13 — Compatibility, migration, verification

- [ ] `/api/external/v1/global-master-list` stays a working URL — the live OMS client's request must
      remain **byte-identical** in path, parameters, and the 12 columns plus `id` it receives.
- [ ] `describe_access`'s **payload** for a GML-only key must be unchanged too, not just the tool
      names. Pin it.
- [ ] `MCP_TOOL_NAMES` stays pinned; a GML-only key still sees exactly two tools.
- [ ] Migration is additive: `granted_columns` is neither dropped nor altered in this pass. A
      compat shim reads either shape so the deploy is order-independent. Dropping the old column is
      a **separate commit behind a probe**.
- [ ] `SELECT` backup to disk before the backfill `UPDATE`.
- [ ] `scripts/verify-external-api-resources.mts` — read-only, run after apply, proves the one live
      client's effective grant is unchanged.

## Task 14 — Docs, in the same commit

- [ ] `docs/features/external-api-resources.md` — the new governing doc.
- [ ] Rewrite `external-api-integrations.md` § "One table = one route" — that rule is now
      superseded by Kane's ruling 1, and the doc must say so **in those words**, with the date, not
      quietly drop it. Correct the `catalog.test.ts` overstatement and the stale migration note.
- [ ] `orphanage-pay-step.md` — a third reader of the record, and what it cannot see.
- [ ] New `docs/features/INDEX.md` row with the Key invariant filled in.
- [ ] Memory `external-api-resources` + its `MEMORY.md` pointer + its wikilink in the INDEX row.
- [ ] Deploy notes naming every migration script by path, marked **PENDING** until Kane confirms.

## Not in this plan

- Phase B's eight resources.
- The `dispatched` verdict axis.
- Item 136 — the anon-readable GML. A security decision for Kane; narrowing that policy blind
  would break the anon GML readers `roster-bulk-check-rls-gap` documents.
- Item 134's repair of `audit-orphanage-pay-divergence.mts` (its "clean — blob ABSENT" line should
  read `UNCOMPARED`). This plan works around the drift; it does not fix the script.
