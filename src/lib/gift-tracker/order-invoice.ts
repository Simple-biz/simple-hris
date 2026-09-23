/**
 * Gift order invoice → PDF (pdf-lib, client-side).
 *
 * Built ONLY from a stored `InvoiceSnapshot` plus the order's own header —
 * never from the live catalog or live submissions — so re-downloading an old
 * invoice prints exactly what was locked, whatever Gift items says today.
 * Governing doc: docs/features/gift-tracker-orders.md.
 *
 * Page 1+: the priced summary a vendor fills (item · size · qty · unit · amount,
 * total). Then the delivery list (who each gift goes to). A REOPENED order still
 * prints, stamped REOPENED, because the invoice existed.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage } from 'pdf-lib';
import {
  C_EMERALD,
  C_EMERALD_500,
  C_TEAL,
  downloadBlob,
  drawHGradient,
  loadLogoBytes,
  sanitize,
  wrapText,
} from './shipping-export';
import type { InvoiceSnapshot } from './orders';

export interface InvoiceHeader {
  orderNo: number;
  lockedAt: string;
  lockedBy: string;
  status: 'locked' | 'reopened';
  reopenedAt?: string | null;
  reopenedBy?: string | null;
}

/** GO-000042 — the number printed on the invoice and in the filename. */
export function invoiceNumber(orderNo: number): string {
  return `GO-${String(orderNo).padStart(6, '0')}`;
}

/** PHP 1,234.50 — WinAnsi has no peso sign, so the PDF spells it. */
export function pdfPhp(centavos: number): string {
  const pesos = Math.floor(Math.abs(centavos) / 100).toLocaleString('en-US');
  return `${centavos < 0 ? '-' : ''}PHP ${pesos}.${String(Math.abs(centavos) % 100).padStart(2, '0')}`;
}

const PAGE_W = 612; // US Letter portrait
const PAGE_H = 792;
const MARGIN = 40;
const CONTENT_W = PAGE_W - MARGIN * 2;
const BOTTOM = 56;
const EMERALD = rgb(C_EMERALD[0], C_EMERALD[1], C_EMERALD[2]);
const INK = rgb(0.094, 0.094, 0.106);
const MUTED = rgb(0.443, 0.443, 0.478);
const ROW_ALT = rgb(0.925, 0.992, 0.961);
const BORDER = rgb(0.827, 0.906, 0.871);
const ROSE = rgb(0.882, 0.114, 0.282);

type Col = { header: string; width: number; align?: 'left' | 'right' };

function fmtStamp(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

export async function generateOrderInvoicePdf(
  header: InvoiceHeader,
  snap: InvoiceSnapshot,
  opts: { logoUrl?: string } = {},
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Gift order ${invoiceNumber(header.orderNo)}`);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  let logo: PDFImage | null = null;
  const logoBytes = await loadLogoBytes(opts.logoUrl ?? '/simple-logo.png');
  if (logoBytes) {
    try {
      logo = await doc.embedPng(logoBytes);
    } catch {
      logo = null;
    }
  }

  const state = { page: doc.addPage([PAGE_W, PAGE_H]), y: PAGE_H - MARGIN };
  const newPage = () => {
    state.page = doc.addPage([PAGE_W, PAGE_H]);
    state.y = PAGE_H - MARGIN;
  };
  const text = (s: string, x: number, y: number, size: number, f: PDFFont = font, color = INK) =>
    state.page.drawText(sanitize(s), { x, y, size, font: f, color });
  const right = (s: string, xRight: number, y: number, size: number, f: PDFFont = font, color = INK) => {
    const t = sanitize(s);
    state.page.drawText(t, { x: xRight - f.widthOfTextAtSize(t, size), y, size, font: f, color });
  };

  // ── Masthead ──────────────────────────────────────────────────────────────
  {
    const top = state.y;
    if (logo) {
      const h = 28;
      state.page.drawImage(logo, { x: MARGIN, y: top - h, width: (logo.width / logo.height) * h, height: h });
    } else {
      text('Simple', MARGIN, top - 22, 22, bold, EMERALD);
    }
    right('INVOICE', PAGE_W - MARGIN, top - 14, 18, bold, INK);
    right(invoiceNumber(header.orderNo), PAGE_W - MARGIN, top - 30, 10, bold, EMERALD);
    right(`Locked ${fmtStamp(header.lockedAt)}`, PAGE_W - MARGIN, top - 43, 8.5, font, MUTED);
    right(`by ${header.lockedBy}`, PAGE_W - MARGIN, top - 54, 8.5, font, MUTED);

    state.y = top - 64;
    text('HR - GIFT TRACKER - ORDERS', MARGIN, state.y, 8.5, bold, EMERALD);
    state.y -= 18;
    text('Tenure Gift Order', MARGIN, state.y, 16, bold, INK);
    state.y -= 13;
    text(
      `${snap.giftCount} gift${snap.giftCount === 1 ? '' : 's'} · ${snap.qtyTotal} item${snap.qtyTotal === 1 ? '' : 's'} · prices in PHP from Gift items at lock time`,
      MARGIN,
      state.y,
      9,
      font,
      MUTED,
    );
    state.y -= 9;
    drawHGradient(state.page, MARGIN, state.y - 2.4, CONTENT_W, 2.4, C_EMERALD_500, C_TEAL);
    state.y -= 18;

    if (header.status === 'reopened') {
      state.page.drawRectangle({ x: MARGIN, y: state.y - 20, width: CONTENT_W, height: 22, color: rgb(1, 0.945, 0.949) });
      text(
        `REOPENED ${fmtStamp(header.reopenedAt)}${header.reopenedBy ? ` by ${header.reopenedBy}` : ''} - this invoice is void; its gifts went back to Orders.`,
        MARGIN + 8,
        state.y - 13,
        8.5,
        bold,
        ROSE,
      );
      state.y -= 32;
    }
  }

  // ── Generic table ────────────────────────────────────────────────────────
  const drawTable = (title: string, cols: Col[], rows: string[][], size = 9, afterRows?: () => void) => {
    const pad = 5;
    const headerRow = () => {
      state.page.drawRectangle({ x: MARGIN, y: state.y - 18, width: CONTENT_W, height: 18, color: EMERALD });
      let x = MARGIN;
      for (const c of cols) {
        if (c.align === 'right') right(c.header, x + c.width - pad, state.y - 12.5, 8.5, bold, rgb(1, 1, 1));
        else text(c.header, x + pad, state.y - 12.5, 8.5, bold, rgb(1, 1, 1));
        x += c.width;
      }
      state.y -= 18;
    };
    if (state.y - 60 < BOTTOM) newPage();
    text(title, MARGIN, state.y - 2, 11, bold, INK);
    state.y -= 12;
    headerRow();
    rows.forEach((r, i) => {
      const wrapped = r.map((cell, ci) => wrapText(cell, font, size, cols[ci].width - pad * 2));
      const lines = Math.max(...wrapped.map((w) => w.length));
      const h = lines * (size + 2.5) + 7;
      if (state.y - h < BOTTOM) {
        newPage();
        headerRow();
      }
      if (i % 2 === 1) state.page.drawRectangle({ x: MARGIN, y: state.y - h, width: CONTENT_W, height: h, color: ROW_ALT });
      let x = MARGIN;
      wrapped.forEach((w, ci) => {
        w.forEach((ln, li) => {
          const y = state.y - 4 - (li + 1) * (size + 2.5) + 2.5;
          if (cols[ci].align === 'right') right(ln, x + cols[ci].width - pad, y, size);
          else text(ln, x + pad, y, size);
        });
        x += cols[ci].width;
      });
      state.y -= h;
      state.page.drawLine({ start: { x: MARGIN, y: state.y }, end: { x: MARGIN + CONTENT_W, y: state.y }, thickness: 0.5, color: BORDER });
    });
    afterRows?.();
    state.y -= 18;
  };

  // ── Priced summary ───────────────────────────────────────────────────────
  const priced: Col[] = [
    { header: 'Item', width: 200 },
    { header: 'Size', width: 90 },
    { header: 'Qty', width: 50, align: 'right' },
    { header: 'Unit price', width: 96, align: 'right' },
    { header: 'Amount', width: CONTENT_W - 436, align: 'right' },
  ];
  drawTable(
    'Order summary',
    priced,
    snap.groups.map((g) => [g.item, g.size || '-', String(g.qty), pdfPhp(g.unitCentavos), pdfPhp(g.amountCentavos)]),
    9.5,
    () => {
      if (state.y - 24 < BOTTOM) newPage();
      state.page.drawRectangle({ x: MARGIN, y: state.y - 22, width: CONTENT_W, height: 22, color: rgb(0.925, 0.992, 0.961) });
      text('TOTAL', MARGIN + 5, state.y - 15, 10, bold);
      right(String(snap.qtyTotal), MARGIN + 340 - 5, state.y - 15, 10, bold);
      right(pdfPhp(snap.totalCentavos), MARGIN + CONTENT_W - 5, state.y - 15, 11, bold, EMERALD);
      state.y -= 22;
    },
  );

  // ── Delivery list ────────────────────────────────────────────────────────
  drawTable(
    'Delivery list',
    [
      { header: 'Employee', width: 110 },
      { header: 'Gift', width: 110 },
      { header: 'Ship to', width: 170 },
      { header: 'Contact', width: 70 },
      { header: 'Received by', width: CONTENT_W - 460 },
    ],
    snap.recipients.map((r) => [
      `${r.name} · ${r.milestone}`,
      r.items,
      r.shipTo || '(no address on file)',
      r.contact || '-',
      r.receivedBy || 'Employee',
    ]),
    8,
  );

  // Footer on every page.
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    const s = sanitize(`${invoiceNumber(header.orderNo)} · page ${i + 1} of ${pages.length} · Simple-HRIS`);
    p.drawText(s, { x: PAGE_W - MARGIN - font.widthOfTextAtSize(s, 7.5), y: 28, size: 7.5, font, color: MUTED });
  });

  return doc.save();
}

export async function downloadOrderInvoicePdf(header: InvoiceHeader, snap: InvoiceSnapshot): Promise<void> {
  const bytes = await generateOrderInvoicePdf(header, snap);
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  downloadBlob(`gift-order-${invoiceNumber(header.orderNo)}.pdf`, new Blob([ab], { type: 'application/pdf' }));
}
