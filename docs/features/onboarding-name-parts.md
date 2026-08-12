# Onboarding Name Parts — what composes into the name, and what deliberately doesn't

> **Status:** Built and live, except the `middle_name` column.
> **Migration NOT APPLIED** — measured against production 2026-08-12 (both
> `hr_onboarding_submissions.middle_name` and `hr_pending_employees.middle_name`
> returned *"column … does not exist"*). This is a measurement, not a claim; if
> you read this later, re-measure before repeating it
> (`node scripts/apply-middle-name-columns.mjs --verify`).

The onboarding paperwork's Welcome step captures a hire's legal name in **four**
boxes. Three of them compose into the combined name the rest of the company runs
on. The fourth — the middle name — deliberately does not. This doc exists because
that asymmetry is the thing most likely to be "fixed" by mistake.

---

## The four boxes

| Box | Column | Required | In the composed name? |
|---|---|---|---|
| First name | `first_name` | yes | **yes** |
| Middle name | `middle_name` | no | **NO — see below** |
| Last name | `last_name` (whole surname, "Dela Cruz") | yes | **yes** |
| Extension | `name_extension` (Jr./Sr./II/III/IV) | no | **yes** |

They live on `hr_onboarding_submissions` and are carried onto
`hr_pending_employees` at stage-on-submit and at set-work-email. The parts are
the **source of truth** — nothing re-parses the blob (see
[[onboarding-name-split]]).

---

## Why the middle name stays out of `full_name`

`composeFullName(first, last, extension)`
([src/lib/hr/work-email.ts](../../src/lib/hr/work-email.ts)) builds
`hr_onboarding_submissions.full_name` / `hr_pending_employees.name` on every
write. That string is **not** a display convenience — it is the value that
becomes:

- the master-list Google Sheet **"Name"** column on promote,
- the key for **payroll name-matching** (`nameTokens` / `normalizeNameTokens`),
- the input to the surname-first **display trigger**
  (`public.name_last_first_quoted`, ported in
  [src/lib/name/display-name.ts](../../src/lib/name/display-name.ts)).

The display rule takes the **last given token that isn't a bare initial** as the
quoted go-by name. So folding a middle name into the composed string changes what
the person is *called* everywhere:

| Composed name | Display name | Go-by |
|---|---|---|
| `Jane Santos` (today) | `Santos, Jane "Jane"` | Jane ✅ |
| `Jane Marie Santos` (if middle were folded in) | `Santos, Jane Marie "Marie"` | **Marie** ❌ |

And the Payroll Wizard prints exactly that master quoted name at a single fix
point — `calcResults`' `name:` field — so every wizard screen, dispatch row,
paystub preview and modal would follow it (see
[[payroll-wizard-master-quoted-name]]).

**Rule:** `middle_name` is captured, stored, and shown to HR. It is never passed
to `composeFullName`, never written into `full_name` / `name`, and never reaches
any derivation. If a future request wants the middle name inside the legal name,
that is a **deliberate rename of every affected employee**, not a bug fix — it
needs the go-by rule solved first.

## What the middle name never touches

`derivationNameParts()` reads `first_name` + `last_name` only, reducing each to
the same first-token / last-token `splitFullName` yields. Every identity artifact
hangs off that, and none of them see a middle name:

- the `@simple.biz` **work email** (`<first><progressive last slice>`),
- the **Gmail Surname** sent to the workspace webhook in place of the legal
  surname ([onboarding-gmail-surname.md](./onboarding-gmail-surname.md)),
- the Lead Gen **CallTools username**
  ([onboarding-calltools-username.md](./onboarding-calltools-username.md)),
- the **Nickname** field, which mirrors the first name (and its multi-first-name
  arrows, which step through `first_name` tokens only).

The Extension is a third case again: it **is** folded into `full_name`, but is
never sent to the workspace-account webhook.

---

## The name-order check (Welcome step)

Leaving the Welcome step opens a one-time `alertdialog` — *"Hold on — check your
name"* — that lists back exactly what the hire typed in each box and asks them to
confirm the first and last names aren't swapped. A swapped pair is the most
common mistake on this form and the most expensive to undo: it is already baked
into the work email, the Gmail Surname, the signed contracts and the master list
by the time anyone notices.

Behaviour (all in
[app/onboarding/[token]/page.tsx](../../app/onboarding/[token]/page.tsx)):

- Fires from `goNext()` when `step === WELCOME_STEP` — an index **derived from
  `STEP_TITLES`**, so re-ordering the wizard can't point it at the wrong step.
- **Never blocks.** `nameCheckAcknowledged` is set the moment the dialog opens,
  so it can interrupt at most once per session however it is dismissed —
  *Let me check again*, *They're correct — continue*, Escape, or the backdrop.
  *…continue* closes and advances in the same click.
- Sits **after** step validation but **outside** the `if (!isPreview)` guard, so
  it also fires on `/onboarding/preview` (which skips validation entirely) and HR
  can see it.
- It is **not** content-based — it does not try to guess whether the names look
  swapped. It's a prompt to look, not an accusation, and there is no heuristic
  that could be wrong about a real person's name.

---

## Migration

`references/sql/alter/add_middle_name_to_onboarding.sql` — idempotent,
transactional, adds one nullable `middle_name TEXT` to **both** tables.

```
node scripts/apply-middle-name-columns.mjs          # apply + verify
node scripts/apply-middle-name-columns.mjs --verify # verify only
```

Needs `DATABASE_URL` in `.env.local` (the direct Supabase Postgres URI, port
5432 — not the pooler). **It is not currently set** in this checkout; add it
before running.

**There is no backfill.** A middle name was never captured and cannot be
recovered from `full_name` — existing rows stay `NULL` until the hire re-opens
their paperwork.

Until the migration runs the feature **degrades rather than breaking**: both
writers strip a `middle_name` the database rejects and retry, so a hire's
paperwork always lands and only the one column drops
(`OPTIONAL_COLUMN_FAMILIES`). `middle_name` is its own family in both files —
folding it into the split-name family would make a database that has
first/last/extension but not middle throw all four away. On the pending table
the update path now runs the **same bounded strip-and-retry loop** as the insert
(it was a one-shot retry that could only ever survive one missing family).

---

## Files

| Path | Role |
|---|---|
| [`app/onboarding/[token]/page.tsx`](../../app/onboarding/[token]/page.tsx) | Middle-name field; `NameOrderCheckDialog`; the `goNext` gate |
| [`app/api/onboarding/[token]/route.ts`](../../app/api/onboarding/[token]/route.ts) | Composes `full_name` **without** the middle name; returns it in `priorData`; carries it to stage-on-submit |
| [`src/lib/supabase/hr-onboarding-submissions.ts`](../../src/lib/supabase/hr-onboarding-submissions.ts) | Row + input types, the write, the `middle_name` degradation family |
| [`src/lib/supabase/hr-pending-employees.ts`](../../src/lib/supabase/hr-pending-employees.ts) | Row + input types; shared `OPTIONAL_COLUMN_FAMILIES` used by insert AND update |
| [`app/api/hr/onboarding-submissions/[id]/set-work-email/route.ts`](../../app/api/hr/onboarding-submissions/[id]/set-work-email/route.ts) | Carries `middle_name` onto the pending hire (create + update) |
| [`src/components/hr/HrOnboardingForm.tsx`](../../src/components/hr/HrOnboardingForm.tsx) | Detail modal "Middle name" row — the only place it surfaces |
| [`src/lib/hr/work-email.ts`](../../src/lib/hr/work-email.ts) | `composeFullName` / `derivationNameParts` — neither takes a middle name |
| [`src/lib/name/display-name.ts`](../../src/lib/name/display-name.ts) | The go-by rule this whole carve-out exists to protect |
| [`references/sql/alter/add_middle_name_to_onboarding.sql`](../../references/sql/alter/add_middle_name_to_onboarding.sql) | Migration — **NOT APPLIED** as of 2026-08-12 |
| [`scripts/apply-middle-name-columns.mjs`](../../scripts/apply-middle-name-columns.mjs) | Apply + verify runner (`--verify` is read-only) |

## Related

- [onboarding-gmail-surname.md](./onboarding-gmail-surname.md) — the surname slice sent to Workspace
- [onboarding-calltools-username.md](./onboarding-calltools-username.md) — the Lead Gen dialer name
- [identity-resolution.md](./identity-resolution.md) — how a person is matched across sources
