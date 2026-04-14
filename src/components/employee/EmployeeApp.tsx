'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTheme } from 'next-themes';
import { motion, AnimatePresence } from 'motion/react';
import EmployeeSidebar from './EmployeeSidebar';
import EmployeeDashboard from './EmployeeDashboard';
import EmployeeProfile from './EmployeeProfile';
import EmployeeLeaves from './EmployeeLeaves';
import EmployeeSettings from './EmployeeSettings';
import { Toaster } from '@/components/ui/sonner';
import { FileText, Clock } from 'lucide-react';
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
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [employeeEmail, setEmployeeEmail] = useState<string | null>(null);
  const [profilePhotoUrl, setProfilePhotoUrl] = useState<string | null>(null);
  const [employeeName, setEmployeeName] = useState<string | null>(null);
  const [employeeDepartment, setEmployeeDepartment] = useState<string | null>(null);
  const [employeeId, setEmployeeId] = useState<string | null>(null);

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

  if (!employeeEmail) return null;

  const renderContent = () => {
    if (!employeeEmail) return null;

    switch (activeTab) {
      case 'dashboard':
        return <EmployeeDashboard employeeEmail={employeeEmail} />;
      case 'profile':
        return (
          <EmployeeProfile
            employeeEmail={employeeEmail}
            profilePhotoUrl={profilePhotoUrl}
            onProfilePhotoUpdated={(url) => setProfilePhotoUrl(url)}
            onNavigateToSettings={() => setActiveTab('settings')}
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
          <div className="flex min-h-full flex-col items-center justify-center gap-4 bg-gradient-to-br from-white via-orange-50/30 to-blue-50/20 p-8 text-center dark:bg-none dark:bg-[#0d1117]">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-red-500/10">
              <FileText className="h-8 w-8 text-red-500" />
            </div>
            <h2 className="text-2xl font-bold text-zinc-900 dark:text-white">My Disputes</h2>
            <p className="max-w-md text-sm text-zinc-600 dark:text-zinc-500">
              File and track hour disputes here. Your manager will be notified and can approve adjustments.
            </p>
          </div>
        );
      case 'settings':
        return <EmployeeSettings employeeEmail={employeeEmail} />;
      default:
        return <EmployeeDashboard employeeEmail={employeeEmail} />;
    }
  };

  return (
    <div className="flex h-screen bg-white font-sans text-zinc-900 selection:bg-orange-500/20 selection:text-orange-900 dark:bg-[#0d1117] dark:text-zinc-100 dark:selection:bg-orange-500/30 dark:selection:text-orange-200">
      <EmployeeSidebar
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        employeeName={employeeName || employeeEmail?.split('@')[0]?.replace(/\./g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) || 'Employee'}
        department={employeeDepartment || undefined}
        employeeId={employeeId || undefined}
        employeeEmail={employeeEmail}
        profilePhotoUrl={profilePhotoUrl}
      />
      <main className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden">
        <AnimatePresence mode="wait">
          <motion.div
            key={activeTab}
            role="presentation"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            className="flex h-full min-h-0 flex-1 flex-col overflow-hidden"
          >
            {renderContent()}
          </motion.div>
        </AnimatePresence>
      </main>
      <Toaster position="top-right" theme={isDark ? 'dark' : 'light'} />
    </div>
  );
}
