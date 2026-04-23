'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  fetchPabPeriodSettings,
  isValidManualPabRange,
  yearMonthKey,
  type PabOverridesMap,
  type PabPeriodFetchResult,
} from '@/lib/pab-period-settings';
import { getCurrentPabMonth, getPabMonthRange } from '@/lib/hubstaff/calendar-column-dedupe';

export function usePabPeriodSettings() {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<PabPeriodFetchResult>({
    manual: false,
    start: null,
    end: null,
    overrides: new Map() as PabOverridesMap,
    activeMonth: null,
    scopeDepartmentKeys: null,
  });

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setData(await fetchPabPeriodSettings());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** Legacy compat — valid single-range from the deprecated manual toggle. */
  const validManualRange = useMemo(
    () => (isValidManualPabRange(data) ? { start: data.start, end: data.end } : null),
    [data],
  );

  /**
   * The month the wizard should display. Falls back to today's PAB month if the
   * user hasn't explicitly set one yet. `isCurrent` reflects whether the active
   * month is today's PAB month.
   */
  const resolvedActiveMonth = useMemo(() => {
    const current = getCurrentPabMonth();
    const active = data.activeMonth ?? current;
    return {
      ...active,
      key: yearMonthKey(active.year, active.month),
      isCurrent: active.year === current.year && active.month === current.month,
    };
  }, [data.activeMonth]);

  /**
   * The PAB range for the active month: override if saved, otherwise the default
   * `getPabMonthRange()` window. Always non-null.
   */
  const activeRange = useMemo(() => {
    const override = data.overrides.get(resolvedActiveMonth.key);
    if (override) {
      return { start: override.start, end: override.end, isOverride: true };
    }
    const r = getPabMonthRange(resolvedActiveMonth.year, resolvedActiveMonth.month);
    return { start: r.start, end: r.end, isOverride: false };
  }, [data.overrides, resolvedActiveMonth]);

  return {
    loading,
    ...data,
    validManualRange,
    activeMonthResolved: resolvedActiveMonth,
    activeRange,
    refresh,
  };
}
