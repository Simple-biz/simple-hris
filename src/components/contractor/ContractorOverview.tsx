'use client';

import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { FileText, DollarSign, ArrowRight, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

interface ContractorOverviewProps {
  contractorEmail: string;
  onNavigate: (tab: string) => void;
}

interface InvoiceRow {
  id: string;
  invoice_number: string;
  invoice_date: string;
  due_date: string;
  to_company: string;
  total: number;
  subtotal: number;
  tax_total: number;
  created_at: string;
}

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  delay,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  sub?: string;
  delay: number;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1], delay }}
      className="flex flex-col gap-3 rounded-xl border border-blue-100 bg-white p-5 shadow-sm dark:border-blue-950/60 dark:bg-blue-950/10"
    >
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-100 dark:bg-blue-950/50">
          <Icon className="h-4 w-4 text-blue-600 dark:text-blue-400" />
        </div>
        <span className="text-sm font-medium text-zinc-600 dark:text-zinc-400">{label}</span>
      </div>
      <div>
        <p className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-white">{value}</p>
        {sub && <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-500">{sub}</p>}
      </div>
    </motion.div>
  );
}

export default function ContractorOverview({ contractorEmail, onNavigate }: ContractorOverviewProps) {
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!contractorEmail) return;
    let cancelled = false;
    setLoading(true);
    fetch(`/api/contractor/invoices?email=${encodeURIComponent(contractorEmail)}`, {
      cache: 'no-store',
    })
      .then((r) => r.json())
      .then((j: { invoices?: InvoiceRow[] }) => {
        if (cancelled) return;
        setInvoices(j.invoices ?? []);
      })
      .catch(() => {
        if (!cancelled) setInvoices([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [contractorEmail]);

  const invoiceCount = invoices.length;
  const totalBilled = invoices.reduce((sum, inv) => sum + (inv.total ?? 0), 0);

  const displayName = contractorEmail
    ? contractorEmail.split('@')[0].replace(/\./g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
    : 'Contractor';

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="shrink-0 border-b border-blue-100 bg-white px-4 py-3 sm:px-6 sm:py-5 dark:border-blue-950/60 dark:bg-[#0d1117]">
        <h1 className="text-base font-semibold tracking-tight text-zinc-900 sm:text-xl dark:text-white">
          Overview
        </h1>
        <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-500">
          Your contractor dashboard at a glance.
        </p>
      </div>

      {/* Content */}
      <div className="min-h-0 flex-1 overflow-y-auto bg-[#f8faff] px-4 py-6 sm:px-6 dark:bg-[#0d1117]">
        <div className="mx-auto max-w-2xl space-y-6">
          {/* Greeting */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
          >
            <h2 className="text-lg font-semibold text-zinc-900 dark:text-white">
              {greeting}, {displayName} 👋
            </h2>
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
              Welcome to your contractor portal. Track your invoices and billing history here.
            </p>
          </motion.div>

          {/* Stat Cards */}
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading stats…
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <StatCard
                icon={FileText}
                label="Invoices Created"
                value={String(invoiceCount)}
                sub={invoiceCount === 1 ? '1 invoice on record' : `${invoiceCount} invoices on record`}
                delay={0.04}
              />
              <StatCard
                icon={DollarSign}
                label="Total Billed"
                value={
                  totalBilled === 0
                    ? '₱0.00'
                    : `₱${totalBilled.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                }
                sub="Sum of all invoice totals"
                delay={0.1}
              />
            </div>
          )}

          {/* Navigation hint */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1], delay: 0.18 }}
            className="rounded-xl border border-blue-100 bg-blue-50/60 p-4 dark:border-blue-950/60 dark:bg-blue-950/20"
          >
            <div className="flex items-start gap-3">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-100 dark:bg-blue-950/50">
                <FileText className="h-4 w-4 text-blue-600 dark:text-blue-400" />
              </div>
              <div className="flex-1">
                <p className="text-sm font-medium text-zinc-900 dark:text-white">
                  Manage your invoices
                </p>
                <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                  Use the Invoices tab to create and manage your invoices. You can create new invoices, view your history, and track billing.
                </p>
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-2 h-7 gap-1.5 px-2 text-blue-600 hover:bg-blue-100 hover:text-blue-700 dark:text-blue-400 dark:hover:bg-blue-950/40 dark:hover:text-blue-300"
                  onClick={() => onNavigate('invoices')}
                >
                  Go to Invoices
                  <ArrowRight className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          </motion.div>

          {/* Recent invoices preview */}
          {!loading && invoices.length > 0 && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1], delay: 0.22 }}
              className="rounded-xl border border-zinc-100 bg-white shadow-sm dark:border-blue-950/60 dark:bg-blue-950/10"
            >
              <div className="flex items-center justify-between border-b border-zinc-100 px-4 py-3 dark:border-blue-950/60">
                <h3 className="text-sm font-semibold text-zinc-900 dark:text-white">Recent Invoices</h3>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 gap-1 px-2 text-xs text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
                  onClick={() => onNavigate('invoices')}
                >
                  View all
                  <ArrowRight className="h-3 w-3" />
                </Button>
              </div>
              <div className="divide-y divide-zinc-100 dark:divide-blue-950/40">
                {invoices.slice(0, 3).map((inv) => (
                  <div key={inv.id} className="flex items-center justify-between px-4 py-2.5">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-zinc-900 dark:text-white">
                        {inv.invoice_number || '—'}
                      </p>
                      <p className="truncate text-xs text-zinc-500 dark:text-zinc-500">
                        {inv.to_company || 'No client'} · {inv.invoice_date || '—'}
                      </p>
                    </div>
                    <span className="ml-4 shrink-0 text-sm font-semibold text-blue-600 dark:text-blue-400">
                      ₱{(inv.total ?? 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                  </div>
                ))}
              </div>
            </motion.div>
          )}
        </div>
      </div>
    </div>
  );
}
