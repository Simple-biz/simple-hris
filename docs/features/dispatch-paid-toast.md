# Payment Dispatch "paid" toast — lower-left cards on every Accounting tab while processing is on

While the global dispatch lock is ON, every open Accounting dashboard shows one card in the
lower-left per **Paid** dispatch row — `lenny@simple.biz paid kaner@simple.biz  $2,700.00`
(₱ small beneath) — sliding in from the left edge, resting ~6 s, then leaving to the right. The
paying browser shows it from its own Mark Paid handler; every other Accounting screen hears it
over a Supabase Realtime **Broadcast** topic — and, since 2026-09-02 evening, also by **polling
the server** every 10 s, so a payment logged by a clerk on an older production build (Lenny on
prod while Kane ran localhost — the first live test showed nothing) still lands as a card. Remote
arrivals play the payment-confirmed chime. It is
visible on every tab, to every permission level, because it names no amount the viewer could
not already read on the Payment Dispatch tab. Shipped 2026-09-02 (Kane approved the brief the
same day: every tab, every permission; chime on remote screens).

## Key files

| Piece | File |
| --- | --- |
| Pure rules — event shape, `shouldAnnouncePaid`, amount parts, de-dupe + cap | `src/lib/payroll/dispatch-paid-toast.ts` (+ `.test.ts`) |
| Live half — local CustomEvent in, Broadcast out/in, timers, chime, lock reset | `src/hooks/useDispatchPaidToasts.ts` |
| The cards — fixed bottom-left stack, `motion/react` slide | `src/components/accounting/DispatchPaidToasts.tsx` |
| Announce point — after each successful `paid` POST leg | `src/components/payroll-clerk/PayrollDispatch.tsx` (`handleConfirmPaid`) |
| Poll route — watermark + PAID rows after `since`, same gate as the dispatch list | `app/api/payment-dispatches/recent-paid/route.ts` |
| Poll read — bounded, oldest-first, `truncated` continuation | `listRecentPaidDispatches` in `src/lib/supabase/payment-dispatches.ts` |
| Mount — beside `<Toaster>`, fed `dispatchLock.locked` | `src/App.tsx` |

## Broadcast, never `postgres_changes` — and on its OWN topic

The browser client is `anon` and `payment_dispatches` is RLS-protected, so a row-change
subscription never fires in the browser (the lesson already recorded in
[payment-dispatch.md](./payment-dispatch.md) §5.1.1). Delivery is therefore a Broadcast on topic
`payment-dispatch-paid`, event `paid`, published by the **paying browser's shell hook** after it
shows its own card.

The topic must stay its own. realtime-js `channel()` returns the **existing** channel for a
repeated topic, so publishing on the queue's `payment-dispatch-sync` would let this hook's
`removeChannel` tear down the queue's live sync (and vice versa). A test pins the topic away
from both `payment-dispatch-sync` and `payments-live`.

Broadcast alone was not enough — it only works while the **payer's** browser runs this code and
the receiver's socket is up. The first live test (Kane on localhost, Lenny paying from the
production build) showed nothing, because Lenny's build had nothing to send. Hence the poll below.

## The poll is the path that does not depend on the payer

While locked and the tab is visible, the hook calls `GET /api/payment-dispatches/recent-paid`
every 10 s and folds new PAID rows into the same stack (`foldRecentPaidRows`, pure + tested):

- **The server sets the watermark.** The first call carries no `since` and returns only the
  newest paid `created_at`; the client never compares its own clock to the database's, and a
  screen opened mid-cycle replays nothing. Every later call uses the returned `latest`.
- **Bounded, not paged — on purpose.** `RECENT_PAID_LIMIT = 50` rows per tick with a
  `truncated` flag; the client continues at once while the watermark moves. This is a rolling
  cursor read, so it satisfies the 1000-row rule without ever paging a whole cycle.
- **Own rows are skipped.** The paying browser already showed and chimed them from the local
  path; the poll must never mint a second card (`selfEmail` comes from the shell).
- **Stale rows only advance the watermark.** Older than 90 s by the server clock means history,
  not news — a tab hidden for an hour does not replay sixty payments on return.
- **Same gate as the dispatch list.** `requireRateVisibilityOrFeatureEdit("accounting",
  "payment_dispatch")` — the ONE gate every dispatch-queue read shares
  ([payment-dispatch.md](./payment-dispatch.md) §5.1, `authorize-feature.ts`). The Accounting
  shell admits only `accounting` and `admin`, both rate-visible, so "every permission in the
  shell" and this gate are the same set. A 401/403 stops the poll for that mount.

## Only a real `paid` row toasts

`shouldAnnouncePaid(status)` is `status === 'paid'`. Problem / Not Paid / Threshold are markers
that moved no money and never toast; an Undo is a delete and never toasts. A multi-cycle
arrears settle announces **one card per cleared leg**, which is why the stack caps at 4 and
drops the oldest.

De-dupe is by **dispatch row id** (`json.row.id` from the POST). The same payment can reach a
screen twice — locally and over the wire, or from a retried send — and must be one card. The
fallback key for a missing id keeps a toast from being swallowed but is unique per leg.

## The chime is asymmetric on purpose

The paying browser does **not** chime here — `MarkPaidDialog` already plays
`playPaymentConfirmed` on that confirm, and a second cue on the same click would read as a
double-fire. Remote screens **do** chime (Kane, Q2), staggered 160 ms like the CEO
"Being paid now" rail so a burst reads as a cascade, not a chord. A chime still queued when
the lock flips off or the shell unmounts is cancelled.

## Nothing shows while the lock is off

The stack is a processing-time surface. `locked=false` renders nothing, and the flip to
`false` clears cards, timers, queued chimes and the de-dupe memory, so the next processing run
starts fresh. The **broadcast** from the paying screen is unconditional — the receiver gates on
its own lock state, not the sender's.

## Its own stack, not sonner

Accounting's `<Toaster>` is top-right and teal by rule ([notification-alerts.md](./notification-alerts.md));
this card's placement and motion are the feature, so it is a fixed `bottom-4 left-4` stack of
its own (the `CarlaSongToast` precedent). Enter is `x −56 → 0` on a spring, exit `x 0 → +28`
with a fade; `useReducedMotion` collapses both to opacity at the same timing
(ui-standards §14.5). The amount follows the CEO rail: USD leads with ₱ beneath, a COP-only
payee leads with `$COP`.

## What looks like a bug but isn't

- **Two actor sources, one value.** Local and broadcast cards carry the paying browser's session
  email; polled cards carry `created_by`. `getSessionActor` lowercases `session.user.email`
  into `created_by`, so they agree. A missing actor reads `accounting`.
- **A remote card can lag up to 10 s.** That is the poll cadence when the payer's build cannot
  broadcast. Once every clerk is on a build with this code, Broadcast delivers instantly and
  the poll merely confirms.
- **The standalone `/payroll-clerk` shell shows nothing.** Kane did not answer Q3 in the brief,
  so it stayed out. Mounting `<DispatchPaidToasts>` there is one line if wanted.

## Deploy notes

**No migration.** One new read-only route (`/api/payment-dispatches/recent-paid`). No env var,
no n8n. Broadcast needs no publication membership.

**Rollout note:** the toast appears for a payment only when the VIEWER's build has this code.
The payer's build no longer matters — that is what the poll is for.
