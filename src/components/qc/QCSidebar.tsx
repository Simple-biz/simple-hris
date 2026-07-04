'use client';

import React from 'react';
import { useTheme } from 'next-themes';
import { signOut } from 'next-auth/react';
import { withViewTransition } from '@/lib/theme/with-view-transition';
import { Bell, ClipboardCheck, LayoutDashboard, LogOut, Moon, MoreHorizontal, Sun } from 'lucide-react';
import CollapsibleSidebarShell from '@/components/common/CollapsibleSidebarShell';
import SidebarLogoHeader from '@/components/common/SidebarLogoHeader';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import ViewSwitcher from '@/components/rbac/ViewSwitcher';
import { SESSION_EMAIL_KEY } from '@/lib/rbac/views';
import EmployeeAvatar from '@/components/employee/EmployeeAvatar';
import { useViewerProfilePhoto } from '@/hooks/useViewerProfilePhoto';
import { useSidebarCollapsed } from '@/hooks/useSidebarCollapsed';

export type QcTab = 'overview' | 'qc-calculator' | 'notifications';

interface QcSidebarProps {
  activeTab: QcTab;
  setActiveTab: (tab: QcTab) => void;
  mobileOpen: boolean;
  viewerEmail: string | null;
  /** Tab ids the viewer may see after the feature-permission overlay. */
  allowedTabs: readonly string[];
}

/**
 * QC dashboard sidebar — same structure/footer/theme-toggle/Switch-view as every
 * other dashboard (ManagerSidebar is the reference), carrying the QC orange
 * identity. Nav tabs sit at the TOP; the "Switch view" picker sits BELOW them.
 */
export default function QCSidebar({
  activeTab,
  setActiveTab,
  mobileOpen,
  viewerEmail,
  allowedTabs,
}: QcSidebarProps) {
  const can = (id: QcTab) => allowedTabs.includes(id);
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => { setMounted(true); }, []);
  const isDark = mounted ? resolvedTheme === 'dark' : false;
  const { profilePhotoUrl, googlePhotoUrl } = useViewerProfilePhoto(viewerEmail);
  const { collapsed, toggle } = useSidebarCollapsed();

  const displayName = viewerEmail?.includes('@')
    ? viewerEmail.split('@')[0]!.replace(/[._-]/g, ' ')
    : viewerEmail || 'QC';
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

  const navBtn = (id: QcTab, label: string, Icon: React.ComponentType<{ className?: string }>) => (
    <button
      key={id}
      type="button"
      onClick={() => setActiveTab(id)}
      title={collapsed ? label : undefined}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-md px-2.5 py-[7px] text-[13.5px] font-[450] transition-[color,background-color,box-shadow] duration-200 ease-out',
        activeTab === id
          ? 'bg-gradient-to-r from-orange-500 to-orange-600 font-medium text-white shadow-sm shadow-orange-600/25'
          : 'text-[#3f3f46] hover:bg-orange-50 hover:text-orange-900 dark:text-zinc-300 dark:hover:bg-orange-950/40 dark:hover:text-orange-100',
      )}
    >
      <Icon
        className={cn(
          'h-[15px] w-[15px] shrink-0',
          activeTab === id ? 'text-white/85' : 'text-[#a1a1aa] dark:text-zinc-500',
        )}
      />
      <span className={cn('truncate text-left sb-collapse-fade')}>{label}</span>
    </button>
  );

  return (
    <CollapsibleSidebarShell
      collapsed={collapsed}
      onToggle={toggle}
      innerWidthClassName="md:w-[220px]"
      accentClassName="border-orange-200/80 hover:text-orange-600 focus-visible:ring-orange-400 dark:border-orange-900/60 dark:hover:text-orange-300"
      id="qc-sidebar-nav"
      ariaLabel="QC navigation"
      className={cn(
        'flex h-dvh w-[220px] max-w-[min(100vw,220px)] shrink-0 flex-col border-r border-orange-100/70 bg-gradient-to-b from-white via-orange-50/30 to-white shadow-xl dark:border-orange-950/40 dark:from-black dark:via-orange-950/20 dark:to-black md:max-w-none md:shadow-none',
        'fixed inset-y-0 left-0 z-50 transition-[transform,width] duration-300 ease-out md:static md:z-auto md:translate-x-0',
        mobileOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0',
      )}
    >
      <div className="shrink-0 px-5 pt-7 pb-5">
        <SidebarLogoHeader collapsed={collapsed} accentClassName="from-orange-500 to-orange-600" />
      </div>

      <ScrollArea className="min-h-0 flex-1 px-5">
        <div className="pr-2 pb-4">
          <p className={cn('mb-1.5 px-2.5 text-[10.5px] font-medium uppercase tracking-[0.06em] text-[#a1a1aa] sb-collapse-fade')}>
            Workspace
          </p>
          <nav className="flex flex-col gap-px">
            {can('overview') && navBtn('overview', 'Overview', LayoutDashboard)}
            {can('qc-calculator') && navBtn('qc-calculator', 'QC Calculator', ClipboardCheck)}
            {can('notifications') && navBtn('notifications', 'Notifications', Bell)}
          </nav>

          <div className="mt-6 border-t border-orange-100/60 pt-4 dark:border-orange-950/40">
            <div className={cn('sb-collapse-fade')}>
              <ViewSwitcher email={viewerEmail} currentView="qc" />
            </div>
            <button
              type="button"
              onClick={() => withViewTransition(() => setTheme(isDark ? 'light' : 'dark'))}
              title={collapsed ? (isDark ? 'Dark mode' : 'Light mode') : undefined}
              className="mb-2 mt-3 flex w-full items-center justify-between rounded-md border border-orange-100/70 bg-gradient-to-br from-white to-orange-50/60 px-3 py-2 text-left transition-colors hover:from-orange-50 hover:to-orange-100/60 dark:border-orange-950/40 dark:from-zinc-950 dark:to-orange-950/20 dark:hover:from-orange-950/30 dark:hover:to-orange-950/40"
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

      <div className="shrink-0 border-t border-orange-100/60 p-5 dark:border-orange-950/40">
        <div className="flex items-center gap-2.5 rounded-md border border-orange-100/70 bg-gradient-to-br from-white to-orange-50/60 px-2.5 py-2 dark:border-orange-950/40 dark:from-zinc-950 dark:to-orange-950/20">
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
            <div className="mt-px truncate text-[11px] leading-tight text-orange-700/80 dark:text-orange-400/70">
              Quality Control
            </div>
          </div>
          <MoreHorizontal className={cn('h-4 w-4 shrink-0 cursor-pointer text-orange-400/70 transition-opacity duration-[var(--sb-collapse-ms)] ease-[var(--sb-collapse-ease)] dark:text-orange-500/70', collapsed && 'md:opacity-0')} aria-hidden />
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
