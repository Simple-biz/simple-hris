# Hardening Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a `hardening` project skill that reads the governing docs before any non-trivial code edit, hard-stops on contradictions with a precise either/or, and — when harden-words are used — forbids fixing anything by loosening it.

**Architecture:** Three prose artifacts, no runtime code. `docs/features/INDEX.md` turns doc discovery from a 44-file guess into a 15-row lookup. `.claude/skills/hardening/SKILL.md` holds the procedure and consumes that index at step 1. Root `CLAUDE.md` carries the trigger line so the skill cannot be forgotten, plus the repo rules that currently live only in memory.

**Tech Stack:** Markdown with YAML frontmatter. Claude Code project-skill loader (`.claude/skills/<name>/SKILL.md`). No dependencies, no build step.

**Spec:** `docs/superpowers/specs/2026-08-10-hardening-design.md`

## Global Constraints

- **Build order is fixed:** INDEX.md (Task 1) → SKILL.md (Task 2) → CLAUDE.md (Task 3) → validation (Task 4). SKILL.md step 1 dereferences INDEX.md; writing the skill first produces a dangling reference.
- **No committed scripts, no CI check, no hooks, no report artifacts** (spec §10). Verification uses throwaway shell one-liners run from the terminal, never a committed file.
- **Skill name is exactly `hardening`.** Directory `.claude/skills/hardening/`, frontmatter `name: hardening`.
- **Name collision:** the installed `impeccable` skill's description already contains the word *harden* and its `argument-hint` lists `harden`. The `hardening` description MUST end with an explicit disambiguation sentence so "harden the dashboard UI" still routes to impeccable. Exact required sentence: `Correctness and invariants only — for visual or frontend polish use the impeccable skill.`
- **Memory directory path** (absolute, used in every verification command):
  `c:/Users/Kane/.claude/projects/c--Users-Kane-Desktop-simple-hris/memory`
- **Memory slugs are written as `[[wikilinks]]`** in INDEX.md, matching the existing memory-file convention, so a single grep can verify every slug resolves to a real file.
- **Git:** commit directly to `main`. **Never push.** Stage files by explicit path — never `git add -A` or `git add .`, because multiple sessions share this checkout. Re-run `git status` immediately before each commit.
- Commit message trailer for every commit in this plan:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`

---

## File Structure

| File | Responsibility |
|---|---|
| `docs/features/INDEX.md` | Surface → doc paths → memory slugs → key invariant. The lookup that makes step 1 deterministic. Created in Task 1. |
| `.claude/skills/hardening/SKILL.md` | The procedure: locate, read, cite, classify, brief, hard-stop. Plus the never-loosen table. Created in Task 2. |
| `CLAUDE.md` (repo root) | Always-loaded trigger line + git/data/build rules currently only in memory. Created in Task 3. |

No existing files are modified. No source code changes.

---

## Task 1: Surface → doc index

**Files:**
- Create: `docs/features/INDEX.md`
- Test: none committed — verification is two shell one-liners (Global Constraints)

**Interfaces:**
- Consumes: nothing.
- Produces: `docs/features/INDEX.md` with a table whose columns are exactly `Surface | Docs | Memory | Key invariant`. Task 2's SKILL.md step 1 reads this file by that exact path and relies on those exact column names.

- [ ] **Step 1: Write the failing coverage check**

Run this first, before creating anything. It asserts every `.md` in `docs/features/` is named somewhere inside `INDEX.md`.

```bash
cd "c:/Users/Kane/Desktop/simple-hris" && for f in docs/features/*.md; do b=$(basename "$f"); [ "$b" = "INDEX.md" ] && continue; grep -q "$b" docs/features/INDEX.md 2>/dev/null || echo "MISSING: $b"; done; echo "coverage check done"
```

- [ ] **Step 2: Run it to confirm it fails**

Expected: 44 `MISSING:` lines (every feature doc), because `INDEX.md` does not exist yet, followed by `coverage check done`.

- [ ] **Step 3: Create `docs/features/INDEX.md`**

Write this file exactly. Every doc path and every `[[slug]]` below was read from disk on 2026-08-10 — do not invent additional rows or slugs.

````markdown
# Feature doc index

Surface → governing docs → memory entries → the rule most likely to be violated.

Used by the `hardening` skill as step 1. **Look up here before editing code.**
A surface with no row means no governing doc — say so out loud rather than assuming none exists.

**Maintenance:** a new doc in `docs/features/` means a new row, same commit.
A memory entry that corrects a doc means the `Key invariant` cell gets corrected too.

| Surface | Docs | Memory | Key invariant |
|---|---|---|---|
| Payment dispatch & bank routing | `payment-dispatch.md` · `bank-preferred-routing.md` · `cop-country-payees.md` | [[bank-preferred-is-routing-do-not-seed]] · [[bank-preferred-field]] · [[bank-preferred-approval-gate]] · [[wires-lock-shipped]] · [[small-wires-wise-reroute]] · [[hurupay-no-email-wires-flip]] · [[mark-paid-bank-override]] · [[people-tab-bank-drift-audit]] · [[cop-country-payees-dispatch]] · [[contractor-invoice-payment-toggle]] · [[ph-freelancers-wise-seed]] · [[wise-employee-pickers-unretired]] · [[hsl-npd-bank-list-seed]] · [[nobank-list-clobbered-submissions]] · [[bank-info-notify-webhook]] · [[bank-info-temporary-exemption]] · [[gracea-wrong-bank-seeded]] | **"Bank Preferred" is the SEND-FROM rail** (which processor Accounting pays out on) — a different thing from the employee's RECEIVING account. Never seed one from the other. `wires`/null never auto-flip to hurupay/higlobe. |
| Payroll Wizard | `payroll-wizard-final-pay.md` · `payroll-wizard-configuration-tab.md` · `payroll-wizard-notes.md` · `payroll-readiness.md` | [[payroll-wizard-master-quoted-name]] · [[payroll-wizard-tab-persist]] · [[wizard-setup-readiness-checklist]] · [[wizard-every-dept-visible]] · [[wizard-rate-snapshots-toggle]] · [[per-cycle-fx-zero-placeholder]] · [[payroll-readiness-tab]] · [[payroll-notes-adjustment-column]] · [[notes-adjustment-bridge-loss]] · [[payroll-notes-fab-readiness-ring]] · [[payroll-notes-offboarded-tab-shipped]] · [[payroll-wizard-configuration-tab]] | Display names come from the master **quoted nickname**, set at exactly one point (`calcResults` `name:`). A per-cycle FX of 0 hard-gates Step 8 and makes publish a no-op. |
| Paystubs | `paystub-dispatch.md` | [[paystub-staged-snapshot-stale]] · [[prorated-paystub-design-approved]] · [[paystub-weekend-hours-hsl]] · [[employee-paystub-modal-and-paid-notification]] · [[paystub-export-week-dedupe-and-startdate]] · [[paystub-email-rendered-in-app]] · [[never-paid-and-misdelivered-paystubs]] · [[payroll-available-notification]] · [[payment-cycle-complete-celebration]] | `paystub-fresh.ts` merges the snapshot **over** staged data; marking paid freezes it. The weekend block is a display **carve-out** — totals do not change. |
| HSL rates & KPI | `hsl-kpi-calculator-2026-07.md` | [[hsl-rate-history-stale-underpay]] · [[hsl-weekend-premium-in-ot-column]] · [[weekend-rate-off-headline-disclosure]] · [[weekend-ot-merge-assessment]] · [[hsl-subdept-restructure]] · [[hsl-collections-tl-simple-texting-removed]] · [[hsl-kpi-calculator-2026-07-changes]] | Two separate rules — **do not merge them**. **Weekend HOURS pay = `regular + 15`**: intentional. A weekend rate that isn't `reg + 15` is a **dated rate change**, not a math error (981 staged lines audited, 0 money errors) — check `proration.effective_date` against which day the hours fell on before hunting a premium bug. **OT rate = `regular × 1.5`**: `regular + 15` in the *OT-rate column* was a real bug that underpaid ~10 HSL people, fixed 2026-08-04 — if it recurs, correct it. `employee_rate_history` outranks `employee_hourly_rates`. |
| Rates & Payment Catalog | `bonus-catalog.md` · `payment-catalog-departments.md` · `bonus-calculator.md` | [[rate-catalog-source-of-truth]] · [[payment-catalog-overview-redesign]] · [[payment-catalog-search-tab]] · [[payment-catalog-department-tab]] · [[system-bonus-dept-resolver-split]] · [[system-bonus-paid-tab-snapshot]] · [[custom-system-bonuses-currency-variants]] · [[no-pay-rate-dept-fallback-order-bug]] · [[offboarded-bonus-scoring]] · [[kpi-bonus-shared-personal-email]] · [[bonus-overrides-email-key-casing]] · [[ssd-medical-records-rfc-pool]] · [[medical-records-rfc-manual]] | The Payment Catalog is the **rate source of truth**; any comp display must mirror engine precedence exactly, alias emails included. |
| Offboarding | `offboarding-automation.md` | [[offboard-delete-only-routing]] · [[temporary-pause-offboard-reason]] · [[manager-suspend-button]] · [[offboard-final-pay-grace]] · [[scheduled-deletion-cron-never-ran]] · [[rehire-invisible-offboard-reuse]] · [[clearoffboarded-reactivation-collision]] · [[final-pay-roster-overlay]] · [[readiness-bank-offboard-aging]] · [[offboarding-docs-and-code-map]] | **Every** offboard fires `offboarding_delete`. `offboarding_deactivate` is the suspend/temporary pathway **only**. The 14-day deferral is retired — never restamp `scheduled_deletion_at`. |
| MESA | `mesa.md` · `accounting-mesa-export.md` | [[mesa-notes-and-roster-bridge]] · [[mesa-flag-vs-ledger-rejoin-gap]] · [[mesa-accounts-per-stint]] · [[mesa-optin-requests-derived]] · [[mesa-optout-deduction-and-sheet-clobber]] · [[mesa-deduction-nonmembers-ledger-gap]] · [[mesa-optout-effective-date]] · [[mesa-disbursement-receipts]] · [[mesa-week-delete-cascade]] · [[mesa-off-gml-indicator]] | An opted-out member is **never** charged. Weekly 100 + 300 deposits are idempotent. Opt-out state must be read from the **ledger**, not the flag alone. |
| Roster, master list & identity | `identity-resolution.md` · `csv-imports.md` · `hr-global-master-list-export.md` · `sales-dept-split.md` · `department-transfers.md` | [[master-list-sync-race]] · [[sheet-readd-dept-clobber]] · [[transfer-apply-reconcile-by-target]] · [[sales-dept-split]] · [[referrer-email-matching]] · [[onboarding-name-split]] · [[people-profile-name-parts-editor]] · [[roster-bulk-check-rls-gap]] · [[postgrest-1000-cap-sweep]] · [[sheet-import-tables-quoted-columns]] · [[monday-hris-board-sync]] · [[dead-tables-drop-candidates]] | **PostgREST truncates at 1000 rows even with `.range()`** — always page via `selectAllPaged`. Transfers reconcile by **target** department, not source. |
| Onboarding & documents | `onboarding-calltools-username.md` · `onboarding-gmail-surname.md` · `onboarding-ip-assignment.md` · `onboarding-pay-plans.md` · `new-hire-checklist.md` · `workspace-account-verify.md` · `documents-tab.md` | [[onboarding-contracts-download-tab]] · [[coe-generated-not-uploaded]] · [[documents-tab-signing-flow]] · [[orientation-email-invalid-to-incident]] · [[gift-feature-info-only]] | The COE is **generated, never uploaded** — the signature lives in the document body. Structured name columns are the source of truth for the composed master `Name`. |
| PAB, orphanage & time | `orphanage-dispute-flow.md` · `orphanage-pab-coverage.md` · `third-party-vendors.md` · `time-adjustment-requests.md` | [[pab-payout-week-gate-and-pill]] · [[pab-calendar-parity]] · [[orphanage-pab-auto-coverage]] · [[employee-pab-dispute-removed]] · [[time-adjustments-segments-migration]] | PAB forgiveness = disputes **⊕ time adjustments**, keyed by Hubstaff email. PAB pays only the week containing the period end. Adjustment segments cover **missed** time only. |
| Hubstaff ingest | `hubstaff-weekly-auto-sync.md` · `csv-imports.md` | [[hubstaff-double-ingest-duplicate-batch]] · [[hubstaff-ingest-blocklist]] · [[hubstaff-weekly-auto-sync]] · [[vano-hubstaff-api-case]] | A double ingest must collapse to the **preferred batch** — readers dedupe, they do not sum. |
| Access control & audit | `rbac-feature-permissions.md` · `route-authorization.md` · `delete-authorization.md` · `admin-api-keys.md` | [[subagents-write-to-live-db]] · [[security-invoker-view-silent-empty]] · [[penny-audit-log-visibility]] · [[admin-penny-ai]] | A `security_invoker` view returns a **silent empty set** when any table its filter sub-selects is RLS-blocked. Check every table the filter touches, not just the outer one. |
| Accounting surfaces | `accounting-total-payout.md` · `accounting-cobrowse.md` · `urgent-payments.md` · `tickets-board.md` · `system-diagnostics.md` · `manager-my-team.md` · `ceo-assistant.md` · `login-carla-song.md` | [[accounting-transfers-kpi-search-export]] · [[overview-total-payout-salary-only]] · [[cobrowse-observe-two-bugs]] · [[tickets-board-deploy-steps]] · [[people-pay-oneoff-urgent]] · [[contractor-invoices-hidden-by-period-filter]] · [[pay-cycle-reports-tab]] · [[carla-signin-song]] · [[pd-focus-mode-retract-fallback]] | Payment Dispatch is **hard-scoped to the cycle window** by deliberate decision — contractor rows open the invoice instead. Publish gates must also read `payment_dispatches`. |
| UI, theming & build | `docs/design/ui-standards.md` · `docs/design/responsive-design.md` · `docs/design/orphanage-dashboard-standards.md` | [[collab-chrome-stacking-and-mirror-css]] · [[dashboard-switch-performance]] · [[nextjs-build-vs-dev-shared-dir]] · [[next-themes-script-warning-patch]] | `next build` and a running `next dev` share `.next/` — check for a live dev server before building. Portaled surfaces need their theme class applied explicitly. |
| Git & session process | *(no doc — memory only)* | [[do-not-push-user-handles-git]] · [[multi-session-shared-checkout]] · [[worktree-baseref-origin-lag]] · [[subagents-write-to-live-db]] | Commit direct to `main`, **never push**. Stage specific files only — another session shares this checkout. `.env.local` is **production** service-role. |
````

- [ ] **Step 4: Re-run the coverage check to verify it passes**

```bash
cd "c:/Users/Kane/Desktop/simple-hris" && for f in docs/features/*.md; do b=$(basename "$f"); [ "$b" = "INDEX.md" ] && continue; grep -q "$b" docs/features/INDEX.md 2>/dev/null || echo "MISSING: $b"; done; echo "coverage check done"
```

Expected: `coverage check done` and **nothing else**. Any `MISSING:` line means that doc needs adding to the most appropriate existing row — add it to a row, do not create a new one-doc row.

- [ ] **Step 5: Verify every memory slug resolves to a real file**

```bash
cd "c:/Users/Kane/Desktop/simple-hris" && MEM="c:/Users/Kane/.claude/projects/c--Users-Kane-Desktop-simple-hris/memory" && grep -oE '\[\[[a-z0-9-]+\]\]' docs/features/INDEX.md | tr -d '[]' | sort -u | while read s; do [ -f "$MEM/$s.md" ] || echo "NO SUCH MEMORY: $s"; done; echo "slug check done"
```

Expected: `slug check done` and nothing else. A `NO SUCH MEMORY:` line means the slug was mistyped — fix the spelling in `INDEX.md`; do not create a memory file to satisfy the check.

- [ ] **Step 6: Commit**

```bash
cd "c:/Users/Kane/Desktop/simple-hris" && git status --short && git add docs/features/INDEX.md && git commit -m "$(cat <<'EOF'
docs(index): map every feature surface to its docs, memory, and invariant

Fifteen rows covering all 44 feature docs plus the design standards, each
carrying the memory slugs that govern it and the one rule most likely to be
violated. Turns "find the governing doc" from a guess across 44 filenames
into a lookup, which is what the hardening skill needs at step 1.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: The `hardening` skill

**Files:**
- Create: `.claude/skills/hardening/SKILL.md`
- Test: none committed — verification is frontmatter parse + section presence one-liners

**Interfaces:**
- Consumes: `docs/features/INDEX.md` from Task 1, by exact path, relying on its `Surface | Docs | Memory | Key invariant` columns.
- Produces: a skill invocable as `hardening` (and as `/hardening` because `user-invocable: true`). Task 3's `CLAUDE.md` references it by that exact name.

- [ ] **Step 1: Write the failing structure check**

```bash
cd "c:/Users/Kane/Desktop/simple-hris" && F=.claude/skills/hardening/SKILL.md && for s in "name: hardening" "impeccable skill" "## Procedure" "## The brief" "## Never loosen" "## Conflict questions" "## Stale docs" "## Edge cases"; do grep -qF "$s" "$F" 2>/dev/null || echo "MISSING SECTION: $s"; done; echo "structure check done"
```

- [ ] **Step 2: Run it to confirm it fails**

Expected: eight `MISSING SECTION:` lines, then `structure check done`.

- [ ] **Step 3: Create `.claude/skills/hardening/SKILL.md`**

Write this file exactly.

````markdown
---
name: hardening
description: Use before editing code on any surface that has a governing doc — payroll, wizard, dispatch, paystubs, MESA, HSL rates, offboarding, bank routing, onboarding, PAB, catalog, roster. Reads the governing docs and memory FIRST, cites the rules it found, and hard-stops with a precise either/or when the request contradicts what is documented. When the user says harden, tighten, lock down, close the gaps, plug the holes, shore up, bulletproof, prevent regressions, or make sure X cannot happen again, it additionally enumerates the failure classes being closed and forbids fixing anything by loosening a type, guard, validation, limit, or test. Correctness and invariants only — for visual or frontend polish use the impeccable skill.
user-invocable: true
argument-hint: "[target — file, feature, or surface]"
---

# Hardening

Two duties. They trigger separately and stack.

| Duty | Fires on | Obligation |
|---|---|---|
| **Doc-check** | any non-trivial code edit | read the governing docs before touching anything; stop on contradictions |
| **Tightening** | harden-words only | enumerate failure classes, prove each closed, never loosen |

Harden-words: *harden · tighten · lock down · close the gaps · close the holes · plug the holes · shore up · bulletproof · make it robust · make it safe · make sure X can't happen again · prevent regressions · guard against · stop this from recurring · make it airtight.*

## Procedure

**1 — Locate.** Open `docs/features/INDEX.md` and find the row matching the target.
No matching row → grep `docs/` and the memory directory for the surface name.
Still nothing → say `READ none — no governing doc for <surface>` out loud and continue.
**Never skip silently.** A missing doc is a fact to report, not permission to guess.

**2 — Read.** Open every doc and memory file the row lists. In full. Not skim, not grep for a keyword.

**3 — Extract.** List each rule that constrains this change, each with a `file:line` citation.
**No citation = not a rule.** This cuts invented constraints as hard as it cuts skipped ones.

**4 — Classify.** Every rule against the request: `consistent` / `contradicts` / `unaddressed`.

**5 — Brief.** Post it. Always, even when clean.
- Zero contradictions → post the brief and proceed. No confirmation round-trip.
- One or more → **hard stop.** One precise question each.

## The brief

```
READ   docs/features/payment-dispatch.md · memory/bank-preferred-is-routing-do-not-seed.md
RULE   "Bank Preferred" = SEND-FROM rail (payment-dispatch.md:112); never seeded from the receiving acct
SCOPE  in: dispatch picker precedence · out: People profile editor, rates sheet
GAPS   doc is silent on COP-country payees
```

Then either `No contradictions — proceeding.` or a CONFLICT block.

When the tightening duty is active, add one line:

```
CLASSES  1. null bank on an active payee  2. dept transfer mid-cycle  3. duplicate dispatch row
```

`SCOPE` is a contract. What is listed under `out:` does not get touched. If the work turns out to require an `out:` surface, that is a scope change — say so and re-post the brief.

## Never loosen

Hardening tightens. A change that relaxes anything is not hardening, whatever it is labelled.

| Banned as a "fix" | What belongs there instead |
|---|---|
| widen a type · `any` · `as` · `@ts-ignore` | narrow the type; make illegal states unrepresentable |
| remove or relax a validation or guard | add the missing guard at the boundary |
| `try/catch` that swallows · `?? fallback` masking a null | fail loud at the source |
| make a required field optional | keep it required; fix the producer |
| broaden a filter so the bad row disappears | fix why the bad row exists |
| raise a limit or timeout to dodge the error | fix what is slow or unbounded |
| delete or skip the failing test or assertion | fix the code the test caught |
| loosen `===` to `==` · relax a lint rule | keep strictness; fix the value |

**If the only way to satisfy the request is to loosen something → hard stop.** Ask, using the conflict format below. Never relax silently, and never relax "just temporarily."

Proof obligation: each enumerated failure class needs a test, a type, a DB constraint, or a cited invariant. An assertion that a class is closed, with nothing behind it, does not close it. Check adjacent surfaces for regressions before calling it done.

## Conflict questions

- Quote the doc line **verbatim** and the instruction **verbatim**, side by side.
- Offer exactly two named resolutions, each stating what it concretely produces:
  - **(a) doc stands** → here is what I do instead.
  - **(b) doc is stale** → I make the change *and* correct the doc + memory in the same commit.
- **Banned:** "should I proceed?" · "want me to look into it?" · "which do you prefer?" with no stated outcomes · any self-invented compromise between (a) and (b).
- One question per contradiction. Never bundled.

Shape:

```
CONFLICT
  doc  payment-dispatch.md:112 — "Bank Preferred is the send-from rail; never seeded from the receiving account"
  you  "seed bank_preferred from their account number"

  (a) doc stands  → I leave bank_preferred alone and fix the dispatch picker precedence instead
  (b) doc is stale → I seed it as asked AND rewrite payment-dispatch.md:112 + the memory entry in this commit
```

## Stale docs

Choosing **(b)** makes the doc edit and the memory edit part of the same commit as the code.

**No commit ships carrying a doc the brief already flagged as stale.** This is what stops the same contradiction resurfacing in three weeks.

A new doc, or a doc whose invariant changed, also means updating its row in `docs/features/INDEX.md` — same commit.

## Edge cases

**No governing doc.** Report it, proceed, and offer to write the doc afterward. There is no spec to violate, and that itself is worth saying.

**Docs contradict each other.** Common here — `OPEN:` memory items versus `docs/features/`. This is a contradiction like any other: hard stop, same format, with the two docs quoted instead of doc-versus-instruction. Precedence is never auto-resolved silently. Default proposal is newest-wins, but it is always surfaced, never assumed.

**"Skip the check."** Skipped. No argument, no re-litigation, no reminder next turn.

**Not this skill.** Visual, layout, typography, motion, and general frontend polish belong to the `impeccable` skill even when the word *harden* is used. This skill is correctness and invariants.
````

- [ ] **Step 4: Re-run the structure check to verify it passes**

```bash
cd "c:/Users/Kane/Desktop/simple-hris" && F=.claude/skills/hardening/SKILL.md && for s in "name: hardening" "impeccable skill" "## Procedure" "## The brief" "## Never loosen" "## Conflict questions" "## Stale docs" "## Edge cases"; do grep -qF "$s" "$F" 2>/dev/null || echo "MISSING SECTION: $s"; done; echo "structure check done"
```

Expected: `structure check done` and nothing else.

- [ ] **Step 5: Verify the frontmatter block is well-formed**

```bash
cd "c:/Users/Kane/Desktop/simple-hris" && head -1 .claude/skills/hardening/SKILL.md && sed -n '2,6p' .claude/skills/hardening/SKILL.md | cut -c1-40 && awk 'NR>1 && /^---$/{print "closing --- at line " NR; exit}' .claude/skills/hardening/SKILL.md
```

Expected: line 1 is `---`; the following lines show `name:`, `description:`, `user-invocable:`, `argument-hint:`; and a closing `---` is reported. If no closing `---` prints, the frontmatter is unterminated and the skill will not load.

- [ ] **Step 6: Verify the index reference resolves**

```bash
cd "c:/Users/Kane/Desktop/simple-hris" && grep -o 'docs/features/INDEX.md' .claude/skills/hardening/SKILL.md | head -1 && test -f docs/features/INDEX.md && echo "index target exists"
```

Expected: `docs/features/INDEX.md` then `index target exists`. If the second line is absent, Task 1 was not completed — stop and finish it first.

- [ ] **Step 7: Commit**

```bash
cd "c:/Users/Kane/Desktop/simple-hris" && git status --short && git add .claude/skills/hardening/SKILL.md && git commit -m "$(cat <<'EOF'
feat(skill): add hardening — read the docs first, then tighten

Doc-check runs on any non-trivial edit: look the surface up in the feature
index, read the governing docs in full, cite each rule with file:line, and
hard-stop on contradictions with the doc's words and the instruction's words
quoted side by side against exactly two named outcomes.

Harden-words additionally switch on the tightening rules: enumerate the
failure classes, prove each closed, and never widen a type, swallow an error,
optional a required field, raise a limit, or delete a test to make a failure
go away. Choosing "the doc is stale" ships the doc correction in the same
commit as the code.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Root `CLAUDE.md`

**Files:**
- Create: `CLAUDE.md` (repo root)
- Test: none committed — verification is a section-presence one-liner

**Interfaces:**
- Consumes: the skill name `hardening` from Task 2 and the path `docs/features/INDEX.md` from Task 1.
- Produces: always-loaded project instructions. Nothing consumes this — it is the last artifact.

- [ ] **Step 1: Write the failing check**

```bash
cd "c:/Users/Kane/Desktop/simple-hris" && for s in "hardening" "NEVER push" "docs/features/INDEX.md" "selectAllPaged" "never loosen"; do grep -qiF "$s" CLAUDE.md 2>/dev/null || echo "MISSING: $s"; done; echo "claude.md check done"
```

- [ ] **Step 2: Run it to confirm it fails**

Expected: five `MISSING:` lines, then `claude.md check done`.

- [ ] **Step 3: Create `CLAUDE.md`**

Write this file exactly. Keep it short — everything here is loaded into every session.

````markdown
# Simple HRIS — project rules

## Before changing code

Any non-trivial edit: use the **`hardening`** skill first. It resolves the surface via
`docs/features/INDEX.md`, reads the governing docs and memory, cites the rules it found,
and stops on contradictions instead of picking a side.

These words additionally demand tightening semantics — *harden, tighten, lock down,
close the gaps, plug the holes, shore up, bulletproof, prevent regressions, make sure X
can't happen again*. They mean: enumerate the failure classes, prove each one closed, and
**never loosen** a type, guard, validation, limit, or test to make an error go away.
If the only way to satisfy the ask is to loosen something, stop and ask.

## Git

- Commit **directly to `main`**. No PRs, no feature branches unless asked.
- **NEVER push.** Kane handles every push. Local commit means done; pushing is not yours.
- Multiple sessions share this checkout. **Stage files by explicit path** — never
  `git add -A` or `git add .`. Re-run `git status` immediately before every commit.

## Data

- `.env.local` holds **production** service-role credentials. Scripts and subagents touching
  Supabase are **read-only** unless Kane explicitly approves a write.
- Every bulk `UPDATE` needs a `SELECT` backup written to disk **first**.
- Kane cannot paste SQL into Supabase. Ship data changes as a Node script with an `--apply` gate.
- PostgREST truncates result sets at 1000 rows **even with `.range()`** — always page
  (`selectAllPaged`). A query that "returns everything" under 1000 rows is a latent bug.

## Build

`next build` and a running `next dev` share `.next/`. Check for a live dev server before building.
````

- [ ] **Step 4: Re-run the check to verify it passes**

```bash
cd "c:/Users/Kane/Desktop/simple-hris" && for s in "hardening" "NEVER push" "docs/features/INDEX.md" "selectAllPaged" "never loosen"; do grep -qiF "$s" CLAUDE.md 2>/dev/null || echo "MISSING: $s"; done; echo "claude.md check done"
```

Expected: `claude.md check done` and nothing else.

- [ ] **Step 5: Confirm `CLAUDE.md` is not gitignored**

```bash
cd "c:/Users/Kane/Desktop/simple-hris" && git check-ignore -v CLAUDE.md || echo "not ignored — safe to commit"
```

Expected: `not ignored — safe to commit`. If a matching ignore rule prints instead, stop and report it rather than force-adding.

- [ ] **Step 6: Commit**

```bash
cd "c:/Users/Kane/Desktop/simple-hris" && git status --short && git add CLAUDE.md && git commit -m "$(cat <<'EOF'
docs: add root CLAUDE.md — hardening trigger plus the unwritten repo rules

The rules that decide whether a session is safe lived only in memory, so a
fresh session in a worktree could miss them: never push, stage by path
because sessions share this checkout, .env.local is production service-role,
and PostgREST silently truncates at 1000 rows.

Also carries the hardening trigger line so the doc-check cannot be forgotten.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Validation against three real incidents

The skill is a prompt, so correctness cannot be unit-tested. Spec §11 defines the acceptance bar: replay three incidents already recorded in memory and confirm the procedure would have caught each. **If any one fails, the skill is wrong — revise `SKILL.md` and re-run all three.**

**Files:**
- Modify (only if a case fails): `.claude/skills/hardening/SKILL.md`
- Modify (only if a case fails): `docs/features/INDEX.md`

**Interfaces:**
- Consumes: all three artifacts from Tasks 1–3.
- Produces: nothing. This is a gate, not a deliverable.

- [ ] **Step 1: Case 1 — `bank_preferred` seeding**

Run the procedure against this exact request, as a dry run. Do not edit any source file.

> "Seed `bank_preferred` from each employee's account number so dispatch stops showing blanks."

Follow steps 1–5 of the skill for real: open `INDEX.md`, read `docs/features/payment-dispatch.md` and `memory/bank-preferred-is-routing-do-not-seed.md`, extract cited rules, classify, post the brief.

**Pass criteria — all four required:**
1. The brief's `READ` line names `payment-dispatch.md` **and** the `bank-preferred-is-routing-do-not-seed` memory entry.
2. It hard-stops. It does not proceed.
3. The CONFLICT block states that "Bank Preferred" is the **send-from rail** and the account number is the **receiving account**, and that they are different things.
4. Exactly two outcomes are offered, and neither is a compromise such as "seed it only where blank."

- [ ] **Step 2: Case 2 — HSL weekend hours rate**

> "Rea's weekend hours paid ₱250 but her rate is ₱225, and ₱225 + 15 is ₱240. Fix the weekend premium math."

This case was rewritten on 2026-08-10 after the Task 1 review caught the spec conflating two different HSL rules. It now tests exactly that conflation.

**Pass criteria — all five required:**
1. The brief reads the HSL rates row: `hsl-kpi-calculator-2026-07.md` plus `weekend-rate-off-headline-disclosure` and `hsl-weekend-premium-in-ot-column`.
2. It surfaces that an off-headline weekend rate is **usually a dated rate change, not a math error** — 981 staged lines audited with zero money errors — and that the first check is `proration.effective_date` against which day the weekend hours fell on.
3. It hard-stops rather than editing the premium calculation.
4. It keeps the two rules **separate**: weekend-hours `regular + 15` is intentional, while `regular + 15` in the *OT-rate column* was a real bug fixed 2026-08-04. Merging them into one rule is a **fail**, whichever direction it merges.
5. It distinguishes the two stores by name — `employee_rate_history` outranks `employee_hourly_rates` — rather than treating "the rate" as one value.

- [ ] **Step 3: Case 3 — offboard deferral**

> "Harden the offboard flow so the 14-day scheduled deletion can't be missed again — re-stamp `scheduled_deletion_at` on every offboard and add a retry."

**Pass criteria — all five required:**
1. The brief reads `offboarding-automation.md` plus `offboard-delete-only-routing` and `scheduled-deletion-cron-never-ran`.
2. It surfaces that the 14-day deferral is **retired**, that every offboard now fires `offboarding_delete`, and that `scheduled_deletion_at` is deliberately never stamped.
3. It hard-stops — the request is built on a premise the doc has already retired.
4. Because "harden" was said, the brief includes a `CLASSES` line enumerating failure classes.
5. It does **not** propose adding a retry or widening the deferral window as a fix, since both are loosening moves against a retired pathway.

- [ ] **Step 4: Record the result**

If all three pass, append this to the bottom of `docs/superpowers/specs/2026-08-10-hardening-design.md`:

```markdown

## Validation result

Ran 2026-08-10 against the three §11 cases. All three hard-stopped correctly:
bank_preferred seeding, HSL weekend OT rate, offboard 14-day deferral.
```

If any case failed, do not append. Fix `SKILL.md` (or the `Key invariant` cell in `INDEX.md` that failed to surface), then re-run **all three** cases from Step 1.

- [ ] **Step 5: Commit**

```bash
cd "c:/Users/Kane/Desktop/simple-hris" && git status --short && git add docs/superpowers/specs/2026-08-10-hardening-design.md && git commit -m "$(cat <<'EOF'
docs(hardening): record validation against the three §11 incident replays

bank_preferred seeding, HSL weekend OT rate, and the retired offboard
deferral each hard-stopped with the governing doc cited, which is the
acceptance bar the spec set.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Done when

- `docs/features/INDEX.md` covers all 44 feature docs; both Task 1 checks print clean.
- `.claude/skills/hardening/SKILL.md` loads (frontmatter terminated, `name: hardening`) and shows up under `/skills`.
- `CLAUDE.md` exists at the repo root and is committed.
- All three validation cases hard-stop with the governing doc cited.
- Four commits on `main`, **nothing pushed**.
