# Employee Support — the staff Kanban

**STATUS: APPROVED BY KANE 2026-09-21. Scope narrowed to the STAFF board.**

The chat already mints `ES-` tickets when a conversation goes unanswered, tells the employee
*"someone will reply within one working day"*, and files them in a table **no surface in the app
can open**. This build is the surface. It is the smallest thing that makes a promise already being
made to employees a promise the company can keep.

**Not in this build:** the employee filing form, ticket history and track map. They are real and
they are next — and they carry the staff-only trial gate question with them, because that gate is
about the employee's button, which does not exist yet.

> **RULED 2026-09-21, and it shapes the NEXT build rather than this one.** Kane: *"Instead of Chat
> change that to **Help** where they can choose between a Chat Support or a Ticket."* So the
> employee entry point beside FAQs becomes **Help**, opening a chooser with two doors — *Chat
> Support* and *Raise a ticket*.
>
> **It cannot ship before the ticket door exists.** There is no filing form, no employee route and
> no history today, so a chooser built now would offer a door that leads nowhere. It is therefore
> the shape of the employee-side build that follows this one, not a rename of
> `EmployeeSupportChat` to be done in passing.
>
> Two consequences to carry forward. The chooser is the natural home for the **track map** (his
> 2026-09-18 ruling) — one place that answers "what did I ask, and where has it got to", across
> both doors. And it is where the **staff-only trial gate** Carla signed finally has something to
> gate: *"You and the support team try it before any employee sees it"* applies to the Help button,
> which is the single thing an employee sees.

> **ALSO RULED 2026-09-21.** Kane: *"The chat support option should ask the Employees what issue is
> it about if it is about salary or COE or anything related to Accounting and HR."*
>
> **Ask the category when they enter the chat queue.** The vocabulary already exists —
> `SUPPORT_CATEGORIES` (`src/lib/support/types.ts:27-37`) ships the nine Carla approved, and his
> examples land on them: salary → `pay_payslip`, COE → `documents_certificates`. Reusing it means
> chat and tickets speak one language rather than two.
>
> **It closes a real loss.** A converted chat is currently filed as `CHAT_TICKET_CATEGORY = 'other'`
> (`abandonment.ts`) because the session never knew its subject. With a category on the session the
> ticket **inherits the real one**, which is also what makes it sortable and routable on the board.
>
> **SEPARATE THE TWO THINGS IN HIS SENTENCE.** *What it is about* is a category and is in scope.
> *"Anything related to Accounting and HR"* is **who answers it** — agent specialisation, which he
> deferred himself on 2026-09-18 (*"another topic and meeting I have for Carla so standby"*) and
> which Q4 currently answers as ONE GLOBAL QUEUE, every agent qualified for everything. So: capture
> the category, group it by team in the COPY, and do not route on it until that meeting happens.
> Capturing it now is what makes the routing cheap later.
>
> **Mechanically:** `employee_support_chat_sessions` has no `category` column. Nothing has been
> applied yet, so this is a clean additive ALTER beside the triage one — same launcher, same
> transaction. It must be NULLABLE or default to `other`: every session that exists before it ships
> has no category, and a NOT NULL with no default would fail the migration.

---

## What is already decided

| Source | Ruling |
|---|---|
| Carla, signed 2026-09-15 | Five named answerers · reply **within one working day** (displayed, not enforced) · **no per-day cap** · **no attachments** · leaver access ends the day they leave · *"One screen listing every question, showing name, work email, the concern and the ticket number"* · **sorted longest-waiting unanswered first, not newest** · *"Counts at a glance: how many need a reply, how many were answered today"* · *"Either side can reply again. Nothing is deleted — closed questions stay readable by both."* |
| Kane, 2026-09-18 | **Close a ticket** · **urgency ranking** · a **queueing line feeding a board** · **auto-claim on first touch, with handoff** · response-time KPIs **deferred** |
| Kane, 2026-09-21 | **Q1 / N3 RESOLVED.** Carla's *"shouldn't be able to request an adjustment through the support channels"* means the **existing time-adjustment feature** — she was saying *do not build a second intake for something that already has one*, not *refuse the ticket*. `routing.ts` steering people to My Hours is therefore correct as shipped and needs no guard. **This closes N3; it does not need to go back to her.** |

**Carried, reversible, not ruled:** one new tab with the line and the board as sections inside it
(so the counts span both) · within an urgency band, longest-waiting first, dated from filing · a
"touch" that auto-claims is the first **action**, never a read.

## What governs it

- `docs/features/employee-support.md` — the governing doc. Its "What is not built" section is this
  scope, and it gets rewritten by this work.
- `docs/features/employee-support-chat.md` — the sibling that mints the tickets. **Read its sweep
  section**: the conversion writes a concern prefixed `[ESC-nnnn]`, and the board must treat those
  as ordinary tickets, not a separate kind of row.
- `docs/features/INDEX.md:42` — **"Never add a cron."** Anything with a lifetime expires lazily on
  read.
- `references/sql/create/2026-09-16_employee_support.sql` — the shipped table. It already carries
  `status`, `claimed_by`/`claimed_at`, `first_response_at`, `closed_by`/`closed_at`, `flagged_at`,
  and both-or-neither CHECKs on every pair. **Only the triage columns are missing.**

## The precedent

The chat build, three weeks old, is the closest cousin and most of this is a second instance of it:

| Piece | Copy from |
|---|---|
| The tab, its host wiring, the Live/Polling pill | `src/components/tickets/SupportChatTab.tsx` |
| Claim as compare-and-set, 409 on a lost race | `app/api/support/chat/queue/route.ts` |
| Ordering + the resolved/unknown split | `src/lib/support/queue.ts` |
| The vocabulary-module shape | `src/lib/support/chat-types.ts` |
| Reply gated at **view**, not edit | `app/api/tickets/[id]/comments/route.ts:43-46` |

`ticketsHostAccess()` in `src/lib/rbac/view-tabs.ts` **already** handles a second support tab — it
returns every granted support tab and lands on the first. Adding one is a catalog entry and a nav
row, not a new gate.

## Invariants

- **The line is the default view, never a drawer.** An unranked ticket that nobody triages never
  reaches the board. Starvation is the failure mode; hiding the line is how it happens.
- **The counts span BOTH stages.** Carla signed *"one screen listing every question"*. A line plus a
  board is two lists, so a count scoped to one of them hides work.
- **`priority IS NULL` means "in the line"** — one column carrying the stage, with
  `triaged_at`/`triaged_by` moving as a set under a both-or-neither CHECK.
- **The four values are shared with the dev board; the column is not.** `public.tickets.priority`
  is `not null default 'medium'`. **Never widen `TICKET_PRIORITIES` or `TICKET_PRIORITY_LABELS`** to
  admit a null or a fifth value — the support side carries its own nullability.
- **The claim is a compare-and-set on NULL; the handoff is a compare-and-set on the CURRENT
  holder.** Two guarded UPDATEs, never one loosened one. A lost race is a 409 the UI re-reads from.
- **A "touch" is the first ACTION** — rank, reply, or explicit claim. Never a read, or browsing the
  line claims everything scrolled past.
- **Closing hides nothing.** Carla signed *"Nothing is deleted — closed questions stay readable by
  both"*, so a closed ticket stays in the record and a reply to one has a defined outcome.
- **Every set-materialising read pages.** PostgREST caps at 1000 rows with no error.
- **Realtime carries a signal, never content.** Broadcast that ticket N changed; re-fetch through
  the gated route.
- **Converted chats are ordinary tickets.** The `[ESC-nnnn]` marker in `concern` is provenance, not
  a type.

## Tasks

- [x] 1. `references/sql/alter/2026-09-21_employee_support_triage.sql` — `priority` (nullable,
      the four `TICKET_PRIORITIES` values), `triaged_at`, `triaged_by`. Two CHECKs, both on new
      columns only, so no existing row can violate one and the validating scan runs against a small
      table. **Must not DROP and re-add an existing CHECK** — the FPU migration once did that
      unconditionally and would have stripped a value on re-run.
- [x] 2. `references/sql/alter/2026-09-21_support_notification_types.sql` — plan task 3, which has
      never had a file. Restates the **FULL** `employee_notifications` type list plus
      `support.replied` / `support.answered`. **The chat's two types are already in that
      constraint**, so a flat restatement from an older file would strip them — additive shape, the
      same as the chat widen, and re-read live before `--apply`.
- [x] 3. Folded into `scripts/apply-employee-support-chat-migration.mts` rather than its own script
      (a deliberate deviation from "a `.cmd` launcher" above) — that launcher already ran the
      2026-09-19 chat files, and Kane has both `.cmd`s memorized; a third launcher for two more
      files was one more thing to remember to run. Applied and verified 2026-09-21, 171 checks OK.
- [x] 4. `src/lib/support/triage.ts` (+ test) — pure. The line-vs-board predicates, the sort
      (urgency DESC, then longest-waiting within the band, dated from `created_at`), and the two
      counts. Tested at the 1000-row boundary.
- [x] 5. `src/lib/support/lifecycle.ts` (+ test) — pure. Who may claim, rank, reply, close, reopen
      and reassign, and what a reply to a closed ticket does. One module so the route and the board
      cannot disagree about what a button should be disabled for.
- [x] 6. `app/api/support/tickets/route.ts` — GET the list (line + board + counts, `selectAllPaged`)
      and PATCH claim / rank / reassign, each a compare-and-set → 409. Gated on `support_chat`'s
      sibling key (see task 8). **Landed in an unlabeled `push` commit (`26292c44`) — after this doc
      and `employee-support.md` had already been written saying it was a paused partial. Neither
      doc was corrected until the 2026-09-21 status-check session (audit item 121) caught it.**
- [x] 7. `app/api/support/tickets/[id]/reply/route.ts` — reply, close, reopen. Reply gated at
      **view**, not edit. Writes the message, stamps `first_response_at` **once**, fires the in-app
      notification and the n8n leg — recipient decided in code, `null` never `''`.
- [x] 8. `src/lib/rbac/feature-permissions.ts` — a `support_tickets` key in the **existing**
      `employee_support` catalog, and `VIEW_TAB_IDS.employee_support` gains `support-tickets`.
      **No new role, no change to any gate** — `ticketsHostAccess` already does the work. Keep the
      two catalogs key-disjoint; a test already asserts it. (Landed alongside task 6.)
- [x] 9. `src/components/tickets/SupportTicketsTab.tsx` — the line and the board, the counts on top,
      the claim/rank/reassign/reply/close/reopen controls, each enabled from the same `canStaffAct`
      verdict the routes enforce. `TicketsBoard.tsx` gained the missing `activeView ===
      'support-tickets'` branch — without it the tab silently fell through to the dev Kanban's own
      JSX, which is the live bug Kane reported ("shouldn't be the Board data in there") that started
      this pass. `TicketsSidebar.tsx` needed no change — its rail entry already existed (`2e542207`).
- [x] 10. Docs: rewrote `docs/features/employee-support.md`, corrected its INDEX row (78) and the
      stale duplicate at row 60, memory — same commit. `api-reference.md` / `components.md` sweep
      not done this pass — flagged, not silently skipped.

## Also this pass, not originally scoped

`src/lib/support/ticket-live.ts` — the shared live-channel contract
`app/api/employee/support/route.ts` and `.../[id]/messages/route.ts` had each restated inline,
saying in a comment that a third consumer would justify the module. The staff board is that third
consumer, so it was created and both employee-side files were pointed at it instead of a third
copy of the same two string literals.

## Deploy notes

- **MIGRATION PENDING — Kane runs it.** Two SQL files, one launcher.
- **⚠ The 2026-09-16 ticket migration must already be applied, and its state has never been
  verified.** `--verify` it first. Credentials are back in `.env.local` as of 2026-09-21, so this
  is now answerable instead of unknown.
- **The notification widen must be re-read against the live constraint before `--apply`** — the
  chat's `support_chat.*` types are already in it.
- **A sixth grant is NOT needed.** The five already hold `employee_support`; this adds a feature key
  inside that catalog, and `provisionDashboardTabs` grants catalog entries at `edit` when the role
  is granted — so anyone granted the role *after* this ships gets both tabs, and the five granted
  *before* need the new key added by hand.
- **n8n: PENDING.** `support_filed` is not needed by this build (nothing files yet);
  `support_replied` is.
- **No cron.**
