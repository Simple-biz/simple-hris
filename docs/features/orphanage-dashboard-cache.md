# Orphanage dashboard tab cache

The seventh client cache, and until 2026-09-22 the only one with **no feature doc and no
`docs/features/INDEX.md` row** — its rules lived in its own docstring, which is why the
INDEX's cache rows understated the store count as four when it was seven. Found by the
2026-09-22 dashboard-switch audit (item 169) and written here.

Key files:

- `src/lib/orphanage/tab-cache.ts` — the store (in-memory `Map`, deliberately not persisted).
- Consumers: `GiftTracker.tsx` (four keys), and since 2026-09-22 `GiftRecentSubmissions.tsx`
  and `GiftCatalog.tsx`.
- Tests: `src/lib/orphanage/tab-cache.test.ts`.

Modelled on `src/lib/hr/tab-cache.ts`, which is the shipped reference for this exact shape.
Same semantics, same prohibitions — **if you fix a bug in one, fix it in the other.**

## Paint and skip are different questions

| Predicate | Answers | Used for |
| --- | --- | --- |
| `hasOrphanageTabCache(key)` | is there something to **paint**? | whether a skeleton is needed |
| `isOrphanageTabCacheFresh(key)` | may the fetch be **skipped**? | whether to hit the server |

`FRESH_WINDOW_MS` is **30s**, matching the HR store and the Payroll Notes panes. A warm but
stale entry still PAINTS and the consumer revalidates behind it. Collapsing the two
predicates back into one is the regression — it is what left an HR session running all day
on data it pulled once.

Do not reach for Realtime as the alternative: browser `postgres_changes` is documented dead
here ([[supabase-realtime-anon-rls-dead]]), and "add the table to the publication" is a
security decision for Kane, not a fix for a stale tab.

## In-memory ONLY, and that is load-bearing

Nothing is mirrored to `sessionStorage` or `localStorage`, so this store carries **no
identity stamp** — which is safe *solely* because it cannot outlive the page. Signing out
navigates and drops the module. A test greps the module for `sessionStorage`/`localStorage`
so a well-meaning "make it survive reloads" change fails loudly.

Note what that means for a **dashboard switch**, which is `router.push` and therefore keeps
the module alive: this cache survives orphanage → accounting → orphanage, and does **not**
survive F5. That is the opposite trade from the four `sessionStorage` stores, and it is the
deliberate one until the identity envelope is added.

## Bank rows stay OUT of this store

The Orphanage dashboard is structurally a payments dashboard, and **four of its tabs carry an
account number on their primary row type**:

| Tab | Row type | Carries |
|---|---|---|
| 3rd Party Vendors | `OrphanageVendorRow` | `bank_name`, `account_holder_name`, `account_number`, `swift_code`, `routing_number` — all **required** |
| Orphanages | `Orphanage` | `bankName`, `bankAccountName`, `bankAccountNumber`, `swiftCode` (the receiving bank for the interns' orphanage share) |
| Budget History | `OrphanageBudgetRequestRow` | `bank_account_name`, `bank_account_number`, `bank_name`, `swift_code` |
| Gift Payments | `GiftPaymentRow` | `our_bank`, `transaction_id`, and the vendor block |

None of them is cached, and that is the decision rather than an omission.

The store already holds **home addresses** by design — the gift shipping rows do, and the
module's own docstring names them as what the in-memory-only property protects. Account
numbers are a different category. This store's single safety property is that it cannot reach
disk, guarded by one grep test; if half the dashboard's rows were bank rows, that test would
be the only thing standing between account numbers and `sessionStorage`, one well-meaning
"make it survive reloads" change away. Keeping bank rows out entirely is what keeps that
warning a nice-to-have instead of a load-bearing secret.

**If one of these tabs needs caching later, the shape is the Admin roster's**: cache a
projection with the bank fields partitioned out at compile time
(`src/lib/employee/master-row-cache.ts`), and let the bank block load live for the selected
row alone.

## Wired datasets

| Key | Source | Note |
|---|---|---|
| `orph:gift:employees` | `GET /api/employees` | the Gift Tracker roster |
| `orph:gift:notes` | gift-tracker notes | RAW rows; the by-email `Map` is derived |
| `orph:gift:shipping` | shipping submissions | RAW rows; grouping derived |
| `orph:gift:receipts` | fulfilment ledger | RAW rows; the nested `Map` is derived |
| `orph:gift:recent-submissions` | `GET /api/gift-tracker/recent-submissions?limit=100` | rows + summary + total as **ONE** entry — three keys would let per-key eviction print a total that disagrees with the rows beside it |
| `orph:gift:catalog` | `GET /api/gift-catalog` | the catalog as **LOADED or SAVED, never as EDITED** |

### The catalog is a form, so it gets the Admin store's draft rule

`GiftCatalog`'s Save button is gated on `dirty` — a diff of `payload` against `originalJson`.
Seeding `payload` from a half-typed draft would paint unsaved edits under a clean, disabled
Save, which is the same defect `admin-dashboard-cache.md` describes for `webhooks:entries`.
Both states are therefore seeded from the **same** cached value, which is what makes them
agree, and the cache is written on load and after a **accepted** PUT — never on edit, and
never before the server answers.

## Not done

- **Four tabs stay uncached on purpose** (above). The Interns tab and the budget form were
  not reviewed.
- **No identity envelope.** Adding one is the prerequisite for ever persisting this store.
- **Not verified in a browser** — `tsc` is clean and 4350/4352 tests pass (the two failures
  pre-existing and unrelated), but the live tab-switch behaviour was not clicked through.
