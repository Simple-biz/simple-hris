'use client';

/**
 * People → Offboarded — search-first tab over the WHOLE `offboarded_sheet`
 * ledger (GET /api/people/offboarded). Row grain on purpose: a recycled work
 * email returns EVERY record that ever carried it (they are different people;
 * the ledger row id is the identity), so the table can list three "jamesc@"
 * leavers side by side.
 *
 * Per row: Name / Work Email / Personal Email (+ Start Date & off date when
 * known), a bank chip ("Bank on file · <rail>" / "Prior bank on file" /
 * "No Bank"), a Pay action (files the same one-off `urgent_payment_requests`
 * flow the roster's Pay uses — the card lands in Payment Dispatch under the
 * person's processor bucket), and Set bank (the shared SetBankDialog →
 * POST /api/update-employee-ids).
 *
 * Recycled-email caution (Kane 2026-09-01, warn-and-allow): when a row's work
 * email belongs to someone on the ACTIVE roster today, an amber badge names
 * them — Pay prefills and bank edits on that email physically target the
 * current holder. The warning repeats inside PayDialog and SetBankDialog; it
 * never blocks.
 */

import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Banknote, Loader2, Search, UserX } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { TeamAvatar } from '@/components/team/team-ui';
import SetBankDialog from '@/components/accounting/SetBankDialog';
import { PROCESSOR_OPTIONS } from '@/lib/employee-payment-processors';
import { PEOPLE_TAB_SOURCE } from '@/lib/payroll/readiness-audit';
import { formatDeptLabel } from '@/lib/departments/hsl-subdept';
import { OFFBOARDED_SEARCH_MIN_QUERY } from '@/lib/people/offboarded-search';
import { cn } from '@/lib/utils';
import type { Accent } from './PeopleTab';

/** Client mirror of the route's OffboardedSearchRow. */
export interface OffboardedRow {
  id: string;
  name: string | null;
  workEmail: string | null;
  personalEmail: string | null;
  department: string | null;
  startDate: string | null;
  offBoardedAt: string | null;
  origin: 'hris' | 'google_sheet';
  bankStatus: 'ok' | 'missing' | 'missing_has_snapshot';
  bankProcessor: string | null;
  bankPrefill: {
    processor: string | null;
    walletEmail: string;
    walletName: string;
    bankName: string;
    accountHolder: string;
    accountNumber: string;
    swiftCode: string;
  } | null;
  activeHolder: string | null;
}

/** The person shape PayDialog needs — see PeopleTab's PayPerson. */
export interface OffboardedPayPerson {
  work_email: string | null;
  name: string | null;
  department: string | null;
  activeHolder?: string | null;
}

function processorLabel(id: string | null): string {
  if (!id) return '';
  return PROCESSOR_OPTIONS.find((p) => p.id === id)?.label ?? id;
}

function offDateLabel(iso: string | null): string {
  if (!iso) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[2]}/${m[3]}/${m[1].slice(2)}` : iso;
}

/** Amber recycled-email caution, shared by the row badge and both dialogs. */
export function ActiveHolderWarning({ holder, compact = false }: { holder: string; compact?: boolean }) {
  return (
    <p
      className={cn(
        'flex items-start gap-1.5 rounded-md border border-amber-300/70 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200',
        compact && 'px-1.5 py-1 text-[10px]',
      )}
      role="alert"
    >
      <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
      <span>
        This work email now belongs to <span className="font-semibold">{holder}</span> (active).
        Payments and bank edits on this email go to them.
      </span>
    </p>
  );
}

export default function PeopleOffboarded({
  accent,
  canPay,
  canEdit,
  onPay,
}: {
  accent: Accent;
  canPay: boolean;
  /** Gates Set bank (accounting-only — the CEO's People tab is read-only). */
  canEdit: boolean;
  onPay: (person: OffboardedPayPerson) => void;
}) {
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<OffboardedRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const [bankTarget, setBankTarget] = useState<OffboardedRow | null>(null);
  // Drops answers that arrive after a newer keystroke's request.
  const seqRef = useRef(0);

  const runSearch = async (q: string) => {
    const seq = ++seqRef.current;
    if (q.trim().length < OFFBOARDED_SEARCH_MIN_QUERY) {
      setRows([]);
      setTotal(0);
      setError(null);
      setLoading(false);
      setSearched(false);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`/api/people/offboarded?q=${encodeURIComponent(q)}`, { cache: 'no-store' });
      const json = (await res.json()) as { rows?: OffboardedRow[]; total?: number; error?: string };
      if (seq !== seqRef.current) return;
      if (!res.ok || json.error) throw new Error(json.error || `Search failed (${res.status})`);
      setRows(json.rows ?? []);
      setTotal(json.total ?? 0);
      setError(null);
      setSearched(true);
    } catch (e) {
      if (seq !== seqRef.current) return;
      setRows([]);
      setTotal(0);
      setError(e instanceof Error ? e.message : 'Search failed');
      setSearched(true);
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  };

  useEffect(() => {
    const t = setTimeout(() => void runSearch(query), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const bankChip = (r: OffboardedRow) => {
    if (r.bankStatus === 'ok') {
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
          <Banknote className="h-3 w-3" /> Bank on file{r.bankProcessor ? ` · ${processorLabel(r.bankProcessor)}` : ''}
        </span>
      );
    }
    if (r.bankStatus === 'missing_has_snapshot') {
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
          <Banknote className="h-3 w-3" /> Prior bank on file
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
        No Bank
      </span>
    );
  };

  return (
    <div>
      <div className="relative sm:max-w-md">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
        <Input
          type="search"
          autoFocus
          placeholder="Search offboarded people by name or work email…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className={cn('pl-9', accent.ring)}
          aria-label="Search offboarded people"
        />
      </div>

      {error && (
        <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
          {error}
        </div>
      )}

      {!searched && !loading && !error ? (
        <div className="mt-10 flex flex-col items-center gap-2 text-center text-zinc-400 dark:text-zinc-500">
          <UserX className="h-8 w-8" />
          <p className="text-sm">
            Search the offboarded ledger — every record ever kept, including people who
            shared a work email.
          </p>
          <p className="text-[11px]">Type at least {OFFBOARDED_SEARCH_MIN_QUERY} characters of a name or work email.</p>
        </div>
      ) : loading && rows.length === 0 ? (
        <div className="mt-10 flex items-center justify-center gap-2 text-sm text-zinc-400">
          <Loader2 className="h-4 w-4 animate-spin" /> Searching…
        </div>
      ) : searched && rows.length === 0 && !error ? (
        <div className="mt-10 text-center text-sm text-zinc-400 dark:text-zinc-500">
          No offboarded records match “{query.trim()}”.
        </div>
      ) : rows.length > 0 ? (
        <>
          <p className="mt-3 text-[12px] text-zinc-500 dark:text-zinc-400">
            {total > rows.length
              ? `Showing the first ${rows.length} of ${total} matching records — narrow the search to see the rest.`
              : `${rows.length} matching record${rows.length === 1 ? '' : 's'}.`}
          </p>
          <div className="mt-2 overflow-x-auto rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
            <table className="w-full min-w-[860px] text-left text-[13px]">
              <thead>
                <tr className="border-b border-zinc-200 text-[11px] uppercase tracking-wide text-zinc-500 dark:border-zinc-800">
                  <th className="px-3 py-2 font-medium">Name</th>
                  <th className="px-3 py-2 font-medium">Work Email</th>
                  <th className="px-3 py-2 font-medium">Personal Email</th>
                  <th className="px-3 py-2 font-medium">Start Date</th>
                  <th className="px-3 py-2 font-medium">Offboarded</th>
                  <th className="px-3 py-2 font-medium">Bank</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-zinc-100 last:border-0 dark:border-zinc-900">
                    <td className="px-3 py-2.5" data-label="Name">
                      <div className="flex items-center gap-2.5">
                        <TeamAvatar name={r.name ?? ''} email={r.workEmail} />
                        <div className="min-w-0">
                          <div className="truncate font-medium text-zinc-900 dark:text-zinc-100">{r.name ?? '—'}</div>
                          {r.department && (
                            <div className="truncate text-[11px] text-zinc-400" title={r.department}>
                              {formatDeptLabel(r.department) || r.department}
                            </div>
                          )}
                          {r.activeHolder && (
                            <div className="mt-1 max-w-xs">
                              <ActiveHolderWarning holder={r.activeHolder} compact />
                            </div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-zinc-600 dark:text-zinc-300" data-label="Work Email">
                      {r.workEmail ?? <span className="text-zinc-400">—</span>}
                    </td>
                    <td className="px-3 py-2.5 text-zinc-600 dark:text-zinc-300" data-label="Personal Email">
                      {r.personalEmail ?? <span className="text-zinc-400">—</span>}
                    </td>
                    <td className="px-3 py-2.5 tabular-nums text-zinc-500 dark:text-zinc-400" data-label="Start Date">
                      {r.startDate ?? '—'}
                    </td>
                    <td className="px-3 py-2.5 tabular-nums text-zinc-500 dark:text-zinc-400" data-label="Offboarded">
                      {offDateLabel(r.offBoardedAt)}
                    </td>
                    <td className="px-3 py-2.5" data-label="Bank">
                      {bankChip(r)}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        {canPay && (
                          <Button
                            type="button"
                            size="sm"
                            className={cn('h-7 gap-1 px-2 text-[12px]', accent.btn)}
                            disabled={!r.workEmail}
                            title={r.workEmail ? 'Send a one-off payment' : 'No work email on file — one-off payments key on the work email'}
                            onClick={() =>
                              onPay({
                                work_email: r.workEmail,
                                name: r.name,
                                department: r.department,
                                activeHolder: r.activeHolder,
                              })
                            }
                          >
                            <Banknote className="h-3.5 w-3.5" /> Pay
                          </Button>
                        )}
                        {canEdit && (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="h-7 px-2 text-[12px]"
                            disabled={!r.workEmail && !r.personalEmail}
                            title="Add or correct the bank details on this person's payout profile"
                            onClick={() => setBankTarget(r)}
                          >
                            {r.bankStatus === 'ok' ? 'Edit bank' : 'Set bank'}
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {bankTarget && (
        <SetBankDialog
          person={{
            name: bankTarget.name ?? bankTarget.workEmail ?? 'Offboarded person',
            email: bankTarget.workEmail ?? bankTarget.personalEmail,
            workEmail: bankTarget.workEmail,
            personalEmail: bankTarget.personalEmail,
            processor: bankTarget.bankProcessor,
          }}
          prefill={bankTarget.bankPrefill ?? undefined}
          source={PEOPLE_TAB_SOURCE}
          warning={bankTarget.activeHolder ? <ActiveHolderWarning holder={bankTarget.activeHolder} /> : undefined}
          onClose={() => setBankTarget(null)}
          onSaved={() => void runSearch(query)}
        />
      )}
    </div>
  );
}
