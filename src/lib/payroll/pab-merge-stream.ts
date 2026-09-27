import type { PabMergeResult } from './pab-merge';

export type PabMergeStreamSkipped = { file: string; error: string };

/**
 * Serialise the merge as ONE JSON document — `{ columns, skipped, rows }` — in
 * chunks, for `POST /api/payroll-wizard/pab-merge`.
 *
 * Streamed because a buffered Vercel Function response is capped at 4.5 MB and
 * the merge is ~5 MB for 31 uploads (2026-09-26) and grows every week; a
 * streamed body is not capped. The client still reads it with `res.json()`:
 * the chunks concatenate to exactly `JSON.stringify({ columns, skipped, rows })`
 * (`pab-merge-stream.test.ts` pins that byte-for-byte), so nothing about the
 * payload depends on how it was chunked.
 */
export function encodePabMergeStream(
  merged: PabMergeResult,
  skipped: readonly PabMergeStreamSkipped[],
  rowsPerChunk = 250,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const size = Math.max(1, Math.floor(rowsPerChunk));
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(`{"columns":${JSON.stringify(merged.columns)},"skipped":${JSON.stringify(skipped)},"rows":[`),
      );
      for (let i = 0; i < merged.rows.length; i += size) {
        const chunk = merged.rows.slice(i, i + size).map((r) => JSON.stringify(r)).join(',');
        controller.enqueue(encoder.encode(i === 0 ? chunk : `,${chunk}`));
      }
      controller.enqueue(encoder.encode(']}'));
      controller.close();
    },
  });
}
