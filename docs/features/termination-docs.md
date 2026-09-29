# Termination Letters — a signed one-page letter for someone who left

Accounting → Documents → **Termination letters**, the second inner tab of the Documents surface
(the first is the **Signing queue**, `TerminationDocsTabRow.tsx:36-37`; the host is
[documents-tab.md](./documents-tab.md)). An accounting rep finds someone who was offboarded,
reviews a facts sheet the server resolves, types whatever the record does not hold, and generates
a **one-page PDF signed at generation with the rep's own saved signature**. Nothing is emailed: the
rep downloads the letter and replies from their own inbox. Every generation is a permanent log row
(plan `:3-8`). Carla estimates two to three letters a month
([meeting](../meetings/2026-09-28-carla-termination-letters-blocked.md) `:19-20`).

**Status, 2026-09-29.** Built 2026-08-31 from the approved brief (plan `:3`). The whole feature
landed inside Kane's commit `e8e8c6ae` ("PAB TAB Ignore", 2026-09-01), which also carried another
session's employee-dashboard-cache work (`src/lib/monday/hris-plan.ts:1337`). Later changes:
`90812026` and `bf43c86a` (search console, 2026-09-01), `34f92fd1` (the hours refusal names the
week, 2026-09-16), `ca36e17e` (the one-person master-row insert script, 2026-09-23), `6565022d`
(the ledger arm and the optional starting rate, 2026-09-28). `6565022d` is an ancestor of
`origin/main` (`0fa0b89d`). **Not clicked through in a browser since `6565022d`** (Open items 245
(a)). **`termination_documents` is PRESENT in production and holds 3 rows** (read-only service-role
select, 2026-09-29 ~13:35Z, Sep 29 log item 263), so the migration has run.

Build docs: [plan](../superpowers/plans/2026-08-31-termination-docs.md) ·
[frozen contract](../superpowers/plans/2026-08-31-termination-docs-contract.md) ·
[audit round 1](../superpowers/plans/2026-08-31-termination-docs-audit-round1.md) ·
[ledger-only insert plan](../superpowers/plans/2026-09-23-ledger-only-master-row.md). The contract
was frozen before the audit fixes and is stale in places; § *Where the contract and the code
differ* lists them. This doc describes the code at HEAD.

## Key files

Unqualified filenames in this doc are in `src/lib/documents/termination/`.

| Piece | File |
| --- | --- |
| The whole type surface, pure and client-safe | `types.ts` |
| The seven-reason allowlist, `reasonKey`, `escapeLikePattern` | `reason-key.ts` |
| The refusal ladder and every printed fact, pure (`arbitrateTerminationFacts`; the ledger arm is `ledgerOnlySubject`) | `termination-arbitration.ts` |
| The reads that feed the ladder | `termination-facts.ts` |
| Departure-evidence read, work-keyed, with an error channel | `termination-evidence.ts` |
| Ledger identity read, for a subject with no master row only | `termination-ledger.ts` |
| The cycle timesheet as a refusal-only, three-state signal | `termination-cycle-hours.ts` |
| Alternate-work-address screen before any rate read | `termination-alias-screen.ts` |
| Starting and ending rate, with currency | `termination-rates.ts` |
| Person search (reads only) | `termination-search.ts` |
| The generate route's ordered decisions, pure | `termination-route-rules.ts` |
| The panel's judgements, pure (selectable candidates, hand-repair banner, optional blanks) | `termination-panel-rules.ts` |
| PDF renderer | `termination-document.ts` |
| Log table, storage object, audit rows | `termination-log.ts` |
| Write-back: Supabase adapter · pure core | `termination-writeback.ts` · `termination-writeback-rules.ts` |
| Routes | `app/api/accounting/documents/termination/route.ts` (GET log, POST generate) · `search/route.ts` · `facts/route.ts` · `[id]/route.ts` |
| UI | `src/components/accounting/termination-docs/TerminationDocsPanel.tsx` · `TerminationDocsTabRow.tsx`, mounted by `src/components/accounting/AccountingDocuments.tsx` inside `[TERMINATION-DOCS]` markers |
| DDL · teardown | `references/sql/migrate/2026-08-31_termination_docs.sql` · `references/sql/fix/drop_termination_docs.sql` |
| Scripts | `scripts/apply-termination-docs-migration.mts` · `scripts/revert-termination-doc-writebacks.mts` · `scripts/insert-ledger-only-master-row.mts` |

The pure modules exist because `npm test` cannot load a `server-only` module and never runs a
`.tsx` file (`termination-arbitration.ts:4-13`, `termination-route-rules.ts:4-8`,
`termination-panel-rules.ts:5-9`). A rule left inside a route or the panel has no test behind it.

## Who can reach it

1. **Every read is `view`, generating is `edit`, on the existing `documents` feature.** Search,
   facts, the log and the download call `requireFeatureAccess('accounting', 'documents', 'view')`
   (`search/route.ts:37`, `facts/route.ts:26`, `route.ts:138`, `[id]/route.ts:29`). The POST calls
   `requireFeatureEdit('accounting', 'documents')` (`route.ts:172`). The `'view'` argument is
   required: it defaults to `'edit'` (`src/lib/auth/authorize-feature.ts:52`).
2. **No feature key of its own.** A new key resolves to hidden and would remove the Documents tab
   for every current rep (`route.ts:52-55`; contract `:153`).
3. **View-only reps get the log and its downloads, nothing else.** The host passes
   `canEdit={canEditAccountingTab('documents', …)}` (`src/App.tsx:404-409`), and without it the
   search, facts and generate steps are absent, not disabled (`TerminationDocsPanel.tsx:48-50`,
   `:1284-1293`).
4. **The signer is the session rep.** The signature is `getDocumentSignature(authz.sessionEmail)`
   (`route.ts:311`), never a body field.
5. **Payroll state is not an input.** No termination source or route may read the dispatch lock,
   and a source-scan test pins it (`src/lib/documents/documents-unaffected-by-payroll-lock.test.ts:34-57`,
   `:80-90`). [[documents-not-gated-by-payroll-lock]]
6. **Nothing reaches an employee screen.** The log is its own table, named by a module-const literal
   (`termination-log.ts:4-10`, `:38-39`), while `GET /api/employee/documents` reads only the literal
   `'document_requests'` (plan `:15-19`). Never add a `document_type` for this. The migration
   enables RLS with no policies, so the anon key reads zero rows
   (`2026-08-31_termination_docs.sql:124-139`). The external API lists `termination_documents` under
   a `status: 'never'` dataset (`src/lib/external-api/datasets.ts:672-681`).

## Identity: a personal email searches, a work email identifies

One personal inbox backs several master identities: `carla@simple.biz` (active) would inherit
`carlath@simple.biz`'s `resigned` stamp through a shared Gmail, and a letter keyed on the inbox
would be issued for a working employee (plan `:25-28`).

7. **The resolver takes one work email and never sees the query** (`termination-facts.ts:6-10`,
   `:90`). The facts route accepts only `?work_email=` (`facts/route.ts:14-18`).
8. **Search matches a fragment and returns a set.** A partial value is matched across every name
   and email column of `global_master_list`, `offboarded_sheet` and completed `offboarding_queue`
   rows, and each candidate's identity is the work email on the matched row
   (`termination-search.ts:6-21`). One `.ilike` per column, every value through
   `escapeLikePattern`, never `.or()` (`termination-search.ts:23-29`).
9. **Short and capped searches say so.** Under 3 characters no read runs (`tooShort`); over 50
   identities the list is cut and flagged `truncated` (`types.ts:264-273`,
   `termination-search.ts:31-36`).
10. **Nothing is auto-selected, not even a lone result** (`TerminationDocsPanel.tsx:7-10`). A row is
    selectable exactly when the server stamped no `blockedCode`. The `active` flag is a chip, never
    a veto (`termination-panel-rules.ts:15-27`, `:93-105`).
11. **The candidate list's refusals are advisory.** Search can only stamp `no_master`,
    `evidence_read_failed`, `still_active`, `temporary_pause` and `not_a_departure`; everything else
    is decided when the facts load (`termination-arbitration.ts:346-356`, `:427-464`). A failed
    status-map read stamps every candidate `evidence_read_failed` (`:430-434`).
12. **The departure-evidence read never touches a personal column** (`termination-evidence.ts:23-29`),
    and a source pin fails if it does (`termination-facts.test.ts:1217-1229`). The ledger identity
    read selects `personal_email` as data, never as a filter, and lives in its own module so that
    pin still holds (`termination-ledger.ts:13-19`, `termination-facts-reads.test.ts:753-775`). The
    first cut of the ledger arm failed that pin; the read was split out rather than the pin loosened
    (item 245).
13. **Rates are looked up on work addresses only**: the work email plus the two Alternate Work Email
    columns (`termination-arbitration.ts:225-256`). An alternate is dropped if it is any master row's
    Personal Email, and dropped if that check cannot run (`termination-alias-screen.ts:15-28`,
    `:61-97`; `termination-facts.ts:179-197`). The first build printed another identity's hire rate
    through the personal email (audit round 1 `:17-21`). [[kpi-bonus-shared-personal-email]] ·
    [[maria-argote-split-identity]]

## The refusal ladder

`arbitrateTerminationFacts` (`termination-arbitration.ts:876`) holds the whole ladder, and the first
refusal wins. A facts sheet needs four independent tests passed: **T1** the reads succeeded, **T2** a
valid first-party departure record, **T3** no re-engagement, **T4** no hours in the current
timesheet. The order only decides which refusal the rep sees (`termination-arbitration.ts:817-858`).
The facts route returns a refusal as **200 with `blocked`** (`facts/route.ts:20-23`). The POST
re-resolves from the work email and returns **409** (`route.ts:181-190`). Rates are read only after
every refusal has passed (`termination-facts.ts:192-197`).

The rep reads the server's message in the facts pane (`TerminationDocsPanel.tsx:1714-1718`).

| # | Code | Fires when | Server message (the facts pane) | Cite |
| --- | --- | --- | --- | --- |
| T1a | `evidence_read_failed` | the master identity read errored | "The master-list read for ‹email› failed (‹error›), so the rows behind this person are unknown. Retry — …" | `termination-arbitration.ts:891-896` |
| T1b | `evidence_read_failed` | the roster status-map read errored | "The active-roster check for ‹email› could not run (‹error›), so there is no way to tell whether this person is still working. Retry — a failed status read must never be read as "not active"." | `:897-902` |
| T1c | `evidence_read_failed` | this feature's own departure-evidence read errored | "A departure-evidence read for ‹email› failed (‹error›), so this person cannot be confirmed as a leaver. Retry — …" | `:903-908` |
| T1d | `evidence_read_failed` | the cycle timesheet could not be read | "The current pay cycle's timesheet could not be read (‹error›), so whether ‹email› is still working cannot be established. Retry — …" | `:913-918` |
| — | *(no refusal)* | the timesheet read fine but is empty overall | a degraded note on the sheet: "The current pay cycle's timesheet is EMPTY, so it could not be asked whether this person worked. …" | `:919-926` |
| 1 | the ledger arm | no master row has this address as its Work Email | six ledger refusals, § *The ledger arm* | `:928-940` |
| 2 | `ambiguous_identity` | equally current master rows (same upload tier) name different people | "‹email› is carried by N equally current master rows naming different people (…). … compare the rows below and have HR repair the master list. Which person a letter is about is never auto-resolved." Below it, one line per row (name, department label, off-board date, reason, a *No off-board stamp* chip) and nothing to pick (`TerminationDocsPanel.tsx:1719-1771`) | `:976-1019` |
| 3 | `still_active` | nothing first-party records a departure, and the roster still carries the person | "‹email› is on the live roster and NOTHING records a departure — … Offboard them first, or have HR stamp the row that actually left …", naming the unstamped rows | `:1039-1066` |
| 4 | `no_departure_evidence` (or `evidence_read_failed` when a non-fatal read degraded) | no departure record at all | "Nothing stamps ‹email› as having left — no master stamp, no offboarded_sheet row, no completed offboarding_queue row. There is no departure to document." | `:1103-1115` |
| 5 | `temporary_pause` | the latest reason normalizes to `temporary_pause` | "‹email›'s latest offboard record is a TEMPORARY PAUSE — a suspension with a return, not a departure. A paused employee can never be issued a termination letter." | `:1159-1168` |
| 6 | `not_a_departure` | the latest reason is off the seven-reason allowlist | "‹email›'s latest offboard reason is "‹raw›", which is not one of the seven departure reasons a termination letter may state." plus *Stored reason: ‹raw›* (`TerminationDocsPanel.tsx:1772-1778`) | `:1170-1180` |
| 7 | `rehire_after_offboard` | termination date on or before the start date | master: "‹email› started on ‹start›, on or after the ‹off› offboard stamp — this record describes a RE-HIRE … Fix the master row before documenting a departure." Ledger: "… one of those two dates is wrong … Engineering has to correct the ledger row …" | `:1194-1214` |
| 8 | `reengaged_after_departure` | any master row (ledger: any ledger row) starts after the departure | master: "… That is a RE-ENGAGEMENT … Have HR reconcile the rows before anything is issued." Ledger: "… Engineering has to date the later ledger row …" | `:1216-1251` |
| 9 | `still_active` (T4) | the person has hours in the current Hubstaff upload | two wordings, rule 21 | `:1253-1288` |
| 10 | `bad_name` | the composed legal name is empty or contains `,` `"` `“` `”` or `@` | master: "The master row for ‹email› does not compose to a printable legal name. Fix the master list — …" Ledger: "… Engineering has to correct the name on the ledger row — …" plus *Name cell holds: …* | `:1290-1305` |
| POST | `rehire_after_offboard` | the dates the rep filled make termination ≤ start | 409, "The termination date is on or before the start date — that is a re-hire, not a departure" | `termination-route-rules.ts:339-364`, `route.ts:301-302` |

14. **A failed read never becomes a verdict.** No `no_master`, "not active" or "never left" may come
    from a read that errored (`termination-arbitration.ts:821-829`, `:887-908`). The shared
    `loadOffboardEvidenceByEmail` swallows its errors, so this feature reads the same sources itself
    (`termination-evidence.ts:6-21`).
15. **An unstamped duplicate master row is not a refusal by itself.** The roster refuses only when
    nothing first-party records a departure (`termination-arbitration.ts:860-864`, `:1036-1052`).
    That shape is the normal leaver: on 2026-08-21, 1,287 active rows carried zero stamps while 294
    of those people were offboarded (`:1030-1031`). [[offboarded-tab-no-date-means-stale-row]]
16. **A completed offboarding-queue row alone never vouches for a departure**
    (`termination-arbitration.ts:1043-1050`).
17. **A temporary pause can never become a letter, at four layers**: the type
    (`types.ts:221-232`), the resolver (`termination-arbitration.ts:1159-1168`), the route's
    reason check (`termination-route-rules.ts:265-274`) and the DB CHECK
    (`2026-08-31_termination_docs.sql:60-65`).
18. **The reason list is an allowlist, by ruling; a denylist is forbidden** (`reason-key.ts:7-11`,
    `2026-08-31_termination_docs.sql:60-62`). The seven: `ncns`, `resigned`, `end_of_contract`,
    `performance`, `attendance`, `time_manipulation`, `other` (`types.ts:223-231`). `reasonKey`
    folds case and punctuation only (`reason-key.ts:19-26`). No sheet label is mapped onto one
    (Open items 248).
19. **The re-hire boundary is `<=`, deliberately.** A same-day start and departure refuses. The code
    and the DDL's `termination_date > start_date` move together or not at all
    (`termination-arbitration.ts:1195-1204`, `2026-08-31_termination_docs.sql:77-79`).
20. **Hours only ever refuse.** A hit blocks; an absent signal never permits, because T3 catches the
    re-hire hours were there to catch (`termination-arbitration.ts:809-815`,
    `termination-cycle-hours.ts:28-33`). Three states: an errored read blocks (T1d), an empty index
    is *unavailable* and becomes a degraded note, and only a readable, non-empty index can hit
    (`termination-cycle-hours.ts:14-26`, `:177-182`). The match is the widest reasonable one: every
    known address, the local part (3+ characters) on any domain, the exact name-token key, and a
    token-subset name match with 2+ shared tokens (`termination-cycle-hours.ts:35-45`, `:106-127`,
    `:194-233`). The index is the `is_current` Hubstaff upload (`termination-facts.ts:123-126`).
21. **The T4 refusal names the week, and the guard stands.** When the departure is after the week
    the newest file covers, the message reads: "‹email› has hours in the most recent timesheet
    loaded, which covers ‹week›. The departure on file is ‹date› — AFTER that week closed, so this is
    not a contradiction: they worked their last week and left. No letter is issued while the newest
    timesheet still contains them. It will generate once a newer Hubstaff file — one this person has
    no rows in — is ingested. Nothing on this record needs repairing." Otherwise: "… so this person
    is WORKING whatever the off-board stamps say. A stale stamp cannot forge a timesheet row. Nothing
    is issued for someone who is still on the clock." (`termination-arbitration.ts:1276-1288`). The
    week is read from the filename as ISO strings; a file with no range names no week
    (`termination-cycle-hours.ts:153-169`). Kane declined issuing anyway on 2026-09-16, and the
    2026-09-28 change did not reopen it (memory `termination-docs.md:57-73`, meeting `:51-58`).
    **Never make T4 week-aware**: it re-opens the typo'd-year hole (`franm@`'s `2027-04-20`)
    (memory `termination-docs.md:69-72`). [[hubstaff-filename-junk-heuristic-hides-paid-week]]
22. **Refusals are not audited.** Only a generation and a write-back write an audit row
    (`src/lib/audit/registry.ts:213`), so which refusal a rep saw cannot be measured (meeting
    `:47-49`).

**Fallback copy.** The candidate list shows these on a greyed row, and the facts pane shows them only
when a server message arrives empty (`TerminationDocsPanel.tsx:141-152`, `:153-179`):

| Code | Panel copy |
| --- | --- |
| `no_master` | "This record has no work email that the master list or the offboarded sheet identifies a person by, and a letter is always keyed on one. Search by the person's name to find the work email their records use." |
| `ambiguous_identity` | "Two or more equally current master rows under this one work email name different people, so which person a letter would be about cannot be known. Compare the rows below and have HR repair the master list — it is never guessed for you." |
| `still_active` | "Still on the active roster: a master row carrying this address — or, for someone with no master row, their personal inbox — has no off-board stamp. A termination letter here would state something untrue." |
| `no_departure_evidence` | "No departure stamp anywhere — the master list, the offboarded sheet and the offboarding queue are all silent for this address." |
| `temporary_pause` | "Recorded as a Temporary Pause. That is a suspension the person is expected to return from, not a departure, and it can never become a termination letter." |
| `not_a_departure` | "The stored off-board reason is not a departure — it is a bookkeeping or sync marker — so there is nothing a letter could state." **This copy is false for the 832 ledger labels behind item 248** ("No Show", "Policy Violation", …), which are departures the allowlist does not name, not markers (Sep 29 log item 264). The server message the facts pane shows (row 6 above) is accurate; this fallback shows on the greyed candidate rows. |
| `rehire_after_offboard` | "Re-hired after that off-board date, so the stamp belongs to an earlier stint. The current departure has to be dated before a letter can be issued." |
| `reengaged_after_departure` | "One of this person's master rows starts AFTER the departure a letter would document — they were taken back on, so that departure is not the current one. HR has to reconcile the rows first." |
| `bad_name` | "The Name cell cannot be rendered as a legal name — it is empty, quoted, comma-shaped, or an email address. Fix the master row, then come back." |
| `evidence_read_failed` | "The departure-evidence read failed, so nothing on this record is confirmed. Refresh; if it keeps failing, raise it with engineering before issuing anything." |

## The ledger arm: a leaver with no master row

Kane, 2026-09-28 (Open items 245, "Docs are stale change it!"). The master list begins 2026-04-21, so
anyone who left before that exists only on the `offboarded_sheet` ledger. Refusing them `no_master`
sent the rep to HR for a row nobody can create: the app never inserts master rows, and re-adding the
person to the sheet makes them ACTIVE (`termination-arbitration.ts:660-669`,
`documents-tab.md:635-641`).

23. **It runs only after a successful, empty master read.** The ledger identity read happens only
    when the `"Work Email"` read succeeded and returned no row, so a person with a master row pays no
    extra query (`termination-facts.ts:138-145`, `termination-ledger.ts:21-24`). Its own error
    blocks `evidence_read_failed`, never `no_master` (`termination-arbitration.ts:699-707`).
24. **Six refusals the roster can no longer make, in this order** (`termination-arbitration.ts:708-768`):
    1. no ledger row either → `no_master`: "Neither the master list nor the offboarded-sheet ledger
       has a row whose work email is ‹email›, so there is no record to build a letter from. Search by
       the person's name instead — their records may use a different work email." (`:709-716`)
    2. an UNSTAMPED master row carries the address in another column → `still_active`: "… someone on
       the live roster still uses it. No letter is issued for an address a working person uses."
       (`:718-725`)
    3. a STAMPED master row carries it in another column → `no_master`: "… the roster knows this
       person under a different work email. Search their name and issue the letter from that
       master-list record instead." (`:726-730`)
    4. the ledger's personal inbox is on a LIVE master row → `still_active`: "… Search that inbox: if
       they have since left, issue the letter from their current record; if they are working, no
       letter is issued." (`:733-742`)
    5. the ledger rows carry two personal inboxes → `ambiguous_identity`, `candidates: []`: "…
       Engineering has to split the ledger rows before a letter can be issued." (`:743-751`)
    6. the ledger rows compose to two different legal names → `ambiguous_identity`,
       `candidates: []`: "… Engineering has to correct or split the ledger rows …" (`:752-768`).
       Names compare as the composed legal name: "Sepnio, Raphael" and "Raphael Sepnio" are one
       person, "Raph Sepnio" and "Raphael Sepnio" are not (`:752-754`).
25. **Otherwise one stand-in row.** It has no id, no stamp and no upload. The name comes from the
    latest-departure ledger rows; the department and start date only where those rows agree, and a
    disagreement is a blank, never a pick (`termination-arbitration.ts:689-692`, `:770-796`).
26. **Then the ladder runs unchanged on the stand-in**: allowlist, pause, re-hire, re-engagement,
    hours, name (`termination-arbitration.ts:671-676`, `:866-871`). Every ledger row is a departure
    record, dated or not, and an undated one is a termination-date blank marked `not_on_file`
    (`:1078-1090`, `:1362-1368`). Every ledger row's own start date is a T3 probe (`:797-800`,
    `:1232-1235`). Hours are matched on the ledger's names and personal inbox too
    (`termination-facts.ts:255-258`, `:274-280`).
27. **Conflicting ledger reasons for one departure never slip past the allowlist.** A pause among
    them refuses, then any off-list label refuses, and only when every stated reason is allowlisted
    does the reason go blank with a note asking the rep to choose (`termination-arbitration.ts:1134-1156`,
    `:1382-1386`).
28. **A ledger letter never writes back.** There is no master row id to key the undo on. The panel
    shows a *From the offboarded sheet* note instead of the checkbox and sends `write_back: false`,
    and the route skips any write without an id (`TerminationDocsPanel.tsx:1833-1848`, `:1050-1052`,
    `:2117-2121`; `route.ts:386-396`).
29. **A ledger letter is recognisable forever from its snapshot**: `matchedColumn:
    'offboarded_sheet.work_email'` with `masterRowId: null` (`types.ts:203-219`,
    `termination-arbitration.ts:1329-1334`).

How a ledger-only leaver differs from a master-row leaver:

| | Master-row leaver | Ledger-only leaver |
| --- | --- | --- |
| Identity row | every master row under the work email, current upload first (`termination-arbitration.ts:947-961`) | one stand-in, `id: null` (`:780-796`) |
| Name · department · start date | the winning row, then its tier, then first non-null (`:1183-1192`, `:1308-1311`) | the latest-departure ledger rows, only where they agree (`:770-791`) |
| Departure records | master stamps, dated sheet rows, the evidence read (`:1069-1101`) | every ledger row, dated or not (`:1078-1090`) |
| Re-engagement probes | every master row (`:1235`) | every ledger row (`:797-799`) |
| `ambiguous_identity` detail | one line per master row (`:993-1013`) | none, `candidates: []` (`:748`, `:765`) |
| Who fixes bad data, per the message | HR / the master list (`:1016`, `:1210`, `:1245`, `:1302`) | Engineering, on the ledger row (`:747`, `:764`, `:1209`, `:1244`, `:1301`) |
| Write-back | on opt-in (`route.ts:397-409`) | never (`route.ts:386-396`) |

**The ledger arm is NOT the insert script's check, whatever `documents-tab.md:686-690` says.**
Measured against the code 2026-09-29 (Sep 29 log item 264): refusal 4 fires only when the
ledger's personal inbox is on a **LIVE** master row (`termination-arbitration.ts:733-742`), while
the script refuses when the inbox is on **any** master row, stamped or not, in any email column
(`scripts/insert-ledger-only-master-row.mts:186-200`). The arm also never checks whether that
inbox sits on the ledger under another work email (script `:158-168`), and it compares composed
legal names where the script compares raw ones. So a leaver whose personal inbox is on a
STAMPED master row under a different work email gets a ledger letter the script would have
refused. Which of the two is intended is **Kane's call**; neither side is changed here.

30. **The insert script is no longer needed for a letter.** `scripts/insert-ledger-only-master-row.mts`
    stays as a one-person tool for when a master row is wanted for its own sake. A row it inserts
    moves that person off the ledger arm and onto the master path, which is the only route to the
    write-back (script `:29-34`, `documents-tab.md:685-690`). [[ledger-only-leaver-no-master-row]]

## Facts, blanks, and what the rep must fill

31. **Prompt, never refuse.** A missing fact is an input; a refusal is kept for what would make the
    letter false (plan `:20-24`).
32. **Six facts can arrive blank**: termination date, reason, ending department, start date,
    starting rate, ending rate (`types.ts:62-69`). Blanks are computed from the null facts and
    recomputed once the rates land (`termination-arbitration.ts:615-639`).
33. **The starting rate is the one optional blank.** `TERMINATION_OPTIONAL_BLANKS = ['starting_rate']`,
    pinned by a test (`termination-panel-rules.ts:292-313`, `termination-panel-rules.test.ts:388-392`).
    Left empty, the letter prints the ending rate alone (`TerminationDocsPanel.tsx:1995-1996`,
    `termination-document.ts:569-570`). Every other blank shows *Required — the letter cannot be
    generated while this is blank.* (`TerminationDocsPanel.tsx:335-341`).
34. **The route requires three facts; the panel requires five.** The route refuses 400 only while
    termination date, reason or ending department is blank, the three NOT NULL columns
    (`termination-route-rules.ts:148-154`, `:329-335`; `route.ts:294-295`). The panel also requires
    the start date and the ending rate, both on Carla's list. The panel may be stricter than the
    route, never looser (`termination-panel-rules.ts:303-307`).
35. **The rep can fill only what the server found blank.** Any other key, or a currency without its
    rate, is a 400 (`termination-route-rules.ts:162-207`).
36. **Every date on the page passes one gate**, `explicitMasterDay`: normalized, a real calendar day,
    the raw cell stating year, month and day, and not more than a day in the future. Anything else is
    a blank with `date_failed_sanity` (`termination-arbitration.ts:21-46`, `:150-223`,
    `:1369-1380`). A rep-typed date must be `YYYY-MM-DD` and then passes the same gate
    (`termination-route-rules.ts:209-263`).
37. **Only the department label prints.** `formatDeptLabel(raw)` reaches the page; a raw `hsl:*` key
    never does (`termination-arbitration.ts:1317-1321`, `route.ts:227-235`,
    `termination-log.ts:119-124`, `2026-08-31_termination_docs.sql:73-75`).
38. **The legal name is first, middle, last [+ extension]; the nickname is dropped**
    (`termination-arbitration.ts:645-652`).
39. **A typed rate must be above zero and carries the record's currency.** With no currency on
    record the rep must pick one; a currency that disagrees with the record is a 400 and a reload
    (`route.ts:91-97`, `:244-281`; `termination-route-rules.ts:276-326`;
    `TerminationDocsPanel.tsx:903-925`).

Why a fact is blank, in the rep's words (`TerminationDocsPanel.tsx:192-214`):

| `blankReason` | Panel copy |
| --- | --- |
| `not_on_file` | "nothing usable was on file in any source" |
| `date_failed_sanity` | "the stored date failed the sanity check — impossible, or far in the future — and an unchecked date must never print" |
| `never_paid` | "no payroll week has been paid out to this person yet, so there is no ending rate to read. They may still have earnings in a cycle that has not been closed — this is unavailable, not zero. Type the ending rate if you have it" |
| `no_hire_record` | "there is no digital hire record — the hire predates the onboarding pipeline" |
| `zero_rate` | "the source held 0, and a zero rate is not a rate" |
| `non_php_payee` | "this person is priced in a currency other than pesos, and the only figure on file is a peso-equivalent of a payroll week — not their rate. Type the rate in their own currency." |
| `currency_unresolved` | "a figure is on file but the Payment Catalog could not be read, so nothing can say which currency it is in. Type the rate and pick its currency." |
| `read_degraded` | "the source read failed" |

40. **`never_paid` is unavailable, not zero.** It means only that no `payment_dispatches` row with a
    `cycle_source_file` is marked paid yet (`termination-rates.ts:464-467`). The copy must not claim a
    cycle is open or closed: nothing here can read that (memory `termination-docs.md:74-80`,
    `TerminationDocsPanel.tsx:196-206`).

## Rates

41. **Starting rate, first hit wins** (`termination-rates.ts:357-443`): the hire record
    (`hr_pending_employees`, one pass per WORK alias, never the personal column) → the earliest
    decision in `employee_rate_history` (excluding the 1970 baseline and rows by `GSheets Sync` or
    `system`) → the 1970 baseline → blank `no_hire_record`, or `read_degraded` when the history read
    failed.
42. **Ending rate, first hit wins** (`termination-rates.ts:447-561`): the latest paid, non-contractor
    `payment_dispatches` row with a `cycle_source_file` (none → blank `never_paid`) → that week's
    paystub `rates_php.regular` (`wizard_snapshot` or `paystub_locked`) → that week's
    `disbursement_records.regular_rate_php` → the rate history as of the departure day → blank
    `not_on_file`, or `read_degraded`.
43. **A zero is not a rate.** A carrier holding ≤ 0 is a `zero_rate` blank
    (`termination-rates.ts:7-13`, `:256`, `:280`), and the DB refuses a stored rate that is not
    `> 0` (`2026-08-31_termination_docs.sql:67-71`).
44. **The currency is resolved, never assumed.** The Payment Catalog is read: an employee-scope
    structure on a work alias, then the department base, else the PHP rails
    (`termination-rates.ts:20-31`, `:164-226`). A failed catalog read leaves the currency null and
    turns any figure into a `currency_unresolved` blank (`:170-175`, `:257-259`). A bare-number
    carrier (hire record, rate history) prints only when the catalog confirms the payee's own
    currency; a non-PHP department base makes it `non_php_payee` (`:137-145`, `:217-222`,
    `:250-264`). A peso-equivalent carrier (`rates_php`, `regular_rate_php`) is `non_php_payee` for
    any non-PHP payee (`:266-291`). [[cop-country-payees-dispatch]]
45. **Known gap, deliberate:** a non-PHP payee whose only catalog structure is keyed on a personal
    address resolves to the PHP rails (`termination-rates.ts:47-54`).
46. **The source is recorded, never printed.** The panel shows it to the rep; the PDF does not
    (`types.ts:29-38`, `TerminationDocsPanel.tsx:216-227`).

## What the letter prints

47. One page titled *Certificate of Termination* (`termination-document.ts:100-101`): the legal
    name with the work email under it (`:525`), the statement that the person's contract ended on
    the termination date (`:530-537`), then *Contract end date*, *Reason for departure*, *Ending
    department* (`:541-544`), *Contract start date* only when present (`:546-547`), and one rate row:
    both rates as "start -> end", with a currency note when they differ, or the one rate that exists
    (`:549-571`). Below it the signature image, the signer's name, title and email, the signing
    date and the *Reference ID* (`:578-605`). A signature row with no title prints *Accounting
    Head* (`route.ts:320-321`). There is no blank line for a wet signature (meeting `:24-27`).

## What writes, and what never writes

On a successful POST, in this order (`route.ts:311-461`):

48. **The PDF** goes to `termination/‹email-segment›/‹id›/termination.pdf` in the existing private
    `document-requests` bucket with `upsert: false`, so a regeneration gets a new id and path
    (`termination-log.ts:213-221`). It is removed if the row insert fails (`:258-262`).
49. **One `termination_documents` row**: identity, printed facts, both rates with currency and
    source, the full `facts` snapshot, `filled_by_rep`, and `field_writebacks` starting as `[]`
    (`termination-log.ts:225-257`).
50. **One audit row, `documents.termination_generated`, awaited.** If it fails the generation fails,
    but the row and file stay (`termination-log.ts:266-305`).
51. **The write-back, only on opt-in and only with a master row id** (`route.ts:367-409`):
    - only cells the rep filled, and only `off_boarded_at`, `off_boarded_reason`, `"Start Date"`
      (`route.ts:369-381`, `types.ts:311-317`). Never `"Department"`, never a rate
      (`termination-writeback.ts:5-11`). [[hris-is-dept-source-of-truth]]
    - blank-ness proved in the filter chain: `.is(col, null)`, then `.eq(col, '')` for the two text
      columns. Zero rows is a skip, and a whitespace-only cell is skipped
      (`termination-writeback.ts:20-44`, `termination-writeback-rules.ts:235-336`).
    - keyed on `global_master_list.id`, never an email (`termination-writeback.ts:46-49`).
    - the undo trail is written to `field_writebacks` after each cell and before the next, and a
      failed save stops further cells (`route.ts:99-135`, `termination-writeback-rules.ts:318-330`).
      `before: null` and `before: ''` never collapse (`types.ts:297-309`,
      `termination-writeback-rules.ts:338-349`).
    - a second audit row, `documents.termination_writeback`, carries the records
      (`termination-log.ts:310-377`, `route.ts:426-459`). It is a second copy, not the copy
      (`termination-log.ts:319-324`).
    - a cell that was WRITTEN but whose undo record failed to save becomes a banner that does not
      dismiss, kept in `localStorage` under `simple-hris.termination-docs.manual-repairs.v1`, never
      a toast (`termination-panel-rules.ts:29-50`, `:109-131`, `:239-241`;
      `TerminationDocsPanel.tsx:29-35`).
52. **The write-back is last and never fatal.** The letter stands; a failure comes back as a skip
    with a 200 (`route.ts:359-363`).
53. **Regenerating is allowed, with a confirm that lists the letters already issued.** Both stay in
    the log (plan `:47`, `TerminationDocsPanel.tsx:2530-2561`).
54. **The log has no delete, and must never get one** (`TerminationDocsPanel.tsx:26-28`).

Scripts that write. Each is a dry run by default; Kane runs `--apply`:

55. `scripts/insert-ledger-only-master-row.mts` inserts ONE pre-stamped `global_master_list` row for
    one named work email, after a backup to `references/backups/`, and only if the tab's own
    arbitration returns facts for it (script `:1-69`, `:310-318`). It was approved for Raph Sepnio
    only and is not a batch tool (script `:25-27`, `documents-tab.md:690`). It has run once: row
    `cac9eb83…` for `raphs@simple.biz` was measured on 2026-09-25, and the note stays PENDING until
    Kane confirms it was his run (Sep 25 log item 211 (d), `documents-tab.md:697-701`). Revert:
    delete the printed row id (script `:69`).
56. `scripts/revert-termination-doc-writebacks.mts` reverses write-backs (§ *Removal*).
57. `scripts/apply-termination-docs-migration.mts` applies the DDL: no flag or `--dry` rehearses in a
    rolled-back transaction, `--apply` commits, `--verify` checks the table, five indexes, seven
    CHECKs and RLS (script `:1-13`).

Never written by this feature:

58. `employee_rate_history`, `employee_hourly_rates`, `payment_catalog_pay_structures`,
    `paystub_dispatch_queue`, `disbursement_records`, `app_settings`, `offboarded_sheet`,
    `offboarding_queue`, and `global_master_list."Department"` (contract `:858`). The write-back loops
    over the three-column allowlist and nothing else (`termination-writeback-rules.ts:222-223`,
    `:256`).
59. No email and no notification (plan `:6-7`, contract `:1144`).
60. Search and facts are reads. A refusal writes nothing, not even an audit row (rule 22).

## Route failure modes

| Route | Condition | Status | Cite |
| --- | --- | --- | --- |
| `GET …/search` | empty `q` | 200, no candidates | `search/route.ts:40-49` |
| | every read failed and nothing matched | 500 with `degraded` | `:59-71` |
| | some reads failed | 200 with `error` and `degraded` | `:73-80` |
| `GET …/facts` | no `work_email` | 400 | `facts/route.ts:29-35` |
| | resolver error | 500 | `:39-46` |
| | refusal | 200 with `blocked` | `:20-23`, `:48` |
| `POST …/termination` | no `work_email` | 400 | `route.ts:178-179` |
| | resolver error | 500 | `:187` |
| | refusal | 409 with `blocked` | `:188-190` |
| | unknown key, a key the server did not find blank, a currency without its rate | 400 | `termination-route-rules.ts:173-207` |
| | bad date, reason, empty department, rate ≤ 0, currency | 400 | `route.ts:207-281` |
| | a required fact still blank: "Fill in ‹fields› before generating" | 400 | `termination-route-rules.ts:329-335` |
| | the filled dates make a re-hire | 409 | `termination-route-rules.ts:348-364` |
| | the signature read errored | 500 | `termination-route-rules.ts:95-101` |
| | "No saved signature — …" / "Your signature is switched off — …" (the panel opens signature capture) | 412 | `termination-route-rules.ts:73-79`, `:102-103` |
| | unloggable facts, upload, insert or audit failure | 500 | `termination-log.ts:103-155`, `:196-305`; `route.ts:353-355` |
| | a thrown error with either signature substring | 412, else 500 | `route.ts:475-481`, `termination-route-rules.ts:110-112` |
| `GET …/termination` (log) | malformed `before` cursor | 400 | `route.ts:148-153`, `termination-log.ts:404-409` |
| | read error | 500 | `route.ts:148-153` |
| `GET …/[id]` | unknown or malformed id | **404, not 403** | `[id]/route.ts:20-24`, `:41-46`; `termination-log.ts:453-466` |
| | no file, or the URL could not be signed | 404 | `[id]/route.ts:48-54` |

Download URLs are signed for 3,600 s (`termination-log.ts:45-46`). The log pages past 1,000 rows and
never rests on a `.limit()` (`termination-log.ts:379-392`). [[postgrest-1000-cap-sweep]]

## Measured

**2026-09-28**, read-only on production, the real `arbitrateTerminationFacts`, **hours passed as
unavailable (T4 not checked)** (Sep 25 log item 245; `documents-tab.md:643-655`; meeting `:72-80`):

- **2,567** ledger work emails have no master row with that address as its Work Email. The
  2026-09-23 figure of 2,532 counted across all four email columns.
- **1,550** reach a facts sheet. 1,546 of them need the department and the start date typed, 395
  need the termination date, 4 need the reason.
- **832** refuse `not_a_departure` on the ledger's own labels (Open items 248).
- **129** `ambiguous_identity` · **35** `still_active` · **10** `bad_name` · **6** `no_master` ·
  **5** `temporary_pause`. The seven buckets sum to 2,567.
- Termination tests 364/364 at `6565022d` (item 245).

Earlier: **2026-08-21**, 1,287 active master rows carried zero stamps while 294 of those people were
offboarded (`termination-arbitration.ts:1030-1031`). **2026-09-16**, `wilmarg@` had 30:02:59 in the
Sep 6–12 file and was offboarded Sep 14 (Sep 14 log item 136).

## Open items

- **245 (a)** — the ledger arm and the optional starting rate have not been clicked through in a
  browser. **(b)** — this doc; closed when it is committed.
- **248 — OPEN, Kane's call.** 832 ledger-only leavers refuse `not_a_departure`: "No Show" 351 · "No
  Show During Orientation" 279 · "Policy Violation" 116 · "Declined Offer" 42 · "Productivity" 16 ·
  "Reschedule For Next Week" 9 · "Need to Reschedule" 5 · a tail of 1–2 each, including "Active" 2.
  Questions: does "Policy Violation" or "Productivity" read as `performance` (or `other`)? Should
  someone who never started get a letter at all? Suggested, not ruled: an approved mapping becomes a
  pinned normalization step beside `reasonKey`, not a blank the rep fills. Nothing is mapped until
  Kane rules (Sep 25 log item 248).
- **191** — (a) Raph Sepnio's master row exists (`cac9eb83…`, measured 2026-09-25) and waits on
  Kane's confirmation that it was his run. (b) and (c) were superseded on 2026-09-28 by the ledger
  arm (Sep 23 log item 191, Sep 25 log item 211 (d)).
- **136** — every recent leaver is refused for about one cycle, because the newest uploaded
  timesheet lags a week. The row still reads OPEN for Kane/Carla. Kane declined issuing anyway on
  2026-09-16, and the 2026-09-28 meeting did not reopen it (meeting `:53-58`).
- **263** (Sep 29 log): this doc, and the migration measured PRESENT (3 rows, 2026-09-29).
- **264 — OPEN, Kane's call** (Sep 29 log): the ledger arm is looser than the insert script it is
  documented as copying (§ *The ledger arm*). Also: the `not_a_departure` fallback copy is false
  for ledger labels; `types.ts:40` and the unmarked `DOC_TABS` are stale markers; refusals are
  unaudited, so which one a rep hit is only ever inferred (meeting `:47-49`); the insert script's
  own `selectAllPaged` pages with `.range()` and no `.order()` (script `:119-128`), so the
  collision scan that gates its one write can skip a row ([[postgrest-1000-cap-sweep]]).
- `src/lib/anthropic/admin-tools.ts:1415` builds `.or()` with email values, which PostgREST
  mis-splits. A separate bug (contract `:1166`, memory `termination-docs.md:126-128`).

## Where the contract and the code differ

The contract was frozen on 2026-08-31, before audit round 1, and was re-edited only where Kane
ruled on 2026-09-28 (the ledger arm, the optional starting rate). This doc describes the code;
the table keeps the contract's version beside it. **It is a record, not a ruling.** Most rows are
audit-round-1 fixes, and only the non-PHP row carries a named ruling (plan risk 4). Before
changing either side to match the other, raise it as a `hardening` CONFLICT. Two code-side
markers are also stale: `types.ts:40` still says a blank rate means *"the rep must fill it"*,
which is false for `starting_rate` since `6565022d`. And `DOC_TABS` / `DocTab`
(`AccountingDocuments.tsx:66-67`) carry no `[TERMINATION-DOCS]` marker (Sep 29 log item 264).

| Topic | Contract | Code at HEAD |
| --- | --- | --- |
| Active check (G3) | `fetchGmlStatusMap` active ⇒ an absolute `still_active` (`:729`, `:943-944`) | the roster refuses only when nothing first-party records a departure; hours refuse separately (`termination-arbitration.ts:1036-1066`, `:1276-1288`) |
| Departure evidence | `loadOffboardEvidenceByEmail('work')` (`:730`, `:922`) | the feature's own read with an error channel (`termination-evidence.ts:6-21`) |
| Refusal order | name refusal before the re-hire check (`:732-734`) | `bad_name` is last (`termination-arbitration.ts:1290-1305`), matching plan `:87-89` |
| Refusal codes | nine codes (`:234-243`) | adds `reengaged_after_departure` (`types.ts:121-134`) |
| `ambiguous_identity.candidates` | `string[]` (`:236`) | per-row objects the rep can read, `[]` on the ledger arm (`types.ts:95-115`) |
| Search | exact address, four email columns (`:702-712`) | a `%fragment%` across name and email columns, 3-char minimum, 50 cap (`termination-search.ts:6-36`) |
| Hire-record rate | also matched on `hr_pending_employees.personal_email` (`:754`) | work aliases only (`termination-rates.ts:371-383`) |
| Non-PHP payees | PHP only; a USD/COP figure is a `non_php_payee` blank (`:766`) | native currency from the Payment Catalog where it confirms one (`termination-rates.ts:20-41`); plan risk 4 ruled "print the native currency" (plan `:45`) |
| `TerminationRate.currency` | always one of the three (`:206`) | `null` when nothing could state one (`types.ts:43-55`) |
| `''` write-back | re-read, then one unguarded retry (`:855`) | a second guarded UPDATE, `.eq(col, '')` (`termination-writeback.ts:148-157`) |
| DDL | six CHECK constraints (the plan says "five CHECKs"), no RLS (`:576-601`) | seven CHECKs incl. `currency_present_with_rate`, and RLS on (`2026-08-31_termination_docs.sql:93-102`, `:139`) |
| Revert | a SKIP is reported and the run exits non-zero, with no way to retire it (`:1111-1115`; audit round 1 `:103-109`) | `--accept-skipped` retires reviewed skips (revert script `:5-9`, drop SQL `:41-53`) |
| One commit | `git revert <feature-commit-sha>` (`:1123-1128`) | the feature landed inside `e8e8c6ae` with unrelated work; there is no single sha (`hris-plan.ts:1337`) |
| Negative inventory | "no `localStorage` key" (`:1144`) | `simple-hris.termination-docs.manual-repairs.v1` (`termination-panel-rules.ts:241`) and the `docTab` in sessionStorage `documents:view` (`src/lib/accounting/tab-cache.ts:507-512`) |
| Tab state | `useState('queue')` (`:101`) | seeded from the tab cache (`AccountingDocuments.tsx:149-150`) |

## Removal (one-shot)

Modelled on `payroll-wizard-tutorial-mode.md` § Removal. The write-back is the one act a code revert
cannot undo, so it goes first.

1. **Reverse the write-backs.** Dry run first; it predicts WOULD-RESTORE / WOULD-SKIP per record.
   Then `--apply`. Records that cannot be reversed stay in `field_writebacks`, annotated; after a
   human reads them, `--accept-skipped` then `--apply --accept-skipped` retires them with a backup
   (revert script `:5-9`, `:50-76`; drop SQL `:4-53`).
2. **PRE-CHECK must return 0**: `select count(*) from public.termination_documents where
   jsonb_array_length(field_writebacks) > 0;` (drop SQL `:12-16`).
3. **Drop the table, then the storage prefix** `termination/%` in `document-requests`
   (drop SQL `:55-67`). Kane cannot paste SQL, and no script runs this drop today, so it needs one
   with an `--apply` gate (CLAUDE.md § Data).
4. **Delete the code by path.** There is no single commit to revert (see the table above).
   - First re-point `src/lib/documents/coe-admin-search.ts:31`: the COE search imports
     `escapeLikePattern` from `./termination/reason-key`.
   - Delete `src/lib/documents/termination/`, `src/components/accounting/termination-docs/`,
     `app/api/accounting/documents/termination/`.
   - In `AccountingDocuments.tsx`, remove the marked blocks (`:56-58`, `:149-150`, `:489-501`,
     `:968-977`) and the unmarked `DOC_TABS` / `DocTab` (`:66-67`) with the cached view's `docTab`
     (`src/lib/accounting/tab-cache.ts:507-512`).
   - Edit `src/lib/documents/documents-unaffected-by-payroll-lock.test.ts:36-37`, `:54-57`: its
     first test fails on a missing file (`:72-79`).
   - Edit the audit-registry note (`src/lib/audit/registry.ts:213`) and the dataset's source list
     (`src/lib/external-api/datasets.ts:678`).
   - Delete the three scripts and the two SQL files, the revert script and the drop only after they
     have run.
5. **Delete the record**: this doc, its `docs/features/INDEX.md` row, `documents-tab.md` § ledger
   arm, the plans, and the memory entries `termination-docs` and `ledger-only-leaver-no-master-row`
   with their `MEMORY.md` lines.

Not dropped, deliberately: the `document-requests` bucket, `document_requests`,
`document_signatures`, and every audit row with action `documents.termination_generated` or
`documents.termination_writeback` (drop SQL `:68-71`). Nothing else references the feature: no env
var, no `app_settings` key, no cron, no n8n webhook, no notification type (contract `:1144`). Left
inert: the `localStorage` key, the `docTab` field, and the Realtime channel
`accounting-termination-docs` (`TerminationDocsPanel.tsx:708-711`).

## Deploy notes

- **The migration** is `references/sql/migrate/2026-08-31_termination_docs.sql`, applied with
  `scripts/apply-termination-docs-migration.mts --apply` against the session pooler `DATABASE_URL`
  (script `:22-32`). **APPLIED: measured 2026-09-29, the table is present with 3 rows** (read-only
  select; Sep 29 log item 263). The constraints, indexes and RLS were not re-read; `--verify`
  checks them but also runs inside a transaction, so it is Kane's to run. Before it ran, the log
  GET answered 500 and no letter could be saved (audit round 1 `:325-329`, script `:38-40`).
- **`6565022d` needed no migration.** The ledger arm reads `offboarded_sheet`, which already exists
  (`termination-ledger.ts:40-59`).
- No env var, no n8n import, no cron (contract `:1144`).
- Code on `origin/main` (`0fa0b89d` includes `6565022d`). Not browser-clicked since `6565022d`
  (Open items 245 (a)).

## Related memory

[[termination-docs]] · [[ledger-only-leaver-no-master-row]] ·
[[2026-09-28-carla-termination-letters-blocked]] · [[accounting-documents-tab-cache]] ·
[[documents-not-gated-by-payroll-lock]] · [[hubstaff-filename-junk-heuristic-hides-paid-week]] ·
[[kpi-bonus-shared-personal-email]] · [[maria-argote-split-identity]] ·
[[lawang-rate-shadow-duplicate-identity]] · [[offboarded-tab-no-date-means-stale-row]] ·
[[rehire-invisible-offboard-reuse]] · [[hris-is-dept-source-of-truth]] ·
[[cop-country-payees-dispatch]] · [[postgrest-1000-cap-sweep]]
