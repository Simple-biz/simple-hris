"use client";

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTheme } from 'next-themes';
import Sidebar from './components/Sidebar';
import Overview from './components/Overview';
import Rates from './components/Rates';
import PayrollWizard from './components/PayrollWizard';
import { Toaster } from '@/components/ui/sonner';
import SystemSettings from './components/SystemSettings';
import LeaveRequestsPanel from './components/LeaveRequestsPanel';
import PabDisputeQueue from './components/payroll/PabDisputeQueue';
import OrphanageVisits from './components/payroll/OrphanageVisits';
import { normEmail } from '@/lib/email/norm-email';
import { SESSION_EMAIL_KEY } from '@/lib/rbac/views';

function isPlausibleEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

export default function App() {
  const [activeTab, setActiveTab] = useState('overview');
  const [focusRatesEmail, setFocusRatesEmail] = useState<string | null>(null);
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const searchParams = useSearchParams();
  const emailFromQuery = searchParams.get('email');

  const handleViewRates = (email: string) => {
    setFocusRatesEmail(email);
    setActiveTab('rates');
  };

  useEffect(() => {
    setMounted(true);
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

  const isDark = mounted ? resolvedTheme === 'dark' : false;

  const renderContent = () => {
    switch (activeTab) {
      case 'overview':
        return <Overview onViewRates={handleViewRates} />;
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
      case 'disputes':
        return <PabDisputeQueue />;
      case 'orphanage-visits':
        return <OrphanageVisits />;
      case 'settings':
        return <SystemSettings />;
      case 'leave-requests':
        return <LeaveRequestsPanel />;
      default:
        return <Overview />;
    }
  };

  return (
    <div className="flex h-screen bg-white font-sans text-zinc-900 selection:bg-orange-500/20 selection:text-orange-900 dark:bg-[#0d1117] dark:text-zinc-100 dark:selection:bg-orange-500/30 dark:selection:text-orange-200">
      <Sidebar activeTab={activeTab} setActiveTab={setActiveTab} />
      <main className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden">
        {renderContent()}
      </main>
      <Toaster position="top-right" theme={isDark ? 'dark' : 'light'} />
    </div>
  );
}

