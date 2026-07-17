# Accounting — MESA: Export (PDF / XLSX / CSV)

Every tab of Accounting → MESA (Requests · Non Members · MESA Active Members)
has an **Export** dropdown in its toolbar (next to Refresh), added Jul 17, 2026.
Component: `src/components/payroll/AccountingMesa.tsx` (`MesaExportMenu`), plus
the new export module.

## Module

- `src/lib/accounting/mesa-export.ts` — **fully client-side** (in-memory Blob
  download, no server round-trip), modeled on
  `src/lib/hr/global-master-list-export.ts` but **spec-driven**: each tab
  builds a `MesaExportSpec` (title, scope label, stat band, columns with
  PDF-weight/XLSX-width, pre-formatted string rows, optional note lines) over
  its **filtered** rows, so what you see is what exports.
- **CSV**: BOM + RFC-4180 escaping, provenance preamble (scope, timestamp,
  stats, notes).
- **XLSX**: SheetJS with merged title banner + autofilter (community-edition
  writer emits no cell colors/freeze panes — theme is structural).
- **PDF**: themed to match the **CEO dashboard** (warm orange→rose gradient,
  amber/gold stat cards, warm zebra rows) — same deliberate choice as the HR
  Global Master List export, not the Accounting teal.
- Money is exported as `PHP 1,234.56` (the `₱` glyph isn't in pdf-lib's
  WinAnsi Helvetica; `sanitize()` also maps `₱` → `PHP ` defensively).

## Per-tab content

- **Requests** (`mesa-requests-YYYY-MM-DD.*`): employee, email, department,
  type, details (reason + explanation), amount, status, submitted, reviewed by.
  Stat band (In this export / Pending / Approved / Denied) is recomputed over
  the filtered set so it always matches the row count.
- **Non Members** (`mesa-non-members-*`): name, department, email. Note line
  clarifies opted-out ex-members are not listed (they're former members).
- **Active Members** (`mesa-active-members-*`): member, email, account #,
  department, contributed, matched, disbursed, balance, member since. Money
  stat band recomputed over the filtered set.

## Per-stint account caveat (carried as a note on the Active Members export)

Figures are scoped to each member's **current (open) MESA account number**
(see `summarizeMemberAccount` in `src/lib/mesa/ledger.ts`). Opting out closes
that account — its history is **retained** in the MESA ledger under the
previous account number, nothing is deleted — and a re-join opens a fresh
`YY-MM-#####` account starting from PHP 0. The exported document states this
so a reader can't misread a re-joined member's small balance as data loss.
