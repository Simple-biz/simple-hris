/**
 * The Accounting Scoreboard's board-local roles (Open item 393, 2026-10-07). Pure, so the server and the
 * client ask the same table.
 *
 * Carla: Team member edits everything except Setup; Assistant sees Setup but can't change it and sees
 * everyone's tasks; Admin has full write. Three roles, not an edit / view / hidden matrix ("Nah.").
 *
 * Who is what (`resolveBoardRole`):
 * - an HRIS `admin` is ALWAYS a board Admin: the break glass, so the board can never be locked out of
 *   Setup (plan Review Focus 3);
 * - else a live grant in `accounting_scoreboard_roles` (Admin or Assistant) is the role, and it is
 *   membership on its own;
 * - else anyone on the member list (a live person row, or `accounting_scoreboard_members`) is a Team member;
 * - else nobody: HRIS `accounting` alone lets no one in and makes no one a manager (Kane, 2026-10-07). Until
 *   then "managers are the admin and accounting roles".
 *
 * Governing doc: docs/features/accounting-scoreboard.md § Who may open it.
 */

export const BOARD_ROLES = ['admin', 'assistant', 'member'] as const;
export type BoardRole = (typeof BOARD_ROLES)[number];
export type GrantRole = Exclude<BoardRole, 'member'>;

export const BOARD_ACTIONS = [
  /** Type into the grids (entries PUT). */
  'edit_cells',
  /** Log collections and problems, tick Payment Verified, delete or uncheck one's own. */
  'log_lines',
  /** Delete anyone's logged collection or problem. */
  'delete_any_line',
  /** Uncheck anyone's Payment Verified tick. */
  'unverify_any',
  /** See Setup (rows, sections, problem types, members), read-only. */
  'view_setup',
  /** Change anything in Setup, including members and the roster picker. */
  'edit_setup',
  /** Task boards (plan Task 7): see everyone's, and add or remove tasks. */
  'view_all_tasks',
  'manage_tasks',
  /** The weekly lock-in (plan Task 5). */
  'lock_week',
  'reopen_week',
  /** Grant and revoke Admin / Assistant. */
  'manage_roles',
  /** Setup → Keys (Open item 424): see and change who holds a seat on which paid platform. Admin only, reading too. */
  'manage_keys',
] as const;
export type BoardAction = (typeof BOARD_ACTIONS)[number];

const MEMBER: readonly BoardAction[] = ['edit_cells', 'log_lines'];
const ASSISTANT: readonly BoardAction[] = [...MEMBER, 'view_setup', 'view_all_tasks'];
const ADMIN: readonly BoardAction[] = BOARD_ACTIONS;

const TABLE: Record<BoardRole, ReadonlySet<BoardAction>> = {
  member: new Set(MEMBER),
  assistant: new Set(ASSISTANT),
  admin: new Set(ADMIN),
};

export const ROLE_LABEL: Record<BoardRole, string> = {
  admin: 'Admin',
  assistant: 'Assistant',
  member: 'Team member',
};

export function can(role: BoardRole, action: BoardAction): boolean {
  return TABLE[role].has(action);
}

export function isBoardRole(value: unknown): value is BoardRole {
  return typeof value === 'string' && (BOARD_ROLES as readonly string[]).includes(value);
}

/** Of one person's live grants (one per address they sign in with), the higher one. */
export function highestGrant(grants: readonly GrantRole[]): GrantRole | null {
  if (grants.includes('admin')) return 'admin';
  return grants.includes('assistant') ? 'assistant' : null;
}

export function resolveBoardRole(i: {
  hrisRoles: readonly string[];
  grant: GrantRole | null;
  isMember: boolean;
}): BoardRole | null {
  if (i.hrisRoles.includes('admin')) return 'admin';
  if (i.grant) return i.grant;
  return i.isMember ? 'member' : null;
}

/**
 * The board keeps one live Admin GRANT; an HRIS admin is the break glass on top. The database trigger
 * (`acct_sb_roles_guard`) refuses the same revoke under a lock, so this is the friendly answer, not the guard.
 */
export function canRevokeGrant(grant: { role: GrantRole }, liveAdminGrants: number): boolean {
  return grant.role !== 'admin' || liveAdminGrants > 1;
}
