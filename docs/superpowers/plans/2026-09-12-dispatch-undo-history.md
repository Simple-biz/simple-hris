# Payment Dispatch — Undo history — build plan

**Approved 2026-09-12.** Kane: *"Payment Dispatch - SHOULD HAVE UNDO Button version
history… whenever leny presses the undo button we should know what changed please
make sure to add time stamp as well."*

Answers to the brief's questions:

| Q | Answer |
| --- | --- |
| Q1 who may open it | **Anyone who operates Payment Dispatch** — i.e. anyone who can press Undo. Same gate as the undo write itself, so the clerk sees her own corrections |
| Q2 how far back | **All weeks.** Not cycle-scoped — keyset paging, actor filter, date range, search |
| Q3 does "Clear" belong in it | **No.** Clearing a Not-Paid / Threshold / Problem marker is excluded |

## What already exists (do NOT rebuild)

`POST /api/payment-dispatches/undo` already writes one `payment.undone` audit
event per undone payment, carrying the full snapshot of the row it deleted
(recipient, USD/PHP/COP, processor, txn id, bank used, original status, note,
`originally_paid_by`, `originally_paid_at`, cycle context) plus a `batch` block
tying one multi-select together. It is `await`ed, not fire-and-forget, and falls
back to per-row inserts if the bulk write fails. `audit_log.created_at` is the
timestamp. **None of that changes here.** This build adds the surface that reads
it, and closes two defects in the recording.

## Measured before building (read-only, 2026-09-12)

198 `payment.undone` events, 2026-06-08 → 2026-09-11. Every one of them
resources `payment_dispatches`.

| Slice | Count | Consequence for this build |
| --- | --- | --- |
| `original_status: 'paid'` | 109 | money undos — the spine of the view |
| **no `original_status` at all** | **59** | legacy shape `{count, ids}` only, 06-08 → 07-29. **"What changed" is unknowable for these** — only the dispatch id survives |
| `problem` / `threshold` / `not_paid` | 24 | marker clears — excluded per Q3 |
| `no_rows_deleted: true` | 6 | undo pressed against rows already gone |
| `ip_address` populated | **0 / 198** | defect — neither undo route ever writes it |
| actor `'unknown'` | 0 | the fail-open has not bitten yet; still a latent hole |
| actor `kaner@simple.biz (dedupe-payment-dispatches)` | 82 | script-written, not a button press — must be visually distinct |
| `lenny@simple.biz` | 43 | the actual subject of the request |

**The classification rule this forces.** Exclude only what can be *positively*
identified as a marker clear (`original_status` ∈ problem/threshold/not_paid).
Everything else stays, including the 59 legacy rows and the 6 no-op attempts.
Filtering to `original_status === 'paid'` would silently hide 59 real undos — the
"a window posing as the whole history" bug this codebase has already been bitten
by twice ([[penny-audit-log-visibility]]). A row that cannot be classified is
shown and labelled **unknown**, never guessed and never dropped.

## Tasks

### 1 — Data
- [ ] **No migration.** Every field already exists on `audit_log`; the undo
      routes already write `details.cycle` in `payment.dispatched`'s shape.

### 2 — Pure logic, tested
- [ ] `src/lib/payroll/undo-history.ts` + `undo-history.test.ts`
      Pure, no DB, no `server-only`. One audit row → one `UndoHistoryEntry`:
      - `kind`: `'payment'` | `'marker_clear'` | `'no_op'` | `'unrecorded'`
        (the legacy `{count, ids}` shape). Derived from `details`, **never** from
        the action name — one action serves all four.
      - `isMoneyUndo()` — the Q3 filter. Excludes ONLY a positively-identified
        marker clear; `unrecorded` and `no_op` pass through.
      - `actorLabel()` — splits `kaner@simple.biz (dedupe-payment-dispatches)`
        into email + script tag so a script run never reads as a button press.
      - `batchKey()` — groups the per-row events of one multi-select.
      - Amounts pass through **verbatim**; no re-derivation, no FX maths.

### 3 — Read route
- [ ] `app/api/payment-dispatches/undo-history/route.ts`
      `requireRateVisibilityOrFeatureEdit('accounting', 'payment_dispatch')` —
      copied from `app/api/payroll-wizard/audit/route.ts:24`, the same gate the
      undo write uses, which is what makes it self-visible (Q1).
      Reads via `fetchAuditLog({ actionPrefix: 'payment.undone', … })` — keyset
      paging, never `.range()` ([[postgrest-1000-cap-sweep]]). Q3 filtering runs
      in JS over the page, so the response reports `scanned` and `filtered_out`
      the way `/api/audit-log` reports its `search_window`: a page that shows 8
      of 20 scanned says so.

### 4 — Close the recording defects
- [ ] `app/api/payment-dispatches/undo/route.ts` — `getSessionActor()` →
      `auditFrom(req, authz)`. The route already holds an `AuthzOk` from
      `requireFeatureEdit`; `getSessionActor()` fails OPEN to `anonymous`, and
      line 91 writes `actor ?? "unknown"`. `AuthzOk.sessionEmail` is a
      non-optional string, so the un-actored branch stops existing
      ([[audit-registry-single-source]]).
- [ ] `app/api/urgent-payments/dispatches/undo/route.ts` — same swap, both
      `insertAuditLog` calls.
- [ ] Both: record `ip_address` (0/198 rows carry one today). It is the only
      signal separating a staff-entered action from anything else.
- [ ] **Not loosened:** no gate, type, or validation is relaxed. The actor
      becomes *stricter* — fail-open replaced by a type that cannot be un-actored.

### 5 — UI
- [ ] `src/components/payroll-clerk/UndoHistoryPanel.tsx`
      Reads the route; renders newest-first. Each entry states **what changed**:
      who was paid, how much, via which processor, txn id, and what it reverted
      to. Timestamp is **absolute Manila + relative**, mirroring
      `AuditLogPanel.tsx:938`. Actor named on every row. Legacy `unrecorded`
      entries say plainly that only the dispatch id survives.
      Filters: actor, date range, free-text.
- [ ] Mount in `src/components/payroll-clerk/PayrollDispatch.tsx` as a rail card
      beside History.

### 6 — Docs, same commit
- [ ] `docs/features/payment-dispatch.md` — new § for the undo trail, and
      **correct the stale line 1154** which still claims there is no undo UI.
- [ ] `docs/features/INDEX.md` row
- [ ] memory `dispatch-undo-history` + `MEMORY.md` pointer

### 7 — Verify
- [ ] `node --test` on the new pure module
- [ ] `tsc --noEmit` — **not `next build`**: a dev server is live on :3000 and
      they share `.next/` ([[nextjs-build-vs-dev-shared-dir]]).
