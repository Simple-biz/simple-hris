import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  AUDIT_FAMILIES,
  AUDIT_SURFACES,
  auditSurfaceDef,
  describeAuditFamilies,
  familiesForSurface,
  familyForAction,
  isOnSurface,
  surfacesForAction,
} from './registry';

/**
 * What this file is for: the audit-action registry is now the single source of
 * truth behind BOTH the Admin panel's dashboard filter and Admin Penny's
 * `search_audit_log` description. Its predecessors were two hand-kept lists,
 * and both had already drifted from the log — the panel silently had no
 * category for half the live families, and the tool description named actions
 * that do not exist while omitting three of the largest that do
 * (memory/penny-audit-log-visibility.md).
 *
 * So the registry is only worth having if it cannot fall behind the code. This
 * scans every `insertAuditLog` / `insertAuditLogs` call site in the repo and
 * fails when an action string has no family to land in. A new audited action
 * therefore breaks the build until it is registered, which is the point.
 */

const REPO = process.cwd();
const SCAN_DIRS = [join(REPO, 'app'), join(REPO, 'src')];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(full) && !full.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

type Emitted = { action: string; file: string; dynamic: boolean };

/**
 * Collect the `action:` values that belong to an audit write.
 *
 * `action:` is a common key elsewhere (route bodies, decision payloads), so a
 * naive repo-wide grep pulls in `action: 'approve'` and friends. The window is
 * therefore anchored: only `action:` lines within 14 lines AFTER an
 * `insertAuditLog(` / `insertAuditLogs(` call, or inside a local `audit(...)`
 * helper's own call sites, are treated as audit actions.
 */
function collectEmittedActions(): Emitted[] {
  const found: Emitted[] = [];
  for (const dir of SCAN_DIRS) {
    for (const file of walk(dir)) {
      const src = readFileSync(file, 'utf8');
      if (!src.includes('insertAuditLog')) continue;
      // Split on CRLF too: the repo has mixed line endings, and a stray `\r`
      // silently defeats a `(.*)$` match (JS `.` excludes it) — which is how
      // the first draft of this scan "found" full coverage while missing
      // `payroll.rate.set` entirely.
      const lines = src.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        if (!/insertAuditLogs?\s*\(/.test(lines[i]!)) continue;
        for (let j = i; j < Math.min(i + 14, lines.length); j += 1) {
          if (!/action:/.test(lines[j]!)) continue;
          // The action EXPRESSION, which may span lines (a multi-line ternary):
          // take the text after `action:` and stop at the next property key.
          const chunk = lines.slice(j, j + 5).join(' ');
          let expr = chunk.slice(chunk.indexOf('action:') + 'action:'.length);
          const stop = expr.search(/\b(resource|resource_id|details|user_name|ip_address):/);
          if (stop !== -1) expr = expr.slice(0, stop);
          // For a ternary, everything before `?` is the CONDITION — its string
          // literals ('approved', 'hidden', 'suspend') are not action names.
          const q = expr.indexOf('?');
          if (q !== -1) expr = expr.slice(q);
          // Nested ternaries put further conditions AFTER that `?`
          // (`: decision === 'returned' ? …`), so drop every literal that is
          // the right-hand side of a comparison.
          expr = expr.replace(/[!=]==?\s*['"][^'"]*['"]/g, '');

          for (const lit of expr.matchAll(/['"]([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*)['"]/g)) {
            found.push({ action: lit[1]!, file: relative(REPO, file), dynamic: false });
          }
          // Template literals: only the static head can be checked, which is
          // exactly what a prefix family needs.
          const tpl = /`([a-z][a-z0-9_.]*)\$\{/.exec(expr);
          if (tpl) found.push({ action: tpl[1]!, file: relative(REPO, file), dynamic: true });
          break;
        }
      }
    }
  }
  return found;
}

const EMITTED = collectEmittedActions();

/* ── Negative control ────────────────────────────────────────────────────── */

/**
 * A scan that matched nothing would report perfect coverage of an empty set.
 * Refuse to conclude anything unless it actually found the call sites, and
 * unless it found specific ones that are known to exist.
 */
test('the source scan found the audit call sites', () => {
  assert.ok(
    EMITTED.length >= 100,
    `scan found only ${EMITTED.length} audit actions — the anchor pattern is probably broken`,
  );
  const names = new Set(EMITTED.map((e) => e.action));
  for (const expected of [
    'payroll.rate.set',
    'people.profile.updated',
    'pab_dispute.admin_deleted',
    'orphanage_registry.deleted',
    'bonus_catalog.definition.deleted',
    'hsl_bonus.period_deleted',
    'audit.purged',
    'ceo_assistant.feedback',
    'daily_report.imported',
  ]) {
    assert.ok(names.has(expected), `scan missed a known action: ${expected}`);
  }
  assert.ok(
    EMITTED.some((e) => e.dynamic),
    'scan found no template-literal actions — the `qc.review.${…}` form exists and must be covered',
  );
});

/* ── Coverage ────────────────────────────────────────────────────────────── */

test('every emitted audit action resolves to a registered family', () => {
  const orphans = new Map<string, string[]>();
  for (const e of EMITTED) {
    if (familyForAction(e.action)) continue;
    const files = orphans.get(e.action) ?? [];
    if (!files.includes(e.file)) files.push(e.file);
    orphans.set(e.action, files);
  }
  assert.deepEqual(
    [...orphans.entries()].map(([action, files]) => `${action} (${files.join(', ')})`),
    [],
    'these actions have no family in src/lib/audit/registry.ts — add one, or the Admin panel ' +
      'cannot filter them and Penny cannot describe them',
  );
});

test('every registered family is reachable from at least one dashboard', () => {
  for (const fam of AUDIT_FAMILIES) {
    assert.ok(fam.surfaces.length > 0, `${fam.match} lists no surface`);
    for (const surface of fam.surfaces) {
      // Throws on an id outside the union.
      auditSurfaceDef(surface);
      assert.ok(
        familiesForSurface(surface).includes(fam),
        `${fam.match} claims ${surface} but familiesForSurface disagrees`,
      );
    }
  }
});

test('family prefixes are unique', () => {
  const seen = new Set<string>();
  for (const fam of AUDIT_FAMILIES) {
    const key = `${fam.exact ? 'exact' : 'prefix'}:${fam.match}`;
    assert.ok(!seen.has(key), `duplicate family entry: ${key}`);
    seen.add(key);
  }
});

/* ── Longest match wins ──────────────────────────────────────────────────── */

/**
 * The old panel depended on ARRAY ORDER ("listed before `csv` so
 * `csv.rates.sync` is tagged as a sync") — a comment that stops being true the
 * moment anyone re-sorts the list. Matching is longest-prefix instead, so these
 * hold however the array is ordered.
 */
test('a narrow family beats a broad one regardless of order', () => {
  assert.equal(familyForAction('orphanage.vendor.saved')?.match, 'orphanage.');
  assert.equal(familyForAction('orphanage_registry.deleted')?.match, 'orphanage_registry.');
  assert.equal(familyForAction('orphanage_intern_pay.week_submitted')?.match, 'orphanage_intern');
  assert.equal(familyForAction('employee.mesa.enroll')?.match, 'employee.mesa.');
  assert.equal(familyForAction('employee.login.success')?.match, 'employee.');
  assert.equal(familyForAction('department_transfer.requested')?.match, 'department_transfer.');
  assert.equal(familyForAction('department.create')?.match, 'department.');
  assert.equal(familyForAction('paystubs.staged')?.match, 'paystub');
});

test('an unknown action resolves to nothing rather than a default bucket', () => {
  assert.equal(familyForAction('totally.made.up'), null);
  assert.deepEqual(surfacesForAction('totally.made.up'), []);
  assert.equal(isOnSurface('totally.made.up', 'admin'), false);
  assert.equal(familyForAction(''), null);
  assert.equal(familyForAction('   '), null);
});

/* ── The four dashboards this pass was about ─────────────────────────────── */

test('Accounting, CEO, HR and Orphanage each own the families they were missing', () => {
  const cases: Array<[string, Parameters<typeof isOnSurface>[1]]> = [
    // Orphanage — the registry CRUD had no audit event at all before this pass.
    ['orphanage_registry.created', 'orphanage'],
    ['orphanage_registry.updated', 'orphanage'],
    ['orphanage_registry.deleted', 'orphanage'],
    ['orphanage_registry.photo_uploaded', 'orphanage'],
    ['pab_dispute.submitted', 'orphanage'],
    // Accounting — pay definitions and the HSL period wipe.
    ['bonus_catalog.definition.saved', 'accounting'],
    ['bonus_catalog.definition.deleted', 'accounting'],
    ['bonus_catalog.assignment.added', 'accounting'],
    ['system_bonus.saved', 'accounting'],
    ['system_bonus.deleted', 'accounting'],
    ['hsl_bonus.period_deleted', 'accounting'],
    ['hsl_bonus.entry_deleted', 'accounting'],
    // HR.
    ['hr.onboarding.notifications_backfilled', 'hr'],
    ['employee_gift_shipping.submitted', 'hr'],
    ['daily_report.imported', 'hr'],
    // CEO — its only two write paths.
    ['ceo_assistant.query', 'ceo'],
    ['ceo_assistant.feedback', 'ceo'],
    // The trail's own retention purge.
    ['audit.purged', 'admin'],
  ];
  for (const [action, surface] of cases) {
    assert.ok(isOnSurface(action, surface), `${action} should be filterable under ${surface}`);
  }
});

/* ── The generated description ───────────────────────────────────────────── */

test('describeAuditFamilies lists every family exactly once, under a dashboard', () => {
  const text = describeAuditFamilies();
  for (const fam of AUDIT_FAMILIES) {
    const needle = `• ${fam.exact ? fam.match : `${fam.match}*`} — ${fam.label}`;
    const occurrences = text.split(needle).length - 1;
    assert.equal(occurrences, 1, `${fam.match} appears ${occurrences}× in the generated text`);
  }
  // Every surface that owns a family heads a section.
  for (const surface of AUDIT_SURFACES) {
    const owns = AUDIT_FAMILIES.some((f) => f.surfaces[0] === surface.id);
    if (owns) {
      assert.ok(
        text.includes(surface.label.toUpperCase()),
        `no section for ${surface.label} in the generated family list`,
      );
    }
  }
  // Secondary dashboards are named inline rather than repeating the family.
  assert.match(text, /\[also on /);
});

/* ── Penny actually uses it ──────────────────────────────────────────────── */

/**
 * A source scan, not an import: `admin-tools.ts` starts with
 * `import 'server-only'` and pulls the Supabase clients behind it, so a plain
 * node test cannot load it (same constraint as console-phases.test.ts).
 */
test('search_audit_log builds its family list from the registry, not by hand', () => {
  const src = readFileSync(join(REPO, 'src', 'lib', 'anthropic', 'admin-tools.ts'), 'utf8');
  const start = src.indexOf("name: 'search_audit_log'");
  assert.notEqual(start, -1, 'search_audit_log not found — renamed?');
  const end = src.indexOf('input_schema', start);
  const description = src.slice(start, end);

  assert.ok(
    description.includes('describeAuditFamilies()'),
    'the tool description must be generated from the registry',
  );
  // The hand-written bullet list that drifted is gone for good.
  assert.ok(
    !description.includes('• accounting.payroll_wizard_notes.'),
    'a hardcoded family bullet is back in the description — it will drift again',
  );
  // The dashboard filter is offered and enumerated from the registry.
  const schema = src.slice(end, src.indexOf("name: 'run_diagnostics'", end));
  assert.ok(schema.includes('surface:'), 'search_audit_log lost its `surface` parameter');
  assert.ok(
    schema.includes('AUDIT_SURFACES.map'),
    'the surface parameter must enumerate AUDIT_SURFACES, not a hand-typed list',
  );
});
