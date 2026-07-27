// Removes stale hubstaff_hours batches left behind when the SAME source_file
// was ingested more than once (e.g. 2026-07-27: the 2026-07-19_to_2026-07-25
// CSV was uploaded twice ~9s apart; the first attempt aborted mid-insert and
// left 350 rows that duplicated people in every source_file-scoped reader).
//
// For each source_file whose rows span multiple upload_ids, the preferred
// batch (is_current first, then newest uploaded_at — same ranking as
// getHubstaffUploadIdBySourceFile) is KEPT; every other batch's rows are
// backed up to references/backups/ and deleted, along with their now-orphaned
// hubstaff_uploads rows (never the is_current one).
//
// Usage:
//   node scripts/cleanup-duplicate-hubstaff-uploads.mjs           # dry run
//   node scripts/cleanup-duplicate-hubstaff-uploads.mjs --apply   # delete
import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const APPLY = process.argv.includes('--apply');

const env = {};
for (const f of ['.env', '.env.local']) {
  try {
    for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line.trim());
      if (m) env[m[1]] = m[2].replace(/^"|"$/g, '');
    }
  } catch {}
}

const url = env.NEXT_PUBLIC_SUPABASE_URL || env.SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}
const supabase = createClient(url, key, { auth: { persistSession: false } });
const TABLE = env.NEXT_PUBLIC_SUPABASE_HUBSTAFF_HOURS_TABLE?.trim() || 'hubstaff_hours';

// 1. Full scan of (id, source_file, upload_id) to find multi-batch files.
const slim = [];
let from = 0;
while (true) {
  const { data, error } = await supabase
    .from(TABLE)
    .select('id, source_file, upload_id')
    .not('source_file', 'is', null)
    .range(from, from + 999);
  if (error) throw new Error(error.message);
  slim.push(...data);
  if (data.length < 1000) break;
  from += 1000;
}

const byFile = new Map();
for (const r of slim) {
  const sf = (r.source_file ?? '').trim();
  if (!sf) continue;
  if (!byFile.has(sf)) byFile.set(sf, new Map());
  const batches = byFile.get(sf);
  const uid = r.upload_id ?? '';
  if (!batches.has(uid)) batches.set(uid, []);
  batches.get(uid).push(r.id);
}

const multi = [...byFile.entries()].filter(([, batches]) => batches.size > 1);
if (multi.length === 0) {
  console.log('No source_file has rows from multiple upload batches. Nothing to do.');
  process.exit(0);
}

const { data: uploads, error: upErr } = await supabase
  .from('hubstaff_uploads')
  .select('id, source_file, uploaded_at, is_current')
  .order('uploaded_at', { ascending: false });
if (upErr) throw new Error(upErr.message);

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
mkdirSync('references/backups', { recursive: true });

for (const [sf, batches] of multi) {
  const preferred =
    uploads.find((u) => u.source_file === sf && u.is_current)?.id ??
    uploads.find((u) => u.source_file === sf && batches.has(u.id))?.id ??
    [...batches.entries()].sort((a, b) => b[1].length - a[1].length)[0][0];

  console.log(`\n${sf}`);
  for (const [uid, ids] of batches) {
    const up = uploads.find((u) => u.id === uid);
    const tag = uid === preferred ? 'KEEP  ' : 'DELETE';
    console.log(
      `  ${tag} upload=${uid || '(none)'} rows=${ids.length} uploaded_at=${up?.uploaded_at ?? '?'} is_current=${up?.is_current ?? '?'}`,
    );
  }

  const staleIds = [...batches.entries()]
    .filter(([uid]) => uid !== preferred)
    .flatMap(([, ids]) => ids);
  const staleUploadIds = [...batches.keys()].filter((uid) => uid && uid !== preferred);

  if (!APPLY) continue;

  // Backup the full stale rows before deleting.
  const staleRows = [];
  for (let i = 0; i < staleIds.length; i += 200) {
    const chunk = staleIds.slice(i, i + 200);
    const { data, error } = await supabase.from(TABLE).select('*').in('id', chunk);
    if (error) throw new Error(error.message);
    staleRows.push(...data);
  }
  const backupPath = `references/backups/hubstaff-dupe-batch_${sf.replace(/[^a-z0-9._-]/gi, '_')}_${stamp}.json`;
  writeFileSync(backupPath, JSON.stringify({ source_file: sf, deleted_upload_ids: staleUploadIds, rows: staleRows }, null, 2));
  console.log(`  backed up ${staleRows.length} rows -> ${backupPath}`);

  for (let i = 0; i < staleIds.length; i += 200) {
    const chunk = staleIds.slice(i, i + 200);
    const { error } = await supabase.from(TABLE).delete().in('id', chunk);
    if (error) throw new Error(error.message);
  }
  console.log(`  deleted ${staleIds.length} hubstaff_hours rows`);

  if (staleUploadIds.length > 0) {
    const { error } = await supabase
      .from('hubstaff_uploads')
      .delete()
      .in('id', staleUploadIds)
      .eq('is_current', false); // never delete the live cycle pointer
    if (error) throw new Error(error.message);
    console.log(`  deleted ${staleUploadIds.length} stale hubstaff_uploads row(s)`);
  }
}

console.log(APPLY ? '\nDone.' : '\nDry run only — re-run with --apply to delete.');
