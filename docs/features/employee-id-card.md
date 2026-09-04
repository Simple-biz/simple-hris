# Employee ID card — the company badge, inside Profile

A read-only company ID badge in the Employee portal at **Profile → ID**, second in the
section row after Overview. It renders Full name, Work email, Latest department, Address
and Start date over the `employee_id` serial, using values the Profile screen has already
fetched. Built for Kane, 2026-09-04: *"an Image of an ID … like we would on school or
company ID"*, portrait, front only, milled metal in the Simple wordmark's own navy.

Shipped 2026-09-04 (commit in `git log -- src/lib/employee/id-card.ts`).
Approved comp: <https://claude.ai/code/artifact/a45d0cb3-4790-4f56-8b64-3a12fabfb33b>

## Key files

| Piece | File |
| --- | --- |
| View-model resolution — pure, DOM-free | `src/lib/employee/id-card.ts` (+ `id-card.test.ts`) |
| The badge — presentational only | `src/components/employee/EmployeeIdCard.tsx` |
| PNG export — canvas painter | `src/lib/employee/id-card-render.ts` (+ `id-card-render.test.ts`) |
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

Kane, 2026-09-04: *"Simple blue should be more dominant than orange"*, then *"make the
design kind of like a metallic card ... that has shining slow effects on it"* — which
**supersedes** the earlier *"Dont make it 3D Make it flat"*. The surface is now milled
metal. Everything structural below survived that change unaltered.

### The metal

Three things do the work, and none of them is a drop shadow:

- **Raking-light ramps** on every surface — navy `#35366F → #27285A → #1E1F48`, silver
  `#FFFFFF → #F7F8FC → #ECEDF4`, orange `#FF8B2D → #F26F07 → #D75E02`.
- **Anisotropic brush lines** — 1px, 3px apart, 6° off horizontal, at `0.05` white on the
  navy and `0.032` navy on the silver. **These are what actually read as metal.** A gradient
  on its own reads as a gradient; delete the brush and the card goes back to looking flat.
- **One slow specular sweep**, 9s, travelling in the first 52% of the cycle and resting for
  the remainder. One authored moment, not scattered shimmer.

`ID_CARD_METAL` in `id-card-render.ts` holds the ramps, and `EmployeeIdCard.tsx` mirrors
them in literal CSS. Change one, change the other.

### The sweep is bounded twice, and both bounds are contrast rules

1. **It passes UNDER the content, never over it.** Glyphs sit at `z-4`, the sheen at `z-2`,
   so no text is ever composited through it. This also keeps it off the wordmark, which
   must never be blended (ui-standards §6.4).
2. **It stops at the footer band** (`ID_CARD_GEOMETRY.sheen.height`; the component mirrors
   it as `h-[89%]`). The band carries the only light-on-dark text on the card, and at peak
   sheen **no mid-tone ink survives on lightened navy** — the periwinkle `#A9AAD0` label
   falls to 2.2:1. Brightening the ink cannot fix a ground that light, so the sheen never
   reaches it. Every other surface it crosses either holds no text, or holds dark ink on
   light metal where lightening only helps.

`sheenPeakAlpha` (0.28) is a **contrast budget, not a taste knob**, and tests pin all of it:
the label's ratio on the unlit band, the proof it would fail if lit, and the region bound.
Raising the alpha or extending the region fails the suite.

`prefers-reduced-motion` **parks** the sweep rather than deleting it — the card keeps its
caught-the-light look and simply stops moving.

### Structural rules — unchanged by the metal

- **Navy dominates.** Header panel and footer band are navy, roughly half the card. Orange
  appears exactly twice, both as fills: the block bleeding off the top edge and the rule
  under the name.
- **Orange is never text.** `#F26F07` is 2.95:1 on white — under AA even for large text, and
  PRODUCT.md targets AA. A test scans the component and fails if orange colours any text.
- **The footer band has a straight top edge.** An earlier comp sloped it, and its high corner
  sat above the record block, so a long address ran underneath the navy. The straight edge
  plus `mt-auto` on the record makes the overlap structurally impossible: a third address
  line grows into the gap, not the band. **Do not re-slope it.**
- **The address never truncates.** A partial address on an identity document is worse than an
  absent one.
- **Ink is measured against the metal, not against white.** "Not on file" is `#666881`
  because the silver body's darkest stop is `#ECEDF4`, not `#FFFFFF` — `#6E7086` clears AA
  on paper and fails at 4.16:1 on the card. Test both ends of the ramp when changing ink.
- **The card never themes.** Same surface in light and dark — there is not one `dark:`
  variant in the component, and a test fails if one appears. Only what sits behind it changes.
- **The wordmark sits on a flat white plate**, `object-contain`, no `mix-blend` (ui-standards
  §6.4). The plate is deliberately flat white, not silver: a ramp under the wordmark tints it.
- Type and geometry are sized in `cqw` against an `@container`, so the badge scales as one
  object. Tailwind arbitrary values must stay **literal** — an interpolated class is absent
  from the build and renders unstyled.

## Photo

Upload → Google SSO → initials, the same ladder `EmployeeAvatar` uses, walked with `onError`
so a dead URL degrades to initials instead of a broken frame.

**Initials strip punctuation before taking the letter, and a name splits on whitespace and
commas only.** Roster names carry parenthesised maiden names and quoted nicknames:
`Reroma (Teves), Jan Kane "Kane"` rendered `R"` on a real badge, because the last "word" was
`"Kane"` and its first character was the quote mark. A hyphen **joins** in a name —
`Mary-Anne` is one given name — so only the email fallback keeps `. _ -` as separators. That
one was found by rendering a badge, not by a test. The card does not reuse
`EmployeeAvatar` because that component's initials fallback is an orange→blue gradient
circle, which belongs to no surface on this card.

## Download PNG — two renderers, one view model

Added 2026-09-04 on Kane's ask. `EmployeeIdCard.tsx` draws the badge in the DOM;
`renderIdCardPng` in `src/lib/employee/id-card-render.ts` paints the same design onto a
canvas at 3x and hands back a PNG — the same metal, painted statically, with the sweep
frozen at `sheenCenter` and the band repainted over its tail. Both read the same `IdCard`
from `buildIdCard`, so the
data can never differ — but **the layout is now written twice, and that is the standing
hazard on this surface**. `ID_CARD_GEOMETRY` holds every number as a fraction of the card's
own width or height, which is exactly what the component's `cqw` classes are: change one,
change the other. The Tailwind classes deliberately cannot be generated from those
constants, because an interpolated class is absent from the build and renders unstyled.

A DOM screenshot was rejected: rasterising this card means a new dependency or an SVG
`foreignObject` clone, and both resolve container queries and Tailwind's cascade
unreliably.

**The canvas must not be tainted.** A photo drawn from another origin without CORS makes
`toBlob` throw a `SecurityError`, which presents as a download button that does nothing at
all. Every photo therefore loads with `crossOrigin = 'anonymous'`, and a host that will not
send the header fails the load instead — the painter walks to the next candidate and then
to initials. Never drop that flag to "make the photo show up".

**Failures degrade; two abort loudly.** A missing photo paints initials, a blank address
prints "Not on file" exactly as the screen does, and a blank `employee_id` hides the serial.
The two that raise `IdCardRenderError` are an unloadable `/simple-logo.png` — an unbranded
rectangle claiming to be a company ID is worse than no file — and a canvas the browser
cannot encode. Both carry a sentence written for the employee, surfaced as a toast.

`ctx.letterSpacing` is **not** used: it silently does nothing in older engines, which would
collapse every tracked label in exactly the browsers hardest to spot it in. Tracked text is
drawn one glyph at a time instead, and **the font size for that spacing is passed in — never
read back off `ctx.font`.** The canvas normalises that property, so it returns
`"600 12.65px …"` and `parseFloat` yields the **weight**, not the size. That shipped in the
first PNG: the footer serial spaced its glyphs at 600 × 0.05 = 30px and ran straight across
the "EMPLOYEE ID" label. It hid at every other call site only because weight `700`
serialises to the keyword `bold`, so `parseFloat` returned `NaN` and a fallback stood in at
roughly the right size — approximately right by accident. A source-scan test now fails if
`parseFloat(ctx.font)` reappears, and `trackedTotalWidth` is pinned separately.

The filename is `simple-id-<employee_id>.png`, falling back to a slug of the name and then
to `simple-id-card.png`. Everything outside `[a-z0-9-]` is collapsed and the stem is capped,
so a name with a quote, a slash or no Latin characters cannot produce an unsaveable file.

**An elevated `?email=` viewer may download the badge they are previewing.** The doc was
silent, and this is the decision: a download grants no access the viewer does not already
have — the same five fields are on screen, and the card carries no bank data — so a gate
would be theatre that also stops HR helping someone. If that ever needs to change, gate it
where identity is resolved (`EmployeeApp.tsx`), not on the button.

## Deploy notes

**No migration.** Every column already exists on `global_master_list` (`name`, `work_email`,
`department`, `full_address` / `street` / `city` / `province` / `postal_code`, `start_date`,
`employee_id`). No new table, no new API route, no env var, no n8n import — the card reads
values `EmployeeProfile` already fetches through `/api/employees?email=` and
`/api/employee-master-record?email=`, both already filtered server-side to one person.

No write path exists on this surface. **Download PNG** is client-side only — the file is
painted in the browser and never uploaded, so there is no route, no storage bucket and
nothing to retain. There is still no print or PDF.
