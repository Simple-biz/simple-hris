'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import AdminSidebar from '@/components/admin/AdminSidebar';
import AdminRoles from '@/components/admin/AdminRoles';
import AdminWebhooks from '@/components/admin/AdminWebhooks';
import AuditLogPanel from '@/components/audit/AuditLogPanel';
import { Toaster } from '@/components/ui/sonner';
import { Construction } from 'lucide-react';
import { normEmail } from '@/lib/email/norm-email';
import { SESSION_EMAIL_KEY } from '@/lib/rbac/views';

function isPlausibleEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

function AdminShellFallback() {
  return (
    <div className="flex h-screen items-center justify-center bg-white dark:bg-[#0d1117]">
      <div
        className="h-8 w-8 animate-spin rounded-full border-2 border-orange-500 border-t-transparent"
        aria-hidden
      />
    </div>
  );
}

function AdminPageInner() {
  const [activeTab, setActiveTab] = useState('roles');
  const searchParams = useSearchParams();
  const emailFromQuery = searchParams.get('email');

  useEffect(() => {
    try {
      const q = emailFromQuery?.trim() ?? '';
      if (q && isPlausibleEmail(q)) {
        const normalized = normEmail(q) ?? q.toLowerCase();
        sessionStorage.setItem(SESSION_EMAIL_KEY, normalized);
      }
    } catch {
      /* ignore */
    }
  }, [emailFromQuery]);

  const renderContent = () => {
    switch (activeTab) {
      case 'roles':
        return <AdminRoles />;
      case 'employees':
        return <Placeholder title="Employees" hint="Manage employees from the Rates page for now." />;
      case 'webhooks':
        return <AdminWebhooks />;
      case 'audit':
        return (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <AuditLogPanel className="min-h-0 flex-1" />
          </div>
        );
      default:
        return <AdminRoles />;
    }
  };

  return (
    <div className="flex h-screen w-full bg-white text-zinc-900 dark:bg-[#0d1117] dark:text-zinc-100">
      <AdminSidebar activeTab={activeTab} setActiveTab={setActiveTab} />
      <main className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden">
        {renderContent()}
      </main>
      <Toaster position="top-right" />
    </div>
  );
}

export default function AdminPage() {
  return (
    <Suspense fallback={<AdminShellFallback />}>
      <AdminPageInner />
    </Suspense>
  );
}

function Placeholder({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-amber-500/10">
        <Construction className="h-7 w-7 text-amber-500" />
      </div>
      <h2 className="text-2xl font-bold text-zinc-900 dark:text-white">{title}</h2>
      <p className="max-w-md text-sm text-zinc-500 dark:text-zinc-400">{hint}</p>
    </div>
  );
}
