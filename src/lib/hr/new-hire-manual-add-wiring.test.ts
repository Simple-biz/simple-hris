/**
 * The New Hire Checklist's MANUAL add stays, whatever the hiring-database sync does.
 *
 * Kane, 2026-10-08: "we should always retain the manual add new hire in here because —
 * Sometimes the other managers do their own hiring process but we still need to add them
 * so their accounts can be created." Those hires never pass through the recruitment
 * portal, so the sync can never bring them in; the modal is their only way onto the
 * checklist, and the checklist is what Lock-in (orientation) and Bulk Invite (accounts)
 * read. Source scans, like oms-panel-wiring.test.ts: a refactor that drops the button,
 * gates it on the sync, or makes the downstream readers skip manual rows fails HERE.
 * Doc: docs/features/new-hire-source-sync.md § The manual New Hire stays.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n');
const grid = read('src/components/hr/HrNewHireChecklist.tsx');
const route = read('app/api/hr/new-hire-checklist/route.ts');
const data = read('src/lib/supabase/hr-new-hire-checklist.ts');
const webhook = read('src/lib/hr/new-hire-checklist-webhook.ts');
const sync = read('src/lib/hr/hires-source-sync.ts');
const copyDb = read('src/lib/supabase/hr-new-hire-source-db.ts');

/** The JSX/function text from `from` up to the next occurrence of `to`. */
function slice(src: string, from: string, to: string): string {
  const at = src.indexOf(from);
  assert.ok(at >= 0, `missing: ${from}`);
  return src.slice(at, src.indexOf(to, at));
}

describe('the manual New Hire button is always there', () => {
  test('the floating New Hire button opens the add modal', () => {
    assert.match(grid, /aria-label="Add a new hire"/);
    const cta = slice(grid, 'aria-label="Add a new hire"', '</motion.button>');
    assert.match(grid, /onClick=\{openAdd\}[\s\S]{0,120}aria-label="Add a new hire"/);
    assert.match(cta, /New Hire/);
  });

  test('an empty week offers "Add a new hire" too', () => {
    assert.match(grid, /onClick=\{openAdd\}[^>]*>\s*<UserPlus[^>]*\/> Add a new hire/);
  });

  test('the add modal saves through handleQuickAdd → POST /api/hr/new-hire-checklist', () => {
    assert.match(grid, /return handleQuickAdd\(values\);/);
    const add = slice(grid, 'const handleQuickAdd = useCallback(', '[departments, period');
    assert.match(add, /fetch\('\/api\/hr\/new-hire-checklist', \{\s*method: 'POST'/);
  });

  test('neither button is gated on the sync — only a locked week disables adding', () => {
    const cta = slice(grid, '{/* "New Hire" CTA', '{/* Per-cell edit-history popover');
    assert.doesNotMatch(cta, /hiresSync|HiresSync|syncing/);
    const empty = slice(grid, ') : rows.length === 0 ? (', ') : (');
    assert.doesNotMatch(empty, /hiresSync|HiresSync|syncing/);
  });
});

describe('a hand-added hire is a full citizen', () => {
  test('the POST route inserts a MANUAL row (never passes the synced provenance)', () => {
    const post = slice(route, 'export async function POST', 'export async function PATCH');
    assert.match(post, /insertHrNewHireChecklistRow\(period, pickFields\(body\.values\), \{\s*createdBy: authz\.sessionEmail,\s*\}\)/);
    assert.doesNotMatch(post, /synced/);
  });

  test('Bulk Invite (account creation) and Lock-in (orientation) never filter on origin', () => {
    const bulk = slice(data, 'export async function listHrNewHireChecklistByDepartment', '\n}\n');
    assert.doesNotMatch(bulk, /origin|source_key/);
    const week = slice(data, 'export async function listHrNewHireChecklist(', '\n}\n');
    assert.doesNotMatch(week, /origin|source_key/);
    assert.doesNotMatch(webhook, /\borigin\b|source_key/);
  });

  test('the sync never deletes a checklist row', () => {
    assert.doesNotMatch(sync, /\.delete\(|deleteHrNewHireChecklistRows/);
    assert.doesNotMatch(copyDb, /\.delete\(/);
  });
});
