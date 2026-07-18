// document_signatures — each approver's saved, drawn signature.
//
// The Accounting Head draws their signature once in the Documents tab; it's
// stored as a PNG data URL and stamped onto every document they approve. The
// `enabled` flag is the revoke switch: while off (or while no row exists) that
// person cannot approve requests. Approvals always use the APPROVER's OWN row,
// so a different accountant can never sign with Carla's signature.

import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { resolveUserRole } from '@/lib/supabase/pab-day-disputes';
import { normEmail } from '@/lib/email/norm-email';
import { MAX_SIGNATURE_DATA_URL_CHARS, type DocumentSignatureRow } from './types';

const TABLE = 'document_signatures';

const IMAGE_DATA_URL_RE = /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/;

export async function getDocumentSignature(
  email: string,
): Promise<{ row: DocumentSignatureRow | null; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { row: null, error: 'Supabase not configured' };
  const owner = normEmail(email) ?? email.trim().toLowerCase();
  const { data, error } = await supabase.from(TABLE).select('*').eq('owner_email', owner).maybeSingle();
  return { row: (data as DocumentSignatureRow) ?? null, error: error?.message ?? null };
}

/**
 * Create/update the caller's own signature. Passing `image_data_url` replaces
 * the drawing; `enabled` flips the revoke switch; name/title update the burned
 * caption. Enabling (or creating) requires a drawing to exist.
 */
export async function upsertDocumentSignature(params: {
  owner_email: string;
  owner_name?: string | null;
  title?: string | null;
  image_data_url?: string | null;
  enabled?: boolean;
}): Promise<{ row: DocumentSignatureRow | null; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { row: null, error: 'Supabase not configured' };

  const owner = normEmail(params.owner_email) ?? params.owner_email.trim().toLowerCase();
  if (!owner) return { row: null, error: 'Missing signer email' };

  const { row: existing, error: fetchErr } = await getDocumentSignature(owner);
  if (fetchErr) return { row: null, error: fetchErr };

  const newImage = params.image_data_url?.trim() || null;
  if (newImage) {
    if (newImage.length > MAX_SIGNATURE_DATA_URL_CHARS) {
      return { row: null, error: 'Signature image is too large — draw it again with fewer strokes' };
    }
    if (!IMAGE_DATA_URL_RE.test(newImage)) {
      return { row: null, error: 'Signature must be a PNG or JPEG data URL' };
    }
  }

  const image = newImage ?? existing?.image_data_url ?? null;
  const enabled = params.enabled ?? existing?.enabled ?? true;
  if (!image) {
    return { row: null, error: 'Draw and save your signature first' };
  }

  const nowIso = new Date().toISOString();
  const payload = {
    owner_email: owner,
    owner_name: (params.owner_name ?? existing?.owner_name ?? null)?.toString().trim() || null,
    title: (params.title ?? existing?.title ?? null)?.toString().trim() || null,
    image_data_url: image,
    enabled,
    updated_at: nowIso,
  };

  const { data, error } = await supabase
    .from(TABLE)
    .upsert(payload, { onConflict: 'owner_email' })
    .select('*')
    .single();
  if (error) return { row: null, error: error.message };

  void (async () => {
    const role = await resolveUserRole(owner, 'Accounting');
    await insertAuditLog({
      user_name: owner,
      user_role: role,
      action: newImage
        ? 'documents.signature_saved'
        : enabled !== (existing?.enabled ?? true)
          ? enabled
            ? 'documents.signature_enabled'
            : 'documents.signature_revoked'
          : 'documents.signature_updated',
      resource: TABLE,
      resource_id: owner,
      details: { enabled, replaced_image: !!newImage },
    });
  })();

  return { row: data as DocumentSignatureRow, error: null };
}
