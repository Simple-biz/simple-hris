'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTheme } from 'next-themes';
import { useSession } from 'next-auth/react';
import { motion, AnimatePresence } from 'motion/react';
import { toast } from 'sonner';
import EmployeeSidebar from './EmployeeSidebar';
import EmployeeDashboard from './EmployeeDashboard';
import EmployeeProfile from './EmployeeProfile';
import EmployeeLeaves from './EmployeeLeaves';
import EmployeePolicies from './EmployeePolicies';
import EmployeeMesa from './EmployeeMesa';
import EmployeeMyHours from './EmployeeMyHours';
import AnnouncementWall from '@/components/announcements/AnnouncementWall';
import SWall from '@/components/swall/SWall';
import NotificationsPanel from '@/components/notifications/NotificationsPanel';
// import MyDisputes from './MyDisputes'; // hidden — disputes now go through Orphanage Manager → Accounting flow
import PayrollLockBanner from './PayrollLockBanner';
import { Toaster } from '@/components/ui/sonner';
import { Lock, Menu, Unlock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useDispatchLock } from '@/hooks/useDispatchLock';
import { normEmail } from '@/lib/email/norm-email';
import type { EmployeeRow } from '@/lib/supabase/employees';
import type { EmployeeHourlyRateRow } from '@/lib/supabase/employee-hourly-rates';

const SESSION_KEY = 'employee_session_email';

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

  // Google SSO profile photo — falls back through Supabase upload → Gravatar in EmployeeAvatar.
  // Only honored when the NextAuth session email matches the employee being viewed, so
  // impersonation paths (?email=other.user@simple.biz) don't show the wrong person's photo.
  const { data: session } = useSession();
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
          description: 'Disputes are temporarily paused while accounting runs payroll.',
          duration: 6000,
        });
      } else {
        toast.success('Payroll processing finished', {
          icon: <Unlock className="h-4 w-4 text-emerald-500" />,
          description: 'You can file new disputes again.',
          duration: 5000,
        });
      }
    }
    previousLocked.current = current;
  }, [lockState.locked, lockLoading]);

  const emailFromQuery = searchParams?.get('email') ?? null;

  useEffect(() => {
    setMounted(true);
    try {
      const q = emailFromQuery?.trim() ?? '';
      if (q && isPlausibleEmail(q)) {
        const normalized = normEmail(q) ?? q.toLowerCase();
        sessionStorage.setItem(SESSION_KEY, normalized);
        setEmployeeEmail(normalized);
        return;
      }
      const stored = sessionStorage.getItem(SESSION_KEY);
      if (stored) {
        setEmployeeEmail(stored);
      } else {
        router.replace('/login');
      }
    } catch {
      router.replace('/login');
    }
  }, [router, emailFromQuery]);

  // Fetch profile photo, name, department, and employee ID
  useEffect(() => {
    if (!employeeEmail) {
      setProfilePhotoUrl(null);
      setEmployeeName(null);
      setEmployeeDepartment(null);
      setEmployeeId(null);
      return;
    }
    const norm = normEmail(employeeEmail) ?? employeeEmail.toLowerCase();
    let cancelled = false;
    (async () => {
      try {
        const [photoRes, empRes, rateRes] = await Promise.all([
          fetch(`/api/employee-profile-photo?email=${encodeURIComponent(employeeEmail)}`, { cache: 'no-store' }),
          fetch(`/api/employees?email=${encodeURIComponent(employeeEmail)}`, { cache: 'no-store' }),
          fetch(`/api/employee-hourly-rates?email=${encodeURIComponent(employeeEmail)}`, { cache: 'no-store' }),
        ]);
        const photoJson = (await photoRes.json()) as { profilePhotoUrl?: string | null };
        const empJson = (await empRes.json()) as { employees?: EmployeeRow[] };
        const rateJson = (await rateRes.json()) as { rows?: EmployeeHourlyRateRow[] };
        if (cancelled) return;

        setProfilePhotoUrl(photoJson.profilePhotoUrl?.trim() || null);

        let master = (empJson.employees ?? []).find((e) => {
          const we = normEmail(e.work_email ?? '');
          const pe = normEmail(e.personal_email ?? '');
          return we === norm || pe === norm;
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

  const navigate = (tab: string) => {
    setActiveTab(tab);
    setMobileNavOpen(false);
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

  const renderContent = () => {
    if (!employeeEmail) return null;

    switch (activeTab) {
      case 'dashboard':
        return (
          <EmployeeDashboard
            employeeEmail={employeeEmail}
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
            onProfilePhotoUpdated={(url) => setProfilePhotoUrl(url)}
            payrollLocked={lockState.locked}
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
      case 'policies':
        return <EmployeePolicies department={employeeDepartment} />;
      case 'announcements':
        return (
          <EmployeeAnnouncementsTab
            employeeEmail={employeeEmail}
            department={employeeDepartment}
          />
        );
      case 'notifications':
        return <NotificationsPanel viewerEmail={employeeEmail} accent="orange" />;
      case 's-wall':
        return (
          <div className="flex h-full min-h-0 flex-col">
            <div className="shrink-0 border-b border-orange-100 bg-white px-4 py-3 sm:px-6 sm:py-5 dark:border-blue-950/60 dark:bg-[#0d1117]">
              <h1 className="text-base font-semibold tracking-tight text-zinc-900 sm:text-xl dark:text-white">
                Simple Wall
              </h1>
              <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-500">
                Company-wide social feed — comment and react to posts from your team.
              </p>
            </div>
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
    <div className="flex h-dvh max-h-dvh overflow-hidden bg-white font-sans text-zinc-900 selection:bg-orange-500/20 selection:text-orange-900 dark:bg-[#0d1117] dark:text-zinc-100 dark:selection:bg-orange-500/30 dark:selection:text-orange-200">
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
        <AnimatePresence mode="wait">
          <motion.div
            key={activeTab}
            role="presentation"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
          >
            {renderContent()}
          </motion.div>
        </AnimatePresence>
      </main>
      <Toaster position="top-right" theme={isDark ? 'dark' : 'light'} />
    </div>
  );
}

function EmployeeAnnouncementsTab({
  employeeEmail,
  department,
}: {
  employeeEmail: string | null;
  department: string | null;
}) {
  const scope: string[] = department ? [department] : [];
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-[#ececec] bg-white px-4 py-3 sm:px-6 sm:py-5 dark:border-zinc-800 dark:bg-zinc-950">
        <h1 className="text-base font-semibold tracking-tight text-zinc-900 sm:text-xl dark:text-white">
          Announcements
        </h1>
        <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-500">
          Company-wide and team updates. New posts appear live.
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto bg-[#fafaf8] px-3 py-4 sm:px-6 sm:py-6 dark:bg-[#0d1117]">
        <div className="mx-auto max-w-2xl">
          <AnnouncementWall scope={scope} viewerEmail={employeeEmail} />
        </div>
      </div>
    </div>
  );
}
