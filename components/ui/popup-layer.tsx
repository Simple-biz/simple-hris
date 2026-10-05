'use client';

import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import { intersectBoxes, isClipped, placePopup, toContainingBlock, type Box } from '@/lib/ui/popup-placement';

/**
 * Where an escaped popup mounts instead of <body>: a Base UI dialog popup, any other
 * `role="dialog"` surface, or anything that opts in with `data-popup-host`. Staying
 * inside the dialog's DOM keeps focus traps and outside-press dismissal treating the
 * popup as dialog content.
 */
const HOST_SELECTOR = '[data-slot="dialog-content"], [role="dialog"], [data-popup-host]';

/** Theme scopes a popup must carry when it leaves the subtree that applied them
 *  (ui-standards § 1.4: a portaled surface re-applies `tickets-theme dark`). */
const THEME_SCOPES = ['dark', 'tickets-theme'] as const;

/** The z-index SmoothSelect's portal always painted at: above dialogs (z-50) and the collab rail (z-60). */
const Z_FLOOR = 70;

const PAD = 8;

interface Layer {
  host: HTMLElement;
  scope: string;
  zIndex: number;
  /** The trigger's width when the popup escaped — a menu is never narrower than it. */
  anchorWidth: number;
}

interface Pos {
  top: number;
  left: number;
  fixed: boolean;
  up: boolean;
  maxHeight: number | null;
  maxWidth: number;
}

const samePos = (a: Pos | null, b: Pos) =>
  !!a &&
  a.fixed === b.fixed &&
  a.up === b.up &&
  a.maxHeight === b.maxHeight &&
  a.maxWidth === b.maxWidth &&
  Math.abs(a.top - b.top) < 0.5 &&
  Math.abs(a.left - b.left) < 0.5;

/** The visible padding box of `el` if its overflow can cut off a descendant, else null. */
function clipBoxOf(el: HTMLElement, cs: CSSStyleDeclaration = getComputedStyle(el)): Box | null {
  if (cs.overflowX === 'visible' && cs.overflowY === 'visible') return null;
  const r = el.getBoundingClientRect();
  const top = r.top + el.clientTop;
  const left = r.left + el.clientLeft;
  return { top, left, right: left + el.clientWidth, bottom: top + el.clientHeight };
}

/**
 * Every ancestor of `from` that would clip an in-flow popup. The walk stops at a
 * `position: fixed` ancestor (nothing above it clips its subtree) and at <body>
 * (the page scrolls; it does not cut anything off).
 */
function clipBoxesAbove(from: HTMLElement): Box[] {
  const out: Box[] = [];
  for (let n = from.parentElement; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
    const cs = getComputedStyle(n);
    const clip = clipBoxOf(n, cs);
    if (clip) out.push(clip);
    if (cs.position === 'fixed') break;
  }
  return out;
}

function resolveLayer(anchor: HTMLElement): Layer {
  const host = (anchor.closest(HOST_SELECTOR) as HTMLElement | null) ?? document.body;
  const scope = THEME_SCOPES.filter((c) => anchor.closest(`.${c}`) && !host.closest(`.${c}`)).join(' ');
  let zIndex = Z_FLOOR;
  if (host === document.body) {
    // Paint above whatever overlay the trigger lives in, however high it stacks.
    for (let n: HTMLElement | null = anchor; n && n !== document.body; n = n.parentElement) {
      const z = Number.parseInt(getComputedStyle(n).zIndex, 10);
      if (Number.isFinite(z) && z >= zIndex) zIndex = z + 1;
    }
  }
  return { host, scope, zIndex, anchorWidth: anchor.getBoundingClientRect().width };
}

export interface EscapingPopupOptions {
  open: boolean;
  /** The trigger's positioned wrapper — the in-flow popup's containing block. */
  anchorRef: RefObject<HTMLElement | null>;
  panelRef: RefObject<HTMLElement | null>;
  /** Escape on every open, clipped or not (SmoothSelect's `portal`). */
  force?: boolean;
  align: 'start' | 'end';
  /** Space between trigger and popup once escaped. */
  gap: number;
  /** Escaped popups are at least as wide as the trigger (a menu), or keep their own width (a calendar). */
  matchAnchorWidth?: boolean;
  /** Where the in-flow popup sits, from the trigger's rect and the popup's laid-out size. */
  inFlowBox: (anchor: DOMRect, width: number, height: number) => Box;
}

export interface EscapingPopup {
  /** The popup has left its in-flow spot for a layer. */
  escaped: boolean;
  /** Forced to escape but the layer is not resolved yet: render nothing this pass. */
  pending: boolean;
  /** Opened above the trigger (escaped only). */
  up: boolean;
  /** Position style for the escaped popup; undefined while in flow. */
  style: CSSProperties | undefined;
  /** Call where the popup opens, so it is judged afresh in place. */
  beginOpen: () => void;
  /** Mount `node` in the layer, wrapped in the theme scopes it left behind. */
  portal: (node: ReactNode) => ReactNode;
}

/**
 * Keeps a picker's popup whole. It opens in place; if an ancestor would clip it, it
 * moves — before the first paint — into the nearest dialog popup (or <body>), placed
 * under the trigger, flipped or height-capped to fit, and kept anchored on scroll,
 * resize and content changes. Geometry: `src/lib/ui/popup-placement.ts`.
 */
export function useEscapingPopup({
  open,
  anchorRef,
  panelRef,
  force = false,
  align,
  gap,
  matchAnchorWidth = false,
  inFlowBox,
}: EscapingPopupOptions): EscapingPopup {
  const [layer, setLayer] = useState<Layer | null>(null);
  const [pos, setPos] = useState<Pos | null>(null);
  // Read inside the judging effect without re-running it on every render while open.
  const inFlowRef = useRef(inFlowBox);
  useLayoutEffect(() => {
    inFlowRef.current = inFlowBox;
  });

  const beginOpen = useCallback(() => {
    setLayer(null);
    setPos(null);
  }, []);

  // Judge: does the popup, drawn in place, fit inside every clipping ancestor?
  useLayoutEffect(() => {
    if (!open || layer) return;
    const anchor = anchorRef.current;
    if (!anchor) return;
    if (force) {
      setLayer(resolveLayer(anchor));
      return;
    }
    const panel = panelRef.current;
    if (!panel) return;
    const box = inFlowRef.current(anchor.getBoundingClientRect(), panel.offsetWidth, panel.offsetHeight);
    if (isClipped(box, clipBoxesAbove(anchor))) setLayer(resolveLayer(anchor));
  }, [open, layer, force, anchorRef, panelRef]);

  // Place the escaped popup and keep it on the trigger.
  useLayoutEffect(() => {
    if (!open || !layer) return;
    const isBody = layer.host === document.body;
    const update = () => {
      const anchor = anchorRef.current;
      const panel = panelRef.current;
      if (!anchor || !panel) return;
      const root = document.documentElement;
      const viewport: Box = { top: 0, left: 0, right: root.clientWidth, bottom: root.clientHeight };
      const hostClip = isBody ? null : clipBoxOf(layer.host);
      const bounds = hostClip ? intersectBoxes(viewport, hostClip) : viewport;
      // Natural height even while capped: content height plus the borders.
      const height = panel.scrollHeight + (panel.offsetHeight - panel.clientHeight);
      const p = placePopup({
        anchor: anchor.getBoundingClientRect(),
        width: panel.offsetWidth,
        height,
        bounds,
        align,
        gap,
        pad: PAD,
      });
      let { top, left } = p;
      let fixed = true;
      const cb = isBody ? null : (panel.offsetParent as HTMLElement | null);
      if (cb) {
        ({ top, left } = toContainingBlock(p, {
          rect: cb.getBoundingClientRect(),
          clientTop: cb.clientTop,
          clientLeft: cb.clientLeft,
          scrollTop: cb.scrollTop,
          scrollLeft: cb.scrollLeft,
        }));
        fixed = false;
      }
      const next: Pos = {
        top,
        left,
        fixed,
        up: p.up,
        maxHeight: p.maxHeight,
        maxWidth: Math.max(0, bounds.right - bounds.left - PAD * 2),
      };
      setPos((prev) => (samePos(prev, next) ? prev : next));
    };
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    // A filtered list, a month ↔ year view switch: the popup's size changes under it.
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    if (panelRef.current) ro?.observe(panelRef.current);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
      ro?.disconnect();
    };
  }, [open, layer, align, gap, anchorRef, panelRef]);

  let style: CSSProperties | undefined;
  if (layer) {
    const minWidth = matchAnchorWidth ? layer.anchorWidth : undefined;
    style = pos
      ? {
          position: pos.fixed ? 'fixed' : 'absolute',
          top: pos.top,
          left: pos.left,
          minWidth,
          maxWidth: pos.maxWidth,
          maxHeight: pos.maxHeight ?? undefined,
          overflowY: pos.maxHeight != null ? 'auto' : undefined,
          zIndex: layer.zIndex,
        }
      : {
          // Laid out but unseen for one measuring pass, before the first paint.
          position: layer.host === document.body ? 'fixed' : 'absolute',
          top: 0,
          left: 0,
          minWidth,
          visibility: 'hidden',
          zIndex: layer.zIndex,
        };
  }

  const portal = useCallback(
    (node: ReactNode) =>
      layer ? createPortal(<div className={cn('contents', layer.scope)}>{node}</div>, layer.host) : null,
    [layer],
  );

  return {
    escaped: layer !== null,
    pending: force && open && layer === null,
    up: !!(layer && pos?.up),
    style,
    beginOpen,
    portal,
  };
}
