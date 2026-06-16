# Managers — My Team logic

Reference for how the **Manager portal → My Team** surfaces a department manager's
roster, what each manager can and cannot see, and how the per-member dialog is
built.

Key files:

- `src/components/manager/ManagerApp.tsx` — the roster shell (cards, medal context, Active-now).
- `src/components/manager/ManagerMemberDialog.tsx` — the per-member detail modal.
- `src/components/manager/ManagerMemberHoursMini.tsx` — the attendance/PAB mini-calendar inside the modal.

## Managers do not see rates or pay (anywhere)

> **Source of truth:** managers see attendance, recognition, and shared profile
> data — never compensation. Rates and pay were stripped from every My Team
> surface; do **not** reintroduce them.

Removed from `ManagerApp.tsx`:

- The global **Show rates / Hide rates** toggle and its `ratesHidden` state.
- The per-card **rate footer** on each roster card. A quiet email/identity footer
  remains (see the inline comment near `ManagerApp.tsx:3061`, "rates removed:
  managers no longer see pay rates").
- The now-unused `AnimatedRate` / rate-formatting helpers.

Kept: the **Active now** control (`ActiveNowButton`, `ManagerApp.tsx:2694` /
`:3193`), which shows online presence and is unrelated to pay.

## Member dialog (`ManagerMemberDialog.tsx`)

The modal has a left **identity rail** and a right **tabbed detail panel**.

### Recognition card replaces the pay-rate card

The rail's old **Pay rates** card (with its show/hide toggle and `MaskedRate`) is
gone. In its place is a read-only **`RecognitionCard`** (`ManagerMemberDialog.tsx:167`)
that surfaces the medals awarded to the teammate from the roster:

- **Commendation** (green flag) and **flag-for-review** (red flag) groups, ordered
  by `MEDAL_ORDER = ['commend', 'flag']`.
- Per group: a **count** badge, the **latest note**, and **who/when** awarded
  (`by <awarded_by> — <date>`).
- Empty state: "No commendations or flags yet."

Data comes from a new optional **`medals?: MedalRecord[]`** prop
(`ManagerMemberDialog.tsx:54`), supplied by the roster's medal context. In
`ManagerApp.tsx` the medals map is read from `useMedalCtx()` (`:2008`) and the
selected member's medals are passed into the dialog keyed on personal/work email
(`:3159`). Awarding still happens via roster drag-drop, not in the dialog
(the card is read-only here).

### Tabs: Work · Notes · Hours

`TabId = 'work' | 'notes' | 'hours'` (`ManagerMemberDialog.tsx:31`). The former
**Payments** tab is renamed **Hours** (`CalendarDays` icon, `:227`) and is now
**attendance-only** — the pay summary was removed. The tab renders
`ManagerMemberHoursMini` (`:441`), passing `workEmail`, `personalEmail`,
`alternateWorkEmail`, `alternateWorkEmail2`, and the member's **`department`**
(`:447`).

## Attendance mini-calendar (`ManagerMemberHoursMini.tsx`)

This component was gutted of all pay. Removed: per-day rate badges/tooltips, the
rates + rate-history + `member-monthly-pay` fetches, the `monthPay` calc, and the
**Estimated pay / Bonuses / MESA / weekend pay** summary card. What remains is a
pure attendance view built from merged Hubstaff hours.

- **Hours-only fetch:** loads the merged Hubstaff row once per member open; month
  navigation is derived state (no refetch). Holiday settings are fetched once for
  the violet holiday cells.
- **Month picker** with sliding label animation, plus an "`Xh month`" total
  (`monthAllDaysTotalSeconds`).
- **Cell coloring:** emerald = pass, rose = fail, violet = holiday (overrides), and
  weekend handling. See `CalendarBody`.

### HSL PAB rule now derives from the `department` prop

Because the server pay payload was removed, the HSL-specific attendance rule
(weekend qualification + overnight-shift split) is now driven entirely by the new
**`department` prop**:

```ts
const isHslMember = (department ?? '').trim().toLowerCase() === 'hsl';
```

(`ManagerMemberHoursMini.tsx:312`, passed down as `isHsl`). HSL members qualify a
weekend day at `hours >= 7` and get the overnight rule (`hslOvernightQualifies`,
`:539`) that combines a short day with the adjacent day to reach the 7h threshold.

> **Caller invariant:** `ManagerMemberHoursMini` has exactly one caller —
> `ManagerMemberDialog`, which passes `department`. If you add another caller, it
> **must** pass `department` or HSL members will be mis-colored against the
> non-HSL rule.

## Related

- Medals / recognition: `src/components/manager/MedalRecognition.tsx` (`MedalRecord`, `MedalType`, `MEDALS`).
- Manager-authored member notes: `PUT /api/manager/member-notes` (Notes tab).
- Employee-facing attendance/PAB: see [bonus-calculator.md](./bonus-calculator.md) and [bonus-catalog.md](./bonus-catalog.md), plus the PAB calendar logic in `src/lib/hubstaff/calendar-column-dedupe.ts`.
