# 2026-09-28 — Carla: Termination Letters refuse on missing info and don't say how to fix it

Relayed by Kane on 2026-09-28 as pasted notes. The meeting's own date was not stated; this file
is dated for the day the notes arrived. Surface: Accounting → Documents → Termination Letters.
The session first hard-stopped on two conflicts with documented rules. **Kane ruled the same day
("Docs are stale change it!"), choosing (b) on both, and the change was built and committed
locally** (Open items 245 and 248, [Sep 25 log](../audits/audit-2026-09-25-session-log.md)).

## What Carla said (the notes, verbatim)

> Carla expressed frustration that the HRIS blocks the creation of termination documents due to
> missing information without explaining how to fix the issues.
>
> - **Required Information:** They noted that they only need basic details to confirm a contract
>   has ended, including the start date, last team, last hourly rate, termination date, reason,
>   and a space for accounting to sign.
> - **System Flexibility:** They suggested the system should prompt for missing details so they
>   can manually fill them in, rather than preventing document generation altogether.
> - **Frequency:** They estimated that termination documents are only needed about two to three
>   times a month.

## What was true before this session (measured in code, 2026-09-28)

- **The letter already carries her six items.** Start date, department at departure ("last
  team"), ending rate ("last hourly rate"), termination date, reason, and the generating rep's
  saved signature, drawn in at generation (`termination-document.ts:541-604`). There is no blank
  line for a wet signature. The page is signed when it is generated (G9).
- **A missing fact is supposed to be an input, not a refusal.** That is decision 2 of the build
  plan (`docs/superpowers/plans/2026-08-31-termination-docs.md:20-24`, "Prompt, never refuse"),
  and it is what the facts sheet does for all six blank fields.
- **Only three facts are required, but the panel requires all six.** The route treats
  termination date, reason and department as required (`termination-route-rules.ts:150-154`).
  The PDF prints with no start date (`termination-document.ts:546-547`) and with an ending rate
  alone (`:569-570`). The panel, however, marks every blank "Required — the letter cannot be
  generated while this is blank" (`TerminationDocsPanel.tsx:326`). For an old leaver with no
  digital hire record (`no_hire_record`), that means typing a **starting rate**, which Carla says
  she does not need and usually cannot find. The frozen contract agrees with the panel:
  "`amount === null` means BLANK — the rep must fill it" (contract `:198`).
- **The most likely refusal is `no_master`, and its copy gives an impossible fix.** The master
  list begins on 2026-04-21, so about **2,532** ledger addresses that left earlier have no
  `global_master_list` row. They are refused at `termination-arbitration.ts:705-710` (measured
  2026-09-23, `documents-tab.md:633-670`). The panel tells the rep "HR has to repair the roster
  row first" (`TerminationDocsPanel.tsx:151`). HR cannot do that, and re-adding the person to
  the sheet makes them ACTIVE. The only repair is `scripts/insert-ledger-only-master-row.mts`,
  which runs once per person and needs Kane to apply it. That is Open item **191(b)/(c)**, still
  open. At 2–3 letters a month, many requests will be for these older leavers.
- **Refusals are not logged.** The route writes an audit row only when a letter is generated
  (`src/lib/audit/registry.ts:213`). So which refusal Carla actually saw cannot be measured. It
  is inferred from the shape of her complaint ("missing information").

## What is NOT reopened

The **T4 hours refusal stands.** A recent leaver who still has hours in the newest uploaded
timesheet is refused for about one cycle. Carla asked for the letter to be issued anyway on
2026-09-16, and Kane declined (memory `termination-docs.md:57-73`). Only the wording was changed:
it now names the week and says when the refusal will clear. The request "rather than preventing
document generation altogether" does not override that ruling. If Kane wants it revisited, that
is a new ruling.

## Decision (Kane, 2026-09-28): the docs were stale on both points

1. **Ledger-only leavers are documented from the ledger.** When no master row has the address as
   its work email, the tab builds the facts sheet from `offboarded_sheet` instead of refusing
   `no_master`. Every other refusal still applies. New refusals were added for what the roster can
   no longer vouch for: the address on another master row, the ledger's personal inbox on a live
   row, and ledger rows that name two people. There is no write-back, because there is no master
   row to write into. `no_master` now means that neither the roster nor the ledger has a row, and
   its copy no longer sends anyone to HR.
2. **The starting rate is optional.** The letter prints the ending rate alone. The start date and
   the ending rate stay required, as Carla listed them.

Measured after the change (read-only, 2026-09-28, hours not checked): **1,550 of the 2,567
ledger-only work emails now reach a facts sheet.** Almost all of them need the department and the
start date typed (the ledger rarely holds either).

## New finding: 832 ledger-only leavers still refuse on the ledger's own labels

`not_a_departure` refuses 832 of them because the ledger's labels are not on the seven-reason
allowlist. The labels are "No Show" 351, "No Show During Orientation" 279, "Policy Violation" 116,
"Declined Offer" 42, "Productivity" 16, and a tail. The allowlist is a ruling, so nothing was
mapped. Whether "Policy Violation" or "Productivity" should read as a departure reason, and whether
someone who never started should get a letter at all, are Kane's calls (Open items 248).

## Gaps found

- `docs/features/termination-docs.md` was planned (plan task 8, `:148-152`) but was **never
  written**. The feature's rules live in the frozen contract, the INDEX row, the memory entry and
  `documents-tab.md` § ledger arm. This change updated those in place and did not write the missing
  doc (still OPEN, item 245).

Links: [[termination-docs]] · [[ledger-only-leaver-no-master-row]] ·
[documents-tab.md](../features/documents-tab.md) · Open items 191, 245, 248.
