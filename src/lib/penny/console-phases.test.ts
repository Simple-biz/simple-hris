import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONSOLE_BOOT_LINES,
  CONSOLE_IDLE_LINE,
  TOOL_PHASES,
  TOOL_PHASE_FALLBACK,
  phaseForTool,
} from "./console-phases";

/**
 * A source scan, not an import: both tool files begin with `import 'server-only'`
 * and pull the Supabase clients behind it, so they cannot be loaded in a plain
 * node test. The employee tool guards solved the same problem the same way.
 *
 * The failure this pins is small and ugly: the Admin console prints a phase line
 * per tool call, so a tool with no mapped phrase shows an admin a raw
 * `get_bank_change_history` mid-answer.
 */

const ROOT = join(process.cwd(), "src", "lib", "anthropic");

/** Pulls the `name:` values out of one exported tool array. */
function toolNamesFrom(file: string, exportName: string): string[] {
  const src = readFileSync(join(ROOT, file), "utf8");
  const start = src.indexOf(`export const ${exportName}`);
  assert.notEqual(start, -1, `${exportName} not found in ${file} — has it been renamed?`);
  // The array ends at the first line that is exactly `];`.
  const end = src.indexOf("\n];", start);
  assert.notEqual(end, -1, `could not find the end of ${exportName} in ${file}`);
  const block = src.slice(start, end);

  // Tool names are snake_case identifiers. This deliberately excludes the
  // diagnostic PROBES array's human labels ("Supabase Client / Postgres"),
  // which also use a `name:` key but live outside this block anyway.
  return [...block.matchAll(/name:\s*'([a-z][a-z0-9_]*)'/g)].map((m) => m[1]!);
}

const CEO = toolNamesFrom("ceo-tools.ts", "CEO_TOOLS");
const ADMIN = toolNamesFrom("admin-tools.ts", "ADMIN_TOOLS");
const ALL = [...CEO, ...ADMIN];

/* ── Negative control ────────────────────────────────────────────────────── */

/**
 * A scan that silently matched nothing would report full coverage of an empty
 * set — the exact failure mode that let a broken migration probe pass for
 * weeks. Refuse to draw any conclusion unless the scan actually found tools.
 */
test("the source scan found both tool sets", () => {
  assert.ok(CEO.length >= 10, `CEO_TOOLS scan found only ${CEO.length}`);
  assert.ok(ADMIN.length >= 10, `ADMIN_TOOLS scan found only ${ADMIN.length}`);
  assert.ok(CEO.includes("find_employee"));
  assert.ok(ADMIN.includes("search_audit_log"));
  // No human-readable probe label leaked into the scan.
  for (const n of ALL) assert.match(n, /^[a-z][a-z0-9_]*$/, `suspicious tool name: ${n}`);
});

/* ── Coverage ────────────────────────────────────────────────────────────── */

test("every tool Penny can call has a phase line", () => {
  const missing = ALL.filter((n) => !(n in TOOL_PHASES));
  assert.deepEqual(missing, [], `tools with no console phase: ${missing.join(", ")}`);
});

/**
 * Compared against the exact fallback OUTPUT, not its prefix: "Running the
 * diagnostic probes" is the right phrase for `run_diagnostics` and shares the
 * fallback's first word, so a prefix test would fail on correct copy.
 */
test("no phase line falls back to the raw tool name", () => {
  for (const n of ALL) {
    assert.notEqual(
      phaseForTool(n),
      `${TOOL_PHASE_FALLBACK}${n}`,
      `${n} would print the fallback`,
    );
  }
});

test("TOOL_PHASES carries no entry for a tool that no longer exists", () => {
  const stale = Object.keys(TOOL_PHASES).filter((n) => !ALL.includes(n));
  assert.deepEqual(stale, [], `phases for removed tools: ${stale.join(", ")}`);
});

/* ── Typesetting contract ────────────────────────────────────────────────── */

/**
 * The console appends the ellipsis to a RUNNING step and a full stop to nothing
 * at all, so the phrases must arrive bare. A phrase that shipped its own "…"
 * renders as "Searching the audit log……".
 */
test("phase lines carry no trailing punctuation", () => {
  for (const [tool, phrase] of Object.entries(TOOL_PHASES)) {
    assert.ok(!/[.…:;,]$/.test(phrase), `${tool} ends with punctuation: "${phrase}"`);
    assert.equal(phrase, phrase.trim(), `${tool} has stray whitespace`);
    assert.ok(phrase.length > 0, `${tool} has an empty phrase`);
  }
});

test("phase lines stay short enough for one console row", () => {
  for (const [tool, phrase] of Object.entries(TOOL_PHASES)) {
    assert.ok(phrase.length <= 52, `${tool} phrase is ${phrase.length} chars: "${phrase}"`);
  }
});

test("the fallback still names the tool, so an unmapped call is legible", () => {
  assert.equal(phaseForTool("some_new_tool"), "Running some_new_tool");
});

/* ── Boot banner ─────────────────────────────────────────────────────────── */

/**
 * Both boot lines are claims about this surface. If either stops being true —
 * Penny gains a write tool, or the route stops auditing — the banner is lying
 * to an admin, so they are asserted here rather than typed inline in the view.
 */
test("the boot banner states read-only and audited", () => {
  const banner = CONSOLE_BOOT_LINES.join(" | ").toLowerCase();
  assert.match(banner, /read-only/);
  assert.match(banner, /audit log/);
});

test("the admin route still writes an audit row for tool use", () => {
  const route = readFileSync(
    join(process.cwd(), "app", "api", "admin", "penny-chat", "route.ts"),
    "utf8",
  );
  assert.match(route, /insertAuditLog/);
  assert.match(route, /admin_assistant\.query/);
});

test("the idle line names what this Penny is for", () => {
  assert.ok(CONSOLE_IDLE_LINE.length > 20);
  assert.ok(!/[.…]$/.test(CONSOLE_IDLE_LINE));
});
