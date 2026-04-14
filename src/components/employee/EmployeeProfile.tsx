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
  MapPin,
  Landmark,
  Pencil,
  ArrowRight,
  CreditCard,
  ShieldCheck,
} from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent } from '@/components/ui/card';
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

interface EmployeeProfileProps {
  employeeEmail: string;
  profilePhotoUrl: string | null;
  onProfilePhotoUpdated: (url: string) => void;
  onNavigateToSettings?: () => void;
}

function formatPHP(n: number): string {
  return '₱' + n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function parseRate(v: string | null | undefined): number | null {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function pickRow(row: Record<string, unknown>, aliases: string[]): string | null {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
  const entries = Object.entries(row);
  for (const a of aliases) {
    const want = norm(a);
    for (const [k, v] of entries) {
      if (norm(k) === want && v != null && String(v).trim() !== '') {
        return String(v).trim();
      }
    }
  }
  return null;
}

function maskAccountNumber(num: string | null): string | null {
  if (!num?.trim()) return null;
  const s = num.trim();
  if (s.length <= 4) return s;
  return '••••' + s.slice(-4);
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

function hubstaffRowMatchesEmail(row: Record<string, unknown>, n: string): boolean {
  const emails: string[] = [];
  for (const k of ['Email', 'email', 'Work Email', 'work_email', 'user_email']) {
    if (Object.prototype.hasOwnProperty.call(row, k)) {
      const v = row[k];
      if (v != null && String(v).trim()) emails.push(String(v));
    }
  }
  return emails.some((e) => normEmail(e) === n);
}

/* ---------- Skeleton ---------- */
function ProfileSkeleton() {
  return (
    <div className="box-border flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-gradient-to-br from-white via-orange-50/30 to-blue-50/20 dark:bg-none dark:bg-[#0d1117]">
      {/* Hero skeleton */}
      <div className="shrink-0 border-b border-zinc-200/60 bg-gradient-to-r from-orange-50/60 via-white to-blue-50/40 px-4 py-6 sm:px-6 dark:border-zinc-800 dark:from-zinc-900/60 dark:via-zinc-950 dark:to-zinc-900/60">
        <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start sm:gap-5">
          <div className="h-20 w-20 animate-pulse rounded-full bg-zinc-200 dark:bg-zinc-800 sm:h-24 sm:w-24" />
          <div className="flex flex-1 flex-col items-center gap-2 sm:items-start">
            <div className="h-6 w-48 animate-pulse rounded-md bg-zinc-200 dark:bg-zinc-800" />
            <div className="h-4 w-36 animate-pulse rounded bg-zinc-200/70 dark:bg-zinc-800/70" />
            <div className="mt-1 flex gap-2">
              <div className="h-6 w-16 animate-pulse rounded-full bg-zinc-200 dark:bg-zinc-800" />
              <div className="h-6 w-20 animate-pulse rounded-full bg-zinc-200 dark:bg-zinc-800" />
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
}: {
  icon?: React.ComponentType<{ className?: string }>;
  label: string;
  value: string | null;
  mono?: boolean;
}) {
  if (!value) return null;
  return (
    <div className="flex items-start gap-2.5 py-1.5">
      {Icon && <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-400 dark:text-zinc-500" />}
      <div className="min-w-0 flex-1">
        <div className="text-[10px] font-medium uppercase tracking-wide text-zinc-400 dark:text-zinc-500">{label}</div>
        <div className={`mt-0.5 text-xs text-zinc-900 dark:text-zinc-100 ${mono ? 'break-all font-mono text-[11px]' : ''}`}>{value}</div>
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
      <div className="flex items-center gap-2 border-b border-zinc-100 px-4 py-2.5 dark:border-zinc-800">
        <Icon className="h-4 w-4 shrink-0 text-orange-500 dark:text-orange-400" />
        <span className="text-xs font-semibold tracking-tight text-zinc-900 dark:text-white">{title}</span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-0 px-4 py-2">{children}</div>
    </div>
  );
}

export default function EmployeeProfile({
  employeeEmail,
  profilePhotoUrl,
  onProfilePhotoUpdated,
  onNavigateToSettings,
}: EmployeeProfileProps) {
  const norm = normEmail(employeeEmail) ?? employeeEmail.toLowerCase();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [master, setMaster] = useState<EmployeeRow | null>(null);
  const [rate, setRate] = useState<EmployeeHourlyRateRow | null>(null);
  const [bankInfo, setBankInfo] = useState<EmployeeIdRow | null>(null);
  const [hubMeta, setHubMeta] = useState<{
    memberName: string | null;
    jobType: string | null;
    jobTitle: string | null;
    organization: string | null;
  } | null>(null);
  const [usdToPhpRate, setUsdToPhpRate] = useState(OFFICIAL_USD_TO_PHP_RATE);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setError(null);
      setLoading(true);
      try {
        const [empRes, rateRes, hubRes, idsRes, fxRes] = await Promise.all([
          fetch('/api/employees', { cache: 'no-store' }),
          fetch('/api/employee-hourly-rates', { cache: 'no-store' }),
          fetch(`/api/hubstaff-hours?_=${Date.now()}`, { cache: 'no-store' }),
          fetch('/api/employee-ids', { cache: 'no-store' }),
          fetch('/api/app-settings?key=usd_to_php_rate', { cache: 'no-store' }),
        ]);

        const empJson = (await empRes.json()) as { employees?: EmployeeRow[]; error?: string | null };
        const rateJson = (await rateRes.json()) as { rows?: EmployeeHourlyRateRow[]; error?: string | null };
        const hubJson = (await hubRes.json()) as {
          rows?: Record<string, unknown>[] | null;
          error?: string | null;
        };
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

        const hubRows = hubJson.rows ?? [];
        const hubRow = hubRows.find((r) => hubstaffRowMatchesEmail(r, norm));
        if (hubRow) {
          setHubMeta({
            memberName: pickRow(hubRow, ['Member', 'member', 'Name', 'name']),
            jobType: pickRow(hubRow, ['Job type', 'Job Type', 'job_type', 'job type']),
            jobTitle: pickRow(hubRow, ['Job title', 'Job Title', 'job_title', 'job title']),
            organization: pickRow(hubRow, ['Organization', 'organization', 'org']),
          });
        } else {
          setHubMeta(null);
        }

        const idRows = idsJson.rows ?? [];
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
    master?.name?.trim() ||
    hubMeta?.memberName?.trim() ||
    employeeEmail.split('@')[0]?.replace(/\./g, ' ') ||
    '—';

  const department = rate?.department?.trim() || master?.department?.trim() || null;
  const reg = parseRate(rate?.regular_rate ?? null);
  const ot = parseRate(rate?.ot_rate ?? null);

  const avatarEmail =
    master?.work_email?.trim() || rate?.work_email?.trim() || employeeEmail.trim() || null;

  const displayProfilePhotoUrl =
    profilePhotoUrl?.trim() || master?.profile_photo_url?.trim() || null;

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

  if (loading) return <ProfileSkeleton />;

  return (
    <div className="box-border flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-gradient-to-br from-white via-orange-50/30 to-blue-50/20 dark:bg-none dark:bg-[#0d1117]">
      {/* ── Hero header ── */}
      <div className="shrink-0 border-b border-zinc-200/60 bg-gradient-to-r from-orange-50/60 via-white to-blue-50/40 px-4 py-5 sm:px-6 sm:py-6 dark:border-zinc-800 dark:from-zinc-900/60 dark:via-zinc-950 dark:to-zinc-900/60">
        <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-center sm:gap-5">
          {/* Avatar — large */}
          <div className="group relative shrink-0">
            <div className="rounded-full ring-4 ring-white/80 dark:ring-zinc-900/80">
              <EmployeeAvatar
                photoUrl={displayProfilePhotoUrl}
                email={avatarEmail}
                initials={avatarInitials}
                className="h-20 w-20 text-2xl sm:h-24 sm:w-24 sm:text-3xl"
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
          <div className="flex flex-1 flex-col items-center gap-1.5 sm:items-start">
            <h2 className="text-xl font-bold tracking-tight text-zinc-900 sm:text-2xl dark:text-white">
              {displayName}
            </h2>
            <p className="font-mono text-xs text-zinc-500 dark:text-zinc-400">{employeeEmail}</p>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              {department && (
                <Badge variant="outline" className="gap-1 border-orange-200 bg-orange-50 text-orange-700 dark:border-orange-800/50 dark:bg-orange-950/30 dark:text-orange-400">
                  <Building2 className="h-3 w-3" />
                  {department}
                </Badge>
              )}
              {hubMeta?.jobTitle && (
                <Badge variant="outline" className="gap-1 border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-800/50 dark:bg-blue-950/30 dark:text-blue-400">
                  <Briefcase className="h-3 w-3" />
                  {hubMeta.jobTitle}
                </Badge>
              )}
              {master?.employee_id && (
                <Badge variant="outline" className="gap-1 border-zinc-200 bg-zinc-50 font-mono text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900/40 dark:text-zinc-400">
                  <Hash className="h-3 w-3" />
                  {master.employee_id}
                </Badge>
              )}
            </div>
          </div>

          {/* Upload button — visible on mobile */}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 text-[11px] sm:hidden"
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
              {rate || hubMeta ? (
                <>
                  No <span className="font-mono">global_master_list</span> row for{' '}
                  <span className="font-mono font-medium">{employeeEmail}</span> — Hubstaff / rates only.
                </>
              ) : (
                <>
                  No directory or payroll row for <span className="font-mono font-medium">{employeeEmail}</span>.
                </>
              )}
            </p>
          </div>
        )}

        <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 sm:grid-cols-2">
          {/* Identity */}
          <ProfilePanel title="Identity" icon={User}>
            <FieldRow icon={User} label="Full Name" value={displayName === '—' ? null : displayName} />
            <FieldRow icon={Hash} label="Employee ID" value={master?.employee_id ?? null} mono />
          </ProfilePanel>

          {/* Contact */}
          <ProfilePanel title="Contact" icon={Mail}>
            <FieldRow icon={Mail} label="Work Email" value={master?.work_email?.trim() || rate?.work_email?.trim() || null} mono />
            <FieldRow icon={Mail} label="Personal Email" value={master?.personal_email?.trim() || rate?.personal_email?.trim() || null} mono />
          </ProfilePanel>

          {/* Employment */}
          <ProfilePanel title="Employment" icon={Briefcase}>
            <FieldRow icon={Building2} label="Department" value={department} />
            <FieldRow icon={Briefcase} label="Job Type" value={hubMeta?.jobType} />
            <FieldRow icon={Briefcase} label="Job Title" value={hubMeta?.jobTitle} />
            <FieldRow icon={MapPin} label="Organization" value={hubMeta?.organization} />
            <FieldRow icon={Calendar} label="Start Date" value={formatStartDate(master?.start_date ?? null)} />
          </ProfilePanel>

          {/* Compensation */}
          <ProfilePanel title="Compensation" icon={Banknote}>
            <FieldRow icon={Banknote} label="Regular Rate" value={reg != null ? `${formatPHP(reg)} / hr` : null} />
            <FieldRow icon={Banknote} label="Overtime Rate" value={ot != null ? `${formatPHP(ot)} / hr` : null} />
            <div className="border-t border-zinc-100 pt-2 dark:border-zinc-800">
              <div className="text-[10px] font-medium uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
                USD → PHP (payroll)
              </div>
              <p className="mt-1 font-mono text-xs text-zinc-700 dark:text-zinc-300">
                ₱{usdToPhpRate.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 5 })} = $1 USD
              </p>
            </div>
            {!reg && !ot && (
              <p className="py-2 text-[10px] text-zinc-400 dark:text-zinc-500">
                No hourly rates set yet. Contact HR.
              </p>
            )}
          </ProfilePanel>

          {/* Bank Information */}
          <div className="col-span-1 sm:col-span-2">
            <div className="flex min-h-0 flex-col rounded-xl border border-zinc-200/90 bg-white/90 shadow-sm transition-shadow hover:shadow-md dark:border-zinc-700/80 dark:bg-zinc-900/50">
              <div className="flex items-center justify-between border-b border-zinc-100 px-4 py-2.5 dark:border-zinc-800">
                <div className="flex items-center gap-2">
                  <Landmark className="h-4 w-4 shrink-0 text-orange-500 dark:text-orange-400" />
                  <span className="text-xs font-semibold tracking-tight text-zinc-900 dark:text-white">Bank Information</span>
                </div>
                {onNavigateToSettings && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 gap-1.5 text-[10px]"
                    onClick={onNavigateToSettings}
                  >
                    <Pencil className="h-3 w-3" />
                    Edit
                    <ArrowRight className="h-3 w-3" />
                  </Button>
                )}
              </div>
              <div className="px-4 py-3">
                {bankInfo && (bankInfo.bank_name || bankInfo.account_number || bankInfo.alt_bank_name) ? (
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {/* Primary Account */}
                    <div className="rounded-lg border border-zinc-100 bg-zinc-50/60 p-3 dark:border-zinc-800 dark:bg-zinc-900/40">
                      <div className="mb-2 flex items-center gap-1.5">
                        <CreditCard className="h-3.5 w-3.5 text-zinc-500" />
                        <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Primary Account</span>
                      </div>
                      <div className="space-y-1.5">
                        {bankInfo.bank_name && (
                          <div>
                            <div className="text-[9px] font-medium uppercase tracking-wide text-zinc-400">Bank</div>
                            <div className="text-xs font-medium text-zinc-900 dark:text-zinc-100">{bankInfo.bank_name}</div>
                          </div>
                        )}
                        {bankInfo.account_holder_name && (
                          <div>
                            <div className="text-[9px] font-medium uppercase tracking-wide text-zinc-400">Account Holder</div>
                            <div className="text-xs text-zinc-900 dark:text-zinc-100">{bankInfo.account_holder_name}</div>
                          </div>
                        )}
                        {bankInfo.account_number && (
                          <div>
                            <div className="text-[9px] font-medium uppercase tracking-wide text-zinc-400">Account Number</div>
                            <div className="font-mono text-xs text-zinc-900 dark:text-zinc-100">{maskAccountNumber(bankInfo.account_number)}</div>
                          </div>
                        )}
                        {bankInfo.routing_number && (
                          <div>
                            <div className="text-[9px] font-medium uppercase tracking-wide text-zinc-400">Routing Number</div>
                            <div className="font-mono text-xs text-zinc-900 dark:text-zinc-100">{bankInfo.routing_number}</div>
                          </div>
                        )}
                        {!bankInfo.bank_name && !bankInfo.account_number && (
                          <p className="text-[10px] text-zinc-400">Not set</p>
                        )}
                      </div>
                    </div>
                    {/* Alternative Account */}
                    <div className="rounded-lg border border-zinc-100 bg-zinc-50/60 p-3 dark:border-zinc-800 dark:bg-zinc-900/40">
                      <div className="mb-2 flex items-center gap-1.5">
                        <ShieldCheck className="h-3.5 w-3.5 text-zinc-500" />
                        <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Alternative Account</span>
                      </div>
                      <div className="space-y-1.5">
                        {bankInfo.alt_bank_name && (
                          <div>
                            <div className="text-[9px] font-medium uppercase tracking-wide text-zinc-400">Bank</div>
                            <div className="text-xs font-medium text-zinc-900 dark:text-zinc-100">{bankInfo.alt_bank_name}</div>
                          </div>
                        )}
                        {bankInfo.alt_account_holder_name && (
                          <div>
                            <div className="text-[9px] font-medium uppercase tracking-wide text-zinc-400">Account Holder</div>
                            <div className="text-xs text-zinc-900 dark:text-zinc-100">{bankInfo.alt_account_holder_name}</div>
                          </div>
                        )}
                        {bankInfo.alt_account_number && (
                          <div>
                            <div className="text-[9px] font-medium uppercase tracking-wide text-zinc-400">Account Number</div>
                            <div className="font-mono text-xs text-zinc-900 dark:text-zinc-100">{maskAccountNumber(bankInfo.alt_account_number)}</div>
                          </div>
                        )}
                        {bankInfo.alt_routing_number && (
                          <div>
                            <div className="text-[9px] font-medium uppercase tracking-wide text-zinc-400">Routing Number</div>
                            <div className="font-mono text-xs text-zinc-900 dark:text-zinc-100">{bankInfo.alt_routing_number}</div>
                          </div>
                        )}
                        {!bankInfo.alt_bank_name && !bankInfo.alt_account_number && (
                          <p className="text-[10px] text-zinc-400">Not set</p>
                        )}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col items-center gap-2 py-4 text-center">
                    <Landmark className="h-8 w-8 text-zinc-300 dark:text-zinc-700" />
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">No bank information on file</p>
                    {onNavigateToSettings && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="mt-1 h-8 gap-1.5 text-[11px]"
                        onClick={onNavigateToSettings}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                        Add Bank Details in Settings
                        <ArrowRight className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Data Sources */}
          <div className="col-span-1 sm:col-span-2">
            <div className="rounded-xl border border-zinc-200/90 bg-gradient-to-br from-emerald-50/40 to-zinc-50/30 p-4 shadow-sm dark:border-zinc-700/80 dark:from-emerald-950/20 dark:to-zinc-950/40">
              <div className="mb-2.5 flex items-center gap-2">
                <BadgeCheck className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                <span className="text-xs font-semibold text-zinc-900 dark:text-white">Data Sources</span>
              </div>
              <p className="mb-3 text-[10px] leading-relaxed text-zinc-600 sm:text-[11px] dark:text-zinc-400">
                Profile data is assembled from three Supabase tables. Contact HR to update official records.
              </p>
              <div className="grid grid-cols-1 gap-2 text-[10px] sm:grid-cols-3 sm:gap-3 sm:text-[11px]">
                <div className="rounded-lg border border-white/60 bg-white/60 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900/40">
                  <span className="font-mono font-medium text-zinc-800 dark:text-zinc-200">global_master_list</span>
                  <p className="mt-0.5 leading-snug text-zinc-500 dark:text-zinc-400">Name, emails, start date, employee ID</p>
                </div>
                <div className="rounded-lg border border-white/60 bg-white/60 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900/40">
                  <span className="font-mono font-medium text-zinc-800 dark:text-zinc-200">employee_hourly_rates</span>
                  <p className="mt-0.5 leading-snug text-zinc-500 dark:text-zinc-400">Department, regular &amp; OT rates</p>
                </div>
                <div className="rounded-lg border border-white/60 bg-white/60 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900/40">
                  <span className="font-mono font-medium text-zinc-800 dark:text-zinc-200">hubstaff_hours</span>
                  <p className="mt-0.5 leading-snug text-zinc-500 dark:text-zinc-400">Job type, title, organization</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
