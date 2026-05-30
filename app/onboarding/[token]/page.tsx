'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { toast } from 'sonner';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  CloudUpload,
  Eraser,
  Loader2,
  PartyPopper,
  Shield,
  Sparkles,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Toaster } from '@/components/ui/sonner';
import { cn } from '@/lib/utils';
import type { OnboardingPaymentMethod } from '@/lib/supabase/hr-onboarding-submissions';
import {
  AGREEMENT_TITLES,
  ContractWorkerText,
  NonSolicitationText,
  PrivacyText,
} from '@/components/onboarding/agreement-texts';

type PriorData = {
  full_name: string | null;
  phone: string | null;
  email: string | null;
  non_solicitation_signature: string | null;
  privacy_signature: string | null;
  w8ben_applicable: boolean | null;
  w8ben_file_name: string | null;
  payment_method: string | null;
  hurupay_email: string | null;
  bank_full_name: string | null;
  bank_account_name: string | null;
  bank_account_number: string | null;
  bank_swift_code: string | null;
  bank_street: string | null;
  bank_city: string | null;
  bank_province: string | null;
  bank_postal_code: string | null;
  bank_full_address: string | null;
  contract_signature: string | null;
  contract_date: string | null;
};

type LinkInfo = {
  id: string;
  status: 'pending' | 'submitted' | 'archived';
  invite_name: string | null;
  invite_personal_email: string | null;
  invite_department: string | null;
  invite_note: string | null;
  submitted_at: string | null;
  priorData?: PriorData | null;
};

type FormState = {
  first_name: string;
  last_name: string;
  phone: string;
  email: string;
  non_solicitation_signature: string;
  privacy_signature: string;
  w8ben_applicable: boolean | null; // null = not chosen yet
  w8ben_file_path: string | null;
  w8ben_file_name: string | null;
  payment_method: OnboardingPaymentMethod | null;
  hurupay_email: string;
  bank_full_name: string;
  bank_account_name: string;
  bank_account_number: string;
  bank_swift_code: string;
  bank_street: string;
  bank_city: string;
  bank_province: string;
  bank_postal_code: string;
  bank_full_address: string;
  contract_signature: string;
  contract_date: string;
};

const emptyForm: FormState = {
  first_name: '',
  last_name: '',
  phone: '',
  email: '',
  non_solicitation_signature: '',
  privacy_signature: '',
  w8ben_applicable: null,
  w8ben_file_path: null,
  w8ben_file_name: null,
  payment_method: null,
  hurupay_email: '',
  bank_full_name: '',
  bank_account_name: '',
  bank_account_number: '',
  bank_swift_code: '',
  bank_street: '',
  bank_city: '',
  bank_province: '',
  bank_postal_code: '',
  bank_full_address: '',
  contract_signature: '',
  contract_date: '',
};

const STEP_TITLES = [
  'Welcome',
  'Non-Solicitation',
  'Privacy Agreement',
  'W-8BEN Tax Form',
  'Payment Method',
  'Contract Worker Agreement',
] as const;

export default function OnboardingFormPage() {
  const params = useParams<{ token: string }>();
  const token = params?.token;

  const [link, setLink] = useState<LinkInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [step, setStep] = useState(0);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [reviewing, setReviewing] = useState(false);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/onboarding/${token}`, { cache: 'no-store' });
        const json = (await res.json()) as { row?: LinkInfo; error?: string };
        if (!res.ok || json.error) throw new Error(json.error ?? 'Failed to load');
        if (cancelled) return;
        setLink(json.row ?? null);
        const prior = json.row?.priorData;
        if (prior) {
          // Pre-fill from previous submission so the hire doesn't start from scratch.
          const nameTokens = (prior.full_name ?? '').trim().split(/\s+/).filter(Boolean);
          setForm({
            first_name: nameTokens[0] ?? '',
            last_name: nameTokens.slice(1).join(' '),
            phone: prior.phone ?? '',
            email: prior.email ?? '',
            non_solicitation_signature: prior.non_solicitation_signature ?? '',
            privacy_signature: prior.privacy_signature ?? '',
            w8ben_applicable: prior.w8ben_applicable ?? null,
            w8ben_file_path: null, // path is server-side; hire can re-upload if needed
            w8ben_file_name: prior.w8ben_file_name ?? null,
            payment_method: (prior.payment_method as FormState['payment_method']) ?? null,
            hurupay_email: prior.hurupay_email ?? '',
            bank_full_name: prior.bank_full_name ?? '',
            bank_account_name: prior.bank_account_name ?? '',
            bank_account_number: prior.bank_account_number ?? '',
            bank_swift_code: prior.bank_swift_code ?? '',
            bank_street: prior.bank_street ?? '',
            bank_city: prior.bank_city ?? '',
            bank_province: prior.bank_province ?? '',
            bank_postal_code: prior.bank_postal_code ?? '',
            bank_full_address: prior.bank_full_address ?? '',
            contract_signature: prior.contract_signature ?? '',
            contract_date: prior.contract_date ?? '',
          });
        } else {
          // New submission — seed invite fields as hints.
          if (json.row?.invite_name) {
            const tokens = (json.row.invite_name ?? '').trim().split(/\s+/).filter(Boolean);
            setForm((f) => ({ ...f, first_name: tokens[0] ?? '', last_name: tokens.slice(1).join(' ') }));
          }
          if (json.row?.invite_personal_email) {
            setForm((f) => ({
              ...f,
              email: json.row!.invite_personal_email ?? '',
              hurupay_email: json.row!.invite_personal_email ?? '',
            }));
          }
        }
        if (json.row?.status === 'submitted') {
          setSubmitted(true);
        }
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : 'Failed to load');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const update = useCallback(<K extends keyof FormState>(k: K, v: FormState[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
  }, []);

  const validateStep = useCallback((s: number): string | null => {
    switch (s) {
      case 0:
        if (!form.first_name.trim()) return 'Please enter your first name.';
        if (!form.last_name.trim()) return 'Please enter your last name.';
        if (!form.phone.trim()) return 'Please enter your phone number.';
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) return 'Please enter a valid email.';
        return null;
      case 1:
        if (!form.non_solicitation_signature) return 'Please sign the non-solicitation agreement.';
        return null;
      case 2:
        if (!form.privacy_signature) return 'Please sign the privacy agreement.';
        return null;
      case 3:
        if (form.w8ben_applicable === null) return 'Please indicate whether you are based outside the US.';
        if (form.w8ben_applicable && !form.w8ben_file_path) {
          return 'Please upload your completed W-8BEN form.';
        }
        return null;
      case 4:
        if (form.payment_method == null) return 'Please choose a payment method.';
        if (form.payment_method === 'hurupay') {
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.hurupay_email.trim())) {
            return 'Please enter the email for your Hurupay account.';
          }
        }
        if (form.payment_method === 'wires') {
          if (!form.bank_full_name.trim()) return 'Bank name is required for wire transfers.';
          if (!form.bank_account_name.trim()) return 'Name on account is required.';
          if (!form.bank_account_number.trim()) return 'Account number is required.';
          if (!form.bank_swift_code.trim()) return 'SWIFT code is required.';
          if (!form.bank_street.trim()) return 'Street is required.';
          if (!form.bank_city.trim()) return 'City is required.';
          if (!form.bank_province.trim()) return 'Province is required.';
          if (!form.bank_postal_code.trim()) return 'Postal code is required.';
          if (!form.bank_full_address.trim()) return 'Please re-enter your full address in one cell.';
        }
        return null;
      case 5:
        if (!form.contract_signature) return 'Please sign the contract worker agreement.';
        if (!form.contract_date) return 'Please enter the date of signature.';
        return null;
      default:
        return null;
    }
  }, [form]);

  const goNext = useCallback(() => {
    const err = validateStep(step);
    if (err) {
      toast.error(err);
      return;
    }
    setStep((s) => Math.min(STEP_TITLES.length - 1, s + 1));
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [step, validateStep]);

  const goPrev = useCallback(() => {
    setStep((s) => Math.max(0, s - 1));
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const submitForm = useCallback(async () => {
    for (let i = 0; i <= 5; i++) {
      const err = validateStep(i);
      if (err) {
        toast.error(err);
        setStep(i);
        return;
      }
    }
    setSubmitting(true);
    try {
      const res = await fetch(`/api/onboarding/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          full_name: [form.first_name.trim(), form.last_name.trim()].filter(Boolean).join(' '),
          phone: form.phone.trim(),
          email: form.email.trim(),
          non_solicitation_signature: form.non_solicitation_signature,
          privacy_signature: form.privacy_signature,
          w8ben_applicable: form.w8ben_applicable,
          w8ben_file_path: form.w8ben_file_path,
          w8ben_file_name: form.w8ben_file_name,
          payment_method: form.payment_method,
          hurupay_email: form.hurupay_email.trim() || null,
          bank_full_name: form.bank_full_name.trim() || null,
          bank_account_name: form.bank_account_name.trim() || null,
          bank_account_number: form.bank_account_number.trim() || null,
          bank_swift_code: form.bank_swift_code.trim() || null,
          bank_street: form.bank_street.trim() || null,
          bank_city: form.bank_city.trim() || null,
          bank_province: form.bank_province.trim() || null,
          bank_postal_code: form.bank_postal_code.trim() || null,
          bank_full_address: form.bank_full_address.trim() || null,
          contract_signature: form.contract_signature,
          contract_date: form.contract_date,
        }),
      });
      const json = (await res.json()) as { row?: { id: string }; error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Failed to submit');
      setSubmitted(true);
      setReviewing(false);
      toast.success(reviewing ? 'Your responses have been updated!' : 'Welcome aboard! Your onboarding form has been received.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to submit');
    } finally {
      setSubmitting(false);
    }
  }, [form, token, validateStep]);

  if (loading) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-gradient-to-br from-emerald-50 via-white to-teal-50">
        <Loader2 className="h-7 w-7 animate-spin text-emerald-600" />
      </main>
    );
  }

  if (loadError || !link) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-gradient-to-br from-emerald-50 via-white to-teal-50 px-4">
        <div className="max-w-sm rounded-2xl border border-rose-100 bg-white p-8 text-center shadow-sm">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-rose-100">
            <Shield className="h-6 w-6 text-rose-600" />
          </div>
          <h1 className="text-lg font-semibold text-zinc-900">Invalid onboarding link</h1>
          <p className="mt-2 text-sm text-zinc-600">
            {loadError ?? 'This onboarding link is no longer valid. Please reach out to HR.'}
          </p>
        </div>
      </main>
    );
  }

  if ((submitted || link.status === 'submitted') && !reviewing) {
    return (
      <SubmittedScreen
        submittedAt={link.submitted_at}
        hasPriorData={!!link.priorData}
        onReview={() => { setReviewing(true); setStep(0); }}
      />
    );
  }

  const progressPct = Math.round(((step + 1) / STEP_TITLES.length) * 100);

  return (
    <main className="min-h-dvh bg-gradient-to-br from-sky-50 via-white to-emerald-50 px-3 py-6 sm:px-6 sm:py-10">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
        {/* Brand header */}
        <header className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-500 to-teal-700 text-white shadow-md shadow-emerald-600/25">
              <Sparkles className="h-5 w-5" />
            </div>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-emerald-700/80">
                Simple.biz onboarding
              </p>
              <h1 className="text-base font-semibold text-zinc-900">
                {link.invite_name ? `Welcome, ${link.invite_name.split(/\s+/)[0]}!` : 'Welcome!'}
              </h1>
            </div>
          </div>
          <div className="hidden text-right sm:block">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
              Step {step + 1} of {STEP_TITLES.length}
            </p>
            <p className="text-sm font-semibold text-zinc-700">{STEP_TITLES[step]}</p>
          </div>
        </header>

        {/* Progress bar */}
        <div className="overflow-hidden rounded-full border border-emerald-100 bg-white p-1 shadow-sm">
          <div className="relative h-3 overflow-hidden rounded-full bg-zinc-100">
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-emerald-500 via-teal-500 to-emerald-600 transition-all duration-500"
              style={{ width: `${progressPct}%` }}
            />
            <span className="absolute inset-0 flex items-center justify-center text-[10px] font-bold text-zinc-700 mix-blend-luminosity">
              {progressPct}% Complete
            </span>
          </div>
        </div>

        {/* Step content card */}
        <section className="overflow-hidden rounded-2xl border border-emerald-100/80 bg-white shadow-md ring-1 ring-emerald-500/5">
          {step === 0 && <Step1Welcome form={form} update={update} link={link} />}
          {step === 1 && <Step2NonSolicitation form={form} update={update} />}
          {step === 2 && <Step3Privacy form={form} update={update} />}
          {step === 3 && <Step4W8Ben token={token!} form={form} update={update} />}
          {step === 4 && <Step5Payment form={form} update={update} />}
          {step === 5 && <Step6Contract form={form} update={update} />}
        </section>

        {/* Footer with prev/next */}
        <footer className="flex items-center justify-between gap-3 rounded-xl border border-emerald-100/70 bg-white/80 px-3 py-2.5 shadow-sm backdrop-blur-sm">
          <Button
            type="button"
            variant="outline"
            className="border-emerald-200 text-emerald-800 disabled:opacity-40"
            onClick={goPrev}
            disabled={step === 0 || submitting}
          >
            <ArrowLeft className="mr-1.5 h-4 w-4" />
            Previous
          </Button>

          <p className="text-[11px] text-zinc-400 sm:hidden">
            {step + 1}/{STEP_TITLES.length}
          </p>

          {step < STEP_TITLES.length - 1 ? (
            <Button
              type="button"
              className="bg-gradient-to-r from-emerald-500 to-teal-700 text-white shadow-md shadow-emerald-600/25 hover:opacity-95"
              onClick={goNext}
              disabled={submitting}
            >
              Next
              <ArrowRight className="ml-1.5 h-4 w-4" />
            </Button>
          ) : (
            <Button
              type="button"
              className="bg-gradient-to-r from-emerald-500 to-teal-700 text-white shadow-md shadow-emerald-600/25 hover:opacity-95"
              onClick={submitForm}
              disabled={submitting}
            >
              {submitting ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <Check className="mr-1.5 h-4 w-4" />
              )}
              Submit
            </Button>
          )}
        </footer>

        <p className="text-center text-[10px] text-zinc-400">
          Need help? Email <a href="mailto:hr@simple.biz" className="text-emerald-700 hover:underline">hr@simple.biz</a>.
        </p>
      </div>

      <Toaster richColors position="top-center" />
    </main>
  );
}

// ─── Step 1 — Welcome / Personal info ──────────────────────────────────────

function Step1Welcome({
  form,
  update,
  link,
}: {
  form: FormState;
  update: <K extends keyof FormState>(k: K, v: FormState[K]) => void;
  link: LinkInfo;
}) {
  return (
    <div className="space-y-6 p-5 sm:p-7">
      <div>
        <h2 className="text-xl font-bold text-zinc-900">Hello and welcome to Simple.biz!</h2>
        <p className="mt-1.5 text-sm leading-relaxed text-zinc-600">
          Please review the documents in the next steps, and provide the following
          information so we can enter you into our accounting system.
        </p>
        {link.invite_note && (
          <p className="mt-3 rounded-lg border border-emerald-100 bg-emerald-50/60 px-3 py-2 text-xs text-emerald-900">
            <strong>From HR:</strong> {link.invite_note}
          </p>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="First name" required>
          <Input
            value={form.first_name ?? ''}
            onChange={(e) => update('first_name', e.target.value)}
            placeholder="Jane"
            autoComplete="given-name"
            autoFocus
          />
        </Field>
        <Field label="Last name" required>
          <Input
            value={form.last_name ?? ''}
            onChange={(e) => update('last_name', e.target.value)}
            placeholder="Dela Cruz"
            autoComplete="family-name"
          />
        </Field>
        <Field label="Phone Number" required>
          <Input
            value={form.phone ?? ''}
            onChange={(e) => update('phone', e.target.value)}
            placeholder="+63 9XX XXX XXXX"
            inputMode="tel"
            autoComplete="tel"
          />
        </Field>
        <Field label="Email" required>
          <Input
            type="email"
            value={form.email ?? ''}
            onChange={(e) => update('email', e.target.value)}
            placeholder="you@example.com"
            autoComplete="email"
          />
        </Field>
      </div>

      <div className="rounded-xl border border-zinc-100 bg-zinc-50/60 p-4">
        <h3 className="text-sm font-semibold text-zinc-800">Pay Structure</h3>
        <p className="mt-1 text-xs leading-relaxed text-zinc-600">
          You will be paid weekly for the work completed the previous week, according
          to the pay plan emailed to you. While we process payments weekly, please note
          that international wires typically take 2-5 business days, depending on your
          bank. As an alternative, we also offer <strong>Hurupay</strong> which is faster
          for receiving your pay.{' '}
          <span className="rounded bg-yellow-100 px-1.5 py-0.5 font-semibold text-yellow-900">
            Please complete the form indicating your preferred payment method.
          </span>{' '}
          If you have any questions regarding your pay or have questions about Hurupay,
          Fran in our accounting department is available at{' '}
          <a href="mailto:payroll@simple.biz" className="text-emerald-700 hover:underline">
            payroll@simple.biz
          </a>{' '}
          and she will be happy to assist you.
        </p>
      </div>

      <div className="rounded-xl border border-amber-200 bg-amber-50/50 p-4">
        <h3 className="inline-block rounded bg-yellow-200 px-1.5 py-0.5 text-sm font-semibold text-yellow-900">
          Hurupay
        </h3>
        <p className="mt-2 text-xs leading-relaxed text-zinc-700">
          Please download the Hurupay app on your phone and create your account at{' '}
          <a
            href="https://hurupay.com"
            target="_blank"
            rel="noopener noreferrer"
            className="font-semibold text-emerald-700 hover:underline"
          >
            hurupay.com
          </a>
          .
        </p>
        <ol className="mt-3 list-decimal space-y-1 pl-5 text-xs text-zinc-700">
          <li>Create a Hurupay account with your <strong>personal email</strong> (not your work email).</li>
          <li>Secure it with a 6-digit PIN (and optionally add 2FA for enhanced security).</li>
          <li>
            Share your email address(es) linked with your Hurupay account and your complete
            personal address with zipcode for payroll purposes to{' '}
            <a href="mailto:payroll@simple.biz" className="text-emerald-700 hover:underline">
              payroll@simple.biz
            </a>
            .
          </li>
          <li>You can link your preferred bank to receive funds.</li>
        </ol>
        <p className="mt-3 text-[11px] italic leading-relaxed text-zinc-500">
          <strong>Important note:</strong> KYC verification is only required for users who need
          a US bank account number and routing number for personal use cases, such as receiving
          ACH transfers or wire payments.
        </p>
      </div>
    </div>
  );
}

// ─── Step 2 — Non-Solicitation ─────────────────────────────────────────────

function Step2NonSolicitation({
  form,
  update,
}: {
  form: FormState;
  update: <K extends keyof FormState>(k: K, v: FormState[K]) => void;
}) {
  return (
    <div className="space-y-5 p-5 sm:p-7">
      <div>
        <h2 className="text-xl font-bold text-zinc-900">{AGREEMENT_TITLES.nonSolicitation}</h2>
      </div>
      <NonSolicitationText />

      <Field label="Please sign here to indicate that you agree to the above" required>
        <SignaturePad
          value={form.non_solicitation_signature}
          onChange={(v) => update('non_solicitation_signature', v)}
        />
      </Field>
    </div>
  );
}

// ─── Step 3 — Privacy Agreement ────────────────────────────────────────────

function Step3Privacy({
  form,
  update,
}: {
  form: FormState;
  update: <K extends keyof FormState>(k: K, v: FormState[K]) => void;
}) {
  return (
    <div className="space-y-5 p-5 sm:p-7">
      <div>
        <h2 className="text-xl font-bold text-zinc-900">{AGREEMENT_TITLES.privacy}</h2>
      </div>
      <PrivacyText />

      <Field
        label='Please sign here to indicate that you agree to exclude mention of "Simple.biz" by name on all social media'
        required
      >
        <SignaturePad
          value={form.privacy_signature}
          onChange={(v) => update('privacy_signature', v)}
        />
      </Field>
    </div>
  );
}

// ─── Step 4 — W-8BEN ───────────────────────────────────────────────────────

function Step4W8Ben({
  token,
  form,
  update,
}: {
  token: string;
  form: FormState;
  update: <K extends keyof FormState>(k: K, v: FormState[K]) => void;
}) {
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  async function handleFile(file: File) {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch(`/api/onboarding/${token}/w8ben`, {
        method: 'POST',
        body: fd,
      });
      const json = (await res.json()) as { path?: string; name?: string; error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Upload failed');
      update('w8ben_file_path', json.path ?? null);
      update('w8ben_file_name', json.name ?? file.name);
      toast.success('W-8BEN uploaded.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="space-y-5 p-5 sm:p-7">
      <div>
        <h2 className="text-xl font-bold text-zinc-900">W-8BEN Tax Form</h2>
      </div>

      <p className="text-sm leading-relaxed text-zinc-700">
        We are now required to have a <strong>W-8BEN form</strong> on file for all contract
        workers located outside of the US.
      </p>
      <p className="text-sm leading-relaxed text-zinc-700">
        Please note that this information is collected solely for internal recordkeeping and
        does not impact your personal tax obligations. As an independent contractor, no taxes
        are withheld from your payments, and any applicable taxes would be handled directly
        between you and the tax authorities in your country of residence.
      </p>
      <p className="text-sm leading-relaxed text-zinc-700">
        You can access the W-8BEN form here:{' '}
        <a
          href="https://www.irs.gov/forms-pubs/about-form-w-8-ben"
          target="_blank"
          rel="noopener noreferrer"
          className="font-semibold text-emerald-700 hover:underline"
        >
          IRS W-8BEN Form
        </a>
        . Please complete all required fields, download your filled form, and upload it
        directly below.
      </p>

      <Field label="Are you based outside of the United States?" required>
        <div className="flex flex-wrap gap-2">
          <ChoiceChip
            active={form.w8ben_applicable === true}
            onClick={() => update('w8ben_applicable', true)}
            label="Yes — I'm outside the US"
          />
          <ChoiceChip
            active={form.w8ben_applicable === false}
            onClick={() => {
              update('w8ben_applicable', false);
              update('w8ben_file_path', null);
              update('w8ben_file_name', null);
            }}
            label="No — I'm US-based"
          />
        </div>
      </Field>

      {form.w8ben_applicable && (
        <Field label="Upload your completed W-8BEN form" required>
          <div className="space-y-2">
            <input
              ref={fileRef}
              type="file"
              accept=".pdf,application/pdf,image/png,image/jpeg"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleFile(f);
              }}
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
              className={cn(
                'flex w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-emerald-300 bg-emerald-50/40 px-6 py-8 text-center transition-colors hover:border-emerald-400 hover:bg-emerald-50',
                uploading && 'opacity-60',
              )}
            >
              {uploading ? (
                <Loader2 className="h-7 w-7 animate-spin text-emerald-600" />
              ) : (
                <CloudUpload className="h-7 w-7 text-emerald-600" />
              )}
              <div className="text-sm">
                <p className="font-semibold text-emerald-900">
                  {form.w8ben_file_name ? 'Replace file' : 'Choose file or drag and drop'}
                </p>
                <p className="text-[11px] text-zinc-500">PDF, PNG or JPG — up to 10 MB.</p>
              </div>
            </button>
            {form.w8ben_file_name && (
              <div className="flex items-center gap-2 rounded-lg border border-emerald-100 bg-emerald-50/50 px-3 py-2 text-xs">
                <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
                <span className="truncate text-emerald-900">{form.w8ben_file_name}</span>
              </div>
            )}
          </div>
        </Field>
      )}
    </div>
  );
}

// ─── Step 5 — Payment Method + Wires ───────────────────────────────────────

function Step5Payment({
  form,
  update,
}: {
  form: FormState;
  update: <K extends keyof FormState>(k: K, v: FormState[K]) => void;
}) {
  return (
    <div className="space-y-5 p-5 sm:p-7">
      <div>
        <h2 className="text-xl font-bold text-zinc-900">How would you like to be paid?</h2>
        <p className="mt-1 text-sm text-zinc-600">
          We support Hurupay and international wire transfers.
        </p>
      </div>

      <Field label="Preferred payment method" required>
        <div className="grid gap-3 sm:grid-cols-2">
          <ChoiceCard
            active={form.payment_method === 'hurupay'}
            onClick={() => update('payment_method', 'hurupay')}
            title="Hurupay"
            description="Faster — set it up via the Hurupay app and email payroll@simple.biz."
          />
          <ChoiceCard
            active={form.payment_method === 'wires'}
            onClick={() => update('payment_method', 'wires')}
            title="Wire Transfer"
            description="Provide your bank details below. 2-5 business days per transfer."
          />
        </div>
      </Field>

      {form.payment_method === 'hurupay' && (
        <div className="space-y-3 rounded-xl border border-amber-200 bg-amber-50/40 p-4">
          <div>
            <h3 className="inline-block rounded bg-yellow-200 px-1.5 py-0.5 text-sm font-semibold text-yellow-900">
              Hurupay
            </h3>
            <p className="mt-2 text-xs leading-relaxed text-zinc-700">
              Enter the email tied to your Hurupay account. We have suggested your
              personal email, but you can change it to whichever email your Hurupay
              account uses.
            </p>
          </div>
          <Field label="Hurupay account email" required>
            <Input
              type="email"
              value={form.hurupay_email}
              onChange={(e) => update('hurupay_email', e.target.value)}
              placeholder={form.email || 'you@example.com'}
              autoComplete="email"
            />
          </Field>
        </div>
      )}

      {form.payment_method === 'wires' && (
        <div className="space-y-5 rounded-xl border border-amber-200 bg-amber-50/40 p-4">
          <div>
            <h3 className="inline-block rounded bg-yellow-200 px-1.5 py-0.5 text-sm font-semibold text-yellow-900">
              Wires
            </h3>
            <p className="mt-2 text-xs leading-relaxed text-zinc-700">
              If you don't have a Hurupay account, we can send a wire transfer instead. To set this
              up, please send us your wire transfer details. Please ensure all information is accurate
              and complete. Incomplete or incorrect details may cause delays in processing your payment.
              We recommend double-checking all information before submitting to ensure timely processing.
            </p>
            <p className="mt-2 text-xs font-semibold text-zinc-800">
              Please avoid initials. For example: there are multiple banks named BDO — we need to know
              exactly which bank is yours.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Full Name of Bank" required>
              <Input
                value={form.bank_full_name}
                onChange={(e) => update('bank_full_name', e.target.value)}
                placeholder="e.g. Banco de Oro Unibank, Inc."
              />
            </Field>
            <Field label="Name on account" required>
              <Input
                value={form.bank_account_name}
                onChange={(e) => update('bank_account_name', e.target.value)}
                placeholder="Account holder full name"
              />
            </Field>
            <Field label="Account Number" required>
              <Input
                value={form.bank_account_number}
                onChange={(e) => update('bank_account_number', e.target.value)}
                placeholder="0123 4567 8901"
                inputMode="numeric"
              />
            </Field>
            <Field label="SWIFT Code" required>
              <Input
                value={form.bank_swift_code}
                onChange={(e) => update('bank_swift_code', e.target.value)}
                placeholder="BNORPHMM"
              />
            </Field>
          </div>

          <div>
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              Personal address
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Street" required>
                <Input
                  value={form.bank_street}
                  onChange={(e) => update('bank_street', e.target.value)}
                  placeholder="123 Main St"
                />
              </Field>
              <Field label="City" required>
                <Input
                  value={form.bank_city}
                  onChange={(e) => update('bank_city', e.target.value)}
                  placeholder="Quezon City"
                />
              </Field>
              <Field label="Province" required>
                <Input
                  value={form.bank_province}
                  onChange={(e) => update('bank_province', e.target.value)}
                  placeholder="Metro Manila"
                />
              </Field>
              <Field label="Postal Code" required>
                <Input
                  value={form.bank_postal_code}
                  onChange={(e) => update('bank_postal_code', e.target.value)}
                  placeholder="1100"
                />
              </Field>
            </div>
          </div>

          <Field
            label="Please re-enter FULL (Street, City, Province and Postal Code) personal address here, in one cell"
            required
          >
            <textarea
              value={form.bank_full_address}
              onChange={(e) => update('bank_full_address', e.target.value)}
              placeholder="123 Main St, Quezon City, Metro Manila 1100"
              rows={2}
              style={{ color: "#000" }}
              className="w-full rounded-lg border border-zinc-300 bg-transparent px-2.5 py-1.5 text-sm !text-black outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:border-input dark:bg-input/30"
            />
          </Field>

          <p className="rounded-lg border border-emerald-100 bg-emerald-50/50 px-3 py-2 text-xs text-emerald-900">
            <strong>Again, welcome to the Simple.biz family!</strong> We look forward to working
            with you.
          </p>
        </div>
      )}
    </div>
  );
}

// ─── Step 6 — Contract Worker Agreement ────────────────────────────────────

function Step6Contract({
  form,
  update,
}: {
  form: FormState;
  update: <K extends keyof FormState>(k: K, v: FormState[K]) => void;
}) {
  return (
    <div className="space-y-5 p-5 sm:p-7">
      <div>
        <h2 className="text-xl font-bold text-zinc-900">{AGREEMENT_TITLES.contract}</h2>
      </div>

      <ContractWorkerText />

      <Field
        label="My signature below indicates that I have read and understood this Agreement in its entirety"
        required
      >
        <SignaturePad
          value={form.contract_signature}
          onChange={(v) => update('contract_signature', v)}
        />
      </Field>

      <Field label="Date of Signature" required className="max-w-xs">
        <Input
          type="date"
          value={form.contract_date}
          onChange={(e) => update('contract_date', e.target.value)}
        />
      </Field>
    </div>
  );
}

// ─── Shared field wrapper ─────────────────────────────────────────────────

function Field({
  label,
  required,
  children,
  className,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <Label className="text-xs font-semibold text-zinc-800">
        {label}
        {required && <span className="ml-0.5 text-rose-500">*</span>}
      </Label>
      {children}
    </div>
  );
}

function ChoiceChip({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-lg border px-3.5 py-2 text-sm font-medium transition-all',
        active
          ? 'border-emerald-500 bg-emerald-50 text-emerald-900 ring-2 ring-emerald-500/30'
          : 'border-zinc-200 bg-white text-zinc-700 hover:border-emerald-200 hover:bg-emerald-50/40',
      )}
    >
      {label}
    </button>
  );
}

function ChoiceCard({
  active,
  onClick,
  title,
  description,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  description: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group rounded-xl border p-4 text-left transition-all',
        active
          ? 'border-emerald-500 bg-emerald-50 ring-2 ring-emerald-500/30'
          : 'border-zinc-200 bg-white hover:border-emerald-200 hover:bg-emerald-50/40',
      )}
    >
      <div className="flex items-center gap-2">
        <div
          className={cn(
            'flex h-5 w-5 items-center justify-center rounded-full border transition-all',
            active ? 'border-emerald-600 bg-emerald-600 text-white' : 'border-zinc-300 bg-white',
          )}
        >
          {active && <Check className="h-3 w-3" />}
        </div>
        <p className="text-sm font-semibold text-zinc-900">{title}</p>
      </div>
      <p className="mt-1.5 text-xs leading-relaxed text-zinc-600">{description}</p>
    </button>
  );
}

// ─── Signature pad (HTML5 canvas) ─────────────────────────────────────────

function SignaturePad({
  value,
  onChange,
}: {
  value: string;
  onChange: (dataUrl: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawingRef = useRef(false);
  const lastRef = useRef<{ x: number; y: number } | null>(null);
  const [hasInk, setHasInk] = useState<boolean>(Boolean(value));

  // Set up canvas with HiDPI support.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const ratio = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * ratio;
    canvas.height = rect.height * ratio;
    ctx.scale(ratio, ratio);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#0f172a';

    // If we already have a stored data URL (resumed mid-form), restore it.
    if (value) {
      const img = new Image();
      img.onload = () => {
        ctx.clearRect(0, 0, rect.width, rect.height);
        ctx.drawImage(img, 0, 0, rect.width, rect.height);
      };
      img.src = value;
    }
    // We only want to do this once on mount per pad — the resize handler below
    // would otherwise wipe the canvas on every layout shift.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const getPos = (e: PointerEvent | React.PointerEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return { x: (e as PointerEvent).clientX - rect.left, y: (e as PointerEvent).clientY - rect.top };
  };

  const onDown: React.PointerEventHandler<HTMLCanvasElement> = (e) => {
    e.preventDefault();
    drawingRef.current = true;
    lastRef.current = getPos(e);
    setHasInk(true);
  };

  const onMove: React.PointerEventHandler<HTMLCanvasElement> = (e) => {
    if (!drawingRef.current) return;
    e.preventDefault();
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!ctx || !canvas) return;
    const pos = getPos(e);
    const last = lastRef.current ?? pos;
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(pos.x, pos.y);
    ctx.stroke();
    lastRef.current = pos;
  };

  const onUp = () => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    lastRef.current = null;
    const canvas = canvasRef.current;
    if (canvas) onChange(canvas.toDataURL('image/png'));
  };

  const clear = () => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!ctx || !canvas) return;
    const rect = canvas.getBoundingClientRect();
    ctx.clearRect(0, 0, rect.width, rect.height);
    setHasInk(false);
    onChange('');
  };

  return (
    <div className="relative">
      <div className="rounded-xl border border-zinc-300 bg-white p-2 shadow-inner">
        <canvas
          ref={canvasRef}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerLeave={onUp}
          className="h-40 w-full touch-none rounded-lg bg-white"
          style={{ touchAction: 'none' }}
        />
        <div className="mx-3 -mt-2 border-b border-zinc-400/70" aria-hidden />
      </div>
      <div className="mt-1.5 flex items-center justify-between text-[11px] text-zinc-500">
        <span>{hasInk ? 'Signed — looks good!' : 'Draw your signature inside the box.'}</span>
        <button
          type="button"
          onClick={clear}
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium text-emerald-700 hover:bg-emerald-50"
        >
          <Eraser className="h-3 w-3" /> clear
        </button>
      </div>
    </div>
  );
}

// ─── Submitted screen ─────────────────────────────────────────────────────

function SubmittedScreen({
  submittedAt,
  hasPriorData,
  onReview,
}: {
  submittedAt: string | null;
  hasPriorData: boolean;
  onReview: () => void;
}) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-gradient-to-br from-emerald-50 via-white to-teal-50 px-4 py-10">
      <div className="w-full max-w-md rounded-2xl border border-emerald-100 bg-white p-8 text-center shadow-md">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-700 text-white shadow-md shadow-emerald-600/25">
          <PartyPopper className="h-7 w-7" />
        </div>
        <h1 className="text-xl font-bold text-zinc-900">You're all set!</h1>
        <p className="mt-2 text-sm leading-relaxed text-zinc-600">
          Thank you for submitting your onboarding form. HR has been notified and will be in touch
          shortly with next steps.
        </p>
        {submittedAt && (
          <p className="mt-4 text-[11px] uppercase tracking-wider text-zinc-400">
            Submitted {new Date(submittedAt).toLocaleString()}
          </p>
        )}
        <p className="mt-6 rounded-lg border border-emerald-100 bg-emerald-50/60 px-3 py-2 text-xs text-emerald-900">
          Welcome to the Simple.biz family — we look forward to working with you!
        </p>
        {hasPriorData && (
          <button
            type="button"
            onClick={onReview}
            className="mt-5 inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-4 py-2 text-sm font-medium text-zinc-600 shadow-sm transition-colors hover:border-emerald-300 hover:bg-emerald-50 hover:text-emerald-800"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
            Review / update my responses
          </button>
        )}
      </div>
      <Toaster richColors position="top-center" />
    </main>
  );
}
