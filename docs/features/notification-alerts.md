# Notification alerts — the live chime + toast, and the panel's tiles and timestamp

Every dashboard has a Notifications panel and a sidebar unread badge. Separately,
some dashboards **announce** a new notification the moment it lands: a two-tone
bell plus a teal toast, top-right, driven by `useNotificationChime`. This doc
governs which dashboards announce, what each one is allowed to announce, and why
the alert must always be scoped to a single dashboard — and, since 2026-10-01,
what the panel's Unread / Need Action tiles count and how every card is stamped.

Accounting gained its alert on 2026-08-17 (it had never had one — the hook was
mounted on HR alone since it was written), and HR's alert was scoped in the same
change so money never rings there.

## Key files

| Piece | File |
| --- | --- |
| The hook — unread set → chime + toast | `src/hooks/useNotificationChime.ts` |
| The toast body (teal, single stable id, `+N` badge) | `src/components/notifications/NotificationToast.tsx` |
| "Just announced" page signal (`notification:arrived`) | `src/lib/notifications/notification-arrived.ts` (+ `.test.ts`) |
| Type → dashboard map + per-view exclusion | `src/lib/notifications/notification-views.ts` |
| The rules above, pinned | `src/lib/notifications/notification-views.test.ts` |
| Server-side view filter + feature gating | `app/api/employee-notifications/route.ts` |
| HR mount (`view: 'hr'`) | `src/components/hr/HrApp.tsx` |
| Accounting mount (`view: 'accounting'`) | `src/App.tsx` |
| Employee mount (`view: 'employee'`) | `src/components/employee/EmployeeApp.tsx` |
| Sidebar unread badge (already view-scoped) | `src/components/Sidebar.tsx` · `src/hooks/useEmployeeNotificationsUnread.ts` |
| The panel (every dashboard) — Unread / Need Action tiles, card stamps | `src/components/notifications/NotificationsPanel.tsx` |
| Need Action rule + `needsAction` per button | `src/lib/notifications/notification-actions.ts` (+ `.test.ts`) |
| The one notification timestamp format | `src/lib/notifications/notification-timestamp.ts` (+ `.test.ts`) |

## Every mount passes a `view`. Never add an unscoped one.

`GET /api/employee-notifications` treats an **absent** `view` as *every type this
viewer may see* — that is deliberate, because the count/badge hooks bucket per
view themselves. It makes an unscoped alert wrong on any account holding two
roles: the notification is fetched, so it chimes and toasts, on a dashboard whose
own panel correctly hides it.

That is not hypothetical. It is the bug this doc exists for: **HR heard about
money.** Bank-detail changes fan out to `admin` / `accounting` / `ceo` role
holders only — `notifyReviewers` in `app/api/bank-update/save/route.ts` and both
fan-outs in `app/api/update-employee-ids/route.ts` — and
`people.banking.self_updated` is mapped away from HR. An HR coordinator who also
held accounting or ceo was nonetheless a legitimate *recipient*, so while the HR
panel hid the row, the unscoped chime rang it on the HR dashboard.

So: a dashboard announces its **own** notifications, matching its badge and its
panel, or it does not announce. Adding `useNotificationChime(email)` with no
second argument reopens the leak silently — nothing fails, a payout change simply
starts ringing somewhere it shouldn't.

## The money rule is enforced in the map, not in the alert

Keeping money off HR is one line — `people.banking.self_updated` is mapped to
`['accounting', 'admin', 'ceo']` — and the scoped fetch is what makes that line
bite the alert as well as the panel. A test pins both halves: money is hidden
from the HR view, **and** still reaches Accounting. Tightening HR must never cost
Accounting the alert it is the reviewer for.

The same test refuses any *future* type matching `people.banking.*`,
`bank_preferred.*` or `bank_info.*` that is mapped to `hr`. If a money flow needs
an HR-visible notification, that is a decision to make out loud and re-document
here — not a map edit.

## The high-water mark is per (email, view)

The hook rings each notification at most once, using a `localStorage` mark of the
newest `created_at` already alerted, plus a session id-set. With two dashboards
alerting the same person, that mark **must not be shared**: each reads a
different slice of one unread set, so a notification alerted on Accounting would
push the mark past an older HR notification that never rang — silencing it
forever, with no error anywhere.

Hence `notif-chime-hw:<email>:<view>`. The legacy unscoped key
`notif-chime-hw:<email>` is still read as a fallback when the scoped key is
absent, so introducing the scope did not re-ring everyone's existing backlog on
first load. Leave that fallback in place; removing it costs every user one
replayed alert.

## The alert tells the page what it announced (2026-09-29)

Each time the hook announces a batch it also dispatches `notification:arrived` on
`window`, detail `{ view, types }` — the types of exactly the rows it just toasted.
A surface showing the number a notification is about subscribes with
`subscribeNotificationTypes([...types], refetch)` and refetches **on the toast**,
instead of on a timer of its own that drifts up to 30s from the chime's. The first
subscribers are the Employee Overview's KPI Bonus card and the KPI Results tab
(`kpi-scored-notification.md` § The figure moves with the toast).

It fires only for what this tab actually announced, so it inherits the rules above:
the view scope decides which types can appear, and the shared high-water mark means a
second browser tab that did not toast does not hear it either — a subscriber still
owes its own focus/poll refresh. It is a hint to refetch, never data: subscribers read
nothing from the detail but the type.

## The panel: two tiles and one timestamp, on every dashboard (2026-10-01)

Kane: *"add a KPI Card in here for 'Unread, Need Action' also make sure every
notification has a time stamp for the date in this format - April 5, 1999 : 8:00
AM EST - in all dashboards"*. One shared `NotificationsPanel` is the Notifications
tab on Accounting, Admin, CEO, Employee, HR, Manager, Orphanage, QC and Payment
Dispatch, so both reach every dashboard at once.

**Unread is counted by the server, never from the list.** The panel asks
`GET /api/employee-notifications?…&counts=1`, which returns `counts: { total,
unread }` from two exact count queries with the **same** recipient + type scope as
the list (one `scoped()` builder, so they cannot drift). The list itself stops at
PostgREST's 1000 rows, and heavy recipients are far past that — **measured
2026-10-01: 241,822 rows over 1,760 recipients, the top eight at 12,359–14,353
each, one with 14,244 unread.** A count taken from the list reads "1,000" for
them. When the list is capped the pager says *"newest 1,000 of N shown"*. The
list is **not** paged to N: that would ship ~14k rows on every poll (item 305).

**Unread means unread when this visit opened.** The panel marks what it shows
read 2s after display but keeps it highlighted for the visit; the tile is the
count fetched with that list, so it agrees with the "New" pills on screen.
Deleting a card adjusts both figures; Clear all refetches, because a capped list
can have more behind it. The payroll-lock banner is not counted — it is a live
state, not a row (the header's "N active" pill still counts it, as before).

**Need Action counts things waiting on the viewer, once each**
(`notificationNeedsAction` / `countNeedAction`, pinned by the test):

- The card's button must **ask for an action**. `needsAction` is a **required**
  field on every resolver, so a new one decides out loud: onboarding review,
  offboarding review, ticket reply and ticket assignment count; a ticket's column
  move is news and does not.
- An offboarding request whose queue rows are known goes **by the queue** —
  still pending counts even after it was read, already actioned never counts.
  Everything else goes by `read_at`, the only "handled" signal the HRIS has.
- **One submission, ticket or request counts once**, however many notifications
  point at it. Not hypothetical: one HR account held 11,573
  `onboarding.submitted` rows for 1,328 submissions, up to 49 per submission
  (item 305).
- It counts the loaded list (never a search result or a page), and says *"in the
  newest 1,000"* when that list is capped.

Only HR and Employee have actionable types today, so Need Action reads 0 on every
other dashboard. That is the true answer, not a gap — a dashboard gains it when a
resolver is added for its view.

**A failed read is a dash, never a 0.** No count → `—`; a failed first list read
→ *"Couldn't load notifications"* instead of *"All caught up"*. A failed count
keeps the last good one. The route's HTTP-200 body that carries `error` beside an
empty list is treated as the failure it is (it used to blank the list).

**Every card is stamped `April 5, 1999 : 8:00 AM EST`** (`formatNotificationTimestamp`).
The clock is Eastern wall time through `America/New_York` — DST-aware, **never a
fixed -05:00**, the rule `src/lib/support/hours.ts` set when Kane confirmed its
"9 AM – 5 PM EST" *as written*. The label is the literal `EST` year-round,
exactly as given; from March to November the clock is daylight time. A fixed
offset would put every summer stamp an hour behind the wall clock. The card's
stamp is `details.submitted_at` when it parses, else `created_at` (filled on
every insert), so no card goes unstamped. The lock banner and the *"Already
offboarded by … ·"* line use the same format. It replaced the relative "3h ago" /
"Sep 29". The live toast carries no stamp — it announces *now*.

## HR's gift alert is scoped by GRANT, not by the map alone (2026-09-22)

`gift_shipping.submitted` maps to `['hr']` — somebody filled in or updated their
tenure-gift delivery details, through the public link, their Employee dashboard
card, or a staff entry. One type for all three: same news, same readers, and the
surface is a detail on the row rather than a different notification.

The map is the **view** scope. The **recipient** list is narrower still, and the
two do different jobs. Kane's ruling was *"HR Dashboard people with HR - Gift
Tracker Access"*, so `resolveGiftTrackerRecipients`
(`src/lib/notifications/gift-shipping-submitted.ts`) resolves holders of the
`hr / gift_tracker` feature permission above `hidden`, unions the admins — who
pass `requireFeatureAccess` with no grant row — and folds aliases onto the master
row's primary work email so one human is one bell.

**This is the first fan-out here keyed on a feature permission rather than a
role.** Every other HR flow calls `recipientsForRoles(['hr_coordinator',
'admin'])`. Copying that would have rung for coordinators who cannot open the
Gift Tracker and stayed silent for the delegated people who can. Mapping to
`['hr']` on top of that keeps the chime, the badge and the panel agreeing for the
people who do receive it.

It is not money, so it does not trip the rule above — and a test pins that it
reaches the HR dashboard and **no other**.

## What looks like a bug but isn't

- **The toast is teal on Accounting too.** It is the shared
  `renderNotificationToast`; teal is also the Accounting palette, so it was left
  alone rather than forked per dashboard.
- **The chime can be silent while the toast shows.** Browser autoplay policy
  blocks audio until the first user gesture; the hook flags the sound pending and
  flushes it on the next `pointerdown`/`keydown`. A toast with no bell on a
  freshly-loaded tab is the policy, not a fault.
- **Unmapped types announce everywhere.** `hiddenTypesForView` only ever lists
  *mapped* types, so a new flow that forgets its mapping degrades to visible-and-
  audible on every dashboard rather than vanishing. Prefer that failure
  direction; do not "fix" it by defaulting unmapped types to hidden.
- **Only HR, Accounting and Employee announce.** Manager, CEO, QC, Orphanage and
  Admin have panels and badges but no chime. That is the current state, not an
  oversight to be closed casually — each new mount owes a `view` and a line in
  the table above. The Employee mount (2026-08-17, Kane's call with the
  `kpi.scored` feature — see `kpi-scored-notification.md`) announces **every**
  employee-view type, keyed on the VIEWED identity so it always matches the
  panel beside it.

## Deploy notes

The 2026-08-17 scoping change was **client-only**: two mounts and an additive
`opts.view` on the hook. No migration, no env var, no n8n import.

**PENDING (2026-09-22):** `gift_shipping.submitted` needs
`references/sql/alter/2026-09-22_add_gift_shipping_notification_type.sql` applied
before it can deliver anything — `employee_notifications.type` is
CHECK-constrained, and a rejected insert is indistinguishable from "nothing
happened". Every failure is written to `audit_log` as
`notification.insert_failed`, so the silence is at least visible. Stays PENDING
until Kane confirms it landed. **Measured 2026-09-25 (read-only): present in
`employee_notifications_type_check`, which now allows 49 types.** It was still
rejecting at 09:27Z that day (session log 2026-09-25, item 211).

Cross-links: `docs/features/mesa.md` (money request routing) ·
`docs/features/urgent-payments.md` (the URGENT rail these alerts point at) ·
`docs/design/ui-standards.md` §10 (dialog/toast chrome).
