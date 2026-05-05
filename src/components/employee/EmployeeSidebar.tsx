'use client';

import React from 'react';
import { motion } from 'motion/react';
import { useTheme } from 'next-themes';
import { signOut } from 'next-auth/react';
import { withViewTransition } from '@/lib/theme/with-view-transition';
import { SESSION_EMAIL_KEY } from '@/lib/rbac/views';
import {
  LayoutDashboard,
  Clock,
  CalendarDays,
  Moon,
  Sun,
  LogOut,
  ChevronRight,
  User,
  UserCircle,
  Lock,
  Megaphone,
  Newspaper,
  ScrollText,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import EmployeeAvatar from './EmployeeAvatar';
import ViewSwitcher from '@/components/rbac/ViewSwitcher';

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
}

const navItems = [
  { id: 'dashboard', label: 'Overview', icon: LayoutDashboard },
  { id: 'profile', label: 'Profile', icon: UserCircle },
  { id: 'hours', label: 'My Hours', icon: Clock },
  { id: 'leaves', label: 'Leave', icon: CalendarDays },
  // { id: 'disputes', label: 'My Disputes', icon: FileText }, // hidden — disputes now go through Orphanage Manager → Accounting flow (no employee submission)
  { id: 'policies', label: 'Policies', icon: ScrollText },
  { id: 'announcements', label: 'Announcements', icon: Megaphone },
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
}: EmployeeSidebarProps) {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);
  const isDark = mounted ? resolvedTheme === 'dark' : false;

  const initials = employeeName
    .split(' ')
    .map((w) => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);

  return (
    <aside
      className={cn(
        // Base shell — drawer on mobile, static column on md+.
        'flex h-dvh w-[85vw] max-w-[20rem] shrink-0 flex-col border-r border-orange-100 bg-gradient-to-b from-white to-orange-50/40 text-zinc-600 dark:border-blue-950/60 dark:from-[#0d1117] dark:to-[#0f1729] dark:text-zinc-400 md:w-64 md:max-w-none md:shadow-none',
        // Off-canvas positioning and slide transition.
        'fixed inset-y-0 left-0 z-50 will-change-transform md:static md:z-auto md:translate-x-0',
        'transition-[transform,box-shadow] duration-[360ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
        mobileOpen
          ? 'translate-x-0 shadow-2xl shadow-black/25'
          : '-translate-x-full shadow-none md:translate-x-0',
      )}
      id="employee-sidebar-nav"
      role="navigation"
      aria-label="Employee navigation"
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-6">
        <div className="mb-8 flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-orange-500 to-orange-600 shadow-md shadow-orange-500/30">
            <User className="h-5 w-5 text-white" />
          </div>
          <div className="rounded-md bg-white px-2.5 py-1.5">
            <img
              src="/simple-logo.png"
              alt="Simple HRIS"
              className="h-7 w-auto object-contain"
            />
          </div>
        </div>

        <ScrollArea className="-mx-2 flex-1">
          <nav className="space-y-1 px-2">
            {navItems.map((item, index) => (
              <button
                key={item.id}
                onClick={() => setActiveTab(item.id)}
                style={{
                  // Stagger each nav item on mobile drawer open — no-op on desktop because
                  // md: utilities pin opacity/translate to the visible state.
                  transitionDelay: mobileOpen ? `${60 + index * 35}ms` : '0ms',
                }}
                className={cn(
                  'group flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-[background-color,color,transform,box-shadow] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
                  mobileOpen
                    ? 'translate-x-0'
                    : '-translate-x-8 md:translate-x-0',
                  activeTab === item.id
                    ? 'bg-gradient-to-r from-orange-100 to-orange-50 text-orange-900 shadow-sm dark:from-blue-950/70 dark:to-blue-950/40 dark:text-white'
                    : 'hover:bg-orange-50 hover:text-zinc-900 dark:hover:bg-blue-950/30 dark:hover:text-zinc-200',
                )}
              >
                <item.icon
                  className={cn(
                    'h-4 w-4 transition-colors duration-200',
                    activeTab === item.id
                      ? 'text-orange-500 dark:text-orange-400'
                      : 'text-zinc-500 group-hover:text-orange-500 dark:text-zinc-500 dark:group-hover:text-orange-400',
                  )}
                />
                {item.label}
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
                    aria-label="Disputes paused — payroll is being processed"
                  >
                    <Lock className="h-2.5 w-2.5" aria-hidden />
                    Paused
                  </motion.span>
                )}
                {activeTab === item.id && !(item.id === 'disputes' && payrollLocked) && (
                  <ChevronRight className="ml-auto h-3 w-3 text-orange-400 dark:text-orange-500/70" />
                )}
              </button>
            ))}
            {/* S-Wall — all authenticated users can view; employees comment/react only */}
            <button
              onClick={() => setActiveTab('s-wall')}
              style={{ transitionDelay: mobileOpen ? `${60 + navItems.length * 35}ms` : '0ms' }}
              className={cn(
                'group flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-[background-color,color,transform,box-shadow] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
                mobileOpen ? 'translate-x-0' : '-translate-x-8 md:translate-x-0',
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
              S-Wall
              {activeTab === 's-wall' && (
                <ChevronRight className="ml-auto h-3 w-3 text-violet-400 dark:text-violet-500/70" />
              )}
            </button>
          </nav>
        </ScrollArea>
      </div>

      <div
        style={{
          transitionDelay: mobileOpen ? `${60 + navItems.length * 35}ms` : '0ms',
        }}
        className={cn(
          'mt-auto border-t border-orange-100 p-4 transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none dark:border-blue-950/60',
          mobileOpen ? 'translate-x-0' : '-translate-x-8 md:translate-x-0',
        )}
      >
        {payrollLocked && (
          <p className="mb-2 flex items-center gap-1.5 rounded-md border border-amber-200/80 bg-amber-50/90 px-2.5 py-1.5 text-[10px] leading-tight text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100/90">
            <Lock className="h-3 w-3 shrink-0" aria-hidden />
            Payroll is being processed. Some changes may be unavailable.
          </p>
        )}
        <ViewSwitcher email={employeeEmail} currentView="employee" />
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
          <EmployeeAvatar
            photoUrl={profilePhotoUrl}
            googlePhotoUrl={googlePhotoUrl}
            email={employeeEmail}
            initials={initials}
            className="h-9 w-9 text-xs"
            pixelSize={72}
          />
          <div className="flex min-w-0 flex-col overflow-hidden">
            <span className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-200">
              {employeeName}
            </span>
            {(department || employeeId) && (
              <span className="truncate text-[10px] text-zinc-500 dark:text-zinc-500">
                {department || '—'}{employeeId ? ` · ${employeeId}` : ''}
              </span>
            )}
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
          Log Out
        </Button>
      </div>
    </aside>
  );
}
