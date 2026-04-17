'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarHeart, Loader2, RefreshCw } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { normEmail } from '@/lib/email/norm-email';
import type { PabDayDisputeRow } from '@/lib/supabase/pab-day-disputes';

interface Props {
  employeeEmail: string;
}

function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, (m ?? 1) - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

export default function EmployeeOrphanageVisits({ employeeEmail }: Props) {
  const [visits, setVisits] = useState<PabDayDisputeRow[]>([]);
  const [loading, setLoading] = useState(true);

  const normalizedEmail = useMemo(
    () => normEmail(employeeEmail) ?? employeeEmail.trim().toLowerCase(),
    [employeeEmail],
  );

  const fetchVisits = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/pab-disputes/orphanage-visits', { cache: 'no-store' });
      const json = await res.json();
      const rows = (json.rows ?? []) as PabDayDisputeRow[];
      const mine = rows.filter(r => {
        const rowEmail = normEmail(r.work_email ?? '') ?? (r.work_email ?? '').toLowerCase();
        return rowEmail === normalizedEmail;
      });
      setVisits(mine);
    } catch {
      setVisits([]);
    } finally {
      setLoading(false);
    }
  }, [normalizedEmail]);

  useEffect(() => { fetchVisits(); }, [fetchVisits]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-hidden bg-gradient-to-br from-white via-orange-50/30 to-blue-50/20 p-4 sm:p-5 dark:bg-none dark:bg-[#0d1117]">
      <div className="flex shrink-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-xl font-bold tracking-tight text-zinc-900 sm:text-2xl dark:text-white">
            <CalendarHeart className="h-5 w-5 text-rose-500" />
            My Orphanage Visits
          </h2>
          <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
            Visit dates recorded by HR. The PAB 7-hour floor drops to 4 hours on the visit day and the day after.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={fetchVisits} disabled={loading} className="shrink-0">
          <RefreshCw className={cn('mr-1.5 h-3.5 w-3.5', loading && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      {loading ? (
        <div className="flex flex-1 items-center justify-center gap-2 py-8 text-sm text-zinc-500">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading visits…
        </div>
      ) : visits.length === 0 ? (
        <Card className="border-zinc-200 dark:border-zinc-800">
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
            <CalendarHeart className="h-8 w-8 text-zinc-300 dark:text-zinc-700" />
            <p className="text-sm text-zinc-500">No orphanage visits recorded for you yet.</p>
            <p className="text-[11px] text-zinc-400">
              If you visited an orphanage, ask HR to record the date here so PAB is preserved.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto rounded-md border border-zinc-200 dark:border-zinc-800">
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-gradient-to-r from-orange-50/95 to-blue-50/60 backdrop-blur-sm dark:from-blue-950/90 dark:to-blue-950/70">
              <TableRow className="border-zinc-200 hover:bg-transparent dark:border-zinc-800">
                <TableHead className="text-zinc-600 dark:text-zinc-400">Visit date</TableHead>
                <TableHead className="text-zinc-600 dark:text-zinc-400">PAB forgiven on</TableHead>
                <TableHead className="text-zinc-600 dark:text-zinc-400">Note</TableHead>
                <TableHead className="text-zinc-600 dark:text-zinc-400">Recorded by</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visits.map(v => (
                <TableRow key={v.id} className="border-zinc-200 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900/40">
                  <TableCell className="whitespace-nowrap text-sm font-medium text-zinc-800 dark:text-zinc-200">{v.dispute_date}</TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-zinc-600 dark:text-zinc-400">
                    {v.dispute_date} &amp; {addDaysIso(v.dispute_date, 1)}
                  </TableCell>
                  <TableCell className="max-w-[280px] truncate text-xs text-zinc-600 dark:text-zinc-400" title={v.decision_note ?? ''}>
                    {v.decision_note || '—'}
                  </TableCell>
                  <TableCell className="text-xs text-zinc-500 dark:text-zinc-400">{v.decided_by ?? '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
