/**
 * Guard: a raw department cell must never reach a human.
 *
 * `hsl-subdepartments.md:32` — *"Displayed anywhere a human reads it →
 * **HSL — Intake Specialist** (em-dash, never `HSL:`)"*. The master `Department`
 * cell holds `hsl:filing_specialist`, and after the parent cutover **every**
 * HSL person carries a sub-labeled cell — so any surface that renders
 * `row.department` straight shows a storage key to an accountant, a manager, or
 * the employee themself. Kane, 2026-08-24: *"All Dashboards and Instances —
 * `hsl:filing_specialist` — I shouldn't see something like this."*
 *
 * Two halves:
 *   1. the formatter itself does what the doc says, for BOTH sub-team keyspaces
 *      and for a sub-key this build doesn't recognise;
 *   2. a source scan proving no component renders a department VALUE as a JSX
 *      child without it. The scan is deliberately narrow — keys, URLs, counts
 *      and search haystacks keep the raw string on purpose — and every
 *      remaining exception is named below with its reason.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { formatDeptLabel } from './hsl-subdept';
import { humanizeDeptKey, catalogDeptName } from './dept-identity';

test('formatDeptLabel is the em-dash display form, never the raw slug', () => {
  assert.equal(formatDeptLabel('hsl:filing_specialist'), 'HSL — Filing Specialist');
  assert.equal(formatDeptLabel('hsl:simple_texting'), 'HSL — Simple Texting');
  // Unknown sub-key: still never the bare `hsl:` slug.
  assert.ok(!formatDeptLabel('hsl:not_a_team').includes('hsl:'));
  // Non-HSL labels pass through untouched — this helper is safe to wrap anything in.
  assert.equal(formatDeptLabel('Lead Gen'), 'Lead Gen');
  assert.equal(formatDeptLabel(null), '');
});

test('the generic slug humanizer no longer mangles namespaced HSL keys', () => {
  // Was "Hsl:filing Specialist" — the exact defect hsl-subdepartments.md:186 warns about.
  assert.equal(humanizeDeptKey('hsl:filing_specialist'), 'HSL — Filing Specialist');
  assert.equal(catalogDeptName('hsl:intake_specialist'), 'HSL — Intake Specialist');
  // Custom Payment Catalog slugs keep the old behaviour.
  assert.equal(humanizeDeptKey('executive_assistants'), 'Executive Assistants');
});

// ── source scan ─────────────────────────────────────────────────────────────

const COMPONENTS = path.resolve(process.cwd(), 'src/components');

/** Helpers that produce a human label. A line calling one is compliant. */
const FORMATTERS = [
  'formatDeptLabel',
  'collapseHslFamilyLabel',
  'hslSubTeamName',
  'catalogDeptName',
  'humanizeDeptKey',
  'stripHslPrefix',
  'deptName(',
  'dep(',
];

/** A member access (or bare identifier) that holds a raw department label. */
const DEPT_VALUE =
  /(?<![A-Za-z0-9_])(?:[A-Za-z_][A-Za-z0-9_]*\??\.)*(department|dept|from_department|to_department|invite_department)(?![A-Za-z0-9_(])/;

/**
 * Not a label: identity keys, query strings, counts, colours, canonical names
 * already resolved server-side, and the raw values a filter compares against.
 */
const NOT_A_LABEL =
  /(\.length|\.size|\.count|Count\b|\.color|\.cadence|\.name\b|\.submittedAt|\.submittedVia|department_name|departmentKey|department_key|deptKey|\bkey=|`app:|::|\|\$\{|api\/|encodeURIComponent|deptFilter|filterDepartment|departmentFilter|activeDept|selectedDept|deptSearch|deptGroups|deptRows|deptStats|deptOptions|deptTotals|\bdeptLabel\b)/;

/** `department${…}` is the plural suffix of a sentence ("3 departments"), never
 *  a value; `department: string` is an inline TYPE literal, not JSX at all. */
const PROSE_OR_TYPE = /departments?\$\{|:\s*(string|number|boolean|null)\b/;

/**
 * JSX children that render something department-ish but are NOT a raw cell.
 * Keyed by the exact source snippet so the entry survives line drift, and each
 * one has to earn its place.
 */
const ALLOWED_SNIPPETS: ReadonlyArray<{ snippet: string; why: string }> = [
  {
    snippet: "{hov ? hov.dept.slice(0, 13) : 'employees'}",
    why: 'Overview donut hover — the slice label is already formatted upstream (Overview.tsx:3901).',
  },
  {
    snippet: "{initialCalcDeptSafe !== 'all' && ' in the selected department'}",
    why: 'Prose, not a value.',
  },
  {
    snippet: "{dept.trim().length === 0 ? 'Pick a department first.' : 'Pick a project first.'}",
    why: 'Prose, not a value.',
  },
  {
    snippet: "{query && !dept ? 'Clear search' : 'Clear filters'}",
    why: 'Prose, not a value.',
  },
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (entry.name.endsWith('.tsx')) out.push(p);
  }
  return out;
}

test('no component renders a raw department cell to a human', () => {
  const offenders: string[] = [];

  for (const file of walk(COMPONENTS)) {
    const rel = path.relative(process.cwd(), file).replace(/\\/g, '/');
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);

    lines.forEach((line, i) => {
      const s = line.trim();
      // JSX child expression occupying the whole line: `{...}`.
      if (!s.startsWith('{') || !s.endsWith('}')) return;
      if (s.startsWith('{/*') || s.startsWith("{'") || s.startsWith('{"')) return;
      if (!DEPT_VALUE.test(s)) return;
      if (NOT_A_LABEL.test(s) || PROSE_OR_TYPE.test(s)) return;
      if (FORMATTERS.some((f) => s.includes(f))) return;
      if (ALLOWED_SNIPPETS.some((a) => s === a.snippet)) return;
      offenders.push(`${rel}:${i + 1}  ${s}`);
    });
  }

  assert.deepEqual(
    offenders,
    [],
    `Raw department value(s) rendered to a human. Wrap in formatDeptLabel(...) — ` +
      `hsl-subdepartments.md:32. If the value is genuinely not a label (a key, a URL, ` +
      `a count), widen NOT_A_LABEL or add it to ALLOWED_SNIPPETS with a reason.\n` +
      offenders.join('\n'),
  );
});
