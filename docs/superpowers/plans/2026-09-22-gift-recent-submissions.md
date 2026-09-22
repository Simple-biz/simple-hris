# Gift Tracker → "Recently filled / updated" + the HR submission alert

**STATUS: APPROVED BY KANE 2026-09-22.** Four questions asked and answered, then a CONFLICT
posted and resolved with (a). This plan is written against brief revision 2.

A fourth Gift Tracker sub-tab that lists gift-address submissions newest-first, whichever surface
they came from, so the team can see who is actually using the link — plus an in-app notification
to the people who hold HR → Gift Tracker access the moment one lands.

## What Kane ruled

| Q | Ruling | Consequence for the build |
|---|---|---|
| 1 | Recommendation → sub-tab | A 4th `SubTab` inside `GiftTracker.tsx`. No `HrSidebar`, `view-tabs.ts`, `visibility.ts` or RBAC change. |
| 2 | *"either from HRIS or the external link same way someone we catch from the update bank information"* | BOTH channels. **This widened scope** — the in-app `PUT /api/employee-gift-shipping` notifies and broadcasts too, not just the public save. |
| 3 | Recommendation + *"realtime"* | One notification per submission, per-event like every other type here. Live via Broadcast. |
| 4 | *"HR Dashboard people with HR - Gift Tracker Access"* | Recipients resolved from `employee_feature_permissions` (`feature='gift_tracker'`, `view_key='hr'`, access above `hidden`) ∪ admins — **not** `recipientsForRoles`. Type maps to `['hr']`. |
| CONFLICT | (a) — memory stands | `broadcastFromServer` + a poll floor. NOT the `app_settings` + `postgres_changes` pulse the bank feed uses. |

## The conflict, and why (a) was the right call

`PeopleBankChanges.tsx:155` claims *"app_settings reliably reaches the anon client over
Realtime"* and binds `postgres_changes` to a pulse key. `memory/supabase-realtime-anon-rls-dead`
— verified against the live catalog on 2026-09-02 — says `app_settings` has RLS on with one
"Admins only" policy, so **anon receives nothing**; `realtime-broadcast.ts:6-12` states the same
finding independently.

Both cannot be true. The measured one wins, which means the Bank changes feed is very likely
running on its poll + focus fallback today and its pulse channel is decorative. **That is not
fixed here** and it is not measured here — it is recorded as an Open item so it is not lost.

The gift tab therefore does not inherit that channel. It broadcasts from the routes that write,
the way Employee Support and FPU already do.

## Three rules this build must not break

1. **The notification type is CHECK-constrained.** Deploying before the DDL runs makes every
   insert fail in a way that is *indistinguishable from nobody having submitted*. `kpi.scored`
   was dead three days and `pab.*` seventeen for exactly this reason. Every insert failure goes
   through `recordNotifyFailure` so the silence is visible in `audit_log`.
2. **The channel is read, never inferred.** `audit_log` already carries it —
   `gift_address.saved` stamps `channel: 'external_link'`, `employee_gift_shipping.submitted`
   stamps `employee_self` or `staff`. A row whose channel cannot be resolved renders
   **Unknown source**, never a guess.
3. **Nobody is dropped.** Off-roster submitters and the ~11 people refused by the
   `(personal_email, milestone_index)` key are the likeliest mis-ships. They appear in the feed
   flagged, exactly as the export already treats them.

## Tasks

- [ ] 1. `references/sql/alter/2026-09-22_add_gift_shipping_notification_type.sql` — widen the
      `employee_notifications_type_check` to allow `gift_shipping.submitted`, copying the
      self-widening `do $widen$` shape from `2026-09-19_add_chat_notification_types.sql` verbatim
      (reads the live constraint, unions, can only widen, raises on a missing or reshaped one).
- [ ] 2. `src/lib/gift-tracker/gift-live.ts` — Broadcast topic + event + poll floor constants,
      own topic, browser-safe. Modeled on `src/lib/mesa/fpu-live.ts`.
- [ ] 3. `src/lib/gift-tracker/recent-submissions.ts` + `.test.ts` — pure. Orders submissions by
      `updated_at` desc, classifies **filled** vs **updated** from `created_at` vs `updated_at`,
      folds the audit channel in by `(work email, milestone)`, flags off-roster, never guesses a
      channel.
- [ ] 4. `app/api/gift-tracker/recent-submissions/route.ts` —
      `requireFeatureAccess('hr','gift_tracker','view')`, paged reads on both tables, the
      audit window bounded.
- [ ] 5. `src/lib/notifications/gift-shipping-submitted.ts` + `.test.ts` — recipient resolution
      (feature-permission holders ∪ admins, roster-bridged across all four email columns, like
      `listTicketMembers`), the insert, and `recordNotifyFailure` on rejection.
- [ ] 6. `src/lib/notifications/notification-views.ts` + test — map `gift_shipping.submitted` to
      `['hr']`.
- [ ] 7. Call it from `app/api/gift-address/save/route.ts` (+ broadcast).
- [ ] 8. Call it from `app/api/employee-gift-shipping/route.ts` PUT (+ broadcast).
- [ ] 9. `src/hooks/useGiftShippingLive.ts` — Broadcast + poll floor + focus, modeled on
      `useFpuLive.ts`, returning the honest channel state.
- [ ] 10. `src/components/orphanage/GiftTracker.tsx` — `SubTab` gains `'recent'`, `SUB_TAB_ORDER`,
      a `SubTabButton`, and the panel.
- [ ] 11. `npx tsc --noEmit` + `npm test`.
- [ ] 12. Docs: `gift-address-external-link.md`, `notification-alerts.md`, INDEX row 39,
      `api-reference.md`, memory + `MEMORY.md` pointer, Open items for the DDL and the bank-pulse
      finding. One commit, staged by explicit path.

## Deploy notes

**PENDING Kane's `--apply`:** task 1's DDL. Until it runs, every `gift_shipping.submitted` insert
is rejected by the CHECK and the alert delivers nothing — `audit_log` will carry a
`notification.insert_failed` row per attempt, which is how you will know.
