'use client';

/**
 * Shared plumbing for surfacing RECENTLY OFFBOARDED people in the KPI bonus
 * calculators (DeptBonusCalculator + HslBonusCalculator), so managers can
 * still score someone's FINAL bonuses after they've left the roster.
 *
 * Data: GET /api/manager/transfer-candidates?offboarded=1 — the union of every
 * offboard record source (see src/lib/roster/recently-offboarded.ts). Each
 * candidate carries `hubstaff_email`: the identity their current hours are
 * keyed on, which is the ONLY key the Payroll Wizard can resolve for someone
 * absent from the active roster (its master-index bridge covers active people
 * only; offboarded entries pay solely via direct Hubstaff-email match). Both
 * calculators must therefore key offboarded adds through
 * {@link offboardedAddEmail}, never the roster's personal-first rule.
 */

import { useEffect, useState } from 'react';
import { UserPlus, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { normEmail } from '@/lib/email/norm-email';

export interface OffboardedCandidate {
  name: string;
  department: string | null;
  work_email: string | null;
  personal_email: string | null;
  /** `YYYY-MM-DD` they left; null when they fell off the roster without a
   *  recorded date (still a recent departure — see the lib doc). */
  off_boarded_at: string | null;
  /** The email their recent Hubstaff hours are keyed on (the payable
   *  identity), when determinable. */
  hubstaff_email: string | null;
}

/**
 * The email an offboarded person must be keyed under so their bonus actually
 * PAYS: Hubstaff login first (direct-match is the only bridge payroll has for
 * off-roster people), then work email (= the Hubstaff login in the normal
 * case). `allowPersonal` mirrors the host surface's rule — the general dept
 * calculator tolerates personal email as a last resort, HSL never does.
 */
export function offboardedAddEmail(c: OffboardedCandidate, allowPersonal: boolean): string {
  return (
    normEmail(c.hubstaff_email ?? null) ||
    normEmail(c.work_email ?? null) ||
    (allowPersonal ? normEmail(c.personal_email ?? null) || '' : '')
  );
}

/** "Left Jul 23" / "Left the roster" chip label. */
export function offboardedLeftLabel(c: OffboardedCandidate): string {
  if (!c.off_boarded_at) return 'Left the roster';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(c.off_boarded_at);
  if (!m) return 'Left the roster';
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  try {
    return `Left ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
  } catch {
    return `Left ${c.off_boarded_at}`;
  }
}

/** Case-insensitive candidate filter for the pickers' search box. */
export function matchesOffboardedQuery(c: OffboardedCandidate, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return [c.name, c.department, c.work_email, c.personal_email, c.hubstaff_email].some(
    (v) => !!v && v.toLowerCase().includes(needle),
  );
}

/**
 * Fetch the offboarded candidates once per surface. Both the per-dept strips
 * and the add-member modal share the result, so the calculators fetch a single
 * time on mount rather than per keystroke (the underlying union reads the last
 * two Hubstaff files — not something to re-run while typing).
 */
export function useOffboardedPeople(enabled: boolean): OffboardedCandidate[] {
  const [people, setPeople] = useState<OffboardedCandidate[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    fetch('/api/manager/transfer-candidates?offboarded=1', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j: { offboarded?: OffboardedCandidate[] }) => {
        if (!cancelled) setPeople(j.offboarded ?? []);
      })
      .catch(() => {
        // Best-effort: the strips/picker group simply don't render. The manual
        // search path (active candidates) is unaffected.
        if (!cancelled) setPeople([]);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return people;
}

/**
 * The per-department "Offboarded" strip: recently-departed members of THIS
 * department, each one click away from joining the calculator table so their
 * final bonuses can be scored. Renders nothing when the list is empty.
 */
export function OffboardedStrip({
  people,
  onAdd,
  disabled,
  allowPersonal = true,
  maxChips = 8,
}: {
  people: OffboardedCandidate[];
  /** Attempt the add; returns an error message to surface, or null on success. */
  onAdd: (c: OffboardedCandidate) => string | null;
  /** True while the week is read-only (submitted / payroll-locked). */
  disabled?: boolean;
  /** Must MATCH the host's add rule (HSL passes false — work email only), so a
   *  chip never advertises/enables an email the add handler will then reject. */
  allowPersonal?: boolean;
  maxChips?: number;
}) {
  const [error, setError] = useState<string | null>(null);
  if (people.length === 0) return null;
  const shown = people.slice(0, maxChips);
  const overflow = people.length - shown.length;

  return (
    <div className="rounded-lg border border-amber-200/80 bg-amber-50/60 px-3 py-2.5 dark:border-amber-500/25 dark:bg-amber-500/[0.07]">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-amber-700 dark:text-amber-300">
          Offboarded ({people.length})
        </span>
        <span className="text-[11px] text-amber-700/80 dark:text-amber-300/70">
          Recently left this team — add them to score their final bonuses; they’re paid with the week that
          covers their last hours.
        </span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {shown.map((c) => {
          const email = offboardedAddEmail(c, allowPersonal);
          return (
            <button
              key={`${c.name}:${email || c.off_boarded_at || ''}`}
              type="button"
              disabled={disabled || !email}
              onClick={() => setError(onAdd(c))}
              title={
                !email
                  ? 'No usable email on file — cannot be added'
                  : disabled
                    ? 'Read-only — the week is submitted or payroll is processing'
                    : `Add ${c.name} to this calculator (${email})`
              }
              className={cn(
                'inline-flex max-w-full items-center gap-1.5 rounded-full border px-2 py-1 text-left transition-colors',
                disabled || !email
                  ? 'cursor-not-allowed border-zinc-200 bg-white/60 opacity-50 dark:border-zinc-700 dark:bg-zinc-900/40'
                  : 'border-amber-300/80 bg-white hover:border-amber-400 hover:bg-amber-100/70 dark:border-amber-500/30 dark:bg-zinc-900/60 dark:hover:bg-amber-500/10',
              )}
            >
              <UserPlus className="h-3 w-3 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
              <span className="truncate text-[11.5px] font-medium text-zinc-800 dark:text-zinc-100">{c.name}</span>
              <span className="shrink-0 font-mono text-[9px] uppercase tracking-wide text-zinc-400">
                {offboardedLeftLabel(c)}
              </span>
            </button>
          );
        })}
        {overflow > 0 && (
          <span className="font-mono text-[10px] text-amber-700/70 dark:text-amber-300/60">
            +{overflow} more — use “Add member” to search them
          </span>
        )}
      </div>
      {error && (
        <p className="mt-1.5 flex items-start gap-1.5 text-[11px] font-medium text-red-600 dark:text-red-400">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden /> {error}
        </p>
      )}
    </div>
  );
}
