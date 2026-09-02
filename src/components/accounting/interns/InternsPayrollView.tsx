'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Clock,
  GraduationCap,
  Loader2,
  RefreshCw,
  RotateCcw,
  Settings2,
  Undo2,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { formatInternPHP, type InternInboxWeek, type InternPayStatus, type InternShareMode } from '@/lib/interns/intern-types';
import { INTERN_PAB_MIN_WEEKLY_HOURS } from '@/lib/interns/intern-pab';

/**
 * Payroll Wizard → Interns (the Simple | Interns toggle in App.tsx).
 *
 * Accounting's side of the hand-off: an inbox of weeks the Orphanage Manager
 * locked in the mini wizard. Each row is RE-DERIVED on read from its own
 * hours × rates (a red chip on drift, never a rewrite). Accounting ACCEPTS a
 * week (its rows become pending items in Payment Dispatch → Orphanage) or
 * REJECTS it back with a note. It never edits an intern's hours, rate, bank or
 * personal data — those change on the Orphanage dashboard only (Kane 2026-09-02).
 * Setup holds the one config the interns have: how the orphanage share is paid.
 */

type Filter = 'submitted' | 'accepted' | 'rejected' | 'all';

function weekLabel(start: string, end: string): string {
  const f = (iso: string) => {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };
  return `${f(start)} – ${f(end)}`;
}
function when(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

const STATUS_CHIP: Record<InternPayStatus, string> = {
  submitted: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
  accepted: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300',
  rejected: 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300',
};

export default function InternsPayrollView({ canEdit }: { sessionEmail: string | null; canEdit: boolean }) {
  const [weeks, setWeeks] = useState<InternInboxWeek[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('submitted');
  const [config, setConfig] = useState<{ shareMode: InternShareMode | null } | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [decision, setDecision] = useState<{ week: InternInboxWeek; kind: 'accepted' | 'rejected' | 'reopen' } | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    setError(null);
    try {
      const [wRes, cRes] = await Promise.all([
        fetch(`/api/orphanage-interns/pay-weeks/inbox?_=${Date.now()}`, { cache: 'no-store' }),
        fetch(`/api/orphanage-interns/pay-weeks/config?_=${Date.now()}`, { cache: 'no-store' }),
      ]);
      const wJson = (await wRes.json()) as { weeks?: InternInboxWeek[]; error?: string | null };
      const cJson = (await cRes.json()) as { config?: { shareMode: InternShareMode | null }; error?: string | null };
      if (!wRes.ok || wJson.error) throw new Error(wJson.error ?? 'Could not load intern weeks');
      setWeeks(wJson.weeks ?? []);
      if (cRes.ok && cJson.config) setConfig(cJson.config);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Could not load intern weeks';
      if (opts?.silent) toast.error(msg);
      else setError(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(() => (filter === 'all' ? weeks : weeks.filter((w) => w.status === filter)), [weeks, filter]);
  const counts = useMemo(
    () => ({
      submitted: weeks.filter((w) => w.status === 'submitted').length,
      accepted: weeks.filter((w) => w.status === 'accepted').length,
      rejected: weeks.filter((w) => w.status === 'rejected').length,
    }),
    [weeks],
  );

  const decide = async () => {
    if (!decision) return;
    setBusy(true);
    try {
      const res = await fetch('/api/orphanage-interns/pay-weeks/decide', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source_file: decision.week.sourceFile, decision: decision.kind, note: note.trim() || null }),
      });
      const json = (await res.json()) as { error?: string | null };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Decision failed');
      toast.success(
        decision.kind === 'accepted'
          ? `Accepted ${weekLabel(decision.week.weekStart, decision.week.weekEnd)} — now pending in Payment Dispatch → Orphanage`
          : decision.kind === 'rejected'
            ? 'Sent back to the Orphanage Manager'
            : 'Week reopened — back with the Orphanage Manager',
      );
      setDecision(null);
      setNote('');
      await load({ silent: true });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Decision failed');
    } finally {
      setBusy(false);
    }
  };

  const saveConfig = async (mode: InternShareMode | null) => {
    setBusy(true);
    try {
      const res = await fetch('/api/orphanage-interns/pay-weeks/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shareMode: mode }),
      });
      const json = (await res.json()) as { config?: { shareMode: InternShareMode | null }; error?: string | null };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Could not save');
      setConfig(json.config ?? { shareMode: mode });
      toast.success(mode ? 'Share mode saved — the mini wizard can lock in now' : 'Share mode cleared — lock in is blocked until it is set');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-violet-700 dark:text-violet-300">
            <GraduationCap className="h-3.5 w-3.5" /> Interns · locked weeks from the Orphanage dashboard
          </div>
          <p className="mt-1 max-w-2xl text-xs text-zinc-500 dark:text-zinc-400">
            Accept a week to send it to Payment Dispatch → Orphanage, or reject it back with a note. Hours, rates,
            bank and personal details are managed on the Orphanage dashboard — nothing here edits them.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider',
              config?.shareMode ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300' : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
            )}
          >
            {config?.shareMode === 'system_split' ? 'Share: split to two payees' : config?.shareMode === 'intern_remits' ? 'Share: intern remits' : 'Share mode not set'}
          </span>
          <Button size="sm" variant="outline" onClick={() => setSetupOpen(true)} className="h-8 gap-1.5 text-xs">
            <Settings2 className="h-3.5 w-3.5" /> Setup
          </Button>
          <Button size="sm" variant="outline" onClick={() => load()} className="h-8 gap-1.5 text-xs">
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} /> Refresh
          </Button>
        </div>
      </div>

      <div role="tablist" className="inline-flex w-fit rounded-xl border border-zinc-200 bg-zinc-50 p-1 dark:border-zinc-800 dark:bg-zinc-900/60">
        {(['submitted', 'accepted', 'rejected', 'all'] as Filter[]).map((f) => (
          <button
            key={f}
            role="tab"
            type="button"
            aria-selected={filter === f}
            onClick={() => setFilter(f)}
            className={cn(
              'rounded-lg px-3 py-1.5 text-xs font-semibold capitalize transition-colors',
              filter === f ? 'bg-white text-violet-700 shadow-sm dark:bg-zinc-950 dark:text-violet-300' : 'text-zinc-500 hover:text-violet-700 dark:text-zinc-400',
            )}
          >
            {f === 'submitted' ? `Awaiting you · ${counts.submitted}` : f === 'accepted' ? `Accepted · ${counts.accepted}` : f === 'rejected' ? `Sent back · ${counts.rejected}` : 'All'}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex flex-1 items-center justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-violet-500" /></div>
      ) : error ? (
        <div className="rounded-xl border border-rose-200 bg-rose-50/60 px-4 py-6 text-center text-xs text-rose-700 dark:border-rose-900/40 dark:bg-rose-950/20 dark:text-rose-300">{error}</div>
      ) : visible.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-zinc-200 px-6 py-14 text-center dark:border-zinc-800">
          <Clock className="h-6 w-6 text-zinc-400" />
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            {filter === 'submitted' ? 'Nothing awaiting you' : 'No weeks here'}
          </h2>
          <p className="max-w-sm text-xs text-zinc-500 dark:text-zinc-400">
            Weeks appear when the Orphanage Manager locks them in the Interns tab of the Orphanage dashboard.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {visible.map((w) => (
            <section key={w.sourceFile} className="rounded-2xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
              <header className="flex flex-wrap items-start justify-between gap-3 border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{weekLabel(w.weekStart, w.weekEnd)}</span>
                    <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider', STATUS_CHIP[w.status])}>{w.status}</span>
                    {w.mismatches > 0 && (
                      <span className="flex items-center gap-1 rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-rose-700 dark:bg-rose-900/30 dark:text-rose-300">
                        <AlertTriangle className="h-3 w-3" /> {w.mismatches} mismatch{w.mismatches === 1 ? '' : 'es'}
                      </span>
                    )}
                    {w.paidRows > 0 && (
                      <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">
                        {w.paidRows} paid
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 font-mono text-[10px] text-zinc-400">{w.sourceFile}</p>
                  <p className="mt-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">
                    Locked in {when(w.submittedAt)}{w.submittedBy ? ` by ${w.submittedBy}` : ''}
                    {w.decidedAt ? ` · ${w.status} ${when(w.decidedAt)}${w.decidedBy ? ` by ${w.decidedBy}` : ''}` : ''}
                    {w.decisionNote ? ` · “${w.decisionNote}”` : ''}
                  </p>
                </div>
                {canEdit && (
                  <div className="flex items-center gap-1.5">
                    {w.status === 'submitted' && (
                      <>
                        <Button size="sm" variant="outline" onClick={() => { setDecision({ week: w, kind: 'rejected' }); setNote(''); }} className="h-8 gap-1.5 text-xs text-rose-700 hover:bg-rose-50 dark:text-rose-300">
                          <Undo2 className="h-3.5 w-3.5" /> Send back
                        </Button>
                        <Button size="sm" onClick={() => { setDecision({ week: w, kind: 'accepted' }); setNote(''); }} className="h-8 gap-1.5 bg-emerald-600 text-xs text-white hover:bg-emerald-700">
                          <Check className="h-3.5 w-3.5" /> Accept week
                        </Button>
                      </>
                    )}
                    {w.status === 'accepted' && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={w.paidRows > 0}
                        title={w.paidRows > 0 ? 'Some rows are already paid — a paid week cannot be reopened' : undefined}
                        onClick={() => { setDecision({ week: w, kind: 'reopen' }); setNote(''); }}
                        className="h-8 gap-1.5 text-xs"
                      >
                        <RotateCcw className="h-3.5 w-3.5" /> Reopen
                      </Button>
                    )}
                  </div>
                )}
              </header>

              <div className="grid grid-cols-2 gap-px bg-zinc-100 text-xs dark:bg-zinc-800 sm:grid-cols-3 lg:grid-cols-6">
                {[
                  ['Interns', String(w.totals.interns)],
                  ['Paid hours', w.totals.hoursPaid.toFixed(2)],
                  ['Pay', formatInternPHP(w.totals.payPhp)],
                  ['PAB', formatInternPHP(w.totals.pabPhp)],
                  ['To the orphanage', formatInternPHP(w.totals.orphanagePhp)],
                  ['To the interns', formatInternPHP(w.totals.internPhp)],
                ].map(([k, v]) => (
                  <div key={k} className="bg-white px-4 py-2.5 dark:bg-zinc-950">
                    <div className="text-[10px] uppercase tracking-wider text-zinc-400">{k}</div>
                    <div className="mt-0.5 font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">{v}</div>
                  </div>
                ))}
              </div>

              <div className="overflow-x-auto">
                <table className="w-full min-w-[820px] text-xs">
                  <thead className="bg-zinc-50 text-[10px] uppercase tracking-wider text-zinc-500 dark:bg-zinc-900/60">
                    <tr>
                      <th className="px-4 py-2 text-left">Intern</th>
                      <th className="px-2 py-2 text-right">Paid h</th>
                      <th className="px-2 py-2 text-right">Rate</th>
                      <th className="px-2 py-2 text-right">Pay</th>
                      <th className="px-2 py-2 text-right">PAB</th>
                      <th className="px-2 py-2 text-right">Gross</th>
                      <th className="px-2 py-2 text-right">Orphanage</th>
                      <th className="px-2 py-2 text-right">Intern</th>
                      <th className="px-4 py-2 text-left">Dispatch</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                    {w.rows.map((r) => (
                      <tr key={r.id} className={cn(r.reconcile.status !== 'ok' && 'bg-rose-50/60 dark:bg-rose-950/20')}>
                        <td className="px-4 py-2">
                          <div className="font-semibold text-zinc-900 dark:text-zinc-100">{r.intern_name}</div>
                          <div className="font-mono text-[10px] text-zinc-400">{r.intern_email}</div>
                          {r.reconcile.status !== 'ok' && (
                            <div className="mt-0.5 flex items-center gap-1 text-[10px] font-semibold text-rose-700 dark:text-rose-300">
                              <AlertTriangle className="h-3 w-3" /> {r.reconcile.message}
                            </div>
                          )}
                        </td>
                        <td className="px-2 py-2 text-right font-mono tabular-nums">{r.hours_paid.toFixed(2)}</td>
                        <td className="px-2 py-2 text-right font-mono tabular-nums">{formatInternPHP(r.rate_php)}</td>
                        <td className="px-2 py-2 text-right font-mono tabular-nums">{formatInternPHP(r.pay_php)}</td>
                        <td className="px-2 py-2 text-right font-mono tabular-nums">{formatInternPHP(r.pab_php)}</td>
                        <td className="px-2 py-2 text-right font-mono font-semibold tabular-nums">{formatInternPHP(r.gross_php)}</td>
                        <td className="px-2 py-2 text-right font-mono tabular-nums">{formatInternPHP(r.orphanage_share_php)}</td>
                        <td className="px-2 py-2 text-right font-mono tabular-nums">{formatInternPHP(r.intern_share_php)}</td>
                        <td className="px-4 py-2">
                          {r.status !== 'accepted' ? (
                            <span className="text-zinc-400">—</span>
                          ) : r.dispatch?.paid ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300"><CheckCircle2 className="h-3 w-3" /> Paid</span>
                          ) : r.dispatch?.problem ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-rose-700 dark:bg-rose-900/30 dark:text-rose-300"><AlertTriangle className="h-3 w-3" /> Problem</span>
                          ) : (
                            <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-700 dark:bg-amber-900/30 dark:text-amber-300"><Clock className="h-3 w-3" /> Pending</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ))}
        </div>
      )}

      {/* Decision dialog — the PabDecisionConfirmDialog vocabulary. */}
      <Dialog open={decision !== null} onOpenChange={(o) => { if (!o && !busy) setDecision(null); }}>
        <DialogContent showCloseButton={!busy} className="sm:max-w-[460px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-lg">
              {decision?.kind === 'accepted' ? <Check className="h-5 w-5 text-emerald-500" /> : decision?.kind === 'rejected' ? <Undo2 className="h-5 w-5 text-rose-500" /> : <RotateCcw className="h-5 w-5 text-amber-500" />}
              {decision?.kind === 'accepted' ? 'Accept this week?' : decision?.kind === 'rejected' ? 'Send this week back?' : 'Reopen this week?'}
            </DialogTitle>
            <DialogDescription className="text-xs leading-relaxed">
              {decision && (
                <>
                  {weekLabel(decision.week.weekStart, decision.week.weekEnd)} · {decision.week.totals.interns} intern{decision.week.totals.interns === 1 ? '' : 's'} ·{' '}
                  {formatInternPHP(decision.week.totals.grossPhp)} gross.{' '}
                  {decision.kind === 'accepted' && 'Every row becomes a pending item in Payment Dispatch → Orphanage, paid to the bank on each intern profile.'}
                  {decision.kind === 'rejected' && 'The Orphanage Manager sees your note and can fix and lock in again. A note is required.'}
                  {decision.kind === 'reopen' && 'Goes back to the Orphanage Manager as submitted. Refused if any row has already been paid.'}
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          {decision?.kind === 'rejected' && (
            <div>
              <Label htmlFor="in-reject-note" className="text-xs">What needs fixing</Label>
              <textarea
                id="in-reject-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
                className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-950"
                placeholder="e.g. Maria's Tuesday hours look doubled — please re-export"
              />
            </div>
          )}
          <DialogFooter className="mt-3 gap-2">
            <Button variant="outline" onClick={() => setDecision(null)} disabled={busy}>Cancel</Button>
            <Button
              onClick={decide}
              disabled={busy || (decision?.kind === 'rejected' && !note.trim())}
              className={cn(
                'gap-2 text-white',
                decision?.kind === 'accepted' ? 'bg-emerald-600 hover:bg-emerald-700' : decision?.kind === 'rejected' ? 'bg-rose-600 hover:bg-rose-700' : 'bg-amber-600 hover:bg-amber-700',
              )}
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : decision?.kind === 'accepted' ? <Check className="h-4 w-4" /> : decision?.kind === 'rejected' ? <X className="h-4 w-4" /> : <RotateCcw className="h-4 w-4" />}
              {decision?.kind === 'accepted' ? 'Accept week' : decision?.kind === 'rejected' ? 'Send back' : 'Reopen week'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Setup — the interns' one setting. */}
      <Dialog open={setupOpen} onOpenChange={(o) => { if (!busy) setSetupOpen(o); }}>
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-lg"><Settings2 className="h-5 w-5 text-violet-500" /> Interns setup</DialogTitle>
            <DialogDescription className="text-xs leading-relaxed">
              Until the share mode is set, the Orphanage Manager cannot lock in a week — a default would move money nobody decided on.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">How the orphanage&apos;s share is paid <span className="normal-case tracking-normal">· Ellie / Ralph</span></div>
            {(
              [
                ['system_split', 'HRIS splits it', 'Two pending items per intern week: the intern share to the intern’s bank, the orphanage share to the orphanage’s bank (from the Orphanage directory).'],
                ['intern_remits', 'Intern remits it', 'One pending item for the full gross to the intern’s bank. The orphanage share is recorded as owed by the intern, not dispatched.'],
              ] as Array<[InternShareMode, string, string]>
            ).map(([mode, title, desc]) => (
              <label
                key={mode}
                className={cn(
                  'flex cursor-pointer items-start gap-3 rounded-xl border p-3 text-xs transition-colors',
                  config?.shareMode === mode ? 'border-violet-400 bg-violet-50/60 dark:border-violet-700 dark:bg-violet-950/20' : 'border-zinc-200 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900/60',
                  !canEdit && 'cursor-not-allowed opacity-60',
                )}
              >
                <input type="radio" name="shareMode" className="mt-0.5 accent-violet-600" disabled={!canEdit || busy} checked={config?.shareMode === mode} onChange={() => saveConfig(mode)} />
                <span>
                  <span className="block font-semibold text-zinc-900 dark:text-zinc-100">{title}</span>
                  <span className="block text-zinc-500 dark:text-zinc-400">{desc}</span>
                </span>
              </label>
            ))}
            {canEdit && config?.shareMode && (
              <button type="button" onClick={() => saveConfig(null)} disabled={busy} className="self-start text-[11px] text-zinc-500 underline underline-offset-2 hover:text-zinc-800 dark:hover:text-zinc-200">
                Clear (blocks lock-in again)
              </button>
            )}
            <div className="mt-2 rounded-xl border border-zinc-200 bg-zinc-50/60 p-3 text-xs dark:border-zinc-800 dark:bg-zinc-900/40">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">PAB rule <span className="normal-case tracking-normal">· fixed, Ralph 2026-09-02</span></div>
              <p className="mt-1 text-zinc-700 dark:text-zinc-300">
                ₱1,000 when every Sunday–Saturday week of the PAB period reaches {INTERN_PAB_MIN_WEEKLY_HOURS} paid hours. Same pay cycle and PAB period as Simple; paid on the payout week only. No Tech Bonus.
              </p>
            </div>
          </div>
          <DialogFooter className="mt-2">
            <Button variant="outline" onClick={() => setSetupOpen(false)} disabled={busy}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
