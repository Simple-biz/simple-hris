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
} from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import EmployeeAvatar from './EmployeeAvatar';
import { normEmail } from '@/lib/email/norm-email';
import { compressProfilePhotoForUpload } from '@/lib/images/compress-profile-photo';
import type { EmployeeRow } from '@/lib/supabase/employees';
import type { EmployeeHourlyRateRow } from '@/lib/supabase/employee-hourly-rates';

interface EmployeeProfileProps {
  employeeEmail: string;
  profilePhotoUrl: string | null;
  onProfilePhotoUpdated: (url: string) => void;
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

type ProfileField = { label: string; value: string | null; mono?: boolean };

function FieldRow({ label, value, mono }: { label: string; value: string | null; mono?: boolean }) {
  if (!value) return null;
  return (
    <div className="grid grid-cols-[minmax(0,7.5rem)_1fr] items-start gap-x-2 gap-y-0.5 text-[11px] leading-snug sm:grid-cols-[9rem_1fr] sm:text-xs">
      <span className="font-medium text-zinc-500 dark:text-zinc-400">{label}</span>
      <span className={`text-zinc-900 dark:text-zinc-100 ${mono ? 'break-all font-mono text-[10px] sm:text-xs' : ''}`}>
        {value}
      </span>
    </div>
  );
}

function ProfilePanel({
  title,
  icon: Icon,
  fields,
  className,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  fields: ProfileField[];
  className?: string;
}) {
  const rows = fields.filter((f) => f.value);
  if (rows.length === 0) return null;
  return (
    <div
      className={`flex min-h-0 flex-col rounded-xl border border-zinc-200/90 bg-white/90 p-3 shadow-sm dark:border-zinc-700/80 dark:bg-zinc-900/50 ${className ?? ''}`}
    >
      <div className="mb-2.5 flex items-center gap-2 border-b border-zinc-100 pb-2 dark:border-zinc-800">
        <Icon className="h-3.5 w-3.5 shrink-0 text-orange-500 dark:text-orange-400" />
        <span className="text-xs font-semibold tracking-tight text-zinc-900 dark:text-white">{title}</span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2">{rows.map((f) => <FieldRow key={f.label} {...f} />)}</div>
    </div>
  );
}

export default function EmployeeProfile({
  employeeEmail,
  profilePhotoUrl,
  onProfilePhotoUpdated,
}: EmployeeProfileProps) {
  const norm = normEmail(employeeEmail) ?? employeeEmail.toLowerCase();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [master, setMaster] = useState<EmployeeRow | null>(null);
  const [rate, setRate] = useState<EmployeeHourlyRateRow | null>(null);
  const [hubMeta, setHubMeta] = useState<{
    memberName: string | null;
    jobType: string | null;
    jobTitle: string | null;
    organization: string | null;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setError(null);
      setLoading(true);
      try {
        const [empRes, rateRes, hubRes] = await Promise.all([
          fetch('/api/employees', { cache: 'no-store' }),
          fetch('/api/employee-hourly-rates', { cache: 'no-store' }),
          fetch(`/api/hubstaff-hours?_=${Date.now()}`, { cache: 'no-store' }),
        ]);

        const empJson = (await empRes.json()) as { employees?: EmployeeRow[]; error?: string | null };
        const rateJson = (await rateRes.json()) as { rows?: EmployeeHourlyRateRow[]; error?: string | null };
        const hubJson = (await hubRes.json()) as {
          rows?: Record<string, unknown>[] | null;
          error?: string | null;
        };

        if (cancelled) return;

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

  const identity: ProfileField[] = [
    { label: 'Full name', value: displayName === '—' ? null : displayName },
    { label: 'Employee ID', value: master?.employee_id ?? null, mono: true },
  ];

  const contact: ProfileField[] = [
    { label: 'Work email', value: master?.work_email?.trim() || rate?.work_email?.trim() || null, mono: true },
    { label: 'Personal email', value: master?.personal_email?.trim() || rate?.personal_email?.trim() || null, mono: true },
  ];

  const employment: ProfileField[] = [
    { label: 'Department', value: department },
    { label: 'Job type', value: hubMeta?.jobType },
    { label: 'Job title', value: hubMeta?.jobTitle },
    { label: 'Organization', value: hubMeta?.organization },
    { label: 'Start date', value: formatStartDate(master?.start_date ?? null) },
  ];

  const reg = parseRate(rate?.regular_rate ?? null);
  const ot = parseRate(rate?.ot_rate ?? null);
  const pay: ProfileField[] = [
    { label: 'Regular rate', value: reg != null ? `${formatPHP(reg)} / hr` : null },
    { label: 'Overtime rate', value: ot != null ? `${formatPHP(ot)} / hr` : null },
  ];

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

  if (loading) {
    return (
      <div className="flex h-full min-h-0 flex-1 items-center justify-center bg-gradient-to-br from-white via-orange-50/30 to-blue-50/20 dark:bg-none dark:bg-[#0d1117]">
        <Loader2 className="h-8 w-8 animate-spin text-orange-500" />
      </div>
    );
  }

  return (
    <div className="box-border flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-gradient-to-br from-white via-orange-50/30 to-blue-50/20 dark:bg-none dark:bg-[#0d1117]">
      {/* Header — compact */}
      <div className="shrink-0 px-3 pb-2 pt-3 sm:px-4 sm:pb-3 sm:pt-4 md:px-5">
        <div className="flex items-start gap-3">
          <div className="relative shrink-0">
            <EmployeeAvatar
              photoUrl={displayProfilePhotoUrl}
              email={avatarEmail}
              initials={avatarInitials}
              className="h-11 w-11 text-sm"
              pixelSize={88}
            />
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              className="sr-only"
              aria-label="Upload profile photo"
              onChange={onAvatarFileChange}
              disabled={uploadingPhoto}
            />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-bold tracking-tight text-zinc-900 sm:text-xl dark:text-white">Profile</h2>
            <p className="mt-0.5 text-[11px] leading-snug text-zinc-600 sm:text-xs dark:text-zinc-500">
              HR directory &amp; payroll (Supabase). Contact HR to update official records.
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 text-[11px]"
                disabled={uploadingPhoto}
                onClick={() => fileInputRef.current?.click()}
              >
                {uploadingPhoto ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Camera className="h-3.5 w-3.5" />
                )}
                {uploadingPhoto ? 'Uploading…' : 'Photo'}
              </Button>
            </div>
            <p className="mt-1 text-[10px] leading-snug text-zinc-400 dark:text-zinc-600">
              Uploaded photo is stored in Supabase (max 5 MB; larger images are resized). Otherwise Gravatar for
              your work email, then initials.
            </p>
          </div>
        </div>
      </div>

      {/* Single viewport: scroll only if needed on very small screens */}
      <div className="flex min-h-0 flex-1 flex-col px-3 pb-3 sm:px-4 md:px-5">
        <Card className="flex min-h-0 flex-1 flex-col overflow-hidden border-zinc-200/90 bg-white/95 shadow-md dark:border-zinc-800 dark:bg-zinc-950/80">
          <CardContent className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3 sm:p-4">
            {error && (
              <div className="flex shrink-0 items-start gap-2 rounded-lg border border-amber-200/80 bg-amber-50/90 px-3 py-2 dark:border-amber-900/50 dark:bg-amber-950/40">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                <p className="text-[11px] leading-snug text-amber-950 dark:text-amber-200">{error}</p>
              </div>
            )}

            {!master && !error && (
              <div className="flex shrink-0 items-start gap-2 rounded-lg border border-zinc-200 bg-zinc-50/90 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900/50">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-zinc-400" />
                <p className="text-[11px] leading-snug text-zinc-600 dark:text-zinc-400">
                  {rate || hubMeta ? (
                    <>
                      No <span className="font-mono">global_master_list</span> row for{' '}
                      <span className="font-mono font-medium">{employeeEmail}</span> — Hubstaff / rates only. Ask HR to add
                      your record for full directory info.
                    </>
                  ) : (
                    <>
                      No directory or payroll row for <span className="font-mono font-medium">{employeeEmail}</span>.
                      Match <span className="font-mono">global_master_list</span> or{' '}
                      <span className="font-mono">employee_hourly_rates</span>.
                    </>
                  )}
                </p>
              </div>
            )}

            {master && !rate && !error && (
              <p className="shrink-0 text-[10px] text-zinc-500 dark:text-zinc-400">
                No hourly rates in <span className="font-mono">employee_hourly_rates</span> for this email yet.
              </p>
            )}

            {/* Main grid: 2×2 + footer row */}
            <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-3 lg:grid-cols-12 lg:gap-3">
              <div className="min-h-0 sm:col-span-1 lg:col-span-6">
                <ProfilePanel title="Identity" icon={User} fields={identity} className="h-full" />
              </div>
              <div className="min-h-0 sm:col-span-1 lg:col-span-6">
                <ProfilePanel title="Contact" icon={Mail} fields={contact} className="h-full" />
              </div>
              <div className="min-h-0 sm:col-span-1 lg:col-span-6">
                <ProfilePanel title="Employment" icon={Briefcase} fields={employment} className="h-full" />
              </div>
              <div className="min-h-0 sm:col-span-1 lg:col-span-6">
                <ProfilePanel title="Compensation" icon={Banknote} fields={pay} className="h-full" />
              </div>

              <div className="col-span-1 min-h-0 sm:col-span-2 lg:col-span-12">
                <div className="rounded-xl border border-zinc-200/90 bg-gradient-to-br from-emerald-50/40 to-zinc-50/30 p-3 dark:border-zinc-700/80 dark:from-emerald-950/20 dark:to-zinc-950/40">
                  <div className="mb-2 flex items-center gap-2">
                    <BadgeCheck className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                    <span className="text-xs font-semibold text-zinc-900 dark:text-white">Data sources</span>
                  </div>
                  <p className="mb-2 text-[10px] leading-relaxed text-zinc-600 dark:text-zinc-400 sm:text-[11px]">
                    Job type, title, and organization come from the latest <span className="font-mono">hubstaff_hours</span>{' '}
                    row when present. Department may be overridden by <span className="font-mono">employee_hourly_rates</span>.
                  </p>
                  <div className="grid grid-cols-1 gap-2 text-[10px] text-zinc-600 sm:grid-cols-3 sm:gap-3 sm:text-[11px] dark:text-zinc-400">
                    <div className="rounded-md border border-white/60 bg-white/50 px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-900/40">
                      <span className="font-mono text-zinc-800 dark:text-zinc-200">global_master_list</span>
                      <p className="mt-0.5 leading-snug">Name, emails, start date, employee ID</p>
                    </div>
                    <div className="rounded-md border border-white/60 bg-white/50 px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-900/40">
                      <span className="font-mono text-zinc-800 dark:text-zinc-200">employee_hourly_rates</span>
                      <p className="mt-0.5 leading-snug">Department, regular &amp; OT rates</p>
                    </div>
                    <div className="rounded-md border border-white/60 bg-white/50 px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-900/40">
                      <span className="font-mono text-zinc-800 dark:text-zinc-200">hubstaff_hours</span>
                      <p className="mt-0.5 leading-snug">Job type, title, organization</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
