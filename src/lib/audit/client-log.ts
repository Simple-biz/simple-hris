/**
 * Client-side helper for posting Payroll Wizard audit events.
 *
 * Every event includes the cycle context (source_file / period / fx_rate) so
 * the Reports tab can drill down into a single cycle's history. Calls are
 * fire-and-forget: failures never block the UI.
 */

import type {
  AuditAction,
  AuditCycleContext,
  NewAuditLog,
} from '@/lib/supabase/audit-log';

export type WizardAuditPayload = {
  action: AuditAction | string;
  resource: string;
  resource_id?: string | null;
  details?: Record<string, unknown> | null;
  cycle?: AuditCycleContext | null;
  /** Operator email/name. Defaults to "anonymous" if not provided. */
  user_name?: string | null;
  /** Operator role tag — use the session RBAC role, never a hardcoded string. */
  user_role?: string | null;
};

/** Merge cycle context into a details JSONB blob without clobbering caller keys. */
export function withCycleContext(
  details: Record<string, unknown> | null | undefined,
  cycle: AuditCycleContext | null | undefined,
): Record<string, unknown> {
  const base: Record<string, unknown> = { ...(details ?? {}) };
  if (cycle && typeof cycle === 'object') {
    base.cycle = {
      source_file: cycle.source_file ?? null,
      period_start: cycle.period_start ?? null,
      period_end: cycle.period_end ?? null,
      cycle_id: cycle.cycle_id ?? null,
      fx_rate: cycle.fx_rate ?? null,
    };
  }
  return base;
}

/**
 * Fire-and-forget audit POST. Never throws. Use this everywhere on the client.
 *
 * Returns a Promise that resolves with `{ ok: boolean }` so callers can await
 * if they want to chain UI feedback — but the typical pattern is `void logAudit(...)`.
 */
export async function logAudit(payload: WizardAuditPayload): Promise<{ ok: boolean }> {
  try {
    const body: NewAuditLog = {
      user_name: payload.user_name?.trim() || 'anonymous',
      user_role: payload.user_role?.trim() || 'user',
      action: payload.action,
      resource: payload.resource,
      resource_id: payload.resource_id ?? null,
      details: withCycleContext(payload.details, payload.cycle),
    };
    const res = await fetch('/api/audit-log', {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      keepalive: true,
    });
    return { ok: res.ok };
  } catch {
    return { ok: false };
  }
}

/**
 * Convenience wrapper that bakes operator + cycle into a reusable logger,
 * so wizard call sites don't have to re-thread context on every call.
 */
export function createWizardLogger(opts: {
  user_name: string | null | undefined;
  user_role?: string | null | undefined;
  cycle: AuditCycleContext | null | undefined;
}) {
  return function logWizard(
    action: AuditAction | string,
    resource: string,
    extra?: {
      resource_id?: string | null;
      details?: Record<string, unknown> | null;
    },
  ): Promise<{ ok: boolean }> {
    return logAudit({
      user_name: opts.user_name ?? null,
      user_role: opts.user_role ?? 'user',
      cycle: opts.cycle ?? null,
      action,
      resource,
      resource_id: extra?.resource_id ?? null,
      details: extra?.details ?? null,
    });
  };
}

/**
 * Stable JSON-friendly value compare for "old vs new" edit detection.
 * Returns true when the values are meaningfully different (skips logging no-ops).
 */
export function valuesDiffer(a: unknown, b: unknown): boolean {
  if (a === b) return false;
  if (a == null && b == null) return false;
  try {
    return JSON.stringify(a) !== JSON.stringify(b);
  } catch {
    return a !== b;
  }
}
