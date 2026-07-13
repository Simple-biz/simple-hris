'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { toast } from 'sonner';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CloudUpload,
  Eraser,
  FileText,
  Headset,
  Loader2,
  PartyPopper,
  Shield,
  Sparkles,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DatePicker } from '@/components/ui/date-picker';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Toaster } from '@/components/ui/sonner';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { cn } from '@/lib/utils';
import type { OnboardingPaymentMethod } from '@/lib/supabase/hr-onboarding-submissions';
import {
  AGREEMENT_TITLES,
  ContractWorkerText,
  IntellectualPropertyText,
  NonSolicitationText,
  PrivacyText,
} from '@/components/onboarding/agreement-texts';
import {
  IP_ASSIGNMENT_ACKNOWLEDGEMENT,
  formatLongDate,
  todayLocalIso,
} from '@/lib/onboarding/ip-assignment-text';
import { ONBOARDING_COUNTRIES, currencyForCountry } from '@/lib/onboarding/countries';
import { toTitleCaseName } from '@/lib/text/sanitize-name';
import { NAME_EXTENSIONS } from '@/lib/hr/work-email';
import { calltoolsUsernameCandidates, isLeadGenDepartment } from '@/lib/hr/calltools-username';

type PriorData = {
  full_name: string | null;
  gmail_surname: string | null;
  /** Lead Gen only. The minted calltools_username is deliberately NOT returned
   *  to the paperwork — it's internal to HR and re-minted on re-submit. */
  calltools_nickname: string | null;
  phone: string | null;
  email: string | null;
  location: string | null;
  country: string | null;
  address_street: string | null;
  address_city: string | null;
  address_state: string | null;
  address_province: string | null;
  address_region: string | null;
  address_postal_code: string | null;
  ip_agreement_agreed: boolean | null;
  ip_agreement_name: string | null;
  ip_agreement_signature: string | null;
  ip_agreement_date: string | null;
  non_solicitation_signature: string | null;
  privacy_signature: string | null;
  w8ben_applicable: boolean | null;
  w8ben_file_name: string | null;
  payment_method: string | null;
  hurupay_email: string | null;
  bank_full_name: string | null;
  bank_account_name: string | null;
  // bank_account_number and bank_swift_code are NOT returned by the API
  // (stripped server-side to avoid exposing credentials via the public token URL).
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
  /** For most departments: a read-only display name mirrored from
   *  {@link first_name}. When the hire has more than one first name (e.g.
   *  "Mary Grace"), this holds whichever one they stepped to with the arrow
   *  buttons, defaulting to the first, and it is NOT part of the submit payload.
   *  For LEAD GEN hires the field is editable instead — the hire types how they
   *  want to be called on the CallTools dialer, it feeds
   *  {@link calltools_username}, and it IS submitted (calltools_nickname). */
  nickname: string;
  /** Lead Gen only: read-only auto-minted CallTools dialer username —
   *  `<Nickname> <first initial>. <surname slice>.` (e.g. "Mikey J. T."), the
   *  slice lengthening until unique (mirrors the Gmail Surname rule). Empty for
   *  every other department. */
  calltools_username: string;
  last_name: string;
  /** Optional name extension / generational suffix (Jr., Sr., II, III, IV) shown
   *  beside the last name. Folded into the stored full_name for HR + contracts,
   *  but NEVER sent to the workspace-account automation (that webhook only ever
   *  gets the first-name token + the work-email-derived gmail_surname). */
  extension: string;
  /** Surname used for the @simple.biz Google (Gmail) account — sent to the
   *  workspace-account webhook in place of the legal last name. */
  gmail_surname: string;
  phone: string;
  email: string;
  country: string;
  address_street: string;
  address_city: string;
  address_state: string;
  address_province: string;
  address_region: string;
  address_postal_code: string;
  ip_agreement_agreed: boolean;
  ip_agreement_name: string;
  ip_agreement_signature: string;
  ip_agreement_date: string; // ISO yyyy-mm-dd, stamped on load
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
  nickname: '',
  calltools_username: '',
  last_name: '',
  extension: '',
  gmail_surname: '',
  phone: '',
  email: '',
  country: '',
  address_street: '',
  address_city: '',
  address_state: '',
  address_province: '',
  address_region: '',
  address_postal_code: '',
  ip_agreement_agreed: false,
  ip_agreement_name: '',
  ip_agreement_signature: '',
  ip_agreement_date: '',
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

/** Split a full name into first / last / extension, peeling a trailing
 *  generational suffix (the shared {@link NAME_EXTENSIONS} set) into its own
 *  "Extension" box so re-editing a submission shows the suffix there instead of
 *  glued onto the last name. Only peels when at least three tokens remain
 *  (first + last + suffix), so a two-token name is never left without a last
 *  name. Unlike work-email's splitFullName, `last` here is the WHOLE last name
 *  ("Dela Cruz"), since it backs the form's last-name field. */
function splitName(full: string | null | undefined): {
  first: string;
  last: string;
  extension: string;
} {
  const tokens = (full ?? '').trim().split(/\s+/).filter(Boolean);
  let extension = '';
  if (tokens.length >= 3 && NAME_EXTENSIONS.has((tokens[tokens.length - 1] ?? '').toLowerCase())) {
    extension = tokens.pop() ?? '';
  }
  return { first: tokens[0] ?? '', last: tokens.slice(1).join(' '), extension };
}

const STEP_TITLES = [
  'Intellectual Property',
  'Welcome',
  'Non-Solicitation',
  'Privacy Agreement',
  'W-8BEN Tax Form',
  'Payment Method',
  'Contract Worker Agreement',
] as const;

// Directional slide+fade for step navigation. `direction` is +1 going forward
// (Next) and -1 going back (Previous): the incoming step enters from the side
// you're heading toward, the outgoing step leaves the opposite way.
const STEP_VARIANTS = {
  enter: (dir: number) => ({ opacity: 0, x: dir >= 0 ? 44 : -44 }),
  center: { opacity: 1, x: 0 },
  exit: (dir: number) => ({ opacity: 0, x: dir >= 0 ? -44 : 44 }),
};

export default function OnboardingFormPage() {
  const params = useParams<{ token: string }>();
  const token = params?.token;
  // Reserved token that renders the form as a no-save preview so HR can see
  // exactly what the onboarding paperwork looks like (linked from HR > Onboarding).
  // Real invite tokens are long random strings, so this never collides.
  const isPreview = token === 'preview';

  const [link, setLink] = useState<LinkInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [step, setStep] = useState(0);
  // +1 when moving forward, -1 when moving back — drives the slide direction.
  const [direction, setDirection] = useState(0);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  // True while the Gmail-surname lookup is in flight (debounce + request) — drives
  // the inline "searching Google Workspace" indicator on the read-only field.
  const [surnameLoading, setSurnameLoading] = useState(false);
  // Same, for the CallTools-username lookup on the Lead Gen Welcome step.
  const [calltoolsLoading, setCalltoolsLoading] = useState(false);
  // Preview-only: lets HR flip the sample form into the Lead Gen experience
  // (editable nickname + auto-minted CallTools username) to test it. Real links
  // get Lead Gen behaviour from their invite_department instead.
  const [previewLeadGen, setPreviewLeadGen] = useState(false);

  // Lead Gen hires choose their own dialer nickname and get a CallTools
  // username minted from it; everyone else keeps the mirrored read-only
  // Nickname. Driven by the invite's department — or the Lead Gen switch in
  // preview, where there is no invite.
  const isLeadGen = isPreview
    ? previewLeadGen
    : isLeadGenDepartment(link?.invite_department);

  // Preview-only: flip the sample form between the standard and the Lead Gen
  // experience. Shared by the banner pill and the Welcome-step switch.
  // Entering Lead Gen blanks the mirrored nickname so the tester types their
  // own (the real Lead Gen behaviour); leaving re-mirrors it from the first
  // name automatically.
  const setPreviewLeadGenMode = useCallback((next: boolean) => {
    setPreviewLeadGen(next);
    if (next) setForm((f) => ({ ...f, nickname: '', calltools_username: '' }));
  }, []);

  // Honour the OS "reduce motion" setting — fall back to a plain cross-fade.
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    if (!token) return;
    // Preview mode: skip the API entirely and render an empty sample form.
    if (isPreview) {
      setLink({
        id: 'preview',
        status: 'pending',
        invite_name: null,
        invite_personal_email: null,
        invite_department: null,
        invite_note: null,
        submitted_at: null,
        priorData: null,
      });
      setLoading(false);
      return;
    }
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
          const priorName = splitName(prior.full_name);
          // A Lead Gen hire's nickname is their own typed dialer name — restore
          // it from the stored value, never from the first name.
          const leadGen = isLeadGenDepartment(json.row?.invite_department);
          setForm({
            first_name: priorName.first,
            nickname: leadGen ? prior.calltools_nickname ?? '' : priorName.first,
            calltools_username: '', // preview-only display value; never prefilled
            last_name: priorName.last,
            extension: priorName.extension,
            gmail_surname: prior.gmail_surname ?? '',
            phone: prior.phone ?? '',
            email: prior.email ?? '',
            country: prior.country ?? '',
            // Prefer the structured parts; fall back to the legacy combined
            // `location` (dropped into Street) so old submissions aren't lost.
            address_street: prior.address_street ?? (prior.address_city ? '' : prior.location ?? ''),
            address_city: prior.address_city ?? '',
            address_state: prior.address_state ?? '',
            address_province: prior.address_province ?? '',
            address_region: prior.address_region ?? '',
            address_postal_code: prior.address_postal_code ?? '',
            ip_agreement_agreed: prior.ip_agreement_agreed ?? false,
            ip_agreement_name: prior.ip_agreement_name ?? prior.full_name ?? '',
            ip_agreement_signature: prior.ip_agreement_signature ?? '',
            ip_agreement_date: prior.ip_agreement_date ?? todayLocalIso(),
            non_solicitation_signature: prior.non_solicitation_signature ?? '',
            privacy_signature: prior.privacy_signature ?? '',
            w8ben_applicable: prior.w8ben_applicable ?? null,
            // '__existing__' signals that a file was already uploaded server-side.
            // Validation accepts it, and the submit payload omits both file fields
            // so the server keeps the stored path instead of overwriting with null.
            w8ben_file_path: prior.w8ben_file_name ? '__existing__' : null,
            w8ben_file_name: prior.w8ben_file_name ?? null,
            payment_method: (prior.payment_method as FormState['payment_method']) ?? null,
            hurupay_email: prior.hurupay_email ?? '',
            bank_full_name: prior.bank_full_name ?? '',
            bank_account_name: prior.bank_account_name ?? '',
            bank_account_number: '',
            bank_swift_code: '',
            bank_street: prior.bank_street ?? '',
            bank_city: prior.bank_city ?? '',
            bank_province: prior.bank_province ?? '',
            bank_postal_code: prior.bank_postal_code ?? '',
            bank_full_address: prior.bank_full_address ?? '',
            contract_signature: prior.contract_signature ?? '',
            contract_date: prior.contract_date ?? '',
          });
        } else {
          // New submission — seed invite fields as hints. A Lead Gen hire's
          // nickname stays blank on purpose: they type their own dialer name.
          if (json.row?.invite_name) {
            const inviteName = splitName(json.row.invite_name);
            setForm((f) => ({
              ...f,
              first_name: inviteName.first,
              nickname: isLeadGenDepartment(json.row?.invite_department) ? '' : inviteName.first,
              last_name: inviteName.last,
              extension: inviteName.extension,
              // Pre-fill the IP document's name from the invite too.
              ip_agreement_name: f.ip_agreement_name || (json.row!.invite_name ?? ''),
            }));
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
  }, [token, isPreview]);

  // Stamp the IP agreement with the local day the link was opened — client-side
  // (in an effect) so it reflects the hire's timezone, never the server's UTC
  // day. Only fills when empty, so a prior-submitted date is preserved.
  useEffect(() => {
    setForm((f) => (f.ip_agreement_date ? f : { ...f, ip_agreement_date: todayLocalIso() }));
  }, []);

  // Auto-derive the read-only "Gmail Surname" from first + last name via the
  // same roster the work-email suggester uses, so a 2nd "Kane R…" gets "RE", a
  // 3rd "Kane Res…" gets "RES", etc. The endpoint works for both a real
  // onboarding token AND the HR "/onboarding/preview" (session-gated there), so
  // preview is collision-aware too. Debounced so it doesn't fire per keystroke.
  useEffect(() => {
    const first = form.first_name.trim();
    const last = form.last_name.trim();
    // The bare last-name initial — the guaranteed minimal surname. Strip combining
    // marks (NFD + U+0300–U+036F) so an accented first letter folds to ASCII.
    const fallback =
      (last.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z]/g, '')[0] ?? '').toUpperCase();
    const apply = (val: string) =>
      setForm((f) => (f.gmail_surname === val ? f : { ...f, gmail_surname: val }));

    if (!first || !last) {
      setSurnameLoading(false);
      apply(''); // nothing to generate until both names are present
      return;
    }
    // RULE: ALWAYS generate a surname. Seed the initial immediately — so the
    // field is never blank and never shows a stale value from a previous name —
    // then refine it with the collision-aware roster result. If the lookup can't
    // run, the seeded initial stays.
    apply(fallback);
    setSurnameLoading(true);
    let cancelled = false;
    // Short debounce so it feels like a live search but doesn't hit the roster
    // on every keystroke.
    const handle = setTimeout(() => {
      void (async () => {
        try {
          const res = await fetch(`/api/onboarding/${token}/gmail-surname`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ first, last }),
          });
          const json = (await res.json().catch(() => ({}))) as { gmail_surname?: string };
          if (cancelled) return;
          // Use the roster result when present; otherwise keep the initial.
          apply(res.ok && json.gmail_surname ? json.gmail_surname : fallback);
        } catch {
          if (!cancelled) apply(fallback);
        } finally {
          // Only the latest (non-superseded) request clears the indicator.
          if (!cancelled) setSurnameLoading(false);
        }
      })();
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [form.first_name, form.last_name, token]);

  // Keep the read-only "Nickname" mirrored to the first-name field. It defaults
  // to the first of possibly several first names; if the hire had stepped to a
  // later one with the arrows, that choice is kept as long as it still appears
  // in the (re-typed / re-cased) first name — otherwise it falls back to the
  // first. Case-insensitive match so blur-time title-casing doesn't reset it.
  // Lead Gen hires type their OWN nickname (it feeds the CallTools username),
  // so the mirror must never clobber it — but flipping the preview toggle back
  // off re-mirrors, which is why isLeadGen is a dependency.
  useEffect(() => {
    if (isLeadGen) return;
    const tokens = form.first_name.trim().split(/\s+/).filter(Boolean);
    setForm((f) => {
      const matchIdx = tokens.findIndex(
        (t) => t.toLowerCase() === f.nickname.trim().toLowerCase(),
      );
      const desired = matchIdx >= 0 ? tokens[matchIdx] : tokens[0] ?? '';
      return f.nickname === desired ? f : { ...f, nickname: desired };
    });
  }, [form.first_name, isLeadGen]);

  // PREVIEW ONLY: derive the "CallTools Username" live so HR can watch it mint —
  // the self-chosen nickname + first-name initial + a progressive surname slice
  // ("Mikey J. T.", lengthening to "Mikey J. TH." on a collision), checked
  // against the usernames this system has already minted (the endpoint is
  // session-gated for the preview token). Same debounced pattern as the Gmail
  // Surname above. A REAL hire never sees the username, so their form never
  // derives it — the submit route mints it server-side instead.
  useEffect(() => {
    const nickname = form.nickname.trim();
    const first = form.first_name.trim();
    const last = form.last_name.trim();
    const apply = (val: string) =>
      setForm((f) => (f.calltools_username === val ? f : { ...f, calltools_username: val }));

    // The shortest candidate ("<Nick> <F>. <S>.") — the guaranteed minimal
    // username, seeded immediately and kept whenever the lookup can't run.
    const fallback =
      isPreview && isLeadGen ? calltoolsUsernameCandidates(nickname, first, last)[0] ?? '' : '';
    if (!fallback) {
      setCalltoolsLoading(false);
      apply(''); // not Lead Gen, or nothing to generate yet
      return;
    }
    apply(fallback);
    setCalltoolsLoading(true);
    let cancelled = false;
    const handle = setTimeout(() => {
      void (async () => {
        try {
          const res = await fetch(`/api/onboarding/${token}/calltools-username`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nickname, first, last }),
          });
          const json = (await res.json().catch(() => ({}))) as { calltools_username?: string };
          if (cancelled) return;
          // Use the collision-aware result when present; otherwise keep the
          // minimal candidate.
          apply(res.ok && json.calltools_username ? json.calltools_username : fallback);
        } catch {
          if (!cancelled) apply(fallback);
        } finally {
          // Only the latest (non-superseded) request clears the indicator.
          if (!cancelled) setCalltoolsLoading(false);
        }
      })();
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [form.nickname, form.first_name, form.last_name, isPreview, isLeadGen, token]);

  const update = useCallback(<K extends keyof FormState>(k: K, v: FormState[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
  }, []);

  const validateStep = useCallback((s: number): string | null => {
    switch (s) {
      case 0:
        if (!form.ip_agreement_name.trim()) return 'Please enter your name on the Intellectual Property Assignment.';
        if (!form.ip_agreement_agreed) return 'Please tick the box to acknowledge the Intellectual Property Assignment.';
        if (!form.ip_agreement_signature) return 'Please sign the Intellectual Property Assignment.';
        return null;
      case 1:
        if (!form.first_name.trim()) return 'Please enter your first name.';
        if (!form.last_name.trim()) return 'Please enter your last name.';
        // Lead Gen: the nickname is the hire's own dialer name and the CallTools
        // username is minted from it, so it can't be blank.
        if (isLeadGen && !form.nickname.trim()) {
          return 'Please enter the nickname you want to use in CallTools.';
        }
        if (!form.phone.trim()) return 'Please enter your phone number.';
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) return 'Please enter a valid email.';
        if (!form.country.trim()) return 'Please select your country.';
        if (!form.address_street.trim()) return 'Please enter your street address.';
        if (!form.address_city.trim()) return 'Please enter your city / municipality.';
        if (!form.address_postal_code.trim()) return 'Please enter your postal code.';
        // State / Province / Region are country-specific (US uses State; PH uses
        // Province + Region; Colombia a Department≈Province) — require at least
        // one rather than forcing fields that don't apply.
        if (
          !form.address_state.trim() &&
          !form.address_province.trim() &&
          !form.address_region.trim()
        )
          return 'Please enter your State, Province, or Region.';
        return null;
      case 2:
        if (!form.non_solicitation_signature) return 'Please sign the non-solicitation agreement.';
        return null;
      case 3:
        if (!form.privacy_signature) return 'Please sign the privacy agreement.';
        return null;
      case 4:
        if (form.w8ben_applicable === null) return 'Please indicate whether you are based outside the US.';
        if (form.w8ben_applicable && !form.w8ben_file_path && !form.w8ben_file_name) {
          return 'Please upload your completed W-8BEN form.';
        }
        return null;
      case 5:
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
      case 6:
        if (!form.contract_signature) return 'Please sign the contract worker agreement.';
        if (!form.contract_date) return 'Please enter the date of signature.';
        return null;
      default:
        return null;
    }
  }, [form, isLeadGen]);

  const goNext = useCallback(() => {
    // In preview, skip validation so HR can page through every step freely.
    if (!isPreview) {
      const err = validateStep(step);
      if (err) {
        toast.error(err);
        return;
      }
    }
    // Leaving the IP step: seed the Welcome name from the name on the IP
    // document so the hire doesn't have to type it twice.
    if (step === 0) {
      setForm((f) => {
        if (f.first_name.trim() || !f.ip_agreement_name.trim()) return f;
        const seeded = splitName(f.ip_agreement_name);
        return { ...f, first_name: seeded.first, last_name: seeded.last, extension: seeded.extension };
      });
    }
    setDirection(1);
    setStep((s) => Math.min(STEP_TITLES.length - 1, s + 1));
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [step, validateStep, isPreview]);

  const goPrev = useCallback(() => {
    setDirection(-1);
    setStep((s) => Math.max(0, s - 1));
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  // Preview-mode dry run: render the REAL signed IP Assignment PDF from what the
  // tester entered and open it in a new tab. Nothing is written to the database
  // or storage — this just exercises the exact document the hire will produce.
  const generateIpPreviewPdf = useCallback(async () => {
    if (!form.ip_agreement_name.trim() || !form.ip_agreement_signature) {
      toast.error('Enter your name and sign the agreement first.');
      setDirection(-1);
      setStep(0);
      if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/onboarding/ip-assignment-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.ip_agreement_name.trim(),
          signatureDataUrl: form.ip_agreement_signature,
          dateIso: form.ip_agreement_date,
        }),
      });
      if (!res.ok) throw new Error(`Failed to render PDF (HTTP ${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener,noreferrer');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      toast.success('Generated the signed IP Assignment PDF — opened in a new tab.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to generate preview PDF');
    } finally {
      setSubmitting(false);
    }
  }, [form.ip_agreement_name, form.ip_agreement_signature, form.ip_agreement_date]);

  const submitForm = useCallback(async () => {
    if (isPreview) {
      // In preview there's no real submission — instead render the signed IP
      // Assignment PDF so the tester can see the generated document.
      await generateIpPreviewPdf();
      return;
    }
    for (let i = 0; i <= 6; i++) {
      const err = validateStep(i);
      if (err) {
        toast.error(err);
        setDirection(i >= step ? 1 : -1);
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
          // Extension (Jr./Sr./III) is folded into the legal full name here so HR
          // + contracts read it whole. It is NOT sent to the workspace-account
          // automation: that webhook derives first_name from the first token and
          // last_name from the work-email-based gmail_surname, so the suffix never
          // reaches it.
          full_name: [form.first_name.trim(), form.last_name.trim(), form.extension.trim()]
            .filter(Boolean)
            .join(' '),
          gmail_surname: form.gmail_surname.trim() || null,
          // Lead Gen only — just the self-chosen dialer nickname. The CallTools
          // username is hidden from the hire and minted SERVER-SIDE at submit
          // (the route ignores any client-sent value). Omitted entirely for
          // other departments so the server never touches those columns.
          ...(isLeadGen && {
            calltools_nickname: form.nickname.trim() || null,
          }),
          phone: form.phone.trim(),
          email: form.email.trim(),
          country: form.country.trim() || null,
          address_street: form.address_street.trim() || null,
          address_city: form.address_city.trim() || null,
          address_state: form.address_state.trim() || null,
          address_province: form.address_province.trim() || null,
          address_region: form.address_region.trim() || null,
          address_postal_code: form.address_postal_code.trim() || null,
          ip_agreement_agreed: form.ip_agreement_agreed,
          ip_agreement_name: form.ip_agreement_name.trim(),
          ip_agreement_signature: form.ip_agreement_signature,
          ip_agreement_date: form.ip_agreement_date,
          non_solicitation_signature: form.non_solicitation_signature,
          privacy_signature: form.privacy_signature,
          w8ben_applicable: form.w8ben_applicable,
          // Omit both file fields when the hire kept their previously-uploaded file
          // (sentinel '__existing__'). The server interprets undefined as "no change"
          // and keeps the stored path. Only send when a new file was uploaded.
          ...(form.w8ben_file_path !== '__existing__' && {
            w8ben_file_path: form.w8ben_file_path,
            w8ben_file_name: form.w8ben_file_name,
          }),
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
  }, [form, token, validateStep, isPreview, isLeadGen, generateIpPreviewPdf, step]);

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
    <main className="onboarding-public min-h-dvh bg-gradient-to-br from-sky-50 via-white to-emerald-50 px-3 py-6 sm:px-6 sm:py-10">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
        {isPreview && (
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-amber-300 bg-amber-50 px-4 py-2.5 text-xs font-medium text-amber-900 shadow-sm">
            <Sparkles className="h-4 w-4 shrink-0 text-amber-600" />
            <span className="min-w-0 flex-1">
              Preview mode — this is what new hires see. Nothing here is saved or submitted.
            </span>
            {/* Flip the sample form into the Lead Gen experience: editable
                nickname + live CallTools username on the Welcome step. */}
            <button
              type="button"
              role="switch"
              aria-checked={previewLeadGen}
              onClick={() => setPreviewLeadGenMode(!previewLeadGen)}
              title="Preview the paperwork as a Lead Gen hire — the Welcome step swaps to a type-your-own nickname and mints the CallTools username live."
              className={cn(
                'flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-semibold transition-colors',
                previewLeadGen
                  ? 'border-violet-500 bg-violet-600 text-white shadow-sm'
                  : 'border-amber-300 bg-white text-amber-900 hover:bg-amber-100',
              )}
            >
              <Headset className="h-3.5 w-3.5" />
              Test as Lead Gen
              <span
                className={cn(
                  'rounded-full px-1.5 py-px text-[9px] font-bold uppercase tracking-wide',
                  previewLeadGen ? 'bg-white/25 text-white' : 'bg-amber-100 text-amber-700',
                )}
              >
                {previewLeadGen ? 'On' : 'Off'}
              </span>
            </button>
          </div>
        )}
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

        {/* Step content card. overflow-hidden clips the horizontal slide so a
            transition never spawns a scrollbar. mode="wait" lets the outgoing
            step finish leaving before the next one slides in. */}
        <section className="overflow-hidden rounded-2xl border border-emerald-100/80 bg-white shadow-md ring-1 ring-emerald-500/5">
          <AnimatePresence mode="wait" initial={false} custom={direction}>
            <motion.div
              key={step}
              custom={direction}
              variants={
                reduceMotion
                  ? { enter: { opacity: 0 }, center: { opacity: 1 }, exit: { opacity: 0 } }
                  : STEP_VARIANTS
              }
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ duration: reduceMotion ? 0.15 : 0.26, ease: [0.22, 1, 0.36, 1] }}
            >
              {step === 0 && <StepIpAssignment form={form} update={update} preview={isPreview} onPreview={generateIpPreviewPdf} previewBusy={submitting} />}
              {step === 1 && <Step1Welcome form={form} update={update} link={link} surnameLoading={surnameLoading} isLeadGen={isLeadGen} calltoolsLoading={calltoolsLoading} preview={isPreview} onPreviewLeadGenChange={setPreviewLeadGenMode} />}
              {step === 2 && <Step2NonSolicitation form={form} update={update} />}
              {step === 3 && <Step3Privacy form={form} update={update} />}
              {step === 4 && <Step4W8Ben token={token!} form={form} update={update} preview={isPreview} />}
              {step === 5 && <Step5Payment form={form} update={update} />}
              {step === 6 && <Step6Contract form={form} update={update} />}
            </motion.div>
          </AnimatePresence>
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
              className="bg-gradient-to-r from-emerald-500 to-teal-700 text-white shadow-md shadow-emerald-600/25 hover:opacity-95 disabled:opacity-50"
              onClick={submitForm}
              disabled={submitting}
            >
              {submitting ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <Check className="mr-1.5 h-4 w-4" />
              )}
              {isPreview ? 'Generate signed PDF' : 'Submit'}
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

// ─── Step 0 — Intellectual Property Assignment (standalone first document) ──

function StepIpAssignment({
  form,
  update,
  preview,
  onPreview,
  previewBusy,
}: {
  form: FormState;
  update: <K extends keyof FormState>(k: K, v: FormState[K]) => void;
  preview?: boolean;
  onPreview?: () => void;
  previewBusy?: boolean;
}) {
  return (
    <div className="space-y-5 p-5 sm:p-7">
      <div>
        <h2 className="text-xl font-bold text-zinc-900">{AGREEMENT_TITLES.intellectualProperty}</h2>
        <p className="mt-1.5 text-sm leading-relaxed text-zinc-600">
          Before we begin, please read this agreement in full. Tick the box, then print your name
          and sign at the bottom to continue.
        </p>
      </div>

      {/* The agreement copy — the same document, read top to bottom */}
      <div className="max-h-[420px] overflow-y-auto rounded-xl border border-zinc-100 bg-zinc-50/60 p-4 sm:p-5">
        <IntellectualPropertyText />
      </div>

      {/* Acknowledgement checkbox — mirrors the box on the printed document */}
      <button
        type="button"
        onClick={() => update('ip_agreement_agreed', !form.ip_agreement_agreed)}
        aria-pressed={form.ip_agreement_agreed}
        className={cn(
          'flex w-full items-start gap-3 rounded-xl border p-4 text-left transition-all',
          form.ip_agreement_agreed
            ? 'border-emerald-500 bg-emerald-50 ring-2 ring-emerald-500/30'
            : 'border-zinc-200 bg-white hover:border-emerald-200 hover:bg-emerald-50/40',
        )}
      >
        <span
          className={cn(
            'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-all',
            form.ip_agreement_agreed
              ? 'border-emerald-600 bg-emerald-600 text-white'
              : 'border-zinc-300 bg-white',
          )}
        >
          {form.ip_agreement_agreed && <Check className="h-3.5 w-3.5" />}
        </span>
        <span className="text-sm font-medium leading-relaxed text-zinc-800">
          {IP_ASSIGNMENT_ACKNOWLEDGEMENT}
        </span>
      </button>

      {/* PARTICIPANT block — sign at the very bottom, exactly like the document */}
      <div className="space-y-5 rounded-xl border border-emerald-100 bg-emerald-50/30 p-4 sm:p-5">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-emerald-700/80">
          Participant
        </p>
        <Field label="Name" required>
          <Input
            value={form.ip_agreement_name}
            onChange={(e) => update('ip_agreement_name', e.target.value)}
            onBlur={(e) => update('ip_agreement_name', toTitleCaseName(e.target.value))}
            placeholder="Your full legal name"
            autoComplete="name"
          />
        </Field>
        <Field label="Signature" required>
          <SignaturePad
            value={form.ip_agreement_signature}
            onChange={(v) => update('ip_agreement_signature', v)}
          />
        </Field>
        <Field label="Date">
          <div className="flex h-9 items-center rounded-lg border border-zinc-200 bg-zinc-100/70 px-3 text-sm text-zinc-700">
            {formatLongDate(form.ip_agreement_date) || '—'}
          </div>
          <p className="text-[11px] text-zinc-500">
            Automatically set to the date you opened this link.
          </p>
        </Field>

        {preview && (
          <div className="rounded-lg border border-dashed border-amber-300 bg-amber-50/70 p-3">
            <p className="mb-2 text-[11px] font-medium text-amber-900">
              Preview test — render the signed PDF from what you entered above (nothing is saved).
            </p>
            <Button
              type="button"
              variant="outline"
              className="border-amber-300 bg-white text-amber-900 hover:bg-amber-100"
              onClick={onPreview}
              disabled={previewBusy}
            >
              {previewBusy ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <FileText className="mr-1.5 h-4 w-4" />
              )}
              Generate signed PDF
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Step 1 — Welcome / Personal info ──────────────────────────────────────

function Step1Welcome({
  form,
  update,
  link,
  surnameLoading,
  isLeadGen,
  calltoolsLoading,
  preview,
  onPreviewLeadGenChange,
}: {
  form: FormState;
  update: <K extends keyof FormState>(k: K, v: FormState[K]) => void;
  link: LinkInfo;
  surnameLoading: boolean;
  /** Lead Gen: the Nickname becomes the hire's own typed dialer name and the
   *  auto-minted CallTools Username field appears beneath it. */
  isLeadGen: boolean;
  calltoolsLoading: boolean;
  /** Preview mode: shows the inline "Onboard as Lead Gen" switch right above
   *  the Nickname field so HR can watch it flip between the system-generated
   *  mirror and the Lead Gen type-your-own version. */
  preview?: boolean;
  onPreviewLeadGenChange?: (next: boolean) => void;
}) {
  // Currency is derived from the selected country (United States → USD,
  // Philippines → PHP, Colombia → COP) — knowing the country is how we know it.
  const selectedCurrency = currencyForCountry(form.country);

  // The read-only Nickname mirrors the first-name field. When the hire typed
  // more than one first name (e.g. "Mary Grace"), the arrows step through them;
  // otherwise it's a plain copy of the single name.
  const reduceMotion = useReducedMotion();
  const firstNameTokens = (form.first_name ?? '').trim().split(/\s+/).filter(Boolean);
  const hasMultipleFirstNames = firstNameTokens.length > 1;
  const nicknameIdx = Math.max(
    0,
    firstNameTokens.findIndex((t) => t.toLowerCase() === (form.nickname ?? '').trim().toLowerCase()),
  );
  // The arrows pulse to advertise that the nickname is pickable — until the hire
  // actually steps to another name (discovery achieved), then they go quiet.
  const [nicknamePicked, setNicknamePicked] = useState(false);
  const stepNickname = (delta: number) => {
    const next = firstNameTokens[nicknameIdx + delta];
    if (next) {
      update('nickname', next);
      setNicknamePicked(true);
    }
  };
  const blinkNicknameNav = hasMultipleFirstNames && !nicknamePicked && !reduceMotion;

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
            onBlur={(e) => update('first_name', toTitleCaseName(e.target.value))}
            placeholder="Jane"
            autoComplete="given-name"
            autoFocus
          />
        </Field>
        <div className="grid grid-cols-[1fr_5.5rem] gap-3">
          <Field label="Last name" required>
            <Input
              value={form.last_name ?? ''}
              onChange={(e) => update('last_name', e.target.value)}
              onBlur={(e) => update('last_name', toTitleCaseName(e.target.value))}
              placeholder="Dela Cruz"
              autoComplete="family-name"
            />
          </Field>
          <Field label="Extension">
            <Input
              value={form.extension ?? ''}
              onChange={(e) => update('extension', e.target.value)}
              onBlur={(e) => update('extension', toTitleCaseName(e.target.value))}
              placeholder="Jr."
              autoComplete="honorific-suffix"
            />
          </Field>
        </div>
        {/* Preview-only: the Lead Gen switch sits right on top of the Nickname
            field so HR can flip it and watch the field change from the
            system-generated mirror to the type-your-own Lead Gen version. */}
        {preview && (
          <div
            className={cn(
              'flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed px-3.5 py-3 transition-colors sm:col-span-2',
              isLeadGen ? 'border-violet-400 bg-violet-50/70' : 'border-zinc-300 bg-zinc-50/60',
            )}
          >
            <div className="flex min-w-0 items-center gap-2.5">
              <span
                className={cn(
                  'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors',
                  isLeadGen ? 'bg-violet-600 text-white' : 'bg-zinc-200 text-zinc-500',
                )}
              >
                <Headset className="h-4.5 w-4.5" />
              </span>
              <div className="min-w-0">
                <p className={cn('text-xs font-semibold', isLeadGen ? 'text-violet-900' : 'text-zinc-700')}>
                  Preview test — onboard this hire as Lead Gen
                </p>
                <p className={cn('text-[11px] leading-relaxed', isLeadGen ? 'text-violet-700/90' : 'text-zinc-500')}>
                  {isLeadGen
                    ? 'Lead Gen: the hire types their own nickname, and their CallTools username is minted from it below.'
                    : 'Off: the nickname is auto-generated from the first name, like every other department.'}
                </p>
              </div>
            </div>
            <label className="flex shrink-0 cursor-pointer items-center gap-2">
              <span
                className={cn(
                  'text-[11px] font-bold uppercase tracking-wide',
                  isLeadGen ? 'text-violet-700' : 'text-zinc-400',
                )}
              >
                {isLeadGen ? 'Lead Gen' : 'Standard'}
              </span>
              <Switch
                checked={isLeadGen}
                onCheckedChange={(v) => onPreviewLeadGenChange?.(v)}
                aria-label="Onboard as Lead Gen"
                className="data-checked:bg-violet-600"
              />
            </label>
          </div>
        )}
        {isLeadGen ? (
          <>
            {/* Lead Gen: the hire types their OWN dialer nickname (never derived
                from their name). The CallTools username minted from it is an
                internal HR value — the hire never sees it, so the field below
                renders ONLY in preview; real submissions mint it server-side. */}
            <Field label="Nickname" required className="sm:col-span-2">
              <Input
                value={form.nickname ?? ''}
                onChange={(e) => update('nickname', e.target.value)}
                onBlur={(e) => update('nickname', toTitleCaseName(e.target.value))}
                placeholder="How you want to be called — e.g. Mikey"
                className="font-medium"
              />
              <p className="text-[11px] leading-relaxed text-zinc-500">
                You&rsquo;re joining as <span className="font-semibold text-zinc-600">Lead Gen</span> — type the
                nickname you want to go by on the dialer.
                {preview && ' It builds the CallTools username below.'}
              </p>
            </Field>
            {preview && (
              <Field label="CallTools Username" className="sm:col-span-2">
                <div className="relative">
                  <Input
                    value={form.calltools_username ?? ''}
                    readOnly
                    tabIndex={-1}
                    aria-readonly
                    placeholder={
                      form.nickname.trim() && form.first_name.trim()
                        ? ''
                        : 'Enter your nickname and name above'
                    }
                    className="pr-52 font-mono tracking-wide"
                  />
                  {calltoolsLoading && (
                    <span className="pointer-events-none absolute right-3 top-1/2 inline-flex -translate-y-1/2 items-center gap-1.5 text-[11px] font-medium text-emerald-600">
                      <span className="h-3 w-3 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" />
                      Checking availability…
                    </span>
                  )}
                </div>
                <p className="text-[11px] leading-relaxed text-zinc-500">
                  <span className="font-semibold text-violet-700">Only visible in this preview</span> — the hire
                  never sees this field. On a real submission the username is generated when they submit: nickname
                  plus initials, with extra surname letters added automatically if it&rsquo;s already in use.
                </p>
              </Field>
            )}
          </>
        ) : (
        <Field label="Nickname" className="sm:col-span-2">
          <div className="flex items-center gap-2">
            {hasMultipleFirstNames && (
              <NicknameNavButton
                direction="prev"
                onClick={() => stepNickname(-1)}
                disabled={nicknameIdx <= 0}
                blink={blinkNicknameNav && nicknameIdx > 0}
              />
            )}
            <Input
              value={form.nickname ?? ''}
              readOnly
              tabIndex={-1}
              aria-readonly
              placeholder={form.first_name.trim() ? '' : 'Auto-filled from your first name'}
              className="bg-zinc-50 text-zinc-700 cursor-default text-center font-medium"
            />
            {hasMultipleFirstNames && (
              <NicknameNavButton
                direction="next"
                onClick={() => stepNickname(1)}
                disabled={nicknameIdx >= firstNameTokens.length - 1}
                blink={blinkNicknameNav && nicknameIdx < firstNameTokens.length - 1}
              />
            )}
          </div>
          <p className="text-[11px] leading-relaxed text-zinc-500">
            {hasMultipleFirstNames ? (
              <>
                Copied from your first name. You have more than one first name — use the arrows to pick the one you
                go by{' '}
                <span className="font-semibold text-zinc-600">
                  ({nicknameIdx + 1} of {firstNameTokens.length})
                </span>
                .
              </>
            ) : (
              'Automatically copied from your first name above.'
            )}
          </p>
        </Field>
        )}
        <Field label="Gmail Surname" className="sm:col-span-2">
          <div className="relative">
            <Input
              value={form.gmail_surname ?? ''}
              readOnly
              tabIndex={-1}
              aria-readonly
              placeholder={
                form.first_name.trim() && form.last_name.trim()
                  ? ''
                  : 'Enter your first and last name above'
              }
              className="pr-52 font-mono tracking-wide"
            />
            {surnameLoading && (
              <span className="pointer-events-none absolute right-3 top-1/2 inline-flex -translate-y-1/2 items-center gap-1.5 text-[11px] font-medium text-emerald-600">
                <span className="h-3 w-3 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" />
                Searching Google Workspace…
              </span>
            )}
          </div>
          <p className="text-[11px] leading-relaxed text-zinc-500">
            Auto-generated surname for your @simple.biz Google account (for privacy, it&rsquo;s not your full last
            name). If your initials are already in use, extra letters are added automatically to keep it unique.
          </p>
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
        <Field label="Country" required className="sm:col-span-2">
          <div className="relative">
            <select
              value={form.country ?? ''}
              onChange={(e) => update('country', e.target.value)}
              autoComplete="country-name"
              className={cn(
                'h-10 w-full cursor-pointer appearance-none rounded-lg border bg-white pl-3 pr-10 text-sm font-medium shadow-sm outline-none transition-all',
                'border-zinc-300 hover:border-emerald-300 hover:shadow',
                'focus-visible:border-emerald-500 focus-visible:ring-4 focus-visible:ring-emerald-500/20',
                form.country ? '!text-zinc-900' : '!text-zinc-400',
              )}
            >
              <option value="" disabled>
                Select your country…
              </option>
              {ONBOARDING_COUNTRIES.map((c) => (
                <option key={c.name} value={c.name} className="text-zinc-900">
                  {c.name}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-emerald-600" />
          </div>
          {selectedCurrency && (
            <span className="mt-1 inline-flex w-fit items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-800">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
              You&apos;ll be paid in {selectedCurrency}
            </span>
          )}
        </Field>

        {/* Home address — the former single Location field, broken down. */}
        <Field label="Street address" required className="sm:col-span-2">
          <Input
            value={form.address_street ?? ''}
            onChange={(e) => update('address_street', e.target.value)}
            placeholder="123 Main St, Apt / Barangay"
            autoComplete="street-address"
          />
        </Field>
        <Field label="City / Municipality" required>
          <Input
            value={form.address_city ?? ''}
            onChange={(e) => update('address_city', e.target.value)}
            placeholder="Quezon City"
            autoComplete="address-level2"
          />
        </Field>
        <Field label="Postal code" required>
          <Input
            value={form.address_postal_code ?? ''}
            onChange={(e) => update('address_postal_code', e.target.value)}
            placeholder="1100"
            autoComplete="postal-code"
            inputMode="numeric"
          />
        </Field>
        <p className="text-[11px] leading-relaxed text-zinc-500 sm:col-span-2">
          Fill the parts that apply to your country — at least one of State / Province / Region is required.
        </p>
        <Field label="State">
          <Input
            value={form.address_state ?? ''}
            onChange={(e) => update('address_state', e.target.value)}
            placeholder="e.g. Texas (US)"
            autoComplete="address-level1"
          />
        </Field>
        <Field label="Province">
          <Input
            value={form.address_province ?? ''}
            onChange={(e) => update('address_province', e.target.value)}
            placeholder="e.g. Cavite (PH)"
          />
        </Field>
        <Field label="Region">
          <Input
            value={form.address_region ?? ''}
            onChange={(e) => update('address_region', e.target.value)}
            placeholder="e.g. Metro Manila / NCR"
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
  preview,
}: {
  token: string;
  form: FormState;
  update: <K extends keyof FormState>(k: K, v: FormState[K]) => void;
  preview?: boolean;
}) {
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  async function handleFile(file: File) {
    if (preview) {
      toast.info('Uploads are disabled in preview mode.');
      return;
    }
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
        <DatePicker
          value={form.contract_date}
          onChange={(v) => update('contract_date', v)}
          required
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

// Prev/next arrow for the read-only Nickname picker. Pulses an emerald ring
// (`blink`) to advertise that the hire can choose which of their first names they
// go by; the pulse stops once they've stepped to a different name. transform/
// box-shadow only — no opacity/scale on the icon — so the glyph stays crisp.
function NicknameNavButton({
  direction,
  onClick,
  disabled,
  blink,
}: {
  direction: 'prev' | 'next';
  onClick: () => void;
  disabled: boolean;
  blink: boolean;
}) {
  const Icon = direction === 'prev' ? ChevronLeft : ChevronRight;
  return (
    <motion.button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={direction === 'prev' ? 'Previous first name' : 'Next first name'}
      className={cn(
        'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border shadow-sm transition-colors',
        'border-emerald-300 bg-emerald-50 text-emerald-700 hover:border-emerald-400 hover:bg-emerald-100',
        'disabled:cursor-not-allowed disabled:border-zinc-200 disabled:bg-white disabled:text-zinc-300 disabled:hover:border-zinc-200 disabled:hover:bg-white',
      )}
      animate={
        blink
          ? { boxShadow: ['0 0 0 0 rgba(16,185,129,0.5)', '0 0 0 7px rgba(16,185,129,0)'] }
          : { boxShadow: '0 0 0 0 rgba(16,185,129,0)' }
      }
      transition={
        blink
          ? { duration: 1.25, repeat: Infinity, ease: 'easeOut' }
          : { duration: 0.2 }
      }
    >
      <Icon className="h-4 w-4" />
    </motion.button>
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
