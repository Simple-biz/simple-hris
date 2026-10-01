import 'server-only';

/**
 * The Accounting Scoreboard archive: sheet tabs the board has no section for, kept row for row AS
 * TYPED (accounting_scoreboard_archive, references/sql/create/2026-10-01_accounting_scoreboard_backfill.sql).
 * Governing doc: docs/features/accounting-scoreboard-backfill.md.
 *
 * Read-only. Nothing in the app writes the archive: the backfill script is its only writer. Paged,
 * because one tab alone is 615 rows and PostgREST stops at 1000.
 */

import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { selectAllPaged } from '@/lib/supabase/select-all-paged';
import type { Result } from './server';

export interface ArchiveTabView {
  tab: string;
  /** The tab's first archived row: its column headings. */
  header: string[];
  /** Every other row, in the sheet's own order (that tab is newest first). */
  rows: Array<{ sheetRow: number; cells: string[]; entryDate: string | null }>;
  firstDate: string | null;
  lastDate: string | null;
  importedAt: string;
}

type ArchiveRecord = { tab: string; sheet_row: number; cells: unknown; entry_date: string | null; imported_at: string };

const asCells = (v: unknown): string[] => (Array.isArray(v) ? v.map((c) => (c === null || c === undefined ? '' : String(c))) : []);

export async function readArchive(): Promise<Result<ArchiveTabView[]>> {
  const sb = createSupabaseServiceRoleClient();
  if (!sb) throw new Error('Supabase service role is not configured');
  const { rows, error } = await selectAllPaged<ArchiveRecord>((from, to) =>
    sb
      .from('accounting_scoreboard_archive')
      .select('tab, sheet_row, cells, entry_date, imported_at')
      .order('tab')
      .order('sheet_row')
      .range(from, to),
  );
  if (error) {
    const missing = /does not exist|schema cache|PGRST205|42P01/i.test(error);
    return {
      ok: false,
      status: missing ? 503 : 500,
      code: missing ? 'not_set_up' : 'db_error',
      message: missing
        ? 'The archive is not set up yet (scripts/apply-accounting-scoreboard-backfill-migration.mts).'
        : error,
    };
  }

  const byTab = new Map<string, ArchiveRecord[]>();
  for (const r of rows) byTab.set(r.tab, [...(byTab.get(r.tab) ?? []), r]);

  const tabs: ArchiveTabView[] = [...byTab].map(([tab, list]) => {
    const [head, ...rest] = list;
    const dates = rest.map((r) => r.entry_date).filter((d): d is string => !!d).sort();
    return {
      tab,
      header: asCells(head?.cells),
      rows: rest.map((r) => ({ sheetRow: r.sheet_row, cells: asCells(r.cells), entryDate: r.entry_date })),
      firstDate: dates[0] ?? null,
      lastDate: dates[dates.length - 1] ?? null,
      importedAt: head?.imported_at ?? '',
    };
  });
  return { ok: true, value: tabs };
}
