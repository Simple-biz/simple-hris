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
