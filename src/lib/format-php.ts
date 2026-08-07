/**
 * The org's peso formatter. Extracted from PayrollWizard.tsx so the Validation
 * breakdown table can render identical strings to the wizard around it — a table
 * that formats money differently from its own subtotal footer reads as a bug.
 */
export function formatPHP(n: number): string {
  return '₱' + n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
