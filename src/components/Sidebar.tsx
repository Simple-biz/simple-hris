'use client';

import React from 'react';
import { motion } from 'motion/react';
import { useSearchParams } from 'next/navigation';
import { useTheme } from 'next-themes';
import { signOut } from 'next-auth/react';
import { withViewTransition } from '@/lib/theme/with-view-transition';
import {
  Bell,
  LayoutDashboard,
  Wand2,
  Wallet,
  AlertCircle,
  Megaphone,
  Newspaper,
  Send,
  Settings,
  ChevronRight,
  LogOut,
  Moon,
  Sun,
  HeartHandshake,
  Users,
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
import { normEmail } from '@/lib/email/norm-email';
import EmployeeAvatar from '@/components/employee/EmployeeAvatar';
import { useViewerProfilePhoto } from '@/hooks/useViewerProfilePhoto';
import { useDispatchLock } from '@/hooks/useDispatchLock';
import { useEmployeeNotificationsUnread } from '@/hooks/useEmployeeNotificationsUnread';
import { useSidebarCollapsed } from '@/hooks/useSidebarCollapsed';

function isPlausibleEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

interface SidebarProps {
  activeTab: string;
  setActiveTab: (tab: string) => void;
  /** Below `md`, sidebar is a drawer; when false it sits off-screen. Desktop ignores this. */
  mobileOpen: boolean;
  /** Tab ids the viewer is allowed to see, after the feature-permission
   *  overlay. Computed once by the parent App so the rail and content gate
   *  agree. */
  allowedTabs: readonly string[];
  /** Tab ids an admin marked "under construction" — shown with a badge. */
  constructionTabs?: readonly string[];
}

const navItems = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'people', label: 'People', icon: Users },
  { id: 'payroll-wizard', label: 'Payroll Wizard', icon: Wand2 },
  { id: 'bonus-catalog', label: 'Payment Catalog', icon: Wallet },
  { id: 'payment-dispatch', label: 'Payment Dispatch', icon: Send },
  { id: 'disputes', label: 'Issues', icon: AlertCircle },
  { id: 'mesa', label: 'MESA', icon: HeartHandshake },
  { id: 'announcements', label: 'Announcements', icon: Megaphone },
  { id: 'notifications', label: 'Notifications', icon: Bell },
  { id: 'settings', label: 'System Settings', icon: Settings },
];

export default function Sidebar({ activeTab, setActiveTab, mobileOpen, allowedTabs, constructionTabs = [] }: SidebarProps) {
  const isConstr = (id: string) => constructionTabs.includes(id);
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);
  const [email, setEmail] = React.useState<string | null>(null);
  const [roles, setRoles] = React.useState<string[]>([]);
  const searchParams = useSearchParams();
  const emailFromQuery = searchParams?.get('email') ?? null;
  React.useEffect(() => {
    setMounted(true);
    try {
      const q = emailFromQuery?.trim() ?? '';
      if (q && isPlausibleEmail(q)) {
        const normalized = normEmail(q) ?? q.toLowerCase();
        sessionStorage.setItem(SESSION_EMAIL_KEY, normalized);
        setEmail(normalized);
        return;
      }
      setEmail(sessionStorage.getItem(SESSION_EMAIL_KEY));
    } catch {
      /* ignore */
    }
  }, [emailFromQuery]);
  React.useEffect(() => {
    const e = (email || '').trim();
    if (!e) { setRoles([]); return; }
    let cancelled = false;
    fetch(`/api/employee-roles?email=${encodeURIComponent(e)}`, { cache: 'no-store' })
      .then(r => r.json())
      .then((j: { rows?: { role: string }[] }) => {
        if (cancelled) return;
        setRoles((j.rows ?? []).map(r => r.role));
      })
      .catch(() => { if (!cancelled) setRoles([]); });
    return () => { cancelled = true; };
  }, [email]);
  const isDark = mounted ? resolvedTheme === 'dark' : false;

  const [logoBeat, setLogoBeat] = React.useState(false);
  React.useEffect(() => {
    const fire = () => setLogoBeat(true);
    const first = setTimeout(fire, 5000);
    const interval = setInterval(fire, 12000);
    return () => { clearTimeout(first); clearInterval(interval); };
  }, []);

  const { profilePhotoUrl, googlePhotoUrl } = useViewerProfilePhoto(email);
  const { state: lockState } = useDispatchLock();
  const { collapsed, toggle } = useSidebarCollapsed();
  const unreadNotifications = useEmployeeNotificationsUnread(email);
  const allowedTabSet = React.useMemo(() => new Set<string>(allowedTabs), [allowedTabs]);
  const visibleNavItems = React.useMemo(
    () => navItems.filter((item) => allowedTabSet.has(item.id)),
    [allowedTabSet],
  );

  return (
    <CollapsibleSidebarShell
      as="div"
      collapsed={collapsed}
      onToggle={toggle}
      innerWidthClassName="md:w-64"
      accentClassName="border-orange-200/80 hover:text-orange-600 focus-visible:ring-orange-400 dark:border-blue-950/70 dark:hover:text-orange-300"
      id="accounting-sidebar-nav"
      ariaLabel="Accounting navigation"
      className={cn(
        'flex h-dvh w-64 max-w-[min(100vw,16rem)] shrink-0 flex-col border-r border-orange-100 bg-gradient-to-b from-white to-orange-50/40 text-zinc-600 shadow-xl dark:border-blue-950/60 dark:from-[#0d1117] dark:to-[#0f1729] dark:text-zinc-400 md:max-w-none md:shadow-none',
        'fixed inset-y-0 left-0 z-50 transition-[transform,width] duration-300 ease-out md:static md:z-auto md:translate-x-0',
        mobileOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0',
      )}
    >
      <div className="flex min-h-0 flex-1 flex-col p-6">
        <div className="mb-8 shrink-0">
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
                alt="Simple Accounting HRIS"
                className={cn('h-10 w-full object-contain transition-opacity duration-[var(--sb-collapse-ms)] ease-[var(--sb-collapse-ease)]', collapsed && 'md:opacity-0', logoBeat && 'logo-heartbeat')}
                onAnimationEnd={() => setLogoBeat(false)}
              />
              <SidebarBrandMark
              className={cn('pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 opacity-0 transition-opacity duration-[var(--sb-collapse-ms)] ease-[var(--sb-collapse-ease)] from-orange-500 to-amber-600', collapsed && 'md:opacity-100')}
            />
            </div>
          </a>
        </div>

        <ScrollArea className="-mx-2 min-h-0 flex-1">
          <nav className="space-y-1 px-2">
            {visibleNavItems.filter((item) => item.id !== 's-wall').map((item) => (
              <button
                key={item.id}
                onClick={() => setActiveTab(item.id)}
                title={collapsed ? item.label : undefined}
                className={cn(
                  'group flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-all duration-200',
                  activeTab === item.id
                    ? 'bg-gradient-to-r from-orange-100 to-orange-50 text-orange-900 shadow-sm dark:from-blue-950/70 dark:to-blue-950/40 dark:text-white'
                    : 'hover:bg-orange-50 hover:text-zinc-900 dark:hover:bg-blue-950/30 dark:hover:text-zinc-200',
                )}
              >
                <item.icon
                  className={cn(
                    'h-4 w-4 shrink-0',
                    activeTab === item.id
                      ? 'text-orange-500 dark:text-orange-400'
                      : 'text-zinc-500 group-hover:text-orange-500 dark:text-zinc-500 dark:group-hover:text-orange-400',
                  )}
                />
                <span className={cn('truncate transition-opacity duration-[var(--sb-collapse-ms)] ease-[var(--sb-collapse-ease)]', collapsed && 'md:opacity-0')}>{item.label}</span>
                {isConstr(item.id) && <span className={cn('transition-opacity duration-[var(--sb-collapse-ms)] ease-[var(--sb-collapse-ease)]', collapsed && 'md:opacity-0')}><ConstructionMark active={activeTab === item.id} /></span>}
                {item.id === 'notifications' && unreadNotifications > 0 && activeTab !== 'notifications'
                  ? (
                    <span className="relative ml-auto inline-flex">
                      <span className="absolute inset-0 -m-0.5 animate-ping rounded-full bg-rose-500/60" />
                      <span className="absolute inset-0 animate-pulse rounded-full bg-rose-500/30 blur-[2px]" />
                      <motion.span
                        initial={{ opacity: 0, scale: 0.4, y: -4 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        transition={{ type: 'spring', stiffness: 420, damping: 14 }}
                        key={unreadNotifications}
                        className={cn(
                          'relative inline-flex min-w-[1.35rem] items-center justify-center rounded-full px-1.5 py-0.5 text-[10.5px] font-bold tabular-nums text-white',
                          'bg-gradient-to-br from-rose-500 via-red-500 to-orange-500',
                          'shadow-[0_0_0_2px_rgba(255,255,255,0.9),0_4px_12px_-2px_rgba(244,63,94,0.6)]',
                          'dark:shadow-[0_0_0_2px_rgba(13,17,23,0.95),0_4px_14px_-2px_rgba(244,63,94,0.7)]',
                          'ring-1 ring-rose-300/70 dark:ring-rose-400/40',
                        )}
                        aria-label={`${unreadNotifications} unread notifications`}
                      >
                        {unreadNotifications > 99 ? '99+' : unreadNotifications}
                      </motion.span>
                    </span>
                  )
                  : item.id === 'notifications' && unreadNotifications === 0 && lockState.locked
                    ? <span className="ml-auto h-2 w-2 animate-pulse rounded-full bg-red-500" />
                    : activeTab === item.id && (
                      <ChevronRight className="ml-auto h-3 w-3 text-orange-400 dark:text-orange-500/70" />
                    )
                }
              </button>
            ))}
            {allowedTabSet.has('s-wall') && (
              <button
                onClick={() => setActiveTab('s-wall')}
                title={collapsed ? 'S-Wall' : undefined}
                className={cn(
                  'group/sw flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-all duration-200',
                  activeTab === 's-wall'
                    ? 'bg-gradient-to-r from-violet-100 to-violet-50 text-violet-900 shadow-sm dark:from-violet-950/70 dark:to-violet-950/40 dark:text-white'
                    : 'hover:bg-violet-50 hover:text-zinc-900 dark:hover:bg-violet-950/30 dark:hover:text-zinc-200',
                )}
              >
                <Newspaper
                  className={cn(
                    'h-4 w-4 shrink-0',
                    activeTab === 's-wall'
                      ? 'text-violet-500 dark:text-violet-400'
                      : 'text-zinc-500 group-hover/sw:text-violet-500 dark:text-zinc-500 dark:group-hover/sw:text-violet-400',
                  )}
                />
                <span className={cn('transition-opacity duration-[var(--sb-collapse-ms)] ease-[var(--sb-collapse-ease)]', collapsed && 'md:opacity-0')}><SWallNavLabel /></span>
                {isConstr('s-wall') && <span className={cn('transition-opacity duration-[var(--sb-collapse-ms)] ease-[var(--sb-collapse-ease)]', collapsed && 'md:opacity-0')}><ConstructionMark active={activeTab === 's-wall'} /></span>}
                {activeTab === 's-wall' && (
                  <ChevronRight className="ml-auto h-3 w-3 text-violet-400 dark:text-violet-500/70" />
                )}
              </button>
            )}
          </nav>
        </ScrollArea>
      </div>

      <div className="mt-auto border-t border-orange-100 p-4 dark:border-blue-950/60">
        <div className={cn('transition-opacity duration-[var(--sb-collapse-ms)] ease-[var(--sb-collapse-ease)]', collapsed && 'md:opacity-0')}>
          <ViewSwitcher email={email} currentView="accounting" />
        </div>
        <button
          onClick={() => withViewTransition(() => setTheme(isDark ? 'light' : 'dark'))}
          title={collapsed ? (isDark ? 'Dark mode' : 'Light mode') : undefined}
          className="mb-2 flex w-full items-center justify-between rounded-md border border-orange-100 bg-orange-50/60 px-3 py-2 transition-colors hover:bg-orange-100/80 dark:border-blue-950/60 dark:bg-blue-950/20 dark:hover:bg-blue-950/40"
          aria-label="Toggle dark mode"
        >
          <div className="flex items-center gap-2 text-zinc-700 dark:text-zinc-300">
            {isDark ? <Moon className="h-4 w-4 shrink-0" /> : <Sun className="h-4 w-4 shrink-0" />}
            <span className={cn('text-xs font-medium transition-opacity duration-[var(--sb-collapse-ms)] ease-[var(--sb-collapse-ease)]', collapsed && 'md:opacity-0')}>{isDark ? 'Dark mode' : 'Light mode'}</span>
          </div>
          <div className={cn('flex h-6 w-6 items-center justify-center rounded-md bg-white shadow-sm transition-opacity duration-[var(--sb-collapse-ms)] ease-[var(--sb-collapse-ease)] dark:bg-blue-950/60', collapsed && 'md:opacity-0')}>
            {isDark ? (
              <Sun className="h-3.5 w-3.5 text-orange-400" />
            ) : (
              <Moon className="h-3.5 w-3.5 text-blue-500" />
            )}
          </div>
        </button>
        <div className="mb-4 flex items-center gap-2.5 rounded-md border border-orange-100 bg-orange-50/60 px-2.5 py-2 dark:border-blue-950/60 dark:bg-blue-950/20">
          <EmployeeAvatar
            photoUrl={profilePhotoUrl}
            googlePhotoUrl={googlePhotoUrl}
            email={email}
            initials={(email || '?').slice(0, 2).toUpperCase()}
            className="h-7 w-7 shrink-0 text-[11px]"
            pixelSize={56}
          />
          <div className={cn('flex min-w-0 flex-col overflow-hidden transition-opacity duration-[var(--sb-collapse-ms)] ease-[var(--sb-collapse-ease)]', collapsed && 'md:opacity-0')}>
            <span className="truncate text-[13px] font-medium leading-tight text-zinc-900 dark:text-zinc-200" title={email ?? undefined}>{email || 'Not signed in'}</span>
            <span className="truncate text-[11px] leading-tight text-zinc-500 dark:text-zinc-500">
              Accounting
              {roles.length > 0 && (
                <> · <span className="font-mono text-[10px] text-orange-600 dark:text-orange-400" title={roles.join(', ')}>{roles.join(', ')}</span></>
              )}
            </span>
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
          <span className={cn('transition-opacity duration-[var(--sb-collapse-ms)] ease-[var(--sb-collapse-ease)]', collapsed && 'md:opacity-0')}>Sign Out</span>
        </Button>
      </div>
    </CollapsibleSidebarShell>
  );
}
