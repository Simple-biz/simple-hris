'use client';

/**
 * Active-roster people who had already LEFT before the pay week being scored,
 * so a KPI calculator can drop them from its member list.
 *
 * `active_employees` cannot answer "has this person left" — `/api/hr/offboard`
 * stamps a `global_master_list` row the roster view does not serve, so the
 * served row keeps `off_boarded_at = null` forever. Measured 2026-09-14: **284
 * of 1,373** active-roster people carry a dated departure record, **188** of
 * them in a QC-scored department. `johna@simple.biz` completed the offboarding
 * pipeline on 2026-07-20 and was still on the Lead Gen calculator seven weeks
 * later. Kane: *"I shouldn't see him in Lead Gen KPI Calculator because he is
 * long gone."*
 *
 * Week-scoped and refetched per week, because the answer changes with the week:
 * somebody who left on 2026-07-20 belongs in June's calculator and not
 * September's. `''` disables it — the calculators pass
 * `weekResolved ? weekStart : ''` so the Monday local-clock seed can never hide
 * anybody.
 *
 * Empty on any failure. Hiding a live person means their KPI bonus is never
 * scored and never paid; showing a departed one is noise.
 */

import { useEffect, useState } from 'react';

const EMPTY: ReadonlySet<string> = new Set<string>();

export function useDepartedMembers(weekStart: string): ReadonlySet<string> {
  const [emails, setEmails] = useState<ReadonlySet<string>>(EMPTY);
  useEffect(() => {
    if (!weekStart) {
      setEmails(EMPTY);
      return;
    }
    let cancelled = false;
    fetch(`/api/manager/departed-members?week=${weekStart}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((j: { emails?: string[] }) => {
        if (!cancelled) setEmails(new Set((j.emails ?? []).map((e) => e.trim().toLowerCase())));
      })
      .catch(() => {
        // Best-effort: nobody is hidden. The list is then exactly what it was
        // before this guard existed, which is noisy but never wrong about money.
        if (!cancelled) setEmails(EMPTY);
      });
    return () => {
      cancelled = true;
    };
  }, [weekStart]);
  return emails;
}

/** True when any of this person's addresses is in the departed set. */
export function isDepartedMember(
  departed: ReadonlySet<string>,
  emails: ReadonlyArray<string | null | undefined>,
): boolean {
  if (departed.size === 0) return false;
  for (const e of emails) {
    const n = (e ?? '').trim().toLowerCase();
    if (n && departed.has(n)) return true;
  }
  return false;
}
