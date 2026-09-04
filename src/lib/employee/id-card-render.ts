import type { IdCard } from './id-card';

/**
 * Paints the Employee ID card onto a canvas and hands back a PNG blob, so the
 * employee can save their badge (Profile -> ID -> Download PNG).
 *
 * ## Why this is a painter and not a DOM screenshot
 *
 * The badge is sized in `cqw` against an `@container` and styled with Tailwind
 * arbitrary values. Rasterising that DOM would mean either a new dependency
 * (`html-to-image` and friends) or an SVG `foreignObject` clone, and both resolve
 * container queries and Tailwind's cascade unreliably. Painting from the same
 * `IdCard` view model is deterministic, dependency-free, and testable.
 *
 * **The cost is drift**: two renderers now draw one design. {@link ID_CARD_GEOMETRY}
 * is the shared arithmetic, and every number below is a fraction of the card's own
 * width or height — the same fractions the component's literal Tailwind classes
 * carry. Change one, change the other; `docs/features/employee-id-card.md` says so
 * too. The Tailwind classes cannot be generated from these constants because an
 * interpolated class is absent from the build and renders unstyled.
 *
 * ## What must never happen
 *
 * Every failure degrades, and none of them throws past the caller with a half
 * written file: a photo that will not load paints initials, an unencodable canvas
 * raises a named error, and a missing address prints "Not on file" exactly as the
 * screen does. The one thing that aborts is a missing wordmark — an unbranded
 * rectangle claiming to be a company ID is worse than no download.
 */

/** Design units. CR80 upright: 54 x 85.6 mm. */
const W = 372;
const H = (W * 85.6) / 54;

/** Rendered at 3x so the file is crisp when printed or opened at full size. */
const SCALE = 3;

/** A fraction of the card WIDTH — the `cqw` unit the component uses. */
const cqw = (n: number) => (n / 100) * W;

export const ID_CARD_GEOMETRY = {
  width: W,
  height: H,
  scale: SCALE,
  radius: cqw(5),
  header: { height: H * 0.46, navyBottomLeft: 0.92, navyBottomRight: 0.74, hairBottomLeft: 0.955, hairBottomRight: 0.775 },
  footer: { height: H * 0.11 },
  /**
   * The sweep stops at the footer band. That band carries the only light-on-dark
   * text on the card, and at peak sheen NO mid-tone ink survives on lightened
   * navy — the periwinkle "EMPLOYEE ID" label falls to 2.2:1. Brightening the ink
   * cannot fix a ground that light, so the sheen simply never reaches it. Every
   * other surface it crosses either holds no text (the header) or holds dark ink
   * on light metal, where lightening only helps.
   */
  sheen: { height: H - H * 0.11 },
  padding: { x: cqw(7), top: cqw(6), bottom: cqw(21) },
  logo: { height: cqw(6.4), plateRadius: cqw(1.6), padX: cqw(2.2), padY: cqw(1.5) },
  photo: { marginTop: cqw(27), size: cqw(35), ring: cqw(1.1) },
  name: { marginTop: cqw(5), size: cqw(7), lineHeight: 1.12 },
  rule: { marginTop: cqw(3), marginBottom: cqw(2.6), width: cqw(10), height: cqw(0.9) },
  role: { size: cqw(2.75), tracking: 0.19 },
  rows: { paddingTop: cqw(5), colGap: cqw(3.4), rowGap: cqw(3), labelSize: cqw(2.5), labelTracking: 0.14, valueSize: cqw(3.15), valueLineHeight: 1.45 },
  serial: { labelSize: cqw(2.3), labelTracking: 0.2, valueSize: cqw(3.4) },
} as const;

/** Brand values sampled from `public/simple-logo.png`. Orange is fill-only. */
export const ID_CARD_COLORS = {
  navy: '#27285A',
  orange: '#F26F07',
  card: '#FFFFFF',
  hair: '#E4E4EE',
  slot: '#EDEDF3',
  value: '#34364F',
  missing: '#666881',
  onNavySoft: '#A9AAD0',
} as const;

/**
 * The milled-metal ramps, mirrored by `EmployeeIdCard.tsx`'s literal Tailwind and
 * inline styles. Change one, change the other.
 *
 * `sheenPeakAlpha` is a CONTRAST budget, not a taste knob. The sweep lightens the
 * navy behind the footer serial, and white on that lightened navy must stay above
 * 4.5:1. At 0.28 it is 5.6:1; a test proves it and fails if the cap is raised.
 */
export const ID_CARD_METAL = {
  navy: [[0, '#35366F'], [0.44, '#27285A'], [1, '#1E1F48']],
  silver: [[0, '#FFFFFF'], [0.48, '#F7F8FC'], [1, '#ECEDF4']],
  orange: [[0, '#FF8B2D'], [0.52, '#F26F07'], [1, '#D75E02']],
  ring: [[0, '#FFFFFF'], [0.46, '#D7D9E6'], [1, '#FFFFFF']],
  brushLight: 'rgba(255,255,255,0.05)',
  brushDark: 'rgba(39,40,90,0.032)',
  brushStep: 3,
  brushSlopeDeg: 6,
  sheenPeakAlpha: 0.28,
  /** Where the frozen sweep sits in the still, as a fraction of card width. */
  sheenCenter: 0.42,
  sheenWidth: 0.42,
  sheenTiltDeg: 8,
} as const;

const SANS = '"Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif';
const MONO = '"Cascadia Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace';

/* ───────── pure helpers (unit-tested) ───────── */

/**
 * Greedy word wrap against a caller-supplied measurer, so it can be tested
 * without a canvas. Never drops a word: a single word wider than the line gets
 * its own line and overhangs rather than being cut, because the address on an
 * identity document is never truncated.
 */
export function wrapToLines(
  text: string,
  maxWidth: number,
  measure: (s: string) => number,
): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const lines: string[] = [];
  let line = words[0]!;
  for (const word of words.slice(1)) {
    const candidate = `${line} ${word}`;
    if (measure(candidate) <= maxWidth) {
      line = candidate;
    } else {
      lines.push(line);
      line = word;
    }
  }
  lines.push(line);
  return lines;
}

/**
 * `simple-id-2405-0012.png`, falling back to the name when no serial exists.
 * Everything outside `[a-z0-9-]` is collapsed so a name with a slash, a quote or
 * a non-Latin character cannot produce an unsaveable filename.
 */
export function idCardFileName(card: Pick<IdCard, 'employeeId' | 'name'>): string {
  const slug = (s: string) =>
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48);
  const stem = slug(card.employeeId ?? '') || slug(card.name ?? '') || 'card';
  return `simple-id-${stem}.png`;
}

/* ───────── canvas primitives ───────── */

/**
 * Total advance of a tracked run: the glyphs, plus `size x tracking` in each gap.
 * Gaps only go BETWEEN glyphs, so a run never carries trailing space that would
 * throw off right alignment or centring.
 *
 * Pure, and exported so the arithmetic is testable without a canvas.
 */
export function trackedTotalWidth(
  charWidths: readonly number[],
  size: number,
  tracking: number,
): number {
  if (charWidths.length === 0) return 0;
  const glyphs = charWidths.reduce((sum, w) => sum + w, 0);
  return glyphs + size * tracking * (charWidths.length - 1);
}

/**
 * Draws letter-spaced text one glyph at a time.
 *
 * `ctx.letterSpacing` exists only in newer engines and silently does nothing in
 * the rest, which would collapse every tracked label on the card in exactly the
 * browsers hardest to notice it in. Drawing per glyph is identical everywhere.
 *
 * **`size` is passed in and must never be read back off `ctx.font`.** The canvas
 * normalises that property, so it comes back as `"600 12.65px ..."` and
 * `parseFloat` yields the WEIGHT — 600 — not the size. That shipped once: the
 * footer serial drew at 600 x 0.05 = 30px per gap and ran straight across the
 * "EMPLOYEE ID" label. It hid at every other call site only because weight 700
 * serialises to the keyword `bold`, so `parseFloat` gave NaN and a fallback
 * stood in at roughly the right size. Approximately-right-by-accident is why it
 * took a rendered PNG to see it.
 */
function drawTracked(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  size: number,
  tracking: number,
  align: 'left' | 'right' = 'left',
): void {
  const chars = [...text];
  if (chars.length === 0) return;
  const space = size * tracking;
  const widths = chars.map((c) => ctx.measureText(c).width);
  const total = trackedTotalWidth(widths, size, tracking);
  let cursor = align === 'right' ? x - total : x;
  const prevAlign = ctx.textAlign;
  ctx.textAlign = 'left';
  chars.forEach((c, i) => {
    ctx.fillText(c, cursor, y);
    cursor += widths[i]! + space;
  });
  ctx.textAlign = prevAlign;
}

function trackedWidth(
  ctx: CanvasRenderingContext2D,
  text: string,
  size: number,
  tracking: number,
): number {
  return trackedTotalWidth([...text].map((c) => ctx.measureText(c).width), size, tracking);
}

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number | { tl: number; tr: number; br: number; bl: number },
): void {
  const c = typeof r === 'number' ? { tl: r, tr: r, br: r, bl: r } : r;
  ctx.beginPath();
  ctx.moveTo(x + c.tl, y);
  ctx.lineTo(x + w - c.tr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + c.tr);
  ctx.lineTo(x + w, y + h - c.br);
  ctx.quadraticCurveTo(x + w, y + h, x + w - c.br, y + h);
  ctx.lineTo(x + c.bl, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - c.bl);
  ctx.lineTo(x, y + c.tl);
  ctx.quadraticCurveTo(x, y, x + c.tl, y);
  ctx.closePath();
}

function ramp(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  stops: readonly (readonly [number, string])[] | readonly (number | string)[][],
): CanvasGradient {
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  for (const stop of stops as readonly [number, string][]) g.addColorStop(stop[0], stop[1]);
  return g;
}

/**
 * Anisotropic brush lines — the thing that actually reads as metal. A gradient on
 * its own reads as a gradient. Near-horizontal, 1px, barely-there alpha; the
 * caller clips to the surface being brushed.
 */
function brushLines(ctx: CanvasRenderingContext2D, color: string): void {
  const rise = W * Math.tan((ID_CARD_METAL.brushSlopeDeg * Math.PI) / 180);
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  for (let y = -rise; y < H + rise; y += ID_CARD_METAL.brushStep) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y + rise);
    ctx.stroke();
  }
  ctx.restore();
}

/** Fill a clipped region with a ramp, then brush it. */
function paintMetal(
  ctx: CanvasRenderingContext2D,
  path: () => void,
  stops: readonly (readonly [number, string])[] | readonly (number | string)[][],
  brush: string,
  box: { x: number; y: number; w: number; h: number },
): void {
  ctx.save();
  path();
  ctx.clip();
  ctx.fillStyle = ramp(ctx, box.x, box.y, box.x + box.w * 0.42, box.y + box.h, stops);
  ctx.fillRect(box.x, box.y, box.w, box.h);
  brushLines(ctx, brush);
  ctx.restore();
}

function polygon(ctx: CanvasRenderingContext2D, pts: [number, number][]): void {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  ctx.closePath();
}

/**
 * Resolves to `null` instead of rejecting, so a dead or CORS-refused URL becomes
 * "no photo" rather than a failed download.
 *
 * `crossOrigin = 'anonymous'` is what keeps the canvas untainted: a photo drawn
 * without it makes `toBlob` throw a SecurityError, which is a download button
 * that does nothing at all. A host that will not send CORS headers fails the
 * load here instead, and the caller paints initials.
 */
function loadImage(src: string, crossOrigin: boolean): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    if (crossOrigin) img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/* ───────── the painter ───────── */

export class IdCardRenderError extends Error {}

export async function renderIdCardPng(card: IdCard): Promise<Blob> {
  const G = ID_CARD_GEOMETRY;
  const C = ID_CARD_COLORS;

  // Same-origin, so no crossOrigin needed. This is the one hard requirement:
  // an unbranded rectangle claiming to be a company ID is worse than no file.
  const logo = await loadImage('/simple-logo.png', false);
  if (!logo) throw new IdCardRenderError('Could not load the Simple logo, so the ID was not saved.');

  let photo: HTMLImageElement | null = null;
  for (const src of card.photoSources) {
    photo = await loadImage(src, true);
    if (photo) break;
  }

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(W * SCALE);
  canvas.height = Math.round(H * SCALE);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new IdCardRenderError('This browser could not draw the ID card.');
  ctx.scale(SCALE, SCALE);
  ctx.textBaseline = 'alphabetic';

  // Card body, clipped so every shape below stops at the rounded edge.
  roundedRect(ctx, 0, 0, W, H, G.radius);
  ctx.save();
  ctx.clip();
  paintMetal(ctx, () => roundedRect(ctx, 0, 0, W, H, G.radius), ID_CARD_METAL.silver, ID_CARD_METAL.brushDark, { x: 0, y: 0, w: W, h: H });

  /* header — navy panel, grey hairline, one orange block */
  const hz = G.header.height;
  const headerPath = () =>
    polygon(ctx, [[0, 0], [W, 0], [W, hz * G.header.navyBottomRight], [0, hz * G.header.navyBottomLeft]]);
  paintMetal(ctx, headerPath, ID_CARD_METAL.navy, ID_CARD_METAL.brushLight, { x: 0, y: 0, w: W, h: hz });
  // The lit lip of a milled plate — 1px of light, not a bevel.
  ctx.fillStyle = 'rgba(255,255,255,0.25)';
  ctx.fillRect(0, 0, W, cqw(0.3));

  ctx.fillStyle = C.hair;
  polygon(ctx, [
    [0, hz * G.header.navyBottomLeft],
    [W, hz * G.header.navyBottomRight],
    [W, hz * G.header.hairBottomRight],
    [0, hz * G.header.hairBottomLeft],
  ]);
  ctx.fill();

  const amberW = cqw(15);
  const amberX = W - cqw(8) - amberW;
  ctx.fillStyle = ramp(ctx, amberX, -cqw(7), amberX + amberW, cqw(16), ID_CARD_METAL.orange);
  roundedRect(ctx, amberX, -cqw(7), amberW, cqw(23), { tl: 0, tr: 0, br: cqw(7.5), bl: cqw(7.5) });
  ctx.fill();

  /* footer band — STRAIGHT top edge (employee-id-card.md) */
  const bandTop = H - G.footer.height;
  paintMetal(
    ctx,
    () => ctx.rect(0, bandTop, W, G.footer.height),
    ID_CARD_METAL.navy,
    ID_CARD_METAL.brushLight,
    { x: 0, y: bandTop, w: W, h: G.footer.height },
  );
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  ctx.fillRect(0, bandTop, W, cqw(0.3));

  /* The specular sweep, frozen. On screen it travels; a still catches it once.
     Drawn over every metal surface and UNDER every glyph — the draw order below
     is the contrast guarantee, not a stacking preference. */
  {
    const sw = W * ID_CARD_METAL.sheenWidth;
    ctx.save();
    ctx.translate(W * ID_CARD_METAL.sheenCenter, H / 2);
    ctx.rotate((ID_CARD_METAL.sheenTiltDeg * Math.PI) / 180);
    const peak = ID_CARD_METAL.sheenPeakAlpha;
    ctx.fillStyle = ramp(ctx, -sw / 2, 0, sw / 2, 0, [
      [0, 'rgba(255,255,255,0)'],
      [0.34, `rgba(255,255,255,${peak * 0.29})`],
      [0.5, `rgba(255,255,255,${peak})`],
      [0.66, `rgba(255,255,255,${peak * 0.29})`],
      [1, 'rgba(255,255,255,0)'],
    ]);
    ctx.fillRect(-sw / 2, -H, sw, H * 2);
    ctx.restore();
  }
  // Repaint the band over the sheen's tail: the rotated rect is clipped by the
  // card, not by the band, so this is what actually enforces G.sheen.height.
  {
    paintMetal(
      ctx,
      () => ctx.rect(0, bandTop, W, G.footer.height),
      ID_CARD_METAL.navy,
      ID_CARD_METAL.brushLight,
      { x: 0, y: bandTop, w: W, h: G.footer.height },
    );
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.fillRect(0, bandTop, W, cqw(0.3));
  }

  if (card.employeeId) {
    const midY = H - G.footer.height / 2;
    ctx.fillStyle = C.onNavySoft;
    ctx.font = `700 ${G.serial.labelSize}px ${SANS}`;
    drawTracked(ctx, 'EMPLOYEE ID', G.padding.x, midY + G.serial.labelSize * 0.36, G.serial.labelSize, G.serial.labelTracking);

    ctx.fillStyle = '#FFFFFF';
    ctx.font = `600 ${G.serial.valueSize}px ${MONO}`;
    drawTracked(ctx, card.employeeId, W - G.padding.x, midY + G.serial.valueSize * 0.36, G.serial.valueSize, 0.05, 'right');
  }

  /* wordmark on a WHITE plate — ui-standards §6.4 */
  const logoH = G.logo.height;
  const logoW = logoH * (logo.naturalWidth / logo.naturalHeight || 900 / 324);
  const plateW = logoW + G.logo.padX * 2;
  const plateH = logoH + G.logo.padY * 2;
  ctx.fillStyle = C.card;
  roundedRect(ctx, G.padding.x, G.padding.top, plateW, plateH, G.logo.plateRadius);
  ctx.fill();
  ctx.drawImage(logo, G.padding.x + G.logo.padX, G.padding.top + G.logo.padY, logoW, logoH);

  /* portrait, straddling the diagonal */
  const photoTop = G.padding.top + plateH + G.photo.marginTop;
  const d = G.photo.size;
  const cx = W / 2;
  const cy = photoTop + d / 2;
  const rOuter = d / 2;
  const rInner = rOuter - G.photo.ring;

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, rInner, 0, Math.PI * 2);
  ctx.clip();
  if (photo) {
    // object-cover: fill the circle, crop the overflow, never squash a face.
    const ar = photo.naturalWidth / photo.naturalHeight || 1;
    const dw = ar >= 1 ? rInner * 2 * ar : rInner * 2;
    const dh = ar >= 1 ? rInner * 2 : (rInner * 2) / ar;
    ctx.drawImage(photo, cx - dw / 2, cy - dh / 2, dw, dh);
  } else {
    ctx.fillStyle = ramp(ctx, cx - rInner, cy - rInner, cx + rInner, cy + rInner, ID_CARD_METAL.silver);
    ctx.fillRect(cx - rInner, cy - rInner, rInner * 2, rInner * 2);
    ctx.fillStyle = C.navy;
    ctx.font = `600 ${cqw(11)}px ${SANS}`;
    ctx.textAlign = 'center';
    ctx.fillText(card.initials, cx, cy + cqw(11) * 0.36);
    ctx.textAlign = 'left';
  }
  ctx.restore();

  ctx.strokeStyle = ramp(ctx, cx - rOuter, cy - rOuter, cx + rOuter, cy + rOuter, ID_CARD_METAL.ring);
  ctx.lineWidth = G.photo.ring;
  ctx.beginPath();
  ctx.arc(cx, cy, rInner + G.photo.ring / 2, 0, Math.PI * 2);
  ctx.stroke();

  /* name */
  let y = photoTop + d + G.name.marginTop + G.name.size * 0.82;
  ctx.fillStyle = C.navy;
  ctx.font = `600 ${G.name.size}px ${SANS}`;
  ctx.textAlign = 'center';
  const nameLines = wrapToLines(card.name, W - G.padding.x * 2, (s) => ctx.measureText(s).width);
  for (const line of nameLines) {
    ctx.fillText(line, cx, y);
    y += G.name.size * G.name.lineHeight;
  }
  y -= G.name.size * G.name.lineHeight;
  ctx.textAlign = 'left';

  /* the orange rule — a FILL, never text */
  const ruleY = y + G.name.size * 0.34 + G.rule.marginTop;
  ctx.fillStyle = ramp(ctx, cx - G.rule.width / 2, ruleY, cx + G.rule.width / 2, ruleY + G.rule.height, ID_CARD_METAL.orange);
  ctx.fillRect(cx - G.rule.width / 2, ruleY, G.rule.width, G.rule.height);

  /* department — already through formatDeptLabel, omitted when blank */
  if (card.department) {
    ctx.fillStyle = C.navy;
    ctx.globalAlpha = 0.7;
    ctx.font = `700 ${G.role.size}px ${SANS}`;
    const rw = trackedWidth(ctx, card.department.toUpperCase(), G.role.size, G.role.tracking);
    drawTracked(
      ctx,
      card.department.toUpperCase(),
      cx - rw / 2,
      ruleY + G.rule.height + G.rule.marginBottom + G.role.size,
      G.role.size,
      G.role.tracking,
    );
    ctx.globalAlpha = 1;
  }

  /* record block — anchored above the footer band, growing upward */
  const rows: { label: string; value: string | null; mono?: boolean }[] = [
    { label: 'EMAIL', value: card.workEmail },
    { label: 'STARTED', value: card.startDate, mono: true },
    { label: 'ADDRESS', value: card.address },
  ];

  ctx.font = `700 ${G.rows.labelSize}px ${SANS}`;
  const labelW = Math.max(...rows.map((r) => trackedWidth(ctx, r.label, G.rows.labelSize, G.rows.labelTracking)));
  const valueX = G.padding.x + labelW + G.rows.colGap;
  const valueMax = W - G.padding.x - valueX;

  const wrapped = rows.map((r) => {
    ctx.font = `500 ${G.rows.valueSize}px ${r.mono && r.value ? MONO : SANS}`;
    const text = r.value ?? 'Not on file';
    return { ...r, text, lines: wrapToLines(text, valueMax, (s) => ctx.measureText(s).width) };
  });

  const lineStep = G.rows.valueSize * G.rows.valueLineHeight;
  const blockH =
    G.rows.paddingTop +
    wrapped.reduce((sum, r) => sum + r.lines.length * lineStep, 0) +
    G.rows.rowGap * (wrapped.length - 1);
  const blockTop = H - G.padding.bottom - blockH;

  ctx.fillStyle = C.hair;
  ctx.fillRect(G.padding.x, blockTop, W - G.padding.x * 2, 1);

  let ry = blockTop + G.rows.paddingTop;
  for (const r of wrapped) {
    ctx.fillStyle = C.navy;
    ctx.font = `700 ${G.rows.labelSize}px ${SANS}`;
    drawTracked(ctx, r.label, G.padding.x, ry + G.rows.valueSize * 0.86, G.rows.labelSize, G.rows.labelTracking);

    ctx.fillStyle = r.value ? C.value : C.missing;
    ctx.font = `500 ${G.rows.valueSize}px ${r.mono && r.value ? MONO : SANS}`;
    let ly = ry + G.rows.valueSize * 0.86;
    for (const line of r.lines) {
      ctx.fillText(line, valueX, ly);
      ly += lineStep;
    }
    ry += r.lines.length * lineStep + G.rows.rowGap;
  }

  ctx.restore();

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      // Null means the browser refused to encode — most often a tainted canvas.
      // Naming it beats a button that silently does nothing.
      if (!blob) reject(new IdCardRenderError('This browser could not save the ID card as a PNG.'));
      else resolve(blob);
    }, 'image/png');
  });
}

/**
 * Renders and hands the file to the browser, using the app's own download idiom
 * (object URL + a synthetic anchor, revoked straight after — see
 * `BizReportCard.tsx`). Throws `IdCardRenderError` with a sentence worth showing.
 */
export async function downloadIdCardPng(card: IdCard): Promise<void> {
  const blob = await renderIdCardPng(card);
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = idCardFileName(card);
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}
