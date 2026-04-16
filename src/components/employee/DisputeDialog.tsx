'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import type { PabDayDisputeRow, PabDisputeReasonCode } from '@/lib/supabase/pab-day-disputes';

type DisputeDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  employeeEmail: string;
  employeeName?: string | null;
  disputeDate: string;
  hoursWorked: number;
  existingDispute?: PabDayDisputeRow | null;
  onSubmitted?: () => void;
};

const STATUS_STYLES: Record<string, string> = {
  pending: 'border-amber-400 bg-amber-50 text-amber-700 dark:border-amber-600 dark:bg-amber-950/40 dark:text-amber-400',
  approved: 'border-emerald-400 bg-emerald-50 text-emerald-700 dark:border-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-400',
  denied: 'border-rose-400 bg-rose-50 text-rose-700 dark:border-rose-600 dark:bg-rose-950/40 dark:text-rose-400',
};

export default function DisputeDialog({
  open,
  onOpenChange,
  employeeEmail,
  employeeName,
  disputeDate,
  hoursWorked,
  existingDispute,
  onSubmitted,
}: DisputeDialogProps) {
  const [reasonCodes, setReasonCodes] = useState<PabDisputeReasonCode[]>([]);
  const [selectedReason, setSelectedReason] = useState('');
  const [explanation, setExplanation] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    fetch('/api/app-settings?key=pab_dispute_reason_codes', { cache: 'no-store' })
      .then((r) => r.json())
      .then((json: { value: string | null }) => {
        try {
          const codes = JSON.parse(json.value ?? '[]') as PabDisputeReasonCode[];
          setReasonCodes(Array.isArray(codes) ? codes : []);
        } catch {
          setReasonCodes([]);
        }
      })
      .catch(() => setReasonCodes([]));
  }, [open]);

  useEffect(() => {
    if (open && !existingDispute) {
      setSelectedReason('');
      setExplanation('');
    }
  }, [open, existingDispute]);

  const handleSubmit = useCallback(async () => {
    if (!selectedReason) {
      toast.error('Please select a reason');
      return;
    }
    if (selectedReason === 'other' && !explanation.trim()) {
      toast.error('Please provide an explanation for "Other"');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/pab-disputes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          work_email: employeeEmail,
          dispute_date: disputeDate,
          reason: selectedReason,
          explanation: explanation.trim() || null,
          created_by: employeeName ?? employeeEmail,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Failed to submit dispute');
      toast.success('Dispute submitted for HR review');
      onOpenChange(false);
      onSubmitted?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to submit dispute');
    } finally {
      setSubmitting(false);
    }
  }, [selectedReason, explanation, employeeEmail, employeeName, disputeDate, onOpenChange, onSubmitted]);

  const hours = (hoursWorked / 3600).toFixed(1);
  const dateDisplay = new Date(disputeDate + 'T00:00:00').toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

  const nextDay = new Date(disputeDate + 'T00:00:00');
  nextDay.setDate(nextDay.getDate() + 1);
  const nextDayDisplay = nextDay.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });

  if (existingDispute) {
    const reasonLabel = reasonCodes.find((c) => c.code === existingDispute.reason)?.label ?? existingDispute.reason;
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-sm">
              Dispute: {dateDisplay} — {hours}h
            </DialogTitle>
            <DialogDescription className="text-xs">
              Submitted dispute details
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <div className="flex items-center gap-2">
              <span className="text-zinc-500">Status:</span>
              <Badge variant="outline" className={STATUS_STYLES[existingDispute.status] ?? ''}>
                {existingDispute.status}
              </Badge>
            </div>
            <div><span className="text-zinc-500">Reason:</span> {reasonLabel}</div>
            {existingDispute.explanation && (
              <div>
                <span className="text-zinc-500">Explanation:</span>
                <p className="mt-1 rounded border border-zinc-200 bg-zinc-50 p-2 text-xs dark:border-zinc-800 dark:bg-zinc-900">
                  {existingDispute.explanation}
                </p>
              </div>
            )}
            {existingDispute.decided_by && (
              <div className="rounded border border-zinc-200 bg-zinc-50 p-2 text-xs dark:border-zinc-800 dark:bg-zinc-900">
                <div><span className="text-zinc-500">Decided by:</span> {existingDispute.decided_by}</div>
                {existingDispute.decided_at && (
                  <div><span className="text-zinc-500">Date:</span> {new Date(existingDispute.decided_at).toLocaleDateString('en-US')}</div>
                )}
                {existingDispute.decision_note && (
                  <div className="mt-1"><span className="text-zinc-500">Note:</span> {existingDispute.decision_note}</div>
                )}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm">
            Dispute: {dateDisplay} — {hours}h worked
          </DialogTitle>
          <DialogDescription className="text-xs">
            This day is below the 7-hour threshold. Select a reason and submit for HR review.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300">Reason</label>
            <div className="flex flex-wrap gap-1.5">
              {reasonCodes.map((rc) => (
                <button
                  key={rc.code}
                  type="button"
                  onClick={() => setSelectedReason(rc.code)}
                  className={`rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${
                    selectedReason === rc.code
                      ? 'border-orange-400 bg-orange-50 text-orange-700 dark:border-orange-600 dark:bg-orange-950/40 dark:text-orange-400'
                      : 'border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400'
                  }`}
                >
                  {rc.label}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
              Explanation {selectedReason === 'other' ? '(required)' : '(optional)'}
            </label>
            <textarea
              value={explanation}
              onChange={(e) => setExplanation(e.target.value)}
              rows={3}
              placeholder={
                selectedReason === 'orphanage_visit'
                  ? 'e.g., Visited San Pablo orphanage with the team. Left at 1pm, returned 5pm.'
                  : selectedReason === 'medical'
                    ? 'e.g., Doctor appointment at 2pm.'
                    : 'Explain why hours were under 7h...'
              }
              className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
            />
          </div>

          <p className="rounded border border-blue-200 bg-blue-50 px-3 py-2 text-[11px] text-blue-700 dark:border-blue-800 dark:bg-blue-950/30 dark:text-blue-400">
            This dispute covers <strong>{dateDisplay}</strong> and <strong>{nextDayDisplay}</strong> (day of or day after).
          </p>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleSubmit} disabled={submitting || !selectedReason}>
            {submitting && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />}
            Submit dispute
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
