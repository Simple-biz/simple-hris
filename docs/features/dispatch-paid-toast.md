# Payment Dispatch "paid" toast — lower-left cards on every dashboard while processing is on

While the global dispatch lock is ON, every open dashboard shows one card in the lower-left per
**Paid** dispatch row — `lenny@simple.biz paid kaner@simple.biz  $2,700.00`
(₱ small beneath) — sliding in from the left edge, resting ~6 s, then leaving to the right. The
paying browser shows it from its own Mark Paid handler; every other Accounting screen hears it
over a Supabase Realtime **Broadcast** topic — and, since 2026-09-02 evening, also by **polling
the server** every 10 s, so a payment logged by a clerk on an older production build (Lenny on
prod while Kane ran localhost — the first live test showed nothing) still lands as a card. Remote
arrivals play the payment-confirmed chime. Since the same evening it is mounted from the **root
layout**, so it shows on EVERY dashboard — Accounting, Admin, CEO, HR, Manager, Orphanage, QC,
Payroll Clerk, Employee — to anyone holding **Accounting → Payment Dispatch VIEW access** (or
admin). Kane's rulings, all 2026-09-02: every tab; chime on remote screens; "elevated users
should see this on every dashboard if they have Accounting View access, not Edit".

## Key files

| Piece | File |
| --- | --- |
| Pure rules — event shape, `shouldAnnouncePaid`, amount parts, de-dupe + cap | `src/lib/payroll/dispatch-paid-toast.ts` (+ `.test.ts`) |
| Live half — local CustomEvent in, Broadcast out/in, timers, chime, lock reset | `src/hooks/useDispatchPaidToasts.ts` |
| The cards — fixed bottom-left stack, `motion/react` slide | `src/components/accounting/DispatchPaidToasts.tsx` |
| Announce point — after each successful `paid` POST leg | `src/components/payroll-clerk/PayrollDispatch.tsx` (`handleConfirmPaid`) |
| Poll route — watermark + PAID rows after `since`, same gate as the dispatch list | `app/api/payment-dispatches/recent-paid/route.ts` |
| Poll read — bounded, oldest-first, `truncated` continuation | `listRecentPaidDispatches` in `src/lib/supabase/payment-dispatches.ts` |
| Server-side Broadcast (REST) — fires from the route that wrote the row | `src/lib/supabase/realtime-broadcast.ts` · `app/api/payment-dispatches/route.ts` · `.../undo/route.ts` |
| Table sync — remote paid ⇒ row hidden at the render boundary | `PAID_TOAST_REMOTE_EVENT`, `remotePaidHidesRow`, `hidePaidElsewhere` · `PayrollDispatch.tsx` (`paidElsewhere`) |
| Mount — root layout, every dashboard; runs only with a signed-in session | `src/components/common/DispatchPaidToastsGlobal.tsx` · `app/layout.tsx` |

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

Broadcast from the **browser** alone was not enough — it only works while the payer's browser
runs this code. The first live test (Kane on localhost, Lenny paying from the production build)
showed nothing, because Lenny's build had nothing to send. Two fixes stack: the poll below
(the floor), and, since the same night, the **server broadcasts** too.

## The server broadcasts the moment it writes the row

`POST /api/payment-dispatches` sends two Broadcasts right after the INSERT succeeds, through
`broadcastFromServer` (service-role client, REST delivery — `channel.httpSend`, no socket):

| Topic | Event | Who reacts |
| --- | --- | --- |
| `payment-dispatch-sync` | `queue-changed` `{ sourceFile, ts }` | every open Payment Dispatch table reloads its queue (its existing listener) |
| `payment-dispatch-paid` | `paid` (the toast event) | every dashboard's toast stack — only when `status === 'paid'` |

`POST /api/payment-dispatches/undo` sends `queue-changed` only, once per cycle touched. An Undo
is a delete, never a toast.

Why this is the fix and not the browser broadcast: the live catalog (checked 2026-09-02) has
`payment_dispatches` under RLS with **zero policies** and `app_settings` under "Admins only", so
`postgres_changes` can never deliver to the anon browser. Broadcast is a bus, not a table — a
message posted by the server reaches every subscriber regardless of who paid or on which build.
The browser still re-broadcasts its own payment (a second chance if the server's REST call
fails); de-dupe by row id makes the pair one card. A payer therefore hears its **own** payment
back over the wire — remote events whose actor is the viewer are dropped, so the payer never
gets a second card or a chime for their own click.

## The table never lags the toast

The moment a remote paid event is accepted, the hook fires `hris:dispatch-paid-remote` on the
document. `PayrollDispatch` listens: if the event's cycle matches the table's (or either is
unknown), the recipient goes into a `paidElsewhere` overlay and is filtered out of
`mainPending` / `copPending` **at the render boundary**. The overlay is cleared whenever a
reload lands (`fetched` changes), so the server's rows are the truth again within seconds.

`pending` itself is **never** touched by this path. It feeds `isCycleFullyPaid`, and emptying
it ahead of the server is exactly the 2026-08-18 false-100% celebration
([cycle-closeout.md](./cycle-closeout.md), memory `payment-cycle-complete-celebration`). The
hero Pending count and the progress strip therefore lag the visual removal by one reload; that
lag is the safety margin, not a bug.

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
- **The gate is "Accounting VIEW access".** `requireFeatureAccess("accounting",
  "payment_dispatch", "view")` — a view-or-better grant on the Accounting dashboard's Payment
  Dispatch tab, the same gate as the other view-level dispatch reads (paystub, arrears,
  orphanage-dispatches). Admin bypasses. A missing grant is 403 (`rbac-feature-permissions.md`
  default-deny), and that answer is how the client learns it is not authorized.

## Who sees it is the server's verdict, on every dashboard

`DispatchPaidToastsGlobal` sits in `app/layout.tsx` beside `CarlaSongToast`, so it survives
dashboard switches and renders on all of them. It refuses to run without a signed-in session
(public pages never probe or subscribe). Beyond that, **no client-side RBAC copy exists**: the
hook's first poll after the lock turns on is the authorization probe — 200 lets remote cards
(broadcast and poll) render, 401/403 stops the poll and nothing remote ever renders on that
document. The local path (the payer's own Mark Paid) is never gated here; a browser whose paid
POST was just accepted is authorized by construction.

Consequences to know:

- A person whose Payment Dispatch tab an admin set to **hidden** sees no toast anywhere, even
  with the `accounting` role. That is Kane's rule applied literally — the grant decides, not
  the role. (The earlier gate, rate-visible-OR-edit, would have admitted them; it was replaced,
  not loosened.)
- A grant changed mid-run takes effect on the next lock cycle — the verdict is cached per
  processing run and cleared when the lock flips off.
- Mounting `<DispatchPaidToasts>` anywhere else would create a second instance with its own
  de-dupe memory and double every card. The Accounting shell's own mount was removed for that
  reason; the root layout is the only one.

## The pending CSV and Stop Processing read the same overlay

Kane asked (2026-09-02) whether the **Export CSV** and **Stop Processing** stay accurate now
that a remotely paid person vanishes from the table before the reload. Both read what the
screen shows:

- **Export CSV** (`ProcessorQueue`) builds from `filtered`, whose source is `visibleRows` →
  `mainPending`, which already carries the `paidElsewhere` overlay. The file matches the table
  row-for-row; a person paid elsewhere leaves both at the same instant. Its residual window is
  the delivery window itself: a payment whose broadcast and poll have not landed yet (normally
  under a second, at most 10 s) is still in the file, exactly as it is still on screen.
- **Stop Processing** — the Stop dialog's "with N unpaid people", the close-out POST body and
  the client-built premature snapshot all come from `unpaidPayable`, which now iterates the
  same overlaid rows. And the **server prunes again** against its own paid rows
  (`unpaid.reconciledPaid`, [cycle-closeout.md](./cycle-closeout.md)), so even a screen with no
  overlay at all cannot file a paid person as unpaid.

`pending` itself is untouched by both; the hero Pending count and the celebration gate still
move only when a reload lands.

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
- **A remote card can still lag up to 10 s** — only when the server's REST broadcast failed AND
  the payer's browser could not broadcast. Normally the server's message lands within a second
  of the INSERT, whatever build the payer runs; the poll is the floor.
- **The hero Pending count moves a beat after the row disappears.** The row is hidden at the
  render boundary; the count comes from `pending`, which only the reload may change.
- **An employee-only user never sees it, even during processing.** They have no Accounting
  grant, so the probe returns 403 and the stack stays empty. That is the gate working.

## Deploy notes

**No migration.** One new read-only route (`/api/payment-dispatches/recent-paid`). No env var,
no n8n. Broadcast needs no publication membership.

**Rollout note:** the toast appears for a payment only when the VIEWER's build has this code.
The payer's build no longer matters — that is what the poll is for. Visibility for a given
person is an Admin → Roles decision (Accounting → Payment Dispatch at View or Edit), not a code
change.
