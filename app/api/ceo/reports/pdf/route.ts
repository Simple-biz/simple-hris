import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth/auth-options';
import { parseBizReport, bizReportSlug } from '@/lib/ceo/biz-report';
import { generateBizReportPdf, type AvatarImage } from '@/lib/ceo/report-pdf';
import { getProfilePhotoUrlForEmail } from '@/lib/supabase/employee-profile-photo';
import { insertAuditLog } from '@/lib/supabase/audit-log';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Renders a Penny AI report spec to a downloadable PDF.
 *
 * The chat assistant emits the report spec inline (a ```biz-report block); the
 * client holds it and POSTs it here when the CEO clicks Download — so this
 * endpoint is stateless (no report storage) and the spec round-trips through
 * the same `parseBizReport` validator used to render the on-screen card.
 *
 * Auth mirrors the CEO dashboard / chat endpoint: `ceo` or `admin` only.
 */

function sessionRoles(session: unknown): string[] {
  const user = (session as { user?: { roles?: string[] } } | null)?.user;
  return Array.isArray(user?.roles) ? user!.roles! : [];
}

// Only fetch avatar images from hosts we control / trust. Profile photos are
// either Supabase Storage public URLs or the Google SSO photo CDN; restricting
// to these blocks any SSRF even though the URL comes from our own DB.
const ALLOWED_IMG_HOST = /(^|\.)(supabase\.(co|in)|googleusercontent\.com)$/i;

function isAllowedImageUrl(u: string): boolean {
  try {
    const url = new URL(u);
    return (url.protocol === 'https:' || url.protocol === 'http:') && ALLOWED_IMG_HOST.test(url.hostname);
  } catch {
    return false;
  }
}

function detectImageFormat(b: Uint8Array): 'png' | 'jpg' | null {
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  return null;
}

/** Resolve an employee's uploaded profile photo (by email) to embeddable bytes. */
async function resolveAvatar(email: string): Promise<AvatarImage | null> {
  try {
    const url = await getProfilePhotoUrlForEmail(email);
    if (!url || !isAllowedImageUrl(url)) return null;
    const res = await fetch(url);
    if (!res.ok) return null;
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > 6_000_000) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > 6_000_000) return null;
    const format = detectImageFormat(bytes);
    return format ? { bytes, format } : null;
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  const email = (session?.user as { email?: string } | undefined)?.email;
  if (!email) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const roles = sessionRoles(session);
  if (!roles.includes('ceo') && !roles.includes('admin')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const spec = (body as { report?: unknown })?.report ?? body;
  const report = parseBizReport(spec);
  if (!report) {
    return NextResponse.json({ error: 'The report could not be built — it was empty or malformed.' }, { status: 400 });
  }

  // Absolute logo URL from the request origin so the server-side renderer can
  // fetch /simple-logo.png (a relative URL has no base on the server). Falls
  // back to a wordmark in the renderer if it can't be loaded.
  const proto = request.headers.get('x-forwarded-proto') ?? 'https';
  const host = request.headers.get('host');
  const logoUrl = host ? `${proto}://${host}/simple-logo.png` : undefined;
  const now = new Date();

  let pdf: Uint8Array;
  try {
    pdf = await generateBizReportPdf({
      report,
      generatedAt: now.toLocaleString('en-US', {
        dateStyle: 'long',
        timeStyle: 'short',
      }),
      year: now.getFullYear(),
      preparedFor: email,
      logoUrl,
      resolveAvatar,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Could not render the PDF: ${msg}` }, { status: 500 });
  }

  void insertAuditLog({
    user_name: email,
    user_role: roles.includes('ceo') ? 'ceo' : 'admin',
    action: 'ceo_assistant.report_download',
    resource: 'ceo_report',
    resource_id: null,
    details: { title: report.title, sections: report.sections.length },
  }).catch(() => {});

  const filename = `${bizReportSlug(report)}.pdf`;
  // Copy into a fresh ArrayBuffer-backed view so the body is a clean BodyInit.
  const bytes = new Uint8Array(pdf);
  return new Response(bytes, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': String(bytes.byteLength),
      'Cache-Control': 'no-store',
    },
  });
}
