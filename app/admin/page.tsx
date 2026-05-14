'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import AdminSidebar from '@/components/admin/AdminSidebar';
import AdminOverview from '@/components/admin/AdminOverview';
import AdminRoles from '@/components/admin/AdminRoles';
import AdminEmployees from '@/components/admin/AdminEmployees';
import AdminWebhooks from '@/components/admin/AdminWebhooks';
import AdminCsvImports from '@/components/admin/AdminCsvImports';
import AuditLogPanel from '@/components/audit/AuditLogPanel';
import SystemDiagnostics from '@/components/SystemDiagnostics';
import { Construction, Menu } from 'lucide-react';
import NotificationsPanel from '@/components/notifications/NotificationsPanel';
import { Button } from '@/components/ui/button';
import { normEmail } from '@/lib/email/norm-email';
import { SESSION_EMAIL_KEY } from '@/lib/rbac/views';
import { cn } from '@/lib/utils';

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

interface WebhookEntry {
  slug: string;
  url: string;
  active: boolean;
}

function AdminPageInner() {
  const [activeTab, setActiveTab] = useState('overview');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [adminEmail, setAdminEmail] = useState<string | null>(null);
  const [navCounts, setNavCounts] = useState({
    roles: 0,
    employees: 0,
    webhookAlert: 0,
  });
  const searchParams = useSearchParams();
  const emailFromQuery = searchParams?.get('email') ?? null;

  useEffect(() => {
    try {
      const q = emailFromQuery?.trim() ?? '';
      if (q && isPlausibleEmail(q)) {
        const normalized = normEmail(q) ?? q.toLowerCase();
        sessionStorage.setItem(SESSION_EMAIL_KEY, normalized);
        setAdminEmail(normalized);
        return;
      }
      setAdminEmail(sessionStorage.getItem(SESSION_EMAIL_KEY));
    } catch {
      setAdminEmail(null);
    }
  }, [emailFromQuery]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [empRes, rolesRes, hookRes] = await Promise.all([
          fetch('/api/employees', { cache: 'no-store' }),
          fetch('/api/employee-roles', { cache: 'no-store' }),
          fetch('/api/app-settings?key=webhooks.config', { cache: 'no-store' }),
        ]);
        const empJson = (await empRes.json()) as { employees?: unknown[] };
        const rolesJson = (await rolesRes.json()) as { rows?: unknown[] };
        const hookJson = (await hookRes.json()) as { value: string | null };
        let hooks: WebhookEntry[] = [];
        if (hookJson.value) {
          try {
            const raw = JSON.parse(hookJson.value) as WebhookEntry[];
            hooks = Array.isArray(raw) ? raw : [];
          } catch {
            hooks = [];
          }
        }
        const webhookAlert = hooks.filter((w) => w.active && !String(w.url ?? '').trim()).length;
        if (!cancelled) {
          setNavCounts({
            employees: (empJson.employees ?? []).length,
            roles: (rolesJson.rows ?? []).length,
            webhookAlert,
          });
        }
      } catch {
        if (!cancelled) setNavCounts({ employees: 0, roles: 0, webhookAlert: 0 });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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

  const renderContent = () => {
    switch (activeTab) {
      case 'overview':
        return <AdminOverview userEmail={adminEmail} onNavigate={navigate} />;
      case 'roles':
        return <AdminRoles />;
      case 'employees':
        return (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <AdminEmployees />
          </div>
        );
      case 'webhooks':
        return <AdminWebhooks />;
      case 'csv-imports':
        return (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <AdminCsvImports />
          </div>
        );
      case 'audit':
        return (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <AuditLogPanel className="min-h-0 flex-1" />
          </div>
        );
      case 'diagnostics':
        return (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <SystemDiagnostics />
          </div>
        );
      case 'api-tokens':
        return (
          <Placeholder
            title="API tokens"
            hint="Token management is not wired yet. Use Supabase and server env for service access."
          />
        );
      case 'backups':
        return (
          <Placeholder
            title="Backups"
            hint="Database backups are handled by your hosting provider or Supabase scheduled backups."
          />
        );
      case 'notifications':
        return <NotificationsPanel viewerEmail={adminEmail} accent="zinc" />;
      case 'settings':
        return (
          <Placeholder title="System settings" hint="Global app settings live in the main HRIS Settings tab for now." />
        );
      default:
        return <AdminOverview userEmail={adminEmail} onNavigate={setActiveTab} />;
    }
  };

  return (
    <div
      className={cn(
        'flex h-dvh max-h-dvh w-full overflow-hidden text-zinc-900 dark:text-zinc-100',
        activeTab === 'overview' ? 'bg-zinc-50 dark:bg-zinc-950' : 'bg-white dark:bg-[#0d1117]',
      )}
    >
      {mobileNavOpen && (
        <button
          type="button"
          className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px] md:hidden"
          aria-label="Close navigation menu"
          onClick={() => setMobileNavOpen(false)}
        />
      )}
      <AdminSidebar
        activeTab={activeTab}
        setActiveTab={navigate}
        mobileOpen={mobileNavOpen}
        viewerEmail={adminEmail}
        counts={navCounts}
      />
      <main className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex shrink-0 items-center gap-3 border-b border-[#ececec] bg-white/95 px-3 py-2.5 backdrop-blur-md supports-[padding:max(0px)]:pt-[max(0.625rem,env(safe-area-inset-top))] dark:border-zinc-800 dark:bg-zinc-950/95 md:hidden">
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="shrink-0 border-[#ececec] bg-[#fafaf8] dark:border-zinc-800 dark:bg-zinc-900"
            onClick={() => setMobileNavOpen(true)}
            aria-expanded={mobileNavOpen}
            aria-controls="admin-sidebar-nav"
            aria-label="Open navigation menu"
          >
            <Menu className="h-5 w-5" />
          </Button>
          <span className="min-w-0 truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            Admin
          </span>
        </header>
        <div
          className={cn(
            'flex min-h-0 min-w-0 flex-1 flex-col',
            activeTab === 'overview' ? 'overflow-hidden' : 'overflow-y-auto',
          )}
        >
          {renderContent()}
        </div>
      </main>
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
