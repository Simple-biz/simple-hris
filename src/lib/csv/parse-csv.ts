import { parse } from "csv-parse/sync";

/**
 * RFC-style CSV parsing (quoted fields, empty fields, BOM) using csv-parse.
 * Matches Hubstaff / Simple.biz daily report exports where commas appear only inside quotes.
 */
export function parseCsv(text: string): string[][] {
  return parse(text, {
    bom: true,
    skip_empty_lines: true,
    trim: false,
    relax_column_count: false,
    cast: false,
  }) as string[][];
}
