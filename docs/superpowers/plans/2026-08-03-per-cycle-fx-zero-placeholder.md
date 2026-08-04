# Per-Cycle FX Zero Placeholders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Step 2's USD→PHP and USD→COP rates start at **0 for every new Hubstaff upload** (per-cycle record; absent = zero); setting them is the confirmation. Readiness "USD rate confirmed" goes green only when both are non-zero; Dispatch is hard-blocked while either is 0.

**Architecture:** New app_settings record `payroll.wizard.fx.<sourceFile>` = `{php, cop, by, at}` written by the four existing Step-2 save paths, which also **write through** to the existing global keys (`usd_to_php_rate`/`usd_to_cop_rate`) so all non-wizard consumers are untouched. The wizard's rate state hydrates from the cycle record raw (never through the `effective*` fallbacks, which erase zeros). The readiness fx row reads the cycle record instead of the now-removed weekly confirm marker.

**Tech Stack:** Next.js app router, React client component (PayrollWizard.tsx ~19.2k lines), Supabase app_settings, `node --import tsx --test` for the pure module.

**Spec:** `docs/superpowers/specs/2026-08-03-per-cycle-fx-zero-placeholder-design.md` (approved; supersedes the fx confirm marker from this morning's checklist spec).

## Global Constraints

- **NEVER `git push`** — Kane handles git. Commit locally only.
- **Multi-session shared checkout:** `git add` ONLY the exact files each task names — never `-A`/`-u`/`.`. If an external commit sweeps your work mid-task, do NOT rebase/amend/reset — verify your file-scoped diff and report it.
- **Live production DB:** `.env.local` holds production service-role creds. The only DB access allowed is the read-only `scripts/verify-readiness.mts` where a task explicitly says so.
- **No `next build`, no dev servers.** Verification = `npm run lint` (tsc --noEmit) + targeted `node --import tsx --test <file>`.
- Line numbers below are anchors **at commit `7b10f00`** — the file moves constantly (other sessions). ALWAYS locate edits by searching the quoted code, never by line number.
- Exact new key: `payroll.wizard.fx.<sourceFile>` (prefix `payroll.wizard.fx.`). Value JSON: `{"php":number,"cop":number,"by":string|null,"at":iso-string}`. Absent/malformed ⇒ treated as `php=0, cop=0`.
- The old fx marker (`payroll.wizard.fx_confirmed.*`) is removed from code in stages: Task 1 stops READING it (server), Task 2 stops WRITING it (wizard), Task 4 deletes the exports+tests. Old exports must survive until Task 4 so every intermediate commit stays lint-clean.
- The orphanage confirm-none marker, Step-1 CSV modal, `markerWeekStart`, and week-scoped roster are UNTOUCHED by every task.
- Commit style: conventional commits; body ends with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Pure cycle-FX record + readiness fx row swap (server)

**Files:**
- Modify: `src/lib/payroll/wizard-setup-steps.ts`
- Modify: `src/lib/payroll/wizard-setup-steps.test.ts`
- Modify: `src/lib/payroll/payroll-readiness.ts` (buildWizardSetup only)

**Interfaces:**
- Consumes: existing `WizardSetupInput`/`deriveWizardSetupSteps`; `getAppSettings` batch in `buildWizardSetup`.
- Produces (Tasks 2–5 rely on these EXACT names):
  - `CYCLE_FX_SETTING_PREFIX = 'payroll.wizard.fx.'`
  - `cycleFxSettingKey(sourceFile: string): string`
  - `interface CycleFxRecord { php: number; cop: number; by: string | null; at: string | null }`
  - `parseCycleFxRecord(value: string | null): CycleFxRecord | null`
  - `WizardSetupInput.fx: CycleFxRecord | null` (REPLACES `fxMarker`)
  - Old `fxConfirmedSettingKey`/`parseFxConfirmedMarker`/`FX_CONFIRMED_SETTING_PREFIX` remain EXPORTED (wizard still imports them until Task 2/4).

- [ ] **Step 1: Update the test file first (failing tests)**

In `src/lib/payroll/wizard-setup-steps.test.ts`:

1. Add to the import list from `'./wizard-setup-steps'`: `cycleFxSettingKey, parseCycleFxRecord`.
2. In `ALL_DONE`, REPLACE the line `fxMarker: { rate: 58.9, by: 'lenny@simple.biz', at: '2026-08-02T06:00:00Z' },` with:

```ts
  fx: { php: 58.9, cop: 4050, by: 'lenny@simple.biz', at: '2026-08-02T06:00:00Z' },
```

3. REPLACE the existing test `'fx unconfirmed → attention pointing at Step 2'` with:

```ts
test('fx: absent record or both zero → "Rates at 0"; single zero names the missing leg; both set → done', () => {
  const absent = step(deriveWizardSetupSteps({ ...ALL_DONE, fx: null }), 'fx');
  assert.equal(absent.status, 'attention');
  assert.match(absent.detail, /Rates at 0/);
  const bothZero = step(
    deriveWizardSetupSteps({ ...ALL_DONE, fx: { php: 0, cop: 0, by: null, at: null } }),
    'fx',
  );
  assert.equal(bothZero.status, 'attention');
  assert.match(bothZero.detail, /Rates at 0/);
  const phpZero = step(
    deriveWizardSetupSteps({ ...ALL_DONE, fx: { php: 0, cop: 4050, by: null, at: null } }),
    'fx',
  );
  assert.equal(phpZero.status, 'attention');
  assert.match(phpZero.detail, /PHP still 0/);
  const copZero = step(
    deriveWizardSetupSteps({ ...ALL_DONE, fx: { php: 58.9, cop: 0, by: null, at: null } }),
    'fx',
  );
  assert.equal(copZero.status, 'attention');
  assert.match(copZero.detail, /COP still 0/);
  const done = step(deriveWizardSetupSteps(ALL_DONE), 'fx');
  assert.equal(done.status, 'done');
  assert.match(done.detail, /58\.9/);
  assert.match(done.detail, /4,050/);
});

test('fx: no matched CSV → waiting for the CSV (not a zero complaint)', () => {
  const s = step(
    deriveWizardSetupSteps({
      ...ALL_DONE,
      csvUpload: null,
      paneWeekStart: '2026-07-19',
      paneWeekLabel: 'Jul 19 – Jul 25',
      fx: null,
    }),
    'fx',
  );
  assert.equal(s.status, 'attention');
  assert.match(s.detail, /CSV/);
});

test('cycleFxSettingKey + parseCycleFxRecord', () => {
  assert.equal(cycleFxSettingKey('a.csv'), 'payroll.wizard.fx.a.csv');
  assert.deepEqual(
    parseCycleFxRecord('{"php":58.9,"cop":4050,"by":"a@b.c","at":"2026-08-09T02:11:00Z"}'),
    { php: 58.9, cop: 4050, by: 'a@b.c', at: '2026-08-09T02:11:00Z' },
  );
  // partial / sloppy records normalize: missing or invalid legs read 0, extra fields drop
  assert.deepEqual(parseCycleFxRecord('{"php":58.9}'), { php: 58.9, cop: 0, by: null, at: null });
  assert.deepEqual(parseCycleFxRecord('{"php":-1,"cop":"x"}'), { php: 0, cop: 0, by: null, at: null });
  assert.equal(parseCycleFxRecord('not json'), null);
  assert.equal(parseCycleFxRecord(null), null);
});
```

4. The existing degraded test (`'a degraded read → pending …'`) currently passes `fxMarker: null` — change that property to `fx: null`.
5. Do NOT remove the `fxConfirmedSettingKey`/`parseFxConfirmedMarker` assertions in the keys/parsers test yet (Task 4 does).

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import tsx --test src/lib/payroll/wizard-setup-steps.test.ts`
Expected: FAIL — `cycleFxSettingKey`/`parseCycleFxRecord` not exported; `fx` not a known input property.

- [ ] **Step 3: Implement in `wizard-setup-steps.ts`**

1. Below the orphanage key helpers, add:

```ts
// ── Per-cycle FX record (Step 2 zero placeholders) ───────────────────────────

/** The cycle's USD-anchored rates. Kept per Hubstaff upload so every NEW cycle
 *  starts at 0 — typing the real rates IS the weekly confirmation (Kane,
 *  2026-08-03; supersedes the fx_confirmed week marker). Absent key ⇒ both 0.
 *  The wizard writes this AND the global usd_to_*_rate keys (write-through);
 *  the globals never hold 0 — their effective* readers erase zeros. */
export const CYCLE_FX_SETTING_PREFIX = 'payroll.wizard.fx.';

export function cycleFxSettingKey(sourceFile: string): string {
  return `${CYCLE_FX_SETTING_PREFIX}${sourceFile}`;
}

export interface CycleFxRecord {
  php: number;
  cop: number;
  by: string | null;
  at: string | null;
}

/** Malformed/null ⇒ null (treated as absent). Invalid/negative legs read 0 —
 *  a broken leg must look UNSET, never set. */
export function parseCycleFxRecord(value: string | null): CycleFxRecord | null {
  if (!value) return null;
  try {
    const o = JSON.parse(value) as { php?: unknown; cop?: unknown; by?: unknown; at?: unknown };
    const leg = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
    return {
      php: leg(o.php),
      cop: leg(o.cop),
      by: typeof o.by === 'string' ? o.by : null,
      at: typeof o.at === 'string' ? o.at : null,
    };
  } catch {
    return null;
  }
}
```

2. In `WizardSetupInput`, REPLACE the `fxMarker` field with:

```ts
  /** The cycle's per-upload FX record (see CYCLE_FX_SETTING_PREFIX). Null when
   *  no record exists for the matched upload — which reads as rates-at-zero. */
  fx: CycleFxRecord | null;
```

3. In `deriveWizardSetupSteps`, REPLACE the entire `// 2 · USD → PHP rate confirmed…` block with:

```ts
  // 2 · USD rates set for the cycle — zero is the placeholder; both legs must
  // be non-zero. No matched CSV means there is no cycle to set rates on yet.
  if (degraded('fx')) {
    steps.push({ key: 'fx', stepNo: '2', label: 'USD rate confirmed', status: 'pending', detail: "Couldn't read the cycle rates" });
  } else if (!input.csvUpload) {
    steps.push({ key: 'fx', stepNo: '2', label: 'USD rate confirmed', status: 'attention', detail: "Waiting for this week's CSV" });
  } else {
    const php = input.fx?.php ?? 0;
    const cop = input.fx?.cop ?? 0;
    if (php > 0 && cop > 0) {
      const stamp = manilaStampLabel(input.fx?.at ?? null);
      steps.push({
        key: 'fx',
        stepNo: '2',
        label: 'USD rate confirmed',
        status: 'done',
        detail: `₱${php} · COP ${new Intl.NumberFormat('en-US').format(cop)} / $1${input.fx?.by ? ` · ${input.fx.by}` : ''}${stamp ? ` · ${stamp}` : ''}`,
      });
    } else if (php <= 0 && cop <= 0) {
      steps.push({ key: 'fx', stepNo: '2', label: 'USD rate confirmed', status: 'attention', detail: 'Rates at 0 — set on Step 2' });
    } else if (php <= 0) {
      steps.push({ key: 'fx', stepNo: '2', label: 'USD rate confirmed', status: 'attention', detail: 'PHP still 0 — Step 2' });
    } else {
      steps.push({ key: 'fx', stepNo: '2', label: 'USD rate confirmed', status: 'attention', detail: 'COP still 0 — Step 2' });
    }
  }
```

Leave `fxConfirmedSettingKey`, `parseFxConfirmedMarker`, `FX_CONFIRMED_SETTING_PREFIX` exported and untouched (Task 4 removes them).

- [ ] **Step 4: Swap the server read in `payroll-readiness.ts` (`buildWizardSetup`)**

Locate by content (anchors @7b10f00: imports :98-102, settings batch ~:1423, fxMarker use ~:1504):

1. Import block from `'@/lib/payroll/wizard-setup-steps'`: REMOVE `fxConfirmedSettingKey` and `parseFxConfirmedMarker`; ADD `cycleFxSettingKey` and `parseCycleFxRecord`.
2. In the `getAppSettings([...])` batch: REPLACE the `fxConfirmedSettingKey(expectedWeekStart),` entry with a matched-file-conditional entry, mirroring how the dispatch-lock key is already conditional:

```ts
      ...(matched?.source_file ? [cycleFxSettingKey(matched.source_file)] : []),
```

3. In the `deriveWizardSetupSteps({...})` input literal: REPLACE `fxMarker: parseFxConfirmedMarker(settings?.[fxConfirmedSettingKey(expectedWeekStart)] ?? null),` with:

```ts
    fx: matched?.source_file
      ? parseCycleFxRecord(settings?.[cycleFxSettingKey(matched.source_file)] ?? null)
      : null,
```

- [ ] **Step 5: Run tests + lint**

Run: `node --import tsx --test src/lib/payroll/wizard-setup-steps.test.ts` → PASS (all, including the untouched marker-parser test).
Run: `npm run lint` → clean (the wizard still imports the still-exported old helpers).

- [ ] **Step 6: Verify against live data (read-only)**

```powershell
$env:TSX_TSCONFIG_PATH="tsconfig.readiness-verify.json"; node --import tsx scripts/verify-readiness.mts
```

Expected: the Wizard setup block's fx row now reads `[attention] 2  USD rate confirmed  Rates at 0 — set on Step 2` (no cycle record exists yet anywhere). Nothing written.

- [ ] **Step 7: Commit**

```bash
git add src/lib/payroll/wizard-setup-steps.ts src/lib/payroll/wizard-setup-steps.test.ts src/lib/payroll/payroll-readiness.ts
git commit -m "feat(readiness): fx row reads per-cycle rate record - zero placeholder until both legs set"
```

---

### Task 2: Wizard Step 2 — cycle hydration, write-through saves, marker removal

**Files:**
- Modify: `src/components/PayrollWizard.tsx`

**Interfaces:**
- Consumes: `cycleFxSettingKey`, `parseCycleFxRecord` from `'@/lib/payroll/wizard-setup-steps'` (Task 1); existing `savePabSetting`, `calcSourceFile`, `isReplay`, `sessionEmail`.
- Produces: `usdToPhpRate`/`usdToCopRate` now carry CYCLE values (0 = unset); new `globalPhpRate`/`globalCopRate` state (reference display + Task 3's snapshot fallback). Writes `payroll.wizard.fx.<calcSourceFile>` exactly in Task 1's parse shape.

All anchors @7b10f00 — locate by searching the quoted code.

- [ ] **Step 1: State split**

At the rate state block (`:2004-2027`):

1. Change the two initial values from the OFFICIAL defaults to **0** (zero-first display):

```ts
  /** USD → PHP (PHP per $1) FOR THIS CYCLE. 0 until set for the cycle — the
   *  zero placeholder is the point (Kane 2026-08-03): a new Hubstaff upload
   *  starts at 0 and typing the real rate is the weekly confirmation. Saves
   *  write payroll.wizard.fx.<file> AND the global usd_to_php_rate. */
  const [usdToPhpRate, setUsdToPhpRate] = useState<number>(0);
  const [usdToPhpInput, setUsdToPhpInput] = useState<string>('0');
```

and likewise `usdToCopRate` → `useState<number>(0)`, `usdToCopInput` → `useState<string>('0')` (update its doc comment the same way).

2. REMOVE the fx marker states `fxConfirmedAt`/`fxConfirming` (the block at `:2012-2013`). KEEP `orphanageNoneConfirmed`/`orphanageNoneConfirming` and trim the comment above them to orphanage-only:

```ts
  /** Weekly confirm marker (Wizard Setup checklist, step 3) — read-only mirror
   *  of the app_settings stamp so the Step-3 button can render "already
   *  confirmed" without re-deriving from the Readiness pane. */
```

3. Immediately after the `usdToCopEditing` state, add the global reference state:

```ts
  /** The GLOBAL rates (usd_to_php_rate / usd_to_cop_rate) — what the rest of
   *  the app converts with. Shown as a reference under each Step-2 card and
   *  used as the final-pay snapshot's fx fallback while the cycle is unset.
   *  Never 0: the effective* readers replace invalid values with OFFICIAL_*. */
  const [globalPhpRate, setGlobalPhpRate] = useState<number>(OFFICIAL_USD_TO_PHP_RATE);
  const [globalCopRate, setGlobalCopRate] = useState<number>(OFFICIAL_USD_TO_COP_RATE);
```

- [ ] **Step 2: Repurpose the settings loader; add cycle hydration**

1. The existing loader (`:3011-3032`, fetches `usd_to_php_rate,usd_to_cop_rate`) currently sets the four rate/input states. Change its body to set ONLY the globals:

```ts
        const phpRate = effectiveUsdToPhpRateFromStored(values['usd_to_php_rate']);
        setGlobalPhpRate(phpRate);
        const copRate = effectiveUsdToCopRateFromStored(values['usd_to_cop_rate']);
        setGlobalCopRate(copRate);
```

2. Directly below it, add the cycle hydration effect:

```ts
  // Hydrate THIS CYCLE's rates from payroll.wizard.fx.<file> — raw, never via
  // the effective* fallbacks (they'd erase the zero placeholder). Absent record
  // ⇒ 0/0 for a live cycle; a replayed pre-record cycle displays the globals
  // instead (read-only there — see the cards) so historical USD views stay sane.
  // Skipped while either card is mid-edit so a slow response can't clobber typing.
  useEffect(() => {
    if (!calcSourceFile) {
      setUsdToPhpRate(0);
      setUsdToPhpInput('0');
      setUsdToCopRate(0);
      setUsdToCopInput('0');
      return;
    }
    if (usdToPhpEditing || usdToCopEditing) return;
    let cancelled = false;
    const key = cycleFxSettingKey(calcSourceFile);
    fetch(`/api/app-settings?keys=${encodeURIComponent(key)}`, { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : { values: {} }))
      .then((json: { values?: Record<string, string | null> }) => {
        if (cancelled) return;
        const rec = parseCycleFxRecord(json.values?.[key] ?? null);
        const php = rec?.php ?? (isReplay ? globalPhpRate : 0);
        const cop = rec?.cop ?? (isReplay ? globalCopRate : 0);
        setUsdToPhpRate(php);
        setUsdToPhpInput(String(php));
        setUsdToCopRate(cop);
        setUsdToCopInput(String(cop));
      })
      .catch(() => {
        /* keep current values — a failed read must not zero a set cycle */
      });
    return () => {
      cancelled = true;
    };
  }, [calcSourceFile, isReplay, globalPhpRate, globalCopRate, usdToPhpEditing, usdToCopEditing]);
```

Note: `rec?.php ?? …` — `parseCycleFxRecord` returns non-null legs as numbers (0 for unset), so a RECORD WITH `php: 0` stays 0 even in replay (post-feature replays show their true stored state); only a NULL record (pre-feature cycle) falls back to globals in replay.

3. Update the import from `'@/lib/payroll/wizard-setup-steps'` (`:242-247`): REMOVE `fxConfirmedSettingKey` and `parseFxConfirmedMarker`; ADD `cycleFxSettingKey` and `parseCycleFxRecord`. Keep the two orphanage imports.

- [ ] **Step 3: Rework the marker-load effect to orphanage-only**

The effect at `:2185-2206` fetches both marker keys. Reduce it to the orphanage key only:

```ts
  // The step-3 confirm-none marker for the cycle in view — read-only mirror of
  // what the Readiness checklist shows. Shape mirrors the fx-settings loader
  // (`{ values: Record<string, string|null> }`).
  useEffect(() => {
    let cancelled = false;
    const key = orphanageConfirmedSettingKey(markerWeekStart);
    fetch(`/api/app-settings?keys=${encodeURIComponent(key)}`, { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : { values: {} }))
      .then((json: { values?: Record<string, string | null> }) => {
        if (cancelled) return;
        setOrphanageNoneConfirmed(parseOrphanageNoneMarker(json.values?.[key] ?? null) !== null);
      })
      .catch(() => {
        /* marker display is best-effort; stamping still works */
      });
    return () => {
      cancelled = true;
    };
  }, [markerWeekStart]);
```

- [ ] **Step 4: Remove `stampFxConfirmed` + its call sites + the Confirm button**

1. Delete the whole `stampFxConfirmed` callback (`:3063-3089`).
2. Delete the line `void stampFxConfirmed(parsed);` in BOTH PHP save paths (`:10112` Enter — keep the `cursorOverlayRef.current?.broadcastSave();` line after it — and `:10194` Apply & Save).
3. In the PHP card's `!usdToPhpEditing` branch (`:10126-10161`): delete the "Confirm for this week" `<Button>` and unwrap the fragment so ONLY the original "Edit rate" button remains (restore the pre-fragment form: `{!usdToPhpEditing ? (<Button …>Edit rate</Button>) : (…)}`).

- [ ] **Step 5: Write-through saves (all four paths)**

Add one helper near `savePabSetting` (search for `const savePabSetting`):

```ts
  /** Persist the cycle's FX record (Step 2 zero-placeholder model). Merges the
   *  other leg from current state; fire-and-forget from the save paths — the
   *  global write already succeeded, and a failed cycle write only leaves the
   *  checklist amber + dispatch gated until the next save retries it. */
  const saveCycleFxRecord = React.useCallback(
    (leg: 'php' | 'cop', value: number) => {
      if (!calcSourceFile) return;
      const record = {
        php: leg === 'php' ? value : usdToPhpRate,
        cop: leg === 'cop' ? value : usdToCopRate,
        by: sessionEmail ?? null,
        at: new Date().toISOString(),
      };
      savePabSetting(cycleFxSettingKey(calcSourceFile), JSON.stringify(record)).catch(() => {
        toast.error('Rate saved globally, but the cycle record failed — save again to confirm the cycle.');
      });
    },
    [calcSourceFile, usdToPhpRate, usdToCopRate, sessionEmail, savePabSetting],
  );
```

Then in each of the FOUR save paths (PHP Enter `:10084-10118`, PHP Apply `:10173-10199`, COP Enter `:10245-10278`, COP Apply `:10299-10331`), inside the `.then` success branch right after `toast.success(...)`, add the matching call:

- PHP paths: `saveCycleFxRecord('php', parsed);`
- COP paths: `saveCycleFxRecord('cop', parsed);`

(Leave the `broadcastSave()` asymmetry between Enter/Apply paths exactly as found.)

Also add a replay guard at the TOP of each of the four paths (before any state change), matching the house convention:

```ts
                        if (isReplay) {
                          toast.error('Replaying a past period is view-only');
                          return;
                        }
```

- [ ] **Step 6: Zero-placeholder card UI (both cards)**

1. PHP card: the read-only branch shows just "Edit rate" (after Step 4). Hide the edit affordance during replay: wrap the Edit-rate button as `{!isReplay && (<Button …>Edit rate</Button>)}` — same on the COP card. (The inputs are already `readOnly` outside editing.)
2. Under each card's existing helper `<p className="w-full text-xs …">`, prepend a cycle-status line inside the same `<p>` (keep it one paragraph; search each card's helper text):
   - PHP card, insert at the start of the `<p>`:

```tsx
                {usdToPhpRate <= 0 ? (
                  <span className="font-semibold text-amber-700 dark:text-amber-400">
                    Not set for this cycle — enter this week&apos;s rate.{' '}
                  </span>
                ) : null}
                <span className="text-zinc-500 dark:text-zinc-500">Global: ₱{globalPhpRate.toFixed(2)} / $1.</span>{' '}
```

   - COP card, same pattern:

```tsx
                {usdToCopRate <= 0 ? (
                  <span className="font-semibold text-amber-700 dark:text-amber-400">
                    Not set for this cycle — enter this week&apos;s rate.{' '}
                  </span>
                ) : null}
                <span className="text-zinc-500 dark:text-zinc-500">Global: $COP{globalCopRate.toLocaleString('es-CO')} / $1.</span>{' '}
```

3. The PHP card's "Current: ₱{usdToPhpRate.toFixed(5)} = $1" copy and COP card's equivalents can stay — at 0 they now truthfully show 0. In the replayed-pre-record case add nothing extra (the hydration effect already shows globals; the cards are read-only there).

- [ ] **Step 7: Lint**

Run: `npm run lint` → clean. (`parseFxConfirmedMarker` and `fxConfirmedSettingKey` are no longer imported here but stay exported from the pure module — fine.)

- [ ] **Step 8: Commit**

```bash
git add src/components/PayrollWizard.tsx
git commit -m "feat(wizard): Step 2 rates are per-cycle with zero placeholders - write-through saves, confirm button removed"
```

---

### Task 3: Zero consequences — display guard, snapshot fallback, Step 7 line, Step 8 gate

**Files:**
- Modify: `src/components/PayrollWizard.tsx`

**Interfaces:**
- Consumes: Task 2's cycle-valued `usdToPhpRate`/`usdToCopRate` + `globalPhpRate`.
- Produces: no new exports — behavior only.

- [ ] **Step 1: Guard the one unguarded division**

At `:10768` (search for `≈&nbsp;${(row.initialPay / usdToPhpRate)` — the Step-2 Initial Pay USD sub-line): wrap the whole `≈ …` expression so it renders only when `usdToPhpRate > 0`, mirroring the already-guarded dept-total at `:13153` (`{usdToPhpRate > 0 && (…)}`). Every other site is already guarded or routes through `formatUsdFromPhp`/`PhpWithUsd` (verified audit @7b10f00; if lint or a fresh grep for `/ usdToPhpRate` turns up a new unguarded site added by another session, guard it the same way and note it in the report).

- [ ] **Step 2: Snapshot fx fallback**

In `publishFinalPaySnapshot` (search `fx_rate is stored once per week`): change `fx_rate: usdToPhpRate,` to

```ts
        // Cycle rate once set; the global effective rate while the cycle is
        // still at 0 — staged employee-facing paystubs must never divide by 0.
        JSON.stringify({ source_file: calcSourceFile, fx_rate: usdToPhpRate > 0 ? usdToPhpRate : globalPhpRate, finals }),
```

and add `globalPhpRate` to the callback's dependency array.

- [ ] **Step 3: Step 7 Validation line**

In the Validation Checks array (search `label: 'Hubstaff Hours Uploaded'`), add after the `'Initial Calculations Complete'` item:

```ts
                  {
                    label: usdToPhpRate > 0 && usdToCopRate > 0
                      ? 'Cycle FX Rates Set (USD→PHP & USD→COP)'
                      : `Cycle FX Rates at 0 — set on Step 2 (dispatch is blocked)`,
                    pass: usdToPhpRate > 0 && usdToCopRate > 0,
                  },
```

(The list renders Pass/Warn only — the real stop is Step 8's gate; the label says so.)

- [ ] **Step 4: Step 8 hard gate**

1. Button `disabled` (search `disabled={isDispatching || isReplay}`):

```tsx
                disabled={isDispatching || isReplay || usdToPhpRate <= 0 || usdToCopRate <= 0}
```

2. Button label ternary — extend (search the label line right below):

```tsx
                {isDispatching ? 'Sending to Dispatch…' : isReplay ? 'View-only (past period)' : (usdToPhpRate <= 0 || usdToCopRate <= 0) ? 'Set Step 2 rates first' : 'Lock in Values & Send to Payment Dispatch'}
```

3. Defensive check in the onClick handler, right after the `!calcSourceFile` stop (search `toast.error('No pay-period file selected')`):

```ts
                  if (usdToPhpRate <= 0 || usdToCopRate <= 0) {
                    toast.error('Cycle FX rates not set', {
                      description: "Set this cycle's USD → PHP and USD → COP rates on Step 2 first.",
                    });
                    return;
                  }
```

4. Below the button row container (search `className="flex flex-wrap items-center justify-center gap-4"`), add the explanatory line rendered only while gated:

```tsx
            {!isReplay && (usdToPhpRate <= 0 || usdToCopRate <= 0) && (
              <p className="text-center text-sm font-medium text-amber-700 dark:text-amber-400">
                Set this cycle&apos;s USD → PHP and USD → COP rates on Step 2 first — dispatch is blocked while either is 0.
              </p>
            )}
```

- [ ] **Step 5: Lint + commit**

Run: `npm run lint` → clean.

```bash
git add src/components/PayrollWizard.tsx
git commit -m "feat(wizard): hard-block dispatch while cycle FX rates are 0; guard USD display; snapshot fx fallback"
```

---

### Task 4: Remove the superseded fx confirm marker exports + tests

**Files:**
- Modify: `src/lib/payroll/wizard-setup-steps.ts`
- Modify: `src/lib/payroll/wizard-setup-steps.test.ts`

**Interfaces:**
- Consumes: nothing new. Precondition: Tasks 1–2 removed every import of these symbols (verify with a repo-wide grep before deleting).
- Produces: `FX_CONFIRMED_SETTING_PREFIX`, `fxConfirmedSettingKey`, `parseFxConfirmedMarker` no longer exist.

- [ ] **Step 1: Verify nothing still imports them**

Run: `grep -rn "fxConfirmedSettingKey\|parseFxConfirmedMarker\|FX_CONFIRMED_SETTING_PREFIX" src/ app/ scripts/ --include=*.ts --include=*.tsx`
Expected: hits ONLY in `wizard-setup-steps.ts` (definitions) and its test file. If anything else hits, STOP and report — do not delete.

- [ ] **Step 2: Delete definitions + tests**

1. In `wizard-setup-steps.ts`: delete `FX_CONFIRMED_SETTING_PREFIX`, `fxConfirmedSettingKey`, `parseFxConfirmedMarker` (keep the orphanage prefix/key/parser and everything else).
2. In the test file: remove `fxConfirmedSettingKey`/`parseFxConfirmedMarker` from the import and delete their assertions from the keys/parsers test (keep the orphanage + dispatch-lock + cycleFx assertions).

- [ ] **Step 3: Full suite + lint + commit**

Run: `npm test` → all pass. Run: `npm run lint` → clean.

```bash
git add src/lib/payroll/wizard-setup-steps.ts src/lib/payroll/wizard-setup-steps.test.ts
git commit -m "refactor(readiness): drop superseded fx_confirmed week-marker helpers"
```

---

### Task 5: Docs + final verification

**Files:**
- Modify: `docs/features/payroll-readiness.md`

- [ ] **Step 1: Update the feature doc**

In the Wizard-setup checklist section (added earlier today): rewrite the fx row's description to the shipped model — per-cycle key `payroll.wizard.fx.<sourceFile>` `{php, cop, by, at}`, absent = 0/0, green requires both legs > 0, written by Step 2's four save paths with write-through to the globals, Step 8 hard-blocked while either leg is 0, and the `payroll.wizard.fx_confirmed.*` week marker retired (orphaned rows inert). Ground every claim by reading the shipped code, not this plan. Fix any other statement the change staled (e.g. a markers table listing the fx marker).

- [ ] **Step 2: Full suite + lint + verify (read-only)**

```powershell
npm test
npm run lint
$env:TSX_TSCONFIG_PATH="tsconfig.readiness-verify.json"; node --import tsx scripts/verify-readiness.mts
```

Expected: suite green; lint clean; the Wizard setup block's fx row shows the zero-placeholder state (amber) until rates are re-entered on Step 2 — paste the block in the report.

- [ ] **Step 3: Commit**

```bash
git add docs/features/payroll-readiness.md
git commit -m "docs(readiness): fx row reads per-cycle zero-placeholder record"
```
