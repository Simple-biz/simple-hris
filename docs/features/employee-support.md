# Employee Support — an employee-filed ticket, answered by five named people

A button beside FAQs on the Employee Dashboard opens a form; what the employee writes becomes a
numbered support ticket that five named people answer from their own tabs inside `/tickets`. It
exists because a question about a payslip, a missing bonus or a time adjustment had nowhere to go —
it became a chat message to whoever seemed likely, with no record, no number, and no way to see
whether anyone was dealing with it.

**Approved by Carla Thomas 2026-09-15** (signed, `Employee-Support-for-approval.pdf`).
**The data layer shipped 2026-09-16 in `99716520`.** The routes, the UI and the `employee_support`
feature key are **not built**. The live chat half is a separate, later document —
`employee-support-chat.md` — and is being built first by Kane's override; see *The chat came first*
below.

> The governing plan is `docs/superpowers/plans/2026-09-14-employee-support.md`. Read it before
> changing anything here: it carries the signed decisions, the reasoning, and the task list.

## Key files

| Piece | File |
| --- | --- |
| Tables | `references/sql/create/2026-09-16_employee_support.sql` |
| Migration runner | `scripts/apply-employee-support-migration.mts` + `Apply Employee Support migration.cmd` |
| Vocabulary — statuses, categories, labels, `ES-` format | `src/lib/support/types.ts` |
| Support window (Eastern) | `src/lib/support/hours.ts` |
| Category routing / the steered subjects | `src/lib/support/routing.ts` |
| Language screening | `src/lib/support/screening.ts` |
| Who hears about an event | `src/lib/support/recipients.ts` |
| Audit family `employee_support.` | `src/lib/audit/registry.ts` |

## It is not on the dev ticket board, and that is not a preference

Three measured facts rule out reusing `public.tickets`, and each is a reason on its own:

1. **`tickets`, `ticket_comments` and `ticket_events` have no RLS and no policy, and all three sit
   in the `supabase_realtime` publication** (`references/sql/migrate/2026-07-15_tickets_kanban.sql`).
   Authorization is entirely in the route handlers. That is survivable for *"the board flickers on
   drop"* and not survivable for *"my manager is underpaying me."*
2. **Every ticket is force-assigned to `kaner@simple.biz`** (`app/api/tickets/route.ts:91-93`), with
   owner-only reassignment and a second hardcoded copy of the address in
   `src/lib/tickets/notify.ts`. Support work that only one person can hand out is not support work.
3. **There is no `employee` role.** An employee is a signed-in user with an *empty roles array*, so
   `requireFeatureAccessAnyView` never enters its loop and default-denies
   (`src/lib/auth/authorize-feature.ts:111-128`). An employee cannot call `/api/tickets/*` at all,
   and `route-access.ts` bounces them off `/tickets`.

Carla's signed privacy paragraph says the same thing in her words: *"their own private area rather
than reusing the existing developer ticket board, specifically so that only the people you name in
Decision 1 can read them."*

**So the tables are RLS-on with zero policies, they have their own `ES-` identity series, and they
are deliberately absent from `supabase_realtime`.** The SQL file says so in capitals at `:26-33`
along with the sanctioned alternative: broadcast the FACT that a ticket changed and let each client
re-fetch through its own gated route. **Never put a message body on a public topic.** Adding these
tables to the publication would require a permissive anon SELECT policy on pay disputes.

## Granting access is the dangerous part

The five answerers are **Carla, Claire, Ainsley, Grace and Alivia** (Decision 1). **None of them
holds the `tickets` role**, and they must not get it: Carla's own *not included* table says *"the
support team only sees support questions."*

The trap is that **granting a role auto-provisions `access:'edit'` for every feature in that view's
catalog** (`app/api/employee-roles/route.ts`, `provisionDashboardTabs`). Putting an
`employee_support` key inside `FEATURE_CATALOG.tickets` would therefore hand all five the HRIS dev
Kanban at edit until an admin downgraded each by hand.

**So `employee_support` is its own role AND its own `FeatureViewKey`**, hosted at `/tickets` as its
own tabs, using the per-tab overlay (`allowedTabsForUser`) that every other dashboard already uses
and that `/tickets` had opted out of. A support-only holder sees support tabs and nothing else — by
click or by typed URL.

## The rules inside the feature

**The session writes the row, never the body.** `authorizeEmailAccess` gates, then the row is
written with `authz.effectiveEmail` (the precedent is `app/api/time-adjustments/route.ts:135`). And
`work_email` is the **master** work email resolved server-side — an employee's session email can be
a personal or alternate address, so the address they signed in with is not necessarily who they are.

**Nine categories, and two subjects that are not categories at all.** `SUPPORT_CATEGORIES`
(`types.ts:27-37`) is the six Carla printed plus Gmail, Hubstaff and Roboform from her write-in.
Nothing was crossed out. *Requesting* a time adjustment, your schedule, and time off are **steered**
to a manager by copy shown before the person types (`routing.ts`) — they are `STEERED_SUBJECTS`,
not categories, and **nothing refuses a ticket**. A misfiled ticket costs one reply; a wrong refusal
costs someone their only way to ask.

> **Open with Carla:** she wrote *"They shouldn't be able to request an adjustment through the
> support channels"*, and this is a notice that accepts the ticket anyway. Softer than her words.
> Do not harden it without asking her — and do not soften the copy either.

**A screening flag never blocks.** `screening.ts` returns a verdict, the ticket is filed either way,
and a human sees the flag beside the text. A blocking filter turns every false positive into an
employee who cannot report a problem on the one channel built for reporting problems — someone
describing harassment uses the words that were used on them. It **fails open** on an internal
error. Turning a flag into a refusal is a policy change, not a configuration change.

**Support hours are Eastern, and this is the only non-Manila window in the HRIS.** `hours.ts` stores
an IANA zone (`America/New_York`) plus local clock times — **never a fixed offset**, because Eastern
observes DST and a stored `-05:00` becomes a bug in March. Kane confirmed the zone 2026-09-16, and
on 2026-09-18 ruled that **every employee is on EST**, which closes the Manila-reader problem the
dual-zone formatter was originally built for. The formatter stays; the second zone is now belt and
braces rather than protection.

**A recipient is decided in code and is `null`, never `''`.** `recipients.ts` mirrors
`src/lib/tickets/recipients.ts`. The n8n Gmail node is **stop-on-error**, so an empty `send_to`
breaks the workflow — every hook returns early on `null`. The recipient is never chosen inside n8n.

**The claim is a compare-and-set, never a read-then-write.** A lost race is a **409** the UI
re-reads from, never an auto-merge — so two people never answer the same question, which is what
Carla was promised in step 3 of the signed flow.

**The staff list sorts longest-waiting-unanswered first, not newest.** Her words: *"Sorted so the
longest-waiting unanswered question is at the top, **not the newest**."* Kane's urgency ranking
(2026-09-18) sits *above* that rule, not instead of it: urgency descending, then longest-waiting
within each band, dated from **filing**.

## What is not built

Everything above the data layer. No routes, no components, no `employee_support` key, and **task 3
— the `employee_notifications` type CHECK widen — has no file at all**, so until it exists every
`support.*` notification insert is rejected and the notification is dead.

Also unbuilt and worth knowing, because they are things Carla approved rather than nice-to-haves:
the **at-a-glance counts** (*"how many need a reply, how many were answered today"*), and the
**staff-only trial** — *"You and the support team try it before any employee sees it"* — which
means the dashboard button ships in its **own commit, after** the five have used it for real.

## The chat came first

Carla ticked *"Tickets first, add live chat once we know the volume"* (Decision 2). **Kane overrode
it on 2026-09-18** and reaffirmed after the contradiction was put to him; **she has not been told**,
and she is the approver of record. The chat work is
`docs/superpowers/plans/2026-09-19-employee-support-chat.md` and `employee-support-chat.md`.

One consequence that reaches back into this document: **an unanswered chat becomes a ticket**
(Kane's Q1), so these tables are the floor under the chat feature rather than a parallel thing, and
the chat migration has a foreign key into `employee_support_tickets`.

## Deploy notes

- **MIGRATION PENDING — Kane runs it.** `scripts/Apply Employee Support migration.cmd`, or
  `node --import tsx scripts/apply-employee-support-migration.mts --apply`. Dry run is the default;
  `--verify` is read-only.
- **The migration's state is UNKNOWN, not unapplied.** It has never been verified. The one recorded
  run (2026-09-16, started by mistake) reported every object MISSING, which proves the credentials
  worked that day and says nothing about today. `.env.local` has since held only `.env.example`
  placeholders — see `docs/audits/audit-2026-09-16-session-log.md` Open item 115.
- **Run this migration BEFORE the chat one.** `employee_support_chat_sessions.became_ticket_id` is a
  foreign key into `employee_support_tickets`.
- **Five grants by hand after deploy**: `employee_support` to Carla, Claire, Ainsley, Grace, Alivia.
  Until they exist the staff tabs are empty for everyone.
- **n8n: PENDING.** `support_filed`, `support_replied` if the email leg ships. Recipient handed over
  as `send_to`; the Gmail node never picks one.
- **No cron.** `docs/features/INDEX.md:42` — every `/api/cron/*` 401s on the fail-closed
  `CRON_SECRET` gate and the two declared crons have never once run. Anything with a lifetime
  expires **lazily on read**.
