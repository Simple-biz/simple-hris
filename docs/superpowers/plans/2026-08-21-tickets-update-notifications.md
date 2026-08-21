# Tickets board — update + status-move notifications

Requested by Kane 2026-08-21. A ticket today emails on three things only:
created (to the board owner), assigned (to the dev) and done (to the creator).
So a requester who files a ticket hears **nothing** between filing it and it
shipping. Two new n8n hooks close that gap.

Blueprint brief approved 2026-08-21 with all three questions answered:

- **Q1** a status move emails the **ticket creator only** — the dev is usually
  the one moving the card, so mailing them their own move is noise.
- **Q2** a comment emails the **counterparty**: the creator, or the assigned dev
  when the creator is the one who typed it. This is byte-for-byte the rule the
  in-app `ticket.replied` leg already implements, so the two legs can never
  disagree.
- **Q3** **any** move is emailed, including a backward `testing → in_progress`
  bounce. So there is no status allowlist: status changed → email the creator,
  with `done` still riding the existing `notifyTicketDone`.

Estimated 5 SP. Monday row: `[HRIS] Tickets board notifies the requester on
every update — comment emails and status-move emails`, epic HRIS-17, Sprint 27.

## Tasks

- [ ] 1. `references/sql/alter/2026-08-21_add_ticket_moved_notification_type.sql`
      — widen `employee_notifications_type_check` to allow `ticket.moved`,
      restating the FULL 47-type list verbatim. A subset silently breaks every
      other type's INSERT.
- [ ] 2. `scripts/apply-ticket-moved-notification-type.mjs` — `pg` DDL runner
      with the superset guard (abort if the LIVE constraint allows a type our
      file lacks) and a `--verify` mode. Kane runs it.
- [ ] 3. `src/lib/tickets/recipients.ts` + `recipients.test.ts` — pure:
      `commentEmailRecipient()` and `moveEmailRecipient()`. `node:test`.
- [ ] 4. `src/lib/tickets/notify.ts` — `notifyTicketReplied` (slug
      `ticket_replied`) and `notifyTicketMoved` (slug `ticket_moved`), both
      copied from `notifyTicketDone`: resolve-or-no-op, `void`, 10s timeout,
      never throw, recipient decided here via `send_to`.
- [ ] 5. `references/n8n/ticket-replied-email.workflow.json` +
      `ticket-moved-email.workflow.json` — copies of
      `ticket-done-email.workflow.json`.
- [ ] 6. `src/components/admin/AdminWebhooks.tsx` + `src/lib/webhooks/sample-payloads.ts`
      — register both slugs so they are configurable and testable from Admin.
- [ ] 7. `notification-views.ts` + `notification-actions.ts` +
      `NotificationsPanel.tsx` — map the new `ticket.moved` in-app type.
- [ ] 8. `app/api/tickets/[id]/comments/route.ts` — fire the email leg beside
      the in-app leg that already ships.
- [ ] 9. `app/api/tickets/[id]/route.ts` — on any status transition: email the
      creator + write the in-app `ticket.moved`, `done` unchanged.
- [ ] 10. Typecheck (check for a live `next dev` first — shared `.next/`).
- [ ] 11. Docs: `docs/features/tickets-board.md` § Notifications as a rule
       table, `INDEX.md:31` memory cell, `memory/tickets-update-notifications.md`
       + its `MEMORY.md` pointer. All in the same commit as the code.

## Deploy (Kane's, both PENDING until confirmed)

1. `node scripts/apply-ticket-moved-notification-type.mjs` — until this runs,
   every `ticket.moved` insert is rejected and the failure is swallowed. This is
   exactly how `kpi.scored` was dead for three days.
2. Import both n8n workflows, then paste their webhook URLs into
   Admin → Webhooks under `ticket_replied` / `ticket_moved`. Until then both
   hooks no-op silently — by design.
