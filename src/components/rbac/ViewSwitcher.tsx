'use client';

import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { LayoutDashboard, ShieldCheck, Briefcase, ArrowLeftRight, UserCog, HeartHandshake, Crown, Users, HardHat, ClipboardCheck, SquareKanban } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useNotificationCountsByView } from '@/hooks/useNotificationCountsByView';
import SidebarCollapsedDot from '@/components/common/SidebarCollapsedDot';
import DashboardSwitchLoader from '@/components/common/DashboardSwitchLoader';
import {
  ACTIVE_VIEW_KEY,
  VIEW_LABELS,
  VIEW_ROUTES,
  useAvailableViews,
  type AppView,
  type Role,
} from '@/lib/rbac/views';

interface ViewSwitcherProps {
  email: string | null | undefined;
  currentView: AppView;
  /**
   * True while the host rail is collapsed (desktop only). Drives the collapsed-rail
   * treatment — the card chrome + labels fade (CSS, `md:`-scoped) while the view
   * icons stay visible, with unread counts standing in as a corner dot.
   */
  collapsed?: boolean;
}

const VIEW_ICONS: Record<AppView, React.ComponentType<{ className?: string }>> = {
  employee: LayoutDashboard,
  admin: ShieldCheck,
  accounting: Briefcase,
  manager: UserCog,
  orphanage: HeartHandshake,
  ceo: Crown,
  hr: Users,
  contractor: HardHat,
  qc: ClipboardCheck,
  tickets: SquareKanban,
};

export default function ViewSwitcher({ email, currentView, collapsed = false }: ViewSwitcherProps) {
  const router = useRouter();
  const { data: session } = useSession();
  // Roles from the JWT session, used as an offline fallback so the switcher
  // survives a Supabase outage. Only trust them when THIS switcher is showing the
  // session owner's own views — not when an elevated user is browsing another
  // person's dashboard via `?email=` (their roles ≠ that person's).
  const sessionEmail = (session?.user?.email ?? '').trim().toLowerCase();
  const sessionRoles = (session?.user as { roles?: Role[] } | undefined)?.roles ?? null;
  const selfRoles =
    sessionRoles && sessionEmail && sessionEmail === (email ?? '').trim().toLowerCase()
      ? sessionRoles
      : null;
  const { views } = useAvailableViews(email, selfRoles);
  const notifCounts = useNotificationCountsByView(email);
  const [transitioning, setTransitioning] = useState<AppView | null>(null);

  if (views.length <= 1) return null;

  const urlFor = (view: AppView) => {
    const base = VIEW_ROUTES[view];
    return email ? `${base}?email=${encodeURIComponent(email)}` : base;
  };

  // Warm the target route's JS + loading boundary on hover/focus so the click
  // itself only pays for the streamed data, not the whole bundle + RSC shell.
  const prefetchView = (view: AppView) => {
    if (view === currentView) return;
    try {
      router.prefetch(urlFor(view));
    } catch {
      /* prefetch is best-effort */
    }
  };

  const switchTo = (view: AppView) => {
    if (view === currentView || transitioning) return;
    setTransitioning(view);
    try {
      sessionStorage.setItem(ACTIVE_VIEW_KEY, view);
    } catch {
      /* ignore */
    }
    // Paint the full-screen switch modal (identical to the target route's
    // loading.tsx) THIS frame, then navigate on the next one. We deliberately
    // do NOT wrap the push in a View Transition here: the transition froze a
    // screenshot of the outgoing page and cross-faded it OVER the incoming
    // route, which masked the DashboardSwitchLoader for the first ~400ms so the
    // modal never appeared to cover the whole switch. Without it, our own
    // overlay is the single continuous surface from click → route load → new
    // dashboard, and it hands off seamlessly to the route's loading.tsx (same
    // component) with no snapshot fade in between.
    requestAnimationFrame(() => {
      router.push(urlFor(view));
    });
  };

  return (
    <>
      <div className="vs-collapse-box mb-3 rounded-md border border-orange-100 bg-white/60 p-2 dark:border-blue-950/60 dark:bg-blue-950/20">
        <div className="mb-1.5 flex items-center gap-1.5 px-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400 sb-collapse-fade">
          <ArrowLeftRight className="h-3 w-3" />
          Switch view
        </div>
        <div className="grid gap-1">
          {views.map((v) => {
            const Icon = VIEW_ICONS[v];
            const active = v === currentView;
            const isPending = transitioning === v;
            const notifCount = notifCounts[v] ?? 0;
            return (
              <button
                key={v}
                type="button"
                onClick={() => switchTo(v)}
                onPointerEnter={() => prefetchView(v)}
                onFocus={() => prefetchView(v)}
                disabled={!!transitioning}
                title={collapsed ? VIEW_LABELS[v] : undefined}
                className={cn(
                  'group relative flex items-center gap-2 overflow-hidden rounded px-2 py-1.5 text-xs font-medium transition-all duration-200',
                  active
                    ? 'bg-gradient-to-r from-orange-100 to-orange-50 text-orange-900 dark:from-blue-950/70 dark:to-blue-950/40 dark:text-white'
                    : 'text-zinc-600 hover:translate-x-0.5 hover:bg-orange-50 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-blue-950/40 dark:hover:text-zinc-100',
                  isPending && 'scale-[0.98] bg-orange-100 dark:bg-blue-950/60',
                  transitioning && !isPending && 'opacity-40',
                )}
              >
                <span className="relative z-10 flex shrink-0">
                  <Icon
                    className={cn(
                      'h-3.5 w-3.5 transition-transform',
                      active ? 'text-orange-500 dark:text-orange-400' : 'text-zinc-400',
                      isPending && 'animate-pulse',
                    )}
                  />
                  {/* Collapsed rail clips the count pill — stand in with a corner dot. */}
                  <SidebarCollapsedDot collapsed={collapsed} show={notifCount > 0} tone="bg-red-500" />
                </span>
                <span className="relative z-10 sb-collapse-fade">{VIEW_LABELS[v]}</span>
                {notifCount > 0 && (
                  <span
                    title={`${notifCount} unread notification${notifCount === 1 ? '' : 's'} on the ${VIEW_LABELS[v]} dashboard`}
                    className={cn(
                      'relative z-10 ml-auto inline-flex min-w-[18px] items-center justify-center rounded-full px-1.5 text-[10px] font-bold leading-[18px] tabular-nums text-white shadow-sm sb-collapse-fade',
                      isPending ? 'bg-red-400' : 'bg-red-500',
                    )}
                  >
                    {notifCount > 99 ? '99+' : notifCount}
                  </span>
                )}
                {isPending && (
                  <span className="absolute inset-y-0 left-0 w-full origin-left animate-[viewswitch-shimmer_500ms_ease-out_forwards] bg-gradient-to-r from-orange-300/0 via-orange-300/60 to-orange-300/0 dark:via-blue-400/40" />
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Full-screen switch modal — the SAME component each dashboard renders
          from its loading.tsx. Painting it here, on the outgoing page, the
          instant a switch begins means the box modal + background skeleton is
          already up before the router navigates; when the incoming route's
          loading.tsx mounts the identical component, the handoff is invisible
          and the modal appears to cover the entire switch. Portaled to <body>
          so a transformed sidebar ancestor can't trap the fixed overlay in a
          local containing block (which would clip it to the rail). */}
      {transitioning &&
        typeof document !== 'undefined' &&
        createPortal(
          <div className="fixed inset-0 z-[100]">
            <DashboardSwitchLoader view={transitioning} />
          </div>,
          document.body,
        )}

      <style jsx global>{`
        @keyframes viewswitch-shimmer {
          0%   { transform: translateX(-100%); }
          100% { transform: translateX(100%); }
        }
      `}</style>
    </>
  );
}
