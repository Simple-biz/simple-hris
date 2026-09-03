# Payment Catalog — Pay Processors tab (the processor registry)

Accounting → **Payment Catalog → Pay Processors** is the registry of every processor
Accounting sends salaries **from** — Kolan, HiGlobe, Wise, Jeeves, the x1153 wire
account — with a logo, a classification (**One-to-one** wallet vs **Multi-peer** bank
rail), an active/retired status, a blurb and notes. It is, by Kane's decision on
2026-09-03, **the source of truth for processors**: Payment Dispatch will soon read it to
build one bucket per active processor. Add and edit only; nothing is ever deleted.
Shipped 2026-09-03 (commit in `git log -- src/components/accounting/PayProcessorsTab.tsx`).

Sibling docs: [bonus-catalog.md](./bonus-catalog.md) (the host tab),
[payment-catalog-departments.md](./payment-catalog-departments.md) (the registry precedent
this copies), [bank-preferred-routing.md](./bank-preferred-routing.md) §4 (the 1:1 rule
the One-to-one class describes), [payment-dispatch.md](./payment-dispatch.md) §3.3.1 (logo
assets).

## Key files

| Piece | File |
| --- | --- |
| Model, seeds, validation, merge, pure mutations (client-safe) | `src/lib/payment-catalog/pay-processors.ts` (+ `pay-processors.test.ts`) |
| Storage — `app_settings` JSON behind compare-and-swap | `src/lib/payment-catalog/pay-processors-db.ts` |
| API — GET merged list · POST create · PATCH edit | `app/api/payment-catalog/pay-processors/route.ts` |
| Tab UI — cards, add/edit dialog, logo upload | `src/components/accounting/PayProcessorsTab.tsx` |
| Host — tab entry, fetch, realtime filter | `src/components/accounting/BonusCatalog.tsx` |
| Logo plate (shared with Payment Dispatch cards) | `src/components/payroll-clerk/ProcessorLogo.tsx` |
| The code registries this tab describes but does not yet drive | `src/lib/employee-payment-processors.ts` (`PROCESSOR_OPTIONS`, `WALLET_RAILS`, `BANK_PREFERRED_OPTIONS`) |

## 1. Storage — one `app_settings` row, **no migration**

The registry is a JSON array under `payment_catalog.pay_processors.registry`
(`PAY_PROCESSORS_SETTING_KEY`). No table, no SQL — the same decision as the Department
registry, for the same reason (rare, small, single-team edits).

Each `PayProcessor` row:

| Field | Rule |
| --- | --- |
| `id` | Stable slug. For code-wired processors it **is** the `ProcessorId` — and **`hurupay` stays `hurupay` forever** (label "Kolan"). It is the literal stored in `employee_ids.bank_preferred` and what `isWiresPreferred` compares against; renaming it would classify ~700 Kolan payees as WIRES ([hurupay-kolan-rebrand](../../../.claude/projects/c--Users-Kane-Desktop-simple-hris/memory/hurupay-kolan-rebrand.md)). Custom rows get `slugifyProcessorId(label)`. **Immutable after creation** — a rename changes `label` only. |
| `label`, `blurb`, `notes` | Free text, bounded (40 / 80 / 500). |
| `routing` | `one_to_one` \| `multi_peer` — §2. |
| `status` | `active` \| `retired`. **Retire, never delete.** Old dispatch rows keep a label. |
| `logo` | `{kind:'public', src}` — only one of the shipped seed assets — or `{kind:'data', dataUrl, mime, bytes}` — an upload, inline. §3. |
| `wiredInCode` | **Derived from `PROCESSOR_OPTIONS` on every read, never trusted from the blob.** A stored row cannot promote itself to "wired" or demote a wired id. |
| `createdBy/At`, `updatedBy/At` | Attribution. Immutable creation; a never-saved seed carries the epoch stamp until its first edit, which then records who materialised it. |

Two storage rules, both load-bearing:

- **A failed read THROWS** (`readPayProcessorRegistry`). A transient DB error must never
  read as "nobody has saved anything", because the next write would persist a registry
  missing every row that was there. Corrupt JSON surfaces as empty and is **not** written
  back; only an explicit save overwrites it. The host keeps the **prior** list when a fetch
  fails — an empty tab reads as "every processor is gone", not as an error.
- **Writes are compare-and-swap** (`mutatePayProcessorRegistry` → `casUpdateAppSetting`,
  retried up to 4×). Two Accounting people editing two different processors at the same
  moment both land; a plain upsert would silently drop one. A conflict that survives the
  retries is a **409**, and the client says "try again".

## 2. Classification — what "One-to-one" and "Multi-peer" mean

Kane's words, 2026-09-03: *"one to one like Kolan and Higlobe"* and *"another bank that is
compatible with another bank like multi peer"*, with Wise as the multi-peer example.

| Class | Meaning | Code today |
| --- | --- | --- |
| `one_to_one` | A **wallet**. Money is sent from this processor into the same wallet the person receives on, so the receiving channel and the send-from rail are physically one account. This is the 1:1 rule of bank-preferred-routing.md §4. | `WALLET_RAILS = ['hurupay','higlobe']` |
| `multi_peer` | A **bank rail**. It can send into any receiving bank the person has. **It is a flag, not a list** — Kane declined a "compatible banks" picker (Q2); Wise pays into anything. | Everything not in `WALLET_RAILS` |

**Seeds mirror code exactly** (`codeSeedProcessors()`): Kolan and HiGlobe one-to-one; Wise,
Jeeves, x1153 (`wires`) and Wepay multi-peer; **Wepay retired** (Kane: *"we have to retire
this Wepay thing"*); everything else active. The `wires` row is labelled **x1153** because
that is what the Bank Preferred dropdown already calls it; there is one row for it, not one
per wire account (Q4).

### 2.1 Drift — the registry is right, the code is what pays

Routing today still reads the compile-time `ProcessorId` union and `WALLET_RAILS`
(10 consumer files, three normaliser copies, the fail-closed 1:1 guard). **This tab does
not change what Payment Dispatch does** — that is the integration Kane called "soon", and
it is a separate brief under the hardening check because it moves money.

So when a wired row's registry classification disagrees with `codeRoutingFor(id)`, the
card shows an amber **"Dispatch: One-to-one"** chip and the tab shows a notice. `routingDrift`
is **surfaced, never auto-resolved** in either direction: the registry is what Kane wants,
the code is what currently pays, and silently reconciling one to the other would hide the
exact fact the integration has to act on. The PATCH does **not** refuse the edit — this is
the source of truth, and refusing would make the tab lie about being one.

A **custom** row (not in `PROCESSOR_OPTIONS`) carries a **"Not wired yet"** chip and a
notice: nobody can be routed on it until engineering adds the id. The chip is amber
because it is a warning about money that cannot move, not a decoration.

## 3. Logos

Logos render on **`ProcessorLogo`'s 80×44 white plate** — the same surface as the Payment
Dispatch cards — so seeds use the **plated** artwork `PROCESSOR_VISUALS` uses, which for
Kolan is the dark lockup **`/Kolan.png`**, not the `/kolan.svg` mark the bare pickers draw.
`pay-processors.test.ts` checks every seed path against `readdirSync(public/)` case-exactly,
because `fs.existsSync` lies on Windows and prod static serving does not, and a missing
asset falls back to the monogram tile with nothing erroring.

Uploads are stored **inline as data URLs** (Q3 — no storage bucket, no external step):

- MIME allowlist PNG / SVG / WebP / JPEG, **≤150 KB**, measured from the actual base64
  length — never from the caller's `bytes` claim, which must agree within 3 bytes.
- The declared MIME must match the `data:<mime>;base64,` prefix; the payload must be
  valid base64.
- SVG is allowed because every logo renders **only through `<img src>`**, where an SVG
  cannot run script. Never inline a stored SVG into the DOM.
- `public`-kind logos are accepted **only** from `ALLOWED_PUBLIC_LOGO_SRCS` (the seed
  assets). An arbitrary path is refused — upload the file instead.
- On read, a logo that fails validation is **dropped to null rather than failing the
  row** — a bad image must not make a processor vanish, because a vanished processor is
  indistinguishable from a retired one.

## 4. The tab

Header + **"Add a Processor"** (same hero button as "Create a Department"). **Active**
grid of cards: logo plate (monogram tile fallback tinted by class), label, blurb,
classification chip, "Wired for dispatch" / "Not wired yet", drift chip, pencil to edit.
**Retired** section collapsed behind "Show N". One dialog for add and edit: name (with the
slug it will get, on create), blurb, logo upload/drop previewed on the real plate,
classification radios with plain-words help, active/retired switch, notes, and an inline
drift warning when a wired row's class is being changed. Height-capped with a scrolling
body per `docs/design/responsive-design.md` "Dialogs and modals".

Validation runs **client-side for button gating and server-side before any write**
(`validatePayProcessorInput`); create checks the slug against the **live merged** id set
so a custom "Wise" can never shadow the wired rail.

**Access.** GET shares the Payment Catalog read gate (`requireRateVisibilitySession`);
POST and PATCH require `requireFeatureEdit('accounting','bonus_catalog')` — the same
feature that governs the whole tab. Every write audits `pay_processor.create` /
`pay_processor.update` (resource `payment_catalog_pay_processors`, with the previous
label/class/status on edits), best-effort.

**Live.** `BonusCatalog` subscribes to `postgres_changes` on `app_settings` filtered to
this one key, so a teammate's edit shows up without a refetch on unrelated setting bumps.

## 5. What this tab is NOT (yet)

- It does **not** route money. `PROCESSOR_OPTIONS`, `WALLET_RAILS`, `BANK_PREFERRED_OPTIONS`,
  the three normalisers, `isWiresPreferred`, `isBankPreferredAllowedForReceiving`, the
  dispatch tabs and the pickers all still read code. The Payment Dispatch integration —
  one bucket per active registry row — is the next brief.
- It does **not** delete. Retire instead.
- It does **not** push labels or logos into any other surface. Renaming Kolan here renames
  it here.

## Deploy notes

**No migration.** No env vars, no n8n, no storage bucket. The `app_settings` row is created
on the first save; before that the tab shows the code seeds. Nothing for Kane to run.
