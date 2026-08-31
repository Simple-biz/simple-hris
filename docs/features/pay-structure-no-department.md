# Payment Catalog → Pay Structure → "No department"

**Status:** audit complete 2026-08-30, **no code change shipped**. Findings below are
measured against production, read-only. Script:
`scripts/audit-pay-structure-no-department.mts`.

Related: `bonus-catalog.md` §5.5 (the Pay Structure tree) · `hubstaff-zero-hours-gap.md`
(the same label drift, fixed on a different surface) · memory
[[pay-structure-department-members]] · [[payment-catalog-hides-offboarded]].

---

## 1. What the bucket is

"No department" is **not a department**. It is the residue of `railKeyForCell`
(`src/lib/payment-catalog/dept-rail.ts`): every active-roster person whose
`global_master_list` Department cell resolves to no rail entry lands here, plus every
pay-structure row whose owner the roster cannot place (`homeKeyForStructure`).

Both facts about it are already enforced in code, and neither may be "simplified" away:

- [BonusCatalog.tsx:2400](../../src/components/accounting/BonusCatalog.tsx#L2400) hides the
  **department pay-structure editor** for the bucket — a rate saved there would file
  `department_key='@no_department'` into the rate source of truth, where nothing resolves it.
- [BonusCatalog.tsx:2503](../../src/components/accounting/BonusCatalog.tsx#L2503) hides the
  **individual-rate adder** for the same reason. Existing rows stay editable; new ones must
  be added from a real department.

The consequence is the whole point of this doc: **being in this bucket means no rate can
reach you from this screen.**

## 2. Measured composition — 2026-08-30

61 rows resolve to the bucket; the tab renders **60**. Khyle Armea is hidden by the
catalog's off-board filter (stamped 2026-07-21). Josh Salud also carries a stamp
(2026-01-19) but has a 06/01/26 start date — a re-hire, correctly shown.

| Department cell | People |
|---|---|
| USEE | 26 |
| Site Building (US - Freelance) | 20 |
| Site Building (PH - Freelancer) | 13 |
| Orphan Ministry | 1 |
| Manager | 1 |

**60 rows is 59 humans** — see §3.3.

## 3. The four groups that do not belong

### 3.1 Site Building — 32 active people, invisible to the rate editor

`normalizeDeptToKey` knows the label `"site building"` and nothing else, so
`Site Building (US - Freelance)` and `Site Building (PH - Freelancer)` resolve to no rail
entry. **28 of the 33 still carry a stale bare `"Site Building"` GML row at the identical
start date** — that is a relabel, not a transfer.

Live effect: the Site Building rail entry holds **7 members** while its other 32 sit in
No department, where §1's two guards mean no Site Building rate can be set for them here.

**The repo already fixed this exact split on another surface.** `baseDeptLabel`
([hubstaff-reconciliation.ts:55-78](../../src/lib/payroll/hubstaff-reconciliation.ts#L55-L78))
strips the trailing parenthetical after the same rename broke Hubstaff reconciliation on
2026-08-09 — same 20/13 cohort split, same root cause. The catalog rail never got that
treatment. Its docstring is explicit that widening the base label is safe only because the
base still has to be one of five declared entries; any fix here must keep that property.

This is the fix to do first, and it goes through the `hardening` skill — it is a change to
an existing surface with an existing precedent, not a new build.

### 3.2 Ralfh Macapagal — "Orphan Ministry" — is on-channel and being paid now

Worked hours in 25 weekly files including the current one, ₱265 on the rates sheet, 8 Wise
dispatches, latest **₱15,329.92 on 2026-08-27** for the 08-16→22 week.

`"Orphan Ministry"` exists nowhere in `DEPARTMENTS` or the alias map — only as a **retired
KPI key**. He is the one person in an off-channel bucket who is actively hourly-paid, so
his cell is wrong, not his pay. **Kane's call which department he belongs to.**

### 3.3 Seungyong Lee is in the bucket twice

| Email | Cell | Evidence |
|---|---|---|
| `seungyong@simple.biz` | literally `"Manager"` | no start date, no hours, no dispatches, holds a $16 USD `us_manager_bonus` structure |
| `seungyongl@simple.biz` | USEE | hours every week |

Both GML rows are ACTIVE. `seungyong@` is **already blocklisted** as the retired US Manager
seat in `HUBSTAFF_RECON_EXCLUDED_EMAILS` — the app knows it is noise; the rail does not.
Same class as [[maria-argote-split-identity]]: one human, two live identities.

### 3.4 The 26 USEE do belong

Off-channel by design; their last pipeline dispatches were 2026-06-14. Two exceptions:

- **Carla Thomas** — ₱175 rate row filed under "Lead Gen", plus a dispatch on 2026-08-14.
- **Jackie Zapata** — ₱175 across dozens of rate rows + an $18 USD structure. This is the
  known `jackie@ USD bonus stranded` item from [[kpi-calculator-retired-depts]].

## 4. Most of the bucket is not people at all

Beyond the member list the bucket holds **120 individual rate rows, 111 of them belonging
to nobody the roster can place** — leavers and retired addresses (Van Ortiz, Kimer Lauron,
Bea Olarte, …).

That is `homeKeyForStructure` refusing to park a ghost on a real department, **working as
designed** ([[pay-structure-department-members]]: an unresolvable owner goes to
"No department", never the stored key, because a department row is a claim about a real
person). Do not "clean this up" by re-homing them — the rows are the evidence.

## 5. Rules this audit establishes

1. **A cohort qualifier in a Department cell is a relabel, not a transfer.** Look for a
   sibling GML row at the identical start date before treating it as a move.
2. **The catalog rail's label resolution is stricter than Hubstaff's.** `baseDeptLabel`
   exists on one surface only; the rail does exact-match. Any new parenthetical dept label
   silently drops its people into No department.
3. **"No department" population is a rate-visibility alarm, not cosmetics.** §1's guards
   mean anyone parked here cannot be priced from this screen.
4. **Row count ≠ headcount here.** Duplicate identities and ghost rate rows both inflate it;
   the audit script separates the three populations.

## 6. Re-running it

```
npx tsx scripts/audit-pay-structure-no-department.mts
```

Strictly read-only — no insert/update/delete/upsert. It reproduces the tab exactly (same
`active_employees` view, same `buildRoster` dedupe, same rail, same `assignRosterToRail`)
by importing the **shipped** modules rather than copying them, then goes back to
`global_master_list` for every row each person owns so a second row carrying a real
department shows up as the finding.

## 7. Open — Kane's call

- [ ] Site Building: apply the `baseDeptLabel` treatment to the catalog rail (32 people).
- [ ] Ralfh Macapagal: which department replaces "Orphan Ministry".
- [ ] `seungyong@simple.biz`: retire the duplicate GML row, or accept it as noise.
- [ ] Jackie Zapata / Carla Thomas: the stranded USD structures.
