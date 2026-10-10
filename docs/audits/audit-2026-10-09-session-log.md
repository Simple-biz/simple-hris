# Session log — 2026-10-09

The **90 Claude sessions since the Sep 30 sweep** (Sep 30 11:49Z → Oct 9 16:29Z), checked against the documentation
by session `c0549c5f`, from their transcripts and the 260 commits `64728b4b..19672c89`. **No product code.** Kane:
*"Check all the claude sessions we had these past few days and last week make sure to update our documentation"*, then
*"like features design patterns and meetings"*.

Continues the [Sep 29 log](./audit-2026-09-29-session-log.md), which served as the running log from Sep 29 to Oct 9 and
holds **Open items 256–437**. Those rows are not repeated here. Where this sweep found one of them stale, it appended a
dated note to that row, marked *"2026-10-09 sweep `c0549c5f`"*: rows 334, 336 (both), 342, 353, 391, 392, 393, 398, 411,
412, 421, 424, 431 and 436, plus row 214 in the [Sep 25 log](./audit-2026-09-25-session-log.md). Rows **438+** are new.

**Dates are UTC** throughout.

**How it was checked.** A script reduced each transcript to Kane's messages, the commits it made (matched by hash
against `git log`), the files it edited, and how it ended. Every commit since the Sep 30 sweep maps to a session.
Nine read-only reviewers each took a date range and checked every session against the working tree. They checked the
feature doc for the behaviour that shipped, the INDEX and README rows, `docs/reference/*`, `docs/design/*`, memory, the
Open items, meetings, and anything edited but never committed. Only verified gaps were reported. Every state change
below (applied, pushed, live) was measured or read from a row that measured it, not taken from a transcript's claim.

**Measured, not read off a transcript.** "Pushed" comes from the `origin/main` reflog (`update by push` entries).
`origin/main` = local `main` = `19672c89`, pushed 2026-10-09 16:30Z. "Deployed" is still **not measurable from
here**: there is no Vercel CLI and the claude.ai Vercel connector is unauthorised.

## Sessions

Rows 1–44 are in the Sep 29 log.

| # | Session | When (UTC) | Shipped |
|---|---|---|---|
| 45 | `aeaf641d` | Sep 30 11:49 → 12:11 | **Every Transfers list loads the whole table, not 300 rows; the count is 434, not 299** (`27082696`, `0f783bf4`). Items 290, 291 |
| 46 | `89cc91e6` | Sep 30 12:33 → 14:55 | **Payroll Wizard → Validation → HRIS vs NPD tab**: work-email match, 3¢ tolerance with an "off by" box, excluded people left out (`e8c0cdba` … `851777f6`). Items 292–297 |
| 47 | `6cf219ad` | Sep 30 15:02 → 15:25 | **From the Sep 27 week, non-HSL pay is priced on 2dp hours × rate**; Sep 20–26 keeps whole seconds (`ae33f9fd`, `57e712f9`). Items 298, 299 |
| 48 | `77408540` | Oct 1 12:12 → 13:09 | **Every HR tab and every cold Manager tab paints from its tab cache**; Leaves cached on Kane's (b) (`70381811`, `9dbc17bc`, `c5555f3d`). Items 303, 304, 306. Its design-hook question went unanswered (item 439) |
| 49 | `d86dc079` | Oct 1 12:45 → 13:05 | **Notifications: Unread and Need Action tiles, every card stamped "April 5, 1999 : 8:00 AM EST"; the onboarding backfill stops re-sending 140 rows** (`abf5f7a0`, `97f1bdef`). Item 305 |
| 50 | `f13767cd` | Oct 1 13:18 → 13:45 | **OWASP Top 10:2025 audit**: 52 findings, 6 Critical, the public repo with bank data the worst. Nothing fixed (`d18ad5af`). Items 307, 308 |
| 51 | `8a6f547e` | Oct 1 13:28 → 15:09 | **Accounting → NPD**, the manual payroll sheet with Lock in and the Google Sheet's own formulas (`f92527b3` … `a24daf85`). Items 309–311, 313 |
| 52 | `75ddced6` | Oct 1 14:46 → 14:49 | Advisory: Admin Integrations is inbound-only, so Kentshin's compliance portal is pulled the OMS way; calendar month vs PAB window is open money (`16589600`). Item 312 |
| 53 | `07042ab7` | Oct 1 15:07 → 15:33 | **HRIS vs NPD "Save output"**, append-only versions per week, plus its migration (`ee8e5a8b`). Item 314 |
| 54 | `9fe90c48` | Oct 1 17:01 → 21:58 | **The Accounting Scoreboard** at `/accounting-scoreboard` and its own host, then polish, Payroll Timing from the Wizard (`7458fc5a` … `8a4a514d`). Items 315–318. Its route-access rule reached `route-authorization.md` only on 10-09 |
| 55 | `f103ca58` | Oct 1 20:45 → 20:46 | Advisory: "Not a Sunday week key" came from row 54's half-finished refactor and cleared when `c476ffe8` landed. Nothing changed |
| 56 | `0cbcdde0` | Oct 1 21:10 → 21:58 | **Scoreboard backfill from Carla's sheet** (9,852 collections lines, 41,888 cells) and the read-only archive (`789fb0fa`). Item 319 |
| 57 | `fee89c7a` | Oct 2 17:01 → 17:05 | Advisory: johnwm@ is under Excluded · No bank (no `employee_ids` row); not a bug |
| 58 | `7eb35ea9` | Oct 2 17:05 → 17:08 | Advisory: rob@ is in Roles only through Kane's `ceo` grant; answered in row 61 |
| 59 | `2e9e12d8` | Oct 2 17:21 → 17:41 | **Admin Penny draws the real employee ID card** (`get_employee_id_card`, 26 tools) (`9eda01e1`). INDEX and README counts corrected only on 10-09 |
| 60 | `117cbf24` | Oct 2 17:45 → 19:54 | **NPD: Google Sheet sync, progress bar, cache picture, virtualised grid, Lock modal** (`c28a7041` … `6a2c1f22`). Items 320, 323–326 (326: the global `*` transition rule; ui-standards § 14 now warns) |
| 61 | `1c11c3eb` | Oct 2 17:47 → 19:02 | **Salaried pay basis** (`4ef0da13`, item 322, four money rulings open) and **NPD Lock in + formulas migrations applied** (`f255de46`). Items 310, 313, 320 |
| 62 | `79a61ba9` | Oct 2 17:51 → 18:04 | **Onboarding Bypass/Save accept data sub-teams like `hsl:attorney`**; the suite passes 5,556/5,556 (`071297ce`, `88237d71`) |
| 63 | `4a8c39d3` | Oct 2 18:36 → 18:38 | Hardening CONFLICT on NPD cache (`23b425f5`), resolved (b) in row 60. Item 321 |
| 64 | `b004acdc` | Oct 2 18:48 → 18:50 | Advisory: Safari's own load-failure page; the site was back in six minutes. No finding |
| 65 | `c6782c06` | Oct 2 20:31 → 20:37 | **rob@ sees only View in CEO → People; Pay is hidden for him and `/api/people/pay` is 403** (`7c7f7046`) |
| 66 | `d2ba4c35` | Oct 2 20:44 → Oct 3 00:26 | **CEO Overview without the full-page skeleton; Payments to send cached** (`89b4347f`); **78 of 83 Monday rows Done on Kane's word** (`a9119036`). Items 328, 329, 331 |
| 67 | `334b41c6` | Oct 2 20:48 → Oct 4 23:08 | **Monday skill: no 1 SP; passes 38 and 39; 11 duplicate rows archived; Send to OMS button wired** (`f082ba96`); NPD Save migration recorded applied (`76296bad`). Items 327, 330, 332–336, 341 |
| 68 | `9a96c410` | Oct 3 01:10 → 01:17 | Advisory: no API keys on phones, pinning N/A; OW-3 and OW-29 open (`e88315ac`). The second row numbered 336 |
| 69 | `1f2f4528` | Oct 3 01:31 → 02:16 | **HRIS vs NPD fills itself from NPD once both tabs are locked** (`9d6225b6`, `9129b1d0`). Items 337, 339 (339 reversed by item 367) |
| 70 | `2904d73b` | Oct 3 01:54 → 02:27 | Advisory: 6 of 9 Monday rows still Pending Deploy (`0023dcec`). Item 338, resolved in 341 |
| 71 | `a04891b4` | Oct 3 02:22 → 02:37 | Advisory: HRIS Total Project SP 2,998, completed 2,813 (`66cba381`). Item 340, superseded by 431 |
| 72 | `ea96aacc` | Oct 3 02:44 → Oct 5 11:00 | **Employee Profile cold load skeletons only the pane** (`2af89fb6`). Item 345. The pattern reached `ui-standards.md` § 12.3 on 10-09 |
| 73 | `42db1628` | Oct 5 10:14 → 11:19 | Advisory: Monday backlog triage; the bare-`hsl` overrides still price pay; the 343 backfill already applied (`53a0dec5`, `efa568af`, `20ac1b6d`). Items 342, 343. Its email to Carla is on 342 since 10-09 |
| 74 | `38cf3b9d` | Oct 5 10:19 → 10:43 | **"Loading your Employee Dashboard" card on every cold mount** (`cd7fb08a`, `9762b30f`, `f8f91c29`). README row added 10-09 |
| 75 | `88c4e8cf` | Oct 5 10:29 → 10:52 | **Orientation no-shows go on the Offboarded list as NCNS, plus a backfill** (`118c6b9b`, `0bb8dae4`). Item 343 |
| 76 | `d2176700` | Oct 5 10:33 → 19:10 | **Recycled-email identity: an orientation mark re-dates only its own row; an address is never re-issued; promote never writes onto another person's bank row; Dispatch holds "Bank record is someone else's"; previous holders re-keyed** (`7d46dd1a` … `932942d9`). Items 344, 353. Owns the three untracked `scripts/rekey-*.mts` (row 353 note) |
| 77 | `c1003df8` | Oct 5 11:12 → 11:21 | **Global Master List: no gradient hero, Sync in the toolbar, 20-row pages, ledger rules** (`b46bb9f2`, `7667670a`) |
| 78 | `463210bd` | Oct 5 12:36 → 12:51 | **KPI Calculator QC first pass cached, with Retry** (`d2b93c08`). Item 346 |
| 79 | `fc9abea3` | Oct 5 12:57 → 12:58 | **Termination Letters header paragraph removed** (`3db9748d`) |
| 80 | `0759a043` | Oct 5 13:04 → 13:39 | **NPD loading card per tab × week, fed by a streamed read** (`da77be2b`). Item 348. Its two files reached the components index on 10-09 |
| 81 | `d7bac06f` | Oct 5 13:09 → 13:24 | **COE request → n8n email to jakec@, recipient editable** (`c7c9f8a7`). Item 347; the env-fallback warning (352) added to its doc 10-09 |
| 82 | `5975ee4c` | Oct 5 17:06 → 18:04 | **MESA: archive completed requests, n8n email per member request, a return carries its amount** (`d2115d23`, `c78f8c5b`). Items 349, 350, 352 |
| 83 | `94d30f8b` | Oct 5 17:26 → 17:38 | **Bulk Ignore on PAB Needs review; `/api/pab-exclusions` by compare-and-swap** (`3c9b2f47`). Item 351 |
| 84 | `3485da88` | Oct 5 17:59 → 20:45 | **Every table's Refresh keeps its rows and opens a progress modal** (`7d04a364`). Items 354–356. Its design-pass question went unanswered (item 439) |
| 85 | `7604a93f` | Oct 5 18:56 → 19:30 | **No native dropdown or date input left; picker popups escape clipping (`useEscapingPopup`); the Roles accent border kept** (`501e6cde`, `09618ab3`). Item 357 |
| 86 | `67866882` | Oct 5 19:02 → 19:13 | Advisory: ronaldc@ attended after the batch promote and was never promoted; ₱113.75 pay question. No row until item 440 |
| 87 | `12368ba9` | Oct 5 19:51 → 19:56 | **FINDING: a transfer apply hard-deletes the live row over an off-boarded target row; 6 paid people gone** (`a1a9860d`). Item 358 |
| 88 | `adf12936` | Oct 6 11:32 → 12:02 | **Monday pass 40 staged**; measured the MESA archive migration APPLIED and the n8n workflow active (`4c081959`, `1e6a1135`, `43fc708f`). Items 359, 350. The feature docs said PENDING until 10-09 |
| 89 | `d1583b1c` | Oct 6 11:37 → 12:25 | **MESA suspension from an effective date; uniform Action buttons; "saving" needs an open account** (`1f0a7350`, `972edc8d`, `55999aa5`). Items 360, 361 |
| 90 | `00f105f5` | Oct 6 12:27 → 12:30 | Advisory: rong@ is back via an onboarding bypass; the code fix is still not in (`e5cfebd3`). Item 358 |
| 91 | `56254fe8` | Oct 6 12:35 → 12:51 | **Accounting/CEO → People paints entirely from cache** (`8186145a`). Item 362 |
| 92 | `7fc39608` | Oct 6 13:10 → 13:42 | **A forgiven PAB day adds no hours; the 4 h floor retired; the calendar shows and revokes forgiven dates** (`33fccfbc`, `ca4e5514`). Item 363 |
| 93 | `62e89e9e` | Oct 6 13:52 → 14:05 | Advisory: the "no work email" banner is the Arriola ghost row; a guarded script (`976c58d9`, `e0f6773e`). Item 364 → 384 |
| 94 | `a46e470e` | Oct 6 14:07 → 14:43 | **SSD Medical Records scored from its Payment Catalog formula; colour teams gone** (`5fe90369`). Item 365. The "9 of 12" counts became 10 on 10-09 |
| 95 | `74fcc2be` | Oct 6 14:35 → 16:17 | **HRIS vs NPD Export CSV; excluded people become a count; the Notes column is the paystub's** (`921ddfcd` … `ae229888`). Items 366–368, 370 |
| 96 | `bac6cd3f` | Oct 6 15:34 → 15:44 | **Manager → My Team paints its frame, skeletons only the data** (`a2a9ad07`). Item 369 |
| 97 | `8ee05ac9` | Oct 6 16:24 → 17:04 | **HRIS vs NPD "Why" line and column; `POST /api/payroll-wizard/npd-identities`** (`fcd609ec`). Items 371, 372 |
| 98 | `1b35d87f` | Oct 6 17:22 → 17:54 | **Aliviah's email triaged; the Proof of Residential Address letter** (`897b5237`, `5935c119`). Items 343, 373–376 |
| 99 | `48c8828b` | Oct 6 17:23 → Oct 7 14:11 | **Carla's SCOREBOARD UPDATES round 3, the browser-cache paint, the streamed loading modal** (`66f40a60` … `a51de4e9`). Items 379–381, 387 |
| 100 | `4c6729e4` | Oct 6 17:45 → 18:07 | **Preview Emails paystub Refresh** (`fbe841ba`). Items 377, 378 |
| 101 | `04f2bf48` | Oct 7 12:43 → 12:59 | **Monday pass 40 written (16/16); pass 41 staged** (`86f12843`). Items 359, 382–384 |
| 102 | `3bc62721` | Oct 7 12:49 → 16:41 | **Aliviah's four asks answered; COP rates stored as COP** (`14ea111a` … `f1842508`). Items 343, 373–375 |
| 103 | `728157e2` | Oct 7 12:59 → 14:33 | **Scoreboard: custom sections inside built-in tabs, goals on every section, Team Score** (`72f96e70`, `e0f7566e`, `0b8748f6`, `fb080059`). Items 385, 387, 388 |
| 104 | `57c2276b` | Oct 7 13:08 → 13:55 | **Aliviah's own sign-in song** (`ce1d5cd4` … `53c53342`). Item 386 |
| 105 | `1f6686db` | Oct 7 14:34 → 14:40 | **The Send to OMS modal stops clipping the Amount** (`fc7c9d99`). No row until the 334 note (10-09) |
| 106 | `b69e13fd` | Oct 7 14:35 → 15:39 | **OMS return-table SQL for their dev; `pymcf` confirmed to hold the table** (`fde162ed` … `5e2e20cd`). Item 334. The feature doc was rewritten to that state on 10-09 |
| 107 | `29515503` | Oct 7 14:49 → 16:22 | **The Offboarded dataset on the external API** (`4cf42388`, `703d0107`). Item 389. API reference and README rows added 10-09 |
| 108 | `c3a1a730` | Oct 7 17:43 → 17:56 | **Alternate-email filers resolve to their owner, so the second-approver list fills** (`c073e076`). Item 390. API reference corrected 10-09 |
| 109 | `39022c5c` | Oct 7 20:04 → Oct 8 14:08 | **The Oct 7 Carla/Alivia meeting note, the meeting-notes skill, the round-4 plan, Kane's rulings, task boards + Post to Chat, the tasks import** (`cf2b5ff5` … `0b7d39c9`). Items 391–398, 410 |
| 110 | `5fae2311` | Oct 8 01:07 → 11:25 | **Round-4 Tasks 1, 3, 9: On Overview switch, Chargebacks signs + Net, Pre-arb as a loss, Monday's grid cleared** (`476b6b9f`, `63500994`, `c88c554c`, `34b937a2`, `42388492`). Items 391, 392, 399, 317 |
| 111 | `913c9ae5` | Oct 8 01:09 → 01:18 | **Probe: the job portal key reads the Offboarded list** (`cb0b94d4`, `46e4afb8`). Items 395, 343, 389 |
| 112 | `28856f9b` | Oct 8 01:09 → 12:49 | **Interns lock-in popup and card labelled per intern; HRIS never paid an intern week** (`134ce6b9`, `10ae6efa`, `f59275d5`). Item 396 |
| 113 | `63e0ef1e` | Oct 8 01:10 → 13:36 | **A returned offboarding row notifies; the No Meeting Streak pills; board-local roles** (`3e5f960e`, `f770d29b`, `74f6d2ee`, `7ed5b3f8`). Items 397, 391, 393. API reference § 24 corrected 10-09 |
| 114 | `b447e9cc` | Oct 8 01:12 → 11:30 | **The Arriola ghost row reverted and stamped; ₱750 deleted; 13 Lead Gen lines uncredited (≤₱11,250)** (`6ed59243` … `0ea5ede5`). Items 384, 400, 403 |
| 115 | `9e18d69e` | Oct 8 01:24 → 12:56 | **The payout change safety on both bank saves; account status reports; paid-account track record** (`eb9a0005`, `27e69bca`, `20a1287a`, `cfb65d35`). Items 401, 402, 406, 266 |
| 116 | `7d2d772e` | Oct 8 11:26 → 12:54 | **Monday passes 42 and 42b applied**; findings 405 (report on the public repo) and 407 (COP `--apply` ran before its deploy) (`6cf851ad` … `a3b89429`). Items 404, 405, 407, 408. The payout-reports and COP docs were corrected 10-09 |
| 117 | `781461ee` | Oct 8 12:08 → 12:14 | **The board-local roles migration applied, claire@ the second Admin** (`a2a95911`). Item 393 |
| 118 | `7f355d9f` | Oct 8 13:24 → 13:35 | **The scoreboard updates live over a values-free Broadcast** (`01e49496`). Item 409 |
| 119 | `1e5dbda7` | Oct 8 14:41 → 20:11 | **New Hire Checklist polls the hiring database** (12 commits, `7dc7500d` … `f0eac591`). Item 411 (header stale until the 10-09 note) |
| 120 | `76550067` | Oct 8 15:16 → 19:54 | **Scheduled Chat posts, the bars card, reorder your own task list** (`5079c89e`, `4884086a`, `b7cfe890`, `d358a4ca`). Items 412, 421, 422. The reorder pattern reached `ui-standards.md` § 5.7 on 10-09 |
| 121 | `51b912c1` | Oct 8 15:19 → 20:08 | **Tasks: change how often, cached with a board-shaped skeleton; NPD's card over the Tasks skeleton; the hires sync writes only the selected week** (`3e3fbae0`, `aa5d12b7`, `e50cb9f4`). Items 413, 414, 423 |
| 122 | `bab026c8` | Oct 8 16:28 → 17:34 | Advisory: the Wizard and Dispatch use no onSnapshot listener; a values-free DB-trigger Broadcast is the safe form. No row until item 441 |
| 123 | `e929349d` | Oct 8 17:02 → 18:37 | **A failed paid-list read no longer repaints Pending; one queue load per screen; the year-tape vision scoped; Diagnostics tells a Supabase outage from our overload** (`c0766122`, `b51f8f15`, `4db047fe`, `c87a6703`). Items 415, 416, 418, 420. The 2XL compute ask had no row until item 442 |
| 124 | `d4482ea2` | Oct 8 17:33 → 18:15 | **Interns capped at 6 h a day and 6 h a week (Ralph); 9 profiles moved** (`74763e67`). Item 417 |
| 125 | `a5168bf6` | Oct 8 17:52 → 18:08 | **The collab rail names the tab a person is really on; realtime-js patched** (`39d04215`). Item 419 |
| 126 | `723157e6` | Oct 8 19:22 → 20:08 | **Monday pass 43 staged; HRIS SP re-measured 3,289 / 2,999; the portfolio script hard-stopped** (`3cabe5a2` … `3c7ec418`). Items 408, 340 |
| 127 | `24ba2a0d` | Oct 9 11:38 → 13:09 | **The Oct 8 Carla meeting note; Setup → Keys; the Overview database signal** (`d1c25a5e`, `49006919` … `6f61f788`, `909ecb09`). Items 424–428, 444 |
| 128 | `85af82ec` | Oct 9 11:40 → 14:26 | **Monday pass 44 staged (53 rows / 236 SP); PAB forgive backfill applied; HRIS V1 close-out CSVs, 3,329 / 3,165 SP** (`5fe16242`, `fa481223`, `d9a14ea8`). Items 429, 431, 363, 334, 427. Still live: the Monday cron fires 00:07Z |
| 129 | `38387a37` | Oct 9 12:41 → 13:30 | **The scoreboard de-slopped (Simple wordmark, no gradients, orange-700); the History tab** (`b3e57d86`, `8f737179`, `78d92c05`). Item 444 |
| 130 | `f4065d68` | Oct 9 13:01 → 13:31 | **Setup → Scheduled Posts: the Chat posts are rows** (`c7659cea`). Item 430 |
| 131 | `f0e65cbf` | Oct 9 14:36 → 15:16 | **A paystub is never mailed to a previous holder of a recycled work email; data applied** (`3403963e`, `77b0ead4`, `946d180d`). Items 432, 433 |
| 132 | `fa7e8cda` | Oct 9 14:53 → 15:12 | Advisory: no paystub ever went to dolzkris210@; **the Oct 9 call note** (`f4a7ba9e`). Items 433–435, 443 |
| 133 | `7afdf629` | Oct 9 15:39 → 15:59 | **Accounting → System Settings → Bank Guardrail switch** (`a0bfec98`, `6be64331`). Item 436 |
| 134 | `c3e35660` | Oct 9 16:05 → 16:29 | **A Payroll Timing close can be set by hand; Sep 27 – Oct 3 closed 11:55 AM ET** (`9ee42135` … `19672c89`). Item 437 |
| 135 | `c0549c5f` | Oct 9 16:36 → | **This sweep.** Items 438–446 |

## What this sweep corrected

Documentation only; no product code, no database, no push.

- **`docs/README.md`**: 11 feature docs that were in INDEX but not README (half-published): the five scoreboard docs
  (backfill, tasks, scheduled posts, keys, history), `external-api-offboarded`, `coe-request-notify`,
  `employee-login-loader`, `new-hire-source-sync`, `proof-of-address-letter`, `hris-v1-closeout`. Five older meeting
  notes that were never listed. Stale rows: Penny's tool count (24 → 26) and its ID-card line, NPD (the sync, cache,
  Lock modal and applied migrations), salaried pay (migration applied), the HSL counts (9 → 10 of 12), and the
  round-4 plan (no longer awaiting review).
- **`docs/reference/api-reference.md`**: § Route index re-diffed against the tree, the first time since 09-29. 375
  routes on disk, 365 listed; the 10 missing rows were added, and every row now names a file on disk. § 20 gained
  `GET /api/external/v1/offboarded`, the MCP tool `query_offboarded` and the admin `scopes` field. § 24 gained the
  board-local roles (the `not_manager` code is gone), the roles route, and the five 10-09 routes. Also fixed: the
  chat cron (every UTC hour, posts are rows), `GET /api/manager/time-adjustments` (alternate-email resolution, item 390)
  and `GET /api/hr/new-hire-checklist` (`inDatabaseIds`).
- **`docs/reference/components.md`**: the Component & hook index was re-diffed both ways. 9 `.tsx` were missing; they
  and `npd-sheet-loader.ts` are added. The primitives table gains `smooth-select`, `date-picker`, `popup-layer`,
  `skeleton`, `popover`, `flag` and `confetti-burst`. `SystemSettings` gains its `bank-guardrail` tab.
- **`docs/reference/llm-context.md`** and **`data-sources.md`**: stale "NOT pushed" and "PENDING" flags measured and
  corrected.
- **Design patterns** (`docs/design/ui-standards.md`, `responsive-design.md`), each from a feature doc that already
  stated it for one surface:
  - § 12.3, **a cold load skeletons the data, never the frame** (two users).
  - § 5.5, **`LoadingLines`**: a spinner caption that cycles only through real reads.
  - § 5.7, **reordering a list**: a grip, the keyboard path, whole-list-or-nothing.
  - § 14, **OPEN 326**: Tailwind transition classes do nothing in this app.
  - § 15.4, the `side-tab` waiver and the gray-on-color count (15).
  - responsive-design, **a sideways row fades at a hidden end, never cuts**.
- **Feature docs whose state was stale**:
  - **Migrations or data applied, docs said PENDING:**
    - `mesa.md` and `mesa-request-notify.md`: the archive migration and the n8n import.
    - `proof-of-address-letter.md`: the migration.
    - `payout-account-reports.md`: the table.
    - `cop-country-payees.md`: the `--apply` ran 10-07.
  - **Live, docs said pending:**
    - `new-hire-source-sync.md`: the Vercel env was set 10-08.
    - `accounting-scoreboard-tasks.md`: scheduled posts live, the bars card proven.
  - **Pushes measured from the reflog:** `accounting-scoreboard*.md`, `npd-dashboard.md` and `orphanage-oms-pull.md`.
  - **Missing rules:**
    - `route-authorization.md`: the scoreboard's member-list gate, `/qc`, `/tickets`, and the host blocks.
    - `orphanage-oms-pull.md` § Send to OMS: rewritten to the confirmed `pymcf` state.
    - `coe-request-notify.md`: the env-fallback warning (item 352).
- **INDEX**: 23 memory entries written since 09-29 had no wikilink in any row; they are mapped. Stale cells corrected
  on rows 37, 40, 53, 63, 111 and 112.
- **The round-4 plan and its session tracker**: the header no longer says "AWAITING KANE'S REVIEW". Tasks 1–4, 9 and
  11–14 are struck as built, W0.9 is ticked, and the ₱750 is recorded as deleted.
- **Memory**: six `MEMORY.md` hooks that said "push PENDING" for pushed work. The scoreboard, scheduled-posts,
  history, payout-reports, payout-safety, recycled-email, proof-of-address and COE files. The 2XL compute ask added to
  `dispatch-queue-reload-cost`.

**Not touched, on purpose:**
- **The uncommitted files that are not this sweep's.**
  - The three `scripts/rekey-*.mts` (row 353 note).
  - `docs/features/audit-log.md`: line endings only. `git diff` is empty and the file matches HEAD once CRs are stripped.
  - `docs/audits/2026-10-09-hris-v1-sp-summary.csv` (item 445).
  - `tsconfig.tsbuildinfo`.
- **Code.** The comment at `app/api/cron/accounting-scoreboard-chat/route.ts:21-26` still describes the old four-hour
  schedule (item 446).

---

## Open items (new this session)

| # | Item | State |
|---|---|---|
| **438** | **Push state, 2026-10-09: `origin/main` = local `main` = `19672c89`. Every "NOT pushed", "push PENDING" or "awaiting push" in items 256–437 is PUSHED. Deploy and click-through are unverified for all of them** | Read from the `origin/main` reflog. Pushes on 10-09 (EDT): 08:13 `49006919`, 08:41 `6f61f788`, 08:52 `b3e57d86`, 09:33 `c7659cea`, 12:02 `6be64331`, 12:30 `19672c89`; 10-08: fifteen pushes between 07:36 and 16:13. This supersedes, without rewriting them, the push words still in **86** of rows 257–437 (a grep for "not pushed" / "push PENDING" / "awaiting push", 2026-10-09; in some rows it is history that a later note already corrects). The stalest headers are annotated: 391–393, 398, 411, 412, 421, 424, 436. The feature docs and memory hooks this sweep found saying otherwise are corrected (§ What this sweep corrected). **Owed, as each row says:** a signed-in pass on production after the deploy. **OPEN** (the click-throughs) |
| **439** | **Advisory, Kane's call: design-detector findings on code the sessions did not touch, asked about twice and never answered** | The same kind as Sep 29 item 268, after its window. **Session `77408540` (10-01)**, with `d86dc079` and `8a6f547e`, asked *"Do you want a separate design pass on S-Wall and Notifications, or should I record these styles as intentional so the hook stops raising them?"*. `SWall.tsx`: 6 (ai-color-palette, bounce-easing). `NotificationsPanel.tsx`: 2 gray-on-color (Clear all, delete). `NpdSheetGrid.tsx`: a gray-on-color false positive on the toolbar (gray at rest on white). The ignore entry was refused by the permission check. **Session `3485da88` (10-05)** asked *"Do you want a separate design pass on those screens?"* about 22 findings, all predating its change: `OrphanageApp.tsx` ×15 (including gradient text, still `bg-clip-text` today), `InternsWizard.tsx` ×1, `OrphanageBudgetHistory.tsx` ×2, `PabDisputeQueue.tsx` ×2, `UrgentPaymentsQueue.tsx` ×2. No waiver was added for any of them: § 15.4 waivers need Kane. Line numbers have drifted. **Unanswered. OPEN** |
| **440** | **FOUND 2026-10-05, waiting on HR / Carla: ronaldc@ (pending #1465) attended orientation but was never promoted, and a ₱113.75 pay question** | Session `67866882`, read-only (Jackie via Kane). His attended mark landed at 18:36Z, 46 minutes after Carla's 17:50Z Lead Gen batch promote, so he has no master or bank row. Marking attendance never promotes. **Owed:** (1) Jackie confirms the attended date (stamped 10-06, the cohort is 10-05; Promote uses it as the Start Date); (2) Carla clicks Promote (nothing blocks it); (3) **OPEN MONEY, Carla:** ₱113.75 in the Sep 27 → Oct 3 Wizard final pay, for 0.65 h of Hubstaff on 09-28, his no-show day (an Overview Exception): pay it or not. Not re-measured by this sweep. [[late-attendance-misses-batch-promote]] · **OPEN** |
| **441** | **ADVISORY 2026-10-08, nothing built: the Payroll Wizard and Payment Dispatch use no onSnapshot-style listener. The safe live form is proposed and waits on Kane** | Session `bab026c8`. Today they use a browser Broadcast, polls and a full reload. Measured read-only in production: `realtime.send` and `realtime.broadcast_changes` exist. **Proposed:** a trigger on `payment_dispatches` (and the dispatch lock setting) sends a values-free "cycle changed" on a public topic, then each screen does a gated re-read (a migration behind an `--apply` gate). Putting the row in the message needs `realtime.messages` policies (0 today) and Supabase JWTs for NextAuth sessions. `postgres_changes` and Firestore are rejected. No plan upgrade is needed. The Wizard is ~12 tables, a larger job. **This supersedes** Sep 25 item 214's "put the paid row inside the broadcast": the topic is public, so the row would reach anyone holding the anon key (note on 214). The session's offer to build the Dispatch trigger was never answered. [[supabase-realtime-anon-rls-dead]] · **OPEN** |
| **442** | **MONEY, Kane → Thomas & Cobb, 2026-10-08: Supabase compute Medium → 2XL proposed; approval not recorded** | Session `e929349d`, from Kane's usage screen. The project is on **Medium** (~$60/mo). The session recommended Large; Kane: *"I dont want large I want 2XL!"*. An email was drafted for Thomas & Cobb: 2XL at $0.562/h × 730 ≈ **$410/mo**, about $350/mo more, ~$4,200/yr all year or ~$1,320/yr on paydays only; billed hourly, downgrade any time. The same screen showed **egress 171 GB** and **Realtime 6.2M messages** at day 20 of the Sep 18 – Oct 18 cycle. The session *recalled* (not verified) that Pro includes 250 GB / 5M, so Realtime may already be over; full Dispatch queue reloads drive both (item 416). Diagnostics' load thresholds are per vCPU, so they hold after a resize (item 420). Item 416 (b)'s "step it up if Micro/Small" is answered: it was Medium. Neither the send nor the resize is recorded. [[dispatch-queue-reload-cost]] · **OPEN MONEY** |
| **443** | **OPEN 2026-10-09 (meeting): review the payroll inbox for replies from the other previous holders on item 432's list** | From the [Oct 9 call note](../meetings/2026-10-09-paystub-misdirection-ex-employee-report.md) (action item 2: *"count how many of the other 13 previous holders also wrote in"*). Items 433–435 cover the re-send, the Workspace resets and the mistaken offboard. 434 notes only who wrote in. Owner not named. Outside the repo. **OPEN** |
| **444** | **Built and pushed 2026-10-09 with no row: the scoreboard's Overview database signal and the History tab. Neither was clicked through signed in** | **DB signal** (session `24ba2a0d`, `909ecb09`, pushed 13:33Z): three bars and the server's ms for one tiny read; a slow or failed database is a 200 answer. On local dev it reads orange by design. **History tab** (session `38387a37`, `8f737179`, pushed 13:33Z): one bar per week per Overview card, read a quarter at a time. **Every week is judged against TODAY's goals**: a goal history needs a new table (plan Task 15, Kane's call). Both docs are current: `accounting-scoreboard.md` and `accounting-scoreboard-history.md`. **Owed:** a signed-in pass on production. **OPEN** |
| **445** | **Kane's call: `docs/audits/2026-10-09-hris-v1-sp-summary.csv` was rewritten outside any session and is uncommitted** | Session `85af82ec`'s close-out file (item 431). At 16:38Z it changed with no Claude tool call: quotes stripped, the "Done SP" column removed, CRLF line endings. It looks like a hand or spreadsheet save. This sweep did not commit or revert it. The next close-out run will overwrite it. **Keep it, or restore HEAD's.** **OPEN** |
| **446** | **What this sweep did not fix** | (a) **Code comment:** `app/api/cron/accounting-scoreboard-chat/route.ts:21-26` still describes the 13/14/19/20 UTC schedule. The API reference and `vercel.json` are right; the comment is out of a docs sweep's scope. (b) **The components index's six `.ts` helpers** named on 2026-09-29 are still unlisted, so its "does not exist" claim holds for `.tsx` and hooks only. (c) **The hand-written API sections** were not re-measured against the tree; only § Route index was. (d) **The 336 numbering collision** is annotated, not renumbered, because both rows are cited by number elsewhere. (e) **Monday:** this sweep wrote nothing to the board. **OPEN** (a)–(c) |
| **447** | **BUILT 2026-10-09, committed, NOT pushed: Admin (and CEO) Penny now read the Offboarded ledger. Three things are left open** | Session `ef26d914`, `hardening`, no contradictions. Kane: *"Admin - Penny AI - Does not know about the Offboarded data"*. Measured read-only before the build: `offboarded_sheet` = 4,462 rows, and `find_employee` reached **1,621 of the 4,447** addressed departures. Kane's one query that day ran `find_employee` ×2 and stopped. Built: `find_employee` merges the ledger (`mergeLedgerLeavers`); `get_offboarding_info` gains `offboarded_ledger_only` and the recorded name per ledger row; the new tool `list_offboarded` lists leavers by window, department, reason and recorder. Doc: `admin-penny-tools.md` §6b. Live check `scripts/verify-penny-offboarded-ledger.mts`: **28/28 PASS**, all 4,447 reachable. **OPEN:** (a) **Stamp-path reasons:** `find_employee` still shows a stamped master row as a leaver without reading its reason, so a `duplicate_cleanup` or `temporary_pause` stamp on an address nobody holds reads as a departure. Not measured how many reach Penny. (b) **Not clicked through** in the console signed in; only the tool runners were run against production. (c) **Latency:** `find_employee` now pages ~4,500 more rows per call. The reads run in parallel; from a dev machine the roster took 5–13 s and the ledger 7–9 s. Production latency is unmeasured. **Push: Kane.** |
| **448** | **FIXED 2026-10-09, committed, NOT pushed: every Safari and iPhone Google sign-in ended on next-auth's "Server error" page. Three Safari gaps left open** | Session `f62e3c73`, `hardening` + `systematic-debugging`, no contradictions. Kane: *"There is an issue with HRIS not being able to work in Safari"*. **Cause:** the popup design in `app/login/page.tsx` awaited `signIn('google', { redirect: false })`. In next-auth v4 that call navigates and returns `undefined` for an OAuth provider (`node_modules/next-auth/react/index.js:258-265`), so the fallback fired a second `signIn` on every click. WebKit cancels in-flight fetches when a navigation starts, so the second call's `/api/auth/providers` failed, and next-auth then sent the tab to `/api/auth/error`. **Measured** in Playwright WebKit 26.5 against production: 3/3 clicks ended on `/api/auth/error`. Chromium: 2/2 reached Google. **Fixed:** one `signIn('google', { callbackUrl: '/login' })` plus a double-click guard. After the fix, WebKit 3/3 and Chromium 3/3 reach Google's sign-in with the state cookie that matches the committed URL (local dev, signed out). A WebKit double-click sends one POST (2/2). Test: `google-sign-in-once.test.ts`. Doc: `login-google-sso.md` (the first doc for `/login`). **Not verified:** a full sign-in on a real iPhone or Mac Safari after deploy. That needs Kane's push and one tap-through. **OPEN:** (a) **A deep link is lost after Google sign-in.** `system-architecture.md:148` says a safe `?callbackUrl=` wins, but the query string never survives the trip to Google (only the dead popup kept it). Carrying it needs OW-29 (the `callbackUrl` open redirect) closed first. (b) **POSSIBLE in Safari, unmeasured; needs a signed-in WebKit pass:** `window.open(…, 'noopener')` after an `await` is silently blocked and returns null either way, at `RequestDocumentsTab.tsx:343`, `AccountingDocuments.tsx:368`, `TerminationDocsPanel.tsx:909` and `:1142`, `penny-attachments.tsx:136` and `app/onboarding/[token]/page.tsx:712`. Blob URLs revoked synchronously after `a.click()` (`id-card-render.ts:582` and about 10 exporters) can fail downloads on iOS. The iPhone audio unlock listens only for `pointerdown` (`carla-song.ts:337`, `ping-chime.ts:60`). (c) **Safari below 16.4 (iOS 16.3 and older) cannot run the app at all.** That is the Next 16 build target; the App Router runtime uses class static blocks. It cannot be fixed here, so anyone on iOS 15 has to update. **Push: Kane.** |
