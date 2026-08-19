import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  inlineToPlainText,
  parseBlocks,
  parseInline,
  type BlockNode,
  type InlineNode,
} from "./chat-markdown";

/**
 * One test per failure class enumerated in the hardening brief. A chat parser
 * breaks in predictable ways — half-streamed delimiters, data that contains the
 * delimiter, identifiers with underscores — and each of those is a wrong answer
 * shown to an employee, not a cosmetic slip.
 */

/** Node types in document order, for compact structural assertions. */
function shape(nodes: InlineNode[]): string {
  return nodes
    .map((n) =>
      n.type === "text" || n.type === "code"
        ? n.type
        : `${n.type}(${shape(n.children)})`,
    )
    .join("+");
}

const types = (blocks: BlockNode[]): string[] => blocks.map((b) => b.type);

/* ── The reported bug ────────────────────────────────────────────────────── */

test("BUG 2026-08-19: a `***` section break renders as a rule, not six asterisks", () => {
  const blocks = parseBlocks("Your pay was ₱12,000.\n\n***\n\nAnything else?");
  assert.deepEqual(types(blocks), ["paragraph", "rule", "paragraph"]);
  // The literal asterisks are gone from the rendered text entirely.
  const text = blocks
    .flatMap((b) => (b.type === "paragraph" ? b.lines.map(inlineToPlainText) : []))
    .join(" ");
  assert.equal(text.includes("*"), false);
});

test("`**bold**` becomes emphasis, never literal asterisks", () => {
  const nodes = parseInline("Your PAB is **₱5,000** this month");
  assert.equal(shape(nodes), "text+strong(text)+text");
  assert.equal(inlineToPlainText(nodes), "Your PAB is ₱5,000 this month");
});

test("`***both***` is bold-italic, not an empty italic inside bold", () => {
  // Longest-delimiter-first. Getting this wrong yields strong(em()) + stray text.
  assert.equal(shape(parseInline("***urgent***")), "strongEm(text)");
  assert.equal(inlineToPlainText(parseInline("***urgent***")), "urgent");
});

test("`---` and `___` are also rules (the model varies its separator)", () => {
  for (const sep of ["---", "___", "- - -", "*  *  *"]) {
    const blocks = parseBlocks(`before\n${sep}\nafter`);
    assert.deepEqual(types(blocks), ["paragraph", "rule", "paragraph"], `sep=${sep}`);
  }
});

test("a divider never opens a reply and never stacks", () => {
  // A hairline flush against the bubble's top edge reads as a broken render.
  assert.deepEqual(types(parseBlocks("***\nHello")), ["paragraph"]);
  assert.deepEqual(types(parseBlocks("a\n***\n***\n***\nb")), [
    "paragraph",
    "rule",
    "paragraph",
  ]);
  // Nor does it dangle at the end.
  assert.deepEqual(types(parseBlocks("a\n***")), ["paragraph"]);
});

/* ── CLASS 1: literal delimiters in real data ────────────────────────────── */

test("CLASS 1: a lone `*` in prose stays a lone `*`", () => {
  const nodes = parseInline("Rate * hours = pay");
  assert.equal(shape(nodes), "text");
  assert.equal(inlineToPlainText(nodes), "Rate * hours = pay");
});

test("CLASS 1: an unmatched `**` renders literally", () => {
  assert.equal(inlineToPlainText(parseInline("2 ** 3 is exponentiation")), "2 ** 3 is exponentiation");
  assert.equal(shape(parseInline("**not closed")), "text");
});

test("CLASS 1: two UNRELATED stray asterisks do not pair up across a sentence", () => {
  // Caught by server-rendering a real reply, 2026-08-19 — the tests above each
  // held one stray delimiter, so nothing ever had a partner to close against.
  // "Rate * hours = pay. 2 ** 3" italicised the ten words between them.
  // A delimiter followed by whitespace cannot open (CommonMark left-flanking).
  const line = "Rate * hours = pay. 2 ** 3 stays literal.";
  assert.equal(shape(parseInline(line)), "text");
  assert.equal(inlineToPlainText(parseInline(line)), line);

  // Same shape, more delimiters, still untouched.
  const bulletish = "a * b * c * d";
  assert.equal(inlineToPlainText(parseInline(bulletish)), bulletish);
});

test("CLASS 1: a delimiter followed by a space never opens emphasis", () => {
  for (const open of ["*", "**", "***", "_", "__", "~~"]) {
    const line = `x ${open} y ${open} z`;
    assert.equal(
      inlineToPlainText(parseInline(line)),
      line,
      `${open} followed by a space must stay literal`,
    );
  }
});

test("CLASS 1: emphasis never spans a blank line", () => {
  // Otherwise one stray `*` early in a long reply italicises everything after.
  const nodes = parseInline("*start\n\nlater* text");
  assert.equal(inlineToPlainText(nodes), "*start\n\nlater* text");
});

/* ── CLASS 4: mid-stream half-delimiters ─────────────────────────────────── */

test("CLASS 4: every prefix of a streaming reply keeps all its words", () => {
  // The renderer runs on every chunk. No prefix may drop characters — a word
  // that vanishes and reappears as bold is worse than plain text throughout.
  const full = "Your **PAB** is *₱5,000* and pays in ***week 4***.";
  for (let n = 1; n <= full.length; n++) {
    const prefix = full.slice(0, n);
    const rendered = inlineToPlainText(parseInline(prefix));
    const strip = (s: string) => s.replace(/[*_~`]/g, "");
    assert.equal(
      strip(rendered),
      strip(prefix),
      `prefix of length ${n} lost content: ${JSON.stringify(prefix)} → ${JSON.stringify(rendered)}`,
    );
  }
});

/* ── CLASS 5: bullet vs italic ───────────────────────────────────────────── */

test("CLASS 5: `* item` is a bullet; `*word*` is italic", () => {
  const blocks = parseBlocks("* first\n* second");
  assert.deepEqual(types(blocks), ["bullets"]);
  const bullets = blocks[0] as Extract<BlockNode, { type: "bullets" }>;
  assert.deepEqual(bullets.items.map(inlineToPlainText), ["first", "second"]);

  // Same character, inline, is emphasis.
  assert.equal(shape(parseInline("an *urgent* case")), "text+em(text)+text");
});

test("CLASS 5: `-`, `+` and `•` bullets all group into one list", () => {
  for (const mark of ["-", "+", "•"]) {
    const blocks = parseBlocks(`${mark} a\n${mark} b\n${mark} c`);
    assert.deepEqual(types(blocks), ["bullets"]);
    const list = blocks[0] as Extract<BlockNode, { type: "bullets" }>;
    assert.equal(list.items.length, 3, `mark=${mark}`);
  }
});

test("a numbered list keeps its starting number", () => {
  const blocks = parseBlocks("2. second\n3. third");
  const ol = blocks[0] as Extract<BlockNode, { type: "ordered" }>;
  assert.equal(ol.type, "ordered");
  assert.equal(ol.start, 2);
  assert.deepEqual(ol.items.map(inlineToPlainText), ["second", "third"]);
});

test("a date like `2026. ` at line start is not mistaken for a list", () => {
  // Four digits exceed the 1-3 digit ordered-marker bound, so prose survives.
  assert.deepEqual(types(parseBlocks("2026. was the year")), ["paragraph"]);
});

/* ── CLASS 7: intraword underscores ─────────────────────────────────────── */

test("CLASS 7: identifiers with underscores are NOT italicised", () => {
  for (const id of [
    "work_email",
    "source_file",
    "manila_day",
    "penny_employee_usage",
    "some_file_name.csv",
  ]) {
    const nodes = parseInline(`the ${id} column`);
    assert.equal(shape(nodes), "text", `${id} should stay plain text`);
    assert.equal(inlineToPlainText(nodes), `the ${id} column`);
  }
});

test("CLASS 7: `_italic_` at a word boundary still works", () => {
  assert.equal(shape(parseInline("this is _emphasis_ here")), "text+em(text)+text");
  assert.equal(shape(parseInline("this is __strong__ here")), "text+strong(text)+text");
});

/* ── Backticks are opaque ────────────────────────────────────────────────── */

test("no emphasis is parsed inside backticks", () => {
  const nodes = parseInline("call `get_my_pay` and `a*b`");
  assert.equal(shape(nodes), "text+code+text+code");
  assert.equal(inlineToPlainText(nodes), "call get_my_pay and a*b");
});

test("an unclosed backtick stays literal", () => {
  assert.equal(inlineToPlainText(parseInline("a ` b")), "a ` b");
});

/* ── Headings + paragraphs ───────────────────────────────────────────────── */

test("`## Heading` becomes a heading, not literal hashes", () => {
  const blocks = parseBlocks("## Your pay\nIt was ₱12,000.");
  assert.deepEqual(types(blocks), ["heading", "paragraph"]);
  const h = blocks[0] as Extract<BlockNode, { type: "heading" }>;
  assert.equal(inlineToPlainText(h.children), "Your pay");
});

test("a `#` with no space is a hashtag, not a heading", () => {
  assert.deepEqual(types(parseBlocks("#1 priority")), ["paragraph"]);
});

test("consecutive lines stay one paragraph; a blank line splits", () => {
  const one = parseBlocks("line a\nline b");
  assert.deepEqual(types(one), ["paragraph"]);
  assert.equal((one[0] as Extract<BlockNode, { type: "paragraph" }>).lines.length, 2);
  assert.deepEqual(types(parseBlocks("line a\n\nline b")), ["paragraph", "paragraph"]);
});

/* ── CLASS 6: no HTML path ───────────────────────────────────────────────── */

test("CLASS 6: neither the parser nor the renderer can emit HTML", () => {
  // The parser returns data, the renderer maps it to React elements. If
  // dangerouslySetInnerHTML ever appears on this path, a reply containing markup
  // becomes executable — and replies quote employee-supplied text back.
  for (const rel of [
    "src/lib/penny/chat-markdown.ts",
    "src/components/ceo/ceo-chat-message.tsx",
  ]) {
    const src = readFileSync(join(process.cwd(), rel), "utf8");
    assert.equal(
      src.includes("dangerouslySetInnerHTML"),
      false,
      `${rel} must never use dangerouslySetInnerHTML`,
    );
  }
});

test("CLASS 3: the Markdown pass runs ONLY on plain-text segments", () => {
  // The ```biz-report fence and pipe tables are consumed upstream in
  // parseSegments; the Markdown pass must never see their contents, or a JSON
  // string like "Payroll **August**" gets reformatted inside a downloadable
  // report and a `-` table cell parses as a bullet. Structural guarantee: the
  // block parser is invoked at exactly one call site — the text branch.
  const src = readFileSync(
    join(process.cwd(), "src/components/ceo/ceo-chat-message.tsx"),
    "utf8",
  );
  const blockCalls = src.match(/parseBlocks\(/g) ?? [];
  assert.equal(
    blockCalls.length,
    1,
    "parseBlocks must be called exactly once (inside the seg.type === 'text' branch)",
  );
  // Table cells get the INLINE pass only — header, body, and nothing else.
  const inlineCalls = src.match(/parseInline\(/g) ?? [];
  assert.equal(
    inlineCalls.length,
    2,
    "parseInline belongs on table headers and cells only — not on report JSON",
  );
});

test("CLASS 2: a `-` cell in a table is not a bullet (inline pass only)", () => {
  // Guards the reason CLASS 3's call-site count matters: run the BLOCK parser on
  // a cell whose value is "-" (Penny's empty-value marker) and it becomes a list.
  const asBlock = parseBlocks("- ");
  assert.notDeepEqual(types(asBlock), ["paragraph"], "block parser does treat '- ' as a list");
  // Inline is the correct pass for a cell: the dash survives as text.
  assert.equal(inlineToPlainText(parseInline("-")), "-");
  assert.equal(inlineToPlainText(parseInline("- 40.0")), "- 40.0");
});

test("CLASS 6: markup in a reply stays text", () => {
  const nodes = parseInline('<img src=x onerror="alert(1)"> and <b>bold</b>');
  assert.equal(shape(nodes), "text");
  assert.equal(
    inlineToPlainText(nodes),
    '<img src=x onerror="alert(1)"> and <b>bold</b>',
  );
});

/* ── Real Penny answers ──────────────────────────────────────────────────── */

test("a realistic Haiku reply parses into the intended structure", () => {
  const reply = [
    "## Your Attendance Bonus",
    "",
    "The **PAB** is ₱5,000 and covers *August 3 – September 4*.",
    "",
    "To earn it you need:",
    "- 7+ hours on all five workdays",
    "- no missed workdays in the window",
    "",
    "***",
    "",
    "Check the PAB calendar on your Overview for your day-by-day status.",
  ].join("\n");

  assert.deepEqual(types(parseBlocks(reply)), [
    "heading",
    "paragraph",
    "paragraph",
    "bullets",
    "rule",
    "paragraph",
  ]);
  // And not one asterisk survives into the rendered text.
  const plain = parseBlocks(reply)
    .flatMap((b) =>
      b.type === "paragraph"
        ? b.lines.map(inlineToPlainText)
        : b.type === "bullets"
          ? b.items.map(inlineToPlainText)
          : b.type === "heading"
            ? [inlineToPlainText(b.children)]
            : [],
    )
    .join("\n");
  assert.equal(plain.includes("*"), false);
  assert.equal(plain.includes("#"), false);
});

test("an empty or whitespace-only reply yields no blocks", () => {
  assert.deepEqual(parseBlocks(""), []);
  assert.deepEqual(parseBlocks("\n\n   \n"), []);
});
