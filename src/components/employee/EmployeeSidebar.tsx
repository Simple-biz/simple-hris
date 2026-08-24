'use client';

import React from 'react';
import { motion } from 'motion/react';
import { useTheme } from 'next-themes';
import { signOut } from 'next-auth/react';
import { withViewTransition } from '@/lib/theme/with-view-transition';
import { SESSION_EMAIL_KEY } from '@/lib/rbac/views';
import {
  LayoutDashboard,
  Bell,
  Clock,
  CalendarDays,
  Moon,
  Sun,
  LogOut,
  ChevronRight,
  UserCircle,
  Lock,
  Newspaper,
  Users,
  HeartHandshake,
  Trophy,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatDeptLabel, collapseHslFamilyLabel } from '@/lib/departments/hsl-subdept';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import ConstructionMark from '@/components/common/ConstructionMark';
import CollapsibleSidebarShell from '@/components/common/CollapsibleSidebarShell';
import SidebarLogoHeader from '@/components/common/SidebarLogoHeader';
import SidebarCollapsedDot from '@/components/common/SidebarCollapsedDot';
import EmployeeAvatar from './EmployeeAvatar';
import ViewSwitcher from '@/components/rbac/ViewSwitcher';
import { useSidebarCollapsed } from '@/hooks/useSidebarCollapsed';

interface EmployeeSidebarProps {
  activeTab: string;
  setActiveTab: (tab: string) => void;
  /** Below `md`, sidebar is a drawer. Desktop ignores this. */
  mobileOpen: boolean;
  employeeName?: string;
  department?: string;
  employeeId?: string;
  /** Used for Gravatar (same email as ?email= on /employee). */
  employeeEmail?: string | null;
  /** Supabase profile photo URL when set. */
  profilePhotoUrl?: string | null;
  /** Google SSO profile picture URL — used as a fallback when no Supabase upload exists. */
  googlePhotoUrl?: string | null;
  /** True while payroll dispatch is locked (read-only / limited actions). */
  payrollLocked?: boolean;
  /** Profile photo and/or bank details still missing — flags the Profile nav item. */
  profileIncomplete?: boolean;
  profileSetupCount?: number;
  /** Accounting/CEO asked this person to add missing payout details — escalates
   *  the Profile nav flag to a rose "!" blink. */
  bankInfoNudge?: boolean;
  /** Unread notification count — drives the bell badge in the sidebar. */
  unreadNotifications?: number;
  /** New MESA contributions since the member last opened MESA — badges that tab. */
  mesaNewCount?: number;
  /** Tab ids an admin hid in Pages settings — removed from the menu. */
  hiddenTabs?: readonly string[];
  /** Tab ids an admin marked "under construction" — shown with a badge. */
  constructionTabs?: readonly string[];
}

const navItems = [
  { id: 'dashboard', label: 'Overview', icon: LayoutDashboard },
  { id: 'profile', label: 'Profile', icon: UserCircle },
  { id: 'hours', label: 'My Hours', icon: Clock },
  { id: 'kpi', label: 'KPI Results', icon: Trophy },
  { id: 'leaves', label: 'Leave', icon: CalendarDays },
  // { id: 'disputes', label: 'My Disputes', icon: FileText }, // hidden — disputes now go through Orphanage Manager → Accounting flow (no employee submission)
  { id: 'mesa', label: 'MESA', icon: HeartHandshake },
  { id: 'team', label: 'My Team', icon: Users },
  { id: 'notifications', label: 'Notifications', icon: Bell },
];

export default function EmployeeSidebar({
  activeTab,
  setActiveTab,
  mobileOpen,
  employeeName = 'Employee',
  department,
  employeeId,
  employeeEmail = null,
  profilePhotoUrl = null,
  googlePhotoUrl = null,
  payrollLocked = false,

  profileIncomplete = false,
  profileSetupCount = 0,
  bankInfoNudge = false,
  unreadNotifications = 0,
  mesaNewCount = 0,
  hiddenTabs = [],
  constructionTabs = [],
}: EmployeeSidebarProps) {
  const isHidden = (id: string) => hiddenTabs.includes(id);
  const isConstr = (id: string) => constructionTabs.includes(id);

  // The team tab is named after the viewer's OWN department ("AI/API Team"),
  // falling back to "My Team" until the master record resolves. An `hsl:*` cell
  // collapses to a single "HSL" (hsl-subdepartments.md).
  //
  // The Pages registry (`src/lib/pages/visibility.ts`) deliberately keeps the
  // static "My Team" label for this tab: it is a workspace-wide admin control,
  // so it cannot carry a per-viewer name. Same for `humanizeTabId`, which feeds
  // presence and the document title — those stay comparable across the org.
  const teamTabLabel = collapseHslFamilyLabel(department ?? '') || 'My Team';
  const labelFor = (item: { id: string; label: string }) =>
    item.id === 'team' ? teamTabLabel : item.label;
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);
  const isDark = mounted ? resolvedTheme === 'dark' : false;
  const { collapsed, toggle } = useSidebarCollapsed();

  const initials = employeeName
    .split(' ')
    .map((w) => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);

  return (
    <CollapsibleSidebarShell
      collapsed={collapsed}
      onToggle={toggle}
      innerWidthClassName="md:w-64"
      accentClassName="border-orange-200/80 hover:text-orange-600 focus-visible:ring-orange-400 dark:border-blue-950/70 dark:hover:text-orange-300"
      id="employee-sidebar-nav"
      ariaLabel="Employee navigation"
      className={cn(
        // Base shell — drawer on mobile, static column on md+.
        'flex h-dvh w-[85vw] max-w-[20rem] shrink-0 flex-col border-r border-orange-100 bg-gradient-to-b from-white to-orange-50/40 text-zinc-600 dark:border-blue-950/60 dark:from-[#0d1117] dark:to-[#0f1729] dark:text-zinc-400 md:w-64 md:max-w-none md:shadow-none',
        // Off-canvas positioning and slide transition.
        'fixed inset-y-0 left-0 z-50 transform-gpu will-change-transform md:static md:z-auto md:translate-x-0 md:opacity-100',
        'transition-[transform,opacity,box-shadow,width] duration-[360ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
        mobileOpen
          ? 'translate-x-0 opacity-100 shadow-2xl shadow-black/25'
          : '-translate-x-full opacity-0 shadow-none md:translate-x-0 md:opacity-100',
      )}
    >
      <div className="flex min-h-0 flex-1 flex-col p-6">
        <div className="mb-8">
          <SidebarLogoHeader collapsed={collapsed} accentClassName="from-orange-500 to-amber-600" />
        </div>

        <ScrollArea className="-mx-2 min-h-0 flex-1">
          <nav className="space-y-1 px-2">
            {navItems.filter((item) => !isHidden(item.id)).map((item, index) => (
              <button
                key={item.id}
                onClick={() => setActiveTab(item.id)}
                title={collapsed ? labelFor(item) : undefined}
                style={{
                  // Stagger each nav item on mobile drawer open — no-op on desktop because
                  // md: utilities pin opacity/translate to the visible state.
                  transitionDelay: mobileOpen ? `${60 + index * 35}ms` : '0ms',
                }}
                className={cn(
                  'group flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-[background-color,color,transform,box-shadow,opacity] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
                  mobileOpen
                    ? 'translate-x-0 opacity-100'
                    : '-translate-x-6 opacity-0 md:translate-x-0 md:opacity-100',
                  activeTab === item.id
                    ? 'bg-gradient-to-r from-orange-100 to-orange-50 text-orange-900 shadow-sm dark:from-blue-950/70 dark:to-blue-950/40 dark:text-white'
                    : 'hover:bg-orange-50 hover:text-zinc-900 dark:hover:bg-blue-950/30 dark:hover:text-zinc-200',
                )}
              >
                <span className="relative shrink-0">
                  <item.icon
                    className={cn(
                      'h-4 w-4 transition-colors duration-200',
                      activeTab === item.id
                        ? 'text-orange-500 dark:text-orange-400'
                        : 'text-zinc-500 group-hover:text-orange-500 dark:text-zinc-500 dark:group-hover:text-orange-400',
                    )}
                  />
                  {/* Collapsed rail clips the full profile badge — keep the nudge
                      visible with a corner dot on the icon. */}
                  {item.id === 'profile' && profileIncomplete && activeTab !== 'profile' && (
                    <SidebarCollapsedDot
                      collapsed={collapsed}
                      tone={bankInfoNudge ? 'bg-rose-500' : 'bg-amber-500'}
                    />
                  )}
                  {/* Collapsed rail clips the count pill — keep a dot on the bell. */}
                  {item.id === 'notifications' && unreadNotifications > 0 && activeTab !== 'notifications' && (
                    <SidebarCollapsedDot collapsed={collapsed} tone="bg-red-500" />
                  )}
                  {/* Collapsed rail clips the MESA pill — keep a dot on the icon. */}
                  {item.id === 'mesa' && mesaNewCount > 0 && activeTab !== 'mesa' && (
                    <SidebarCollapsedDot collapsed={collapsed} tone="bg-emerald-500" />
                  )}
                </span>
                <span className={cn('truncate text-left sb-collapse-fade')}>{labelFor(item)}</span>
                {isConstr(item.id) && <span className={cn('sb-collapse-fade')}><ConstructionMark active={activeTab === item.id} /></span>}
                {item.id === 'profile' && profileIncomplete && activeTab !== 'profile' && (
                  <span
                    className={cn(
                      'relative ml-auto flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[10px] font-semibold leading-none text-white ring-2 ring-white dark:ring-[#0d1117] sb-collapse-fade',
                      bankInfoNudge ? 'bg-rose-500' : 'bg-amber-500',
                    )}
                    aria-label={bankInfoNudge ? 'Payroll requested your bank details' : 'Profile setup incomplete'}
                    title={bankInfoNudge ? 'Payroll asked you to add your bank / payout details' : 'Finish profile photo, payment details, and Skill Sets'}
                  >
                    <span className={cn('absolute inline-flex h-full w-full animate-ping rounded-full', bankInfoNudge ? 'bg-rose-500/60' : 'bg-amber-500/60')} />
                    <span className="relative">{bankInfoNudge ? '!' : (profileSetupCount || 1)}</span>
                  </span>
                )}
                {item.id === 'disputes' && payrollLocked && (
                  <motion.span
                    initial={{ opacity: 0, scale: 0.6 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ type: 'spring', stiffness: 320, damping: 20 }}
                    className={cn(
                      'ml-auto flex items-center gap-1 rounded-full border px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide',
                      activeTab === item.id
                        ? 'border-rose-300 bg-rose-100 text-rose-800 dark:border-rose-500/40 dark:bg-rose-500/20 dark:text-rose-200'
                        : 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300',
                    )}
                    aria-label="Issues paused — payroll is being processed"
                  >
                    <Lock className="h-2.5 w-2.5" aria-hidden />
                    Paused
                  </motion.span>
                )}
                {item.id === 'notifications' && unreadNotifications > 0 && (
                  <span
                    className={cn(
                      'ml-auto flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[10px] font-semibold leading-none text-white sb-collapse-fade',
                      activeTab === item.id ? 'bg-white/25 dark:bg-white/20' : 'bg-red-500',
                    )}
                    aria-label={`${unreadNotifications} unread notifications`}
                  >
                    {unreadNotifications > 99 ? '99+' : unreadNotifications}
                  </span>
                )}
                {item.id === 'mesa' && mesaNewCount > 0 && (
                  <span
                    className={cn(
                      'ml-auto flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[10px] font-semibold leading-none text-white sb-collapse-fade',
                      activeTab === item.id ? 'bg-white/25 dark:bg-white/20' : 'bg-emerald-500',
                    )}
                    aria-label={`${mesaNewCount} new MESA ${mesaNewCount === 1 ? 'contribution' : 'contributions'}`}
                    title={`${mesaNewCount} new MESA contribution${mesaNewCount === 1 ? '' : 's'} deposited`}
                  >
                    {mesaNewCount > 99 ? '99+' : mesaNewCount}
                  </span>
                )}
                {activeTab === item.id
                  && !(item.id === 'disputes' && payrollLocked)
                  && !(item.id === 'notifications' && unreadNotifications > 0)
                  && !(item.id === 'mesa' && mesaNewCount > 0) && (
                  <ChevronRight className="ml-auto h-3 w-3 text-orange-400 dark:text-orange-500/70 sb-collapse-fade" />
                )}
              </button>
            ))}
            {/* S-Wall — all authenticated users can view; employees comment/react only */}
            {!isHidden('s-wall') && (
            <button
              onClick={() => setActiveTab('s-wall')}
              title={collapsed ? 'S-Wall' : undefined}
              style={{ transitionDelay: mobileOpen ? `${60 + navItems.length * 35}ms` : '0ms' }}
              className={cn(
                'group flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-[background-color,color,transform,box-shadow,opacity] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
                mobileOpen ? 'translate-x-0 opacity-100' : '-translate-x-6 opacity-0 md:translate-x-0 md:opacity-100',
                activeTab === 's-wall'
                  ? 'bg-gradient-to-r from-violet-100 to-violet-50 text-violet-900 shadow-sm dark:from-violet-950/70 dark:to-violet-950/40 dark:text-white'
                  : 'hover:bg-violet-50 hover:text-zinc-900 dark:hover:bg-violet-950/30 dark:hover:text-zinc-200',
              )}
            >
              <Newspaper
                className={cn(
                  'h-4 w-4 shrink-0 transition-colors duration-200',
                  activeTab === 's-wall'
                    ? 'text-violet-500 dark:text-violet-400'
                    : 'text-zinc-500 group-hover:text-violet-500 dark:text-zinc-500 dark:group-hover:text-violet-400',
                )}
              />
              <span className={cn('truncate text-left sb-collapse-fade')}>S-Wall</span>
              {isConstr('s-wall') && <span className={cn('sb-collapse-fade')}><ConstructionMark active={activeTab === 's-wall'} /></span>}
              {activeTab === 's-wall' && (
                <ChevronRight className="ml-auto h-3 w-3 text-violet-400 dark:text-violet-500/70 sb-collapse-fade" />
              )}
            </button>
            )}
          </nav>

          {/* ViewSwitcher + theme toggle live INSIDE the scroll surface so they
              stay reachable via the same scrollbar on short viewports (matches HR). */}
          <div className="mt-5 px-2">
            <div className="border-t border-orange-100 pt-4 dark:border-blue-950/60">
              {payrollLocked && (
                <p className={cn('mb-2 flex items-center gap-1.5 rounded-md border border-amber-200/80 bg-amber-50/90 px-2.5 py-1.5 text-[10px] leading-tight text-amber-900 transition-opacity duration-[var(--sb-collapse-ms)] ease-[var(--sb-collapse-ease)] dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100/90', collapsed && 'md:opacity-0')}>
                  <Lock className="h-3 w-3 shrink-0" aria-hidden />
                  Payroll is being processed. Some changes may be unavailable.
                </p>
              )}
              <ViewSwitcher email={employeeEmail} currentView="employee" collapsed={collapsed} />
              <button
                onClick={() => withViewTransition(() => setTheme(isDark ? 'light' : 'dark'))}
                title={collapsed ? (isDark ? 'Dark mode' : 'Light mode') : undefined}
                className="mt-3 flex w-full items-center justify-between rounded-md border border-orange-100 bg-orange-50/60 px-3 py-2 transition-colors hover:bg-orange-100/80 dark:border-blue-950/60 dark:bg-blue-950/20 dark:hover:bg-blue-950/40"
                aria-label="Toggle dark mode"
              >
                <div className="flex items-center gap-2 text-zinc-700 dark:text-zinc-300">
                  {isDark ? <Moon className="h-4 w-4 shrink-0" /> : <Sun className="h-4 w-4 shrink-0" />}
                  <span className={cn('text-xs font-medium sb-collapse-fade')}>{isDark ? 'Dark mode' : 'Light mode'}</span>
                </div>
                <div className={cn('flex h-6 w-6 items-center justify-center rounded-md bg-white shadow-sm transition-opacity duration-[var(--sb-collapse-ms)] ease-[var(--sb-collapse-ease)] dark:bg-blue-950/60', collapsed && 'md:opacity-0')}>
                  {isDark ? (
                    <Sun className="h-3.5 w-3.5 text-orange-400" />
                  ) : (
                    <Moon className="h-3.5 w-3.5 text-blue-500" />
                  )}
                </div>
              </button>
            </div>
          </div>
        </ScrollArea>
      </div>

      <div
        style={{
          transitionDelay: mobileOpen ? `${60 + navItems.length * 35}ms` : '0ms',
        }}
        className={cn(
          'mt-auto border-t border-orange-100 p-4 transition-[transform,opacity] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none dark:border-blue-950/60',
          mobileOpen ? 'translate-x-0 opacity-100' : '-translate-x-6 opacity-0 md:translate-x-0 md:opacity-100',
        )}
      >
        <div className="mb-4 flex items-center gap-3 px-3 py-2">
          <EmployeeAvatar
            photoUrl={profilePhotoUrl}
            googlePhotoUrl={googlePhotoUrl}
            email={employeeEmail}
            initials={initials}
            className="h-9 w-9 text-xs"
            pixelSize={72}
          />
          <div className={cn('flex min-w-0 flex-col overflow-hidden sb-collapse-fade')}>
            <span className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-200">
              {employeeName}
            </span>
            {(department || employeeId) && (
              <span className="truncate text-[10px] text-zinc-500 dark:text-zinc-500">
                {formatDeptLabel(department) || '—'}{employeeId ? ` · ${employeeId}` : ''}
              </span>
            )}
          </div>
        </div>
        <Button
          variant="ghost"
          title={collapsed ? 'Sign Out' : undefined}
          className="w-full justify-start gap-3 text-zinc-600 hover:bg-red-500/10 hover:text-red-600 dark:text-zinc-500 dark:hover:text-red-400"
          onClick={() => {
            try {
              sessionStorage.removeItem(SESSION_EMAIL_KEY);
            } catch { /* ignore */ }
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
