# Simple HRIS — project rules

## Before writing code

Two skills, split by whether the thing already exists.

**Building something new** — a dashboard, page, tab, route, table, report, export,
notification, integration, or script: use the **`blueprint`** skill first. It scopes the
surface against the governing docs and the nearest shipped precedent, posts a `BLUEPRINT`
brief, and **hard-stops for approval before any code is written**. After the build it writes
the feature doc, the `docs/features/INDEX.md` row, and the memory entry into the same commit.
A feature without its doc is unfinished.

**Changing something that exists** — any non-trivial edit: use the **`hardening`** skill first.
It resolves the surface via `docs/features/INDEX.md`, reads the governing docs and memory,
cites the rules it found, and stops on contradictions instead of picking a side.

These words additionally demand tightening semantics — *harden, tighten, lock down,
close the gaps, plug the holes, shore up, bulletproof, prevent regressions, make sure X
can't happen again* — see `.claude/skills/hardening/SKILL.md` for the full list. They mean:
enumerate the failure classes, prove each one closed, and **never loosen** a type, guard,
validation, limit, or test to make an error go away.
If the only way to satisfy the ask is to loosen something, stop and ask.

## Before answering "how are we on X" / "what is the status of X"

Status lives in three places. Read them in this order, then verify in the working tree:

1. `docs/audits/` — the newest `audit-*-session-log.md`, **§ Open items**. That table is the
   current state of every unfinished thing, re-verified on the date in its header.
2. The surface's row in `docs/features/INDEX.md` and every doc it lists.
3. Memory. A `MEMORY.md` hook is a **pointer, not a fact** — open the file.

Never answer from a hook alone, and never report something as done because a transcript said
it was proposed. "Committed" is a `git log` fact; "applied" is a database fact.

## A session that ships no code still ships its record

Advisory, investigation, meeting and status sessions have produced the most important findings
of the last two weeks and, by default, wrote them nowhere — the doc-in-the-same-commit rule
only fires on a code commit. So, before the session ends:

- A **finding** (security hole, false premise, money contradiction) → a memory entry **and** a
  row in the newest session log's Open items (start a new log if that one is days old).
- A **meeting** → `docs/meetings/YYYY-MM-DD-<slug>.md`, its `docs/README.md` row, and
  wikilinks in every INDEX row it touches.
- A **brief posted and awaiting approval** (a `blueprint` or `hardening` hard stop) → one Open
  items line naming the session id and the questions outstanding.
- Then **commit it**, by explicit path. Doc work left in the working tree is invisible to the
  next session and gets swept under someone else's commit message.

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
