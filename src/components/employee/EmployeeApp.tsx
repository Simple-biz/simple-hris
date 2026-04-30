'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTheme } from 'next-themes';
import { motion, AnimatePresence } from 'motion/react';
import { toast } from 'sonner';
import EmployeeSidebar from './EmployeeSidebar';
import EmployeeDashboard from './EmployeeDashboard';
import EmployeeProfile from './EmployeeProfile';
import EmployeeLeaves from './EmployeeLeaves';
import EmployeeOrphanageVisits from './EmployeeOrphanageVisits';
import EmployeeSettings from './EmployeeSettings';
import MyDisputes from './MyDisputes';
import PayrollLockBanner from './PayrollLockBanner';
import { Toaster } from '@/components/ui/sonner';
import { Clock, Lock, Menu, Unlock } from 'lucide-react';
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
  /**
   * When the user clicks a sub-7h day in the PAB calendar we redirect them to
   * the disputes tab with the date (and Hubstaff seconds) pre-loaded. Cleared
   * by `MyDisputes` once the form has consumed it.
   */
  const [disputesPrefill, setDisputesPrefill] = useState<{ date: string; seconds?: number } | null>(null);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [employeeEmail, setEmployeeEmail] = useState<string | null>(null);
  const [profilePhotoUrl, setProfilePhotoUrl] = useState<string | null>(null);
  const [employeeName, setEmployeeName] = useState<string | null>(null);
  const [employeeDepartment, setEmployeeDepartment] = useState<string | null>(null);
  const [employeeId, setEmployeeId] = useState<string | null>(null);

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

  const emailFromQuery = searchParams.get('email');

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
          fetch('/api/employees', { cache: 'no-store' }),
          fetch('/api/employee-hourly-rates', { cache: 'no-store' }),
        ]);
        const photoJson = (await photoRes.json()) as { profilePhotoUrl?: string | null };
        const empJson = (await empRes.json()) as { employees?: EmployeeRow[] };
        const rateJson = (await rateRes.json()) as { rows?: EmployeeHourlyRateRow[] };
        if (cancelled) return;

        setProfilePhotoUrl(photoJson.profilePhotoUrl?.trim() || null);

        const master = (empJson.employees ?? []).find((e) => {
          const we = normEmail(e.work_email ?? '');
          const pe = normEmail(e.personal_email ?? '');
          return we === norm || pe === norm;
        });
        const rate = (rateJson.rows ?? []).find((r) => {
          const we = normEmail(r.work_email ?? '');
          const pe = normEmail(r.personal_email ?? '');
          return we === norm || pe === norm;
        });

        setEmployeeName(master?.name?.trim() || null);
        setEmployeeDepartment(rate?.department?.trim() || master?.department?.trim() || null);
        setEmployeeId(master?.employee_id?.trim() || null);
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
            onNavigateToDisputes={(prefill) => {
              setDisputesPrefill(prefill ?? null);
              navigate('disputes');
            }}
          />
        );
      case 'profile':
        return (
          <EmployeeProfile
            employeeEmail={employeeEmail}
            profilePhotoUrl={profilePhotoUrl}
            onProfilePhotoUpdated={(url) => setProfilePhotoUrl(url)}
            payrollLocked={lockState.locked}
          />
        );
      case 'hours':
        return (
          <div className="flex min-h-full flex-col items-center justify-center gap-4 bg-gradient-to-br from-white via-orange-50/30 to-blue-50/20 p-8 text-center dark:bg-none dark:bg-[#0d1117]">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-blue-500/10">
              <Clock className="h-8 w-8 text-blue-500" />
            </div>
            <h2 className="text-2xl font-bold text-zinc-900 dark:text-white">My Hours</h2>
            <p className="max-w-md text-sm text-zinc-600 dark:text-zinc-500">
              Detailed hour logs and historical pay period data will be available here.
            </p>
          </div>
        );
      case 'leaves':
        return (
          <EmployeeLeaves
            employeeEmail={employeeEmail}
            employeeName={employeeName ?? undefined}
            department={employeeDepartment ?? undefined}
          />
        );
      case 'disputes':
        return (
          <MyDisputes
            employeeEmail={employeeEmail}
            employeeName={employeeName}
            prefill={disputesPrefill}
            onPrefillConsumed={() => setDisputesPrefill(null)}
            payrollLocked={lockState.locked}
          />
        );
      case 'orphanage-visits':
        return <EmployeeOrphanageVisits employeeEmail={employeeEmail} />;
      case 'settings':
        return <EmployeeSettings employeeEmail={employeeEmail} />;
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
