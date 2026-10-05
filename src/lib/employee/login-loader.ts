/**
 * The "Loading your Employee Dashboard" card that covers the employee shell
 * from its cold mount until the Overview is really on screen.
 *
 * Kane, 2026-10-05: *"a loading employee dashboard Modal as the Employee
 * Dashboard is loading similar to switching tabs but this one is the first one
 * when the person logs in"*. The dashboard switch already had one
 * (`DashboardSwitchLoader`, painted by `ViewSwitcher` and every `loading.tsx`);
 * arriving at the employee shell went straight to the Overview's inline skeleton.
 *
 * Three rules this module encodes, each a way the card could go wrong:
 *
 * 1. **It shows on EVERY cold mount of the shell, never only on the sign-in
 *    baton.** It first shipped keyed on `hris_post_login` and Kane could not
 *    find it (*"So where is the loading?"*): a person already signed in reaches
 *    the dashboard via `/` → `/employee` (app/page.tsx), which sets no baton. The
 *    card hides nothing real — the Overview's `if (loading)` skeleton is not
 *    cache-seeded, so a cold mount always starts on a skeleton. Tab switches
 *    inside the shell never remount it, so they never show the card.
 * 2. **It never traps anyone.** Every way the Overview can fail to report ready
 *    has its own lift: the Overview is not the tab on screen (the Pages overlay
 *    hid it and the shell bounced), it is under construction (the placeholder
 *    renders instead and never reports), or the fetches simply hang
 *    (`LOGIN_LOADER_MAX_MS`). A failed load still counts as ready — its error
 *    belongs on the dashboard's own banner, not behind a spinning card.
 * 3. **No minimum display time.** The switch loader "unmounts the instant the
 *    real dashboard is ready", and an artificial 520ms switch delay was removed
 *    on 2026-07-20 because switching felt slow. The card fades out; it does not
 *    linger.
 *
 * Kept as a pure module because tests never execute `.tsx`.
 */
import type { PageVisibility } from '@/lib/pages/visibility';

/**
 * The longest the card may stay up, in ms. Past this it lifts whether or not
 * the Overview reported — the dashboard's own skeletons and connection banner
 * carry whatever is still loading. Raising it only lengthens the worst case of
 * staring at a card; it never makes data arrive sooner.
 */
export const LOGIN_LOADER_MAX_MS = 15_000;

/** The card's fade-out, in seconds. */
export const LOGIN_LOADER_FADE_S = 0.35;

/**
 * Small caps above the title. The switch loader says "Switching to", which is
 * false on arrival — nobody is switching from anything.
 */
export const LOGIN_LOADER_EYEBROW = 'Loading your';

/**
 * The cycling status line. Each one names something the Overview's first load
 * actually does (rates + settings, the week's hours, the pay statement), so the
 * card never claims work that is not happening.
 */
export const LOGIN_LOADER_STATUS_MESSAGES: readonly string[] = [
  'Loading your workspace',
  'Fetching your hours',
  'Preparing your pay week',
  'Almost ready',
];

/** The shell tab the card is waiting on. */
export const LOGIN_LOADER_TAB = 'dashboard';

export interface LoginLoaderLiftInput {
  /** The Overview's essentials AND its first week of hours have settled — success or failure. */
  overviewReady: boolean;
  /** The shell tab on screen. */
  activeTab: string;
  /** The Pages overlay's verdict for the Overview tab. */
  overviewVisibility: PageVisibility;
  /** `LOGIN_LOADER_MAX_MS` has passed since the card went up. */
  timedOut: boolean;
}

/**
 * Whether the card should lift. True as soon as ANY reason holds — there is no
 * reason to hold the card that outranks one to lift it.
 */
export function shouldLiftLoginLoader(input: LoginLoaderLiftInput): boolean {
  if (input.overviewReady) return true;
  if (input.timedOut) return true;
  // The Overview is not what the person will land on — it will never report.
  if (input.activeTab !== LOGIN_LOADER_TAB) return true;
  if (input.overviewVisibility !== 'visible') return true;
  return false;
}

/**
 * The latch: once lifted, the card never comes back. Without it, a card lifted
 * because the shell bounced off a hidden Overview would drop back over the page
 * the moment that tab is shown again before the fetches finish — a loading card
 * appearing over a dashboard the person is already using.
 */
export function loginLoaderLifted(liftedBefore: boolean, input: LoginLoaderLiftInput): boolean {
  return liftedBefore || shouldLiftLoginLoader(input);
}
