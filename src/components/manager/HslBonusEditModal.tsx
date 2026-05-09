'use client';

import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  Lock,
  Save,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import {
  BonusStatus,
  DeptConfig,
  HslDeptKey,
  HSL_DEPTS,
  KpiData,
  SubTeamName,
  TeamSplitRule,
  TieredRule,
  calcBonus,
  calcTeamSplitShare,
  formatPeso,
} from '@/lib/hsl-bonus/schema';
import {
  DEFAULT_SUB_TEAMS,
  KpiTable,
  SsdEmployeeTable,
  SsdSubTeamGrid,
  type EntryRow,
  type SubTeamState,
  recomputeSsdEntries,
} from './HslBonusCalculator';

interface HslBonusEditModalProps {
  open: boolean;
  deptKey: HslDeptKey;
  periodStart: string;
  periodEnd: string;
  initialStatus: BonusStatus;
  periodLabel: string;
  viewerEmail: string | null;
  onClose: () => void;
  onSaved: () => void;
  onDeleted: () => void;
}

export default function HslBonusEditModal({
  open,
  deptKey,
  periodStart,
  periodEnd,
  initialStatus,
  periodLabel,
  viewerEmail,
  onClose,
  onSaved,
  onDeleted,
}: HslBonusEditModalProps) {
  const dept = HSL_DEPTS[deptKey];
  const isTeamSplit = dept.rules[0]?.type === 'team_split';
  const tieredRule = dept.rules.find((r): r is TieredRule => r.type === 'tiered');

  const [entries, setEntries] = useState<EntryRow[]>([]);
  const [subTeams, setSubTeams] =
    useState<Record<SubTeamName, SubTeamState>>(DEFAULT_SUB_TEAMS);
  const [status, setStatus] = useState<BonusStatus>(initialStatus);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [dirty, setDirty] = useState(false);

  // Reset whenever the modal opens for a new period
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDirty(false);
    setConfirmDelete(false);
    setStatus(initialStatus);

    (async () => {
      try {
        const res = await fetch(
          `/api/hsl-bonus/entries?dept=${deptKey}&period_start=${periodStart}`,
          { cache: 'no-store' },
        );
        const json = (await res.json()) as {
          rows?: {
            id: string;
            employee_email: string;
            employee_name: string | null;
            is_manager: boolean;
            kpi_data: KpiData;
            calculated_bonus: number;
          }[];
          error?: string;
        };
        if (cancelled) return;
        if (json.error) setError(json.error);
        const rows: EntryRow[] = (json.rows ?? []).map((r) => ({
          id: r.id,
          employee_email: r.employee_email.toLowerCase(),
          employee_name: r.employee_name ?? r.employee_email,
          is_manager: r.is_manager,
          kpi_data: r.kpi_data ?? {},
          calculated_bonus: r.calculated_bonus ?? 0,
        }));
        rows.sort((a, b) =>
          a.employee_name.localeCompare(b.employee_name, undefined, { sensitivity: 'base' }),
        );
        setEntries(rows);
        // We don't persist subTeams (pct/records) in the DB today; reset to
        // empty so the manager re-enters scores when editing past weeks. The
        // existing per-employee `calculated_bonus` is shown as a reference.
        setSubTeams({ ...DEFAULT_SUB_TEAMS });
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Failed to load entries');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, deptKey, periodStart, initialStatus]);

  const subtotal = useMemo(
    () => entries.reduce((s, e) => s + e.calculated_bonus, 0),
    [entries],
  );

  const subTeamMemberCount = (subTeam: SubTeamName): number =>
    entries.filter((e) => (e.kpi_data.sub_team as unknown as string) === subTeam).length;

  const ssdShareForTeam = (subTeam: SubTeamName, memberCount: number): number => {
    if (!isTeamSplit) return 0;
    const st = subTeams[subTeam];
    const pct = parseFloat(st.pct) || 0;
    const records = parseInt(st.records, 10) || 0;
    const rule = dept.rules[0] as TeamSplitRule;
    return calcTeamSplitShare(pct, records, memberCount, rule);
  };

  const handleKpiChange = (email: string, kpiKey: string, val: number | boolean) => {
    setEntries((prev) => {
      const next = prev.map((e) => {
        if (e.employee_email !== email) return e;
        const newKpi = { ...e.kpi_data, [kpiKey]: val };
        return {
          ...e,
          kpi_data: newKpi,
          calculated_bonus: calcBonus(newKpi, dept, e.is_manager),
        };
      });
      return recomputeSsdEntries(deptKey, next, subTeams);
    });
    setDirty(true);
  };

  const handleToggleManager = (email: string) => {
    setEntries((prev) => {
      const next = prev.map((e) => {
        if (e.employee_email !== email) return e;
        const newIsManager = !e.is_manager;
        return {
          ...e,
          is_manager: newIsManager,
          calculated_bonus: calcBonus(e.kpi_data, dept, newIsManager),
        };
      });
      return recomputeSsdEntries(deptKey, next, subTeams);
    });
    setDirty(true);
  };

  const handleSubTeamChange = (
    subTeam: SubTeamName,
    field: 'pct' | 'records',
    val: string,
  ) => {
    setSubTeams((prev) => {
      const next = {
        ...prev,
        [subTeam]: { ...prev[subTeam], [field]: val },
      };
      // Recompute entries with the new subTeams so the table updates live.
      setEntries((curEntries) => recomputeSsdEntries(deptKey, curEntries, next));
      return next;
    });
    setDirty(true);
  };

  const handleSubTeamAssign = (email: string, subTeam: SubTeamName | '') => {
    handleKpiChange(email, 'sub_team', subTeam as unknown as number);
  };

  async function persistStatus(next: BonusStatus): Promise<boolean> {
    try {
      const res = await fetch('/api/hsl-bonus/period-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          department: deptKey,
          period_type: dept.cadence,
          period_start: periodStart,
          period_end: periodEnd,
          status: next,
          locked_by: viewerEmail ?? undefined,
        }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? 'Status update failed');
      setStatus(next);
      return true;
    } catch (e) {
      toast.error('Status update failed', {
        description: e instanceof Error ? e.message : String(e),
      });
      return false;
    }
  }

  async function persistEntries(): Promise<boolean> {
    try {
      const payload = entries.map((e) => ({
        department: deptKey,
        period_type: dept.cadence,
        period_start: periodStart,
        period_end: periodEnd,
        employee_email: e.employee_email,
        employee_name: e.employee_name,
        is_manager: e.is_manager,
        kpi_data: e.kpi_data,
        calculated_bonus: e.calculated_bonus,
        created_by: viewerEmail ?? undefined,
      }));
      const res = await fetch('/api/hsl-bonus/entries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entries: payload }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? 'Save failed');
      return true;
    } catch (e) {
      toast.error('Save failed', {
        description: e instanceof Error ? e.message : String(e),
      });
      return false;
    }
  }

  /** Save edits and bounce back to draft so accounting sees the new totals
   *  only after the manager re-marks ready. Matches the existing reopen flow. */
  const handleSave = async () => {
    setSaving(true);
    const okEntries = await persistEntries();
    if (!okEntries) {
      setSaving(false);
      return;
    }
    // After editing a ready/locked period, drop back to draft so accounting
    // doesn't see partial mid-edit state until the manager re-marks ready.
    if (status !== 'draft') {
      const ok = await persistStatus('draft');
      if (!ok) {
        setSaving(false);
        return;
      }
    }
    setDirty(false);
    setSaving(false);
    toast.success('Changes saved', {
      description: 'Period flipped back to draft — Mark Ready to send to Accounting again.',
    });
    onSaved();
  };

  const handleSaveAndMarkReady = async () => {
    setSaving(true);
    const okEntries = await persistEntries();
    if (!okEntries) {
      setSaving(false);
      return;
    }
    const okStatus = await persistStatus('ready');
    if (!okStatus) {
      setSaving(false);
      return;
    }
    setDirty(false);
    setSaving(false);
    toast.success('Saved & marked ready', {
      description: 'Visible to Accounting · PayrollWizard.',
    });
    onSaved();
    onClose();
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      const res = await fetch(
        `/api/hsl-bonus/period?dept=${deptKey}&period_start=${periodStart}`,
        { method: 'DELETE' },
      );
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? 'Delete failed');
      toast.success(`${dept.name} · ${periodLabel} deleted`);
      setDeleting(false);
      onDeleted();
      onClose();
    } catch (e) {
      setDeleting(false);
      toast.error('Delete failed', {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const isLocked = false; // editing always allows changes

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="grid max-h-[92vh] w-[calc(100%-1.5rem)] grid-rows-[auto_1fr_auto] gap-0 overflow-hidden p-0 sm:max-w-3xl">
        <header
          className="flex flex-col gap-1 border-b border-zinc-200/70 px-5 py-4 dark:border-zinc-800"
          style={{ borderLeft: `3px solid ${dept.color}` }}
        >
          <div className="flex flex-wrap items-center gap-2">
            <DialogTitle className="text-[15px] font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
              Edit · {dept.name}
            </DialogTitle>
            <span
              className={cn(
                'inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider ring-1 ring-inset',
                status === 'draft' &&
                  'bg-zinc-100 text-zinc-600 ring-zinc-200/70 dark:bg-zinc-800/60 dark:text-zinc-300 dark:ring-zinc-700/70',
                status === 'ready' &&
                  'bg-amber-100 text-amber-800 ring-amber-300/60 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-700/40',
                status === 'locked' &&
                  'bg-emerald-100 text-emerald-800 ring-emerald-300/60 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-700/40',
              )}
            >
              {status === 'locked' && <Lock className="h-3 w-3" />}
              {status === 'ready' && <CheckCircle2 className="h-3 w-3" />}
              {status}
            </span>
          </div>
          <DialogDescription className="text-[12px] text-zinc-500 dark:text-zinc-400">
            {periodLabel} · {entries.length}{' '}
            {entries.length === 1 ? 'employee' : 'employees'} ·{' '}
            <span className="font-mono font-semibold text-emerald-600 dark:text-emerald-400">
              {formatPeso(subtotal)}
            </span>{' '}
            current total
          </DialogDescription>
          {isTeamSplit && (
            <p className="mt-1 rounded-md bg-amber-50/70 px-2 py-1 text-[11px] leading-snug text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
              <AlertCircle className="mr-1 inline-block h-3 w-3" />
              Re-enter Accuracy % and Records for each sub-team — they aren&rsquo;t
              persisted between sessions. Per-employee shares will recompute as you type.
            </p>
          )}
        </header>

        <div className="min-h-0 overflow-y-auto bg-zinc-50/40 px-4 py-4 dark:bg-zinc-950/30 sm:px-5">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-12 text-[12px] text-zinc-500">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading entries…
            </div>
          ) : error ? (
            <div className="rounded-xl border border-rose-200/80 bg-rose-50/60 px-4 py-6 text-center text-sm text-rose-700 dark:border-rose-900/40 dark:bg-rose-950/30 dark:text-rose-300">
              {error}
            </div>
          ) : entries.length === 0 ? (
            <div className="rounded-xl border border-dashed border-zinc-200 bg-white px-4 py-12 text-center text-[12px] text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950/40 dark:text-zinc-400">
              No employees in this period.
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {isTeamSplit && (
                <SsdSubTeamGrid
                  subTeams={subTeams}
                  isLocked={isLocked}
                  onSubTeamChange={handleSubTeamChange}
                  ssdShareForTeam={ssdShareForTeam}
                  subTeamMemberCount={subTeamMemberCount}
                />
              )}

              {tieredRule && (
                <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900/30">
                  <span className="font-mono text-[9px] uppercase tracking-[0.15em] text-zinc-500">
                    {tieredRule.label} tiers
                  </span>
                  {tieredRule.tiers.map((t, i) => (
                    <span
                      key={i}
                      className="rounded border border-zinc-300 bg-white px-1.5 py-0.5 font-mono text-[9px] text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400"
                    >
                      {t.min}–{t.max ?? '∞'} → {t.rate === 0 ? '₱0' : `₱${t.rate}/case`}
                    </span>
                  ))}
                </div>
              )}

              {!isTeamSplit && !dept.noKpi && (
                <KpiTable
                  dept={dept}
                  entries={entries}
                  subtotal={subtotal}
                  isLocked={isLocked}
                  onKpiChange={handleKpiChange}
                  onToggleManager={handleToggleManager}
                />
              )}

              {isTeamSplit && (
                <SsdEmployeeTable
                  entries={entries}
                  allEntries={entries}
                  isLocked={isLocked}
                  ssdShareForTeam={ssdShareForTeam}
                  onSubTeamAssign={handleSubTeamAssign}
                />
              )}
            </div>
          )}
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-zinc-200/70 bg-white/60 px-5 py-3 dark:border-zinc-800 dark:bg-zinc-950/40">
          <div className="flex items-center gap-2">
            <AnimatePresence initial={false} mode="wait">
              {confirmDelete ? (
                <motion.div
                  key="confirm"
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -8 }}
                  transition={{ duration: 0.15 }}
                  className="flex items-center gap-2"
                >
                  <span className="text-[11px] font-medium text-rose-700 dark:text-rose-400">
                    Delete this entire week?
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    disabled={deleting}
                    onClick={() => setConfirmDelete(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    className="h-7 gap-1.5 bg-rose-600 text-xs text-white hover:bg-rose-500"
                    disabled={deleting}
                    onClick={() => void handleDelete()}
                  >
                    {deleting ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Trash2 className="h-3 w-3" />
                    )}
                    {deleting ? 'Deleting…' : 'Yes, delete'}
                  </Button>
                </motion.div>
              ) : (
                <motion.div
                  key="actions"
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -8 }}
                  transition={{ duration: 0.15 }}
                >
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-8 gap-1.5 border-rose-200 text-xs text-rose-700 hover:bg-rose-50 dark:border-rose-900/50 dark:text-rose-400 dark:hover:bg-rose-950/30"
                    disabled={loading || saving}
                    onClick={() => setConfirmDelete(true)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Delete week
                  </Button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8 text-xs"
              onClick={onClose}
              disabled={saving || deleting}
            >
              Close
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8 gap-1.5 text-xs"
              disabled={saving || deleting || !dirty || loading}
              onClick={() => void handleSave()}
            >
              {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
              Save (back to draft)
            </Button>
            <Button
              type="button"
              size="sm"
              className="h-8 gap-1.5 bg-amber-600 text-xs text-white hover:bg-amber-500 disabled:opacity-50"
              disabled={saving || deleting || loading || entries.length === 0}
              onClick={() => void handleSaveAndMarkReady()}
            >
              {saving ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <CheckCircle2 className="h-3 w-3" />
              )}
              Save & Mark Ready
            </Button>
          </div>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
