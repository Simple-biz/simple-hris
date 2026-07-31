# Session Log — the 20 most recent Claude sessions (Jul 30, 2026)

Reconstructed from Claude Code session transcripts. The 20 sessions cover a single
working day — **Jul 30 2026, 08:05 → 17:56 ET** — which produced ~40 commits
(`7e6f9e5` → `fc25241`). Grouped by part of day, newest first. Each entry lists what
was asked, the commit(s) it produced, and a rough size.
Continues [audit-2026-07-26-session-log.md](./audit-2026-07-26-session-log.md).

> Several sessions ran **concurrently in one shared checkout**, so entries interleave and
> each commit stages only its own files. See the "shared checkout" note in *Working
> conventions* at the bottom.

---

## Big themes this stretch

1. **Mid-week rate changes became explicable on the paystub — then the rule grew two
   more layers.** A question ("have we applied mid-week transfer rates yet?") became an
   approved artifact mock, then a shipped feature: the affected earnings line keeps its
   row and gains an amber **Prorated** chip, a **`₱old → ₱new`** cell, and a per-rate
   hour basis (`9a767a4`). Two follow-on rules landed the same afternoon —
   **catalog-consistency** (a catalog-managed person prorates through dated history only
   when the terminal history rate equals the structure, else fail closed to the flat
   week — `5b66a40`) and the **HSL transfer-week rule** (the +₱15/h weekend premium
   day-scopes from the transfer's effective date — `9e17ac9`). Both are implemented
   identically in **both** engines (wizard + Dispatch compute + disbursement seeding) so
   no engine can disagree. See
   [paystub-dispatch.md](../features/paystub-dispatch.md#mid-week-proration--2026-07-30).
2. **The PostgREST 1000-row cap turned out to be everywhere, with live damage.** Asking
   "what else needs hardening?" triggered a 22-agent audit against the live DB. The
   roster had reached **1,296** people and sixteen un-paged readers were silently
   dropping their tail: **Payment Dispatch routing missing 20 people**, **outstanding-pay
   totals missing ~470 recipients**, **~296 people never getting "Salary Ready to View"**,
   126 of 448 HSL people on the wrong week model, ~296 missing from manager Team pages,
   and a work-email suggester that could re-mint a taken address. All sixteen now drain
   through one shared `selectAllPaged` helper (`2829a6d`). **A per-cycle or per-week
   filter is not a bound.** See
   [data-sources.md](../reference/data-sources.md#data-integrity-gotcha-postgrest-1000-row-default-cap-discovered-2026-07-09-systemic-sweep-2026-07-30).
3. **"Total payout" stopped being salary-only.** An audit request ("does Total Payout
   match bonuses, salary, urgent payments?") found the Accounting Overview hero trailing
   the wizard's Total Weekly Outflow by **₱2.6M**. Everything in the "Never included"
   column is now added from payroll's *own* staged/live figures — KPI/catalog bonuses,
   Notes adjustments, orphanage pay, MESA, and the cycle's paid urgent payments
   (`6907393`), then hardened through an adversarial review that caught 10 real issues
   before shipping (`640e3af`). See
   [accounting-total-payout.md](../features/accounting-total-payout.md).
4. **Two payroll data-integrity bugs found by asking about one person's number.** "Why is
   russel@'s bonus 11k when the KPI Calculator says 2.5k?" exposed that the wizard
   **assumed one email = one person** — a shared master-list email merged two people's KPI
   bonuses onto both paystubs. Fixed by attributing applied rows via their
   `employee_name` snapshot, with stored keys and QC untouched (`5cd515c`). Separately,
   "I can't find kriziah@ on the Global Master List" unravelled into **13 people whose
   applied transfers had been silently reverted by a stale Google-Sheet paste** — all
   restored, plus a full 1,326-row Sheet-vs-DB sweep proving there were no more.
5. **Colombians finally see their own currency.** Colombian staff ride the PHP rails (no
   COP Pay Structure exists for them), so their dispatch rows and paystubs showed pesos
   they never receive. A display-only `countryCurrency` marker — from the hire's
   **submitted** onboarding country, never HR's misclick-prone `invite_country` — puts
   native `$COP` on queue rows, the Mark Paid dialog (copy pastes a bare integer), and
   paystubs (`9f235c7`, `fc25241`). See
   [cop-country-payees.md](../features/cop-country-payees.md).
6. **Two n8n email automations, both awaiting import.** *Urgent Payment filed* → red-alarm
   alert to carla/claire/lennyt (`3f4240b`), and *Payment Dispatch hits 100%* →
   confetti-and-balloons congratulations to every `accounting`-role holder, guaranteed
   once per cycle by an atomic `app_settings` claim (`836f68f`).
7. **A visible-polish run across Payment Catalog** — Overview renamed **Summary** and
   rebuilt as a pay-mix dashboard with paginating, hover-pausing charts; the Search hero
   truly centered with a smooth dock-to-top glide; the Department tab's master-list
   section rendered as cards; plus **custom System Bonuses in COP/USD** as currency
   variants of PAB/Tech with no schema change (`c4663e8`).

---

## Afternoon (14:00 – 18:00 ET)

### Payment Dispatch 100% → confetti email to Accounting · `836f68f` · M
> *"…when Payment Dispatch reaches 100% … send an email to all accounting members … confetti and balloons … admin will have another slot on webhooks"*

Client effect in `PayrollDispatch.tsx` watches the same math as the Dispatch Progress
strip (`pending = 0 && blocked = 0 && ≥1 paid`, gated on hydrated/wizardReady/no errors so
a half-loaded queue can't read as complete). Server route sends **exactly one email per
cycle, ever** via an atomic `app_settings` INSERT marker per source file — five clerks at
100% → one email; undo→re-pay → silent; the marker is released only if n8n delivery fails.
Audience = live `accounting` role holders. Confetti/balloons are inline-block spans + CSS
keyframes (no `position:absolute`) so animation-stripping clients degrade to a static
garland. **Pending:** n8n import + `payment_cycle_complete` webhook URL.

### Urgent Payment filed → alert email · `3f4240b` · S
> *"…if there is an Urgent Payment that just landed onto Payment Dispatch — email carla@, claire@ and lennyt@…"*

`POST /api/people/pay` is the only creator of urgent requests, so it now fires the webhook
best-effort right after the insert (a hiccup can never fail the payment). Recipients and
copy are fixed inside the workflow's Code node so the endpoint can't be a general mailer.
**Pending:** n8n import + `urgent_payment_notify` webhook URL.

### COP payees in Payment Dispatch, then on paystubs · `9f235c7`, `fc25241` · L
> *"for People Under COP or Columbian lets please use the COP Value not the PHP Value as the small number … with the COPY Paste in it"* → *"Make sure the Paystubs are in COP as well!"*

Two deliberate safety calls: only the **hire-selected** country counts (a never-submitted
invite marked a Filipino hire as Colombia), and `payCurrency` is untouched so nothing about
routing/amounts/records changes. Verified against live data — exactly 4 people this cycle.

### Total Payout audit → full pay run · `6907393`, `640e3af` · XL
> *"audit if the total payout matches to everything like Bonuses, salary, and even urgent payments"* → *"I think we are lacking the bonuses lets add all of those that are in NEVER"*

Live figures after the change: ₱9.52M salary + **₱2,555,211.55 extras** ≈ ₱12.07M. The
adversarial review (16 agents, refute-verified) caught the CEO snapshot publishing a
salary-only total in the ~1s before extras loaded, a transient DB error silently zeroing
bonuses, ~2–4MB of paystub payloads streamed per viewer per refresh, and two
identically-paid people collapsing into one pre-lock. **Still open:** the salary base is
sheet-only rates (~₱213K catalog drift; ~17 no-rate people invisible).

### Wizard "Rate snapshots" toggle on Dispatch · `06b3fd7` · L
> *"…a toggle switch beside the Lock in button where … we would have a snapshot preview of the People's Tab's rate = 'Banking Info' and for Payment Catalog whatever rate was set … modals floating with the pay stubs so we can see it in comparison"*

Two floating comparison cards with match/differ verdict chips. Two constraints that will
break if changed: the cards must be **Base UI popup children positioned outside the box**
(not portals — portals get dismissed or z-trapped), and they render only ≥1180px. The
People-tab rate is mirrored from the **raw sheet index**, not the catalog-overlaid map, or
the comparison would be vacuous.

### Krizia, then 12 more: stale Sheet paste reverted applied transfers · no commit · L
> *"I couldnt find her on the Global Master List … kriziah@simple.biz"* → *"there where a few who were transferreed check the managers please"* → *"glaizag@simple.biz was transferred and it seems I cant find her"*

Audited all **117 applied transfers**, found 11 more in the same broken state, fixed each
(Sheet cell → transfer target, DB row restamped visible, sync-minted duplicate deleted,
exactly one active row), with row backups printed before every write. Glaiza proved a
transfer-record audit is insufficient — her move was a **direct Sheet edit** with no
transfer record — so a full **1,326 Sheet rows × 2,311 DB rows** consistency sweep was run:
zero mismatches remaining. **2 open human decisions:** Gopez/Quijano (reverted 17 days ago,
survived 2+ payroll cycles) and Medilo Hanna Grace (Sheet says Active, current DB row is
offboarded). Playbook written into
[department-transfers.md § 6](../features/department-transfers.md).

### Carla sign-in song · `eec5a4c`, `e499ab4`, `2967bf9`, `1ea603a`, `1f6fc03` · L
> *"When Carla Signs in … lets play this song for like 30 seconds till it fades out even when she switches dashboard"* → *"The music cuts off when the dashboard is loaded"*

The reported cut-off turned out to be the **login intro video's own soundtrack** ending at
the hand-off (the clip hadn't been installed yet), but the requirement was hardened anyway:
the run is persisted **per tab** and resumed at the correct offset, so 26s-fade / 30s-stop
hold across a full page load. Clip = a 40s final-chorus cut, −14 LUFS, no baked fade-out
(the player owns the fade). Alternates stay untracked. See
[login-carla-song.md](../features/login-carla-song.md).

### HR → Transfers tab was silently empty · `19e504b` · S
> *"HR - Transfers - Fix the contents in here is so missing"*

Regression from `7c8e314`: the unscoped HR/admin default had been repurposed to "requests
I raised", and HR coordinators never raise transfers. New explicit `scope=all`, plus the
(roles, scope) → list dispatch extracted from route comments into the tested pure function
`resolveTransferListQuery` so it can't regress in either direction.

### Mid-week proration on the paystub, ×3 rules, then the hardening sweep · `9a767a4` → `2829a6d` · XL
> *"Have we applied the Mid week transfer …?"* → *"can you give me an Artifact on what the paystub would look like … add a label that this was prorated as not to add more rows … add the previous rate and current rate"* → *"Lets implement this please perfectly!"* → *"…if they are transferred to HSL within that week only that week they will have the WeekEnd Hours"* → *"what else needs to be hardened on this process?"*

The longest session of the day. Design was approved as an artifact first, then implemented
TDD. The HSL transfer-week investigation caught two adjacent bugs: server engines
classified HSL by the **exact string `"hsl"`** (so `hsl:*` sub-teams and `Hogan Smith Law`
labels were paid *without* the weekend premium server-side while the wizard paid it), and
rate-history reads were truncated at 1,000 rows. The final "what else needs hardening?"
question is what produced the 16-reader `selectAllPaged` sweep. Money impact of the HSL
rule on the current cohort: **₱0** (all ten transferees worked zero weekend hours), so it
landed as a pure rule with no surprise repricing.

**Prioritized hardening still open** (from that session's own list):
1. Surface the **17 catalog-vs-history conflicts** (Capillo 210-vs-225 etc.) in the
   wizard's rate-issues panel or Readiness — today only
   `scripts/audit-catalog-history-conflicts.mjs` sees them.
2. **Auto-write the baseline history row** when a first-ever Payment Catalog rate is saved
   (the Uriel gap) — otherwise a newly catalog-managed person's first mid-week change
   can't split.
3. **Unify the two rate write paths** — `update-employee-rates` (Rates editor) writes
   history but not the catalog structure, which is exactly how Capillo's conflict was born.

---

## Midday (11:00 – 14:00 ET)

### Why is russel@'s bonus 11k? → shared-email KPI attribution · `5cd515c` · L
> *"where was russel@simple.biz's bonus set and why is it 11k? where on KPI Calculator it was 2.5k"* → *"No where in the HRIS Payroll Wizard where we will connect their Personal Emails with anything!"* → *"Lets not touch QC and just fix this properly code wise"*

Kane's constraint (leave QC and stored keys alone) reframed the fix: the bug isn't the
key scheme, it's that the wizard assumed one email = one person. Now collision-aware by
name snapshot, with an amber Additions banner. 10 new unit tests; live verifier splits the
merged 11,167 into 2,500 / 8,667 — and confirms it was the **only** genuine collision
across 1,307 master rows. See
[payroll-wizard-final-pay.md § 3a](../features/payroll-wizard-final-pay.md).

### Plain-language list: why someone isn't in Payment Dispatch · no commit · S
> *"Give me a list of reasons in plain sentence only the reason why they wont appear on Payment Dispatch no tech terms just a list"*

Now recorded as a triage list in
[payment-dispatch.md § 12.9](../features/payment-dispatch.md).

### Payment Catalog Overview → Summary, rebuilt · `fee8f00`, `9fd132c`, `dd2fed5`, `e997c0e`, `8764d67` · M
> *"Redesign the Overview where we can see a pie chart and a Graph … one KPI Card … randomnly show a person's rate … nice gradient"* → *"change that to Summary"* → *"paginate it to 10 … switching page once every 10 seconds"* → *"Lets utilize the width"* → *"add a smooth hover effect"*

Five iterative commits. Gotcha recorded: Framer Motion's inline opacity defeats CSS
hover-dimming, so hover classes live on an inner wrapper div.

### Collab CSS: the sidebar was overlapping the Observe mirror · `3bb0efa` · M
> *"fix the collaborative feature bug the CSS seems to be broken and inconsistent"* → *"Seems like the collaborative Feature seems to be overlapped by the side bar"*

A regression from the previous day's `isolate` fix, correctly identified by Kane. The
mirror now portals to `<body>`. This establishes a general rule for anything rendered
inside `<main>` — recorded in
[accounting-cobrowse.md](../features/accounting-cobrowse.md).

*(This session's first attempt used a workflow that died on the org monthly spend limit;
the diagnosis was completed inline.)*

---

## Morning (08:00 – 11:00 ET)

### Custom System Bonuses in COP / USD · `c4663e8` · L
> *"System Bonuses I should be able to add similar system bonuses like this with COP or Dollars please check how the structure works and implement it"*

A variant is a **currency variant of PAB or Tech**: it keeps the built-in's timing and
eligibility rules but carries its own name, amount + currency, and department allowlist,
**replacing** the built-in amount for those departments. Stored in the *same* table under
prefixed codes (`pab:*` / `tech:*`) — **no migration**. Threaded through both server math
paths, the wizard, dispatch, paystubs, and the dashboards; the Overview's PAB accrual now
sums **per-employee** amounts instead of `eligible × ₱5,000`. See
[bonus-catalog.md § 6.1](../features/bonus-catalog.md).

### Urgent bucket persists all week, + Undo · `5c82064`, `b2ff805` · L
> *"If there are urgents on that week even though it was already paid the bucket should not disappear … it should have Pending, Paid, Not Paid, and etc."* → *"Lets add the undo button in here please"*

The server-side half was the interesting part: urgent pending items live in **source
request tables**, so deleting the dispatch row alone would strand the request as
"dispatched" forever. Each source has its own recovery path, MESA's going through the
`mesa.disbursement.dispatched` **audit event** because it has no dispatch-link column.
Revive-before-delete + idempotent revive means a failed delete leaves the card visible to
retry rather than stranding an invisible payment. See
[urgent-payments.md](../features/urgent-payments.md).

### HSL Weekend Hours on every paystub surface · `3d820c3` · L
> *"Paystubs should have Weekend Hours - this should mean that the weekend Hours Could have Regular Hours or OT Hours in there so be wary also this cuts across all dashboards where Paystubs Exist"*

Kane's warning was correct and load-bearing: the 40h cap is chronological, so a weekend day
past the cap is weekend **OT** — hence two weekend rows, not one. The `weekend` block is a
**carve-out** (totals unchanged; weekday lines derived by subtraction), which also fixed the
long-standing quirk where an HSL stub's hours × rate didn't match the amount because the
+₱15/h premium was hidden inside it. **Pending:** re-import the live n8n instance.

### Payment Catalog polish · `773acf1`, `3e77bb1` · S each
> *"Center the CSearch bar please and the logo as well … sure when the user starts typing it transitions smoothly"* · *"From the Master List Sync should be in Cards please"*

The Search hero centers with a flex spacer (46% of free space, optically centered) and only
the **top** spacer animates to zero — animating both is the classic flex-grow gotcha that
freezes the hero until the very end. Reduced-motion respected.

### Is the employee dashboard slow because of CSS? · no commit · M
> *"Is the CSS we are using for the employee dashboard making the loading of the page so slow?"*

**Answer: no — JavaScript and data fetching dominate.** Measured from the production build:
~800 KB compressed JS across 21 chunks + 446 KB root runtime (~3 MB uncompressed) vs. one
~92 KB CSS file. Root causes in order: (1) essentially **zero code-splitting** — one
`next/dynamic` in the whole app, so `EmployeeApp.tsx` eagerly imports all 38 dependencies;
(2) five `cache: 'no-store'` API calls on mount, one of which scans the full roster
server-side to return a single row; (3) the one genuine CSS penalty — the **Google Fonts
`@import`** at `src/index.css:1` creates a render-blocking chain on every page (switching to
`next/font` would remove it).

### HR Global Master List heading · `7e6f9e5`, `1cf7328` · S
> *"change 'Active Roster' to Global Master List"* → *"it is still saying active roster"*

Worth recording for the next reader: **there are two `RosterCard` components with the same
"Active roster" title**, and the one in `HrApp.tsx:1012` is **dead code, never rendered**.
The live heading is `HrGlobalMasterList.tsx:1310`. A deletion candidate, left alone.

---

## Open deploy steps carried out of this stretch

| # | Step | Blocks |
|---|---|---|
| 1 | **Import + activate** `references/n8n/urgent-payment-alert.workflow.json`, then register the production URL in **Admin → Webhooks** slug `urgent_payment_notify` | urgent-payment alert emails (app-side fire currently no-ops) |
| 2 | **Import + activate** `references/n8n/payment-cycle-complete-celebration.workflow.json`, register slug `payment_cycle_complete` | the 100%-paid confetti email |
| 3 | **Re-import the live n8n Paystub Automation** from `references/n8n/Paystub Automation.json` | HSL **Weekend Hours** rows *and* the **Prorated** chip / dual-rate cells in paystub emails. Until then emails render the classic lines from the same payload (still reconciles) |
| 4 | **Reload the wizard tabs and re-lock cycle 07-19** | restages the shared-email KPI split (rows staged before `5cd515c` still hold the merged ₱11,167) |
| 5 | **Fix the master list** — Rhocel Bencito's Personal Email is John Corpuz's gmail | the amber Additions banner nags until corrected |
| 6 | **Reload the Payment Dispatch tab** after deploy | so it refetches pay data and picks up the COP markers |
| 7 | **Two human decisions on reverted transfers** — Gopez Stephen / Quijano RJ (Jul 13 move, reverted 17 days, 2+ cycles ago) and Medilo Hanna Grace (Sheet Active vs. offboarded DB row) | those people's correct department / visibility |
| 8 | Tell whoever re-adds Google-Sheet rows to paste **current** department values | prevents another 13-person transfer clobber |

## Documentation debt noted (features shipped just before this window, still undocumented)

- **Admin Penny AI** (`b0f433e`, Jul 29) — `/api/admin/penny-chat` (Sonnet) + `ADMIN_TOOLS`
  in `src/lib/anthropic/admin-tools.ts`: read-only audit-log forensics, diagnostic probes,
  wizard runtime state, and per-person rate/transfer/onboarding/bank history, layered on
  top of the CEO payroll tools. Design rules worth writing up: **service-role client only**
  (these tables sit behind RLS where an anon client "succeeds" with zero rows — a silent
  wrong answer), each tool is a narrow pre-shaped query (never model-written SQL), and
  results carry `field_notes` so the model can't invent a reading.
- **Onboarding contracts Download tab** (`9d46941`, Jul 28) — the View modal compiles all
  four signed agreements into one branded packet PDF; copy moved to
  `src/lib/onboarding/agreement-copy.ts`.

## Working conventions confirmed this stretch

- **Commit locally, never push.** Kane pushes.
- **Shared checkout.** Multiple sessions run in one working tree; every commit stages
  **only its own files** and re-checks `BASE..HEAD` before any git operation, because
  another session may have committed in between.
- **Design-lint stop-hook findings get `git blame`d before being treated as real.** Most
  are pre-existing shipped chrome (the Payment Dispatch violet/fuchsia palette, the
  per-person avatar gradient hash, the `AdminWebhooks` status border) or false positives
  where the gray text and the colored background belong to different interaction states.
  Nothing is restyled inside an unrelated fix, and **no suppressions are added without
  Kane's say-so**.
