'use client';

import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { Check, Clock, Eye, ImageOff, Loader2, Lock, Trash2, X } from 'lucide-react';
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
  onDelete: (id: string) => void;
  deletingId: string | null;
  locked?: boolean;
};

const STATUS_BADGE: Record<string, string> = {
  pending: 'border-amber-400 bg-amber-50 text-amber-700 dark:border-amber-600 dark:bg-amber-950/40 dark:text-amber-300',
  manager_approved: 'border-blue-400 bg-blue-50 text-blue-700 dark:border-blue-600 dark:bg-blue-950/40 dark:text-blue-300',
  manager_denied: 'border-rose-400 bg-rose-50 text-rose-700 dark:border-rose-600 dark:bg-rose-950/40 dark:text-rose-300',
  approved: 'border-emerald-400 bg-emerald-50 text-emerald-700 dark:border-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-300',
  denied: 'border-rose-400 bg-rose-50 text-rose-700 dark:border-rose-600 dark:bg-rose-950/40 dark:text-rose-300',
};

const STATUS_LABEL: Record<string, string> = {
  pending: 'Awaiting manager',
  manager_approved: 'Manager approved',
  manager_denied: 'Manager declined',
  approved: 'Approved',
  denied: 'Denied',
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
  onDelete,
  deletingId,
  locked = false,
}: Props) {
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!lightboxUrl) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setLightboxUrl(null); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [lightboxUrl]);
  // Accounting can act ONLY on manager_approved rows.
  const actionable = adjustments.filter((a) => a.status === 'manager_approved');
  // Pending = waiting for manager, shown read-only so Accounting knows they exist.
  const awaitingManager = adjustments.filter((a) => a.status === 'pending');
  const decided = adjustments.filter(
    (a) => a.status === 'approved' || a.status === 'denied' || a.status === 'manager_denied',
  );

  if (adjustments.length === 0) return null;

  return (
    <>
      {/* Evidence lightbox — always-mounted portal so AnimatePresence owns the exit animation */}
      {typeof document !== 'undefined' && createPortal(
        <AnimatePresence>
          {lightboxUrl && (
            <motion.div
              key="lightbox-backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2, ease: 'easeOut' }}
              className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 backdrop-blur-sm"
              onClick={() => setLightboxUrl(null)}
            >
              <motion.div
                key="lightbox-img"
                initial={{ opacity: 0, scale: 0.9, y: 12 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.92, y: 8 }}
                transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
                className="relative max-h-[88vh] max-w-[90vw]"
                onClick={(e) => e.stopPropagation()}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={lightboxUrl}
                  alt="Evidence"
                  className="max-h-[88vh] max-w-[90vw] rounded-xl object-contain shadow-2xl"
                />
                <button
                  type="button"
                  onClick={() => setLightboxUrl(null)}
                  className="absolute -right-3 -top-3 flex h-7 w-7 items-center justify-center rounded-full bg-zinc-800/90 text-white ring-1 ring-zinc-600 transition hover:bg-zinc-700"
                >
                  <X className="h-4 w-4" />
                </button>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    <Card className="border-amber-200/80 bg-amber-50/40 ring-0 dark:border-amber-900/50 dark:bg-amber-950/15">
      <CardHeader className="pb-3 pt-4">
        <CardTitle className="flex items-center gap-2 text-sm text-zinc-800 dark:text-zinc-200">
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-amber-100 dark:bg-amber-950">
            <Clock className="h-3 w-3 text-amber-600 dark:text-amber-400" />
          </span>
          Time Adjustments — {deptName}
          {actionable.length > 0 && (
            <Badge variant="outline" className={STATUS_BADGE.manager_approved}>
              {actionable.length} ready to review
            </Badge>
          )}
          {awaitingManager.length > 0 && (
            <Badge variant="outline" className={STATUS_BADGE.pending}>
              {awaitingManager.length} awaiting manager
            </Badge>
          )}
        </CardTitle>
        <p className="text-xs text-zinc-600 dark:text-zinc-400">
          Manager-approved requests are ready for you to set hours and approve.
          Requests still pending manager sign-off are shown below for visibility only.
        </p>
        {locked && (
          <div className="mt-2 flex items-center gap-2 rounded-md border border-zinc-300/70 bg-zinc-100 px-3 py-2 text-[11px] font-medium text-zinc-600 dark:border-zinc-700/60 dark:bg-zinc-800/60 dark:text-zinc-400">
            <Lock className="h-3 w-3 shrink-0" />
            Payroll processing is in progress — decisions are locked until processing stops.
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-4">

        {/* Actionable: manager already approved, Accounting can decide */}
        {actionable.map((a) => {
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
                    {a.period_label && (
                      <>
                        <span className="mx-1.5 text-zinc-300">&middot;</span>
                        <span className="text-zinc-400">period {a.period_label}</span>
                      </>
                    )}
                  </p>
                </div>
                <Badge variant="outline" className={STATUS_BADGE.manager_approved}>
                  {a.manager_decided_by ? `Approved by ${a.manager_decided_by.split('@')[0]}` : 'Manager approved'}
                </Badge>
              </div>

              {a.explanation && (
                <p className="mt-2 rounded-md border border-zinc-200 bg-zinc-50/80 p-2 text-[11px] leading-relaxed text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-300">
                  {a.explanation}
                </p>
              )}
              {a.manager_decision_note && (
                <p className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">
                  <span className="font-medium">Manager note:</span> {a.manager_decision_note}
                </p>
              )}

              {/* Evidence thumbnails */}
              {a.image_paths.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  {a.image_paths.map((p, idx) => {
                    const url = signedUrls[p];
                    return url ? (
                      <button
                        key={idx}
                        type="button"
                        onClick={() => setLightboxUrl(url)}
                        className="group relative h-16 w-16 overflow-hidden rounded-md border border-zinc-200 transition-transform duration-150 hover:scale-105 hover:border-zinc-300 dark:border-zinc-700 dark:hover:border-zinc-500"
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={url} alt={`evidence ${idx + 1}`} className="h-full w-full object-cover" />
                        <div className="absolute inset-0 flex items-center justify-center bg-black/0 transition-colors group-hover:bg-black/25">
                          <Eye className="h-3.5 w-3.5 scale-0 text-white drop-shadow transition-transform group-hover:scale-100" />
                        </div>
                      </button>
                    ) : (
                      <div key={idx} className="flex h-16 w-16 items-center justify-center rounded-md border border-zinc-200 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900">
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
                  disabled={locked}
                  className="h-8 w-24"
                />
                <Button
                  size="sm"
                  className="h-8 bg-emerald-600 text-white hover:bg-emerald-700"
                  disabled={locked || isDeciding || draft.trim() === ''}
                  onClick={() => onDecide(a.id, 'approve', draft.trim() === '' ? null : parseFloat(draft))}
                >
                  {isDeciding ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Check className="mr-1 h-3 w-3" />}
                  Approve
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 border-rose-300 text-rose-600 hover:bg-rose-50 dark:border-rose-800 dark:text-rose-400"
                  disabled={locked || isDeciding}
                  onClick={() => onDecide(a.id, 'deny', null)}
                >
                  <X className="mr-1 h-3 w-3" />
                  Deny
                </Button>
              </div>
            </div>
          );
        })}

        {/* Awaiting manager: read-only, locked for Accounting */}
        {awaitingManager.length > 0 && (
          <div className="space-y-2">
            <p className="flex items-center gap-1.5 text-[11px] font-medium text-zinc-500 dark:text-zinc-400">
              <Lock className="h-3 w-3" />
              Waiting for manager sign-off before you can act
            </p>
            {awaitingManager.map((a) => (
              <div
                key={a.id}
                className="flex flex-wrap items-center gap-2 rounded-md border border-amber-200/70 bg-amber-50/60 px-3 py-2 text-[11px] dark:border-amber-900/40 dark:bg-amber-950/20"
              >
                <span className="font-mono font-medium text-zinc-700 dark:text-zinc-300">{a.adjust_date}</span>
                <span className="truncate text-zinc-600 dark:text-zinc-400">{a.work_email}</span>
                <span className="text-zinc-400">&middot;</span>
                <span className="text-zinc-500">{reasonLabel(a.reason)}</span>
                {a.requested_hours != null && (
                  <span className="ml-auto text-zinc-500">{a.requested_hours}h requested</span>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Decided rows */}
        {decided.length > 0 && (
          <div className="space-y-1.5 pt-1">
            {decided.map((a) => {
              const isDenied = a.status === 'denied' || a.status === 'manager_denied';
              const isDeleting = deletingId === a.id;
              return (
                <div
                  key={a.id}
                  className="flex flex-wrap items-center gap-2 rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-[11px] dark:border-zinc-800 dark:bg-zinc-900"
                >
                  <span className="font-mono text-zinc-600 dark:text-zinc-300">{a.adjust_date}</span>
                  <span className="truncate text-zinc-500">{a.work_email}</span>
                  <Badge variant="outline" className={`${STATUS_BADGE[a.status] ?? ''} ml-auto`}>
                    {STATUS_LABEL[a.status] ?? a.status}
                    {a.status === 'approved' && a.approved_hours != null ? ` · ${a.approved_hours}h` : ''}
                  </Badge>
                  {isDenied && (
                    <button
                      type="button"
                      disabled={isDeleting}
                      onClick={() => onDelete(a.id)}
                      title="Delete this denied request"
                      className="ml-1 flex h-5 w-5 shrink-0 items-center justify-center rounded text-zinc-400 transition hover:bg-rose-50 hover:text-rose-500 disabled:opacity-40 dark:hover:bg-rose-950/30 dark:hover:text-rose-400"
                    >
                      {isDeleting
                        ? <Loader2 className="h-3 w-3 animate-spin" />
                        : <Trash2 className="h-3 w-3" />}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
    </>
  );
}
