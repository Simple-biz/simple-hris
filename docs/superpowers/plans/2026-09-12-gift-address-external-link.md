# External tenure-gift address link — build plan

**Approved 2026-09-12.** Kane: *"They should be able to see all the gifts they are
owed since their start dates… make a beautiful UI same from the employee
dashboard… This is a public link and a simple.biz account should be entered first
to check… there should be an n8n automation for the confirmation code."*

Answers to the brief's questions:

| Q | Answer |
| --- | --- |
| Q1 which milestones | **(b)** — every gift owed since their start date, one address covering them |
| Q2 who may use it | work email entered first, validated against the ACTIVE roster; open to active staff |
| Q3 does submitting mean gifted | **No** — assumed from the standing rule, not answered. Address only; `received` stays HR's |
| Q4 the 43 existing submissions | **Stay** — assumed. Used to prefill; not destroyed as a side effect of this build |

Scope change from the posted brief, declared: the employee dashboard card
(`GiftShippingCard.tsx`) was listed `out:`, but "same as the employee dashboard"
is only guaranteed by a shared module, so the presentational constants move to
`src/lib/gift-tracker/milestone-copy.ts`. A pure move — no behaviour change.

## Tasks

### 1 — Data
- [ ] `references/sql/migrate/2026-09-12_gift_address_external_link.sql`
      `gift_address_otps`, mirroring `bank_update_otps`: hashed code, 10-min TTL,
      5 attempts, hashed session token, 20-min session, `request_ip`.
      **No `BEGIN`/`COMMIT`** — the apply script owns the transaction.
- [ ] `scripts/apply-gift-address-migration.mts` — `--dry` default, `--apply`
      commits, negative controls prove the CHECKs bite.

### 2 — Pure logic, tested
- [ ] `src/lib/otp/otp-core.ts` + `otp-core.test.ts`
      Table-agnostic. Hash-with-pepper, constant-time compare, throttle fails
      CLOSED, enumeration-safe. `bank-update/otp.ts` predates this and is NOT
      migrated here (live money path, out of scope) — recorded as a follow-up.
- [ ] `src/lib/gift-address/owed.ts` + `owed.test.ts`
      Pure: start date + receipts + submissions → the milestones to ask about.
      Uses the SHARED `isMilestoneDue`; never a second date rule.
- [ ] `src/lib/gift-tracker/milestone-copy.ts`
      Moved from `GiftShippingCard.tsx`: `MILESTONE_MESSAGES`, `HEARTS_FLOAT`,
      `APPAREL_SIZES`, `tenureLabel`. Card re-imports them.

### 3 — Server
- [ ] `src/lib/gift-address/otp.ts` — binds the core to `gift_address_otps`
- [ ] `src/lib/gift-address/otp-email.ts` — webhook slug `gift_address_otp`
- [ ] `app/api/gift-address/request-otp/route.ts` — GENERIC response always
- [ ] `app/api/gift-address/verify-otp/route.ts`
- [ ] `app/api/gift-address/owed/route.ts` — session token only
- [ ] `app/api/gift-address/save/route.ts` — identity from the TOKEN, never the body
- [ ] `src/lib/audit/registry.ts` — family `gift_address.`

### 4 — Edge
- [ ] `proxy.ts` — `PUBLIC_PATHS` entry, `GIFT_ADDRESS_PUBLIC_HOST` isolation,
      its own rate-limit bucket (never the bank bucket)

### 5 — UI
- [ ] `app/update-gift-address/page.tsx` — email → code → owed list + address → done

### 6 — Docs, same commit
- [ ] `docs/features/gift-address-external-link.md`
- [ ] `docs/features/INDEX.md` row
- [ ] memory `gift-address-external-link` + `MEMORY.md` pointer

## Rules this build must not break

- **Identity comes from the session token.** The save route never trusts a
  client-supplied email. This is the salary-redirect hole the bank flow closed.
- **`personal_email` is the submissions key and is NOT injective.** Two ACTIVE
  pairs share one; 7 active people have none. The save route must refuse rather
  than overwrite a colleague's address.
- **Submitting is not receiving.** Nothing here writes `employee_gift_receipts`.
- **No price, ever** — tenure gifts are information-only.
- **Enumeration-safe** — one generic answer whether or not the email exists.
