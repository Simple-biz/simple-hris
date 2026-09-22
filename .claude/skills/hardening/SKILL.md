---
name: hardening
description: Use before any non-trivial code edit — e.g. payroll, wizard, dispatch, paystubs, MESA, HSL rates, offboarding, bank routing, onboarding, PAB, catalog, roster, and anywhere else a governing doc might exist. Also use when the target IS a doc, a skill, or the process itself. Reads the governing docs and memory FIRST, cites the rules it found, and hard-stops with a precise either/or when the request contradicts what is documented. Closes the documentation in the same commit as the code — feature doc, INDEX row, README row, docs/reference, memory, Open items — because a commit whose doc still describes the old behavior is not finished. When the user says harden, tighten, lock down, close the gaps, plug the holes, shore up, bulletproof, prevent regressions, or make sure X cannot happen again, it additionally enumerates the failure classes being closed and forbids fixing anything by loosening a type, guard, validation, limit, test, or documented rule. Correctness and invariants only — for visual or frontend polish use the impeccable skill.
user-invocable: true
argument-hint: "[target — file, feature, surface, or doc]"
---

# Hardening

Three duties. They trigger separately and stack.

| Duty | Fires on | Obligation |
|---|---|---|
| **Doc-check** | any non-trivial code edit | read the governing docs before touching anything; stop on contradictions |
| **Doc-closure** | every commit this skill governs — and every session it governs that ships none | the docs describing the change are true again **in that same commit** |
| **Tightening** | harden-words only | enumerate failure classes, prove each closed, never loosen |

Harden-words: *harden · tighten · lock down · close the gaps · close the holes · plug the holes · shore up · bulletproof · make it robust · make it safe · make sure X can't happen again · prevent regressions · guard against · stop this from recurring · make it airtight.*

## Procedure

**1 — Locate.** Open `docs/features/INDEX.md` and find the row matching the target.
No matching row → grep `docs/` and the memory directory for the surface name.
Still nothing → say `READ none — no governing doc for <surface>` out loud and continue.
**Never skip silently.** A missing doc is a fact to report, not permission to guess.

**The target is itself a doc, a skill, a script, or the process** → same procedure, no exemption.
Its governing docs are that file, its `INDEX.md` row, and root `CLAUDE.md`; `.claude/skills/*` is
governed by the **Skills & doc process** row. There is no code diff — step 6 diffs the doc files
instead, and step 7 still fires. **A doc edit is an edit.** The rules written there are the ones
every future session obeys, so changing one silently reaches further than changing a function.

**2 — Read.** Open every doc and memory file the row lists. In full. Not skim, not grep for a keyword.

**3 — Extract.** List each rule that constrains this change, each with a `file:line` citation.
**No citation = not a rule.** This cuts invented constraints as hard as it cuts skipped ones.

**4 — Classify.** Every rule against the request: `consistent` / `contradicts` / `unaddressed`.

**5 — Brief.** Post it. Always, even when clean.
- Zero contradictions → post the brief and proceed. No confirmation round-trip.
- One or more → **hard stop.** One precise question each.
- An `unaddressed` rule on a money, routing, or deletion path is not a footnote — decide it explicitly in the brief and write the resolution back to the doc in the same commit.

**6 — Close scope.** Before committing, diff the changed files against `SCOPE`'s `in:` list — anything outside it is a scope change and gets said out loud.

**7 — Close the docs.** Every artifact named on the `DOCS` line, in this commit. See below.
The work is not done while a doc still describes the old behavior.

## The brief

```
READ   docs/features/payment-dispatch.md · memory/bank-preferred-is-routing-do-not-seed.md
RULE   "Bank Preferred" = SEND-FROM rail (payment-dispatch.md:112); never seeded from the receiving acct
SCOPE  in: dispatch picker precedence · out: People profile editor, rates sheet
DOCS   payment-dispatch.md §4 precedence · INDEX Key invariant · api-reference.md (route gains
       ?rail=) · components.md n/a · memory n/a · Open items n/a
GAPS   doc is silent on COP-country payees
```

Then either `No contradictions — proceeding.` or a CONFLICT block.

When the tightening duty is active, add one line:

```
CLASSES  1. null bank on an active payee  2. dept transfer mid-cycle  3. duplicate dispatch row
```

`SCOPE` is a contract. What is listed under `out:` does not get touched. If the work turns out to require an `out:` surface, that is a scope change — say so and re-post the brief.

**`DOCS` is a contract of the same kind.** It names — *before the code is written* — every doc this
change is about to make untrue, and step 7 is checked against it. Write `n/a` per artifact, never
silence: silence reads as *forgot*. A doc that turns out to need editing and is not on the line is
announced out loud, exactly like a scope change.

## Closing the documentation

Not optional. Not "after Kane confirms it works." Not a follow-up commit.
**A change whose doc still describes the old behavior has not been finished — it has moved the
defect into the documentation, where it is harder to see and outlives the code.**

Walk every row. Each is either edited in this commit or explicitly `n/a` on the `DOCS` line:

| Artifact | Fires when | Where |
|---|---|---|
| the governing doc(s) read at step 2 | you changed, added, or removed a rule | `docs/features/<slug>.md` — **rewrite the rule**, never append a changelog |
| the `Key invariant` cell | the invariant moved | `docs/features/INDEX.md` |
| a row in **both** indexes | you added a feature doc | `docs/features/INDEX.md` **and** `docs/README.md` — one without the other is **half-published** |
| `api-reference.md` | you added, renamed, gated, moved, or deleted an API route | `docs/reference/` |
| `components.md` | you added or renamed a shared component or hook | `docs/reference/` |
| `llm-context.md` | the read-first overview of that surface is now wrong | `docs/reference/` |
| memory entry | the change teaches a rule the next session would otherwise break | memory dir + `[[wikilink]]` in the INDEX row + a `MEMORY.md` pointer **at the top**, hook ≤150 chars |
| Open items row | anything is left unfinished, staged-not-applied, or found-not-fixed | newest `docs/audits/audit-*-session-log.md` **§ Open items** |
| Deploy notes | a migration, env var, n8n import, or grant Kane runs by hand | the feature doc, marked **PENDING** until he confirms it landed |

`docs/reference/*` is the row nobody remembers unaided, because its rot is invisible: every
per-feature doc looks healthy while the reference index still claims *"all 14 endpoints"* and
documents none of the six that shipped. Prefer **updating an existing memory file** to adding one —
`MEMORY.md` is truncated from the tail past ~24.4 KB and is already over it.

**A session that ships no code still ships its record.** The doc-in-the-same-commit rule fires on a
code commit, so an advisory, investigation, meeting, or hard-stopped session writes nothing durable
unless this does:

- a **finding** (security hole, false premise, money contradiction) → a memory entry **and** a row in the newest session log's Open items; start a new log if that one is days old
- a **brief posted and awaiting approval** → one Open items line naming the session id and the questions outstanding
- a **meeting** → `docs/meetings/YYYY-MM-DD-<slug>.md` + its `docs/README.md` row + wikilinks in every INDEX row it touches

Then **commit it, by explicit path.** Doc work left in the working tree is invisible to the next
session and gets swept under someone else's commit message.

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

### A doc is loosenable too

This table fires **whenever a doc is edited**, not only on harden-words. Weakening a written rule
costs one keystroke and silently repeals the guard for every session that comes after.

| Banned in a doc | What belongs there instead |
|---|---|
| delete a rule because the code no longer obeys it | fix the code — or record that the rule changed, with the date and who changed it |
| soften `never` → `avoid`, `must` → `should`, `always` → `usually` | keep the strength; if the rule genuinely eased, name who eased it and when |
| drop a caveat, an edge case, or a measured number | keep it, and put the new measurement beside the old one with its date |
| widen the doc's stated scope until the code stops contradicting it | narrow the code |
| replace an invariant with a line about what changed | invariants — a doc that lists what changed is a changelog |
| mark an item DONE that is staged, built-unrun, or merely proposed | "committed" is a `git log` fact; "applied" is a database fact |
| let a `PENDING` deploy note quietly disappear | it stays PENDING until Kane confirms it landed |
| close an `OPEN:` item because it reads as stale | measure it, or leave it open and say you did not measure it |

**A documented rule is weakened only by Kane, on the record — never as cleanup.** If the request
requires one weakened, that is a contradiction: hard stop, conflict format, resolution (b).

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

**No governing doc.** Report it and proceed. At step 7 either write the doc, or say out loud that
you are not writing one and why — silence is what left the surface undocumented in the first place.

**Docs contradict each other.** Common here — `OPEN:` memory items versus `docs/features/`. This is a contradiction like any other: hard stop, same format, with the two docs quoted instead of doc-versus-instruction. Precedence is never auto-resolved silently. Default proposal is newest-wins, but it is always surfaced, never assumed.

**"Skip the check."** Skipped. No argument, no re-litigation, no reminder next turn.

**"Skip the docs."** Also skipped — and said once in the commit message, so the gap is on the
record instead of invisible.

**Not this skill.** Visual, layout, typography, motion, and general frontend polish belong to the `impeccable` skill even when the word *harden* is used. This skill is correctness and invariants.
