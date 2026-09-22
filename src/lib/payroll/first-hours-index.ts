import 'server-only';

/**
 * Server side of the "first paycheck" label (`first-paycheck.ts`): for every
 * email that has ever appeared in `hubstaff_hours`, the EARLIEST upload week
 * (parsed period start) that carries it.
 *
 * Reads two columns (`Email`, `source_file`) across the whole table, PAGED —
 * PostgREST returns at most 1000 rows per request with no error (measured
 * 40,509 rows / 31 uploads on 2026-09-22). The result only changes when an
 * upload lands, so it is cached in-process keyed on the uploads list signature
 * (ids + is_current), with a TTL as belt-and-braces for a process that outlives
 * an upload it never saw.
 *
 * Every upload with a parseable `_to_` range counts, backfills and junk-suffixed
 * names included: for "have they worked before?" MORE history is the safe
 * direction, and a `(1)` week was genuinely paid (memory:
 * hubstaff-filename-junk-heuristic-hides-paid-week). Never apply that regex here.
 *
 * Fails to an EMPTY index with `error` set. The consumer (the wizard) then
 * labels nobody and says so — a failed read must never show as "no first
 * paychecks this week".
 */
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { selectAllPaged } from '@/lib/supabase/select-all-paged';
import { listHubstaffUploads } from '@/lib/supabase/hubstaff-hours-db';
import { buildFirstHoursIndex, weekKeyFromUploadName, type WeekKey } from './first-paycheck';

const HUBSTAFF_TABLE = process.env.NEXT_PUBLIC_SUPABASE_HUBSTAFF_HOURS_TABLE?.trim() || 'hubstaff_hours';
const CACHE_TTL_MS = 10 * 60 * 1000;

export interface FirstHoursIndexPayload {
  /** normalized email → earliest upload week key (`YYYY-MM-DD`). */
  byEmail: Record<string, WeekKey>;
  oldestWeek: WeekKey | null;
  /** Distinct upload names that fed the index. */
  filesIndexed: number;
  /** Rows whose `source_file` had no parseable range — counted, not hidden. */
  rowsSkipped: number;
  /** Non-null ⇒ the index is EMPTY and must not be read as "nobody is new". */
  error: string | null;
}

let cache: { sig: string; builtAt: number; payload: FirstHoursIndexPayload } | null = null;

function uploadsSignature(uploads: Awaited<ReturnType<typeof listHubstaffUploads>>): string {
  return uploads.map((u) => `${u.id}:${u.is_current ? 1 : 0}`).sort().join('|');
}

/** Test seam / rare operator need. Not wired to any route. */
export function resetFirstHoursIndexCache(): void {
  cache = null;
}

export async function loadFirstHoursIndex(): Promise<FirstHoursIndexPayload> {
  try {
    const uploads = await listHubstaffUploads();
    const sig = uploadsSignature(uploads);
    if (cache && cache.sig === sig && Date.now() - cache.builtAt < CACHE_TTL_MS) {
      return cache.payload;
    }

    const supabase = createSupabaseServiceRoleClient();
    if (!supabase) throw new Error('Supabase service role is not configured');

    type Row = { Email: string | null; source_file: string | null };
    const { rows, error } = await selectAllPaged<Row>((from, to) =>
      supabase
        .from(HUBSTAFF_TABLE)
        .select('"Email", source_file')
        .not('source_file', 'is', null)
        .order('id', { ascending: true })
        .range(from, to),
    );
    if (error) throw new Error(error);

    const files = new Set<string>();
    const built = buildFirstHoursIndex(
      rows.map((r) => {
        const sf = (r.source_file ?? '').trim();
        if (sf) files.add(sf);
        return { email: r.Email, weekKey: weekKeyFromUploadName(sf) };
      }),
    );

    const payload: FirstHoursIndexPayload = {
      byEmail: Object.fromEntries(built.firstWeekByEmail),
      oldestWeek: built.oldestWeek,
      filesIndexed: files.size,
      rowsSkipped: built.skipped,
      error: null,
    };
    cache = { sig, builtAt: Date.now(), payload };
    return payload;
  } catch (e) {
    return {
      byEmail: {},
      oldestWeek: null,
      filesIndexed: 0,
      rowsSkipped: 0,
      error: e instanceof Error ? e.message : 'Could not build the first-hours index',
    };
  }
}
