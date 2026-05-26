'use client';

import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { FileText, DollarSign, ArrowRight, Loader2, Receipt, CheckCircle2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatMoney, normalizeCurrency, sumByCurrency, formatGrouped } from '@/lib/contractor-currency';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

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
  currency: string | null;
  created_at: string;
}

// ─── StatTile ─────────────────────────────────────────────────────────────────

function StatTile({
  label,
  value,
  hint,
  icon: Icon,
  iconBg,
  iconColor,
  onClick,
}: {
  label: string;
  value: string;
  hint: string;
  icon: React.ComponentType<{ className?: string }>;
  iconBg: string;
  iconColor: string;
  onClick?: () => void;
}) {
  const Wrapper = onClick ? 'button' : 'div';
  return (
    <Wrapper
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={cn(
        'group flex items-center gap-4 rounded-xl border border-zinc-200 bg-white px-5 py-4 text-left shadow-sm transition-all dark:border-zinc-800 dark:bg-zinc-900',
        onClick && 'cursor-pointer hover:-translate-y-0.5 hover:border-zinc-300 hover:shadow-md dark:hover:border-zinc-700',
      )}
    >
      <div className={cn('flex h-11 w-11 shrink-0 items-center justify-center rounded-xl', iconBg)}>
        <Icon className={cn('h-5 w-5', iconColor)} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">{label}</p>
        <p className="mt-0.5 text-2xl font-bold tabular-nums text-zinc-900 dark:text-white">{value}</p>
        <p className="mt-0.5 text-[11px] text-zinc-400 dark:text-zinc-500">{hint}</p>
      </div>
      {onClick && (
        <ArrowRight className="h-4 w-4 shrink-0 text-zinc-300 transition-transform group-hover:translate-x-0.5 dark:text-zinc-600" />
      )}
    </Wrapper>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function ContractorOverview({ contractorEmail, onNavigate }: ContractorOverviewProps) {
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!contractorEmail) return;
    let cancelled = false;
    setLoading(true);
    fetch(`/api/contractor/invoices?email=${encodeURIComponent(contractorEmail)}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((j: { invoices?: InvoiceRow[] }) => {
        if (cancelled) return;
        setInvoices(j.invoices ?? []);
      })
      .catch(() => { if (!cancelled) setInvoices([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [contractorEmail]);

  const invoiceCount = invoices.length;
  const billedByCurrency = sumByCurrency(invoices);

  const firstName = contractorEmail.split('@')[0]
    .replace(/[._-]/g, ' ')
    .split(' ')[0];
  const displayName = firstName.charAt(0).toUpperCase() + firstName.slice(1);

  const hour = new Date().getHours();
  const timeGreeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  return (
    <div className="flex flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">

      {/* ── Greeting ── */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
        className="rounded-2xl border border-zinc-200 bg-white px-6 py-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
      >
        <div className="flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-widest text-zinc-400 dark:text-zinc-500">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" />
          Contractor portal
        </div>
        <h1 className="mt-1.5 text-xl font-bold tracking-tight text-zinc-900 dark:text-white sm:text-2xl">
          {timeGreeting}, {displayName}.
        </h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Here's your contractor portal at a glance.
        </p>
      </motion.div>

      {/* ── Stat tiles ── */}
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-zinc-400">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading…
        </div>
      ) : (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1], delay: 0.05 }}
          className="grid gap-3 sm:grid-cols-2"
        >
          <StatTile
            icon={FileText}
            label="Invoices submitted"
            value={String(invoiceCount)}
            hint={invoiceCount === 1 ? '1 invoice on record' : `${invoiceCount} invoices on record`}
            iconBg="bg-violet-100 dark:bg-violet-950/50"
            iconColor="text-violet-600 dark:text-violet-400"
            onClick={() => onNavigate('invoices')}
          />
          <StatTile
            icon={DollarSign}
            label="Total billed"
            value={formatGrouped(billedByCurrency)}
            hint="Sum of all invoice totals"
            iconBg="bg-emerald-100 dark:bg-emerald-950/50"
            iconColor="text-emerald-600 dark:text-emerald-400"
          />
        </motion.div>
      )}

      {/* ── Submit invoice card ── */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1], delay: 0.1 }}
      >
        <Card className="border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <CardHeader className="flex-row items-center gap-3 space-y-0 pb-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-amber-100 dark:bg-amber-950/50">
              <Receipt className="h-4 w-4 text-amber-600 dark:text-amber-400" />
            </div>
            <div className="flex-1">
              <CardTitle className="text-sm">Submit an invoice</CardTitle>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                Send a new invoice to accounting for review.
              </p>
            </div>
            <Button
              size="sm"
              className="bg-zinc-900 text-white hover:bg-zinc-700 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
              onClick={() => onNavigate('invoices')}
            >
              New invoice
            </Button>
          </CardHeader>
          <CardContent className="grid gap-2 text-xs text-zinc-500 sm:grid-cols-2 dark:text-zinc-400">
            {[
              'Auto-generated invoice number',
              'Line items with qty, rate, and tax',
              'Logo and entity name from your profile',
              'Sent directly to accounting as pending',
            ].map((text) => (
              <div key={text} className="flex items-center gap-2">
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                <span>{text}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      </motion.div>

      {/* ── Recent invoices ── */}
      {!loading && invoices.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1], delay: 0.15 }}
        >
          <Card className="border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
            <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm">Recent invoices</CardTitle>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 gap-1 px-2 text-xs text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white"
                onClick={() => onNavigate('invoices')}
              >
                View all
                <ArrowRight className="h-3 w-3" />
              </Button>
            </CardHeader>
            <CardContent className="pt-0">
              <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {invoices.slice(0, 4).map((inv) => (
                  <div key={inv.id} className="flex items-center justify-between py-2.5">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-zinc-900 dark:text-white">
                        {inv.invoice_number || '—'}
                      </p>
                      <p className="truncate text-xs text-zinc-400 dark:text-zinc-500">
                        {inv.to_company || 'No client'} · {inv.invoice_date || '—'}
                      </p>
                    </div>
                    <span className="ml-4 shrink-0 text-sm font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
                      {formatMoney(inv.total ?? 0, normalizeCurrency(inv.currency))}
                    </span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </motion.div>
      )}

    </div>
  );
}
