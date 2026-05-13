'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2, Save, User, CreditCard, Check, FileText, Upload, X } from 'lucide-react';
import { toast } from 'sonner';
import { motion, AnimatePresence } from 'motion/react';
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
  from_entity_name?: string | null;
  from_name?: string | null;
  from_address?: string | null;
  from_city_state_zip?: string | null;
  from_country?: string | null;
  logo_data_url?: string | null;
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

type SectionId = 'identity' | 'invoice-form' | 'payment-gateway';

const SECTIONS: { id: SectionId; label: string; description: string; icon: React.ElementType }[] = [
  {
    id: 'identity',
    label: 'Identity',
    description: 'Your name and account info',
    icon: User,
  },
  {
    id: 'invoice-form',
    label: 'Invoice Form',
    description: 'Prefilled sender details & logo',
    icon: FileText,
  },
  {
    id: 'payment-gateway',
    label: 'Payment Gateway',
    description: 'How you receive payouts',
    icon: CreditCard,
  },
];

function FieldGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="block text-xs font-medium text-zinc-500 dark:text-zinc-400">{label}</Label>
      {children}
    </div>
  );
}

function SectionShell({ title, description, icon: Icon, children }: {
  title: string;
  description: string;
  icon: React.ElementType;
  children: React.ReactNode;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
      className="flex flex-col gap-6"
    >
      {/* Section header */}
      <div className="flex items-center gap-3 border-b border-zinc-100 pb-5 dark:border-zinc-800">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-50 dark:bg-blue-950/40">
          <Icon className="h-4.5 w-4.5 text-blue-500" />
        </div>
        <div>
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-white">{title}</h2>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">{description}</p>
        </div>
      </div>
      {children}
    </motion.div>
  );
}

export default function ContractorProfile({
  contractorEmail,
}: {
  contractorEmail: string;
}) {
  const norm = normEmail(contractorEmail) ?? contractorEmail.toLowerCase();
  const [activeSection, setActiveSection] = useState<SectionId>('identity');

  const [displayName, setDisplayName] = useState('');
  const [fromEntityName, setFromEntityName] = useState('');
  const [fromName, setFromName] = useState('');
  const [fromAddress, setFromAddress] = useState('');
  const [fromCityStateZip, setFromCityStateZip] = useState('');
  const [fromCountry, setFromCountry] = useState('Philippines');
  const [logoDataUrl, setLogoDataUrl] = useState<string | null>(null);
  const logoInputRef = useRef<HTMLInputElement>(null);
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
        setLogoDataUrl(row.logo_data_url?.trim() || null);
        setFromEntityName(row.from_entity_name?.trim() || '');
        setFromName(row.from_name?.trim() || '');
        setFromAddress(row.from_address?.trim() || '');
        setFromCityStateZip(row.from_city_state_zip?.trim() || '');
        setFromCountry(row.from_country?.trim() || 'Philippines');
        if (row.preferred_processor && isProcessorId(row.preferred_processor)) {
          setPreferredProcessor(row.preferred_processor);
        }
        setPayout({
          preferredBankSlot: row.preferred_bank_slot === 'alternative' ? 'alternative' : 'primary',
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

  const handleLogoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      toast.error('Logo too large — maximum 5 MB.');
      return;
    }
    const reader = new FileReader();
    reader.onload = (ev) => {
      const result = ev.target?.result;
      if (typeof result === 'string') setLogoDataUrl(result);
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/contractor/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contractor_email:        norm,
          display_name:            displayName.trim() || null,
          logo_data_url:           logoDataUrl || null,
          from_entity_name:        fromEntityName.trim() || null,
          from_name:               fromName.trim() || null,
          from_address:            fromAddress.trim() || null,
          from_city_state_zip:     fromCityStateZip.trim() || null,
          from_country:            fromCountry.trim() || null,
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
      {/* Page header */}
      <div className="shrink-0 border-b border-blue-100 bg-white px-4 py-3 sm:px-6 sm:py-5 dark:border-blue-950/60 dark:bg-[#0d1117]">
        <h1 className="text-base font-semibold tracking-tight text-zinc-900 sm:text-xl dark:text-white">Profile</h1>
        <p className="mt-0.5 text-xs text-zinc-500">Manage your identity, invoice defaults, and payment preferences.</p>
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-y-auto bg-[#fafaf8] dark:bg-[#0d1117]">
        <div className="mx-auto max-w-2xl px-4 py-6 sm:px-6">

          {/* ── Top tabs ── */}
          <div className="mb-6 flex gap-1 rounded-xl border border-zinc-200 bg-white p-1 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
            {SECTIONS.map((s) => {
              const Icon = s.icon;
              const active = activeSection === s.id;
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setActiveSection(s.id)}
                  className={cn(
                    'flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-medium transition-all',
                    active
                      ? 'bg-blue-500 text-white shadow-sm'
                      : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-300',
                  )}
                >
                  <Icon className="h-3.5 w-3.5 shrink-0" />
                  <span>{s.label}</span>
                </button>
              );
            })}
          </div>

          {/* ── Content panel ── */}
          <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/60">
              <AnimatePresence mode="wait">
                {activeSection === 'identity' && (
                  <SectionShell
                    key="identity"
                    title="Identity"
                    description="Your name and account information"
                    icon={User}
                  >
                    <div className="space-y-4">
                      <FieldGroup label="Display Name">
                        <Input
                          value={displayName}
                          onChange={(e) => setDisplayName(e.target.value)}
                          placeholder="Your full name"
                          className="dark:border-zinc-700 dark:bg-zinc-900"
                        />
                      </FieldGroup>
                      <FieldGroup label="Email (read-only)">
                        <Input
                          value={contractorEmail}
                          readOnly
                          className="cursor-default bg-zinc-50 text-zinc-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-400"
                        />
                      </FieldGroup>
                    </div>
                  </SectionShell>
                )}

                {activeSection === 'invoice-form' && (
                  <SectionShell
                    key="invoice-form"
                    title="Invoice Form"
                    description="These details prefill the sender block on every new invoice"
                    icon={FileText}
                  >
                    <div className="space-y-5">
                      {/* Logo */}
                      <FieldGroup label="Company Logo">
                        <div className="flex items-start gap-5">
                          <div
                            className={cn(
                              'flex h-24 w-24 shrink-0 cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed border-zinc-200 bg-zinc-50 text-center transition-colors hover:border-blue-300 hover:bg-blue-50/50 dark:border-zinc-700 dark:bg-zinc-800/40 dark:hover:border-blue-700',
                              logoDataUrl && 'border-solid border-blue-200 bg-white p-1 dark:border-blue-900/60 dark:bg-zinc-900',
                            )}
                            onClick={() => logoInputRef.current?.click()}
                            role="button"
                            tabIndex={0}
                            onKeyDown={(e) => e.key === 'Enter' && logoInputRef.current?.click()}
                            aria-label="Upload company logo"
                          >
                            {logoDataUrl ? (
                              <img src={logoDataUrl} alt="Company logo" className="h-full w-full rounded-lg object-contain" />
                            ) : (
                              <>
                                <Upload className="h-5 w-5 text-zinc-400" />
                                <span className="text-[10px] font-medium leading-tight text-zinc-500">Upload</span>
                              </>
                            )}
                            <input
                              ref={logoInputRef}
                              type="file"
                              accept="image/*"
                              className="sr-only"
                              onChange={handleLogoUpload}
                            />
                          </div>
                          <div className="space-y-1.5 pt-1">
                            <p className="text-xs text-zinc-500 dark:text-zinc-400">PNG, JPG, SVG · max 5 MB</p>
                            <p className="text-[11px] text-zinc-400 dark:text-zinc-500">Appears on every invoice you send.</p>
                            {logoDataUrl && (
                              <button
                                type="button"
                                onClick={() => setLogoDataUrl(null)}
                                className="flex items-center gap-1 text-[11px] text-zinc-400 hover:text-red-500"
                              >
                                <X className="h-3 w-3" /> Remove
                              </button>
                            )}
                          </div>
                        </div>
                      </FieldGroup>

                      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                        <FieldGroup label="Entity / Company Name">
                          <Input
                            value={fromEntityName}
                            onChange={(e) => setFromEntityName(e.target.value)}
                            placeholder="Kane LTD"
                            className="dark:border-zinc-700 dark:bg-zinc-900"
                          />
                        </FieldGroup>
                        <FieldGroup label="Your Name">
                          <Input
                            value={fromName}
                            onChange={(e) => setFromName(e.target.value)}
                            placeholder="Full name on invoice"
                            className="dark:border-zinc-700 dark:bg-zinc-900"
                          />
                        </FieldGroup>
                      </div>

                      <FieldGroup label="Street Address">
                        <Input
                          value={fromAddress}
                          onChange={(e) => setFromAddress(e.target.value)}
                          placeholder="123 Main St"
                          className="dark:border-zinc-700 dark:bg-zinc-900"
                        />
                      </FieldGroup>

                      <div className="grid grid-cols-2 gap-4">
                        <FieldGroup label="City / State / ZIP">
                          <Input
                            value={fromCityStateZip}
                            onChange={(e) => setFromCityStateZip(e.target.value)}
                            placeholder="Cebu City, 6000"
                            className="dark:border-zinc-700 dark:bg-zinc-900"
                          />
                        </FieldGroup>
                        <FieldGroup label="Country">
                          <Input
                            value={fromCountry}
                            onChange={(e) => setFromCountry(e.target.value)}
                            placeholder="Philippines"
                            className="dark:border-zinc-700 dark:bg-zinc-900"
                          />
                        </FieldGroup>
                      </div>
                    </div>
                  </SectionShell>
                )}

                {activeSection === 'payment-gateway' && (
                  <SectionShell
                    key="payment-gateway"
                    title="Payment Gateway"
                    description="Choose how you receive your payouts"
                    icon={CreditCard}
                  >
                    <div className="space-y-5">
                      {/* Processor picker */}
                      <div>
                        <p className="mb-3 text-xs font-medium text-zinc-500 dark:text-zinc-400">Select processor</p>
                        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                          {PROCESSOR_OPTIONS.map((opt) => {
                            const active = preferredProcessor === opt.id;
                            return (
                              <button
                                key={opt.id}
                                type="button"
                                onClick={() => setPreferredProcessor(active ? '' : opt.id)}
                                className={cn(
                                  'flex items-center gap-2.5 rounded-xl border px-3.5 py-3 text-left text-xs font-medium transition-all',
                                  active
                                    ? 'border-blue-500/60 bg-blue-50 text-blue-800 shadow-sm dark:border-blue-500/40 dark:bg-blue-950/40 dark:text-blue-200'
                                    : 'border-zinc-200 bg-zinc-50 text-zinc-700 hover:border-zinc-300 hover:bg-white dark:border-zinc-700 dark:bg-zinc-800/50 dark:text-zinc-300 dark:hover:bg-zinc-800',
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
                      </div>

                      {preferredProcessor && (
                        <p className="rounded-lg bg-blue-50 px-3.5 py-2.5 text-xs text-blue-700 dark:bg-blue-950/30 dark:text-blue-300">
                          {processorDescription(preferredProcessor)}
                        </p>
                      )}

                      {preferredProcessor && (
                        <PayoutDetailsFields
                          processor={preferredProcessor}
                          payout={payout}
                          setPayout={setPayout}
                        />
                      )}

                      {!preferredProcessor && (
                        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-zinc-200 py-10 text-center dark:border-zinc-700">
                          <CreditCard className="h-8 w-8 text-zinc-300 dark:text-zinc-600" />
                          <p className="text-sm text-zinc-400 dark:text-zinc-500">Select a processor above to enter your details.</p>
                        </div>
                      )}
                    </div>
                  </SectionShell>
                )}
              </AnimatePresence>

              {/* Save */}
              <div className="mt-8 flex items-center justify-between border-t border-zinc-100 pt-6 dark:border-zinc-800">
                <p className="text-xs text-zinc-400 dark:text-zinc-500">Changes apply across all sections on save.</p>
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
    </div>
  );
}
