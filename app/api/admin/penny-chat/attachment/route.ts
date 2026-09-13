import { NextResponse, type NextRequest } from 'next/server';
import { requireAdminSession, deniedResponse } from '@/lib/auth/authorize-email';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { auditFrom } from '@/lib/audit/context';
import { getProfilePhotoUrlForEmail } from '@/lib/supabase/employee-profile-photo';
import {
  ATTACHMENT_SOURCES,
  parseAttachmentRef,
  type AttachmentRef,
} from '@/lib/penny/attachment-refs';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Open ONE file that Admin Penny surfaced.
 *
 * `GET ?ref=<source>~<record id>[~<slot>]` → `{ url }`, a short-lived link.
 *
 * ── Why the ref names a record and not a path ────────────────────────────────
 * The client never supplies a storage path. It names a ROW, this route reads
 * the path off that row, and the bucket comes from a fixed table keyed by the
 * source. Traversal is therefore unrepresentable rather than merely filtered:
 * there is no string from the request that reaches `storage.from(...)`.
 *
 * ── Why this adds no access ──────────────────────────────────────────────────
 * The gate is `requireAdminSession()`, and every one of these files is already
 * openable by the same caller through its own surface — `requireFeatureAccess`
 * admin-bypasses and `authorizeEmailAccess` elevated-bypasses. What is new is
 * the audit row: the surfaces this borrows from write NONE on a download, so
 * opening through Penny is the better-recorded path, not a quieter one.
 *
 * ── Why the link is minted here and not at list time ─────────────────────────
 * A signed URL is a bearer credential. Minting one for every file Penny merely
 * mentions would put live links on screen that nobody asked to open, and start
 * their clock early. Here the TTL begins when someone actually looks — and each
 * source keeps its OWN lifetime (the W-8BEN's 300s is short on purpose), which
 * is why `ATTACHMENT_SOURCES` carries the number rather than this route
 * choosing one.
 */

type Resolved = {
  /** Storage path, read off the record — never off the request. */
  path: string | null;
  /** Whose record it is, for the audit row. */
  subject: string | null;
  /** Already-usable URL (the public avatar), when nothing needs signing. */
  directUrl?: string | null;
};

async function resolve(ref: AttachmentRef): Promise<Resolved | { error: string; status: number }> {
  if (ref.source === 'photo') {
    const url = await getProfilePhotoUrlForEmail(ref.id);
    if (!url) return { error: 'No profile photo on file', status: 404 };
    return { path: null, subject: ref.id, directUrl: url };
  }

  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { error: 'Storage is not configured', status: 503 };

  switch (ref.source) {
    case 'evidence': {
      const { data, error } = await supabase
        .from('time_adjustment_requests')
        .select('work_email, image_paths')
        .eq('id', ref.id)
        .maybeSingle();
      if (error) return { error: error.message, status: 500 };
      if (!data) return { error: 'Record not found', status: 404 };
      const row = data as { work_email: string; image_paths: string[] | null };
      // The slot indexes THIS row's own list. An out-of-range slot is a stale
      // or forged ref, not a reason to fall back to the first image.
      const path = (row.image_paths ?? [])[ref.slot] ?? null;
      return { path, subject: row.work_email };
    }
    case 'receipt': {
      const { data, error } = await supabase
        .from('mesa_request_receipts')
        .select('work_email, file_path')
        .eq('id', ref.id)
        .maybeSingle();
      if (error) return { error: error.message, status: 500 };
      if (!data) return { error: 'Record not found', status: 404 };
      const row = data as { work_email: string; file_path: string | null };
      return { path: row.file_path, subject: row.work_email };
    }
    case 'document':
    case 'document_signed': {
      const { data, error } = await supabase
        .from('document_requests')
        .select('employee_email, file_path, signed_file_path')
        .eq('id', ref.id)
        .maybeSingle();
      if (error) return { error: error.message, status: 500 };
      if (!data) return { error: 'Record not found', status: 404 };
      const row = data as {
        employee_email: string;
        file_path: string | null;
        signed_file_path: string | null;
      };
      return {
        path: ref.source === 'document_signed' ? row.signed_file_path : row.file_path,
        subject: row.employee_email,
      };
    }
    case 'w8ben':
    case 'ip_assignment': {
      const { data, error } = await supabase
        .from('hr_onboarding_submissions')
        .select('work_email, invite_personal_email, email, w8ben_file_path, ip_assignment_file_path')
        .eq('id', ref.id)
        .maybeSingle();
      if (error) return { error: error.message, status: 500 };
      if (!data) return { error: 'Record not found', status: 404 };
      const row = data as {
        work_email: string | null;
        invite_personal_email: string | null;
        email: string | null;
        w8ben_file_path: string | null;
        ip_assignment_file_path: string | null;
      };
      return {
        path: ref.source === 'w8ben' ? row.w8ben_file_path : row.ip_assignment_file_path,
        subject: row.work_email ?? row.invite_personal_email ?? row.email,
      };
    }
  }
}

export async function GET(request: NextRequest) {
  const authz = await requireAdminSession();
  if (!authz.ok) return deniedResponse(authz);

  const ref = parseAttachmentRef(request.nextUrl.searchParams.get('ref'));
  if (!ref) return NextResponse.json({ error: 'Malformed attachment reference' }, { status: 400 });

  const def = ATTACHMENT_SOURCES[ref.source];

  let resolved: Awaited<ReturnType<typeof resolve>>;
  try {
    resolved = await resolve(ref);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
  if ('error' in resolved) {
    return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  }

  let url = resolved.directUrl ?? null;
  if (!url) {
    if (!resolved.path) {
      return NextResponse.json({ error: 'That file is no longer on the record' }, { status: 404 });
    }
    if (!def.bucket || def.ttlSeconds == null) {
      // A signed source with no bucket or no lifetime is a registry mistake,
      // not something to paper over with a default.
      return NextResponse.json({ error: 'Attachment source is misconfigured' }, { status: 500 });
    }
    const supabase = createSupabaseServiceRoleClient();
    if (!supabase) return NextResponse.json({ error: 'Storage is not configured' }, { status: 503 });
    const { data, error } = await supabase.storage
      .from(def.bucket)
      .createSignedUrl(resolved.path, def.ttlSeconds);
    if (error || !data?.signedUrl) {
      return NextResponse.json({ error: error?.message ?? 'Could not open the file' }, { status: 404 });
    }
    url = data.signedUrl;
  }

  // Audit the OPEN — the moment someone actually looks at the file — not the
  // listing. The actor is the authorized session, never anything in the request
  // (audit-registry-single-source). Best-effort: the read already happened, and
  // failing the response now would only hide it.
  void insertAuditLog({
    ...auditFrom(request, authz),
    action: 'admin_assistant.attachment_opened',
    resource: 'admin_penny_chat',
    resource_id: resolved.subject ?? ref.id,
    details: {
      source: ref.source,
      record_id: ref.id,
      slot: def.slotted ? ref.slot : undefined,
      subject_email: resolved.subject,
      ttl_seconds: def.ttlSeconds,
    },
  }).catch(() => {});

  return NextResponse.json(
    { url, expires_in: def.ttlSeconds },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
