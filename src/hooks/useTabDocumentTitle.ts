'use client';

import { useEffect } from 'react';

/**
 * Keeps the browser tab title in sync with the active dashboard tab,
 * e.g. "Payroll Wizard - HRIS". Every dashboard shell calls this with the
 * same humanized label it publishes to presence, so the tab title always
 * matches where the user actually is.
 */
export function useTabDocumentTitle(label: string | null | undefined): void {
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const trimmed = (label ?? '').trim();
    document.title = trimmed ? `${trimmed} - HRIS` : 'HRIS';
  }, [label]);
}
