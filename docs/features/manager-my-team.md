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

## Suspend / Reactivation (the manager temporary-pause pair)

Row actions in the My Team **list** and in every roster **card footer** (kept in
lockstep): View · Suspend · Reactivation · Offboard. Suspend and Reactivation are
the manager-facing replacement for the `temporary_pause` reason, which is
deliberately `disabled:` in the manager offboard modal — see
[offboarding-automation.md](./offboarding-automation.md).

Both ride one route: `POST /api/manager/temp-pause` `{ email, action: 'suspend' | 'reactivate' }`.
Manager or admin only, dept-scoped; a **dual-department person authorizes on ANY
managed roster row** (`.filter` + `.some`, never `.find` — row-order dependence
was a real bug) and the envelope carries the **department union**.

> **Neither writes anything to the roster.** No `global_master_list` stamps, no
> queue row — `audit_log` only (`manager.suspended` / `manager.reactivated`,
> `resource_id` = work email). Account state lives on the n8n/Workspace side, so
> **the webhook IS the action**: a webhook failure fails the request (502).
> Reactivation is therefore always enabled — there is no DB flag to read.

### The two envelopes are NOT the same shape

Envelope builders are pure and unit-tested in
`src/lib/hr/manager-temp-pause-webhooks.ts` (`.test.ts` pins both contracts —
the reactivate test is a whole-object `deepEqual` on purpose).

| | Suspend | Reactivation |
|---|---|---|
| Slug | `manager_suspend` | `manager_reactivate` |
| Default URL | `.../webhook/offboarding-deactivate` (shared with HR temp pauses) | `.../webhook/hris-reactivate-suspended` |
| Envelope | the **exact HR `temporary_pause` offboard envelope** — `event employee.offboarded`, `phase deactivate`, `deletion_mode "none"`, `hubstaff_pay_rate 0`, `off_boarded_by/_at`, plus additive `source: "manager_suspend"` | its **own** envelope — `event employee.reactivate`, `phase reactivate`, `reactivated_by`, `reactivated_at`, `count`, `employees[]` |
| Per-item fields | identity + `reason: "temporary_pause"`, `note`, `off_boarded_by/_at`, `scheduled_deletion_at: null` | identity + `note`, `reactivated_by`, `reactivated_at` |

> **Source of truth:** the Reactivation envelope above is the contract Kane
> verified against the live flow on **2026-08-10**. It carries **no** `reason`,
> `action`, or `source` — the flow only re-enables the account and sends a
> confirmation email, so `note` is carried for shape but is always `null` (the
> button has no note input). Do not "harmonize" it back onto the offboard
> envelope.

Suspend keeps mirroring the offboard envelope because that is how the existing
n8n deactivate flow branches to suspend-only with zero n8n changes — changing
`deletion_mode`, `phase`, or `reason` there changes what happens to the person's
account. **Temp pause must never schedule a deletion.**

Changing either slug or URL means **five sync points**:
`src/lib/hr/offboard-webhooks.ts` (slug + default URL + env branch) ·
`AdminWebhooks.tsx` `KNOWN_SLUGS` · `src/lib/webhooks/sample-payloads.ts` ·
`references/sql/seed/seed_webhooks_config.sql` · `.env.example`.

## Related

- Medals / recognition: `src/components/manager/MedalRecognition.tsx` (`MedalRecord`, `MedalType`, `MEDALS`).
- Manager-authored member notes: `PUT /api/manager/member-notes` (Notes tab).
- Employee-facing attendance/PAB: see [bonus-calculator.md](./bonus-calculator.md) and [bonus-catalog.md](./bonus-catalog.md), plus the PAB calendar logic in `src/lib/hubstaff/calendar-column-dedupe.ts`.
