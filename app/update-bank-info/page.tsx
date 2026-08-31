'use client';

import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { toast } from 'sonner';
import { Loader2, Mail, ShieldCheck, ArrowLeft, CheckCircle2, Landmark, Lock } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import {
  PreferredPaymentMethodRadios,
  PayoutDetailsFields,
  emptyPayout,
  payoutDraftFromIdsRow,
  isPayoutComplete,
  type PayoutFields,
} from '@/components/employee/employee-payout-fields';
import { resolveEffectivePayoutProcessor } from '@/lib/employee/payout-completeness';
import type { ProcessorId } from '@/lib/employee-payment-processors';

type Step = 'email' | 'code' | 'edit' | 'done';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function UpdateBankInfoPage() {
  const [step, setStep] = useState<Step>('email');
  const [busy, setBusy] = useState(false);
  const [payrollLocked, setPayrollLocked] = useState(false);

  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [info, setInfo] = useState<string | null>(null);

  const [sessionToken, setSessionToken] = useState('');
  const [workEmail, setWorkEmail] = useState('');
  const [name, setName] = useState<string | null>(null);

  const [preferredProcessor, setPreferredProcessor] = useState<ProcessorId | ''>('');
  const [payout, setPayout] = useState<PayoutFields>(() => ({ ...emptyPayout }));

  // ── Payroll-lock probe ────────────────────────────────────────────────────
  // While Accounting is dispatching payroll the /save endpoint hard-blocks with
  // 423, so we grey out the email + "Send code" controls up front rather than
  // let someone run the whole OTP flow only to be rejected at the end. Poll (and
  // refetch on tab focus) so the form reopens on its own the moment processing
  // stops. Advisory only: on a read error we fail OPEN and let the server
  // enforce the real block.
  useEffect(() => {
    let alive = true;
    const check = async () => {
      try {
        const res = await fetch('/api/bank-update/lock-status', { cache: 'no-store' });
        if (!res.ok) return;
        const json = (await res.json()) as { locked?: boolean };
        if (alive) setPayrollLocked(Boolean(json.locked));
      } catch {
        /* advisory — keep prior state */
      }
    };
    void check();
    const id = window.setInterval(check, 20_000);
    const onFocus = () => void check();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      alive = false;
      window.clearInterval(id);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, []);

  // ── Step 1: request a code ────────────────────────────────────────────────
  const requestCode = async () => {
    if (payrollLocked) return;
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

      const payoutRow = (json.payout ?? {}) as Record<string, unknown>;
      const draft = payoutDraftFromIdsRow(payoutRow);
      // Seed the picker from the rail the employee is ACTUALLY paid on: their
      // Disbursement pick if they made one, else their Bank Preferred
      // send-from rail. Showing an empty picker to a bank_preferred-routed
      // person made them guess, and their guess then disagreed with payroll.
      setPreferredProcessor(
        draft.preferredProcessor ||
          (resolveEffectivePayoutProcessor(payoutRow) ?? ''),
      );
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
    if (payrollLocked) return;
    if (!preferredProcessor) {
      toast.error('Choose a payment method.');
      return;
    }
    const payload = {
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
    };
    // Block a half-filled save (e.g. method chosen but its required field blank),
    // which would otherwise overwrite good details with empties.
    if (!isPayoutComplete(payload)) {
      toast.error(`Fill in the required ${preferredProcessor} details before saving.`);
      return;
    }
    setBusy(true);
    try {
      const res = await fetch('/api/bank-update/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = (await res.json()) as { success?: boolean; error?: string };
      // 423 = payroll dispatch lock flipped on mid-session. Reflect it in the UI
      // (greys the controls, shows the notice) so it matches the server's block.
      if (res.status === 423) setPayrollLocked(true);
      if (!res.ok || json.error) throw new Error(json.error ?? 'Could not save your details.');
      setStep('done');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save your details.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="relative grid min-h-dvh place-items-center overflow-y-auto bg-gradient-to-br from-zinc-200 via-zinc-100 to-zinc-200 px-4 py-10 text-zinc-900 dark:from-black dark:via-zinc-950 dark:to-black dark:text-zinc-100">
      {/* Frosted dim backdrop so the card reads as a modal on the otherwise-empty page. */}
      <div className="pointer-events-none absolute inset-0 bg-black/10 backdrop-blur-sm dark:bg-black/50" />
      <motion.div
        initial={{ opacity: 0, y: 14, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
        className="relative w-full max-w-xl"
      >
        <div className="max-h-[88vh] overflow-y-auto rounded-3xl border border-white/60 bg-white/95 p-7 shadow-[0_24px_70px_-20px_rgba(0,0,0,0.35)] ring-1 ring-black/5 backdrop-blur-xl dark:border-white/10 dark:bg-zinc-950/90 dark:ring-white/10 sm:p-9">
          <div className="mb-6 flex flex-col items-center text-center">
            <img src="/simple-logo.png" alt="Simple.biz" className="mb-3 h-9 w-auto" />
            <h1 className="text-xl font-semibold tracking-tight">Update your bank details</h1>
            <p className="mt-1.5 text-sm text-zinc-500 dark:text-zinc-400">
              Verify your work email, then review and update your payout details.
            </p>
          </div>
          {step === 'email' && (
            <div className="space-y-5">
              {payrollLocked && <LockNotice />}
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
                  onKeyDown={(ev) => ev.key === 'Enter' && !busy && !payrollLocked && requestCode()}
                  disabled={busy || payrollLocked}
                />
              </div>
              <Button
                type="button"
                className="w-full"
                onClick={requestCode}
                disabled={busy || payrollLocked}
              >
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
              {payrollLocked && <LockNotice />}
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

              <Button
                type="button"
                className="w-full"
                onClick={save}
                disabled={busy || payrollLocked || !preferredProcessor}
              >
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
      </motion.div>
    </main>
  );
}

/**
 * Shown when the Payroll Wizard's dispatch lock is on. Explains why the controls
 * are greyed out and that the page reopens on its own — no manual refresh needed.
 */
function LockNotice() {
  return (
    <div
      className="flex items-start gap-2.5 rounded-xl border border-rose-200 bg-rose-50/80 px-4 py-3 dark:border-rose-900/50 dark:bg-rose-950/30"
      role="status"
      aria-live="polite"
    >
      <Lock className="mt-0.5 h-4 w-4 shrink-0 text-rose-600 dark:text-rose-300" aria-hidden />
      <div className="text-[13px] leading-relaxed">
        <p className="font-semibold text-rose-900 dark:text-rose-100">
          Payroll is being processed right now
        </p>
        <p className="mt-0.5 text-rose-700/90 dark:text-rose-300/80">
          Bank detail updates are temporarily paused so payouts can&rsquo;t change mid-cycle. This
          page reopens automatically once processing finishes — please check back shortly.
        </p>
      </div>
    </div>
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
