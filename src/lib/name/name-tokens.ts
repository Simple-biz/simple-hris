/**
 * Normalize a name for comparison by extracting unique alphabetic tokens,
 * sorting, and joining. Handles "Last, First" vs "First Last" vs
 * 'Last, First "Nick"' — e.g. 'Arrieta, Ace "Ace"' and 'Ace Arrieta' both
 * normalize to 'ace arrieta'.
 *
 * Server-safe port of the Payroll Wizard's private matcher
 * (PayrollWizard.tsx `normalizeNameTokens`) so lib code can token-match
 * free-text names against master-list rows without importing a client
 * component.
 */
export function normalizeNameTokens(name: string): string {
  return nameTokens(name).join(" ");
}

/** The sorted, de-duped token set behind {@link normalizeNameTokens} — exposed
 *  so callers can do subset matching (e.g. "Kane Reroma" against the master's
 *  fuller "Jan Kane Reroma"). */
export function nameTokens(name: string): string[] {
  const tokens = name
    // Fold "fancy" Unicode (math-italic/bold, full-width, etc.) to plain ASCII
    // BEFORE lowercasing — otherwise a name saved as styled glyphs never
    // token-matches its master row.
    .normalize("NFKC")
    .toLowerCase()
    // Straight AND curly quotes — sheet-pasted names often carry “smart” quotes
    // around the go-by name, which NFKC does not fold to ASCII.
    .replace(/["'()“”‘’]/g, "")
    .replace(/,/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  return [...new Set(tokens)].sort();
}
