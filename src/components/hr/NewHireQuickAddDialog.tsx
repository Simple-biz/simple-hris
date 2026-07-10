'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  Building2,
  CalendarDays,
  Check,
  Compass,
  Globe2,
  Loader2,
  Mail,
  MapPin,
  Pencil,
  Phone,
  Plus,
  User,
  UserCheck,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { ONBOARDING_COUNTRIES } from '@/lib/onboarding/countries';
import { BASE_SOURCE_OPTIONS, isReferralSource } from '@/lib/hr/referral-source';
import SmoothCombobox from './SmoothCombobox';

/**
 * "New Hire" quick-add modal for the HR New Hire Checklist. Collects one hire's
 * details and hands the RAW values back via `onSave`, which canonicalises
 * department / country and appends a row to the bottom of the grid. The keys
 * here MUST match the grid/DB column keys (HrNewHireChecklist `COLUMNS`).
 *
 * Source is a smooth combobox (pick a known source OR type a custom one).
 * "Referred By" is checked against the Global Master List and is REQUIRED when
 * the source is a referral.
 */
export type QuickAddValues = {
  name: string;
  personal_email: string;
  location: string;
  phone_number: string;
  date_of_interview: string;
  source: string;
  referred_by: string;
  hired_by: string;
  department: string;
  country: string;
};

const EMPTY: QuickAddValues = {
  name: '',
  personal_email: '',
  location: '',
  phone_number: '',
  date_of_interview: '',
  source: '',
  referred_by: '',
  hired_by: '',
  department: '',
  country: '',
};

const COUNTRY_OPTIONS = ONBOARDING_COUNTRIES.map((c) => c.name);

const INPUT_CLASS =
  'h-10 w-full rounded-xl border border-zinc-300 bg-white pl-9 pr-3 text-[13.5px] text-zinc-900 outline-none transition placeholder:text-zinc-400 focus:border-emerald-400 focus:ring-2 focus:ring-emerald-300/50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:border-emerald-500';

const LABEL_CLASS =
  'flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-600 dark:text-zinc-400';

/** Plain free-text fields, in intake order. Source / Referred By / Department /
 *  Country are smooth comboboxes rendered separately. `full` spans both cols. */
const TEXT_FIELDS = [
  { key: 'name', label: 'Full name', placeholder: 'Jane Dela Cruz', Icon: User, type: 'text', full: true },
  { key: 'personal_email', label: 'Personal email', placeholder: 'jane@gmail.com', Icon: Mail, type: 'email', full: true },
  { key: 'location', label: 'Location', placeholder: 'Manila, PH', Icon: MapPin, type: 'text', full: false },
  { key: 'phone_number', label: 'Phone number', placeholder: '+63 900 000 0000', Icon: Phone, type: 'tel', full: false },
  { key: 'date_of_interview', label: 'Date of interview', placeholder: '', Icon: CalendarDays, type: 'date', full: false },
  { key: 'hired_by', label: 'Hired by', placeholder: 'Recruiter', Icon: UserCheck, type: 'text', full: false },
] as const satisfies ReadonlyArray<{
  key: keyof QuickAddValues;
  label: string;
  placeholder: string;
  Icon: typeof User;
  type: string;
  full: boolean;
}>;

interface Props {
  open: boolean;
  /** 'add' appends a new hire; 'edit' updates an existing row (pre-filled). */
  mode: 'add' | 'edit';
  /** e.g. "Jun 28 – Jul 4, 2026" — shown so HR sees which week they're on. */
  weekLabel: string;
  /** Department dropdown suggestions (same source the grid uses). */
  departments: string[];
  /** Source dropdown suggestions (base list ∪ sources already used). */
  sources: string[];
  /** Referrer suggestions — names from the Global Master List. */
  referrers: string[];
  /** Pre-fill values for edit mode; ignored (blank form) in add mode. */
  initialValues?: QuickAddValues | null;
  onCancel: () => void;
  /** Add: insert the hire. Edit: update the row. Awaited — resolve `false` to
   *  keep the dialog open (e.g. the server write failed / hit a conflict). */
  onSave: (values: QuickAddValues) => boolean | void | Promise<boolean | void>;
}

export default function NewHireQuickAddDialog({
  open,
  mode,
  weekLabel,
  departments,
  sources,
  referrers,
  initialValues,
  onCancel,
  onSave,
}: Props) {
  const reduceMotion = useReducedMotion();
  const cardRef = useRef<HTMLDivElement>(null);
  const firstFieldRef = useRef<HTMLInputElement>(null);
  // The control focused before we opened, so focus returns there on close.
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const [values, setValues] = useState<QuickAddValues>(EMPTY);
  const [submitting, setSubmitting] = useState(false);

  const sourceOptions = useMemo(
    () => (sources.length > 0 ? sources : [...BASE_SOURCE_OPTIONS]),
    [sources],
  );
  const sourceIsReferral = isReferralSource(values.source);
  const referrerMissing = sourceIsReferral && values.referred_by.trim().length === 0;
  const canSave = values.name.trim().length > 0 && !referrerMissing;

  const set = useCallback(
    (key: keyof QuickAddValues, v: string) => setValues((prev) => ({ ...prev, [key]: v })),
    [],
  );

  // Seed the form when the dialog OPENS: blank for add, the row's values for
  // edit. Keyed on `open` only on purpose — re-reading initialValues on every
  // render would wipe edits in progress.
  useEffect(() => {
    if (open) setValues(initialValues ?? EMPTY);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Remember the trigger on open; hand focus back to it on close.
  useEffect(() => {
    if (!open) return;
    returnFocusRef.current = (document.activeElement as HTMLElement | null) ?? null;
    return () => {
      const el = returnFocusRef.current;
      if (el && typeof el.focus === 'function' && document.contains(el)) el.focus();
    };
  }, [open]);

  // Autofocus the first field once the entrance animation settles.
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => firstFieldRef.current?.focus(), reduceMotion ? 0 : 180);
    return () => clearTimeout(t);
  }, [open, reduceMotion]);

  // Lock body scroll while open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  const commit = useCallback(
    async (again: boolean) => {
      if (!canSave || submitting) return;
      setSubmitting(true);
      try {
        // A `false` result means the server write failed / conflicted — keep the
        // dialog open so the entry isn't lost and can be retried.
        const ok = await Promise.resolve(onSave(values));
        if (ok === false) return;
        if (again) {
          setValues(EMPTY);
          requestAnimationFrame(() => firstFieldRef.current?.focus());
        } else {
          onCancel();
        }
      } finally {
        setSubmitting(false);
      }
    },
    [canSave, submitting, values, onSave, onCancel],
  );

  // Escape closes; Tab is trapped inside the card so focus can't reach the
  // (inert) page behind the modal. (A combobox popover swallows its own Esc, so
  // Esc here only fires when no dropdown is open.)
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onCancel(); return; }
      if (e.key !== 'Tab' || !cardRef.current) return;
      const focusables = Array.from(
        cardRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !el.hasAttribute('disabled') && el.getAttribute('tabindex') !== '-1' && el.getClientRects().length > 0);
      if (focusables.length === 0) { e.preventDefault(); cardRef.current.focus(); return; }
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement as HTMLElement | null;
      if (active && !cardRef.current.contains(active)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[120] flex items-center justify-center p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduceMotion ? 0 : 0.18 }}
        >
          {/* Backdrop */}
          <div className="absolute inset-0 bg-zinc-950/50 backdrop-blur-sm" onClick={submitting ? undefined : onCancel} aria-hidden />

          {/* Card */}
          <motion.div
            ref={cardRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="nhc-quickadd-title"
            tabIndex={-1}
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.95, y: 14 }}
            animate={reduceMotion ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: 10 }}
            transition={{ duration: reduceMotion ? 0 : 0.24, ease: [0.22, 1, 0.36, 1] }}
            className="relative z-[1] w-full max-w-xl overflow-hidden rounded-2xl bg-white shadow-2xl shadow-black/25 ring-1 ring-emerald-500/30 dark:bg-[#0d1117]"
            onClick={(e) => e.stopPropagation()}
          >
            {/* ── Header ─────────────────────────────────────────────── */}
            <div className="relative overflow-hidden bg-gradient-to-br from-emerald-500 via-emerald-600 to-teal-700 px-5 py-4 text-white">
              <div aria-hidden className="pointer-events-none absolute -right-6 -top-8 h-32 w-32 rounded-full bg-white/10 blur-2xl" />
              <div className="relative flex items-start gap-3">
                <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white/20 backdrop-blur-sm">
                  {mode === 'edit' ? <Pencil className="h-5 w-5" /> : <UserPlus className="h-5 w-5" />}
                </span>
                <div className="min-w-0">
                  <h2 id="nhc-quickadd-title" className="text-[15px] font-semibold leading-tight drop-shadow-sm sm:text-base">
                    {mode === 'edit' ? 'Edit hire' : 'Add a new hire'}
                  </h2>
                  <p className="mt-0.5 text-[12.5px] font-medium text-white/90 drop-shadow-sm">
                    {mode === 'edit' ? `On ${weekLabel}` : `Lands at the bottom of ${weekLabel}`}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={onCancel}
                  disabled={submitting}
                  aria-label="Cancel"
                  className="ml-auto -mr-1 -mt-1 rounded-lg p-1.5 text-white/70 transition hover:bg-white/15 hover:text-white disabled:opacity-40"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            {/* ── Body (form) ────────────────────────────────────────── */}
            <form noValidate onSubmit={(e) => { e.preventDefault(); void commit(false); }}>
              <div className="max-h-[62vh] overflow-y-auto px-5 py-4">
                <div className="grid grid-cols-1 gap-x-4 gap-y-3.5 sm:grid-cols-2">
                  {TEXT_FIELDS.map((f, i) => {
                    const Icon = f.Icon;
                    return (
                      <div key={f.key} className={cn(f.full && 'sm:col-span-2')}>
                        <label htmlFor={`nhc-qa-${f.key}`} className={LABEL_CLASS}>
                          <Icon className="h-3.5 w-3.5" />
                          {f.label}
                          {f.key === 'name' && <span className="text-emerald-600 dark:text-emerald-400">*</span>}
                        </label>
                        <div className="relative mt-1.5">
                          <Icon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
                          <input
                            ref={i === 0 ? firstFieldRef : undefined}
                            id={`nhc-qa-${f.key}`}
                            type={f.type}
                            value={values[f.key]}
                            placeholder={f.placeholder}
                            onChange={(e) => set(f.key, e.target.value)}
                            className={INPUT_CLASS}
                          />
                        </div>
                      </div>
                    );
                  })}

                  {/* Source — smooth combobox (pick a known source OR type a custom one). */}
                  <div>
                    <label className={LABEL_CLASS}>
                      <Compass className="h-3.5 w-3.5" />
                      Source
                    </label>
                    <div className="mt-1.5">
                      <SmoothCombobox
                        value={values.source}
                        onChange={(v) => set('source', v)}
                        options={sourceOptions}
                        placeholder="How did we find them?"
                        icon={Compass}
                        ariaLabel="Source"
                      />
                    </div>
                  </div>

                  {/* Referred By — checked against the Global Master List; required
                      when the source is a referral. */}
                  <div>
                    <label className={LABEL_CLASS}>
                      <Users className="h-3.5 w-3.5" />
                      Referred by
                      {sourceIsReferral && <span className="text-amber-600 dark:text-amber-400">*</span>}
                    </label>
                    <div className="mt-1.5">
                      <SmoothCombobox
                        value={values.referred_by}
                        onChange={(v) => set('referred_by', v)}
                        options={referrers}
                        placeholder={sourceIsReferral ? 'Required — search the master list' : 'Search the master list'}
                        icon={Users}
                        ariaLabel="Referred by"
                        invalid={referrerMissing}
                        customFirst
                      />
                    </div>
                    {sourceIsReferral && (
                      <p className="mt-1 text-[11px] leading-snug text-amber-600 dark:text-amber-400">
                        Referral hires need a referrer from the Global Master List.
                      </p>
                    )}
                  </div>

                  {/* Department — smooth combobox (typeable + suggestions). */}
                  <div>
                    <label className={LABEL_CLASS}>
                      <Building2 className="h-3.5 w-3.5" />
                      Department
                    </label>
                    <div className="mt-1.5">
                      <SmoothCombobox
                        value={values.department}
                        onChange={(v) => set('department', v)}
                        options={departments}
                        placeholder="Choose or type…"
                        icon={Building2}
                        ariaLabel="Department"
                      />
                    </div>
                  </div>

                  {/* Country — the onboarding-supported set (drives Bulk Invite). */}
                  <div>
                    <label className={LABEL_CLASS}>
                      <Globe2 className="h-3.5 w-3.5" />
                      Country
                    </label>
                    <div className="mt-1.5">
                      <SmoothCombobox
                        value={values.country}
                        onChange={(v) => set('country', v)}
                        options={COUNTRY_OPTIONS}
                        placeholder="Choose…"
                        searchable={false}
                        icon={Globe2}
                        ariaLabel="Country"
                      />
                    </div>
                  </div>
                </div>

                <p className="mt-3.5 text-[11.5px] leading-snug text-zinc-500 dark:text-zinc-500">
                  Only the <strong className="font-semibold text-zinc-700 dark:text-zinc-300">name</strong> is required
                  {' '}(plus <strong className="font-semibold text-zinc-700 dark:text-zinc-300">who referred them</strong> for
                  referral hires). This hire is saved to the checklist right away — the{' '}
                  <strong className="font-semibold text-zinc-700 dark:text-zinc-300">orientation invite</strong> only sends when
                  you <strong className="font-semibold text-zinc-700 dark:text-zinc-300">Lock in</strong> the week.
                </p>
              </div>

              {/* ── Footer ───────────────────────────────────────────── */}
              <div className="flex flex-wrap items-center justify-end gap-2.5 border-t border-zinc-100 bg-zinc-50/70 px-5 py-3.5 dark:border-zinc-800 dark:bg-zinc-900/40">
                <button
                  type="button"
                  onClick={onCancel}
                  disabled={submitting}
                  className="h-9 rounded-lg border border-zinc-200 px-4 text-[13px] font-medium text-zinc-600 transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                >
                  Cancel
                </button>
                {mode === 'add' && (
                  <button
                    type="button"
                    onClick={() => void commit(true)}
                    disabled={!canSave || submitting}
                    className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-emerald-300 bg-white px-4 text-[13px] font-semibold text-emerald-700 transition hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-emerald-500/40 dark:bg-transparent dark:text-emerald-300 dark:hover:bg-emerald-950/40"
                  >
                    <Plus className="h-4 w-4" />
                    Save &amp; add another
                  </button>
                )}
                <button
                  type="submit"
                  disabled={!canSave || submitting}
                  className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-4 text-[13px] font-semibold text-white shadow-sm transition hover:bg-emerald-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-emerald-600 dark:hover:bg-emerald-500"
                >
                  {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                  {mode === 'edit' ? 'Save changes' : 'Add to checklist'}
                </button>
              </div>
            </form>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
