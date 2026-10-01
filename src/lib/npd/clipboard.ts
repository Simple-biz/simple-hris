/**
 * Spreadsheet clipboard text ⇄ a grid of strings.
 *
 * Google Sheets (and Excel) put a copied block on the clipboard as `text/plain`
 * TSV: cells split by TAB, rows by newline. A cell holding a tab, a newline or a
 * double quote is wrapped in double quotes, with its own quotes doubled. NPD's
 * notes columns hold multi-line cells, so a naive `split('\n')` would cut one
 * person's row in two and shift every later row's figures onto the wrong person.
 *
 * Rules, all pinned in clipboard.test.ts:
 *  - A field is QUOTED only when it starts with `"` AND a closing quote is
 *    followed by a tab, a line break or the end of the text. Anything else that
 *    starts with `"` (say `"5 hours` with no closing quote) is a literal cell.
 *  - `\r\n`, `\n` and a lone `\r` all end a row.
 *  - ONE trailing line break is dropped (Excel ends a copy with one); a blank
 *    line in the middle is a real blank row and stays.
 *  - Rows keep their own width; padding is the caller's decision.
 */

/** Parse clipboard text into rows of cells. Empty text → no rows. */
export function parseClipboardGrid(text: string): string[][] {
  let src = text;
  if (src.endsWith('\r\n')) src = src.slice(0, -2);
  else if (src.endsWith('\n') || src.endsWith('\r')) src = src.slice(0, -1);
  if (src === '') return [];

  const rows: string[][] = [];
  let row: string[] = [];
  const n = src.length;
  let i = 0;
  // One field per pass: read it, then consume the tab or line break after it.
  for (;;) {
    const quoted = src[i] === '"' ? readQuoted(src, i) : null;
    let end: number;
    if (quoted) {
      row.push(quoted.value);
      end = quoted.next;
    } else {
      end = i;
      while (end < n && src[end] !== '\t' && src[end] !== '\n' && src[end] !== '\r') end += 1;
      row.push(src.slice(i, end));
    }
    if (end >= n) {
      rows.push(row);
      return rows;
    }
    if (src[end] === '\t') {
      i = end + 1;
      continue;
    }
    rows.push(row);
    row = [];
    i = end + (src[end] === '\r' && src[end + 1] === '\n' ? 2 : 1);
  }
}

/**
 * A quoted field starting at `start` (which holds `"`), or null when the quote
 * never closes in a position that ends a field — then the cell is literal.
 */
function readQuoted(text: string, start: number): { value: string; next: number } | null {
  let out = '';
  let i = start + 1;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === '"') {
      if (text[i + 1] === '"') {
        out += '"';
        i += 2;
        continue;
      }
      const after = text[i + 1];
      if (after === undefined || after === '\t' || after === '\n' || after === '\r') {
        return { value: out, next: i + 1 };
      }
      return null;
    }
    out += ch;
    i += 1;
  }
  return null;
}

/** Cells → clipboard TSV that Google Sheets and Excel read back cell for cell. */
export function serializeClipboardGrid(rows: readonly (readonly string[])[]): string {
  return rows.map((r) => r.map(quoteCell).join('\t')).join('\n');
}

function quoteCell(cell: string): string {
  if (/[\t\n\r"]/.test(cell)) return `"${cell.replace(/"/g, '""')}"`;
  return cell;
}
