# Session log — 2026-09-16

Rows carried forward are **not** re-verified here. For earlier state see the
[Sep 14 log](./audit-2026-09-14-session-log.md) § Open items.

| # | Session | When (ET) | Shipped |
|---|---|---|---|
| 1 | `d937b520` | Sep 14 → Sep 16 | **Employee Support.** `blueprint` scope, brief, hard stop, a mockup artifact, a signed approval PDF for Carla. **No code.** Two doc commits |
| 2 | `8e95752d` | Sep 17 | **Payment Dispatch processor rail.** Wires' plate spells **WIRES** (was `"WI"`); the whole rail compacts to plates alone when the app sidebar is expanded. 3 components, 2 new tests, `payment-dispatch.md` §3.3.2–§3.3.3. One commit |

---

## What this session did

Kane asked for an Employee Support button beside FAQs that files a ticket into a new section on
`/tickets`, employee-side ticket history, and a live chat with a queue and a served-by counter.

The `blueprint` scope read (8 parallel readers over the tree, then an adversarial verify pass
over every load-bearing citation) found three conditions that forbid the obvious build. The
brief was posted and hard-stopped on **Q1–Q9**. Kane then asked for a plain-language PDF for
Carla; she signed it on **2026-09-15** and her answers **removed the live chat from v1** and
**added content moderation**, which was never scoped.

---

## Open items (new this session)

| # | Item | State |
|---|---|---|
| **90** | **Employee Support — APPROVED, but the live chat is OUT of v1** | Carla signed `Employee-Support-for-approval.pdf` on **2026-09-15**. Her **Decision 2** took *"tickets first, add live chat once we know the volume"* — **more than half of the original ask, deferred by the approver, not dropped by us.** **Q3** (chat as its own channel vs the ticket escalated), **Q4** (global vs per-agent queue), **Q5** (persisted vs ephemeral) and **Q8** (what the counter counts down from) are **UNANSWERED, not resolved** — they must be re-asked when chat returns, not read off this plan. Also ruled: **five named answerers — Carla, Claire, Ainsley, Grace, Alivia** (none holds the `tickets` role, so the new `employee_support` feature key is now **required**, and five grants are a manual post-deploy step); **within one working day** as a displayed promise; **no per-day cap**; **no attachments**; **leaver access ends on the last day**. Plan rewritten for v1 at `docs/superpowers/plans/2026-09-14-employee-support.md`; memory [[employee-support-blueprint-pending]]. **Still nothing under `src/` or `app/`.** |
| **91** | **Content moderation was added by Decision 4 and is unscoped** | Carla's write-in asks us to **"prescreen any hateful/hurtful language"** and says **"unprofessional behavior should be flagged."** There is **no moderation anything in this repo** — no wordlist, no classifier, no review surface — so every option is new build. **The question is not technical:** "prescreen" reads as *refuse before send*, and a false positive **silences an employee with a real complaint on the one channel built for complaints**; "flag" needs a destination (who sees it, is the employee told, does the ticket still reach the queue). **Blocking — `N1` in the plan.** Whatever ships, screening **fails OPEN on an internal error**: a screening bug must never swallow a complaint. |
| **92** | **~~Support hours were given as 9–5 EST~~ — RULED, EST confirmed** | Carla wrote **"Monday - Friday, 9 AM - 5 PM EST"** against Decision 3, overriding the suggested Manila business hours. **Kane confirmed 2026-09-16: EST, as written.** So support is open **9 PM – 5 AM Manila** — the US-facing floors' shift, and everyone else's night. **This is the first surface in the HRIS whose operating window is not Manila** (everything else: `manilaDayIso`, the Sunday pay week, `hsl.week_model_cutover`), so it is recorded as a deliberate exception rather than left to look like a bug. Two consequences now in the plan: **(a)** the hours are **never shown as a bare "9 AM – 5 PM"** — a Manila-based employee reading an unlabelled 9–5 is wrong by twelve hours, so the form prints **both zones** and computes the conversion rather than carrying a second hardcoded string; **(b)** Eastern observes **DST and Manila does not**, so the window is stored as an **IANA zone plus local clock times, never a fixed UTC offset** — a stored `-05:00` is a bug that surfaces in March. New task 14b (`src/lib/support/hours.ts`) is tested across a DST boundary. |
| **93** | **The time-adjustment restriction is a guard or a sentence, and nobody has said which** | Decision 4: an employee may ask about an adjustment **already approved** and may **not request one** through support; schedules and time-off are likewise **a manager question**. Copy that says "ask your manager" is cheap. **Refusing** a ticket whose subject has no approved adjustment on record is a real lookup and a real refusal path. `N3` in the plan. |
| **94** | **Decision 7 closes the final-pay route, knowingly** | Leaver access **ends the day they leave**. The proposal put the counter-argument in front of her — questions about **final pay usually arrive *after* someone has left, and today they have no route to ask at all** — and she ruled against it anyway. **Recorded as a consequence, not a defect**, so it is not rediscovered later as an oversight. Reopening it is hers. |
| **95** | **`MEMORY.md` was over its read limit and silently dropping its tail** | Measured at **25.4KB against a 24.4KB cap** on 2026-09-14 — 5 lines were being cut off on every load, at the end, where `postgrest-1000-cap-sweep`, `multi-session-shared-checkout` and `subagents-write-to-live-db` live. Those are safety rules no session had been reading. Compacted to **19.5KB**, **every filename kept** (the remaining long lines pack 4–6 pointers each; trimming further deletes pointers, not prose). **Back to 22.1KB by 09-16** from other sessions' entries — still under the read limit, but it refills. [[memory-index-load-cap]]. |
| **96** | **Two tests fail on a clean `main` — unrelated to any change, found 2026-09-17** | `npm test` is **3,676 / 3,678** on a stashed, unmodified tree (verified by `git stash` on 2026-09-17, so neither is a regression from that session's work). Failing: **`src/lib/departments/dept-label-render.test.ts`** — *"no component renders a raw department cell to a human"*, i.e. a department value is reaching a screen without `formatDeptLabel(...)` ([[dept-label-display-sweep]]); and **`src/lib/manager/manager-time-adjustments-live.test.ts`** — *"hours are never interpolated raw into the shell gallery"*, i.e. the Manager Overview gallery is printing unformatted hours ([[manager-time-adjustments-workspace]]). Both are **guards that are currently red**, which means the next session's `npm test` is already non-green and a genuinely new break is easy to wave through as "the usual two". **Neither was touched — fixing them by widening the allowlist is exactly what those tests exist to prevent.** Needs the offending call sites found and wrapped. |
| **97** | **Admin → Webhooks becomes "Webhooks & Integrations" with a new Integrations tab — BLUEPRINT posted, awaiting Kane (session `675a6e09`, 2026-09-17)** | Kane: rename the sidebar entry and add an **Integrations** tab where outside systems query our database with a token we issue, scoped to **tables and columns at our permission**; *"I do not know yet how and what."* Scoping found the cousin already shipped in `a90155fc` (Sep 16, commit message `s`): **Admin → API tokens → External access** — `external_api_clients`, one key per system, one table (Global Master List), **all columns**, `GET /api/external/v1/global-master-list`. **Measured 2026-09-17: the `external_api_clients` / `external_api_requests` migration is NOT applied** (PGRST205 on both), `EXTERNAL_API_KEY_PEPPER` unset (falls to `NEXTAUTH_SECRET`). That commit also shipped its feature doc with **no `INDEX.md` row and no memory entry** — this build absorbs both. Questions outstanding: **Q1** the doc rule *"adding a table = a new SQL CHECK scope + a new route, never widen"* vs one catalog-driven endpoint with per-client table/column grants; **Q2 RULED** (Kane, same day): the Global Master List only, per-column permission, pulled *"via querying or MCP"* — so v1 adds an **MCP server** (`@modelcontextprotocol/sdk` 1.29.0 is already in `node_modules` transitively, no MCP code exists) on the SAME key and grants; new **Q7** MCP for every key vs a per-client toggle, **Q8** one rate limiter across REST + MCP; **Q3** grants editable after issue (audited) or fixed until Rotate; **Q4** PII columns default OFF; **Q5** External access moves out of API tokens or shows in both; **Q6** amend the un-applied 09-16 create SQL or ship an alter with its own `.cmd`. No code written. |

---

## Notes

- **No `next build` was run** and no dev server was started this session.
- The engineering mockup is a published artifact; the approval PDF was rendered locally with the
  Chromium that ships beside Playwright in Kane's profile (`--headless --print-to-pdf`), since
  neither Playwright nor Puppeteer is installed in this project.
