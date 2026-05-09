"use client";

import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTheme } from 'next-themes';
import { AnimatePresence, motion } from 'motion/react';
import { Menu } from 'lucide-react';
import { Button } from '@/components/ui/button';
import Sidebar from './components/Sidebar';
import Overview from './components/Overview';
import Rates from './components/Rates';
import PayrollWizard from './components/PayrollWizard';
import { Toaster } from '@/components/ui/sonner';
import SystemSettings from './components/SystemSettings';
import PabDisputeQueue from './components/payroll/PabDisputeQueue';
import PayrollDispatch from './components/payroll-clerk/PayrollDispatch';
import { normEmail } from '@/lib/email/norm-email';
import { SESSION_EMAIL_KEY } from '@/lib/rbac/views';
import AnnouncementWall from './components/announcements/AnnouncementWall';
import AnnouncementComposer from './components/announcements/AnnouncementComposer';
import SWall from './components/swall/SWall';
import { ACCOUNTING_TAB_IDS, allowedAccountingTabsForRoles, canAccessAccountingTab } from '@/lib/rbac/accounting-tabs';

function isPlausibleEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

export default function App() {
  const [activeTab, setActiveTab] = useState('overview');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [focusRatesEmail, setFocusRatesEmail] = useState<string | null>(null);
  const [roles, setRoles] = useState<string[]>([]);
  const [sessionEmail, setSessionEmail] = useState<string | null>(null);
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const searchParams = useSearchParams();
  const emailFromQuery = searchParams?.get('email') ?? null;

  useEffect(() => {
    setMounted(true);
    try {
      const q = emailFromQuery?.trim() ?? '';
      if (q && isPlausibleEmail(q)) {
        const normalized = normEmail(q) ?? q.toLowerCase();
        sessionStorage.setItem(SESSION_EMAIL_KEY, normalized);
        setSessionEmail(normalized);
        return;
      }
      setSessionEmail(sessionStorage.getItem(SESSION_EMAIL_KEY));
    } catch {
      /* ignore */
    }
  }, [emailFromQuery]);

  useEffect(() => {
    const e = (sessionEmail || '').trim();
    if (!e) {
      setRoles([]);
      return;
    }
    let cancelled = false;
    fetch(`/api/employee-roles?email=${encodeURIComponent(e)}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((j: { rows?: { role: string }[] }) => {
        if (cancelled) return;
        setRoles((j.rows ?? []).map((row) => row.role));
      })
      .catch(() => {
        if (!cancelled) setRoles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionEmail]);

  const isDark = mounted ? resolvedTheme === 'dark' : false;
  const allowedTabs = allowedAccountingTabsForRoles(roles);

  const tabDirRef = useRef<1 | -1>(1);

  const navigate = (tab: string) => {
    if (!canAccessAccountingTab(tab, roles)) {
      setActiveTab(allowedTabs[0] ?? 'payment-dispatch');
      setMobileNavOpen(false);
      return;
    }
    const currentIdx = ACCOUNTING_TAB_IDS.indexOf(activeTab as typeof ACCOUNTING_TAB_IDS[number]);
    const nextIdx = ACCOUNTING_TAB_IDS.indexOf(tab as typeof ACCOUNTING_TAB_IDS[number]);
    tabDirRef.current = nextIdx >= currentIdx ? 1 : -1;
    setActiveTab(tab);
    setMobileNavOpen(false);
  };

  const handleViewRates = (email: string) => {
    setFocusRatesEmail(email);
    navigate('rates');
  };

  useEffect(() => {
    if (!mobileNavOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMobileNavOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mobileNavOpen]);

  useEffect(() => {
    if (!canAccessAccountingTab(activeTab, roles)) {
      setActiveTab(allowedTabs[0] ?? 'payment-dispatch');
    }
  }, [activeTab, allowedTabs, roles]);

  const renderContent = () => {
    switch (activeTab) {
      case 'overview':
        return <Overview onViewRates={handleViewRates} onNavigate={navigate} />;
      case 'rates':
        return (
          <Rates
            focusEmail={focusRatesEmail}
            onFocusConsumed={() => setFocusRatesEmail(null)}
          />
        );
      case 'payroll-wizard':
        return <PayrollWizard />;
      case 'hogan-suite':
        return (
          <div className="p-8 flex flex-col items-center justify-center h-full text-center space-y-4">
            <div className="w-16 h-16 bg-amber-500/10 rounded-full flex items-center justify-center">
              <span className="text-2xl font-bold text-amber-500">H</span>
            </div>
            <h2 className="text-2xl font-bold text-zinc-900 dark:text-white">Hogan Suite</h2>
            <p className="text-zinc-600 dark:text-zinc-500 max-w-md">
              Dedicated view for Monday-Sunday cycle management. 
              Toggle the Hogan switch in the Payroll Wizard to process these records.
            </p>
          </div>
        );
      case 'payment-dispatch':
        return <PayrollDispatch />;
      case 'disputes':
        return <PabDisputeQueue />;
      case 'settings':
        return <SystemSettings />;
      case 'announcements':
        return (
          <AccountingAnnouncementsTab
            sessionEmail={sessionEmail}
            canPostGeneral={canPostGeneral}
            isElevated={isElevated}
          />
        );
      case 's-wall':
        return (
          <AccountingSwallTab
            sessionEmail={sessionEmail}
            canPost={canPostGeneral}
          />
        );
      default:
        return <Overview onViewRates={handleViewRates} onNavigate={navigate} />;
    }
  };

  // Roles that can post general announcements
  const canPostGeneral = roles.some((r) =>
    ['admin', 'ceo', 'hr_coordinator', 'finance', 'payroll_coordinator', 'payroll_manager', 'orphanage_manager'].includes(r),
  );
  const isElevated = roles.includes('admin') || roles.includes('ceo');

  return (
    <div className="flex h-dvh max-h-dvh overflow-hidden bg-white font-sans text-zinc-900 selection:bg-orange-500/20 selection:text-orange-900 dark:bg-[#0d1117] dark:text-zinc-100 dark:selection:bg-orange-500/30 dark:selection:text-orange-200">
      {mobileNavOpen && (
        <button
          type="button"
          className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px] md:hidden"
          aria-label="Close navigation menu"
          onClick={() => setMobileNavOpen(false)}
        />
      )}
      <Sidebar activeTab={activeTab} setActiveTab={navigate} mobileOpen={mobileNavOpen} />
      <main className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex shrink-0 items-center gap-3 border-b border-orange-100 bg-white/95 px-3 py-2.5 backdrop-blur-md supports-[padding:max(0px)]:pt-[max(0.625rem,env(safe-area-inset-top))] dark:border-blue-950/60 dark:bg-[#0d1117]/95 md:hidden">
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="shrink-0 border-orange-200/80 bg-white/80 dark:border-blue-950/60 dark:bg-blue-950/30"
            onClick={() => setMobileNavOpen(true)}
            aria-expanded={mobileNavOpen}
            aria-controls="accounting-sidebar-nav"
            aria-label="Open navigation menu"
          >
            <Menu className="h-5 w-5" />
          </Button>
          <span className="min-w-0 truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            Accounting HRIS
          </span>
        </header>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <AnimatePresence mode="wait" initial={false} custom={tabDirRef.current}>
            <motion.div
              key={activeTab}
              custom={tabDirRef.current}
              variants={{
                enter: (dir: number) => ({ opacity: 0, y: dir * 28 }),
                center: { opacity: 1, y: 0 },
                exit: (dir: number) => ({ opacity: 0, y: dir * -20 }),
              }}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
              className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
            >
              {renderContent()}
            </motion.div>
          </AnimatePresence>
        </div>
      </main>
      <Toaster position="top-right" theme={isDark ? 'dark' : 'light'} />
    </div>
  );
}

function AccountingAnnouncementsTab({
  sessionEmail,
  canPostGeneral,
  isElevated,
}: {
  sessionEmail: string | null;
  canPostGeneral: boolean;
  isElevated: boolean;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-[#ececec] bg-white px-4 py-3 sm:px-6 sm:py-5 dark:border-zinc-800 dark:bg-zinc-950">
        <h1 className="text-base font-semibold tracking-tight text-zinc-900 sm:text-xl dark:text-white">
          Announcements
        </h1>
        <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-500">
          Post company-wide updates or read the general wall. Live via Realtime.
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto bg-[#fafaf8] px-3 py-4 sm:px-6 sm:py-6 dark:bg-[#0d1117]">
        <div className="mx-auto max-w-2xl space-y-4">
          {canPostGeneral && (
            <AnnouncementComposer
              authorEmail={sessionEmail ?? ''}
              allowGeneral
              departments={[]}
              canPin={isElevated}
            />
          )}
          <AnnouncementWall scope="all" viewerEmail={sessionEmail} isElevated={isElevated} />
        </div>
      </div>
    </div>
  );
}

function AccountingSwallTab({
  sessionEmail,
  canPost,
}: {
  sessionEmail: string | null;
  canPost: boolean;
}) {
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
        <SWall viewerEmail={sessionEmail} canPost={canPost} sourceLabel={canPost ? 'Accounting' : undefined} />
      </div>
    </div>
  );
}
