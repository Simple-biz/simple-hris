---
name: blueprint
description: Use when building something that does not exist yet — a new dashboard, page, tab, route, table, report, export, notification, integration, or script. Fires on "create a new", "build me", "add a feature", "I want a screen that", "we need a way to", "make a tool for". Scopes the new surface against the governing docs and the closest already-shipped precedent, posts a SCOPE brief and hard-stops for approval before writing any code, then executes and writes the feature doc, INDEX row, and memory entry into the same commit. For changing, fixing, or tightening something that already exists use the hardening skill; for visual polish on an existing screen use impeccable.
user-invocable: true
argument-hint: "[the feature — what it is and what it should do]"
---

# Blueprint

Four phases, in order. **Nothing is written to `src/` or `app/` before phase 2 is approved.**

| Phase | Produces | Gate |
|---|---|---|
| 1 · Scope | governing docs read · precedent named · unknowns listed | — |
| 2 · Brief | the `BLUEPRINT` block, posted in chat | **hard stop — wait for Kane** |
| 3 · Build | plan doc, then the code, data layer first | — |
| 4 · Document | feature doc · INDEX row · memory · one commit | — |

## Phase 1 — Scope

**1.1 Read what governs it.** A new surface still lands inside existing rules. Open
`docs/features/INDEX.md` and find every row the feature touches — data it reads, tables it
writes, people it pays, roles that see it. Read those docs and memory entries **in full**.
Cite each constraining rule with `file:line`. **No citation = not a rule.**
No matching row → grep `docs/` and the memory directory, then say `READ none` out loud.

If the feature touches **money, bank routing, or deletion**, run the `hardening` doc-check in
full. This skill adds a plan gate; it does not replace that check.

**1.2 Name the precedent.** Every new surface here has a closest cousin already shipped —
name it with paths. A new dashboard copies an existing dashboard's route/API/component split;
a new tab copies the tab beside it; a new script copies `scripts/verify-*.mts`.
**Inventing a new pattern where a precedent exists is a defect.** Copy it, or say in the brief
why the precedent doesn't fit.

**1.3 List what you don't know.** Anything where two readings produce materially different
builds. These become numbered `Q` lines in the brief — **not** silent assumptions, and not
questions you plan to ask later when you hit them.

## Phase 2 — The brief

Post it. Then stop.

```
BLUEPRINT  Attendance dashboard
READ    docs/features/csv-imports.md:31 · memory/postgrest-1000-cap-sweep.md
LIKE    src/components/accounting/PayrollReadiness.tsx — same route+API+component split
SCOPE   in:  /attendance route · KPI header · per-dept table · GET /api/attendance/summary
        out: payroll wizard · dispatch · paystubs · every write path
BUILD   1. src/lib/attendance/stats.ts          pure, unit-tested
        2. app/api/attendance/summary/route.ts  requireFeatureAccess("accounting","attendance","view")
        3. src/components/AttendanceDashboard.tsx
DATA    new table attendance_days → references/sql/create/2026-08-10_attendance_days.sql
        you run it — shipped as a Node script with an --apply gate
RISK    punch rows exceed 1000 → selectAllPaged, never .range()
DOCS    docs/features/attendance-dashboard.md + INDEX row + memory attendance-dashboard
Q1      Do temporary_pause people appear? On the roster, not working — changes the KPI
        denominator and whether the table has an "excluded" state.
```

What each line owes:

- **`SCOPE out:` is a contract.** What is listed there does not get touched. If the build turns
  out to need an `out:` surface, that is a scope change — say so and re-post the brief.
- **`BUILD`** lines are file paths in build order, not activities. "wire up the backend" is not a
  BUILD line.
- **`DATA`** says `No migration.` explicitly when there is none. Silence reads as *forgot*.
- **`RISK`** names the specific failure mode and its guard. "might be slow" is not a risk.
- **`Q`** lines each state what concretely changes based on the answer.

**Then stop.** Do not open an editor. Do not start "the safe part" — there isn't one; the shape of
the data layer is exactly what the questions are about. Approval is a message from Kane, never an
inference from silence.

Revision → re-post the **whole** brief, not a diff of it.

## Phase 3 — Build

Approved brief → write it out as `docs/superpowers/plans/YYYY-MM-DD-<slug>.md` (task-by-task,
`- [ ]` steps, matching the plans already in that directory), then execute in this order:

1. **SQL first** — the `.sql` file exists before anything reads the table.
2. **Pure functions + their tests** — `node:test`, next to the module.
3. **Route** — gated the same way the closest existing route is gated.
4. **UI last.** A component built against a shape that doesn't exist yet gets rebuilt.
5. **Typecheck / build.** `next build` and a live `next dev` share `.next/` — check for a running
   dev server first.

Traps that bite new surfaces specifically:

| Situation | Rule |
|---|---|
| any new query over any table | PostgREST truncates at 1000 rows **even with `.range()`** — `selectAllPaged` |
| any new DDL | file into `references/sql/<create\|alter\|fix\|seed>/`. **Kane cannot paste SQL** — ship a Node script with an `--apply` gate |
| any script touching Supabase | `.env.local` is **production** service-role. Read-only unless Kane approves the write. Bulk `UPDATE` needs a `SELECT` backup on disk first |
| new API route | gate it — `requireFeatureAccess(...)`, mirroring the nearest existing route |
| new notification type, webhook, or cron | the DDL and the n8n import are external steps Kane runs — they go in Deploy notes marked **PENDING** |
| new `security_invoker` view | a single RLS-blocked table in its filter returns a **silent empty set** |

Scope drift mid-build → stop, say it, re-post the brief. Never widen quietly.

## Phase 4 — Document

Not optional. Not "after Kane confirms it works." Not a follow-up commit.
**A feature without its doc is unfinished work, not finished work awaiting paperwork.**

Four artifacts, all in the same commit as the code:

1. `docs/features/<slug>.md` — the governing doc. Contract below.
2. A new row in `docs/features/INDEX.md` — new doc = new row, with the Key invariant filled in.
3. A memory file in `C:/Users/Kane/.claude/projects/c--Users-Kane-Desktop-simple-hris/memory/`
   plus its one-line pointer in `MEMORY.md`, and its `[[wikilink]]` in the INDEX row's Memory cell.
4. The `references/sql/…` file, referenced by path from Deploy notes.

### The feature doc contract

The doc states what the surface **is** and which rule the next person will break. Required parts,
in this order:

```markdown
# <Surface> — <one line of what it is>

<2–4 sentences: what it does, where it lives, who it is for. Ship date + commit SHA.>

## Key files
| Piece | File |
| --- | --- |

## <one section per behavior that carries a rule>
State the invariant, then why it is that way. Name the thing that looks like a
bug but isn't. Cross-link sibling docs.

## Deploy notes
Migration path, or **No migration.** · env vars · n8n imports · anything Kane
runs by hand, marked PENDING until he confirms it landed.
```

The test: someone editing this surface in six weeks reads **only this file** and does not break it.
A doc that lists what changed is a changelog — rewrite it as rules.

## Commit

Code + all four doc artifacts, one commit. Re-run `git status` immediately before staging —
another session shares this checkout. Stage **by explicit path**; never `git add -A` or `git add .`.
Commit direct to `main`. **Never push.**

## Red flags — STOP

- *"This one's small enough to just build"* → the brief costs two minutes and is the whole point
- *"I'll write the doc once he confirms it works"* → the doc ships **in** the commit
- *"I'll ask about that edge case when I reach it"* → it is a `Q` line, now
- *"There's no existing pattern for this"* → you haven't looked. Name the closest cousin
- *"The doc would just restate the code"* → then it names no invariant. Find the rule
- *"I'll mention the migration in chat"* → Deploy notes, or it is lost
- *"Silence means he's fine with it"* → approval is a message
- About to touch a file listed under `out:` → scope change. Re-post the brief

## Not this skill

| Ask | Skill |
|---|---|
| change, fix, extend, or tighten something that exists | `hardening` |
| visual, layout, typography, motion, frontend polish | `impeccable` |
| "skip the plan, just build it" | skipped — no argument, no reminder next turn |
