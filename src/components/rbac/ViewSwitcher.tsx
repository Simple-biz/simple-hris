'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { LayoutDashboard, ShieldCheck, Briefcase, ArrowLeftRight, Sparkles, UserCog, HeartHandshake, Crown, Users, HardHat } from 'lucide-react';
import { cn } from '@/lib/utils';
import { withViewTransition } from '@/lib/theme/with-view-transition';
import {
  ACTIVE_VIEW_KEY,
  VIEW_LABELS,
  VIEW_ROUTES,
  useAvailableViews,
  type AppView,
} from '@/lib/rbac/views';

interface ViewSwitcherProps {
  email: string | null | undefined;
  currentView: AppView;
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
};

export default function ViewSwitcher({ email, currentView }: ViewSwitcherProps) {
  const router = useRouter();
  const { views } = useAvailableViews(email);
  const [transitioning, setTransitioning] = useState<AppView | null>(null);

  if (views.length <= 1) return null;

  const switchTo = (view: AppView) => {
    if (view === currentView || transitioning) return;
    setTransitioning(view);
    try {
      sessionStorage.setItem(ACTIVE_VIEW_KEY, view);
    } catch {
      /* ignore */
    }
    const base = VIEW_ROUTES[view];
    const url = email ? `${base}?email=${encodeURIComponent(email)}` : base;
    window.setTimeout(() => {
      withViewTransition(() => router.push(url));
    }, 520);
  };

  return (
    <>
      <div className="mb-3 rounded-md border border-orange-100 bg-white/60 p-2 dark:border-blue-950/60 dark:bg-blue-950/20">
        <div className="mb-1.5 flex items-center gap-1.5 px-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
          <ArrowLeftRight className="h-3 w-3" />
          Switch view
        </div>
        <div className="grid gap-1">
          {views.map((v) => {
            const Icon = VIEW_ICONS[v];
            const active = v === currentView;
            const isPending = transitioning === v;
            return (
              <button
                key={v}
                type="button"
                onClick={() => switchTo(v)}
                disabled={!!transitioning}
                className={cn(
                  'group relative flex items-center gap-2 overflow-hidden rounded px-2 py-1.5 text-xs font-medium transition-all duration-200',
                  active
                    ? 'bg-gradient-to-r from-orange-100 to-orange-50 text-orange-900 dark:from-blue-950/70 dark:to-blue-950/40 dark:text-white'
                    : 'text-zinc-600 hover:translate-x-0.5 hover:bg-orange-50 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-blue-950/40 dark:hover:text-zinc-100',
                  isPending && 'scale-[0.98] bg-orange-100 dark:bg-blue-950/60',
                  transitioning && !isPending && 'opacity-40',
                )}
              >
                <Icon
                  className={cn(
                    'h-3.5 w-3.5 transition-transform',
                    active ? 'text-orange-500 dark:text-orange-400' : 'text-zinc-400',
                    isPending && 'animate-pulse',
                  )}
                />
                <span className="relative z-10">{VIEW_LABELS[v]}</span>
                {isPending && (
                  <span className="absolute inset-y-0 left-0 w-full origin-left animate-[viewswitch-shimmer_500ms_ease-out_forwards] bg-gradient-to-r from-orange-300/0 via-orange-300/60 to-orange-300/0 dark:via-blue-400/40" />
                )}
              </button>
            );
          })}
        </div>
      </div>

      {transitioning && <ViewSwitchOverlay target={transitioning} />}

      <style jsx global>{`
        @keyframes viewswitch-shimmer {
          0%   { transform: translateX(-100%); }
          100% { transform: translateX(100%); }
        }
        @keyframes viewswitch-overlay-in {
          0%   { opacity: 0; backdrop-filter: blur(0); }
          100% { opacity: 1; backdrop-filter: blur(8px); }
        }
        @keyframes viewswitch-card-in {
          0%   { opacity: 0; transform: translateY(12px) scale(0.96); }
          60%  { opacity: 1; transform: translateY(0) scale(1.02); }
          100% { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes viewswitch-ring {
          0%   { transform: scale(0.6); opacity: 0.9; }
          100% { transform: scale(2.4); opacity: 0; }
        }
        ::view-transition-old(root) {
          animation: 320ms cubic-bezier(0.4, 0, 1, 1) both viewswitch-fade-out;
        }
        ::view-transition-new(root) {
          animation: 420ms cubic-bezier(0, 0, 0.2, 1) both viewswitch-fade-in;
        }
        @keyframes viewswitch-fade-out {
          to { opacity: 0; transform: scale(0.985); filter: blur(4px); }
        }
        @keyframes viewswitch-fade-in {
          from { opacity: 0; transform: scale(1.015); filter: blur(4px); }
        }
      `}</style>
    </>
  );
}

function ViewSwitchOverlay({ target }: { target: AppView }) {
  const Icon = VIEW_ICONS[target];
  return (
    <div
      className="pointer-events-none fixed inset-0 z-[100] flex items-center justify-center bg-white/30 dark:bg-black/40"
      style={{ animation: 'viewswitch-overlay-in 200ms ease-out forwards' }}
    >
      <div
        className="relative flex flex-col items-center gap-3 rounded-2xl border border-orange-200/60 bg-white/90 px-8 py-6 shadow-2xl shadow-orange-500/20 backdrop-blur-xl dark:border-blue-900/60 dark:bg-[#0d1117]/90 dark:shadow-blue-900/40"
        style={{ animation: 'viewswitch-card-in 380ms cubic-bezier(0.16, 1, 0.3, 1) forwards' }}
      >
        <div className="relative flex h-14 w-14 items-center justify-center rounded-full bg-gradient-to-br from-orange-500 to-orange-600 text-white shadow-lg shadow-orange-500/40">
          <Icon className="h-7 w-7" />
          <span
            className="absolute inset-0 rounded-full border-2 border-orange-400"
            style={{ animation: 'viewswitch-ring 700ms ease-out forwards' }}
          />
          <span
            className="absolute inset-0 rounded-full border-2 border-orange-300"
            style={{ animation: 'viewswitch-ring 700ms ease-out 120ms forwards' }}
          />
        </div>
        <div className="flex flex-col items-center gap-0.5 text-center">
          <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-orange-500 dark:text-orange-400">
            <Sparkles className="h-3 w-3" />
            Switching to
          </div>
          <div className="text-lg font-bold text-zinc-900 dark:text-white">
            {VIEW_LABELS[target]} view
          </div>
        </div>
      </div>
    </div>
  );
}
