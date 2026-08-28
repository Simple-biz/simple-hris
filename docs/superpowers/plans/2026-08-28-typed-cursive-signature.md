# Documents — typed cursive signature + pointer-registration fix

Approved brief (rev 2) 2026-08-28. Two deliverables in one commit, both inside the
signature-capture surface:

1. A **Type** mode beside the existing draw pad: the signer types their name and picks one
   of six self-hosted cursive faces; the result is rasterised to the *same* trimmed PNG
   data URL a drawn signature produces.
2. A fix for the **pointer↔ink offset** in the draw pad (Kane: *"the pointer doesn't
   actually point properly to the ink"*).

## Kane's rulings

- **Q1 onboarding — NO.** `app/onboarding/[token]/page.tsx` keeps its own private
  `SignaturePad` (4 sites). It carries the *same* registration bug; it is deliberately not
  touched here and is recorded as open.
- **Q2 "Enhance" = the registration bug**, not a beautification pass.
- **Q3 Draw stays the default**, Type sits to its right.
- **Q4 typed signatures are allowed on every document type, COE included.** No per-type
  refusal, no gate, no acknowledgement. One **non-blocking** advisory on the employee's
  Request Documents form, worded for the reader who will hand the PDF to a bank.

## Root cause of the offset (measured, not guessed)

`components/ui/dialog.tsx:58` opens `DialogContent` with
`data-open:zoom-in-[0.94] slide-in-from-bottom-6` over 320ms. `SignaturePad`'s `resize()`
runs on mount — *during* that transform — and sizes the bitmap from
`getBoundingClientRect()`, which returns the **transformed** box:

    canvas.width = 0.94 · W · dpr        then   ctx.scale(dpr, dpr)

so the drawing surface spans `0.94 · W` CSS units, stretched across the displayed `W`.
Pointer coordinates are taken later from a settled, full-size rect and range `0..W`. Ink
therefore lands at ~0.94× the pointer's distance from the left edge: **zero error at the
left edge, ~6% of the pad width at the right** (~1 cm on a 640 px pad), with the same
again vertically from `slide-in-from-bottom-6`.

`ResizeObserver` never corrects it, because a CSS transform does not change the layout
box it observes — so the wrong bitmap size sticks for the life of the dialog.

**Not the fix:** deferring `resize()` past the animation. That makes the symptom rarer
while leaving browser page-zoom and any future ancestor transform broken.

**The fix, two independent halves:**
1. size the bitmap from `offsetWidth/offsetHeight` — the layout box, which ignores
   ancestor transforms;
2. divide out the live `rect` ratio when mapping each pointer event, so any residual
   transform is cancelled at draw time rather than assumed away.

Either half removes the offset; both together also stop the raster being 6%
under-resolution.

## Tasks

- [ ] 1. `scripts/fetch-signature-fonts.mjs` + `public/fonts/signature/*` — six OFL faces,
      latin + latin-ext, self-hosted. **Self-hosted is a guard, not a preference**: canvas
      2D does not report a missing font, so a CDN miss would save a signature that is not
      cursive with no error anywhere.
- [ ] 2. `src/lib/documents/signature-canvas.ts` — pure `canvasPointFromEvent()` +
      `bitmapSizeFor()`. The Q2 fix lives here, out of the effect, so it is testable with
      no DOM. Tests cover the 0.94 mid-animation case, page zoom, and dpr > 1.
- [ ] 3. `src/lib/documents/signature-fonts.ts` — the six-face registry + `coversText()`
      built from the shipped `unicode-range`s, mirroring `isCoveredBySubset()` in
      `src/lib/pdf/fonts.ts`.
- [ ] 4. `src/lib/documents/signature-render.ts` — pure raster plan: export height, the
      `scale ≤ 1` floor both PDF renderers impose, and the 300 000-char budget.
- [ ] 5. `src/components/common/SignaturePad.tsx` — Draw | Type, one `onChange`.
- [ ] 6. `src/components/accounting/AccountingDocuments.tsx` — dialog copy.
- [ ] 7. `src/components/employee/RequestDocumentsTab.tsx` — the advisory.
- [ ] 8. Docs: `documents-tab.md` § The signature · INDEX row 26 · memory + MEMORY.md line.
- [ ] 9. `npm test`, typecheck, and re-run `coe-document.test.ts` with a typed PNG.

## Invariants this build must not break

| Rule | Where |
|---|---|
| Signature is a PNG/JPEG **data URL**, ≤ 300 000 chars | `signatures.ts:17` · `types.ts:114` |
| Both PDF renderers scale-to-fit and **never upscale** (`scale ≤ 1`) | `coe-document.ts:450` · `sign-pdf.ts:232` |
| The COE is **one page**, pinned by tests | `coe-document.test.ts` |
| Approvals stamp the **approver's own** row | `documents-tab.md:270` |
| Nothing server-side changes — no route, no lib, no schema | brief `SCOPE out:` |
