/**
 * Run a theme swap (or any DOM-mutating callback) inside the browser's
 * View Transition, so the change cross-fades instead of snapping.
 * Falls back to calling the callback directly on browsers without support.
 */
interface ViewTransitionLike {
  ready?: Promise<unknown>;
  finished?: Promise<unknown>;
  updateCallbackDone?: Promise<unknown>;
}
type StartViewTransition = (cb: () => void) => ViewTransitionLike;

export function withViewTransition(cb: () => void): void {
  const start = (document as Document & { startViewTransition?: StartViewTransition })
    .startViewTransition;
  if (typeof start !== 'function') {
    cb();
    return;
  }
  try {
    const transition = start.call(document, cb);
    // When a transition is interrupted (a second toggle fires before the first
    // finishes, or the component unmounts mid-navigation), the browser rejects
    // these promises with "InvalidStateError: Transition was aborted because of
    // invalid state". The DOM mutation in `cb` still applies, so the rejection
    // is benign — swallow it so it doesn't surface as an unhandled rejection.
    transition?.ready?.catch(() => {});
    transition?.finished?.catch(() => {});
    transition?.updateCallbackDone?.catch(() => {});
  } catch {
    // startViewTransition can throw synchronously (e.g. document not fully
    // active). Fall back to applying the change directly.
    cb();
  }
}
