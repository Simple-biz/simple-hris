# Update bank info: the public OTP page where an employee edits their own payout details

A PUBLIC, no-login page at **`/update-bank-info`**. Someone types a work email, a 6-digit code
is mailed to that person's **company inbox**, and after verifying it they review and change the
receiving details payroll pays them on: payment method, wallet emails, bank accounts. The
changes land directly in `employee_ids`, the payout record the People tab and Payment Dispatch
read (`references/sql/migrate/2026-06-29_bank_update_external_link.sql:4-8`).

**Status:** live code at HEAD `c76bb25a` (2026-09-29). Built 2026-06-29 (`d1167017`). The
non-clearable history table was added 2026-07-01 (`f63443a6`) and the dispatch-lock probe
2026-07-21 (`3618d82d`). The sending-bank mismatch alert came 2026-09-24 (`6cabcff3`), and the
card-safety warning 2026-09-25 (`d21a0a3b`, `87c407ff`).
Both of those are on `origin/main` (Open item 215); a production deploy was not verified. This
doc was written 2026-09-29 from the code, read-only. **Only two things in it were measured
against production for this doc:** the anon-key reads of `bank_update_otps` and
`bank_update_history` (§ *Security notes*, 2026-09-29). Every other number cites its source.

**Payout change safety, 2026-10-07** (§ *Payout change safety*): the page shows how many times
the account on file has been paid, and a save that changes anything is refused until the employee
acknowledges a versioned notice (card numbers, closed accounts, a spouse's or anyone else's
account), plus a separate confirmation when the new account looks like a card number or its holder
is not them. What they attested is recorded. The same gate runs on the Employee Dashboard's own
save ([employee-profile.md](employee-profile.md) §6.4).

It is the precedent the gift-address link was copied from
([gift-address-external-link.md:34-37](gift-address-external-link.md)). The two flows now
differ in places, which §*Security notes* lists.

## Key files

| Piece | File |
| --- | --- |
| Page (four steps, lock probe, card-safety notice) | `app/update-bank-info/page.tsx` |
| Request a code | `app/api/bank-update/request-otp/route.ts` |
| Verify the code, return the prefill | `app/api/bank-update/verify-otp/route.ts` |
| Save | `app/api/bank-update/save/route.ts` |
| Public lock probe | `app/api/bank-update/lock-status/route.ts` |
| OTP + session machinery | `src/lib/bank-update/otp.ts` |
| Code email (n8n) | `src/lib/bank-update/otp-email.ts` |
| Payroll-team email (n8n) | `src/lib/bank-update/notify-email.ts` |
| Current-details prefill | `src/lib/bank-update/prefill.ts` |
| Write-time masking | `src/lib/bank-update/mask-field.ts` |
| History table data layer | `src/lib/supabase/bank-update-history.ts` |
| Method radios + detail fields (shared with the dashboard) | `src/components/employee/employee-payout-fields.tsx` |
| Completeness + effective rail (shared) | `src/lib/employee/payout-completeness.ts` |
| Edge allowlist, rate limit, host isolation | `proxy.ts` |
| Migrations | `references/sql/migrate/2026-06-29_bank_update_external_link.sql` · `2026-07-01_bank_update_history.sql` |
| The email that links here | `references/n8n/bank-info-missing-notify.workflow.json` · `src/lib/people/bank-info-notify.ts` · `app/api/people/request-bank-info/route.ts` |
| Payout change safety: notice text + version, card/holder checks, the gate, the attestation, the track-record fold | `src/lib/banking/payout-change-safety.ts` (+ `.test.ts`, 25 tests) |
| Track record reader (`payment_dispatches`, paged) | `src/lib/supabase/payout-track-record.ts` |
| The notice and the track line (shared with the dashboard) | `src/components/banking/payout-change-notice.tsx` |
| The attestation column | `references/sql/alter/2026-10-07_bank_update_history_safety.sql` · `scripts/apply-bank-update-history-safety-migration.mts` |
| The measurement behind the design | `scripts/measure-payout-track-record.mts` (read-only, counts only) |
| Tests that pin it | `src/lib/employee/send-from-accounting-only.test.ts:57-62` · `src/lib/notifications/notification-views.test.ts:25-40` · `src/lib/banking/payout-change-safety.test.ts` |

## Who uses it, and how they get there

- **Anyone, unauthenticated.** `/update-bank-info` is in `PUBLIC_PATHS` (`proxy.ts:163-167`)
  and `/api/bank-update/*` skips the JWT gate after the rate limiter (`proxy.ts:265-275`).
  Public by design. `pre-release-security-readiness.md:83-85` clears it as intentional: *"do not
  'fix' these"*.
- **Who can get a code:** a row in `active_employees` whose `"Work Email"` or
  `"Personal Email"` matches the typed address (`src/lib/bank-update/otp.ts:83-97`). "Active"
  is that view's definition. It keeps leavers on the sheet through final pay: 294 of 1,287
  active rows belonged to people who had left (`INDEX.md:27`, Rates & Payment Catalog row,
  citing `bonus-catalog.md` §3.2, 2026-08-21).
- **The main way in** is the Missing Bank Info email. Accounting or the CEO (edit on the `people`
  feature, `app/api/people/request-bank-info/route.ts:35-36`) clicks **Notify** in People → the
  Missing bank info dialog (`src/components/people/PeopleTab.tsx:1447-1530`). That drops an
  in-app `bank_info.requested` nudge (`request-bank-info/route.ts:80-129`) and fires the
  `bank_info_notify` n8n webhook (`:146-160`). The n8n *Build Recipients* node hard-codes the
  button link as `https://bank-payout-update.vercel.app/update-bank-info`
  (`bank-info-missing-notify.workflow.json:23`, `UPDATE_LINK`). The in-app nudge points at the
  dashboard Profile instead (`request-bank-info/route.ts:83-85`).

## The flow, step by step

1. **Page load: lock probe.** `GET /api/bank-update/lock-status` returns only `{ locked }`
   (`lock-status/route.ts:21-24`). The page re-polls it every 20 s and on focus or visibility
   (`page.tsx:57-80`). While locked, the email field, **Send code** and **Save changes** are
   disabled and a rose "Payroll is being processed" notice shows (`page.tsx:231, 245, 252, 307,
   336, 407-426`).
2. **Email.** The page checks the address shape (`page.tsx:32, 86-89`) and POSTs `{ email }` to
   `request-otp` (`page.tsx:92-96`). The server resolves the person, mints a code if under the
   throttle, mails it to the row's Work Email, audits, and answers with one fixed sentence
   (§Rules 2–4).
3. **Code.** The field accepts six digits only (`page.tsx:112, 275`). **Resend code** re-runs
   step 2, and **Change email** goes back (`page.tsx:284-301`). `verify-otp` checks the newest
   live code. On success it returns `session_token`, `work_email`, `name`, the current
   payout record, and `payout_track`: how many times the account on file has been paid
   (rule 27).
4. **Edit.** The method picker is seeded with the stored `preferred_processor`, else the
   **effective** rail (Bank Preferred → Disbursement → legacy cell), so a person routed on
   Bank Preferred is not shown an empty picker (`page.tsx:139-146`,
   `payout-completeness.ts:113-122`, [bank-preferred-routing.md:480-482](bank-preferred-routing.md)).
   The fields for the chosen method render from the shared component. The track line sits above
   them and the payout change notice below them (§ *Payout change safety*). **Save** is blocked in
   the browser until a method is chosen, its required fields are filled, and the notice (plus any
   card or holder confirmation it raised) is ticked.
5. **Save.** POSTs the session token, the 18 payout keys and the three safety answers. Server
   order: token → 401 · service role → 500 · field validation → 400 · dispatch lock → 423 ·
   before-snapshot · **safety gate → 400** (with a `bank_update.safety_refused` audit row) · write ·
   stamp · audit · history · reviewer alert · feed pulse · payroll email.
6. **Done.** **Make another change** returns to the edit step with the same token
   (`page.tsx:355-363`). The token keeps working until its 20 minutes run out
   (`otp.ts:26, 230-233`), after which a save answers 401 *"Your verification expired"*
   (`save/route.ts:117-122`).

## Rules

Each is what the code does at HEAD, with where it does it.

### Identity

1. **The saved-to person comes only from the verified session token, never from the request
   body.** `resolveSessionToken` is the only source of the target email
   (`save/route.ts:114-122`, `otp.ts:211-235`). The save accepts no email field, and
   `name` / `work_email` / `personal_email` are not on its allowlist (`save/route.ts:18-44`).
   This closed the "salary-redirect hole"
   (`2026-06-29_bank_update_external_link.sql:17-22`).
2. **The code is only ever mailed to the row's Work Email**, including when the person typed
   their Personal Email (`otp.ts:66-73, 101-108`; `request-otp/route.ts:75-80`). A matched row
   with no Work Email gets no code (`otp.ts:102`).
3. **Only `"Work Email"` then `"Personal Email"` are matched.** The two alternate work-email
   columns are not (`otp.ts:96-97`). A typed alternate resolves to nobody and gets the
   generic answer with no code. The gift link fixed this gap for itself on 2026-09-23. The bank
   copy was deliberately left unchecked as a live money path (Open item 182;
   [gift-address-external-link.md:345-347](gift-address-external-link.md)).

### Enumeration

4. **`request-otp` answers one fixed sentence** for an active employee, a non-employee, a
   throttled send and a malformed address. A malformed address gets it **without a database
   hit** (`request-otp/route.ts:16-21, 36-40, 62-73, 98`). The two exceptions carry nothing
   per-email: an empty body is a 400 (`:32-35`), and a missing email webhook in production is a
   503 **before** any lookup (`:42-57`).
5. **`verify-otp` shares one error sentence** between "wrong code" and "no live code / unknown
   email" (`verify-otp/route.ts:43-48`), and a non-employee is reported as `expired`
   (`otp.ts:162-164`). The response also carries a `reason` field, which does distinguish them.
   See §Security notes.

### Codes and sessions

6. **Codes are 6 digits, stored only as `sha256(code · work_email · pepper)`, compared in
   constant time** (`otp.ts:45-47, 54-59, 62-64, 183-185`). The pepper is `NEXTAUTH_SECRET`
   (`otp.ts:41-43`).
7. **A code lives 10 minutes, and 5 wrong guesses kill it** (`otp.ts:25, 27, 181, 187-193`).
   Only the **newest unconsumed** code for the inbox is checked (`otp.ts:171-178`), so a resend
   replaces the previous code.
8. **At most 3 codes per email per 15 minutes, and the throttle fails CLOSED.** A count error
   or a null count counts as "at the cap" (`otp.ts:28-29, 126-135`).
9. **A verified code becomes a 20-minute session.** 32 random bytes go to the browser once, and
   only their hash is stored (`otp.ts:26, 196-205`). A save does not consume it: `save/route.ts`
   has no write to `bank_update_otps`, and **Make another change** reuses it until it expires
   (`page.tsx:355-363`).

### Edge

10. **`/api/bank-update/*` is rate-limited per IP: 10 POST and 30 GET per 60 s, answering 429**
    (`proxy.ts:43-46, 265-275`). The counter is in-memory per edge isolate and resets on a cold
    start (`proxy.ts:27-33`). It is keyed on the first `x-forwarded-for` hop, bucket `bank`
    (`proxy.ts:64-70, 87-89`).
11. **On `BANK_UPDATE_PUBLIC_HOST` only this flow exists.** `/update-bank-info` is served,
    `/api/bank-update/*` falls through to the limiter, every other `/api/*` is a 404, and every
    other page redirects to the form. This runs before `PUBLIC_PATHS`, so `/login` never renders
    on that host. It is inert until the env var is set (`proxy.ts:177-206`).

### What the save accepts

12. **Allowlist: 19 payout columns of `employee_ids`** (`save/route.ts:24-44`). **Processors:**
    `hurupay` (Kolan), `wepay`, `higlobe`, `wise`, `jeeves`, `wires`, anything else a 400
    (`:45, 138-140`). **Bank slot:** `primary` | `alternative` (`:46, 141-143`). An empty
    update is a 400 (`:147-149`).
13. **The page offers Kolan, HiGlobe and Wires for a new pick**, plus the stored method when it
    is a retired one (Wise, Jeeves, Wepay) so the picker is not blank
    (`employee-payout-fields.tsx:243-253`, `employee-payment-processors.ts:28-33`). That narrowing
    is in the UI. The server allowlist in rule 12 still accepts all six.
14. **Posted means written. Blank means NULL, and absent means untouched** (`save/route.ts:134-145`).
    The page posts all 18 of its keys on every save (`page.tsx:163-183`). A field the employee
    clears is therefore cleared in `employee_ids`, and `fields` in the audit and history rows
    always lists all 18. The per-field `changed` flag is what says what moved
    (`save/route.ts:252-261`; [[nobank-list-clobbered-submissions]]).
15. **The page never posts `routing_number`.** Primary SWIFT is posted as `swift_code`
    (`page.tsx:178`), and the alternative slot's SWIFT as `alt_routing_number` (`page.tsx:182`). The prefill reads primary SWIFT from
    `swift_code`, falling back to `routing_number`, and alternative SWIFT from
    `alt_routing_number` (`payout-completeness.ts:82, 87`), so the round trip is stable.
16. **"Complete before save" is a browser check only** (`page.tsx:184-189`, `isPayoutComplete`).
    The route does not call it.

### The sending bank

17. **The page never writes `employee_ids.bank_preferred`, the send-from rail.** It is not on the
    allowlist (`save/route.ts:24-44`), a test pins that
    (`send-from-accounting-only.test.ts:57-62`), and only Accounting sets it, in People → Banking
    ([bank-preferred-routing.md:280](bank-preferred-routing.md); [[bank-preferred-approval-gate]]).
18. **A receiving change that leaves Accounting's sending bank out of step is reported, never
    refused.** When `preferred_processor` is written, the stored `bank_preferred` is read into
    the before-snapshot (never into `changes`), and `sendFromMismatch` is run
    (`save/route.ts:175-195`). A mismatch retitles the reviewer alert *"Bank details updated —
    sending bank no longer matches"* and appends `sendFromMismatchSentence`
    (`save/route.ts:94-100`). This matches the dashboard route
    ([bank-preferred-routing.md:258-272](bank-preferred-routing.md)). A person with no sending bank
    set is never a mismatch (`:270-272`).

### Lock

19. **Every save is refused with 423 while `payroll.dispatch_locked` is true**
    (`save/route.ts:151-162`; `payroll-dispatch-lock.ts:3, 18-29`). The check runs after
    validation and before any read or write. The lock probe and the greyed controls are advisory
    UX (`lock-status/route.ts:7-20`, `page.tsx:50-56`). A 423 mid-session flips the page into the
    locked state (`page.tsx:198-200`).
20. **Requesting and verifying a code are not lock-gated on the server.** Only the page greys
    **Send code** (`page.tsx:84, 252`). **Verify** is not greyed (`page.tsx:280`).
21. **The per-cycle lock `payroll.dispatch_lock.<sourceFile>` does not gate this page.** It
    gates nothing server-side ([bank-preferred-routing.md:508-512](bank-preferred-routing.md)).

### Masking and who hears about it

22. **Values are masked at write time, so `audit_log` and `bank_update_history` never hold a full
    account number** (`save/route.ts:249-261`, `mask-field.ts:1-10`). Masked: `account_number`,
    `alt_account_number`, `routing_number`, `alt_routing_number` and `phone_number` keep their
    last 4 behind at most 8 dots. The four wallet emails keep their first character and domain
    (`mask-field.ts:12-48`). **Stored verbatim:** bank name, account holder, address, processor,
    `swift_code`, `wise_tag`, `higlobe_account_name` and `preferred_bank_slot` (`mask-field.ts:55-62`).
23. **The payroll-team email names WHO and WHICH FIELDS, never values**
    (`notify-email.ts:5-11, 79-104`). The in-app alert's `details` carry field names only
    (`save/route.ts:96-101`).
24. **The in-app alert goes to live `admin` / `accounting` / `ceo` role holders only**
    (`save/route.ts:75-86`), and `people.banking.self_updated` is kept off every HR view
    (`notification-views.test.ts:25-40`, [notification-alerts.md:35-40](notification-alerts.md)).

### Prefill

25. **What the verified browser sees:** the person's `employee_ids` row, including
    `bank_preferred` and full account numbers (`prefill.ts:28-56`). With no row it falls back to
    the newest non-archived `hr_onboarding_submissions` row matched on **work email only**,
    never personal email, *"which is documented as non-unique and could surface another person's
    bank details"* (`prefill.ts:15-20, 58, 70-79`). That fallback maps only
    `hurupay` / `wires` as a method (`prefill.ts:91`).

### Payout change safety (2026-10-07)

26. **A self-service save that changes anything is refused (400 `payout_notice_ack_required`)
    unless `payout_notice_ack` equals `PAYOUT_CHANGE_NOTICE_VERSION` exactly.** A stale page
    posting an older version, or `true`, is refused. A save that changes nothing needs no
    acknowledgement. "Changed" compares each posted field with the stored row; the stored row is
    read whole and best-effort, and an unread row (`{}`) makes everything read as changed, so the
    gate asks rather than skips (`judgePayoutChange`, `assessPayoutChange`).
27. **The track record counts `paid` dispatch rows whose recorded destination is the account on
    file**: digits of `recipient_account_number` against the paid slot's account, or the wallet
    email lowercased on a wallet rail, keyed on the rail Payment Dispatch pays (all three tiers,
    `resolveWalletRailLock`). `problem` rows to the same account are counted too. A failed read is
    `unavailable`, **never "0 payments"**. Rows with no recorded account cannot be attributed, so the
    count is "on record", a floor.
28. **A card-shaped account number is confirmed, never blocked.** A NEW account number (changed in
    this save) with 15–19 digits, a card-network prefix and a valid Luhn digit needs
    `confirm_not_card_number: true` (400 `card_confirm_required`). Not a block, because 2 of the 8
    card-shaped numbers on file were paid successfully (measured 2026-10-07). A number already on
    file is not re-flagged.
29. **A holder who is not the employee is confirmed, never blocked.** When a slot's details change
    (or the paid slot switches) and its holder name does not carry BOTH a given name and a surname
    of the employee, or HiGlobe's account name likewise, the save needs
    `confirm_holder_is_self: true` (400 `holder_confirm_required`). A shared surname alone is what a
    spouse's account looks like, so it is a mismatch; surname particles (*dela*, *de los*, *san*)
    never count. The names judged against come from the roster and the payout row, **never the
    body**. Not a block, because 115 of 1,044 bank-rail holders on file read as a mismatch
    (married names, short forms, roster typos).
30. **What the employee attested is recorded and holds no value**: notice version, time, flags,
    both confirmations, whether the destination moved, and the paid/problem counts of the account
    they left. It goes on the `bank_update.saved` audit row (`details.safety`), the non-clearable
    `bank_update_history.safety` column, and Accounting's alert (`details.safety` plus plain
    sentences). A flagged change without a sending-bank mismatch is titled *"Bank details updated —
    check the new account"*; the mismatch title keeps precedence (rule 18).
31. **A refusal is recorded too** (`bank_update.safety_refused`, `{via, code, flags}`), so the
    record shows the employee was warned even when nothing was saved.

## What it writes

| Where | What | Code |
| --- | --- | --- |
| `bank_update_otps` | One row per code: `work_email`, `code_hash`, `attempts: 0`, `expires_at`, `request_ip`. A wrong guess bumps `attempts`, and the 5th sets `expires_at` to now. A verify sets `consumed_at`, `session_token` (the hash) and `session_expires_at`. | `otp.ts:139-145, 187-193, 197-205` |
| `audit_log` | `bank_update.otp_requested`: `resource_id` = the typed email when nobody matched, the Work Email when someone did; `details` `{found}` or `{found, throttled}`. `bank_update.otp_verify_failed`: typed email, `{reason}`. `bank_update.otp_verified`: Work Email, `{has_existing_payout}`. `bank_update.saved`: Work Email, role `employee (external link)`, `{via, fields, processor, created, changes, safety?}` with masked `changes` and the attestation (rule 30). `bank_update.safety_refused`: Work Email, `{via, code, flags}` (rule 31). | `request-otp/route.ts` · `verify-otp/route.ts` · `save/route.ts` |
| `employee_ids` (existing) | The posted payout columns, on **every** row whose `work_email` matches case-insensitively | `save/route.ts:198-202` |
| `employee_ids` (new) | When no row matches: `employee_id` `SELF-` + 14 hex characters, `name` (roster name, else derived from the address), `work_email`, `personal_email` (roster), plus the payout columns | `save/route.ts:48-53, 209-233` |
| `employee_ids.bank_last_self_updated_at` | now(), best-effort | `save/route.ts:235-245` |
| `bank_update_history` | `work_email`, `employee_name`, `fields`, masked `changes`, `processor` (= `preferred_processor`, the receive election, not the send-from rail), `created_new`, `via: external_link`, `ip_address`, and `safety` (the attestation, rule 30) once the 2026-10-07 column exists. Best-effort. Until the column is applied, PostgREST rejects a payload naming it, so the writer retries that one error without it: the history row still lands and the attestation stays on the audit row. No actor column: `external_link` means the employee themself ([[admin-penny-ai]]). | `save/route.ts` · `bank-update-history.ts` (`insertBankUpdateHistory`) · [bank-preferred-routing.md:600-603](bank-preferred-routing.md) |
| `employee_notifications` | `people.banking.self_updated`, tone `neutral`, one per recipient; `details` `{work_email, via, fields, send_from_mismatch?, safety?}`; title *"check the new account"* on a flagged change with no mismatch | `save/route.ts` (`notifyReviewers`) |
| `app_settings` | `people.bank_changes.pulse` = now, to nudge the People → Bank changes feed | `save/route.ts:293-295` · `app-settings.ts:272-281` |
| n8n `bank_update_otp` | `{to, recipient_name, otp_code, subject, body, html, sent_by}` to the Work Email | `otp-email.ts:70-79` |
| n8n `bank_update_notify` | To `BANK_UPDATE_NOTIFY_EMAIL`, else `payroll@simple.biz`: employee, method, first-time vs update, field names | `notify-email.ts:20-23, 79-104` |
| Rate-profile cache | invalidated after the write | `save/route.ts:247` |

## What it never writes

- **`employee_ids.bank_preferred`**, rule 17. The route also never files a sending-bank request.
  There is no employee approval flow any more
  ([bank-preferred-routing.md:166-169](bank-preferred-routing.md)).
- **`name`, `work_email` or `personal_email` of an existing row** (`save/route.ts:19-21`). Only
  the bootstrap insert sets them (`:211-217`).
- **`routing_number`** from this page, rule 15. The route would accept it (`save/route.ts:29`).
- **The roster or onboarding tables.** `active_employees` and `hr_onboarding_submissions` are
  read only (`otp.ts:88-94`, `prefill.ts:72-79`).
- **A full account number into any trail**, rule 22. **Any value into an email or alert**,
  rule 23.
- **The plaintext code or session token.** Only their hashes are stored (`otp.ts:139-145,
  197-205`).

## The card-safety warning (2026-09-25, Open item 207)

Kane: *"Bank update external link - Can we add reminders to the employees not to give Card
Numbers, CVV and Expiry date and that Simple Employees would never ask this"*, and for the
emails *"yes add that too"* (Sep 23 session log, item 207).

| Surface | Where | Copy | State |
| --- | --- | --- | --- |
| The page | amber `CardSafetyNotice` on the email, code and edit steps (`step !== 'done'`) | *"Never share your card number, CVV or expiry date"* / *"Simple employees will never ask for these — not on this page, by email, chat or phone. If anyone does, it's a scam. We only need your account or wallet details to pay you."* | Code on `origin/main` (`d21a0a3b`, item 215); deploy unverified. `page.tsx:228, 377-401` |
| OTP code email | amber box in the HTML, one line in the text body | *"Never share your card number, CVV or expiry date. Simple employees will never ask for them — by email, chat or phone. If anyone does, it's a scam."* | Ships with the deploy (`87c407ff`). `otp-email.ts:44, 76` |
| Missing Bank Info email | the grey trust note in *Build Recipients*, deliberately not red | *"Simple employees will never ask for your password, a payment, or your card number, CVV or expiry date — if anyone does, it's a scam."* | **Live since 2026-10-02** (Kane, 2026-10-02 ~21:20 EDT: *"it already existed"*, then *"udpated!"*): the live n8n node now runs this code. Kane's word; n8n is not readable from here. `bank-info-missing-notify.workflow.json:23`; [[bank-info-notify-webhook]] |

## Payout change safety (2026-10-07, Open item 401)

Kane, 2026-10-07: *"When updating bank information - lets add like an indicator in there that this
bank account has been successful in how many numbers with no problems - and let them know that if
they change this - it might cause problems if not done correctly like, Giving out Card numbers
instead of account numbers, Or closed account numbers … lets also add that do not send your money
to your spouse or anyone that isn't you … This type of error should not rule that this is an HRIS
Problem but rather a USER ERROR make sure we have systems and loggers in place for this"*.

**Both self-service surfaces, one module.** This page and Profile → Compensation → Payout render
the same `PayoutTrackLine` and `PayoutChangeNotice`, from copy that lives beside the server gate
in `payout-change-safety.ts`, so the warning cannot be worded differently in two places. The
dashboard route applies the gate to the employee's **own** row only; staff fixing someone else's
row (People tab, Payroll Wizard Readiness) are not attesting to their own account and are not
asked.

**Measured before it was designed** (`scripts/measure-payout-track-record.mts`, read-only, counts
only, 2026-10-07):

| Measure | Value |
| --- | --- |
| `payment_dispatches` rows | 13,970: 13,792 `paid`, 165 `threshold`, 13 `problem` (a cleared problem is DELETED, so problems undercount) |
| Paid rows with no recorded account | 2,498, which cannot be attributed to an account |
| `employee_ids` rows with a destination on file | 2,103 of 2,347 (1,118 wallet, 985 account) |
| Paid to the CURRENT destination | 684 at 10–19 times, 254 at 5–9, 641 at 1–4, 524 never |
| Paid before but never to the current destination | 58 |
| Card-shaped numbers on file | 8 of 22 sixteen-digit values; **2 were paid successfully** |
| Bank-rail holder vs own name | 859 match, **115 mismatch**, 70 unknown |

Those last two rows are why rules 28 and 29 ask for a confirmation and never refuse: a block on
either would have stopped real, working accounts.

**What the employee sees.** Above the form, *"Paid successfully N times to this account — no
problems on record"* (amber with the problem count when there were any; *"No payments to this
account on record yet"* for an unproven one; nothing when no account is on file). Below the form,
the amber notice: the account's record and what changing it means, the four rules (account
number not card number; open account; own name, never a spouse's, relative's or friend's, pay
yourself then send money on; check every digit), the responsibility sentence (*"not an HRIS or
payroll error"*), and the acknowledgement box. Rose boxes with their own checkbox appear for a
card-shaped number and for a holder who is not them.

**What Accounting sees.** The alert carries the flags and plain sentences, never values. People →
Bank changes shows a *Check account* chip on a flagged change, and **View** shows the employee's
attestation (`BankChangeDetailDialog` → `AttestationBlock`).

**This page's older card-safety notice is unchanged.** It is about phishing (never share a CVV);
the new notice is about typing the wrong number.

## Limits and expiry

| Limit | Value | Code |
| --- | --- | --- |
| POST to `/api/bank-update/*` | 10 per IP per 60 s → 429 | `proxy.ts:43-46` |
| GET to `/api/bank-update/*` | 30 per IP per 60 s → 429 | `proxy.ts:43-46` |
| Codes mailed | 3 per email per 15 min, fails closed | `otp.ts:28-29, 126-135` |
| Code life | 10 min | `otp.ts:25` |
| Wrong guesses | 5, then the code is dead | `otp.ts:27, 187-193` |
| Session life | 20 min, reusable | `otp.ts:26` |
| Lock probe | every 20 s + focus / visibility | `page.tsx:69-73` |
| n8n calls | 15 s timeout each | `otp-email.ts:86` · `notify-email.ts:111` · `bank-info-notify.ts:71` |
| Missing Bank Info run | 2,000 recipients max, batches of 10 with a 1 s wait, one bad address does not halt it | `request-bank-info/route.ts:51` · `workflow.json:23, 51, 83, 87-88` |

## Failure modes

- **No code webhook in production → 503** *"The verification email channel isn't set up yet"*
  for everyone. In dev the code is printed to the server console instead
  (`request-otp/route.ts:47-57, 81-85`).
- **A failed code email is invisible.** The route discards `sendBankUpdateOtpEmail`'s result
  (`request-otp/route.ts:80`), and the audit row still reads `found: true, throttled: false`.
  The employee waits for a code that never comes.
- **`throttled: true` does not only mean throttled.** It is `!code`, which is also true when the
  OTP insert failed or the service role was missing (`otp.ts:123-124, 146`,
  `request-otp/route.ts:94`).
- **A failed lock read lets the save through.** `getAppSetting` returns `null` on a read error
  (`app-settings.ts:26-36`), and `parseLocked(null)` is `false` (`payroll-dispatch-lock.ts:13-16`).
  So the 423 gate in rule 19 fails OPEN, although the page comment calls the server
  *"the real block"* (`page.tsx:55-56`).
- **The attestation rides the same best-effort writes as the rest of the trail** (rule 30), so a
  failed audit insert AND a failed history insert would leave a saved change with no record of
  what was attested. Making the save refuse when the trail cannot be written is item 266 #3,
  still Kane's call (Open item 401).
- **A lost audit row does not fail the save.** `insertAuditLog` returns `{ error }` and never
  throws. Its only failure signal is a `console.error` (`audit-log.ts:147-178`). The route awaits
  it and ignores the result (`save/route.ts:263-279`), despite its comment *"a payout change must
  not be reported successful without leaving a trail"*. The history row, the stamp, the alert,
  the pulse and the payroll email are all best-effort too (`save/route.ts:235-245, 282-304`,
  `:104-106`; `app-settings.ts:274-281`).
- **Two rows with one work email are both overwritten.** The update matches every row
  (`save/route.ts:198-202`). The before-snapshot reads one (`:179-186`), and the prefill shows
  one (`employee-ids.ts:94-96`, `.limit(1)`).
- **No row means a new `SELF-` row.** A person with a master row under a different email ends up
  with two ([[nobank-list-clobbered-submissions]]). If the insert races, the update is retried
  once (`save/route.ts:218-229`).
- **Leaving mid-session does not stop a save.** The save re-resolves the roster
  (`save/route.ts:166`) but uses it only for the name, and a null match still writes, falling
  back to a placeholder name. The gift link re-reads the roster and stops there
  ([gift-address-external-link.md:86-87](gift-address-external-link.md)).
- **A personal email shared by two active people** resolves to whichever row PostgREST returns
  first. `.limit(1).maybeSingle()` has no order (`otp.ts:88-94`), so the code goes to one of the
  two work inboxes. The gift doc measured two such active pairs
  ([gift-address-external-link.md:156-160](gift-address-external-link.md)).
- **An un-migrated environment** gets *"The payout columns aren't fully set up yet"* or a
  permissions message instead of a raw error (`save/route.ts:313-322`).
- **The Bank changes feed is probably on its poll.** Its Realtime binding is on an "Admins only"
  `app_settings` key an anon browser cannot receive. Not measured
  ([gift-address-external-link.md:331-339, 369-371](gift-address-external-link.md);
  [[supabase-realtime-anon-rls-dead]]). The feed polls regardless (`PeopleBankChanges.tsx:179`).

## Security notes

- **Item 221: the anon key is in this page's JavaScript, and it reads the table this page
  protects.** Measured 2026-09-25: `/update-bank-info` returns 200 with no session, and 2 of its
  ~25 JS chunks carry `NEXT_PUBLIC_SUPABASE_ANON_KEY` and the project URL. With that key,
  `employee_ids` policy `anon_read` returns all 30 columns of 2,198 rows (Sep 25 session log,
  item 221; [[anon-key-reads-bank-accounts]]). The OTP gates this flow, not the table. The page's
  own imports hold no Supabase client (`page.tsx:1-28`). The root layout mounts
  `DispatchPaidToastsGlobal` on every route (`app/layout.tsx:64`), and that imports
  `useDispatchLock` → `getSupabaseBrowserClient` (`DispatchPaidToastsGlobal.tsx:4`,
  `useDispatchLock.ts:5`). That is a likely path for the key into this page. **Which chunk
  carries it was not traced.**
- **The prefill's main read runs on the anon key, server-side.** `getPayoutPrefill` →
  `getEmployeeIdRowByEmail` → `createSupabaseServerClient` (the anon key)
  (`prefill.ts:28`, `employee-ids.ts:79-89`, `server.ts:123-128`). Item 221's reader sweep names
  this helper. **This is derived from code, not measured.** If the anon SELECT on `employee_ids`
  is dropped before the helper moves to the service role, RLS returns zero rows with no error
  ([[security-invoker-view-silent-empty]]). This page would then prefill from onboarding or
  from nothing. Because a save posts every field (rule 14), saving that form would clear any
  stored field the employee did not re-type. Add this page to item 221's load-bearing order.
- **`verify-otp` returns `reason` in its 401 body** (`verify-otp/route.ts:49`). `invalid` occurs
  only when a live code exists for an active employee's inbox (`otp.ts:180-193`), while a
  non-employee reads `expired` (`otp.ts:164`). Anyone who requests a code for an address and
  then submits a wrong one can read back whether it belongs to an active employee. The comment
  above it says the response *"can't be used for enumeration"* (`verify-otp/route.ts:43-44`).
  The page never reads `reason` (`page.tsx:123-131`). The gift link answers 400 for every failure
  shape ([gift-address-external-link.md:102-104](gift-address-external-link.md)). This was not
  tested against production.
- **Neither create script enables RLS**, yet the anon key reads nothing from either table.
  Neither `2026-06-29_bank_update_external_link.sql` nor `2026-07-01_bank_update_history.sql` has
  `ENABLE ROW LEVEL SECURITY`, and a new table in `public` gets anon and authenticated ALL by
  default ([[anon-key-reads-bank-accounts]], the lesson). **Measured 2026-09-29 ~13:40Z,
  read-only, counts only:** the anon key reads **0** of `bank_update_otps`' **1,519** rows and
  **0** of `bank_update_history`'s **1,641** rows. Both answer 200 with an empty set, not an
  error. So something outside the repo's SQL closed them, either RLS or revoked grants.
  `relrowsecurity` and the grants were not read, so which one is not established. The exposure
  is closed either way (Sep 29 log item 266).
- **A verified session receives the full stored payout record in clear**, with account numbers
  unmasked (`verify-otp/route.ts:53, 65-71`; `prefill.ts:28-55`). A code sent to a company inbox
  is the only gate on those values.
- **The pepper falls back to a constant, `"bank-update-otp"`, if `NEXTAUTH_SECRET` is unset**
  (`otp.ts:41-43`).
- **Two copies of the OTP machinery.** `src/lib/bank-update/otp.ts` predates
  `src/lib/otp/otp-core.ts` and was deliberately not migrated. Fix a bug in one and check the
  other ([gift-address-external-link.md:352-354](gift-address-external-link.md)).

## Who reads what it writes

- **People → Bank changes** feed and per-person history read `bank_update_history`
  (`bank-update-history.ts:115-158`). `audit_log` rows stay for the Admin audit view
  (`audit-log.ts:411-415`).
- **People popup:** *"Self-updated via external link on <date>"* is drawn from
  `bank_last_self_updated_at` (`PeopleTab.tsx:3358-3361`, `people-banking.ts:152-168`). The
  dashboard save stamps the same column too (`app/api/update-employee-ids/route.ts:166-171`), so
  the label is not proof the link was used.
- **Roster export "Bank Info Updated"** reads the history table, not the stamp
  ([people-roster-export.md:89-98](people-roster-export.md)).
- **Readiness activity feed** allowlists `bank_update.saved`
  ([payroll-readiness.md:911-915](payroll-readiness.md)).
- **Admin Penny** `get_bank_change_history` / `get_change_timeline` read the history table
  ([admin-penny-tools.md:49, 65](admin-penny-tools.md)).

## Deploy notes

- **PENDING (Open item 401): the `bank_update_history.safety` column.** Kane runs
  `node --import tsx scripts/apply-bank-update-history-safety-migration.mts --apply` (dry run
  verified 2026-10-07: all five checks pass, rolled back). Order is free: until it runs, the
  history row is written without the attestation and the attestation is on the audit row only.
  **The non-clearable copy is not kept until this runs.**
- **Migrations.** `2026-06-29_bank_update_external_link.sql` adds `bank_update_otps`, the
  `bank_last_self_updated_at` column and the `people.banking.self_updated` notification type.
  `2026-07-01_bank_update_history.sql` adds the history table. Neither is re-measured here. A
  2026-08-24 production read of `bank_update_history` is recorded at
  `bank-update-history.ts:165-173`.
- **Webhooks.** Resolution order is Admin → Webhooks config → legacy `app_settings` key → env var
  (`resolve-webhook.ts:10-19`).
  - `bank_update_otp` (legacy `hr.otp_webhook_url`, env `N8N_OTP_WEBHOOK_URL`) is **required in
    production**, or every request is a 503 (`otp-email.ts:17-25`).
  - `bank_update_notify` (legacy `hr.bank_update_notify_webhook_url`, env
    `N8N_BANK_UPDATE_NOTIFY_WEBHOOK_URL`) is optional and a no-op when absent
    (`notify-email.ts:17-18, 73-77`).
  - **Neither is in `KNOWN_SLUGS`** (`AdminWebhooks.tsx:80-206`, where only `bank_info_notify`
    is listed, at `:159`). Their rows do not appear on their own in Admin → Webhooks. They must be
    added by hand or set by env var ([[gift-address-external-link]]).
- **Env vars:** `BANK_UPDATE_PUBLIC_HOST` (optional, rule 11), `BANK_UPDATE_NOTIFY_EMAIL`
  (default `payroll@simple.biz`), `N8N_BANK_INFO_NOTIFY_WEBHOOK_URL`,
  `N8N_BANK_INFO_NOTIFY_SECRET` (pair with `REQUIRED_SECRET` in the n8n node,
  `bank-info-notify.ts:55-60`), and `NEXTAUTH_SECRET` (the pepper). The two `BANK_UPDATE_*`
  are not in `.env.example` ([system-architecture.md:406-407](../reference/system-architecture.md)).
- **DONE 2026-10-02: the n8n *Build Recipients* node was re-pasted** (item 207; Kane, 2026-10-02 ~21:20 EDT: *"it already existed"*, then *"udpated!"*).
  The Missing Bank Info email now carries the card warning. That rests on Kane's word, because n8n is not readable from here.
- **Not recorded in the repo: whether `bank-payout-update.vercel.app`**, the hard-coded CTA host
  in that node, **is the `BANK_UPDATE_PUBLIC_HOST` domain.** Env values are not in the tree.
- **Item 221 containment is Kane's click:** Supabase → Authentication → turn off new sign-ups
  ([[anon-key-reads-bank-accounts]]).

## Open items

- **401 — OPEN** (Sep 29 log): payout change safety shipped in code 2026-10-07. Owed: the
  `safety` column `--apply` (Kane), a push, and a signed-in browser pass of both forms. Kane's
  call: whether a save should REFUSE when its trail cannot be written (item 266 #3), now that the
  trail is the employee's attestation.
- **216** (Sep 25 log): this surface had no feature doc. It is closed by this file, its INDEX row
  and its README row (Sep 29 log item 265).
- **266 — OPEN SECURITY, Kane's call** (Sep 29 log): four findings made while writing this doc:
  the `verify-otp` `reason` enumeration, the save's lock gate failing open on a read error, the
  audit row not enforced, and a save landing after the person left mid-session. Plus the prefill
  hazard for item 221's fix order. None is fixed.
- **207** (Sep 23 log): n8n re-paste DONE 2026-10-02 on Kane's word. Page and OTP email code pushed
  (item 215), deploy unverified.
- **221** (Sep 25 log): OPEN CRITICAL, anon key reads `employee_ids`. This page adds one hazard
  to its fix order (§Security notes, second bullet).
- **182** (Sep 16 log): the alternate-work-email gap, still unchecked on this flow (rule 3).
- **202** (Sep 23 log / [bank-preferred-routing.md:316-327](bank-preferred-routing.md)): 13 rows
  break 1:1. A save here can create another one, and it is named in the alert, not refused
  (rule 18).
- **267 — OPEN** (Sep 29 log): two sources disagree on whether the 2026-07-26 no-bank-list
  restore ran. `bank-preferred-routing.md:396-397` says *"the restore has **not been run**
  (Kane's call)"*; memory `nobank-list-clobbered-submissions` says *"RESOLVED … restored
  preferred_processor … for 14 people"*. Which one is true is a database fact nobody has read.
- **No cleanup of spent codes.** `bank_update_otps` grows forever. The migration carries an
  optional purge (`2026-06-29_bank_update_external_link.sql:100-103`;
  [gift-address-external-link.md:355-356](gift-address-external-link.md)).

## Related memory

[[bank-info-notify-webhook]] (the Notify email, the card warning, the n8n re-paste) ·
[[bank-preferred-approval-gate]] (RETIRED: only Accounting sets the sending bank) ·
[[bank-preferred-field]] · [[wallet-rail-mirror-and-lock]] (the 1:1 rule, the mismatch alert) ·
[[anon-key-reads-bank-accounts]] (item 221) · [[nobank-list-clobbered-submissions]] (the page
posts all fields, history `fields` is useless, the `SELF-` rows) · [[gift-address-external-link]]
· [[gift-otp-ignores-alternate-work-email]] · [[gracea-wrong-bank-seeded]] (reading
`bank_update_history` + `audit_log` to name a channel) · [[maria-argote-split-identity]] (10+
`found:false` tries under the wrong email) · [[bank-info-temporary-exemption]] (the Readiness
list a submission here clears) · [[people-export-account-last4-and-updated]] ·
[[supabase-realtime-anon-rls-dead]] · [[security-invoker-view-silent-empty]] ·
[[pre-release-security-blockers]] (public by design; do not add a session gate) ·
[[admin-penny-ai]] (history has no actor column).

## History

`git log` over the page, routes, `src/lib/bank-update/`, the history layer, both migrations and
the Notify flow:

| Commit | Date | What |
| --- | --- | --- |
| `d1167017` | 2026-06-29 | Page, the three OTP routes, `otp.ts`, the code email, the prefill, the 06-29 migration |
| `20807bc2` | 2026-06-30 | Payroll-team email (`notify-email.ts`); revisions to every route, the page and the migration |
| `0bcd2aab` | 2026-06-30 | People → Bank changes feed and its pulse (4 lines in the save route) |
| `f63443a6` | 2026-07-01 | `bank_update_history` migration + data layer, write-time masking (`mask-field.ts`) |
| `36f0d1d7` | 2026-07-01 | `request-bank-info` route (the in-app Notify nudge) |
| `3618d82d` | 2026-07-21 | `lock-status` route and the page's lock probe |
| `561a5e23` | 2026-07-21 | The Notify email: n8n workflow + `bank-info-notify.ts` |
| `a7ecd4cf` | 2026-08-10 | Prefill carries `bank_preferred`; picker seeded from the effective rail ([bank-preferred-routing.md:480-482](bank-preferred-routing.md)) |
| `edf0aa10` | 2026-08-24 | Roster export reads the history table |
| `debac13d` · `b8b1f3fc` | 2026-08-31 | Receiving-side wallet gate added, then removed by the 1:1 rule |
| `6cabcff3` | 2026-09-24 | Sending-bank mismatch alert; the employee send-from pick retired |
| `d21a0a3b` · `87c407ff` | 2026-09-25 | Card-safety warning: page, OTP email, n8n node |
| (this commit) | 2026-10-07 | Payout change safety: track record, versioned notice + confirmations, server gate on both self-service routes, attestation trail, `safety` column (PENDING apply) |

Commit subjects before 2026-08 are uninformative ("push", "Push", "asdasdas"). The "What" for
those rows is inferred from the files each touched, not from the messages.
