/**
 * READ-ONLY. Proves the Payroll Wizard's all-uploads Hubstaff merge is byte-identical
 * whichever way it is produced, on the live table.
 *
 *   npx tsx scripts/verify-pab-merge-identity.mts
 *
 * A — THE OLD PATH, as it ran in the browser until 2026-09-26: one
 *     `GET /api/hubstaff-hours?source_file=` per upload (simulated by reading the
 *     rows with the same `fetchHubstaffRowsBySourceFile` and JSON round-tripping
 *     them, which is what the browser received), merged by the old inline
 *     `mergeRowsInto`, copied verbatim below.
 * B — THE NEW PATH: `POST /api/payroll-wizard/pab-merge` — the same reads, merged
 *     on the server by `mergeHubstaffUploadsForPab`, then JSON-serialised and
 *     parsed the way the wizard receives it.
 *
 * Exit 0 only when JSON.stringify(A) === JSON.stringify(B) — which fixes key
 * ORDER as well as every value — for the wizard's real upload order. It also
 * re-reads every upload a second time and checks the guarded reader returns the
 * same row set, and reports sizes and merge timings.
 *
 * Step 2's PAY hours read this merge (payroll-wizard-final-pay.md §4). Run it
 * after ANY change to pab-merge.ts, calendar-column-dedupe.ts's resolvers, or
 * fetchHubstaffRowsBySourceFile.
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
// Default import + destructure: the project's src is compiled CJS under tsx (see
// probe-first-paycheck-cohort.mts), so named ESM imports fail the export lexer.
import dbModule from '../src/lib/supabase/hubstaff-hours-db';
import mergeModule from '../src/lib/payroll/pab-merge';
import dedupeModule from '../src/lib/hubstaff/calendar-column-dedupe';
import emailModule from '../src/lib/email/norm-email';

const { fetchHubstaffRowsBySourceFile, listHubstaffUploads, sortHubstaffColumnsForDisplay } = dbModule as typeof import('../src/lib/supabase/hubstaff-hours-db');
const { mergeHubstaffUploadsForPab } = mergeModule as typeof import('../src/lib/payroll/pab-merge');
const { columnsAreAllCanonical, resolveCanonicalColumnsToIso } = dedupeModule as typeof import('../src/lib/hubstaff/calendar-column-dedupe');
const { normEmail } = emailModule as typeof import('../src/lib/email/norm-email');

/** The wizard's inline merge before 2026-09-26 — VERBATIM. Never edit to match the module. */
function legacyMerge(responses: { file: string; json: { columns?: string[] | null; rows?: Record<string, unknown>[] | null } }[]) {
  const mergeRowsInto = (
    rows: Record<string, unknown>[],
    rowsByEmail: Map<string, Record<string, unknown>>,
    allCols: Set<string>,
    sourceFile?: string,
  ) => {
    for (let row of rows) {
      if (sourceFile && columnsAreAllCanonical(Object.keys(row))) {
        row = resolveCanonicalColumnsToIso(row, sourceFile);
      }
      for (const k of Object.keys(row)) allCols.add(k);
      const rawEmail = String(row['Email'] ?? row['email'] ?? '').trim();
      const email = normEmail(rawEmail) ?? rawEmail.toLowerCase();
      if (!email) continue;
      const existing = rowsByEmail.get(email) ?? {};
      rowsByEmail.set(email, { ...existing, ...row });
    }
  };
  const allCols = new Set<string>();
  const rowsByEmail = new Map<string, Record<string, unknown>>();
  for (const { file, json } of responses) {
    if (!json.columns?.length || !json.rows?.length) continue;
    mergeRowsInto(json.rows, rowsByEmail, allCols, file);
  }
  return { columns: sortHubstaffColumnsForDisplay([...allCols]), rows: [...rowsByEmail.values()] };
}

/** The route retries each upload; so does this (local networks drop large responses). */
async function readWithRetry(file: string) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetchHubstaffRowsBySourceFile(file);
    } catch (e) {
      if (attempt >= 5) throw e;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

async function main() {
  // The wizard's order: is_current first, then the endpoint's newest-first, de-duplicated
  // (`loadUploadedSourceFiles` / `prefetchAccountingData`).
  const uploads = [...(await listHubstaffUploads())].sort((a, b) => Number(b.is_current) - Number(a.is_current));
  const files: string[] = [];
  const seen = new Set<string>();
  for (const u of uploads) {
    const f = (u.source_file ?? '').trim();
    if (!f || seen.has(f)) continue;
    seen.add(f);
    files.push(f);
  }
  console.log(`uploads: ${files.length} (current first: ${files[0]})`);

  const reads: { file: string; columns: string[]; rows: Record<string, unknown>[] }[] = [];
  for (const file of files) {
    const { columns, rows } = await readWithRetry(file);
    reads.push({ file, columns, rows });
  }

  // A — what the browser received (JSON round trip per upload) and merged inline.
  const browserResponses = reads.map(({ file, columns, rows }) => ({
    file,
    json: JSON.parse(JSON.stringify({ columns, rows })) as { columns: string[]; rows: Record<string, unknown>[] },
  }));
  let t = performance.now();
  const a = legacyMerge(browserResponses);
  const legacyMs = performance.now() - t;

  // B — merged on the server from the raw reads, serialised, parsed by the wizard.
  t = performance.now();
  const serverMerged = mergeHubstaffUploadsForPab(reads.map(({ file, columns, rows }) => ({ file, columns, rows })));
  const newMs = performance.now() - t;
  const wire = JSON.stringify({ columns: serverMerged.columns, skipped: [], rows: serverMerged.rows });
  const b = JSON.parse(wire) as { columns: string[]; rows: Record<string, unknown>[] };

  const aStr = JSON.stringify({ columns: a.columns, rows: a.rows });
  const bStr = JSON.stringify({ columns: b.columns, rows: b.rows });
  const identical = aStr === bStr;

  // The guarded reader must return the same ROW SET on a second read.
  let rereadMismatch = 0;
  for (const r of reads) {
    const again = await readWithRetry(r.file);
    const ids = (rows: Record<string, unknown>[]) => rows.map((x) => String(x.id)).sort().join(',');
    if (ids(again.rows) !== ids(r.rows)) {
      rereadMismatch++;
      console.log(`  re-read differs: ${r.file}`);
    }
  }

  const rawMB = browserResponses.reduce((s, x) => s + JSON.stringify(x.json).length, 0) / 1048576;
  console.log({
    people: a.rows.length,
    columns: a.columns.length,
    identical,
    rereadMismatch,
    oldBrowserPayloadMB: +rawMB.toFixed(2),
    newPayloadMB: +(wire.length / 1048576).toFixed(2),
    legacyMergeMs: Math.round(legacyMs),
    newMergeMs: Math.round(newMs),
  });

  if (!identical) {
    for (let i = 0; i < Math.max(a.rows.length, b.rows.length); i++) {
      if (JSON.stringify(a.rows[i]) !== JSON.stringify(b.rows[i])) {
        console.log('first differing row', i, { old: a.rows[i], new: b.rows[i] });
        break;
      }
    }
    if (JSON.stringify(a.columns) !== JSON.stringify(b.columns)) console.log('columns differ');
  }
  process.exit(identical && rereadMismatch === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
