'use client';

import { AnimatePresence, motion } from 'motion/react';
import { CheckCircle2, Lock, Unlock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import {
  DeptConfig,
  formatPeso,
  type KpiData,
  type SubTeamName,
} from '@/lib/hsl-bonus/schema';

interface PreviewEntry {
  employee_email: string;
  employee_name: string;
  is_manager: boolean;
  kpi_data: KpiData;
  calculated_bonus: number;
}

interface HslBonusReadyPreviewProps {
  open: boolean;
  dept: DeptConfig | null;
  status: 'ready' | 'locked';
  periodLabel: string;
  entries: PreviewEntry[];
  reopenSubmitting?: boolean;
  /** Omit to hide the Reopen button entirely (e.g., the History view is read-only). */
  onReopen?: () => void;
  onClose: () => void;
}

const SUB_TEAM_DOT: Record<SubTeamName, string> = {
  BLUE: 'bg-blue-500',
  GREEN: 'bg-emerald-500',
  YELLOW: 'bg-yellow-500',
  ORANGE: 'bg-orange-500',
  PURPLE: 'bg-violet-500',
  RED: 'bg-red-500',
};

const STATUS_PALETTE: Record<
  'ready' | 'locked',
  { bg: string; text: string; ring: string; icon: typeof CheckCircle2 }
> = {
  ready: {
    bg: 'bg-amber-100 dark:bg-amber-950/40',
    text: 'text-amber-800 dark:text-amber-300',
    ring: 'ring-amber-300/60 dark:ring-amber-700/40',
    icon: CheckCircle2,
  },
  locked: {
    bg: 'bg-emerald-100 dark:bg-emerald-950/40',
    text: 'text-emerald-800 dark:text-emerald-300',
    ring: 'ring-emerald-300/60 dark:ring-emerald-700/40',
    icon: Lock,
  },
};

export default function HslBonusReadyPreview({
  open,
  dept,
  status,
  periodLabel,
  entries,
  reopenSubmitting = false,
  onReopen,
  onClose,
}: HslBonusReadyPreviewProps) {
  const isSsd = dept?.key === 'ssd_medical_records';
  const total = entries.reduce((s, e) => s + e.calculated_bonus, 0);
  const palette = STATUS_PALETTE[status];
  const StatusIcon = palette.icon;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="grid max-h-[88vh] w-[calc(100%-1.5rem)] grid-rows-[auto_1fr_auto] gap-0 overflow-hidden p-0 sm:max-w-2xl"
      >
        {dept && (
          <>
            <header
              className="flex flex-col gap-1 border-b border-zinc-200/70 px-5 py-4 dark:border-zinc-800"
              style={{ borderLeft: `3px solid ${dept.color}` }}
            >
              <div className="flex flex-wrap items-center gap-2">
                <DialogTitle className="text-[15px] font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
                  {dept.name}
                </DialogTitle>
                <span
                  className={cn(
                    'inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider ring-1 ring-inset',
                    palette.bg,
                    palette.text,
                    palette.ring,
                  )}
                >
                  <StatusIcon className="h-3 w-3" />
                  {status}
                </span>
              </div>
              <DialogDescription className="text-[12px] text-zinc-500 dark:text-zinc-400">
                {periodLabel} · {entries.length}{' '}
                {entries.length === 1 ? 'employee' : 'employees'} ·{' '}
                <span className="font-mono font-semibold text-emerald-600 dark:text-emerald-400">
                  {formatPeso(total)}
                </span>{' '}
                total
              </DialogDescription>
              <p className="mt-1 text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">
                {status === 'ready'
                  ? 'These scores are visible to Accounting and will flow into PayrollWizard → Additions. Reopen to make changes.'
                  : 'Locked for the week — Accounting can dispatch these as final bonuses.'}
              </p>
            </header>

            <div className="min-h-0 overflow-y-auto bg-zinc-50/40 px-4 py-4 dark:bg-zinc-950/30 sm:px-5">
              {entries.length === 0 ? (
                <div className="rounded-xl border border-dashed border-zinc-200 bg-white px-4 py-12 text-center text-[12px] text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950/40 dark:text-zinc-400">
                  No employees scored yet for this period.
                </div>
              ) : (
                <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950/60">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-zinc-200 bg-zinc-50/80 dark:border-zinc-800 dark:bg-zinc-900/40">
                        <th className="px-3 py-2 text-left font-mono text-[9px] uppercase tracking-[0.15em] text-zinc-500">
                          Employee
                        </th>
                        {isSsd && (
                          <th className="px-2 py-2 text-left font-mono text-[9px] uppercase tracking-[0.15em] text-zinc-500">
                            Sub-team
                          </th>
                        )}
                        <th className="px-3 py-2 text-right font-mono text-[9px] uppercase tracking-[0.15em] text-zinc-500">
                          Bonus
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      <AnimatePresence initial={false}>
                        {entries.map((e, idx) => {
                          const subTeam =
                            (e.kpi_data.sub_team as unknown as SubTeamName | undefined) ?? null;
                          return (
                            <motion.tr
                              key={e.employee_email}
                              initial={{ opacity: 0, y: 4 }}
                              animate={{ opacity: 1, y: 0 }}
                              transition={{
                                duration: 0.2,
                                delay: Math.min(idx * 0.015, 0.18),
                                ease: [0.22, 1, 0.36, 1],
                              }}
                              className="border-b border-zinc-100 last:border-b-0 dark:border-zinc-800/60"
                            >
                              <td className="px-3 py-2">
                                <div className="font-medium text-zinc-900 dark:text-zinc-100">
                                  {e.employee_name}
                                  {e.is_manager && (
                                    <span className="ml-1.5 rounded bg-blue-100 px-1 py-0.5 font-mono text-[8px] uppercase tracking-wider text-blue-700 dark:bg-blue-950/40 dark:text-blue-300">
                                      Mgr
                                    </span>
                                  )}
                                </div>
                                <div className="font-mono text-[10px] text-zinc-500">
                                  {e.employee_email}
                                </div>
                              </td>
                              {isSsd && (
                                <td className="px-2 py-2">
                                  {subTeam ? (
                                    <span className="inline-flex items-center gap-1.5 rounded-md bg-zinc-100 px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200">
                                      <span
                                        className={cn(
                                          'h-1.5 w-1.5 rounded-full',
                                          SUB_TEAM_DOT[subTeam],
                                        )}
                                      />
                                      {subTeam}
                                    </span>
                                  ) : (
                                    <span className="font-mono text-[10px] text-zinc-300 dark:text-zinc-700">
                                      —
                                    </span>
                                  )}
                                </td>
                              )}
                              <td className="px-3 py-2 text-right font-mono text-xs font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
                                {formatPeso(e.calculated_bonus)}
                              </td>
                            </motion.tr>
                          );
                        })}
                      </AnimatePresence>
                      <tr className="border-t border-zinc-300 bg-zinc-100/70 dark:border-zinc-700 dark:bg-zinc-900/60">
                        <td
                          colSpan={isSsd ? 2 : 1}
                          className="px-3 py-2 font-mono text-[10px] uppercase tracking-[0.15em] text-zinc-500"
                        >
                          Total
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-sm font-bold text-zinc-900 dark:text-zinc-100">
                          {formatPeso(total)}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-zinc-200/70 bg-white/60 px-5 py-3 dark:border-zinc-800 dark:bg-zinc-950/40">
              <span className="font-mono text-[10px] text-zinc-500">
                Auto-syncs to Accounting · PayrollWizard
              </span>
              <div className="flex items-center gap-2">
                {status === 'ready' && onReopen && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={onReopen}
                    disabled={reopenSubmitting}
                    className="h-8 gap-1.5 text-xs"
                  >
                    <Unlock className="h-3.5 w-3.5" />
                    {reopenSubmitting ? 'Reopening…' : 'Reopen for edits'}
                  </Button>
                )}
                <Button type="button" size="sm" onClick={onClose} className="h-8 text-xs">
                  Close
                </Button>
              </div>
            </footer>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
