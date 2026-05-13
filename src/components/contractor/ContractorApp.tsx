'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTheme } from 'next-themes';
import { useSession } from 'next-auth/react';
import { motion, AnimatePresence } from 'motion/react';
import { Menu } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Toaster } from '@/components/ui/sonner';
import ContractorSidebar from './ContractorSidebar';
import ContractorOverview from './ContractorOverview';
import ContractorInvoices from './ContractorInvoices';
import ContractorProfile from './ContractorProfile';
import { normEmail } from '@/lib/email/norm-email';
import type { EmployeeRow } from '@/lib/supabase/employees';

const SESSION_KEY = 'contractor_session_email';

function isPlausibleEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

/**
 * Contractor-facing app shell — rendered at /contractor.
 * Identity comes from `?email=` (synced to sessionStorage) when present; otherwise
 * sessionStorage set at login. Without either, redirects to /login.
 */
export default function ContractorApp() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [activeTab, setActiveTab] = useState('overview');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [contractorEmail, setContractorEmail] = useState<string | null>(null);
  const [profilePhotoUrl, setProfilePhotoUrl] = useState<string | null>(null);
  const [contractorName, setContractorName] = useState<string | null>(null);

  const { data: session } = useSession();
  const googlePhotoUrl = useMemo(() => {
    const sessionEmail = session?.user?.email?.trim().toLowerCase();
    const sessionImage = session?.user?.image?.trim();
    if (!sessionEmail || !sessionImage) return null;
    const subjectEmail = (normEmail(contractorEmail ?? '') ?? contractorEmail?.trim().toLowerCase()) || null;
    if (!subjectEmail) return null;
    return sessionEmail === subjectEmail ? sessionImage : null;
  }, [session?.user?.email, session?.user?.image, contractorEmail]);

  const emailFromQuery = searchParams?.get('email') ?? null;

  useEffect(() => {
    setMounted(true);
    try {
      const q = emailFromQuery?.trim() ?? '';
      if (q && isPlausibleEmail(q)) {
        const normalized = normEmail(q) ?? q.toLowerCase();
        sessionStorage.setItem(SESSION_KEY, normalized);
        setContractorEmail(normalized);
        return;
      }
      const stored = sessionStorage.getItem(SESSION_KEY);
      if (stored) {
        setContractorEmail(stored);
      } else {
        router.replace('/login');
      }
    } catch {
      router.replace('/login');
    }
  }, [router, emailFromQuery]);

  // Fetch contractor name and profile photo
  useEffect(() => {
    if (!contractorEmail) {
      setProfilePhotoUrl(null);
      setContractorName(null);
      return;
    }
    const norm = normEmail(contractorEmail) ?? contractorEmail.toLowerCase();
    let cancelled = false;
    (async () => {
      try {
        const [photoRes, empRes] = await Promise.all([
          fetch(`/api/employee-profile-photo?email=${encodeURIComponent(contractorEmail)}`, { cache: 'no-store' }),
          fetch('/api/employees', { cache: 'no-store' }),
        ]);
        const photoJson = (await photoRes.json()) as { profilePhotoUrl?: string | null };
        const empJson = (await empRes.json()) as { employees?: EmployeeRow[] };
        if (cancelled) return;

        setProfilePhotoUrl(photoJson.profilePhotoUrl?.trim() || null);

        let master = (empJson.employees ?? []).find((e) => {
          const we = normEmail(e.work_email ?? '');
          const pe = normEmail(e.personal_email ?? '');
          return we === norm || pe === norm;
        }) ?? null;

        if (!master) {
          try {
            const mrRes = await fetch(
              `/api/employee-master-record?email=${encodeURIComponent(contractorEmail)}`,
              { cache: 'no-store' },
            );
            const mrJson = (await mrRes.json()) as { employee?: EmployeeRow | null };
            master = mrJson.employee ?? null;
          } catch { /* ignore */ }
        }

        if (cancelled) return;
        setContractorName(master?.name?.trim() || null);
      } catch {
        if (!cancelled) setProfilePhotoUrl(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [contractorEmail]);

  const isDark = mounted ? resolvedTheme === 'dark' : false;

  const navigate = (tab: string) => {
    setActiveTab(tab);
    setMobileNavOpen(false);
  };

  // Close on Escape
  useEffect(() => {
    if (!mobileNavOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMobileNavOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mobileNavOpen]);

  // Lock body scroll on mobile drawer
  useEffect(() => {
    if (!mobileNavOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [mobileNavOpen]);

  if (!contractorEmail) return null;

  const displayName =
    contractorName ||
    contractorEmail?.split('@')[0]?.replace(/\./g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) ||
    'Contractor';

  const renderContent = () => {
    if (!contractorEmail) return null;
    switch (activeTab) {
      case 'overview':
        return (
          <ContractorOverview
            contractorEmail={contractorEmail}
            onNavigate={navigate}
          />
        );
      case 'invoices':
        return <ContractorInvoices contractorEmail={contractorEmail} />;
      case 'profile':
        return <ContractorProfile contractorEmail={contractorEmail} />;
      default:
        return (
          <ContractorOverview
            contractorEmail={contractorEmail}
            onNavigate={navigate}
          />
        );
    }
  };

  return (
    <div className="flex h-dvh max-h-dvh overflow-hidden bg-white font-sans text-zinc-900 selection:bg-blue-500/20 selection:text-blue-900 dark:bg-[#0d1117] dark:text-zinc-100 dark:selection:bg-blue-500/30 dark:selection:text-blue-200">
      {/* Mobile backdrop */}
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

      <ContractorSidebar
        activeTab={activeTab}
        setActiveTab={navigate}
        mobileOpen={mobileNavOpen}
        contractorName={displayName}
        contractorEmail={contractorEmail}
        profilePhotoUrl={profilePhotoUrl}
        googlePhotoUrl={googlePhotoUrl}
      />

      <main className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {/* Mobile header */}
        <header className="flex shrink-0 items-center gap-3 border-b border-blue-100 bg-white/95 px-3 py-2.5 backdrop-blur-md supports-[padding:max(0px)]:pt-[max(0.625rem,env(safe-area-inset-top))] dark:border-blue-950/60 dark:bg-[#0d1117]/95 md:hidden">
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="shrink-0 border-blue-200/80 bg-white/80 dark:border-blue-950/60 dark:bg-blue-950/30"
            onClick={() => setMobileNavOpen(true)}
            aria-expanded={mobileNavOpen}
            aria-controls="contractor-sidebar-nav"
            aria-label="Open navigation menu"
          >
            <Menu className="h-5 w-5" />
          </Button>
          <span className="min-w-0 truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            Contractor
          </span>
        </header>

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
