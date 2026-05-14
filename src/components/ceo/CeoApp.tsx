'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { AnimatePresence, motion } from 'motion/react';
import { Crown, Menu, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Toaster } from '@/components/ui/sonner';
import { normEmail } from '@/lib/email/norm-email';
import { SESSION_EMAIL_KEY, type Role } from '@/lib/rbac/views';
import CeoSidebar, { type CeoTab } from './CeoSidebar';
import AnnouncementWall from '@/components/announcements/AnnouncementWall';
import AnnouncementComposer from '@/components/announcements/AnnouncementComposer';
import SWall from '@/components/swall/SWall';
import NotificationsPanel from '@/components/notifications/NotificationsPanel';

function isPlausibleEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

export default function CeoApp() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const emailFromQuery = searchParams?.get('email') ?? null;

  const [activeTab, setActiveTab] = useState<CeoTab>('overview');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [viewerEmail, setViewerEmail] = useState<string | null>(null);
  const [authChecked, setAuthChecked] = useState(false);

  useEffect(() => {
    try {
      const q = emailFromQuery?.trim() ?? '';
      if (q && isPlausibleEmail(q)) {
        const normalized = normEmail(q) ?? q.toLowerCase();
        sessionStorage.setItem(SESSION_EMAIL_KEY, normalized);
        setViewerEmail(normalized);
        return;
      }
      setViewerEmail(sessionStorage.getItem(SESSION_EMAIL_KEY));
    } catch {
      setViewerEmail(null);
    }
  }, [emailFromQuery]);

  useEffect(() => {
    if (!viewerEmail) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/employee-roles?email=${encodeURIComponent(viewerEmail)}`,
          { cache: 'no-store' },
        );
        const json = (await res.json()) as { rows?: { role: Role }[] };
        const roles = (json.rows ?? []).map((r) => r.role);
        const allowed = roles.includes('ceo') || roles.includes('admin');
        if (cancelled) return;
        if (!allowed) {
          router.replace(viewerEmail ? `/employee?email=${encodeURIComponent(viewerEmail)}` : '/employee');
          return;
        }
        setAuthChecked(true);
      } catch {
        if (!cancelled) setAuthChecked(true);
      }
    })();
    return () => { cancelled = true; };
  }, [router, viewerEmail]);

  useEffect(() => {
    if (!mobileNavOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMobileNavOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mobileNavOpen]);

  if (!authChecked) {
    return (
      <div className="flex h-screen items-center justify-center bg-white dark:bg-[#0d1117]">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-yellow-500 border-t-transparent" aria-hidden />
      </div>
    );
  }

  return (
    <div className="flex h-dvh max-h-dvh w-full overflow-hidden bg-gradient-to-br from-white via-yellow-50/30 to-white text-zinc-900 dark:from-black dark:via-yellow-950/10 dark:to-black dark:text-zinc-100">
      {mobileNavOpen && (
        <button
          type="button"
          className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px] md:hidden"
          aria-label="Close navigation menu"
          onClick={() => setMobileNavOpen(false)}
        />
      )}

      <CeoSidebar
        activeTab={activeTab}
        setActiveTab={(tab) => { setActiveTab(tab); setMobileNavOpen(false); }}
        mobileOpen={mobileNavOpen}
        viewerEmail={viewerEmail}
      />

      <main className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex shrink-0 items-center gap-3 border-b border-yellow-100/70 bg-white/95 px-3 py-2.5 backdrop-blur-md dark:border-yellow-950/40 dark:bg-[#0d1117]/95 md:hidden">
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="shrink-0 border-yellow-200/80 bg-white/80 dark:border-yellow-950/60 dark:bg-yellow-950/20"
            onClick={() => setMobileNavOpen(true)}
            aria-label="Open navigation menu"
          >
            <Menu className="h-5 w-5" />
          </Button>
          <span className="min-w-0 truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            CEO Dashboard
          </span>
        </header>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={activeTab}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
              className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto"
            >
              {activeTab === 'overview' && <CeoOverview viewerEmail={viewerEmail} />}
              {activeTab === 'announcements' && (
                <CeoAnnouncements viewerEmail={viewerEmail} />
              )}
              {activeTab === 'notifications' && (
                <NotificationsPanel viewerEmail={viewerEmail} accent="yellow" />
              )}
              {activeTab === 's-wall' && (
                <CeoSwallTab viewerEmail={viewerEmail} />
              )}
            </motion.div>
          </AnimatePresence>
        </div>
      </main>

      <Toaster richColors position="top-center" />
    </div>
  );
}

const CEO_MESSAGES: { heading: (name: string) => string; body: string }[] = [
  {
    heading: (name) => `Welcome, ${name} — the company moves in the direction you set. ◆`,
    body: "Your decisions shape every team, every workflow, and every outcome here. This dashboard is your command center — built to give you clarity at a glance.",
  },
  {
    heading: (name) => `Good to see you, ${name} — great companies are built one decision at a time. ◆`,
    body: "Everything running through this system — payroll, disputes, attendance — traces back to the standards you set. Keep leading with intention.",
  },
  {
    heading: (name) => `Hi ${name} — the best leaders stay informed. ◆`,
    body: "From pay cycles to team health, you have full visibility here. Use the Announcements board to keep everyone aligned.",
  },
  {
    heading: (name) => `Welcome back, ${name} — steady hands steer great ships. ◆`,
    body: "Your people are working. Your systems are running. Use this space to stay on top of what matters most.",
  },
  {
    heading: (name) => `Hey ${name} — vision without execution is just a dream. ◆`,
    body: "This dashboard bridges the two. Real-time data, live updates, and direct communication channels — all in one place for you.",
  },
];

const DIAMONDS = [
  { left: '5%',  delay: '0s',    dur: '4.4s', size: '20px' },
  { left: '13%', delay: '1.2s',  dur: '3.8s', size: '16px' },
  { left: '23%', delay: '2.5s',  dur: '4.8s', size: '24px' },
  { left: '36%', delay: '0.6s',  dur: '3.6s', size: '18px' },
  { left: '50%', delay: '1.9s',  dur: '4.2s', size: '14px' },
  { left: '62%', delay: '0.8s',  dur: '4.6s', size: '22px' },
  { left: '74%', delay: '2.8s',  dur: '3.9s', size: '17px' },
  { left: '84%', delay: '1.5s',  dur: '4.3s', size: '20px' },
  { left: '93%', delay: '3.2s',  dur: '4.0s', size: '15px' },
] as const;

function CeoOverview({ viewerEmail }: { viewerEmail: string | null }) {
  const msgIdx = Math.floor(Math.random() * CEO_MESSAGES.length);
  const welcomeMsg = CEO_MESSAGES[msgIdx]!;

  const rawFirst = viewerEmail?.includes('@')
    ? viewerEmail.split('@')[0]!.replace(/[._-]/g, ' ').split(' ')[0]
    : 'there';
  const greeting = rawFirst.charAt(0).toUpperCase() + rawFirst.slice(1);

  return (
    <div className="flex flex-col gap-6 px-4 pb-10 pt-6 sm:px-6 lg:gap-8 lg:px-8 lg:pt-8">
      {/* Hero card */}
      <header className="relative overflow-hidden rounded-2xl border border-yellow-200/80 bg-gradient-to-br from-yellow-500 via-amber-600 to-zinc-900 px-5 py-7 text-white shadow-lg shadow-yellow-600/20 dark:border-yellow-900/50 dark:from-yellow-600 dark:via-amber-900 dark:to-black sm:px-7">
        <style>{`
          @keyframes floatDiamond {
            0%   { transform: translateY(0)      scale(1);    opacity: 0; }
            12%  {                                             opacity: 0.5; }
            80%  { transform: translateY(-115px) scale(0.65); opacity: 0.22; }
            100% { transform: translateY(-135px) scale(0.45); opacity: 0; }
          }
        `}</style>

        {/* Floating diamonds */}
        {DIAMONDS.map((d, i) => (
          <span
            key={i}
            aria-hidden
            style={{
              position: 'absolute',
              bottom: '6px',
              left: d.left,
              fontSize: d.size,
              color: 'rgba(255,255,255,0.72)',
              animation: `floatDiamond ${d.dur} ${d.delay} infinite ease-in`,
              pointerEvents: 'none',
              userSelect: 'none',
              lineHeight: 1,
            }}
          >
            ◆
          </span>
        ))}

        {/* Glow blobs */}
        <div className="absolute -right-10 -top-10 h-36 w-36 rounded-full bg-white/10 blur-3xl" aria-hidden />
        <div className="absolute -bottom-12 left-8 h-32 w-32 rounded-full bg-amber-300/20 blur-2xl" aria-hidden />

        <div className="relative flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between lg:gap-6">
          <div className="flex min-w-0 flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.18em] text-yellow-100/90">
              <Sparkles className="h-3 w-3 shrink-0" />
              CEO dashboard
            </div>
            <h1 className="text-balance text-2xl font-bold tracking-tight sm:text-3xl">
              {welcomeMsg.heading(greeting)}
            </h1>
            <p className="max-w-2xl text-sm leading-relaxed text-yellow-100/80">
              {welcomeMsg.body}
            </p>
          </div>

          {/* Crown badge */}
          <div className="flex shrink-0 items-center justify-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-white/20 bg-white/10 backdrop-blur-sm shadow-lg shadow-black/20">
              <Crown className="h-8 w-8 text-yellow-100" />
            </div>
          </div>
        </div>
      </header>

      {/* Placeholder content area */}
      <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-yellow-200/60 bg-yellow-50/30 py-14 text-center dark:border-yellow-900/30 dark:bg-yellow-950/10">
        <Crown className="h-8 w-8 text-yellow-400/60 dark:text-yellow-600/60" />
        <p className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
          Executive analytics coming soon
        </p>
        <p className="max-w-xs text-xs text-zinc-400 dark:text-zinc-600">
          KPIs, headcount, payroll summaries, and team health metrics will appear here.
        </p>
      </div>
    </div>
  );
}

function CeoSwallTab({ viewerEmail }: { viewerEmail: string | null }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-[#ececec] bg-white px-4 py-3 sm:px-6 sm:py-5 dark:border-zinc-800 dark:bg-zinc-950">
        <h1 className="text-base font-semibold tracking-tight text-zinc-900 sm:text-xl dark:text-white">
          Simple Wall
        </h1>
        <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-500">
          Company-wide social feed. Post updates, react, and comment — live via Realtime.
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto bg-[#fafaf8] dark:bg-[#0d1117]">
        <SWall viewerEmail={viewerEmail} canPost sourceLabel="CEO" />
      </div>
    </div>
  );
}

function CeoAnnouncements({ viewerEmail }: { viewerEmail: string | null }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-[#ececec] bg-white px-4 py-3 sm:px-6 sm:py-5 dark:border-zinc-800 dark:bg-zinc-950">
        <h1 className="text-base font-semibold tracking-tight text-zinc-900 sm:text-xl dark:text-white">
          Announcements
        </h1>
        <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-500">
          Post company-wide announcements. Live updates via Realtime.
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto bg-[#fafaf8] px-3 py-4 sm:px-6 sm:py-6 dark:bg-[#0d1117]">
        <div className="mx-auto max-w-2xl space-y-4">
          <AnnouncementComposer
            authorEmail={viewerEmail ?? ''}
            allowGeneral
            departments={[]}
            canPin
          />
          <AnnouncementWall scope="all" viewerEmail={viewerEmail} isElevated />
        </div>
      </div>
    </div>
  );
}
