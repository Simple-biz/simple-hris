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
 *
 * Visual register (Kane 2026-09-01, "futuristic — only this tab"): a console
 * treatment scoped to THIS FILE — a mono status readout that narrates the real
 * phases of a query, a scan line on the search field while a request is in
 * flight, staggered row entrances. It stays on the People tab's own accent
 * (orange/amber via the `accent` prop) in both themes, and every animation has
 * a reduced-motion fallback. The status phases mirror what the route actually
 * does (ledger read → match → active-roster cross-check → payout resolution),
 * so the motion conveys state, not decoration.
 *
 * Debounce rule: the 300ms timer is armed ONLY by keystrokes (scheduled in the
 * input's onChange, never in an effect), so nothing runs on mount or remount.
 * Enter searches immediately.
 */

import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { AlertTriangle, Banknote, Search, UserX } from 'lucide-react';
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
  /** Live employee_ids id, or the offboard snapshot's frozen copy; on a
   *  recycled email the snapshot outranks the live row (which is the current
   *  holder's). Null for most of the ledger. */
  employeeId: string | null;
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

/** The searched term as the readout speaks it — trimmed and capped so a pasted
 *  novel can't wrap the console line. */
function spokenTerm(q: string): string {
  const t = q.trim();
  return t.length > 24 ? `${t.slice(0, 24)}…` : t;
}

/**
 * What the console readout says while a query is in flight (Kane's flavor:
 * "looking back / searching previous records", opening with the term itself —
 * searching "franm" leads with “Looking for ‘franm’…”). The lines still walk
 * in the rough order the route works — ledger, records, roster cross-check,
 * payout data — and the last line HOLDS until the response lands (never loops
 * back, which would claim progress that isn't happening).
 */
function searchPhases(q: string): string[] {
  const term = spokenTerm(q);
  return [
    `Looking for “${term}”…`,
    `Searching the database for “${term}”…`,
    'Searching previous records…',
    'Checking employees who came before…',
    'Cross-referencing the active roster…',
    'Pulling up Employee IDs and bank details…',
  ];
}

const DEBOUNCE_MS = 300;
const PHASE_MS = 850;

/**
 * The mono console line under the search field. While loading it walks the
 * SEARCH_PHASES; otherwise it states the result plainly. aria-live so screen
 * readers hear the search progress without watching the animation.
 */
function ConsoleReadout({
  loading,
  error,
  searched,
  count,
  total,
  query,
  accent,
}: {
  loading: boolean;
  error: string | null;
  searched: boolean;
  count: number;
  total: number;
  /** The term being searched — spoken back in the first phase lines. */
  query: string;
  accent: Accent;
}) {
  const reduceMotion = useReducedMotion();
  const [phase, setPhase] = useState(0);
  const phases = searchPhases(query);

  // Restart the phase walk on every new request; hold on the final line.
  useEffect(() => {
    if (!loading) return;
    setPhase(0);
    const t = setInterval(
      () => setPhase((p) => Math.min(p + 1, searchPhases('').length - 1)),
      PHASE_MS,
    );
    return () => clearInterval(t);
  }, [loading]);

  let text: string;
  if (loading) text = phases[Math.min(phase, phases.length - 1)];
  else if (error) text = 'Query failed — see the message below.';
  else if (searched && count > 0)
    text = total > count ? `${count} of ${total} matching records shown` : `${count} matching record${count === 1 ? '' : 's'}`;
  else if (searched) text = 'No matching records.';
  else text = 'Standing by — type a name or work email.';

  return (
    <div
      aria-live="polite"
      className="mt-1.5 flex items-center gap-1.5 font-mono text-[11px] tracking-tight text-zinc-500 dark:text-zinc-400"
    >
      <span
        aria-hidden
        className={cn(
          'h-1.5 w-1.5 shrink-0 rounded-full',
          loading ? cn(accent.bar, !reduceMotion && 'animate-pulse') : error ? 'bg-rose-500' : 'bg-zinc-300 dark:bg-zinc-600',
        )}
      />
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={text}
          initial={reduceMotion ? false : { opacity: 0, y: 2 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduceMotion ? undefined : { opacity: 0, y: -2 }}
          transition={{ duration: 0.15, ease: 'easeOut' }}
        >
          {text}
        </motion.span>
      </AnimatePresence>
      {loading && (
        <span aria-hidden className={cn('ml-0.5 inline-block h-3 w-[5px] rounded-[1px]', accent.bar, !reduceMotion && 'animate-pulse')} />
      )}
    </div>
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
  const reduceMotion = useReducedMotion();
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<OffboardedRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const [bankTarget, setBankTarget] = useState<OffboardedRow | null>(null);
  // Drops answers that arrive after a newer keystroke's request.
  const seqRef = useRef(0);
  // The typing debounce timer. Armed ONLY in handleQueryChange (a keystroke),
  // never in an effect — so a mount/remount can never fire a search.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (debounceRef.current) clearTimeout(debounceRef.current); }, []);

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

  const handleQueryChange = (v: string) => {
    setQuery(v);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => void runSearch(v), DEBOUNCE_MS);
  };

  const searchNow = () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    void runSearch(query);
  };

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
      {/* Search console — the input plus the mono readout that narrates it. */}
      <div className="sm:max-w-xl">
        <div
          className={cn(
            'relative overflow-hidden rounded-xl border bg-white transition-shadow dark:bg-zinc-950',
            loading
              ? 'border-zinc-300 shadow-[0_0_0_3px_rgba(249,115,22,0.08)] dark:border-zinc-700'
              : 'border-zinc-200 dark:border-zinc-800',
          )}
        >
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
          <Input
            type="search"
            autoFocus
            placeholder="Search offboarded people by name or work email…"
            value={query}
            onChange={(e) => handleQueryChange(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') searchNow(); }}
            className={cn('border-0 pl-9 shadow-none focus-visible:ring-1', accent.ring)}
            aria-label="Search offboarded people"
          />
          {/* Scan line — a single moving segment along the bottom edge while a
              request is in flight. Transform-only; absent under reduced motion
              (the readout dot still pulses state → no, it's static too: the
              console TEXT is the reduced-motion signal). */}
          {loading && !reduceMotion && (
            <motion.span
              aria-hidden
              className={cn('absolute bottom-0 left-0 h-[2px] w-1/3 rounded-full', accent.bar)}
              animate={{ x: ['-100%', '300%'] }}
              transition={{ repeat: Infinity, duration: 1.2, ease: 'linear' }}
            />
          )}
        </div>
        <ConsoleReadout
          loading={loading}
          error={error}
          searched={searched}
          count={rows.length}
          total={total}
          query={query}
          accent={accent}
        />
      </div>

      {error && (
        <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
          {error}
        </div>
      )}

      {!searched && !loading && !error ? (
        <div className="mt-12 flex flex-col items-center gap-4 text-center">
          {/* Idle reticle — concentric rings around the empty-state mark. */}
          <div className="relative flex h-20 w-20 items-center justify-center" aria-hidden>
            <span className="absolute inset-0 rounded-full border border-dashed border-zinc-300 dark:border-zinc-700" />
            <span className="absolute inset-3 rounded-full border border-zinc-200 dark:border-zinc-800" />
            <UserX className="h-7 w-7 text-zinc-400 dark:text-zinc-500" />
          </div>
          <div className="max-w-md space-y-1">
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              Search the offboarded ledger — every record ever kept, including people who
              shared a work email.
            </p>
            <p className="font-mono text-[11px] text-zinc-400 dark:text-zinc-500">
              min. {OFFBOARDED_SEARCH_MIN_QUERY} characters · name or work email
            </p>
          </div>
        </div>
      ) : searched && rows.length === 0 && !error && !loading ? (
        <div className="mt-10 text-center text-sm text-zinc-500 dark:text-zinc-400">
          No offboarded records match “{query.trim()}”.
        </div>
      ) : rows.length > 0 ? (
        <div className={cn('mt-3 transition-opacity', loading && 'opacity-60')}>
          <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
            <table className="w-full min-w-[980px] text-left text-[13px]">
              <thead>
                <tr className="border-b border-zinc-200 font-mono text-[10px] uppercase tracking-[0.14em] text-zinc-500 dark:border-zinc-800">
                  <th className="px-3 py-2 font-medium">Name</th>
                  <th className="px-3 py-2 font-medium">Employee ID</th>
                  <th className="px-3 py-2 font-medium">Work Email</th>
                  <th className="px-3 py-2 font-medium">Personal Email</th>
                  <th className="px-3 py-2 font-medium">Start Date</th>
                  <th className="px-3 py-2 font-medium">Offboarded</th>
                  <th className="px-3 py-2 font-medium">Bank</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <motion.tr
                    key={r.id}
                    initial={reduceMotion ? false : { opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.18, delay: Math.min(i * 0.02, 0.24), ease: 'easeOut' }}
                    className="border-b border-zinc-100 transition-colors last:border-0 hover:bg-orange-50/40 dark:border-zinc-900 dark:hover:bg-orange-500/[0.04]"
                  >
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
                    <td className="px-3 py-2.5 font-mono text-[12px] tabular-nums text-zinc-600 dark:text-zinc-300" data-label="Employee ID">
                      {r.employeeId ?? <span className="text-zinc-400" title="No employee_ids record survives for this person">—</span>}
                    </td>
                    <td className="px-3 py-2.5 font-mono text-[12px] text-zinc-600 dark:text-zinc-300" data-label="Work Email">
                      {r.workEmail ?? <span className="text-zinc-400">—</span>}
                    </td>
                    <td className="px-3 py-2.5 font-mono text-[12px] text-zinc-600 dark:text-zinc-300" data-label="Personal Email">
                      {r.personalEmail ?? <span className="text-zinc-400">—</span>}
                    </td>
                    <td className="px-3 py-2.5 font-mono text-[12px] tabular-nums text-zinc-500 dark:text-zinc-400" data-label="Start Date">
                      {r.startDate ?? '—'}
                    </td>
                    <td className="px-3 py-2.5 font-mono text-[12px] tabular-nums text-zinc-500 dark:text-zinc-400" data-label="Offboarded">
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
                  </motion.tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
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
