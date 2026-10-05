/**
 * Geometry for picker popups — the SmoothSelect menu and the DatePicker /
 * DateRangePicker calendar (`components/ui/popup-layer.ts` is the DOM half).
 *
 * A picker draws its popup in place first. If an ancestor whose overflow is not
 * `visible` (a scrolling dialog body, an `overflow-hidden` card, a table
 * scroller) would cut any of it off, the popup leaves its in-flow spot and is
 * placed here instead: below the trigger, flipped above when it fits there and
 * not below, height-capped (and scrolled) when it fits on neither side, and
 * slid sideways to stay inside the bounds.
 *
 * Pure: every input is a measured number.
 */

export interface Box {
  top: number;
  left: number;
  right: number;
  bottom: number;
}

/**
 * True when `panel` reaches outside any of `clips` — each the visible padding
 * box of an ancestor whose overflow is not `visible`. `tolerance` absorbs
 * sub-pixel rounding, so a menu that sits exactly on a card's edge stays put.
 */
export function isClipped(panel: Box, clips: readonly Box[], tolerance = 1): boolean {
  return clips.some(
    (c) =>
      panel.top < c.top - tolerance ||
      panel.left < c.left - tolerance ||
      panel.bottom > c.bottom + tolerance ||
      panel.right > c.right + tolerance,
  );
}

/** The overlap of two boxes (the viewport and a clipping host). */
export function intersectBoxes(a: Box, b: Box): Box {
  return {
    top: Math.max(a.top, b.top),
    left: Math.max(a.left, b.left),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  };
}

export interface PlacementInput {
  /** The trigger's rect. Same coordinate space as `bounds`. */
  anchor: Box;
  /** The popup's laid-out width and natural (uncapped) height. */
  width: number;
  height: number;
  /** The area the popup must stay inside: the viewport, or the viewport cut
   *  down to a clipping host (a dialog popup that hides its overflow). */
  bounds: Box;
  /** `start` lines the popup's left edge up with the trigger's; `end` its right edge. */
  align: 'start' | 'end';
  /** Space between trigger and popup. */
  gap: number;
  /** Minimum distance kept from every edge of `bounds`. */
  pad: number;
}

export interface Placement {
  top: number;
  left: number;
  /** Opened above the trigger. */
  up: boolean;
  /** Set only when the popup fits on neither side: cap it and let it scroll. */
  maxHeight: number | null;
}

export function placePopup({ anchor, width, height, bounds, align, gap, pad }: PlacementInput): Placement {
  const below = bounds.bottom - pad - (anchor.bottom + gap);
  const above = anchor.top - gap - (bounds.top + pad);
  // Flip only when it doesn't fit below AND (it fits above, or above is simply roomier).
  const up = height > below && (height <= above || above > below);
  const room = Math.max(0, up ? above : below);
  const maxHeight = height > room ? room : null;
  const shown = maxHeight ?? height;
  const top = up ? anchor.top - gap - shown : anchor.bottom + gap;

  const preferred = align === 'start' ? anchor.left : anchor.right - width;
  // Slide back inside the right edge first, then the left edge wins: a popup wider
  // than the bounds starts at the left pad rather than off-screen.
  const left = Math.max(bounds.left + pad, Math.min(preferred, bounds.right - pad - width));

  return { top, left, up, maxHeight };
}

export interface ContainingBlock {
  rect: Pick<Box, 'top' | 'left'>;
  clientTop: number;
  clientLeft: number;
  scrollTop: number;
  scrollLeft: number;
}

/**
 * Viewport coordinates → the `top`/`left` of an `absolute` popup whose containing
 * block is `cb`. Its border is subtracted and its scroll added back, because an
 * absolute child of a scrolled container is laid out against the scrolled content.
 */
export function toContainingBlock(point: { top: number; left: number }, cb: ContainingBlock): { top: number; left: number } {
  return {
    top: point.top - cb.rect.top - cb.clientTop + cb.scrollTop,
    left: point.left - cb.rect.left - cb.clientLeft + cb.scrollLeft,
  };
}
