'use client';

import { useEffect, useState } from 'react';

/**
 * Debounces a value — returns the latest input only after `delayMs` of
 * inactivity. Use the input directly to drive a controlled `<input>`, and the
 * debounced output to drive expensive work (filtering, fetches, etc).
 *
 * Pair with `value !== debounced` to know whether a debounce is in flight,
 * which is useful for showing a "still typing" indicator.
 */
export function useDebouncedValue<T>(value: T, delayMs = 250): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(id);
  }, [value, delayMs]);

  return debounced;
}
