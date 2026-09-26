# Integrations → Data catalog tab

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:executing-plans`. Steps use `- [x]` syntax.

**Goal:** a third tab on Admin → Webhooks & Integrations that documents every dataset an outside
system may read (or may one day read), grouped by area, and shows which clients hold each live
one. Documentation only: nothing here makes a dataset reachable.

**Spec:** the `BLUEPRINT` brief posted in session `4fd1bd52` on 2026-09-25 (audit log
`docs/audits/audit-2026-09-25-session-log.md` item **218**). Kane took all three recommendations:

| # | Ruling | Consequence |
|---|---|---|
| Q1 | Show planned datasets now, labelled not reachable | the registry has a `planned` status; its pages say "No key can reach this" |
| Q2 | Bank Info = payout method + bank name + last-4 + missing-info flag; full numbers never offerable | the Bank Info page lists account / routing / SWIFT / alt numbers under **Never leaves the HRIS**, test-pinned |
| Q3 | `datasets.ts` stays documentation-only; Phase A's `resources/*.ts` replaces it later | no `ResourceDef`, no liveColumns, no cursor declarations here |

**Architecture:** one pure registry (`src/lib/external-api/datasets.ts`) whose GML fields are the
`catalog.ts` objects themselves, a pure access resolver (`dataset-access.ts`) over the client list
the Integrations tab already fetches, and one component. **No new route, no migration.**

## Global constraints

- **A planned dataset never looks reachable.** Only `status: 'live'` carries `scope`, `restPath`,
  `mcpTool` (a discriminated union, so the compiler refuses the rest); the test pins it again.
- **The live set is pinned both ways to controls outside this file**: every live scope is in the
  SQL `external_api_clients_scopes_known` CHECK, and every scope in that CHECK is a live dataset;
  every live `restPath` is a route file on disk; every live `mcpTool` is in `MCP_TOOL_NAMES`.
- **"Who has access" is computed, never stored.** Live = not revoked, not expired (`isExpired`,
  fail-closed), scope held. Cache paints, never decides (`admin-dashboard-cache.md`).
- **No bank value, no row data** ever enters this tab: the registry holds field names only.
- Out of scope: every `/api/external/` route, grants, the scope CHECK, the New client slideshow,
  `authenticate.ts` / `serve.ts`, Phase A of `2026-09-21-external-api-resources-and-writes.md`.
- Stage by explicit path. Commit direct to `main`. **Never push.**

## Task 1 — The registry

- [x] `src/lib/external-api/datasets.ts`: `DATASET_DOMAINS` (People & roster · Time & attendance ·
      Pay · Banking · Performance · Never offered), `DATASETS` (live · planned · never).
- [x] GML: `fields: GML_CATALOG`, `always: ALWAYS_COLUMNS`, `neverServed: NEVER_COLUMNS`, imported.
- [x] Caveats carry a reference (audit item or memory) so the page can say where the fact lives.

## Task 2 — The registry's tests

- [x] Slugs unique; every domain used; every dataset in a known domain.
- [x] Live-only fields: planned / never entries carry no `scope` / `restPath` / `mcpTool`.
- [x] Live scopes ⇄ the SQL CHECK enumeration (latest file defining it), both directions.
- [x] Live `restPath` → route file exists; `mcpTool` ∈ `MCP_TOOL_NAMES`.
- [x] GML fields are `GML_CATALOG` by identity; always / never equal the catalog's.
- [x] Bank Info: no field names a full number; the never list names every one (Kane Q2).
- [x] No field is both offered and never-served, per dataset.

## Task 3 — The access resolver

- [x] `src/lib/external-api/dataset-access.ts`: `clientAccess(clients, dataset, now)` →
      `{ live, revoked, expired }` rows with fields granted / hidden, 7-day calls.
- [x] Revoked wins over expired (the panel's `stateOf` order). An unparseable expiry is expired.
- [x] `dataset-access.test.ts`: scope absent → not listed; revoked; expired; unparseable; the
      field count for a whole-table and a partial grant; a list not read is unknown (`describeAccess`).

## Task 4 — UI

- [x] `src/components/admin/AdminDataCatalog.tsx`: grouped list → detail with Back. Same fetch
      and cache key as `AdminExternalApiClients` (`integrations:clients`).
- [x] `AdminWebhooks.tsx`: `SECTIONS` gains `catalog` ("Data catalog").
- [x] `tab-cache.ts`: the `webhooksSection` comment names the third value.

## Task 5 — Verify and document

- [x] `npx tsc --noEmit`; the three test files; the full suite (two known failures, item 203).
- [x] `docs/features/integrations-data-catalog.md`, INDEX row, memory + `MEMORY.md`,
      `components.md`, a cross-link from `external-api-integrations.md`, audit item 218 updated.

## Done — 2026-09-25

24 tests (13 + 11) green; each registry pin verified to FAIL when broken (scope typo, missing route,
retyped GML fields, a full account number offered on Bank Info). Full suite 4,566 / 4,568 — the two
failures are item 203's, in files this plan does not touch. Typecheck clean apart from two stale
`.next/types` entries for the retired `bank-preferred-requests` route. Server render of the list and
all 23 dataset pages. **Not exercised in a browser** (Admin needs SSO).

**Corrected against the brief:** its RISK line cited item 135's 1,723-vs-1,215 gap; that gap was
closed 2026-09-21 (memory `gml-transfer-orphan-rows`, both read 1,266), so no such caveat shipped.
