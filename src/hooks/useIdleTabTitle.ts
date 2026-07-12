'use client';

import { useEffect } from 'react';

/**
 * Swaps the browser tab title to a nudge (default: "Get back to work") whenever
 * the current tab loses focus — the user switches to another tab, minimizes the
 * window, or alt-tabs to another app — and restores the real title the instant
 * they come back.
 *
 * Two signals drive it, because neither alone covers every "away":
 *   - `visibilitychange` fires on tab-switch / minimize (document.hidden).
 *   - window `blur`/`focus` catches alt-tabbing to another application while the
 *     browser tab itself is still technically visible.
 *
 * A single `away` latch guards against the two signals both firing on the same
 * transition (which would otherwise re-capture the *nudge* text as the "real"
 * title and never restore it). We snapshot the live title at the moment of
 * leaving, so whatever the page had set is restored exactly.
 */
export function useIdleTabTitle(message = 'Get back to work'): void {
  useEffect(() => {
    if (typeof document === 'undefined') return;

    let realTitle = document.title;
    let away = false;

    const leave = () => {
      if (away) return;
      away = true;
      realTitle = document.title;
      document.title = message;
    };
    const returnBack = () => {
      if (!away) return;
      away = false;
      document.title = realTitle;
    };

    const onVisibility = () => {
      if (document.hidden) leave();
      else returnBack();
    };

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('blur', leave);
    window.addEventListener('focus', returnBack);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', leave);
      window.removeEventListener('focus', returnBack);
      // Never leave a stale nudge behind on unmount.
      document.title = realTitle;
    };
  }, [message]);
}
