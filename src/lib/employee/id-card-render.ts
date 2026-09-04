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
  missing: '#8A8CA2',
  onNavySoft: '#A9AAD0',
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
 * Draws letter-spaced text one glyph at a time.
 *
 * `ctx.letterSpacing` exists only in newer engines and silently does nothing in
 * the rest, which would collapse every tracked label on the card in exactly the
 * browsers hardest to notice it in. Drawing per glyph is identical everywhere.
 */
function drawTracked(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  tracking: number,
  align: 'left' | 'right' = 'left',
): void {
  const em = parseFloat(ctx.font) || 10;
  const space = em * tracking;
  const chars = [...text];
  const total = chars.reduce((sum, c) => sum + ctx.measureText(c).width + space, 0) - space;
  let cursor = align === 'right' ? x - total : x;
  const prevAlign = ctx.textAlign;
  ctx.textAlign = 'left';
  for (const c of chars) {
    ctx.fillText(c, cursor, y);
    cursor += ctx.measureText(c).width + space;
  }
  ctx.textAlign = prevAlign;
}

function trackedWidth(ctx: CanvasRenderingContext2D, text: string, tracking: number): number {
  const em = parseFloat(ctx.font) || 10;
  const space = em * tracking;
  const chars = [...text];
  if (chars.length === 0) return 0;
  return chars.reduce((sum, c) => sum + ctx.measureText(c).width + space, 0) - space;
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
  ctx.fillStyle = C.card;
  ctx.fillRect(0, 0, W, H);

  /* header — navy panel, grey hairline, one orange block */
  const hz = G.header.height;
  ctx.fillStyle = C.navy;
  polygon(ctx, [[0, 0], [W, 0], [W, hz * G.header.navyBottomRight], [0, hz * G.header.navyBottomLeft]]);
  ctx.fill();

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
  ctx.fillStyle = C.orange;
  roundedRect(ctx, amberX, -cqw(7), amberW, cqw(23), { tl: 0, tr: 0, br: cqw(7.5), bl: cqw(7.5) });
  ctx.fill();

  /* footer band — STRAIGHT top edge (employee-id-card.md) */
  ctx.fillStyle = C.navy;
  ctx.fillRect(0, H - G.footer.height, W, G.footer.height);

  if (card.employeeId) {
    const midY = H - G.footer.height / 2;
    ctx.fillStyle = C.onNavySoft;
    ctx.font = `700 ${G.serial.labelSize}px ${SANS}`;
    drawTracked(ctx, 'EMPLOYEE ID', G.padding.x, midY + G.serial.labelSize * 0.36, G.serial.labelTracking);

    ctx.fillStyle = '#FFFFFF';
    ctx.font = `600 ${G.serial.valueSize}px ${MONO}`;
    drawTracked(ctx, card.employeeId, W - G.padding.x, midY + G.serial.valueSize * 0.36, 0.05, 'right');
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
    ctx.fillStyle = C.slot;
    ctx.fillRect(cx - rInner, cy - rInner, rInner * 2, rInner * 2);
    ctx.fillStyle = C.navy;
    ctx.font = `600 ${cqw(11)}px ${SANS}`;
    ctx.textAlign = 'center';
    ctx.fillText(card.initials, cx, cy + cqw(11) * 0.36);
    ctx.textAlign = 'left';
  }
  ctx.restore();

  ctx.strokeStyle = C.card;
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
  ctx.fillStyle = C.orange;
  ctx.fillRect(cx - G.rule.width / 2, ruleY, G.rule.width, G.rule.height);

  /* department — already through formatDeptLabel, omitted when blank */
  if (card.department) {
    ctx.fillStyle = C.navy;
    ctx.globalAlpha = 0.7;
    ctx.font = `700 ${G.role.size}px ${SANS}`;
    const rw = trackedWidth(ctx, card.department.toUpperCase(), G.role.tracking);
    drawTracked(
      ctx,
      card.department.toUpperCase(),
      cx - rw / 2,
      ruleY + G.rule.height + G.rule.marginBottom + G.role.size,
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
  const labelW = Math.max(...rows.map((r) => trackedWidth(ctx, r.label, G.rows.labelTracking)));
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
    drawTracked(ctx, r.label, G.padding.x, ry + G.rows.valueSize * 0.86, G.rows.labelTracking);

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
