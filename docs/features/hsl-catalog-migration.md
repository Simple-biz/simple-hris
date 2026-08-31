# HSL KPI Calculator → Payment Catalog (scoping only — NOT BUILT)

**Status: approved, scoped, and never built.** Kane approved an INERT migration on
2026-08-29 ("Code wise lets migrate it but not implement it yet dont wire it up yet").
`src/lib/hsl-bonus-catalog/` **does not exist on `main`** — verified 2026-08-31. Nothing in
this doc is shipped behaviour.

What survives is worth more than the build would have been: a 44-agent scoping pass plus
independent verification turned up **four facts about the live HSL bonus engine**, three of
which contradict something a governing doc or the codebase itself asserts.

Related: `hsl-kpi-calculator-2026-07.md` · `bonus-catalog.md` · `hsl-subdepartments.md` ·
memory [[kpi-calculator-autosave]] · [[hsl-bonus-weeks-never-submitted]] ·
[[rate-catalog-source-of-truth]] · [[ssd-medical-records-rfc-pool]].

---

## 1. The four findings (each reproduced independently, 2026-08-31)

### 1.1 The double-pay guard was RED — ~~FIXED 2026-08-31~~

```
BEFORE  ✖ the HSL family never enters the payable KPI set
          "executive_assistants" is in WIZARD_PAYABLE_KPI_DEPT_KEYS
           — it would be paid twice (catalog + HSL entries)
        tests 9 | pass 8 | fail 1

AFTER   ✔ the namespaced HSL family never enters the payable KPI set
        ✔ every bare HSL key colliding with a payable slug is a declared homonym
        ✔ each declared homonym is genuinely a separate department
        tests 11 | pass 11 | fail 0     (full src/lib suite: 1627/1627)
```

**It was the TEST that was wrong, not the payable set** — and the correct fix was the
opposite of the obvious one. The payable set holds **unnamespaced** slugs; an HSL
sub-dept only reaches a payable-key lookup as `hsl:<key>`. The old test iterated
**bare** `HSL_DEPT_KEYS`, so it compared an HSL sub-dept's bare key against an
unrelated in-app registry slug. Measured 2026-08-31: **1 of 14** bare keys collides
(`executive_assistants`), **0** namespaced `hsl:*` keys are payable, **0** family
labels are payable. The documented invariant held perfectly; the assertion did not
express it.

Subtracting `HSL_DEPT_KEYS` from the payable set — the intuitive fix — would have
removed the *legitimate* in-app `executive_assistants` card and stopped the wizard
reading weeks already scored under it: the exact "never narrow the payable set"
violation this file's §1.1 was written to warn about. It holds 0 applied rows today,
so the cost would have been zero *this week* and unbounded later.

The guard now pins the namespaced form (**previously untested — the real double-pay
vector had no coverage at all**) and the family labels, and forces any bare-key
collision to be **declared** in `KNOWN_DISTINCT_DEPT_HOMONYMS` with a justification.
All three assertions were mutation-tested: smuggling `hsl:intake_specialist` in fails
only the first, an undeclared bare `attestation` fails only the second, and
un-retiring the declared homonym fails only the third.

**The reason the old test had to change rather than the code:** it failed permanently,
so other sessions normalised it as "known red" — and a test that is always red catches
nothing. That normalisation was the actual hazard, as this file already said.

The original mechanism, still worth knowing:

- `WIZARD_PAYABLE_KPI_DEPT_KEYS` is `DEPT_INPUT_CONFIG` keys **∪**
  `KPI_CALCULATOR_RETIRED_DEPT_KEYS`
  ([department-bonus.ts:314-317](../../src/lib/payroll/department-bonus.ts#L314-L317)).
- `executive_assistants` sits in the retired set
  ([department-bonus.ts:269](../../src/lib/payroll/department-bonus.ts#L269)) — correct at
  the time, it *was* a retired in-app registry dept.
- It then became an **HSL sub-team** (`noKpi: true`, 2026-08-14, see
  `hsl-subdepartments.md` §7a). Retiring a calculator and adopting a dept into the HSL
  family are two independent edits in two files, and nothing couples them.

So the failure class is general: **any dept that is retired from the KPI calculator and
later adopted into HSL re-enters the payable set silently.** The test is the only tripwire
and it is currently failing, which means it can no longer catch the *next* one. Other
sessions have been reporting it as a known-red "pre-existing `kpi-calculator-depts`" —
that normalisation is the real hazard.

### 1.2 `medical_records` — the code pays ₱100, the doc says ₱250

| Source | Patient Portal Log Ins |
|---|---|
| [schema.ts:178](../../src/lib/hsl-bonus/schema.ts#L178) `{ type: 'per_unit', key: 'portal_login', rate: 100 }` | **₱100** |
| [hsl-kpi-calculator-2026-07.md:19](hsl-kpi-calculator-2026-07.md) | **₱250** |

Two governing sources disagree on a **live weekly money path**. The code produced every
stored value, so the doc line is the likely typo — but if ₱250 is right this is an
underpayment that predates any of this work, not a documentation defect.
**Unresolved; Kane's call.** The doc now carries the contradiction inline rather than a
silently corrected number.

### 1.3 `calcBonus` does not score two of the fourteen departments

Its loop handles `per_unit` / `tiered` / `flat` / `manual` and **skips `team_split` /
`team_pool` entirely** — the comment says so at
[schema.ts:458](../../src/lib/hsl-bonus/schema.ts#L458): *"team_split / team_pool are
calculated at the sub-team level, not per-employee here."* `hsl_managers` additionally has
an empty `rules[]`.

So for `ssd_medical_records` and `hsl_managers`, `calcBonus` returns **0**, and the stored
`calculated_bonus` comes from `recomputeSsdEntries` / `calcManagerBonus` instead.

**`calculated_bonus` is therefore NOT uniformly "what `calcBonus` would return".** Any
future parity harness, replay, or "recompute and compare" tool that assumes one scoring
entry point will read two whole departments as ₱0 divergence.

### 1.4 `monthlyMax: null` would zero a department

The cap gate is `!==  undefined`
([schema.ts:460](../../src/lib/hsl-bonus/schema.ts#L460)):

```ts
if (dept.monthlyMax !== undefined) total = Math.min(total, dept.monthlyMax);
```

`Math.min(total, null)` is **0**. Any re-expression of the schema that emits
`monthlyMax: null` where the source omits the key silently zeroes every bonus in that dept.
Six of the fourteen machine extractions in the scoping pass produced `null`; the
adversarial pass caught all six. **`null` and absent are not interchangeable here** — a test
must assert the compiled form *omits* the key when the source omits it.

## 2. Why byte-for-byte replay is unachievable

The approved success criterion was "byte-for-byte across all 3,941 rows". It is provably
impossible, for four independent reasons:

| Class | Rows | Why replay cannot succeed |
|---|---|---|
| `ssd_medical_records` | 172 | Team inputs (`pct`, `records`, `rfc`) are **deliberately never persisted** — `kpi_data` holds only `{"sub_team":"ORANGE"}`. One stored sum, three unknowns. Not invertible. |
| Retired dept/metric keys | ~150 | `case_manager` rows use `five_star_reviews`/`dme_prescriptions`/`completed_tasks`; live `case_managers` uses `reviews`/`dme`/`task`. Recompute to ₱0. |
| `callback_team` pre-2026-07-21 | subset | The rule set was *replaced* after the rows were saved; the old metric key was deleted from source. |
| Effective-dating | all | `BonusDef` has **no effective-date field** ([types.ts:29-51](../../src/lib/bonus-catalog/types.ts#L29-L51)). The catalog shape structurally cannot version a rule. |

**The rule this establishes:** any HSL→catalog parity tool must deliver a **classified
divergence report** — every row reconciled or assigned to a named class, with counts and
peso deltas — never a green checkmark over a quietly narrowed row set.

## 3. The scope, if it is ever picked up

```
SCOPE  in:  src/lib/hsl-bonus-catalog/*  (definitions, compiler, tests)
            scripts/verify-hsl-catalog-parity.mts  (read-only replay)
       out: PayrollWizard.tsx · HslBonusCalculator.tsx · DeptBonusCalculator.tsx ·
            src/lib/bonus-catalog/{formula,types}.ts · BonusCatalog.tsx ·
            every dispatch/paystub path · ALL DDL · ALL DB writes · every barrel re-export

DATA   No migration. No DDL. No seeds. No writes. The harness only SELECTs
       (selectAllPaged — PostgREST truncates at 1000 even with .range()).

RISK   monthlyMax null≠undefined (§1.4) → dept-wide zeroing.
       Nothing may import the new module — assert it with a test that greps for importers.
```

Precedent to copy: `manager-scheduling.md` — the repo's clearest INERT ship (2026-08-26,
UI-only, feeds no pay). Harness precedent: `scripts/verify-attestation-tiers.mts` (174 rows,
measured not asserted). Module shape: `src/lib/payment-catalog/system-bonus.ts` + `.test.ts`.

**Two wiring-time decisions were never made** and block any non-inert follow-up: whether
catalog KPI semantics are auto-applied or overridable, and whether history is backfilled.

## 4. The chosen direction — de-hardcode DEFINITIONS, not the payout path

**Kane's ruling, 2026-08-31 (resolution "A").** The scope in §3 conflated two
questions that are not the same question:

| Question | Answer |
| --- | --- |
| Where do the HSL bonus **rule definitions** live? | Today: hardcoded in `schema.ts`. **Target: DB-backed, editable by Accounting in the Payment Catalog.** |
| Which table **pays** an HSL bonus? | `hsl_bonus_entries`, via its own wizard loader. **Unchanged. Not in scope.** |

Conflating them is why the migration kept colliding with the double-pay guard:
`department-bonus.ts` states the HSL family *must stay absent* from the payable set,
so wiring an HSL dept onto the catalog **payout** path would require removing it from
the HSL loader in the same commit and migrating its rows — a nine-times money-path
cutover, with a production write, on ₱5,754,138 across 2,904 rows.

Splitting them makes the goal reachable with the money path untouched. And it widens
the reachable set: `ssd_medical_records` (`team_split`/`team_pool`),
`post_hearing_prep` (₱3,500/wk cap) and `hsl_managers` (per-employee checklists) were
only ever blocked from catalog **payout**, never from catalog **authoring** — so the
target is **12 of 14** depts, not 9. The two `noKpi` roster-only depts
(`executive_guest_services`, `executive_assistants`) have no rules to express.

**The invariant this direction must preserve:** with no DB overrides present, every
resolved definition must be byte-identical to `HSL_DEPTS`. The overlay precedent is
`src/lib/payroll/resolve-rate.ts` (Pay Structures made authoritative for hourly rates
via a compute-time overlay, `bonus-catalog.md` §5) — not a rewrite of `schema.ts`,
which stays the seed and the fallback.

Live-data constraint (Kane, 2026-08-31): *"they are adding bonuses right now … dont let
the HSL Doable values go."* Measured the same day — the 9 formula-expressible depts hold
**₱5,754,138 across 2,904 rows, all `ready`, zero drafts**; the only drafts anywhere are
stale (`accounting` 05-18/05-31, `ssd_medical_records` 06-01 — 54 rows, ₱3,500). Under
this direction **nothing moves**, which is the strongest form of not losing it.

## 5. Open

- [x] ~~**Fix the red guard (§1.1).**~~ Done 2026-08-31, mutation-tested, suite 1627/1627.
- [ ] **Resolve ₱100 vs ₱250 (§1.2).** Money path, still unanswered. Blocks nothing
      structural — `medical_records` encodes `100` verbatim (what produced every stored
      value) until Kane rules. **Do not normalise it to the doc's number.**
- [ ] Build the definitions overlay (§4). `src/lib/hsl-bonus-catalog/` still does not exist.
- [ ] `filing_specialist` still carries the old 30/40/50 Attested Cases bands and did not
      receive the Referral Leads / SSA.Gov terms. A re-expression must **reproduce that
      divergence verbatim**, not normalise it.
- [ ] Stranded `ssd_medical_records` draft at 2026-06-01 (54 rows, ₱3,500) — never submitted.
