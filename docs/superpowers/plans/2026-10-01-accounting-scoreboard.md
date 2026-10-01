# Accounting Scoreboard — in HRIS, served on its own domain

**Brief:** in-session 2026-10-01 (session `9fe90c48`). Kane: *"we are not using appscript … just
nextjs typescript … basically its in this project … just on a different domain"*, then
*"accounting-bonus.vercel.app - lets point that here"*. Built under the 2026-09-26 blueprint rule:
recommendations taken (CHOSEN 1–6). The NEEDS lines (the points-vs-accounts money ruling, the bonus
shape after Carla's revamp, and the history import) are left out behind honest seams. The analysis
it starts from is `docs/notes/2026-10-01-accounting-scoreboard-analysis.md`.

**Stack:** Next.js app router, Supabase service role behind a server-side member check,
`node --import tsx --test`.

## Task 1 — the data layer

- [ ] `references/sql/create/2026-10-01_accounting_scoreboard.sql`
  - `accounting_scoreboard_rows`: section key (CHECK = the 10 keys), label, optional HRIS work
    email, sort order, created/archived stamps. One live label and one live person per section.
  - `accounting_scoreboard_entries`: (row, date, slot) primary key. Slot is one of am · pm · day ·
    mtg · start · end. Value is ≥ 0, minutes ≤ 1440, and the meeting flag is 0/1.
  - `accounting_scoreboard_collections`: the log (date, rep row, business, points 0–100, amount).
    A composite FK pins the rep to a **collections** row. Rows are append-only: a trigger refuses
    every edit except the one soft delete.
  - `accounting_scoreboard_members` (extra members) and `accounting_scoreboard_sections` (on/off,
    goal override).
  - RLS on, zero policies, privileges revoked from anon/authenticated, not in realtime.
- [ ] `scripts/apply-accounting-scoreboard-migration.mts`: dry by default, `--apply`, `--verify`;
  object checks and negative controls.

## Task 2 — pure modules + tests

- [ ] `src/lib/accounting-scoreboard/sections.ts`: the 10 sections (kind, days, slots, goal).
- [ ] `src/lib/accounting-scoreboard/week.ts`: Sunday week keys, US Eastern "today", day dates.
- [ ] `src/lib/accounting-scoreboard/scoring.ts`: the sheet's formulas (bucket tiers, inbox
  10 − avg, WTD, averages, hours, ranks, record), plus missing-PM handling.
- [ ] `src/lib/accounting-scoreboard/host.ts`: the pure host decision the proxy calls.
- [ ] `src/lib/accounting-scoreboard/validate.ts`: request-body parsing for every write.
- [ ] Tests for each, plus a SQL ↔ code pin on the section keys and slots.

## Task 3 — server + routes

- [ ] `src/lib/accounting-scoreboard/server.ts`: the member/manager check (session email +
  alternate work emails), board read (selectAllPaged), and writes stamped from the session.
- [ ] `app/api/accounting-scoreboard/route.ts` (GET board) · `entries` (PUT) · `collections`
  (POST, DELETE) · `rows` (POST, PATCH) · `members` (POST, DELETE) · `sections` (PATCH) ·
  `roster` (GET, managers only).
- [ ] Dancing Queen preview: the live catalog formula assigned to `accounting`, evaluated with
  `evaluateFormula` on points and on accounts. Display only.

## Task 4 — page, host, docs

- [ ] `app/accounting-scoreboard/page.tsx` (server guard) and `src/components/accounting-scoreboard/*`.
- [ ] `proxy.ts`: an `ACCOUNTING_SCOREBOARD_HOST` block, inert until the env var is set.
- [ ] `docs/features/accounting-scoreboard.md`, the INDEX row, memory, Open item 315, and the
  analysis note's § 10.
- [ ] Typecheck, tests, one commit by explicit path. Never push.
