'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { signOut } from 'next-auth/react';
import {
  CheckCircle2,
  HeartHandshake,
  Loader2,
  LogOut,
  RefreshCw,
  Search,
  XCircle,
} from 'lucide-react';
import { toast, Toaster } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import ViewSwitcher from '@/components/rbac/ViewSwitcher';
import { SESSION_EMAIL_KEY } from '@/lib/rbac/views';
import { normEmail } from '@/lib/email/norm-email';
import type { PabDayDisputeRow } from '@/lib/supabase/pab-day-disputes';

function isPlausibleEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

function formatVerifiedAt(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

export default function OrphanageApp() {
  const searchParams = useSearchParams();
  const emailFromQuery = searchParams.get('email');
  const [viewerEmail, setViewerEmail] = useState<string | null>(null);
  const [rows, setRows] = useState<PabDayDisputeRow[]>([]);
  const [verifiedRows, setVerifiedRows] = useState<PabDayDisputeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [verifiedSearch, setVerifiedSearch] = useState('');
  const [actingId, setActingId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ row: PabDayDisputeRow; action: 'approve' | 'deny' } | null>(null);
  const [decisionNote, setDecisionNote] = useState('');

  useEffect(() => {
    try {
      const q = emailFromQuery?.trim() ?? '';
      if (q && isPlausibleEmail(q)) {
        const normalized = normEmail(q) ?? q.toLowerCase();
        sessionStorage.setItem(SESSION_EMAIL_KEY, normalized);
        setViewerEmail(normalized);
        return;
      }
      setViewerEmail(sessionStorage.getItem(SESSION_EMAIL_KEY));
    } catch {
      setViewerEmail(null);
    }
  }, [emailFromQuery]);

  const fetchRows = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/orphanage-disputes', { cache: 'no-store' });
      const json = (await res.json()) as {
        pending?: PabDayDisputeRow[];
        verified?: PabDayDisputeRow[];
        error?: string;
      };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Failed to load queue');
      setRows(json.pending ?? []);
      setVerifiedRows(json.verified ?? []);
    } catch (e) {
      setRows([]);
      setVerifiedRows([]);
      toast.error(e instanceof Error ? e.message : 'Could not load orphanage queue');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchRows();
  }, [fetchRows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((row) =>
      [row.work_email, row.dispute_date, row.explanation ?? '', row.created_by ?? '', row.decision_note ?? '']
        .join(' ')
        .toLowerCase()
        .includes(q),
    );
  }, [rows, search]);

  const filteredVerified = useMemo(() => {
    const q = verifiedSearch.trim().toLowerCase();
    if (!q) return verifiedRows;
    return verifiedRows.filter((row) =>
      [
        row.work_email,
        row.dispute_date,
        row.explanation ?? '',
        row.decided_by ?? '',
        row.decision_note ?? '',
      ]
        .join(' ')
        .toLowerCase()
        .includes(q),
    );
  }, [verifiedRows, verifiedSearch]);

  const runDecide = useCallback(async () => {
    if (!confirm || !viewerEmail) return;
    const row = confirm.row;
    const action = confirm.action;
    const noteTrimmed = decisionNote.trim() || null;
    setActingId(row.id);
    setConfirm(null);
    setDecisionNote('');
    try {
      const res = await fetch(`/api/pab-disputes/${row.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: action === 'approve' ? 'orphanage_manager_approve' : 'orphanage_manager_deny',
          decided_by: viewerEmail,
          decision_note: noteTrimmed,
        }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Failed');
      if (action === 'approve') {
        toast.success('Verified — sent to Accounting for final payroll approval.', {
          description: `Logged under ${viewerEmail} · ${formatVerifiedAt(new Date().toISOString())}`,
        });
      } else {
        toast.success('Dispute denied.');
      }
      await fetchRows();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not update dispute');
    } finally {
      setActingId(null);
    }
  }, [confirm, viewerEmail, decisionNote, fetchRows]);

  return (
    <div className="flex h-dvh max-h-dvh overflow-hidden bg-white text-zinc-900 dark:bg-[#0d1117] dark:text-zinc-100">
      <aside className="flex w-64 shrink-0 flex-col border-r border-pink-100 bg-gradient-to-b from-white to-pink-50/50 p-5 dark:border-pink-950/50 dark:from-[#0d1117] dark:to-pink-950/10">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-pink-500 text-white">
            <HeartHandshake className="h-5 w-5" />
          </div>
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-pink-600 dark:text-pink-400">
              Orphanage
            </p>
            <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Manager review</p>
          </div>
        </div>

        <nav className="space-y-1">
          <button className="flex w-full items-center gap-3 rounded-md bg-pink-100 px-3 py-2 text-sm font-medium text-pink-900 dark:bg-pink-950/40 dark:text-pink-100">
            <HeartHandshake className="h-4 w-4" />
            Dispute queue
          </button>
        </nav>

        <div className="mt-auto border-t border-pink-100 pt-4 dark:border-pink-950/50">
          <ViewSwitcher email={viewerEmail} currentView="orphanage" />
          <div className="mb-3 rounded-md border border-pink-100 bg-white/70 px-3 py-2 dark:border-pink-950/50 dark:bg-pink-950/10">
            <p className="truncate text-xs font-medium text-zinc-900 dark:text-zinc-100">{viewerEmail ?? 'Not signed in'}</p>
            <p className="text-[11px] text-zinc-500 dark:text-zinc-400">Orphanage Manager</p>
          </div>
          <Button
            variant="ghost"
            className="w-full justify-start gap-2 text-zinc-600 hover:bg-rose-500/10 hover:text-rose-600 dark:text-zinc-400"
            onClick={() => {
              try { sessionStorage.removeItem(SESSION_EMAIL_KEY); } catch { /* ignore */ }
              void signOut({ callbackUrl: '/login' });
            }}
          >
            <LogOut className="h-4 w-4" />
            Sign Out
          </Button>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex shrink-0 items-center justify-between border-b border-pink-100 bg-white/95 px-5 py-4 dark:border-pink-950/50 dark:bg-[#0d1117]/95">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Orphanage dispute queue</h1>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Verify visits with one click — hub hours stay as logged; optional note appears on the receipt log.
              Accounting gives final payroll forgiveness.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={fetchRows} disabled={loading}>
            <RefreshCw className={loading ? 'mr-1.5 h-3.5 w-3.5 animate-spin' : 'mr-1.5 h-3.5 w-3.5'} />
            Refresh
          </Button>
        </header>

        <section className="flex min-h-0 flex-1 flex-col gap-8 overflow-auto p-5">
          <div className="flex min-h-0 flex-col gap-4">
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Awaiting your review</h2>
            <div className="relative max-w-md">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search email, date, or note..."
                className="pl-9"
              />
            </div>

            {loading ? (
              <div className="flex flex-1 items-center justify-center gap-2 py-16 text-sm text-zinc-500">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading queue...
              </div>
            ) : filtered.length === 0 ? (
              <div className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-zinc-200 py-16 text-sm text-zinc-500 dark:border-zinc-800">
                No orphanage disputes awaiting manager review.
              </div>
            ) : (
              <div className="overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800">
                <table className="w-full text-left text-sm">
                  <thead className="sticky top-0 bg-zinc-50 text-xs text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                    <tr>
                      <th className="px-4 py-3 font-medium">Employee</th>
                      <th className="px-4 py-3 font-medium">Date</th>
                      <th className="px-4 py-3 font-medium">Explanation</th>
                      <th className="px-4 py-3 font-medium">Status</th>
                      <th className="px-4 py-3 text-right font-medium">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                    {filtered.map((row) => (
                      <tr key={row.id} className="align-top">
                        <td className="px-4 py-3 font-mono text-xs">{row.work_email}</td>
                        <td className="whitespace-nowrap px-4 py-3">{row.dispute_date}</td>
                        <td className="max-w-md px-4 py-3 text-xs text-zinc-600 dark:text-zinc-400">
                          <p>{row.explanation || 'No explanation provided'}</p>
                          {row.decision_note ? (
                            <p className="mt-2 rounded-md border border-amber-200/80 bg-amber-50/90 px-2 py-1.5 text-[11px] text-amber-900 dark:border-amber-800/60 dark:bg-amber-950/35 dark:text-amber-200">
                              <span className="font-semibold text-amber-800 dark:text-amber-300">Accounting: </span>
                              {row.decision_note}
                            </p>
                          ) : null}
                        </td>
                        <td className="px-4 py-3">
                          <Badge variant="outline" className="border-amber-300 bg-amber-50 text-[10px] text-amber-700 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-300">
                            Manager review
                          </Badge>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex justify-end gap-2">
                            <Button
                              size="sm"
                              className="h-8 bg-emerald-600 text-xs hover:bg-emerald-700"
                              disabled={actingId === row.id}
                              onClick={() => {
                                setDecisionNote('');
                                setConfirm({ row, action: 'approve' });
                              }}
                            >
                              <CheckCircle2 className="mr-1 h-3.5 w-3.5" />
                              Approve
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-8 border-rose-300 text-xs text-rose-700 hover:bg-rose-50 dark:border-rose-800 dark:text-rose-300"
                              disabled={actingId === row.id}
                              onClick={() => {
                                setDecisionNote('');
                                setConfirm({ row, action: 'deny' });
                              }}
                            >
                              <XCircle className="mr-1 h-3.5 w-3.5" />
                              Deny
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="flex min-h-0 shrink-0 flex-col gap-3 border-t border-pink-100 pt-6 dark:border-pink-950/50">
            <div>
              <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Receipt log — verified for Accounting</h2>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                Orphanage manager approvals with who verified, when, and any note. Rows disappear here after Accounting
                issues a final decision.
              </p>
            </div>
            <div className="relative max-w-md">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
              <Input
                value={verifiedSearch}
                onChange={(e) => setVerifiedSearch(e.target.value)}
                placeholder="Search verified rows..."
                className="pl-9"
                disabled={loading}
              />
            </div>
            {loading ? null : filteredVerified.length === 0 ? (
              <p className="rounded-lg border border-dashed border-zinc-200 py-8 text-center text-sm text-zinc-500 dark:border-zinc-800">
                No verified disputes in this log yet.
              </p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
                <table className="w-full min-w-[640px] text-left text-sm">
                  <thead className="bg-zinc-50 text-xs text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                    <tr>
                      <th className="px-4 py-3 font-medium">Employee</th>
                      <th className="px-4 py-3 font-medium">Visit date</th>
                      <th className="px-4 py-3 font-medium">Verified by</th>
                      <th className="px-4 py-3 font-medium">Verified at</th>
                      <th className="px-4 py-3 font-medium">Note</th>
                      <th className="px-4 py-3 font-medium">Routing</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                    {filteredVerified.map((row) => (
                      <tr key={row.id} className="align-top">
                        <td className="px-4 py-3 font-mono text-xs">{row.work_email}</td>
                        <td className="whitespace-nowrap px-4 py-3">{row.dispute_date}</td>
                        <td className="px-4 py-3 text-xs text-zinc-700 dark:text-zinc-300">{row.decided_by ?? '—'}</td>
                        <td className="whitespace-nowrap px-4 py-3 text-xs text-zinc-600 dark:text-zinc-400">
                          {formatVerifiedAt(row.decided_at)}
                        </td>
                        <td className="max-w-[220px] px-4 py-3 text-xs text-zinc-600 dark:text-zinc-400">
                          {row.decision_note || '—'}
                        </td>
                        <td className="px-4 py-3">
                          <Badge variant="outline" className="border-sky-300 bg-sky-50 text-[10px] text-sky-800 dark:border-sky-700 dark:bg-sky-950/40 dark:text-sky-200">
                            With Accounting
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>
      </main>
      <Toaster position="top-right" />

      <Dialog
        open={!!confirm}
        onOpenChange={(o) => {
          if (!o) {
            setConfirm(null);
            setDecisionNote('');
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-sm">
              {confirm?.action === 'deny' ? 'Deny orphanage dispute?' : 'Verify for Accounting?'}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {confirm && (
                <>
                  {confirm.row.work_email} · {confirm.row.dispute_date}
                  <br />
                  No hour changes — PAB still uses Hubstaff time with orphanage rules after Accounting approves.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label className="text-xs">Optional note (appears in the receipt log)</Label>
            <textarea
              value={decisionNote}
              onChange={(e) => setDecisionNote(e.target.value)}
              rows={3}
              placeholder="e.g. Confirmed with team lead, visit day matches schedule."
              className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
            />
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setConfirm(null);
                setDecisionNote('');
              }}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              className={
                confirm?.action === 'deny'
                  ? 'bg-rose-600 hover:bg-rose-700'
                  : 'bg-emerald-600 hover:bg-emerald-700'
              }
              onClick={() => void runDecide()}
            >
              {confirm?.action === 'deny' ? 'Deny' : 'Verify & send to Accounting'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
