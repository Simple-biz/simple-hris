# Employee ID card — Profile section

Approved comp: https://claude.ai/code/artifact/a45d0cb3-4790-4f56-8b64-3a12fabfb33b

A read-only company ID badge inside the Employee portal's **Profile** screen, as a new
section next to Overview. Renders Full name, Work email, Latest department, Address,
Start date and the `employee_id` serial. No new dashboard tab, no new route, no writes.

Decisions taken at approval (Kane, 2026-09-04, "Lets ship"):

- Section chip inside Profile, **after Overview** — not a dashboard tab.
- Photo uses the existing ladder: upload → Google SSO → initials.
- No download / print / PDF in this pass.
- Home address stays on the card, not behind a show/hide.
- Card is flat: no shadow, no gradient. Navy dominates; orange is fill-only.

## Tasks

- [ ] 1. `src/lib/employee/id-card.ts` — pure view-model builder
  - [ ] `buildIdCard()` resolves name, work email, department (through `formatDeptLabel`),
        address, start date, serial, initials, photo source
  - [ ] every field null-safe; nothing throws on an empty master row
- [ ] 2. `src/lib/employee/id-card.test.ts` — `node --test`
  - [ ] `hsl:filing_specialist` → `HSL — Filing Specialist`
  - [ ] address from `full_address`, else joined parts, else null
  - [ ] name falls back to the email prefix
  - [ ] start date matches Profile's own `formatStartDate` output exactly
  - [ ] blank `employee_id` hides the serial
  - [ ] photo order: upload beats Google SSO beats initials
- [ ] 3. `src/components/employee/EmployeeIdCard.tsx` — presentational, props only
  - [ ] CR80 upright (`aspect-ratio: 54/85.6`), container queries for type scale
  - [ ] navy header with one diagonal, straight-edged navy footer band
  - [ ] wordmark on a white plate (ui-standards §6.4)
  - [ ] address wraps, never truncates; footer band cannot overlap the record
- [ ] 4. Wire into `src/components/employee/EmployeeProfile.tsx`
  - [ ] `TabId` gains `'id'`; tabs array gains the chip after Overview
  - [ ] render block reusing the screen's existing resolved values
  - [ ] import `formatDeptLabel` and fix the raw department on the Overview Row
- [ ] 5. Typecheck / build (check for a live `next dev` first — shared `.next/`)
- [ ] 6. Docs: `docs/features/employee-id-card.md`, INDEX row, memory + MEMORY.md pointer
- [ ] 7. One commit, explicit paths, direct to `main`. Never push.

## Out of scope

Dashboard tab registry (`visibility.ts`, `EmployeeSidebar.tsx`, `EmployeeApp.tsx`),
`humanizeTabId`, download/print, any write path, Manager/HR/Admin surfaces, a reverse face.
