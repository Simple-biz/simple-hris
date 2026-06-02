'use client';

import React from 'react';
import { Check, Clock, ImageOff, Loader2, X } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  TIME_ADJUSTMENT_REASONS,
  type TimeAdjustmentRow,
} from '@/lib/supabase/time-adjustments';

type Props = {
  deptName: string;
  adjustments: TimeAdjustmentRow[];
  signedUrls: Record<string, string>;
  decidingId: string | null;
  hoursDraft: Record<string, string>;
  setHoursDraft: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  onDecide: (id: string, action: 'approve' | 'deny', approvedHours: number | null, note?: string) => void;
};

const STATUS_BADGE: Record<string, string> = {
  pending: 'border-amber-400 bg-amber-50 text-amber-700 dark:border-amber-600 dark:bg-amber-950/40 dark:text-amber-300',
  approved: 'border-emerald-400 bg-emerald-50 text-emerald-700 dark:border-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-300',
  denied: 'border-rose-400 bg-rose-50 text-rose-700 dark:border-rose-600 dark:bg-rose-950/40 dark:text-rose-300',
};

function reasonLabel(code: string): string {
  return TIME_ADJUSTMENT_REASONS.find((r) => r.code === code)?.label ?? code;
}

export default function TimeAdjustmentReviewPanel({
  deptName,
  adjustments,
  signedUrls,
  decidingId,
  hoursDraft,
  setHoursDraft,
  onDecide,
}: Props) {
  const pending = adjustments.filter((a) => a.status === 'pending');
  const decided = adjustments.filter((a) => a.status !== 'pending');

  if (adjustments.length === 0) return null;

  return (
    <Card className="border-amber-200/80 bg-amber-50/40 ring-0 dark:border-amber-900/50 dark:bg-amber-950/15">
      <CardHeader className="pb-3 pt-4">
        <CardTitle className="flex items-center gap-2 text-sm text-zinc-800 dark:text-zinc-200">
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-amber-100 dark:bg-amber-950">
            <Clock className="h-3 w-3 text-amber-600 dark:text-amber-400" />
          </span>
          Time Adjustments — {deptName}
          {pending.length > 0 && (
            <Badge variant="outline" className={STATUS_BADGE.pending}>
              {pending.length} pending
            </Badge>
          )}
        </CardTitle>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Set the corrected hours for a day and approve. Approved hours override Hubstaff for that
          day and feed this employee&apos;s pay below. Hubstaff data is never modified.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {pending.map((a) => {
          const draft = hoursDraft[a.id] ?? (a.requested_hours != null ? String(a.requested_hours) : '');
          const isDeciding = decidingId === a.id;
          return (
            <div
              key={a.id}
              className="rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-xs font-semibold text-zinc-800 dark:text-zinc-200">{a.work_email}</p>
                  <p className="mt-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">
                    <span className="font-mono font-medium text-zinc-700 dark:text-zinc-300">{a.adjust_date}</span>
                    <span className="mx-1.5 text-zinc-300">&middot;</span>
                    {reasonLabel(a.reason)}
                    {a.requested_hours != null && (
                      <>
                        <span className="mx-1.5 text-zinc-300">&middot;</span>
                        requested {a.requested_hours}h
                      </>
                    )}
                  </p>
                </div>
              </div>

              {a.explanation && (
                <p className="mt-2 rounded-md border border-zinc-200 bg-zinc-50/80 p-2 text-[11px] leading-relaxed text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-300">
                  {a.explanation}
                </p>
              )}

              {/* Evidence thumbnails */}
              {a.image_paths.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  {a.image_paths.map((p, idx) => {
                    const url = signedUrls[p];
                    return url ? (
                      <a
                        key={idx}
                        href={url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block h-16 w-16 overflow-hidden rounded-md border border-zinc-200 dark:border-zinc-700"
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={url} alt={`evidence ${idx + 1}`} className="h-full w-full object-cover" />
                      </a>
                    ) : (
                      <div
                        key={idx}
                        className="flex h-16 w-16 items-center justify-center rounded-md border border-zinc-200 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900"
                      >
                        <ImageOff className="h-4 w-4 text-zinc-300 dark:text-zinc-600" />
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="mt-2 text-[11px] italic text-zinc-400">No evidence images attached.</p>
              )}

              {/* Decision controls */}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <label className="text-[11px] font-medium text-zinc-600 dark:text-zinc-400">Set hours</label>
                <Input
                  type="number"
                  min={0}
                  max={24}
                  step={0.5}
                  value={draft}
                  onChange={(e) => setHoursDraft((prev) => ({ ...prev, [a.id]: e.target.value }))}
                  placeholder="e.g. 8"
                  className="h-8 w-24"
                />
                <Button
                  size="sm"
                  className="h-8 bg-emerald-600 text-white hover:bg-emerald-700"
                  disabled={isDeciding || draft.trim() === ''}
                  onClick={() => onDecide(a.id, 'approve', draft.trim() === '' ? null : parseFloat(draft))}
                >
                  {isDeciding ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Check className="mr-1 h-3 w-3" />}
                  Approve
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 border-rose-300 text-rose-600 hover:bg-rose-50 dark:border-rose-800 dark:text-rose-400"
                  disabled={isDeciding}
                  onClick={() => onDecide(a.id, 'deny', null)}
                >
                  <X className="mr-1 h-3 w-3" />
                  Deny
                </Button>
              </div>
            </div>
          );
        })}

        {decided.length > 0 && (
          <div className="space-y-1.5 pt-1">
            {decided.map((a) => (
              <div
                key={a.id}
                className="flex flex-wrap items-center gap-2 rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-[11px] dark:border-zinc-800 dark:bg-zinc-900"
              >
                <span className="font-mono text-zinc-600 dark:text-zinc-300">{a.adjust_date}</span>
                <span className="truncate text-zinc-500">{a.work_email}</span>
                <Badge variant="outline" className={`${STATUS_BADGE[a.status] ?? ''} ml-auto`}>
                  {a.status}
                  {a.status === 'approved' && a.approved_hours != null ? ` · ${a.approved_hours}h` : ''}
                </Badge>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
