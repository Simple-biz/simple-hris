# Session Log — the 10 most recent Claude sessions (Sep 10, 2026)

Continues [audit-2026-09-09-session-log.md](./audit-2026-09-09-session-log.md). Times are ET.

Window: **`362624c3` (Sep 9 09:07) → `25a6f677` (Sep 9 16:53)** — seven commits, all on Tue Sep 9 —
plus today's `eff439e7`, which lands work a Sep 9 session wrote and never committed.
**Nothing in this window is pushed.** `origin/main` is still at `6068f1f7` (Sep 8 17:10);
`git rev-list --count origin/main..main` is **8** including today's commit. Pushing is Kane's.

| # | Session | When (ET) | Shipped |
|---|---|---|---|
| 1 | `438013b6` | Sep 9 16:38 → 17:01 | `25a6f677` — **production data changed** (rename + reseed, backed up) · one follow-up question unresolved |
| 2 | `c2cf2f89` | Sep 9 13:31 → 14:28 | — meeting record + 11 memories + 8 INDEX rows written, **NOT committed** (API error) → landed today as `eff439e7` |
| 3 | `33c5ffd7` | Sep 9 10:49 → 11:30 | `ddf4c790` — audit-log registry; **2 of the 6 ungated routes closed** |
| 4 | `e45b1682` | Sep 9 09:41 → 10:59 | `4e8590cb` · `f5ad83ab` — then a **blueprint hard stop** (Admin cache), decision owed |
| 5 | `4b3331cb` | Sep 9 09:23 → 09:40 | — **blueprint hard stop** (impersonation), Q1–Q3 owed |
| 6 | `11011fc4` | Sep 9 09:25 → 09:32 | `0573d834` |
| 7 | `29264e47` | Sep 9 08:58 → 09:16 | `362624c3` · `75d50864` — the Sep 9 log itself |
| 8–10 | `ab38d267` · `a7f934fc` · `1a6b84b8` | Sep 8 | already narrated in the Sep 9 log; not repeated |

---

## What this pass found

1. **The doc-check is working where it was designed to work.** All five sessions that edited code
   invoked `hardening` or `blueprint` first, posted a `READ`/`RULE`/`SCOPE` brief, and shipped the
   feature doc, INDEX row and memory entry in the same commit. Three of them found a surface with
   **no governing doc at all** and wrote one — `audit-log.md`, `accounting-dashboard-cache.md`,
   `hr-dashboard-cache.md`. That is the convention doing exactly what it is for.

2. **It keeps failing in the same place: sessions that ship no code.** The Sep 9 log's finding #5
   said so; it happened again the same day, worse. Session `c2cf2f89` processed the Carla/Jackie
   meeting into a 519-line record, eleven memory files and wikilinks in eight INDEX rows — then hit
   an API error and ended with *"Nothing is committed — say the word."* Nobody did. Two later
   sessions saw the dirty `INDEX.md`, correctly refused to sweep another session's work
   ([[multi-session-shared-checkout]]), and one of them therefore **left its own INDEX wikilink
   unwritten**. The record sat 15 hours in the working tree. Two `blueprint` briefs also ended the
   day awaiting Kane's answers with no note anywhere that a decision was owed.
   **Fixed structurally today:** root `CLAUDE.md` gained two sections — *how to answer a status
   question* (newest `docs/audits/` log § Open items → INDEX row → memory FILE → verify in the tree)
   and *a session that ships no code still ships its record* (finding → memory + Open items row;
   meeting → `docs/meetings/` + README + INDEX; unapproved brief → Open items line; **then commit**).
   Memory: [[no-code-session-still-writes-the-record]].

3. **Four memory entries written yesterday had no INDEX wikilink**, so both skills were blind to
   them: the cache session linked *other* stores' memories into its two new rows but not its own two
   ([[accounting-cache-envelope-and-purge]], [[hr-cache-freshness-window]]); the Hubstaff session
   deferred its link because INDEX was dirty ([[hubstaff-filename-junk-heuristic-hides-paid-week]]);
   and the Firebase advisory ([[firebase-scope-fcm-only]]) never had a row. All four are linked now,
   and the three new feature docs have their `docs/README.md` rows (they had none — "half-published",
   the exact defect the Skills row warns about).

4. **Two open items from the Sep 9 log were wrong in opposite directions**, which is why the new
   status rule says *verify, never relay*. The log (and memory) said Kane had applied
   `gracechellem@`'s back-date — a read-only probe today shows **he has not** (no `eff 2026-08-30`
   row; the stray `eff 09-08` row is still there). And the log carried **82 duplicate paid rows** as
   open, "not re-verified" — a paged count today finds **one** email+file key with two paid rows
   (the `alonzos@` divergent pair the script leaves alone by design), and `references/backups/`
   holds three `dedupe-payment-dispatches-*.json` files from Sep 3 12:31–12:54. The `--apply` ran
   on Sep 3 and nobody wrote it down. The Bonus Library migration, by contrast, is confirmed
   **NOT applied** (all four objects missing) — and `scripts/audit-pending-migrations.mts` does not
   probe it, so the folklore rule ([[migration-pending-claims-are-folklore]]) had no instrument.

5. **Production data was changed yesterday, deliberately and reversibly.** `25a6f677` renamed the
   Aug 23–29 Hubstaff upload off its browser `(1)` suffix across five stores and re-seeded 1,100
   `disbursement_records` (1,051 paid) that a fully paid week had never had. No amounts, statuses or
   `paid_at` moved; full restore set in `references/backups/hubstaff-rename_*.json`. Kane's follow-up
   — *"the missing is 30 - 5"* — is **unresolved**: that week is present, in the *Current week · live*
   slot, locked Sep 8 with **620 dispatches against 1,069** the week before. See Open item 24.

6. **The meeting record corrects the room three times**, and one of its findings blocks payroll
   code: Pre/Post-Hearing's monthly flat is pinned at **₱2,500** in code, test, two docs and memory —
   all sourced to Carla on Sep 8 — and Carla said *"supposed to be 3500"* on Sep 9. The record and
   [[pre-post-hearing-2500-vs-3500]] both say: **never pick one, never rewrite the pinned amount or
   its test** without a worked example.

---

## Tue Sep 9

### The 2026-08-23 week was paid, named badly, and invisible to every money reader · `25a6f677`
> *"Please check - Accounting - Payment Dispatch - Week Selector - is missing last week's HUBSTAFF Report"*
> 16:38 → 17:01 · `438013b6` · routed to **`hardening`**

The week was in the database, paid and locked — 1,101 hour rows, 1,069 dispatches, cycle-complete
fired — under the filename `…_2026-08-23_to_2026-08-29 **(1)**.csv`. The browser's duplicate-download
suffix passes the ingest filename contract (parseable range + Sunday start) and then trips a junk-file
heuristic, `/backfill|time-activity|\(\d+\)|copy/i`, that lives in **four independent copies**: the
dispatch week selector (the reported symptom), `seedMissingDisbursementRecords` (so the week seeded
**0 of ~1,100** records), the CEO financial timeline and the People payroll history. Nine days invisible.

Kane approved the rename. The session did **not** use the wizard's rename button — it migrates only
`payroll.wizard.final_pay.<file>` and would have stranded six other filename-keyed settings, replaying
the week with no additions and **FX 0** (the backup shows the real rate was ₱62.38). The new
[scripts/rename-hubstaff-source-file.mts](../../scripts/rename-hubstaff-source-file.mts) discovers every
`app_settings` key ending in the old name rather than enumerating them, backs the full restore set up
first, renames `disbursement_records` before `payment_dispatches` (the sync trigger matches on
`cycle_source_file`), and re-seeds **last** so the existing dispatch rows stamp the records paid. Result
against the neighbour week: 1,100 records / 1,051 paid vs 1,070 / 1,023. `csv.rename` audited.

**Kane approved the rename only.** The ingest guard — reject a heuristic-matching name at the same
choke point that enforces the Sunday rule — is OPEN, and so are the four regex copies. Narrowing the
regex is the wrong fix ([[hubstaff-double-ingest-duplicate-batch]]).

Then Kane: *"the missing is 30 - 5."* Aug 30 – Sep 5 is the `is_current` upload and sits in the
**Current week · live** slot, which `PayrollDispatch.tsx:2636` deliberately excludes from PAST WEEKS.
Locked 2026-09-08 by `aliviah@`, **620 dispatches (618 paid, 2 problem)** — versus 1,069 for Aug 23–29.
The session asked what was missing about it; Kane interrupted and asked *"for 23-29 did we do
anything?"* (answer: yes, above, fully reversible). **What "missing" meant is still open** — item 24.

### The Carla/Jackie meeting — processed, verified against code, not committed · `eff439e7` (today)
> *"process this for me please - and please make sure that we get the important part in HRIS"*
> 13:31 → 14:28 · `c2cf2f89` · 47-agent verification workflow; every "current behavior" claim checked in the tree

Full record: [2026-09-09-carla-jackie-employee-surface-and-qc.md](../meetings/2026-09-09-carla-jackie-employee-surface-and-qc.md).
The short version, because the room got three things wrong:

| Said in the meeting | Verified |
|---|---|
| *"It's randomized already"* (QC assignment) | **False.** Deterministic alphabetical round-robin, `qc-db.ts:304-306`; officer #1 gets the alphabetically-first slice of Lead Gen every week — the buddy risk Carla was closing. No Hubstaff join either. |
| *"There's no calendar there"* (employee PAB) | **Wrong.** An HSL-aware PAB calendar ships on Overview and a second in My Hours. Missing: the **drill-in** (the stat cell is an inert `<div>`) and a calendar in the mobile popup. Copy wrong three ways in three places. |
| Leave can't be backdated, so filing is safe | **Picker-only.** No server or DB bound; `today` is UTC. Conclusion still right (approved leave already explains a zero-hours week). **Do not add a hard floor** — Sick and Bereavement are filed after the fact. |

**Approved for build:** exactly one thing — the per-day time-adjustment nudge ([[time-adjustment-nudge-approved]]),
and "red" misses Carla's own zero-hours case. **Rulings:** leave filing stays on
([[employee-leave-filing-stays-on]]); peers see quoted nickname + work email only
([[team-directory-shows-legal-name]] — legal name in five places today, personal email via `??`,
search matches both). **New build, unscoped:** Lead Gen QC paste → Compare → Override + officer
histogram ([[qc-compare-override-paste-format]] — absence is NOT zero; the QC surface has essentially
no doc). **Blocking:** [[pre-post-hearing-2500-vs-3500]]. **Open:** nothing pays a late-granted PAB
([[retro-pab-no-payment-path]]); the gift tracker has no shipped/received state, so chasing Ellie
cannot fix it ([[gift-tracker-no-receipt-state]]). Eleven open questions in § 8 of the record.

Eight of the thirteen surfaces the meeting walked have **no INDEX row** — Profile, Skill Sets,
Badges/Certificates, the employee PAB card, leave filing, the whole QC surface, gift receipt, any
compliance dashboard. The QC surface is the worst: ~7,000 lines with two clauses of written record.

### The audit log gets a governing doc and one registry · `ddf4c790`
> *"Audit Log Mechanism - let us improve this across - Accounting, CEO, HR and Orphanage"*
> 10:49 → 11:30 · `33c5ffd7` · routed to **`hardening`** — `READ none`, then a three-question hard stop, then built

The brief said it plainly: **there was no governing doc for the audit-log mechanism**; the four docs in
the neighbourhood govern *authorization*. The panel, Admin Penny and the write paths each had a private
idea of what an action name meant, and the panel's 14 hand-written predicates claimed **no**
`orphanage.*`, `wizard.*`, `dispatch.*`, `documents.*`, `people.*`, `bank_*`, `ticket.*` or
`time_adjustment.*` row — those were reachable only under "All activity", badge-less.

Now [audit-log.md](../features/audit-log.md) and [[audit-registry-single-source]]:
`src/lib/audit/registry.ts` is the ONE place an action family means something; the panel's filter and
badges and Penny's `search_audit_log` description are **generated** from it, and `registry.test.ts`
source-scans every `insertAuditLog` call site and **fails the build** on an unregistered action.
Actor comes from `auditFrom(request, authz)` — six routes had been taking `edited_by`/`decided_by`
off the request **body** as the actor; that value stays on the row as a business fact and appears in
`details` as a *claim*. Destructive paths audit **first**. The wholesale "Clear log" became a dated
purge with a 90-day floor.

The three hard-stop questions were all answered "recommended path": no wholesale clear; gate the
gift-shipping `PUT`; gate (not delete, yet) the dead `import-daily-report`. Those last two are **2 of
the 6 ungated routes from the security sweep, now closed** — closed *here* because an ungated write has
no actor to record. `import-daily-report` is fetched by nothing; deletion is the right end state and is
Kane's call (`audit-log.md` §8).

### Caching — two stores that decided instead of painted · `4e8590cb` · `f5ad83ab`, then a hard stop
> *"Check all Dashboards from Admin to Employee see what dashboard has no proper Caching Practices"* … *"lets fix this in order and by your best recommendation"*
> 09:41 → 10:59 · `e45b1682` · read-only audit → **`hardening`** → **`blueprint`** hard stop

The audit split "no proper caching" into two opposite problems. **No cache** (Admin — 65 fetches /
36 `no-store`, zero seeding; Orphanage 48/22; Contractor, Tickets, QC Overview) is a speed problem.
**A cache that decides** is a correctness problem and worse than none: the Accounting/CEO/Payroll-Clerk
store had **no identity stamp, no schema version, no age ceiling and no purge function at all**, so
`people:list` / `dispatch:queue` / `overview:payouts` survived `signOut` into the next account; and the
HR store skipped every warm tab's mount fetch on a Realtime justification that did not hold — **ten of
twelve datasets have no subscription**, and `postgres_changes` never reaches the anon client anyway
([[supabase-realtime-anon-rls-dead]]).

`4e8590cb` fixed the second class. The Accounting store now carries the envelope the other stores were
written against — identity + schema v + 12 h ceiling, reads fail closed, all three sidebars remove
`SESSION_EMAIL_KEY` **first** then `clearAllAccountingCache()`; it **self-binds** (its shells render
before identity resolves, so inert-until-bound would silently disable it), and only
`bindAccountingCacheIdentity` purges. HR gained `isHrTabCacheFresh` (30 s) beside `hasHrTabCache` —
*paint* and *may-skip* are different questions — and every revalidate is silent. `f5ad83ab` then wrote
down that the two remaining skip-flag exceptions (Notes FAB lookup lists + CEO snapshot; HR
`orientationAttendance`) are **ratified boundaries, not oversights**, pinned by tests. Docs:
[accounting-dashboard-cache.md](../features/accounting-dashboard-cache.md),
[hr-dashboard-cache.md](../features/hr-dashboard-cache.md); memory
[[accounting-cache-envelope-and-purge]], [[hr-cache-freshness-window]].

Then the session posted a **`blueprint` brief for an Admin store** and stopped, as the skill requires.
Three questions plus a sequencing call — this would be the **fifth copy** of the same cache envelope,
and extracting a shared factory first may be the better order. **Awaiting Kane.** Nothing built. See
[[admin-dashboard-cache-blueprint-pending]] and Open item 20.

### Impersonation — Kane's ruling, and a brief waiting on three answers · no commits
> *"How are we on the Super-admin impersonation…?"* → *"I dont want the super admin to have password anymore i Just want it to where anyone with admin provisions in HRIS can impersonate anyone through the Admin - Global Master List"*
> 09:23 → 09:40 · `4b3331cb` · status answered from the tree, then **`blueprint`** hard stop

The status answer was **nothing has changed** — checked in the working tree, not memory:
`auth-options.ts:44-45` unchanged, password absent from `.env.local` so the literal runs, form still on
public `/login`, no auth commits since the finding. And the design Kane was asking about does not exist
in any form — no allowlist, no provisioned-admin check; `authorize()` has no prior session to consult.

Kane's ruling turns this from "harden the backdoor" into "delete the password path and move
impersonation behind an admin session, launched from the GML drawer." The brief names the precedent
(the Force-logout button one section over, `app/api/auth/force-logout/route.ts`), pins the audit action
name (`auth.impersonation.signin` — Penny's family list hard-codes it), and stops on:
**Q1** gate mechanism — (A, recommended, no migration) the `impersonate` provider decodes the caller's
own session cookie and demands role `admin`; (B) a single-use 60 s ticket table. **Q2** exit path —
sign out and re-Google, or a "Return to my account" cookie. **Q3** may an admin impersonate another
admin / CEO / Kane — impersonation inherits the *subject's* allow-listed access. Two Kane-only deploy
steps regardless: **rotate `NEXTAUTH_SECRET`** (deleting the provider does not kill minted JWTs) and
**check prod first** (`vercel env ls`). Open item 1.

### Reports tab search — display only · `0573d834`
> *"Payroll Wizard - Reports - lets add a search bar in here please"*
> 09:25 → 09:32 · `11011fc4` · routed to **`hardening`**

Seven minutes, and the brief is why it was safe: it cited *a filter never hides a row*
([[dispatch-log-department-filter]]), *exports reconcile from their own columns*
([[payroll-exports-itemized]]), and *Reports rows are the snapshot, never recomputed*. So the search
narrows the step-9 table and **nothing else**: both exports still build from the whole `snap.employees`
(the toolbar says so while a search is active), the cycle Total never narrows (a second, labelled
*Search subtotal* row appears instead), a payee with no department matches `no department`, and the
needle clears on every period switch. [[wizard-reports-search-display-only]].

### The Sep 9 log, and the ₱231,900 question · `362624c3` · `75d50864`
> *"Check the last 15 Claude sessions and update our documentations…"* → *"How about the HSL Medical Records"*
> 08:58 → 09:16 · `29264e47`

The previous pass in this chain. Its durable output beyond the log: [pre-release-security-readiness.md](../features/pre-release-security-readiness.md)
(the Sep 8 sweep's findings, which had lived only in a transcript), and the correction that the
`medical_records` portal-login rate is **not a doc typo** — `schema.ts:196` pays ₱100 while the doc
*and* Kane's own worked example in memory say ₱250; 1,546 units, 33 people, 8 weeks, **₱231,900**
between the two readings. Open item 7b; Kane's call.

---

## Thu Sep 10 (later)

### The COE states the profile role and the bonuses earned over the last 4 pay cycles · `47232941`
> *"Employee - COE - Add role to the COE Request - if only they put the role in their profile we can pull it as well. And also for the bonus where all the last 4 payroll cycles bonuses are added and be put into the COE"*
> session `91c49a23` · routed to **`hardening`** — brief cited nine rules, zero contradictions, two money-path GAPS decided in the brief and written into the doc

Both new facts are **optional** — absent, the certificate reads byte-for-byte as before, no dash, no
new refusal code (the refuse-rather-than-blank rule is for facts the certificate MUST state). The role
is the employee's own Profile → Skill Sets entry (`employee_skill_sets.role_title`, read by WORK
email); the check against a joke title is Accounting seeing it on the card and the real PDF before
signing. The bonus line sums the **Attendance + Technology + Performance lines of the worker's own
statements** over their 4 most recent COMPLETED Sunday–Saturday weeks (in-progress week excluded;
"earned", not "paid"; never Adjustment / Orphanage / MESA; real count under four; zero completed
weeks ⇒ row omitted).

Two things worth the record. **The statements are read through ONE assembly**: the paystub route's
all-weeks mode moved verbatim (diffed) to `src/lib/payroll/employee-paystubs.ts`, so the certificate
carries no second copy of the recovery arithmetic and `paystub-dispatch.md` now names that module as
the one reader of `paystub.recovered.*`. And **the one-page constraint broke on the first run** — the
two additions cost 28pt against 34 of slack — and was recovered from whitespace only; the renderer
now reports its layout budget (`onLayout`) and the worst-case test pins **slack ≥ 24pt**. Probed
read-only against live data for six recently-paid people: every total matched the newest four
statements exactly, and a July hire's 12-week window had to be **clamped to the start date** (five
pre-join weeks each ran the whole-company engine — 45 s → 4 s). Doc: `documents-tab.md` § Role and
recent bonuses. Memory: [[coe-role-and-recent-bonuses]].

**Follow-up the same evening — "in the VIEW and Employee Dashboard even when signed it is not
there" / "harden it".** Kane's 17:14 request carried both additions on its draft; the copy signed
at 17:15 had neither — and also the OLD whitespace, which only the layout constants set. The sign
route's compiled chunk on disk is stamped 17:17:15, two minutes after the signature: the dev server
(up since 09:10) had recompiled the request route at 16:57 but kept serving the pre-change module
for `accounting/documents/[id]` until Turbopack rebuilt it. Not a code path; a stale process.
Hardened anyway, because the same symptom is exactly what a future fork of the sign path would
produce: `coe-request-paths.test.ts` pins two single-argument `resolveCoeFacts` calls and two
`renderCoeDocument` calls in `requests.ts`, no other renderer, and the `recentBonuses: false`
opt-out in Penny's tool only; `coe-document.test.ts` pins both blocks in the SIGNED state. Remedy
for Kane: restart `next dev`, request and sign again.

### The Reports XLSX carries the Time Adjustments columns · committed with this section
> *"Payroll Wizard - Reports - Export CSV - Should have the Time Adjustments Columns please"*
> session `b07137f4` · routed to **`hardening`** — brief cited nine rules, zero contradictions, one
> assumption said out loud (there is no CSV button; the XLSX `Salaries` sheet is the file meant)

The gap the brief found before a line was written: an approved time adjustment SETS a day's hours
and the wizard folds Σ(approved − raw) × regular rate into Initial Pay (`effectiveCalcResults`),
but nothing itemized that delta — not `CalcRow`, not the staged payload, not the final-pay
snapshot, not the export. So an adjusted row exported **Regular + OT ≠ Initial Pay** on the file
Kane reconciles against the Google Sheet, with no column explaining why. Reports rows are the
payload, never a recompute, so the fix is staged rather than computed at export time: every
effective row now carries `timeAdjustment`, every payload `time_adjustment { hours, pay_php, days }`
(zeros when none — a blank cell means "predates the block", a zero means "checked, none"), every
snapshot `timeAdjustmentHours` / `Pay` / `Days`, and the shared builder emits **Time Adj. Hours /
Time Adj. Pay / Time Adj. Dates** between OT and Initial Pay with a third identity in its test
guard, `regular + ot + timeAdjustPay = initial`. `Hours` stays raw tracked. `overlayReplayFinal`
applies the saved delta as a unit so a replay shows it as paid. PDF (704pt budget), on-screen
table and every peso of pay unchanged; `tsc` clean; suite 2830/2832 — the 2 failures are the
pre-existing dept-label and hours-gallery source sweeps, in files this commit does not touch.
**Finding, not fixed:** the
paystub's earnings lines still hide the same delta while `final` includes it — item 32. Doc:
`payroll-wizard-final-pay.md` § 2026-09-10. Memory: [[wizard-reports-time-adjustment-columns]].

---

## Open items

Carried forward from the Sep 9 log and **re-verified 2026-09-10** unless marked otherwise. Items 1–18
keep their Sep 9 numbers; 19+ are new.

| # | Item | State |
|---|---|---|
| 1 | **Impersonation backdoor is live** | Re-verified in the tree: `auth-options.ts:44-45` unchanged, `.env.example:69` uncommented, no `SUPER_ADMIN_*` key in `.env.local`, form on public `/login`. **Kane ruled 2026-09-09: no password; admin-session impersonation from Admin → GML.** Blueprint brief posted (`4b3331cb`), **waiting on Q1 mechanism / Q2 exit / Q3 admin→admin.** Then rotate `NEXTAUTH_SECRET`; check prod env first. **BLOCKING the EOM release.** |
| 2 | **Ungated API routes** | **2 of 6 CLOSED** in `ddf4c790` (`employee-gift-shipping` GET+PUT, `import-daily-report`). **4 open:** `manager/member-monthly-pay` (anyone's pay — first), `hr/fpu-enrollments`, `hsl-bonus/period-summary`, `presence/last-seen`. Helpers exist; wiring. **BLOCKING.** `import-daily-report` should be deleted, not just gated — Kane's call. |
| 3 | **`SHOW_UNPAID_STAGED_PAYSTUBS = true`** | Unchanged (`paystub/route.ts:68`). Sits in exactly the Employee surface Carla calls the remaining 15%. Kane's decision. |
| 4 | **No security headers** | Unchanged — no `headers` block in `next.config.ts` or `vercel.json`. |
| 5 | **"Last signed in" — (a) or (b)** | Untouched. Decision owed (see Sep 9 log item 5 for the two shapes). |
| 6 | **`gracechellem@` back-date** | **STILL NOT DONE — re-probed 2026-09-11 (3rd time).** `employee_rate_history` holds ₱175 eff **2026-09-08**, ₱175 eff **2026-09-01**, and ₱235 eff 2026-07-20 ×2. **No `eff 2026-08-30` row.** Her 08-30→09-05 `disbursement_records` row stands at **40.35 h, ₱7,520.88, status `problem`** — vs **₱7,091.88** flat at ₱175; the **₱429.00** gap is exactly 7.15 h × ₱60 (Mon 08-31 priced at the old ₱235). **Not a bug — a wrong effective date**: carla@ saved ₱175 on a *Tuesday*. Click-path: Payment Catalog → Pay Structure → Lead Gen → her ₱175 override → Edit → Effective from `2026-08-30` → Update (it **supersedes**, sweeping the stray 09-01 and 09-08 rows), then re-lock 08-30→09-05 or the record keeps the old money. **The Offboarded tab's orange Set rate cannot do this** — it sends no effective date and the route defaults to today, which is why Carla's two clicks produced two useless today-dated rows. [[readiness-setrate-cannot-backdate]] |
| 7 | **HSL items that need Carla** | Not re-verifiable from the repo: PURPLE re-saves for `jennylynf@` + `rockym@`; `emss@`'s monthly box. And the now-automatic bonuses must not also be typed into Adjustment. |
| 7b | **`medical_records` portal rate — ₱231,900** | Unchanged: `schema.ts:196` still `rate: 100`. Needs one worked example. **Do not change the rate either way to close it.** |
| 7c | SSD Medical Records auto-dispatch | Fixed and verified 2026-09-09; not re-checked today. |
| 8 | **~~Bonus Library migration~~ APPLIED 2026-09-11** | Kane approved the write; `scripts/apply-bonus-history-migration.mjs` ran against the session pooler. **Verified independently through PostgREST with a clean negative control:** `bonus_catalog_bonus_history` **49 rows** (one baseline version per bonus), `bonus_catalog_assignment_history` **26** (one `added` event per assignment), `bonus_catalog_bonuses.version` and `.effective_from` both present, **0** bonuses and **0** assignments without history. The surface is live, not half-dead, and the row on the Monday board is **no longer blocked** (5 SP). The DISPLAY/AUDIT-ONLY ruling is unchanged — the calculator still pays the LIVE definition. **The probe gap that hid this is STILL OPEN:** `audit-pending-migrations.mts` does not probe these four objects, so its "0 NOT APPLIED" was silent on them — the same silence that hid #88/#89. Add the probes. [[bonus-library-versioned-history]] |
| 9 | **~~`angelicac@` transfer backfill~~ APPLIED 2026-09-11** | Kane approved the write; `--apply` ran. All five guards passed against live data first and a JSON backup was written before any write (`references/backups/angelicac_transfer_backfill_2026-09-11T10-39-27-891Z.json`). **Verified independently through PostgREST:** `global_master_list` reads **`hsl:collections`** (the value 30 peers already carry), `department_transfer_requests` **fb10af2c** is `applied` with `sheet_synced: true` and `effective_date` **2026-06-22**, the Sheet cell at row **530** reads the target, and `audit_log` holds one `transfer.backfilled` event naming the backup (negative control on a bogus action returns 0). **Notifications deliberately NOT sent** (`--notify` off by default) — say the word if she should be told. Monday row **no longer blocked** (2 SP). **Still open, out of scope by design:** her Payment Catalog row stays keyed to the deleted parent `hogan_smith_law`, and the first paystub to carry the new department is the first cycle LOCKED after this — paid stubs stay frozen. [[angelicac-dept-never-transferred-in-hris]] |
| 10 | **82 duplicate paid rows** | **CLOSED on Sep 3, undocumented until today.** Paged count 2026-09-10: 9,643 paid rows, **1** email+file key with two paid rows (the `alonzos@` divergent pair the script leaves alone by design). Three `references/backups/dedupe-payment-dispatches-*.json` from Sep 3 12:31–12:54. **Confirmed in `audit_log`: 82 `payment.undone` events tagged `duplicate_paid_row`, 2026-09-03 16:54–16:55 UTC (12:54 ET) — the `--apply` ran that afternoon.** Only `alonzos@` (two Hurupay txn ids 82 s apart) is left to verify in Hurupay. |
| 11 | **MESA close-out doc** | Carried, untouched: `accounting-mesa-export.md:42` still never says a closed account's balance is released as an obligation. |
| 12 | **Orientation no-shows → Offboarded** | Carried, untouched. Kane's call. |
| 13 | **Pay Processors → Payment Dispatch** | Carried, untouched. |
| 14 | **Orphanage interns migration** | `audit-pending-migrations.mts` run 2026-09-10: **26 APPLIED / 0 NOT APPLIED / 0 INCONCLUSIVE** across everything it probes. It does **not** probe the Bonus Library objects (item 8). |
| 15 | **Monday board** | **Pass 26 APPLIED + VERIFIED 2026-09-12** (hash `4dda094a2ea9`, 36 rows, 0 created, 0 sprint moves). **31 Done / 104 SP newly closed** on Kane's explicit, recorded confirmation — asked for twice, quoted verbatim in `pass.mts` and on every row. Completed Dates are each row's last-sha commit date, git-enforced, all inside Sprint 28. **5 held**, of which the pay-cycle celebration is the only one with an OPEN blocker (the n8n import — Kane hit a conflicting webhook-path dialog 09-11, unresolved). Pass 25's 31-entry ledger was **superseded, not flushed** — flushing Pending Deploy over Done would have undone 28 closures; `flush-pending.mts` now reports nothing pending. `verify.mts` reads **FAIL (17)** and all 17 are item 34, not this write: the pass's own half is clean (every status and date correct, 0 Done rows without a date, rollup 1569/874, relation 284/284). |
| 16 | **`penny` CLI** | Shape only, no brief, nothing built. |
| 17 | **2 pre-existing test failures** | Still failing today: `dept-label-render.test.ts` (raw department cell, `EmployeeIdCard.tsx:205` + `ManagerApp.tsx`) and the Manager Overview gallery hours interpolation. **2,748 / 2,750** pass. Every session yesterday re-proved they fail with its change stashed. |
| 18 | **`MEMORY.md` caps** | **126 lines / 21.9 KB** after this pass (was 108 / 18.5 KB on Sep 9 — the meeting added 11 entries). Under both hard caps (200 lines, ~24.4 KB), **over the file's own <17 KB target** and growing ~3 KB/week. Newest at top per [[memory-index-load-cap]]. ~~A prune is due.~~ **RE-MEASURED 2026-09-11: the prune HAPPENED — 95 lines / 18.1 KB before this session added its one line, 96 / 18.4 KB after. That is 30 lines and 3.5 KB below where this row left it, comfortably under both hard caps, though still above the file’s own <17 KB target.** |
| 19 | **COP rates keyed into the PHP rate column — 3 Colombians** | **Found 2026-09-11** (session `a499eb64`), read-only. Kane: *"I dont believe he has a salary of 15,661.72 dollars."* Correct — and it is **not FX**: `usd_to_php_rate` 62.72 / `usd_to_cop_rate` 3139.99, provenance `live`; every inflated row's implied rate (`amount_php / amount_usd`) is exactly right. `employee_rate_history`, note "Set via Payment Catalog", **carla@simple.biz 2026-08-28 20:08–09, eff 2026-08-23**: arturoa@ ₱225→**22,200**, soniaa@ ₱225→**22,300**, reinelr@ ₱175→**17,300** (~98.8× each — one conversion factor, not three typos); ainsleyw@ 09-01 set soniaa@ eff 09-07 → 22,200. canasm@/juanr@/santiagom@ untouched at ₱175 and sane. The doc's own §0 class (“settlement figure → a PHP column … pays about 68×”), new entry point. **Exposure — NOTHING PAID:** 08-23→08-29 dispatched at `problem` (₱759,980/₱1,016,334/₱746,032); 08-30→09-05 **staged & locked 09-08, not dispatched** — ≈**₱2.63M / $41,968** against their last correct week (08-16→08-22: ₱6,880.88 + ₱9,663.94 + ₱7,495.29 = **₱24,040 / ≈$390**), `amount_cop` inflated in step (arturoa ≈ COP 49.2M). No COP Pay Structure exists (10 non-PHP structures, all USD `us_manager_bonus`); `payCurrency` untouched. **HOLD the 08-30→09-05 dispatch for these three.** **Awaiting Kane/Carla:** is 22,200 (a) a COP rate → ₱443.50/hr, which encodes a ~2× raise, or (b) simply wrong → restore ₱225/337.50 and ₱175/262.50 eff 08-23? **Not picked — the two readings pay different money.** A rate fix alone is insufficient: staged USD is frozen at lock (`mock-queue.ts:771`, `PayrollWizard.tsx:19265`), so both cycles need **re-staging/re-lock**. **Guard gap, open:** `app/api/update-employee-rates/route.ts` validates presence and numeric-ness only — no plausibility ceiling, no WoW alarm; `settlement-currency-surfaces.test.ts` greps the Calculator/Wizard source and cannot see a human keying COP into the rate editor. [[cop-rate-keyed-in-php-column]] |
| 20 | **A close-out’s `byProcessor` counts PAYMENTS, not people — and nothing said so** | **Found 2026-09-11** (per-processor breakdown build), read-only probe of the 3 live close-out records. `Σ byProcessor.count` = **3,112** = `paid.dispatchCount`, while the tab’s headline `paid.payeeCount` = **3,088**. Any surface dividing the processor counts against the unpaid (people) counts produces a **plausible but fabricated** rate — 97.73% for Kolan, ~1pt off the real 98.47%. The new modal names the field `paidPayments`, draws **no per-processor rate**, and shows the 24-row gap; a unit test pins `Σ usd === paid.paidUSD`. **The 24 rows themselves are unexamined**: each is a second paid row for someone already paid that week (retry, correction, or a real double payment) — cf. [[dispatch-duplicate-paid-rows]]. **OPEN: nobody has looked at which 24.** [[cycle-processor-breakdown-modal]] |
| 21 | **A Payment Dispatch "Problem" records no cause, so HRIS-vs-processor fault is underivable** | **Found 2026-09-11.** The close-out’s unpaid payee carries name, email, payeeType, reason, amounts and processor — **no cause, no note, no owner, and no department**, so Kane’s question (*"it could have been the pay processor itself that is the problem not HRIS but it could be something like an HSL mid day shift"*) cannot be answered from stored data. Ruled 2026-09-11: the modal shows **evidence, not a verdict**, and a problem counts as **ours** until something says otherwise; the HSL/department roster join is **out**. **OPEN — needs a brief:** capture a cause code at Problem-time in Payment Dispatch (it moves the dispatch screen, so it needs the full hardening check). Until then every future week is equally unattributable. Live signal so far: **both problem rows in all recorded history are on `wires` (x1153)**, zero on Kolan/Wise/HiGlobe/Jeeves — 2 rows, not a trend. [[cycle-processor-breakdown-modal]] |
| 22 | **Four pay weeks ran outside HRIS, and three of them sit 100% `pending` in the ledger** | **Found 2026-09-11** (trend-chart build), read-only over `payment_dispatches` (10,106 rows) + `disbursement_records` (22,290). HRIS paid ~800/wk for three weeks (period ends **2026-05-31 / 06-07 / 06-14**), then **no dispatch row exists at all** for 06-21, 06-27, 07-04 and 07-11 — four consecutive weeks. The ledger for 06-21/06-28/07-05 is **935 / 972 / 1,009 rows, every one `pending`**; 06-14 shows 880 `paid` with no dispatch rows. Then **2026-07-12→07-18 paid 330 and left 723 pending** — the restart, which Kane remembered as *"we paid like 300 only but stopped"* (it was the restart, not the first week). From 07-19 the series is steady at ~1,007–1,056. **Nothing here is necessarily wrong** — payroll for those weeks plainly happened somewhere else — but the ledger is left asserting ~2,900 people are `pending` for weeks that are long settled, which is the same stale-ledger class the rate rules already quarantine. **OPEN: nobody has reconciled those four weeks.** Now visible on the trend chart as `not_run`. [[cycle-success-trend-chart]] |
| 23 | **The `/employee` "This page couldn't load" black screen is a BROWSER crash, not Vercel — no upgrade is indicated** | **Found 2026-09-11** (session `778c505e`), read-only, from a screenshot Kane sent; his question was *"check if this is a vercel issue if we need to upgrade."* **Answer: no.** `GET /employee` → **307** → `/login?callbackUrl=%2Femployee` in **166 ms**; `GET /login` → **200**, 28,197 B, **220 ms**; `X-Vercel-Id: hkg1::sin1::…` (functions in `sin1` as `vercel.json` pins); **no `x-vercel-error` header anywhere**. A Vercel platform failure always renders **Vercel's own** page with a code + id (`504: GATEWAY_TIMEOUT`, `500: FUNCTION_INVOCATION_FAILED`, `402` on a usage stop) — the screenshot has neither. **And the copy is not ours**: grepping `app/ components/ src/ public/` for "couldn't load" / "Reload to try again" returns nothing, and there is **no `error.tsx`, `global-error.tsx` or `not-found.tsx` in `app/` at all**, so it is not a Next.js error boundary either ⇒ **the tab process died**, which no plan tier changes. Note **prod was not running the current code**: `origin/main` = `bd7f8402` (Sep 10), `main` **15 ahead** — all of Sep 11 was local only. **LEAD, NOT PROVEN (no repro, no console):** `/employee` is **1,110 KB of source across 30 files** with **zero `next/dynamic` and zero `await import()`** in the whole tree (all six tabs in one bundle), `EmployeeApp.tsx:613` renders `Array.from(mountedTabs)` and only **hides** inactive tabs so each keeps its state, payloads and timers for the life of the tab ([[employee-dashboard-reload-cache]], deliberate), and **9 `setInterval`s** run across it incl. a **1-second** clock (`EmployeeMyHours.tsx:336`) — a textbook renderer OOM for a portal left open all day. **Ruled out already:** no rrweb/cobrowse on this surface, and the employee's `hubstaff-hours?source_files=1` returns only a filename list (the heavy path is email-scoped `merge_all=1`), so the **4.5 MB function-response cap** — identical on Hobby and Pro, never an upgrade fix — is not in play. **OPEN, needs Kane:** capture the tab's memory (Shift+Esc / `chrome://system`) as it dies, and whether it needs a long-lived session or crashes on a cold load (cold ⇒ a loop instead, cf. [[manager-time-adjustments-render-loop]]). Code-splitting the tabs is the shape, and it moves a live surface — `hardening` path + brief first, and **nothing gets loosened to make it go away**. [[employee-page-crash-is-browser-not-vercel]] |
| 19b | **… and it is FOUR artifacts, not one** | **2026-09-11, same session.** Kane asked whether the Wizard's USD→COP could fix Dispatch. **Premise false:** the Wizard writes through to the global `usd_to_php_rate`/`usd_to_cop_rate` on every save and `computeCurrentPay` reads those globals — verified identical this cycle (62.72 / 3139.99). No better rate exists to carry across. But the rate is the right tool for the corrupt *figures*. Cross-rate = **50.0636 COP/₱**. All four were created by **carla@ within ~6 minutes on 2026-08-28** and they do **not** share one fix. **(1) `bonus_mtddp1p5rf4hq1rw` "Lead Gen (COP)"**, desc *"COP Lead Gen only"*, formula `=Appts*14000`, created **20:03:25** — its **`currency` is `"PHP"`**, the default never changed. 14,000 ÷ 50.0636 = **₱279.64**/appt vs the PHP "Lead Gen" bonus at ₱250/appt, so the intent is legible. **Fix is unambiguous — set `currency:'COP'`**, exactly what [[settlement-currency-per-person]] prescribed (*"different amounts would need a Payment Catalog bonus with `currency: 'COP'`"*). Applied rows store the peso figure, so the **2 existing applications must be re-applied**: reynellruiz@gmail.com 08-23 ₱14,000→₱279.64, 08-30 ₱28,000→₱559.28 (this is reinelr@'s personal email — the bonus is keyed there, not on his work email). **(2) the 3 hourly rates** (20:08–09) — ÷ 50.0636 gives ₱443.44 / ₱445.43 / ₱345.56 = **1.97–1.98× their old rates**, and the factor actually used at entry (98.7 / 99.1 / 98.9) matches **no rate HRIS has ever held** (cross-rate was **51.11** that day). Numbers came from outside HRIS — **still ambiguous, still not picked.** **(3) arturoa@ `bonusOverrides` = 508,728** in the 08-30 additions blob — ÷ 50.0636 = **₱10,161.63**, and it is the only out-of-family value among **56** overrides (next largest 9,444.25, median 2,500, so **54×** its neighbour). Derivable but hand-typed; Carla should confirm. **The conversion rate is itself a decision and the error direction FLIPS:** for display (₱→COP) a low `usd_to_cop_rate` understates what they see; for this fix (COP→₱) it **overstates what we pay**. At 3139.99 → ₱443.44 / ₱10,161.63 / ₱279.64; at a market ~4,000 → ₱348.09 / ₱7,976.80 / ₱219.50, **−21.5%**. [[fx-no-cross-check-npd-divergence]] already flags 3139.99 as below market. **Nothing written — awaiting (i) the rate to convert at, (ii) the rate-intent ruling.** |
| **19** | **Pre/Post-Hearing ₱2,500 vs ₱3,500** | **BLOCKING, Carla's ruling.** ₱2,500 pinned in `schema.ts:279`, its test, two docs, the Sep 9 log and memory — all sourced to Carla 2026-09-08; she said 3,500 on 09-09. ₱3,500 is also the weekly cap. **Never pick one; never rewrite the pinned amount or its test.** One worked example for one named person for the 08-30 final week settles it. [[pre-post-hearing-2500-vs-3500]] |
| **20** | **Admin dashboard cache — blueprint awaiting approval** | Brief posted in `e45b1682`: Q1 AdminRoles in (rec. IN), Q2 `AuditLogPanel` shared with Accounting (rec. OUT), Q3 shared roster key (rec. shared), **plus the sequencing call** — fifth copy of the envelope vs a shared factory first. Orphanage (48/22) is next. [[admin-dashboard-cache-blueprint-pending]] |
| **21** | **Time-adjustment nudge — approved, not built** | The meeting's only approved build. Resolve the trigger first: "red" is `<7h WITH data`; Carla's failed click was a zero-hours day, which renders sky/orange. A blank cell can also be an ingest artifact (`docs/notes/hubstaff-sunday-overlap.md`). [[time-adjustment-nudge-approved]] |
| **22** | **~~QC assignment is not randomized~~ FIXED 2026-09-10** | Deal is now seeded-random per `(period_start, department)` — `src/lib/qc/deal.ts` over `src/lib/seeded-shuffle.ts`, 9 tests incl. the not-alphabetical regression. Callback left `QC_DEPT_KEYS` (history retained, invisible). The surface got its first feature doc + INDEX row. **Still owed:** Kane unchecks Alivia's `qc` role in Admin (do it before the first Monday read so the officer-set change triggers the re-deal); **Q2 zero-hours eligibility is Carla's ruling, not a cleanup**; **Compare/Override/Undo BUILT 2026-09-10** — TAB-only paste, four buckets with `scored_by`, Override via `setVar` only, in-memory Undo, one audit event; the officer histogram is still a separate brief. Q1 settled by a read-only prod probe: `Appts_Set` (dept) / `Appts` (reinelr@). [[qc-assignment-not-randomized]] · [[qc-compare-override-paste-format]] |
| **22b** | **~~QC migrations #88/#89 were UNMEASURED~~ MEASURED APPLIED 2026-09-11** | `audit-pending-migrations.mts` re-run read-only: **32 APPLIED · 0 NOT APPLIED · 1 INCONCLUSIVE**, with the **negative control clean** (a non-existent table and column both report MISSING), so the report can detect absence and its APPLIED verdicts mean something. All four QC tables exist and are populated — `qc_score_assignments` 8,189 rows, `qc_kpi_submissions` 26, `qc_officer_locks` 1, `qc_review_status` 20 — plus `roster_status` and `current_department`. **The Mon 2026-09-14 deadline risk is closed on the migration side**; what remains for Monday is Kane unchecking Alivia's `qc` role (item 22). The `head:true` probe bug is fixed in the script — existence is now a plain `.limit(1)`. `kpi.published` remains the one INCONCLUSIVE: no row uses the type, so the CHECK is not readable via PostgREST — **not settleable read-only, record it neither way.** [[migration-pending-claims-are-folklore]] |
| **23** | **Hubstaff ingest guard** | Nothing stops the next `(1)`/`copy`/`(2)` filename; the live week `…_2026-08-30_to_2026-09-05 4.csv` survives only because a bare ` 4` does not match. Fix at ingest, never by narrowing the four regex copies. Kane approved the rename only. [[hubstaff-filename-junk-heuristic-hides-paid-week]] |
| **24** | **"the missing is 30 - 5"** | Kane's follow-up, unresolved. Aug 30 – Sep 5 is present in the *Current week · live* slot (excluded from PAST WEEKS by design), locked 09-08 by `aliviah@` with **620 dispatches** vs 1,069 the prior week. Whether "missing" meant the slot, the lock state, or that gap is a question for Kane. |
| **25** | **Retro-PAB has no payment path** | Carla's own unanswered question. A late-granted dispute pays nothing; only the unlabelled Adjustment column is ungated, while the approval notification promises the day "now counts" unconditionally. [[retro-pab-no-payment-path]] |
| **26** | **~~Gift tracker has no receipt state~~ CLOSED 2026-09-11** | `employee_gift_receipts` shipped — keyed on **WORK email** because `personal_email` is not injective on this roster (russell@/johnc@ share `corpuzmachacon@gmail.com`, greyg@ has none), so putting fulfilment on `employee_gift_shipping_details` would have **merged two people's gift history**. Backfilled 1,434 assertions of 9,832 cells: **842 received, 592 owed** — the backlog's first countable number. **8,398 `No` cells against milestones years away were deliberately NOT imported** (spreadsheet default, not a statement). Migration + route + roster control + export columns all shipped, and the **employee card was found telling people a lie** — its green “Received” chip meant `status === 'approved'`, i.e. the ADDRESS was confirmed, so anyone whose address got locked in was told their gift had arrived; relabelled **Address confirmed** (sky) with real **Gift received** / **Gift on the way** chips beside it and a milestone nobody has recorded showing NOTHING, employee read-only; Kane ruled HRIS is the ledger, retiring the Google-Sheet premise in `gift-tracker-shipping-export.md`. [[gift-receipts-ledger]] |
| **27** | **Team directory shows legal names** | Carla's safety ruling; five render sites + personal-email fallback + search. Needs the fallback-token decision and client-vs-server scoping (the manager roster shares the route). [[team-directory-shows-legal-name]] |
| **28** | **~~Eight~~ SEVEN employee surfaces have no INDEX row** | Profile, Skill Sets, Badges/Certificates, leave filing, QC, gift receipt, compliance dashboard. **The employee PAB card got its row 2026-09-10** with the Wave-3 build. Any edit on the rest starts with `READ none`. |
| **29** | **~~8 commits unpushed~~ PUSHED** | Verified 2026-09-10 evening: `origin/main` = HEAD = `a56ce28c`, `git rev-list --count origin/main..HEAD` = 0. |
| **30** | **Employee-surface + QC build plan — awaiting approval** | Session `c2cf2f89`. [implementation-plan-employee-surface-and-qc.md](../implementation-plans/implementation-plan-employee-surface-and-qc.md) sequences items 19–28 into ten `hardening` commits plus a `BLUEPRINT` brief (§13) for the two new surfaces. **Wave 1 is deadline-driven: Mon 2026-09-14**, when Jackie and nine officers test with real data — Callback out of `QC_DEPT_KEYS` (one line, Discovery precedent), Alivia's `qc` role revoked, and randomization written from scratch. **Nine questions outstanding:** Q1 retired-Callback history read path · Q2 zero-hours QC eligibility (**a ruling, not a cleanup** — every comparable predicate fails toward keeping the person) · Q3 nudge on sky "Processing" days · Q4 PAB FAQ explains the derivation vs prints Accounting's saved window · Q5 `formatStartDate` off-by-one in scope for the Profile merge · Q6 directory fallback token (**blocks Wave 6** — the derived go-by renames *Jane Marie Santos* to "Marie") · Q7 Award/Certificate leaves the employee picker · Q8 Skill Sets cap shape (**a cap of 10 on Current projects would loosen an existing cap of 2 — cannot ship**) · Q9 the QC test day, since the transcript cuts off mid-answer where Jackie raised her Monday training. Item 19 stays untouched by the plan. **Later 2026-09-10:** Kane approved and the session shipped `15dbd67f` (PAB copy + drill-in), `8ab5dcdb` + `9841c4c9` (Time Adjustments rename + nudge), `aa48e39d` (QC Wave 1), `2e56b84e` (Compare/Override/Undo), then the score-ahead build (row 31). The rest of the plan stays open. |
| **31** | **`kpi.published` ALTER — APPLIED** | Session `c2cf2f89`, built 2026-09-10 with the score-the-upcoming-week feature (`hsl-kpi-calculator-2026-07.md` §Scoring the upcoming week). Kane ran `node scripts/apply-kpi-published-notification-type.mjs` the same day; `--verify` on a fresh connection shows `'kpi.published'` in `employee_notifications_type_check` (45 types, superset intact). **First real insert still unproven** — the next Mark Ready / Lock on any dept-week is the proof; a missing Accounting card means read `audit_log` for `notification.insert_failed` first. |
| **32** | **Paystub earnings lines hide the time-adjustment delta** | Found 2026-09-10 while adding the Reports columns (session `b07137f4`): `effectiveCalcResults` folds Σ(approved − raw) × regular rate into `initial`, and `final` includes it, but `PayStubStatement` renders Regular (hours × rate) and OT lines only — no line for the adjustment, so an adjusted statement's lines do not sum to its total. The payload now carries `time_adjustment { hours, pay_php, days }` and the snapshot `timeAdjustmentHours/Pay/Days`, so the statement has the figure to render; rendering it (and the n8n email template) is its own `hardening` pass — PAID stubs are frozen as-paid, so only unpaid/new stubs would gain the line. The Reports PDF omits the three columns by its 704pt budget (documented in `payroll-wizard-final-pay.md` § 2026-09-10; not a defect). |
| **33** | **~~Lawang rate shadow `--apply` is blocked~~ FALSE — it ran 2026-08-18** | Found 2026-09-11 while checking which board rows were genuinely finished. Read-only probe: `payment_catalog_pay_structures/pay_mse34sctiw8xsiio` reads **225 / 337.5 / `hogan_smith_law`**, `updated_by: fix-lawang-rate-shadow.mts` at **2026-08-18T20:09:14Z** (created 2026-08-04 by `jakec@` at 175 / `lead_gen`); `employee_rate_history` holds the matching **225 row effective 2026-08-16** with the same `created_by` at the same second; the sheet mirror `03b7882a-…` reads 225 / 337.5. All three of the script's declared steps landed. Both `hris-plan.ts` and [[lawang-rate-shadow-duplicate-identity]] had said "`--apply` BLOCKED — NOT YET RUN" for three weeks, and the Monday row sat **Ready to Start** on that claim; both corrected, and the row closes Done in pass 25. **Still open and not closed by this:** merging the two Lawang master rows, and the **five employees who still hold a bare-`hsl` employee-scope override** — re-measured present 2026-09-11 (`glendac@`, `domv@`, `beao@`, `joee@`, `jesr@`, untouched since the "rate-divergence fix 2026-07-29" that seeded them). Same lesson as items 6, 10 and 22b: **probe, do not carry the claim.** [[migration-pending-claims-are-folklore]] |
| **34** | **Gift receipts: no ask path for the 592 owed** | **Found 2026-09-11.** The backlog is now countable but **not collectable**: the employee shipping form only ever asks for the LATEST milestone and freezes earlier ones read-only, so none of the 592 owed gifts has an address-collection route. The form also still gates on pure tenure arithmetic and knows nothing about fulfilment — wiring it needs a ruling first, because the export's `Current Milestone` and the employee's own form must never disagree. No delegated `hr / gift_tracker` grant exists either, so only full-grant staff can record receipts. **OPEN — needs a brief.** [[gift-receipts-ledger]] · [[gift-tracker-no-receipt-state]] |
| **35** | **A migration SQL file carrying `BEGIN`/`COMMIT` defeats its own dry run** | **Found the hard way 2026-09-11.** `apply-gift-receipts-migration.mts` opens a transaction and rolls it back on `--dry`; the SQL file's own `COMMIT` ended that transaction **from the inside**, so the rehearsal **committed the table to production** and the script's `ROLLBACK` had nothing left to undo. Caught immediately (table was empty), dropped, SQL fixed, rehearsal re-run and the rollback **proven** (table absent afterwards), then applied properly. Every sibling under `references/sql/migrate/` omits them for this reason — but **nothing enforces it**, and the next migration author gets the same silent write. **OPEN: add the check to the apply-script template.** [[gift-receipts-ledger]] · [[migration-apply-needs-database-url]] |
| **36** | **43 gift address submissions were deleted** | **2026-09-11, Kane's ruling (brief Conflict 3a) — done, recorded here because it is not reversible from the app.** 42 pending + 1 approved, all 43 carrying a submitted delivery address. Backup written **and read back to verify** before the delete, full snapshot into `audit_log` (`employee_gift_shipping.period_cleared`) **before** it, restore file `reports/gift-shipping-submissions-backup-*.json`. Cost: every export row now falls back to the master-list home address (`Address Source` never reads `Submitted`), off-roster submitters vanish from the appended block until people submit again, and the one approved row's lock is gone. **No fulfilment was lost** — it lives in a different table. |

| **37** | **The NPD Lead-Gen-vs-HSL mismatch is `markm@`, and no self-serve surface can fix it** | **Found 2026-09-11** from an accounting chat Kane pasted (Carla T / Alivia H: *"two problems left on the NPD… someone who transferred to hsl and then quit… you need Jan Kane"*). Read-only probe names him: **`markm@simple.biz` — Macasinag, Mark Randy "Randy"**, offboarded **2026-09-11 14:19 UTC**. `global_master_list` reads **Lead Gen** with **zero `department_transfer_requests` rows**, while HSL's own side says otherwise three ways: ₱225/337.50 **eff 2026-08-09** (alissar@, "Set via Payment Catalog"), an employee-scope catalog row keyed **`hogan_smith_law`**, and `hsl_bonus_entries` scoring him **`intake_specialist`** for 08-16 (₱750, carla@), 08-23 and 08-30 (₱0, aliviah@). `hsl_team_members` lacks him, but that table has not been written since **2026-07-09** — before his move — so its silence is not evidence. Exact repeat of item 9. **The rate is NOT the defect and must not be touched:** ₱225 has been right since 08-09 (employee-scope override wins regardless of master dept) and his **OT is 0.00 h every week**, so the HSL 0.5× differential never bites — this is a **bucketing** divergence against the NPD sheet, not a per-peso one. Live money: 08-30→09-05 = **23.24 h, ₱5,280.15, `pending`** (still movable); 08-23→08-29 paid at ₱5,173.06 and frozen. **aliviah@ clicked Readiness → Set rate at 14:40 and wrote ₱225 eff 2026-09-11 — the rate he already had.** Set rate has **no department write at all**; item 6's defect and this one are the same dialog. **`scripts/backfill-angelicac-transfer.mts` cannot be reused:** **G2 dies** on `active.length !== 1` (he is offboarded) and **G5** wants the stale HSL roster. **Both guards are correct — do NOT loosen them to make him fit**; an offboarded backfill is a different shape and needs its own `hardening` pass. Fix per [[hris-is-dept-source-of-truth]] is an HRIS transfer Lead Gen → `hsl:intake_specialist`, never a sheet edit. **VERIFIED 2026-09-11 — there is NO in-app fix, all three paths are closed:** (a) filing a transfer is useless because `applyApprovedTransfer` **auto-cancels** anyone not on the active roster (`apply-transfer.ts:80-88`, "off-boarded or email changed"); (b) the People profile `PATCH` cannot do it either — `updateMasterListProfile` refuses off-boarded rows outright (`master-list-profile.ts:172`, *"Employee record not found (or off-boarded)"*); (c) Set rate writes rates, never departments. So this needs a **script with an `--apply` gate** — a NEW script, so `blueprint`, not a loosened copy of the angelicac one. **Ask the money question first:** his rate is already right and his OT is 0.00 h, so a transfer moves **no money** — it fixes the NPD bucket and a department label on a frozen stub. Whether that is worth a script is Carla's call, not a default. **OPEN — awaiting Kane.** [[markm-hsl-transfer-never-filed]] |

| **38** | **Item 6's click path survives the Payment Catalog offboard filter — and her start date is garbage** | **Verified 2026-09-11** while checking whether Kane can actually perform item 6. The catalog hides 178 off-boarded people ([[payment-catalog-hides-offboarded]]) and `gracechellem@` left on 2026-08-09, so the documented click path was in doubt. It holds: `offboardedEmails` filters **`visibleRoster`** only — search, pickers, headcounts, spend — and is passed to `PayProcessorsTab` alone; the Pay Structure tab renders **existing override rows from the structures data**, deliberately, because *"filtering the name map too would turn an existing rate row into a bare email address"* (`BonusCatalog.tsx:695-703`). Her ₱175 row stays listed and editable. **But the data underneath is bad:** her **Lead Gen master row carries `Start Date` 2026-08-24 while she was off-boarded 2026-08-09** — she "starts" 15 days after she left — and her second row reads `06/22/26` (`offboarded_sheet` says 2026-06-22). Guard 2 of `isOffboardedForPaymentCatalog` is exactly `offDate <= startDate`, so **which duplicate row wins decides whether she is visible at all**; HSL wins the tie ([[duplicate-master-rows-hsl-tiebreak]]). Not blocking today's fix, but this is a guard one bad cell away from flipping. [[readiness-setrate-cannot-backdate]] |
| **37** | **~~13 stranded gift receipts~~ IT WAS 15, AND THE FIX HAD THE SAME BLIND SPOT** | **Found 2026-09-11** from Kane's report that `lennyt@simple.biz` showed the wrong data. The sheet and the ledger were both RIGHT — she holds 5 received + the 2026-04-10 miss — but the backfill matched on `work_email` ALONE, so people whose sheet spelling differs were stored under an address the roster never looks up, and the tracker rendered them **"Not recorded"**, the state meaning *nobody has assessed this person*. A silent failure that reads as its own opposite. The first audit found 13; an adversarial review found **2 more the audit's own test could not see** — `teodya@` (Teody Amaro, active at `james@`) and `mat@` (Maria Fe Tanjusay, active at `maria@`, **both rows owed**) match tier 1 against a **GHOST** master row (216 rows are in `global_master_list`, absent from `active_employees`, with no off-board date), so nothing falls through. **15 people / 58 rows.** Resolver shipped (`roster-match.ts`, 42 tests): work_email → **employee_id** → alternate work email → name AND start date, every tier exact, ambiguity falls through to a **stricter** key only, ghosts yield to the live row. Repair script MOVES rows (preserving provenance), refuses on ambiguity and collision, dry-run clean at **15 keys / 58 rows / 0 refusals**. **Adversarially verified: 0 refutations of 39 votes.** [[gift-receipt-key-drift]] |
| **38** | **`johnc@simple.biz` has 6 correctly-keyed gift receipts the tracker could never show** | **Found 2026-09-11.** `GiftTracker` deduped roster rows on `personal_email ?? work_email`, which is **not injective** — `johnc@` and `russell@` share `corpuzmachacon@gmail.com` — so whichever `/api/employees` returned second was silently removed from the roster entirely, and **which one vanished was not stable across loads**. `shipping-export.ts` had the identical defect, so the file dropped them too. FIXED: dedupe identity is now the WORK email (unique per person, and what the ledger keys on); the notes/shipping key stays personal-email because those tables key on it. Two tests pin it. The migration comment already cited this exact pair as the reason the STORAGE key is work email — and the DISPLAY key had gone back to personal email anyway. [[gift-receipt-key-drift]] |
| **39** | **`warren@simple.biz` holds a LIVE un-revoked manager role for a person who is `warrens@simple.biz`** | **Found 2026-09-11** by the completeness critic sweeping every `work_email` column for the gift-tracker drift signature. Verified directly against production: `employee_roles` has `warren@simple.biz` / `manager` / `assigned_by carla@` / **`revoked_at: null`**, plus **21 `employee_feature_permissions` rows**, while **Seguis, Warren** is on the active roster as `warrens@simple.biz` (10 permission rows) with `warren@` as his alternate. Auth survives by accident — `auth-options.ts` runs `expandWorkEmailAliases` before reading roles — but `hr/offboard-rbac.ts:135` revokes with a single-address `ilike`, so **offboarding him at `warrens@` would leave the `warren@` grant standing forever**, and `contractor-dispatch-queue.ts:570` / `documents/requests.ts:552` read the raw address as a NOTIFICATION RECIPIENT. *"Is this person a manager"* currently has two answers depending on which code path asks. The same signature is live in 9 tables (`employee_skill_sets` 6 of 45 keys, `employee_ids` 10, `bank_update_history` 4, `offboarded_sheet` 4, …). **OPEN — Kane's call, grants are admin-only. NOT touched.** [[gift-receipt-key-drift]] · [[audit-registry-single-source]] |
| **40** | **The gift ledger answers for the PH roster only — 57 active people, 365 unassessed milestones** | **Found 2026-09-11.** **211 active roster rows have no sheet row at all** (not by work email, alternate, or name+start-date) because the source file is literally *"HRIS Active Ppl"*; **57 of them have a milestone already due, 365 in total with zero assertions** — the whole US/leadership/freelance side, including the people who commissioned the tracker (Thomas Arndt 17 due, Carla 10, Jackie 9). They correctly read *Not recorded*, but re-keying 15 people does not change that shape. Separately **16 owed gifts sit on 9 offboarded keys the tracker structurally cannot render** — the import deliberately kept leavers *because* "a person who left owed a gift is exactly the case the tracker could never see", and then the roster being `active_employees`-only rebuilt the blind spot. And **18 people have due milestones past the sheet's 48-month ceiling** (56 total; the highest index in the ledger is 7). **OPEN: needs a second source or an explicit out-of-scope marker, not a re-key.** [[gift-receipt-key-drift]] |
| **41** | **The master-list sync overwrites `Work Email` in place, so key drift recurs silently forever** | **Found 2026-09-11.** No history, no `audit_log` row for any work-email rename (live example: `anonuevojo@` → `anonuevoj@` on 2026-08-03), and **nothing constrains `employee_gift_receipts.work_email` to a master row** — no FK, no trigger, no scheduled detector. So every address change re-creates this class, and the symptom is again "Not recorded", i.e. invisible. `scripts/audit-gift-receipt-key-drift.mts` is the detector but it is a manual run needing the CSV. Also latent: **25 work emails have been held by two different humans** (`jamesc@` = Ceballos + Chan, `josephr@` = Robles + Ramos, `rodneys@` = two Sarmiento brothers …) and `employee_gift_receipts` is `UNIQUE (work_email, milestone_index)` — no receipts sit on a recycled address today **purely by timing accident**; only two of those addresses have a holder past six months' tenure. The resolver now refuses rather than picking, which makes it visible instead of wrong. **OPEN.** [[gift-receipt-key-drift]] |
| **42** | **Gift Tracker caching — the 5th bespoke store, and the sequencing call is still Kane's** | **2026-09-11.** Kane: *"add proper caching practices in here where we don't have to always refresh and hit the database"*. Shipped `src/lib/orphanage/tab-cache.ts` (12 tests) on the **PAINT vs SKIP(30s)** split from the HR store — `has*` decides the skeleton, `isFresh*` decides the network, and collapsing them is the 2026-09-09 HR bug. In-memory ONLY (no identity stamp, safe solely because it dies with the page; a test greps for `sessionStorage`). Every write invalidates the surface; Refresh drops the cache first. **But `admin-dashboard-cache-blueprint-pending` reserves a decision for Kane**: this is another copy of the same envelope, and the open question was *fifth copy vs extract a shared factory first*. This one deliberately sidesteps the sessionStorage envelope (nothing persisted ⇒ no identity stamp needed), so it is not the Admin store the brief is about — **but the factory question is now more expensive, not less.** [[admin-dashboard-cache-blueprint-pending]] · [[hr-cache-freshness-window]] |
| **43** | **Two tests are RED on `main`, and neither is in today's diff** | **Found 2026-09-11** running the full suite after the People bank-card work: **3,012 of 3,014 pass, 2 fail.** (a) `dept-label-render.test.ts` — *"no component renders a raw department cell to a human"* names `EmployeeIdCard.tsx:205 {card.department}` and `ManagerApp.tsx:1669 {dept || 'No department'}`; both should go through `formatDeptLabel` ([[dept-label-display-sweep]]). (b) `manager-time-adjustments-live.test.ts:196` — *"hours are never interpolated raw into the shell gallery"*, the Overview gallery is not formatting its hours ([[manager-time-adjustments-workspace]]). `git status` confirms **none of the four implicated files is modified** in this session, so both predate it. They were not introduced here and were not fixed here — a red suite is how the next real regression gets waved through. **OPEN.** |
| **44** | **Three live bank spellings the declared table plausibly covers but does not claim** | **Found 2026-09-11** while measuring bank-logo coverage for the card (read-only probe over 2,065 `employee_ids` rows). On the PAID slot: **765** resolve to a bank with a shipped logo, **162** to a declared bank that deliberately ships none (MariBank 104, Metrobank 31, Security Bank 16), **14** are unmapped, and **1,124** have no bank on that slot at all. Of the 14 unmapped, **8 are a person's NAME** typed into the bank field (correctly flagged, never guessed) — but three look like ordinary spellings of banks already in `OFFICIAL_BANKS`: **`CIMB Bank`** (1), **`Philippines National Bank`** (1) and **`GoTyme Bank, Inc. (GoTyme Bank Corporation)`** (1). Adding each is a **declared claim** and needs `scripts/audit-bank-spellings.mts` re-run before and after, per `payment-catalog-current-banks.md` §2 — **none was added**, because guessing is the invented equivalence §10.1 forbids and this was out of the card's scope. **OPEN — a 10-minute job for whoever next touches the alias table.** [[people-bank-card]] · [[payment-catalog-current-banks]] |
| **45** | **12 of our epics were DELETED from the shared Roadmap board** | Found 2026-09-12 when `review.mts` reported `epics to create: 12` where pass 25 had reported 0. Measured directly with proper paging (3 pages x 100, so **not** the 25-item `items(ids:)` cap): Roadmap & Epics has gone **295 items / 37 ours -> 239 / 25 ours**. ~56 items removed board-wide, 12 ours, all confirmed ABSENT by name: **HRIS-01, 01a, 02a, 06, 08, 12, 14, 16, 27, 28, 31, 32**. The board is SHARED; likeliest cause is another team's cleanup. **DO NOT run `apply.mts` on the full path until this is settled** — the reconciler would mint 12 duplicate epics and rewrite the epic relation on all 284 tasks. `--only-new` returns before phase 1 and is safe. Collateral already visible: 16 tasks now read "not linked to an epic", and the project rollup is computed from epic status so it is no longer trustworthy. **Kane's call: restore them, or re-point the plan?** |

**Closed since the Sep 9 log:** the 82 duplicate paid rows (item 10 — closed on Sep 3, discovered today);
2 of 6 ungated routes (item 2); the Sep 9 meeting record is committed; every memory written on Sep 9
has an INDEX wikilink; the three new feature docs have README rows.

---

## Conventions this window confirmed

- **The doc-check works on code edits and fails on everything else.** Five of five code sessions read
  the docs first; the meeting, the status question and both hard-stopped briefs left nothing durable
  until today. `CLAUDE.md` now says what a no-code session owes, and where a status answer starts.
- **Verify, never relay.** Two Sep 9 open items were wrong in opposite directions — one recorded as
  done that was not, one recorded as open that had been closed six days earlier. "Applied" is a
  database fact; "committed" is a `git log` fact; a memory hook is a pointer.
- **`READ none` is a result, and it produces a doc.** Three surfaces got their first governing doc
  yesterday because the skill made a session say out loud that none existed.
- **Refusing to sweep another session's work is right, and it has a cost.** Two sessions correctly left
  the dirty `INDEX.md` alone; one therefore shipped without its own wikilink. The fix is to commit
  promptly, not to sweep.
- **Name the artifact.** "The missing is 30 – 5" is ambiguous between a selector slot, a lock state and
  a dispatch count — the same ambiguity that caused last week's PAB revert.
- **A data change to production ships with its restore set.** The rename backed up five stores and
  seven settings before writing, and said so in the commit.
