/**
 * Run a theme swap (or any DOM-mutating callback) inside the browser's
 * View Transition, so the change cross-fades instead of snapping.
 * Falls back to calling the callback directly on browsers without support.
 */
type StartViewTransition = (cb: () => void) => unknown;

export function withViewTransition(cb: () => void): void {
  const start = (document as Document & { startViewTransition?: StartViewTransition })
    .startViewTransition;
  if (typeof start === 'function') {
    start.call(document, cb);
    return;
  }
  cb();
}
