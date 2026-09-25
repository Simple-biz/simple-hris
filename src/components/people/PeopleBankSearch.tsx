'use client';

/**
 * People → Search Bar: find anyone on the roster by name or work email, then
 * View their bank details INLINE (Kane, 2026-09-25: *"name and work email then
 * we can see their bank details when we view it similar from payment
 * catalog"*). Modelled on Payment Catalog → Search (`BonusCatalog.tsx`
 * `SearchTab`): the Simple logo over a centred bar that moves up once you
 * type, and View replaces the search with that person's page, which has a Back
 * button.
 *
 * Rules this file keeps (docs/features/people-bank-search.md):
 * - It searches the roster PeopleTab already holds (active master list), no
 *   new request. Leavers are searched on the Offboarded tab.
 * - The result row prints only what that roster row already carries: the rail
 *   Payment Dispatch routes on, the SERVER-masked last 4 digits (bank rails
 *   only), and the one Missing-bank-info rule. No full number ever reaches this
 *   list.
 * - The person page renders the popup's own `PayoutRecordBody` and reaches it
 *   through the SAME audited reveal (`POST /api/people/[email]/reveal-banking`)
 *   the popup uses. The body is never drawn from a masked record.
 * - A failed read is an error, never "no payout details on file".
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { ArrowLeft, Banknote, Eye, EyeOff, Landmark, Loader2, Search, UserRound, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { TeamAvatar } from '@/components/team/team-ui';
import { formatDeptLabel } from '@/lib/departments/hsl-subdept';
import { PROCESSOR_OPTIONS } from '@/lib/employee-payment-processors';
import { payoutRailFromStored, payoutRailView } from '@/lib/banking/payout-rail-view';
import { isMissingBankInfo, searchPeopleByNameOrEmail } from '@/lib/people/bank-search';
import { cn } from '@/lib/utils';
import { PayoutRecordBody, PayoutRevealSkeletonContent, type Banking } from './payout-record';
import type { Accent } from './PeopleTab';

/** The roster fields this tab reads. PeopleTab's `RosterRow` satisfies it structurally. */
export interface BankSearchPerson {
  id: string | null;
  name: string | null;
  work_email: string | null;
  department: string | null;
  /** The rail Payment Dispatch routes on (server-resolved), or null = unrouted. */
  processor: string | null;
  /** `isPayoutComplete` on that rail. */
  hasBanking: boolean;
  /** Already masked on the server ("···1234"), slot-aware. */
  accountLast4: string | null;
}

const PAGE_SIZE = 15;
const EASE = [0.22, 1, 0.36, 1] as const;
/** Confident deceleration for the tab's short arrivals (expo-out): views, results. */
const GLIDE = [0.16, 1, 0.3, 1] as const;
/** The bar's ~280px lift. Ease-in-out, NOT expo-out: measured in a harness, expo-out
 *  covered 21% of the travel in the first frame, which reads as a lurch. This one
 *  starts at 0.2%, never moves more than 9% in a frame, and is 78% there at half time. */
const TRAVEL = [0.4, 0, 0.2, 1] as const;

/** The rail's post-rebrand label (hurupay → Kolan); an id we do not know prints as stored. */
function railLabel(id: string): string {
  return PROCESSOR_OPTIONS.find((p) => p.id === id)?.label ?? id;
}

/** Stable identity for a roster row: the master-list PK, else email + name (the
 *  roster's own dedupe key), so a recycled work email never selects the wrong person. */
function personKey(p: BankSearchPerson): string {
  return p.id ?? `${(p.work_email ?? '').toLowerCase()}|${p.name ?? ''}`;
}

export default function PeopleBankSearch<T extends BankSearchPerson>({
  rows,
  loading,
  error,
  accent,
  onOpenProfile,
}: {
  rows: readonly T[];
  /** The roster is still on its first load (nothing cached to search yet). */
  loading: boolean;
  error: string | null;
  accent: Accent;
  /** Open the full People popup for this person, on its Banking tab. */
  onOpenProfile: (row: T) => void;
}) {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const reduceMotion = !!useReducedMotion();

  const results = useMemo(() => searchPeopleByNameOrEmail(rows, query), [rows, query]);
  useEffect(() => {
    setPage(1);
  }, [query]);

  const totalPages = Math.max(1, Math.ceil(results.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageStart = (safePage - 1) * PAGE_SIZE;
  const pageRows = results.slice(pageStart, pageStart + PAGE_SIZE);

  // Looked up live, so a profile edit made from "Open full profile" (merged into
  // the roster by PeopleTab) shows here too. A person who drops off the roster on
  // a refresh returns the page to the search rather than a stale record.
  const selected = selectedKey ? (rows.find((r) => personKey(r) === selectedKey) ?? null) : null;
  const typed = query.trim() !== '';

  // One motion language for the tab (docs/features/people-bank-search.md §7).
  // The focal moment is the bar lifting to the top when a search starts: the logo
  // and the bar FLIP there as transforms (`layout`), so the glide cannot be cut
  // short by the results landing underneath. The old version animated the
  // spacer's flex-grow and the logo's height as CSS transitions of different
  // lengths, which fought each other and snapped whenever the results filled the
  // free space. Reduced motion drops the travel and keeps the state fades.
  const glide = reduceMotion ? { duration: 0 } : { duration: 0.5, ease: TRAVEL };
  const viewEnter = { duration: reduceMotion ? 0.15 : 0.28, ease: GLIDE };
  const viewExit = { duration: 0.12, ease: 'easeIn' as const };

  // The search and the person page share one scroll container (PeopleTab's). The
  // page opens at its top; Back returns to the spot in the results it was opened
  // from. Both run while the incoming view is still at opacity 0, so nothing is
  // seen to jump.
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsScrollTop = useRef(0);
  const openPerson = (key: string) => {
    resultsScrollTop.current = scrollParentOf(rootRef.current)?.scrollTop ?? 0;
    setSelectedKey(key);
  };

  return (
    <div ref={rootRef} className="mx-auto flex min-h-full w-full max-w-3xl flex-col">
      <AnimatePresence mode="wait" initial={false}>
        {selected ? (
          <motion.div
            key={`person-${selectedKey}`}
            initial={{ opacity: 0, y: reduceMotion ? 0 : 8 }}
            animate={{ opacity: 1, y: 0, transition: viewEnter }}
            exit={{ opacity: 0, transition: viewExit }}
          >
            <PersonBankPage
              person={selected}
              reduceMotion={reduceMotion}
              onBack={() => setSelectedKey(null)}
              onOpenProfile={() => onOpenProfile(selected)}
            />
            <OnMount
              run={() => {
                const sp = scrollParentOf(rootRef.current);
                if (sp) sp.scrollTop = 0;
              }}
            />
          </motion.div>
        ) : (
          <motion.div
            key="search"
            initial={{ opacity: 0, y: reduceMotion ? 0 : 8 }}
            animate={{ opacity: 1, y: 0, transition: viewEnter }}
            exit={{ opacity: 0, transition: viewExit }}
            className="relative flex w-full grow flex-col"
          >
            {/* Same landing as Payment Catalog → Search: the logo over a vertically
                centred bar when idle, both at the top once a query is typed. The
                spacer switches instantly; the logo and bar FLIP from where they were.
                The navy logo renders as a white silhouette in dark mode. */}
            <div aria-hidden className={cn('shrink-0', typed ? 'grow-0' : 'grow-[0.85]')} />
            <div className="mx-auto w-full max-w-xl">
              <div className={cn('flex justify-center', typed ? 'mb-4' : 'mb-7')}>
                <motion.img
                  layout={!reduceMotion}
                  layoutDependency={typed}
                  transition={glide}
                  src="/simple-logo.png"
                  alt="Simple"
                  draggable={false}
                  className={cn(
                    'select-none object-contain dark:brightness-0 dark:invert',
                    typed ? 'h-9' : 'h-16 sm:h-20',
                  )}
                />
              </div>
              <motion.div
                layout={reduceMotion ? false : 'position'}
                layoutDependency={typed}
                transition={glide}
                className="relative"
              >
                <Search className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-zinc-400" />
                <input
                  ref={inputRef}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search anyone by name or work email…"
                  aria-label="Search people by name or work email"
                  className={cn(
                    'w-full rounded-full border border-zinc-200 bg-white py-3.5 pl-12 pr-10 text-sm text-zinc-800 shadow-sm outline-none transition-shadow duration-200 placeholder:text-zinc-400 hover:shadow-md focus:shadow-md dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200',
                    accent.ring,
                  )}
                />
                <AnimatePresence initial={false}>
                  {query && (
                    <motion.button
                      key="clear"
                      type="button"
                      aria-label="Clear search"
                      onClick={() => {
                        setQuery('');
                        inputRef.current?.focus({ preventScroll: true });
                      }}
                      initial={{ opacity: 0, scale: reduceMotion ? 1 : 0.8 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: reduceMotion ? 1 : 0.8 }}
                      transition={{ duration: 0.14 }}
                      className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full p-1 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
                    >
                      <X className="h-4 w-4" />
                    </motion.button>
                  )}
                </AnimatePresence>
              </motion.div>
              {/* popLayout: the leaving hint drops out of the flow at once, so the
                  results sit right under the bar instead of below an invisible
                  slot, and it fades back in only after the bar has settled. */}
              <div className="relative">
                <AnimatePresence initial={false} mode="popLayout">
                  {!typed && (
                    <motion.p
                      key="hint"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1, transition: { duration: 0.24, delay: reduceMotion ? 0 : 0.3 } }}
                      exit={{ opacity: 0, transition: { duration: 0.1 } }}
                      className="mt-3 text-center text-xs text-zinc-400 dark:text-zinc-500"
                    >
                      {loading && rows.length === 0
                        ? 'Loading the roster…'
                        : `${rows.length.toLocaleString()} people on the roster · view anyone's bank details`}
                      <br />
                      Someone who has left? Search them on the Offboarded tab.
                    </motion.p>
                  )}
                </AnimatePresence>
              </div>
            </div>

            {/* The results arrive once per search, a beat behind the bar, and
                live-filter in place after that: a keystroke re-renders the rows
                without re-animating them, because feedback on typing must not lag. */}
            <AnimatePresence initial={false} mode="popLayout">
              {typed && (
                <motion.div
                  key="results"
                  initial={{ opacity: 0, y: reduceMotion ? 0 : 10 }}
                  animate={{
                    opacity: 1,
                    y: 0,
                    transition: { duration: reduceMotion ? 0.15 : 0.32, delay: reduceMotion ? 0 : 0.18, ease: GLIDE },
                  }}
                  exit={{ opacity: 0, transition: { duration: 0.1 } }}
                  className="mt-2"
                >
                  {error && rows.length === 0 ? (
                    <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/30 dark:text-rose-300">
                      The roster could not be loaded, so there is nothing to search: {error}
                    </p>
                  ) : loading && rows.length === 0 ? (
                    <div className="flex items-center justify-center gap-2 py-8 text-sm text-zinc-500">
                      <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" /> Loading the roster…
                    </div>
                  ) : results.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-zinc-300 px-4 py-8 text-center dark:border-zinc-700">
                      <p className="text-sm font-medium text-zinc-700 dark:text-zinc-200">No one matches “{query.trim()}”</p>
                      <p className="mt-1 text-xs text-zinc-500">
                        Search by name or work email. Someone who has left is on the Offboarded tab.
                      </p>
                    </div>
                  ) : (
                    <>
                      {/* Keyed by page: a quick crossfade marks that Prev/Next swapped
                          the rows, where an instant swap reads as nothing happening. */}
                      <motion.div
                        key={safePage}
                        initial={{ opacity: 0.35 }}
                        animate={{ opacity: 1 }}
                        transition={{ duration: 0.18 }}
                        className="space-y-2"
                      >
                        {pageRows.map((r, i) => (
                          <ResultRow
                            key={`${personKey(r)}|${pageStart + i}`}
                            person={r}
                            onView={() => openPerson(personKey(r))}
                          />
                        ))}
                      </motion.div>
                      {/* Never capped: a common first name pages instead of losing its
                          31st match (a filter never hides a row). */}
                      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[12px] text-zinc-500">
                        <span>
                          Showing {pageStart + 1}–{Math.min(pageStart + PAGE_SIZE, results.length)} of {results.length}
                        </span>
                        {totalPages > 1 && (
                          <div className="flex items-center gap-2">
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              className="h-7 px-2 text-[12px]"
                              disabled={safePage <= 1}
                              onClick={() => setPage((p) => Math.max(1, p - 1))}
                            >
                              Prev
                            </Button>
                            <span className="tabular-nums text-zinc-600 dark:text-zinc-300">
                              Page {safePage} of {totalPages}
                            </span>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              className="h-7 px-2 text-[12px]"
                              disabled={safePage >= totalPages}
                              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                            >
                              Next
                            </Button>
                          </div>
                        )}
                      </div>
                    </>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
            {/* Fixed counterweight for the top spacer (see above). */}
            <div aria-hidden className="grow" />
            <OnMount
              run={() => {
                const sp = scrollParentOf(rootRef.current);
                if (sp) sp.scrollTop = resultsScrollTop.current;
                // preventScroll: autoFocus would yank the container back up to the
                // bar and undo the restore above.
                inputRef.current?.focus({ preventScroll: true });
              }}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Nearest scrolling ancestor: PeopleTab's content pane. */
function scrollParentOf(el: HTMLElement | null): HTMLElement | null {
  for (let p = el?.parentElement ?? null; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if (oy === 'auto' || oy === 'scroll') return p;
  }
  return null;
}

/** Runs `run` once, after the view it sits in has mounted. Under AnimatePresence
 *  mode="wait" that is the moment the incoming view replaces the old one, while
 *  it is still at opacity 0. A PASSIVE effect on purpose: a layout effect here
 *  runs before later siblings' and ancestors' refs are attached (post-order
 *  commit), so the input and the root were still null and focus never landed. */
function OnMount({ run }: { run: () => void }) {
  const runRef = useRef(run);
  useEffect(() => {
    runRef.current();
  }, []);
  return null;
}

/** Rail · last-4 · missing flag, from what the roster row already carries. */
function BankChips({ person, className }: { person: BankSearchPerson; className?: string }) {
  // Last-4 only where the rail pays into a bank. A Kolan/HiGlobe payee's leftover
  // account would read as where their money goes, and it is not; an unrouted
  // person fails closed (payoutRailView with no bank-name evidence).
  const bankRail = payoutRailView(payoutRailFromStored(person.processor), false).showBankCard;
  const missing = isMissingBankInfo(person);
  return (
    <div className={cn('flex flex-wrap items-center gap-1.5', className)}>
      {person.processor ? (
        <span className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
          <Banknote className="h-3 w-3" /> {railLabel(person.processor)}
        </span>
      ) : (
        <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
          Not routed
        </span>
      )}
      {bankRail && person.accountLast4 && (
        <span
          className="rounded-full bg-zinc-100 px-2 py-0.5 font-mono text-[11px] tabular-nums text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
          title="Last 4 of the account Payment Dispatch pays into"
        >
          {person.accountLast4}
        </span>
      )}
      {missing && (
        <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
          Missing bank info
        </span>
      )}
    </div>
  );
}

function ResultRow({ person, onView }: { person: BankSearchPerson; onView: () => void }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-zinc-200 bg-white px-3 py-2.5 dark:border-zinc-800 dark:bg-zinc-950">
      <TeamAvatar name={person.name ?? ''} email={person.work_email} />
      <div className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-zinc-800 dark:text-zinc-200">{person.name ?? '—'}</span>
        <span className="block truncate text-xs text-zinc-500">
          {formatDeptLabel(person.department) || 'No department'} · {person.work_email ?? 'No work email'}
        </span>
        <BankChips person={person} className="mt-1.5 sm:hidden" />
      </div>
      <BankChips person={person} className="hidden shrink-0 justify-end sm:flex" />
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={onView}
        disabled={!person.work_email}
        title={person.work_email ? 'View bank details' : 'No work email on file, so the payout record cannot be looked up'}
        className="shrink-0 gap-1"
      >
        <Eye className="h-3.5 w-3.5" /> View
      </Button>
    </div>
  );
}

type RecordState =
  | { status: 'loading' }
  | { status: 'failed'; error: string }
  | { status: 'ready'; banking: Banking | null };

function PersonBankPage({
  person,
  reduceMotion,
  onBack,
  onOpenProfile,
}: {
  person: BankSearchPerson;
  reduceMotion: boolean;
  onBack: () => void;
  onOpenProfile: () => void;
}) {
  // Frozen for the page's lifetime, as the popup does: an email edited from the
  // full profile must not re-fire the read and silently re-mask a reveal.
  const [email] = useState(() => person.work_email ?? '');
  const [record, setRecord] = useState<RecordState>({ status: 'loading' });
  const [revealing, setRevealing] = useState(false);
  const [shown, setShown] = useState(false);
  const [routingOpen, setRoutingOpen] = useState(false);
  // The View button that opened this page is gone, so focus would fall to <body>.
  // Land it on Back instead, the page's first control, without scrolling.
  const backRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    backRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    let alive = true;
    fetch(`/api/people/${encodeURIComponent(email)}`, { cache: 'no-store' })
      .then(async (res) => {
        const j = (await res.json()) as { banking?: Banking | null; bankingResolved?: boolean; error?: string };
        if (!res.ok) throw new Error(j.error || `Request failed (${res.status})`);
        // `banking: null` means both "no record" and "the read failed"; only
        // `bankingResolved` tells them apart. Fail closed: anything but a
        // confirmed read is an error, never "no payout details on file".
        if (j.bankingResolved !== true) throw new Error(j.error || 'The payout record could not be read.');
        return j.banking ?? null;
      })
      .then((banking) => {
        if (alive) setRecord({ status: 'ready', banking });
      })
      .catch((e: unknown) => {
        if (alive) setRecord({ status: 'failed', error: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      alive = false;
    };
  }, [email]);

  const reveal = async (): Promise<Banking | null> => {
    setRevealing(true);
    try {
      const res = await fetch(`/api/people/${encodeURIComponent(email)}/reveal-banking`, { method: 'POST' });
      const j = (await res.json()) as { banking?: Banking | null; error?: string };
      if (!res.ok) throw new Error(j.error || 'Reveal failed');
      if (j.banking) setRecord({ status: 'ready', banking: j.banking });
      return j.banking ?? null;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not reveal banking');
      return null;
    } finally {
      setRevealing(false);
    }
  };

  // The popup's toggle, same rules: a masked record goes through the audited
  // reveal first and stays hidden if that fails; hiding is purely visual.
  const toggle = async () => {
    if (record.status !== 'ready') return;
    if (shown) {
      setShown(false);
      return;
    }
    if (record.banking?.masked) {
      const b = await reveal();
      if (!b) return;
    }
    setShown(true);
  };

  // Opacity only, so it stays under reduced motion: it is what says the reveal landed.
  const fade = { duration: 0.14 };

  return (
    <div>
      <button
        ref={backRef}
        type="button"
        onClick={onBack}
        className="group mb-3 inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[13px] font-medium text-zinc-500 transition-colors hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
      >
        <ArrowLeft className="h-4 w-4 transition-transform duration-150 group-hover:-translate-x-0.5 motion-reduce:transition-none" /> Back to search
      </button>

      <div className="rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex flex-wrap items-center gap-3 border-b border-zinc-200 px-4 py-4 dark:border-zinc-800">
          <TeamAvatar name={person.name ?? ''} email={person.work_email} />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-semibold text-zinc-900 dark:text-zinc-100">{person.name ?? '—'}</h2>
            <p className="truncate text-xs text-zinc-500">
              {formatDeptLabel(person.department) || 'No department'} · {person.work_email}
            </p>
            <BankChips person={person} className="mt-1.5" />
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 shrink-0 gap-1.5 px-2.5 text-[12px]"
            onClick={onOpenProfile}
            title="Edit payout details and see the bank change history"
          >
            <UserRound className="h-3.5 w-3.5" /> Open full profile
          </Button>
        </div>

        <div className="px-4 py-4">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-500">
              <Landmark className="h-3.5 w-3.5 text-emerald-500" /> Banking &amp; payout
            </h3>
            {record.status === 'ready' && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 gap-1.5 px-2 text-[12px]"
                onClick={toggle}
                disabled={revealing}
              >
                {revealing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                ) : shown ? (
                  <EyeOff className="h-3.5 w-3.5" />
                ) : (
                  <Eye className="h-3.5 w-3.5" />
                )}
                {shown ? 'Hide' : 'Reveal'}
              </Button>
            )}
          </div>

          {record.status === 'loading' ? (
            <div className="rounded-lg border border-zinc-200 bg-zinc-50/60 p-3 dark:border-zinc-800 dark:bg-zinc-900/40">
              <div className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="space-y-1.5">
                    <Skeleton className="h-2.5 w-16" />
                    <Skeleton className="h-3.5 w-32" />
                  </div>
                ))}
              </div>
            </div>
          ) : record.status === 'failed' ? (
            <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/30 dark:text-rose-300">
              The payout record could not be loaded, so nothing is shown rather than a blank record: {record.error}
            </p>
          ) : (
            <AnimatePresence mode="wait" initial={false}>
              {revealing ? (
                <motion.div
                  key="revealing"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={fade}
                  className="rounded-lg border border-zinc-200 bg-zinc-50/60 p-3 dark:border-zinc-800 dark:bg-zinc-900/40"
                  aria-live="polite"
                  aria-busy
                >
                  <PayoutRevealSkeletonContent />
                </motion.div>
              ) : !shown ? (
                <motion.button
                  key="hidden"
                  type="button"
                  onClick={toggle}
                  disabled={revealing}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={fade}
                  className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-zinc-300 bg-zinc-50/60 px-3 py-4 text-[12px] text-zinc-500 transition-colors hover:border-zinc-400 hover:text-zinc-700 disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900/40 dark:text-zinc-400 dark:hover:border-zinc-600 dark:hover:text-zinc-200"
                >
                  <Eye className="h-3.5 w-3.5" />
                  Payout details hidden. Click to reveal (recorded in the audit log).
                </motion.button>
              ) : (
                <motion.div
                  key="shown"
                  initial={reduceMotion ? { opacity: 0 } : { opacity: 0, height: 0 }}
                  animate={reduceMotion ? { opacity: 1 } : { opacity: 1, height: 'auto' }}
                  exit={reduceMotion ? { opacity: 0 } : { opacity: 0, height: 0 }}
                  transition={{ duration: reduceMotion ? 0 : 0.3, ease: EASE }}
                  className="overflow-hidden"
                >
                  <PayoutRecordBody
                    banking={record.banking}
                    reduceMotion={reduceMotion}
                    routingOpen={routingOpen}
                    onToggleRouting={() => setRoutingOpen((v) => !v)}
                  />
                </motion.div>
              )}
            </AnimatePresence>
          )}
        </div>
      </div>
      <p className="mt-2 text-[11px] text-zinc-400">
        To edit these details or see the bank change history, open the full profile.
      </p>
    </div>
  );
}
