'use client';

import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, ChevronDown, Loader2, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

export interface TransferTarget {
  name: string | null;
  work_email?: string | null;
  personal_email: string | null;
  department: string | null;
}

interface Props {
  member: TransferTarget | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a request is successfully raised. */
  onSubmitted?: () => void;
}

export default function ManagerTransferDialog({ member, open, onOpenChange, onSubmitted }: Props) {
  const [departments, setDepartments] = useState<string[]>([]);
  const [loadingDepts, setLoadingDepts] = useState(false);
  const [toDept, setToDept] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const currentDept = member?.department?.trim() ?? '';

  // Reset form whenever a new member is opened.
  useEffect(() => {
    if (open) {
      setToDept('');
      setReason('');
    }
  }, [open, member?.work_email, member?.personal_email]);

  // Load the distinct department list for the target picker.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoadingDepts(true);
    fetch('/api/employee-rate-profiles/summary', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j: { profiles?: Array<{ department: string | null }> }) => {
        if (cancelled) return;
        const set = new Set<string>();
        for (const p of j.profiles ?? []) {
          const d = p.department?.trim();
          if (d) set.add(d);
        }
        setDepartments(Array.from(set).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })));
      })
      .catch(() => {
        if (!cancelled) setDepartments([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingDepts(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const targetOptions = useMemo(
    () => departments.filter((d) => d.toLowerCase() !== currentDept.toLowerCase()),
    [departments, currentDept],
  );

  const canSubmit = !!member && !!toDept && toDept.toLowerCase() !== currentDept.toLowerCase() && !submitting;

  const handleSubmit = async () => {
    if (!member || !toDept) return;
    setSubmitting(true);
    try {
      const res = await fetch('/api/department-transfers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          employee_name: member.name,
          employee_work_email: member.work_email,
          employee_personal_email: member.personal_email,
          from_department: currentDept,
          to_department: toDept,
          reason: reason.trim() || null,
        }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok || json.error) throw new Error(json.error || `Request failed (${res.status})`);
      toast.success('Transfer request sent to HR for approval');
      onOpenChange(false);
      onSubmitted?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to send transfer request');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Request department transfer</DialogTitle>
          <DialogDescription>
            HR must approve this move. Once approved, {member?.name?.split(' ')[0] || 'the employee'}{' '}
            will be reassigned to the new department.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          {/* Who + current -> target preview */}
          <div className="rounded-lg border border-blue-100 bg-blue-50/50 px-3 py-2.5 dark:border-blue-950/50 dark:bg-blue-950/20">
            <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              {member?.name || member?.work_email || member?.personal_email || 'Employee'}
            </div>
            <div className="mt-1.5 flex items-center gap-2 text-xs">
              <span className="rounded-md bg-white px-2 py-0.5 font-medium text-zinc-600 ring-1 ring-zinc-200 dark:bg-zinc-900 dark:text-zinc-300 dark:ring-zinc-700">
                {currentDept || 'No department'}
              </span>
              <ArrowRight className="h-3.5 w-3.5 text-zinc-400" />
              <span
                className={cnPill(!!toDept)}
              >
                {toDept || 'Select target'}
              </span>
            </div>
          </div>

          {/* Target department */}
          <div>
            <label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
              Transfer to
            </label>
            <div className="relative">
              <select
                value={toDept}
                onChange={(e) => setToDept(e.target.value)}
                disabled={loadingDepts}
                className="w-full appearance-none rounded-lg border border-zinc-200 bg-white py-2 pl-3 pr-9 text-sm text-zinc-900 focus:border-blue-300 focus:outline-none focus:ring-1 focus:ring-blue-200 disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
              >
                <option value="">{loadingDepts ? 'Loading departments...' : 'Select a department'}</option>
                {targetOptions.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
            </div>
          </div>

          {/* Reason */}
          <div>
            <label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
              Reason <span className="text-zinc-400">(optional)</span>
            </label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              maxLength={500}
              placeholder="Why is this transfer needed?"
              className="w-full resize-none rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-blue-300 focus:outline-none focus:ring-1 focus:ring-blue-200 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
            />
          </div>

          {/* Source-of-truth note */}
          <p className="flex items-start gap-1.5 text-[11px] leading-snug text-amber-700 dark:text-amber-400">
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
            The change applies in the HRIS on approval. HR should also update the master Google Sheet
            so the next sync keeps the new department.
          </p>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="gap-1.5 bg-blue-600 text-white hover:bg-blue-700"
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Send to HR
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function cnPill(active: boolean): string {
  return active
    ? 'rounded-md bg-blue-600 px-2 py-0.5 font-semibold text-white'
    : 'rounded-md bg-white px-2 py-0.5 font-medium text-zinc-400 ring-1 ring-dashed ring-zinc-300 dark:bg-zinc-900 dark:ring-zinc-700';
}
