# Accounting Scoreboard Keys — the paid platforms each person holds a seat on

Setup → **Keys** on the Accounting Scoreboard lists which paid platforms (QBO, Stripe, Bitrix, Wise, Chase…) each
person holds a seat on, so that taking someone off the team shows every seat still to remove. It replaces a sheet Carla
kept by hand (one column per platform, *"done Carla"* typed in each cell). Admins only. Built 2026-10-09 (session
`24ba2a0d`, Open item 424) from the [Oct 8 meeting](../meetings/2026-10-08-carla-scoreboard-keys-hsl-v2-and-cop.md)
§ Keys. It lives inside the scoreboard ([accounting-scoreboard.md](accounting-scoreboard.md)) and shares its access
and roles.

> Carla: *"QBO charges us per seat. Uh Stripe charges us per seat. So we lose money if we don't offboard them from all
> these other platforms."* *"We can call them keys like I can create a key to QBO and you have a key to access QBO."*
> *"if I ever needed to offboard [someone], I could click on his name. It would show me all the tags and I would be
> able to action all of that before kicking him off the team."*

## Key files

| Piece | File |
| --- | --- |
| Tables, guards, lock-down | `references/sql/create/2026-10-09_accounting_scoreboard_keys.sql` |
| Apply / verify (dry by default) | `scripts/apply-accounting-scoreboard-keys-migration.mts` |
| Parsers, the grid, who is off the board (pure) | `src/lib/accounting-scoreboard/keys.ts` (+ `keys.test.ts`) |
| Who may: `manage_keys` (Admin only) | `src/lib/accounting-scoreboard/roles.ts` (+ `roles.test.ts`) |
| Reads and writes | `src/lib/accounting-scoreboard/server.ts` § Keys (`readKeys`, `createKey`, `archiveKey`, `giveKeySeat`, `removeKeySeat`) |
| Wire types | `ScoreboardKey`, `KeySeat`, `KeysPayload` in `src/lib/accounting-scoreboard/types.ts` |
| Routes | `app/api/accounting-scoreboard/keys/route.ts` (GET · POST `{ label }` · DELETE `?id=` archives) · `keys/seats/route.ts` (POST `{ keyId, email }` gives · DELETE `?keyId=&email=` removes) |
| UI | `src/components/accounting-scoreboard/KeysArea.tsx`, mounted by `SetupPanel.tsx` as the **Keys** area |

## Who sees it: Admins only, reading too

- Every Keys route asks `resolveAccess('manage_keys')`, and `can()` gives `manage_keys` to Admins only (an HRIS
  `admin`, or a live Admin grant). An Assistant, who sees the rest of Setup read-only, does **not** see the Keys area
  at all, and its GET answers 403. Carla: *"It's not for the team"*; Kane: *"whatever admin is in there"*.
  `roles.test.ts` pins both routes to `manage_keys` and nothing else.
- To let Assistants read it later, add `'manage_keys'` reading as its own action (`view_keys`) to the Assistant list
  in `roles.ts`. Do not reuse `view_setup`: that would also show the list to everyone who sees Setup.

## A key is a platform; a seat is one person holding it

- `accounting_scoreboard_keys`: one row per platform. The name is 1 to 40 characters, trimmed, and unique among
  **live** keys whatever the case (`QBO` and `qbo` are one platform: unique index on `lower(label)`). A second live key
  with the same name is 409 `key_exists`.
- `accounting_scoreboard_key_seats`: one row per (key, person) **while held**. One live seat per key per person
  (partial unique index): a second give is 409 `already_holds`.
- **A key's name never changes in place**, and there is no rename. A typo is fixed by archiving the empty key and adding
  it again. Why: a removed seat names its platform through the key, so a rename would rewrite history.

## Nothing is deleted

- **Removing a seat is a stamp** (`removed_at`, `removed_by` = the session email), set once. The row stays. Holding the
  same key again inserts a **new** seat. So "who held QBO, from when, and who removed it when" is always readable. This
  is the board's rule since item 410 (*"make sure all of the data … is saved"*), and the same shape as role grants and
  task ticks.
- **Archiving a key is a stamp too**, and it is allowed **only once nobody holds a seat on it**. An archived key with an
  open seat would hide money still being spent. The route answers 409 `key_has_seats` (it counts first), and the
  table's trigger refuses it anyway. The archive and a new seat on the same key take the **same per-key advisory lock**
  (`hashtext('accounting_scoreboard_keys:' || id)`), so one cannot slip past the other.
- Both triggers refuse a `DELETE`, a row created already stamped, a second stamp, and a stamp without who. A seat can
  never move to another person or key. The migration script proves each refusal (17 negative controls).
- `keys.test.ts` pins that the Keys block of `server.ts` never calls `.delete(` and stamps `removed_by` with the
  session email.

## Who a seat can go to, and who is "off the board"

- **A seat is given only to someone on the board**: a live person row with a work email, an address under Members, or
  a role grant. That is `listTaskPeople`, the same list the task boards use. Any other address is 422 `not_on_board`
  (*"Add them under Setup → Members first"*). Why: Carla assigns *"to anybody that's on this list"*, and a typed
  address would create a holder nobody can find.
- **Anyone who leaves the board while still holding a seat is "Off the board"**: listed first in the grid, tinted
  amber, and named in a banner (*"1 person is off the board and still holds 2 seats"*). Those are the seats still
  being paid for. Their boxes can be unticked (seat removed) but never ticked (the server refuses a give).
- "Off the board" is judged against the **board's** people, **not** the HRIS roster. Several US staff on the board are
  not on the GML at all (memory `carla-accounting-scoreboard-sheet`), so an HRIS check would flag them permanently.
  Taking someone off the board (archiving their row, removing them from Members) is what makes their open seats show.
- People are matched by the exact work email the seat was given to (the board list's address). A person whose row is
  re-created under an alternate address shows twice. That is not a bug; give the seat to the address the board uses.

## The grid

- People down, keys across (A to Z), a tick = holds a seat. Ticking gives a seat; **unticking marks the seat removed**.
  There is no confirm, because nothing is lost: a wrong untick is fixed by ticking again, and both stay in history.
- Each column header shows its live seat count; the archive button (×) appears only on a key nobody holds.
- **A name opens that person's seats**: *"Seats to remove before <name> leaves"*, each with **Seat removed**, then the
  **Removed** history (platform, when, by whom, held since when). This is Carla's offboarding checklist.
- Search by name or address; *Only people holding a seat* hides the rest.
- On a phone the grid scrolls sideways inside its box, the name column stays put (sticky), and an opened person's panel
  is exactly the visible width (`@container` + `w-[100cqw]` + sticky), so **Seat removed** is never off-screen.
  The off-the-board tint is **opaque** and the same on the row and its sticky name cell (`OFF_BOARD_BG`): a
  see-through sticky cell shows the ticks scrolling under it.
- The area loads on open and re-reads after every write (like Access). It is not cached and not on the live channel.

## Not part of the board

- `readBoard` never reads the Keys tables, so Keys is not in the board payload, the browser cache, the loading modal,
  the Overview or the Team Score. Until the migration is applied, **only Setup → Keys** says "not set up yet".
- No write here announces on the live channel: `live.test.ts` lists `keys/` in `NOT_THE_BOARD` with its reason.
- No audit rows. The tables carry who and when (like Members), so the audit registry is unchanged.
- The HRIS Offboarding queue does not know about Keys. Whether it should was not asked (meeting § Keys).

## Not built (on purpose, or waiting)

- **Pre-seeding from Carla's sheet: NEEDS the sheet's link** (meeting § Keys; she said she would share it). Until then
  she adds the keys and ticks people in the grid. An import would follow the task import's pattern
  (`scripts/import-accounting-scoreboard-tasks.mts`: dry by default, a gitignored name → email map, exact matches only).
- What "FMS" and "PA" stand for is not recorded; they are just names Carla types.
- Rename, a reason on a removal, Assistant read access, and a link from the HRIS Offboarding queue.

## Deploy notes

1. **Migration FIRST, then the push** (the board's standing rule; three earlier pushes went first and broke the live
   board). Here only Keys would break, but keep the order:
   `node --import tsx scripts/apply-accounting-scoreboard-keys-migration.mts --apply`, then `--verify`.
   Dry run passed on production 2026-10-09 (session `24ba2a0d`): every object, privilege, positive and negative
   control, rolled back. **`--apply` PENDING (Kane).**
2. Push and deploy. **PENDING (Kane).** No env var, no cron, no n8n.
3. Signed-in pass: an Admin opens Setup → Keys, adds a key, ticks a person, opens them, marks the seat removed.
   An Assistant must not see the Keys area. **PENDING.**
