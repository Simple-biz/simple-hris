'use client';

import { signOut, useSession } from 'next-auth/react';
import { clearAllTicketsCache } from '@/lib/tickets/tab-cache';
import { SESSION_EMAIL_KEY } from '@/lib/rbac/views';
import {
  Archive,
  ChartColumn,
  ChevronRight,
  LogOut,
  MessageCircle,
  SquareKanban,
  Ticket,
} from 'lucide-react';
import CollapsibleSidebarShell from '@/components/common/CollapsibleSidebarShell';
import SidebarLogoHeader from '@/components/common/SidebarLogoHeader';
import ViewSwitcher from '@/components/rbac/ViewSwitcher';
import EmployeeAvatar from '@/components/employee/EmployeeAvatar';
import { useViewerProfilePhoto } from '@/hooks/useViewerProfilePhoto';
import { useSidebarCollapsed } from '@/hooks/useSidebarCollapsed';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import type { TicketsHostAccess } from '@/lib/rbac/view-tabs';

/**
 * The surfaces this rail can point at.
 *
 * The first three are the dev Kanban's own views — component state, not routes
 * (TicketsBoard.tsx:96). `support-chat` and `support-tickets` are Employee
 * Support's TWO tabs (Kane, 2026-09-21: "two tabs in ticket for employee
 * support one for chat and one for ticket"), hosted on the same /tickets route
 * by his Q3, and their ids are the ones `VIEW_TAB_IDS.employee_support`
 * declares (view-tabs.ts:121-138) — the strings are the join between this nav
 * and the per-tab overlay gate, so they are not names that may be chosen
 * freely here.
 */
export type TicketsView = 'board' | 'overview' | 'archived' | 'support-chat' | 'support-tickets';

interface TicketsSidebarProps {
  /** Below `md`, sidebar is a drawer. Desktop ignores this. */
  mobileOpen: boolean;
  /** Signed-in viewer (from /api/tickets) — feeds the ViewSwitcher. */
  viewerEmail: string | null;
  /** Which tickets surface is showing. `null` before the landing is decided. */
  active: TicketsView | null;
  onNavigate: (view: TicketsView) => void;
  /**
   * What this viewer may open, from `ticketsHostAccess` — the ONE decision
   * function, so this nav, the page's landing and any guard inside cannot
   * disagree with each other (view-tabs.ts:272-287).
   *
   * **`null` means the roles have not landed yet, and that is not "nothing".**
   * A rail drawn from an empty answer would flash the dev board's three
   * entries at a support-only holder for one frame, which is exactly the thing
   * the `employee_support` role exists to prevent. So `null` paints a
   * skeleton.
   */
  access: TicketsHostAccess | null;
}

/** The dev Kanban's own views. Shown only to a `TICKET_BOARD_ROLES` holder. */
const BOARD_NAV: Array<{ key: TicketsView; label: string; icon: typeof SquareKanban }> = [
  { key: 'overview', label: 'Overview', icon: ChartColumn },
  { key: 'board', label: 'Board', icon: SquareKanban },
  { key: 'archived', label: 'Archived', icon: Archive },
];

/**
 * Employee Support's tabs, keyed by the tab id the overlay gates. Only the ids
 * in `access.supportTabs` are drawn, so an admin hiding Support Chat in the
 * per-tab grid removes it here without a second rule.
 *
 * Two entries since 2026-09-21, and they are drawn in `access.supportTabs`
 * order (= catalog order), so Chat sits above Tickets: chat is the intake
 * channel, the ticket is the durable record every chat becomes.
 * `src/lib/rbac/view-tabs.test.ts` pins that every id in
 * `VIEW_TAB_IDS.employee_support` has an entry here — without one the loop
 * below silently skips it and the granted tab is unreachable from the rail.
 */
const SUPPORT_NAV: Record<string, { label: string; icon: typeof SquareKanban }> = {
  'support-chat': { label: 'Support Chat', icon: MessageCircle },
  'support-tickets': { label: 'Support Tickets', icon: Ticket },
};

/** One rail entry. Extracted so the two groups cannot drift apart visually. */
function NavItem({
  label,
  Icon,
  collapsed,
  isActive,
  onClick,
}: {
  label: string;
  Icon: typeof SquareKanban;
  collapsed: boolean;
  isActive: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={collapsed ? label : undefined}
      onClick={onClick}
      aria-current={isActive ? 'page' : undefined}
      className={cn(
        'group flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
        isActive
          ? 'bg-gradient-to-r from-red-950/70 to-red-950/30 text-white shadow-sm'
          : 'text-zinc-500 hover:bg-red-500/10 hover:text-zinc-200',
      )}
    >
      <Icon
        className={cn('h-4 w-4', isActive ? 'text-red-500' : 'text-zinc-600 group-hover:text-red-400')}
      />
      <span className={cn('truncate text-left sb-collapse-fade')}>{label}</span>
      {isActive && <ChevronRight className="ml-auto h-3 w-3 text-red-500/70" />}
    </button>
  );
}

/** A section heading, drawn only when a viewer holds both surfaces. */
function NavGroupLabel({ label, collapsed }: { label: string; collapsed: boolean }) {
  return (
    <p
      className={cn(
        'px-3 pt-3 pb-1 text-[10px] font-semibold tracking-wider text-zinc-600 uppercase sb-collapse-fade',
        collapsed && 'sr-only',
      )}
    >
      {label}
    </p>
  );
}

/**
 * Sidebar rail for /tickets, which since 2026-09-19 hosts TWO unrelated
 * surfaces: the HRIS dev Kanban (`tickets` role) and Employee Support
 * (`employee_support` role, Kane's Q3). Which of the two groups a viewer sees
 * — and whether they see both — is decided entirely by `ticketsHostAccess`
 * and passed in as `access`; nothing is derived a second time here.
 *
 * Black + red to match the board's console theme; the surface is fixed dark in
 * both global themes, so this rail carries no light variant (and no theme
 * toggle — it would visibly do nothing here).
 */
export default function TicketsSidebar({
  mobileOpen,
  viewerEmail,
  active,
  onNavigate,
  access,
}: TicketsSidebarProps) {
  const { collapsed, toggle } = useSidebarCollapsed();
  // `viewerEmail` arrives with the board fetch; the next-auth session fills the
  // identity card immediately on first paint (they're the same person — the
  // board API derives its viewer from this session).
  const { data: session } = useSession();
  const email = viewerEmail ?? session?.user?.email?.trim().toLowerCase() ?? null;
  const { profilePhotoUrl, googlePhotoUrl } = useViewerProfilePhoto(email);

  // Same derivation the dashboard sidebars use (HR/QC/etc.): a readable name
  // from the email's local part, plus 2-letter initials for the avatar fallback.
  const displayName = email?.includes('@')
    ? email.split('@')[0]!.replace(/[._-]/g, ' ')
    : email || 'Tickets';
  const titleName = displayName
    .split(' ')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
  const initials = displayName
    .split(' ')
    .map((w) => w[0] ?? '')
    .join('')
    .toUpperCase()
    .slice(0, 2) || (email || '?').slice(0, 2).toUpperCase();

  // Only ids this rail actually knows how to draw. A catalog key with no entry
  // in SUPPORT_NAV is skipped rather than rendered as a nameless button — the
  // catalog is expected to grow (feature-permissions.ts:117-138: a new support
  // surface appends its key there), and the honest failure while the two are
  // briefly out of step is a missing entry, not a blank one. A test keeps that
  // window short: view-tabs.test.ts scans this map for every declared tab id.
  const supportEntries = (access?.supportTabs ?? []).flatMap((id) => {
    const entry = SUPPORT_NAV[id];
    return entry ? [{ key: id as TicketsView, label: entry.label, icon: entry.icon }] : [];
  });
  const bothGroups = !!access?.board && supportEntries.length > 0;

  return (
    <CollapsibleSidebarShell
      collapsed={collapsed}
      onToggle={toggle}
      innerWidthClassName="md:w-64"
      accentClassName="border-red-950/70 hover:text-red-400 focus-visible:ring-red-500"
      id="tickets-sidebar-nav"
      ariaLabel="Tickets navigation"
      className={cn(
        'flex h-dvh w-[85vw] max-w-[20rem] shrink-0 flex-col border-r border-border bg-gradient-to-b from-[#0d0d0e] to-[#080809] text-zinc-400 md:w-64 md:max-w-none md:shadow-none',
        'fixed inset-y-0 left-0 z-50 will-change-transform md:static md:z-auto md:translate-x-0',
        'transition-[transform,box-shadow,width] duration-[360ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
        mobileOpen
          ? 'translate-x-0 shadow-2xl shadow-black/50'
          : '-translate-x-full shadow-none md:translate-x-0',
      )}
    >
      <div className="flex min-h-0 flex-1 flex-col p-6">
        <div className="mb-8">
          <SidebarLogoHeader collapsed={collapsed} accentClassName="from-red-500 to-red-800" />
        </div>

        <ScrollArea className="-mx-2 min-h-0 flex-1">
          <nav className="space-y-1 px-2">
            {access === null ? (
              // The roles have not landed. See the `access` prop's docstring:
              // an un-resolved answer is not an empty one, and drawing the dev
              // board's entries "just for a frame" is the leak this surface
              // was scoped against.
              <div className="space-y-1.5 py-1">
                <Skeleton className="h-9 rounded-md bg-zinc-800/60" />
                <Skeleton className="h-9 rounded-md bg-zinc-800/60" />
                <Skeleton className="h-9 rounded-md bg-zinc-800/60" />
              </div>
            ) : (
              <>
                {/* Group headings appear only when a viewer actually holds
                    both — for the single-surface case (everyone but an admin
                    or a dual grant) they would be chrome around one list. */}
                {access.board && bothGroups && <NavGroupLabel collapsed={collapsed} label="HRIS Updates" />}
                {access.board &&
                  BOARD_NAV.map(({ key, label, icon: Icon }) => (
                    <NavItem
                      key={key}
                      label={label}
                      Icon={Icon}
                      collapsed={collapsed}
                      isActive={active === key}
                      onClick={() => onNavigate(key)}
                    />
                  ))}

                {supportEntries.length > 0 && bothGroups && (
                  <NavGroupLabel collapsed={collapsed} label="Employee Support" />
                )}
                {supportEntries.map(({ key, label, icon: Icon }) => (
                  <NavItem
                    key={key}
                    label={label}
                    Icon={Icon}
                    collapsed={collapsed}
                    isActive={active === key}
                    onClick={() => onNavigate(key)}
                  />
                ))}

                {/* Granted nothing. An empty state, NEVER a default entry —
                    `VIEW_TAB_IDS.employee_support` carries no fallback id for
                    exactly this case (view-tabs.ts:111-115). */}
                {!access.board && supportEntries.length === 0 && (
                  <p className={cn('px-3 py-2 text-xs leading-relaxed text-zinc-500 sb-collapse-fade')}>
                    Nothing here is granted to you yet. Ask an admin for the tab you need.
                  </p>
                )}
              </>
            )}
          </nav>
        </ScrollArea>
      </div>

      <div className="mt-auto border-t border-border p-4">
        <ViewSwitcher email={email} currentView="tickets" collapsed={collapsed} />
        {/* Identity card — the signed-in session, mirroring the dashboard
            sidebars (HR/QC/…), recolored for the board's black + red theme. */}
        <div
          className="my-3 flex items-center gap-2.5 rounded-md border border-red-950/40 bg-gradient-to-br from-zinc-950 to-red-950/15 px-2.5 py-2"
          title={email ?? undefined}
        >
          <EmployeeAvatar
            photoUrl={profilePhotoUrl}
            googlePhotoUrl={googlePhotoUrl}
            email={email}
            initials={initials}
            className="h-7 w-7 text-[11px]"
            pixelSize={56}
          />
          <div className={cn('min-w-0 flex-1 sb-collapse-fade')}>
            <div className="truncate text-[13px] font-medium leading-tight text-zinc-100">
              {titleName}
            </div>
            <div className="mt-px truncate text-[11px] leading-tight text-red-400/70">
              {email ?? 'Tickets'}
            </div>
          </div>
        </div>
        <Button
          variant="ghost"
          title={collapsed ? 'Sign Out' : undefined}
          className="w-full justify-start gap-3 text-zinc-500 hover:bg-red-500/10 hover:text-red-400"
          onClick={() => {
            try {
              sessionStorage.removeItem(SESSION_EMAIL_KEY);
            } catch { /* ignore */ }
            // `signOut` navigates in the SAME tab and `sessionStorage` survives
            // that, so the next person here would otherwise have the board on
            // disk. Email first, then the purge: a read racing the purge would
            // re-adopt the identity being dropped.
            clearAllTicketsCache();
            void signOut({ callbackUrl: '/login' });
          }}
        >
          <LogOut className="h-4 w-4 shrink-0" />
          <span className={cn('sb-collapse-fade')}>Log Out</span>
        </Button>
      </div>
    </CollapsibleSidebarShell>
  );
}
