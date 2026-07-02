'use client';

import React from 'react';
import { useTheme } from 'next-themes';
import { signOut } from 'next-auth/react';
import { withViewTransition } from '@/lib/theme/with-view-transition';
import {
  ArrowRightLeft,
  Bell,
  CalendarDays,
  ClipboardList,
  Gift,
  HeartHandshake,
  LayoutDashboard,
  LogIn,
  LogOut,
  Megaphone,
  Moon,
  MoreHorizontal,
  Newspaper,
  Sheet,
  Sun,
  UserMinus,
} from 'lucide-react';
import { SWallNavLabel } from '@/components/swall/SWall';
import ConstructionMark from '@/components/common/ConstructionMark';
import CollapsibleSidebarShell from '@/components/common/CollapsibleSidebarShell';
import SidebarBrandMark from '@/components/common/SidebarBrandMark';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import ViewSwitcher from '@/components/rbac/ViewSwitcher';
import { SESSION_EMAIL_KEY } from '@/lib/rbac/views';
import EmployeeAvatar from '@/components/employee/EmployeeAvatar';
import { useViewerProfilePhoto } from '@/hooks/useViewerProfilePhoto';
import { useDispatchLock } from '@/hooks/useDispatchLock';
import { useSidebarCollapsed } from '@/hooks/useSidebarCollapsed';

export type HrTab = 'overview' | 'global-master-list' | 'onboarding' | 'new-hire-checklist' | 'offboarding' | 'leaves' | 'transfers' | 'gift-tracker' | 'mesa' | 'announcements' | 's-wall' | 'notifications';

interface HrSidebarProps {
  activeTab: HrTab;
  setActiveTab: (tab: HrTab) => void;
  mobileOpen: boolean;
  viewerEmail: string | null;
  /** Unread notification count — drives the bell badge in the sidebar. */
  unreadNotifications?: number;
  /** Tab ids the viewer may see after the feature-permission overlay. */
  allowedTabs: readonly string[];
  /** Tab ids an admin marked "under construction" — shown with a badge. */
  constructionTabs?: readonly string[];
}

export default function HrSidebar({
  activeTab,
  setActiveTab,
  mobileOpen,
  viewerEmail,
  unreadNotifications = 0,
  allowedTabs,
  constructionTabs = [],
}: HrSidebarProps) {
  const can = (id: HrTab) => allowedTabs.includes(id);
  const isConstr = (id: HrTab) => constructionTabs.includes(id);
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => { setMounted(true); }, []);
  const isDark = mounted ? resolvedTheme === 'dark' : false;
  const { profilePhotoUrl, googlePhotoUrl } = useViewerProfilePhoto(viewerEmail);
  const { state: lockState } = useDispatchLock();
  const { collapsed, toggle } = useSidebarCollapsed();

  const [logoBeat, setLogoBeat] = React.useState(false);
  React.useEffect(() => {
    const fire = () => setLogoBeat(true);
    const first = setTimeout(fire, 1000);
    const interval = setInterval(fire, 12000);
    return () => { clearTimeout(first); clearInterval(interval); };
  }, []);

  const displayName = viewerEmail?.includes('@')
    ? viewerEmail.split('@')[0]!.replace(/[._-]/g, ' ')
    : viewerEmail || 'HR';
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
    id: HrTab,
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
          ? 'bg-gradient-to-r from-emerald-500 to-teal-700 font-medium text-white shadow-sm shadow-emerald-600/25'
          : 'text-[#3f3f46] hover:bg-emerald-50 hover:text-emerald-900 dark:text-zinc-300 dark:hover:bg-emerald-950/40 dark:hover:text-emerald-100',
      )}
    >
      <Icon
        className={cn(
          'h-[15px] w-[15px] shrink-0',
          activeTab === id ? 'text-white/85' : 'text-[#a1a1aa] dark:text-zinc-500',
        )}
      />
      <span className={cn('truncate text-left transition-opacity duration-[var(--sb-collapse-ms)] ease-[var(--sb-collapse-ease)]', collapsed && 'md:opacity-0')}>{label}</span>
      {isConstr(id) && <span className={cn('transition-opacity duration-[var(--sb-collapse-ms)] ease-[var(--sb-collapse-ease)]', collapsed && 'md:opacity-0')}><ConstructionMark active={activeTab === id} /></span>}
      {badge}
    </button>
  );

  return (
    <CollapsibleSidebarShell
      collapsed={collapsed}
      onToggle={toggle}
      innerWidthClassName="md:w-[220px]"
      accentClassName="border-emerald-200/80 hover:text-emerald-700 focus-visible:ring-emerald-400 dark:border-emerald-900/60 dark:hover:text-emerald-300"
      id="hr-sidebar-nav"
      ariaLabel="HR navigation"
      className={cn(
        'flex h-dvh w-[220px] max-w-[min(100vw,220px)] shrink-0 flex-col border-r border-emerald-100/70 bg-gradient-to-b from-white via-emerald-50/30 to-white shadow-xl dark:border-emerald-950/40 dark:from-black dark:via-emerald-950/15 dark:to-black md:max-w-none md:shadow-none',
        'fixed inset-y-0 left-0 z-50 transition-[transform,width] duration-300 ease-out md:static md:z-auto md:translate-x-0',
        mobileOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0',
      )}
    >
      {/* Brand — anchored at the top */}
      <div className="shrink-0 px-5 pb-2 pt-7">
        <a
          href="https://www.simple.biz/"
          target="_blank"
          rel="noopener noreferrer"
          className="logo-neon"
          onMouseEnter={() => { if (!logoBeat) setLogoBeat(true); }}
        >
          <div className="logo-neon__inner relative overflow-hidden px-3 py-2 border border-zinc-200 dark:border-black dark:ring-1 dark:ring-white">
            <img
              src="/simple-logo.png"
              alt="Simple HRIS"
              className={cn('h-10 w-full object-contain transition-opacity duration-[var(--sb-collapse-ms)] ease-[var(--sb-collapse-ease)]', collapsed && 'md:opacity-0', logoBeat && 'logo-heartbeat')}
              onAnimationEnd={() => setLogoBeat(false)}
            />
            <SidebarBrandMark
              className={cn('pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 opacity-0 transition-opacity duration-[var(--sb-collapse-ms)] ease-[var(--sb-collapse-ease)] from-emerald-500 to-teal-600', collapsed && 'md:opacity-100')}
            />
          </div>
        </a>
      </div>

      {/* Middle column — single scroll surface for nav + view switcher + theme toggle.
          Brand at top and Sign Out at bottom stay anchored regardless of viewport height. */}
      <ScrollArea className="min-h-0 flex-1">
        <div className="px-5 pb-4 pr-3">
          <p className={cn('mb-1.5 px-2.5 text-[10.5px] font-medium uppercase tracking-[0.06em] text-[#a1a1aa] transition-opacity duration-[var(--sb-collapse-ms)] ease-[var(--sb-collapse-ease)]', collapsed && 'md:opacity-0')}>
            Workspace
          </p>
          <nav className="flex flex-col gap-px">
            {can('overview') && navBtn('overview', 'Overview', LayoutDashboard)}
            {can('global-master-list') && navBtn('global-master-list', 'Global Master List', Sheet)}
            {can('new-hire-checklist') && navBtn('new-hire-checklist', 'New Hire Checklist', ClipboardList)}
            {can('onboarding') && navBtn('onboarding', 'Onboarding', LogIn)}
            {can('offboarding') && navBtn('offboarding', 'Offboarding', UserMinus)}
            {can('leaves') && navBtn('leaves', 'Leave Requests', CalendarDays)}
            {can('transfers') && navBtn('transfers', 'Transfers', ArrowRightLeft)}
            {can('gift-tracker') && navBtn('gift-tracker', 'Gift Tracker', Gift)}
            {can('mesa') && navBtn('mesa', 'MESA', HeartHandshake)}
            {can('announcements') && navBtn('announcements', 'Announcements', Megaphone)}
            {can('notifications') && navBtn(
              'notifications',
              'Notifications',
              Bell,
              (unreadNotifications > 0 || lockState.locked) ? (
                <span className="ml-auto flex items-center gap-1.5">
                  {unreadNotifications > 0 && (
                    <span
                      className={cn(
                        'inline-flex min-w-[18px] items-center justify-center rounded-full px-1.5 text-[10px] font-semibold leading-[18px]',
                        activeTab === 'notifications'
                          ? 'bg-white/25 text-white'
                          : 'bg-red-500 text-white',
                      )}
                    >
                      {unreadNotifications > 99 ? '99+' : unreadNotifications}
                    </span>
                  )}
                  {lockState.locked && (
                    <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" />
                  )}
                </span>
              ) : null,
            )}
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
              <span className={cn('transition-opacity duration-[var(--sb-collapse-ms)] ease-[var(--sb-collapse-ease)]', collapsed && 'md:opacity-0')}><SWallNavLabel /></span>
              {isConstr('s-wall') && <span className={cn('transition-opacity duration-[var(--sb-collapse-ms)] ease-[var(--sb-collapse-ease)]', collapsed && 'md:opacity-0')}><ConstructionMark active={activeTab === 's-wall'} /></span>}
            </button>}
          </nav>

          {/* ViewSwitcher + theme toggle — kept INSIDE the scroll area so they're
              reachable via the same scrollbar when the viewport is short. */}
          <div className="mt-5 border-t border-emerald-100/60 pt-4 dark:border-emerald-950/40">
            <div className={cn('transition-opacity duration-[var(--sb-collapse-ms)] ease-[var(--sb-collapse-ease)]', collapsed && 'md:opacity-0')}>
              <ViewSwitcher email={viewerEmail} currentView="hr" />
            </div>
            <button
              type="button"
              onClick={() => withViewTransition(() => setTheme(isDark ? 'light' : 'dark'))}
              title={collapsed ? (isDark ? 'Dark mode' : 'Light mode') : undefined}
              className="mb-1 mt-3 flex w-full items-center justify-between rounded-md border border-emerald-100/70 bg-gradient-to-br from-white to-emerald-50/60 px-3 py-2 text-left transition-colors hover:from-emerald-50 hover:to-emerald-100/60 dark:border-emerald-950/40 dark:from-zinc-950 dark:to-emerald-950/15 dark:hover:from-emerald-950/25 dark:hover:to-emerald-950/35"
              aria-label="Toggle dark mode"
            >
              <div className="flex items-center gap-2 text-xs font-medium text-[#3f3f46] dark:text-zinc-300">
                {isDark ? <Moon className="h-4 w-4 shrink-0" /> : <Sun className="h-4 w-4 shrink-0" />}
                <span className={cn('transition-opacity duration-[var(--sb-collapse-ms)] ease-[var(--sb-collapse-ease)]', collapsed && 'md:opacity-0')}>{isDark ? 'Dark' : 'Light'}</span>
              </div>
              <span className={cn('text-[#a1a1aa] transition-opacity duration-[var(--sb-collapse-ms)] ease-[var(--sb-collapse-ease)]', collapsed && 'md:opacity-0')}>{isDark ? '☀' : '☾'}</span>
            </button>
          </div>
        </div>
      </ScrollArea>

      {/* Identity + Sign Out — anchored at the bottom, always reachable */}
      <div className="shrink-0 border-t border-emerald-100/60 p-5 dark:border-emerald-950/40">
        <div className="flex items-center gap-2.5 rounded-md border border-emerald-100/70 bg-gradient-to-br from-white to-emerald-50/60 px-2.5 py-2 dark:border-emerald-950/40 dark:from-zinc-950 dark:to-emerald-950/15">
          <EmployeeAvatar
            photoUrl={profilePhotoUrl}
            googlePhotoUrl={googlePhotoUrl}
            email={viewerEmail}
            initials={initials}
            className="h-7 w-7 text-[11px]"
            pixelSize={56}
          />
          <div className={cn('min-w-0 flex-1 transition-opacity duration-[var(--sb-collapse-ms)] ease-[var(--sb-collapse-ease)]', collapsed && 'md:opacity-0')}>
            <div className="truncate text-[13px] font-medium leading-tight text-[#18181b] dark:text-zinc-100">
              {titleName}
            </div>
            <div className="mt-px truncate text-[11px] leading-tight text-emerald-700/70 dark:text-emerald-400/70">
              HR
            </div>
          </div>
          <MoreHorizontal className={cn('h-4 w-4 shrink-0 cursor-pointer text-emerald-400/70 transition-opacity duration-[var(--sb-collapse-ms)] ease-[var(--sb-collapse-ease)]', collapsed && 'md:opacity-0')} aria-hidden />
        </div>
        <Button
          variant="ghost"
          title={collapsed ? 'Sign Out' : undefined}
          className="mt-3 w-full justify-start gap-3 text-[#71717a] hover:bg-red-500/10 hover:text-red-600 dark:text-zinc-500 dark:hover:text-red-400"
          onClick={() => {
            try { sessionStorage.removeItem(SESSION_EMAIL_KEY); } catch { /* ignore */ }
            void signOut({ callbackUrl: '/login' });
          }}
        >
          <LogOut className="h-4 w-4 shrink-0" />
          <span className={cn('transition-opacity duration-[var(--sb-collapse-ms)] ease-[var(--sb-collapse-ease)]', collapsed && 'md:opacity-0')}>Sign Out</span>
        </Button>
      </div>
    </CollapsibleSidebarShell>
  );
}
