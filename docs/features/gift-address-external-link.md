# Gift address external link — a public page for collecting where to send a tenure gift

A PUBLIC, no-login page at **`/update-gift-address`** where someone types their
Simple.biz work email, receives a 6-digit code in that inbox, then sees every
tenure gift they have reached since their start date and gives one delivery
address covering the ones still waiting. It exists because HRIS is not open to
the company yet and the gifts recorded as owed had no collection path at all.
Built 2026-09-12 on Kane's approval of the posted blueprint.

## Key files

| Piece | File |
| --- | --- |
| Migration | `references/sql/migrate/2026-09-12_gift_address_external_link.sql` |
| Migration runner | `scripts/apply-gift-address-migration.mts` |
| OTP core (generic, tested) | `src/lib/otp/otp-core.ts` + `otp-core.test.ts` |
| OTP bound to this table | `src/lib/gift-address/otp.ts` |
| n8n code email | `src/lib/gift-address/otp-email.ts` |
| What to show / collect for | `src/lib/gift-address/owed.ts` + `owed.test.ts` |
| Submission-key guard | `src/lib/gift-address/save.ts` |
| Routes | `app/api/gift-address/{request-otp,verify-otp,owed,save}/route.ts` |
| Edge allowlist + host isolation | `proxy.ts` |
| Page | `app/update-gift-address/page.tsx` |
| Shared copy with the dashboard | `src/lib/gift-tracker/milestone-copy.ts` |

Closest cousin, and the thing this was copied from rather than invented:
**`/update-bank-info`** (`app/update-bank-info/page.tsx`,
`app/api/bank-update/*`, `src/lib/bank-update/otp.ts`). Same OTP shape, same
generic-response discipline, same host isolation.

## Identity comes from the session token. Never from the request body.

The flow is: type an email → a code is mailed to the roster's **Work Email** for
that person → the code is exchanged for a session token → **every later step
re-derives the work email from that token**.

This is the whole security model. A body that could name its own email is the
redirect-someone-else's-parcel hole — the same shape as the salary-redirect hole
`/update-bank-info` closed in June. `/api/gift-address/owed` and `/save` take no
`email` parameter at all, by design: accepting one would let anyone holding any
valid session read a colleague's home address and gift history.

`resolveGiftAddressSession` also **re-reads the roster** rather than trusting
anything cached on the OTP row, so someone offboarded mid-session stops there.

Codes are stored as `sha256(code · email · pepper)` and session tokens as their
own hash; neither exists in the database in usable form. Compared in constant
time — `===` on a hash leaks how many leading characters matched, which turns a
6-digit search into a per-character one.

## The page must never reveal who works here

It is public and unauthenticated, and the roster is people's names and home
addresses. So `request-otp` returns **one fixed sentence** whether the address
belongs to an active employee, a leaver, or nobody — and returns it for a
throttled send too, so hitting the cap does not confirm the address is real
either. A malformed address gets the same answer **without a database hit**.

`verify-otp` reports `expired` both for a genuinely expired code and for an
email belonging to nobody, and answers **400 for every failure shape**. A 404 on
"no such person" would restore the oracle the shared message exists to close.

## The throttle fails CLOSED

Three codes per email per fifteen minutes. A count that errors or returns null is
treated as *already at the cap* — treating "we do not know" as zero would turn
any transient database fault into an uncapped mailer pointed at someone's work
inbox.

## Every gift since the start date — not just the current one

The in-app employee form asks only about the milestone whose 30-day window is
open and freezes earlier ones read-only. That is exactly why the gifts recorded
as owed had nowhere to land: the person owed a gift from two years ago could not
tell anyone where to send it. This page walks **every milestone reached**.

`buildGiftAsk` resolves each one to `received` or `pending`, and **one address is
written against every pending milestone**.

**"Pending" is not a promise.** A reached milestone that is not recorded as
received is either `owed` (someone stated it was missed) or `unknown` (nobody has
assessed it — 239 active people were absent from the source sheet entirely).
**Both are collected for and both are presented identically**, because the
distinction is about our bookkeeping and the employee cannot act on it. Telling
someone "you are owed this" when the truth is "we never checked" promises a
parcel that may already have arrived.

A person with no start date reaches nothing: the walk is empty and the page asks
for no address, rather than inventing a milestone. That is a roster problem to
fix upstream.

## Submitting an address is NOT receiving a gift

This page writes `employee_gift_shipping_details` and **nothing else**.
`employee_gift_receipts` — the ledger of what was actually given — is never
touched from a public page; HR sets that in the Gift Tracker. An employee able to
mark their own gift received would make the backlog unfalsifiable.

The audit family is `gift_address.*` and is deliberately separate from
`gift_receipt.*` for the same reason.

## The milestone list is recomputed server-side on save

The request carries an address and a token. It does **not** get to say which
milestones to write — `/save` rebuilds the list from the token. A body that could
name its own milestones could write a submission row against a colleague's gift.

An unknown apparel size is **refused**, not coerced to blank: a silently dropped
size means somebody receives the wrong shirt and never finds out why.

## Eleven people are refused on purpose

`employee_gift_shipping_details` is `UNIQUE (personal_email, milestone_index)` —
it keys on **personal** email while this flow authenticates a **work** email. On
the live roster personal email is not injective: two active pairs share one
(`corpuzmachacon@gmail.com` = johnc@/russell@, and `yong092734@gmail.com`), and
**7 active people have none at all**.

Writing anyway would let one colleague's verified session overwrite the other's
delivery address under that shared key — the parcel goes to the wrong house and
nothing in the app shows why. So `checkSubmissionKey` **refuses** those people
and the page tells them to contact HR, *before* they fill in a form that would
only be rejected on submit. It **fails closed**: a database error reports
`shared`, because "we could not check whether this key collides" must not resolve
to "go ahead and write".

Refusing ~11 of 1,300 is the correct trade against silently redirecting a parcel.
The real fix is for the submissions table to key on work email like the receipts
ledger does — a migration, recorded as open below.

## The look is shared with the employee dashboard, not copied

`src/lib/gift-tracker/milestone-copy.ts` holds the eight thank-you messages, the
floating-heart positions, the apparel sizes and `tenureLabel`. Both this page and
`GiftShippingCard.tsx` read it. Kane asked for a page that reads like the
dashboard; a second copy of eight messages drifts the first time somebody
improves one of them.

Ink is toned to its ground throughout — warm ink on a tinted fill, never neutral
zinc on pink or emerald. Same rule the My Hours tiles follow.

## Deploy notes

**Run in this order.**

1. `node --import tsx scripts/apply-gift-address-migration.mts` — rehearses and
   rolls back. Verified 2026-09-12: all objects and all 6 negative controls pass,
   and the table is absent afterwards.
2. The same with `--apply`. **PENDING — Kane runs this.**
3. **The n8n flow. PENDING — Kane builds and imports this.** A generic
   "send this email" flow accepting `{ to, subject, body, html, otp_code,
   recipient_name }`. Register it in **Admin → Webhooks** under the slug
   **`gift_address_otp`**, or set `N8N_GIFT_ADDRESS_OTP_WEBHOOK_URL`.
   **It must not reuse `bank_update_otp`** — that flow's copy says "bank-update
   code", so borrowing it would email a bank notice for a gift, and any later
   edit to the bank flow would silently change what gift recipients read. With
   nothing configured the route 503s in production and prints the code to the
   server console in dev, so the flow stays testable without n8n.
4. Deploy the code.

**The migration SQL carries no `BEGIN`/`COMMIT`.** The apply script owns the
transaction; a `COMMIT` inside the file ends it from within, so the rehearsal
commits to production and the script's own `ROLLBACK` has nothing to undo. That
happened on 2026-09-11 with the gift-receipts migration.

### Optional: a dedicated public domain

`GIFT_ADDRESS_PUBLIC_HOST` mirrors the bank flow's `BANK_UPDATE_PUBLIC_HOST`.
When a request arrives on that hostname, **only** `/update-gift-address` and
`/api/gift-address/*` exist — every other API path 404s and every other page
redirects to the form, so the HRIS (and `/login`) never surfaces on a domain
handed to the whole company.

Add the domain in Vercel → Settings → Domains, assign it to Production, add the
DNS record it shows, then set `GIFT_ADDRESS_PUBLIC_HOST` to that exact hostname
(lowercase, no scheme, no trailing slash) as a **Production** env var and
redeploy — env vars are baked at build time.

**Inert until the env var is set**, and only fires when the host matches, so the
normal HRIS domain is unaffected. The domain is cosmetic isolation, not security:
the OTP and the host filter are the protection, and both work on the default
domain too.

## What is still open

- **The submissions table keys on `personal_email`.** Until it keys on work
  email like the receipts ledger, ~11 active people cannot use this page at all.
- **Two copies of the OTP machinery.** `src/lib/bank-update/otp.ts` predates
  `src/lib/otp/otp-core.ts` and was deliberately not migrated in this change — it
  is a live money path. Fix a bug in one and check the other until they converge.
- **No cleanup of spent codes.** `gift_address_otps` grows forever; the bank
  table has the same gap. Harmless but unbounded.
- **The page cannot help a leaver.** `findActiveEmployeeByEmail` is
  `active_employees`-only, so the 16 owed gifts sitting on offboarded people
  still have no collection path.

Siblings: [gift-tracker-receipts.md](gift-tracker-receipts.md) — the ledger this
reads · [gift-tracker-shipping-export.md](gift-tracker-shipping-export.md) — the
file the addresses come out in.
