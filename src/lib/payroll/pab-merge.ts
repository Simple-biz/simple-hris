/**
 * The Payroll Wizard's ALL-UPLOADS Hubstaff merge — one row per person across
 * every archived weekly upload.
 *
 * This is a money input, not a PAB display helper. Two consumers read it:
 *   - the PAB verdicts (steps 4 / 5 / 7 / 8 — `hubstaffRowsForPab`), and
 *   - Step 2's PAY hours: `payDaysByEmail` reads these merged rows to recover a
 *     pay week's leading Sunday from the ADJACENT upload
 *     (`payroll-wizard-final-pay.md` §4, `docs/notes/hubstaff-sunday-overlap.md`).
 *
 * Semantics, all of them load-bearing and all of them the wizard's since
 * 2026-06-10:
 *   - Uploads are merged IN THE ORDER GIVEN, and the merge is LAST-WINS: a later
 *     upload's value replaces an earlier one's for the same key, INCLUDING a
 *     null. The wizard passes `uploadedSourceFiles` (the `is_current` upload
 *     first, then newest-first), so for a date two uploads both carry the
 *     older upload's cell is the one that survives. Reordering the input moves
 *     money.
 *   - Canonical weekday columns (`monday`…`sunday`) are resolved to true ISO
 *     dates from EACH upload's own filename before merging, so weeks do not
 *     overwrite each other's `monday`.
 *   - People are keyed by `normEmail(Email)`; a row with no email is dropped.
 *   - An upload with no columns or no rows contributes nothing (not an error).
 *
 * Until 2026-09-26 this lived inline in `PayrollWizard.tsx` and ran in the
 * browser, copying every person's growing merged object once per upload
 * (`{ ...existing, ...row }`) — 756 ms of main thread on the live 31-upload,
 * 40,509-row table. It now mutates ONE accumulator object per person, which
 * yields the same keys in the same order with the same values: a spread and
 * `Object.assign` both keep an existing key's position and append new keys in
 * the row's order. `pab-merge.test.ts` pins the result against the old
 * inline implementation, verbatim, and
 * `scripts/verify-pab-merge-identity.mts` proves it byte-for-byte on live data.
 *
 * Pure and client-safe: the wizard runs it for the legacy per-upload fallback,
 * and `POST /api/payroll-wizard/pab-merge` runs it on the server.
 */
import {
  columnsAreAllCanonical,
  createCanonicalIsoResolver,
} from '@/lib/hubstaff/calendar-column-dedupe';
import { normEmail } from '@/lib/email/norm-email';
import { sortHubstaffColumnsForDisplay } from '@/lib/supabase/hubstaff-hours-db';

/** One upload's rows, as `GET /api/hubstaff-hours?source_file=` returns them. */
export type PabMergeUpload = {
  file: string;
  columns: readonly string[] | null | undefined;
  rows: readonly Record<string, unknown>[] | null | undefined;
};

export type PabMergeResult = {
  /** Every column any merged row carries, in the wizard's display order. */
  columns: string[];
  /** One row per normalized email, in first-seen order. */
  rows: Record<string, unknown>[];
};

/**
 * The merge state, exposed so the wizard's no-upload-list branch (one
 * unfiltered read, no filename to resolve dates from) folds through the SAME
 * row rule as the per-upload path instead of a second copy of it.
 */
export type PabMergeAccumulator = {
  readonly allCols: Set<string>;
  readonly rowsByEmail: Map<string, Record<string, unknown>>;
};

export function createPabMergeAccumulator(): PabMergeAccumulator {
  return { allCols: new Set<string>(), rowsByEmail: new Map<string, Record<string, unknown>>() };
}

/**
 * Fold one upload's rows into the accumulator. `sourceFile` is the upload's
 * filename; without one, canonical weekday columns are left as they are
 * (exactly what the wizard did when it had no filename to resolve them from).
 * The input rows are never mutated.
 */
export function mergeUploadRowsInto(
  acc: PabMergeAccumulator,
  rows: readonly Record<string, unknown>[],
  sourceFile?: string,
): void {
  const resolve = sourceFile ? createCanonicalIsoResolver(sourceFile) : null;
  // `columnsAreAllCanonical` is a pure function of the row's key list, and an
  // upload's rows almost always share one list (PostgREST returns every
  // selected column on every row), so its answer is cached per key list.
  const canonicalByKeys = new Map<string, boolean>();

  for (const input of rows) {
    let row = input;
    if (resolve) {
      const keys = Object.keys(row);
      const sig = keys.join('\u0000');
      let canonical = canonicalByKeys.get(sig);
      if (canonical === undefined) {
        canonical = columnsAreAllCanonical(keys);
        canonicalByKeys.set(sig, canonical);
      }
      if (canonical) row = resolve(row);
    }
    for (const k of Object.keys(row)) acc.allCols.add(k);
    const rawEmail = String(row['Email'] ?? row['email'] ?? '').trim();
    const email = normEmail(rawEmail) ?? rawEmail.toLowerCase();
    if (!email) continue;
    const existing = acc.rowsByEmail.get(email);
    // First sighting COPIES — the resolver hands back the input row itself when
    // the filename carries no parseable range, and inputs must stay untouched.
    if (existing) Object.assign(existing, row);
    else acc.rowsByEmail.set(email, { ...row });
  }
}

export function finishPabMerge(acc: PabMergeAccumulator): PabMergeResult {
  return {
    columns: sortHubstaffColumnsForDisplay([...acc.allCols]),
    rows: [...acc.rowsByEmail.values()],
  };
}

/** Merge every upload, in the order given. See the module comment for why order matters. */
export function mergeHubstaffUploadsForPab(uploads: readonly PabMergeUpload[]): PabMergeResult {
  const acc = createPabMergeAccumulator();
  for (const { file, columns, rows } of uploads) {
    if (!columns?.length || !rows?.length) continue;
    mergeUploadRowsInto(acc, rows, file);
  }
  return finishPabMerge(acc);
}
