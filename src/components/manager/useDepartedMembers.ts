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
 *
 * ## Seeded from the KPI cache (2026-10-05)
 *
 * The moment a week arrives, the set is seeded from the last CLEAN answer for
 * that same week, so the table drops its leavers when the week resolves instead
 * of a further round trip later (~158 rows on Lead Gen). Still nothing before
 * the week resolves — `''` stays empty, so the seed can never hide anybody. The
 * fetch still runs every time and still wins, and a failure still hides nobody:
 * the cached set never outlives a failed read.
 *
 * An unchanged live answer keeps the SAME `Set`. The calculator's per-dept loads
 * are keyed on the roster this filters, so a new-but-equal `Set` re-fetched every
 * department a second time on every visit.
 */

import { useEffect, useState } from 'react';

import { KPI_CACHE_KEYS, getKpiCache, setKpiCache } from '@/lib/manager/kpi-cache';
import { departedMembersResponse, sameEmailSet } from '@/lib/manager/kpi-cache-payloads';

const EMPTY: ReadonlySet<string> = new Set<string>();

function cachedSet(week: string): ReadonlySet<string> {
  if (!week) return EMPTY;
  const cached = getKpiCache<string[]>(KPI_CACHE_KEYS.departedMembers(week));
  return Array.isArray(cached) && cached.length > 0 ? new Set(cached) : EMPTY;
}

export function useDepartedMembers(weekStart: string): ReadonlySet<string> {
  const [shown, setShown] = useState<{ week: string; emails: ReadonlySet<string> }>(() => ({
    week: weekStart,
    emails: cachedSet(weekStart),
  }));
  // A different week is a different answer: reseed during render, so the table
  // never filters one week's rows with another week's hide-list.
  let current = shown;
  if (shown.week !== weekStart) {
    current = { week: weekStart, emails: cachedSet(weekStart) };
    setShown(current);
  }

  useEffect(() => {
    if (!weekStart) return;
    let cancelled = false;
    const apply = (emails: ReadonlySet<string>) =>
      setShown((prev) =>
        prev.week !== weekStart ? prev : sameEmailSet(prev.emails, emails) ? prev : { week: weekStart, emails },
      );
    void (async () => {
      try {
        const res = await fetch(`/api/manager/departed-members?week=${weekStart}`, { cache: 'no-store' });
        const json: unknown = await res.json().catch(() => null);
        if (cancelled) return;
        const answer = departedMembersResponse(res.ok, json);
        if (answer.cacheable) setKpiCache(KPI_CACHE_KEYS.departedMembers(weekStart), answer.emails);
        apply(answer.emails.length > 0 ? new Set(answer.emails) : EMPTY);
      } catch {
        // Best-effort: nobody is hidden. The list is then exactly what it was
        // before this guard existed, which is noisy but never wrong about money.
        if (!cancelled) apply(EMPTY);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [weekStart]);

  return current.emails;
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
