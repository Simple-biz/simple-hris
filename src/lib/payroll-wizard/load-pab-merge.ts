/**
 * How the Payroll Wizard obtains its all-uploads Hubstaff merge
 * (`src/lib/payroll/pab-merge.ts` — read that first: Step 2's PAY hours ride it).
 *
 * Primary path: ONE `POST /api/payroll-wizard/pab-merge` that reads and merges
 * every upload on the server and streams the result back.
 *
 * Fallback: the per-upload fan-out the wizard always used — one
 * `GET /api/hubstaff-hours?source_file=` per upload, merged here in the browser.
 * It runs whenever the server path cannot be trusted: a network error, any
 * non-2xx (a 403 on the new route's gate, a platform body-size refusal, a
 * timeout), or a body that does not parse into the expected shape. Both paths
 * merge with the SAME `mergeHubstaffUploadsForPab`, over the SAME
 * `fetchHubstaffRowsBySourceFile` reads, in the SAME order, so the rows are
 * identical whichever one ran — the fallback exists so a new route can never be
 * the reason the merge is missing, not because it computes anything differently.
 *
 * A failed upload is SKIPPED on both paths, exactly as before (a skipped week is
 * not an error of the merge); the difference is that both now SAY which, via
 * `skipped`, where the fan-out used to drop the week without a word.
 */
import {
  mergeHubstaffUploadsForPab,
  type PabMergeResult,
} from '@/lib/payroll/pab-merge';

export type PabMergeSkipped = { file: string; error: string };

export type PabMergeLoad = {
  result: PabMergeResult;
  skipped: PabMergeSkipped[];
  via: 'server' | 'per-upload';
  /** Why the server path was not used — null when it was. */
  fallbackReason: string | null;
};

/** One upload as the per-upload route returns it. */
export type UploadReadJson = {
  columns?: readonly string[] | null;
  rows?: readonly Record<string, unknown>[] | null;
  error?: string | null;
};

export type LoadPabMergeDeps = {
  /** POSTs `{ files }` to the merge route. */
  postMerge: (files: readonly string[]) => Promise<Response>;
  /** Reads ONE upload through `GET /api/hubstaff-hours?source_file=` (parsed). */
  readUpload: (file: string) => Promise<UploadReadJson>;
};

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Validate the server body. Anything unexpected is a reason to fall back —
 * never a reason to render a partial or empty merge as if it were complete.
 */
export function parseServerMergeBody(
  body: unknown,
): { result: PabMergeResult; skipped: PabMergeSkipped[] } | { invalid: string } {
  if (!isPlainObject(body)) return { invalid: 'body is not an object' };
  const { columns, rows, skipped } = body;
  if (!Array.isArray(columns) || !columns.every((c) => typeof c === 'string')) {
    return { invalid: 'columns is not a string[]' };
  }
  if (!Array.isArray(rows) || !rows.every(isPlainObject)) return { invalid: 'rows is not an object[]' };
  if (
    !Array.isArray(skipped) ||
    !skipped.every((s) => isPlainObject(s) && typeof s.file === 'string' && typeof s.error === 'string')
  ) {
    return { invalid: 'skipped is not a {file,error}[]' };
  }
  return {
    result: { columns: columns as string[], rows: rows as Record<string, unknown>[] },
    skipped: skipped as PabMergeSkipped[],
  };
}

/** The per-upload fan-out, merged in the browser. Never throws for a single upload. */
export async function mergeViaPerUploadReads(
  files: readonly string[],
  readUpload: LoadPabMergeDeps['readUpload'],
): Promise<{ result: PabMergeResult; skipped: PabMergeSkipped[] }> {
  const reads = await Promise.all(
    files.map((file) =>
      readUpload(file).then(
        (json) => ({ file, json, error: json?.error ? String(json.error) : null }),
        (e: unknown) => ({ file, json: null, error: e instanceof Error ? e.message : String(e) }),
      ),
    ),
  );
  return {
    result: mergeHubstaffUploadsForPab(
      reads.map(({ file, json }) => ({ file, columns: json?.columns, rows: json?.rows })),
    ),
    skipped: reads.filter((r) => r.error !== null).map((r) => ({ file: r.file, error: r.error as string })),
  };
}

export async function loadAllUploadsPabMerge(
  files: readonly string[],
  deps: LoadPabMergeDeps,
): Promise<PabMergeLoad> {
  let fallbackReason: string;
  try {
    const res = await deps.postMerge(files);
    if (res.ok) {
      const parsed = parseServerMergeBody(await res.json());
      if (!('invalid' in parsed)) {
        return { ...parsed, via: 'server', fallbackReason: null };
      }
      fallbackReason = `server merge body invalid: ${parsed.invalid}`;
    } else {
      fallbackReason = `server merge HTTP ${res.status}`;
    }
  } catch (e) {
    fallbackReason = `server merge failed: ${e instanceof Error ? e.message : String(e)}`;
  }
  const { result, skipped } = await mergeViaPerUploadReads(files, deps.readUpload);
  return { result, skipped, via: 'per-upload', fallbackReason };
}
