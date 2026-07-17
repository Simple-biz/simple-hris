import { NextResponse } from 'next/server';
import {
  listTimeAdjustments,
  createTimeAdjustment,
  signTimeAdjustmentImageUrls,
  isValidAdjustmentReason,
  sanitizeAdjustmentSegments,
  adjustmentEvidencePrefix,
  MAX_ADJUSTMENT_IMAGES,
  type TimeAdjustmentStatus,
  type TimeAdjustmentSegment,
} from '@/lib/supabase/time-adjustments';
import { normEmail } from '@/lib/email/norm-email';
import {
  authorizeEmailAccess,
  deniedResponse,
  requireElevatedSession,
} from '@/lib/auth/authorize-email';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const email = searchParams.get('email') ?? undefined;
    const from = searchParams.get('from') ?? undefined;
    const to = searchParams.get('to') ?? undefined;
    const statusParams = searchParams.getAll('status').filter(Boolean) as TimeAdjustmentStatus[];
    const limitRaw = searchParams.get('limit');
    const limit = limitRaw ? parseInt(limitRaw, 10) : undefined;

    // Per-email lookup is self-or-elevated; cross-employee listing (no email) is elevated-only.
    const authz = email ? await authorizeEmailAccess(email) : await requireElevatedSession();
    if (!authz.ok) return deniedResponse(authz);

    const scopedEmail = email ? authz.effectiveEmail : undefined;

    let statuses: TimeAdjustmentStatus[] | undefined;
    let status: TimeAdjustmentStatus | undefined;
    if (statusParams.length > 1) statuses = statusParams;
    else if (statusParams.length === 1) status = statusParams[0];

    const { rows, error } = await listTimeAdjustments({
      email: scopedEmail,
      from,
      to,
      status,
      statuses,
      limit,
    });
    if (error) return NextResponse.json({ rows: [], error }, { status: 500 });

    // Elevated callers (Accounting review) get signed evidence URLs so they can view images.
    let signedUrls: Record<string, string> = {};
    if (authz.elevated) {
      const allPaths = rows.flatMap((r) => r.image_paths ?? []);
      if (allPaths.length > 0) signedUrls = await signTimeAdjustmentImageUrls(allPaths);
    }

    return NextResponse.json({ rows, signedUrls, error: null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ rows: [], error: msg }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      work_email?: string;
      adjust_date?: string;
      reason?: string;
      explanation?: string | null;
      requested_segments?: TimeAdjustmentSegment[];
      image_paths?: string[];
      created_by?: string | null;
    };

    const work_email = normEmail(body.work_email ?? '') ?? body.work_email?.trim().toLowerCase();
    if (!work_email) {
      return NextResponse.json({ error: 'work_email is required' }, { status: 400 });
    }

    // Can't request on behalf of another employee unless elevated.
    const authz = await authorizeEmailAccess(work_email);
    if (!authz.ok) return deniedResponse(authz);

    const adjust_date = body.adjust_date?.trim();
    if (!adjust_date || !/^\d{4}-\d{2}-\d{2}$/.test(adjust_date)) {
      return NextResponse.json({ error: 'adjust_date is required (YYYY-MM-DD)' }, { status: 400 });
    }
    // Future days can't be adjusted.
    if (adjust_date > new Date().toISOString().slice(0, 10)) {
      return NextResponse.json({ error: 'Cannot request an adjustment for a future date' }, { status: 400 });
    }

    const reason = body.reason?.trim() ?? '';
    if (!isValidAdjustmentReason(reason)) {
      return NextResponse.json({ error: 'A valid reason is required' }, { status: 400 });
    }
    if (reason === 'other' && !body.explanation?.trim()) {
      return NextResponse.json({ error: 'Please provide an explanation for "Other"' }, { status: 400 });
    }

    const imagePaths = Array.isArray(body.image_paths) ? body.image_paths.filter(Boolean) : [];
    if (imagePaths.length > MAX_ADJUSTMENT_IMAGES) {
      return NextResponse.json({ error: `At most ${MAX_ADJUSTMENT_IMAGES} images` }, { status: 400 });
    }
    // Evidence paths must live in the caller's or target employee's own storage folder
    // (uploads are keyed by session email; edits resubmit previously-uploaded paths;
    // nobody may attach someone else's evidence).
    const allowedPrefixes = [
      adjustmentEvidencePrefix(authz.effectiveEmail),
      adjustmentEvidencePrefix(authz.sessionEmail),
    ];
    if (
      imagePaths.some(
        (p) => typeof p !== 'string' || !allowedPrefixes.some((pre) => p.startsWith(pre)),
      )
    ) {
      return NextResponse.json({ error: 'Invalid evidence image path' }, { status: 400 });
    }

    // Employees must point at the exact time ranges being corrected (time in / time out).
    const { segments, error: segError } = sanitizeAdjustmentSegments(body.requested_segments);
    if (segError || !segments) {
      return NextResponse.json(
        { error: segError ?? 'At least one time in / time out is required' },
        { status: 400 },
      );
    }

    const { id, error } = await createTimeAdjustment({
      work_email: authz.effectiveEmail,
      adjust_date,
      reason,
      explanation: body.explanation,
      requested_segments: segments,
      image_paths: imagePaths,
      created_by: body.created_by ?? authz.effectiveEmail,
    });

    if (error) {
      return NextResponse.json({ error }, { status: error.includes('already') ? 409 : 500 });
    }
    return NextResponse.json({ success: true, id, error: null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
