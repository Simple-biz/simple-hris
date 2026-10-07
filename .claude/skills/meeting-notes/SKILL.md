---
name: meeting-notes
description: Use when Kane pastes a meeting transcript, call notes, or a relayed conversation for the HRIS (Google Meet "Meeting <date> - Transcript" dumps, Carla / Alivia / Jackie / Teal calls, "save this as a meeting", "log this call", "here's the call from today"). Writes docs/meetings/YYYY-MM-DD-<slug>.md, its docs/README.md row and the INDEX wikilinks, then reconciles every surface the call touched against the newest session log's Open items and memory, so a call that changes a surface's state actually changes the record. Ported from the Gridline meeting-notes skill on 2026-10-07.
---

# Meeting Notes (HRIS)

Calls with Carla and the team are where requirements, rulings and complaints actually change.
A note that only archives the conversation is half the job. The other half is **propagating
what changed into the places the next session reads**: the newest
`docs/audits/audit-*-session-log.md` § Open items, the surface's row in
`docs/features/INDEX.md`, and the surface's memory file. Those are what get read later
(`CLAUDE.md` § "how are we on X"), and a stale entry there causes real wrong work.

One rule governs everything below: **a call can invalidate an Open item or a memory entry, and
neither notices on its own.** Always finish the reconciliation pass.

This skill **builds nothing**. A call is full of asks. Each one is recorded and routed:
new surfaces go to `blueprint`, changes to existing ones go to `hardening`, money goes to Kane.
The meeting session writes the record and commits it. That is its whole output.

## 1. Name the file

`docs/meetings/YYYY-MM-DD-<who>-<topic>.md`. The date is the **meeting's** date (from the
transcript header), not today's. If the notes carry no date, use the day they arrived and say
so in the first paragraph. This is the reverse of Gridline's numbered files: `CLAUDE.md` fixes
dated names here.

```bash
ls docs/meetings/ | grep "^YYYY-MM-DD"
```

Read the filesystem, not git. Another session may have already filed the same call
(the checkout is shared). If a file for that date and topic exists, extend it rather than
writing a second one.

## 2. House format

Match the newest notes (`2026-09-14-carla-qc-start-and-offboarded-scoring.md`,
`2026-09-28-carla-termination-letters-blocked.md`):

```markdown
# YYYY-MM-DD: <who>: <dominant topic or "N asks across X, Y, Z">

<1 paragraph: when, who, how long, source (transcript / relayed notes), and what changed>

## Summary
## <one H2 per substantive thread, naming the surface and the Open item number when there is one>
   - What was said (keep the real quote)
   - What is true in the repo / DB (measured, with file:line or "NOT verified, because …")
   - What it needs: blueprint / hardening / Kane's ruling / an outside party
## Decisions made on the call
## Open questions
## Action items                    <- table: # | Owner | Action | Status
## Reference notes                 <- garbles, names, superseded notes, what was not checked
```

- **Summary** leads with what changed and what is now owed, not with who spoke first.
- **Topic sections** carry the surface name and Open item number in the heading
  (`## Accounting Scoreboard: Chargebacks negatives (item 392)`), so the file is greppable.
- **Decisions made** holds only what was actually decided on the call, and by whom. Kane saying
  "yeah" to an ask is acceptance of the ask, not a design ruling. Provisional direction goes in
  the topic section, marked provisional.
- **Action items** need a real owner per row (Kane, Carla, Alivia, an outside party by name).
  Use `Waiting (Ralph)` style statuses rather than dropping a row whose owner is outside.

## 3. Writing rules

- **Keep the real quote.** Carla's phrasing carries information that paraphrase destroys, and it
  is how she recognises her own asks later. *"Three is like bottom. Two is like wow. One is
  perfect."* beats "target under three minutes".
- **No em dashes in the new note** (Kane's standing style rule from Gridline). Use commas,
  colons, parentheses or a full stop. Do not retrofit older notes.
- **Fix garbles, then record them.** Google Meet transcripts mangle names. Correct them in the
  body and list the mapping in Reference notes. Seen so far: Kenchin / Kension / Kenshin =
  Kentshin; Olivia = Alivia (aliviah@); Areola = Arriola; "HR" / "HRS" on screen = the HRIS;
  Christine = Kristine; Joanna = Joana; "prearm" / "pre-arpetration" = pre-arbitration;
  "the global master list service account" = the HRIS Google service account. When a garble
  cannot be resolved, write the transcript's form in quotes and say it is unresolved.
- **Keep personal detail out.** The repo has been public (Open item 307). First names as the
  existing notes use them; no personal emails, bank details, pay amounts tied to a named person,
  or family details. A money figure goes in only at the level it was spoken (a team total).
- **Mark unverified claims as unverified.** What anyone says on a call about the system's state
  is a recollection. Kane's *"it's already connected"* is a claim until a `git log`, a code read
  or a read-only probe says so. Write the claim, then the measurement, or "NOT verified" and why.
  Never put a recollection into Open items or memory as established state.
- **Check every ask against the documented rules.** Read the surface's memory file and feature
  doc. When an ask contradicts a documented rule or a `CHOSEN` line, write it down as a
  contradiction with both sides quoted. **Never pick a side in the note.** That is `hardening`'s
  hard stop, raised early.
- **Money is never decided in a note.** Any ask that changes what someone is paid becomes an
  `OPEN MONEY` Open item, owned by Kane.
- **Cross-link** sibling meetings and the surfaces' docs with relative links, and earlier Open
  items by number.

## 4. Reconcile (do not skip)

For every surface the call touched:

| What happened on the call | What the record needs |
|---|---|
| A new thing was asked for | One Open item naming it as a `blueprint` build, with its `NEEDS` (values only Kane or an outside party holds) listed. |
| A change to a shipped surface was asked for | One Open item naming it as a `hardening` change, with any documented rule it collides with. |
| An existing Open item was answered, overtaken or contradicted | A dated correction on that item (strikethrough plus **Superseded YYYY-MM-DD**, never deletion) **and** a pointer from the new row. |
| Someone said something is done or broken | Verify cheaply (`git log`, `git rev-list --count origin/main..main`, a code read). Record the measurement. If the check is a production read and it is refused, say NOT verified and leave the probe for Kane. Do not route around the refusal. |
| A ruling now sits with someone outside (Ralph, Kentshin, Rainer, OMS) | Name them and what they owe, so a later reader does not treat it as merely unasked. |
| A money question came up | `OPEN MONEY` row. Never a number picked from the call. |

Open items go in the newest session log's table, numbered after the current last row. Re-read
the tail **immediately before writing**: other sessions append to the same table. If the newest
log is days old **and** no session has appended to it recently, start a new log (`CLAUDE.md`).

Then:

- **`docs/README.md` § meetings**: one row, newest first, with a bold date and a one-paragraph
  lead naming the asks, the findings and the contradictions.
- **`docs/features/INDEX.md`**: add `[[YYYY-MM-DD-<slug>]]` to the docs column of every row the
  call touched.
- **Memory**: a short paragraph on each touched surface's memory file (dated, with the item
  number), plus one entry for the meeting itself if it carries findings, and a `MEMORY.md` line.
  Hooks are pointers: put the state in the file, not the hook.

## 5. Do not touch

- **Code.** Nothing gets built in a meeting session, however small the ask looks.
- **Older notes.** Do not retrofit new conventions onto existing meeting files.
- **The database.** Probes are read-only (`CLAUDE.md` § Data), and only when allowed.

## 6. Commit

`git status`, then stage by explicit path (the note, `docs/README.md`, `docs/features/INDEX.md`,
the session log) and commit to `main`: `docs(meetings): YYYY-MM-DD <who>: <gist> (items N–M)`.
Never push. Memory lives outside the repo and is not committed.

## Checklist

Create one todo per item:

- [ ] Take the meeting's date from the transcript; list `docs/meetings/` for that date
- [ ] Write the note in house format: real quotes, no em dashes, no personal detail
- [ ] Record garbles, names and unchecked claims in Reference notes
- [ ] List every surface and every Open item the call touched
- [ ] Read each surface's memory file and feature doc; flag every ask that contradicts a documented rule
- [ ] Verify what is cheap to verify; mark the rest NOT verified with the reason
- [ ] Add Open items rows (re-read the table's tail first) and dated corrections on overtaken items
- [ ] `docs/README.md` row, INDEX wikilinks, memory paragraphs + `MEMORY.md` line
- [ ] Commit by explicit path; do not push
