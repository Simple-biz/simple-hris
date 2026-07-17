# Session Log — 20 Recent Claude Sessions (Jul 15–17, 2026)

Reconstructed from Claude Code session transcripts. Covers the 20 most recent
working sessions (Jul 15 evening – Jul 17, 2026, UTC), grouped by day, newest
first. Each entry lists what was asked and the effort size (assistant-turn
count as a rough proxy for depth).
Continues [audit-2026-07-10-session-log.md](./audit-2026-07-10-session-log.md).

---

## Big themes this stretch

1. **MESA overhaul (Jul 16)** — the dominant thread, spanning five sessions.
   The "All Members" tab became a strict **Non Members** tab; the `mesa_ledger`
   was reloaded from a fresh "MESA Database - Active" sheet export (preserving
   124 DB-only disbursements worth ₱995k); membership flags were re-seeded
   (fixing april@ and 12 others); **per-stint MESA accounts** landed
   (`mesa_accounts`, account numbers `YY-MM-#####`, opt-out zeroes/closes,
   re-join mints a new number); and all MESA tabs gained a **department
   filter** plus **Global Master List source-of-truth gating** (off-roster
   people are hidden, never deleted). See [features/mesa.md](../features/mesa.md).
2. **Tickets hardening + redesign (Jul 15–17)** — access locked to the
   dedicated `tickets` role only (dashboard roles no longer confer it);
   ticket **assignment locked to the board owner** (kaner@simple.biz), with
   every new ticket defaulting to him; the Overview page redesigned twice
   (a dataviz/IA pass, then a mockup translation with smoked-glass KPI cards)
   and made the **default landing view**. The black+red console theme was
   explicitly reaffirmed over a light/violet mockup. See
   [features/tickets-board.md](../features/tickets-board.md).
3. **Payroll Wizard (Jul 17)** — a four-round **PAB payout-week bug hunt**
   (shared `isFinalPabWeek` containment gate, neutral "In Progress" pill,
   replay-snapshot fix, and the real root cause: Sunday-starting Hubstaff
   files resolving to the wrong PAB month); and the **Payroll Notes**
   checklist gained an **Adjustment column** and a **weekly period selector**
   backed by server-stamped Manila weeks. See
   [features/payroll-wizard-notes.md](../features/payroll-wizard-notes.md).
4. **HR surfaces (Jul 17)** — Global Master List gained **PDF/XLSX/CSV
   export** (CEO-dashboard-themed), a per-card **View** detail dialog, and a
   **Sync-deprecation warning**; Offboarding gained the **Weekly Pulse** KPI
   cards (weekly offboard count + attrition rate with its own week selector —
   Teal's request, commit `87053fb`).
5. **Data-integrity firefighting (Jul 16)** — a re-hired employee
   (markg@) was invisible because the promote flow reused his old offboarded
   master row without clearing the flag; two overlapping sheet syncs orphaned
   719 rows and collapsed the active roster 1109 → 390 (restamped back);
   Hubstaff's `activities/daily` endpoint hit a persistent 429 (diagnosed:
   per-instance caches multiply the poll rate; shared-cache fix recommended,
   not yet built).

---

## Deployment prerequisites left open at the end of this window

| Step | Why |
| --- | --- |
| Run `references/sql/alter/add_adjustment_and_week_start_to_payroll_wizard_notes.sql` in Supabase | Payroll Notes board edits fail until the `adjustment` + `week_start` columns exist |
| Run `references/sql/migrate/2026-07-16_mesa_accounts.sql`, then `node scripts/seed-mesa-accounts.mjs --apply` | Creates `mesa_accounts` + backfills 307 stint accounts; until then Account # shows "—" and balances fall back to full-history math |
| Run `references/sql/migrate/2026-07-16_tickets_dedicated_role_only.sql`, then re-grant the Tickets role | Revokes the leaked per-dashboard tickets grants; dashboard roles no longer confer board access |
| Run `references/sql/alter/add_requested_segments_to_time_adjustments.sql` | Time-adjustment submissions now insert `requested_segments` and error without the column |
| Push the uncommitted Jul 17 work | PAB fixes, Payroll Notes, GML export, tickets changes were all local at session end |

Open recommendations (diagnosed, not built): shared (cross-instance) cache for
the Hubstaff live-hours overlay; `toggle-mesa-member` only matches the rates
sheet's Work Email column (personal/alternate-email opt-ins silently no-op);
the promote flow reuses offboarded master rows without clearing flags; no
concurrency lock in the master-list sheet sync.

---

## Jul 17, 2026

### Payroll Notes — Adjustment column + weekly period selector
`f1f930d2` · ~123+ turns · **major**
- New free-text **Adjustment** column between Worker and Notes (the concrete
  pay change, e.g. "+$50 bonus"), flowing through the API field whitelist,
  blank-row seeding, open-count badge, and the CEO chat tool.
- **Period selector** (prev/next + dropdown) over Manila-Monday payroll weeks.
  Notes get a server-stamped, non-editable `week_start` on Add Row / first
  write. The live week shows this week + blank seeds + still-open carry-overs;
  past weeks are read-only snapshots (Add Row disabled). New shared helper
  `src/lib/payroll/manila-week.ts`.
- **Migration PENDING**: `add_adjustment_and_week_start_to_payroll_wizard_notes.sql`.
- Third request (Worker-cell autocomplete fed by the Global Master List +
  recently offboarded employees, for last-pay management) was in progress when
  the transcript was captured.

### PAB payout-week gate — four rounds of fixes
`fc74c4d4` · ~209 turns · **major**
- "Why is the PAB still on this week?" → the attach condition
  `weekEnd >= periodEnd` re-attached PAB every week after the payout week.
  Replaced with shared `isFinalPabWeek()` (`dispatch-bonuses.ts`) — PAB
  attaches only to the ONE week **containing** the period end — across all 5
  surfaces (Wizard, current-pay, EmployeeDashboard, member-monthly-pay,
  hsl-week-snapshot). Also fixed a monthly double-count and gated an expensive
  Hubstaff scan to the payout week.
- Pill rule: a running period shows neutral "⏳ In Progress", never green
  +₱5,000 (green needs a real end-of-period verdict).
- Replay bug: an empty locked snapshot (`{}`) suppressed live computation →
  replays showed ₱0 for everyone. Empty now means absent, with live fallback.
- Root cause of the lingering "+5000 on Jul 5–11": `fileMonth` walked back to
  a Monday, but Hubstaff files start **Sunday**, so the file evaluated June's
  finished PAB. Fixed `fileMonth`, `pabMonthDataCoverage`, and
  `pabMonthFromWeekStart`'s Sunday branch (also fixed dispatch-staging
  exclusions and the paystub `pab_evaluation.month_label`).
- 170/170 tests pass. Known quirk left to self-heal: June's period override is
  misfiled under the `"2026-05"` key in `app_settings` (harmless; rewritten on
  next settings save).

### HR Global Master List — PDF/XLSX/CSV export, Sync deprecation, View dialog
`ffc64f41` · ~185 turns · **major**
- New `src/lib/hr/global-master-list-export.ts`: fully client-side export.
  CSV (BOM + RFC-4180), XLSX (autofilter), PDF **themed like the CEO
  dashboard** (orange→rose gradient, `#0d1117` dark). Export dropdown sits in
  the toolbar row next to Search.
- Clicking hero **Sync** now warns the feature will be deprecated as data
  moves HRIS-native, with a "Sync anyway" escape hatch.
- Each roster card gained a **View** button opening an employee detail dialog
  (avatar + live-status dot, emails, start date, tenure, phone, location) —
  field list matched to Admin's "Master list information" pane.

### Tickets Overview — mockup translation + smoked-glass KPI cards
`23e7ebb9` · ~99 turns · **medium**
- A shared Claude-design mockup (light/violet) couldn't be fetched; user
  pasted a screenshot and chose to **keep the black+red console**, adopting
  only the structure/motifs (window-control dots on every card, toned delta
  sub-lines).
- **Overview is now the default landing view** on `/tickets` (global, not
  per-user); deep-linked `?ticket=` still opens its dialog on top.
- KPI cards got glassmorphism, then a "smoked not hazy" revision:
  `bg-card/65` + `backdrop-blur-[3px]` + white/10 rim over a soft red glow.

### Tickets — assignment locked to the board owner
`cd8bff3e` · ~83 turns · **medium**
- All new tickets default to **kaner@simple.biz**, and only the owner can
  assign/reassign — enforced server-side in the two API routes that write
  `assigned_to`, with UI gating (locked assignee selects, "owner-only" note)
  in TicketDialog and Admin → Design & Specs. Supersedes the earlier
  "developers can self-assign" behavior from commit `07127b1`.

### Hubstaff API — health & scale Q&A (no code changes)
`ac73d552` · ~25 turns · **analysis**
- The real 429 the user hit on "Sync from Hubstaff" is handled by design
  (calm toast, no ingestion, manual CSV path intact). Scaling math: the weekly
  sync is cheap (~17 calls for 1,200 people); the **live My Hours overlay** is
  the budget-drainer — per-instance caches on Vercel multiply polls past
  Hubstaff's 1,000 calls/hr. Recommended (not built): shared cache + 5-min
  poll + smaller live window.

### HR Offboarding — Weekly Pulse KPI cards (Teal's request)
`a6abfe4c` · ~87 turns · **medium**
- New `OffboardingWeeklyPulse.tsx` between the hero and the queue card:
  **Offboarded** (weekly count, vs-last-week chip, 8-week sparkline) and
  **Attrition rate** (Overview formula, annualized in by-week mode) with its
  own rose-tinted All time / By week selector. Committed as `87053fb`
  ("Teals Request").

### Tickets 404s — stale dev-server cache (advisory only)
`3af74838` · ~12 turns · **minor**
- Console 404s on `/api/tickets` etc. were a stale `.next` snapshot; live
  curls returned 401/307. Recommendation: hard refresh or clear `.next`.

## Jul 16, 2026

### MESA — per-stint accounts (`mesa_accounts`, `YY-MM-#####`)
`4cc810e3` · ~152 turns · **major**
- Started as "why isn't april@ an Active Member?" — the tab reads the
  `mesa_member` flag, not the ledger, and the stale seed predated her re-join.
  Flags re-seeded live (292 enrolled; joang flipped to opted-out).
- Built per-stint accounts: one `mesa_accounts` row per enrollment stint;
  **opt-out closes and zeroes the account, re-join mints a new
  `YY-MM-#####`**; balances aggregate only from the open account's opening
  date (April: sane ₱800 vs the old −₱12,000 full-history math). Account #
  column (searchable, teal badge) on Active Members. All flips route through
  `toggle-mesa-member`.
- **PENDING**: run `2026-07-16_mesa_accounts.sql` then
  `seed-mesa-accounts.mjs --apply` (307 accounts: 265 open / 42 closed).

### MESA — department filter + Global Master List source of truth
`8285a287` · ~129 turns · **major**
- "All departments" filter on all three Accounting → MESA tabs.
- New shared `src/lib/roster/roster-emails.ts` (work/personal/alternate email
  matching against `active_employees`); Requests, HR Opt-In queue, and FPU
  sign-ups now **hide** off-roster rows (never delete — restoring the person
  restores their requests), with an amber "N hidden" indicator.
- Hardened after an adversarial review: roster-fetch failures throw loudly
  instead of silently hiding everything; tab-cache key bumped to
  `mesa:requests:v2`. Payment flows deliberately NOT gated so approved payouts
  can't vanish mid-flight.

### MESA — Non Members tab, roster collapse, ledger reload
`f6c3a1e1` · ~29 turns (died at context limit) · **major**
- "All Members" → strict **Non Members** (`mesa_member = false` AND no start
  date; opted-out ex-members appear on neither tab).
- **Roster-collapse incident**: two overlapping master-list sheet syncs left
  719 rows stamped with a never-promoted upload id — `active_employees` fell
  1109 → 390. Restamped live; roster restored. Root cause (no sync lock)
  deliberately left unfixed.
- Generated the 8,144-line `2026-07-16_reload_mesa_ledger_from_active_sheet.sql`
  + reusable `scripts/load-mesa-ledger-from-csv.mjs` (dry-run by default),
  preserving 125 DB-only money-history rows a naive mirror would have dropped.
  The reload was verified applied by the follow-up session (8,076 ledger rows).

### Tickets — dedicated `tickets` role only
`455bff4d` · ~84 turns · **medium**
- Two leaks fixed: every dashboard catalog baked in a "Ticket Board" tab
  (auto-granting `edit` with any dashboard role), and the view switcher showed
  Tickets to all dashboard-role holders. Removed the tab from all four
  catalogs; gated switcher, route, and layout on the `tickets` role (+ admin);
  hardened `listTicketMembers`. 48/48 authz tests pass.
- **PENDING**: run `2026-07-16_tickets_dedicated_role_only.sql` (revokes
  leaked grants), then re-grant Tickets to whoever should keep it.

### Missing promoted employee — markg@simple.biz (data fix)
`3fc99a5f` · ~85 turns · **medium**
- Koki (re-hire on a recycled email) was promoted but invisible: the promote
  flow reused his old master row **without clearing `off_boarded_at`**.
  Cleared his flags + fixed a doubled-nickname display name; verified visible.
  Of 92 "promoted but offboarded" rows only 2 were bug victims; Calibara has
  left, so his stale-upload-id row was deliberately left alone. The
  promote-flow code bug itself was recorded (memory) but not patched.

### Manager KPI calculators — external members for five more departments
`ebce79b9` · ~43 turns · **minor**
- `EXTERNAL_MEMBER_DEPTS` grew from `['edit']` to include `client_va`,
  `lead_gen`, `pm_team`, `site_building`, `smm` — same temporary,
  gone-next-cycle mechanism as the Edit team. Caveat: in roster-only
  departments an external member only sticks if a catalog bonus is applied.

### Hubstaff — "is the API still connected?" (no code changes)
`f493660b` · ~18 turns · **analysis**
- My Hours stopped updating: credentials healthy, but `activities/daily`
  returns persistent 429 and `fetchLiveHours` silently keeps stale data, so
  the tab looks frozen. Same per-instance-cache diagnosis as `ac73d552`.

### settings.local.json — leftover git conflict markers
`69ccf8d0` · ~15 turns · **minor**
- `.claude/settings.local.json` contained unresolved stash-merge conflict
  markers; both sides' permission entries kept, markers removed.

### Failed sessions (no work)
`ef6aa56f` · 3 turns, `5fa5f613` · 1 turn — both died on "Prompt is too long":
the 1.7 MB MESA ledger-reload migration was attached/selected, blowing the
context limit. The april@ question they carried was answered in `4cc810e3`.

## Jul 15, 2026 (evening)

### Tickets Overview — dataviz/IA design pass
`65752001` · ~66 turns · **medium**
- Removed duplicate status-count KPI tiles; added the 48px "Open now" lead
  figure with urgent chip + oldest-open row; four compact tiles with
  week-over-week deltas; priority bars with a 420ms grow animation
  (reduced-motion gated); a11y focus rings and real-count `aria-label`s.
  Verified via an SSR harness + headless screenshots at 1440/768/390px, which
  caught a phone-width overflow bug (fixed with `grid-cols-1`).

### Time Adjustments — time-in/time-out check (no code changes)
`bdc520af` · ~8 turns · **analysis**
- Confirmed the flow only captured a total duration (`requested_hours`); no
  time-in/time-out anywhere in dialog, table, API, or review panel. Ernest's
  prior time-stamp work was never merged into this repo.
- **Follow-through (Jul 17, session outside this window's transcripts)**:
  implemented as `requested_segments` jsonb (max 6 non-overlapping ranges =
  the full worked timeline; `requested_hours` computed server-side from them).
  Requires running
  `references/sql/alter/add_requested_segments_to_time_adjustments.sql` in
  Supabase before deploy. See
  [features/time-adjustment-requests.md](../features/time-adjustment-requests.md).
