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
