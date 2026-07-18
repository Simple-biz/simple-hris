import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { stampSignedDocument, type StampSignedDocumentParams } from './sign-pdf';

// 1x1 black-pixel PNG — a minimal stand-in for a signature-pad export.
const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

async function makeOriginal(pages: number, landscape: boolean): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const p = doc.addPage(landscape ? [792, 612] : [612, 792]);
    p.drawText(`Original page ${i + 1}`, { x: 50, y: 500, size: 14, font });
  }
  return doc.save();
}

function params(original: Uint8Array, overrides?: Partial<StampSignedDocumentParams>): StampSignedDocumentParams {
  return {
    originalBytes: original,
    signatureDataUrl: TINY_PNG,
    signerName: 'Carla Dela Cruz',
    signerTitle: 'Accounting Head',
    signerEmail: 'carla@simple.biz',
    // Em dash + smart quote exercise the WinAnsi sanitizer.
    employeeName: 'Juan D. Santos — Tech Team',
    employeeEmail: 'juan@simple.biz',
    documentLabel: 'Pay Stubs',
    periodLabel: null,
    requestId: 'a1b2c3d4-0000-4000-8000-1234567890ab',
    requestedAtIso: '2026-07-15T02:30:00.000Z',
    signedAtIso: '2026-07-18T06:00:00.000Z',
    ...overrides,
  };
}

test('appends exactly one certification page to a portrait original', async () => {
  const signed = await stampSignedDocument(params(await makeOriginal(2, false)));
  assert.equal(Buffer.from(signed.slice(0, 5)).toString('utf8'), '%PDF-');
  const reloaded = await PDFDocument.load(signed);
  assert.equal(reloaded.getPageCount(), 3);
});

test('certification page matches the landscape page size and fits a period label', async () => {
  const signed = await stampSignedDocument(
    params(await makeOriginal(1, true), { periodLabel: 'Last 6 months · 26 weeks' }),
  );
  const reloaded = await PDFDocument.load(signed);
  assert.equal(reloaded.getPageCount(), 2);
  const cert = reloaded.getPage(1);
  assert.equal(cert.getWidth(), 792);
  assert.equal(cert.getHeight(), 612);
});

test('rejects a corrupt signature image with a clear error', async () => {
  await assert.rejects(
    stampSignedDocument(params(await makeOriginal(1, false), { signatureDataUrl: 'data:image/png;base64,AAAA' })),
    /redraw and save it again/,
  );
});

test('rejects a non-data-URL signature', async () => {
  await assert.rejects(
    stampSignedDocument(params(await makeOriginal(1, false), { signatureDataUrl: 'https://evil.example/sig.png' })),
    /not a valid data URL/,
  );
});

test('rejects bytes that are not a PDF', async () => {
  await assert.rejects(stampSignedDocument(params(new TextEncoder().encode('not a pdf at all'))));
});
