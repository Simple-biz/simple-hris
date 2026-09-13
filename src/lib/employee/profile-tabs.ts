/**
 * The ONE home for the Employee Profile's tab and section vocabulary.
 *
 * Before this module the tab union was copied by hand in five places
 * (EmployeeProfile.tsx, EmployeeApp.tsx, EmployeeDashboard.tsx and
 * ProfileCompletionCard.tsx twice), and the deep links named tab ids DIRECTLY.
 * A narrow union still satisfies a wide one, so retiring a tab left the photo,
 * bank and skill-set nudges pointing at ids no render branch matched — and the
 * render chain is a series of bare `activeTab === '…' &&` guards with no
 * default branch, so the employee got a silently empty pane and tsc said
 * nothing. Callers now name an INTENT; this module decides where it lands.
 */

/** The five panes the Profile renders. There is no sixth, and no local copy. */
export type TabId = 'overview' | 'compensation' | 'skills' | 'requestDocuments' | 'resign';

/**
 * ONE section vocabulary for the whole Profile — deliberately not a parallel
 * per-tab type. `PROFILE_SECTIONS` says which tab owns which section, and the
 * resolution test proves each section is claimed exactly once, so a single flat
 * union cannot become ambiguous.
 */
export type SectionId = 'rates' | 'payStubs' | 'payout' | 'skillSets' | 'commendations';

/**
 * What a nudge is ASKING FOR — never where it goes. Callers (the dashboard
 * completion card, the shell's profile-setup navigation) name one of these and
 * stay ignorant of the tab layout, which is what makes a tab merge a one-file
 * change here instead of a silent breakage five files away.
 */
export type ProfileIntent = 'photo' | 'bank' | 'skillSet';

export const PROFILE_TAB_IDS: readonly TabId[] = [
  'overview', 'compensation', 'skills', 'requestDocuments', 'resign',
];

/**
 * Canonical section order per tab. Compensation is the only tab with a visible
 * section strip; for the stacked tabs these are SCROLL ANCHORS, and the
 * resolution test checks membership either way, so a renamed block cannot
 * silently become an unreachable deep-link target.
 */
export const PROFILE_SECTIONS: Record<TabId, readonly SectionId[]> = {
  overview: [],
  compensation: ['rates', 'payStubs', 'payout'],
  skills: ['skillSets', 'commendations'],
  requestDocuments: [],
  resign: [],
};

export const INTENT_TARGET: Record<ProfileIntent, { tab: TabId; section?: SectionId }> = {
  photo: { tab: 'overview' },
  bank: { tab: 'compensation', section: 'payout' },
  skillSet: { tab: 'skills', section: 'skillSets' },
};

/**
 * A resolved deep link. `nonce` exists because the Profile applies this with a
 * value-keyed effect and no visited tab ever unmounts (EmployeeApp.tsx) — so
 * without it, firing the same nudge twice sets state to the value it already
 * holds, React bails out of the re-render, and the employee does not move.
 */
export type ProfileTarget = { tab: TabId; section?: SectionId; nonce: number };

/** Always advances the nonce, so re-firing the same nudge still moves the pane. */
export function nextProfileTarget(prev: ProfileTarget | null, intent: ProfileIntent): ProfileTarget {
  const target = INTENT_TARGET[intent];
  return { tab: target.tab, section: target.section, nonce: (prev?.nonce ?? 0) + 1 };
}

/** Derived, never hand-written — a renamed section cannot leave a stale anchor id behind. */
export function profileSectionDomId(section: SectionId): string {
  return `profile-section-${section}`;
}

/**
 * The id of the TAB BUTTON that controls `profileSectionDomId(section)`.
 *
 * Derived here rather than spelled out at either end because the two ends live
 * in different files — the button in `CompensationSections.tsx`, the panel in
 * `EmployeeProfile.tsx` — and an `aria-controls` that points at nothing is
 * invisible to everyone except the screen-reader user it strands.
 */
export function profileSectionTabDomId(section: SectionId): string {
  return `profile-section-tab-${section}`;
}
