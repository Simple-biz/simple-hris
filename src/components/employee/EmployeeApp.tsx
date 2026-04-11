'use client';

import { useEffect, useState } from 'react';
import { useTheme } from 'next-themes';
import EmployeeSidebar from './EmployeeSidebar';
import EmployeeDashboard from './EmployeeDashboard';
import EmployeeProfile from './EmployeeProfile';
import EmployeeSettings from './EmployeeSettings';
import { Toaster } from '@/components/ui/sonner';
import { AlertCircle, FileText, Clock, Settings } from 'lucide-react';
import { normEmail } from '@/lib/email/norm-email';
import type { EmployeeRow } from '@/lib/supabase/employees';
import type { EmployeeHourlyRateRow } from '@/lib/supabase/employee-hourly-rates';

/**
 * Employee-facing app shell — rendered at /employee.
 *
 * For now, the employee email is read from a query param (?email=xxx)
 * so you can demo any employee. Once Supabase Auth is wired up,
 * this will be replaced by the logged-in user's email.
 */
export default function EmployeeApp() {
  const [activeTab, setActiveTab] = useState('dashboard');
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [employeeEmail, setEmployeeEmail] = useState<string | null>(null);
  const [profilePhotoUrl, setProfilePhotoUrl] = useState<string | null>(null);
  const [employeeName, setEmployeeName] = useState<string | null>(null);
  const [employeeDepartment, setEmployeeDepartment] = useState<string | null>(null);
  const [employeeId, setEmployeeId] = useState<string | null>(null);

  useEffect(() => {
    setMounted(true);
    const params = new URLSearchParams(window.location.search);
    setEmployeeEmail(params.get('email'));
  }, []);

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

  const renderContent = () => {
    if (!employeeEmail) {
      return (
        <div className="flex min-h-full flex-col items-center justify-center gap-4 bg-gradient-to-br from-white via-orange-50/30 to-blue-50/20 p-8 text-center dark:bg-none dark:bg-[#0d1117]">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-amber-500/10">
            <AlertCircle className="h-8 w-8 text-amber-500" />
          </div>
          <h2 className="text-2xl font-bold text-zinc-900 dark:text-white">
            Employee Dashboard
          </h2>
          <p className="max-w-md text-sm text-zinc-600 dark:text-zinc-500">
            Add your work email as a query parameter to view your dashboard.
          </p>
          <code className="rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-2 font-mono text-sm text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
            /employee?email=your.email@company.com
          </code>
        </div>
      );
    }

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
        {renderContent()}
      </main>
      <Toaster position="top-right" theme={isDark ? 'dark' : 'light'} />
    </div>
  );
}
