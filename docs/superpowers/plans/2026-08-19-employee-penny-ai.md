# Employee Penny AI — Overview chat bubble, Haiku, 10 prompts/day

Approved blueprint (Kane, 2026-08-19):
**Q1 = a DAILY cycle** — 10 prompts per Asia/Manila calendar day, resets at Manila
midnight. **Q2 = sufficient warning before it greys out** — the bubble never
vanishes; it warns on the way down, then greys the composer with the reset time.
**Q3 = (a)** — an elevated viewer on `/employee?email=someone` gets Penny answering
about the VIEWED person, the SESSION holder's quota is the one that would be
charged, and elevated roles are exempt from the cap.

Third mount of the existing Penny, **not a fork** (memory `admin-penny-ai`): same
`CeoChatBubble` + `useCeoChat`, new `endpoint`, new tools module, stricter gate.

## The two invariants that carry this feature

1. **No employee tool takes an email argument.** Every tool closes over the one
   email `authorizeEmailAccess` resolved. Peer-data leakage is structurally
   impossible, not prompt-dependent — a prompt-injected "look up Jane's pay" has
   no parameter to travel through. A test asserts zero email-shaped properties
   across every `input_schema`.
2. **The cap is a COUNT of rows, server-side, fail-closed.** No mutable counter
   (no increment race), no `audit_log` (an admin truncation would refund the whole
   company). Reserve-then-settle: the row is inserted *before* the model call, and
   stamped `refunded_at` if the turn produced no text.

## Tasks

- [ ] 1. `references/sql/create/2026-08-19_penny_employee_usage.sql` — the table,
      idempotent, with the hot index `(lower(session_email), asked_at)
      WHERE refunded_at IS NULL`. No RLS (API-layer gate, like the wizard tables).
- [ ] 2. `scripts/apply-penny-employee-usage.mjs` — `pg` + `DATABASE_URL`,
      **`--apply` gate** (default = verify/dry-run), mirroring
      `scripts/apply-kpi-scored-notification-type.mjs`.
- [ ] 3. `src/lib/penny/employee-quota.ts` + `.test.ts` — pure, client-safe:
      `EMPLOYEE_PENNY_DAILY_LIMIT = 10`, `manilaDayIso`, `manilaDayStartIso`,
      `nextManilaMidnightIso`, `quotaFromUsed()` → `{limit, used, remaining,
      exhausted, warnLevel, resetsAtIso}`. Manila is a fixed `+08:00` (no DST) —
      the day boundary is built from the offset literal and pinned by tests.
      `warnLevel`: `none` (≥4 left) · `low` (2–3) · `last` (1) · `exhausted` (0).
- [ ] 4. `src/lib/penny/employee-usage-db.ts` — `server-only`. `countUsedToday`
      (head count, `escapeLikePattern`, **fail CLOSED** → returns the limit on any
      error), `reservePrompt`, `settlePrompt`, `refundPrompt`.
- [ ] 5. `src/lib/anthropic/employee-tools.ts` + `.test.ts` — `EMPLOYEE_TOOLS`
      (8 definitions, no email params) + `runEmployeeTool(name, input, ctx)` where
      `ctx` carries the resolved email. Tools: `get_my_pay`, `get_my_pay_schedule`,
      `get_my_bonus_status`, `get_my_hours`, `get_my_profile`,
      `get_company_policies`, `get_company_benefits`, `get_my_contacts`.
      Tech week via `resolveIsTechBonusWeek` (a raw `isTechBonusWeek(` call fails
      the source-scan guard test); PAB week via `isFinalPabWeek`; KPI via
      `getEmployeeKpiResults` (ready/locked only).
- [ ] 6. `app/api/employee/penny-chat/quota/route.ts` — GET, seeds the indicator.
- [ ] 7. `app/api/employee/penny-chat/route.ts` — POST, `claude-haiku-4-5`,
      streaming, MAX_TURNS 4. **No `output_config.effort`, no `thinking` block** —
      both error on Haiku 4.5. Split system prompt: static block (cached) +
      per-request date block (uncached) so the cache can actually hit.
      Transcript guard: drop leading assistant turns after slicing.
- [ ] 8. `src/components/ceo/use-ceo-chat.ts` — optional `feedbackEndpoint`
      (`null` ⇒ no thumbs) and `onQuota` (reads the `X-Penny-Quota` response
      header). CEO/Admin behaviour unchanged when the props are absent.
- [ ] 9. `src/components/ceo/CeoChatBubble.tsx` — optional `quota` prop: header
      pill, warning line, exhausted state (composer greyed, reset time shown,
      panel still opens and the transcript stays readable).
- [ ] 10. `src/components/employee/EmployeeApp.tsx` — mount on the Overview tab
      only (`activeTab === 'dashboard'`), `endpoint="/api/employee/penny-chat"`,
      `feedbackEndpoint={null}`.
- [ ] 11. `npx tsc --noEmit` + `node --test` on the new tests (check for a live
      `next dev` before any build — shared `.next/`).
- [ ] 12. Docs: `docs/features/employee-penny-ai.md`, `docs/features/INDEX.md`
      row, memory `employee-penny-ai` + `MEMORY.md` pointer — same commit.

## Out of scope (contract)

The employee dashboard's own cards and figures; the Pay Stubs / My Hours / KPI /
MESA / Leave tabs; every write path; `payment_dispatches`; the paystub queue;
`/api/ceo/chat`, `/api/admin/penny-chat`, `ceo-tools.ts`, `admin-tools.ts`;
`FEATURE_CATALOG`; a full-page Penny tab for employees (bubble only, as asked).
