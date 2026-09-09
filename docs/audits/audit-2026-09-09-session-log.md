# Session Log — the 15 most recent Claude sessions (Sep 9, 2026)

Continues [audit-2026-09-03-session-log.md](./audit-2026-09-03-session-log.md). Times are ET.

Window: **`19ea1862` (Sep 4 11:32) → `6068f1f7` (Sep 8 17:10)**, plus the Sep 2–3 tails of two
long-running sessions already narrated in the Sep 3 log and not repeated here.
**Everything in this window is pushed** — `git rev-list origin/main..main` is `0`, `origin/main` is
at `6068f1f7`.

| # | Session | When (ET) | Shipped |
|---|---|---|---|
| 1 | `ab38d267` | **Sep 8** 17:40 → 17:51 | — **hard stop**, Kane's edit owed |
| 2 | `88e29eb1` | Sep 8 15:42 → 17:10 | `7b760955` → `6f15e889` → `364fdfca` · `6068f1f7` — **built then REVERTED** |
| 3 | `1a6b84b8` | Sep 8 15:14 → 15:18 | — **sweep stopped on a hard blocker** |
| 4 | `0ed27fb2` | Sep 8 12:25 → 12:25 | — advisory only |
| 5 | `a7f934fc` | Sep 8 11:15 → 17:24 | `3d49ebcd` · `224762e6` · `c61e1b8a` · `6121626c` · `f5b75b19` · `78e69361` |
| 6 | `0ea9e845` | Sep 8 11:42 → 12:04 | `8c2710ee` — **migration pending** |
| 7 | `5357b812` | Sep 8 10:10 → 12:00 | `68bcc8fb` · `f1c72380` · `5c5adf54` · `771eb1e1` |
| 8 | `c1da4d35` | Sep 8 09:37 → 10:13 | `d12e8323` + a **dev-environment root cause** |
| 9 | `993aad7f` | Sep 4 16:04 → 16:08 | — **blueprint hard stop**, decision owed |
| 10 | `b1b67eba` | Sep 4 14:09 → 15:15 | `2ff4c6be` · `2a26c4f6` · `9c349baa` · `5bf484a2` |
| 11 | `aae1e82e` | Sep 4 13:01 → 13:27 | `658a99ac` — **script not run** |
| 12 | `f5b15fd7` | Sep 4 11:47 → 13:10 | `88474107` · `2e24032c` |
| 13 | `b6fcc0e5` | Sep 4 07:37 → 14:45 | `f731fe69` · `027fce30` · `c30dbdbc` · `b99867fe` · `1aaeb5ef` |
| 14 | `5a2f134a` | Sep 3 13:33 → Sep 4 15:31 | `459671ea` · `b471a7e8` · `7db4ad3f` · `3c478f1c` |
| 15 | `30aeefd5` | Sep 2 10:44 → Sep 4 11:32 | `609b84ad` · `19ea1862` |

---

## What this pass found

1. **A critical, live security blocker has been sitting in one transcript since Sep 8 and nowhere
   else.** Session `1a6b84b8` was asked *"what's essential before I release the HRIS to all
   employees by EOM"* and stopped four minutes in on a **shared-password impersonation backdoor
   rendered on the public login page, with the password committed to `.env.example`** — plus
   **five ungated API routes** that leak pay, home addresses and enrollment data — a sixth, `presence/last-seen`, was found independently by session `993aad7f`. It wrote no doc
   and no memory entry. **This pass re-verified every finding in the working tree and they are all
   still present**, and gave them a home:
   [pre-release-security-readiness.md](../features/pre-release-security-readiness.md). Read that
   before doing any launch work.

2. **A rule was taken from Kane's own words, built across seven surfaces, and then reverted the same
   afternoon.** `7b760955` implemented *"the payout week is the week AFTER the PAB period"*;
   `364fdfca` undid it. The live data had said otherwise **before the build started** — August's PAB
   had already paid on the `2026-08-23_to_08-29` file, 691 people, `paid · sent`. *"The week after
   the period"* meant the **calendar week you run payroll in**, and during calendar week Aug 30 –
   Sep 5 the file open in front of you is `08-23_to_08-29`. Memory
   [[pab-payout-week-file-vs-calendar-week]] now carries the distinction. **The lesson generalizes:
   when live production data says the system already does X and a new instruction says it should do
   Y, reconcile that before writing code — a natural-language week reference is ambiguous between
   the calendar week and the Hubstaff file, so name the artifact.**

3. **Two sessions ended holding a decision that is Kane's, and neither has been made.**
   `993aad7f` ("last signed in" on the Global Master List) hard-stopped on a blueprint gate with an
   **(a) or (b)** question outstanding. `ab38d267` (`gracechellem@` proration) ends with an exact
   click-path Kane must perform in Payment Catalog. Both are in § Open items.

4. **The Payment Catalog was empty all Sep 8 morning for an environment reason, not a code one.**
   `.next/` held a **production build and a dev build mixed together**, which made the dev server
   render every App Router page fine while silently **404ing every `app/api/**/route.ts` handler**.
   Four unrelated symptoms at once — Payment Catalog, the Diagnostics probe, the presence heartbeat,
   `session-status` — is the signature. This is exactly the hazard `CLAUDE.md` warns about, and it
   has now actually bitten. See [[nextjs-build-vs-dev-shared-dir]].

5. **Documentation discipline held this window, with one gap.** Fourteen of fifteen sessions that
   shipped code also shipped their feature doc, INDEX row and memory entry in the same commit — the
   `blueprint`/`hardening` convention is working. The exception is the one that mattered most
   (finding 1), and it was a session that deliberately shipped no code, which is precisely the case
   the convention does not cover. **A session that ships no code can still ship the most important
   finding of the week.**

6. **Two open items from the Sep 3 log are now closed.** All commits are pushed (was: 8 unpushed),
   and the two undocumented surfaces both have docs — `manager-overview.md` and
   `employee-my-hours-calendar.md`, each with an INDEX row. The Labor Day orientation deadline was
   met with a shipped feature rather than a manual workaround (`609b84ad`).

---

## Mon Sep 8

### The HSL manager bonus realignment — six fixes off one report · `3d49ebcd` +5
> *"there have been changes to the bonuses for the HSL managers. The KPI calculator isn't aligned
> with the new bonuses so the amounts are incorrect."*
> 11:15 → 17:24 · `a7f934fc` · six commits, all pushed

The longest and highest-value session of the window. It ran as a loop: Carla reports a symptom → the
session measures live data → asks Carla one precise question → ships. Six distinct defects, all in
`docs/features/hsl-kpi-calculator-2026-07.md` and [[hsl-kpi-calculator-2026-07-changes]]:

| Fix | Commit |
|---|---|
| Managers Weekly reads the **2026-08-30 sheet** — dated specs, banded weekly tiers, Sherwin/AR/Jazmine added | `3d49ebcd` |
| Pre/Post-Hearing **₱2,500 monthly** as a final-week checkbox, **outside** the weekly cap | `224762e6` |
| Case Managers pays **SSA.Gov × ₱250** — the term that only ever reached Attestation | `c61e1b8a` |
| **SSD Medical Records auto-dispatches** again; its monthly share sums with the weekly bonus | `6121626c` |
| **Collections' monthly flat bonus** auto-dispatches — the second monthly dept that never came through | `f5b75b19` |
| HSL KPI paid for **every scored person**, not only `hogan_smith_law` home-dept rows | `78e69361` |

The SSD bug was the one Carla described as systemic across ~49 people, and it was: the weekly ₱475
landed and the ₱1,625 monthly KPI share did not. Verified after the fix against live data — the Aug
30 – Sep 5 SSD period is **Ready**, five teams scored, **49 people, ₱95,500**.

**Two rules this earned.** Manager specs are **DATED** — a new sheet is a new version and an old one
is never edited. And **`Ready` is the trigger for a monthly auto-dispatch, not the calendar.**

**Left with Carla, not code:** re-open **PURPLE** and re-save accuracy/records/RFC for `jennylynf@`
and `rockym@` (₱0 → ₱1,950 each); untick `emss@`'s Pre/Post-Hearing monthly box (₱7,500 → ₱5,000)
unless it is genuinely owed. And because these bonuses are now automatic, **they must not also be
typed into the Adjustment column** or they pay twice.

### COP payees see COP — and the marker that was arriving and being thrown away · `68bcc8fb` +3
> *"We should have a sticker or any indicator for People who are in COP or Colombian and their Bonus
> should be in COP NOT in PHP"* … *"this should reach Payment Dispatch and Payroll Wizard as well"*
> 10:10 → 12:00 · `5357b812`

Settlement currency is now a **per-person, display-only** fact. [[settlement-currency-per-person]]
draws the line that matters: **catalog currency** is the denomination that gets converted to the
peso actually paid; **settlement currency** is a property of the *person*, sourced from their
onboarding country, and it never changes what is disbursed. `FORCED_DEPT_CURRENCY` is the wrong
lever for this and was not used. For Lead Gen totals, COP is the headline and the peso is the
footnote; the total line carries USD, COP and PHP (`f1c72380`).

The interesting part is `5c5adf54`. Kane asked *"Where is the COP value now?"* — and the `≈ $446.43`
USD lines **were** rendering, which proved the FX rate had arrived and the new code was live. So the
request was succeeding and its answer was being discarded. The fetch effect used a per-effect
`cancelled` flag, and `settlementEmails` derives from state that changes on every department load and
every keystroke; React ran cleanup on each change, killing the **in-flight** request. Those emails
were already marked "asked", so no retry ever came.

> **The rule: marking work "already requested" is only sound if the answer can never be discarded.**

Now only an unmount drops a response — a dependency change must not, because the merge is idempotent
and keyed by email, and a failure **un-asks** so the next change retries. **The identical bug was in
the Payroll Wizard's copy of this and was fixed there too.** `771eb1e1` then moved the
native-settlement renderer inside the calculator, leaving `fmtTotals` with exactly one call site.

### Bonus Library gets versions and effective dates · `8c2710ee`
> *"Bonus Library - Should have a history when we view the bonus so we can see changes on its
> effectivity date"* … *"add version as well please"*
> 11:42 → 12:04 · `0ea9e845` · routed to **`blueprint`**

Every bonus now carries a version number and the date its current version took effect, shown as a
`v3 · from 2026-09-14` chip on the card and in the modal header. Viewing a bonus shows **Version
history** (newest marked current, amount or formula, what changed, effective date, who) and
**Assignment history** (assigned, removed, exclusions changed, team-effort toggled). The editor has
an **Effective from** picker on create and edit; the Assignments tab has one **Changes effective
from** picker per department panel.

**The load-bearing decision, and it was Kane's:** this is **DISPLAY AND AUDIT ONLY.** The KPI
Calculator keeps paying the **live** definition, not the version that was in effect for the week
being scored. `bonus-catalog.md` records that "pay by version" was offered and declined, so nobody
later wires payment to a version chip believing that was the intent. **The migration is still
pending Kane** — see [[bonus-library-versioned-history]].

### PAB payout week — built on Kane's rule, reverted on production's evidence · `7b760955` → `364fdfca`
> *"This week is not the PAB Week why is that? PAB Payout week was last week 30-5"* … *"The payout
> week will always be after the PAB Period … it will never be combined"*
> 15:42 → 17:10 · `88e29eb1`

See § What this pass found #2 for the reasoning. Net position after the revert, verified against the
live production override:

| file week | PAB tab |
|---|---|
| `2026-08-16 → 08-22` | — |
| **`2026-08-23 → 08-29`** | **YES** |
| `2026-08-30 → 09-05` *(open now)* | — |

Two things from the aborted arc were **kept** because they were independently right: the Additions
fix, and the **HSL tie-break** for people holding two master rows (`6f15e889` — 162 such people;
HSL wins, and the step now says whose department was guessed, see
[[duplicate-master-rows-hsl-tiebreak]]). [[pab-payout-week-gate-and-pill]] is **RECONFIRMED** as of
2026-09-08: PAB pays only in the week containing the period end.

### Pre-release readiness sweep — stopped on a blocker · no commits
> *"I am going to be releasing the HRIS to the whole Employees by EOM so please let me know what are
> essential for an HRIS to be done before we release"*
> 15:14 → 15:18 · `1a6b84b8`

The most consequential four minutes in the window. Full findings are now in
[pre-release-security-readiness.md](../features/pre-release-security-readiness.md); the short version
is a **public shared-password impersonation backdoor** (`super-admin`, the literal default, committed
to `.env.example`, absent from `.env.local`, on unless explicitly `off`, rendered on `/login` which
is in `PUBLIC_PATHS`), **five ungated API routes** out of 290 swept, the
`SHOW_UNPAID_STAGED_PAYSTUBS = true` launch flag the code itself asks you to flip, **zero security
headers**, and the standing `SECURITY_AUDIT.md` compliance gaps.

Worth recording what the sweep *praised*, because it bounds the finding: `evaluateRouteAccess` is
centralized and unit-tested, `/api/employee/*` correctly scopes to the session email and never a
query param, and **270 of 290** routes are gated. The architecture is sound; the exceptions are
mechanical.

### `.next/` had a prod build and a dev build mixed together · `d12e8323`
> *"Can you check npm run dev if its running fine"* … 404s on `presence/heartbeat`, `session-status`
> 09:37 → 10:13 · `c1da4d35`

Root cause in § What this pass found #4. `d12e8323` is the real code fix that came out of it — a
failed Payment Catalog read used to say nothing and render an empty catalog, which is what made an
environment fault look like a data fault.

**Two operational notes worth keeping.** A background dev server started by a session and left
running will take port 3000 from Kane's terminal, and **`TaskStop` kills the npm wrapper while the
`next dev` child and its `start-server` grandchild keep the socket** — the tree has to be killed
directly. And after recovering from a mixed `.next/`, **do not delete `.next` again** on the next
start; the rebuilt tree is the clean one.

### `gracechellem@` prorating after offboard — hard stop, Kane's edit · no commits
> *"She is offboarded and her total rate should be 175 for last week, but HRIS is prorating and I
> can't fix it under readiness.offboarded"*
> 17:40 → 17:51 · `ab38d267` · routed to **`hardening`**

No code, no DB writes, temp probes removed. The `hardening` brief cited the governing rule: the
**snap-to-Sunday was deleted** on 2026-08-18 ([[midweek-transfer-proration-ruling]]) and mid-week
effective dates now persist verbatim — *"a whole-week rate change is still expressible: enter it
effective on the pay week's start date."* So Readiness is the wrong surface by design.
[[readiness-setrate-cannot-backdate]] records the corollary: **Set rate is ALWAYS effective-today**;
back-dating a past week happens in Payment Catalog → Pay Structure.

**Kane's exact path** — Payment Catalog → Pay Structure → Lead Gen → her ₱175 individual override →
Edit → **Effective from = `2026-08-30`** → Update. The rate does not change; only the date it
started. The save also **deletes** the stray `eff 2026-09-08` row Carla wrote (the route sweeps
`effective_from >= today`) and leaves the `₱235 eff 2026-07-20` rows alone — that is her real HSL
history and July/August paystubs still need it. **Then re-lock the 08-30 → 09-05 week** so the
disbursement record reprices.

Also surfaced, still open: she holds **two employee-scope pay structures** (₱175 lead_gen vs ₱235
hogan) and newest wins.

### Firebase — where it fits · advisory only, no commits
> *"Im thinking of using Firebase in this system where is it best that we can use it?"*
> 12:25 · `0ed27fb2`

**Best fit: push notifications via FCM.** Nothing today reaches someone whose tab is closed — the
app has in-app chimes, notification rows and n8n email. The server-side write points already exist
(paystub paid, payroll available, KPI scored, ticket comment, time-adjustment approval), each a route
that inserts an `employee_notifications` row, so an FCM send is one call beside that insert. Firebase
would hold **device tokens only, never payroll data**, and the same channel serves a mobile app later.

**Plausible second fit: presence and ephemeral signals**, because [[supabase-realtime-anon-rls-dead]]
records that `postgres_changes` never reaches the anon browser client and the workaround is a server
Broadcast. **Everywhere else Firebase would duplicate Supabase, NextAuth or n8n.** Advisory only —
nothing was built and no dependency was added.

## Fri Sep 4

### Diagnostics → Payroll Cycle Performance + HR Pipeline · `2ff4c6be` +3
> *"lets add a new tab labeled Payroll Cycle Performance where we can calculate the percentage of
> successful payroll cycle … create an implementation plan where I can check it"*
> 14:09 → 15:15 · `b1b67eba` · routed to **`blueprint`**, plan approved before code

Two tabs, **one honest rate each**, taken from the only source that can carry a denominator.
[[diagnostics-performance-tabs]] pins the rule: **the payroll rate comes ONLY from close-outs.**
`9c349baa` then listed **every** pay cycle rather than only the declared ones, per Kane's *"can we
add the unclosed? even though they aren't closed lets just label unclosed"* — shown **with their
data and without a denominator they do not have**, rather than fabricating one. `2a26c4f6` took
orange and teal because amber and green already mean something in this app.

`5bf484a2` replaced the first-load skeletons with a modal progress bar, reusing the Payroll Wizard's
`step-load-prediction.ts`. **Its rule came with it: the bar never reaches 100% until the data
actually lands** — it ramps to 90% over the duration this browser remembers, then eases toward 99%.
On a payroll screen a full bar asserts *the figures behind this are safe to read*. A **failed read
never completes the bar and never trains the estimate.**

### The cycle celebration fires ONE way, and Admin → Webhooks gets an editor · `88474107` · `2e24032c`
> *"The automation should also send the Excel, PDF and CSV Report … All I want is that this
> automation only triggers one way and its when stop processing and close payroll cycle is triggered
> from the UI — there was one instance where It was triggered accidentally … close that gap"*
> 11:47 → 13:10 · `f5b15fd7`

[[cycle-celebration-one-way]]: **one trigger, the close-out route, server-side**, with CSV/XLSX/PDF
attached. The accidental-trigger gap is closed at the source rather than guarded downstream.
[[webhook-automation-editor]] covers the new Admin → Webhooks editor — role ± add/remove or a fixed
recipient list, plus extra payload keys — built for exactly the case Kane named: *"if Carla resigns
we can change the recipient."*

**Offered and not built:** a `penny` CLI for the PC, a real REPL against `/api/admin/penny-chat`
authenticated by a minted personal token rather than a session cookie, so the audit log still names
Kane and revoking the token is the equivalent of pulling a key from `authorized_keys`. The session
posted the shape and stopped short of a blueprint brief. **Kane's call.**

### The Employee ID badge · `f731fe69` · `027fce30` · `c30dbdbc` · `b99867fe` · `1aaeb5ef`
> *"add a new tab after Overview and lets call it ID … give me an artifact of the design first"*
> 07:37 → 14:45 · `b6fcc0e5` · artifact-first, then `impeccable`, then ship

Shipped as a **Profile SECTION, not a tab** ([[employee-id-card]]), navy-dominant with orange never
used as text, flat rather than 3D, and it **never themes** — verified rendering unchanged with the
page in dark mode. Download-as-PNG (`027fce30`), then milled metal with a slow sheen (`b99867fe`).

**The finding worth keeping.** Two of these commits are bug fixes for defects that **98 passing tests
did not catch**, found only by driving the real painter headlessly and looking at the output:
`c30dbdbc` — the serial spaced its glyphs by the font **weight**; `1aaeb5ef` — a quoted nickname put
a quote mark on the badge, because `Reroma (Teves), Jan Kane "Kane"` has a last name-part of literal
`"Kane"` and its opening quote became the second initial. **Punctuation-leading name parts are not
initials.** `formatStartDate` remains **off-by-one and OPEN** — it puts the wrong start date on every
badge, and it is item 4 in the pre-release doc.

### `angelicac@` — a transfer that was never filed · `658a99ac`
> *"Angelica Concepcion should have been transferred to another department already so why is it that
> her paystub is still on leadgen??"* … *"can we hardcode or SQL Migrate as if she was ever put in
> HRIS?"*
> 13:01 → 13:27 · `aae1e82e`

Answered as a **backfilled transfer, not a raw SQL edit**. `scripts/backfill-angelicac-transfer.mts`
inserts the transfer request the HRIS should have had, then runs the **same three production helpers
the Release button runs, in the same order** — master list, then the Google Sheet cell, then mark
applied — so the record, the row and the Sheet move together and a Sheet miss surfaces as a **Retry
badge instead of drifting silently**. Lead Gen → HSL — Collections, effective `2026-06-22` (the day
Accounting's ₱265 catalog rate took effect), overridable. One audit row and a JSON backup to
`references/backups/` before any write; notifications off unless `--notify`.

**Dry run passed all five guards with zero writes. `--apply` has never been run** — see
[[angelicac-dept-never-transferred-in-hris]]. Her 08-23 stub went out under Lead Gen and was paid
Sep 4 17:08, so there is no unsent staged row waiting on this.

### "Last signed in" on the Global Master List — blueprint hard stop · no commits
> *"Admin - Global Master List - each employee should have a last signed in data please so we know"*
> 16:04 → 16:08 · `993aad7f`

**The finding that decides it: "last signed in" does not exist as data anywhere in this system.**
`grep` for `last_sign_in|last_login|signed_in_at` across `src app scripts` returns **zero hits**.

| Signal | What it actually is | Covers |
|---|---|---|
| `user_presence.last_seen_at` | a **heartbeat**, every ~15s while a tab is *visible* | last *active*, not last *authenticated* |
| `audit_log` `employee.login.success` | a real login stamp | **only** the password path |
| `audit_log` `auth.impersonation.signin` | a real login stamp | only the super-admin backdoor |
| **Google SSO** — the main path for everyone | **nothing is recorded** | — |

The one clean hook is the NextAuth `jwt` callback ([auth-options.ts:203](../../src/lib/auth/auth-options.ts#L203)) —
`if (account)` fires exactly once per real sign-in on both providers, and today writes roles and a
Google photo there but no timestamp.

The session **refused to bolt timestamps onto `/api/presence/last-seen`**, having found that route
has **no auth gate at all** — that finding is now item 2 in the pre-release doc. It also refused to
fall back to `last_seen_at` to fill blanks: *a column labelled "Last signed in" showing a heartbeat
is the kind of quiet lie that gets acted on.* Empty stays empty with an honest tooltip.

**Decision owed, (a) or (b)** — see § Open items.

### Payment Catalog → Current Banks, and a People tab on each bank · `459671ea` +3
> *"add a new tab within where we can see all the Current Banks that the Users added … that way we
> can add logos to them"* … *"Lets add a list of people in that bank as well"*
> Sep 3 13:33 → Sep 4 15:31 · `5a2f134a`

[[payment-catalog-current-banks]]: **129 spellings folded to 45** via a DECLARED table, normalized to
the official name. `7db4ad3f` fetched real bank logos into `public/banks`, **measured before they
land**. `b471a7e8` made wallet cards reuse the emerald the app already means "wallet" by.

`3c478f1c` added a **People (N)** tab inside each bank modal — name, work email, department, and a
chip when the bank sits on the person's *other* account rather than the one they are paid into;
a filter box appears past twelve people; the list loads only when that tab is opened.

**The exception Kane approved, and it is written into the doc that it contradicts.** Leavers appear
with a **Left** chip rather than being filtered out, and the card count includes them, because the
bank genuinely is still on their record — hiding them would mean a card reading "203 paid here"
opening to 180 names. [[payment-catalog-hides-offboarded]] still holds everywhere else.

### Orientation dates skip US holidays · `609b84ad` · `19ea1862`
> *"There will be labor day on monday next week how are we on the Orientation Schedule"* … *"if there
> is a holiday on monday then move it the next day, if there is another holiday in there then move it
> to the next"*
> Sep 2 10:44 → Sep 4 11:32 · `30aeefd5`

This closes open item 2 from the Sep 3 log, which had a **Fri Sep 4 ~20:15 UTC deadline** because
that is when Lock-in fires the invite. Shipped as a real feature rather than a manual workaround:
the orientation date **skips enabled US holidays, iteratively** — Sep 7 Labor Day → **Tue Sep 8**.
Monday remains the default ([[orientation-holiday-date-shift]]).

`19ea1862` is doc-only and answers *"where can I see this on the HR side?"* with the fact that there
is **exactly one** surface: **HR → New Hire Checklist → the week → Lock in**, third bullet, which
renders **before** the passphrase field so Cancel is a free look, and **lock mode only** (Reopen
shows no bullets). `new-hire-checklist.md` gained a state table pairing what the dialog *says* with
what Lock in would actually *do*, including *calendar unreadable → freezes the week but sends no
emails.* **That pairing is the part worth having written down**, because the dialog copy and the
server's refusal have to stay in step. Also recorded: where it is **not** — the grid header shows
only the week range, and the Orientation attendance tab keys on `period_start` with no concept of a
scheduled date.

Note: this session **left `INDEX.md` alone** because another session had an uncommitted row in it,
rather than sweeping that work into its own commit — the [[multi-session-shared-checkout]] rule
being applied correctly.

---

## Open items

Carried forward and re-verified on 2026-09-09 unless marked otherwise.

| # | Item | State |
|---|---|---|
| 1 | **Impersonation backdoor is live** | `SUPER_ADMIN_PASSWORD` absent from `.env.local` → falls back to the literal `'super-admin'`; `SUPER_ADMIN_IMPERSONATION` unset → **on**; form rendered on public `/login`; password committed at `.env.example:69`. **Verify prod env first** (`vercel env ls`), then set `=off`, redeploy, **rotate `NEXTAUTH_SECRET`**. **BLOCKING the EOM release.** |
| 2 | **Six ungated API routes** | `manager/member-monthly-pay` (anyone's pay), `employee-gift-shipping` (everyone's home address, plus an unowned `PUT`), `hr/fpu-enrollments`, `import-daily-report` (unauthenticated CSV → Postgres **write**), `hsl-bonus/period-summary`, `presence/last-seen`. Helpers already exist. **BLOCKING.** |
| 3 | **`SHOW_UNPAID_STAGED_PAYSTUBS = true`** | The code comment says *"flip to `false` at HRIS launch."* Intersects four known pay gaps (`canasm@`/`laurenc@` never paid, `erict@` ₱5,373, `mariaa@`/`mariaar@`, ID-card `formatStartDate` off-by-one). **Kane's decision, not a defect.** |
| 4 | **No security headers** | No `headers` block in `vercel.json` or `next.config.ts`. No HSTS/CSP/`X-Frame-Options`. `SECURITY_AUDIT.md` #54. Cheap. |
| 5 | **"Last signed in" — (a) or (b)** | **(a)** true sign-in stamp, forward-only, `—` where unknown, plus a partial `audit_log` backfill (recovers password-login and impersonation only; **Google SSO users have no recoverable history**). **(b)** same build, but the row *also* shows the existing **Last seen** as a separately-labelled second line, so the tab is useful immediately. Two facts, never merged. Needs a new column + route + script, so it re-enters `blueprint` on the answer. |
| 6 | **`gracechellem@` back-date** | Kane's click-path is in § Fri Sep 4 / § Mon Sep 8 above. Then re-lock 08-30 → 09-05. She also holds **two employee-scope pay structures** (₱175 lead_gen vs ₱235 hogan, newest wins). |
| 7 | **HSL items that need Carla, not code** | Re-save **PURPLE** for `jennylynf@` + `rockym@` (₱0 → ₱1,950 each); untick `emss@`'s Pre/Post-Hearing monthly box (₱7,500 → ₱5,000) unless owed. And **do not also type the now-automatic bonuses into Adjustment** — they will pay twice. |
| 7b | **`medical_records` portal rate — ₱231,900 unresolved** | Added 2026-09-09 while answering *"how about the HSL Medical Records"*. `schema.ts:196` pays `portal_login` at **₱100**; `hsl-kpi-calculator-2026-07.md:19` **and** memory [[medical-records-rfc-manual]]’s **Kane-confirmed worked example** both say **₱250**. `hsl-catalog-migration.md` §1.2 had called it a *“likely doc typo”* on two-source reasoning that never weighed the memory; corrected to unresolved. Measured read-only: **1,546 units, 33 people, 8 weeks (07-12→08-30)** — ₱154,600 paid vs ₱386,500. **Needs one worked example for a recent week: is the line ₱100×N or ₱250×N?** Affects `medical_records` ONLY. **Kane's call — do not change the rate either way to close it.** |
| 7c | **HSL items verified fixed, not open** | Distinct from 7b: **SSD** Medical Records (`ssd_medical_records`) auto-dispatch is fixed and pushed — `cadence: 'monthly'` + `monthlyAutoPay: true` confirmed in code 2026-09-09. The RFC pool and the ₱475+₱1,625 summing are working; what remains there is item 7's Carla re-saves. |
| 8 | **Bonus Library migration** | `8c2710ee` shipped the UI; the migration is **pending Kane**. Per [[migration-pending-claims-are-folklore]], run `scripts/audit-pending-migrations.mts` before believing this either way. |
| 9 | **`angelicac@` transfer backfill** | `scripts/backfill-angelicac-transfer.mts --apply` **never run**. Dry run passes all five guards. |
| 10 | **82 duplicate paid rows** | Carried from Sep 3 item 1, **not re-verified this pass.** `scripts/dedupe-payment-dispatches.mjs --apply` had never been run; `d406e7c9` stops new ones and is pushed. `alonzos@` may be a real double payment and is excluded. |
| 11 | **MESA close-out** | Carried from Sep 3 item 5, **still open** — verified 2026-09-09 that `accounting-mesa-export.md:42` still says a closed account's history is *"retained"* and still never says the balance is **released as an obligation**. An omission on a money doc. |
| 12 | **Orientation no-shows → Offboarded** | Carried from Sep 3 items 3 and 4, untouched this window. Two doc contradictions, session recommended deriving no-shows live as a third origin. **Kane's call.** |
| 13 | **Pay Processors → Payment Dispatch** | Carried from Sep 3 item 8. The registry ships; the PD integration that consumes it does not. |
| 14 | **Orphanage interns migration** | Carried from Sep 3 item 7, not re-verified. Same folklore caveat as item 8. |
| 15 | **Monday board** | Pass 23's apply was mid-flight at the Sep 3 hand-off and was never verified; **nothing in this window touched the board**, so at least the Sep 4–8 deliverables above have no rows. **Re-read the board before pass 24.** |
| 16 | **`penny` CLI** | Shape posted in `f5b15fd7`, no brief, nothing built. |
| 17 | **2 pre-existing test failures** | Both in Manager files — a raw department cell in `ManagerApp.tsx` and an unformatted hours interpolation in the Overview gallery. Re-reported by `5a2f134a` this window. |
| 18 | **`MEMORY.md` line cap** | **108 lines / 18.5 KB** after this pass, against hard caps of **200 lines** and ~24.4 KB. Verified both directions this pass: all **248** memory files are indexed and no indexed filename is missing. The file's own header asks for **under 17 KB** and it was already over before this pass — trimming means rewriting other sessions' hooks, so it is flagged rather than done. And [[memory-index-load-cap]]'s rule stands: new entries go at the **TOP**, because truncation eats the tail and the tail is the newest work. |

**Closed since the Sep 3 log:** all commits pushed (was 8 unpushed) · both undocumented surfaces
now have docs and INDEX rows (`manager-overview.md`, `employee-my-hours-calendar.md`) · the Labor Day
orientation deadline, met by `609b84ad`.

---

## Conventions this window confirmed

- **Reconcile live data against a new rule before building on the rule.** The PAB revert cost a whole
  arc across seven surfaces, and the contradicting evidence — 691 people already `paid · sent` on the
  Aug 23–29 file — was available before the first line was written.
- **Name the artifact, never "this week."** A natural-language week reference is ambiguous between the
  calendar week and the Hubstaff file, and that ambiguity is what caused the revert.
- **A session that ships no code can hold the most important finding of the week** — and the
  doc-in-the-same-commit convention does not cover it, because there is no commit. Four of fifteen
  sessions here shipped nothing; three of those four were right to, and the fourth's findings sat
  unrecorded for a day.
- **Marking work "already requested" is only sound if the answer can never be discarded.** Earned by
  the COP marker bug, and the same bug existed in a second copy of that code.
- **Tests that pass are not output that was looked at.** Two ID-badge defects survived 98 passing
  tests and died the moment someone rendered the real painter and looked.
- **A progress indicator must not claim completion it cannot verify** — the wizard's predictor rule
  travelled to Diagnostics with the code, and matters more on a payroll screen, not less.
- **Refuse the plausible substitute.** `last_seen_at` is not `last_sign_in_at`; a mislabelled column
  is worse than an empty one, because an empty one does not get acted on.
- **Write the exception into the doc it contradicts.** The Current Banks leaver exception is recorded
  inside the rule that says off-boarded people are hidden, which is the only place someone will look.
