'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Global collapsed/expanded state for the dashboard sidebars.
 *
 * The preference is shared across every dashboard (Accounting, HR, Manager, CEO,
 * Employee, Admin, …) so collapsing the rail in one view keeps it collapsed when
 * you switch views. It is persisted to `localStorage` and kept in sync between
 * multiple mounts (and browser tabs) via the `storage` event plus a same-document
 * custom event.
 *
 * Collapse is a *desktop* affordance — on mobile the sidebar is a full-width
 * drawer and every consumer scopes the collapsed styling to `md:` so the mobile
 * drawer always renders in full regardless of this flag.
 */
const STORAGE_KEY = 'hris:sidebar:collapsed';
const CHANGE_EVENT = 'hris:sidebar:collapsed-change';

function readStored(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export interface UseSidebarCollapsed {
  collapsed: boolean;
  setCollapsed: (value: boolean) => void;
  toggle: () => void;
  /** False during SSR and the first client paint; true once localStorage is read. */
  hydrated: boolean;
}

export function useSidebarCollapsed(): UseSidebarCollapsed {
  // Always start expanded so server and first client render agree (no hydration
  // mismatch). The stored preference is applied in the effect below.
  const [collapsed, setCollapsedState] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setCollapsedState(readStored());
    setHydrated(true);
    const sync = () => setCollapsedState(readStored());
    window.addEventListener('storage', sync);
    window.addEventListener(CHANGE_EVENT, sync as EventListener);
    return () => {
      window.removeEventListener('storage', sync);
      window.removeEventListener(CHANGE_EVENT, sync as EventListener);
    };
  }, []);

  const setCollapsed = useCallback((value: boolean) => {
    setCollapsedState(value);
    try {
      window.localStorage.setItem(STORAGE_KEY, value ? '1' : '0');
    } catch {
      /* ignore */
    }
    try {
      // Notify other hook instances mounted in this same document.
      window.dispatchEvent(new Event(CHANGE_EVENT));
    } catch {
      /* ignore */
    }
  }, []);

  // Read the freshest persisted value so a memoized toggle never flips a stale
  // closure value when several instances are mounted.
  const toggle = useCallback(() => setCollapsed(!readStored()), [setCollapsed]);

  return { collapsed, setCollapsed, toggle, hydrated };
}
