// A dependency-free PNG decoder, and the ink measurements that decide whether a
// brand logo is legible on the white plate.
//
// Lifted out of `src/lib/processor-logo-assets.test.ts`, which decoded PNGs inline
// to prove Kolan's lockup is dark-inked. `scripts/fetch-bank-logos.mts` needs the
// SAME judgement at download time — a logo that fails the check must never reach
// `public/` — so the decoder became a module rather than a second copy that drifts.
//
// `sharp` is only a transitive Next.js package, absent from package.json, so this
// uses node's own `zlib`. That is deliberate: a check that cannot run without an
// undeclared dependency is not a check.

import zlib from 'node:zlib';

export interface DecodedPng {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel, top-to-bottom. */
  rgba: Buffer;
}

/**
 * Bytes (or palette indices) per pixel for the colour types this decoder handles.
 * Type 3 is PALETTE: one index per pixel, resolved through PLTE/tRNS.
 */
const BYTES_PER_PIXEL: Record<number, number> = { 0: 1, 2: 3, 3: 1, 6: 4 };

/**
 * Decode an 8-bit greyscale / RGB / palette / RGBA, non-interlaced PNG to RGBA.
 *
 * Anything else (16-bit, interlaced, sub-byte palette depths) throws rather than
 * being waved through unmeasured — an un-decodable logo is one we cannot vouch for,
 * and silently accepting it is how an invisible asset ships.
 *
 * Palette support is not a nicety: Wikimedia renders a good number of brand SVGs to
 * 8-bit palette PNGs (Wise, Maya and Chinabank all arrive that way), and refusing
 * them would have meant three real logos going missing for a decoder limitation
 * rather than for anything wrong with the artwork.
 */
export function decodePng(buf: Buffer, label = 'image'): DecodedPng {
  if (buf.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    throw new Error(`${label}: not a PNG`);
  }
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const bitDepth = buf[24];
  const colorType = buf[25];
  const interlace = buf[28];

  if (bitDepth !== 8) throw new Error(`${label}: expected 8-bit channels, got ${bitDepth}`);
  if (interlace !== 0) throw new Error(`${label}: interlaced PNGs are not supported`);
  const bpp = BYTES_PER_PIXEL[colorType];
  if (!bpp) throw new Error(`${label}: unsupported PNG colour type ${colorType}`);

  const idat: Buffer[] = [];
  let palette: Buffer | null = null;
  let paletteAlpha: Buffer | null = null;
  for (let off = 8; off + 8 <= buf.length; ) {
    const len = buf.readUInt32BE(off);
    const type = buf.subarray(off + 4, off + 8).toString('latin1');
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IDAT') idat.push(data);
    else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') paletteAlpha = data;
    if (type === 'IEND') break;
    off += 12 + len; // length + type + data + CRC
  }
  if (idat.length === 0) throw new Error(`${label}: no IDAT chunks`);
  if (colorType === 3 && !palette) throw new Error(`${label}: palette PNG with no PLTE chunk`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  if (raw.length !== (stride + 1) * height) {
    throw new Error(`${label}: unexpected scanline length`);
  }

  // Un-filter in place, per the PNG spec's five filter types.
  const plane = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? plane[y * stride + x - bpp] : 0; // left
      const b = y > 0 ? plane[(y - 1) * stride + x] : 0; // up
      const c = x >= bpp && y > 0 ? plane[(y - 1) * stride + x - bpp] : 0; // up-left
      let v = line[x];
      switch (filter) {
        case 0:
          break;
        case 1:
          v += a;
          break;
        case 2:
          v += b;
          break;
        case 3:
          v += (a + b) >> 1;
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
        default:
          throw new Error(`${label}: unknown PNG filter type ${filter} on row ${y}`);
      }
      plane[y * stride + x] = v & 0xff;
    }
  }

  // Normalise every colour type up to RGBA so callers measure one shape.
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0, px = 0; px < width * height; px++) {
    const s = px * bpp;
    if (colorType === 3) {
      // Palette: the sample is an index into PLTE, with alpha from tRNS when present
      // (tRNS may be shorter than the palette — missing entries are fully opaque).
      const idx = plane[s];
      const p = idx * 3;
      if (p + 2 >= palette!.length) throw new Error(`${label}: palette index ${idx} out of range`);
      rgba[i++] = palette![p];
      rgba[i++] = palette![p + 1];
      rgba[i++] = palette![p + 2];
      rgba[i++] = paletteAlpha && idx < paletteAlpha.length ? paletteAlpha[idx] : 255;
    } else if (colorType === 0) {
      rgba[i++] = plane[s];
      rgba[i++] = plane[s];
      rgba[i++] = plane[s];
      rgba[i++] = 255;
    } else if (colorType === 2) {
      rgba[i++] = plane[s];
      rgba[i++] = plane[s + 1];
      rgba[i++] = plane[s + 2];
      rgba[i++] = 255;
    } else {
      rgba[i++] = plane[s];
      rgba[i++] = plane[s + 1];
      rgba[i++] = plane[s + 2];
      rgba[i++] = plane[s + 3];
    }
  }

  return { width, height, rgba };
}

export interface InkStats {
  /** Opaque (alpha ≥ 32) pixels — the artwork, ignoring transparent padding. */
  inkPixels: number;
  /** Share of ink darker than mid-grey. */
  darkPct: number;
  /** Share of ink lighter than luminance 200 — the "invisible on white" measure. */
  nearWhitePct: number;
  /** Mean luminance of the ink, 0–255. */
  meanLuminance: number;
  /** How much of the canvas WIDTH the ink spans, as a percentage. */
  inkWidthPct: number;
  /** Canvas aspect (width / height). ≥ 1.5 reads as a horizontal wordmark. */
  canvasAspect: number;
}

/**
 * Measure the artwork the way `ProcessorLogo`'s plate will show it.
 *
 * The plate is `bg-white` in BOTH themes by rule (ui-standards.md §6.4), so the
 * property that actually matters is: **is this ink visible against white?** A
 * white-on-transparent lockup renders as an empty box, and because the component
 * falls back to a monogram only on a LOAD error — not on an invisible one — nothing
 * would ever report it.
 */
export function measureInk(png: DecodedPng): InkStats {
  let ink = 0;
  let dark = 0;
  let nearWhite = 0;
  let lumSum = 0;
  let minX = png.width;
  let maxX = -1;

  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const i = (y * png.width + x) * 4;
      if (png.rgba[i + 3] < 32) continue; // transparent padding is not artwork
      ink++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      const lum = 0.299 * png.rgba[i] + 0.587 * png.rgba[i + 1] + 0.114 * png.rgba[i + 2];
      lumSum += lum;
      if (lum < 128) dark++;
      if (lum > 200) nearWhite++;
    }
  }

  return {
    inkPixels: ink,
    darkPct: ink ? (100 * dark) / ink : 0,
    nearWhitePct: ink ? (100 * nearWhite) / ink : 0,
    meanLuminance: ink ? lumSum / ink : 0,
    inkWidthPct: maxX >= 0 ? (100 * (maxX - minX + 1)) / png.width : 0,
    canvasAspect: png.height ? png.width / png.height : 0,
  };
}

/**
 * Would this logo read on the white plate? The one gate every fetched asset passes.
 *
 * Deliberately NOT the processors' "≥90% dark" rule: that was written for Kolan's
 * monochrome lockup, and most bank logos are brand-coloured (BPI red, GoTyme blue,
 * Maya green) which is perfectly legible on white while nowhere near 90% dark. The
 * real hazard is ink that is itself white or near-white, so that is what is measured.
 */
export function isLegibleOnWhite(stats: InkStats): { ok: true } | { ok: false; reason: string } {
  if (stats.inkPixels === 0) return { ok: false, reason: 'fully transparent' };
  if (stats.nearWhitePct >= 85) {
    return {
      ok: false,
      reason: `${stats.nearWhitePct.toFixed(1)}% of the ink is near-white — it would render as an empty box on the white plate`,
    };
  }
  if (stats.meanLuminance > 225) {
    return { ok: false, reason: `mean ink luminance ${stats.meanLuminance.toFixed(0)}/255 is too light for a white plate` };
  }
  if (stats.inkWidthPct < 50) {
    return {
      ok: false,
      reason: `ink spans only ${stats.inkWidthPct.toFixed(0)}% of the canvas width — it would render as a sliver`,
    };
  }
  return { ok: true };
}
