'use client';

import React from 'react';
import { useTheme } from 'next-themes';
import { signOut } from 'next-auth/react';
import { withViewTransition } from '@/lib/theme/with-view-transition';
import {
  Bell,
  CalendarDays,
  ClipboardCheck,
  Calculator,
  History,
  LayoutDashboard,
  LogOut,
  Megaphone,
  Moon,
  MoreHorizontal,
  Newspaper,
  Sun,
  Users,
} from 'lucide-react';
import { SWallNavLabel } from '@/components/swall/SWall';
import ConstructionMark from '@/components/common/ConstructionMark';
import CollapsibleSidebarShell from '@/components/common/CollapsibleSidebarShell';
import SidebarLogoHeader from '@/components/common/SidebarLogoHeader';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import ViewSwitcher from '@/components/rbac/ViewSwitcher';
import { SESSION_EMAIL_KEY } from '@/lib/rbac/views';
import EmployeeAvatar from '@/components/employee/EmployeeAvatar';
import { useViewerProfilePhoto } from '@/hooks/useViewerProfilePhoto';
import { useDispatchLock } from '@/hooks/useDispatchLock';
import { useSidebarCollapsed } from '@/hooks/useSidebarCollapsed';

export type ManagerTab = 'overview' | 'time-adjustments' | 'leaves' | 'team' | 'announcements' | 's-wall' | 'hsl-bonus' | 'bonus-history' | 'notifications';

interface ManagerSidebarProps {
  activeTab: ManagerTab;
  setActiveTab: (tab: ManagerTab) => void;
  mobileOpen: boolean;
  viewerEmail: string | null;
  pendingApprovals: number;
  pendingLeaves?: number;
  /** Tab ids the viewer may see after the feature-permission overlay. */
  allowedTabs: readonly string[];
  /** Tab ids an admin marked "under construction" — shown with a badge. */
  constructionTabs?: readonly string[];
}

export default function ManagerSidebar({
  activeTab,
  setActiveTab,
  mobileOpen,
  viewerEmail,
  pendingApprovals,
  pendingLeaves = 0,
  allowedTabs,
  constructionTabs = [],
}: ManagerSidebarProps) {
  const can = (id: ManagerTab) => allowedTabs.includes(id);
  const isConstr = (id: ManagerTab) => constructionTabs.includes(id);
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => { setMounted(true); }, []);
  const isDark = mounted ? resolvedTheme === 'dark' : false;
  const { profilePhotoUrl, googlePhotoUrl } = useViewerProfilePhoto(viewerEmail);
  const { state: lockState } = useDispatchLock();
  const { collapsed, toggle } = useSidebarCollapsed();

  const displayName = viewerEmail?.includes('@')
    ? viewerEmail.split('@')[0]!.replace(/[._-]/g, ' ')
    : viewerEmail || 'Manager';
  const titleName = displayName
    .split(' ')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
  const initials = titleName
    .split(' ')
    .map((w) => w[0] ?? '')
    .join('')
    .toUpperCase()
    .slice(0, 2) || (viewerEmail || '?').slice(0, 2).toUpperCase();

  const navBtn = (
    id: ManagerTab,
    label: string,
    Icon: React.ComponentType<{ className?: string }>,
    badge?: React.ReactNode,
  ) => (
    <button
      key={id}
      type="button"
      onClick={() => setActiveTab(id)}
      title={collapsed ? label : undefined}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-md px-2.5 py-[7px] text-[13.5px] font-[450] transition-[color,background-color,box-shadow] duration-200 ease-out',
        activeTab === id
          ? 'bg-gradient-to-r from-blue-600 to-blue-800 font-medium text-white shadow-sm shadow-blue-600/25'
          : 'text-[#3f3f46] hover:bg-blue-50 hover:text-blue-900 dark:text-zinc-300 dark:hover:bg-blue-950/40 dark:hover:text-blue-100',
      )}
    >
      <Icon
        className={cn(
          'h-[15px] w-[15px] shrink-0',
          activeTab === id
            ? 'text-white/85'
            : 'text-[#a1a1aa] dark:text-zinc-500',
        )}
      />
      <span className={cn('truncate text-left sb-collapse-fade')}>{label}</span>
      {isConstr(id) && <span className={cn('sb-collapse-fade')}><ConstructionMark active={activeTab === id} /></span>}
      {badge}
    </button>
  );

  const countBadge = (n: number, active: boolean) => {
    if (n <= 0) return null;
    return (
      <span
        className={cn(
          'ml-auto rounded-full px-1.5 py-px text-[10.5px] font-semibold tabular-nums',
          active
            ? 'bg-white/20 text-white'
            : 'bg-blue-100 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300',
        )}
      >
        {n}
      </span>
    );
  };

  return (
    <CollapsibleSidebarShell
      collapsed={collapsed}
      onToggle={toggle}
      innerWidthClassName="md:w-[220px]"
      accentClassName="border-blue-200/80 hover:text-blue-600 focus-visible:ring-blue-400 dark:border-blue-950/70 dark:hover:text-blue-300"
      id="manager-sidebar-nav"
      ariaLabel="Manager navigation"
      className={cn(
        'flex h-dvh w-[220px] max-w-[min(100vw,220px)] shrink-0 flex-col border-r border-blue-100/70 bg-gradient-to-b from-white via-blue-50/30 to-white shadow-xl dark:border-blue-950/40 dark:from-black dark:via-blue-950/20 dark:to-black md:max-w-none md:shadow-none',
        'fixed inset-y-0 left-0 z-50 transition-[transform,width] duration-300 ease-out md:static md:z-auto md:translate-x-0',
        mobileOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0',
      )}
    >
      <div className="shrink-0 px-5 pt-7 pb-5">
        <SidebarLogoHeader collapsed={collapsed} accentClassName="from-blue-500 to-blue-700" />
      </div>

      <ScrollArea className="min-h-0 flex-1 px-5">
        <div className="pr-2 pb-4">
          <p className={cn('mb-1.5 px-2.5 text-[10.5px] font-medium uppercase tracking-[0.06em] text-[#a1a1aa] sb-collapse-fade')}>
            Workspace
          </p>
          <nav className="flex flex-col gap-px">
            {can('overview') && navBtn('overview', 'Overview', LayoutDashboard)}
            {can('time-adjustments') && navBtn(
              'time-adjustments',
              'Time adjustments',
              ClipboardCheck,
              countBadge(pendingApprovals, activeTab === 'time-adjustments'),
            )}
            {can('leaves') && navBtn(
              'leaves',
              'Leaves',
              CalendarDays,
              countBadge(pendingLeaves, activeTab === 'leaves'),
            )}
            {can('team') && navBtn('team', 'My team', Users)}
            {can('announcements') && navBtn('announcements', 'Announcements', Megaphone)}
            {can('s-wall') && <button
              key="s-wall"
              type="button"
              onClick={() => setActiveTab('s-wall')}
              title={collapsed ? 'S-Wall' : undefined}
              className={cn(
                'group/sw flex w-full items-center gap-2.5 rounded-md px-2.5 py-[7px] text-[13.5px] font-[450] transition-[color,background-color,box-shadow] duration-200 ease-out',
                activeTab === 's-wall'
                  ? 'bg-gradient-to-r from-violet-600 to-indigo-700 font-medium text-white shadow-sm shadow-violet-600/25'
                  : 'text-[#3f3f46] hover:bg-violet-50 hover:text-violet-900 dark:text-zinc-300 dark:hover:bg-violet-950/40 dark:hover:text-violet-100',
              )}
            >
              <Newspaper
                className={cn(
                  'h-[15px] w-[15px] shrink-0',
                  activeTab === 's-wall' ? 'text-white/85' : 'text-[#a1a1aa] dark:text-zinc-500',
                )}
              />
              <span className={cn('sb-collapse-fade')}><SWallNavLabel /></span>
              {isConstr('s-wall') && <span className={cn('sb-collapse-fade')}><ConstructionMark active={activeTab === 's-wall'} /></span>}
            </button>}
          </nav>

          {(can('hsl-bonus') || can('bonus-history')) && (
            <div className="my-5 mx-2.5 h-px bg-gradient-to-r from-transparent via-blue-200/60 to-transparent dark:via-blue-900/40" />
          )}

          {(can('hsl-bonus') || can('bonus-history')) && (
            <p className={cn('mb-1.5 px-2.5 text-[10.5px] font-medium uppercase tracking-[0.06em] text-[#a1a1aa] sb-collapse-fade')}>
              Bonuses
            </p>
          )}
          <nav className="flex flex-col gap-px">
            {can('hsl-bonus') && navBtn('hsl-bonus', 'KPI Calculator', Calculator)}
            {can('bonus-history') && navBtn('bonus-history', 'Bonus History', History)}
            {can('notifications') && navBtn(
              'notifications',
              'Notifications',
              Bell,
              lockState.locked ? (
                <span className="ml-auto h-2 w-2 animate-pulse rounded-full bg-red-500" />
              ) : null,
            )}
          </nav>

          <div className="mt-6 border-t border-blue-100/60 pt-4 dark:border-blue-950/40">
            <ViewSwitcher email={viewerEmail} currentView="manager" collapsed={collapsed} />
            <button
              type="button"
              onClick={() => withViewTransition(() => setTheme(isDark ? 'light' : 'dark'))}
              title={collapsed ? (isDark ? 'Dark mode' : 'Light mode') : undefined}
              className="mb-2 mt-3 flex w-full items-center justify-between rounded-md border border-blue-100/70 bg-gradient-to-br from-white to-blue-50/60 px-3 py-2 text-left transition-colors hover:from-blue-50 hover:to-blue-100/60 dark:border-blue-950/40 dark:from-zinc-950 dark:to-blue-950/20 dark:hover:from-blue-950/30 dark:hover:to-blue-950/40"
              aria-label="Toggle dark mode"
            >
              <div className="flex items-center gap-2 text-xs font-medium text-[#3f3f46] dark:text-zinc-300">
                {isDark ? <Moon className="h-4 w-4 shrink-0" /> : <Sun className="h-4 w-4 shrink-0" />}
                <span className={cn('sb-collapse-fade')}>{isDark ? 'Dark' : 'Light'}</span>
              </div>
              <span className={cn('text-[#a1a1aa] sb-collapse-fade')}>{isDark ? '☀' : '☾'}</span>
            </button>
          </div>
        </div>
      </ScrollArea>

      <div className="shrink-0 border-t border-blue-100/60 p-5 dark:border-blue-950/40">
        <div className="flex items-center gap-2.5 rounded-md border border-blue-100/70 bg-gradient-to-br from-white to-blue-50/60 px-2.5 py-2 dark:border-blue-950/40 dark:from-zinc-950 dark:to-blue-950/20">
          <EmployeeAvatar
            photoUrl={profilePhotoUrl}
            googlePhotoUrl={googlePhotoUrl}
            email={viewerEmail}
            initials={initials}
            className="h-7 w-7 text-[11px]"
            pixelSize={56}
          />
          <div className={cn('min-w-0 flex-1 sb-collapse-fade')}>
            <div className="truncate text-[13px] font-medium leading-tight text-[#18181b] dark:text-zinc-100">
              {titleName}
            </div>
            <div className="mt-px truncate text-[11px] leading-tight text-blue-700/70 dark:text-blue-400/70">
              Manager
            </div>
          </div>
          <MoreHorizontal className={cn('h-4 w-4 shrink-0 cursor-pointer text-blue-400/70 transition-opacity duration-[var(--sb-collapse-ms)] ease-[var(--sb-collapse-ease)] dark:text-blue-500/70', collapsed && 'md:opacity-0')} aria-hidden />
        </div>
        <Button
          variant="ghost"
          title={collapsed ? 'Sign Out' : undefined}
          className="mt-3 w-full justify-start gap-3 text-[#71717a] hover:bg-red-500/10 hover:text-red-600 dark:text-zinc-500 dark:hover:text-red-400"
          onClick={() => {
            try {
              sessionStorage.removeItem(SESSION_EMAIL_KEY);
            } catch {
              /* ignore */
            }
            void signOut({ callbackUrl: '/login' });
          }}
        >
          <LogOut className="h-4 w-4 shrink-0" />
          <span className={cn('sb-collapse-fade')}>Sign Out</span>
        </Button>
      </div>
    </CollapsibleSidebarShell>
  );
}
