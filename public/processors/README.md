# Processor logos

Drop a real SVG (or PNG) here named `{processor-id}.svg` and the Payment
Dispatch UI picks it up automatically. Until the file exists, the UI falls
back to a gradient monogram tile so the design still looks finished.

Expected files (lowercase, single word):

- `hurupay.svg` — https://hurupay.com (grab from their site / press kit)
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
