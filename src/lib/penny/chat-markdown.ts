/**
 * The small Markdown subset Penny's chat bubble renders.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * The original design instructed the model to emit plain text and rendered
 * everything verbatim, with pipe tables as the single exception. That bet holds
 * for Sonnet and loses for Haiku: the employee assistant emitted `**bold**` and
 * `***` separators anyway, and employees saw raw asterisks (Kane, 2026-08-19:
 * *"remove the *** it's a lot and looks ugly AF"*).
 *
 * A prompt that says "don't use Markdown" is the loosest possible guarantee —
 * it is a request to a text generator whose strongest habit is Markdown. So the
 * renderer learns the subset instead. This module is the parser half: pure,
 * React-free, and tested against the ways a chat parser actually breaks.
 *
 * ── What it deliberately does NOT do ─────────────────────────────────────────
 * No HTML is produced or accepted anywhere. This module returns DATA; the
 * consumer maps it onto React elements, so markup in a reply stays text — and a
 * guard test in chat-markdown.test.ts scans both files for React's raw-HTML
 * escape hatch by name, which is why neither mentions it even in a comment.
 * Links, images, nested lists and block quotes are out of scope: a chat bubble
 * 380px wide does not need them, and every construct added here is one more
 * thing that can mis-fire on a half-streamed token.
 *
 * Pipe tables and the ```biz-report fence are NOT handled here. They are parsed
 * upstream in `ceo-chat-message.tsx` and must stay that way — this module only
 * ever sees the text between them, so JSON inside a fence is never formatted.
 */

/* ── Inline ───────────────────────────────────────────────────────────────── */

export type InlineNode =
  | { type: 'text'; text: string }
  | { type: 'strong'; children: InlineNode[] }
  | { type: 'em'; children: InlineNode[] }
  | { type: 'strongEm'; children: InlineNode[] }
  | { type: 'strike'; children: InlineNode[] }
  | { type: 'code'; text: string };

/**
 * Delimiters, longest-first — `***` must be tried before `**`, and `**` before
 * `*`, or `***bold italic***` parses as an empty italic wrapped in bold.
 */
const INLINE_RULES: { open: string; type: InlineNode['type']; intraword: boolean }[] = [
  { open: '***', type: 'strongEm', intraword: true },
  { open: '**', type: 'strong', intraword: true },
  { open: '~~', type: 'strike', intraword: true },
  { open: '*', type: 'em', intraword: true },
  // Underscores are NOT allowed intraword. `work_email`, `source_file` and
  // `manila_day` are everyday values in this system; GitHub's own rule exists
  // because `some_file_name` italicising its middle is the classic failure.
  { open: '__', type: 'strong', intraword: false },
  { open: '_', type: 'em', intraword: false },
];

const WORD_CHAR = /[\p{L}\p{N}]/u;

function isWordChar(ch: string | undefined): boolean {
  return !!ch && WORD_CHAR.test(ch);
}

/**
 * Parse inline emphasis. Anything that does not form a complete, non-empty pair
 * is emitted as literal text — which is what keeps a mid-stream reply ending in
 * `…**` from swallowing the words after it, and keeps a genuine asterisk in the
 * data visible.
 */
export function parseInline(input: string): InlineNode[] {
  const out: InlineNode[] = [];
  let buf = '';
  let i = 0;

  const pushText = () => {
    if (buf) {
      out.push({ type: 'text', text: buf });
      buf = '';
    }
  };

  while (i < input.length) {
    const ch = input[i]!;

    // `code` — opaque: no emphasis is parsed inside, so a peso amount or a
    // filename in backticks survives verbatim.
    if (ch === '`') {
      const end = input.indexOf('`', i + 1);
      if (end > i + 1) {
        pushText();
        out.push({ type: 'code', text: input.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
      buf += ch;
      i += 1;
      continue;
    }

    if (ch === '*' || ch === '_' || ch === '~') {
      const rule = INLINE_RULES.find((r) => input.startsWith(r.open, i));
      if (rule) {
        const before = input[i - 1];
        const after = input[i + rule.open.length];
        // CommonMark's left-flanking rule: a delimiter followed by whitespace (or
        // by nothing) cannot OPEN emphasis. Without this, two unrelated stray
        // asterisks pair up across a whole sentence — "Rate * hours = pay. 2 ** 3"
        // italicised everything between them (found by rendering a real reply,
        // 2026-08-19). The right-flanking half lives in findClosing.
        const opensOk = after != null && !/\s/.test(after);
        // An underscore additionally has to sit at a word boundary.
        const boundaryOk =
          opensOk && (rule.intraword || (!isWordChar(before) && isWordChar(after)));
        const closeAt = boundaryOk ? findClosing(input, i + rule.open.length, rule) : -1;
        if (closeAt > i + rule.open.length) {
          const inner = input.slice(i + rule.open.length, closeAt);
          pushText();
          out.push({ type: rule.type, children: parseInline(inner) } as InlineNode);
          i = closeAt + rule.open.length;
          continue;
        }
      }
      // Unmatched delimiter → literal. Streaming safety and data safety are the
      // same guarantee here.
      buf += ch;
      i += 1;
      continue;
    }

    buf += ch;
    i += 1;
  }

  pushText();
  return out;
}

/** Index of the closing delimiter, or -1. Never matches across a blank line. */
function findClosing(
  input: string,
  from: number,
  rule: { open: string; intraword: boolean },
): number {
  for (let j = from; j <= input.length - rule.open.length; j++) {
    if (input.startsWith('\n\n', j)) return -1; // emphasis never spans a paragraph
    if (!input.startsWith(rule.open, j)) continue;
    // Right-flanking: a delimiter preceded by whitespace is not a closer, so a
    // lone multiplication sign in "× * hours" cannot terminate a span.
    if (/\s/.test(input[j - 1] ?? ' ')) continue;
    if (!rule.intraword && isWordChar(input[j + rule.open.length])) continue;
    return j;
  }
  return -1;
}

/* ── Blocks ───────────────────────────────────────────────────────────────── */

export type BlockNode =
  | { type: 'paragraph'; lines: InlineNode[][] }
  | { type: 'heading'; children: InlineNode[] }
  | { type: 'bullets'; items: InlineNode[][] }
  | { type: 'ordered'; items: InlineNode[][]; start: number }
  | { type: 'rule' };

/** `***`, `---`, `___` alone on a line — Markdown's thematic break. */
const RULE_LINE = /^\s*(?:\*\s*){3,}$|^\s*(?:-\s*){3,}$|^\s*(?:_\s*){3,}$/;
/** `#`…`######` heading. The prompts discourage these; render them anyway. */
const HEADING_LINE = /^\s{0,3}#{1,6}\s+(.*)$/;
/** `- item`, `* item`, `+ item`, `• item`. */
const BULLET_LINE = /^\s{0,3}[-*+•]\s+(.*)$/;
/** `1. item`, `2) item`. */
const ORDERED_LINE = /^\s{0,3}(\d{1,3})[.)]\s+(.*)$/;

/**
 * Parse one plain-text segment into blocks.
 *
 * A `***` line becomes a `rule` node rather than three literal asterisks, which
 * is the specific ugliness this was written to remove: the model was using it as
 * a section break, so it renders as one hairline instead of six characters of
 * punctuation.
 */
export function parseBlocks(input: string): BlockNode[] {
  const lines = input.split('\n');
  const blocks: BlockNode[] = [];
  let para: InlineNode[][] = [];

  const flushPara = () => {
    if (para.length) {
      blocks.push({ type: 'paragraph', lines: para });
      para = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    if (line.trim() === '') {
      flushPara();
      continue;
    }

    if (RULE_LINE.test(line)) {
      flushPara();
      // Never open or close a reply with a divider, and never stack two — a
      // hairline against the bubble's edge reads as a rendering fault.
      if (blocks.length > 0 && blocks[blocks.length - 1]!.type !== 'rule') {
        blocks.push({ type: 'rule' });
      }
      continue;
    }

    const heading = HEADING_LINE.exec(line);
    if (heading) {
      flushPara();
      blocks.push({ type: 'heading', children: parseInline(heading[1]!.trim()) });
      continue;
    }

    const bullet = BULLET_LINE.exec(line);
    if (bullet) {
      flushPara();
      const items: InlineNode[][] = [parseInline(bullet[1]!.trim())];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const m = BULLET_LINE.exec(lines[j]!);
        if (!m) break;
        items.push(parseInline(m[1]!.trim()));
      }
      blocks.push({ type: 'bullets', items });
      i = j - 1;
      continue;
    }

    const ordered = ORDERED_LINE.exec(line);
    if (ordered) {
      flushPara();
      const items: InlineNode[][] = [parseInline(ordered[2]!.trim())];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const m = ORDERED_LINE.exec(lines[j]!);
        if (!m) break;
        items.push(parseInline(m[2]!.trim()));
      }
      blocks.push({ type: 'ordered', items, start: Number(ordered[1]) || 1 });
      i = j - 1;
      continue;
    }

    para.push(parseInline(line));
  }

  flushPara();
  // A segment that was nothing but dividers contributes nothing.
  return blocks.filter((b, idx) => !(b.type === 'rule' && idx === blocks.length - 1));
}

/** Flatten to plain text — used by tests and by anything needing a bare string. */
export function inlineToPlainText(nodes: InlineNode[]): string {
  return nodes
    .map((n) =>
      n.type === 'text' || n.type === 'code' ? n.text : inlineToPlainText(n.children),
    )
    .join('');
}
