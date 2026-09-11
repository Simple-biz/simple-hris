# Gift Tracker — the tenure-gift fulfilment ledger

**HRIS is the ledger of record for who has and has not received a tenure gift, as
of 2026-09-11.** Before today it was not, and could not be: the only lifecycle on
`employee_gift_shipping_details` is *address review*, and `Approve` there has
never meant "gifted". The answer lived in a Google Sheet.

Shipped 2026-09-11 on Kane's ruling (brief options 1(b) · 2(b) · 3(a)).

## The question this exists to answer

> *"We need to get caught up on who has and hasn't received a gift so that the HR
> is correct."* — Carla, 2026-09-09

That question had **no column to read**. The Gift Tracker computed who was *due*
a gift from tenure arithmetic and stopped there; nobody had any affordance in
HRIS to record "I shipped this", so the tracker looked stale no matter how hard
the person maintaining the sheet was chased.

## Key files

| Piece | File |
| --- | --- |
| Migration | `references/sql/migrate/2026-09-11_gift_receipts.sql` |
| Migration runner | `scripts/apply-gift-receipts-migration.mts` |
| Sheet backfill | `scripts/backfill-gift-receipts.mts` |
| Submissions wipe | `scripts/drop-gift-shipping-submissions.mts` |
| State logic (shared) | `src/lib/gift-tracker/receipts.ts` + `receipts.test.ts` |
| Sheet parser | `src/lib/gift-tracker/receipt-import.ts` + `receipt-import.test.ts` |
| Data access | `src/lib/supabase/employee-gift-receipts.ts` |
| Route | `app/api/employee-gift-receipts/route.ts` |
| Sheet-to-roster resolver | `src/lib/gift-tracker/roster-match.ts` + `roster-match.test.ts` |
| Key-drift detector | `scripts/audit-gift-receipt-key-drift.mts` |
| Key repair (move, not re-import) | `scripts/repair-gift-receipt-keys.mts` |
| Tab cache | `src/lib/orphanage/tab-cache.ts` + `tab-cache.test.ts` |
| UI | `src/components/orphanage/GiftTracker.tsx` |
| Export columns | `src/lib/gift-tracker/shipping-export.ts` |

## A row is an assertion. No row means UNKNOWN.

This is the whole invariant, and every reader has to honour it.

| State | What it means | How it is stored |
| --- | --- | --- |
| `received` | Somebody stated the gift was given | row, `received = true` |
| `owed` | The milestone has come due **and** somebody stated it was not given | row, `received = false` |
| `not_due` | The milestone has not arrived | no row needed — derived |
| `unknown` | Nobody has stated anything about a milestone that HAS come due | **no row** |

`unknown` is load-bearing. **239 people on the active roster were absent from the
source sheet entirely.** Reading their absence as "not received" invents a
239-person backlog; reading it as "received" hides a real one. Neither is true,
so `GiftReceiptState` refuses to say either, and the UI labels it *Not recorded*
in neutral grey — never amber, which would read as a milder shade of owed rather
than as a different question.

`received` is `BOOLEAN NOT NULL` in the database for the same reason: if the
column were nullable, "nobody said" would be representable *both* as a row and as
an absence, and the two would immediately drift apart.

**Owed and not-recorded are never summed.** The roster cell, the stat tiles and
the export all carry them as separate counts, because one is a debt the company
knows about and the other is a question nobody has answered.

## The key is `work_email`, and that is not cosmetic

`employee_gift_shipping_details` is `UNIQUE (personal_email, milestone_index)`.
On the live roster **`personal_email` is not injective**:

- `russell@simple.biz` and `johnc@simple.biz` both carry `corpuzmachacon@gmail.com`;
- `greyg@simple.biz` has no personal email at all.

Putting fulfilment on the submissions table would have merged two people's gift
history into one row and given a third person nowhere to live. Work email is
unique across all 1,229 sheet rows and across the master list, and it is the
column the source file keys on. So fulfilment lives in **its own table**, keyed on
work email, joined to the roster the way `gift_tracker_notes` is.

`shipping-export.test.ts` pins this: a receipt keyed on someone's *personal*
email does not count, and two people sharing one personal email keep separate
histories.

## Due-ness has exactly one implementation

`isMilestoneDue` in `src/lib/gift-tracker/receipts.ts`, over `addMonths` /
`diffDays` from `gift-milestones.ts`. The importer, the route, the roster and the
export all call it. An imported `owed` and a displayed `owed` therefore cannot
diverge.

`milestoneLabel` moved **into `gift-milestones.ts`** in this change — it had been
living only in `shipping-export.ts`, and the ledger needed it too. The export
keeps a thin wrapper that owns the `None yet` display case and delegates for the
rest. Two spellings of "12-month" was not a risk worth taking.

`source_milestone_date` on the table records what the *sheet* claimed, as
evidence. It is named `source_*` precisely so it can never be mistaken for a
second date rule. **Which milestone is due is always recomputed.**

## The 2026-09-11 backfill

Source: `references/docs/Work Anniversary Gift Tracker - Copy of HRIS Active Ppl.csv`
(1,229 people × 8 milestone columns = 9,832 cells).

| | |
| --- | --- |
| Rows written | **1,434** |
| … recorded received | 842 |
| … recorded owed | **592** ← the backlog, first time it has ever been countable |
| Cells deliberately skipped | 8,398 |

### Why 8,398 cells were skipped

They are `No` against a milestone **years in the future**. That is the
spreadsheet's default fill, not a statement anybody made. Importing them would
have put almost the whole company on the owed list and made the number
meaningless.

The rule, enforced in `selectAssertions` and unit-tested:

- **`Yes` always imports** — a stated receipt is a fact whether or not the
  milestone has arrived. One cell in the file is exactly that
  (`rhysl@simple.biz`, 12-month, dated 2027-01-05); it imports and is flagged
  *Recorded early* rather than dropped.
- **`No` imports only when the milestone has already come due.**
- **Anything else imports nothing**, and is reported.

### Who resolved to what

| | As first run (work email only) | After the resolver |
| --- | --- | --- |
| On the active roster | 1,121 | **1,130** |
| Offboarded (in `global_master_list`, not `active_employees`) | 95 | 99 |
| **No master row at all** | **13** | **0** |
| Resolved by a fallback tier | — | 13 (6 alternate email · 7 name+start date) |
| Ambiguous — imported for nobody | — | 0 |

The first run matched on `work_email` alone and left 13 people unresolved, whose
receipts were then stored under an address the roster never looks up. That is the
key-drift bug below; the resolver closes it and the same file now resolves
everyone. (The active/offboarded split moved by a few because people offboarded
between the two runs, not because anything was rematched.)

**Off-roster people are imported, not dropped.** A person who left owed a gift is
exactly the blind spot this feature exists to close, and it mirrors the export's
standing rule that off-roster submitters are appended flagged.

### Data defects carried forward, not silently fixed

- **Start-date divergence (2):** `masa@` sheet 2026-08-02 vs master 2026-09-07;
  `jant@` sheet 2026-08-09 vs master 2026-03-23. **The master list wins** — it
  owns `start_date`. Both are reported every run.
- **Gift-date divergence (3 cells):** the sheet says Mar 30 where HRIS says
  Mar 31 (month-end rollover on a Sep 30 start). HRIS math wins; the sheet's date
  is kept in `source_milestone_date`.
- **One early receipt** and **7 people with a `Yes` after a `No`** — imported as
  stated and reported. The importer does not straighten out somebody else's
  bookkeeping.

## Recording fulfilment from the app

Gift Tracker → Roster → expand a person. Each reached milestone carries
**Received · Not yet · Clear**.

Three buttons, not a two-state toggle, because there are three statements.
"Clear" withdraws the assertion and returns the milestone to `unknown` — *"we
should not have said anything"* and *"they did not get it"* are different claims,
and only the second one puts a named person on the owed list. Collapsing the
third into the absence of the other two would leave no way to undo a mistake
without asserting its opposite.

The local map updates **only after the server accepts the write**. An optimistic
flip would show a gift as delivered on a failed request, on the very screen HR
reads to decide whether to ship one.

## The employee's own view — and the label that was lying

`src/components/employee/GiftShippingCard.tsx` → **History** tab.

The timeline already printed a green **"Received"** chip. It meant
`status === 'approved'` on `employee_gift_shipping_details` — **the address was
confirmed**, which the code beside it says explicitly does not mean gifted. A
person whose address was locked in was told their gift had arrived.

Fixed 2026-09-11, and the two facts are now drawn apart everywhere on that
timeline:

| Chip | Source | Means |
| --- | --- | --- |
| **Address confirmed** (sky) | `employee_gift_shipping_details.status = 'approved'` | we have your delivery details locked in |
| **Gift received** (emerald) | `employee_gift_receipts.received = true` | it actually reached you |
| **Gift on the way** (amber) | `received = false` on a due milestone | we owe you this one |
| *(nothing)* | no receipt row | nobody has recorded it yet |

The node, the connector line and the heading colour all follow **fulfilment**
now; an approved address is sky, a step rather than an end. A milestone nobody
has recorded renders **no fulfilment chip at all** — silence is honest, and a
grey "not received" would not be.

The card reads `GET /api/employee-gift-receipts?work_email=…`, gated
self-or-staff by the same predicate `employee-gift-shipping` uses, so the two
gift surfaces cannot drift apart on who sees what. **The employee can never
write** — declaring your own gift received is a statement about the company's
obligation to you, so `PUT` and `DELETE` stay on `requireFeatureEdit`.

A failed receipts fetch is **deliberately silent**: the timeline still renders
and every milestone simply reads as unrecorded. It must never fail closed into
"not received", so the fallback is an empty map, never a map of falses.

**The shipping form's gate is untouched.** It still opens on pure tenure
arithmetic suppressed by an existing submission row. Wiring it to fulfilment
needs a ruling first — the export's `Current Milestone` and the employee's own
form must never disagree.

## The key-drift bug, and the resolver that closes it

**Found 2026-09-11, hours after the backfill.** Kane: *"lennyt@simple.biz seems to
have the wrong data… she only did not receive the last one which was april 10, 2026."*

The sheet and the ledger were both **right**. `lennyt@simple.biz` held exactly six
rows — five received, and the 2026-04-10 (36-month) gift recorded as missed. The
Gift Tracker showed her none of it, because she is on the roster as
**`lenny@simple.biz`**. The backfill had matched the sheet against the master list
on `work_email` **alone**, so thirteen people whose sheet spelling differs were
stored under an address the roster never looks up.

**The failure read as its own opposite.** The tracker keys each roster row on the
master list's `work_email`, found nothing, and rendered every due milestone as
*Not recorded* — the state that means *nobody has assessed this person*. So the
screen said "we have never looked at Lenny" when what had actually happened is
that we knew precisely what she was owed and filed it under the wrong name.
52 receipt rows across 13 people were invisible this way.

### The ladder

`src/lib/gift-tracker/roster-match.ts`, shared by the importer and the repair
script so they cannot resolve differently:

| Tier | Match on |
| --- | --- |
| 1 | `work_email` exact |
| 2 | **`employee_id`** exact |
| 3 | **alternate work email** exact |
| 4 | legal **name AND start date**, both exact |

Kane's suggestion — *"if somebody is similar then we can use their start dates to
match them up"* — is tier 4, with the safeguards that make it safe to run
unattended.

`employee_id` sits above the email tiers because it is unique across all 2,698
master rows, needs no name normalisation, and on the live data resolves every
stranded person on its own. It is deliberately used **only** to match the sheet
against the master list, the two sources that agree on it (1,211 of 1,216
resolvable rows); the `employee_ids` table is regenerated per upload and
disagrees for a handful of people, so it is not a durable cross-system key.

### An ambiguous tier falls through to a STRICTER key, never a looser one

Stopping dead on ambiguity was too blunt. Thirteen sheet rows land on an address
two master rows claim: four are genuinely **two different humans** sharing one
address (`jamesc@` is both Ceballos, James Ryan and Chan, James Edward;
`markg@`, `jant@` and `rodneys@` likewise), and nine are **one person with two
master rows** whose name is spelled differently across them (`Montano`/`Montaño`,
a middle initial, a stray smart quote). Refusing all thirteen imported nothing
for people the sheet identifies perfectly well.

So an ambiguous tier is narrowed by an exact key — `employee_id`, else name AND
start date — and accepted **only if exactly one candidate survives**. The
narrowing never widens the set and never reaches outside it; a test pins that an
employee id belonging to a non-candidate leaves the tier refused.

### A tier-1 hit on a stale row is not an answer

This is the trap a work-email-only ladder cannot see, because tier 1 *succeeds*
and nothing falls through. `global_master_list` carries **216 rows absent from
`active_employees` with no off-board date** — ghosts. Two of them hold receipts
for people sitting on the active roster right now:

| stranded key | rows | actually | active at |
| --- | --- | --- | --- |
| `teodya@simple.biz` | 4 | Amaro, Teody | `james@simple.biz` |
| `mat@simple.biz` | 2 (**both owed**) | Tanjusay, Maria Fe | `maria@simple.biz` |

When tier 1 matches a person who is **not** on the active roster the ladder keeps
walking, and exactly one live row for the same human at a later tier wins, with
the abandoned key reported as `supersededStaleKey`. A genuinely offboarded person
still keeps their own key — this rule finds live people behind ghosts, it does
not strand leavers.

**The true count was 15 people / 58 rows, not 13 / 52.** The two extra were found
by an adversarial review pass, not by the original audit, whose orphan test was
"has no master row" and therefore called a ghost healthy.

### Duplicate master rows collapse; recycled addresses do not

`buildRosterIndex` collapses two rows only when the **work email, name and start
date all agree** — one person imported twice. `teodya@` has exactly that (two
rows, two employee ids). But `tinag@`/`tina@` (Garces, Cristina — same name, same
start date, two *active* addresses) and `josephr@` (Robles then Ramos — one
address, two humans) must stay separate: the first because the rows disagree
about where to store, the second because they are different people.

**Pass every master row — never a Map keyed on work email.** A caller that
dedupes before building the index has already discarded the collisions the index
exists to report, and the resolver will then call an ambiguous key unambiguous.
Both scripts were doing this and were fixed.

### The work-email column contains things that are not email addresses

`global_master_list` really holds `"waiting on ppwk"` and
`"issues with automation"` as Work Email values. `isEmailShaped` refuses them, so
a person's gift history can never be stored under the key
`issues with automation`.

**Every tier is an EXACT match. There is no fuzzy string distance anywhere**, and
that is deliberate: `lenny@`/`lennyt@` and `jo@`/`joe@` are the same edit distance
apart, and one of those pairs is two different people. Similarity proposes
nothing; only exact agreement on an independent field does.

**Ambiguity is a refusal, never a pick.** A tier producing two candidates stops
the ladder outright — it does not fall through to a looser tier and it does not
choose. Merging two people's gift history is permanent and silent; an unresolved
row is visible and recoverable. The backfill reports refusals and imports nothing
for them.

**`personal_email` is deliberately not a matching key.** It is not injective on
this roster — `russell@simple.biz` and `johnc@simple.biz` share
`corpuzmachacon@gmail.com` — so matching on it would fuse exactly the two people
the storage key exists to keep apart.

**Name alone and start date alone are both refused.** A whole onboarding cohort
shares a start date, and names repeat; tier 3 needs both, and still refuses when
two rows satisfy both.

### The date comparison does not go through `Date`, and that is the point

`normStartDate` builds its comparison key from the string's own digits.
`parseStartDate` reads a date-only ISO string (`2023-04-10`) as **UTC** midnight
but an `M/D/YY` string (`4/10/23`) as **local** midnight — so west of UTC the two
spellings of one day normalise a day apart, and tier 3 would silently fail on
people whose dates actually agree. The master list holds `4/10/23`. A unit test
pins all four spellings to one key.

This is **not** a second milestone-date rule and must not become one: nothing in
it computes a milestone, a due-ness or a gift date. Only the spellings this
roster actually holds are accepted, and **anything else is refused** rather than
guessed — that costs a match instead of inventing one.

### Repairing what is already stored

`scripts/repair-gift-receipt-keys.mts` (report-only by default) **moves** the
orphaned rows onto the master address rather than deleting and re-importing them,
so `recorded_at`, `recorded_by`, `source` and `source_file` survive — the reason
those columns are `NOT NULL` in the first place. It refuses on ambiguity and
refuses on collision (a destination that already holds that milestone is a human
reconciliation, never an auto-merge), writes and **reads back** a backup before
touching anything, and writes `gift_receipt.rekeyed` into `audit_log` *before* the
update. Live: 13 keys, 52 rows, **0 refusals**.

Detector for the same class, safe to re-run any time:
`scripts/audit-gift-receipt-key-drift.mts` — it reports orphaned, misattributed
and start-date-drifted keys **separately and never netted**, and a proposed
candidate is printed as evidence, never applied.

## The fulfilment filter, and the order list

Roster toolbar → **All · We owe · Not recorded · Received**, counted in people.

**"We owe" is the order-processing view.** The Export menu reads the same
`filteredRows` the table does, so choosing *We owe* and exporting produces the
order list in CSV, XLSX or PDF with no second export path to drift out of step
with the screen. The provenance preamble stamps the filter into the file
(`Employees owed a gift`) — a file containing only the people we owe, labelled
"All employees", misreports its own scope to whoever places the orders.

**"Not recorded" is a separate option and is never rolled into "We owe."** Those
are people nobody has assessed; folding them in would inflate the order list with
people who may already have their gift. Same reason the counts are never summed.

Changing the filter resets paging — narrowing to *We owe* while on page 4 would
otherwise show an empty table, which reads as "nobody is owed".

## Caching: the tab stops re-hitting the database

`src/lib/orphanage/tab-cache.ts`, modelled on the shipped `src/lib/hr/tab-cache.ts`.

One visit to the Gift Tracker pulled the full master list, every note, every
submission and the whole ledger — four `no-store` round trips — and the Orphanage
shell unmounts a tab when you leave it, so every return paid for all four again
and re-flashed the skeleton.

**PAINT and SKIP are different questions, and collapsing them is the regression:**

- `hasOrphanageTabCache` — is there something to **paint**? (skeleton or not)
- `isOrphanageTabCacheFresh` — may the fetch be **skipped**? (30s window)

A warm-but-stale entry still paints, and the consumer revalidates **silently**
behind it — no loading flag, no blanked rows, and no error card thrown across
data already on screen. Merging the two predicates is exactly the HR bug of
2026-09-09, where a session left open all day never re-pulled anything.

All four datasets must be fresh to skip: a stale ledger beside a fresh roster
would show the right people with the wrong gift state.

**Every write invalidates the surface** (`clearOrphanageTabCachePrefix`), because
recording a gift as received and then seeing it repaint as owed is worse than a
slow tab. Manual Refresh drops the cache *first*, so a failed fetch cannot leave a
pre-refresh value sitting there looking fresh.

**In-memory only, and that is load-bearing.** No `sessionStorage`, no
`localStorage`, therefore no identity stamp — which is safe *solely* because the
store dies with the page. Making it survive reloads without first adding the
Accounting store's identity envelope would leak one Orphanage user's roster,
addresses and gift backlog to the next person on that browser tab. A test greps
the module so that change fails loudly.

Do **not** reach for Realtime here: browser `postgres_changes` is documented dead
for this project (RLS with no anon policy — a channel reports SUBSCRIBED and never
delivers). Bounding the staleness is the fix; "add the table to the publication"
is a security decision for Kane.

## Sub-tab transition

The three panels shared a symmetric 250ms in *and* out under `mode="wait"`, so
half a second passed with nothing on screen and the container collapsed to zero
height in the gap — the jump that made switching tabs feel broken rather than
animated. They also moved on Y, which reads as content reloading rather than as
lateral movement between siblings.

Now one shared variant set: the panel travels on **X in the direction the tab bar
moved** (derived from tab order at click time, so Roster → Catalog always slides
the same way), and the **exit is half the entrance** (130ms vs 260ms) with
asymmetric easing — the outgoing panel accelerates away, the incoming one
decelerates in. Reduced motion keeps the cross-fade and drops only the travel;
removing the transition entirely would make the swap read as a flicker.

## Authorization and audit

`route-access.ts` gates pages, not APIs, so this route enforces its own:
`view` on `(hr, gift_tracker)` to read, `edit` for every write.

**The actor is the session, never the body** — `recorded_by` comes from the
resolved `AuthzOk`. Six gift/orphanage routes previously read an actor off the
request body, which is a forged identity.

`recorded_by` is `NOT NULL` with a non-blank CHECK. The PAB-exclusion table
shipped without an author column and 107 person-months are permanently
unattributable as a result; that is not being repeated here.

Audit family `gift_receipt.` (registered in `src/lib/audit/registry.ts`):

| Action | When |
| --- | --- |
| `gift_receipt.recorded` | a staff member states a gift was / was not given |
| `gift_receipt.withdrawn` | an assertion is removed — **details carry the deleted row**, because nothing else records it was ever made |
| `gift_receipt.imported` | the sheet backfill |

It is deliberately separate from `employee_gift_shipping.*`, which is address
review and still does not mean "gifted".

## The submissions were dropped

43 rows (42 pending, 1 approved) were deleted on the same day, per Kane's ruling
— the tracker starts fresh. `scripts/drop-gift-shipping-submissions.mts` writes
every row to disk **and reads the file back to verify it** before deleting
anything, then writes the full snapshot into `audit_log`
(`employee_gift_shipping.period_cleared`) *before* the delete, because the trail
write needs the rows while they still exist. A failed backup or a failed audit
write aborts.

What that cost, stated plainly: every export row now falls back to the
master-list home address (`Address Source` reads `Master list`, never
`Submitted`), off-roster submitters vanish from the appended block until people
submit again, and the one approved row's lock is gone. **No fulfilment was lost**
— it lives in a different table, which is the reason the delete was survivable.

Backup: `reports/gift-shipping-submissions-backup-*.json`.

## Deploy order

1. `node --import tsx scripts/apply-gift-receipts-migration.mts` — rehearses and rolls back.
2. Same with `--apply`.
3. `node --import tsx scripts/backfill-gift-receipts.mts` — report only.
4. Same with `--apply`.
5. `node --import tsx scripts/drop-gift-shipping-submissions.mts --apply`.
6. Deploy the code.

**The migration SQL carries no `BEGIN`/`COMMIT`.** The apply script owns the
transaction; a `COMMIT` inside the file ends it from within, so the rehearsal
commits to production and the script's own `ROLLBACK` has nothing left to undo.
This was found the hard way on 2026-09-11 — the first "dry run" created the table
for real. Every sibling migration under `references/sql/migrate/` omits them for
the same reason. The rollback is now proven: the table is absent after a dry run.

## Found by the adversarial review, NOT fixed here

Three independent reviewers plus a completeness critic went over the 13 proposed
re-keys (0 refutations out of 39 votes). They surfaced five things that are
larger than the re-key and are **left open deliberately** — each needs a decision
or a separate brief, and each is written down so it is not rediscovered.

### The ledger covers the PH roster only — 57 active people have 365 unassessed milestones

**211 active roster rows have no sheet row at all** — not by work email, not by
alternate, not by name+start-date — because the source file is literally
*"HRIS Active Ppl"*. **57 of them have at least one milestone already due,
totalling 365 due milestones with zero assertions.** That is the entire
US/leadership/freelance side, including the people who asked for the tracker:
Thomas Arndt (17 due), Jeff Thibodeau / Destry Henson / Justin Weissman (13
each), Carla Thomas (10), Jackie Zapata (9).

They correctly render as *Not recorded* — nobody has assessed them — but the
honest statement is that this ledger answers the question for the PH roster, not
the company. Re-keying 15 people does not change that shape.

### 16 owed gifts sit on people the tracker cannot display

The backfill imported off-roster people on the stated grounds that *"a person who
left owed a gift is exactly the case the tracker could never see"*. The tracker's
roster is `/api/employees` → `active_employees`. **The blind spot was rebuilt.**
Nine offboarded keys carry 17 rows, **16 of them `received = false`** — several
offboarded within the last two weeks, so they are the recoverable cases. Either
the tracker needs an "Offboarded with an outstanding gift" view or the import
rule for leavers needs revisiting; writing rows nothing can read is the worst of
the three options.

### The 48-month ceiling: 56 milestones the source cannot state

The sheet carries eight milestone pairs (6 Mo … 48 Mo). **18 active people have
due milestones beyond index 8**, totalling 56 the file is structurally incapable
of asserting. The highest `milestone_index` anywhere in the ledger is 7. No
re-key or re-import changes this.

### The same key drift is live in nine other tables — and one of them is access control

The reviewers swept every table exposing a `work_email` column for the identical
signature (*key is not an active primary, but is an active person's alternate*):
`employee_skill_sets` 6 of 45 keys, `employee_ids` 10, `bank_update_history` 4,
`offboarded_sheet` 4, `hr_pending_employees` 2, `hr_onboarding_submissions` 2,
`bank_update_otps` 1 — and:

> **`warren@simple.biz` holds a live, un-revoked `manager` role** (assigned by
> `carla@`, `revoked_at: null`) **plus 21 feature-permission rows**, while
> **Seguis, Warren** is on the roster as `warrens@simple.biz` (10 permission
> rows). Verified directly against production.

Authentication survives this by accident — `auth-options.ts` runs
`expandWorkEmailAliases` before reading `employee_roles`. Three readers do not:
`hr/offboard-rbac.ts` revokes with a single-address `ilike`, so offboarding
Warren at `warrens@` would leave the `warren@` grant standing forever; and
`contractor-dispatch-queue.ts` and `documents/requests.ts` read the raw address
and would send notifications to it. **"Is this person a manager" currently has
two different answers depending on which code path asks.** This is Kane's call,
not a gift-tracker fix.

### Twenty-five work emails have been held by two different humans

`employee_gift_receipts` is `UNIQUE (work_email, milestone_index)`, and 25 work
emails on the master list carry rows with genuinely different names or start
dates — real recycling (`jamesc@`, `josephr@`, `rodneys@`, `markg@`, `jant@` …).
No receipts sit on a recycled address *today*, purely because only two of those
addresses have a holder past six months' tenure. That is a timing accident, not a
guard. The resolver now refuses these rather than picking, which converts a
silent wrong answer into a visible one — but the schema still cannot represent
two holders of one address.

### And the mechanism that caused all of this is still armed

The master-list sync overwrites `Work Email` in place with no history, so this
class recurs silently on every address change — `anonuevojo@` → `anonuevoj@` on
2026-08-03 is a live example, and there is no `audit_log` record of any of these
renames. `scripts/audit-gift-receipt-key-drift.mts` is the detector, but it is a
manual run. Nothing constrains `employee_gift_receipts.work_email` to a master
row.

## What is still open

- **The employee shipping form has no idea about fulfilment.** Its milestone gate
  is still pure tenure arithmetic suppressed by the existence of a submission
  row. Wiring it to receipts needs a decision first — the export's
  `Current Milestone` and the employee's own form must never disagree.
- **A missed milestone still has no ask path.** Only the latest milestone is ever
  asked for; earlier ones freeze read-only. A catch-up needing an old address
  cannot use the form, so the 592 owed gifts have no address-collection route.
- **No delegated grant.** Every write needs `hr / gift_tracker` edit; there is no
  documented grant for the people helping with the catch-up.

Sibling: [gift-tracker-shipping-export.md](gift-tracker-shipping-export.md) — the
roster export, which now carries the fulfilment columns.
