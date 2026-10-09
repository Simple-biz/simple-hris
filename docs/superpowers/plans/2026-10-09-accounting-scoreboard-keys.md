# Accounting Scoreboard Keys — implementation plan (Open item 424)

Session `24ba2a0d`, 2026-10-09, `blueprint`. Kane: *"Lets start implementing about the Keys ignore the other ones
first"*. Spec: [Oct 8 meeting](../../meetings/2026-10-08-carla-scoreboard-keys-hsl-v2-and-cop.md) § Keys. Governing doc
written with the build: [accounting-scoreboard-keys.md](../../features/accounting-scoreboard-keys.md). Written as the
build ran, under a same-morning deadline (Carla wanted it before 9 AM ET 10-09), so each step is ticked as done.

**Brief (CHOSEN, overturnable in one message):** its own Setup area beside Members · Admin only, reading too
(`manage_keys`) · a grid like her sheet (people down, keys across) with a per-person seats panel · removing a seat is a
stamp and re-ticking is a new seat · a key is archived only when nobody holds it, no rename · seats only for people on
the board, leavers still holding seats flagged "Off the board" (not checked against the HRIS roster) · no audit rows ·
not on the live channel. **NEEDS:** Carla's sheet link (pre-seed).

## Task 1: SQL

- [x] `references/sql/create/2026-10-09_accounting_scoreboard_keys.sql`: `accounting_scoreboard_keys` (label 1–40,
      unique live by `lower(label)`, archive stamp) and `accounting_scoreboard_key_seats` (one live per key + email,
      removal stamp). Guards refuse DELETE, pre-stamped inserts, second stamps, a rename, a moved seat; archive refuses
      while a seat is live; give refuses on an archived key; both under one per-key advisory lock. RLS on, 0 policies,
      anon/authenticated revoked.
- [x] `scripts/apply-accounting-scoreboard-keys-migration.mts` (copied from the tasks script): dry by default, objects
      and privileges, the reads, anon refused, 2 positive and 17 negative controls in rolled-back savepoints.
- [x] Dry run on production: all checks PASS, rolled back.

## Task 2: Pure rules + tests

- [x] `src/lib/accounting-scoreboard/keys.ts`: `cleanKeyLabel`, `parseKeyCreate`, `parseKeySeatWrite`,
      `buildKeyGrid` (live keys A–Z, seat counts, people = board ∪ holders, off-board holders first), `liveSeatOf`,
      `canArchiveKey`, `matchesPerson`.
- [x] `keys.test.ts`: parsers, the 40 limit pinned to the SQL CHECK, the grid order, off-board, history, and a source
      pin that the server's Keys block never calls `.delete(`.

## Task 3: Access

- [x] `roles.ts`: `manage_keys` (Admins only, by `ADMIN = BOARD_ACTIONS`); `REFUSED.manage_keys` in `server.ts`.
- [x] `roles.test.ts`: the three role cases; both Keys routes ask `manage_keys` and nothing else.

## Task 4: Server + routes

- [x] `server.ts` § Keys: `readKeys` (paged, + `listTaskPeople`), `createKey` (409 `key_exists`), `archiveKey` (count
      first, 409 `key_has_seats`, trigger as the guard), `giveKeySeat` (422 `not_on_board`, 409 `already_holds`),
      `removeKeySeat` (the stamp; 404 when nothing live).
- [x] `app/api/accounting-scoreboard/keys/route.ts` (GET/POST/DELETE) · `keys/seats/route.ts` (POST/DELETE).
- [x] `live.test.ts`: `keys/` in `NOT_THE_BOARD` with its reason.

## Task 5: UI

- [x] `KeysArea.tsx`: the banner for off-board holders, add key, search, holders filter, the grid (sticky name column,
      per-key seat count, archive × only on an unheld key), the per-person panel (Seat removed, Removed history).
- [x] `SetupPanel.tsx`: the Keys area (Admin-only, outside the read-only fieldset, like Access); the Admin summary
      names Keys.
- [x] Headless check on synthetic data (session scratchpad `harness/`): 35/35 at 1360 light/dark and 390, incl. tick,
      untick, Seat removed, add, duplicate refused, archive, search, filter, Seat removed on screen at 390, no console
      errors. Two fixes came out of it: an even, opaque off-board tint, and a panel that is the visible width on a phone.

## Task 6: Verify + document

- [x] `tsc`: clean apart from the 2 known stale `.next/types` entries. `npm test`: 6,617/6,617.
- [x] Feature doc, INDEX row, `accounting-scoreboard.md` cross-references, Open item 424, memory.
- [ ] Kane: `--apply`, then push, then a signed-in pass (PENDING).
