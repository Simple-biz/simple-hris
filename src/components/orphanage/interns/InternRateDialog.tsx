'use client';

import { useEffect, useState } from 'react';
import { CalendarClock, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { formatInternPHP, type OrphanageInternListItem, type OrphanageInternRateRow } from '@/lib/interns/intern-types';

/**
 * "Change rate…" — APPENDS a dated rate. History is shown and never edited: a
 * rate is a fact about a day, and every week prices with the rate in force on
 * each of its days (memory: rate-updated-at-not-evidence).
 */
export default function InternRateDialog({
  intern,
  onClose,
  onSaved,
}: {
  intern: OrphanageInternListItem | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [history, setHistory] = useState<OrphanageInternRateRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [ratePhp, setRatePhp] = useState('');
  const [from, setFrom] = useState('');

  useEffect(() => {
    if (!intern) return;
    setRatePhp(intern.current_rate_php != null ? String(intern.current_rate_php) : '');
    setFrom(new Date().toISOString().slice(0, 10));
    setLoading(true);
    void (async () => {
      try {
        const res = await fetch(`/api/orphanage-interns/${intern.id}?_=${Date.now()}`, { cache: 'no-store' });
        const json = (await res.json()) as { rates?: OrphanageInternRateRow[]; error?: string | null };
        if (!res.ok || json.error) throw new Error(json.error ?? 'Could not load rate history');
        setHistory(json.rates ?? []);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Could not load rate history');
      } finally {
        setLoading(false);
      }
    })();
  }, [intern]);

  const valid = Number(ratePhp) > 0 && /^\d{4}-\d{2}-\d{2}$/.test(from);

  const save = async () => {
    if (!intern || !valid || saving) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/orphanage-interns/${intern.id}/rates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rate_php: Number(ratePhp), effective_from: from }),
      });
      const json = (await res.json()) as { error?: string | null };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Could not add rate');
      toast.success(`${intern.full_name}: ${formatInternPHP(Number(ratePhp))}/h from ${from}`);
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not add rate');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={!!intern} onOpenChange={(o) => !saving && !o && onClose()}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg">
            <CalendarClock className="h-5 w-5 text-pink-500" />
            Change {intern?.full_name.split(' ')[0] ?? 'the'} rate
          </DialogTitle>
          <DialogDescription className="text-xs leading-relaxed">
            Adds a new rate from a date. Weeks before that date keep pricing at the old rate; history is never rewritten.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="rt-rate" className="text-xs">New hourly rate (₱)</Label>
            <Input id="rt-rate" type="number" min={1} step="0.01" value={ratePhp} onChange={(e) => setRatePhp(e.target.value)} className="font-mono" />
          </div>
          <div>
            <Label htmlFor="rt-from" className="text-xs">Effective from</Label>
            <Input id="rt-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
        </div>

        <div className="mt-2">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">History</div>
          {loading ? (
            <div className="flex items-center gap-2 py-3 text-xs text-zinc-500"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…</div>
          ) : history.length === 0 ? (
            <p className="py-2 text-xs text-amber-600 dark:text-amber-400">No rate on file yet — the wizard refuses to price this intern until one exists.</p>
          ) : (
            <ul className="mt-1 max-h-40 divide-y divide-zinc-100 overflow-y-auto rounded-lg border border-zinc-200 text-xs dark:divide-zinc-800 dark:border-zinc-800">
              {history.map((h) => (
                <li key={h.id} className="flex items-center justify-between px-3 py-1.5">
                  <span className="font-mono tabular-nums text-zinc-900 dark:text-zinc-100">{formatInternPHP(h.rate_php)}/h</span>
                  <span className="text-zinc-500">from {h.effective_from}{h.set_by ? ` · ${h.set_by}` : ''}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <DialogFooter className="mt-2 gap-2">
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={save} disabled={!valid || saving} className="gap-2 bg-pink-600 text-white hover:bg-pink-700">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CalendarClock className="h-4 w-4" />}
            Add rate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
