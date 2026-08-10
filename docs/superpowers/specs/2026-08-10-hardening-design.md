# Hardening skill — design

**Date:** 2026-08-10
**Status:** approved, pending implementation plan
**Owner:** Kane

## Problem

Four failure modes, all confirmed as recurring:

1. **Skipped the docs.** Code changed on a surface whose behavior was already specified in `docs/features/*.md` or a spec, without that doc ever being opened. Settled decisions get re-litigated; documented rules get broken.
2. **Silent contradiction.** A request conflicts with a documented rule or a memory entry, and instead of asking, one side is quietly picked and shipped.
3. **Vague scope on "harden."** The word gets interpreted too broadly (unrelated surfaces touched) or too narrowly (symptom patched, bug class left open).
4. **No precise question asked.** Soft, generic questions ("want me to proceed?") instead of the exact one that mattered ("doc says A, you said B — which wins?").

The repo has 46 docs in `docs/features/`, 14 specs, 12 plans, and ~110 memory entries — many tagged `OPEN:` and contradicting each other. None of it is consulted reliably before a change.

## Solution shape

A project skill named `hardening`, backed by a root `CLAUDE.md` trigger line and a generated surface→doc index map.

Two duties, separately triggered:

| Duty | Fires on | What it does |
|---|---|---|
| **Doc-check** | any edit to a documented surface (fix / harden / refactor / extend) | locate → read → extract cited rules → classify → post brief → hard stop on contradiction |
| **Tightening** | harden-words only | + enumerate failure classes, prove each closed, enforce never-loosen |

Harden-words add teeth to the doc-check; they never replace it.

## 1. Name and trigger

**Skill name:** `hardening`

**Harden-word vocabulary** (activates the tightening duty):
harden, tighten, lock down, close the gaps, close the holes, plug the holes, shore up,
bulletproof, make it robust, make it safe, make sure X can't happen again,
prevent regressions, guard against, stop this from recurring, make it airtight.

**Documented-surface trigger** (activates the doc-check duty): any edit touching
payroll / wizard, payment dispatch, paystubs, MESA, HSL rates, offboarding, bank routing,
onboarding, tickets, PAB, payment catalog, or any other surface with a row in `INDEX.md`.

Note on ordering: whether a surface is documented is only knowable *after* step 1 runs, so
step 1 (the `INDEX.md` lookup) executes on any non-trivial code edit. "Documented surface"
describes the outcome that keeps the procedure going, not a precondition for starting it.
A lookup miss exits cheaply via §9.

## 2. What "harden" means

Hardening has exactly two obligations.

### (a) Bugs must not arise from the change

- Enumerate the failure classes being closed. Not instances — classes.
- Prove each class is closed: a test, a type, a DB constraint, or a cited invariant.
  An assertion with no proof is not a closed class.
- Check adjacent surfaces for regressions before calling it done.

### (b) The feature is never loosened to achieve (a)

Absolute. Hardening tightens. A change that relaxes anything is not hardening.

| Banned as a "fix" (loosening) | Required shape (tightening) |
|---|---|
| widen a type, `any`, `as`, `@ts-ignore` | narrow the type; make illegal states unrepresentable |
| remove or relax a validation or guard | add the missing guard at the boundary |
| `try/catch` that swallows; `?? fallback` masking a null | fail loud at the source |
| make a required field optional | keep it required; fix the producer |
| broaden a filter so the bad row disappears | fix why the bad row exists |
| raise a limit or timeout to dodge the error | fix what is slow or unbounded |
| delete or skip the failing test/assertion | fix the code the test caught |
| loosen `===` to `==`, or relax a lint rule | keep strictness; fix the value |

If the only way to satisfy the request is to loosen something → **hard stop**, precise
either/or, same conflict machinery as §4. No silent relaxation, ever.

## 3. Procedure

1. **Locate.** Resolve the target to surfaces via `docs/features/INDEX.md`.
   No match → grep `docs/` and `memory/MEMORY.md`. If still nothing, say
   "no governing doc found" explicitly. Never proceed silently on a miss.
2. **Read.** Open every mapped doc and memory file in full. Not skim.
3. **Extract.** List each documented rule constraining this change, each with a
   `file:line` citation. **No citation = not a rule.** This kills invented constraints.
4. **Classify.** Every rule against the request: `consistent` / `contradicts` / `unaddressed`.
5. **Post the brief.** Always, even when clean.
   - Zero contradictions → post brief, proceed immediately, no confirmation round-trip.
   - One or more contradictions → hard stop, one precise question each.

## 4. Brief format

Fixed shape, roughly five lines:

```
READ   docs/features/payment-dispatch.md · memory/bank-preferred-is-routing-do-not-seed.md
RULE   bank_preferred = SEND-FROM rail (payment-dispatch.md:112); never seeded from receiving acct
SCOPE  in: dispatch picker precedence · out: People profile editor, rates sheet
GAPS   doc silent on COP-country payees
```

Followed by either `No contradictions — proceeding.` or a CONFLICT block.

When the tightening duty is active, the brief gains one more line:

```
CLASSES  1. null bank on active payee  2. dept transfer mid-cycle  3. dupe dispatch row
```

## 5. Conflict questioning rules

The "precisely exact questions" requirement, made concrete:

- Quote the doc line **verbatim** and the instruction **verbatim**, side by side.
- Offer exactly two named resolutions, each stating what it concretely produces:
  - **(a) doc stands** → here is what I do instead.
  - **(b) doc is stale** → I make the change *and* correct the doc + memory in the same commit.
- **Banned:** "should I proceed?", "want me to look into it?", "which do you prefer?"
  without stated outcomes, and any self-invented compromise between (a) and (b).
- One question per contradiction. Never bundled.

## 6. Stale-doc write-back

Choosing (b) makes the doc edit and memory edit part of the same commit as the code.

**Hard rule:** no commit ships carrying a doc the brief already flagged as stale.

This is what stops the drift that produced the contradiction in the first place.

## 7. `docs/features/INDEX.md`

A lookup table so step 1 is a lookup, not a guess.

| Column | Contents |
|---|---|
| Surface | dispatch, MESA, HSL rates, offboarding, bank routing, wizard tabs, … |
| Docs | paths into `docs/features/`, `docs/superpowers/specs/` |
| Memory slugs | matching entries from `MEMORY.md` |
| Key invariant | one line, the rule most likely to be violated |

Roughly 30 rows covering the 46 feature docs. Built once by reading each doc's opening.
Maintained by the §6 write-back rule: a new doc means a new row, same commit.

## 8. Root `CLAUDE.md`

Does not exist in this repo today. Kept short:

- The `hardening` trigger line.
- Repo rules currently living only in memory: commit direct to main, no PR, **never push**.

## 9. Edge cases

- **No governing doc.** Brief reads `READ none — no governing doc for <surface>`. Proceed,
  but flag that there is no spec to violate, and offer to write one afterward.
- **Docs contradict each other.** Common here — `OPEN:` memory items versus `docs/features/`.
  This is a contradiction like any other: hard stop, same machinery. Precedence is never
  auto-resolved silently. Default proposal is newest-wins, but always surfaced, never assumed.
- **"Skip the check."** Skipped, no argument, no re-litigation.

## 10. Non-goals (YAGNI)

No scripts. No CI check. No `UserPromptSubmit` hook. No report artifact. No edits to
existing skills. No attempt to cover undocumented surfaces beyond saying so out loud.

## 11. Validation

The skill is a prompt, so there are no unit tests. Validation is three dry-runs against
real past incidents recorded in memory, where the check should have fired:

1. **`bank_preferred` seeding** — memory says it is the SEND-FROM rail and must never be
   seeded from the receiving account. A request to seed it must hard-stop.
2. **HSL weekend hours rate** — a weekend line paying more than `headline regular + 15` is
   usually a **dated rate change**, not a math error (981 lines audited, 0 money errors).
   A "fix the weekend premium math" request must surface that, and must keep it separate from
   the unrelated OT-rate rule, where `reg + 15` sitting in the *OT-rate column* was a genuine
   bug fixed 2026-08-04.

   *Corrected 2026-08-10.* This case originally read "`ot = reg + 15`, not `reg × 1.5` — must
   not be corrected," which merged the two rules and landed on the wrong side of both. The
   error came from reading the `MEMORY.md` index line instead of opening
   `hsl-weekend-premium-in-ot-column.md` — the exact failure this skill exists to prevent.
   Caught by the Task 1 review; ruled by Kane on 2026-08-10.
3. **Offboard delete-only routing** — every offboard fires `offboarding_delete`; the 14-day
   deferral is retired. A request assuming deferral must hard-stop.

If the procedure would not have caught all three, the design is wrong and gets revised
before implementation.

## Validation result

Ran 2026-08-10. A fresh agent executed all three requests **blind** — given only the skill
and the request text, never the pass criteria — and a separate scorer graded the output.
Splitting run from score was a deliberate change from the plan: handing the criteria to the
agent that runs the cases lets it confirm answers it already knows.

**All three hard-stopped correctly.** 12 of 14 criteria met on the first pass.

The blind run also found two things the spec had not anticipated: a bulk `bank_preferred` seed
would bypass all four API-layer WIRES-lock enforcement sites, and `offboarding-automation.md`
contradicts *itself* — line 99 states `scheduled_deletion_at` is never stamped while lines
86–88 still document the field.

Two criteria scored unmet; both were ruled defective criteria rather than skill defects
(Kane, 2026-08-10), and dropped:

- **Case 2's fifth criterion** required naming both rate stores and their precedence. It was
  written for the original OT-focused Case 2 and survived the rewrite unexamined —
  `employee_hourly_rates` plays no part in Rea's incident.
- **Case 3's fifth criterion** banned proposing a retry as a loosening move. A retry that
  swallows failures would be; one that fails loud is what the never-loosen table prescribes.

**Note on this section's own history.** Three separate errors in this spec were caught by the
build process, all of the same kind: the author read a one-line summary and did not open the
underlying file. That is the exact failure the skill exists to prevent, which is either
reassuring or damning depending on your mood.
