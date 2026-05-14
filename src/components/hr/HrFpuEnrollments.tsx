'use client';

import React, { useEffect, useMemo, useState } from 'react';
import {
  GraduationCap,
  RefreshCw,
  Search,
  Loader2,
  Mail,
  Building2,
  Clock,
  Inbox,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';

type FpuEnrollment = {
  id: string;
  email: string;
  full_name: string;
  department: string;
  shift_schedule_est: string;
  created_at: string;
};

type ApiResponse = {
  rows: FpuEnrollment[];
  source: 'table' | 'audit';
  error: string | null;
};

const formatDate = (iso: string) => {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
};

export default function HrFpuEnrollments() {
  const [rows, setRows] = useState<FpuEnrollment[]>([]);
  const [source, setSource] = useState<'table' | 'audit' | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const load = async (showSpinner = true) => {
    if (showSpinner) setLoading(true);
    else setRefreshing(true);
    try {
      const res = await fetch('/api/hr/fpu-enrollments', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as ApiResponse;
      setRows(json.rows ?? []);
      setSource(json.source ?? null);
      setError(json.error ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load enrollments');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void load(true);
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        r.email.toLowerCase().includes(q) ||
        r.full_name.toLowerCase().includes(q) ||
        r.department.toLowerCase().includes(q) ||
        r.shift_schedule_est.toLowerCase().includes(q),
    );
  }, [rows, query]);

  const handleRefresh = async () => {
    await load(false);
    toast.success('Refreshed FPU enrollments');
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-gradient-to-br from-white via-emerald-50/30 to-teal-50/20 p-4 sm:p-6 dark:bg-none dark:bg-[#0d1117]">
      <div className="mx-auto w-full max-w-6xl space-y-5">
        {/* Header */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-100 to-teal-100 text-emerald-700 ring-1 ring-emerald-100 dark:from-emerald-950/60 dark:to-teal-950/40 dark:text-emerald-300 dark:ring-emerald-900/60">
              <GraduationCap className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-700 dark:text-emerald-300">
                Financial Peace University
              </p>
              <h2 className="mt-0.5 text-2xl font-bold tracking-tight text-zinc-900 dark:text-white">
                FPU Enrollments
              </h2>
              <p className="mt-1 max-w-2xl text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
                Submissions from the employee FPU sign-up form. Completing FPU is the only
                path into the MESA program — review and follow up with each enrollee here.
              </p>
            </div>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            disabled={refreshing || loading}
            className="gap-1.5"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`}
            />
            Refresh
          </Button>
        </div>

        {/* Stat strip */}
        <div className="grid gap-3 sm:grid-cols-3">
          <StatCard
            label="Total enrollments"
            value={rows.length}
            tone="emerald"
          />
          <StatCard
            label="This month"
            value={
              rows.filter((r) => {
                const d = new Date(r.created_at);
                const now = new Date();
                return (
                  d.getFullYear() === now.getFullYear() &&
                  d.getMonth() === now.getMonth()
                );
              }).length
            }
            tone="teal"
          />
          <StatCard
            label="Distinct departments"
            value={new Set(rows.map((r) => r.department.trim().toLowerCase())).size}
            tone="zinc"
          />
        </div>

        {/* Data source notice */}
        {source === 'audit' && (
          <div className="rounded-lg border border-amber-200/80 bg-amber-50/70 px-4 py-2.5 text-xs leading-relaxed text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">
            Showing data from the audit log because the <code>fpu_enrollments</code> table
            doesn’t exist yet. Run <code>references/add_fpu_enrollments.sql</code> to enable
            full persistence and richer queries.
          </div>
        )}
        {error && (
          <div className="rounded-lg border border-rose-200/80 bg-rose-50/70 px-4 py-2.5 text-xs text-rose-900 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-100">
            {error}
          </div>
        )}

        {/* Search */}
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name, email, department, or shift…"
            className="h-9 border-zinc-200 bg-white pl-9 text-sm focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20 dark:border-zinc-800 dark:bg-zinc-900/60"
          />
        </div>

        {/* List */}
        <Card className="overflow-hidden border-emerald-100/80 shadow-sm dark:border-emerald-900/40">
          <CardHeader className="border-b border-emerald-100/80 bg-emerald-50/30 px-5 py-3 dark:border-emerald-900/40 dark:bg-emerald-950/20">
            <CardTitle className="text-sm font-semibold text-zinc-900 dark:text-white">
              {loading ? 'Loading enrollments…' : `${filtered.length} enrollment${filtered.length === 1 ? '' : 's'}`}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {loading ? (
              <div className="flex items-center justify-center gap-2 px-5 py-12 text-sm text-zinc-500 dark:text-zinc-400">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading…
              </div>
            ) : filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 px-5 py-12 text-center text-sm text-zinc-500 dark:text-zinc-400">
                <Inbox className="h-6 w-6 text-zinc-400" />
                {rows.length === 0
                  ? 'No FPU enrollments yet — submissions from the employee sign-up form will appear here.'
                  : 'No results match your search.'}
              </div>
            ) : (
              <ul className="divide-y divide-emerald-100/80 dark:divide-emerald-900/40">
                {filtered.map((r) => (
                  <li
                    key={r.id}
                    className="flex flex-wrap items-start gap-4 px-5 py-4 transition-colors hover:bg-emerald-50/30 dark:hover:bg-emerald-950/20"
                  >
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-50 to-teal-100/70 text-emerald-600 ring-1 ring-emerald-100 dark:from-emerald-950/60 dark:to-teal-950/40 dark:text-emerald-300 dark:ring-emerald-900/60">
                      <GraduationCap className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-2">
                        <p className="text-sm font-semibold text-zinc-900 dark:text-white">
                          {r.full_name || '—'}
                        </p>
                        <span className="text-xs text-zinc-500 dark:text-zinc-500">
                          submitted {formatDate(r.created_at)}
                        </span>
                      </div>
                      <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-zinc-600 dark:text-zinc-400">
                        <span className="inline-flex items-center gap-1">
                          <Mail className="h-3.5 w-3.5 text-zinc-400" />
                          <a
                            href={`mailto:${r.email}`}
                            className="font-mono text-zinc-700 hover:text-emerald-700 dark:text-zinc-300 dark:hover:text-emerald-300"
                          >
                            {r.email}
                          </a>
                        </span>
                        <span className="inline-flex items-center gap-1">
                          <Building2 className="h-3.5 w-3.5 text-zinc-400" />
                          {r.department || '—'}
                        </span>
                        <span className="inline-flex items-center gap-1">
                          <Clock className="h-3.5 w-3.5 text-zinc-400" />
                          {r.shift_schedule_est || '—'}
                        </span>
                      </div>
                    </div>
                    <Badge
                      variant="outline"
                      className="border-emerald-200 bg-emerald-50 text-[10.5px] font-semibold uppercase tracking-wide text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-500/15 dark:text-emerald-200"
                    >
                      Awaiting class
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'emerald' | 'teal' | 'zinc';
}) {
  const styles = {
    emerald:
      'border-emerald-200 bg-gradient-to-br from-emerald-50 to-white text-emerald-900 dark:border-emerald-700/40 dark:from-emerald-950/40 dark:to-zinc-950 dark:text-emerald-100',
    teal:
      'border-teal-200 bg-gradient-to-br from-teal-50 to-white text-teal-900 dark:border-teal-700/40 dark:from-teal-950/40 dark:to-zinc-950 dark:text-teal-100',
    zinc:
      'border-zinc-200 bg-white text-zinc-900 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-100',
  }[tone];
  return (
    <div className={`rounded-xl border p-4 shadow-sm ${styles}`}>
      <p className="text-[11px] font-medium uppercase tracking-wide opacity-70">{label}</p>
      <p className="mt-1 font-mono text-2xl font-bold tabular-nums">{value}</p>
    </div>
  );
}
