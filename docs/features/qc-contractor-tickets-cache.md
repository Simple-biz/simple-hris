# QC · Contractor · Tickets tab cache — and the envelope, written once

Kane, 2026-09-22: *"if Im from accounting dashboard and went to the manager dashboard I
shouldnt have to refetch data again."* QC, Contractor and Tickets were the three dashboards
with **no cache at all** — 4/3, 11/8 and 22/10 fetches and `no-store` reads, every one of
them cold on the way back.

Key files:

| Piece | File |
| --- | --- |
| The envelope, once | `src/lib/dashboard-cache/create-tab-cache.ts` (+ `.test.ts`, 19 tests) |
| The `useState` drop-in + identity binder, once | `src/lib/dashboard-cache/create-cached-state-hook.ts` |
| The three stores | `src/lib/qc/tab-cache.ts` · `src/lib/contractor/tab-cache.ts` · `src/lib/tickets/tab-cache.ts` |
| Wired surfaces | `QCApp.tsx` · `ContractorOverview.tsx` · `TicketsBoard.tsx` |
| Purge on sign-out | `QCSidebar.tsx` · `ContractorSidebar.tsx` · `TicketsSidebar.tsx` |

## Why there is a factory, and what it deliberately does not touch

Kane answered the sequencing question the same day: **copy the envelope again rather than
extract a shared factory across the shipped stores first.** This honours that and stops
exactly there.

**It migrates nothing.** Not one of the seven shipped stores imports it, and none should as
part of this change — that migration is its own review, against seven test suites. What it
does is keep the count at **seven instead of ten**: three more hand-copies of an envelope
whose duplication is already the recorded debt would have made the eventual migration half
again as large, for three small surfaces. The open follow-up is unchanged and now strictly
smaller than it would otherwise have been.

The factory is the **Manager/Admin** shape, not the Accounting one: `sessionStorage` never
`localStorage`, identity-stamped, **inert until bound** with boundness folded into the hook's
key, 12h ceiling, capacity-bounded with oldest-written evicted first, reads fail closed,
quota and private mode degrade to memory-only.

**No skip-fetch flag is reachable from anything it returns.** That is stronger than the
convention the other stores keep with a `no-skip-flag` test: here a consumer *cannot* skip
its fetch, because nothing in the store or the hook can answer "already fetched". The
Accounting store's `hasFetchedThisSession` remains that store's ratified exception (Kane,
2026-09-09 — keep-and-police), not a pattern.

Two guarantees worth naming, both pinned:

- **A prefix without a trailing `:` is refused at construction.** Not a nicety — a store
  prefixed `qc-tab` would enumerate, and `clearAll` would **delete**, the keys of one
  prefixed `qc-tab-archive`.
- **One store cannot read or purge another's keys**, even for the same key name under the
  same viewer.

## What each store holds — and what it must not

### Tickets (`tkt-tab:`)

`board`, `archived` and `members`. The two ticket lists are separate keys because they are
separate fetches and separate datasets.

**A board is a queue other people act on**, which makes the no-skip property matter more here
than anywhere else in this family: someone moves, closes or reassigns a card while you are on
another dashboard, and a skipped fetch leaves you dragging a card that has already moved —
`manager-dashboard-cache.md`'s *"stale-and-stop is how two managers approve the same request
twice"*.

**`access` (`'view' | 'edit'`) is deliberately absent, and no key may be spelled for it.** It
is a PERMISSION, so caching it is a cached value DECIDING. It also gates whether the board is
draggable, so a stale copy would offer edits the server is going to refuse.

Identity binds from `useSelfEmail()` — the NextAuth session, falling back to the session-email
key login writes. The board's own `j.viewer` arrives with the fetch, far too late to seed
anything.

### QC (`qc-tab:`)

`assignments:<week>` and `progress:<week>`, **keyed by week**. Stepping between weeks is the
common move on this dashboard, and one shared key would make each week evict the other and
re-fetch on the way back — the thing the store exists to stop. A week is also the one
parameter that selects a genuinely different dataset for the same viewer, which is exactly
when the stores' rules say to put it in the key. The key is `null` until a week resolves,
which opts out cleanly rather than writing an entry under a blank week.

`qcLoaded` is now **derived**, and its `settled` flag is **reset per week** — deliberately
unlike the other `settled` flags in this codebase, because a different week is a different
dataset and a flag carried across would clear the skeleton for a week that has not loaded.
`hasQcData` decides "is there anything to paint": `officerCount` alone would not do, since a
week with one officer and no assignments is a legitimately empty answer, and reading it as
"nothing arrived" would pulse the skeleton at a number that will never change
([[kpi-calculator-week-unresolved-hang]] is the same class).

### Contractor (`ctr-tab:`)

One key: `overview:invoices`. **Most of this dashboard may not be cached, and that is the
point.**

- `GET /api/contractor/profile` returns the payout row. The route's own comment says it
  "carries bank account + ACH routing numbers", and its field list includes `account_number`,
  `swift_code`, `ach_routing_number` and both wallet emails. Never cached; no key may be
  spelled for it.
- The saved-invoice list is out for two reasons: `payment_method` carries the rail the
  invoice is to be paid on, and `logo_data_url` is an inline data URL that would spend the
  whole storage budget on one row.
- The invoice **builder** is a draft, and a draft that survived a reload would paint under a
  clean form — the Admin store's *as loaded or as saved, never as edited* rule.

What is left is the Overview's invoice list — numbers, dates, totals, currency, status — which
is the landing surface a dashboard switch actually hits.

## Sign-out

`signOut` navigates in the **same tab** and `sessionStorage` survives that, so all three
sidebars remove the session email **first** and then purge. That order is the one
`accounting-dashboard-cache.md` had to learn: a read racing the purge would re-adopt the
identity being dropped.

## Not done

- **Nothing shipped was migrated onto the factory.** Seven stores still carry their own copy;
  that remains the open follow-up, and it is now a seven-store migration rather than a ten.
- **Contractor is one key.** Its other surfaces are excluded on the grounds above, not
  unfinished — if the saved-invoice list ever needs caching, project `payment_method` and
  `logo_data_url` out of it first.
- **QC's calculator tab keeps its own store** (`mgr-kpi:`, `dept-qc`), unchanged.
- **Not verified in a browser** — `tsc` is clean and 4369/4371 tests pass (the two failures
  pre-existing and unrelated), but no live click-through (needs Google SSO + Supabase auth).
