# Session Log — 20 Recent Claude Sessions (Jul 8–10, 2026)

Reconstructed from Claude Code session transcripts. Covers the 20 most recent
working sessions (Jul 8–10, 2026), grouped by day, newest first. Each entry lists
what was asked and the effort size (assistant-turn count as a rough proxy for depth).
Continues [audit-2026-07-07-session-log.md](./audit-2026-07-07-session-log.md).

---

## Big themes this stretch

1. **Department Transfers v2 (Jul 8–10)** — the dominant thread. A manager-driven
   "pull-in" transfer model with a two-stage consent flow, Google-Sheet write-back,
   past-dated transfers, a rate-linked **Accounting → Transfers** tab, a dedicated
   **Manager → Transfers** tab, and mid-week rate proration wired into the Payroll
   Wizard. Multiple follow-up sessions polished it (Done sub-tab, 409 self-heal,
   rate-change column sourcing, delete button).
2. **PostgREST 1000-row silent-truncation bug (Jul 9)** — discovered while chasing a
   "missing from picker" report: un-paginated `.range(0, 9999)` reads silently cap at
   1000 rows, and the active roster is **1075**. Fixed the roster reader and audited
   ~44 more latent call sites across the data layer.
3. **New subsystems** — Orphanage **3rd Party Vendors** tab with SIMPLE-branded
   invoices (Jul 9); editable **People profile** writing back to the master list +
   Google Sheet (Jul 10); two-way **tutoring chat** during admin screen-watch, then
   admin terminate + "Admin" label anonymization (Jul 9–10).
4. **Identity / RBAC hardening (Jul 9)** — alternate-work-email login now bridges
   roles, department, and the feature-permission overlay (not just hours/rates); the
   Hubstaff↔Master reconciliation gained offboarded/dept-exempt/On-Leave exception
   buckets.
5. **HR data-integrity fixes** — New Hire Checklist rebuilt as a modal-only, atomic,
   conflict-safe grid (Jul 10); Offboarded-sheet automation fixed to stop writing
   blank Location/date/reason (Jul 9); NCNS offboarding reason added (Jul 8).
6. **Bonus cadence + payroll polish (Jul 8)** — Weekly/Monthly bonus toggle wired
   through the Payroll Wizard; COP symbol normalized to `$COP`; PAB pill shows
   provisional "Eligible".

> **Note:** `d0ba1fce` (Bonus cadence, below) began Jul 7 and appeared in the prior
> log's window as *"HR Transfers + Bonus cadence toggle"*; its full detail is captured
> here since the bulk of it landed Jul 8.

---

## Jul 10, 2026

### People profile — editable View Modal → Global Master List + Google Sheet
`46a9ae8d` · ~221 turns · **major**
- Accounting/CEO → People → Roster → **View Modal** Profile tab is now **editable**
  (was 100% read-only). Saving writes `global_master_list` **and** the master Google
  Sheet; Admin/HR reflect it automatically (same table).
- New: `PATCH /api/people/[email]/profile`, `updateMasterListProfile` (collision
  precheck), a generalized multi-cell Sheet-row writer, and an idempotent
  `active_employees` view recreate to expose `id`/`Phone Number`/`Location`
  (**migration #109, PENDING**).
- Guardrails from the user's choices: Name → surname-first canonical; Work Email /
  Dept collision precheck + can't-be-blanked; structured address synced to Sheet
  `Location`; Sheet-write failure warns (best-effort). Adversarial review confirmed
  10 findings; 8 fixed (incl. the personal-email OR-match that could overwrite a
  bystander's Sheet row, and formula-injection guarding).

### New Hire Checklist — modal-only lock-down + atomic hardening
`4da81f21` · ~85 turns · **major**
- Teal (Recruitment) reported concurrent edits losing data. Root cause: the
  whole-grid Save made the DB match the saver's grid exactly (**delete-missing**),
  and best-effort co-editing with no join-snapshot let grids drift → last saver
  wiped others' rows.
- Rebuilt the tab as a **read-only, modal-only grid**: every mutation is an atomic
  per-row `POST`/`PATCH`/`DELETE` (+ bulk-set-field); edit uses optimistic
  concurrency (`expectedUpdatedAt` → **409 reconcile**); `lock` fires the webhook
  from DB truth. New `useChecklistRoom` hook: presence **soft row-lock** + "week
  changed → refetch" broadcast. Verified live (new handlers return 401, not 405/500).

### Admin cobrowse — End chat, "Admin" label, GML Refresh + live telemetry
`ddc1d648` · ~123 turns · **medium**
- Admin can now **End chat** (terminates on both sides, clears live messages,
  decoupled from the screen-watch, reopen bubble, auto-cleanup on stop/switch).
- Admin messages now show as **"Admin"** to the watched person (via a `send({ asName })`
  override); driver replies keep their real name.
- **Refresh** button beside Sync on the Global Master List force-pulls live presence
  + refetches last-seen; 15s auto-tick + pulsing "Live" dot. (Presence already
  streams live over the `hris-presence` Realtime channel — the button is a manual
  force-pull.)

### Payment Dispatch bank dropdown + Wepay retirement; Transfers 409 + Done tab
`a360ed78` · ~145 turns · **medium**
- **Mark as Paid → Bank used** is now a dropdown (Chase, Jeeves, Parallax, PayPal,
  Wise, x1161, x1153, x0048, Remitly, HiGlobe, Hurupay); confirm stays disabled until
  a bank is picked.
- Retired **Wepay** from the Payment Dispatch tabs (mirrors the employee-processor
  retirement: `RETIRED_DISPATCH_PROCESSOR_IDS` / `DISPATCH_PROCESSORS`; label lookups
  keep `wepay` so history resolves).
- Department-transfers PATCH **409** ("already decided") now **self-heals** (info
  toast + list reload). Added a read-only **Done** sub-tab to Manager Transfers for
  resolved release decisions.

### Accounting Transfers — "Rate change" sourced from Payment Catalog
`bb049b1a` · ~49 turns · **medium**
- The Rate-change column was stuck "pending" for **department** moves because it read
  `employee_rate_history`, which only gets a row for **individual** pay structures
  (dept rates are a compute-time overlay). Repointed it to the Payment Catalog
  department base rates: **from-dept → to-dept**, each side in its own currency,
  colored **green (increase) / red (decrease) / neutral** (equal or cross-currency);
  "no catalog rate set" replaces the misleading "pending".

---

## Jul 9, 2026

### Department Transfers v2 — pull-in flow, wizard proration, 1000-row cap fix
`5df37278` · ~685 turns · **major**
- Explained the existing transfer model, then built **v2**: receiving manager pulls a
  person from a global name/dept picker (no pay shown) + proposes an effective date →
  the **source manager** gets Release/Decline → on Release the dept flips in
  `global_master_list` **and** the Google Sheet. Later changed to apply the move
  **immediately on release** (effective date governs only rate proration) to fix a
  stuck-in-`approved` case; added **Apply now**.
- New **Accounting → Transfers** tab (rate-visible only), **HR Transfers** made
  read-only history, and a **dedicated Manager → Transfers** tab (animated
  Release/My-requests/Done sub-tabs, timestamps, dept filter, work-email search,
  past-dated support, delete button). Registered across FEATURE_CATALOG /
  VIEW_TAB_IDS / DASHBOARD_PAGES + default-deny seeds (**pending SQL #107**).
- **Payroll Wizard mid-week proration**: `proratePayForMidPeriodChange` now mirrors
  Payment Dispatch byte-for-byte (client-safe resolver + `/api/payroll/rate-history-bulk`;
  adversarially reviewed, 2 parity fixes applied).
- **Critical bug found & fixed:** PostgREST silently caps un-paginated reads at 1000
  rows; the roster is **1075**, so `jamesc@simple.biz` + ~74 others vanished from the
  picker. Added `fetchAllActiveEmployeeRows` pagination; audited ~44 more un-paginated
  reads (flagged work-email minting, rates CSV sync, dispatch queue, team roster).

### Orphanage — 3rd Party Vendors tab + SIMPLE-branded invoices
`748d17e7` · ~160 turns · **major**
- New Orphanage **3rd party vendors** tab, deliberately separate from Payment Dispatch
  (own tables, no n8n). Vendor directory (business/contact, address, products &
  services, dual banking SWIFT+account or routing+account) + an invoice builder that
  renders **SIMPLE-branded** invoices (logo, line items, live totals, Print/Save-PDF)
  and a **Mark-paid** action that stamps a diagonal **PAID** watermark.
- Tables via `create_orphanage_vendors.sql` (**pending SQL #108**); RBAC-gated;
  adversarial review fixed 3 bugs (double-print guard, view-only read carve-outs,
  dangling `vendor_id` on delete).

### Alternate work email → RBAC & identity bridge
`a16fb9d7` · ~160 turns · **major**
- April signs in as her **alternate** work email (`aprilg@`) but her role, permissions,
  and identity keyed off her **primary** (`april@`) → no ViewSwitcher, empty My Team,
  no MESA tab, redirect loop. New `expandWorkEmailAliases()` bridges **role lookup**
  (JWT + live fetch), **self-identity/department**, and the **feature-permission
  overlay** across a person's linked work emails (self-reads union, most-permissive
  wins; admin cross-reads stay exact). Code-only, verified against live data.

### Hubstaff↔Master reconciliation — exception buckets (offboarded / dept-exempt / On Leave)
`6a54c88c` · ~197 turns · **medium**
- Hardened the Accounting Overview recon so fewer legitimate cases read as directory
  gaps: any Hubstaff worker with hours but not on the active master list is treated as
  an **offboarded exception** (enriched from the Offboarded sheet by work/personal
  email); **Sales** + **USEE** added to the no-Hubstaff dept-exempt set;
  `seungyong@simple.biz` hard-excluded; approved-leave no-hours staff get a dedicated
  **On Leave** status + filter chip (matches overlapping OR upcoming leaves). CEO
  mirror shares the rows.

### Two-way tutoring chat during admin screen-watch
`61053ab6` · ~65 turns · **major**
- Watching someone from Admin → Global Master List can now open a **two-way chat** to
  tutor them live: a docked window on the admin side, a pop-up on the watched person's
  screen that appears **only when the admin sends the first message** (preserving the
  silent-watch contract). New `hris-cobrowse-chat` Broadcast channel (live-only, not
  persisted).

### Offboarded-sheet automation — fix blank Location/Start Date/Reason/Date
`490f1fe5` · ~122 turns · **medium**
- The Masterlist Offboarded-tab automation wrote incomplete rows (John fixed them by
  hand). Two causes: the offboard route never captured location/phone, and the
  append-writer's hardcoded header switch had drifted from the tolerant reader. Rewrote
  the writer to use a **shared alias-map matcher**, added location/phone selection, and
  wrote the reason as the **dropdown label** (not the raw enum slug, which failed the
  sheet's data validation). Built a dormant, dry-run-by-default backfill endpoint. Work
  staged (local Google write blocked by a mangled local `.env` key).

### Payroll Wizard — last-sync timestamps for the three Google syncs
`7f1b1619` · ~91 turns · **medium**
- "Initialize Payroll Data" now shows a **"Last synced …"** line on each of the three
  sync cards (Employee Roster / Payroll Rates / Hogan Pay Plan). Source of truth is the
  **audit trail** (`csv.master.sync` / `csv.rates.sync` / `csv.hsl.sync`), so
  cron-triggered syncs count the same as manual clicks (no schema change). New
  `fetchLastSyncTimestamps` + `GET /api/accounting/sync-status`.

### Employee Profile — static "Request Documents" tab + widen form
`ef58dbc1` · ~65 turns · **minor**
- Added a **UI-only** "Request Documents" tab (between Reports and Resign): document-type
  dropdown (COE / 6 Months of Pay Stubs / Certificate), optional details, disabled
  Submit. Widened the profile column to 1200px so all 7 tabs + subtitle fit. No API/DB.

### Q&A — "Off-roster" badge + missing-email diagnosis
`41f28fe6` · ~30 turns · **minor** (diagnostic, no code)
- Explained the Admin GML **Off-roster** badge (online session whose email isn't in the
  synced roster set) and diagnosed `julyb@` / Ruth B off-roster as an email-match issue
  (their SSO login email differs from the address on their master row).

### Q&A — does Transfers rewrite the Global Master List?
`ff4618b5` · ~5 turns · **minor** (diagnostic, no code)
- Confirmed `applyDepartmentTransfer` UPDATEs `global_master_list.Department`; roster/team
  membership follows automatically; flagged that the (then-current) path did **not** write
  the Google Sheet, so a manual sheet sync could revert it (since fixed in v2).

### Q&A — onboarding paperwork live link
`0344662c` · ~15 turns · **minor** (diagnostic, no code)
- Reported the public, token-gated onboarding URL pattern
  (`https://simple-hris.vercel.app/onboarding/<token>`, rate-limited via `proxy.ts`).

---

## Jul 8, 2026

### Bonus Weekly/Monthly cadence toggle + COP symbol + no-show offboard warning
`d0ba1fce` · ~326 turns · **major** *(began Jul 7)*
- **Cadence toggle:** Payment Catalog bonuses carry Weekly/Monthly (`BonusDef.cadence`,
  **migration #103 PENDING**). Monthly bonuses surface in the manager KPI Calculator
  only on the **final payroll week of the month** and are paid once by the Wizard
  (mirrors PAB). Preceded by a no-code design analysis of transfers vs period-earned
  bonuses.
- **COP symbol** flipped to **`$COP`** app-wide with a `currencyChipLabel` helper to
  stop "COP$ COP" double-printing.
- Diagnosed a `useEffect dependency array changed size` error as a harmless **Fast
  Refresh/HMR** artifact (no code change).
- Manager **"Did not attend"** no-show already fired the offboarding webhook
  (`never_promoted:true`); made the warning copy explicit. Compacted the memory index.

### Payroll Wizard — PAB pill "In Progress" → provisional "Eligible"
`500d5d26` · ~70 turns · **minor**
- The Additions-tab PAB pill now shows green **Eligible** with the Payment-Catalog
  amount as soon as no weekday has failed (provisional), rather than "In Progress".
  **Display-only** — actual payout stays gated by the `perfect_attendance` toggle; HSL
  tab (step 4) deliberately unchanged.

### MESA missing from Admin Roles grid + stale-build false alarms
`3637c4bf` · ~56 turns · **minor**
- `mesa` was wired into `accounting-tabs.ts` but never added to
  **`FEATURE_CATALOG.accounting`** (the single source the Admin Roles grid renders), so
  it had no toggle row — one-line fix. The other three prompts were **stale `.next` /
  Vercel build** false alarms (a "Property 'mode' is missing" error and an rrweb
  ChunkLoadError from `rm -rf .next` under a running dev server).

### Add NCNS offboarding reason to the Manager queue
`27506c9a` · ~36 turns · **minor**
- Added **NCNS** (No Call, No Show) to the top of the Manager → Queue-for-Offboarding
  reason dropdown, in all three enforced places (shared reasons file, server's
  authoritative copy, SQL doc comment). No migration (reasons are API-enforced, not a
  DB CHECK).

---

*Generated 2026-07-10 by scanning `~/.claude/projects/.../*.jsonl` transcripts (clean
per-session digests → fan-out summarizers). Turn counts are assistant-message totals
and only approximate effort.*
