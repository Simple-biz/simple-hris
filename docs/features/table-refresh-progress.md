# Table refresh progress (every table's Refresh button)

Kane, 2026-10-05: *"Find all the tables that have refresh buttons and make sure that when we refresh it
will not reload the table as skeleton but rather a modal with a progress bar on it and add appropriate
text to it"*. Built via `hardening` the same day (session `3485da88`, item 354). One conflict is waiting
on Kane: the Payroll Wizard's **Refresh rates** (item 355).

This is the NPD loading card's rule set (`npd-dashboard.md` § Loading a sheet, built the same morning for
the same kind of ask) applied to every table that has a Refresh button, as a modal.

## What a Refresh click does

1. **The table stays on screen.** No skeleton, no spinner card, no blank pane, no "Loading…" title and no
   stat tile turning into a pulse. The rows already there stay until the new ones arrive
   (`ui-standards.md` § 12.3, *"a refetch never re-skeletons"*).
2. **A modal opens over the page**: *Refreshing ‹what›*, one progress bar, and a checklist. The list
   has one line for each read the table really sends ("Reading every leave request"), then **Updating
   the table**.
3. **When the new rows are on screen**, the bar is full and green, the title says *Refreshed ‹what›*,
   every finished read says what came back ("Read 42 leave requests"), and the modal closes itself
   650 ms later.
4. **If a read fails**, the bar turns red where it stopped and the line that failed is marked. The modal
   shows the server's own sentence and stays open with **Close** and **Try again** (`ui-standards.md`
   § 10.1, § 12.4).

## Only the click reports

The modal belongs to the **Refresh button and nothing else**. A table's first load, a poll, a realtime
nudge, a tab return, a focus refresh, a reload after a save or an undo, a filter or search change, and
a *Retry* on an error card all behave exactly as they did before. They stay silent where they were
silent and show their skeleton where they showed one. This follows `hr-dashboard-cache.md` § *Every
revalidate is silent*: background work never reports.

**How the code keeps that true.** The load a surface already had takes an optional `tracker`. Only the
button's `refresh.run((t) => load({ tracker: t }))` passes one. Every read inside the load is wrapped
in `trackRead(tracker, id, work, describe)`, which is a plain call when there is no tracker. A silent
path therefore runs the same code it always ran.

## Accurate

These are the NPD card's rules (`npd-dashboard.md:470-476`) and `ui-standards.md` § 10.1
(*"the bar tracks completed STEPS, never elapsed time"*). The pure model is
`src/lib/refresh-progress/refresh-progress.ts`, tested in `refresh-progress.test.ts`.

- **Every line is a real read.** Each line is declared up front in the surface's plan and starts when
  that request is sent. It is **done only when the request answered**, and then it says what came
  back, counted from the payload. Where the payload carries no honest count, the line says *Read
  ‹what›* without a number.
- **A read the surface never sent is dropped from the list**, never shown as done. An example is
  Accounting → Issues' second read for *All*, which runs only on a filtered view.
- **No percentage is printed anywhere.** Inside a line the fill is an estimate: one long decelerating
  glide toward a ceiling it never passes (80 % of that line's share). A line crosses its share only
  when its read finishes.
- **A failed read blames only itself.** A read still in flight beside it goes back to unfinished. It
  did not fail, and the ended run will not report it.
- **The bar never moves backwards.** It is **full and green only after the new rows were committed and
  a frame was painted** (two animation frames after React commits them; a timer stands in for a hidden
  tab).
- **Nothing read means no success.** A refresh whose code returned without sending a read fails with
  *"Nothing was read, so the table was left as it was."* It never says *Table updated*. This happens
  when another load was already in flight and the surface skipped the click.
- **A read that failed is never "Read".** Some surfaces tolerate a failed read on purpose: Manager
  Transfers lands a failed scope as an empty list, and the KPI calculator applies a 500 body as an
  empty catalog. They keep doing exactly that on screen. In the modal, that line **fails** with the
  reason.

## Failure

The surface's own failure handling is **unchanged**. A surface that clears its rows on a failed
foreground load still clears them: HR Onboarding, the Offboarding queue, Leave Requests, both
Orientation panels (`hr-orientation-attendance.md` § *Failure refuses to render*). A surface that keeps
them still keeps them. An error card still replaces what it replaced.

Two things move:

- **The surface's own error toast is suppressed on the click path**, because the modal shows the same
  sentence and keeps it on screen (§ 10.1: never a toast that disappears while it is being read).
- **Success toasts that only announced a refresh are gone.** These were *"Refreshed leave requests"*,
  *"Refreshed MESA requests"*, *"Refreshed employee roster"*, *"Refreshed MESA balances"*,
  *"Refreshed urgent payments"* and *"Refreshed MESA-eligible list"*. All six fired **even after the
  refresh had failed**, because the load swallowed the error. The modal says *Refreshed* only when it
  was.

## It never traps anyone

- **✕, Escape and a click outside** hide the modal. The read keeps going, and the table still updates
  when it lands. The button stays disabled with its icon spinning until the read ends.
- **A failure after the modal was hidden is said in a toast**, because nothing else on screen would say
  it.
- **Try again** starts a new run with the same reads. A late answer from the old run is ignored.
- The modal is the house `Dialog` (branded backdrop, § 10). It is portaled, so on `/tickets` it
  re-applies `tickets-theme dark` (§ 1.4).

## Motion and accessibility

- The fill is a **Web Animations glide on `transform`**, the NpdLoadProgress technique. It is resumed
  from stored numbers, so a re-render never restarts it, and it stays smooth while the table re-renders.
  It uses no Tailwind transition class: those are dead app-wide
  ([[global-star-transition-beats-tailwind]]).
- **Reduced motion**: the fill steps and the sheen does not run.
- The bar is a `progressbar`. Its value is the current glide's ceiling (it never claims more), and its
  value text is the line happening now. A screen reader hears one sentence per line change, never a
  running count.

## Which buttons

**48 buttons.** *Before* is what the click did to the table until 2026-10-05.

| Where | The modal's lines (one per read) | Before |
| --- | --- | --- |
| HR → Overview → **Hiring by recruiter** | Counting hires per recruiter (for the week, or all time) | skeleton |
| HR → Overview → **Hiring sources** | Counting hires by source | skeleton |
| HR → Overview → **Referrals** | Reading referrals for the week / every referral | skeleton |
| HR → MESA → **MESA Eligible** | Reading MESA memberships from the pay rates · Reading the master list | rows kept; a "Refreshed" toast even after a failure |
| HR → New Hire Checklist → **Checklist** | Reading the hires for ‹week› | "Loading ‹week›…" replaced the grid |
| HR → New Hire Checklist → **Orientation** | Reading every staged hire and their checklist weeks | panel kept |
| HR → Onboarding → **Onboarding Form** (submissions) | Reading every onboarding submission | skeleton table |
| HR → Onboarding Form → **Pay Plans** dialog | Reading every configured pay plan | rows kept |
| HR → Onboarding → **Pending Hires** | Reading every staged hire | skeleton table |
| HR → Offboarding → **Queue** | Reading the offboarding requests from managers | spinner replaced the table |
| HR → Offboarding → **Offboarded** | Reading everyone who has been off-boarded · Reading the offboarding requests behind them | spinner replaced the table |
| HR → **Transfers** | Reading every transfer request, company-wide | "Loading transfers..." replaced the table |
| HR → **Gift Tracker** (beside the sub-tabs) | Reading the master list · gift notes · shipping submissions · gift fulfilment · gift orders for the Orders badge | rows kept |
| HR → Gift Tracker → **Orders** | Reading locked orders and the gift catalog | rows kept |
| HR → Gift Tracker → **Recently filled / updated** | Reading the latest gift address submissions | no feedback at all |
| HR → **Leave Requests** · Manager → **Leaves** | Reading every leave request | rows kept; a "Refreshed" toast even after a failure |
| Manager → **Transfers** | Reading release requests from other managers · the requests you sent · finished transfers | rows kept |
| Manager → My Team → **Orientation** | Reading every hire and their orientation weeks | panel kept |
| **KPI Calculator → Departments** toolbar (also QC, and Payroll Readiness' dialog) | Reading the bonus catalog · Reading this week's scores for N departments | rows kept |
| KPI Calculator → Departments → **a department's own Refresh** | Saving your pending edits first (only when there are any) · Reading ‹Dept›'s scores for this week | rows kept |
| **KPI Calculator → HSL** toolbar (also Payroll Readiness' dialog) | Reading this week's scores for N branches | rows kept |
| Accounting / CEO → People → **Roster** (header Refresh) | Reading the roster for ‹week or range› | rows kept |
| Accounting / CEO → People → **Bank changes** | Reading the latest bank changes | rows kept |
| Accounting → Payment Dispatch → **the queue** (All pending, each processor, COP) | Reading the week's pay, rates and payments | rows kept |
| Payment Dispatch → **One-off payments** | Reading pending one-off payments · Reading this week's sent one-offs | rows kept |
| Payment Dispatch → **Orphanage** | Reading pending orphanage payments | the whole pane became a spinner |
| Payment Dispatch → **Urgent** (also `/payroll-clerk`) | Reading approved MESA disbursements · orphanage budget requests · this week's dispatch log | rows kept; a "Refreshed" toast even after a failure |
| Accounting → **Issues** | Reading [pending] short-day issues · [for the cards] · Reading [pending] time adjustments · [for the cards] | spinner without a cache; no feedback with one |
| Accounting → **Transfers** | Reading every transfer request | rows kept |
| Accounting → MESA → **Requests** | Reading the latest MESA requests · Reading who is on the Global Master List | rows kept; a "Refreshed" toast even after a failure |
| Accounting → MESA → **Non Members** / **Active Members** | Reading the employee roster · MESA memberships from the pay rates · the MESA ledger | rows kept; a "Refreshed" toast even after a failure |
| Accounting → Documents → **Signing queue** | Reading the latest document requests | rows kept |
| Accounting → Documents → Termination → **Letter log** | Reading the termination letter log (or the letters matching "…") | skeleton, the title and four stats pulsing |
| Accounting → Payroll Wizard → **Interns** | Reading the locked intern weeks · Reading the share mode | spinner replaced the list |
| Orphanage → Issue queue → **Receipt log** | Reading the review queue and the receipt log | the table went blank |
| Orphanage → **Budget History** | Reading your / every budget request (or gift payment) | rows kept |
| Orphanage → **3rd party vendors** | Reading the vendor directory · Reading vendor invoices | "Loading…" replaced the tab |
| Orphanage → Interns → **Profiles** | Reading every intern profile, ended ones included | spinner replaced the grid |
| Orphanage → Interns → Pay week → **Uploaded weeks** | Reading the interns' uploaded Hubstaff weeks | rows kept |
| Admin → **Audit log** (also Accounting → Settings → Audit Log) | Reading the latest 200 audit events (or Searching … for "…") | "Loading audit log…" replaced the whole panel |
| Admin → Webhooks & Integrations → **Integrations** | Reading every client and its 7-day calls | rows kept |
| Admin → Webhooks & Integrations → **Data catalog** | Reading which clients hold each dataset | rows kept |
| Admin → Design & Specifications → **Ticket Developers** | Reading the developer pool from Roles & Permissions · Reading the tickets on the board | rows kept |
| Admin → Global Master List → **Refresh** (live status) | Reading who has been active in the last 2 minutes · Reading last-seen times for the people on screen | rows kept; its spinner stopped on a fixed 500 ms timer |
| `/tickets` → **Board** (Overview · Board · Archived) | Reading the tickets on the board · the board members · the archived tickets (Archived view only) | rows kept |
| `/tickets` → Employee Support → **Support Tickets** | Reading the support board · Reading the open ticket (when one is open) | no feedback at all |
| Employee → **KPI Results** | Reading your published KPI results | rows kept |

Where a read can be overtaken by a newer one (Payment Dispatch's load fence, the audit log's
filters, KPI Results' poll), the click's line or the apply line **fails** with that reason rather
than calling rows it never applied "updated". **Known edge:** Admin → Global Master List's 15 s
presence tick can start during the click's read and win. The modal then completes on the click's
answer a moment before the tick's newer answer paints.

## Not covered, and why

| Button | Why it is not a table refresh |
| --- | --- |
| Payroll Wizard → Step 2 **Refresh rates** | **Conflict, waiting on Kane (item 355).** It swaps the calc table for an 8-row skeleton, but `ui-standards.md` § 17.1 says the wizard is *"its own deep convention — do not modify"* |
| Payroll Wizard → Dispatch → Preview Emails → an opened paystub's **Refresh** (2026-10-06) | A document, not a table (§ 17.1: the preview *"follows § 12.3's per-field rule, not app-table chrome"*), and already inside a modal. Its figures stay and a strip under its header says what moved. See `paystub-dispatch.md` § *Refresh on an opened paystub* |
| Employee Overview (×3), Employee My Hours, the PAB calendar | Dashboards and calendars, not tables |
| Admin → Overview **Sync**, Diagnostics (Payroll Cycles, HR Pipeline, service maps), CEO → Financial Reports, HR → Offboarding metrics | Page-level refreshes of dashboards and reports. Diagnostics keeps its own first-load modal (`diagnostics-performance-tabs.md`) |
| Support ticket / chat **Reload this …**, Set Work Email **Refresh compensation** (×2), Admin → Workspace licence, Termination **Reload facts** | A single record, not a table |
| Every **Sync from Google Sheet**, Monday **Sync board now** / **Re-check**, NPD's sheet sync, row **Retry / Restore / Reopen / Undo / Reset** | Writes, not refreshes |
| Every **Retry / Try again** on an error card | No rows are on screen; it is the first load again |
| NPD | Has no Refresh button. Its own loading card is test-pinned as **not** a modal (`npd-wiring.test.ts`) |
| `AdminCsvImports`, `MyDisputes`, `OrphanageVisits` | Not mounted anywhere |

## Wiring a new table

```tsx
import { trackRead, useTableRefresh, type RefreshTracker } from '@/components/common/RefreshProgressDialog';
import { countOf } from '@/lib/refresh-progress/refresh-progress';

const refresh = useTableRefresh({
  subject: 'leave requests',                                       // "Refreshing leave requests"
  steps: [{ id: 'leaves', label: 'Reading every leave request' }],  // one per read, in order
});

const load = async (opts?: { tracker?: RefreshTracker }) => {
  if (!opts?.tracker) setLoading(true);                             // the click never skeletons
  const rows = await trackRead(opts?.tracker, 'leaves', async () => {
    const res = await fetch('/api/leave-requests?scope=all', { cache: 'no-store' });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'Failed to load');   // a failed read fails its line
    return body.rows ?? [];
  }, (list) => `Read ${countOf(list.length, 'leave request')}`);
  // …the surface's own state updates, unchanged…
};

<Button onClick={() => refresh.run((t) => load({ tracker: t }))} disabled={refresh.running}>Refresh</Button>
{refresh.dialog}
```

Rules a new wiring must keep (each one is how a line stays true):

1. **Only the click passes a tracker.** Never open the modal from inside the load.
2. **`run`'s work awaits every tracked read and the state updates.** A read fired and not awaited makes
   the refresh fail with *"Nothing was read"*.
3. **Every read the click sends is a line**, with the same id in the plan and in `trackRead`. An unknown
   id throws, so a mis-wired line fails loudly instead of hanging.
4. **Throw inside the tracked work for a failed read.** If the surface finds the failure later, call
   `tracker.fail(message, stepId)` there; naming the line keeps a sibling still in flight from
   being blamed.
5. **Leave the failure state alone.** Only `if (!tracker) toast.error(…)`.
6. A button whose subject is decided at click time passes a plan to `run(work, plan)`. One example is a
   single department's Refresh in the KPI calculator. Try again reuses that plan.

## Known gaps

Found while wiring and **not fixed here** (item 356): reads that turn an HTTP error body into an empty
list, refreshes that clear rows on failure, and a few buttons that are never disabled. The refresh
modal inherits one blind spot from them. In the two KPI calculators a department or branch read that
returns a 500 body is applied as empty data with no status check, so its line can say *Read* over data
that never arrived.

## Key files

| File | What it is |
| --- | --- |
| `src/lib/refresh-progress/refresh-progress.ts` | The pure model: plan, lines, glide targets, title, announcement |
| `src/lib/refresh-progress/refresh-progress.test.ts` | Its rules, tested |
| `src/components/common/RefreshProgressDialog.tsx` | `useTableRefresh` (the hook), `trackRead`, the dialog |

## Verified

- **Pure model:** 19 tests (`refresh-progress.test.ts`). They cover: steps, never time; the
  ceiling; never backwards; parallel reads; a failure that blames only its own read; nothing read;
  and an ended run that never moves.
- **Typecheck clean.** The only errors are the two pre-existing stale `.next/types`
  bank-preferred-requests lines.
- **Full `npm test` 5,889/5,889.**
- **Browser fixture, 41/41** (esbuild bundle of the REAL components with the app's Tailwind, a mocked
  `fetch`, and Playwright Chromium; method from NPD's fixture).
  - Real surfaces: Leave Requests, HR Transfers, Audit log, 3rd party vendors, HR Onboarding
    submissions and Pending Hires, plus a synthetic two-read table.
  - In flight: the rows stay; there is no skeleton or "Loading…" swap; the lines run in order; the
    bar stays under its ceiling and never moves back; no % is printed.
  - On success: it ends green and closes itself.
  - On failure: the bar turns red (computed colour) and holds; the server's sentence shows with Try
    again; Try again ends green.
  - Hiding: Escape hides the modal, the button stays disabled, and a later failure toasts.
  - Edge cases: a parallel failure blames only its own read; a run that read nothing fails.
  - Display: dark theme; 390 px phone width with a 16 px gutter and no sideways scroll; reduced
    motion (no glide, no sheen).
- **NOT clicked through signed in.** The other 42 wirings were verified by typecheck and code review
  only: Payment Dispatch, both KPI calculators, Gift Tracker, MESA, Issues and the rest.
