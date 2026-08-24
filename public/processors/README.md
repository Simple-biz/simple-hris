# Processor logos

Brand logos for the Payment Dispatch processor cards.

**There is no auto-pickup.** Nothing probes this folder — the path is written
out by hand in THREE independent registries, and all three must agree or the
same rail shows different marks on different screens:

| Registry | Feeds |
|---|---|
| `src/lib/employee-payment-processors.ts` | employee + Payroll Readiness pickers |
| `src/lib/contractor/invoice-payment.ts` | contractor invoice gateways |
| `src/components/payroll-clerk/PayrollDispatch.tsx` (`PROCESSOR_VISUALS`) | the Payment Dispatch filter cards |

The live assets currently sit at the **public root** (`/kolan.png`,
`/higlobe.png`, `/wise.png`, `/jeeves.png`), not in this folder. Until a file
exists at the referenced path the card falls back to a gradient monogram tile,
so a missing logo degrades quietly instead of leaving an empty box.

`ProcessorLogo.tsx` measures the decoded image: a squarish **mark** (aspect
< 1.5, e.g. Kolan) gets vertical padding on the white plate, a horizontal
**wordmark** fills the plate height.

Expected files (lowercase, single word):

- `kolan.svg` — https://kolan.xyz/ (grab from their site / press kit). Rebranded
  from Hurupay on 2026-08-24; the processor **id** is still `hurupay`, so name
  the asset after the BRAND here and point `logoSrc` at it explicitly.
- `wepay.svg` — Chase WePay (https://go.wepay.com/press)
- `higlobe.svg` — https://higlobe.com (their site footer / press)
- `wise.svg` — https://wise.com/press (public brand kit available)
- `jeeves.svg` — https://www.tryjeeves.com (their press / site)
- `wires.svg` — generic; not a brand. Leave the monogram fallback or use a
  bank icon if you'd rather.

Tips:

- Prefer SVG over PNG — sharp at any size, works with our resize logic.
- Square or near-square crops fit the tile best (target 1:1).
- Trim transparent padding so the logo fills the tile without big margins.
- If the brand logo is dark-on-light only, that's fine — the tile sits on
  white so the logo will read.
