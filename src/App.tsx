"use client";

import { useEffect, useRef, useState } from 'react';
import { useDispatchLock } from '@/hooks/useDispatchLock';
import { useNotificationChime } from '@/hooks/useNotificationChime';
import { useSidebarCollapsed } from '@/hooks/useSidebarCollapsed';
import { useSearchParams } from 'next/navigation';
import { useSession } from 'next-auth/react';
import AppFooter from '@/components/AppFooter';
import { useTheme } from 'next-themes';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Menu } from 'lucide-react';
import { Button } from '@/components/ui/button';
import Sidebar from './components/Sidebar';
import Overview from './components/Overview';
import PayrollWizard from './components/PayrollWizard';
import InternsPayrollView from '@/components/accounting/interns/InternsPayrollView';
import { Toaster } from '@/components/ui/sonner';
import SystemSettings from './components/SystemSettings';
import PabDisputeQueue from './components/payroll/PabDisputeQueue';
import PayrollDispatch from './components/payroll-clerk/PayrollDispatch';
import { normEmail } from '@/lib/email/norm-email';
import { cn } from '@/lib/utils';
import { SESSION_EMAIL_KEY } from '@/lib/rbac/views';
import { usePublishPresenceTab } from '@/components/presence/PresenceProvider';
import { humanizeTabId } from '@/lib/presence/page-label';
import AnnouncementWall from './components/announcements/AnnouncementWall';
import AnnouncementComposer from './components/announcements/AnnouncementComposer';
import SWall from './components/swall/SWall';
import { ACCOUNTING_TAB_IDS, allowedAccountingTabsForUser, canAccessAccountingTabForUser, canEditAccountingTab } from '@/lib/rbac/accounting-tabs';
import { canEditFeature, type FeaturePermissionsMap } from '@/lib/rbac/feature-permissions';
import { readRbacCache, writeRbacCache } from '@/lib/rbac/rbac-cache';
import ReadOnlyTab from '@/components/rbac/ReadOnlyTab';
import { usePagesVisibility } from '@/hooks/usePagesVisibility';
import { useTabDocumentTitle } from '@/hooks/useTabDocumentTitle';
import { pageLabel } from '@/lib/pages/visibility';
import UnderConstruction from '@/components/common/UnderConstruction';
import ConstructionBanner from '@/components/common/ConstructionBanner';
import type { InitialAccountingData } from '@/lib/accounting/prefetch';
import NotificationsPanel from '@/components/notifications/NotificationsPanel';
import AccountingMesa from '@/components/payroll/AccountingMesa';
import AccountingCollabLayer from '@/components/accounting/AccountingCollabLayer';
import PayrollLivePublisher from '@/components/payroll-live/PayrollLivePublisher';
import BonusCatalog from '@/components/accounting/BonusCatalog';
import PeopleTab from '@/components/people/PeopleTab';
import AccountingTransfers from '@/components/accounting/AccountingTransfers';
import AccountingDocuments from '@/components/accounting/AccountingDocuments';
import PayrollWizardNotesFab from '@/components/accounting/PayrollWizardNotesFab';

function isPlausibleEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

/**
 * Tab-switch motion, shared by the animated tab tree and by the Payroll Wizard.
 * The wizard is kept mounted across switches so it lives OUTSIDE `AnimatePresence`
 * (see below) — it has to drive these same variants itself to be indistinguishable
 * from a tab that really does enter and exit.
 */
const TAB_MOTION_MS = 280;
const TAB_EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];
const TAB_VARIANTS = {
  enter: (dir: number) => ({ opacity: 0, y: dir * 28 }),
  center: { opacity: 1, y: 0 },
  exit: (dir: number) => ({ opacity: 0, y: dir * -20 }),
};

export default function App({ initialData }: { initialData?: InitialAccountingData | null }) {
  const [activeTab, setActiveTab] = useState('overview');
  usePublishPresenceTab(humanizeTabId(activeTab));
  // Browser tab title follows the active tab, e.g. "Payroll Wizard - HRIS".
  useTabDocumentTitle(humanizeTabId(activeTab));
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [roles, setRoles] = useState<string[]>([]);
  const [featurePerms, setFeaturePerms] = useState<FeaturePermissionsMap>({});
  const [permsLoaded, setPermsLoaded] = useState(false);
  const [sessionEmail, setSessionEmail] = useState<string | null>(null);
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const searchParams = useSearchParams();
  const emailFromQuery = searchParams?.get('email') ?? null;

  // Auto-retract the dashboard sidebar while payroll is processing so the
  // clerk gets the full width to log payments. This is a TEMPORARY override:
  // we remember the user's own collapsed preference when processing starts and
  // restore it when processing stops — we never clobber their saved setting.
  const { state: dispatchLock } = useDispatchLock();
  const { collapsed: sidebarCollapsed, setCollapsed: setSidebarCollapsed } = useSidebarCollapsed();
  const preProcessingCollapsedRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (dispatchLock.locked) {
      // Entering processing: snapshot the current preference once, then collapse.
      if (preProcessingCollapsedRef.current === null) {
        preProcessingCollapsedRef.current = sidebarCollapsed;
        if (!sidebarCollapsed) setSidebarCollapsed(true);
      }
    } else if (preProcessingCollapsedRef.current !== null) {
      // Leaving processing: restore whatever the user had before we forced it.
      if (!preProcessingCollapsedRef.current) setSidebarCollapsed(false);
      preProcessingCollapsedRef.current = null;
    }
  }, [dispatchLock.locked, sidebarCollapsed, setSidebarCollapsed]);

  // Live Accounting alerts: chime + toast the moment a notification lands, so a
  // bank-detail change or a document signing request is noticed while the
  // accountant is on some other tab. Until now this shell mounted only the
  // sidebar's unread badge, so nothing here ever announced itself — the alert
  // existed on HR alone. Scoped to 'accounting' to match that badge
  // (Sidebar.tsx) and the Notifications panel; unscoped it would also ring for
  // another dashboard's notifications on dual-role accounts.
  useNotificationChime(sessionEmail, { view: 'accounting' });

  // JWT session roles — an offline fallback so tab gating survives a Supabase
  // outage (roles are in the cookie without a DB hit). Only trusted for the
  // session owner's own view; see the fetch effect below.
  const { data: authSession } = useSession();
  const authEmail = (authSession?.user?.email ?? '').trim().toLowerCase();
  const authRoles = (authSession?.user as { roles?: string[] } | undefined)?.roles ?? null;
  const authRolesKey = (authRoles ?? []).join(',');

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
      setFeaturePerms({});
      setPermsLoaded(false);
      return;
    }
    let cancelled = false;
    // Offline fallbacks (used only if a fetch fails, e.g. Supabase down): the JWT
    // session roles (when this is the session owner's own view) and last-known-good
    // cache. Without these, an outage collapses roles+perms to empty and every tab
    // but the read-only Overview vanishes from the rail.
    const selfRoles = authRoles && authEmail && authEmail === e.toLowerCase() ? authRoles : null;
    const cached = readRbacCache(e);
    // Optimistic paint: seed from the JWT roles (session owner) + last-known-good
    // cache so the sidebar tabs render on the FIRST frame of a re-visit instead of
    // waiting on the roles + perms round-trips. The live fetch below overwrites
    // this the moment it resolves — until then an admin sees all tabs and a
    // returning non-admin sees their cached set rather than an empty rail.
    const seedRoles = selfRoles ?? cached?.roles ?? null;
    const seedPerms = cached?.perms ?? null;
    if (seedRoles || seedPerms) {
      setRoles(seedRoles ?? []);
      setFeaturePerms(seedPerms ?? {});
      setPermsLoaded(true);
    }
    // Roles + per-feature permissions are fetched in parallel; the tab-gating
    // logic needs both to decide what to show.
    Promise.all([
      fetch(`/api/employee-roles?email=${encodeURIComponent(e)}`, { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`roles ${r.status}`))))
        .then((j: { rows?: { role: string }[] }) =>
          Array.isArray(j.rows)
            ? j.rows.map((row) => row.role)
            : Promise.reject(new Error('roles shape')),
        )
        .catch(() => selfRoles ?? cached?.roles ?? null),
      fetch(`/api/employee-feature-permissions?email=${encodeURIComponent(e)}`, { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`perms ${r.status}`))))
        .then((j: { rows?: Array<{ view_key: string; feature: string; access: 'view' | 'edit' }> }) => {
          if (!Array.isArray(j.rows)) return Promise.reject(new Error('perms shape'));
          const out: FeaturePermissionsMap = {};
          for (const row of j.rows) {
            const view = row.view_key as keyof FeaturePermissionsMap;
            if (!out[view]) out[view] = {};
            (out[view] as Record<string, 'view' | 'edit'>)[row.feature] = row.access;
          }
          return out;
        })
        .catch(() => cached?.perms ?? null),
    ]).then(([r, p]) => {
      if (cancelled) return;
      setRoles(r ?? []);
      setFeaturePerms(p ?? {});
      setPermsLoaded(true);
      // Only refresh the cache from a live (non-null) fetch — never overwrite good
      // cache with the outage fallback.
      if (r !== null || p !== null) {
        writeRbacCache(e, {
          ...(r !== null ? { roles: r } : {}),
          ...(p !== null ? { perms: p } : {}),
        });
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionEmail, authRolesKey, authEmail]);

  const isDark = mounted ? resolvedTheme === 'dark' : false;
  // Global Pages overlay (admin-controlled visible / construction / hidden).
  const { ready: pagesReady, visibilityOf, rawVisibilityOf, isAdmin } = usePagesVisibility();
  const baseAllowedTabs = allowedAccountingTabsForUser(roles, featurePerms);
  // Drop pages an admin hid; keep "construction" ones (shown with a placeholder).
  const allowedTabs = baseAllowedTabs.filter((t) => visibilityOf('accounting', t) !== 'hidden');
  // Badge uses the RAW state so it still shows for admins (who bypass the gate).
  const constructionTabs = baseAllowedTabs.filter((t) => rawVisibilityOf('accounting', t) === 'construction');
  // Deleting a notification is an "edit" action. Admins bypass tab gating;
  // everyone else needs explicit `edit` access to the notifications feature.
  const canDeleteNotifications =
    roles.includes('admin') || canEditFeature(featurePerms, 'accounting', 'notifications');

  const tabDirRef = useRef<1 | -1>(1);
  const mainRef = useRef<HTMLElement | null>(null);

  const isWizardTab = activeTab === 'payroll-wizard';
  const reduceMotion = useReducedMotion() ?? false;
  const tabTransition = { duration: reduceMotion ? 0 : TAB_MOTION_MS / 1000, ease: TAB_EASE };

  // Mount the Payroll Wizard on first visit, then keep it mounted (parked with
  // `hidden`, outside the animated tab-switch tree below) so leaving for another
  // tab and coming back never re-mounts it / re-fetches its data or resets its
  // step.
  //
  // `wizardShown` is what fades it in, and it flips only AFTER the outgoing tab
  // has finished its exit — exactly the beat `AnimatePresence mode="wait"` gives
  // every other tab. Delaying the *mount* by the same beat matters just as much
  // on the first visit: the wizard's first render is ~19k lines of component and
  // 180-odd hooks, and doing that work while the previous tab is mid-fade
  // stuttered the animation.
  const [wizardVisited, setWizardVisited] = useState(false);
  const [wizardShown, setWizardShown] = useState(false);
  // Simple | Interns toggle on the Payroll Wizard tab (Kane 2026-09-02). Interns
  // is a SEPARATE component beside the Payroll Wizard — the wizard stays mounted
  // (parked with `hidden`) while Interns is showing, so the toggle never costs a
  // wizard remount. Remembered per browser session only.
  const [wizardMode, setWizardMode] = useState<'simple' | 'interns'>(() => {
    try {
      return sessionStorage.getItem('accounting.wizardMode') === 'interns' ? 'interns' : 'simple';
    } catch {
      return 'simple';
    }
  });
  const [internsVisited, setInternsVisited] = useState(wizardMode === 'interns');
  const switchWizardMode = (mode: 'simple' | 'interns') => {
    setWizardMode(mode);
    if (mode === 'interns') setInternsVisited(true);
    try {
      sessionStorage.setItem('accounting.wizardMode', mode);
    } catch {
      /* ignore */
    }
  };
  // Parked = `display:none`, so an inactive wizard costs nothing to lay out.
  // Applied only once the exit animation has finished — parking it mid-fade
  // would make it vanish instead of leave.
  const [wizardParked, setWizardParked] = useState(false);
  useEffect(() => {
    // Leaving: the render below already drives the exit off `isWizardTab`, so
    // this only has to disarm the latch for next time.
    if (!isWizardTab) {
      setWizardShown(false);
      return;
    }
    const t = window.setTimeout(
      () => {
        setWizardVisited(true);
        setWizardShown(true);
      },
      reduceMotion ? 0 : TAB_MOTION_MS,
    );
    return () => window.clearTimeout(t);
  }, [isWizardTab, reduceMotion]);

  const navigate = (tab: string) => {
    // Only gate once roles + feature-perms have loaded. Before then everything
    // looks disallowed (empty perms) and `allowedTabs` is empty too, so gating
    // here would bounce a click made during the initial fetch onto the
    // 'payment-dispatch' fallback (e.g. refresh, then click Rates). The effect
    // below re-checks the active tab the moment permsLoaded flips.
    const blockedByPerms = permsLoaded && !canAccessAccountingTabForUser(tab, roles, featurePerms);
    const hiddenByPages = pagesReady && visibilityOf('accounting', tab) === 'hidden';
    if (blockedByPerms || hiddenByPages) {
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

  // The standalone Rates/Profiles tab was removed; the People tab is its
  // replacement (per-person rate, hours, banking, and payroll history). The
  // Overview roster "View" buttons now open People instead.
  const handleViewRates = (_email: string) => {
    navigate('people');
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
    // Wait for the roles + feature-perms fetch to settle before gating —
    // otherwise the initial render (empty perms) kicks every non-admin off
    // the default 'overview' tab onto the fallback before their real
    // permissions arrive.
    if (!permsLoaded || !pagesReady) return;
    if (
      !canAccessAccountingTabForUser(activeTab, roles, featurePerms) ||
      visibilityOf('accounting', activeTab) === 'hidden'
    ) {
      setActiveTab(allowedTabs[0] ?? 'payment-dispatch');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, allowedTabs, roles, featurePerms, permsLoaded, pagesReady]);

  const renderContent = () => {
    if (visibilityOf('accounting', activeTab) !== 'visible') {
      return <UnderConstruction title={pageLabel('accounting', activeTab)} />;
    }
    if (activeTab === 'payroll-wizard') {
      // Rendered persistently below (outside this animated, remount-on-switch
      // tree) — see the `wizardVisited` block further down.
      return null;
    }
    const readOnly = permsLoaded && !canEditAccountingTab(activeTab as typeof ACCOUNTING_TAB_IDS[number], roles, featurePerms);
    return (
      <ReadOnlyTab readOnly={readOnly}>
        {renderTabContent()}
      </ReadOnlyTab>
    );
  };

  const renderTabContent = () => {
    switch (activeTab) {
      case 'overview':
        return <Overview onViewRates={handleViewRates} onNavigate={navigate} initialData={initialData} viewerEmail={sessionEmail} />;
      case 'people':
        return (
          <PeopleTab
            view="accounting"
            viewerEmail={sessionEmail}
            canEdit={canEditAccountingTab('people', roles, featurePerms)}
            canPay={canEditAccountingTab('people', roles, featurePerms) || roles.includes('ceo')}
          />
        );
      case 'bonus-catalog':
        return <BonusCatalog initialData={initialData} />;
      case 'payment-dispatch':
        return <PayrollDispatch />;
      case 'disputes':
        // Bank Preferred change requests render as rows inside the Issues
        // table itself (merged 2026-09-01) — no stacked card above it.
        return <PabDisputeQueue />;
      case 'transfers':
        return <AccountingTransfers />;
      case 'mesa':
        return <AccountingMesa />;
      case 'documents':
        return (
          <AccountingDocuments
            sessionEmail={sessionEmail}
            canEdit={canEditAccountingTab('documents', roles, featurePerms)}
          />
        );
      case 'notifications':
        return <NotificationsPanel viewerEmail={sessionEmail} accent="orange" view="accounting" canDelete={canDeleteNotifications} />;
      case 'settings':
        return <SystemSettings sessionEmail={sessionEmail} />;
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
        return <Overview onViewRates={handleViewRates} onNavigate={navigate} initialData={initialData} viewerEmail={sessionEmail} />;
    }
  };

  // Roles that can post general announcements
  const canPostGeneral = roles.some((r) =>
    ['admin', 'ceo', 'hr_coordinator', 'accounting', 'orphanage_manager'].includes(r),
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
      <Sidebar activeTab={activeTab} setActiveTab={navigate} mobileOpen={mobileNavOpen} allowedTabs={allowedTabs} constructionTabs={constructionTabs} />
      {/* `isolate`: cap the collab chrome's z-indexes (rail z-[60], ping
          bubbles z-[70], cursor overlay z-50) inside <main> so body-portaled
          surfaces (Base UI dialogs/selects at z-50) always paint above them.
          Without it the avatar rail floated over open modals' scrims while
          the cursor overlay dimmed underneath — half the chrome dimmed,
          half didn't. */}
      <main ref={mainRef} className="isolate relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
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
        {/* Both panes below sit in the SAME 1×1 grid cell so they stack instead
            of competing for height. `AnimatePresence mode="wait"` keeps the
            outgoing tab mounted while it fades, and as a flex sibling that box
            used to split the column with the persistent wizard — so switching to
            the wizard drew it at half height for 280ms and then snapped it to
            full when the old tab finally unmounted. */}
        <div className="grid min-h-0 min-w-0 flex-1 grid-cols-1 grid-rows-1 overflow-hidden">
          <AnimatePresence mode="wait" initial={false} custom={tabDirRef.current}>
            <motion.div
              key={activeTab}
              custom={tabDirRef.current}
              variants={TAB_VARIANTS}
              initial="enter"
              animate="center"
              exit="exit"
              transition={tabTransition}
              className="col-start-1 row-start-1 flex min-h-0 min-w-0 flex-col overflow-hidden"
            >
              {isAdmin && !isWizardTab && rawVisibilityOf('accounting', activeTab) === 'construction' && (
                <ConstructionBanner title={pageLabel('accounting', activeTab)} />
              )}
              {renderContent()}
            </motion.div>
          </AnimatePresence>
          {/* Mounted once on first visit and kept alive (parked, not unmounted)
              in the same grid cell as the animated tab above — the Payroll
              Wizard has its own multi-step flow and dozens of data fetches, so
              tearing it down every time the user peeks at another tab and comes
              back reset its step and re-fetched everything from scratch.
              Being outside `AnimatePresence` it has to run the tab variants
              itself; on the same timing they're indistinguishable. Un-parking
              happens the instant the tab changes, a full beat before the fade-in
              — that hands the browser the dead time to lay the huge subtree back
              out while it's still at opacity 0. */}
          {wizardVisited && visibilityOf('accounting', 'payroll-wizard') === 'visible' && (
            <motion.div
              custom={tabDirRef.current}
              variants={TAB_VARIANTS}
              initial="enter"
              animate={isWizardTab && wizardShown ? 'center' : 'exit'}
              transition={tabTransition}
              onAnimationComplete={(def) => setWizardParked(def === 'exit')}
              className={cn(
                'col-start-1 row-start-1 flex min-h-0 min-w-0 flex-col overflow-hidden',
                // While it fades out it's still stacked on top of the incoming
                // tab, so it must not swallow that tab's clicks.
                !isWizardTab && 'pointer-events-none',
                !isWizardTab && wizardParked && 'hidden',
              )}
            >
              {isAdmin && rawVisibilityOf('accounting', 'payroll-wizard') === 'construction' && (
                <ConstructionBanner title={pageLabel('accounting', 'payroll-wizard')} />
              )}
              {/* The Payroll Wizard is a processing surface, not a browse surface: a
                  view-only user must not touch its step / department navigation, so
                  lock it strictly (no tab/pagination carve-out) rather than the usual
                  browseable read-only. */}
              {/* Simple | Interns — the interns are a separate payee class with their
                  own mini wizard on the Orphanage dashboard; this side is Accounting's
                  inbox for the weeks they lock in. */}
              <div className="flex items-center justify-end px-4 pt-3 md:px-6" data-readonly-allow>
                <div role="tablist" aria-label="Payroll rail" className="inline-flex rounded-xl border border-zinc-200 bg-zinc-50 p-1 dark:border-zinc-800 dark:bg-zinc-900/60">
                  {(['simple', 'interns'] as const).map((m) => (
                    <button
                      key={m}
                      role="tab"
                      type="button"
                      aria-selected={wizardMode === m}
                      onClick={() => switchWizardMode(m)}
                      className={cn(
                        'rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors',
                        wizardMode === m
                          ? m === 'interns'
                            ? 'bg-white text-violet-700 shadow-sm dark:bg-zinc-950 dark:text-violet-300'
                            : 'bg-white text-indigo-700 shadow-sm dark:bg-zinc-950 dark:text-indigo-300'
                          : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200',
                      )}
                    >
                      {m === 'simple' ? 'Simple' : 'Interns'}
                    </button>
                  ))}
                </div>
              </div>
              <ReadOnlyTab
                readOnly={permsLoaded && !canEditAccountingTab('payroll-wizard', roles, featurePerms)}
                strict
              >
                <div className={cn('flex min-h-0 flex-1 flex-col', wizardMode !== 'simple' && 'hidden')}>
                  <PayrollWizard sessionEmail={sessionEmail} sessionRole={roles[0] ?? null} initialData={initialData} />
                </div>
                {internsVisited && (
                  <div className={cn('flex min-h-0 flex-1 flex-col overflow-y-auto', wizardMode !== 'interns' && 'hidden')}>
                    <InternsPayrollView
                      sessionEmail={sessionEmail}
                      canEdit={!permsLoaded || canEditAccountingTab('payroll-wizard', roles, featurePerms)}
                    />
                  </div>
                )}
              </ReadOnlyTab>
            </motion.div>
          )}
        </div>
        <AppFooter />
        <AccountingCollabLayer
          selfEmail={sessionEmail}
          section={activeTab}
          containerRef={mainRef}
        />
        {/* Advertise this accountant into the CEO's live payroll roster while
            they're on a payroll surface. No cobrowse driver here — the collab
            layer above already records this page over the shared channel. */}
        {(activeTab === 'payroll-wizard' || activeTab === 'payment-dispatch') && (
          <PayrollLivePublisher
            selfEmail={sessionEmail}
            surface={activeTab === 'payroll-wizard' ? 'wizard' : 'dispatch'}
            activity={activeTab === 'payroll-wizard' ? 'In the Payroll Wizard' : 'In Payment Dispatch'}
          />
        )}
        {/* Floating carry-over Notes checklist. Mounted OUTSIDE the strict
            ReadOnlyTab wrapper so view-only accountants can still open and
            read it — only `edit` grants (or admin) can change rows, and the
            notes API enforces the same grant server-side. Gated on `wizardShown`
            (not just the tab) because it's fixed-positioned, i.e. outside the
            fading pane: mounted any earlier it pops in over the tab that's still
            on its way out. */}
        {isWizardTab &&
          wizardShown &&
          permsLoaded &&
          visibilityOf('accounting', 'payroll-wizard') === 'visible' && (
            <PayrollWizardNotesFab
              sessionEmail={sessionEmail}
              canEdit={canEditAccountingTab('payroll-wizard', roles, featurePerms)}
            />
          )}
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
      <div className="min-h-0 flex-1 overflow-y-auto bg-[#fafaf8] dark:bg-[#0d1117]">
        <SWall viewerEmail={sessionEmail} canPost={canPost} sourceLabel={canPost ? 'Accounting' : undefined} />
      </div>
    </div>
  );
}
