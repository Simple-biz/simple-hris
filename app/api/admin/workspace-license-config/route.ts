import { NextResponse } from 'next/server';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { requireAdminSession } from '@/lib/auth/authorize-email';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/admin/workspace-license-config
 *
 * Admin endpoint to configure Google Workspace license counts.
 *
 * `total_licenses` is the source of truth the admin enters (Google has no
 * public API for total purchased seats for direct customers).
 *
 * `available_licenses` is an OPTIONAL manual fallback used only when the live
 * Licensing API isn't configured. When the API is wired up, available is
 * computed as total - assigned at read time and this value is ignored. If
 * omitted, it defaults to total (i.e. "all available" until the API reports
 * otherwise). Gated to elevated (admin only) sessions.
 */
export async function POST(req: Request) {
  // Admin-only: the /api/admin/* namespace is admin-gated at the edge (proxy.ts);
  // this in-handler check makes the proxy true defense-in-depth rather than the
  // sole control, and matches the route's documented intent.
  const authz = await requireAdminSession();
  if (!authz.ok) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }

  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) {
    return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });
  }

  try {
    const body = (await req.json()) as {
      available_licenses?: number;
      total_licenses?: number;
    };

    const { total_licenses } = body;

    if (typeof total_licenses !== 'number' || total_licenses < 0) {
      return NextResponse.json(
        { error: 'Invalid input: total_licenses must be a non-negative number' },
        { status: 400 }
      );
    }

    // Manual available fallback — default to total when not provided, clamp to
    // [0, total].
    const rawAvailable =
      typeof body.available_licenses === 'number' ? body.available_licenses : total_licenses;
    if (rawAvailable < 0) {
      return NextResponse.json(
        { error: 'Invalid input: available_licenses cannot be negative' },
        { status: 400 }
      );
    }
    const available_licenses = Math.min(rawAvailable, total_licenses);

    const licenseInfo = {
      available_licenses,
      total_licenses,
      last_updated: new Date().toISOString(),
    };

    // app_settings.value is a TEXT column app-wide — store JSON as a string to
    // match every other setting (see lib/supabase/app-settings.ts).
    const { error } = await supabase
      .from('app_settings')
      .upsert(
        {
          key: 'workspace.license_info',
          value: JSON.stringify(licenseInfo),
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'key' }
      );

    if (error) {
      console.error('Supabase upsert error:', error);
      return NextResponse.json({ error: `Database error: ${error.message}` }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      available_licenses,
      total_licenses,
      last_updated: licenseInfo.last_updated,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Failed to save license config' },
      { status: 500 }
    );
  }
}
