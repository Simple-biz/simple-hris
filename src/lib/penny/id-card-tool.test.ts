import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ATTACHMENT_SOURCE_IDS } from "./attachment-refs";

/**
 * Admin Penny's ID card, wired end to end. A source scan, not an import: the tool
 * file and both routes sit behind `server-only` and the Supabase clients.
 *
 * The failure this pins (Kane, 2026-10-02): asked "show me my ID card", Penny ran
 * list_employee_attachments, which returned every FILE on record — a profile photo
 * and a time-adjustment screenshot of the Penny mascot — and the console put both
 * in front of him as the answer. The ID card is not a file; it is drawn from the
 * roster. Each test below is one way that could quietly become true again.
 */

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8");
const TOOLS = read("src", "lib", "anthropic", "admin-tools.ts");
const CHAT_ROUTE = read("app", "api", "admin", "penny-chat", "route.ts");
const OPEN_ROUTE = read("app", "api", "admin", "penny-chat", "attachment", "route.ts");

/** The object literal that declares one tool, from `name:` to its schema's end. */
function toolBlock(name: string): string {
  const start = TOOLS.indexOf(`name: '${name}'`);
  assert.notEqual(start, -1, `${name} is not declared in ADMIN_TOOLS`);
  const end = TOOLS.indexOf("required: ['work_email']", start);
  assert.notEqual(end, -1, `could not find the end of ${name}'s schema`);
  return TOOLS.slice(start, end);
}

test("get_employee_id_card is declared AND dispatched", () => {
  toolBlock("get_employee_id_card");
  // Schema and dispatch live in one file but two places; a mismatch returns
  // "Unknown tool" and the admin gets no badge and no reason.
  assert.match(TOOLS, /case 'get_employee_id_card':\s*\n\s*return await getEmployeeIdCard\(input\);/);
});

test("ID questions route to the badge, not to the file list", () => {
  const list = toolBlock("list_employee_attachments");
  assert.doesNotMatch(list, /show me X's ID/, "the file list must not offer itself for ID questions");
  assert.match(list, /get_employee_id_card/, "the file list must point ID questions at the badge tool");
  assert.match(toolBlock("get_employee_id_card"), /show me X's ID/);
  // The system prompt says the same, in the place the model reads first.
  assert.match(CHAT_ROUTE, /"Show me X\\'s ID \/ ID card \/ badge" → get_employee_id_card/);
});

test("the file list's source enum offers files only — never the drawn ID card", () => {
  const list = toolBlock("list_employee_attachments");
  assert.match(list, /enum: \['all', \.\.\.FILE_SOURCE_IDS\]/);
  assert.doesNotMatch(list, /\.\.\.ATTACHMENT_SOURCE_IDS/);
});

test("the badge tool says plainly that it is not a government ID", () => {
  assert.match(toolBlock("get_employee_id_card"), /no photograph of a government-issued ID/);
});

test("both opener-dependent tools are withheld from the CEO route", () => {
  // The opener is admin-gated and the CEO widget renders no attachment frames,
  // so a CEO-only holder would be told about an image they cannot open.
  const start = TOOLS.indexOf("export const CEO_WITHHELD_ADMIN_TOOLS");
  assert.notEqual(start, -1);
  const decl = TOOLS.slice(start, TOOLS.indexOf("]);", start));
  assert.match(decl, /'list_employee_attachments'/);
  assert.match(decl, /'get_employee_id_card'/);
});

test("the open endpoint resolves every attachment source by name", () => {
  // Adding a source means a row in ATTACHMENT_SOURCES AND a branch here; a source
  // with no branch falls out of the switch and the chip opens nothing.
  assert.ok(ATTACHMENT_SOURCE_IDS.includes("id_card"));
  for (const s of ATTACHMENT_SOURCE_IDS) {
    assert.ok(
      OPEN_ROUTE.includes(`case '${s}':`) || OPEN_ROUTE.includes(`ref.source === '${s}'`),
      `open endpoint has no branch for "${s}"`,
    );
  }
});

test("the ID card is re-resolved from the roster at open time, not trusted from the ref", () => {
  assert.match(OPEN_ROUTE, /resolveIdCardForEmail\(ref\.id\)/);
  // A failed read must be an error, never a badge drawn from half the data.
  assert.match(OPEN_ROUTE, /resolved\.reason === 'read_failed'/);
});
