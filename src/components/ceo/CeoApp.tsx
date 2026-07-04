'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import AppFooter from '@/components/AppFooter';
import { AnimatePresence, motion } from 'motion/react';
import { Menu } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Toaster } from '@/components/ui/sonner';
import { normEmail } from '@/lib/email/norm-email';
import { SESSION_EMAIL_KEY, type Role } from '@/lib/rbac/views';
import CeoSidebar, { type CeoTab } from './CeoSidebar';
import CeoChatBubble from './CeoChatBubble';
import CeoOverviewKpis from './CeoOverviewKpis';
import CeoFinancialReports from './CeoFinancialReports';
import BizAiTab from './BizAiTab';
import PeopleTab from '@/components/people/PeopleTab';
import AnnouncementWall from '@/components/announcements/AnnouncementWall';
import AnnouncementComposer from '@/components/announcements/AnnouncementComposer';
import SWall from '@/components/swall/SWall';
import NotificationsPanel from '@/components/notifications/NotificationsPanel';
import { useFeaturePermissions } from '@/hooks/useFeaturePermissions';
import { usePagesVisibility } from '@/hooks/usePagesVisibility';
import { pageLabel } from '@/lib/pages/visibility';
import UnderConstruction from '@/components/common/UnderConstruction';
import ReadOnlyTab from '@/components/rbac/ReadOnlyTab';

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
        // A failed role check must DENY, not grant. Redirect to the safe
        // employee portal rather than rendering the privileged dashboard.
        if (!cancelled) {
          router.replace(viewerEmail ? `/employee?email=${encodeURIComponent(viewerEmail)}` : '/employee');
        }
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

  // Per-tab feature-permission overlay (hidden until granted; admin bypasses).
  const { ready: permsReady, allowedTabs, canEditTab } = useFeaturePermissions(viewerEmail);
  // Global Pages overlay (admin-controlled visible / construction / hidden).
  const { ready: pagesReady, visibilityOf } = usePagesVisibility();
  const allowedCeoTabs = allowedTabs('ceo');
  // Drop pages an admin hid; keep "construction" ones (shown with a placeholder).
  const visibleCeoTabs = allowedCeoTabs.filter((t) => visibilityOf('ceo', t) !== 'hidden');
  const constructionCeoTabs = allowedCeoTabs.filter((t) => visibilityOf('ceo', t) === 'construction');
  const visibleCeoKey = visibleCeoTabs.join(',');
  useEffect(() => {
    if (!permsReady || !pagesReady) return;
    if (!visibleCeoTabs.includes(activeTab)) {
      setActiveTab((visibleCeoTabs[0] as CeoTab) ?? 'overview');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [permsReady, pagesReady, visibleCeoKey, activeTab]);

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
        allowedTabs={visibleCeoTabs}
        constructionTabs={constructionCeoTabs}
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
              {visibilityOf('ceo', activeTab) !== 'visible' ? (
                <UnderConstruction title={pageLabel('ceo', activeTab)} />
              ) : activeTab === 'biz-ai' ? (
                // The assistant is read-only by nature (it only queries data and
                // is server-gated to ceo/admin), so it stays fully interactive
                // even for a view-only grant — not wrapped in ReadOnlyTab.
                <BizAiTab />
              ) : (
              <ReadOnlyTab readOnly={permsReady && !canEditTab('ceo', activeTab)}>
              {activeTab === 'overview' && <CeoOverview viewerEmail={viewerEmail} />}
              {activeTab === 'financial-reports' && <CeoFinancialReports viewerEmail={viewerEmail} />}
              {activeTab === 'people' && (
                <PeopleTab view="ceo" viewerEmail={viewerEmail} canEdit={canEditTab('ceo', 'people')} />
              )}
              {activeTab === 'announcements' && (
                <CeoAnnouncements viewerEmail={viewerEmail} />
              )}
              {activeTab === 'notifications' && (
                <NotificationsPanel viewerEmail={viewerEmail} accent="yellow" />
              )}
              {activeTab === 's-wall' && (
                <CeoSwallTab viewerEmail={viewerEmail} />
              )}
              </ReadOnlyTab>
              )}
            </motion.div>
          </AnimatePresence>
        </div>
        <AppFooter />
      </main>

      <Toaster richColors position="top-center" />

      {/* Floating AI assistant — CEO dashboard only. Hidden on the Penny AI tab,
          where the full-page chat takes over. The expand button jumps to that
          full view (only offered when the viewer can see the Penny AI tab). */}
      <CeoChatBubble
        hidden={activeTab === 'biz-ai'}
        onOpenFullView={
          visibleCeoTabs.includes('biz-ai') ? () => setActiveTab('biz-ai') : undefined
        }
      />
    </div>
  );
}

function CeoOverview({ viewerEmail }: { viewerEmail: string | null }) {
  return (
    <div className="flex flex-col gap-6 px-4 pb-10 pt-6 sm:px-6 lg:gap-8 lg:px-8 lg:pt-8">
      <CeoOverviewKpis viewerEmail={viewerEmail} />
    </div>
  );
}

function CeoSwallTab({ viewerEmail }: { viewerEmail: string | null }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
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
            authorLabel="CEO"
          />
          <AnnouncementWall scope="all" viewerEmail={viewerEmail} isElevated />
        </div>
      </div>
    </div>
  );
}
