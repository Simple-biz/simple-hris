# Session Log — 20 Recent Claude Sessions (Jul 21–23, 2026)

Reconstructed from Claude Code session transcripts. Covers the 20 most recent
working sessions (Jul 21 evening – Jul 23, 2026, UTC), grouped by day, newest
first. Each entry lists what was asked, the commit(s) it produced, and an effort
size (assistant-turn count as a rough proxy for depth).
Continues [audit-2026-07-17-session-log.md](./audit-2026-07-17-session-log.md).

> **Read this first — the deploy pipeline was stalled for most of this window.**
> Around 08:00 UTC on Jul 22, Vercel **stopped cutting Production builds from
> `main`**; Production sat frozen on `0e1c362` ("MESA -") for ~9 hours while
> ~29 pushed commits — including everything below marked "pushed" — never built.
> This produced a run of "the change is on localhost / on GitHub but not on the
> live site" reports (sessions `d04e388a`, `a10741f5`, and the "buckets" arc of
> `5b35f451`). **The code was correct and pushed the whole time.** Several of
> those sessions burned heavily chasing a symptom whose root cause was the
> Vercel pipeline, not the repo. Confirm Production is building from `main`
> before diagnosing any "not showing on Vercel" report.

---

## Big themes this stretch

1. **Bank Preferred — the dominant thread (Jul 22), built in four layers.**
   A new **Bank Preferred** dropdown on Employee → Profile → Payment sets the
   *send-from rail* (which processor Accounting pays OUT on) —
   `employee_ids.bank_preferred`, a **separate** column from the Disbursement
   picker (`preferred_processor`). It wins dispatch precedence
   (`bank_preferred` > `preferred_processor` > legacy CSV free-text; `x1153` →
   `wires`). On top of the dropdown came (a) an **Accounting approval gate**
   (changes held `pending` in `bank_preferred_change_requests`, approved in the
   Issues tab, never touching `employee_ids` until approved); (b) a **WIRES
   lock** — a wires/null/legacy-preferred employee can **never** be switched to
   hurupay/higlobe (guard in `employee-payment-processors.ts`, enforced at four
   sites); and (c) a data flip moving **17** active Hurupay-routed people who
   had no Hurupay wallet email but full wire info onto `bank_preferred='wires'`.
   Documented in the `bank-preferred-*` memory files; commits
   `0728c61 → f206f5a`. (No dedicated feature doc yet — routing precedence also
   lives in [payment-dispatch.md](../features/payment-dispatch.md).)
2. **Mark Paid recipient-bank correction (Jul 22).** Two connected pieces: the
   modal now pre-fills a Wise-routed employee's **own** bank (`b98585f`,
   `mark-paid-defaults.ts`), and a **pencil override** on the Recipient divider
   lets Accounting save corrected receiving details straight back to
   `employee_ids` mid-processing (`POST /api/payment-dispatch/bank-override`,
   audit-logged as `mark_paid_override`, employee notified). Designed and
   planned via SDD in `a10741f5`/`22e8dd13`, implemented in `902af62b`
   (`4f23a56`, `c468a98`, `ba738b1`, `e5df5fc`, `e583b72`).
3. **Payment Dispatch UI + the "buckets" saga (Jul 21–23).** Real
   Wise/Hurupay/Higlobe **logos** on the processor filter cards (bigger, wider,
   white logo plate — `8191d19`, `4234252`, `ef6e0c3`, `b98585f`), a
   loading-pulse skeleton (`ProcessorLogo.tsx`), and — after a long fight over
   processor buckets that "wouldn't show" during processing (which turned out to
   be the stale Vercel bundle, not code) — **focus-mode was ripped out
   entirely** at the user's instruction (`a6261aa`, `77d21a7`). A redesigned
   "Preparing Dispatch for you, Kane" Start-Processing modal was built but left
   uncommitted.
4. **Payroll correctness fixes (Jul 21–22), mostly uncommitted at window end.**
   MESA **−₱100 must never hit a non-member** — fixed at all 7 wizard deduction
   sites by deriving the opted-out set from the `mesa_ledger` account window
   (mirroring the "Non Members" tab) instead of the bare `mesa_member` flag
   (`0e263891`, `ledger.test.ts`). The signed **+/− adjustment parser** in
   Payroll Notes was hardened against dropped minus-signs, typos, and rounding
   skew (`4585b564`, `signed-amount-input.ts`, shipped as `f838b47`). Earlier
   (Jul 21, adjacent) the Adj.-column casing bug and the clearOffboarded
   re-activation crash were fixed.
5. **HSL Case Managers sub-department (Jul 22).** A new `case_managers` HSL
   branch (`schema.ts`) with a six-term per-unit KPI formula
   (`Reviews·250 + RFC·250 + PPL·100 + DME·250 + Task·250 + Referral·250`) —
   companion to the Jul 21 `attestation` branch. Seed via
   `2026-07-22_hsl_case_managers_dept.sql` + a Hogan Payplan Sync click
   (`175bc430`).
6. **Dashboard polish (Jul 22–23).** A per-view **themed dashboard-switch
   loader** (`DashboardSwitchLoader.tsx`, `TONES[view]`), a **CEO Live
   Processing** "Departments this cycle" column (`CeoPayrollLive.tsx`), a
   **Manager HSL-Branches animated dropdown** redesign (`HslBonusCalculator.tsx`),
   and an in-progress **slot-machine "Total Payout Value"** counter on the
   Accounting Overview (`edeaff04`) — all via the `impeccable` design skill,
   most left uncommitted for the user to eyeball.
7. **Co-browse Observe — the invisible modal (Jul 21, in `5b35f451`).** A
   driver-opened modal did not appear in the Accounting "Observe" rrweb mirror.
   Root cause (confirmed by parallel adversarial workflows): Base UI dialogs
   reveal via CSS enter-animations that **don't re-fire in the replay iframe**,
   so the modal paints stuck at `opacity:0`. Fix = Replayer `insertStyleRules`
   in `useCobrowse.ts`. The "different emails" and "portal it to body" theories
   were both explicitly refuted.

---

## Deployment prerequisites left open at the end of this window

DDL has **no path from this environment** (no raw-SQL RPC) — every item below
must be run by hand in the **Supabase dashboard SQL editor**. Data-only fixes
ship with the code deploy.

| Step | Why |
| --- | --- |
| Run `references/sql/alter/2026-07-22_employee_notifications_add_bank_preferred_type.sql` | Live CHECK still rejects `bank_preferred.decided`; until run, approving/denying a Bank Preferred change won't notify the employee. Restates the FULL 37-type list (a subset silently breaks other notification inserts). |
| Run `references/sql/alter/2026-07-22_employee_notifications_add_bank_override_type.sql` | Same for `people.banking.overridden`; the Mark Paid pencil-override notification no-ops without it (the override itself still works). |
| Run `references/sql/migrate/2026-07-22_hsl_case_managers_dept.sql`, then click **Hogan Payplan Sync**, then grant `hsl:case_managers` | Stamps the `case_managers` dept_key (~79 people) and admits the branch to the Calculator/payroll; order-independent with Sync. |
| Confirm `references/sql/migrate/2026-07-21_hsl_attestation_dept.sql` + `2026-07-21_hsl_bonus_entries_work_email.sql` are applied | HSL attestation branch + work-email-keyed bonus entries. |
| Confirm `references/sql/create/bank_preferred_change_requests.sql` + `2026-07-22_add_bank_preferred_to_employee_ids.sql` are applied | The requests table was verified present; the `bank_preferred` column pre-existed (migration adds the CHECK). |
| **Trigger a Vercel Production build from `main`** | The pipeline stall (see banner) means the live site can lag `main` regardless of code. |
| Deploy + push the still-uncommitted fixes | MESA non-member deduction (`0e263891`), the "Preparing Dispatch" modal (`5b35f451`), slot-machine counter (`edeaff04`), CEO Departments column (`26dcb645`), themed switch loader (`c219820b`), HSL dropdown (`a7414646`), Mark-Paid copy button (`e67c20a4`) were all local at session end. |
| Re-import the n8n paystub workflow after deploy | The paystub-freshness template now carries `orphanage_pay`. |

**Open recommendations (diagnosed, not resolved):** the All-Dept rates-sheet
free-text "Bank Preferred" cell can still route a fully-null-preferred person to
Hurupay/HiGlobe as the lowest-precedence fallback — a bulk path around the WIRES
lock's intent, left for Kane's explicit call. **48 active** employees remain
Hurupay-routed with neither a Hurupay email nor wire info (a data-collection
gap, exported to `references/backups/2026-07-22_hurupay_no_payout_data.csv`);
broader current-cycle counts are ~156 with no resolvable bank, ~190
hurupay-routed missing wallet emails, ~146 wires-routed missing account numbers.
The HSL rate-history stale-underpay arrears (~₱1.06M, adjacent session
`508d59eb`) await the Payment-Catalog structure + reimbursement remediation.

**Process note:** Kane runs 2+ Claude sessions **plus** his own manual git on one
checkout; junk-named commits (`s`, `dffd`, `fxvx`, `dasdasda`) are his sweeps and
they hoover up whatever is uncommitted — including another session's WIP. Stage
specific files only, re-check `BASE..HEAD` before any git op, and expect
uncommitted edits to be swept + pushed under a junk message at any moment. Kane's
standing instruction this window: **commit locally, never `git push` — he pushes
on his end.**

---

## Jul 23, 2026

### Accounting Overview — slot-machine "Total Payout Value" counter *(in progress)*
`edeaff04` · ~147 turns · **medium**
- Make the Overview's `Total Payout Value` (`9,318,234.91 PHP`) roll up like a
  calculator / slot machine, spinning until it lands on the real figure —
  explicitly via the `impeccable` skill.
- Built the rolling counter in a throwaway harness (`payout-preview.html`
  iterated 11×, plus screenshot/measure scripts) and applied it to
  `Overview.tsx` (3 edits) + `index.css`.
- Most of the session fought a headless-Chromium rasterization quirk
  (`will-change: transform` + `overflow:hidden` leaking cells outside the mask
  during capture). **No commits** — the `Overview.tsx`/`index.css` edits are
  uncommitted in the working tree.

### Payment Dispatch — plain-English walkthrough *(no code)*
`0d575f7e` · ~7 turns · **analysis**
- "Explain how this works as quickly as precise as possible, no weird tech
  lingo." Read the routing logic + feature doc and described Payment Dispatch as
  the post-Wizard "send the money" screen: a per-person list (name, email, USD
  over peso) sorted into rails — Hurupay, HiGlobe, or Wires.

## Jul 22, 2026

### Payment Dispatch — co-browse modal, CSV bank-preferred seed, buckets, Start-Processing *(multi-day; largest session)*
`5b35f451` · ~587 turns · spans Jul 21–23 · **major**
- A single sprawling session that pivoted through four topics:
  1. **Co-browse "I should be able to see the Modal"** — the driver-opened modal
     absent from the Accounting Observe rrweb mirror; diagnosed via parallel
     agents to the Base UI enter-animation / replay-iframe issue (fix =
     `insertStyleRules`; see [accounting-cobrowse.md](../features/accounting-cobrowse.md)).
  2. **Restore the "PAY Processors" rail** ("put it backk").
  3. **Seed `bank_preferred` from `references/docs/PD Data.csv`** by work email —
     the CSV is the *send-from* rail, receiving accounts untouched. Because SQL
     can't be pasted into Supabase, done via Node scripts
     (`seed-pd-bank-preferred.mjs`, `override-bank-preferred.mjs`,
     `clear-preferred-processor-for-pd-csv.mjs`, …); the `.sql` seed was deleted
     during a revert scare. Kane set to WISE.
  4. **"Buckets not visible on the Deployed Server … STRIP IT THE FUCK OUT"** —
     the buckets were fine in code; the deployed bundle was stale. Shipped
     `fix(payment-dispatch): keep processor rail visible during processing`
     (`77d21a7`) then **removed focus-mode entirely** (`a6261aa`).
- Final "Preparing Dispatch for you, Kane" Start-Processing modal (optimistic
  sidebar-retract, custom springs, 1.6s min display) left **uncommitted** per
  the "don't commit until I say ship it" rule. Edited `PayrollDispatch.tsx`
  (18×), `useDispatchLock.ts`, `Sidebar.tsx`, `App.tsx`.

### Mark Paid — Wise-bank fix + WIRES lock + Hurupay-no-payout audit
`902af62b` · ~334 turns · **major**
- A Wise-preferred employee should land in the WISE bucket and the Mark Paid
  modal should show their real bank — fixed via `b98585f` +
  `mark-paid-defaults.ts` (`+` test).
- Built the **WIRES lock** (TDD): a wires/null/legacy employee can never move to
  hurupay/higlobe. Guard `isWiresPreferred` + `isBankPreferredTransitionAllowed`
  in `employee-payment-processors.ts`; four enforcement sites — intercept 400
  (`a83cfdb`), approval re-check vs live value (`6735937`), dropdown hides the
  options (`9b45eb7`), Approve disabled (`1ea4b87`). Final review follow-ups +
  legacy-case tests (`f206f5a`, now the tip of `main`).
- Data audit: exported **48** Hurupay-routed people with no payout data
  (31 HSL, 15 Lead Gen) to `references/backups/2026-07-22_hurupay_no_payout_data.csv`;
  the 17-person Hurupay→wires flip (`fix-hurupay-to-wires-bank-preferred.mjs`,
  dry-run + backup) was applied. Audit scripts left uncommitted.
- **PENDING**: run `2026-07-22_employee_notifications_add_bank_override_type.sql`.

### Employee Bank Preferred — dropdown → separate-field fix → approval gate
`dc730b0f` · ~418 turns · **major**
- Add a Bank Preferred dropdown (HiGlobe/Hurupay/Jeeves/Wise/x1153) below the
  Profile → Payment form; "run the changes ASAP, no PR."
- **Bug** ("changing bank preferred to wise flips the Disbursement wires"): root
  cause was the dropdown sharing `preferred_processor` state. Introduced the
  **separate `employee_ids.bank_preferred` column**
  (`2026-07-22_add_bank_preferred_to_employee_ids.sql`) threaded through
  `employee-ids.ts`, `update-employee-ids/route.ts`, `mock-queue.ts`,
  `pay-schedule.ts`, `dispatch-export-csv.ts`. Commits `0728c61`, `320d200`.
- **Approval gate**: changes held `pending` in `bank_preferred_change_requests`,
  approved in the Issues tab (`BankPreferredApprovals.tsx`), old value stays
  live until approved. Commit `247fe74`; `+ ba7974d` retries the one-pending
  unique-index conflict (23505) instead of 500-ing.
- **PENDING**: `2026-07-22_employee_notifications_add_bank_preferred_type.sql`.

### Bank Preferred not on Vercel — debug + Mark-Paid override design
`a10741f5` · ~262 turns · **medium**
- "Bank Preferred section isn't showing on the deployed site — check for pending
  commits." Systematic-debugging **ruled out pending commits**: all three UI
  commits are ancestors of the pushed `origin/main`, the block renders
  unconditionally, typecheck clean. Diagnosis: **stale Vercel build** (no CLI/
  `.vercel` link to confirm directly). Corrected the "48 no-bank" figure to ~156
  current-cycle / ~190 hurupay-missing-wallet / ~146 wires-missing-account.
- Produced the Mark-Paid **pencil bank-override** design spec + plan (`d6038e4`,
  `1d8420e`); the implementation itself was worked in the sibling `902af62b`.

### MESA deduction — never charge a non-member
`0e263891` · ~98 turns · **major**
- "Non-members should not get a −₱100 deduction whatsoever" — check the Non
  Members tab. Root cause: a bare opt-out flip didn't set the ledger's
  `lastEventOptedOut`, so flag-drifted ex-members were still deducted.
- Fix at **all 7 deduction sites** in `PayrollWizard.tsx` (main compute;
  Additions per-row + dept summary; HSL per-row + footer; Step-7 rows): derive
  the opted-out set from `GET /api/mesa-ledger`'s account window and suppress —
  mirroring the Non Members tab exactly; ledger-unavailable falls back to
  flag-only (never re-introduces a deduction). New `ledger.test.ts` (6 tests);
  190/190 pass. **Uncommitted** — frontend/state only, no migration.

### CEO Live Processing — "Departments this cycle" column
`26dcb645` · ~85 turns · **medium**
- The Live Processing modal should show the count of departments being paid this
  cycle; "separate it into another column, not inline with the people."
- Added a standalone `DepartmentsColumn` `<aside>` in `CeoPayrollLive.tsx`
  (own header + count pill + divider + scroll + empty state), removed the inline
  block, widened the dialog to `lg:max-w-6xl` (three columns, stacking on
  mobile). Touched `payments-live/route.ts`, `usePaymentsLive.ts`,
  `payments-live.ts`. Typecheck clean; **uncommitted**.

### Manager HSL Branches — animated dropdown redesign
`a7414646` · ~128 turns · **medium**
- Redesign the KPI Calculator's HSL-Branches rail into "a beautifully wrapped
  dropdown using the theme with smooth animations" (via `impeccable`, driven by
  screenshots).
- Replaced the rail in `HslBonusCalculator.tsx` with a themed animated dropdown
  (renders only when `multiDept`). Built a throwaway 4-state screenshot harness
  and **fully reverted** all scaffolding + the temporary `proxy.ts` allowlist
  entry afterward (verified clean). **Uncommitted** (working-tree change only).

### Payroll Notes — signed (+/−) adjustment parser hardening
`4585b564` · ~151 turns · **medium**
- "Adding and Subtracting should be there — when we add '−' it should be
  negative … harden it so we don't get bugs" (systematic-debugging).
- Root cause: a state/parse desync could drop the leading `−` (Firefox discards
  the intermediate input). New `signed-amount-input.ts` (+ test: typo rejection
  like `-P5`, empty→null, sign-symmetric rounding); `PayrollWizard.tsx` (8×).
  205 tests green. Shipped to `main` as `f838b47`.
- **Incident:** another session's `0ee1cc9 "dasdasda"` was pushed to `main`
  *during* this one, carrying this fix **plus** an unrelated `MarkPaidDialog.tsx`
  copy-button change; already on `origin/main`, so deliberately not rewritten.

### HSL Case Managers — new KPI branch
`175bc430` · ~62 turns · **major**
- Add a "Case Managers" HSL branch with
  `=(Reviews·250)+(RFC·250)+(PPL·100)+(DME·250)+(Task·250)+(Referral·250)`,
  like the new Attestation branch; tell the user when to run Hogan Payplan Sync.
- Added `case_managers` to `hsl-bonus/schema.ts` (six per-unit rules; RFC is
  per-unit here — flagged as *different* from the Medical Records dept where RFC
  is a manual peso amount). New `2026-07-22_hsl_case_managers_dept.sql` (stamps
  dept_key, ~79 people, optional role grant). Updated
  [hsl-kpi-calculator-2026-07.md](../features/hsl-kpi-calculator-2026-07.md).
  **Uncommitted**; deploy steps queued (SQL → Sync → grant).

### Payment Dispatch — processor filter logos
`4d7394ce` · ~173 turns · **major**
- Give the Wise/Hurupay/Higlobe filter cards their real logos; "make it a bigger
  card so we can actually see the logo."
- Rewrote `ProcessorLogo.tsx` (optional `logoSrc`, white plate, `object-contain`,
  monogram fallback), threaded through `ProcessorCard.tsx` + `PayrollDispatch.tsx`,
  enlarged to a wide white plate on **every** filter card. Root cause of the
  "white boxes": dark ~3:1 wordmarks shrunk by a 44px square + a bad
  `mix-blend-multiply`. Three commits `8191d19`, `4234252`, `ef6e0c3` (each
  typechecked). **Pushed** to `main` — but see the Vercel-stall banner.

### Themed dashboard-switch loader
`c219820b` · ~74 turns · **medium**
- A smooth viewer-switch animation like the accounting one — a modal + skeleton
  whose colour scheme matches the destination dashboard.
- Built a `TONES` record keyed by `AppView` in `DashboardSwitchLoader.tsx`
  (border/shadow/emblem/rings/text/dots/progress per view), replacing the
  hardcoded orange-vs-tickets ternary; shared between the click overlay
  (`ViewSwitcher.tsx`) and the route loader. Typecheck clean; **uncommitted**.

### Mark as Paid — copy button for Account/Wallet ID
`e67c20a4` · ~21 turns · **minor**
- Add a copy-to-clipboard button for the Account/Wallet ID in the Mark Paid
  modal. Added it to `MarkPaidDialog.tsx` mirroring the amount-copy button
  (separate `copiedAcct` state, per-row reset, `pr-10` padding). Clipboard-only;
  typecheck passed; **uncommitted**, awaiting the user's test. (A near-identical
  change rode the `0ee1cc9` sweep noted under `4585b564`.)

### Mark as Paid — edit/save recipient bank *(design only)*
`22e8dd13` · ~31 turns · **analysis**
- Brainstorming session (implementation hard-gated off) for an Edit button that
  edits + **persists** recipient bank details with a full audit trail. Root-cause
  insight: the dialog's edits only snapshot into the `payment_dispatches` row and
  never reach `employee_ids`, so next cycle re-uses stale banking. Proposed the
  `payment_dispatch.recipient_bank_edited` audit action + a
  `recipient-bank/route.ts` — the design that became the pencil override in
  `a10741f5`/`902af62b`.

### WIRES-only lock — design + TDD plan *(planning only)*
`9cf55958` · ~50 turns · **medium**
- "Where their banks are WIRES they cannot be sent through HURUPAY or HIGLOBE."
  Produced `2026-07-22-wires-lock-design.md` + a 6-task TDD plan (`823e7f2`):
  helpers + tests, server 400 backstop, approval re-check, dropdown hiding,
  Approve-disable. **No feature code** — implemented later in `902af62b`.

### Investigate: logos on localhost but not Vercel *(no code)*
`d04e388a` · ~22 turns · **analysis**
- "localhost has the changes, Vercel doesn't." Found Production frozen on
  `0e1c362` for ~9 h while ~29 pushed commits (incl. all three logo commits)
  never built; recent "6h-ago" builds were **Preview** builds on
  `feat/bank-preferred-dropdown`. Conclusion: stalled Vercel Production
  pipeline, not the code — the source of this window's opening banner.

### COMMIT EVERYTHING IN THE BRANCH *(housekeeping)*
`01c26dba` · ~10 turns · **minor**
- Only `.claude/settings.local.json` (allowlist) + `tsconfig.tsbuildinfo` (build
  cache) were dirty; committed to `main` as
  `chore: update local Claude settings allowlist and build cache` (`0bee6a8`).
  Not pushed; `settings.local.json` re-dirtied itself live.

### Do we have any uncommitted code? *(status check)*
`e93a7ddd` · ~3 turns · **analysis**
- `git status` only: two build/config files modified; untracked
  `references/backups/` + two one-off Hurupay fix scripts. No `src/` changes.

### Uninstall the "superpowers" plugin *(config)*
`cbab3708` · ~17 turns · **minor**
- Removed the Superpowers plugin from the Claude Code setup: backed up
  `~/.claude/`, edited `settings.json` + `installed_plugins.json`, planned the
  marketplace/known-marketplaces cleanup + on-disk directory deletion. Local
  config only — not the HRIS app.

## Jul 21, 2026 (evening)

*(The Jul 21 work below sits at the edge of the 20-session window; its fixes were
still uncommitted going into the Jul 22 cluster. Fuller detail lives in the
memory files linked from `MEMORY.md`.)*

### Notable adjacent session (just outside the 20 by mtime)
`508d59eb` · Jul 22 · **major** — **HSL rate-history stale underpay.** The pay
engine prorates each day's rate from `employee_rate_history`, but the HSL sheet
sync never writes that table, so stale `175`/`1970-01-01`-baseline rows beat the
correct HSL rate (Alex paid 175 not 225). Live scope: of 565 HSL agents, **121
underpaid / 10 overpaid**, ≈**₱1.06M** arrears. Remediation = go-forward via
Payment-Catalog per-employee PHP structures (which write an actor-authored
`employee_rate_history` row immune to sync clobber) + reimburse arrears; report
at `reports/hsl_rate_arrears_2026-07-22.csv`. Classify on
`created_by`+`effective_from`, **not** rate inequality (some "over" rows are
legit manual raises). Referenced here because its content date falls in-window.
