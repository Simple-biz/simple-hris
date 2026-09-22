# Admin dashboard cache — the Admin shell's tab-switch and reload store

A `sessionStorage`-mirrored, identity-stamped cache for Admin tabs, so a tab that unmounts on
every switch (`app/admin/page.tsx` renders one tab through a `switch`) repaints instantly from
the last value seen in this browser tab instead of a skeleton. Started 2026-09-17 on
**Webhooks & Integrations** (Kane: *"add cache practices as well where it doesn't go away after
switching tabs or reload"*); it is the store the 2026-09-09 dashboard-cache audit left open for
Admin (65 fetches, 36 `no-store`, zero seeding — the worst surface by volume). Other Admin tabs
join by adding a key and swapping one `useState`.

## Key files

| Piece | File |
| --- | --- |
| The store (envelope, identity, ceiling, purge, keys) | `src/lib/admin/tab-cache.ts` (+ `.test.ts`, 15 tests) |
| The hooks (`useAdminCacheIdentity`, `useAdminCachedState`) | `src/hooks/useAdminCachedState.ts` |
| Identity bound at the top of the shell | `app/admin/page.tsx` — `useAdminCacheIdentity(adminEmail)` |
| Purge on sign-out | `src/components/admin/AdminSidebar.tsx` — `clearAllAdminCache()` beside the `SESSION_EMAIL_KEY` removal |
| The master-row projection (+ `.test.ts`) | `src/lib/employee/master-row-cache.ts` |
| Wired surfaces | `AdminWebhooks.tsx` (section, entries) · `AdminExternalApiClients.tsx` (client list) · **since 2026-09-22** `AdminRoles.tsx` · `AdminOverview.tsx` · `AdminGlobalMasterList.tsx` · `PayrollCyclePerformance.tsx` · `HrPipelinePerformance.tsx` |

## A cached value PAINTS; it never DECIDES

Every consumer seeds its state from the cache and then runs its normal, unconditional fetch,
which overwrites it. There is **no skip-fetch flag** — an integration key can be revoked or
throttled by another admin in another tab, so a skipped fetch would show a dead key as live.
A `no-skip-flag` test greps the module's own exports so the flag cannot return by copy-paste.
The skeleton is for having nothing to paint (`!settled && !data`), never for a request being
in flight; a manual **Refresh** keeps its own spinner and an "Updated … ago" stamp.

## What is cached, and what deliberately is not

- `integrations:clients` — the raw `GET /api/admin/external-api-clients` response: clients with
  their key **prefixes**, 7-day counts, unattributed calls, flags, paths. The plaintext API key is
  never list state, so it cannot be cached; a test pins that no key is spelled like a credential,
  bank field, signed URL or presence signal.
- `webhooks:section` — which tab of Webhooks & Integrations is open.
- `webhooks:entries` — the webhooks config **as loaded or as saved, never as edited**. Edits
  bypass the cache; a draft that survived a reload would paint under a "Saved" button.

## Identity, ceiling, purge — the same envelope as the sibling stores

Every entry is stamped with the viewer it was written for, reads reject any other stamp, the
cache is **inert until bound**, and binding a different viewer purges everything first (Admin
honours `?email=` in the same tab; two admins may share a machine). 12-hour age ceiling, schema
`v` stamp, capacity 32 with oldest-first eviction, `sessionStorage` never `localStorage`, reads
fail closed on anything malformed, quota or private mode degrade to memory-only. Boundness is
folded into the hook's key (the shell renders its tabs before `adminEmail` resolves), exactly as
the Manager store does — see `manager-dashboard-cache.md` for the reasoning.

`signOut` is a same-tab navigation and `sessionStorage` survives it, so the sidebar calls
`clearAllAdminCache()` on Sign Out.

## The blueprint's Q1-Q3, answered 2026-09-22

Kane ruled **(b) the doc is stale** on the gate that had held since 2026-09-09, so the store
widened on the session's own recommendations and this file records them as decided:

- **Q1 — AdminRoles: IN.** It was the worst single tab by mount cost: four parallel fetches
  producing a roster, every role assignment, the department list and the manager assignments.
- **Q2 — the shared `AuditLogPanel`: OUT**, unchanged. Accounting renders it too, so caching it
  from this store would give one surface's entries an Admin identity stamp.
- **Q3 — ONE shared roster key.** `GET /api/employees` is the same URL and the same rows for
  AdminRoles, the Overview and the Global Master List. Two keys would mean two copies of ~2,800
  rows in a storage budget measured in megabytes, with the second free to drift.

### The roster is PROJECTED, and that is what makes one shared key safe

An `EmployeeRow` is not just an identity. It carries the person's **home address** (`street`,
`city`, `province`, `postal_code`, `full_address`, `location`), their **contact phone**, their
**pay rates**, and a `bankInfo` block with an account number and a routing number.

An admin may fetch all of that. Mirroring ~2,800 people's home addresses onto disk, where they
survive reloads and sit in the browser profile until the tab closes, is a different exposure —
and it is the one this file's own rule forbids.

**The rule was already being broken elsewhere by exactly this shape.** `employee:profile-rate`
had been caching `bank_preferred`, both wallet emails, phone and full address since 2026-09-03,
because the rate row carries them and the tests pin **key spellings**. A sensitive field nested
inside an innocently-named row is precisely what a key-spelling test cannot see.

So `src/lib/employee/master-row-cache.ts` is the only way in, and **its cacheable/uncacheable
key lists are partitioned at compile time** — every key of `EmployeeRow` must be classified, so
a column added upstream is a type error rather than a quiet leak. `tab-cache.test.ts` **class 9**
closes the other half: any Admin file that touches the roster key must actually CALL the
projection. (That test's first version passed against a file whose projection had been deleted,
because the comment above the call still named it. It now strips comments and requires the call
form; verified by bypassing the projection and watching it fail.)

`bankInfo` is `null` on every row `getEmployees()` builds today, so nothing was leaking through
the Admin path. It is classified uncacheable regardless: the type permits it, and "the producer
happens not to fill it in" is not a guarantee a reader of the call site can see.

The Global Master List is the one Admin surface that renders an address — for the **selected**
person only. Those fields now live in `addressByKey`, plain in-memory state, so the table paints
from cache instantly while the address waits for the live row. Same shape as the Employee
Profile's payout pane waiting behind `bankInfoLoaded`.

### Derived, not stored — and what that broke

`AdminRoles`' People directory is **derived** from the two cached payloads by
`mergeRosterWithAssignments` (module scope, pure), not stored. That keeps `customEmails` — a
`Set`, which `JSON.stringify` flattens to `{}` — off storage by construction.

Deriving it broke selection twice over, and the fix is worth keeping: selection used to hold the
row OBJECT and compare with `selected === e`. Once the list is rebuilt on every refetch that
reference stops matching (the highlight vanishes) **and** goes on rendering the pre-refresh copy
of that person. Selection is now an EMAIL, re-resolved from the derived list through the same
`rowIdentityKey` the merge maps on — one key derivation, because two spellings of "which row is
this" is how a selected person stops matching their own row.

### What deliberately stayed OUT

- **The Overview's audit strip.** `details` is a free-form blob whose contents vary by event
  family, so nothing here can promise a bank field is not inside one. The 24 rows on screen are
  a slice of a 500-row fetch that runs regardless, so caching them saves no round trip.
- **Presence** on the Global Master List (`lastSeen`, `recentActive`) — a stale liveness signal
  is a wrong answer, not a stale one.
- **`AdminApiKeys`** — a credential surface, and one small fetch.
- **`AdminSystemSettings` and `AdminPages`** — editable config forms, and this store's rule is
  *as loaded or as saved, never as edited*. Their payloads are a few settings rows.
- **`AdminDesignSpecs`** — its report answers "what will this sync do"; a cached one could be
  read as a fresh dry run.
- **`AdminCsvImports`** and **`AdminWorkspace`** — action-driven consoles with nothing painted
  on mount worth seeding.

## This is a further copy of the envelope, knowingly

`memory/admin-dashboard-cache-blueprint-pending` records the alternative — extract a shared
factory across the shipped stores first — as Kane's sequencing call, not the session's. This
store was scoped to the one page Kane asked about **until 2026-09-22**, when he ruled (b) on that
gate and Q1-Q3 were answered as above. He answered the **sequencing** question at the same time:
copy the envelope again rather than extract a shared factory first — so the factory across the
now-seven stores remains the open follow-up, not a blocker.

## Deploy notes

**No migration.** No env. Purely client-side.
