# HR — Global Master List: Export, View dialog, Sync deprecation

Three additions to the HR → Global Master List tab (Jul 17, 2026, session
`ffc64f41`), all in `src/components/hr/HrGlobalMasterList.tsx` plus the new
export module.

## Export (PDF / XLSX / CSV)

- Module: `src/lib/hr/global-master-list-export.ts` — **fully client-side**
  (in-memory Blob download, no server round-trip), modeled on the existing
  `onboarding-export.ts` pattern. Exports whatever the current filter/search
  shows.
- **CSV**: BOM + RFC-4180 escaping (Excel-safe).
- **XLSX**: SheetJS with an autofilter. (A freeze pane was attempted and
  removed — the community-edition writer silently drops `!freeze`.)
- **PDF**: themed to match the **CEO dashboard** (warm orange→rose gradient,
  amber/gold accents, `#0d1117` dark) — a deliberate product choice, not the
  HR emerald.
- UI: an **Export** dropdown (custom inline component — the repo has no
  dropdown primitive) in the toolbar row: Dept filter · Search · **Export** ·
  View toggle. The tab's Card is overridden to `overflow-visible` so the menu
  isn't clipped when the roster is short.
- Exported dates use the same `new Date(iso)` timezone behavior as the
  on-screen `fmtDate`, so exports match what HR sees.

## Per-card View dialog

Each roster card footer has an emerald **View** (Eye) button opening a
self-contained employee detail dialog (`EmployeeDetailDialog` in the same
file): avatar with online/offline presence dot, name, employee ID, department
chip, live-status pill, and a 2-column field grid — work / personal /
alternate emails, start date, tenure, phone, location. Field list matches the
Admin "Master list information" pane. There is intentionally no shared
employee-detail modal to reuse (verified before building).

## Sync deprecation warning

Clicking the hero **Sync** button now opens a warning dialog (AlertTriangle,
house convention): the sheet-sync feature will soon be deprecated as data
management moves HRIS-native. A "Sync anyway" action still runs the existing
`handleSync`. Context: the master-list sheet sync has a known concurrency race
(see [audit-2026-07-17-session-log.md](../audits/audit-2026-07-17-session-log.md)
— overlapping syncs once collapsed the active roster 1109 → 390), which is
part of why the direction of travel is away from sheet syncs.
