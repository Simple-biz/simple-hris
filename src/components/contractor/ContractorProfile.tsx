'use client';

import { useEffect, useState } from 'react';
import { Loader2, Save, User, CreditCard, Check } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { normEmail } from '@/lib/email/norm-email';
import {
  PROCESSOR_OPTIONS,
  isProcessorId,
  processorDescription,
  type ProcessorId,
} from '@/lib/employee-payment-processors';
import {
  emptyPayout,
  PayoutDetailsFields,
  type PayoutFields,
} from '@/components/employee/employee-payout-fields';

interface ContractorProfileRow {
  contractor_email?: string | null;
  display_name?: string | null;
  preferred_processor?: string | null;
  preferred_bank_slot?: string | null;
  hurupay_email?: string | null;
  wepay_email?: string | null;
  higlobe_email?: string | null;
  higlobe_account_name?: string | null;
  wise_email?: string | null;
  wise_tag?: string | null;
  phone_number?: string | null;
  full_address?: string | null;
  bank_name?: string | null;
  account_holder_name?: string | null;
  account_number?: string | null;
  swift_code?: string | null;
  alt_bank_name?: string | null;
  alt_account_holder_name?: string | null;
  alt_account_number?: string | null;
  alt_routing_number?: string | null;
}

export default function ContractorProfile({
  contractorEmail,
}: {
  contractorEmail: string;
}) {
  const norm = normEmail(contractorEmail) ?? contractorEmail.toLowerCase();

  const [displayName, setDisplayName] = useState('');
  const [preferredProcessor, setPreferredProcessor] = useState<ProcessorId | ''>('');
  const [payout, setPayout] = useState<PayoutFields>(emptyPayout);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!contractorEmail) return;
    setLoading(true);
    fetch(`/api/contractor/profile?email=${encodeURIComponent(norm)}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((j: { profile?: ContractorProfileRow | null }) => {
        const row = j.profile;
        if (!row) return;
        setDisplayName(row.display_name?.trim() || '');
        if (row.preferred_processor && isProcessorId(row.preferred_processor)) {
          setPreferredProcessor(row.preferred_processor);
        }
        setPayout({
          preferredBankSlot:
            row.preferred_bank_slot === 'alternative' ? 'alternative' : 'primary',
          hurupayEmail: row.hurupay_email ?? '',
          wepayEmail: row.wepay_email ?? '',
          higlobeEmail: row.higlobe_email ?? '',
          higlobeAccountName: row.higlobe_account_name ?? '',
          wiseEmail: row.wise_email ?? '',
          wiseTag: row.wise_tag ?? '',
          phoneNumber: row.phone_number ?? '',
          fullAddress: row.full_address ?? '',
          bankName: row.bank_name ?? '',
          accountHolderName: row.account_holder_name ?? '',
          accountNumber: row.account_number ?? '',
          swiftCode: row.swift_code ?? '',
          altBankName: row.alt_bank_name ?? '',
          altAccountHolderName: row.alt_account_holder_name ?? '',
          altAccountNumber: row.alt_account_number ?? '',
          altSwiftCode: row.alt_routing_number ?? '',
        });
      })
      .catch(() => {/* ignore */})
      .finally(() => setLoading(false));
  }, [contractorEmail, norm]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/contractor/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contractor_email:        norm,
          display_name:            displayName.trim() || null,
          preferred_processor:     preferredProcessor || null,
          preferred_bank_slot:     payout.preferredBankSlot || null,
          hurupay_email:           payout.hurupayEmail || null,
          wepay_email:             payout.wepayEmail || null,
          higlobe_email:           payout.higlobeEmail || null,
          higlobe_account_name:    payout.higlobeAccountName || null,
          wise_email:              payout.wiseEmail || null,
          wise_tag:                payout.wiseTag || null,
          phone_number:            payout.phoneNumber || null,
          full_address:            payout.fullAddress || null,
          bank_name:               payout.bankName || null,
          account_holder_name:     payout.accountHolderName || null,
          account_number:          payout.accountNumber || null,
          swift_code:              payout.swiftCode || null,
          alt_bank_name:           payout.altBankName || null,
          alt_account_holder_name: payout.altAccountHolderName || null,
          alt_account_number:      payout.altAccountNumber || null,
          alt_routing_number:      payout.altSwiftCode || null,
        }),
      });
      const json = (await res.json()) as { error?: string | null; success?: boolean };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Save failed');
      toast.success('Profile saved');
    } catch (err) {
      toast.error('Save failed', { description: err instanceof Error ? err.message : String(err) });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-blue-500" />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="shrink-0 border-b border-blue-100 bg-white px-4 py-3 sm:px-6 sm:py-5 dark:border-blue-950/60 dark:bg-[#0d1117]">
        <h1 className="text-base font-semibold tracking-tight text-zinc-900 sm:text-xl dark:text-white">
          Profile
        </h1>
        <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-500">
          Set your display name and preferred payment method.
        </p>
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-y-auto bg-[#fafaf8] px-4 py-6 sm:px-6 dark:bg-[#0d1117]">
        <div className="mx-auto max-w-lg space-y-6">

          {/* Identity */}
          <section className="rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900/60">
            <div className="mb-4 flex items-center gap-2">
              <User className="h-4 w-4 text-blue-500" />
              <h2 className="text-sm font-semibold text-zinc-900 dark:text-white">Identity</h2>
            </div>
            <div className="space-y-3">
              <div>
                <Label className="mb-1.5 block text-xs text-zinc-600 dark:text-zinc-400">
                  Display name
                </Label>
                <Input
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="Your full name"
                  className="dark:border-zinc-700 dark:bg-zinc-900"
                />
              </div>
              <div>
                <Label className="mb-1.5 block text-xs text-zinc-600 dark:text-zinc-400">
                  Email (read-only)
                </Label>
                <Input
                  value={contractorEmail}
                  readOnly
                  className="cursor-default bg-zinc-50 text-zinc-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-400"
                />
              </div>
            </div>
          </section>

          {/* Payment gateway */}
          <section className="rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900/60">
            <div className="mb-4 flex items-center gap-2">
              <CreditCard className="h-4 w-4 text-blue-500" />
              <h2 className="text-sm font-semibold text-zinc-900 dark:text-white">Payment Gateway</h2>
            </div>

            {/* Processor picker */}
            <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
              {PROCESSOR_OPTIONS.map((opt) => {
                const active = preferredProcessor === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setPreferredProcessor(active ? '' : opt.id)}
                    className={cn(
                      'flex items-center gap-2 rounded-lg border px-3 py-2.5 text-left text-xs font-medium transition-colors',
                      active
                        ? 'border-blue-500/60 bg-blue-50 text-blue-800 dark:border-blue-500/40 dark:bg-blue-950/40 dark:text-blue-200'
                        : 'border-zinc-200 bg-zinc-50 text-zinc-700 hover:border-zinc-300 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-800/50 dark:text-zinc-300 dark:hover:bg-zinc-800',
                    )}
                  >
                    {'logoSrc' in opt && opt.logoSrc ? (
                      <img src={opt.logoSrc as string} alt={opt.label} className="h-4 w-4 rounded object-contain" />
                    ) : (
                      <opt.Icon className="h-4 w-4 shrink-0 opacity-70" />
                    )}
                    <span className="min-w-0 truncate">{opt.label}</span>
                    {active && <Check className="ml-auto h-3.5 w-3.5 shrink-0 text-blue-500" />}
                  </button>
                );
              })}
            </div>

            {preferredProcessor && (
              <p className="mb-4 text-xs text-zinc-500 dark:text-zinc-400">
                {processorDescription(preferredProcessor)}
              </p>
            )}

            {/* Payout detail fields */}
            {preferredProcessor && (
              <PayoutDetailsFields
                processor={preferredProcessor}
                payout={payout}
                setPayout={setPayout}
              />
            )}
          </section>

          <div className="flex justify-end">
            <Button
              onClick={() => void handleSave()}
              disabled={saving}
              className="gap-2 bg-blue-600 text-white hover:bg-blue-700"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Save profile
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
