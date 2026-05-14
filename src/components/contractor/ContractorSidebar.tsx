'use client';

import React from 'react';
import { motion } from 'motion/react';
import { useTheme } from 'next-themes';
import { signOut } from 'next-auth/react';
import { withViewTransition } from '@/lib/theme/with-view-transition';
import { SESSION_EMAIL_KEY } from '@/lib/rbac/views';
import {
  LayoutDashboard,
  FileText,
  UserCircle,
  Moon,
  Sun,
  LogOut,
  ChevronRight,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import EmployeeAvatar from '@/components/employee/EmployeeAvatar';
import ViewSwitcher from '@/components/rbac/ViewSwitcher';

interface ContractorSidebarProps {
  activeTab: string;
  setActiveTab: (tab: string) => void;
  /** Below `md`, sidebar is a drawer. Desktop ignores this. */
  mobileOpen: boolean;
  contractorName?: string;
  contractorEmail?: string | null;
  profilePhotoUrl?: string | null;
  googlePhotoUrl?: string | null;
}

const navItems = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'profile', label: 'Profile', icon: UserCircle },
  { id: 'invoices', label: 'Invoices', icon: FileText },
];

export default function ContractorSidebar({
  activeTab,
  setActiveTab,
  mobileOpen,
  contractorName = 'Contractor',
  contractorEmail = null,
  profilePhotoUrl = null,
  googlePhotoUrl = null,
}: ContractorSidebarProps) {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);
  const isDark = mounted ? resolvedTheme === 'dark' : false;

  const [logoBeat, setLogoBeat] = React.useState(false);
  React.useEffect(() => {
    const fire = () => setLogoBeat(true);
    const first = setTimeout(fire, 1000);
    const interval = setInterval(fire, 12000);
    return () => { clearTimeout(first); clearInterval(interval); };
  }, []);

  const initials = contractorName
    .split(' ')
    .map((w) => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);

  return (
    <aside
      className={cn(
        'flex h-dvh w-[85vw] max-w-[20rem] shrink-0 flex-col border-r border-blue-100 bg-gradient-to-b from-white to-blue-50/40 text-zinc-600 dark:border-blue-950/60 dark:from-[#0d1117] dark:to-[#0f1729] dark:text-zinc-400 md:w-64 md:max-w-none md:shadow-none',
        'fixed inset-y-0 left-0 z-50 will-change-transform md:static md:z-auto md:translate-x-0',
        'transition-[transform,box-shadow] duration-[360ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
        mobileOpen
          ? 'translate-x-0 shadow-2xl shadow-black/25'
          : '-translate-x-full shadow-none md:translate-x-0',
      )}
      id="contractor-sidebar-nav"
      role="navigation"
      aria-label="Contractor navigation"
    >
      <div className="flex min-h-0 flex-1 flex-col p-6">
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

        <ScrollArea className="-mx-2 min-h-0 flex-1">
          <nav className="space-y-1 px-2">
            {navItems.map((item, index) => (
              <button
                key={item.id}
                onClick={() => setActiveTab(item.id)}
                style={{
                  transitionDelay: mobileOpen ? `${60 + index * 35}ms` : '0ms',
                }}
                className={cn(
                  'group flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-[background-color,color,transform,box-shadow] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
                  mobileOpen
                    ? 'translate-x-0'
                    : '-translate-x-8 md:translate-x-0',
                  activeTab === item.id
                    ? 'bg-gradient-to-r from-blue-100 to-blue-50 text-blue-900 shadow-sm dark:from-blue-950/70 dark:to-blue-950/40 dark:text-white'
                    : 'hover:bg-blue-50 hover:text-zinc-900 dark:hover:bg-blue-950/30 dark:hover:text-zinc-200',
                )}
              >
                <item.icon
                  className={cn(
                    'h-4 w-4 transition-colors duration-200',
                    activeTab === item.id
                      ? 'text-blue-500 dark:text-blue-400'
                      : 'text-zinc-500 group-hover:text-blue-500 dark:text-zinc-500 dark:group-hover:text-blue-400',
                  )}
                />
                {item.label}
                {activeTab === item.id && (
                  <ChevronRight className="ml-auto h-3 w-3 text-blue-400 dark:text-blue-500/70" />
                )}
              </button>
            ))}
          </nav>
        </ScrollArea>
      </div>

      <div
        style={{
          transitionDelay: mobileOpen ? `${60 + navItems.length * 35}ms` : '0ms',
        }}
        className={cn(
          'mt-auto border-t border-blue-100 p-4 transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none dark:border-blue-950/60',
          mobileOpen ? 'translate-x-0' : '-translate-x-8 md:translate-x-0',
        )}
      >
        <ViewSwitcher email={contractorEmail} currentView="contractor" />
        <button
          onClick={() => withViewTransition(() => setTheme(isDark ? 'light' : 'dark'))}
          className="mb-2 flex w-full items-center justify-between rounded-md border border-blue-100 bg-blue-50/60 px-3 py-2 transition-colors hover:bg-blue-100/80 dark:border-blue-950/60 dark:bg-blue-950/20 dark:hover:bg-blue-950/40"
          aria-label="Toggle dark mode"
        >
          <div className="flex items-center gap-2 text-zinc-700 dark:text-zinc-300">
            {isDark ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
            <span className="text-xs font-medium">{isDark ? 'Dark mode' : 'Light mode'}</span>
          </div>
          <div className="flex h-6 w-6 items-center justify-center rounded-md bg-white shadow-sm dark:bg-blue-950/60">
            {isDark ? (
              <Sun className="h-3.5 w-3.5 text-blue-400" />
            ) : (
              <Moon className="h-3.5 w-3.5 text-blue-500" />
            )}
          </div>
        </button>
        <div className="mb-4 flex items-center gap-3 px-3 py-2">
          <EmployeeAvatar
            photoUrl={profilePhotoUrl}
            googlePhotoUrl={googlePhotoUrl}
            email={contractorEmail}
            initials={initials}
            className="h-9 w-9 text-xs"
            pixelSize={72}
          />
          <div className="flex min-w-0 flex-col overflow-hidden">
            <span className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-200">
              {contractorName}
            </span>
            <span className="truncate text-[10px] text-zinc-500 dark:text-zinc-500">
              Contractor
            </span>
          </div>
        </div>
        <Button
          variant="ghost"
          className="w-full justify-start gap-3 text-zinc-600 hover:bg-red-500/10 hover:text-red-600 dark:text-zinc-500 dark:hover:text-red-400"
          onClick={() => {
            try {
              sessionStorage.removeItem(SESSION_EMAIL_KEY);
              sessionStorage.removeItem('contractor_session_email');
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
