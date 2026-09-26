import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { ALWAYS_COLUMNS, GML_CATALOG, NEVER_COLUMNS } from './catalog';
import { MCP_TOOL_NAMES } from './mcp-server';
import {
  DATASETS,
  DATASET_DOMAINS,
  GLOBAL_MASTER_LIST_DATASET,
  LIVE_DATASETS,
  datasetBySlug,
  type Dataset,
} from './datasets';

/**
 * The Data catalog documents what outside systems may read. Its one dangerous
 * failure is a page that says a dataset is reachable when it is not (or the
 * reverse), so the live set is pinned against the controls that actually decide
 * reachability — the SQL scope CHECK, the route files, the MCP tool list — not
 * against itself.
 */

const ROOT = process.cwd();

function sqlFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sqlFiles(p));
    else if (name.endsWith('.sql')) out.push(p);
  }
  return out;
}

/**
 * The scope enumeration in force: the `external_api_clients_scopes_known` CHECK in
 * the newest (dated filename) SQL file that defines it. Phase A of the resources plan
 * widens it with an ALTER; that file sorts later and wins.
 */
function scopesInSqlCheck(): string[] {
  const defining = sqlFiles(path.join(ROOT, 'references', 'sql'))
    .map((p) => ({ p, text: readFileSync(p, 'utf8') }))
    .filter(({ text }) => /external_api_clients_scopes_known/.test(text) && /scopes\s*<@\s*array\s*\[/i.test(text))
    .sort((a, b) => path.basename(a.p).localeCompare(path.basename(b.p)));
  assert.ok(defining.length > 0, 'no SQL file defines external_api_clients_scopes_known');
  const newest = defining[defining.length - 1].text;
  const m = /scopes\s*<@\s*array\s*\[([^\]]*)\]/i.exec(newest);
  assert.ok(m, 'could not read the scope array out of the CHECK');
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

test('slugs are unique and every dataset sits in a known area', () => {
  const slugs = DATASETS.map((d) => d.slug);
  assert.equal(new Set(slugs).size, slugs.length);
  const domains = new Set(DATASET_DOMAINS.map((d) => d.id));
  for (const d of DATASETS) assert.ok(domains.has(d.domain), `${d.slug}: unknown area ${d.domain}`);
});

test('every area has at least one dataset (an empty group is a heading over nothing)', () => {
  for (const dom of DATASET_DOMAINS) {
    assert.ok(DATASETS.some((d) => d.domain === dom.id), `area ${dom.id} is empty`);
  }
});

test('only a live dataset carries a way in — planned and never entries have no scope, route or tool', () => {
  for (const d of DATASETS as readonly Dataset[]) {
    if (d.status === 'live') continue;
    const loose = d as unknown as Record<string, unknown>;
    for (const k of ['scope', 'restPath', 'mcpTool']) {
      assert.equal(loose[k], undefined, `${d.slug} (${d.status}) must not declare ${k}`);
    }
  }
});

test('"Never offered" holds exactly the never datasets', () => {
  for (const d of DATASETS) {
    assert.equal(d.domain === 'never', d.status === 'never', `${d.slug}: area and status disagree`);
  }
});

test('the live scopes are exactly the scopes the SQL CHECK allows — both directions', () => {
  const sql = scopesInSqlCheck().sort();
  const live = LIVE_DATASETS.map((d) => d.scope).sort();
  // A scope in the CHECK with no live page = a dataset keys can hold that the catalog calls planned.
  // A live page whose scope the CHECK refuses = a dataset the catalog calls reachable that no key can hold.
  assert.deepEqual(live, sql);
});

test('every live dataset names a REST route that exists on disk', () => {
  for (const d of LIVE_DATASETS) {
    assert.match(d.restPath, /^\/api\/external\//, `${d.slug}: outside /api/external/ cannot be key-gated`);
    const file = path.join(ROOT, 'app', ...d.restPath.split('/').filter(Boolean), 'route.ts');
    assert.ok(existsSync(file), `${d.slug}: ${d.restPath} has no route file`);
  }
});

test('every live dataset names an MCP tool the server registers', () => {
  for (const d of LIVE_DATASETS) {
    assert.ok((MCP_TOOL_NAMES as readonly string[]).includes(d.mcpTool), `${d.slug}: ${d.mcpTool} is not an MCP tool`);
  }
});

test('the Global Master List page IS catalog.ts — imported, never retyped', () => {
  assert.equal(GLOBAL_MASTER_LIST_DATASET.fields, GML_CATALOG);
  assert.equal(GLOBAL_MASTER_LIST_DATASET.always, ALWAYS_COLUMNS);
  assert.equal(GLOBAL_MASTER_LIST_DATASET.neverServed, NEVER_COLUMNS);
  assert.equal(datasetBySlug('global-master-list'), GLOBAL_MASTER_LIST_DATASET);
});

test('Bank info never offers a full number (Kane, 2026-09-25) and says so on the page', () => {
  const bank = datasetBySlug('bank-info');
  assert.ok(bank && bank.status !== 'never', 'bank-info must exist as a live or planned dataset');
  const FULL = ['account_number', 'routing_number', 'swift_code', 'alt_account_number', 'alt_routing_number'];
  const offered = bank.fields.map((x) => x.name);
  for (const col of FULL) {
    assert.ok(!offered.includes(col), `bank-info must not offer ${col}`);
    assert.ok(bank.neverServed.includes(col), `bank-info must list ${col} under never-served`);
  }
  // A last-4 is the most the page may promise — nothing that reads as a whole number.
  for (const name of offered) assert.doesNotMatch(name, /(^|_)(account|routing)_number$|swift/i, name);
});

test('no field is both offered and never-served', () => {
  for (const d of DATASETS) {
    if (d.status === 'never') continue;
    const never = new Set(d.neverServed);
    for (const fld of d.fields) assert.ok(!never.has(fld.name), `${d.slug}: ${fld.name} is offered and never-served`);
  }
});

test('field names are unique within a dataset', () => {
  for (const d of DATASETS) {
    if (d.status === 'never') continue;
    const names = d.fields.map((x) => x.name);
    assert.equal(new Set(names).size, names.length, d.slug);
  }
});

test('an open caveat says where the fact lives', () => {
  for (const d of DATASETS) {
    for (const c of d.caveats) {
      if (c.kind === 'open') assert.ok(c.ref && c.ref.trim(), `${d.slug}: an open caveat needs a ref`);
    }
  }
});

test('every money-area dataset is marked money or restricted', () => {
  for (const d of DATASETS) {
    if (d.domain === 'pay') assert.equal(d.sensitivity, 'money', d.slug);
    if (d.domain === 'banking') assert.equal(d.sensitivity, 'restricted', d.slug);
  }
});
