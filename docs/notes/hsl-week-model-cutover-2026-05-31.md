# HSL PAB week cutover: Mon→Sun → Sun→Sat (effective 2026-05-31)

**Status:** live.
**Date:** 2026-07-14.
**Scope:** authoritative pay/dispatch engine (`current-pay.ts`) + Accounting's Payroll Wizard
(pay mirror, PAB eligibility, and the PAB Calendar display).

## What changed

HSL's (Hogan) work/PAB week moved from **Mon→Sun** to **Sun→Sat**. This is an
**effective-date cutover**, not a global flip:

- Weeks/PAB months anchored **before** 2026-05-31 keep computing **Mon→Sun** — May 2026 and
  earlier stay byte-identical to what was produced before (and to the frozen
  `hsl_week_model_snapshot` mon_sun baseline). May's last week uploads on 2026-05-24.
- Weeks/PAB months anchored **on/after** 2026-05-31 compute **Sun→Sat** — **June 2026 onward**.

Only **HSL** employees are affected. Every other department was already Sun→Sat.

> **History:** the cutover was first wired at 2026-07-05 (July onward). It was then moved back to
> **2026-05-31** to include the **June 2026** period as Sun→Sat as well. This is a deliberate
> RETROACTIVE change to June — June HSL pay/PAB that may have already been computed/dispatched as
> Mon→Sun will now recompute as Sun→Sat. Verify June against dispatch / the mon_sun snapshot and
> re-run the June cycle if the numbers moved.

## Why 2026-05-31 (a Sunday), not June 1

The server resolves the model **per-upload** from the Hubstaff file's **Sunday start date**; the
wizard resolves it **per-PAB-month** from the month's first Monday. June's first Sun→Sat week
(May 31 – Jun 6, owned by Monday Jun 1) comes from the `2026-05-31_to_…` upload. Anchoring the
cutover on that Sunday (2026-05-31) makes both resolutions agree: the June-owning upload
(start May 31) and June's PAB-month Monday (Jun 1) both land on/after the cutover → Sun→Sat, while
May's last-week upload (start May 24) stays Mon→Sun. A June-1 cutover would have flipped the wizard
but left the pay engine paying June's first week Mon→Sun.

## How it resolves

- **Cutover date** lives in `app_settings['hsl.week_model_cutover']` (YYYY-MM-DD). When unset, the
  code falls back to `HSL_WEEK_MODEL_DEFAULT_CUTOVER = '2026-05-31'`
  ([hsl-week-model.ts](../../src/lib/payroll/hsl-week-model.ts)), so the cutover is live without a
  DB write. A stored value overrides the default (move/disable the cutover from data, no deploy).
- Both call sites resolve via `resolveHslWeekModelWithDefault(anchor, settingValue)`:
  - **Server** ([current-pay.ts](../../src/lib/payroll/current-pay.ts)) anchors on the upload's
    **file start date** (per-upload).
  - **Wizard** ([PayrollWizard.tsx](../../src/components/PayrollWizard.tsx)) anchors on the viewed
    **PAB-month start** for eligibility/calendar; `payDaysByEmail` anchors on the upload start.

## Invariants / guardrails

1. **PAB-month ownership + Tech-bonus timing stay MONDAY-based** for all week models. A Sun→Sat HSL
   week is owned by the month of the Monday inside it. In `current-pay.ts`, `weekMonday` is derived
   from the `mon_sun` variant regardless of the active model, so switching the pay window to
   Sun→Sat never moves a week into a different payroll cycle.
2. **Only the week anchor + period-end snap move.** The HSL ≥5-of-7 quota, weekend credit and
   overnight forward/backward pairing are identical in both models.
3. **Anchor from a stable date** — the upload/file start or PAB-month start — never a week-shape
   dependent value.
4. The pure `resolveHslWeekModel` and its tests are unchanged; the default lives in the wrapper
   `resolveHslWeekModelWithDefault`.

## Verification

- Unit: `npx tsx --test src/lib/payroll/hsl-week-model.test.ts` (boundary tests assert May stays
  Mon→Sun, June flips to Sun→Sat, ownership Monday stays correct).
- Wizard: a **June 2026** HSL PAB Calendar now reads **Sun … Sat** with Sunday-start weeks and
  live weekend cells; a **May 2026** one still reads **Mon … Sun**.
