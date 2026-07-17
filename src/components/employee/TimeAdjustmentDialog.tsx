'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  AlarmClock,
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  Clock,
  HelpCircle,
  ImagePlus,
  Info,
  Loader2,
  Pencil,
  Plus,
  Send,
  Trash2,
  WifiOff,
  X,
  Zap,
} from 'lucide-react';
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
import {
  TIME_ADJUSTMENT_REASONS,
  MAX_ADJUSTMENT_IMAGES,
  MAX_ADJUSTMENT_SEGMENTS,
  adjustmentSegmentsTotalHours,
  fmtAdjustmentClock,
  type TimeAdjustmentRow,
  type TimeAdjustmentSegment,
} from '@/lib/supabase/time-adjustments';

type TimeAdjustmentDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  employeeEmail: string;
  employeeName?: string | null;
  adjustDate: string;
  hoursWorked: number;
  existingRequest?: TimeAdjustmentRow | null;
  onSubmitted?: () => void;
};

type Preview = { file: File; url: string };

const STATUS_STYLES: Record<string, string> = {
  pending: 'border-amber-400 bg-amber-50 text-amber-700 dark:border-amber-600 dark:bg-amber-950/40 dark:text-amber-400',
  manager_approved: 'border-blue-400 bg-blue-50 text-blue-700 dark:border-blue-600 dark:bg-blue-950/40 dark:text-blue-400',
  manager_denied: 'border-rose-400 bg-rose-50 text-rose-700 dark:border-rose-600 dark:bg-rose-950/40 dark:text-rose-400',
  approved: 'border-emerald-400 bg-emerald-50 text-emerald-700 dark:border-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-400',
  denied: 'border-rose-400 bg-rose-50 text-rose-700 dark:border-rose-600 dark:bg-rose-950/40 dark:text-rose-400',
};

const STATUS_LABEL: Record<string, string> = {
  pending: 'Awaiting manager approval',
  manager_approved: 'Manager approved — with Accounting',
  manager_denied: 'Declined by manager',
  approved: 'Approved',
  denied: 'Denied',
};

const REASON_ICONS: Record<string, typeof AlarmClock> = {
  forgot_tracker: AlarmClock,
  tracker_crashed: Zap,
  worked_offline: WifiOff,
  other: HelpCircle,
};

const STEPS = [
  { key: 'reason', label: 'Reason', title: 'What happened?', subtitle: 'Pick the reason your time was not tracked on this day.', Icon: HelpCircle },
  { key: 'details', label: 'Details', title: 'The missed time', subtitle: 'Point at the exact time in and time out that was not tracked.', Icon: Clock },
  { key: 'evidence', label: 'Proof', title: 'Add proof', subtitle: 'Attach screenshots that back up your work.', Icon: ImagePlus },
  { key: 'review', label: 'Review', title: 'Review & submit', subtitle: 'Confirm everything before sending to Accounting.', Icon: CheckCircle2 },
] as const;

const LAST_STEP = STEPS.length - 1;

type SegmentDraft = { timeIn: string; timeOut: string };

const EMPTY_SEGMENT: SegmentDraft = { timeIn: '', timeOut: '' };

// "HH:MM" strings compare correctly lexicographically, so plain < / > works.
function segmentProblem(segments: SegmentDraft[]): string | null {
  if (segments.every((s) => !s.timeIn && !s.timeOut)) {
    return 'Enter at least one time in and time out';
  }
  for (const s of segments) {
    if (!s.timeIn || !s.timeOut) return 'Each time range needs both a time in and a time out';
    if (s.timeOut <= s.timeIn) return 'Time out must be after time in';
  }
  const sorted = [...segments].sort((a, b) => a.timeIn.localeCompare(b.timeIn));
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.timeIn < sorted[i - 1]!.timeOut) return 'Time ranges must not overlap';
  }
  return null;
}

function toSegmentPayload(segments: SegmentDraft[]): TimeAdjustmentSegment[] {
  return segments.map((s) => ({ time_in: s.timeIn, time_out: s.timeOut }));
}

// Render decimal hours as a human "8h 30m" string.
function fmtHM(dec: number): string {
  const totalMin = Math.round(dec * 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

function fmtDate(iso: string): string {
  return new Date(iso + 'T00:00:00').toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

const slideVariants = {
  enter: (dir: number) => ({ x: dir > 0 ? 48 : -48, opacity: 0, filter: 'blur(3px)' }),
  center: { x: 0, opacity: 1, filter: 'blur(0px)' },
  exit: (dir: number) => ({ x: dir > 0 ? -32 : 32, opacity: 0, filter: 'blur(3px)' }),
};

export default function TimeAdjustmentDialog({
  open,
  onOpenChange,
  employeeEmail,
  employeeName,
  adjustDate,
  hoursWorked,
  existingRequest,
  onSubmitted,
}: TimeAdjustmentDialogProps) {
  const [step, setStep] = useState(0);
  const [direction, setDirection] = useState(1);
  const [selectedReason, setSelectedReason] = useState('');
  const [explanation, setExplanation] = useState('');
  const [segments, setSegments] = useState<SegmentDraft[]>([EMPTY_SEGMENT]);
  const [previews, setPreviews] = useState<Preview[]>([]);
  // Evidence paths carried over from the request being edited (kept unless removed).
  const [keptPaths, setKeptPaths] = useState<string[]>([]);
  // True while re-editing a still-pending request (resubmit overwrites the row).
  const [editing, setEditing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounterRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Stable key to group this request's evidence images in storage.
  const requestKey = useMemo(
    () => `${adjustDate}-${Math.random().toString(36).slice(2, 10)}`,
    [adjustDate],
  );

  useEffect(() => {
    if (open && !existingRequest) {
      setStep(0);
      setDirection(1);
      setSelectedReason('');
      setExplanation('');
      setSegments([EMPTY_SEGMENT]);
      setKeptPaths([]);
      setPreviews((prev) => {
        prev.forEach((p) => URL.revokeObjectURL(p.url));
        return [];
      });
    }
    if (open) setEditing(false);
  }, [open, existingRequest]);

  // Switch the read-only status view into the wizard, prefilled from the pending request.
  const startEdit = () => {
    if (!existingRequest) return;
    setSelectedReason(existingRequest.reason);
    setExplanation(existingRequest.explanation ?? '');
    const segs = (existingRequest.requested_segments ?? []).map((s) => ({
      timeIn: s.time_in,
      timeOut: s.time_out,
    }));
    setSegments(segs.length > 0 ? segs : [EMPTY_SEGMENT]);
    setKeptPaths(existingRequest.image_paths ?? []);
    setPreviews((prev) => {
      prev.forEach((p) => URL.revokeObjectURL(p.url));
      return [];
    });
    setStep(0);
    setDirection(1);
    setEditing(true);
  };

  const addImages = useCallback((files: FileList | File[]) => {
    const arr = Array.from(files).filter((f) => f.type.startsWith('image/'));
    setPreviews((prev) => {
      const remaining = MAX_ADJUSTMENT_IMAGES - keptPaths.length - prev.length;
      if (remaining <= 0) {
        toast.error(`Up to ${MAX_ADJUSTMENT_IMAGES} images only`);
        return prev;
      }
      const toAdd = arr.slice(0, remaining).map((f) => ({ file: f, url: URL.createObjectURL(f) }));
      if (arr.length > remaining) toast.error(`Up to ${MAX_ADJUSTMENT_IMAGES} images only`);
      return [...prev, ...toAdd];
    });
  }, [keptPaths.length]);

  const removeImage = (idx: number) => {
    setPreviews((prev) => {
      URL.revokeObjectURL(prev[idx]!.url);
      return prev.filter((_, i) => i !== idx);
    });
  };

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current += 1;
    if (e.dataTransfer.types.includes('Files')) setIsDragOver(true);
  };
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };
  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current -= 1;
    if (dragCounterRef.current === 0) setIsDragOver(false);
  };
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current = 0;
    setIsDragOver(false);
    if (e.dataTransfer.files.length > 0) addImages(e.dataTransfer.files);
  };

  const segmentIssue = segmentProblem(segments);

  const canAdvance = (s: number): boolean => {
    if (s === 0) return !!selectedReason;
    if (s === 1) return !segmentIssue && explanation.trim().length > 0;
    return true;
  };

  const goNext = () => {
    if (!canAdvance(step)) {
      if (step === 0) toast.error('Please select a reason');
      else if (step === 1) toast.error(segmentIssue ?? 'Please describe what you were working on');
      return;
    }
    setDirection(1);
    setStep((s) => Math.min(LAST_STEP, s + 1));
  };
  const goBack = () => {
    setDirection(-1);
    setStep((s) => Math.max(0, s - 1));
  };

  const handleSubmit = useCallback(async () => {
    const segIssue = segmentProblem(segments);
    if (!selectedReason || !explanation.trim() || segIssue) {
      toast.error(segIssue ?? 'Please complete the required fields');
      return;
    }
    setSubmitting(true);
    try {
      // Upload evidence images first (in parallel), collect their storage paths.
      const paths = await Promise.all(
        previews.map(async ({ file }, idx) => {
          const fd = new FormData();
          fd.append('file', file);
          fd.append('request_key', requestKey);
          fd.append('idx', String(idx));
          const res = await fetch('/api/time-adjustments/upload', { method: 'POST', body: fd });
          const json = (await res.json()) as { path?: string; error?: string };
          if (!res.ok || json.error) throw new Error(json.error ?? 'Image upload failed');
          return json.path!;
        }),
      );

      const res = await fetch('/api/time-adjustments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          work_email: employeeEmail,
          adjust_date: adjustDate,
          reason: selectedReason,
          explanation: explanation.trim(),
          requested_segments: toSegmentPayload(segments),
          image_paths: [...keptPaths, ...paths],
          created_by: employeeName ?? employeeEmail,
        }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? 'Failed to submit request');
      toast.success(
        editing
          ? 'Time adjustment updated — back in your manager\'s queue'
          : 'Time adjustment submitted for Accounting review',
      );
      onOpenChange(false);
      onSubmitted?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to submit request');
    } finally {
      setSubmitting(false);
    }
  }, [
    selectedReason,
    explanation,
    segments,
    previews,
    keptPaths,
    editing,
    requestKey,
    employeeEmail,
    employeeName,
    adjustDate,
    onOpenChange,
    onSubmitted,
  ]);

  const trackedHours = (hoursWorked / 3600).toFixed(1);
  const dateDisplay = fmtDate(adjustDate);
  const selectedReasonLabel =
    TIME_ADJUSTMENT_REASONS.find((r) => r.code === selectedReason)?.label ?? '';

  // ── Existing request: read-only status view (unless the employee is editing) ──
  if (existingRequest && !editing) {
    const reasonLabel =
      TIME_ADJUSTMENT_REASONS.find((r) => r.code === existingRequest.reason)?.label ??
      existingRequest.reason;
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-sm">Time adjustment: {dateDisplay}</DialogTitle>
            <DialogDescription className="text-xs">Submitted request details</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <div className="flex items-center gap-2">
              <span className="text-zinc-600 dark:text-zinc-400">Status:</span>
              <Badge variant="outline" className={STATUS_STYLES[existingRequest.status] ?? ''}>
                {STATUS_LABEL[existingRequest.status] ?? existingRequest.status}
              </Badge>
            </div>
            <div><span className="text-zinc-600 dark:text-zinc-400">Reason:</span> {reasonLabel}</div>
            {(existingRequest.requested_segments ?? []).length > 0 && (
              <div>
                <span className="text-zinc-600 dark:text-zinc-400">Missed time:</span>
                <ul className="mt-1 space-y-0.5">
                  {existingRequest.requested_segments.map((s, i) => (
                    <li key={i} className="font-mono text-xs text-zinc-800 dark:text-zinc-200">
                      {fmtAdjustmentClock(s.time_in)} &ndash; {fmtAdjustmentClock(s.time_out)}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {existingRequest.requested_hours != null && (
              <div>
                <span className="text-zinc-600 dark:text-zinc-400">
                  {(existingRequest.requested_segments ?? []).length > 0 ? 'Time to add:' : 'Requested time:'}
                </span>{' '}
                {(existingRequest.requested_segments ?? []).length > 0 ? '+' : ''}
                {fmtHM(existingRequest.requested_hours)}
              </div>
            )}
            {existingRequest.explanation && (
              <div>
                <span className="text-zinc-600 dark:text-zinc-400">Explanation:</span>
                <p className="mt-1 rounded border border-zinc-200 bg-zinc-50 p-2 text-xs dark:border-zinc-800 dark:bg-zinc-900">
                  {existingRequest.explanation}
                </p>
              </div>
            )}
            {existingRequest.image_paths.length > 0 && (
              <div className="text-xs text-zinc-600 dark:text-zinc-400">
                {existingRequest.image_paths.length} evidence image
                {existingRequest.image_paths.length === 1 ? '' : 's'} attached
              </div>
            )}
            {existingRequest.decided_by && (
              <div className="rounded border border-zinc-200 bg-zinc-50 p-2 text-xs dark:border-zinc-800 dark:bg-zinc-900">
                <div><span className="text-zinc-600 dark:text-zinc-400">Decided by:</span> {existingRequest.decided_by}</div>
                {existingRequest.decided_at && (
                  <div><span className="text-zinc-600 dark:text-zinc-400">Date:</span> {new Date(existingRequest.decided_at).toLocaleDateString('en-US')}</div>
                )}
                {existingRequest.approved_hours != null && (
                  <div>
                    <span className="text-zinc-600 dark:text-zinc-400">Time set to:</span>{' '}
                    <span className="font-semibold text-emerald-700 dark:text-emerald-400">{fmtHM(existingRequest.approved_hours)}</span>{' '}
                    (used for payroll)
                  </div>
                )}
                {existingRequest.decision_note && (
                  <div className="mt-1"><span className="text-zinc-600 dark:text-zinc-400">Note:</span> {existingRequest.decision_note}</div>
                )}
              </div>
            )}
            {existingRequest.status === 'pending' && (
              <p className="flex gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-[11px] leading-relaxed text-blue-700 dark:border-blue-800 dark:bg-blue-950/30 dark:text-blue-400">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  Spotted a mistake, or missed another stretch of time this day? You can still edit
                  this request until your manager reviews it.
                </span>
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>Close</Button>
            {existingRequest.status === 'pending' && (
              <Button size="sm" onClick={startEdit}>
                <Pencil className="mr-1.5 h-3.5 w-3.5" />
                Edit request
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  const active = STEPS[step];

  // ── New request: guided wizard ────────────────────────────────────────────
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-lg">
        {/* Header band */}
        <div className="border-b border-zinc-200/80 bg-gradient-to-br from-indigo-50/70 via-white to-orange-50/40 px-5 pb-4 pt-5 dark:border-zinc-800 dark:from-indigo-950/30 dark:via-zinc-950 dark:to-orange-950/15">
          <DialogHeader className="space-y-1 text-left">
            <DialogTitle className="flex items-center gap-2 text-sm font-semibold text-zinc-900 dark:text-white">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-indigo-600/10 text-indigo-600 ring-1 ring-inset ring-indigo-600/20 dark:bg-indigo-500/15 dark:text-indigo-300">
                <Clock className="h-3.5 w-3.5" />
              </span>
              {editing ? 'Edit time adjustment' : 'Request time adjustment'}
            </DialogTitle>
            <DialogDescription className="text-xs text-zinc-500 dark:text-zinc-400">
              For <span className="font-medium text-zinc-800 dark:text-zinc-300">{dateDisplay}</span>
              <span className="mx-1.5 text-zinc-400 dark:text-zinc-600">&middot;</span>
              Hubstaff shows{' '}
              <span className="font-mono font-medium text-zinc-800 dark:text-zinc-300">{trackedHours}h</span>
            </DialogDescription>
          </DialogHeader>

          {/* Step rail */}
          <div className="mt-4 flex items-center">
            {STEPS.map((s, i) => {
              const done = i < step;
              const current = i === step;
              const StepIcon = s.Icon;
              return (
                <div key={s.key} className="flex flex-1 items-center last:flex-none">
                  <div className="flex flex-col items-center gap-1">
                    <motion.div
                      animate={{ scale: current ? 1.1 : 1 }}
                      transition={{ type: 'spring', stiffness: 400, damping: 22 }}
                      className={`flex h-7 w-7 items-center justify-center rounded-full text-[11px] font-semibold transition-colors duration-200 ${
                        done
                          ? 'bg-indigo-600 text-white'
                          : current
                            ? 'bg-white text-indigo-600 ring-2 ring-indigo-500 dark:bg-zinc-900 dark:text-indigo-300'
                            : 'bg-zinc-100 text-zinc-500 ring-1 ring-inset ring-zinc-200 dark:bg-zinc-800 dark:text-zinc-500 dark:ring-zinc-700'
                      }`}
                    >
                      <AnimatePresence mode="wait" initial={false}>
                        <motion.span
                          key={done ? 'check' : s.key}
                          initial={{ scale: 0.5, opacity: 0 }}
                          animate={{ scale: 1, opacity: 1 }}
                          exit={{ scale: 0.5, opacity: 0 }}
                          transition={{ duration: 0.15 }}
                          className="flex items-center justify-center"
                        >
                          {done ? <Check className="h-3.5 w-3.5" /> : <StepIcon className="h-3.5 w-3.5" />}
                        </motion.span>
                      </AnimatePresence>
                    </motion.div>
                    <span
                      className={`hidden text-[9.5px] font-medium uppercase tracking-wide sm:block ${
                        current
                          ? 'text-indigo-600 dark:text-indigo-300'
                          : 'text-zinc-500 dark:text-zinc-500'
                      }`}
                    >
                      {s.label}
                    </span>
                  </div>
                  {i < LAST_STEP && (
                    <div className="relative mx-1.5 h-0.5 flex-1 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700">
                      <motion.div
                        className="absolute inset-y-0 left-0 rounded-full bg-indigo-600"
                        animate={{ width: done ? '100%' : '0%' }}
                        transition={{ type: 'spring', stiffness: 280, damping: 28 }}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Step body */}
        <div className="max-h-[58vh] overflow-y-auto px-5 pb-1 pt-4">
          <div className="mb-3">
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-white">{active.title}</h3>
            <p className="text-xs text-zinc-600 dark:text-zinc-400">{active.subtitle}</p>
          </div>

          <div className="relative min-h-[228px]">
            <AnimatePresence mode="wait" custom={direction} initial={false}>
              <motion.div
                key={active.key}
                custom={direction}
                variants={slideVariants}
                initial="enter"
                animate="center"
                exit="exit"
                transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
              >
                {/* STEP 1 — Reason */}
                {step === 0 && (
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {TIME_ADJUSTMENT_REASONS.map((rc) => {
                      const RIcon = REASON_ICONS[rc.code] ?? HelpCircle;
                      const selected = selectedReason === rc.code;
                      return (
                        <button
                          key={rc.code}
                          type="button"
                          onClick={() => setSelectedReason(rc.code)}
                          className={`group flex items-start gap-2.5 rounded-xl border p-3 text-left transition-all duration-150 ${
                            selected
                              ? 'border-indigo-500 bg-indigo-50/70 ring-1 ring-indigo-500/30 dark:border-indigo-500 dark:bg-indigo-950/30'
                              : 'border-zinc-200 bg-white hover:border-zinc-300 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700'
                          }`}
                        >
                          <span
                            className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors ${
                              selected
                                ? 'bg-indigo-600 text-white'
                                : 'bg-zinc-100 text-zinc-500 group-hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400'
                            }`}
                          >
                            <RIcon className="h-3.5 w-3.5" />
                          </span>
                          <span className="min-w-0 flex-1 text-[12px] font-medium leading-snug text-zinc-800 dark:text-zinc-200">
                            {rc.label}
                          </span>
                          {selected && <Check className="mt-0.5 h-4 w-4 shrink-0 text-indigo-600 dark:text-indigo-300" />}
                        </button>
                      );
                    })}
                  </div>
                )}

                {/* STEP 2 — Details */}
                {step === 1 && (
                  <div className="space-y-4">
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
                          Which time was not tracked? <span className="text-rose-500">*</span>
                        </label>
                        <span className="text-[11px] text-zinc-500 dark:text-zinc-400">
                          Hubstaff: <span className="font-mono">{trackedHours}h</span>
                        </span>
                      </div>
                      <div className="space-y-2">
                        {segments.map((seg, idx) => {
                          const rowInvalid = !!seg.timeIn && !!seg.timeOut && seg.timeOut <= seg.timeIn;
                          return (
                            <div key={idx} className="flex items-center gap-2">
                              <div className="flex flex-1 items-center gap-2">
                                <div className="flex-1 space-y-0.5">
                                  {idx === 0 && (
                                    <span className="text-[10px] font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Time in</span>
                                  )}
                                  <input
                                    type="time"
                                    value={seg.timeIn}
                                    onChange={(e) =>
                                      setSegments((prev) => prev.map((s, i) => (i === idx ? { ...s, timeIn: e.target.value } : s)))
                                    }
                                    className="w-full rounded-md border border-zinc-200 bg-white px-2.5 py-2 text-sm text-zinc-900 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:[color-scheme:dark]"
                                  />
                                </div>
                                <span className={`text-xs text-zinc-400 dark:text-zinc-500 ${idx === 0 ? 'mt-4' : ''}`}>&ndash;</span>
                                <div className="flex-1 space-y-0.5">
                                  {idx === 0 && (
                                    <span className="text-[10px] font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Time out</span>
                                  )}
                                  <input
                                    type="time"
                                    value={seg.timeOut}
                                    onChange={(e) =>
                                      setSegments((prev) => prev.map((s, i) => (i === idx ? { ...s, timeOut: e.target.value } : s)))
                                    }
                                    className={`w-full rounded-md border bg-white px-2.5 py-2 text-sm text-zinc-900 focus:outline-none focus:ring-2 dark:bg-zinc-900 dark:text-zinc-100 dark:[color-scheme:dark] ${
                                      rowInvalid
                                        ? 'border-rose-400 focus:border-rose-400 focus:ring-rose-500/20 dark:border-rose-600'
                                        : 'border-zinc-200 focus:border-indigo-400 focus:ring-indigo-500/20 dark:border-zinc-700'
                                    }`}
                                  />
                                </div>
                              </div>
                              <button
                                type="button"
                                onClick={() => setSegments((prev) => prev.filter((_, i) => i !== idx))}
                                disabled={segments.length === 1}
                                aria-label="Remove time range"
                                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-zinc-400 transition hover:bg-rose-50 hover:text-rose-500 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-zinc-400 dark:hover:bg-rose-950/30 dark:hover:text-rose-400 ${idx === 0 ? 'mt-4' : ''}`}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          );
                        })}
                      </div>
                      <div className="flex items-center justify-between pt-0.5">
                        <button
                          type="button"
                          onClick={() => setSegments((prev) => [...prev, EMPTY_SEGMENT])}
                          disabled={segments.length >= MAX_ADJUSTMENT_SEGMENTS}
                          className="inline-flex items-center gap-1 rounded-md border border-dashed border-zinc-300 px-2 py-1 text-[11px] font-medium text-zinc-600 transition hover:border-indigo-300 hover:bg-indigo-50/50 hover:text-indigo-600 disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-400 dark:hover:border-indigo-700 dark:hover:bg-indigo-950/30 dark:hover:text-indigo-300"
                        >
                          <Plus className="h-3 w-3" />
                          Add another time range
                        </button>
                        <span className="text-[11px] text-zinc-500 dark:text-zinc-400">
                          Time to add:{' '}
                          <span className="font-mono font-semibold text-emerald-700 dark:text-emerald-400">
                            +{fmtHM(adjustmentSegmentsTotalHours(toSegmentPayload(segments)))}
                          </span>
                        </span>
                      </div>
                      {segmentIssue && segments.some((s) => s.timeIn || s.timeOut) && (
                        <p className="text-[11px] text-rose-600 dark:text-rose-400">{segmentIssue}</p>
                      )}
                      <p className="text-[10.5px] text-zinc-500 dark:text-zinc-400">
                        Only the missed time — e.g. forgot the tracker from 9:00 AM to 10:00 AM, add
                        just that hour. Time Hubstaff already tracked stays as is; don&apos;t enter your
                        whole shift. If a missed stretch crosses midnight, submit a separate request
                        for the next day.
                      </p>
                    </div>

                    <div className="space-y-1.5">
                      <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
                        Why couldn&apos;t you track this time? <span className="text-rose-500">*</span>
                      </label>
                      <textarea
                        value={explanation}
                        onChange={(e) => setExplanation(e.target.value)}
                        rows={4}
                        placeholder="Explain what you were working on and why it wasn't tracked. Be specific about the timeline (e.g. 9:00-11:30am: client calls, then ticket #4821)."
                        className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm leading-relaxed text-zinc-900 placeholder:text-zinc-400 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                      />
                      <p className="text-[10.5px] text-zinc-500 dark:text-zinc-400">
                        Reason selected: <span className="font-medium text-zinc-700 dark:text-zinc-300">{selectedReasonLabel}</span>
                      </p>
                    </div>
                  </div>
                )}

                {/* STEP 3 — Evidence */}
                {step === 2 && (
                  <div className="space-y-3">
                    <div
                      onDragEnter={handleDragEnter}
                      onDragOver={handleDragOver}
                      onDragLeave={handleDragLeave}
                      onDrop={handleDrop}
                      onClick={() => fileInputRef.current?.click()}
                      className={`flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed px-3 py-6 text-center transition-colors ${
                        isDragOver
                          ? 'border-violet-400 bg-violet-50/80 dark:border-violet-500 dark:bg-violet-950/30'
                          : 'border-zinc-300 bg-zinc-50/60 hover:border-indigo-300 hover:bg-indigo-50/40 dark:border-zinc-700 dark:bg-zinc-900/40 dark:hover:border-indigo-700/60'
                      }`}
                    >
                      <span className="flex h-9 w-9 items-center justify-center rounded-full bg-white shadow-sm ring-1 ring-zinc-200 dark:bg-zinc-800 dark:ring-zinc-700">
                        <ImagePlus className="h-4 w-4 text-indigo-500 dark:text-indigo-400" />
                      </span>
                      <p className="text-[12px] font-medium text-zinc-700 dark:text-zinc-300">
                        Drag &amp; drop, or click to browse
                      </p>
                      <p className="text-[10.5px] text-zinc-500 dark:text-zinc-400">
                        {keptPaths.length + previews.length}/{MAX_ADJUSTMENT_IMAGES} images
                      </p>
                    </div>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/*"
                      multiple
                      className="hidden"
                      onChange={(e) => { if (e.target.files) addImages(e.target.files); e.target.value = ''; }}
                    />

                    {/* Evidence kept from the request being edited (private bucket — no preview) */}
                    {keptPaths.length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {keptPaths.map((p, idx) => (
                          <div
                            key={p}
                            className="group flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-zinc-50 py-1.5 pl-2 pr-1 dark:border-zinc-700 dark:bg-zinc-900"
                          >
                            <ImagePlus className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
                            <span className="text-[11px] text-zinc-600 dark:text-zinc-400">
                              Saved image {idx + 1}
                            </span>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setKeptPaths((prev) => prev.filter((kp) => kp !== p));
                              }}
                              className="rounded-full p-0.5 text-zinc-400 transition-colors hover:bg-zinc-200 hover:text-zinc-600 dark:hover:bg-zinc-700 dark:hover:text-zinc-300"
                              aria-label={`Remove saved image ${idx + 1}`}
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}

                    {previews.length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {previews.map((p, idx) => (
                          <div key={idx} className="group relative h-16 w-16 overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-700">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={p.url} alt={`evidence ${idx + 1}`} className="h-full w-full object-cover" />
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); removeImage(idx); }}
                              className="absolute right-0.5 top-0.5 rounded-full bg-black/60 p-0.5 text-white opacity-0 transition-opacity hover:bg-black/80 group-hover:opacity-100"
                              aria-label="Remove image"
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}

                    <p className="flex gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-[11px] leading-relaxed text-blue-700 dark:border-blue-800 dark:bg-blue-950/30 dark:text-blue-400">
                      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      <span>
                        Attach a clear screenshot showing a specific timeline of what you were working on -
                        e.g. browser history, Asana / ticket activity, call logs, or any app that can attest to
                        your work during this period.
                      </span>
                    </p>
                  </div>
                )}

                {/* STEP 4 — Review */}
                {step === 3 && (() => {
                  // Segments are the MISSED time; the corrected day = tracked + missed.
                  const missedTotal = adjustmentSegmentsTotalHours(toSegmentPayload(segments));
                  const parsedRequested = hoursWorked / 3600 + missedTotal;
                  const delta = missedTotal;
                  const deltaAbs = delta != null ? Math.abs(delta) : null;
                  const deltaAdded = delta != null && delta > 0;
                  const deltaRemoved = delta != null && delta < 0;
                  const deltaZero = delta != null && delta === 0;
                  return (
                  <div className="space-y-3">
                    {/* Hours impact callout — only when a corrected total is set */}
                    {parsedRequested != null && (
                      <div className={`flex items-center gap-3 rounded-xl border px-4 py-3 ${
                        deltaAdded
                          ? 'border-emerald-200 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/30'
                          : deltaRemoved
                            ? 'border-rose-200 bg-rose-50 dark:border-rose-800 dark:bg-rose-950/30'
                            : 'border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/60'
                      }`}>
                        <div className="min-w-0 flex-1">
                          <p className={`text-[11px] font-medium ${
                            deltaAdded ? 'text-emerald-700 dark:text-emerald-300'
                            : deltaRemoved ? 'text-rose-700 dark:text-rose-300'
                            : 'text-zinc-600 dark:text-zinc-400'
                          }`}>
                            {deltaAdded
                              ? `${deltaAbs != null ? fmtHM(deltaAbs) : ''} will be added to your day`
                              : deltaRemoved
                                ? `${deltaAbs != null ? fmtHM(deltaAbs) : ''} will be removed from your day`
                                : 'No change to your tracked hours'}
                          </p>
                          <div className="mt-1 flex items-center gap-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">
                            <span className="font-mono">{trackedHours}h tracked</span>
                            <span className="text-zinc-300 dark:text-zinc-600">&#8594;</span>
                            <span className={`font-mono font-semibold ${
                              deltaAdded ? 'text-emerald-700 dark:text-emerald-300'
                              : deltaRemoved ? 'text-rose-700 dark:text-rose-300'
                              : 'text-zinc-700 dark:text-zinc-300'
                            }`}>{fmtHM(parsedRequested)} corrected</span>
                            {!deltaZero && deltaAbs != null && (
                              <span className={`ml-0.5 font-mono font-bold ${
                                deltaAdded ? 'text-emerald-600 dark:text-emerald-400'
                                : 'text-rose-600 dark:text-rose-400'
                              }`}>
                                ({deltaAdded ? '+' : '-'}{fmtHM(deltaAbs)})
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    )}

                    <dl className="divide-y divide-zinc-100 overflow-hidden rounded-xl border border-zinc-200 bg-white text-[12px] dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-900">
                      <div className="flex items-center justify-between gap-3 px-3 py-2">
                        <dt className="text-zinc-600 dark:text-zinc-400">Date</dt>
                        <dd className="font-medium text-zinc-800 dark:text-zinc-200">{dateDisplay}</dd>
                      </div>
                      <div className="flex items-center justify-between gap-3 px-3 py-2">
                        <dt className="text-zinc-600 dark:text-zinc-400">Reason</dt>
                        <dd className="text-right font-medium text-zinc-800 dark:text-zinc-200">{selectedReasonLabel}</dd>
                      </div>
                      <div className="flex items-center justify-between gap-3 px-3 py-2">
                        <dt className="text-zinc-600 dark:text-zinc-400">Tracked hours</dt>
                        <dd className="font-mono font-medium text-zinc-800 dark:text-zinc-200">{trackedHours}h</dd>
                      </div>
                      <div className="flex items-start justify-between gap-3 px-3 py-2">
                        <dt className="text-zinc-600 dark:text-zinc-400">Missed time</dt>
                        <dd className="text-right font-mono font-medium text-zinc-800 dark:text-zinc-200">
                          {segments
                            .filter((s) => s.timeIn && s.timeOut)
                            .map((s, i) => (
                              <div key={i}>
                                {fmtAdjustmentClock(s.timeIn)} &ndash; {fmtAdjustmentClock(s.timeOut)}
                              </div>
                            ))}
                        </dd>
                      </div>
                      <div className="flex items-center justify-between gap-3 px-3 py-2">
                        <dt className="text-zinc-600 dark:text-zinc-400">Time to add</dt>
                        <dd className="font-mono font-medium text-emerald-700 dark:text-emerald-400">
                          +{fmtHM(missedTotal)}
                        </dd>
                      </div>
                      <div className="flex items-center justify-between gap-3 px-3 py-2">
                        <dt className="text-zinc-600 dark:text-zinc-400">Corrected total</dt>
                        <dd className="font-mono font-medium text-zinc-800 dark:text-zinc-200">
                          {fmtHM(parsedRequested)}
                        </dd>
                      </div>
                      <div className="flex items-center justify-between gap-3 px-3 py-2">
                        <dt className="text-zinc-600 dark:text-zinc-400">Evidence</dt>
                        <dd className="font-medium text-zinc-800 dark:text-zinc-200">
                          {keptPaths.length + previews.length} image{keptPaths.length + previews.length === 1 ? '' : 's'}
                        </dd>
                      </div>
                      <div className="px-3 py-2">
                        <dt className="text-zinc-600 dark:text-zinc-400">Explanation</dt>
                        <dd className="mt-1 leading-relaxed text-zinc-800 dark:text-zinc-200">{explanation.trim()}</dd>
                      </div>
                    </dl>

                    {keptPaths.length + previews.length === 0 && (
                      <p className="flex gap-2 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-[11px] text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-400">
                        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <span>No evidence attached. Requests with proof are reviewed faster - you can go back to add some.</span>
                      </p>
                    )}

                    <p className="flex gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-700 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-400">
                      <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      <span>
                        Submit before the next payroll cycle begins. Requests sent after the cutoff are
                        carried over and processed in the following payroll cycle.
                      </span>
                    </p>
                  </div>
                  );
                })()}
              </motion.div>
            </AnimatePresence>
          </div>
        </div>

        {/* Footer nav */}
        <DialogFooter className="mx-0 mb-0 flex-row items-center justify-between gap-2 px-5 py-3 sm:justify-between">
          {step === 0 ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => (editing ? setEditing(false) : onOpenChange(false))}
              disabled={submitting}
            >
              Cancel
            </Button>
          ) : (
            <Button variant="ghost" size="sm" onClick={goBack} disabled={submitting}>
              <ArrowLeft className="mr-1 h-3.5 w-3.5" />
              Back
            </Button>
          )}

          <div className="flex items-center gap-3">
            <span className="text-[11px] tabular-nums text-zinc-500 dark:text-zinc-400">Step {step + 1} of {STEPS.length}</span>
            {step < LAST_STEP ? (
              <Button size="sm" onClick={goNext} disabled={!canAdvance(step)}>
                Continue
                <ArrowRight className="ml-1 h-3.5 w-3.5" />
              </Button>
            ) : (
              <Button size="sm" onClick={handleSubmit} disabled={submitting}>
                {submitting ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Send className="mr-1.5 h-3.5 w-3.5" />}
                {editing ? 'Save changes' : 'Submit request'}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
