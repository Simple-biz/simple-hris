'use client';

import React from 'react';
import { CheckCircle } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  PROCESSOR_OPTIONS,
  isProcessorId,
  processorDescription,
  type ProcessorId,
} from '@/lib/employee-payment-processors';
import { cn } from '@/lib/utils';

export interface PayoutFields {
  preferredBankSlot: 'primary' | 'alternative';
  hurupayEmail: string;
  wepayEmail: string;
  higlobeEmail: string;
  higlobeAccountName: string;
  wiseEmail: string;
  wiseTag: string;
  phoneNumber: string;
  fullAddress: string;
  bankName: string;
  accountHolderName: string;
  accountNumber: string;
  swiftCode: string;
  altBankName: string;
  altAccountHolderName: string;
  altAccountNumber: string;
  altSwiftCode: string;
}

export const emptyPayout: PayoutFields = {
  preferredBankSlot: 'primary',
  hurupayEmail: '',
  wepayEmail: '',
  higlobeEmail: '',
  higlobeAccountName: '',
  wiseEmail: '',
  wiseTag: '',
  phoneNumber: '',
  fullAddress: '',
  bankName: '',
  accountHolderName: '',
  accountNumber: '',
  swiftCode: '',
  altBankName: '',
  altAccountHolderName: '',
  altAccountNumber: '',
  altSwiftCode: '',
};

const BANK_SLOT_OPTIONS: ReadonlyArray<{
  value: PayoutFields['preferredBankSlot'];
  label: string;
}> = [
  { value: 'primary', label: 'Primary bank' },
  { value: 'alternative', label: 'Alternative bank' },
];

function pick(row: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = row[k];
    if (v != null && String(v).trim()) return String(v).trim();
  }
  return '';
}

/** Deserialize payout draft + processor from an `employee_ids` row */
export function payoutDraftFromIdsRow(row: Record<string, unknown>): {
  preferredProcessor: ProcessorId | '';
  payout: PayoutFields;
} {
  const stored = pick(row, 'preferred_processor').toLowerCase();
  return {
    preferredProcessor: isProcessorId(stored) ? stored : '',
    payout: {
      hurupayEmail: pick(row, 'hurupay_email'),
      wepayEmail: pick(row, 'wepay_email'),
      higlobeEmail: pick(row, 'higlobe_email'),
      higlobeAccountName: pick(row, 'higlobe_account_name'),
      wiseEmail: pick(row, 'wise_email'),
      wiseTag: pick(row, 'wise_tag'),
      phoneNumber: pick(row, 'phone_number'),
      fullAddress: pick(row, 'full_address'),
      bankName: pick(row, 'bank_name'),
      accountHolderName: pick(row, 'account_holder_name'),
      accountNumber: pick(row, 'account_number'),
      swiftCode: pick(row, 'swift_code', 'routing_number'),
      preferredBankSlot: pick(row, 'preferred_bank_slot') === 'alternative' ? 'alternative' : 'primary',
      altBankName: pick(row, 'alt_bank_name'),
      altAccountHolderName: pick(row, 'alt_account_holder_name'),
      altAccountNumber: pick(row, 'alt_account_number'),
      altSwiftCode: pick(row, 'alt_routing_number'),
    },
  };
}

export function PreferredPaymentMethodRadios({
  value,
  onChange,
  disabled = false,
}: {
  value: ProcessorId | '';
  onChange: (id: ProcessorId) => void;
  disabled?: boolean;
}) {
  return (
    <>
      <div
        role="radiogroup"
        aria-label="Preferred payment method"
        aria-disabled={disabled}
        className={cn(
          'grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3',
          disabled && 'pointer-events-none opacity-60',
        )}
      >
        {PROCESSOR_OPTIONS.map(({ id, label, blurb, Icon, ...rest }) => {
          const logoSrc = 'logoSrc' in rest ? (rest as { logoSrc?: string }).logoSrc : undefined;
          const active = value === id;
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={disabled}
              onClick={() => !disabled && onChange(id)}
              className={cn(
                'group flex items-center gap-3 rounded-lg border p-3 text-left transition-all',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500/50',
                disabled && 'cursor-not-allowed',
                active
                  ? 'border-orange-500 bg-orange-50 shadow-sm dark:border-orange-500 dark:bg-orange-950/30'
                  : 'border-zinc-200 bg-white hover:border-orange-300 hover:bg-orange-50/40 dark:border-zinc-800 dark:bg-zinc-900/60 dark:hover:border-orange-700 dark:hover:bg-orange-950/20',
              )}
            >
              <div
                className={cn(
                  'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors overflow-hidden',
                  logoSrc
                    ? 'bg-white'
                    : active
                    ? 'bg-orange-500 text-white'
                    : 'bg-zinc-100 text-zinc-600 group-hover:bg-orange-100 group-hover:text-orange-600 dark:bg-zinc-800 dark:text-zinc-300 dark:group-hover:bg-orange-950 dark:group-hover:text-orange-400',
                )}
              >
                {logoSrc ? (
                  <img
                    src={logoSrc}
                    alt={label}
                    className="h-full w-full object-contain mix-blend-multiply dark:mix-blend-normal"
                  />
                ) : (
                  <Icon className="h-4 w-4" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-zinc-900 dark:text-white">{label}</div>
                <div className="truncate text-[11px] text-zinc-500 dark:text-zinc-400">{blurb}</div>
              </div>
              {active && (
                <CheckCircle className="h-4 w-4 shrink-0 text-orange-500" aria-hidden />
              )}
            </button>
          );
        })}
      </div>
      {!value && !disabled && (
        <p className="mt-3 text-[11px] text-amber-700 dark:text-amber-400">
          Pick a payment method so payroll knows where to route your salary. Without this, your dispatch
          can&apos;t be queued.
        </p>
      )}
    </>
  );
}

export function PayoutDetailsFields({
  processor,
  payout,
  setPayout,
  disabled = false,
}: {
  processor: ProcessorId;
  payout: PayoutFields;
  setPayout: React.Dispatch<React.SetStateAction<PayoutFields>>;
  disabled?: boolean;
}) {
  const meta = PROCESSOR_OPTIONS.find((p) => p.id === processor)!;
  const ProcIcon = meta.Icon;
  const procLogoSrc = 'logoSrc' in meta ? (meta as typeof meta & { logoSrc?: string }).logoSrc : undefined;
  const supportsMultipleBanks = processor === 'jeeves' || processor === 'wires';

  const update = <K extends keyof PayoutFields>(key: K, val: PayoutFields[K]) =>
    setPayout((p) => ({ ...p, [key]: val }));

  return (
    <div
      className={cn(
        'rounded-lg border border-zinc-100 bg-zinc-50/60 p-4 dark:border-zinc-800 dark:bg-zinc-900/40',
        disabled && 'pointer-events-none opacity-60',
      )}
    >
      <div className="mb-4 flex items-start gap-3 border-b border-zinc-100 pb-3 dark:border-zinc-800">
        <div className={cn(
          'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg overflow-hidden',
          procLogoSrc ? 'bg-white' : 'bg-emerald-500/10 dark:bg-emerald-950/40',
        )}>
          {procLogoSrc ? (
            <img
              src={procLogoSrc}
              alt={meta.label}
              className="h-full w-full object-contain mix-blend-multiply dark:mix-blend-normal"
            />
          ) : (
            <ProcIcon className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-zinc-900 dark:text-white">{meta.label} details</div>
          <p className="mt-0.5 text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">
            {processorDescription(processor)}
          </p>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {supportsMultipleBanks && (
          <div className="sm:col-span-2">
            <Label className="mb-2 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
              Preferred bank for payroll
            </Label>
            <div className="grid gap-2 sm:grid-cols-2">
              {BANK_SLOT_OPTIONS.map((opt) => {
                const active = payout.preferredBankSlot === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    disabled={disabled}
                    onClick={() => update('preferredBankSlot', opt.value)}
                    className={cn(
                      'rounded-lg border px-3 py-2 text-left text-sm transition-colors',
                      disabled && 'cursor-not-allowed opacity-60',
                      active
                        ? 'border-orange-500 bg-orange-50 text-orange-700 dark:border-orange-500 dark:bg-orange-950/30 dark:text-orange-300'
                        : 'border-zinc-200 bg-white text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-300',
                    )}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
            <p className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-500">
              Payment Dispatch will use the bank selected here as the default destination.
            </p>
          </div>
        )}

        {processor === 'hurupay' && (
          <FormField
            disabled={disabled}
            label="Hurupay Email"
            required
            type="email"
            placeholder="you@example.com"
            value={payout.hurupayEmail}
            onChange={(v) => update('hurupayEmail', v)}
            hint="The email registered to your Hurupay account."
          />
        )}

        {processor === 'wepay' && (
          <FormField
            disabled={disabled}
            label="Wepay Email"
            required
            type="email"
            placeholder="you@example.com"
            value={payout.wepayEmail}
            onChange={(v) => update('wepayEmail', v)}
            hint="The email registered to your Wepay account."
          />
        )}

        {processor === 'higlobe' && (
          <>
            <FormField
            disabled={disabled}
              label="HiGlobe Email"
              required
              type="email"
              placeholder="you@example.com"
              value={payout.higlobeEmail}
              onChange={(v) => update('higlobeEmail', v)}
            />
            <FormField
            disabled={disabled}
              label="Account Holder Name"
              required
              placeholder="Juan Dela Cruz"
              value={payout.higlobeAccountName}
              onChange={(v) => update('higlobeAccountName', v)}
              hint="Name on your HiGlobe account, exactly as registered."
            />
          </>
        )}

        {processor === 'wise' && (
          <>
            <FormField
            disabled={disabled}
              label="Wise Email"
              required
              type="email"
              placeholder="you@example.com"
              value={payout.wiseEmail}
              onChange={(v) => update('wiseEmail', v)}
              hint="The email registered to your Wise account."
            />
            <FormField
            disabled={disabled}
              label="Wise Tag"
              placeholder="@yourwisetag"
              value={payout.wiseTag}
              onChange={(v) => update('wiseTag', v)}
              hint="Optional — your Wise @tag if you have one."
            />
          </>
        )}

        {processor === 'jeeves' && (
          <>
            <div className="sm:col-span-2">
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                Primary bank
              </div>
            </div>
            <FormField
            disabled={disabled}
              label="Phone Number"
              required
              placeholder="+63 9XX XXX XXXX"
              value={payout.phoneNumber}
              onChange={(v) => update('phoneNumber', v)}
            />
            <FormField
            disabled={disabled}
              label="Account Holder Name"
              required
              placeholder="Juan Dela Cruz"
              value={payout.accountHolderName}
              onChange={(v) => update('accountHolderName', v)}
            />
            <FormField
            disabled={disabled}
              label="Bank Name"
              required
              placeholder="BDO, BPI, Metrobank, etc."
              value={payout.bankName}
              onChange={(v) => update('bankName', v)}
            />
            <FormField
            disabled={disabled}
              label="Account Number"
              required
              mono
              placeholder="1234-5678-9012"
              value={payout.accountNumber}
              onChange={(v) => update('accountNumber', v)}
            />
            <FormField
            disabled={disabled}
              label="SWIFT / BIC Code"
              required
              mono
              placeholder="BOPIPHMM"
              value={payout.swiftCode}
              onChange={(v) => update('swiftCode', v)}
            />
            <FormField
            disabled={disabled}
              label="Full Address"
              required
              fullWidth
              placeholder="House #, Street, Barangay, City, Province"
              value={payout.fullAddress}
              onChange={(v) => update('fullAddress', v)}
            />
            <div className="sm:col-span-2 mt-1">
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                Alternative bank
              </div>
            </div>
            <FormField
              disabled={disabled}
              label="Bank Name"
              placeholder="Optional backup bank"
              value={payout.altBankName}
              onChange={(v) => update('altBankName', v)}
            />
            <FormField
              disabled={disabled}
              label="Account Holder Name"
              placeholder="Optional backup account holder"
              value={payout.altAccountHolderName}
              onChange={(v) => update('altAccountHolderName', v)}
            />
            <FormField
              disabled={disabled}
              label="Account Number"
              mono
              placeholder="Optional backup account number"
              value={payout.altAccountNumber}
              onChange={(v) => update('altAccountNumber', v)}
            />
            <FormField
              disabled={disabled}
              label="SWIFT / BIC Code"
              mono
              placeholder="Optional backup SWIFT code"
              value={payout.altSwiftCode}
              onChange={(v) => update('altSwiftCode', v)}
            />
          </>
        )}

        {processor === 'wires' && (
          <>
            <div className="sm:col-span-2">
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                Primary bank
              </div>
            </div>
            <FormField
            disabled={disabled}
              label="Account Holder Name"
              required
              placeholder="Juan Dela Cruz"
              value={payout.accountHolderName}
              onChange={(v) => update('accountHolderName', v)}
              hint="Exactly as it appears on your bank account."
            />
            <FormField
            disabled={disabled}
              label="Bank Name"
              required
              placeholder="BDO, BPI, Metrobank, etc."
              value={payout.bankName}
              onChange={(v) => update('bankName', v)}
            />
            <FormField
            disabled={disabled}
              label="Account Number"
              required
              mono
              placeholder="1234-5678-9012"
              value={payout.accountNumber}
              onChange={(v) => update('accountNumber', v)}
            />
            <FormField
            disabled={disabled}
              label="SWIFT / BIC Code"
              required
              mono
              placeholder="BOPIPHMM"
              value={payout.swiftCode}
              onChange={(v) => update('swiftCode', v)}
              hint="International routing code from your bank."
            />
            <FormField
            disabled={disabled}
              label="Full Address"
              required
              fullWidth
              placeholder="House #, Street, Barangay, City, Province"
              value={payout.fullAddress}
              onChange={(v) => update('fullAddress', v)}
            />
            <div className="sm:col-span-2 mt-1">
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                Alternative bank
              </div>
            </div>
            <FormField
              disabled={disabled}
              label="Bank Name"
              placeholder="Optional backup bank"
              value={payout.altBankName}
              onChange={(v) => update('altBankName', v)}
            />
            <FormField
              disabled={disabled}
              label="Account Holder Name"
              placeholder="Optional backup account holder"
              value={payout.altAccountHolderName}
              onChange={(v) => update('altAccountHolderName', v)}
            />
            <FormField
              disabled={disabled}
              label="Account Number"
              mono
              placeholder="Optional backup account number"
              value={payout.altAccountNumber}
              onChange={(v) => update('altAccountNumber', v)}
            />
            <FormField
              disabled={disabled}
              label="SWIFT / BIC Code"
              mono
              placeholder="Optional backup SWIFT code"
              value={payout.altSwiftCode}
              onChange={(v) => update('altSwiftCode', v)}
            />
          </>
        )}
      </div>
    </div>
  );
}

interface FormFieldProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: 'text' | 'email';
  required?: boolean;
  mono?: boolean;
  fullWidth?: boolean;
  hint?: string;
  disabled?: boolean;
}

function FormField({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
  required,
  mono,
  fullWidth,
  hint,
  disabled = false,
}: FormFieldProps) {
  return (
    <div className={cn(fullWidth && 'sm:col-span-2')}>
      <label className="mb-1.5 flex items-center gap-1 text-xs font-medium text-zinc-600 dark:text-zinc-400">
        {label}
        {required ? (
          <span className="text-rose-500">*</span>
        ) : (
          <span className="text-zinc-400 dark:text-zinc-600">(optional)</span>
        )}
      </label>
      <Input
        type={type}
        placeholder={placeholder}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          'border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900/60',
          mono && 'font-mono',
        )}
      />
      {hint && (
        <p className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-500">{hint}</p>
      )}
    </div>
  );
}
