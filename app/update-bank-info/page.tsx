'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Mail, ShieldCheck, ArrowLeft, CheckCircle2, Landmark } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import {
  PreferredPaymentMethodRadios,
  PayoutDetailsFields,
  emptyPayout,
  payoutDraftFromIdsRow,
  type PayoutFields,
} from '@/components/employee/employee-payout-fields';
import type { ProcessorId } from '@/lib/employee-payment-processors';

type Step = 'email' | 'code' | 'edit' | 'done';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function UpdateBankInfoPage() {
  const [step, setStep] = useState<Step>('email');
  const [busy, setBusy] = useState(false);

  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [info, setInfo] = useState<string | null>(null);

  const [sessionToken, setSessionToken] = useState('');
  const [workEmail, setWorkEmail] = useState('');
  const [name, setName] = useState<string | null>(null);

  const [preferredProcessor, setPreferredProcessor] = useState<ProcessorId | ''>('');
  const [payout, setPayout] = useState<PayoutFields>(() => ({ ...emptyPayout }));

  // ── Step 1: request a code ────────────────────────────────────────────────
  const requestCode = async () => {
    const e = email.trim().toLowerCase();
    if (!EMAIL_RE.test(e)) {
      toast.error('Enter a valid email address.');
      return;
    }
    setBusy(true);
    try {
      const res = await fetch('/api/bank-update/request-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: e }),
      });
      const json = (await res.json()) as { ok?: boolean; message?: string; error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Could not send a code.');
      setInfo(json.message ?? 'If that email belongs to an active employee, a code is on its way.');
      setCode('');
      setStep('code');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not send a code.');
    } finally {
      setBusy(false);
    }
  };

  // ── Step 2: verify the code, load current details ─────────────────────────
  const verifyCode = async () => {
    const c = code.trim();
    if (!/^\d{6}$/.test(c)) {
      toast.error('Enter the 6-digit code from your email.');
      return;
    }
    setBusy(true);
    try {
      const res = await fetch('/api/bank-update/verify-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim().toLowerCase(), code: c }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        session_token?: string;
        work_email?: string;
        name?: string | null;
        payout?: Record<string, unknown>;
        error?: string;
      };
      if (!res.ok || json.error) throw new Error(json.error ?? 'That code is incorrect.');

      setSessionToken(json.session_token ?? '');
      setWorkEmail(json.work_email ?? email.trim().toLowerCase());
      setName(json.name ?? null);

      const draft = payoutDraftFromIdsRow((json.payout ?? {}) as Record<string, unknown>);
      setPreferredProcessor(draft.preferredProcessor);
      setPayout(draft.payout);
      setStep('edit');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'That code is incorrect.');
    } finally {
      setBusy(false);
    }
  };

  // ── Step 3: save the new details ──────────────────────────────────────────
  const save = async () => {
    if (!preferredProcessor) {
      toast.error('Choose a payment method.');
      return;
    }
    setBusy(true);
    try {
      const res = await fetch('/api/bank-update/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_token: sessionToken,
          preferred_processor: preferredProcessor || null,
          preferred_bank_slot: payout.preferredBankSlot || null,
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
          alt_bank_name: payout.altBankName,
          alt_account_holder_name: payout.altAccountHolderName,
          alt_account_number: payout.altAccountNumber,
          alt_routing_number: payout.altSwiftCode,
        }),
      });
      const json = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Could not save your details.');
      setStep('done');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save your details.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="min-h-dvh bg-gradient-to-b from-zinc-50 to-zinc-100 px-4 py-10 text-zinc-900 dark:from-zinc-950 dark:to-zinc-900 dark:text-zinc-100">
      <div className="mx-auto w-full max-w-xl">
        <div className="mb-6 flex flex-col items-center text-center">
          <img src="/simple-logo.png" alt="Simple.biz" className="mb-4 h-9 w-auto" />
          <h1 className="text-xl font-semibold tracking-tight">Update your bank details</h1>
          <p className="mt-1 max-w-md text-sm text-zinc-500 dark:text-zinc-400">
            Verify your work email, then review and update the payout details we use to pay you.
          </p>
        </div>

        <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-950 sm:p-7">
          {step === 'email' && (
            <div className="space-y-5">
              <Stepline icon={<Mail className="h-4 w-4" />} title="Step 1 of 2 — Verify it's you">
                Enter your <strong>work email</strong>. We'll send a 6-digit code to that inbox.
              </Stepline>
              <div className="space-y-2">
                <Label htmlFor="bu-email">Work email</Label>
                <Input
                  id="bu-email"
                  type="email"
                  autoComplete="email"
                  placeholder="you@simple.biz"
                  value={email}
                  onChange={(ev) => setEmail(ev.target.value)}
                  onKeyDown={(ev) => ev.key === 'Enter' && !busy && requestCode()}
                  disabled={busy}
                />
              </div>
              <Button type="button" className="w-full" onClick={requestCode} disabled={busy}>
                {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Send code
              </Button>
            </div>
          )}

          {step === 'code' && (
            <div className="space-y-5">
              <Stepline icon={<ShieldCheck className="h-4 w-4" />} title="Step 2 of 2 — Enter your code">
                {info ?? 'Enter the 6-digit code we emailed you.'}
              </Stepline>
              <div className="space-y-2">
                <Label htmlFor="bu-code">6-digit code</Label>
                <Input
                  id="bu-code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  placeholder="••••••"
                  className="text-center text-lg tracking-[0.5em]"
                  value={code}
                  onChange={(ev) => setCode(ev.target.value.replace(/\D/g, '').slice(0, 6))}
                  onKeyDown={(ev) => ev.key === 'Enter' && !busy && verifyCode()}
                  disabled={busy}
                />
              </div>
              <Button type="button" className="w-full" onClick={verifyCode} disabled={busy}>
                {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Verify &amp; continue
              </Button>
              <div className="flex items-center justify-between text-xs text-zinc-500 dark:text-zinc-400">
                <button
                  type="button"
                  className="inline-flex items-center gap-1 hover:text-zinc-800 dark:hover:text-zinc-200"
                  onClick={() => setStep('email')}
                  disabled={busy}
                >
                  <ArrowLeft className="h-3.5 w-3.5" /> Change email
                </button>
                <button
                  type="button"
                  className="hover:text-zinc-800 dark:hover:text-zinc-200"
                  onClick={requestCode}
                  disabled={busy}
                >
                  Resend code
                </button>
              </div>
            </div>
          )}

          {step === 'edit' && (
            <div className="space-y-5">
              <Stepline icon={<Landmark className="h-4 w-4" />} title="Review &amp; update your payout details">
                Signed in as <strong>{name ? `${name} · ` : ''}{workEmail}</strong>. Update anything that's
                changed, then save.
              </Stepline>

              <PreferredPaymentMethodRadios
                value={preferredProcessor}
                onChange={setPreferredProcessor}
                disabled={busy}
              />

              {preferredProcessor ? (
                <PayoutDetailsFields
                  processor={preferredProcessor}
                  payout={payout}
                  setPayout={setPayout}
                  disabled={busy}
                />
              ) : (
                <p className="rounded-lg border border-dashed border-zinc-300 bg-zinc-50 px-3 py-4 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900/40 dark:text-zinc-400">
                  Choose a payment method above to edit its details.
                </p>
              )}

              <Button type="button" className="w-full" onClick={save} disabled={busy || !preferredProcessor}>
                {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Save changes
              </Button>
              <p className="text-center text-[11px] leading-relaxed text-zinc-400">
                Your changes are saved securely and shared with the Accounting team for payroll.
              </p>
            </div>
          )}

          {step === 'done' && (
            <div className="flex flex-col items-center gap-3 py-6 text-center">
              <CheckCircle2 className="h-12 w-12 text-emerald-500" />
              <h2 className="text-lg font-semibold">Bank details updated</h2>
              <p className="max-w-sm text-sm text-zinc-500 dark:text-zinc-400">
                Thanks{name ? `, ${name.split(/\s+/)[0]}` : ''}. Your payout details for{' '}
                <strong>{workEmail}</strong> have been saved. You can close this page.
              </p>
              <Button
                type="button"
                variant="outline"
                className="mt-2"
                onClick={() => {
                  setStep('edit');
                }}
              >
                Make another change
              </Button>
            </div>
          )}
        </div>

        <p className="mt-5 text-center text-[11px] text-zinc-400">
          Didn't request this? You can safely ignore it — nothing changes until a code is verified.
        </p>
      </div>
    </main>
  );
}

function Stepline({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-zinc-50/70 p-4 dark:border-zinc-800 dark:bg-zinc-900/40">
      <div className="mb-1 flex items-center gap-2 text-sm font-semibold">
        <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-zinc-900 text-white dark:bg-white dark:text-zinc-900">
          {icon}
        </span>
        {title}
      </div>
      <p className="pl-9 text-[13px] leading-relaxed text-zinc-500 dark:text-zinc-400">{children}</p>
    </div>
  );
}
