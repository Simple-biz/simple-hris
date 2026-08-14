/**
 * Per-department company policies — a READ-ONLY mirror of the published pages at
 * https://www.simple.biz/team-company-policies.
 *
 * This module is DISPLAY-ONLY and deliberately drives no logic. Nothing here is
 * read by payroll, attendance, the PAB engine, Hubstaff ingest, or any bonus
 * calculation. It exists so a team member can read their own team's rules in the
 * portal instead of hunting the marketing site — Kane, 2026-08-14: "this will not
 * affect any logic in the system this is mainly read only as to avoid confusion".
 *
 * > **Do not wire a rule in this file into a calculation.** The numbers here are
 * > website copy, and the website is edited by people who are not changing code.
 * > The "40 hours" in {@link OVERTIME_40} is NOT the overtime threshold the
 * > payroll engine uses, and the workday windows are NOT shift definitions.
 *
 * ## Source of truth
 *
 * The website is authoritative for this text; the app mirrors it verbatim. When
 * the site changes, update the bodies here — there is no fetch at runtime (the
 * pages are static marketing copy, and an outbound fetch per page view would be
 * a needless dependency on an external host for content that changes ~never).
 * Captured 2026-08-14.
 *
 * ## Known divergence from the S-Wall panel
 *
 * `SWall.tsx`'s `CompanyPoliciesPanel` still carries an older company-wide set
 * whose Overtime Approval reads "The weekly cap is 45 hours … beyond 45 hours".
 * Every published department page says **40**. That panel is a separate surface
 * and is deliberately left alone here; see docs/features/employee-team-directory.md.
 */

/** Which section of the page a policy belongs to. */
export type PolicySectionId = 'schedule' | 'communication' | 'conduct';

/** Icon key — mapped to a lucide component by the rendering component, so this
 *  module stays free of React imports and is safe to use on the server. */
export type PolicyIconKey =
  | 'clock'
  | 'timer'
  | 'calendar'
  | 'monitor'
  | 'languages'
  | 'video'
  | 'loop'
  | 'inbox'
  | 'shield'
  | 'handshake'
  | 'ban'
  | 'heart'
  | 'unplug';

export interface Policy {
  /** Stable id — used as a React key and for the doc's cross-reference. */
  id: string;
  title: string;
  body: string;
  section: PolicySectionId;
  icon: PolicyIconKey;
}

/* ── Shared policy bodies ───────────────────────────────────────────────────
 * Eleven of the thirteen policies are byte-identical across every published
 * department page, so they are defined once and referenced. Only the workday
 * window, the time-off notice period, and two team-specific additions vary. */

const WORKDAY_9_5: Policy = {
  id: 'workday',
  title: '9 AM to 5 PM Workday',
  body:
    'You are expected to work and be available 9 AM to 5 PM Eastern (NYC time). ' +
    'Quickly reply to requests from customers or team members.',
  section: 'schedule',
  icon: 'clock',
};

/** Editors + Project Management carry an extra PST-coverage line above the window. */
const WORKDAY_9_5_PST: Policy = {
  ...WORKDAY_9_5,
  body:
    '11 AM to 7 PM for PST Customer Coverage. You are expected to work and be available ' +
    '9 AM to 5 PM Eastern (NYC time). Quickly reply to requests from customers or team members.',
};

const WORKDAY_750_4: Policy = {
  id: 'workday',
  title: '7:50 AM to 4:00 PM Workday',
  body:
    'You are expected to work and be available 7:50 AM to 4:00 PM Eastern (NYC time). ' +
    'Quickly reply to requests from customers or team members.',
  section: 'schedule',
  icon: 'clock',
};

/** Display copy only — never the payroll overtime threshold. */
const OVERTIME_40: Policy = {
  id: 'overtime',
  title: 'Overtime Approval',
  body: 'You must get approval for overtime beyond 40 hours per week.',
  section: 'schedule',
  icon: 'timer',
};

const TRACKING: Policy = {
  id: 'tracking',
  title: 'Time/Screen Tracking',
  body:
    'Clock in when you’re working. Clock out when you’re on a break. Review your ' +
    'screenshots, ensure your work matches what is shown, and provide receipts if anything ' +
    'appears incorrect.',
  section: 'schedule',
  icon: 'monitor',
};

const ATTENDANCE_1W: Policy = {
  id: 'attendance',
  title: 'Attendance Policies',
  body:
    'Reach out to us at least one week in advance for planned time off. You will receive a ' +
    'bonus if you do not miss a workday.',
  section: 'schedule',
  icon: 'calendar',
};

/** AI/Automation asks for two weeks and spells out the 7-hour qualifying day. */
const ATTENDANCE_2W_7H: Policy = {
  ...ATTENDANCE_1W,
  body:
    'Reach out to us two weeks in advance for planned time off. You will receive a bonus if ' +
    'you do not miss a workday (requires working at least 7 hours on all five days of the ' +
    'work week).',
};

const ENGLISH_ONLY: Policy = {
  id: 'english',
  title: 'English Only',
  body: 'Always use English in all company communications.',
  section: 'communication',
  icon: 'languages',
};

const CAMERAS_ON: Policy = {
  id: 'cameras',
  title: 'Cameras On',
  body:
    'Cameras must be on for every meeting. Your full face must be visible on camera at all times.',
  section: 'communication',
  icon: 'video',
};

const CLOSE_THE_LOOP: Policy = {
  id: 'close-the-loop',
  title: 'Always Close the Loop',
  body:
    'Overcommunicate between team members and clients. We always want to keep our team ' +
    'members and clients updated every step of the way.',
  section: 'communication',
  icon: 'loop',
};

/** Editors + Lead Gen are internal-facing — their copy drops the client half. */
const CLOSE_THE_LOOP_TEAM_ONLY: Policy = {
  ...CLOSE_THE_LOOP,
  body:
    'Overcommunicate with team members. We always want to keep our team members updated ' +
    'every step of the way.',
};

/** AI/Automation only. */
const INBOX_ZERO: Policy = {
  id: 'inbox',
  title: 'Email Inbox Maintenance',
  body:
    'You must maintain a clean, zero-inbox. Answer and archive emails as soon as they arrive ' +
    'in your inbox.',
  section: 'communication',
  icon: 'inbox',
};

const RESPONSIBILITY: Policy = {
  id: 'responsibility',
  title: 'Take Responsibility for Mistakes',
  body: 'We do not make excuses. We take responsibility for our mistakes.',
  section: 'conduct',
  icon: 'shield',
};

const BE_HUMBLE: Policy = {
  id: 'humble',
  title: 'Be Humble',
  body: 'Avoid talking down to others. Do unto others what you would have others do unto you.',
  section: 'conduct',
  icon: 'handshake',
};

const NO_SOLICITING: Policy = {
  id: 'soliciting',
  title: 'No Soliciting',
  body: 'No lending, borrowing, buying, or selling among team members.',
  section: 'conduct',
  icon: 'ban',
};

const NO_FLIRTING: Policy = {
  id: 'flirting',
  title: 'No Flirting',
  body:
    'No flirting, intrusive questioning, or other interactions that may be interpreted as ' +
    'approach behaviors for dating.',
  section: 'conduct',
  icon: 'heart',
};

const OUTSIDE_TOOLS: Policy = {
  id: 'outside-tools',
  title: 'Outside Tools/Websites',
  body:
    'Please refrain from using social media, games, streaming services while on the clock. ' +
    'The use of services that provide music is fine as long as it is not a distraction.',
  section: 'conduct',
  icon: 'unplug',
};

/** The ten policies every published page carries identically. */
const UNIVERSAL: Policy[] = [
  OVERTIME_40,
  TRACKING,
  ENGLISH_ONLY,
  CAMERAS_ON,
  RESPONSIBILITY,
  BE_HUMBLE,
  NO_SOLICITING,
  NO_FLIRTING,
  OUTSIDE_TOOLS,
];

/* ── Per-department sets ────────────────────────────────────────────────── */

export interface DepartmentPolicySet {
  /** Payroll department key this set is published for, or null for the fallback. */
  deptKey: string | null;
  /** How the website names the team (may differ from the roster label — the
   *  roster says "AI/API Team", the policy site says "AI/Automation"). */
  teamLabel: string;
  /** The published page this text mirrors. null for the company-wide fallback. */
  sourceUrl: string | null;
  policies: Policy[];
}

const SITE_ROOT = 'https://www.simple.biz';

/**
 * Keyed by payroll department key (see `normalizeDeptToKey`). Ten of the roster's
 * departments have a published page; everything else falls back to
 * {@link COMPANY_WIDE_POLICIES}.
 */
const BY_DEPT_KEY: Record<string, DepartmentPolicySet> = {
  devs: {
    deptKey: 'devs',
    teamLabel: 'AI/Automation',
    sourceUrl: `${SITE_ROOT}/AI-Automation-Team-Company-Policies`,
    policies: [WORKDAY_9_5, ATTENDANCE_2W_7H, INBOX_ZERO, CLOSE_THE_LOOP, ...UNIVERSAL],
  },
  accounting: {
    deptKey: 'accounting',
    teamLabel: 'Accounting',
    sourceUrl: `${SITE_ROOT}/accounting-team-company-policies`,
    policies: [WORKDAY_9_5, ATTENDANCE_1W, CLOSE_THE_LOOP, ...UNIVERSAL],
  },
  callback: {
    deptKey: 'callback',
    teamLabel: 'Call Back',
    sourceUrl: `${SITE_ROOT}/call-back-team-company-policies`,
    policies: [WORKDAY_750_4, ATTENDANCE_1W, CLOSE_THE_LOOP, ...UNIVERSAL],
  },
  discovery: {
    deptKey: 'discovery',
    teamLabel: 'Discovery',
    sourceUrl: `${SITE_ROOT}/discovery-team-company-policies`,
    policies: [WORKDAY_750_4, ATTENDANCE_1W, CLOSE_THE_LOOP, ...UNIVERSAL],
  },
  edit: {
    deptKey: 'edit',
    teamLabel: 'Editors',
    sourceUrl: `${SITE_ROOT}/edit-team-company-policies`,
    policies: [WORKDAY_9_5_PST, ATTENDANCE_1W, CLOSE_THE_LOOP_TEAM_ONLY, ...UNIVERSAL],
  },
  lead_gen: {
    deptKey: 'lead_gen',
    teamLabel: 'Lead Gen',
    sourceUrl: `${SITE_ROOT}/lead-gen-company-policies`,
    policies: [WORKDAY_750_4, ATTENDANCE_1W, CLOSE_THE_LOOP_TEAM_ONLY, ...UNIVERSAL],
  },
  pm_team: {
    deptKey: 'pm_team',
    teamLabel: 'Project Management',
    sourceUrl: `${SITE_ROOT}/project-management-team-company-policies`,
    policies: [WORKDAY_9_5_PST, ATTENDANCE_1W, CLOSE_THE_LOOP, ...UNIVERSAL],
  },
  qc: {
    deptKey: 'qc',
    teamLabel: 'QC',
    sourceUrl: `${SITE_ROOT}/qc-team-company-policies`,
    policies: [WORKDAY_750_4, ATTENDANCE_1W, CLOSE_THE_LOOP, ...UNIVERSAL],
  },
  sales_assistant: {
    deptKey: 'sales_assistant',
    teamLabel: 'Sales Assistants',
    sourceUrl: `${SITE_ROOT}/sales-assistants-team-company-policies`,
    policies: [WORKDAY_9_5, ATTENDANCE_1W, CLOSE_THE_LOOP, ...UNIVERSAL],
  },
  smm: {
    deptKey: 'smm',
    teamLabel: 'Social Media',
    sourceUrl: `${SITE_ROOT}/social-media-team-company-policies`,
    policies: [WORKDAY_9_5, ATTENDANCE_1W, CLOSE_THE_LOOP, ...UNIVERSAL],
  },
};

/**
 * Shown to the ~15 roster departments with no published page (HSL sub-teams,
 * Client VA, HR, Site Building, Smart Staff, Sales, Executive Assistants, …).
 *
 * Deliberately omits the **workday window** and the **time-off notice period**:
 * those are the two policies that genuinely differ per team, and inventing a
 * default would tell someone the wrong shift. The ten universal rules are shown
 * with a note pointing at their manager.
 */
export const COMPANY_WIDE_POLICIES: DepartmentPolicySet = {
  deptKey: null,
  teamLabel: 'Company-wide',
  sourceUrl: null,
  policies: [CLOSE_THE_LOOP, ...UNIVERSAL],
};

/**
 * The policy set for a payroll department key.
 *
 * Returns {@link COMPANY_WIDE_POLICIES} for a null/unknown key — every employee
 * sees something, and the caller can tell the two apart via `deptKey === null`.
 */
export function policiesForDeptKey(deptKey: string | null | undefined): DepartmentPolicySet {
  if (!deptKey) return COMPANY_WIDE_POLICIES;
  return BY_DEPT_KEY[deptKey] ?? COMPANY_WIDE_POLICIES;
}

/** Department keys with a published, team-specific page. */
export function departmentsWithPublishedPolicies(): string[] {
  return Object.keys(BY_DEPT_KEY);
}

/** Section metadata, in render order. */
export const POLICY_SECTIONS: {
  id: PolicySectionId;
  label: string;
  description: string;
}[] = [
  {
    id: 'schedule',
    label: 'Work schedule & availability',
    description: 'When and how you should be reachable.',
  },
  {
    id: 'communication',
    label: 'Communication',
    description: 'How we talk to teammates and clients.',
  },
  {
    id: 'conduct',
    label: 'Conduct & culture',
    description: 'How we treat each other day to day.',
  },
];

/** Group a set's policies into {@link POLICY_SECTIONS} order, dropping empties. */
export function groupPolicies(
  set: DepartmentPolicySet,
): { id: PolicySectionId; label: string; description: string; policies: Policy[] }[] {
  return POLICY_SECTIONS.map((s) => ({
    ...s,
    policies: set.policies.filter((p) => p.section === s.id),
  })).filter((s) => s.policies.length > 0);
}
