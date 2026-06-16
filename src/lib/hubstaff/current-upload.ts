/**
 * Canonical selection of the Hubstaff upload that accounting / the Payroll
 * Wizard are actively processing — the **Initialized (`is_current`) batch**.
 *
 * The public `GET /api/hubstaff-hours?source_files=1` endpoint returns uploads
 * newest-first so employee/manager dashboards always show the latest upload.
 * Accounting follows the Initialized batch instead: stable-sort `is_current`
 * first, then take the first distinct source_file. This mirrors the Payroll
 * Wizard's `loadUploadedSourceFiles()` (PayrollWizard.tsx) so any surface that
 * needs "the week accounting is dispatching" resolves to the same file.
 *
 * Falls back to the newest file when no upload is flagged current, or to the
 * `files[]` list when the richer `uploads[]` metadata is empty/unavailable.
 *
 * See memory/docs: "Upload batch source of truth" — the newest-first ↔
 * is_current-first split between the public and accounting surfaces.
 */
export interface HubstaffUploadLite {
  source_file: string | null;
  is_current: boolean;
}

/** Shape returned by `GET /api/hubstaff-hours?source_files=1`. */
export interface HubstaffSourceFilesResponse {
  files?: string[];
  uploads?: HubstaffUploadLite[];
}

/**
 * Return the source_file of the current (Initialized) batch, or null when no
 * uploads exist at all.
 */
export function pickCurrentSourceFile(
  uploads: HubstaffUploadLite[] | undefined,
  files: string[] | undefined,
): string | null {
  // Stable sort keeps the endpoint's newest-first order within each group, so
  // the result is the newest is_current upload — or, if none is current, the
  // newest upload overall. Matches the wizard exactly.
  const sorted = [...(uploads ?? [])].sort(
    (a, b) => Number(b.is_current) - Number(a.is_current),
  );
  for (const u of sorted) {
    const f = (u.source_file ?? "").trim();
    if (f) return f;
  }
  const fallback = (files ?? []).find((f) => (f ?? "").trim());
  return fallback ? fallback.trim() : null;
}
