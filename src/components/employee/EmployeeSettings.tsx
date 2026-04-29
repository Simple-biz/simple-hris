'use client';

import React, { useEffect, useState } from 'react';
import {
  Save,
  Loader2,
  Mail,
  CreditCard,
  CheckCircle,
  Banknote,
  Coins,
  Globe2,
  Wallet,
  Wallet2,
  Wifi,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { normEmail } from '@/lib/email/norm-email';
import { cn } from '@/lib/utils';

// Carla's constraint: the processor must be one of the company-approved
// methods. Free-text "GCash" / "digital wallet" entries used to slip into
// the Bank Preferred field that Lenny's dispatch queue routes on — this
// dropdown closes that gap. Keep in sync with mock-queue.ts ProcessorId
// and the CHECK constraint in references/add_preferred_processor.sql.
const PROCESSOR_OPTIONS = [
  { id: 'hurupay', label: 'Hurupay', blurb: 'Email only', Icon: Coins },
  { id: 'wepay', label: 'Wepay', blurb: 'Email only', Icon: Wallet },
  { id: 'higlobe', label: 'Higlobe', blurb: 'Email + account holder', Icon: Globe2 },
  { id: 'wise', label: 'Wise', blurb: 'Email or Wise tag', Icon: Wallet2 },
  { id: 'jeeves', label: 'Jeeves', blurb: 'Phone + wire details', Icon: Wifi },
  { id: 'wires', label: 'Wires', blurb: 'Manual bank wire', Icon: Banknote },
] as const;

type ProcessorId = typeof PROCESSOR_OPTIONS[number]['id'];

function isProcessorId(v: string): v is ProcessorId {
  return PROCESSOR_OPTIONS.some((p) => p.id === v);
}

/** Per-processor payout fields. Each processor uses a subset; UI shows only the relevant ones. */
interface PayoutFields {
  hurupayEmail: string;
  wepayEmail: string;
  higlobeEmail: string;
  higlobeAccountName: string;
  wiseEmail: string;
  wiseTag: string;
  phoneNumber: string;
  fullAddress: string;
  // Wire-related — reuses existing employee_ids columns
  bankName: string;
  accountHolderName: string;
  accountNumber: string;
  swiftCode: string;
}

const emptyPayout: PayoutFields = {
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
};

interface EmployeeSettingsProps {
  employeeEmail: string;
}

/** Read a string from a raw Supabase row, trying multiple column name variants. */
function pick(row: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = row[k];
    if (v != null && String(v).trim()) return String(v).trim();
  }
  return '';
}

export default function EmployeeSettings({ employeeEmail }: EmployeeSettingsProps) {
  const email = normEmail(employeeEmail) ?? employeeEmail.toLowerCase();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [personalEmail, setPersonalEmail] = useState('');
  const [preferredProcessor, setPreferredProcessor] = useState<ProcessorId | ''>('');
  const [payout, setPayout] = useState<PayoutFields>({ ...emptyPayout });
  const [lastSaved, setLastSaved] = useState<string | null>(null);

  // Load from employee_ids table via /api/employee-ids
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/employee-ids', { cache: 'no-store' });
        const json = (await res.json()) as { rows: Array<Record<string, unknown>> };
        if (cancelled) return;

        const rows = json.rows ?? [];
        const me = rows.find((r) => {
          const we = normEmail(String(r.work_email ?? ''));
          const pe = normEmail(String(r.personal_email ?? ''));
          return we === email || pe === email;
        });

        if (me) {
          setPersonalEmail(pick(me, 'personal_email'));
          setPayout({
            hurupayEmail: pick(me, 'hurupay_email'),
            wepayEmail: pick(me, 'wepay_email'),
            higlobeEmail: pick(me, 'higlobe_email'),
            higlobeAccountName: pick(me, 'higlobe_account_name'),
            wiseEmail: pick(me, 'wise_email'),
            wiseTag: pick(me, 'wise_tag'),
            phoneNumber: pick(me, 'phone_number'),
            fullAddress: pick(me, 'full_address'),
            bankName: pick(me, 'bank_name'),
            accountHolderName: pick(me, 'account_holder_name'),
            accountNumber: pick(me, 'account_number'),
            swiftCode: pick(me, 'swift_code', 'routing_number'),
          });
          const stored = pick(me, 'preferred_processor').toLowerCase();
          setPreferredProcessor(isProcessorId(stored) ? stored : '');
        }
      } catch {
        // degrade gracefully
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [email]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/update-employee-ids', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          work_email: email,
          personal_email: personalEmail || undefined,
          preferred_processor: preferredProcessor || null,
          // Per-processor payout fields. We send all of them so a switched
          // processor can clear stale values if the employee blanks them.
          hurupay_email: payout.hurupayEmail,
          wepay_email: payout.wepayEmail,
          higlobe_email: payout.higlobeEmail,
          higlobe_account_name: payout.higlobeAccountName,
          wise_email: payout.wiseEmail,
          wise_tag: payout.wiseTag,
          phone_number: payout.phoneNumber,
          full_address: payout.fullAddress,
          bank_name: payout.bankName,
          account_holder_name: payout.accountHolderName,
          account_number: payout.accountNumber,
          swift_code: payout.swiftCode,
        }),
      });
      const json = (await res.json()) as { error?: string | null; success?: boolean };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Save failed');
      setLastSaved(new Date().toLocaleTimeString());
      toast.success('Settings saved to database');
    } catch (err: unknown) {
      toast.error(`Failed to save: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-full bg-gradient-to-br from-white via-orange-50/30 to-blue-50/20 p-8 dark:bg-none dark:bg-[#0d1117]">
        <div className="flex items-center justify-center py-32">
          <Loader2 className="h-8 w-8 animate-spin text-orange-500" />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-full space-y-8 overflow-auto bg-gradient-to-br from-white via-orange-50/30 to-blue-50/20 p-8 dark:bg-none dark:bg-[#0d1117]">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-white">Settings</h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-500">
            Update your personal information and how you get paid
          </p>
        </div>
        <div className="flex items-center gap-3">
          {lastSaved && (
            <span className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
              <CheckCircle className="h-3 w-3" />
              Saved at {lastSaved}
            </span>
          )}
          <Button
            onClick={handleSave}
            disabled={saving}
            className="gap-2 bg-orange-500 text-white hover:bg-orange-600 dark:bg-orange-600 dark:hover:bg-orange-500"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save Changes
          </Button>
        </div>
      </div>

      {/* Personal Email */}
      <Card className="border-orange-100/80 bg-gradient-to-br from-white to-orange-50/30 shadow-sm dark:border-blue-950/60 dark:bg-none dark:from-blue-950/20 dark:to-blue-950/10">
        <CardHeader className="flex flex-row items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-500/10">
            <Mail className="h-4 w-4 text-blue-500" />
          </div>
          <div>
            <CardTitle className="text-sm font-medium text-zinc-900 dark:text-white">Personal Email</CardTitle>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Used as an alternative contact and for email matching
            </p>
          </div>
          <Badge variant="outline" className="ml-auto border-blue-500/20 bg-blue-500/10 text-[10px] text-blue-700 dark:border-blue-500/30 dark:text-blue-400">
            Work: {email}
          </Badge>
        </CardHeader>
        <CardContent>
          <div className="max-w-md">
            <label className="mb-1.5 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
              Personal Email Address
            </label>
            <Input
              type="email"
              placeholder="your.personal@gmail.com"
              value={personalEmail}
              onChange={(e) => setPersonalEmail(e.target.value)}
              className="border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900/60"
            />
          </div>
        </CardContent>
      </Card>

      {/* Preferred Payment Method — constrained to company-approved processors */}
      <Card className="border-orange-100/80 bg-gradient-to-br from-white to-orange-50/30 shadow-sm dark:border-blue-950/60 dark:bg-none dark:from-blue-950/20 dark:to-blue-950/10">
        <CardHeader className="flex flex-row items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-orange-500/10">
            <CreditCard className="h-4 w-4 text-orange-500" />
          </div>
          <div>
            <CardTitle className="text-sm font-medium text-zinc-900 dark:text-white">
              Preferred Payment Method
            </CardTitle>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              How payroll sends your money. Pick one — these are the processors the company supports.
            </p>
          </div>
          {preferredProcessor && (
            <Badge
              variant="outline"
              className="ml-auto border-orange-500/20 bg-orange-500/10 text-[10px] text-orange-700 dark:border-orange-500/30 dark:text-orange-400"
            >
              {PROCESSOR_OPTIONS.find((p) => p.id === preferredProcessor)?.label}
            </Badge>
          )}
        </CardHeader>
        <CardContent>
          <div
            role="radiogroup"
            aria-label="Preferred payment method"
            className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3"
          >
            {PROCESSOR_OPTIONS.map(({ id, label, blurb, Icon }) => {
              const active = preferredProcessor === id;
              return (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setPreferredProcessor(id)}
                  className={cn(
                    'group flex items-center gap-3 rounded-lg border p-3 text-left transition-all',
                    'focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500/50',
                    active
                      ? 'border-orange-500 bg-orange-50 shadow-sm dark:border-orange-500 dark:bg-orange-950/30'
                      : 'border-zinc-200 bg-white hover:border-orange-300 hover:bg-orange-50/40 dark:border-zinc-800 dark:bg-zinc-900/60 dark:hover:border-orange-700 dark:hover:bg-orange-950/20',
                  )}
                >
                  <div
                    className={cn(
                      'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors',
                      active
                        ? 'bg-orange-500 text-white'
                        : 'bg-zinc-100 text-zinc-600 group-hover:bg-orange-100 group-hover:text-orange-600 dark:bg-zinc-800 dark:text-zinc-300 dark:group-hover:bg-orange-950 dark:group-hover:text-orange-400',
                    )}
                  >
                    <Icon className="h-4 w-4" />
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
          {!preferredProcessor && (
            <p className="mt-3 text-[11px] text-amber-700 dark:text-amber-400">
              Pick a payment method so payroll knows where to route your salary. Without this,
              your dispatch can&apos;t be queued.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Per-processor payout details — only shown once a method is picked */}
      {preferredProcessor && (
        <PayoutDetailsCard
          processor={preferredProcessor}
          workEmail={email}
          payout={payout}
          setPayout={setPayout}
        />
      )}

      {/* Bottom save bar */}
      <div className="flex items-center justify-end gap-3 border-t border-zinc-200 pt-6 dark:border-zinc-800">
        {lastSaved && (
          <span className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
            <CheckCircle className="h-3 w-3" />
            Last saved at {lastSaved}
          </span>
        )}
        <Button
          onClick={handleSave}
          disabled={saving}
          className="gap-2 bg-orange-500 text-white hover:bg-orange-600 dark:bg-orange-600 dark:hover:bg-orange-500"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          Save Changes
        </Button>
      </div>
    </div>
  );
}

/* ─────────────────────── Per-processor form ─────────────────────── */

interface PayoutDetailsCardProps {
  processor: ProcessorId;
  workEmail: string;
  payout: PayoutFields;
  setPayout: React.Dispatch<React.SetStateAction<PayoutFields>>;
}

function PayoutDetailsCard({ processor, workEmail, payout, setPayout }: PayoutDetailsCardProps) {
  const meta = PROCESSOR_OPTIONS.find((p) => p.id === processor)!;
  const Icon = meta.Icon;

  const update = <K extends keyof PayoutFields>(key: K, value: string) =>
    setPayout((p) => ({ ...p, [key]: value }));

  return (
    <Card className="border-orange-100/80 bg-gradient-to-br from-white to-orange-50/30 shadow-sm dark:border-blue-950/60 dark:bg-none dark:from-blue-950/20 dark:to-blue-950/10">
      <CardHeader className="flex flex-row items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-500/10">
          <Icon className="h-4 w-4 text-emerald-500" />
        </div>
        <div>
          <CardTitle className="text-sm font-medium text-zinc-900 dark:text-white">
            {meta.label} Details
          </CardTitle>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            {processorDescription(processor)}
          </p>
        </div>
      </CardHeader>
      <CardContent>
        {processor === 'hurupay' && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Hurupay Email"
              required
              type="email"
              placeholder="you@example.com"
              value={payout.hurupayEmail}
              onChange={(v) => update('hurupayEmail', v)}
              hint="The email registered to your Hurupay account."
            />
          </div>
        )}

        {processor === 'wepay' && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Wepay Email"
              required
              type="email"
              placeholder="you@example.com"
              value={payout.wepayEmail}
              onChange={(v) => update('wepayEmail', v)}
              hint="The email registered to your Wepay account."
            />
          </div>
        )}

        {processor === 'higlobe' && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="HiGlobe Email"
              required
              type="email"
              placeholder="you@example.com"
              value={payout.higlobeEmail}
              onChange={(v) => update('higlobeEmail', v)}
            />
            <Field
              label="Account Holder Name"
              required
              placeholder="Juan Dela Cruz"
              value={payout.higlobeAccountName}
              onChange={(v) => update('higlobeAccountName', v)}
              hint="Name on your HiGlobe account, exactly as registered."
            />
          </div>
        )}

        {processor === 'wise' && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Wise Email"
              required
              type="email"
              placeholder="you@example.com"
              value={payout.wiseEmail}
              onChange={(v) => update('wiseEmail', v)}
              hint="The email registered to your Wise account."
            />
            <Field
              label="Wise Tag"
              placeholder="@yourwisetag"
              value={payout.wiseTag}
              onChange={(v) => update('wiseTag', v)}
              hint="Optional — your Wise @tag if you have one."
            />
          </div>
        )}

        {processor === 'jeeves' && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Phone Number"
              required
              placeholder="+63 9XX XXX XXXX"
              value={payout.phoneNumber}
              onChange={(v) => update('phoneNumber', v)}
            />
            <Field
              label="Account Holder Name"
              required
              placeholder="Juan Dela Cruz"
              value={payout.accountHolderName}
              onChange={(v) => update('accountHolderName', v)}
            />
            <Field
              label="Bank Name"
              required
              placeholder="BDO, BPI, Metrobank, etc."
              value={payout.bankName}
              onChange={(v) => update('bankName', v)}
            />
            <Field
              label="Account Number"
              required
              mono
              placeholder="1234-5678-9012"
              value={payout.accountNumber}
              onChange={(v) => update('accountNumber', v)}
            />
            <Field
              label="SWIFT / BIC Code"
              required
              mono
              placeholder="BOPIPHMM"
              value={payout.swiftCode}
              onChange={(v) => update('swiftCode', v)}
            />
            <Field
              label="Full Address"
              required
              fullWidth
              placeholder="House #, Street, Barangay, City, Province"
              value={payout.fullAddress}
              onChange={(v) => update('fullAddress', v)}
            />
          </div>
        )}

        {processor === 'wires' && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Account Holder Name"
              required
              placeholder="Juan Dela Cruz"
              value={payout.accountHolderName}
              onChange={(v) => update('accountHolderName', v)}
              hint="Exactly as it appears on your bank account."
            />
            <Field
              label="Bank Name"
              required
              placeholder="BDO, BPI, Metrobank, etc."
              value={payout.bankName}
              onChange={(v) => update('bankName', v)}
            />
            <Field
              label="Account Number"
              required
              mono
              placeholder="1234-5678-9012"
              value={payout.accountNumber}
              onChange={(v) => update('accountNumber', v)}
            />
            <Field
              label="SWIFT / BIC Code"
              required
              mono
              placeholder="BOPIPHMM"
              value={payout.swiftCode}
              onChange={(v) => update('swiftCode', v)}
              hint="International routing code from your bank."
            />
            <Field
              label="Full Address"
              required
              fullWidth
              placeholder="House #, Street, Barangay, City, Province"
              value={payout.fullAddress}
              onChange={(v) => update('fullAddress', v)}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function processorDescription(p: ProcessorId): string {
  switch (p) {
    case 'hurupay':
      return 'Tell us which email Hurupay should deposit to.';
    case 'wepay':
      return 'Tell us which email Wepay should deposit to.';
    case 'higlobe':
      return 'HiGlobe needs the email and the name on your account.';
    case 'wise':
      return 'Wise needs the email registered to your account; the @tag is optional.';
    case 'jeeves':
      return 'Jeeves needs your phone plus full bank wire details.';
    case 'wires':
      return 'Manual bank wires need your account, SWIFT code, and full address.';
  }
}

/* ─────────────────────── Field primitive ─────────────────────── */

interface FieldProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: 'text' | 'email';
  required?: boolean;
  mono?: boolean;
  fullWidth?: boolean;
  hint?: string;
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
  required,
  mono,
  fullWidth,
  hint,
}: FieldProps) {
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
