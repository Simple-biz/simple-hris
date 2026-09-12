import { createSupabaseServiceRoleClient, createSupabaseServerClient } from './server';
import type { PaystubIssue } from '@/lib/payroll/paystub-issue';

/**
 * Reader/writer for `public.paystub_issues` — one row per pay statement actually
 * emailed (`references/sql/create/2026-09-12_paystub_issues.sql`).
 *
 * **Every function here degrades to "no history" rather than throwing.** The
 * migration is Kane's to apply, so until it lands the table does not exist in
 * production; a paystub must still send and a payment must still record while
 * the issue number quietly falls back to `paystub_dispatch_queue.send_count`.
 * A missing table surfacing as a 500 on Mark Paid would make a display feature
 * capable of blocking payroll, which is never an acceptable trade here.
 *
 * The counterpart rule: a read that fails returns `[]`, and `[]` means **not
 * recorded** — never "this was issue 1". The UI's `unrecorded` verdict is what
 * carries that distinction.
 */

const TABLE = 'paystub_issues';

const SELECT =
  'cycle_source_file, recipient_email, issue_no, issued_at, issued_by, kind, amount_php, amount_usd, previous_amount_php, source, reason';

function norm(email: string): string {
  return (email ?? '').trim().toLowerCase();
}

function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

type Row = Record<string, unknown>;

function toIssue(r: Row): PaystubIssue {
  return {
    cycleSourceFile: String(r.cycle_source_file ?? ''),
    recipientEmail: String(r.recipient_email ?? ''),
    issueNo: num(r.issue_no) ?? 1,
    issuedAt: String(r.issued_at ?? ''),
    issuedBy: (r.issued_by as string | null) ?? null,
    kind: (r.kind as PaystubIssue['kind']) ?? 'original',
    amountPhp: num(r.amount_php),
    amountUsd: num(r.amount_usd),
    previousAmountPhp: num(r.previous_amount_php),
    source: (r.source as PaystubIssue['source']) ?? 'other',
    reason: (r.reason as string | null) ?? null,
  };
}

/** Every recorded issue of one statement, oldest first. `[]` = nothing recorded. */
export async function listIssuesForStatement(
  sourceFile: string,
  recipientEmail: string,
): Promise<PaystubIssue[]> {
  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) return [];
  try {
    const { data, error } = await supabase
      .from(TABLE)
      .select(SELECT)
      .eq('cycle_source_file', sourceFile)
      .eq('recipient_email', norm(recipientEmail))
      .order('issue_no', { ascending: true });
    if (error) return [];
    return (data ?? []).map((r) => toIssue(r as Row));
  } catch {
    return [];
  }
}

/**
 * Every recorded issue for one person across all weeks, keyed by source file.
 *
 * Paged: a long-tenured employee's statements are bounded, but a shared reader
 * that silently stops at PostgREST's 1000-row cap is exactly the latent bug the
 * project has been bitten by repeatedly (memory/postgrest-1000-cap-sweep).
 */
export async function listIssuesForEmployee(
  recipientEmail: string,
): Promise<Map<string, PaystubIssue[]>> {
  const out = new Map<string, PaystubIssue[]>();
  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) return out;
  const email = norm(recipientEmail);
  const PAGE = 1000;
  try {
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from(TABLE)
        .select(SELECT)
        .eq('recipient_email', email)
        .order('cycle_source_file', { ascending: true })
        .order('issue_no', { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) return out;
      const rows = (data ?? []) as Row[];
      for (const r of rows) {
        const issue = toIssue(r);
        const list = out.get(issue.cycleSourceFile);
        if (list) list.push(issue);
        else out.set(issue.cycleSourceFile, [issue]);
      }
      if (rows.length < PAGE) break;
    }
  } catch {
    return out;
  }
  return out;
}

/**
 * Record one emitted statement. Best-effort by contract — the caller has already
 * sent the email and possibly recorded a payment, so a failure here is logged and
 * swallowed, never propagated.
 *
 * Returns `true` only when the row actually landed, so a caller can tell
 * "recorded" from "the table isn't there yet" if it wants to.
 */
export async function recordPaystubIssue(params: {
  sourceFile: string;
  recipientEmail: string;
  issueNo: number;
  issuedBy: string | null;
  kind: PaystubIssue['kind'];
  amountPhp: number | null;
  amountUsd: number | null;
  previousAmountPhp: number | null;
  source: PaystubIssue['source'];
  reason?: string | null;
}): Promise<boolean> {
  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) return false;
  try {
    const { error } = await supabase.from(TABLE).insert({
      cycle_source_file: params.sourceFile,
      recipient_email: norm(params.recipientEmail),
      issue_no: params.issueNo,
      issued_by: params.issuedBy,
      kind: params.kind,
      amount_php: params.amountPhp,
      amount_usd: params.amountUsd,
      previous_amount_php: params.previousAmountPhp,
      source: params.source,
      reason: params.reason ?? null,
    });
    if (error) {
      // A duplicate (file, email, issue_no) is the UNIQUE constraint doing its
      // job against a retried request — not worth shouting about, and certainly
      // not worth failing a send that already happened.
      if (error.code !== '23505') {
        console.error('[paystub-issues] could not record the issue', error.message);
      }
      return false;
    }
    return true;
  } catch (e) {
    console.error('[paystub-issues] insert threw', e instanceof Error ? e.message : String(e));
    return false;
  }
}
