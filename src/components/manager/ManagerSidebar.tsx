'use client';

import React from 'react';
import { useTheme } from 'next-themes';
import { signOut } from 'next-auth/react';
import { withViewTransition } from '@/lib/theme/with-view-transition';
import {
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
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import ViewSwitcher from '@/components/rbac/ViewSwitcher';
import { SESSION_EMAIL_KEY } from '@/lib/rbac/views';
import EmployeeAvatar from '@/components/employee/EmployeeAvatar';
import { useViewerProfilePhoto } from '@/hooks/useViewerProfilePhoto';

export type ManagerTab = 'overview' | 'time-adjustments' | 'leaves' | 'team' | 'announcements' | 's-wall' | 'hsl-bonus' | 'bonus-history';

interface ManagerSidebarProps {
  activeTab: ManagerTab;
  setActiveTab: (tab: ManagerTab) => void;
  mobileOpen: boolean;
  viewerEmail: string | null;
  pendingApprovals: number;
  pendingLeaves?: number;
}

export default function ManagerSidebar({
  activeTab,
  setActiveTab,
  mobileOpen,
  viewerEmail,
  pendingApprovals,
  pendingLeaves = 0,
}: ManagerSidebarProps) {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => { setMounted(true); }, []);
  const isDark = mounted ? resolvedTheme === 'dark' : false;
  const { profilePhotoUrl, googlePhotoUrl } = useViewerProfilePhoto(viewerEmail);

  const [logoBeat, setLogoBeat] = React.useState(false);
  React.useEffect(() => {
    const fire = () => setLogoBeat(true);
    const first = setTimeout(fire, 1000);
    const interval = setInterval(fire, 12000);
    return () => { clearTimeout(first); clearInterval(interval); };
  }, []);

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
      <span className="truncate text-left">{label}</span>
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
    <aside
      className={cn(
        'flex h-dvh w-[220px] max-w-[min(100vw,220px)] shrink-0 flex-col border-r border-blue-100/70 bg-gradient-to-b from-white via-blue-50/30 to-white shadow-xl dark:border-blue-950/40 dark:from-black dark:via-blue-950/20 dark:to-black md:max-w-none md:shadow-none',
        'fixed inset-y-0 left-0 z-50 transition-transform duration-300 ease-out md:static md:z-auto md:translate-x-0',
        mobileOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0',
      )}
      id="manager-sidebar-nav"
      role="navigation"
      aria-label="Manager navigation"
    >
      <div className="flex flex-1 flex-col px-5 pb-4 pt-7">
        <div className="mb-8">
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
                className={cn('h-10 w-full object-contain', logoBeat && 'logo-heartbeat')}
                onAnimationEnd={() => setLogoBeat(false)}
              />
            </div>
          </a>
        </div>

        <ScrollArea className="min-h-0 flex-1 pr-2">
          <p className="mb-1.5 px-2.5 text-[10.5px] font-medium uppercase tracking-[0.06em] text-[#a1a1aa]">
            Workspace
          </p>
          <nav className="flex flex-col gap-px">
            {navBtn('overview', 'Overview', LayoutDashboard)}
            {navBtn(
              'time-adjustments',
              'Time adjustments',
              ClipboardCheck,
              countBadge(pendingApprovals, activeTab === 'time-adjustments'),
            )}
            {navBtn(
              'leaves',
              'Leaves',
              CalendarDays,
              countBadge(pendingLeaves, activeTab === 'leaves'),
            )}
            {navBtn('team', 'My team', Users)}
            {navBtn('announcements', 'Announcements', Megaphone)}
            <button
              key="s-wall"
              type="button"
              onClick={() => setActiveTab('s-wall')}
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
              <SWallNavLabel />
            </button>
          </nav>

          <div className="my-5 mx-2.5 h-px bg-gradient-to-r from-transparent via-blue-200/60 to-transparent dark:via-blue-900/40" />

          <p className="mb-1.5 px-2.5 text-[10.5px] font-medium uppercase tracking-[0.06em] text-[#a1a1aa]">
            Bonuses
          </p>
          <nav className="flex flex-col gap-px">
            {navBtn('hsl-bonus', 'KPI Calculator', Calculator)}
            {navBtn('bonus-history', 'Bonus History', History)}
          </nav>

          <div className="mt-6 border-t border-blue-100/60 pt-4 dark:border-blue-950/40">
            <ViewSwitcher email={viewerEmail} currentView="manager" />
            <button
              type="button"
              onClick={() => withViewTransition(() => setTheme(isDark ? 'light' : 'dark'))}
              className="mb-2 mt-3 flex w-full items-center justify-between rounded-md border border-blue-100/70 bg-gradient-to-br from-white to-blue-50/60 px-3 py-2 text-left transition-colors hover:from-blue-50 hover:to-blue-100/60 dark:border-blue-950/40 dark:from-zinc-950 dark:to-blue-950/20 dark:hover:from-blue-950/30 dark:hover:to-blue-950/40"
              aria-label="Toggle dark mode"
            >
              <div className="flex items-center gap-2 text-xs font-medium text-[#3f3f46] dark:text-zinc-300">
                {isDark ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
                {isDark ? 'Dark' : 'Light'}
              </div>
              <span className="text-[#a1a1aa]">{isDark ? '☀' : '☾'}</span>
            </button>
          </div>
        </ScrollArea>
      </div>

      <div className="mt-auto border-t border-blue-100/60 p-5 dark:border-blue-950/40">
        <div className="flex items-center gap-2.5 rounded-md border border-blue-100/70 bg-gradient-to-br from-white to-blue-50/60 px-2.5 py-2 dark:border-blue-950/40 dark:from-zinc-950 dark:to-blue-950/20">
          <EmployeeAvatar
            photoUrl={profilePhotoUrl}
            googlePhotoUrl={googlePhotoUrl}
            email={viewerEmail}
            initials={initials}
            className="h-7 w-7 text-[11px]"
            pixelSize={56}
          />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium leading-tight text-[#18181b] dark:text-zinc-100">
              {titleName}
            </div>
            <div className="mt-px truncate text-[11px] leading-tight text-blue-700/70 dark:text-blue-400/70">
              Manager
            </div>
          </div>
          <MoreHorizontal className="h-4 w-4 shrink-0 cursor-pointer text-blue-400/70 dark:text-blue-500/70" aria-hidden />
        </div>
        <Button
          variant="ghost"
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
          <LogOut className="h-4 w-4" />
          Sign Out
        </Button>
      </div>
    </aside>
  );
}
