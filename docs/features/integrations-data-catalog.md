# Integrations → Data catalog — every dataset outside systems may read, may one day read, or never will

A third tab on **Admin → Webhooks & Integrations**, beside Webhooks and Integrations. It lists
every dataset grouped by area (People & roster · Time & attendance · Pay · Banking · Performance ·
Never offered), each in one of three states, and opens each one as a page: what it is for, where it
comes from, what one row is, whether leavers are served, its fields by group with sensitive ones
marked, what never leaves the HRIS, known caveats, and, for a live dataset, **which clients hold
it** and how much of it each one sees. It is for the admin deciding what to give an integration and
for anyone asked "can system X get Y from us?". Built 2026-09-25, session `4fd1bd52`, audit item 218.

Kane, 2026-09-25: *"a new tab inside this integrations page where we can have the documentation of
the Data we can let people have access to … the first one would be Global Master List … we should
know which clients have access … other Data like Bank Info … Offboarded … give me ideas … arrange
them properly."* He took all three recommendations on the brief:

| Q | Ruling |
| --- | --- |
| Q1 | **Planned datasets are shown now**, labelled as not reachable |
| Q2 | **Bank Info never offers a full number** — payout method, bank name, last four, a missing-info flag; account, routing, SWIFT and alternate numbers are listed under *Never leaves the HRIS* |
| Q3 | **`datasets.ts` is documentation only**; Phase A's `resources/*.ts` registry replaces it when a second dataset ships |

## Key files

| Piece | File |
| --- | --- |
| The registry: areas, datasets, fields, caveats | `src/lib/external-api/datasets.ts` (+ `.test.ts`) |
| Who holds a dataset (pure, computed per render) | `src/lib/external-api/dataset-access.ts` (+ `.test.ts`) |
| The tab | `src/components/admin/AdminDataCatalog.tsx` |
| Mounted as the third section | `src/components/admin/AdminWebhooks.tsx` — `SECTIONS`, id `catalog` |
| The client list it reads (unchanged) | `GET /api/admin/external-api-clients` — `app/api/admin/external-api-clients/route.ts` |
| The GML fields it shows (unchanged) | `src/lib/external-api/catalog.ts` |
| Plan | `docs/superpowers/plans/2026-09-25-integrations-data-catalog.md` |

## Only a Live dataset has a way in

Three states: **Live** (a key can read it today), **Planned** (documented, proposed fields, no key
can reach it) and **Never offered** (the no, on record). `scope`, `restPath` and `mcpTool` exist
on the `live` variant of the `Dataset` union only, so the compiler refuses them on a planned entry,
and a planned page renders no endpoint and no copy button — it says *"No key can reach this yet"*.

Why it matters: the failure this tab can cause is a partner being told "yes, pull bank info" off a
page that looked reachable. So `datasets.test.ts` pins the live set **against the controls that
actually decide reachability**, not against itself:

- **Both directions against the SQL scope CHECK.** The live scopes must equal the
  `external_api_clients_scopes_known` enumeration in the newest dated SQL file that defines it. A
  scope added to the CHECK with no live page fails; a page marked live whose scope the CHECK
  refuses fails. When Phase A's ALTER adds `orphanage_pay.read`, this test goes red until the
  Orphanage pay page moves to live — **that is intended**; it is how the catalog learns.
- **Every live `restPath` is a route file on disk**, under `/api/external/`.
- **Every live `mcpTool` is in `MCP_TOOL_NAMES`.**

Each pin was verified to fail when broken (a scope typo, a missing route, a retyped field list, a
full account number offered on Bank Info) before this shipped.

## The Global Master List page IS `catalog.ts`

`GLOBAL_MASTER_LIST_DATASET.fields` is `GML_CATALOG` by reference (and `always` / `neverServed` are
`ALWAYS_COLUMNS` / `NEVER_COLUMNS`); the test asserts identity, not equality, so a copy fails. The
catalog is what the picker offers and the API serves — a second list here would document columns
the API does not have. To change what the GML page shows, change `catalog.ts` (and its own test),
never this file.

## Who holds a dataset is computed, never written down

"Clients with access" is the **same client list the Integrations tab shows**, same route, same
Admin cache key (`ADMIN_CACHE_KEYS.integrationsClients`) and the **whole** response cached, so the
two tabs paint each other's last read and never store different shapes. `clientAccess` filters by
scope and assigns a state in the order the auth gate refuses in: **revoked first, then expired**
(`isExpired`, fail-closed — a stamp that does not parse is expired), otherwise live. Only live
clients count as "can read now"; expired and revoked ones stay listed, greyed, so the page answers
"who could, and who used to". The cache paints; the fetch runs on every mount
(`admin-dashboard-cache.md`).

**A list that was not read is *unknown*, never zero.** `describeAccess(null)` returns *"Unknown —
client list not loaded"* in rose; the detail table says the list could not be loaded. Showing
"No client holds it" after a failed fetch would tell an admin nobody holds the roster when somebody
might. A table that genuinely is not applied yet (`migration_applied: false`) is an empty list, not
unknown.

**Field counts come from `granted_columns`, which is the GML grant and nothing else.** For any other
scope `fieldGrantFor` returns `unknown` (*"Not recorded"*) rather than applying the GML column list
to another dataset — that would invent a grant. Phase A's per-scope `granted_fields` replaces it.

## Planned fields are proposals

A planned page's fields are a starting point for the `blueprint` that builds the dataset, not a
contract: names and the final list are decided then, as a new scope + catalog + route
(`external-api-integrations.md` § *One table = one route*). The page says so. What *is* fixed now:

- **Bank info** (Kane Q2): never `account_number`, `routing_number`, `swift_code`,
  `account_holder_name`, `alt_account_number`, `alt_routing_number`, `hurupay_email`,
  `full_address`. Test-pinned — no offered field may look like a full number. Inside the HRIS a
  full number is shown one person at a time and every reveal is audited
  (`app/api/people/[email]/reveal-banking/route.ts`); a bulk export by key is a different class of
  exposure. `account_last4` is served only where the payout method is a bank, the same rule the
  People Search Bar uses so a wallet payee's leftover account never reads as their destination.
- **Pay and Banking are marked Money / Restricted** (test-pinned), and the resources plan already
  rules that money fields start **unticked** in the picker (`2026-09-21-external-api-resources-and-writes.md`
  Task 11).
- **Orphanage pay** is tracked by audit item 123 and that plan (Phase A, not started). Its page
  names both.

## Caveats are dated facts with a source

Each caveat is `open` (a known defect, amber, with its date) or `note` (a rule to know), and every
`open` one must name where the fact lives (test-pinned). The GML page carries item 136 — **the
public anon key can read the whole table**, measured 2026-09-21 — because a page saying "1 client
has access" would otherwise overstate what the column grants protect. Remove that caveat only when
item 136 is closed by a measurement, not when someone believes it is.

**Checked before writing, and the brief was wrong once:** the brief proposed a caveat that the API
serves 1,723 rows against HR's 1,215. That gap was closed on 2026-09-21 (both read 1,266 —
memory `gml-transfer-orphan-rows`), so it is not on the page. A caveat copied from an old audit row
without re-reading the memory that closed it is exactly how this page would start lying.

## What this tab does not do

No route, no grant, no scope, no key. Nothing on it changes what any client can read — that is the
Integrations tab. No row data, no count of rows, and no bank value reaches it: the registry holds
field **names** only, and the client list is the one the Integrations tab already caches (key
prefixes, never keys).

## Deploy notes

- **No migration.** No new route. No env var. No n8n.
- Not exercised in a browser this session (Admin needs SSO). Verified by typecheck, 24 unit tests,
  and a server render of the list and all 23 dataset pages (every planned / never page checked for
  the absence of an `/api/external/v1` endpoint).
