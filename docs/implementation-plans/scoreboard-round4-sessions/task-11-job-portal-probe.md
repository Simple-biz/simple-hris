# Session: Task 11, prove the job portal reads the Offboarded list (Open item 395)

Lane B: this may run while a scoreboard session is running. Use the **`hardening`** skill first (it is a check on a
shipped surface).

**Meeting notes (read first):** `docs/meetings/2026-10-07-carla-alivia-scoreboard-tasks-roles-and-interns.md` § "HR: Teal's orientation NCNS on the Offboarding list (item 395; follows 343 and 389)". Read that section word for word, plus the note's **Decisions made on the call**, **Open questions** and **Reference notes** (the transcript's name garbles, e.g. Kenchin = Kentshin, Olivia = Alivia). Carla will judge the result against her quotes there, and the plan only restates them.

**Your scope:** Task 11 of `docs/implementation-plans/implementation-plan-scoreboard-round4-and-oct7-asks.md`. Read that task
in full. It writes one **read-only** probe script and records what it finds.

**Why:** on the 2026-10-07 call Kane told Carla the job portal (Rainer B.) *"already"* reads the offboarded list and blocks
reapplying (*"Unless Rainer is not done with us yet"*). The code (`4cf42388`, scope `offboarded.read`) is on `origin/main`.
Whether Rainer's key holds that scope and has called it is **not verified**: a session's production read was refused on
10-07.

## Steps
1. Create `scripts/probe-external-api-offboarded-usage.mts` from the plan's Task 11 Step 1 (it reads
   `external_api_clients` and `external_api_requests` directly, and prints names, scopes and counts, never key hashes or
   prefixes). Typecheck it.
2. **Never curl `/api/external/*` on local dev.** Even a denied call writes a production `external_api_requests` row
   (memory `external-api-offboarded`).
3. Try running it once: `node --import tsx scripts/probe-external-api-offboarded-usage.mts`. **If the permission check
   refuses, do not retry another way.** Ask Kane to run it and paste the output.
4. With the output: if the job portal's key lacks `offboarded.read`, tell Kane to tick Offboarded on that key (Admin →
   Webhooks & Integrations → Integrations, the Datasets step) and tell Rainer. If it holds the scope but shows no calls, the
   question for Rainer is whether the reapply check is live.

## Rules for this session
- `.env.local` is **production**. This script only reads.
- Kane pushes. You never push. Stage by explicit path (the script, the session log, the doc), re-run `git status` right
  before committing, commit to `main`.

## Done means
1. The script is committed. `npm run lint` passes.
2. `docs/features/external-api-offboarded.md` gets a dated line with the measured result, and memories
   `external-api-offboarded` and `orientation-noshow-never-reaches-offboarded` are updated.
3. Open items **395** and **343** in `docs/audits/audit-2026-09-29-session-log.md` get a dated note with the measurement.
4. Reply to Kane in a few lines: verified or not, and what (if anything) he or Rainer must do.
