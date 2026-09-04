'use client';

import React from 'react';
import { useSearchParams } from 'next/navigation';
import { useTheme } from 'next-themes';
import { signOut } from 'next-auth/react';
import { withViewTransition } from '@/lib/theme/with-view-transition';
import {
  Bell,
  Database,
  KeyRound,
  LayoutDashboard,
  LayoutTemplate,
  LogOut,
  Moon,
  MoreHorizontal,
  PencilRuler,
  Radar,
  Settings,
  Sheet,
  ShieldCheck,
  Sparkles,
  Sun,
  UserCog,
  Webhook,
} from 'lucide-react';
import CollapsibleSidebarShell from '@/components/common/CollapsibleSidebarShell';
import SidebarLogoHeader from '@/components/common/SidebarLogoHeader';
import SidebarCollapsedDot from '@/components/common/SidebarCollapsedDot';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import ViewSwitcher from '@/components/rbac/ViewSwitcher';
import { SESSION_EMAIL_KEY } from '@/lib/rbac/views';
import { normEmail } from '@/lib/email/norm-email';
import EmployeeAvatar from '@/components/employee/EmployeeAvatar';
import { useViewerProfilePhoto } from '@/hooks/useViewerProfilePhoto';
import { useDispatchLock } from '@/hooks/useDispatchLock';
import { useSidebarCollapsed } from '@/hooks/useSidebarCollapsed';

function isPlausibleEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

export type AdminSidebarProps = {
  activeTab: string;
  setActiveTab: (tab: string) => void;
  /** Below `md`, sidebar is a drawer. Desktop ignores this. */
  mobileOpen: boolean;
  /** When set (e.g. from parent), used for the footer identity row */
  viewerEmail?: string | null;
  /** Optional counts for nav badges (from live data) */
  counts?: {
    roles?: number;
    employees?: number;
    webhookAlert?: number;
  };
};

const systemNav: Array<{
  id: string;
  label: string;
  icon: typeof LayoutDashboard;
  badge?: 'count' | 'alert';
}> = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'penny-ai', label: 'Penny AI', icon: Sparkles },
  { id: 'roles', label: 'Roles & permissions', icon: UserCog, badge: 'count' },
  { id: 'global-master-list', label: 'Global Master List', icon: Sheet, badge: 'count' },
  { id: 'workspace', label: 'Google Workspace', icon: Settings },
  { id: 'webhooks', label: 'Webhooks', icon: Webhook, badge: 'alert' },
  { id: 'pages', label: 'Pages', icon: LayoutTemplate },
  { id: 'design-specs', label: 'Design & Specifications', icon: PencilRuler },
  { id: 'notifications', label: 'Notifications', icon: Bell },
];

const securityNav: Array<{ id: string; label: string; icon: typeof ShieldCheck }> = [
  { id: 'audit', label: 'Audit log', icon: ShieldCheck },
  { id: 'diagnostics', label: 'Diagnostics', icon: Radar },
  { id: 'api-tokens', label: 'API tokens', icon: KeyRound },
  { id: 'backups', label: 'Backups', icon: Database },
];

export default function AdminSidebar({
  activeTab,
  setActiveTab,
  mobileOpen,
  viewerEmail: viewerEmailProp,
  counts,
}: AdminSidebarProps) {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);
  const [email, setEmail] = React.useState<string | null>(viewerEmailProp ?? null);
  const searchParams = useSearchParams();
  const emailFromQuery = searchParams?.get('email') ?? null;

  React.useEffect(() => {
    setMounted(true);
  }, []);

  React.useEffect(() => {
    if (viewerEmailProp !== undefined) {
      setEmail(viewerEmailProp);
      return;
    }
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
  }, [emailFromQuery, viewerEmailProp]);

  const isDark = mounted ? resolvedTheme === 'dark' : false;
  const { state: lockState } = useDispatchLock();
  const { collapsed, toggle } = useSidebarCollapsed();
  const { profilePhotoUrl, googlePhotoUrl } = useViewerProfilePhoto(email);

  const displayName = email?.includes('@') ? email.split('@')[0]!.replace(/[._-]/g, ' ') : email || 'Admin';
  const titleName = displayName
    .split(' ')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
  const initials = titleName
    .split(' ')
    .map((w) => w[0] ?? '')
    .join('')
    .toUpperCase()
    .slice(0, 2) || (email || '?').slice(0, 2).toUpperCase();

  const navBtn = (
    id: string,
    label: string,
    Icon: typeof LayoutDashboard,
    extra?: React.ReactNode,
    /** Stands in for a right-aligned badge that the collapsed 64px rail clips. */
    dot?: { show: boolean; tone?: string },
    /**
     * Overrides the icon's colour in BOTH states. Used only by Penny AI, whose
     * row opens the orange operator console — the mark matches the surface it
     * leads to. Darker orange in light mode so a 15px glyph still clears 3:1.
     */
    iconClassName?: string,
  ) => (
    <button
      key={id}
      type="button"
      onClick={() => setActiveTab(id)}
      title={collapsed ? label : undefined}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-md px-2.5 py-[7px] text-[13.5px] font-[450] text-[#3f3f46] transition-colors',
        activeTab === id ? 'bg-[#18181b] font-medium text-white' : 'hover:bg-[#f3f3f3] hover:text-[#18181b]',
      )}
    >
      <span className="relative shrink-0">
        <Icon
          className={cn(
            'h-[15px] w-[15px] shrink-0',
            activeTab === id ? 'text-white/75' : 'text-[#a1a1aa]',
            iconClassName,
          )}
        />
        {dot?.show && (
          <SidebarCollapsedDot collapsed={collapsed} tone={dot.tone ?? 'bg-red-500'} />
        )}
      </span>
      <span className={cn('truncate text-left sb-collapse-fade')}>{label}</span>
      {extra}
    </button>
  );

  return (
    <CollapsibleSidebarShell
      collapsed={collapsed}
      onToggle={toggle}
      innerWidthClassName="md:w-[220px]"
      accentClassName="border-[#e4e4e7] hover:text-[#18181b] focus-visible:ring-zinc-400 dark:border-zinc-800 dark:hover:text-zinc-100"
      id="admin-sidebar-nav"
      ariaLabel="Admin navigation"
      className={cn(
        'flex h-dvh w-[220px] max-w-[min(100vw,220px)] shrink-0 flex-col border-r border-[#ececec] bg-white shadow-xl dark:border-zinc-800 dark:bg-zinc-950 md:max-w-none md:shadow-none',
        'fixed inset-y-0 left-0 z-50 transition-[transform,width] duration-300 ease-out md:static md:z-auto md:translate-x-0',
        mobileOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0',
      )}
    >
      {/* Brand — anchored at the top */}
      <div className="shrink-0 px-5 pb-2 pt-7">
        <SidebarLogoHeader collapsed={collapsed} accentClassName="from-zinc-700 to-zinc-900" />
      </div>

      {/* Middle column — single scroll surface for nav + view switcher + theme toggle.
          Brand at top and Sign Out at bottom stay anchored regardless of viewport height. */}
      <ScrollArea className="min-h-0 flex-1">
        <div className="px-5 pb-4 pr-3">
          <p className={cn('mb-1.5 px-2.5 text-[10.5px] font-medium uppercase tracking-[0.06em] text-[#a1a1aa] sb-collapse-fade')}>
            System
          </p>
          <nav className="flex flex-col gap-px">
            {systemNav.map((item) => {
              let badge: React.ReactNode = null;
              if (item.badge === 'count' && item.id === 'roles' && counts?.roles != null) {
                badge = (
                  <span
                    className={cn(
                      'ml-auto rounded-full px-1.5 py-px text-[10.5px] font-semibold tabular-nums',
                      activeTab === item.id
                        ? 'bg-white/15 text-white/90'
                        : 'bg-[#f3f3f3] text-[#71717a] dark:bg-zinc-800 dark:text-zinc-400',
                    )}
                  >
                    {counts.roles}
                  </span>
                );
              }
              if (item.badge === 'count' && item.id === 'global-master-list' && counts?.employees != null) {
                badge = (
                  <span
                    className={cn(
                      'ml-auto rounded-full px-1.5 py-px text-[10.5px] font-semibold tabular-nums',
                      activeTab === item.id
                        ? 'bg-white/15 text-white/90'
                        : 'bg-[#f3f3f3] text-[#71717a] dark:bg-zinc-800 dark:text-zinc-400',
                    )}
                  >
                    {counts.employees}
                  </span>
                );
              }
              let dot: { show: boolean; tone?: string } | undefined;
              if (item.badge === 'alert' && counts?.webhookAlert != null && counts.webhookAlert > 0) {
                badge = (
                  <span
                    className={cn(
                      'ml-auto rounded-full px-1.5 py-px text-[10.5px] font-semibold tabular-nums',
                      activeTab === item.id
                        ? 'bg-white/15 text-white/90'
                        : 'bg-[#fbf3e1] text-[#b45309] dark:bg-amber-950/50 dark:text-amber-400',
                    )}
                  >
                    {counts.webhookAlert}
                  </span>
                );
                dot = { show: true, tone: 'bg-amber-500' };
              }
              if (item.id === 'notifications' && lockState.locked) {
                badge = <span className="ml-auto h-2 w-2 animate-pulse rounded-full bg-red-500" />;
                dot = { show: true, tone: 'bg-red-500' };
              }
              return navBtn(
                item.id,
                item.label,
                item.icon,
                badge,
                dot,
                // Penny AI's row wears the console's accent, so the nav item
                // and the surface it opens read as one thing.
                item.id === 'penny-ai' ? 'text-[#e35c00] dark:text-[#ff7a1a]' : undefined,
              );
            })}
          </nav>

          <div className="my-5 mx-2.5 h-px bg-[#ececec] dark:bg-zinc-800" />

          <p className={cn('mb-1.5 px-2.5 text-[10.5px] font-medium uppercase tracking-[0.06em] text-[#a1a1aa] sb-collapse-fade')}>
            Security
          </p>
          <nav className="flex flex-col gap-px">
            {securityNav.map((item) => navBtn(item.id, item.label, item.icon))}
          </nav>

          <div className="my-5 mx-2.5 h-px bg-[#ececec] dark:bg-zinc-800" />

          <nav className="flex flex-col gap-px">{navBtn('settings', 'System settings', Settings)}</nav>

          {/* ViewSwitcher + theme toggle — moved INSIDE the scroll area so they're
              reachable via the same scrollbar when the viewport is short. */}
          <div className="mt-5 border-t border-[#ececec] pt-4 dark:border-zinc-800">
            <ViewSwitcher email={email} currentView="admin" collapsed={collapsed} />
            <button
              type="button"
              onClick={() => withViewTransition(() => setTheme(isDark ? 'light' : 'dark'))}
              title={collapsed ? (isDark ? 'Dark mode' : 'Light mode') : undefined}
              className="mb-1 mt-3 flex w-full items-center justify-between rounded-md border border-[#ececec] bg-[#fafaf8] px-3 py-2 text-left transition-colors hover:bg-[#f3f3f3] dark:border-zinc-800 dark:bg-zinc-900 dark:hover:bg-zinc-800"
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

      {/* Identity + Sign Out — anchored at the bottom, always reachable */}
      <div className="shrink-0 border-t border-[#ececec] p-5 dark:border-zinc-800">
        <div className="flex items-center gap-2.5 rounded-md border border-[#ececec] bg-[#fafaf8] px-2.5 py-2 dark:border-zinc-800 dark:bg-zinc-900">
          <EmployeeAvatar
            photoUrl={profilePhotoUrl}
            googlePhotoUrl={googlePhotoUrl}
            email={email}
            initials={initials}
            className="h-7 w-7 text-[11px]"
            pixelSize={56}
          />
          <div className={cn('min-w-0 flex-1 sb-collapse-fade')}>
            <div className="truncate text-[13px] font-medium leading-tight text-[#18181b] dark:text-zinc-100">
              {titleName}
            </div>
            <div className="mt-px truncate text-[11px] leading-tight text-[#71717a] dark:text-zinc-500">
              Admin · root
            </div>
          </div>
          <MoreHorizontal className={cn('h-4 w-4 shrink-0 cursor-pointer text-[#a1a1aa] sb-collapse-fade')} aria-hidden />
        </div>
        <Button
          variant="ghost"
          title={collapsed ? 'Sign Out' : undefined}
          className="mt-3 w-full justify-start gap-3 text-[#71717a] hover:bg-red-500/10 hover:text-red-600 dark:text-zinc-500 dark:hover:text-red-400"
          onClick={() => {
            try {
              sessionStorage.removeItem(SESSION_EMAIL_KEY);
            } catch { /* ignore */ }
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
