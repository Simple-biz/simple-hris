'use client';

import { signOut } from 'next-auth/react';
import { SESSION_EMAIL_KEY } from '@/lib/rbac/views';
import { ChartColumn, ChevronRight, LogOut, SquareKanban } from 'lucide-react';
import CollapsibleSidebarShell from '@/components/common/CollapsibleSidebarShell';
import SidebarLogoHeader from '@/components/common/SidebarLogoHeader';
import ViewSwitcher from '@/components/rbac/ViewSwitcher';
import { useSidebarCollapsed } from '@/hooks/useSidebarCollapsed';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';

export type TicketsView = 'board' | 'overview';

interface TicketsSidebarProps {
  /** Below `md`, sidebar is a drawer. Desktop ignores this. */
  mobileOpen: boolean;
  /** Signed-in viewer (from /api/tickets) — feeds the ViewSwitcher. */
  viewerEmail: string | null;
  /** Which tickets surface is showing. */
  active: TicketsView;
  onNavigate: (view: TicketsView) => void;
}

const NAV: Array<{ key: TicketsView; label: string; icon: typeof SquareKanban }> = [
  { key: 'board', label: 'Board', icon: SquareKanban },
  { key: 'overview', label: 'Overview', icon: ChartColumn },
];

/**
 * Sidebar rail for the standalone /tickets Kanban board, so the board reads as
 * part of the app instead of a bare full-screen page. The board is one view
 * (no tabs), so the nav is a single active "Board" entry — the rail's real job
 * is the ViewSwitcher back to the viewer's dashboards, plus sign-out.
 * Black + red to match the board's console theme; the surface is fixed dark in
 * both global themes, so this rail carries no light variant (and no theme
 * toggle — it would visibly do nothing here).
 */
export default function TicketsSidebar({ mobileOpen, viewerEmail, active, onNavigate }: TicketsSidebarProps) {
  const { collapsed, toggle } = useSidebarCollapsed();

  return (
    <CollapsibleSidebarShell
      collapsed={collapsed}
      onToggle={toggle}
      innerWidthClassName="md:w-64"
      accentClassName="border-red-950/70 hover:text-red-400 focus-visible:ring-red-500"
      id="tickets-sidebar-nav"
      ariaLabel="Tickets navigation"
      className={cn(
        'flex h-dvh w-[85vw] max-w-[20rem] shrink-0 flex-col border-r border-border bg-gradient-to-b from-[#0d0d0e] to-[#080809] text-zinc-400 md:w-64 md:max-w-none md:shadow-none',
        'fixed inset-y-0 left-0 z-50 will-change-transform md:static md:z-auto md:translate-x-0',
        'transition-[transform,box-shadow,width] duration-[360ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
        mobileOpen
          ? 'translate-x-0 shadow-2xl shadow-black/50'
          : '-translate-x-full shadow-none md:translate-x-0',
      )}
    >
      <div className="flex min-h-0 flex-1 flex-col p-6">
        <div className="mb-8">
          <SidebarLogoHeader collapsed={collapsed} accentClassName="from-red-500 to-red-800" />
        </div>

        <ScrollArea className="-mx-2 min-h-0 flex-1">
          <nav className="space-y-1 px-2">
            {NAV.map(({ key, label, icon: Icon }) => {
              const isActive = active === key;
              return (
                <button
                  key={key}
                  type="button"
                  title={collapsed ? label : undefined}
                  onClick={() => onNavigate(key)}
                  aria-current={isActive ? 'page' : undefined}
                  className={cn(
                    'group flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                    isActive
                      ? 'bg-gradient-to-r from-red-950/70 to-red-950/30 text-white shadow-sm'
                      : 'text-zinc-500 hover:bg-red-500/10 hover:text-zinc-200',
                  )}
                >
                  <Icon className={cn('h-4 w-4', isActive ? 'text-red-500' : 'text-zinc-600 group-hover:text-red-400')} />
                  <span className={cn('truncate text-left sb-collapse-fade')}>{label}</span>
                  {isActive && <ChevronRight className="ml-auto h-3 w-3 text-red-500/70" />}
                </button>
              );
            })}
          </nav>
        </ScrollArea>
      </div>

      <div className="mt-auto border-t border-border p-4">
        <ViewSwitcher email={viewerEmail} currentView="tickets" collapsed={collapsed} />
        <Button
          variant="ghost"
          title={collapsed ? 'Sign Out' : undefined}
          className="w-full justify-start gap-3 text-zinc-500 hover:bg-red-500/10 hover:text-red-400"
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
