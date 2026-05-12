'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Gift, Heart, Lock, Loader2, CheckCircle2, AlertCircle, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import {
  addMonths,
  buildMilestones,
  diffDays,
  fmtDateIso,
  getCurrentShippingMilestone,
  parseStartDate,
  type GiftMilestone,
} from '@/lib/gift-milestones';
import type {
  EmployeeGiftShippingRow,
  EmployeeGiftShippingStatus,
} from '@/lib/supabase/employee-gift-shipping';

export type GiftShippingStatus =
  | 'none' /* no milestone in window */
  | 'unsubmitted' /* milestone open, employee hasn't filled the form yet */
  | 'pending' /* submitted, awaiting Orphanage review */
  | 'rejected' /* Orphanage returned it for revision */
  | 'approved'; /* locked */

export interface GiftShippingState {
  status: GiftShippingStatus;
  milestoneMonths: number | null;
  /** True when an action is needed from the employee (unsubmitted / pending / rejected). */
  needsAction: boolean;
}

interface Props {
  /** Lower-cased personal email (preferred) or work email — used as the row key. */
  personalEmail: string;
  /** Master-list start date. The card is hidden when null. */
  startDate: Date | null;
  /** Read-only fields prefilled in the form. */
  prefill: {
    name: string | null;
    workEmail: string | null;
    department: string | null;
  };
  /** External dialog control — when supplied, the card uses these instead of its
   *  internal state so a header bell icon can open the same modal. */
  dialogOpen?: boolean;
  onDialogOpenChange?: (open: boolean) => void;
  /** Emits whenever milestone/row state changes so parents (e.g. the bell icon)
   *  can show a badge. Always fires once on initial load too. */
  onStateChange?: (state: GiftShippingState) => void;
  /** When true, render only the dialog — useful when the bell is the only
   *  entry point and the inline card is intentionally hidden. */
  hideInlineCard?: boolean;
}

/** Positions for the floating hearts behind the card content. */
const HEARTS_FLOAT = [
  { left: '6%',  delay: '0s',    dur: '5.2s', size: 14, rotate: -8 },
  { left: '15%', delay: '1.6s',  dur: '4.4s', size: 11, rotate: 6 },
  { left: '26%', delay: '3.1s',  dur: '5.8s', size: 18, rotate: -12 },
  { left: '38%', delay: '0.9s',  dur: '4.1s', size: 12, rotate: 10 },
  { left: '52%', delay: '2.4s',  dur: '5.0s', size: 15, rotate: -4 },
  { left: '64%', delay: '0.3s',  dur: '5.6s', size: 13, rotate: 8 },
  { left: '76%', delay: '3.4s',  dur: '4.3s', size: 17, rotate: -10 },
  { left: '88%', delay: '1.9s',  dur: '5.1s', size: 12, rotate: 4 },
] as const;

function statusBadge(status: EmployeeGiftShippingStatus) {
  switch (status) {
    case 'approved':
      return (
        <Badge className="border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">
          <CheckCircle2 className="mr-1 h-3 w-3" /> Approved · locked
        </Badge>
      );
    case 'rejected':
      return (
        <Badge className="border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300">
          <AlertCircle className="mr-1 h-3 w-3" /> Needs revision
        </Badge>
      );
    default:
      return (
        <Badge className="border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300">
          Pending review
        </Badge>
      );
  }
}

function tenureLabel(months: number): string {
  if (months % 12 === 0) {
    const yrs = months / 12;
    return yrs === 1 ? '1 Year' : `${yrs} Years`;
  }
  return `${months} Months`;
}

type MsStatus = 'approved' | 'pending' | 'rejected' | 'unsubmitted' | 'missed' | 'upcoming';

function getMsStatus(
  ms: GiftMilestone,
  rows: EmployeeGiftShippingRow[],
  currentMs: GiftMilestone | null,
  today: Date,
): MsStatus {
  const row = rows.find((r) => r.milestone_index === ms.index);
  if (row) return row.status as MsStatus;
  if (currentMs?.index === ms.index) return 'unsubmitted';
  if (diffDays(ms.date, today) <= 0) return 'missed';
  return 'upcoming';
}

export default function GiftShippingCard({
  personalEmail,
  startDate,
  prefill,
  dialogOpen,
  onDialogOpenChange,
  onStateChange,
  hideInlineCard,
}: Props) {
  const today = useMemo(() => new Date(), []);
  const milestone: GiftMilestone | null = useMemo(
    () => getCurrentShippingMilestone(startDate, today),
    [startDate, today],
  );

  const [row, setRow] = useState<EmployeeGiftShippingRow | null>(null);
  const [loading, setLoading] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  // Internal dialog state — used as fallback when parent doesn't supply external control.
  const [internalOpen, setInternalOpen] = useState(false);
  const open = dialogOpen ?? internalOpen;
  const setOpen = useCallback(
    (v: boolean) => {
      if (onDialogOpenChange) onDialogOpenChange(v);
      else setInternalOpen(v);
    },
    [onDialogOpenChange],
  );

  // Form fields
  const [location, setLocation] = useState('');
  const [contact, setContact] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  /** Switches the dialog to the celebration screen for ~2.4s after a successful save. */
  const [celebrating, setCelebrating] = useState(false);
  const [allRows, setAllRows] = useState<EmployeeGiftShippingRow[]>([]);
  const [activeTab, setActiveTab] = useState<'form' | 'history'>('form');

  const loadRow = useCallback(async () => {
    if (!milestone || !personalEmail) return;
    setLoading(true);
    try {
      const res = await fetch(
        `/api/employee-gift-shipping?email=${encodeURIComponent(personalEmail)}`,
        { cache: 'no-store' },
      );
      const json = (await res.json()) as { rows?: EmployeeGiftShippingRow[]; error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Failed to load');
      const rows = json.rows ?? [];
      setAllRows(rows);
      const match = rows.find((r) => r.milestone_index === milestone.index) ?? null;
      setRow(match);
      if (match) {
        setLocation(match.preferred_delivery_location);
        setContact(match.active_contact_number);
        setNotes(match.notes);
      } else {
        setLocation('');
        setContact('');
        setNotes('');
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not load shipping details');
    } finally {
      setLoading(false);
    }
  }, [milestone, personalEmail]);

  useEffect(() => {
    void loadRow();
  }, [loadRow]);

  // Emit state changes upward so the bell-icon badge stays in sync.
  useEffect(() => {
    if (!onStateChange) return;
    let status: GiftShippingStatus;
    let needsAction = false;
    if (!milestone) {
      status = 'none';
    } else if (!row) {
      status = 'unsubmitted';
      needsAction = true;
    } else if (row.status === 'approved') {
      status = 'approved';
    } else if (row.status === 'rejected') {
      status = 'rejected';
      needsAction = true;
    } else {
      status = 'pending';
      needsAction = true;
    }
    onStateChange({
      status,
      milestoneMonths: milestone ? milestone.index * 6 : null,
      needsAction,
    });
  }, [milestone, row, onStateChange]);

  // Hide the INLINE card when:
  //   - There's no milestone or start date
  //   - The user dismissed it for this session
  //   - The row was approved (no further action needed)
  //   - The parent asked us to render the dialog only (`hideInlineCard`)
  // The dialog itself stays reachable via `dialogOpen` so a header bell can
  // open it even when the inline card is hidden.
  const cardSuppressed =
    !milestone || !startDate || dismissed || row?.status === 'approved' || !!hideInlineCard;

  // Safe defaults so the inline-card / dialog markup type-checks even when the
  // milestone is null (in which case the card is suppressed AND the dialog is
  // not rendered — see the conditional renderers below).
  const daysUntil = milestone ? diffDays(milestone.date, today) : 0;
  const isOverdue = daysUntil < 0;
  const isLocked = row?.status === 'approved';
  const monthsLabel = milestone ? milestone.index * 6 : 0;

  const milestoneMap = useMemo((): GiftMilestone[] => {
    if (!startDate) return [];
    const { history, next } = buildMilestones(startDate, today);
    const result: GiftMilestone[] = [...history];
    if (next) {
      result.push(next);
      for (let extra = 1; extra <= 2; extra++) {
        const idx = next.index + extra;
        result.push({ index: idx, date: addMonths(startDate, idx * 6) });
      }
    } else if (history.length > 0) {
      const lastIdx = history[history.length - 1].index;
      for (let extra = 1; extra <= 3; extra++) {
        const idx = lastIdx + extra;
        result.push({ index: idx, date: addMonths(startDate, idx * 6) });
      }
    }
    return result;
  }, [startDate, today]);

  useEffect(() => {
    if (!open) setActiveTab('form');
  }, [open]);

  const onSave = async () => {
    if (!milestone) return;
    if (!location.trim() || !contact.trim()) {
      toast.error('Delivery location and contact number are required.');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/employee-gift-shipping', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personal_email: personalEmail,
          milestone_index: milestone.index,
          milestone_date: fmtDateIso(milestone.date),
          preferred_delivery_location: location.trim(),
          active_contact_number: contact.trim(),
          notes: notes.trim(),
        }),
      });
      const json = (await res.json()) as { row?: EmployeeGiftShippingRow; error?: string };
      if (!res.ok || json.error || !json.row) {
        throw new Error(json.error ?? 'Failed to save');
      }
      setRow(json.row);
      toast.success(
        row ? 'Shipping details updated.' : 'Shipping details submitted for review.',
      );
      // Show the celebration screen, then close.
      setCelebrating(true);
      window.setTimeout(() => {
        setCelebrating(false);
        setOpen(false);
      }, 2400);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save shipping details');
    } finally {
      setSaving(false);
    }
  };

  const accentBg = isOverdue
    ? 'from-rose-100 via-pink-50 to-fuchsia-100/60 dark:from-rose-950/55 dark:via-pink-950/35 dark:to-fuchsia-950/30'
    : 'from-pink-100 via-rose-50 to-fuchsia-100/60 dark:from-pink-950/55 dark:via-rose-950/35 dark:to-fuchsia-950/30';

  // When there's nothing to show AND the dialog can't be triggered externally,
  // bail entirely so we don't render an empty fragment.
  if (cardSuppressed && dialogOpen === undefined) {
    // Still keep useEffects running so onStateChange fires; just no DOM.
    return <></>;
  }

  return (
    <>
      {!cardSuppressed && (
      <Card
        className={cn(
          'relative shrink-0 overflow-hidden bg-gradient-to-br shadow-md shadow-pink-500/10 ring-1 ring-pink-300/60 dark:ring-pink-800/50',
          accentBg,
        )}
      >
        {/* Animated keyframes scoped to this card */}
        <style>{`
          @keyframes floatHeart {
            0%   { transform: translateY(8px)   scale(0.85) rotate(var(--heart-rot)); opacity: 0; }
            10%  { opacity: 0.55; }
            60%  { opacity: 0.35; }
            100% { transform: translateY(-120px) scale(0.45) rotate(var(--heart-rot)); opacity: 0; }
          }
          @keyframes giftWiggle {
            0%, 100% { transform: rotate(-8deg) scale(1); }
            45%      { transform: rotate(-2deg) scale(1.06); }
            55%      { transform: rotate(-14deg) scale(1.06); }
          }
          @keyframes giftPulse {
            0%, 100% { box-shadow: 0 6px 18px -2px rgba(236, 72, 153, 0.45), 0 0 0 4px #fff; }
            50%      { box-shadow: 0 10px 24px -2px rgba(236, 72, 153, 0.65), 0 0 0 4px #fff; }
          }
          .dark .gift-sticker-shadow {
            box-shadow: 0 6px 18px -2px rgba(236, 72, 153, 0.55), 0 0 0 4px #fbcfe8;
          }
          @keyframes giftPulseDark {
            0%, 100% { box-shadow: 0 6px 18px -2px rgba(236, 72, 153, 0.55), 0 0 0 4px #fbcfe8; }
            50%      { box-shadow: 0 12px 28px -2px rgba(236, 72, 153, 0.75), 0 0 0 4px #fbcfe8; }
          }
        `}</style>

        {/* Floating heart layer (behind content) */}
        <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
          {HEARTS_FLOAT.map((h, i) => (
            <span
              key={i}
              style={{
                position: 'absolute',
                bottom: 0,
                left: h.left,
                color: 'rgb(244 114 182)', // pink-400
                animation: `floatHeart ${h.dur} ${h.delay} infinite ease-in`,
                ['--heart-rot' as string]: `${h.rotate}deg`,
                lineHeight: 1,
                opacity: 0,
                filter: 'drop-shadow(0 1px 2px rgba(236, 72, 153, 0.25))',
              } as React.CSSProperties}
            >
              <Heart
                strokeWidth={2.5}
                fill="currentColor"
                style={{ width: h.size, height: h.size }}
              />
            </span>
          ))}
        </div>

        {/* Glow blobs */}
        <div
          className="pointer-events-none absolute -right-12 -top-12 h-36 w-36 rounded-full bg-pink-300/35 blur-3xl dark:bg-pink-500/25"
          aria-hidden
        />
        <div
          className="pointer-events-none absolute -bottom-12 left-1/3 h-28 w-28 rounded-full bg-fuchsia-300/30 blur-3xl dark:bg-fuchsia-500/20"
          aria-hidden
        />

        <CardContent className="relative flex flex-col gap-4 px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:py-4">
          <div className="flex min-w-0 items-center gap-4">
            {/* Sticker gift logo */}
            <div className="relative shrink-0">
              {/* Soft halo behind the sticker */}
              <span
                aria-hidden
                className="absolute -inset-2 rounded-full bg-pink-400/30 blur-md dark:bg-pink-500/30"
              />
              <span
                aria-hidden
                className="gift-sticker-shadow flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-pink-500 via-rose-500 to-fuchsia-600 text-white ring-4 ring-white dark:ring-pink-200"
                style={{
                  transform: 'rotate(-8deg)',
                  animation: 'giftWiggle 3.6s ease-in-out infinite, giftPulse 2.4s ease-in-out infinite',
                  position: 'relative',
                }}
              >
                <Gift className="h-7 w-7 drop-shadow-sm" strokeWidth={2.5} />
                {/* Tiny heart bubble on the sticker corner */}
                <span
                  aria-hidden
                  className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-white text-rose-500 shadow-sm ring-2 ring-pink-300 dark:ring-pink-400"
                  style={{ transform: 'rotate(15deg)' }}
                >
                  <Heart className="h-2.5 w-2.5" fill="currentColor" strokeWidth={0} />
                </span>
              </span>
            </div>

            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-pink-600/90 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.14em] text-white shadow-sm">
                  Tenure gift
                </span>
                <h3 className="text-[15px] font-bold text-zinc-900 dark:text-white">
                  {monthsLabel}-month milestone
                </h3>
                {row && statusBadge(row.status)}
                {isOverdue && !row && (
                  <Badge className="border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300">
                    Action needed
                  </Badge>
                )}
              </div>
              <p className="mt-1 text-xs leading-relaxed text-zinc-700 dark:text-zinc-200">
                {row?.status === 'rejected' ? (
                  <>
                    The Orphanage team asked for revisions
                    {row.decision_note ? <>: <em>{row.decision_note}</em></> : '.'}
                  </>
                ) : isOverdue ? (
                  <>Your milestone was <strong>{Math.abs(daysUntil)} days ago</strong> — please confirm your shipping details so your gift can be sent.</>
                ) : daysUntil === 0 ? (
                  <><strong>Today is your milestone!</strong> Confirm your shipping details and we&apos;ll get your gift on its way.</>
                ) : (
                  <>Your gift ships in <strong>{daysUntil} day{daysUntil === 1 ? '' : 's'}</strong>. Take a moment to confirm where it should land.</>
                )}
              </p>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2 self-end sm:self-auto">
            <Button
              size="sm"
              className="group relative h-9 overflow-hidden bg-gradient-to-r from-pink-600 to-rose-700 px-4 text-sm font-semibold text-white shadow-md shadow-pink-600/30 transition-all hover:shadow-lg hover:shadow-pink-600/40 hover:brightness-110"
              onClick={() => setOpen(true)}
              disabled={loading}
            >
              {loading ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Heart
                  className="mr-1.5 h-3.5 w-3.5 transition-transform group-hover:scale-125"
                  fill="currentColor"
                />
              )}
              {row ? 'Review / edit' : 'Confirm details'}
            </Button>
            <button
              type="button"
              onClick={() => setDismissed(true)}
              className="rounded-full p-1.5 text-zinc-500 hover:bg-white/70 hover:text-zinc-800 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
              aria-label="Dismiss for this session"
              title="Hide until next page load"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </CardContent>
      </Card>
      )}

      {/* Dialog only mounts when there's a milestone — otherwise there's nothing to confirm. */}
      {milestone && (
      <Dialog open={open} onOpenChange={(v) => !saving && !celebrating && setOpen(v)}>
        <DialogContent
          showCloseButton={false}
          className="max-w-[760px] sm:max-w-[680px] md:max-w-[760px] lg:max-w-[820px] overflow-hidden border-pink-200/70 bg-gradient-to-br from-pink-50/60 via-white to-fuchsia-50/40 p-0 shadow-2xl shadow-pink-500/15 dark:border-pink-900/40 dark:from-pink-950/40 dark:via-zinc-950 dark:to-fuchsia-950/30 dark:shadow-pink-900/30"
        >
          {celebrating && (
            <div className="relative flex min-h-[420px] flex-col items-center justify-center overflow-hidden bg-gradient-to-br from-pink-500 via-rose-500 to-fuchsia-600 px-8 py-10 text-white">
              <style>{`
                @keyframes celebHeart {
                  0%   { transform: translateY(20px)  scale(0.7) rotate(var(--ch-rot)); opacity: 0; }
                  20%  { opacity: 0.85; }
                  100% { transform: translateY(-260px) scale(0.45) rotate(var(--ch-rot)); opacity: 0; }
                }
                @keyframes giftPop {
                  0%   { transform: scale(0) rotate(-200deg); opacity: 0; }
                  55%  { transform: scale(1.18) rotate(12deg); opacity: 1; }
                  78%  { transform: scale(0.94) rotate(-6deg); }
                  100% { transform: scale(1) rotate(-4deg); }
                }
                @keyframes checkBadgePop {
                  0%   { transform: scale(0) rotate(-90deg); opacity: 0; }
                  60%  { opacity: 1; }
                  75%  { transform: scale(1.2) rotate(8deg); }
                  100% { transform: scale(1) rotate(0deg); opacity: 1; }
                }
                @keyframes checkDraw {
                  to { stroke-dashoffset: 0; }
                }
                @keyframes textRise {
                  0%   { transform: translateY(14px); opacity: 0; }
                  100% { transform: translateY(0);    opacity: 1; }
                }
                @keyframes ringRipple {
                  0%   { transform: scale(0.6); opacity: 0.55; }
                  100% { transform: scale(2.4); opacity: 0;    }
                }
              `}</style>

              {/* Floating hearts (denser than the header version) */}
              <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
                {[
                  { left: '5%',  delay: '0s',    dur: '2.6s', size: 16, rotate: -10 },
                  { left: '14%', delay: '0.4s',  dur: '2.2s', size: 12, rotate: 8 },
                  { left: '24%', delay: '0.9s',  dur: '2.8s', size: 20, rotate: -14 },
                  { left: '34%', delay: '0.2s',  dur: '2.4s', size: 14, rotate: 6 },
                  { left: '44%', delay: '1.0s',  dur: '2.6s', size: 18, rotate: -8 },
                  { left: '54%', delay: '0.6s',  dur: '2.3s', size: 13, rotate: 10 },
                  { left: '64%', delay: '0.1s',  dur: '2.7s', size: 22, rotate: -12 },
                  { left: '74%', delay: '0.8s',  dur: '2.5s', size: 15, rotate: 4 },
                  { left: '84%', delay: '1.1s',  dur: '2.2s', size: 12, rotate: -6 },
                  { left: '93%', delay: '0.3s',  dur: '2.6s', size: 17, rotate: 14 },
                ].map((h, i) => (
                  <span
                    key={i}
                    style={{
                      position: 'absolute',
                      bottom: 0,
                      left: h.left,
                      color: 'rgba(255,255,255,0.92)',
                      animation: `celebHeart ${h.dur} ${h.delay} ease-out forwards`,
                      ['--ch-rot' as string]: `${h.rotate}deg`,
                      lineHeight: 1,
                      opacity: 0,
                      filter: 'drop-shadow(0 2px 3px rgba(0,0,0,0.18))',
                    } as React.CSSProperties}
                  >
                    <Heart
                      strokeWidth={2.5}
                      fill="currentColor"
                      style={{ width: h.size, height: h.size }}
                    />
                  </span>
                ))}
              </div>

              {/* Glow blobs */}
              <div className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-white/30 blur-3xl" aria-hidden />
              <div className="pointer-events-none absolute -bottom-16 -left-16 h-48 w-48 rounded-full bg-fuchsia-300/40 blur-3xl" aria-hidden />

              {/* Gift sticker with checkmark badge */}
              <div className="relative z-10">
                {/* Expanding ring ripple behind the sticker */}
                <span
                  aria-hidden
                  className="absolute left-1/2 top-1/2 h-32 w-32 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white/70"
                  style={{ animation: 'ringRipple 1.4s ease-out forwards' }}
                />
                <span
                  aria-hidden
                  className="absolute left-1/2 top-1/2 h-32 w-32 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white/50"
                  style={{ animation: 'ringRipple 1.4s 0.25s ease-out forwards' }}
                />
                <span
                  aria-hidden
                  className="absolute -inset-4 rounded-full bg-white/35 blur-xl"
                />
                <span
                  aria-hidden
                  className="relative flex h-24 w-24 items-center justify-center rounded-3xl bg-gradient-to-br from-white via-pink-50 to-fuchsia-100 text-pink-600 ring-4 ring-white/90 shadow-2xl shadow-pink-900/40"
                  style={{
                    animation: 'giftPop 0.7s cubic-bezier(0.34, 1.56, 0.64, 1) forwards',
                  }}
                >
                  <Gift className="h-12 w-12 drop-shadow-sm" strokeWidth={2.5} />

                  {/* Animated checkmark badge anchored to the gift */}
                  <span
                    aria-hidden
                    className="absolute -bottom-2 -right-2 flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500 text-white ring-4 ring-white shadow-lg shadow-emerald-700/40"
                    style={{
                      animation: 'checkBadgePop 0.6s 0.55s cubic-bezier(0.34, 1.56, 0.64, 1) backwards',
                    }}
                  >
                    <svg
                      width="28"
                      height="28"
                      viewBox="0 0 28 28"
                      fill="none"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path
                        d="M6.5 14.5l4.5 4.5 10.5-11"
                        stroke="white"
                        strokeWidth="3.4"
                        strokeDasharray="22"
                        strokeDashoffset="22"
                        style={{
                          animation: 'checkDraw 0.45s 1.05s cubic-bezier(0.65, 0, 0.35, 1) forwards',
                        }}
                      />
                    </svg>
                  </span>
                </span>
              </div>

              {/* Success copy */}
              <div
                className="relative z-10 mt-8 max-w-md text-center"
                style={{ animation: 'textRise 0.5s 1.2s ease-out backwards' }}
              >
                <h2 className="text-balance text-2xl font-bold tracking-tight text-white drop-shadow-md">
                  {row ? 'Changes saved!' : 'Submitted for review!'}
                </h2>
                <p className="mt-1.5 text-sm leading-relaxed text-white/90">
                  Your shipping details have been sent to the Orphanage team. You can keep
                  editing this page until they approve your {monthsLabel}-month gift.
                </p>
              </div>
            </div>
          )}

          {!celebrating && <>
          {/* Pink hero ribbon with sticker + floating hearts */}
          <div className="relative overflow-hidden bg-gradient-to-br from-pink-500 via-rose-500 to-fuchsia-600 px-6 pb-6 pt-7 text-white">
            <style>{`
              @keyframes modalHeartFloat {
                0%   { transform: translateY(8px)   scale(0.85) rotate(var(--mh-rot)); opacity: 0; }
                12%  { opacity: 0.55; }
                70%  { opacity: 0.35; }
                100% { transform: translateY(-110px) scale(0.5) rotate(var(--mh-rot)); opacity: 0; }
              }
              @keyframes modalGiftWiggle {
                0%, 100% { transform: rotate(-8deg) scale(1); }
                45%      { transform: rotate(-2deg) scale(1.06); }
                55%      { transform: rotate(-14deg) scale(1.06); }
              }
            `}</style>

            {/* Floating hearts */}
            <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
              {HEARTS_FLOAT.map((h, i) => (
                <span
                  key={i}
                  style={{
                    position: 'absolute',
                    bottom: 0,
                    left: h.left,
                    color: 'rgba(255,255,255,0.92)',
                    animation: `modalHeartFloat ${h.dur} ${h.delay} infinite ease-in`,
                    ['--mh-rot' as string]: `${h.rotate}deg`,
                    lineHeight: 1,
                    opacity: 0,
                    filter: 'drop-shadow(0 1px 1px rgba(0,0,0,0.15))',
                  } as React.CSSProperties}
                >
                  <Heart
                    strokeWidth={2.5}
                    fill="currentColor"
                    style={{ width: h.size, height: h.size }}
                  />
                </span>
              ))}
            </div>

            {/* Glow blobs */}
            <div className="pointer-events-none absolute -right-10 -top-10 h-32 w-32 rounded-full bg-white/25 blur-3xl" aria-hidden />
            <div className="pointer-events-none absolute -bottom-12 left-8 h-28 w-28 rounded-full bg-fuchsia-300/40 blur-3xl" aria-hidden />

            {/* Close button (white, over the pink ribbon) */}
            <button
              type="button"
              onClick={() => !saving && setOpen(false)}
              disabled={saving}
              className="absolute right-3 top-3 z-10 inline-flex h-7 w-7 items-center justify-center rounded-full bg-white/20 text-white backdrop-blur-sm transition hover:bg-white/35 disabled:opacity-50"
              aria-label="Close"
            >
              <X className="h-3.5 w-3.5" />
            </button>

            <div className="relative flex items-center gap-4">
              {/* Sticker gift logo (same recipe as the card) */}
              <div className="relative shrink-0">
                <span aria-hidden className="absolute -inset-2 rounded-full bg-white/30 blur-md" />
                <span
                  aria-hidden
                  className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-white via-pink-50 to-fuchsia-100 text-pink-600 ring-4 ring-white/80 shadow-lg shadow-pink-900/30"
                  style={{
                    transform: 'rotate(-8deg)',
                    animation: 'modalGiftWiggle 3.6s ease-in-out infinite',
                    position: 'relative',
                  }}
                >
                  <Gift className="h-7 w-7 drop-shadow-sm" strokeWidth={2.5} />
                  <span
                    aria-hidden
                    className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-rose-500 text-white shadow-sm ring-2 ring-white"
                    style={{ transform: 'rotate(15deg)' }}
                  >
                    <Heart className="h-2.5 w-2.5" fill="currentColor" strokeWidth={0} />
                  </span>
                </span>
              </div>

              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="rounded-full bg-white/25 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.14em] text-white backdrop-blur-sm">
                    Tenure gift
                  </span>
                  <span className="text-[10.5px] font-medium uppercase tracking-[0.16em] text-white/80">
                    {monthsLabel}-month milestone
                  </span>
                </div>
                <DialogTitle className="mt-1 text-balance text-lg font-bold leading-tight text-white drop-shadow-sm">
                  Confirm your shipping details
                </DialogTitle>
                <DialogDescription className="mt-1 text-[13px] leading-snug text-white/85">
                  Tell us where to send your gift. You can edit this freely until the Orphanage
                  team approves it.
                </DialogDescription>
              </div>
            </div>
          </div>

          {/* Tab switcher */}
          <div className="flex gap-1 border-b border-pink-100/80 bg-white/60 px-5 py-2 dark:border-pink-900/30 dark:bg-zinc-950/50">
            {(['form', 'history'] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setActiveTab(tab)}
                className={cn(
                  'rounded-full px-3.5 py-1 text-xs font-semibold transition-colors',
                  activeTab === tab
                    ? 'bg-pink-600 text-white shadow-sm'
                    : 'text-zinc-500 hover:bg-pink-50 hover:text-pink-700 dark:text-zinc-400 dark:hover:bg-pink-950/40 dark:hover:text-pink-300',
                )}
              >
                {tab === 'form' ? 'Shipping Form' : 'Gift History'}
              </button>
            ))}
          </div>

          {/* Form tab */}
          {activeTab === 'form' && (
          <>
          <div className="flex flex-col gap-5 px-6 py-5">
            {/* Section: Your details (prefilled) */}
            <section>
              <div className="mb-2 flex items-center gap-1.5">
                <span className="h-1 w-1 rounded-full bg-pink-500" aria-hidden />
                <h4 className="text-[11px] font-semibold uppercase tracking-wider text-pink-700 dark:text-pink-300">
                  Your details · from your profile
                </h4>
              </div>
              <div className="grid grid-cols-1 gap-3 rounded-xl border border-pink-100 bg-white/70 p-3.5 text-xs shadow-sm dark:border-pink-900/40 dark:bg-zinc-950/40 sm:grid-cols-2">
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-500">Name</div>
                  <div className="mt-0.5 font-medium text-zinc-900 dark:text-zinc-100">{prefill.name ?? '—'}</div>
                </div>
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-500">Department</div>
                  <div className="mt-0.5 font-medium text-zinc-900 dark:text-zinc-100">{prefill.department ?? '—'}</div>
                </div>
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-500">Personal email</div>
                  <div className="mt-0.5 font-mono text-[11px] text-zinc-800 dark:text-zinc-200 break-all">{personalEmail}</div>
                </div>
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-500">Milestone date</div>
                  <div className="mt-0.5 font-medium text-zinc-900 dark:text-zinc-100">
                    {milestone.date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}
                  </div>
                </div>
              </div>
            </section>

            {/* Section: Editable */}
            <section>
              <div className="mb-2 flex items-center gap-1.5">
                <span className="h-1 w-1 rounded-full bg-pink-500" aria-hidden />
                <h4 className="text-[11px] font-semibold uppercase tracking-wider text-pink-700 dark:text-pink-300">
                  Where should we send it?
                </h4>
              </div>
              <div className="grid gap-3.5 rounded-xl border border-pink-100 bg-white/70 p-3.5 shadow-sm dark:border-pink-900/40 dark:bg-zinc-950/40">
                <div className="grid gap-1.5">
                  <Label htmlFor="ship-loc" className="text-xs font-medium">
                    Preferred delivery location <span className="text-rose-500">*</span>
                  </Label>
                  <Input
                    id="ship-loc"
                    value={location}
                    onChange={(e) => setLocation(e.target.value)}
                    placeholder="e.g. 123 Mango St., Brgy. Sample, Cebu City, 6000"
                    disabled={isLocked || saving}
                    className="border-pink-200/80 bg-white focus-visible:ring-pink-400 dark:border-pink-900/50 dark:bg-zinc-950"
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="ship-phone" className="text-xs font-medium">
                    Active contact number <span className="text-rose-500">*</span>
                  </Label>
                  <Input
                    id="ship-phone"
                    value={contact}
                    onChange={(e) => setContact(e.target.value)}
                    placeholder="e.g. +63 912 345 6789"
                    disabled={isLocked || saving}
                    className="border-pink-200/80 bg-white focus-visible:ring-pink-400 dark:border-pink-900/50 dark:bg-zinc-950"
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="ship-notes" className="text-xs font-medium">
                    Notes <span className="font-normal text-zinc-400">· optional</span>
                  </Label>
                  <textarea
                    id="ship-notes"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Landmark, alternative recipient, gate code, gift preferences, etc."
                    disabled={isLocked || saving}
                    className="min-h-[88px] w-full rounded-md border border-pink-200/80 bg-white px-3 py-2 text-sm shadow-sm placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-pink-400/60 disabled:opacity-60 dark:border-pink-900/50 dark:bg-zinc-950"
                  />
                </div>
              </div>
            </section>

            {isLocked && (
              <div className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-xs text-emerald-800 dark:border-emerald-900/40 dark:bg-emerald-950/30 dark:text-emerald-200">
                <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  Approved by the Orphanage team on{' '}
                  <strong>
                    {row?.decided_at
                      ? new Date(row.decided_at).toLocaleDateString(undefined, {
                          year: 'numeric',
                          month: 'short',
                          day: 'numeric',
                        })
                      : '—'}
                  </strong>
                  . This form is now read-only.
                </span>
              </div>
            )}
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-pink-100/80 bg-pink-50/50 px-6 py-3.5 dark:border-pink-900/30 dark:bg-pink-950/20">
            <Button
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={saving}
              className="border-pink-200 bg-white text-zinc-700 hover:bg-pink-50 dark:border-pink-900/40 dark:bg-zinc-950 dark:text-zinc-200 dark:hover:bg-pink-950/40"
            >
              Close
            </Button>
            {!isLocked && (
              <Button
                onClick={onSave}
                disabled={saving}
                className="group relative overflow-hidden bg-gradient-to-r from-pink-600 to-rose-700 text-white shadow-md shadow-pink-600/30 transition-all hover:shadow-lg hover:shadow-pink-600/40 hover:brightness-110"
              >
                {saving ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Heart
                    className="mr-1.5 h-3.5 w-3.5 transition-transform group-hover:scale-125"
                    fill="currentColor"
                  />
                )}
                {row ? 'Save changes' : 'Submit for review'}
              </Button>
            )}
          </div>
          </>
          )}

          {/* History tab — milestone map */}
          {activeTab === 'history' && (
          <>
          <div className="overflow-y-auto px-6 py-5" style={{ maxHeight: '440px' }}>
            <p className="mb-5 text-[11px] text-zinc-500 dark:text-zinc-400">
              One gift every 6 months from your start date. Approved gifts show the item selected by the Orphanage team.
            </p>
            <div className="relative">
              {milestoneMap.map((ms, idx) => {
                const msRow = allRows.find((r) => r.milestone_index === ms.index) ?? null;
                const msStatus = getMsStatus(ms, allRows, milestone, today);
                const isLast = idx === milestoneMap.length - 1;
                const isCurrent = milestone?.index === ms.index;
                const months = ms.index * 6;
                return (
                  <div key={ms.index} className="relative flex gap-4">
                    {/* Connector line */}
                    {!isLast && (
                      <span
                        aria-hidden
                        className={cn(
                          'absolute left-[15px] top-8 bottom-0 w-0.5',
                          msStatus === 'approved'
                            ? 'bg-emerald-200 dark:bg-emerald-900/50'
                            : 'bg-zinc-200 dark:bg-zinc-800',
                        )}
                      />
                    )}
                    {/* Node */}
                    <div
                      className={cn(
                        'relative z-10 mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 text-[11px] font-bold',
                        msStatus === 'approved' && 'border-emerald-500 bg-emerald-500 text-white',
                        msStatus === 'pending' && 'border-amber-400 bg-amber-50 text-amber-700 dark:bg-amber-950/40',
                        msStatus === 'rejected' && 'border-rose-500 bg-rose-50 text-rose-700 dark:bg-rose-950/40',
                        msStatus === 'unsubmitted' && 'border-pink-500 bg-pink-50 text-pink-700 dark:bg-pink-950/40',
                        msStatus === 'missed' && 'border-zinc-300 bg-zinc-100 text-zinc-400 dark:border-zinc-700 dark:bg-zinc-900',
                        msStatus === 'upcoming' && 'border-zinc-200 bg-white text-zinc-300 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-600',
                      )}
                    >
                      {msStatus === 'approved' ? (
                        <CheckCircle2 className="h-4 w-4" />
                      ) : msStatus === 'unsubmitted' || msStatus === 'missed' ? (
                        <Gift className="h-3.5 w-3.5" />
                      ) : msStatus === 'upcoming' ? (
                        <Lock className="h-3 w-3" />
                      ) : (
                        <span>{ms.index}</span>
                      )}
                    </div>
                    {/* Content */}
                    <div className={cn('min-w-0 flex-1', !isLast ? 'pb-6' : 'pb-2')}>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span
                          className={cn(
                            'text-[13px] font-semibold leading-tight',
                            msStatus === 'approved' && 'text-emerald-700 dark:text-emerald-400',
                            msStatus === 'pending' && 'text-amber-700 dark:text-amber-400',
                            msStatus === 'rejected' && 'text-rose-700 dark:text-rose-400',
                            msStatus === 'unsubmitted' && 'text-pink-700 dark:text-pink-300',
                            (msStatus === 'missed' || msStatus === 'upcoming') && 'text-zinc-400 dark:text-zinc-500',
                          )}
                        >
                          {tenureLabel(months)}
                        </span>
                        {isCurrent && (
                          <span className="rounded-full bg-pink-100 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-pink-700 dark:bg-pink-900/40 dark:text-pink-300">
                            Current
                          </span>
                        )}
                        {msStatus === 'approved' && (
                          <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">
                            Received
                          </span>
                        )}
                        {msStatus === 'pending' && (
                          <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
                            Pending review
                          </span>
                        )}
                        {msStatus === 'rejected' && (
                          <span className="rounded-full bg-rose-100 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-rose-700 dark:bg-rose-900/30 dark:text-rose-400">
                            Needs revision
                          </span>
                        )}
                        {msStatus === 'upcoming' && (
                          <span className="text-[10px] text-zinc-400 dark:text-zinc-600">Upcoming</span>
                        )}
                      </div>
                      <div className="mt-0.5 text-[11px] text-zinc-400 dark:text-zinc-600">
                        {ms.date.toLocaleDateString(undefined, {
                          year: 'numeric',
                          month: 'short',
                          day: 'numeric',
                        })}
                        {msStatus === 'approved' && msRow?.decided_at && (
                          <span className="ml-2 text-emerald-600 dark:text-emerald-500">
                            · Approved{' '}
                            {new Date(msRow.decided_at).toLocaleDateString(undefined, {
                              month: 'short',
                              day: 'numeric',
                              year: 'numeric',
                            })}
                          </span>
                        )}
                      </div>
                      {msStatus === 'approved' && msRow?.gift_name && (
                        <div className="mt-1.5 flex items-center gap-1.5 rounded-md border border-emerald-100 bg-emerald-50/80 px-2.5 py-1.5 text-[11px] font-medium text-emerald-800 dark:border-emerald-900/40 dark:bg-emerald-950/30 dark:text-emerald-300">
                          <Gift className="h-3 w-3 shrink-0" />
                          <span>{msRow.gift_name}</span>
                          {msRow.gift_price_php != null && (
                            <span className="ml-auto font-normal text-emerald-600 dark:text-emerald-500">
                              ₱{msRow.gift_price_php.toLocaleString()}
                            </span>
                          )}
                        </div>
                      )}
                      {msStatus === 'rejected' && msRow?.decision_note && (
                        <div className="mt-1 text-[11px] italic text-rose-600 dark:text-rose-400">
                          Feedback: {msRow.decision_note}
                        </div>
                      )}
                      {msStatus === 'missed' && (
                        <div className="mt-0.5 text-[11px] text-zinc-400 dark:text-zinc-600">
                          No shipping details submitted
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="flex items-center justify-between border-t border-pink-100/80 bg-pink-50/50 px-6 py-3 dark:border-pink-900/30 dark:bg-pink-950/20">
            <p className="text-[11px] text-zinc-400 dark:text-zinc-600">
              {allRows.filter((r) => r.status === 'approved').length} of{' '}
              {milestoneMap.filter((m) => diffDays(m.date, today) <= 0).length} milestone
              {milestoneMap.filter((m) => diffDays(m.date, today) <= 0).length === 1 ? '' : 's'} received
            </p>
            <Button
              variant="outline"
              onClick={() => setOpen(false)}
              className="border-pink-200 bg-white text-zinc-700 hover:bg-pink-50 dark:border-pink-900/40 dark:bg-zinc-950 dark:text-zinc-200 dark:hover:bg-pink-950/40"
            >
              Close
            </Button>
          </div>
          </>
          )}
          </>}
        </DialogContent>
      </Dialog>
      )}
    </>
  );
}
