/**
 * The label a person row gets when picked from the roster. The sheet calls everyone by the name
 * the team uses ("April", "Lenny"), and the Global Master List keeps that as the quoted nickname
 * in `Name` ("Tesalona, Maria Linda "Lenny"").
 * Pure.
 */

const QUOTED = /["“”]([^"“”]+)["“”]/;

/**
 * - a quoted nickname wins: `Galang, April Pearl "April"` → `April`
 * - else "Last, First …": `Weissman, Justin` → `Justin W.`
 * - else the name as written, squeezed
 */
export function shortNameFromRoster(name: string): string {
  const clean = (name ?? '').replace(/\s+/g, ' ').trim();
  const quoted = QUOTED.exec(clean)?.[1]?.trim();
  if (quoted) return quoted.slice(0, 80);
  const comma = clean.indexOf(',');
  if (comma > 0) {
    const last = clean.slice(0, comma).trim();
    const first = clean.slice(comma + 1).trim().split(' ')[0] ?? '';
    if (first && last) return `${first} ${last[0].toUpperCase()}.`.slice(0, 80);
  }
  return clean.slice(0, 80);
}
