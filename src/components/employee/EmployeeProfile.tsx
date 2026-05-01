'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Loader2,
  AlertCircle,
  User,
  Mail,
  BadgeCheck,
  Banknote,
  Briefcase,
  Camera,
  Building2,
  Calendar,
  Hash,
  Landmark,
  Pencil,
  Lock,
  Save,
  CheckCircle,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import EmployeeAvatar from './EmployeeAvatar';
import { normEmail } from '@/lib/email/norm-email';
import {
  OFFICIAL_USD_TO_PHP_RATE,
  effectiveUsdToPhpRateFromStored,
} from '@/lib/fx/usd-php';
import { compressProfilePhotoForUpload } from '@/lib/images/compress-profile-photo';
import type { EmployeeRow } from '@/lib/supabase/employees';
import type { EmployeeHourlyRateRow } from '@/lib/supabase/employee-hourly-rates';
import type { EmployeeIdRow } from '@/lib/supabase/employee-ids';
import { PROCESSOR_OPTIONS, type ProcessorId } from '@/lib/employee-payment-processors';
import {
  PreferredPaymentMethodRadios,
  PayoutDetailsFields,
  emptyPayout,
  payoutDraftFromIdsRow,
  type PayoutFields,
} from '@/components/employee/employee-payout-fields';

interface EmployeeProfileProps {
  employeeEmail: string;
  profilePhotoUrl: string | null;
  onProfilePhotoUpdated: (url: string) => void;
  /** When accounting starts payroll processing, bank / payout editing is disabled. */
  payrollLocked?: boolean;
}

function formatPHP(n: number): string {
  return '₱' + n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function parseRate(v: string | null | undefined): number | null {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function formatStartDate(raw: string | null): string | null {
  if (!raw?.trim()) return null;
  const s = raw.trim();
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) {
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  return s;
}

function matchesEmployeeEmail(emp: EmployeeRow, n: string): boolean {
  const we = normEmail(emp.work_email ?? '');
  const pe = normEmail(emp.personal_email ?? '');
  return we === n || pe === n;
}

/* ---------- Skeleton ---------- */
function ProfileSkeleton() {
  return (
    <div className="box-border flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-gradient-to-br from-white via-orange-50/30 to-blue-50/20 dark:bg-none dark:bg-[#0d1117]">
      {/* Hero skeleton */}
      <div className="shrink-0 border-b border-zinc-200/60 bg-gradient-to-r from-orange-50/60 via-white to-blue-50/40 px-4 py-4 sm:px-6 sm:py-6 dark:border-zinc-800 dark:from-zinc-900/60 dark:via-zinc-950 dark:to-zinc-900/60">
        <div className="flex flex-row items-center gap-4 sm:gap-5">
          <div className="h-16 w-16 animate-pulse rounded-full bg-zinc-200 dark:bg-zinc-800 sm:h-24 sm:w-24" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div className="h-5 w-40 animate-pulse rounded-md bg-zinc-200 sm:h-6 sm:w-48 dark:bg-zinc-800" />
            <div className="h-3.5 w-32 animate-pulse rounded bg-zinc-200/70 sm:h-4 sm:w-36 dark:bg-zinc-800/70" />
            <div className="mt-1 flex gap-2">
              <div className="h-5 w-14 animate-pulse rounded-full bg-zinc-200 sm:h-6 sm:w-16 dark:bg-zinc-800" />
              <div className="h-5 w-16 animate-pulse rounded-full bg-zinc-200 sm:h-6 sm:w-20 dark:bg-zinc-800" />
            </div>
          </div>
        </div>
      </div>
      {/* Cards skeleton */}
      <div className="flex-1 overflow-y-auto px-4 py-4 sm:px-6">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="rounded-xl border border-zinc-200/60 bg-white/80 p-4 dark:border-zinc-800 dark:bg-zinc-900/40">
              <div className="mb-3 flex items-center gap-2">
                <div className="h-4 w-4 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
                <div className="h-3.5 w-24 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
              </div>
              <div className="space-y-2.5">
                {Array.from({ length: 2 + (i % 2) }, (_, j) => (
                  <div key={j} className="flex gap-3">
                    <div className="h-3 w-20 animate-pulse rounded bg-zinc-200/70 dark:bg-zinc-800/70" />
                    <div className="h-3 w-32 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" style={{ animationDelay: `${j * 100}ms` }} />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ---------- Field row ---------- */
function FieldRow({
  icon: Icon,
  label,
  value,
  mono,
  /** When `value` is empty, show this text (muted) so the row is still visible. */
  emptyDisplay,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  label: string;
  value: string | null;
  mono?: boolean;
  emptyDisplay?: string;
}) {
  const trimmed = value?.trim() ?? '';
  const text = trimmed || emptyDisplay?.trim();
  if (!text) return null;
  const isPlaceholder = !trimmed && !!emptyDisplay;
  return (
    <div className="flex items-start gap-2.5 py-2 sm:py-1.5">
      {Icon && <Icon className="mt-0.5 h-4 w-4 shrink-0 text-zinc-400 sm:h-3.5 sm:w-3.5 dark:text-zinc-500" />}
      <div className="min-w-0 flex-1">
        <div className="text-[11px] font-medium uppercase tracking-wide text-zinc-400 sm:text-[10px] dark:text-zinc-500">{label}</div>
        <div
          className={`mt-0.5 text-sm sm:text-xs dark:text-zinc-100 ${mono ? 'break-all font-mono text-xs sm:text-[11px]' : ''} ${isPlaceholder ? 'text-zinc-500 italic dark:text-zinc-400' : 'text-zinc-900'}`}
        >
          {text}
        </div>
      </div>
    </div>
  );
}

/* ---------- Panel ---------- */
function ProfilePanel({
  title,
  icon: Icon,
  children,
  className,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`flex min-h-0 flex-col rounded-xl border border-zinc-200/90 bg-white/90 shadow-sm transition-shadow hover:shadow-md dark:border-zinc-700/80 dark:bg-zinc-900/50 ${className ?? ''}`}
    >
      <div className="flex items-center gap-2 border-b border-zinc-100 px-4 py-3 sm:py-2.5 dark:border-zinc-800">
        <Icon className="h-4 w-4 shrink-0 text-orange-500 dark:text-orange-400" />
        <span className="text-sm font-semibold tracking-tight text-zinc-900 sm:text-xs dark:text-white">{title}</span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-0 px-4 py-3 sm:py-2">{children}</div>
    </div>
  );
}

export default function EmployeeProfile({
  employeeEmail,
  profilePhotoUrl,
  onProfilePhotoUpdated,
  payrollLocked = false,
}: EmployeeProfileProps) {
  const norm = normEmail(employeeEmail) ?? employeeEmail.toLowerCase();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [master, setMaster] = useState<EmployeeRow | null>(null);
  const [rate, setRate] = useState<EmployeeHourlyRateRow | null>(null);
  const [bankInfo, setBankInfo] = useState<EmployeeIdRow | null>(null);
  const [usdToPhpRate, setUsdToPhpRate] = useState(OFFICIAL_USD_TO_PHP_RATE);

  const [preferredProcessor, setPreferredProcessor] = useState<ProcessorId | ''>('');
  const [payout, setPayout] = useState<PayoutFields>(() => ({ ...emptyPayout }));
  const [payoutSaving, setPayoutSaving] = useState(false);
  const [payoutSavedAt, setPayoutSavedAt] = useState<string | null>(null);
  const [payoutEditing, setPayoutEditing] = useState(false);

  useEffect(() => {
    if (!bankInfo) {
      setPreferredProcessor('');
      setPayout({ ...emptyPayout });
      setPayoutEditing(true);
      return;
    }
    const d = payoutDraftFromIdsRow(bankInfo as unknown as Record<string, unknown>);
    setPreferredProcessor(d.preferredProcessor);
    setPayout(d.payout);
    setPayoutEditing(false);
  }, [bankInfo]);

  const resetPayoutDraft = React.useCallback(() => {
    if (!bankInfo) {
      setPreferredProcessor('');
      setPayout({ ...emptyPayout });
      setPayoutEditing(true);
      return;
    }
    const d = payoutDraftFromIdsRow(bankInfo as unknown as Record<string, unknown>);
    setPreferredProcessor(d.preferredProcessor);
    setPayout(d.payout);
    setPayoutEditing(false);
  }, [bankInfo]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setError(null);
      setLoading(true);
      try {
        const [empRes, rateRes, idsRes, fxRes] = await Promise.all([
          fetch('/api/employees', { cache: 'no-store' }),
          fetch('/api/employee-hourly-rates', { cache: 'no-store' }),
          fetch('/api/employee-ids', { cache: 'no-store' }),
          fetch('/api/app-settings?key=usd_to_php_rate', { cache: 'no-store' }),
        ]);

        const empJson = (await empRes.json()) as { employees?: EmployeeRow[]; error?: string | null };
        const rateJson = (await rateRes.json()) as { rows?: EmployeeHourlyRateRow[]; error?: string | null };
        const idsJson = (await idsRes.json()) as { rows?: EmployeeIdRow[]; error?: string | null };
        const fxJson = (await fxRes.json()) as { value: string | null };

        if (cancelled) return;

        if (fxRes.ok) {
          setUsdToPhpRate(effectiveUsdToPhpRateFromStored(fxJson.value));
        }

        if (empJson.error) setError(empJson.error);
        else {
          const me = (empJson.employees ?? []).find((e) => matchesEmployeeEmail(e, norm));
          setMaster(me ?? null);
        }

        if (rateJson.error && !empJson.error) setError(rateJson.error ?? null);
        const rates = rateJson.rows ?? [];
        const myRate = rates.find((r) => {
          const we = normEmail(r.work_email ?? '');
          const pe = normEmail(r.personal_email ?? '');
          return we === norm || pe === norm;
        });
        setRate(myRate ?? null);

        const idRows = idsJson.rows ?? [];
        if (idsJson.error && !empJson.error && !rateJson.error) {
          setError(idsJson.error);
        }
        const myId = idRows.find((r) => {
          const we = normEmail(r.work_email ?? '');
          const pe = normEmail(r.personal_email ?? '');
          return we === norm || pe === norm;
        });
        setBankInfo(myId ?? null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load profile');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [norm]);

  const displayName =
    master?.name?.trim() || employeeEmail.split('@')[0]?.replace(/\./g, ' ') || '—';

  /** Employment panel + department badge: always from `active_employees` / global master list (never rates or Hubstaff). */
  const employmentDepartment = master?.department?.trim() || null;
  const reg = parseRate(rate?.regular_rate ?? null);
  const ot = parseRate(rate?.ot_rate ?? null);

  const avatarEmail =
    master?.work_email?.trim() || rate?.work_email?.trim() || employeeEmail.trim() || null;

  const displayProfilePhotoUrl =
    profilePhotoUrl?.trim() || master?.profile_photo_url?.trim() || null;
  const payoutReadOnly = payrollLocked || !payoutEditing;

  const onAvatarFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploadingPhoto(true);
    try {
      const blob = await compressProfilePhotoForUpload(file);
      const fd = new FormData();
      fd.append('email', employeeEmail);
      fd.append('file', blob, 'avatar.jpg');
      const res = await fetch('/api/employee-profile-photo', { method: 'POST', body: fd });
      const json = (await res.json()) as { profilePhotoUrl?: string; error?: string };
      if (!res.ok) throw new Error(json.error || 'Upload failed');
      if (!json.profilePhotoUrl) throw new Error('No photo URL returned');
      onProfilePhotoUpdated(json.profilePhotoUrl);
      toast.success('Profile photo updated');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not upload photo');
    } finally {
      setUploadingPhoto(false);
    }
  };

  const avatarInitials = useMemo(() => {
    const n = displayName.replace(/—/g, '').trim();
    if (n) {
      const parts = n.split(/\s+/).filter(Boolean);
      if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
      if (parts[0].length >= 2) return parts[0].slice(0, 2).toUpperCase();
      return (parts[0][0] + (parts[0][1] || parts[0][0])).toUpperCase();
    }
    return employeeEmail.slice(0, 2).toUpperCase();
  }, [displayName, employeeEmail]);

  const savePaymentDetails = async () => {
    if (payrollLocked) {
      toast.error('Payroll processing is in progress', {
        description: 'Bank and payout details cannot be edited until accounting finishes.',
      });
      return;
    }
    setPayoutSaving(true);
    try {
      const bootstrapName =
        displayName && displayName !== "—" ? displayName.trim() : "";

      const res = await fetch('/api/update-employee-ids', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          work_email: norm,
          bootstrap_display_name: bootstrapName || undefined,
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
      const json = (await res.json()) as { error?: string | null; success?: boolean };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Save failed');

      const idsRes = await fetch('/api/employee-ids', { cache: 'no-store' });
      const idsJson = (await idsRes.json()) as { rows?: EmployeeIdRow[] };
      const idRows = idsJson.rows ?? [];
      const myId = idRows.find((r) => {
        const we = normEmail(r.work_email ?? '');
        const pe = normEmail(r.personal_email ?? '');
        return we === norm || pe === norm;
      });
      setBankInfo(myId ?? null);
      setPayoutSavedAt(new Date().toLocaleTimeString());
      setPayoutEditing(false);
      toast.success('Payment details saved');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save payment details');
    } finally {
      setPayoutSaving(false);
    }
  };

  if (loading) return <ProfileSkeleton />;

  return (
    <div className="box-border flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-gradient-to-br from-white via-orange-50/30 to-blue-50/20 dark:bg-none dark:bg-[#0d1117]">
      {/* ── Hero header ── */}
      <div className="shrink-0 border-b border-zinc-200/60 bg-gradient-to-r from-orange-50/60 via-white to-blue-50/40 px-4 py-4 sm:px-6 sm:py-6 dark:border-zinc-800 dark:from-zinc-900/60 dark:via-zinc-950 dark:to-zinc-900/60">
        <div className="flex flex-row items-center gap-4 sm:gap-5">
          {/* Avatar */}
          <div className="group relative shrink-0">
            <div className="rounded-full ring-4 ring-white/80 dark:ring-zinc-900/80">
              <EmployeeAvatar
                photoUrl={displayProfilePhotoUrl}
                email={avatarEmail}
                initials={avatarInitials}
                className="h-16 w-16 text-xl sm:h-24 sm:w-24 sm:text-3xl"
                pixelSize={192}
              />
            </div>
            {/* Camera overlay */}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              className="sr-only"
              aria-label="Upload profile photo"
              onChange={onAvatarFileChange}
              disabled={uploadingPhoto}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploadingPhoto}
              className="absolute inset-0 flex items-center justify-center rounded-full bg-black/0 opacity-0 transition-all duration-200 hover:bg-black/40 group-hover:opacity-100"
              aria-label="Change photo"
            >
              {uploadingPhoto ? (
                <Loader2 className="h-6 w-6 animate-spin text-white" />
              ) : (
                <Camera className="h-6 w-6 text-white drop-shadow-lg" />
              )}
            </button>
          </div>

          {/* Name & meta */}
          <div className="flex min-w-0 flex-1 flex-col gap-1 sm:gap-1.5">
            <h2 className="truncate text-lg font-bold tracking-tight text-zinc-900 sm:text-2xl dark:text-white">
              {displayName}
            </h2>
            <p className="truncate font-mono text-xs text-zinc-500 sm:text-xs dark:text-zinc-400">{employeeEmail}</p>
            <div className="mt-1 flex flex-wrap items-center gap-1.5 sm:gap-2">
              {employmentDepartment && (
                <Badge variant="outline" className="gap-1 border-orange-200 bg-orange-50 px-1.5 py-0.5 text-[10px] text-orange-700 sm:px-2 sm:text-xs dark:border-orange-800/50 dark:bg-orange-950/30 dark:text-orange-400">
                  <Building2 className="h-3 w-3" />
                  {employmentDepartment}
                </Badge>
              )}
              {master?.employee_id && (
                <Badge variant="outline" className="gap-1 border-zinc-200 bg-zinc-50 px-1.5 py-0.5 font-mono text-[10px] text-zinc-600 sm:px-2 sm:text-xs dark:border-zinc-700 dark:bg-zinc-900/40 dark:text-zinc-400">
                  <Hash className="h-3 w-3" />
                  {master.employee_id}
                </Badge>
              )}
            </div>
          </div>
        </div>

        {/* Mobile-only Change Photo button, below the hero row so it doesn't crowd the avatar+name. */}
        <div className="mt-3 sm:hidden">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 w-full gap-1.5 text-[11px]"
            disabled={uploadingPhoto}
            onClick={() => fileInputRef.current?.click()}
          >
            {uploadingPhoto ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Camera className="h-3.5 w-3.5" />}
            {uploadingPhoto ? 'Uploading…' : 'Change Photo'}
          </Button>
        </div>
      </div>

      {/* ── Content ── */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-4 sm:px-6">
        {error && (
          <div className="mb-3 flex shrink-0 items-start gap-2 rounded-lg border border-amber-200/80 bg-amber-50/90 px-3 py-2 dark:border-amber-900/50 dark:bg-amber-950/40">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <p className="text-[11px] leading-snug text-amber-950 dark:text-amber-200">{error}</p>
          </div>
        )}

        {!master && !error && (
          <div className="mb-3 flex shrink-0 items-start gap-2 rounded-lg border border-zinc-200 bg-zinc-50/90 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900/50">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-zinc-400" />
            <p className="text-[11px] leading-snug text-zinc-600 dark:text-zinc-400">
              {rate ? (
                <>
                  No <span className="font-mono">global_master_list</span> row for{' '}
                  <span className="font-mono font-medium">{employeeEmail}</span> — rates only; employment details will
                  appear once HR adds you to the roster.
                </>
              ) : (
                <>
                  No directory or payroll row for <span className="font-mono font-medium">{employeeEmail}</span>.
                </>
              )}
            </p>
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 pb-2 sm:grid-cols-2 sm:gap-3">
          {/* Identity */}
          <ProfilePanel title="Identity" icon={User}>
            <FieldRow icon={User} label="Full Name" value={displayName === '—' ? null : displayName} />
            <FieldRow icon={Hash} label="Employee ID" value={master?.employee_id ?? null} mono />
          </ProfilePanel>

          {/* Contact */}
          <ProfilePanel title="Contact" icon={Mail}>
            <FieldRow
              icon={Mail}
              label="Work Email"
              value={master?.work_email?.trim() || rate?.work_email?.trim() || bankInfo?.work_email?.trim() || null}
              mono
            />
            <FieldRow
              icon={Mail}
              label="Personal Email"
              value={bankInfo?.personal_email?.trim() || master?.personal_email?.trim() || rate?.personal_email?.trim() || null}
              mono
            />
          </ProfilePanel>

          {/* Employment — global_master_list via /api/employees (active_employees) */}
          <ProfilePanel title="Employment" icon={Briefcase}>
            <FieldRow
              icon={Building2}
              label="Department"
              value={employmentDepartment}
              emptyDisplay={
                master
                  ? 'Not set on your roster row — ask HR to fill Department in the master list.'
                  : 'No active roster row for your work or personal email. HR must add you to the global master list.'
              }
            />
            <FieldRow
              icon={Calendar}
              label="Start Date"
              value={formatStartDate(master?.start_date ?? null)}
              emptyDisplay={
                master
                  ? 'Not set — ask HR to add Start Date in the master list.'
                  : '—'
              }
            />
            <p className="pt-1 text-[11px] leading-relaxed text-zinc-500 sm:text-[10px] dark:text-zinc-400">
              Pulled only from HR&apos;s roster (same source as Payroll). Payroll rate department can differ{' '}
              — that does not appear here by design.
            </p>
          </ProfilePanel>

          {/* Compensation */}
          <ProfilePanel title="Compensation" icon={Banknote}>
            <FieldRow icon={Banknote} label="Regular Rate" value={reg != null ? `${formatPHP(reg)} / hr` : null} />
            <FieldRow icon={Banknote} label="Overtime Rate" value={ot != null ? `${formatPHP(ot)} / hr` : null} />
            <div className="border-t border-zinc-100 pt-2.5 sm:pt-2 dark:border-zinc-800">
              <div className="text-[11px] font-medium uppercase tracking-wide text-zinc-400 sm:text-[10px] dark:text-zinc-500">
                USD → PHP (payroll)
              </div>
              <p className="mt-1 font-mono text-sm text-zinc-700 sm:text-xs dark:text-zinc-300">
                ₱{usdToPhpRate.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 5 })} = $1 USD
              </p>
            </div>
            {!reg && !ot && (
              <p className="py-2 text-[11px] text-zinc-400 sm:text-[10px] dark:text-zinc-500">
                No hourly rates set yet. Contact HR.
              </p>
            )}
          </ProfilePanel>

          {/* Bank / payout — preferred method + details (edited here; personal email stays in Settings) */}
          <div className="col-span-1 sm:col-span-2">
            <div className="flex min-h-0 flex-col rounded-xl border border-zinc-200/90 bg-white/90 shadow-sm transition-shadow hover:shadow-md dark:border-zinc-700/80 dark:bg-zinc-900/50">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-100 px-4 py-3 sm:py-2.5 dark:border-zinc-800">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <Landmark className="h-4 w-4 shrink-0 text-orange-500 dark:text-orange-400" />
                  <span className="text-sm font-semibold tracking-tight text-zinc-900 sm:text-xs dark:text-white">
                    Bank Information
                  </span>
                  {preferredProcessor && (
                    <Badge
                      variant="outline"
                      className="border-orange-500/20 bg-orange-500/10 text-[10px] text-orange-700 dark:border-orange-500/30 dark:text-orange-400"
                    >
                      {PROCESSOR_OPTIONS.find((p) => p.id === preferredProcessor)?.label}
                    </Badge>
                  )}
                </div>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  {payoutSavedAt && (
                    <span className="flex items-center gap-1 text-[10px] text-emerald-600 dark:text-emerald-400 sm:text-xs">
                      <CheckCircle className="h-3 w-3 shrink-0" />
                      Saved {payoutSavedAt}
                    </span>
                  )}
                  {!payrollLocked && bankInfo && !payoutEditing && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 gap-1.5 text-[11px]"
                      onClick={() => setPayoutEditing(true)}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                      Edit
                    </Button>
                  )}
                  {!payrollLocked && payoutEditing && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 gap-1.5 text-[11px]"
                      disabled={payoutSaving}
                      onClick={resetPayoutDraft}
                    >
                      <X className="h-3.5 w-3.5" />
                      Cancel
                    </Button>
                  )}
                  <Button
                    type="button"
                    size="sm"
                    disabled={payoutSaving || payrollLocked || !payoutEditing}
                    className="h-8 gap-1.5 bg-orange-500 text-[11px] text-white hover:bg-orange-600 disabled:opacity-50 dark:bg-orange-600 dark:hover:bg-orange-500"
                    onClick={savePaymentDetails}
                  >
                    {payoutSaving ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Save className="h-3.5 w-3.5" />
                    )}
                    Save payment details
                  </Button>
                </div>
              </div>
              <div className="px-4 py-3">
                {payrollLocked && (
                  <div className="mb-3 flex items-start gap-2 rounded-lg border border-rose-200/90 bg-rose-50/90 px-3 py-2.5 dark:border-rose-900/50 dark:bg-rose-950/35">
                    <Lock className="mt-0.5 h-4 w-4 shrink-0 text-rose-600 dark:text-rose-400" />
                    <p className="text-[11px] leading-snug text-rose-950 dark:text-rose-100">
                      Payroll processing is in progress. Preferred payment method and bank details are read-only until
                      accounting finishes.
                    </p>
                  </div>
                )}
                {!bankInfo && !payrollLocked && (
                  <p className="mb-3 text-[11px] leading-relaxed text-zinc-600 dark:text-zinc-400">
                    Choose how you get paid and fill in the details below, then save. If you don&apos;t have a payroll row
                    yet, your first save creates one linked to your work email. HR may replace the temporary ID later.
                  </p>
                )}
                <div className="space-y-4">
                  <PreferredPaymentMethodRadios
                    value={preferredProcessor}
                    onChange={setPreferredProcessor}
                    disabled={payoutReadOnly}
                  />
                  {preferredProcessor ? (
                    <PayoutDetailsFields
                      processor={preferredProcessor}
                      payout={payout}
                      setPayout={setPayout}
                      disabled={payoutReadOnly}
                    />
                  ) : null}
                </div>
              </div>
            </div>
          </div>

          {/* Data Sources */}
          <div className="col-span-1 sm:col-span-2">
            <div className="rounded-xl border border-zinc-200/90 bg-gradient-to-br from-emerald-50/40 to-zinc-50/30 p-4 shadow-sm dark:border-zinc-700/80 dark:from-emerald-950/20 dark:to-zinc-950/40">
              <div className="mb-2.5 flex items-center gap-2">
                <BadgeCheck className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                <span className="text-sm font-semibold text-zinc-900 sm:text-xs dark:text-white">Data Sources</span>
              </div>
              <p className="mb-3 text-[11px] leading-relaxed text-zinc-600 sm:text-[11px] dark:text-zinc-400">
                Profile merges the HR master roster with payroll rates and your saved payout info. Employment (department
                and start date) always follows the master list.
              </p>
              <div className="grid grid-cols-1 gap-2.5 text-[11px] sm:grid-cols-3 sm:gap-3 sm:text-[11px]">
                <div className="rounded-lg border border-white/60 bg-white/60 px-3 py-2.5 sm:py-2 dark:border-zinc-700 dark:bg-zinc-900/40">
                  <span className="font-mono font-medium text-zinc-800 dark:text-zinc-200">global_master_list</span>
                  <p className="mt-0.5 leading-snug text-zinc-500 dark:text-zinc-400">
                    Name, emails, department, start date, employee ID, photo URL
                  </p>
                </div>
                <div className="rounded-lg border border-white/60 bg-white/60 px-3 py-2.5 sm:py-2 dark:border-zinc-700 dark:bg-zinc-900/40">
                  <span className="font-mono font-medium text-zinc-800 dark:text-zinc-200">employee_hourly_rates</span>
                  <p className="mt-0.5 leading-snug text-zinc-500 dark:text-zinc-400">
                    Regular &amp; OT rates (and payroll routing fields)
                  </p>
                </div>
                <div className="rounded-lg border border-white/60 bg-white/60 px-3 py-2.5 sm:py-2 dark:border-zinc-700 dark:bg-zinc-900/40">
                  <span className="font-mono font-medium text-zinc-800 dark:text-zinc-200">employee_ids</span>
                  <p className="mt-0.5 leading-snug text-zinc-500 dark:text-zinc-400">
                    Preferred processor, bank / payout details you edit here
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
