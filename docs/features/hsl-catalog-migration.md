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

### 1.1 The double-pay guard is RED on `main` right now

```
$ npx tsx --test src/lib/payroll/kpi-calculator-depts.test.ts
✖ the HSL family never enters the payable KPI set
  "executive_assistants" is in WIZARD_PAYABLE_KPI_DEPT_KEYS
   — it would be paid twice (catalog + HSL entries)
  tests 9 | pass 8 | fail 1
```

**Pre-existing, not caused by this work.** The mechanism:

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

## 4. Open

- [ ] **Fix the red guard (§1.1).** It is a live tripwire that no longer trips.
- [ ] **Resolve ₱100 vs ₱250 (§1.2).** Money path.
- [ ] Decide whether the inert migration is still wanted at all given §2.
