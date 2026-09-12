/**
 * Server half of the live-overlay window: reads what the uploaded batches actually
 * cover, then hands it to the pure resolver in `./live-window`.
 *
 * FAILS SAFE BY CONSTRUCTION. Every failure path — the uploads table unreadable, an
 * empty archive, filenames nothing can parse — yields an EMPTY coverage set, and an
 * empty set makes `resolveLiveOverlayWindow` return exactly the fixed 13-day window it
 * replaced. A broken read therefore costs the request volume this exists to cut; it can
 * never blank a day on an employee's calendar. The inverse (guessing coverage on a bad
 * read, and so asking for less) is the outcome worth engineering against.
 */

import { listHubstaffUploads } from '@/lib/supabase/hubstaff-hours-db';
import {
  coveredDatesFromSourceFiles,
  resolveLiveOverlayWindow,
  type LiveOverlayWindow,
} from './live-window';

/**
 * Batch coverage moves only when someone uploads a CSV, so it is re-read far less often
 * than the activities themselves. Longer than the 180s activities TTL on purpose: a
 * stale coverage read can only make the window WIDER than necessary (the old behaviour),
 * never narrower.
 */
const COVERAGE_TTL_MS = 600_000;

let coverageCache: { at: number; sourceFiles: string[] } | null = null;

async function uploadedSourceFiles(): Promise<{ files: string[]; known: boolean }> {
  const now = Date.now();
  if (coverageCache && now - coverageCache.at < COVERAGE_TTL_MS) {
    return { files: coverageCache.sourceFiles, known: true };
  }
  try {
    const uploads = await listHubstaffUploads();
    const files = uploads.map((u) => u.source_file).filter((f): f is string => !!f);
    coverageCache = { at: now, sourceFiles: files };
    return { files, known: true };
  } catch (e) {
    // Never cache a failure, and never let it narrow the window.
    console.warn('[hubstaff live-window] coverage read failed, using full lookback:', e);
    return { files: [], known: false };
  }
}

/** Test seam — lets a caller drop the memo without waiting out the TTL. */
export function resetLiveOverlayCoverageCache(): void {
  coverageCache = null;
}

export async function resolveLiveOverlayWindowForToday(
  todayIso: string,
): Promise<LiveOverlayWindow & { coverageKnown: boolean }> {
  const { files, known } = await uploadedSourceFiles();
  const window = resolveLiveOverlayWindow({
    todayIso,
    coveredDates: coveredDatesFromSourceFiles(files),
  });
  return { ...window, coverageKnown: known };
}
