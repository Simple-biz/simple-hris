import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import {
  insertPaymentDispatch,
  listPaymentDispatches,
  type InsertPaymentDispatchInput,
} from "@/lib/supabase/payment-dispatches";
import { insertAuditLog } from "@/lib/supabase/audit-log";
import { getSessionActor } from "@/lib/auth/session-actor";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface PostBody extends Omit<InsertPaymentDispatchInput, "created_by"> {}

export async function GET(req: NextRequest) {
  const cycleIdRaw = req.nextUrl.searchParams.get("cycle_id");
  const cycleId = cycleIdRaw === "" ? undefined : cycleIdRaw ?? undefined;
  const emailRaw = req.nextUrl.searchParams.get("email");
  const recipientEmail = emailRaw?.trim() ? emailRaw.trim() : undefined;
  const { rows, error } = await listPaymentDispatches({ cycleId, recipientEmail });
  return NextResponse.json({ rows, error });
}

export async function POST(req: NextRequest) {
  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ row: null, error: "Invalid JSON body" }, { status: 400 });
  }

  // Required field guards.
  const required: Array<keyof PostBody> = [
    "recipient_email",
    "processor",
    "transaction_id",
    "bank_used",
    "sent_date",
  ];
  for (const k of required) {
    if (!body[k] || (typeof body[k] === "string" && !String(body[k]).trim())) {
      return NextResponse.json(
        { row: null, error: `Missing required field: ${k}` },
        { status: 400 },
      );
    }
  }

  // Identify the operator for audit trail.
  let createdBy: string | null = null;
  let createdByRole = 'user';
  try {
    const sessionActor = await getSessionActor();
    createdBy = sessionActor.user_name !== 'anonymous' ? sessionActor.user_name : null;
    createdByRole = sessionActor.user_role;
  } catch {
    /* ignore — audit trail is best-effort */
  }

  const { row, error } = await insertPaymentDispatch({ ...body, created_by: createdBy });
  if (error || !row) {
    return NextResponse.json({ row: null, error: error ?? "Insert failed" }, { status: 500 });
  }

  void insertAuditLog({
    user_name: createdBy ?? "unknown",
    user_role: createdByRole,
    action: "payment.dispatched",
    resource: "payment_dispatches",
    resource_id: row.id,
    details: {
      recipient_email: row.recipient_email,
      recipient_name: row.recipient_name,
      processor: row.processor,
      amount_usd: row.amount_usd,
      amount_php: row.amount_php,
      transaction_id: row.transaction_id,
      bank_used: row.bank_used,
      sent_date: row.sent_date,
      status: row.status,
      cycle: {
        cycle_id: row.cycle_id,
        source_file: row.cycle_source_file ?? null,
        period_start: row.cycle_period_start ?? null,
        period_end: row.cycle_period_end ?? null,
        fx_rate:
          row.amount_php && row.amount_usd
            ? Number((Number(row.amount_php) / Number(row.amount_usd)).toFixed(4))
            : null,
      },
    },
  });

  return NextResponse.json({ row, error: null });
}
