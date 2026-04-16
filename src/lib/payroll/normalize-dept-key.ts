/**
 * Maps a raw Supabase `Department` string to payroll department keys (Payroll Wizard tabs).
 * Case-insensitive; trims whitespace.
 */
export function normalizeDeptToKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  const map: Record<string, string> = {
    accounting: 'accounting',
    'accounting team': 'accounting',
    edit: 'edit',
    'edit team': 'edit',
    devs: 'devs',
    'ai/api team': 'devs',
    'ai api team': 'devs',
    'lead gen': 'lead_gen',
    'lead generation': 'lead_gen',
    'us - manager bonus': 'us_manager_bonus',
    'us manager bonus': 'us_manager_bonus',
    'manager bonus': 'us_manager_bonus',
    callback: 'callback',
    'callback team': 'callback',
    qc: 'qc',
    'quality control': 'qc',
    discovery: 'discovery',
    hr: 'hr',
    'human resources': 'hr',
    'sales assistant': 'sales_assistant',
    sales: 'sales_assistant',
    'smart staff': 'smart_staff',
    smartstaff: 'smart_staff',
    'hogan smith law': 'hogan_smith_law',
    hogan: 'hogan_smith_law',
    hsl: 'hogan_smith_law',
    smm: 'smm',
    'smm freelancer': 'smm',
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
