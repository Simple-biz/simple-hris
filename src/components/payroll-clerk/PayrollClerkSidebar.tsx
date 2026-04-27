'use client';

import React from 'react';
import { useTheme } from 'next-themes';
import { signOut } from 'next-auth/react';
import { withViewTransition } from '@/lib/theme/with-view-transition';
import {
  Banknote,
  Coins,
  Globe2,
  LogOut,
  MoreHorizontal,
  Moon,
  Send,
  Sun,
  Wallet,
  Wifi,
  Wallet2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import ViewSwitcher from '@/components/rbac/ViewSwitcher';
import { SESSION_EMAIL_KEY } from '@/lib/rbac/views';
import { PROCESSORS, type ProcessorId } from './mock-queue';

const PROCESSOR_ICONS: Record<ProcessorId, React.ComponentType<{ className?: string }>> = {
  hurupay: Coins,
  wepay: Wallet,
  higlobe: Globe2,
  wise: Wallet2,
  jeeves: Wifi,
  wires: Banknote,
};

interface PayrollClerkSidebarProps {
  activeTab: string;
  setActiveTab: (tab: string) => void;
  mobileOpen: boolean;
  viewerEmail: string | null;
  /** Map of processor id → number of pending rows (for badges). */
  counts: Record<ProcessorId, number>;
  cycleReady: boolean;
}

export default function PayrollClerkSidebar({
  activeTab,
  setActiveTab,
  mobileOpen,
  viewerEmail,
  counts,
  cycleReady,
}: PayrollClerkSidebarProps) {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => {
    setMounted(true);
  }, []);

  const isDark = mounted ? resolvedTheme === 'dark' : false;

  const displayName = viewerEmail?.includes('@')
    ? viewerEmail.split('@')[0]!.replace(/[._-]/g, ' ')
    : viewerEmail || 'Lenny';
  const titleName = displayName
    .split(' ')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

  const navBtn = (
    id: string,
    label: string,
    Icon: React.ComponentType<{ className?: string }>,
    badge?: React.ReactNode,
  ) => (
    <button
      key={id}
      type="button"
      onClick={() => setActiveTab(id)}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-md px-2.5 py-[7px] text-[13.5px] font-[450] text-[#3f3f46] transition-colors',
        activeTab === id ? 'bg-[#18181b] font-medium text-white' : 'hover:bg-[#f3f3f3] hover:text-[#18181b]',
      )}
    >
      <Icon
        className={cn(
          'h-[15px] w-[15px] shrink-0',
          activeTab === id ? 'text-white/75' : 'text-[#a1a1aa]',
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
            ? 'bg-white/15 text-white/90'
            : 'bg-[#f3f3f3] text-[#71717a] dark:bg-zinc-800 dark:text-zinc-400',
        )}
      >
        {n}
      </span>
    );
  };

  return (
    <aside
      className={cn(
        'flex h-dvh w-[220px] max-w-[min(100vw,220px)] shrink-0 flex-col border-r border-[#ececec] bg-white shadow-xl dark:border-zinc-800 dark:bg-zinc-950 md:max-w-none md:shadow-none',
        'fixed inset-y-0 left-0 z-50 transition-transform duration-300 ease-out md:static md:z-auto md:translate-x-0',
        mobileOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0',
      )}
      id="payroll-clerk-sidebar-nav"
      role="navigation"
      aria-label="Payroll clerk navigation"
    >
      <div className="flex flex-1 flex-col px-5 pb-4 pt-7">
        <div className="mb-8 flex items-center gap-2.5 px-1">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] bg-[#18181b] text-sm font-bold tracking-[-0.02em] text-white dark:bg-zinc-100 dark:text-zinc-900">
            s
          </div>
          <div className="flex min-w-0 flex-col leading-tight">
            <span className="text-[13.5px] font-semibold tracking-[-0.01em] text-[#18181b] dark:text-zinc-100">
              simple·hris
            </span>
            <span className="mt-0.5 text-[10.5px] tracking-[0.02em] text-[#71717a] dark:text-zinc-500">
              Payroll clerk
            </span>
          </div>
        </div>

        <div
          className={cn(
            'mb-5 flex items-center gap-2 rounded-md border px-2.5 py-2 text-[11px] font-medium',
            cycleReady
              ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-400'
              : 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-400',
          )}
        >
          <span
            className={cn(
              'inline-block h-1.5 w-1.5 rounded-full',
              cycleReady ? 'bg-emerald-500' : 'bg-amber-500',
            )}
          />
          {cycleReady ? 'Cycle ready · dispatching' : 'No cycle ready yet'}
        </div>

        <ScrollArea className="min-h-0 flex-1 pr-2">
          <p className="mb-1.5 px-2.5 text-[10.5px] font-medium uppercase tracking-[0.06em] text-[#a1a1aa]">
            Queues
          </p>
          <nav className="flex flex-col gap-px">
            {navBtn(
              'all',
              'All pending',
              Send,
              countBadge(
                Object.values(counts).reduce((a, b) => a + b, 0),
                activeTab === 'all',
              ),
            )}
            {PROCESSORS.map((p) => {
              const Icon = PROCESSOR_ICONS[p.id];
              return navBtn(p.id, p.label, Icon, countBadge(counts[p.id] ?? 0, activeTab === p.id));
            })}
          </nav>

          <div className="my-5 mx-2.5 h-px bg-[#ececec] dark:bg-zinc-800" />

          <p className="mb-1.5 px-2.5 text-[10.5px] font-medium uppercase tracking-[0.06em] text-[#a1a1aa]">
            History
          </p>
          <nav className="flex flex-col gap-px">{navBtn('history', 'Sent payments', Banknote)}</nav>

          <div className="mt-6 border-t border-[#ececec] pt-4 dark:border-zinc-800">
            <ViewSwitcher email={viewerEmail} currentView="accounting" />
            <button
              type="button"
              onClick={() => withViewTransition(() => setTheme(isDark ? 'light' : 'dark'))}
              className="mb-2 mt-3 flex w-full items-center justify-between rounded-md border border-[#ececec] bg-[#fafaf8] px-3 py-2 text-left transition-colors hover:bg-[#f3f3f3] dark:border-zinc-800 dark:bg-zinc-900 dark:hover:bg-zinc-800"
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

      <div className="mt-auto border-t border-[#ececec] p-5 dark:border-zinc-800">
        <div className="flex items-center gap-2.5 rounded-md border border-[#ececec] bg-[#fafaf8] px-2.5 py-2 dark:border-zinc-800 dark:bg-zinc-900">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#18181b] text-[11px] font-semibold text-white dark:bg-zinc-200 dark:text-zinc-900">
            {(viewerEmail || '?').slice(0, 2).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium leading-tight text-[#18181b] dark:text-zinc-100">
              {titleName}
            </div>
            <div className="mt-px truncate text-[11px] leading-tight text-[#71717a] dark:text-zinc-500">
              Payroll clerk
            </div>
          </div>
          <MoreHorizontal className="h-4 w-4 shrink-0 cursor-pointer text-[#a1a1aa]" aria-hidden />
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
