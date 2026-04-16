'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  fetchPabPeriodSettings,
  isValidManualPabRange,
  type PabPeriodFetchResult,
} from '@/lib/pab-period-settings';

export function usePabPeriodSettings() {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<PabPeriodFetchResult>({
    manual: false,
    start: null,
    end: null,
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

  const validManualRange = useMemo(() => (isValidManualPabRange(data) ? { start: data.start, end: data.end } : null), [data]);

  return { loading, ...data, validManualRange, refresh };
}
