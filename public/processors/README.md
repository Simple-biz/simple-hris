# Processor logos

Brand logos for the Payment Dispatch processor cards.

**There is no auto-pickup.** Nothing probes this folder — the path is written
out by hand in THREE independent registries:

| Registry | Feeds | Surface |
|---|---|---|
| `src/components/payroll-clerk/PayrollDispatch.tsx` (`PROCESSOR_VISUALS`) | the Payment Dispatch filter cards | **plated** — `ProcessorLogo`'s 80×44 white plate |
| `src/lib/employee-payment-processors.ts` | employee + Payroll Readiness pickers | **un-plated** — bare 16–20px `<img>` |
| `src/lib/contractor/invoice-payment.ts` | contractor invoice gateways | **un-plated** — bare 16–20px `<img>` |

**The artwork follows the PLATE, not the rail** (2026-08-28). A rail may carry
different assets on the plated card and the bare chips — Kolan does — but a rail
with only ONE asset must be spelled identically in all three registries, or the
same rail shows two different marks on different screens. Both rules are pinned
by `src/lib/processor-logo-assets.test.ts`; nothing else enforces them.

The live assets sit at the **public root** (`/Kolan.png`, `/kolan.svg`,
`/higlobe.png`, `/wise.png`, `/jeeves.png`), not in this folder. Until a file
exists at the referenced path the card falls back to a gradient monogram tile,
so a missing logo degrades quietly instead of leaving an empty box.

⚠️ **That quiet degrade cuts both ways.** From 2026-08-24 to 2026-08-25 all three
registries pointed at `/kolan.png` and no such file was ever added — Kolan, the
highest-volume rail, showed the gradient monogram on every screen and nothing
errored. **Whenever you change a `logoSrc`, `ls` the file — and check its CASE.**
`fs.existsSync` and the Windows/macOS filesystem resolve the wrong case happily;
Linux static serving does not, so a case slip renders locally and 404s in
production. The test compares against `readdirSync` for exactly this reason.

`ProcessorLogo.tsx` measures the decoded image: a squarish **mark** (aspect < 1.5)
gets vertical padding on the white plate, a horizontal **wordmark** fills the
plate height.

Expected files (lowercase, single word — **except `Kolan.png`**, which ships with
the capital K it was delivered under and is referenced case-exactly):

- `Kolan.png` — ✅ **INSTALLED 2026-08-28** at `/Kolan.png`. The **dark lockup**,
  2048×768, used only on the PLATED dispatch card, where it renders ~69×16px —
  within a pixel of `wise.png` on the same plate. Its ink measures 96.5% below
  luminance 128; the test rejects anything under 90%, because the official
  kolan.xyz lockup's wordmark is **WHITE** and the plate is `bg-white` in both
  themes (`docs/design/ui-standards.md` §6.4) — that one would render as a mark
  beside an invisible word. **Never install the white variant.**
- `kolan.svg` — ✅ **INSTALLED 2026-08-25** at `/kolan.svg`. The 42×42 eclipse
  **MARK**, cropped from the same lockup via `viewBox="0 3 42 42"` (no path
  re-drawn), with explicit `width`/`height` because the aspect probe reads
  `naturalWidth`/`naturalHeight` and an SVG without them measures 0 in some
  browsers. Used on the bare **un-plated** chips, where it is the only Kolan
  asset that reads: it is an opaque near-black tile with a white corona, and a
  4.4:1 lockup at 16px would be a ~4px sliver, invisible in dark mode.
  Rebranded from Hurupay on 2026-08-24; the processor **id** is still `hurupay`,
  so both assets are named after the BRAND and every `logoSrc` points at one
  explicitly. The superseded `public/hurupay.png` is unreferenced — kept, not
  deleted, per the rebrand rule that history keeps the old name.
- `wepay.svg` — Chase WePay (https://go.wepay.com/press)
- `higlobe.svg` — https://higlobe.com (their site footer / press)
- `wise.svg` — https://wise.com/press (public brand kit available)
- `jeeves.svg` — https://www.tryjeeves.com (their press / site)
- `wires.svg` — generic; not a brand. Leave the monogram fallback or use a
  bank icon if you'd rather.

Tips:

- Prefer SVG over PNG — sharp at any size, works with our resize logic.
- For the **un-plated** chips, square or near-square crops fit best (target 1:1)
  and the artwork must read on a transparent background in BOTH themes.
- Trim transparent padding so the logo fills the tile without big margins. The
  test rejects a lockup whose ink spans under 80% of its canvas width.
- If the brand logo is dark-on-light only, that's fine for the **plated** card —
  the plate sits on white. It is NOT fine for the bare chips.
- **No `mix-blend` on a logo tile** (`ui-standards.md` §6.4 / :687).
  `multiply` maps white→white and flattened the Kolan corona to a featureless
  black square in light mode. Any new blend/tint must be checked against
  artwork that CONTAINS white, not just dark-on-transparent wordmarks.
