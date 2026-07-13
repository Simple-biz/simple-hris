'use client';

import { Eye } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';

/**
 * Wraps a dashboard tab's content and makes it non-interactive when the viewer
 * only has `view` (not `edit`) access to that feature.
 *
 * We deliberately do NOT use the `inert` attribute here: `inert` is
 * all-or-nothing on a subtree and cannot be re-enabled on a descendant, so it
 * would also kill read-only-safe controls like search/filter boxes. Instead a
 * capture-phase listener on the wrapper swallows every *mutating* interaction
 * (clicks, key presses, typing, paste, drag/drop, submit) before it can reach a
 * child handler — including custom `onClick` divs, since stopping propagation in
 * the capture phase prevents the event from ever reaching the target or bubbling
 * back up to React's delegated root listener.
 *
 * Carve-out: read-only *navigation* stays fully live so a viewer can still move
 * around what they're allowed to see — they just can't mutate it. That means:
 *   - anything inside an element marked `data-readonly-allow` (explicit opt-in,
 *     e.g. pagination bars);
 *   - ARIA tab controls (`[role="tab"]`, `[role="tablist"]`) — the in-page
 *     sub-tab switchers that let a viewer flip between views of the same data;
 *   - native search inputs (`input[type="search"]`, `[role="searchbox"]`).
 * Scrolling and wheel gestures are never blocked.
 *
 * Note we deliberately do NOT exempt `[role="tabpanel"]`: that's the tab's
 * *content*, and exempting it would unblock the whole subtree. Only the
 * switcher controls (tab / tablist) are navigation.
 *
 * Dialogs portaled to `document.body` render outside this subtree, so a tab's
 * dialog triggers must stay inside the wrapper (the trigger click is then
 * swallowed and the portal can't open). The server-side feature check
 * (`requireFeatureEdit`) is the authoritative guard regardless.
 */

/**
 * Elements (and their descendants) that stay interactive in read-only mode.
 * Mark any wrapper with `data-readonly-allow` to opt a region in explicitly;
 * ARIA tab controls are recognised automatically so in-page sub-tab navigation
 * keeps working for view-only users.
 */
const ALLOW_SELECTOR = [
  '[data-readonly-allow]',
  '[role="tab"]',
  '[role="tablist"]',
  'input[type="search"]',
  '[role="searchbox"]',
].join(', ');

/**
 * Heuristic carve-out so existing search/filter boxes stay live without a
 * per-input sweep: a text field whose placeholder or aria-label reads like a
 * search/filter. Failure modes are benign — a stray non-search field staying
 * editable is still blocked at the server for protected routes, and a real edit
 * field never reads "search"/"filter". Prefer `data-readonly-allow` for new code.
 */
function looksLikeSearchField(el: Element): boolean {
  const tag = el.tagName;
  if (tag !== 'INPUT' && tag !== 'TEXTAREA') return false;
  const hint = `${el.getAttribute('placeholder') ?? ''} ${el.getAttribute('aria-label') ?? ''}`.toLowerCase();
  return /\b(search|filter)\b/.test(hint);
}

function isReadOnlyAllowed(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (typeof target.closest === 'function' && target.closest(ALLOW_SELECTOR)) return true;
  return looksLikeSearchField(target);
}

/**
 * Interaction events that can cause an edit/mutation. Read-only gestures
 * (scroll, wheel, pointermove, keyup, copy) are intentionally absent so the
 * page still scrolls.
 */
const BLOCKED_EVENTS = [
  'pointerdown',
  'mousedown',
  'mouseup',
  'click',
  'dblclick',
  'keydown',
  'keypress',
  'beforeinput',
  'input',
  'change',
  'paste',
  'cut',
  'drop',
  'dragstart',
  'submit',
  'contextmenu',
] as const;

export default function ReadOnlyTab({
  readOnly,
  children,
  className,
}: {
  readOnly: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!readOnly) return;
    const node = ref.current;
    if (!node) return;

    const swallow = (e: Event) => {
      // Let read-only-safe controls (search / filter) work as normal.
      if (isReadOnlyAllowed(e.target)) return;
      e.stopPropagation();
      if (e.cancelable) e.preventDefault();
    };

    for (const type of BLOCKED_EVENTS) node.addEventListener(type, swallow, true);
    return () => {
      for (const type of BLOCKED_EVENTS) node.removeEventListener(type, swallow, true);
    };
  }, [readOnly]);

  if (!readOnly) return <>{children}</>;
  return (
    <div className={cn('flex min-h-0 flex-1 flex-col', className)}>
      <div className="flex shrink-0 items-center gap-2 border-b border-amber-200/80 bg-amber-50/90 px-4 py-2 text-[12px] font-medium text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">
        <Eye className="h-3.5 w-3.5 shrink-0" aria-hidden />
        View only &mdash; you can browse and search, but you don&apos;t have edit access to this tab.
      </div>
      <div ref={ref} aria-disabled className="flex min-h-0 flex-1 flex-col opacity-95">
        {children}
      </div>
    </div>
  );
}
