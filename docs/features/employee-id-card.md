# Employee ID card — the company badge, inside Profile

A read-only company ID badge in the Employee portal at **Profile → ID**, second in the
section row after Overview. It renders Full name, Work email, Latest department, Address
and Start date over the `employee_id` serial, using values the Profile screen has already
fetched. Built for Kane, 2026-09-04: *"an Image of an ID … like we would on school or
company ID"*, flat, portrait, front only, in the Simple wordmark's own navy.

Shipped 2026-09-04 (commit in `git log -- src/lib/employee/id-card.ts`).
Approved comp: <https://claude.ai/code/artifact/a45d0cb3-4790-4f56-8b64-3a12fabfb33b>

## Key files

| Piece | File |
| --- | --- |
| View-model resolution — pure, DOM-free | `src/lib/employee/id-card.ts` (+ `id-card.test.ts`) |
| The badge — presentational only | `src/components/employee/EmployeeIdCard.tsx` |
| Host — section chip, render block, `buildIdCard` call | `src/components/employee/EmployeeProfile.tsx` |
| Brand artwork | `public/simple-logo.png` (navy `#27285A`, orange `#F26F07`) |

## It is a section, not a dashboard tab

Kane, 2026-09-04: *"we would not create a new tab on this. we should just put this inside
the profile tab."* Nothing was added to the Pages registry (`src/lib/pages/visibility.ts`),
`EmployeeSidebar.tsx` or `EmployeeApp.tsx` — the card is a `TabId` inside `EmployeeProfile`
only. Two consequences worth knowing before "improving" this:

- **An admin cannot hide the ID card independently.** Hiding Profile in Pages settings
  hides the card with it. Adding it to the registry would make it a dashboard page and
  reintroduce the tab that was explicitly declined.
- `humanizeTabId` never sees `'id'`, so the presence label and document title stay
  "Profile". The Admin live-status column would have rendered `'id'` as **"Id"**, which is
  the same wart that already renders `'kpi'` as "Kpi" — avoided here by not being a tab.

## The card resolves nothing; `buildIdCard` does

`EmployeeIdCard.tsx` is presentational. Every value arrives already resolved from
`buildIdCard()` so the badge cannot disagree with the Overview section two clicks away,
and so the resolution rules are unit-testable without React.

## Department goes through `formatDeptLabel`, unconditionally

`hsl-subdepartments.md` §12: an `hsl:<key>` storage key must never reach a human.
`buildIdCard` wraps the raw cell with no conditional around it — the function is a no-op on
non-HSL labels, so wrapping is always correct and a conditional is always a bug waiting for
the next sub-department. A blank department **omits the line** rather than printing an
empty one.

The same commit fixed the Overview section's Department `Row`, which had been printing the
raw cell since before the parent-department cutover — an HSL employee was reading
`hsl:filing_specialist` on their own profile. `employmentDepartment` itself stays **raw**,
because `getTitlesForDepartment` needs the storage key as a lookup.

## Start date is a DATE column, parsed as local

`start_date` is a calendar day with no time and no zone. `new Date('2024-05-06')` parses it
as UTC midnight, so `toLocaleDateString` renders **the day before** for every viewer west of
UTC. `formatIdCardDate` therefore goes through `parseDateOnlyLocal` (`src/lib/date-only.ts`),
the project's standing rule for DATE columns, and a test pins it against a negative-offset
timezone.

**`EmployeeProfile.tsx`'s own `formatStartDate` still parses the naive way and is off by one
for those viewers.** It was left alone on purpose: it also formats pay dates and resignation
effective dates, so correcting it is a wider change than this feature. The presentation
shape here is deliberately identical, so fixing that function makes the two agree byte for
byte with no further work. Until then the ID card is the correct one.

An unparseable value is passed through **verbatim** rather than blanked — a badly typed
sheet date is still evidence, and hiding it hides the ID's own origin.

## There are two `full_address` columns. The card reads the roster one

- `global_master_list.full_address` — the HR roster record. **This is what the card and the
  Overview section read.**
- `employee_ids.full_address` — payout details, editable by the employee on Profile →
  Payment.

They can disagree, and an identity document follows the roster. Do not add a fallback from
one to the other: it would put an employee-typed payout address on a document that claims to
state the roster's record, with nothing on screen saying which one is showing. When the
roster address is blank the card reads **"Not on file"** and the caption underneath says HR
corrects it — there is deliberately no link or field, because this screen cannot write it.

`full_address` wins over the flat `street / city / province / postal_code` columns, joined in
postal order — the same composition `fullAddressDisplay` uses on Overview.

## The serial hides itself

`employee_id` is `YYMM-NNNN`, where `YYMM` comes from `start_date` (`generateEmployeeIds` in
`src/lib/supabase/employees.ts`). A person with no start date therefore has no ID at all, so
a blank `employee_id` **hides the whole footer serial** rather than printing a placeholder.

## Visual rules

Kane, 2026-09-04: *"Dont make it 3D Make it flat"* and *"Simple blue should be more dominant
than orange."*

- **Flat.** No shadow, no gradient, no inner highlight, no perspective. Separation comes
  from overlap and the grey `#E4E4EE` hairline riding above the navy diagonal — that
  hairline is the only thing letting the header read as a shape rather than a bleed.
- **Navy dominates.** Header panel and footer band are `#27285A`, roughly half the card.
  Orange `#F26F07` appears exactly twice, both as fills: the block bleeding off the top edge
  and the rule under the name.
- **Orange is never text.** `#F26F07` on white is 2.95:1 — under AA even for large text, and
  PRODUCT.md targets AA. Every label and the name are navy.
- **The footer band has a straight top edge.** An earlier comp sloped it, and its high corner
  sat above the record block, so a long address ran underneath the navy. The straight edge
  plus `mt-auto` on the record makes the overlap structurally impossible: a third address
  line grows into the gap, not the band. **Do not re-slope it.**
- **The address never truncates.** A partial address on an identity document is worse than an
  absent one.
- **The card never themes.** White ground, navy geometry, orange accent, identical in light
  and dark — there is not one `dark:` variant in the component. Only the surface behind it
  changes.
- **The wordmark sits on a white plate**, `object-contain`, no `mix-blend` (ui-standards
  §6.4). It is dark-on-transparent artwork; a navy tile swallows it.
- Type and geometry are sized in `cqw` against an `@container`, so the badge scales as one
  object. Tailwind arbitrary values must stay **literal** — an interpolated class is absent
  from the build and renders unstyled.

## Photo

Upload → Google SSO → initials, the same ladder `EmployeeAvatar` uses, walked with `onError`
so a dead URL degrades to initials instead of a broken frame. The card does not reuse
`EmployeeAvatar` because that component's initials fallback is an orange→blue **gradient**
circle, which contradicts the flat rule above.

## Deploy notes

**No migration.** Every column already exists on `global_master_list` (`name`, `work_email`,
`department`, `full_address` / `street` / `city` / `province` / `postal_code`, `start_date`,
`employee_id`). No new table, no new API route, no env var, no n8n import — the card reads
values `EmployeeProfile` already fetches through `/api/employees?email=` and
`/api/employee-master-record?email=`, both already filtered server-side to one person.

No write path exists on this surface. There is no download, print or PDF in this pass.
