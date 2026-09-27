import { NextResponse, type NextRequest } from "next/server";
import { deniedResponse } from "@/lib/auth/authorize-email";
import { requireFeatureAccess } from "@/lib/auth/authorize-feature";
import { fetchHubstaffRowsBySourceFile } from "@/lib/supabase/hubstaff-hours-db";
import { mergeHubstaffUploadsForPab, type PabMergeUpload } from "@/lib/payroll/pab-merge";
import { encodePabMergeStream } from "@/lib/payroll/pab-merge-stream";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/** Well above the 31 uploads on record (2026-09-26); a year of weekly files is ~52. */
const MAX_FILES = 400;
const MAX_FILE_NAME = 512;
/** Uploads read at once. The browser used to fire all of them at once, one request each. */
const CONCURRENCY = 8;
const ATTEMPTS = 3;
/** Merged rows serialised per stream chunk. */
const ROWS_PER_CHUNK = 250;

type Skipped = { file: string; error: string };

/**
 * POST — the Payroll Wizard's all-uploads Hubstaff merge, done on the server.
 *
 * Body: `{ files: string[] }` — the wizard's `uploadedSourceFiles`, **in its
 * order** (`is_current` first, then newest-first). The merge is last-wins, so the
 * order is part of the input and is used exactly as sent: never sorted, never
 * de-duplicated, never re-derived here.
 *
 * Returns `{ columns, rows, skipped }` — what the wizard used to assemble in the
 * browser from one `GET /api/hubstaff-hours?source_file=` per upload (31 requests,
 * ~22.5 MB of JSON, plus a 756 ms merge on the main thread). Each upload is read
 * with the SAME `fetchHubstaffRowsBySourceFile` that route serves, and merged by
 * the SAME `mergeHubstaffUploadsForPab` the wizard's fallback uses, so the rows
 * are identical whichever path produced them
 * (`scripts/verify-pab-merge-identity.mts` proves it on live data).
 *
 * **A failed upload is SKIPPED, exactly as the per-upload fan-out skipped it** —
 * but retried first (the fan-out never retried) and named in `skipped`, where the
 * fan-out said nothing. Whether a skipped week should instead fail the whole merge
 * is a money ruling (a skipped week inside the PAB month manufactures failures),
 * not something this route decides.
 *
 * **Streamed.** The merged payload is ~5 MB for 31 uploads and grows every week;
 * a buffered Vercel Function response is capped at 4.5 MB, a streamed one is not.
 *
 * Same gate as every other Payroll Wizard read. Read-only. No cache: hour rows
 * have been edited in place by scripts (`backfill-may10-sunday.mjs`,
 * `delete-randal-hayes-hubstaff-hours.mjs`) without touching `hubstaff_uploads`,
 * so no upload-list signature can prove a cached merge current.
 */
export async function POST(req: NextRequest) {
  const authz = await requireFeatureAccess("accounting", "payroll_wizard", "view");
  if (!authz.ok) return deniedResponse(authz);

  const body = (await req.json().catch(() => null)) as { files?: unknown } | null;
  const files = body?.files;
  if (
    !Array.isArray(files) ||
    files.length === 0 ||
    files.length > MAX_FILES ||
    !files.every((f) => typeof f === "string" && f.trim() !== "" && f.length <= MAX_FILE_NAME)
  ) {
    return NextResponse.json(
      { error: `files must be 1–${MAX_FILES} non-empty upload names` },
      { status: 400 },
    );
  }
  const names = files as string[];

  const uploads: (PabMergeUpload | null)[] = new Array(names.length).fill(null);
  const failures: (Skipped | null)[] = new Array(names.length).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < names.length) {
      const i = next++;
      const file = names[i];
      let lastError = "";
      for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
        try {
          const { columns, rows } = await fetchHubstaffRowsBySourceFile(file);
          uploads[i] = { file, columns, rows };
          lastError = "";
          break;
        } catch (e) {
          lastError = e instanceof Error ? e.message : String(e);
        }
      }
      if (lastError) failures[i] = { file, error: lastError };
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, names.length) }, worker));
  const skipped = failures.filter((s): s is Skipped => s !== null);

  // `uploads` is indexed by the caller's order, so filtering the failures out
  // leaves every surviving upload exactly where the fan-out would have merged it.
  const merged = mergeHubstaffUploadsForPab(uploads.filter((u): u is PabMergeUpload => u !== null));
  if (skipped.length > 0) {
    console.warn(
      `[pab-merge] ${skipped.length} of ${names.length} uploads skipped after ${ATTEMPTS} attempts:`,
      skipped.map((s) => `${s.file} (${s.error})`).join("; "),
    );
  }

  return new Response(encodePabMergeStream(merged, skipped, ROWS_PER_CHUNK), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
