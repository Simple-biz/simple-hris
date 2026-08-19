'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTheme } from 'next-themes';
import { useSession } from 'next-auth/react';
import { motion } from 'motion/react';
import { toast } from 'sonner';
import EmployeeSidebar from './EmployeeSidebar';
import EmployeeDashboard from './EmployeeDashboard';
import EmployeeProfile from './EmployeeProfile';
import AppFooter from '@/components/AppFooter';
import EmployeeLeaves from './EmployeeLeaves';
import EmployeeTeam from './EmployeeTeam';
import EmployeeMesa from './EmployeeMesa';
import EmployeeMyHours from './EmployeeMyHours';
import EmployeeKpiResults from './EmployeeKpiResults';
import SWall from '@/components/swall/SWall';
import CeoChatBubble from '@/components/ceo/CeoChatBubble';
import NotificationsPanel from '@/components/notifications/NotificationsPanel';
// import MyDisputes from './MyDisputes'; // hidden — disputes now go through Orphanage Manager → Accounting flow
import PayrollLockBanner from './PayrollLockBanner';
import { Toaster } from '@/components/ui/sonner';
import { Lock, Menu, Unlock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useDispatchLock } from '@/hooks/useDispatchLock';
import { useEmployeeNotificationsUnread } from '@/hooks/useEmployeeNotificationsUnread';
import { useNotificationChime } from '@/hooks/useNotificationChime';
import { useMesaNewDeposits } from '@/hooks/useMesaNewDeposits';
import { useBankInfoRequest } from '@/hooks/useBankInfoRequest';
import { usePagesVisibility } from '@/hooks/usePagesVisibility';
import { dashboardPages, pageLabel } from '@/lib/pages/visibility';
import UnderConstruction from '@/components/common/UnderConstruction';
import ConstructionBanner from '@/components/common/ConstructionBanner';

import { normEmail } from '@/lib/email/norm-email';
import { usePublishPresenceTab } from '@/components/presence/PresenceProvider';
import { humanizeTabId } from '@/lib/presence/page-label';
import { useTabDocumentTitle } from '@/hooks/useTabDocumentTitle';
import { isPayoutComplete } from '@/components/employee/employee-payout-fields';
import {
  GREETING_AUTOHIDE_MS,
  GREETING_DELAY_MS,
  GREETING_TEXT,
  allFaqQuestions,
  greetingFaqs,
} from '@/lib/penny/employee-faq';
import { hasAnySkillSetContent, type SkillSetCompletionFields } from '@/lib/skill-set-titles';
import type { EmployeeRow } from '@/lib/supabase/employees';
import type { EmployeeHourlyRateRow } from '@/lib/supabase/employee-hourly-rates';
import type { EmployeeIdRow } from '@/lib/supabase/employee-ids';

const SESSION_KEY = 'employee_session_email';
type EmployeeProfileFocusTab = 'overview' | 'payment' | 'skillsets';

/**
 * Penny's starter chips on the employee Overview — the same pool the greeting
 * balloon draws from. ONE list on purpose: a chip Penny volunteers unprompted and
 * a chip it shows in an empty panel must both be a question it can actually
 * answer. `src/lib/penny/employee-faq.ts` owns them, and a test pins every entry
 * to a real tool so an unanswerable one cannot be added.
 */
const PENNY_EMPLOYEE_SUGGESTIONS = allFaqQuestions();

function isPlausibleEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

/**
 * Employee-facing app shell — rendered at /employee.
 * Identity comes from `?email=` (synced to sessionStorage) when present; otherwise sessionStorage
 * set at login. Without either, redirects to /login.
 */
export default function EmployeeApp() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [activeTab, setActiveTab] = useState('dashboard');
  usePublishPresenceTab(humanizeTabId(activeTab));
  useTabDocumentTitle(humanizeTabId(activeTab));
  const [profileFocusTab, setProfileFocusTab] = useState<EmployeeProfileFocusTab>('overview');
  // Disputes prefill — kept for future use if the flow is re-enabled
  // const [disputesPrefill, setDisputesPrefill] = useState<{ date: string; seconds?: number } | null>(null);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [employeeEmail, setEmployeeEmail] = useState<string | null>(null);
  const [profilePhotoUrl, setProfilePhotoUrl] = useState<string | null>(null);
  const [employeeName, setEmployeeName] = useState<string | null>(null);
  const [employeeDepartment, setEmployeeDepartment] = useState<string | null>(null);
  const [employeeId, setEmployeeId] = useState<string | null>(null);
  const [employeeStartDate, setEmployeeStartDate] = useState<string | null>(null);
  // Whether payout/bank details are filled in. null = not yet known (suppresses
  // the nudge until the first fetch lands so it doesn't flash on load).
  const [payoutComplete, setPayoutComplete] = useState<boolean | null>(null);
  const [skillSetComplete, setSkillSetComplete] = useState<boolean | null>(null);
  // One-shot login hand-off: when we arrive straight from the sign-in video, reveal the shell
  // from a white veil (matching the video's closing fade) instead of popping in. The flag is
  // read once at mount-time (this render only ever happens client-side during the SPA hand-off,
  // so there's no SSR/hydration mismatch) and cleared in an effect below.
  const [revealFromLogin] = useState(() => {
    if (typeof window === 'undefined') return false;
    try {
      return sessionStorage.getItem('hris_post_login') === '1';
    } catch {
      return false;
    }
  });
  const [veilLifted, setVeilLifted] = useState(false);
  const [veilDone, setVeilDone] = useState(false);

  // Google SSO profile photo — falls back through Supabase upload → Gravatar in EmployeeAvatar.
  // Only honored when the NextAuth session email matches the employee being viewed, so
  // impersonation paths (?email=other.user@simple.biz) don't show the wrong person's photo.
  const { data: session, status: sessionStatus } = useSession();
  const googlePhotoUrl = useMemo(() => {
    const sessionEmail = session?.user?.email?.trim().toLowerCase();
    const sessionImage = session?.user?.image?.trim();
    if (!sessionEmail || !sessionImage) return null;
    const subjectEmail = (normEmail(employeeEmail ?? '') ?? employeeEmail?.trim().toLowerCase()) || null;
    if (!subjectEmail) return null;
    return sessionEmail === subjectEmail ? sessionImage : null;
  }, [session?.user?.email, session?.user?.image, employeeEmail]);

  // Live payroll-processing lock — drives the global banner, sidebar lock
  // indicator, and one-time toast notifications when the state flips.
  const { state: lockState, loading: lockLoading } = useDispatchLock();
  const unreadNotifications = useEmployeeNotificationsUnread(employeeEmail, 'employee');
  // Live bell + toast for new employee-view notifications (KPI bonus scored,
  // salary ready, paid, …). Scoped to 'employee' per notification-alerts.md —
  // every useNotificationChime mount passes a view. Keyed on employeeEmail
  // (the viewed identity), matching the unread badge above, so an elevated
  // ?email= viewer hears what that panel shows — never their own other-role mix.
  useNotificationChime(employeeEmail, { view: 'employee' });
  // New MESA contribution alert — badges the MESA tab when a deposit lands
  // (a CSV deposit loaded since the member last opened MESA); clears on open.
  const { newCount: mesaNewDeposits, markSeen: markMesaSeen } = useMesaNewDeposits(employeeEmail);
  // Did accounting/CEO ask this person (from the People tab) to add missing
  // payout details? Escalates the Profile → Payment nudge from amber to rose.
  const bankInfoRequested = useBankInfoRequest(employeeEmail);

  // Global Pages overlay (admin-controlled visible / construction / hidden).
  const { ready: pagesReady, visibilityOf, rawVisibilityOf, isAdmin } = usePagesVisibility();
  const employeeTabKeys = useMemo(() => dashboardPages('employee').map((p) => p.key), []);
  const hiddenEmployeeTabs = employeeTabKeys.filter((t) => visibilityOf('employee', t) === 'hidden');
  // Badge uses the RAW state so it still shows for admins (who bypass the gate).
  const constructionEmployeeTabs = employeeTabKeys.filter((t) => rawVisibilityOf('employee', t) === 'construction');

  const previousLocked = useRef<boolean | null>(null);

  // Detect transitions (only after first hydration so we don't toast on mount).
  useEffect(() => {
    if (lockLoading) return;
    const current = lockState.locked;
    const previous = previousLocked.current;
    if (previous != null && previous !== current) {
      if (current) {
        toast.error('Payroll processing started', {
          icon: <Lock className="h-4 w-4 text-rose-500" />,
          description: 'Issues are temporarily paused while accounting runs payroll.',
          duration: 6000,
        });
      } else {
        toast.success('Payroll processing finished', {
          icon: <Unlock className="h-4 w-4 text-emerald-500" />,
          description: 'You can file new issues again.',
          duration: 5000,
        });
      }
    }
    previousLocked.current = current;
  }, [lockState.locked, lockLoading]);

  // Clear the login baton (so reloads don't re-trigger) and, on the next two frames, lift the
  // white veil. The double rAF guarantees the browser paints the opaque veil first, so the fade
  // actually animates from fully-white instead of skipping straight to revealed.
  useEffect(() => {
    if (!revealFromLogin) return;
    try {
      sessionStorage.removeItem('hris_post_login');
    } catch {
      /* ignore */
    }
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setVeilLifted(true));
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [revealFromLogin]);

  const emailFromQuery = searchParams?.get('email') ?? null;

  // Resolve the portal's viewer identity from the AUTHENTICATED session, not from
  // a client-supplied ?email= / sessionStorage value. A ?email= override is
  // honored ONLY for elevated users (admin/payroll/finance/hr/viewer) so they can
  // preview another employee's portal; for everyone else it is ignored, so a
  // stale or spoofed email (e.g. left over after switching Google accounts in the
  // same tab) can never surface another person's data. The server endpoints
  // enforce the same self-or-elevated rule — this keeps the client in sync.
  useEffect(() => {
    setMounted(true);
    if (sessionStatus === 'loading') return;
    try {
      const sessionEmail =
        (normEmail(session?.user?.email ?? '') ?? session?.user?.email?.trim().toLowerCase()) || null;
      const elevated = !!(session?.user as { elevated?: boolean } | undefined)?.elevated;
      const q = emailFromQuery?.trim() ?? '';
      const queryEmail = q && isPlausibleEmail(q) ? (normEmail(q) ?? q.toLowerCase()) : null;

      let identity: string | null = null;
      if (queryEmail && elevated && queryEmail !== sessionEmail) {
        identity = queryEmail; // elevated preview / impersonation
      } else if (sessionEmail) {
        identity = sessionEmail; // normal self — ignore any stale ?email=
      } else {
        identity = sessionStorage.getItem(SESSION_KEY); // unauthenticated fallback
      }

      if (!identity) {
        router.replace('/login');
        return;
      }
      sessionStorage.setItem(SESSION_KEY, identity);
      setEmployeeEmail(identity);
    } catch {
      router.replace('/login');
    }
  }, [router, emailFromQuery, session?.user, sessionStatus]);

  // Fetch profile photo, name, department, and employee ID
  useEffect(() => {
    if (!employeeEmail) {
      setProfilePhotoUrl(null);
      setEmployeeName(null);
      setEmployeeDepartment(null);
      setEmployeeId(null);
      setPayoutComplete(null);
      setSkillSetComplete(null);
      return;
    }
    const norm = normEmail(employeeEmail) ?? employeeEmail.toLowerCase();
    let cancelled = false;
    (async () => {
      try {
        const [photoRes, empRes, rateRes, idsRes, skillSetRes] = await Promise.all([
          fetch(`/api/employee-profile-photo?email=${encodeURIComponent(employeeEmail)}`, { cache: 'no-store' }),
          fetch(`/api/employees?email=${encodeURIComponent(employeeEmail)}`, { cache: 'no-store' }),
          fetch(`/api/employee-hourly-rates?email=${encodeURIComponent(employeeEmail)}`, { cache: 'no-store' }),
          fetch(`/api/employee-ids?email=${encodeURIComponent(employeeEmail)}`, { cache: 'no-store' }),
          fetch(`/api/employee-skill-sets?email=${encodeURIComponent(employeeEmail)}`, { cache: 'no-store' }),
        ]);
        const photoJson = (await photoRes.json()) as { profilePhotoUrl?: string | null };
        const empJson = (await empRes.json()) as { employees?: EmployeeRow[] };
        const rateJson = (await rateRes.json()) as { rows?: EmployeeHourlyRateRow[] };
        const idsJson = (await idsRes.json()) as { rows?: EmployeeIdRow[] };
        const skillSetJson = (await skillSetRes.json()) as { row?: SkillSetCompletionFields | null };
        if (cancelled) return;

        setProfilePhotoUrl(photoJson.profilePhotoUrl?.trim() || null);
        const myId = (idsJson.rows ?? [])[0];
        setPayoutComplete(isPayoutComplete((myId as unknown as Record<string, unknown>) ?? null));
        setSkillSetComplete(hasAnySkillSetContent(skillSetJson.row));

        let master = (empJson.employees ?? []).find((e) => {
          const we = normEmail(e.work_email ?? '');
          const pe = normEmail(e.personal_email ?? '');
          // Alternate work emails are a second inbox for the same person, so a
          // login via an alternate must still resolve to their own master row
          // (otherwise department stays null and My Team renders empty).
          const a1 = normEmail(e.alternate_work_email ?? '');
          const a2 = normEmail(e.alternate_work_email_2 ?? '');
          return we === norm || pe === norm || a1 === norm || a2 === norm;
        }) ?? null;
        // Fallback to the underlying `global_master_list` for people who aren't on the
        // latest upload (e.g. internal devs). Keeps identity rendering instead of
        // collapsing to "<email-prefix>" / no department.
        if (!master) {
          try {
            const mrRes = await fetch(
              `/api/employee-master-record?email=${encodeURIComponent(employeeEmail)}`,
              { cache: 'no-store' },
            );
            const mrJson = (await mrRes.json()) as { employee?: EmployeeRow | null };
            master = mrJson.employee ?? null;
          } catch { /* ignore — master stays null */ }
        }
        const rate = (rateJson.rows ?? []).find((r) => {
          const we = normEmail(r.work_email ?? '');
          const pe = normEmail(r.personal_email ?? '');
          return we === norm || pe === norm;
        });

        if (cancelled) return;
        setEmployeeName(master?.name?.trim() || null);
        // Department is sourced from global_master_list — that's the canonical roster
        // value. `employee_hourly_rates."Department"` is a payroll/routing bucket and
        // shouldn't drive the portal's identity (per its lib comment).
        setEmployeeDepartment(master?.department?.trim() || rate?.department?.trim() || null);
        setEmployeeId(master?.employee_id?.trim() || null);
        setEmployeeStartDate(master?.start_date?.trim() || null);
      } catch {
        if (!cancelled) setProfilePhotoUrl(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [employeeEmail]);

  const isDark = mounted ? resolvedTheme === 'dark' : false;

  // Profile-setup nudge. A Google SSO photo counts as "has a photo" so SSO users
  // aren't nagged. Gate on payoutComplete !== null so nothing flashes pre-fetch.
  const needsPhoto = !profilePhotoUrl && !googlePhotoUrl;
  const needsBank = payoutComplete === false;
  const needsSkillSet = skillSetComplete === false;
  const profileIncomplete =
    payoutComplete !== null &&
    skillSetComplete !== null &&
    (needsPhoto || needsBank || needsSkillSet);
  const profileSetupCount = [needsPhoto, needsBank, needsSkillSet].filter(Boolean).length;
  // Loud rose escalation only while they were explicitly asked AND still have no
  // payout method — it clears itself the moment they add their bank details.
  const bankInfoNudge = bankInfoRequested && needsBank;

  // Keep-alive: once a tab has been visited we keep its component mounted and
  // just hide it, so its fetched data/state survive tab switches (no reload when
  // hopping overview → profile → my hours and back). Tabs are mounted lazily on
  // first visit so we don't pay every tab's startup fetch up front.
  const [mountedTabs, setMountedTabs] = useState<Set<string>>(() => new Set(['dashboard']));
  useEffect(() => {
    setMountedTabs((prev) => (prev.has(activeTab) ? prev : new Set(prev).add(activeTab)));
  }, [activeTab]);

  // If an admin hides the active page, bounce to the first still-visible page.
  const hiddenEmployeeKey = hiddenEmployeeTabs.join(',');
  useEffect(() => {
    if (!pagesReady) return;
    if (hiddenEmployeeTabs.includes(activeTab)) {
      const firstVisible = employeeTabKeys.find((t) => !hiddenEmployeeTabs.includes(t)) ?? 'dashboard';
      setActiveTab(firstVisible);
      setMobileNavOpen(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pagesReady, hiddenEmployeeKey, activeTab]);

  // Opening MESA marks its contributions as seen, clearing the tab badge.
  useEffect(() => {
    if (activeTab === 'mesa') markMesaSeen();
  }, [activeTab, markMesaSeen]);

  const navigate = (tab: string, profileTarget?: EmployeeProfileFocusTab) => {
    if (tab === 'profile' && profileTarget) setProfileFocusTab(profileTarget);
    setActiveTab(tab);
    setMobileNavOpen(false);
  };

  const navigateToProfileSetup = (target?: EmployeeProfileFocusTab) => {
    navigate('profile', target ?? (needsPhoto ? 'overview' : needsBank ? 'payment' : 'skillsets'));
  };

  useEffect(() => {
    if (!mobileNavOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMobileNavOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mobileNavOpen]);

  // Lock body scroll while the mobile drawer is open so the page doesn't scroll behind it.
  useEffect(() => {
    if (!mobileNavOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [mobileNavOpen]);

  if (!employeeEmail) return null;

  const renderContent = (tab: string) => {
    if (!employeeEmail) return null;

    // Global Pages overlay: hidden tabs render nothing; construction tabs show
    // the placeholder instead of the real page.
    const vis = visibilityOf('employee', tab);
    if (vis === 'hidden') return null;
    if (vis === 'construction') return <UnderConstruction title={pageLabel('employee', tab)} />;

    switch (tab) {
      case 'dashboard':
        return (
          <EmployeeDashboard
            employeeEmail={employeeEmail}
            needsPhoto={needsPhoto}
            needsBank={needsBank}
            needsSkillSet={needsSkillSet}
            onNavigateToProfile={profileIncomplete ? navigateToProfileSetup : undefined}
            onNavigateToNotifications={() => navigate('notifications')}
            unreadNotifications={unreadNotifications}
            // onNavigateToDisputes={(prefill) => {
            //   setDisputesPrefill(prefill ?? null);
            //   navigate('disputes');
            // }}
          />
        );
      case 'profile':
        return (
          <EmployeeProfile
            employeeEmail={employeeEmail}
            profilePhotoUrl={profilePhotoUrl}
            googlePhotoUrl={googlePhotoUrl}
            focusTab={profileFocusTab}
            onProfilePhotoUpdated={(url) => setProfilePhotoUrl(url)}
            onPayoutCompletionChange={(complete) => setPayoutComplete(complete)}
            onSkillSetCompletionChange={(complete) => setSkillSetComplete(complete)}
            payrollLocked={lockState.locked}
            escalatePayment={bankInfoNudge}
          />
        );
      case 'hours':
        return (
          <EmployeeMyHours
            employeeEmail={employeeEmail}
            // onNavigateToDisputes={(prefill) => {
            //   setDisputesPrefill(prefill ?? null);
            //   navigate('disputes');
            // }}
          />
        );
      case 'kpi':
        return <EmployeeKpiResults employeeEmail={employeeEmail} />;
      case 'leaves':
        return (
          <EmployeeLeaves
            employeeEmail={employeeEmail}
            employeeName={employeeName ?? null}
            department={employeeDepartment ?? null}
          />
        );
      // case 'disputes': // hidden — disputes now go through Orphanage Manager → Accounting flow
      //   return (
      //     <MyDisputes
      //       employeeEmail={employeeEmail}
      //       employeeName={employeeName}
      //       prefill={disputesPrefill}
      //       onPrefillConsumed={() => setDisputesPrefill(null)}
      //       payrollLocked={lockState.locked}
      //     />
      //   );
      case 'mesa':
        return (
          <EmployeeMesa
            employeeEmail={employeeEmail}
            employeeName={employeeName ?? null}
            department={employeeDepartment ?? null}
            startDate={employeeStartDate ?? null}
          />
        );
      case 'team':
        return (
          <EmployeeTeam
            employeeEmail={employeeEmail}
            department={employeeDepartment}
          />
        );
      case 'notifications':
        return <NotificationsPanel viewerEmail={employeeEmail} accent="orange" view="employee" />;
      case 's-wall':
        return (
          <div className="flex h-full min-h-0 flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto bg-[#fafaf8] dark:bg-[#0d1117]">
              <SWall viewerEmail={employeeEmail} canPost={false} />
            </div>
          </div>
        );
      default:
        return <EmployeeDashboard employeeEmail={employeeEmail} />;
    }
  };

  return (
    <>
    <motion.div
      initial={revealFromLogin ? { opacity: 0, scale: 0.985 } : false}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
      className="flex h-dvh max-h-dvh overflow-hidden bg-white font-sans text-zinc-900 selection:bg-orange-500/20 selection:text-orange-900 dark:bg-[#0d1117] dark:text-zinc-100 dark:selection:bg-orange-500/30 dark:selection:text-orange-200"
    >
      <button
        type="button"
        className={`fixed inset-0 z-40 bg-black/45 backdrop-blur-[2px] transition-opacity duration-300 ease-out md:hidden ${
          mobileNavOpen ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
        aria-label="Close navigation menu"
        aria-hidden={!mobileNavOpen}
        tabIndex={mobileNavOpen ? 0 : -1}
        onClick={() => setMobileNavOpen(false)}
      />
      <EmployeeSidebar
        activeTab={activeTab}
        setActiveTab={navigate}
        mobileOpen={mobileNavOpen}
        employeeName={employeeName || employeeEmail?.split('@')[0]?.replace(/\./g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) || 'Employee'}
        department={employeeDepartment || undefined}
        employeeId={employeeId || undefined}
        employeeEmail={employeeEmail}
        profilePhotoUrl={profilePhotoUrl}
        googlePhotoUrl={googlePhotoUrl}
        payrollLocked={lockState.locked}

        profileIncomplete={profileIncomplete}
        profileSetupCount={profileSetupCount}
        bankInfoNudge={bankInfoNudge}
        unreadNotifications={unreadNotifications}
        mesaNewCount={mesaNewDeposits}
        hiddenTabs={hiddenEmployeeTabs}
        constructionTabs={constructionEmployeeTabs}
      />
      <main className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex shrink-0 items-center gap-3 border-b border-orange-100 bg-white/95 px-3 py-2.5 backdrop-blur-md supports-[padding:max(0px)]:pt-[max(0.625rem,env(safe-area-inset-top))] dark:border-blue-950/60 dark:bg-[#0d1117]/95 md:hidden">
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="shrink-0 border-orange-200/80 bg-white/80 dark:border-blue-950/60 dark:bg-blue-950/30"
            onClick={() => setMobileNavOpen(true)}
            aria-expanded={mobileNavOpen}
            aria-controls="employee-sidebar-nav"
            aria-label="Open navigation menu"
          >
            <Menu className="h-5 w-5" />
          </Button>
          <span className="min-w-0 truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            Employee
          </span>
        </header>
        <PayrollLockBanner state={lockState} />
        <div className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {Array.from(mountedTabs).map((tab) => {
            const isActive = tab === activeTab;
            return (
              <motion.div
                key={tab}
                role="presentation"
                aria-hidden={!isActive}
                initial={false}
                animate={{ opacity: isActive ? 1 : 0, y: isActive ? 0 : 6 }}
                transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                className={`min-h-0 min-w-0 flex-1 flex-col overflow-hidden ${
                  isActive ? 'flex' : 'pointer-events-none hidden'
                }`}
              >
                {isAdmin && rawVisibilityOf('employee', tab) === 'construction' && (
                  <ConstructionBanner title={pageLabel('employee', tab)} />
                )}
                {renderContent(tab)}
              </motion.div>
            );
          })}
        </div>
        <AppFooter />
      </main>
      {/* Penny AI — Overview tab ONLY (Kane 2026-08-19: "Overview - Chat Bubble
          only"), so it never floats over My Hours, MESA or the Profile forms.
          The route is the access control, not this mount: /api/employee/penny-chat
          re-resolves the subject through authorizeEmailAccess and its tools take
          no identity argument. `email` rides along so an elevated ?email= viewer
          gets Penny answering about the person whose dashboard they are reading,
          matching the notifications panel and the unread badge. No thumbs rating
          — /api/ceo/chat/feedback admits ceo/admin only, so the control would be
          decorative here. See docs/features/employee-penny-ai.md. */}
      {activeTab === 'dashboard' && employeeEmail && (
        <CeoChatBubble
          endpoint="/api/employee/penny-chat"
          quotaEndpoint={`/api/employee/penny-chat/quota?email=${encodeURIComponent(employeeEmail)}`}
          extraBody={{ email: employeeEmail }}
          feedbackEndpoint={null}
          subtitle="Your pay, bonuses & policies"
          suggestions={PENNY_EMPLOYEE_SUGGESTIONS}
          markSrc="/Chatbubblev2.png"
          greeting={{
            text: GREETING_TEXT,
            chips: greetingFaqs(),
            delayMs: GREETING_DELAY_MS,
            autoHideMs: GREETING_AUTOHIDE_MS,
            // Per signed-in identity, so an elevated viewer switching between
            // employees is not re-greeted for each one.
            storageKey: `penny_greeted:${employeeEmail}`,
          }}
        />
      )}
      <Toaster position="top-right" theme={isDark ? 'dark' : 'light'} />
    </motion.div>

      {/* Matched white veil for the sign-in hand-off: starts opaque (continuing the video's
          closing fade), then lifts to reveal the already-laid-out shell so nothing pops in.
          Unmounts itself once the fade completes. */}
      {revealFromLogin && !veilDone && (
        <motion.div
          aria-hidden
          className="pointer-events-none fixed inset-0 z-[200] bg-white dark:bg-[#0d1117]"
          initial={{ opacity: 1 }}
          animate={{ opacity: veilLifted ? 0 : 1 }}
          transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
          onAnimationComplete={() => {
            if (veilLifted) setVeilDone(true);
          }}
        />
      )}
    </>
  );
}
