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
| Wired surfaces | `AdminWebhooks.tsx` (section, entries) · `AdminExternalApiClients.tsx` (client list) |

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

## This is a further copy of the envelope, knowingly

`memory/admin-dashboard-cache-blueprint-pending` records the alternative — extract a shared
factory across the shipped stores first — as Kane's sequencing call, not the session's. This
store was scoped to the one page Kane asked about; the rest of the Admin blueprint (Q1 AdminRoles,
Q2 the shared AuditLogPanel, Q3 one roster key or two) is still open.

## Deploy notes

**No migration.** No env. Purely client-side.
