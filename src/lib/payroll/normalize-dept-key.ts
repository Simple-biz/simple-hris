/**
 * Maps a raw Supabase `Department` string to payroll department keys (Payroll Wizard tabs).
 * Case-insensitive; trims whitespace.
 */
export function normalizeDeptToKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  // Department transfers into an HSL sub-team write the namespaced access key
  // (e.g. "hsl:intake_specialist") into the master list's Department column.
  // Whatever the sub-team, those people belong to Hogan Smith Law.
  if (s.startsWith('hsl:')) return 'hogan_smith_law';
  const map: Record<string, string> = {
    accounting: 'accounting',
    'accounting team': 'accounting',
    edit: 'edit',
    'edit team': 'edit',
    devs: 'devs',
    'ai/api team': 'devs',
    'ai api team': 'devs',
    'ai and api team': 'devs',
    'ai & api team': 'devs',
    'lead gen': 'lead_gen',
    'lead generation': 'lead_gen',
    // NOTE: The former "US Team" / "US Manager Bonus" department was retired
    // (2026-07-07). Its people are record-only on the Global Master List (now
    // labelled "US Employees") and are not run through HRIS PHP payroll, so the
    // label deliberately maps to no payroll key.
    callback: 'callback',
    'callback team': 'callback',
    // The master list (synced from the Google Sheet) carries BOTH "Callback Team"
    // and a stray plural "Callbacks" label. Map both to the single `callback`
    // department key so a manager assigned to either label sees the Callback KPI
    // calculator and the full team groups together (rather than splitting off the
    // lone "Callbacks" person into an unrecognized, invisible department).
    callbacks: 'callback',
    qc: 'qc',
    'quality control': 'qc',
    discovery: 'discovery',
    hr: 'hr',
    'human resources': 'hr',
    'sales assistant': 'sales_assistant',
    // Sales and Sales Assistant are DIFFERENT departments (split 2026-07-27).
    // The master sheet labels both cohorts "Sales"; the PH Sales Assistant
    // people are re-labelled at roster-load time via the email override list
    // (src/lib/departments/dept-email-overrides.ts), so by the time a label
    // reaches this map, "Sales" means the US sales team.
    sales: 'sales',
    'smart staff': 'smart_staff',
    smartstaff: 'smart_staff',
    // Same team, labeled differently across sources: the master list (authoritative
    // for identity) uses "SmartClicks/Sterling"; the old payroll dashboard uses
    // "Smartclicks". All resolve to the Smart Staff department.
    'smartclicks/sterling': 'smart_staff',
    'smart clicks/sterling': 'smart_staff',
    smartclicks: 'smart_staff',
    'smart clicks': 'smart_staff',
    'hogan smith law': 'hogan_smith_law',
    hogan: 'hogan_smith_law',
    hsl: 'hogan_smith_law',
    smm: 'smm',
    // "SMM Freelancer" is its own master-list department (flat-rate freelancers,
    // distinct from the in-house Social Media Team) — its own wizard tab.
    'smm freelancer': 'smm_freelancer',
    'smm freelancers': 'smm_freelancer',
    'social media': 'smm',
    'social media team': 'smm',
    'pm team': 'pm_team',
    pm: 'pm_team',
    'project management': 'pm_team',
    'project management team': 'pm_team',
    'client va': 'client_va',
    'client - va': 'client_va',
    'client-va': 'client_va',
    'site building': 'site_building',
  };
  return map[s] ?? null;
}
