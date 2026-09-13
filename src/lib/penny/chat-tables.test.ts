import test from "node:test";
import assert from "node:assert/strict";
import { WRAP_THRESHOLD, buildTable, isFigure, isSeparator, splitRow } from "./chat-tables";

/**
 * Penny writes these tables, and the failures below are all things the model
 * really does — not hypotheticals. The worst of them (a dropped cell) was
 * silent, which is why it gets the first class.
 */

/* ── CLASS 1: no cell is ever dropped ────────────────────────────────────── */

test("CLASS 1: a row with MORE cells than the header keeps them all", () => {
  // The renderer used to iterate the HEADER array, so an unescaped `|` inside a
  // note took the rest of that row with it — out of an audit table, silently.
  const t = buildTable(
    "| Who | Note |",
    "|---|---|",
    ["| jane@simple.biz | rate a|b changed | extra |"],
  );
  assert.equal(t.headers.length, 4, "grid widened to the longest row");
  assert.equal(t.rows[0]!.length, 4);
  assert.deepEqual(t.rows[0], ["jane@simple.biz", "rate a", "b changed", "extra"]);
  // The header is padded, never truncated, so the columns still line up.
  assert.deepEqual(t.headers, ["Who", "Note", "", ""]);
  assert.equal(t.columns.length, 4);
});

test("CLASS 1: a row with FEWER cells is padded, not ragged", () => {
  const t = buildTable("| A | B | C |", "|---|---|---|", ["| 1 |", "| 1 | 2 | 3 |"]);
  assert.equal(t.rows[0]!.length, 3);
  assert.deepEqual(t.rows[0], ["1", "", ""]);
  assert.deepEqual(t.rows[1], ["1", "2", "3"]);
});

/* ── CLASS 2: alignment ──────────────────────────────────────────────────── */

test("CLASS 2: a column of figures is right-aligned even without the colon", () => {
  // The model forgets `|---:|` constantly, and a column of pesos flush-left is
  // the single most common complaint about these tables.
  const t = buildTable(
    "| Week | Amount |",
    "|---|---|",
    ["| 2026-09-07 | 12,480.00 |", "| 2026-08-31 | 9,300.50 |"],
  );
  assert.equal(t.columns[1]!.align, "right");
  assert.equal(t.columns[1]!.alignSource, "inferred");
  assert.equal(t.columns[1]!.numeric, true);
  // A date column is NOT a quantity — it stays left.
  assert.equal(t.columns[0]!.align, "left");
  assert.equal(t.columns[0]!.numeric, false);
});

test("CLASS 2: a DECLARED alignment always beats the inference", () => {
  const t = buildTable("| Amount |", "|:---|", ["| 1,200.00 |"]);
  assert.equal(t.columns[0]!.numeric, true, "still recognised as figures");
  assert.equal(t.columns[0]!.align, "left", "but the separator row was explicit");
  assert.equal(t.columns[0]!.alignSource, "declared");

  const centered = buildTable("| N |", "|:---:|", ["| 4 |"]);
  assert.equal(centered.columns[0]!.align, "center");
});

test("CLASS 2: one empty marker does not disqualify a numeric column", () => {
  // "-" is Penny's own empty-value marker. Treating it as non-numeric would
  // flip a whole column of pesos back to the left the moment one week is blank.
  const t = buildTable(
    "| Amount |",
    "|---|",
    ["| 1,200.00 |", "| - |", "| 900.00 |", "| n/a |"],
  );
  assert.equal(t.columns[0]!.numeric, true);
  assert.equal(t.columns[0]!.align, "right");
});

test("CLASS 2: a column with no real values is not numeric", () => {
  const t = buildTable("| Amount |", "|---|", ["| - |", "| |"]);
  assert.equal(t.columns[0]!.numeric, false);
  assert.equal(t.columns[0]!.align, "left");
});

/* ── CLASS 3: what counts as a figure ────────────────────────────────────── */

test("CLASS 3: money, counts, percentages and accounting negatives are figures", () => {
  for (const v of ["1,234.00", "₱12,480.50", "$980", "42", "-17", "+3", "98.6%", "(1,234.00)"]) {
    assert.equal(isFigure(v), true, `${v} should read as a figure`);
  }
});

test("CLASS 3: dates, emails, ids and prose are not figures", () => {
  for (const v of [
    "2026-09-12",
    "2026-09-12T04:00:00Z",
    "jane@simple.biz",
    "bank_update.saved",
    "Lead Gen",
    "-",
    "",
  ]) {
    assert.equal(isFigure(v), false, `${v} must not read as a figure`);
  }
});

/* ── CLASS 4: wrapping ───────────────────────────────────────────────────── */

test("CLASS 4: only long text columns may wrap", () => {
  const longNote = "x".repeat(WRAP_THRESHOLD + 5);
  const t = buildTable(
    "| Amount | Note |",
    "|---|---|",
    [`| 1,200.00 | ${longNote} |`],
  );
  assert.equal(t.columns[0]!.wrap, false, "short numeric column stays on one line");
  assert.equal(t.columns[1]!.wrap, true, "long prose column is allowed to break");
});

test("CLASS 4: a numeric column NEVER wraps, however long", () => {
  // Breaking a figure across two lines is worse than the sideways scroll it
  // saves — the digits stop being readable as one number.
  const t = buildTable("| Amount |", "|---|", [`| ${"1".repeat(WRAP_THRESHOLD + 20)} |`]);
  assert.equal(t.columns[0]!.numeric, true);
  assert.equal(t.columns[0]!.wrap, false);
});

test("CLASS 4: a long HEADER over short values still wraps", () => {
  const t = buildTable(
    `| ${"Header words ".repeat(4)} |`,
    "|---|",
    ["| ok |"],
  );
  assert.equal(t.columns[0]!.wrap, true);
});

/* ── CLASS 5: the row/separator grammar is unchanged ─────────────────────── */

test("CLASS 5: separator detection still accepts every real shape", () => {
  for (const s of ["|---|---|", "| --- | --- |", "|:--|--:|", "|:-:|", "---|---"]) {
    assert.equal(isSeparator(s), true, `${s} should be a separator`);
  }
  for (const s of ["| Who | Note |", "| jane | - |", "plain text", ""]) {
    assert.equal(isSeparator(s), false, `${s} must not be a separator`);
  }
});

test("CLASS 5: splitRow tolerates missing outer pipes and trims", () => {
  assert.deepEqual(splitRow("| a | b |"), ["a", "b"]);
  assert.deepEqual(splitRow("a | b"), ["a", "b"]);
  assert.deepEqual(splitRow("|  a  |b|"), ["a", "b"]);
});

/* ── Negative control ────────────────────────────────────────────────────── */

test("a table with no body rows still yields a usable grid", () => {
  // Half-streamed tables hit this on every keystroke of the first data row.
  const t = buildTable("| Who | Amount |", "|---|---:|", []);
  assert.deepEqual(t.headers, ["Who", "Amount"]);
  assert.equal(t.rows.length, 0);
  assert.equal(t.columns.length, 2);
  assert.equal(t.columns[1]!.align, "right", "declared alignment survives an empty body");
  assert.equal(t.columns[1]!.numeric, false, "no data means nothing to infer from");
});
