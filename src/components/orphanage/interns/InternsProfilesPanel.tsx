'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  Banknote,
  CalendarClock,
  GraduationCap,
  Loader2,
  Mail,
  Pencil,
  Phone,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  UserMinus,
  UserPlus,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import InternDialog from './InternDialog';
import InternRateDialog from './InternRateDialog';
import { formatInternPHP, type OrphanageInternListItem } from '@/lib/interns/intern-types';

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

/**
 * The Profiles pane. Copy of ThirdPartyVendorsPanel's shape: cards + dialogs +
 * Refresh, pink accent. This pane is the ONLY writer of intern personal data,
 * bank details and rates — every other surface reads.
 */
export default function InternsProfilesPanel({ viewerEmail, canEdit }: { viewerEmail: string | null; canEdit: boolean }) {
  const [items, setItems] = useState<OrphanageInternListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showEnded, setShowEnded] = useState(false);
  const [search, setSearch] = useState('');

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [rateTarget, setRateTarget] = useState<OrphanageInternListItem | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/orphanage-interns?includeEnded=1&_=${Date.now()}`, { cache: 'no-store' });
      const json = (await res.json()) as { items?: OrphanageInternListItem[]; error?: string | null };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Failed to load interns');
      setItems(json.items ?? []);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Could not load interns';
      if (opts?.silent) toast.error(msg);
      else setError(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items
      .filter((i) => showEnded || i.status === 'active')
      .filter((i) => !q || i.full_name.toLowerCase().includes(q) || i.email.toLowerCase().includes(q));
  }, [items, showEnded, search]);
  const activeCount = items.filter((i) => i.status === 'active').length;

  const setStatus = async (item: OrphanageInternListItem, status: 'active' | 'ended') => {
    setBusyId(item.id);
    try {
      const today = new Date().toISOString().slice(0, 10);
      const res = await fetch(`/api/orphanage-interns/${item.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(status === 'ended' ? { status, ended_on: today } : { status, ended_on: null }),
      });
      const json = (await res.json()) as { error?: string | null };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Update failed');
      toast.success(status === 'ended' ? `${item.full_name}'s internship ended` : `${item.full_name} reactivated`);
      await load({ silent: true });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not update');
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (item: OrphanageInternListItem) => {
    if (!window.confirm(`Remove ${item.full_name}'s profile? This is refused once they have a locked week — use "End internship" then.`)) return;
    setBusyId(item.id);
    try {
      const res = await fetch(`/api/orphanage-interns/${item.id}`, { method: 'DELETE' });
      const json = (await res.json()) as { error?: string | null };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Delete failed');
      toast.success(`Removed ${item.full_name}`);
      setItems((prev) => prev.filter((i) => i.id !== item.id));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not remove');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 p-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
          <Input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name or email" className="h-8 pl-8 text-xs" />
        </div>
        <label className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">
          <input type="checkbox" checked={showEnded} onChange={(e) => setShowEnded(e.target.checked)} className="h-3.5 w-3.5 accent-pink-600" />
          Show ended
        </label>
        <span className="text-xs text-zinc-500 dark:text-zinc-400">
          {activeCount} active{items.length !== activeCount ? ` · ${items.length - activeCount} ended` : ''}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => load()} className="h-8 gap-1.5 text-xs">
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} /> Refresh
          </Button>
          {canEdit && (
            <Button size="sm" onClick={() => { setEditingId(null); setDialogOpen(true); }} className="h-8 gap-1.5 bg-pink-600 text-xs text-white hover:bg-pink-700">
              <Plus className="h-3.5 w-3.5" /> Add intern
            </Button>
          )}
        </div>
      </div>

      {loading ? (
        <div className="flex flex-1 items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-pink-500" />
        </div>
      ) : error ? (
        <div className="rounded-xl border border-rose-200 bg-rose-50/60 px-4 py-6 text-center text-xs text-rose-700 dark:border-rose-900/40 dark:bg-rose-950/20 dark:text-rose-300">
          {error}
        </div>
      ) : visible.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-pink-200 bg-pink-50/40 px-6 py-14 text-center dark:border-pink-900/40 dark:bg-pink-950/10">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-pink-500 to-rose-600 text-white shadow-lg shadow-pink-500/30">
            <GraduationCap className="h-6 w-6" />
          </div>
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            {items.length === 0 ? 'No interns yet' : 'No interns match'}
          </h2>
          <p className="max-w-sm text-xs text-zinc-500 dark:text-zinc-400">
            Interns appear in the Pay week wizard only after they have a profile here — an @pathway.ph email, a rate with its effective date, and bank details.
          </p>
          {canEdit && items.length === 0 && (
            <Button size="sm" onClick={() => { setEditingId(null); setDialogOpen(true); }} className="mt-1 h-8 gap-1.5 bg-pink-600 text-xs text-white hover:bg-pink-700">
              <Plus className="h-3.5 w-3.5" /> Add the first intern
            </Button>
          )}
        </div>
      ) : (
        <AnimatePresence mode="popLayout">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {visible.map((i) => {
              const ended = i.status === 'ended';
              const busy = busyId === i.id;
              return (
                <motion.div
                  key={i.id}
                  layout
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.97 }}
                  className={cn(
                    'flex flex-col gap-3 rounded-2xl border bg-white p-4 shadow-sm dark:bg-zinc-950',
                    ended ? 'border-zinc-200 opacity-70 dark:border-zinc-800' : 'border-pink-100/80 dark:border-pink-900/40',
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">{i.full_name}</span>
                        <span
                          className={cn(
                            'rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider',
                            ended
                              ? 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300'
                              : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300',
                          )}
                        >
                          {ended ? 'Ended' : 'Active'}
                        </span>
                      </div>
                      <div className="mt-1 flex items-center gap-1 font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
                        <Mail className="h-3 w-3 shrink-0" /> {i.email}
                      </div>
                      {i.phone && (
                        <div className="mt-0.5 flex items-center gap-1 font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
                          <Phone className="h-3 w-3 shrink-0" /> {i.phone}
                        </div>
                      )}
                    </div>
                    {canEdit && (
                      <button
                        type="button"
                        onClick={() => { setEditingId(i.id); setDialogOpen(true); }}
                        title="Edit profile"
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-zinc-200 text-zinc-500 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>

                  <div className="grid grid-cols-2 gap-2 text-[11px]">
                    <div className="rounded-lg bg-zinc-50 px-2.5 py-2 dark:bg-zinc-900/60">
                      <div className="text-[10px] uppercase tracking-wider text-zinc-400">Rate</div>
                      <div className="mt-0.5 font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
                        {i.current_rate_php == null ? <span className="text-amber-600 dark:text-amber-400">No rate set</span> : `${formatInternPHP(i.current_rate_php)}/h`}
                      </div>
                      {i.current_rate_effective_from && (
                        <div className="text-[10px] text-zinc-400">since {formatDate(i.current_rate_effective_from)}</div>
                      )}
                    </div>
                    <div className="rounded-lg bg-zinc-50 px-2.5 py-2 dark:bg-zinc-900/60">
                      <div className="text-[10px] uppercase tracking-wider text-zinc-400">Caps · PAB · share</div>
                      <div className="mt-0.5 font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
                        {i.daily_cap_hours}h/day · {i.weekly_cap_hours}h/wk
                      </div>
                      <div className="text-[10px] text-zinc-400">
                        PAB {formatInternPHP(i.pab_bonus_php)} · {i.orphanage_share_pct}% to orphanage
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 text-[11px] text-zinc-600 dark:text-zinc-400">
                    <Banknote className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
                    {i.bank_name || i.bank_account_last4 ? (
                      <span className="truncate">
                        {i.bank_name || 'Bank'} <span className="font-mono">{i.bank_account_last4 ?? ''}</span>
                        {i.bank_account_name ? ` · ${i.bank_account_name}` : ''}
                      </span>
                    ) : (
                      <span className="text-amber-600 dark:text-amber-400">No bank on file</span>
                    )}
                  </div>

                  {canEdit && (
                    <div className="mt-auto flex flex-wrap items-center gap-1.5 border-t border-zinc-100 pt-3 dark:border-zinc-800">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setRateTarget(i)}
                        className="flex h-7 items-center gap-1 rounded-md border border-pink-200 bg-white px-2 text-[11px] font-medium text-pink-700 hover:bg-pink-50 disabled:opacity-50 dark:border-pink-900/40 dark:bg-zinc-950 dark:text-pink-300 dark:hover:bg-pink-950/30"
                      >
                        <CalendarClock className="h-3 w-3" /> Change rate…
                      </button>
                      {ended ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => setStatus(i, 'active')}
                          className="flex h-7 items-center gap-1 rounded-md border border-emerald-200 bg-white px-2 text-[11px] font-medium text-emerald-700 hover:bg-emerald-50 disabled:opacity-50 dark:border-emerald-900/40 dark:bg-zinc-950 dark:text-emerald-300"
                        >
                          <UserPlus className="h-3 w-3" /> Reactivate
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => setStatus(i, 'ended')}
                          className="flex h-7 items-center gap-1 rounded-md border border-zinc-200 bg-white px-2 text-[11px] font-medium text-zinc-600 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400"
                        >
                          <UserMinus className="h-3 w-3" /> End internship
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => remove(i)}
                        title="Remove profile (refused once a week is locked)"
                        className="ml-auto flex h-7 items-center gap-1 rounded-md border border-rose-200 bg-white px-2 text-[11px] font-medium text-rose-600 hover:bg-rose-50 disabled:opacity-50 dark:border-rose-900/40 dark:bg-zinc-950 dark:text-rose-400"
                      >
                        {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                      </button>
                    </div>
                  )}
                </motion.div>
              );
            })}
          </div>
        </AnimatePresence>
      )}

      <InternDialog
        open={dialogOpen}
        editingId={editingId}
        viewerEmail={viewerEmail}
        onOpenChange={(o) => { setDialogOpen(o); if (!o) setEditingId(null); }}
        onSaved={() => { void load({ silent: true }); }}
      />
      <InternRateDialog
        intern={rateTarget}
        onClose={() => setRateTarget(null)}
        onSaved={() => { setRateTarget(null); void load({ silent: true }); }}
      />
    </div>
  );
}
