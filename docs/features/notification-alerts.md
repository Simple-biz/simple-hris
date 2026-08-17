# Notification alerts — the live chime + toast that announces a new notification

Every dashboard has a Notifications panel and a sidebar unread badge. Separately,
some dashboards **announce** a new notification the moment it lands: a two-tone
bell plus a teal toast, top-right, driven by `useNotificationChime`. This doc
governs which dashboards announce, what each one is allowed to announce, and why
the alert must always be scoped to a single dashboard.

Accounting gained its alert on 2026-08-17 (it had never had one — the hook was
mounted on HR alone since it was written), and HR's alert was scoped in the same
change so money never rings there.

## Key files

| Piece | File |
| --- | --- |
| The hook — unread set → chime + toast | `src/hooks/useNotificationChime.ts` |
| The toast body (teal, single stable id, `+N` badge) | `src/components/notifications/NotificationToast.tsx` |
| Type → dashboard map + per-view exclusion | `src/lib/notifications/notification-views.ts` |
| The rules above, pinned | `src/lib/notifications/notification-views.test.ts` |
| Server-side view filter + feature gating | `app/api/employee-notifications/route.ts` |
| HR mount (`view: 'hr'`) | `src/components/hr/HrApp.tsx` |
| Accounting mount (`view: 'accounting'`) | `src/App.tsx` |
| Sidebar unread badge (already view-scoped) | `src/components/Sidebar.tsx` · `src/hooks/useEmployeeNotificationsUnread.ts` |

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
- **Only HR and Accounting announce.** Employee, Manager, CEO, QC, Orphanage and
  Admin have panels and badges but no chime. That is the current state, not an
  oversight to be closed casually — each new mount owes a `view` and a line in
  the table above.

## Deploy notes

**No migration.** No new notification type, no DDL, no env var, no n8n import.
Client-only: two mounts and an additive `opts.view` on the hook.

Cross-links: `docs/features/mesa.md` (money request routing) ·
`docs/features/urgent-payments.md` (the URGENT rail these alerts point at) ·
`docs/design/ui-standards.md` §10 (dialog/toast chrome).
