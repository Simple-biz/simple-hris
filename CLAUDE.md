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
