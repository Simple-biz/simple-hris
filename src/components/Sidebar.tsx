'use client';

import React from 'react';
import { useSearchParams } from 'next/navigation';
import { useTheme } from 'next-themes';
import { signOut } from 'next-auth/react';
import { withViewTransition } from '@/lib/theme/with-view-transition';
import {
  LayoutDashboard,
  DollarSign,
  Wand2,
  Building2,
  AlertCircle,
  CalendarDays,
  Megaphone,
  Newspaper,
  Send,
  Settings,
  ChevronRight,
  LogOut,
  Moon,
  Sun,
} from 'lucide-react';
import { SWallNavLabel } from '@/components/swall/SWall';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import ViewSwitcher from '@/components/rbac/ViewSwitcher';
import { SESSION_EMAIL_KEY } from '@/lib/rbac/views';
import { normEmail } from '@/lib/email/norm-email';
import { allowedAccountingTabsForRoles } from '@/lib/rbac/accounting-tabs';

function isPlausibleEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

interface SidebarProps {
  activeTab: string;
  setActiveTab: (tab: string) => void;
  /** Below `md`, sidebar is a drawer; when false it sits off-screen. Desktop ignores this. */
  mobileOpen: boolean;
}

const navItems = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'rates', label: 'Rates', icon: DollarSign },
  { id: 'payroll-wizard', label: 'Payroll Wizard', icon: Wand2 },
  { id: 'hogan-suite', label: 'Hogan Suite', icon: Building2 },
  { id: 'payment-dispatch', label: 'Payment Dispatch', icon: Send },
  { id: 'leave-requests', label: 'Leave requests', icon: CalendarDays },
  { id: 'disputes', label: 'Orphanage Disputes', icon: AlertCircle },
  { id: 'announcements', label: 'Announcements', icon: Megaphone },
  { id: 'settings', label: 'System Settings', icon: Settings },
];

export default function Sidebar({ activeTab, setActiveTab, mobileOpen }: SidebarProps) {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);
  const [email, setEmail] = React.useState<string | null>(null);
  const [roles, setRoles] = React.useState<string[]>([]);
  const searchParams = useSearchParams();
  const emailFromQuery = searchParams.get('email');
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
  const allowedTabs = React.useMemo(() => allowedAccountingTabsForRoles(roles), [roles]);
  const allowedTabSet = React.useMemo(() => new Set<string>(allowedTabs), [allowedTabs]);
  const visibleNavItems = React.useMemo(
    () => navItems.filter((item) => allowedTabSet.has(item.id)),
    [allowedTabSet],
  );

  return (
    <div
      className={cn(
        'flex h-dvh w-64 max-w-[min(100vw,16rem)] shrink-0 flex-col border-r border-orange-100 bg-gradient-to-b from-white to-orange-50/40 text-zinc-600 shadow-xl dark:border-blue-950/60 dark:from-[#0d1117] dark:to-[#0f1729] dark:text-zinc-400 md:max-w-none md:shadow-none',
        'fixed inset-y-0 left-0 z-50 transition-transform duration-300 ease-out md:static md:z-auto md:translate-x-0',
        mobileOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0',
      )}
      id="accounting-sidebar-nav"
      role="navigation"
      aria-label="Accounting navigation"
    >
      <div className="p-6">
        <div className="mb-8 flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-orange-500 to-orange-600 shadow-md shadow-orange-500/30">
            <Wand2 className="h-5 w-5 text-white" />
          </div>
          <div>
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.24em] text-orange-600/80 dark:text-orange-400/80">
              Accounting HRIS
            </p>
            <div className="rounded-md bg-white px-2 py-1">
              <img
                src="/simple-logo.png"
                alt="Simple Accounting HRIS"
                className="h-5 w-auto object-contain"
              />
            </div>
          </div>
        </div>

        <ScrollArea className="-mx-2 flex-1">
          <nav className="space-y-1 px-2">
            {visibleNavItems.filter((item) => item.id !== 's-wall').map((item) => (
              <button
                key={item.id}
                onClick={() => setActiveTab(item.id)}
                className={cn(
                  'group flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-all duration-200',
                  activeTab === item.id
                    ? 'bg-gradient-to-r from-orange-100 to-orange-50 text-orange-900 shadow-sm dark:from-blue-950/70 dark:to-blue-950/40 dark:text-white'
                    : 'hover:bg-orange-50 hover:text-zinc-900 dark:hover:bg-blue-950/30 dark:hover:text-zinc-200',
                )}
              >
                <item.icon
                  className={cn(
                    'h-4 w-4',
                    activeTab === item.id
                      ? 'text-orange-500 dark:text-orange-400'
                      : 'text-zinc-500 group-hover:text-orange-500 dark:text-zinc-500 dark:group-hover:text-orange-400',
                  )}
                />
                {item.label}
                {activeTab === item.id && (
                  <ChevronRight className="ml-auto h-3 w-3 text-orange-400 dark:text-orange-500/70" />
                )}
              </button>
            ))}
            {allowedTabSet.has('s-wall') && (
              <button
                onClick={() => setActiveTab('s-wall')}
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
                <SWallNavLabel />
                {activeTab === 's-wall' && (
                  <ChevronRight className="ml-auto h-3 w-3 text-violet-400 dark:text-violet-500/70" />
                )}
              </button>
            )}
          </nav>
        </ScrollArea>
      </div>

      <div className="mt-auto border-t border-orange-100 p-4 dark:border-blue-950/60">
        <ViewSwitcher email={email} currentView="accounting" />
        <button
          onClick={() => withViewTransition(() => setTheme(isDark ? 'light' : 'dark'))}
          className="mb-2 flex w-full items-center justify-between rounded-md border border-orange-100 bg-orange-50/60 px-3 py-2 transition-colors hover:bg-orange-100/80 dark:border-blue-950/60 dark:bg-blue-950/20 dark:hover:bg-blue-950/40"
          aria-label="Toggle dark mode"
        >
          <div className="flex items-center gap-2 text-zinc-700 dark:text-zinc-300">
            {isDark ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
            <span className="text-xs font-medium">{isDark ? 'Dark mode' : 'Light mode'}</span>
          </div>
          <div className="flex h-6 w-6 items-center justify-center rounded-md bg-white shadow-sm dark:bg-blue-950/60">
            {isDark ? (
              <Sun className="h-3.5 w-3.5 text-orange-400" />
            ) : (
              <Moon className="h-3.5 w-3.5 text-blue-500" />
            )}
          </div>
        </button>
        <div className="mb-4 flex items-center gap-3 px-3 py-2">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-orange-400 to-blue-500 text-xs font-bold text-white shadow-sm">
            {(email || '?').slice(0, 2).toUpperCase()}
          </div>
          <div className="flex min-w-0 flex-col overflow-hidden">
            <span className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-200" title={email ?? undefined}>{email || 'Not signed in'}</span>
            <span className="truncate text-xs text-zinc-500 dark:text-zinc-500">
              Accounting operations
              {roles.length > 0 && (
                <> · <span className="font-mono text-[10px] text-orange-600 dark:text-orange-400" title={roles.join(', ')}>{roles.join(', ')}</span></>
              )}
            </span>
          </div>
        </div>
        <Button
          variant="ghost"
          className="w-full justify-start gap-3 text-zinc-600 hover:bg-red-500/10 hover:text-red-600 dark:text-zinc-500 dark:hover:text-red-400"
          onClick={() => {
            try {
              sessionStorage.removeItem(SESSION_EMAIL_KEY);
            } catch { /* ignore */ }
            void signOut({ callbackUrl: '/login' });
          }}
        >
          <LogOut className="h-4 w-4" />
          Sign Out
        </Button>
      </div>
    </div>
  );
}
