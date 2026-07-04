import { NextResponse } from 'next/server';
import { requireRateVisibilitySession, deniedResponse } from '@/lib/auth/authorize-email';
import {
  createSupabaseServiceRoleClient,
  createSupabaseServerClient,
} from '@/lib/supabase/server';
import { normEmail } from '@/lib/email/norm-email';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** One person who has access to the Accounting dashboard (the `accounting` role). */
export interface AccountingTeamMember {
  email: string;
  name: string | null;
}

/**
 * The Accounting directory — everyone holding the `accounting` role — so the CEO
 * "Live payroll processing" modal can show the WHOLE team with an online/offline
 * badge (not just whoever happens to be driving a payroll surface right now).
 * Names are resolved best-effort from employee_ids; avatars come from live
 * presence when the person is online (offline → initials).
 *
 * Gated to rate-visible roles (admin / accounting / ceo) — the same gate as the
 * other CEO payroll-oversight endpoints.
 */
export async function GET() {
  const authz = await requireRateVisibilitySession();
  if (!authz.ok) return deniedResponse(authz);

  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) {
    return NextResponse.json({ members: [], error: 'Supabase not configured' }, { status: 500 });
  }

  const { data: roleRows, error: roleErr } = await supabase
    .from('employee_roles')
    .select('work_email')
    .eq('role', 'accounting')
    .is('revoked_at', null);
  if (roleErr) {
    return NextResponse.json({ members: [], error: roleErr.message }, { status: 500 });
  }

  const emails = Array.from(
    new Set(
      (roleRows ?? [])
        .map((r: { work_email?: string | null }) => normEmail(r.work_email ?? '') ?? '')
        .filter(Boolean),
    ),
  );
  if (emails.length === 0) {
    return NextResponse.json({ members: [], error: null });
  }

  // Resolve display names (best-effort — a missing name just falls back to the
  // email handle on the client).
  const nameByEmail = new Map<string, string>();
  try {
    const { data: idRows } = await supabase
      .from('employee_ids')
      .select('name, work_email, personal_email');
    for (const r of (idRows ?? []) as {
      name?: string | null;
      work_email?: string | null;
      personal_email?: string | null;
    }[]) {
      const nm = (r.name ?? '').trim();
      if (!nm) continue;
      const we = normEmail(r.work_email ?? '') ?? '';
      const pe = normEmail(r.personal_email ?? '') ?? '';
      if (we && !nameByEmail.has(we)) nameByEmail.set(we, nm);
      if (pe && !nameByEmail.has(pe)) nameByEmail.set(pe, nm);
    }
  } catch {
    /* names are best-effort */
  }

  const members: AccountingTeamMember[] = emails
    .map((email) => ({ email, name: nameByEmail.get(email) ?? null }))
    .sort((a, b) => (a.name ?? a.email).localeCompare(b.name ?? b.email));

  return NextResponse.json({ members, error: null });
}
