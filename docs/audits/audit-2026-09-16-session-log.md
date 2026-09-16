# Session log — 2026-09-16

Rows carried forward are **not** re-verified here. For earlier state see the
[Sep 14 log](./audit-2026-09-14-session-log.md) § Open items.

| # | Session | When (ET) | Shipped |
|---|---|---|---|
| 1 | `d937b520` | Sep 14 → Sep 16 | **Employee Support.** `blueprint` scope, brief, hard stop, a mockup artifact, a signed approval PDF for Carla. **No code.** Two doc commits |

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
| **92** | **Support hours were given as 9–5 EST, and this system is Manila everywhere** | Carla wrote **"Monday - Friday, 9 AM - 5 PM EST"** against Decision 3, overriding the suggested Manila business hours. Every date, week and cutoff in the HRIS is Manila (`manilaDayIso`, the Sunday pay week, `hsl.week_model_cutover`). **9–5 EST is 9 PM – 5 AM Manila** — precisely the US-facing floors' shift, and precisely everyone else's night. It may be exactly what she meant. **It needs one confirmation and must not be assumed**, because the two readings are disjoint windows. `N2` in the plan. |
| **93** | **The time-adjustment restriction is a guard or a sentence, and nobody has said which** | Decision 4: an employee may ask about an adjustment **already approved** and may **not request one** through support; schedules and time-off are likewise **a manager question**. Copy that says "ask your manager" is cheap. **Refusing** a ticket whose subject has no approved adjustment on record is a real lookup and a real refusal path. `N3` in the plan. |
| **94** | **Decision 7 closes the final-pay route, knowingly** | Leaver access **ends the day they leave**. The proposal put the counter-argument in front of her — questions about **final pay usually arrive *after* someone has left, and today they have no route to ask at all** — and she ruled against it anyway. **Recorded as a consequence, not a defect**, so it is not rediscovered later as an oversight. Reopening it is hers. |
| **95** | **`MEMORY.md` was over its read limit and silently dropping its tail** | Measured at **25.4KB against a 24.4KB cap** on 2026-09-14 — 5 lines were being cut off on every load, at the end, where `postgrest-1000-cap-sweep`, `multi-session-shared-checkout` and `subagents-write-to-live-db` live. Those are safety rules no session had been reading. Compacted to **19.5KB**, **every filename kept** (the remaining long lines pack 4–6 pointers each; trimming further deletes pointers, not prose). **Back to 22.1KB by 09-16** from other sessions' entries — still under the read limit, but it refills. [[memory-index-load-cap]]. |

---

## Notes

- **No `next build` was run** and no dev server was started this session.
- The engineering mockup is a published artifact; the approval PDF was rendered locally with the
  Chromium that ships beside Playwright in Kane's profile (`--headless --print-to-pdf`), since
  neither Playwright nor Puppeteer is installed in this project.
