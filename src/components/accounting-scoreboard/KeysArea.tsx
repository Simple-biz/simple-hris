'use client';

/**
 * Setup → Keys (Admins only, Open item 424): the paid platforms (QBO, Stripe...) each person holds a seat on. Carla's
 * sheet, one column per platform, rebuilt as a grid: people down, keys across, a tick = holds a seat. A name opens
 * that person's seats, each with "Seat removed", so taking someone off the team shows every seat still to remove.
 *
 * Removing a seat is a stamp (who, when), never a delete; ticking it again gives a new seat. People who left the board
 * while still holding a seat are listed first: those seats are still being paid for. Rules: keys.ts and
 * docs/features/accounting-scoreboard-keys.md.
 */

import { Fragment, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { AlertTriangle, ChevronDown, ChevronLeft, ChevronRight, KeyRound, Loader2, Plus, Search, X } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  KEY_LABEL_MAX,
  buildKeyGrid,
  canArchiveKey,
  liveSeatOf,
  matchesPerson,
  type KeyGridPerson,
} from '@/lib/accounting-scoreboard/keys';
import type { KeySeat, KeysPayload, ScoreboardKey } from '@/lib/accounting-scoreboard/types';
import type { BoardRole } from '@/lib/accounting-scoreboard/roles';
import { pageWindow, type PageWindow } from '@/lib/manager/page-window';
import { clearCachedKeys, readCachedKeys, writeCachedKeys, type CachedKeys } from '@/lib/accounting-scoreboard/tab-cache';
import { api, EASE_SETTLE, handle, LoadingLines, ScrollEdgeFade, TINY_CAPS, useScrollEdges } from './shared';

/** What GET /keys really reads, side by side (server.ts readKeys): shown in turn while nothing is painted yet. */
const KEYS_LOADING_LINES = ['Fetching the keys', 'Reading who holds which seat', "Gathering the board's people"] as const;

/**
 * The off-the-board row tint. OPAQUE and the same on the row and its sticky name cell: a see-through sticky cell would
 * show the ticks scrolling under it, and a different tint makes the name cell read as its own block.
 */
const OFF_BOARD_BG = 'bg-amber-50 dark:bg-[color-mix(in_oklab,var(--color-amber-900)_30%,var(--color-zinc-950))]';

/**
 * Hairline rules (Kane, 2026-10-09, a sketch: a line after the Person column and under the header, "less thick"). One
 * pixel, drawn as INSET shadows, never borders: the Person column is sticky, and a collapsed table border stays behind
 * while a sticky cell slides over it. Once the grid is scrolled sideways the column also casts a soft drop shadow, so
 * the ticks pass under it instead of being cut off. One box-shadow per cell, so each state is one full value.
 */
const COL_RULE = 'shadow-[inset_-1px_0_0_var(--color-zinc-200)] dark:shadow-[inset_-1px_0_0_var(--color-zinc-700)]';
const COL_RULE_STUCK =
  'shadow-[inset_-1px_0_0_var(--color-zinc-200),8px_0_10px_-8px_rgb(0_0_0/0.22)] dark:shadow-[inset_-1px_0_0_var(--color-zinc-700),8px_0_12px_-8px_rgb(0_0_0/0.8)]';
const HEAD_RULE = 'shadow-[inset_0_-1px_0_var(--color-zinc-200)] dark:shadow-[inset_0_-1px_0_var(--color-zinc-700)]';
const CORNER_RULE =
  'shadow-[inset_-1px_0_0_var(--color-zinc-200),inset_0_-1px_0_var(--color-zinc-200)] dark:shadow-[inset_-1px_0_0_var(--color-zinc-700),inset_0_-1px_0_var(--color-zinc-700)]';
const CORNER_RULE_STUCK =
  'shadow-[inset_-1px_0_0_var(--color-zinc-200),inset_0_-1px_0_var(--color-zinc-200),8px_0_10px_-8px_rgb(0_0_0/0.22)] dark:shadow-[inset_-1px_0_0_var(--color-zinc-700),inset_0_-1px_0_var(--color-zinc-700),8px_0_12px_-8px_rgb(0_0_0/0.8)]';

/** People per page (Kane, 2026-10-09: "paginate this table to 10 per page"). Display only (ui-standards § 5.6). */
export const KEYS_PAGE_SIZE = 10;

/** Search: rows that drop out fade, and the rest glide into place on the settle curve (never a snap). */
const ROW_MOTION = { duration: 0.28, ease: EASE_SETTLE } as const;

const DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' });
const when = (iso: string | null) => (iso ? DAY.format(new Date(iso)) : '');

/**
 * `role` is the viewer's role as the server page resolved it on THIS load: the cached Keys paint only for a role that
 * may see them now (tab-cache.ts), and are fetched again on every visit regardless.
 */
export function KeysArea({ role }: { role: BoardRole }) {
  const reduce = useReducedMotion() ?? false;
  // Paint the last answer at once, then fetch anyway (a cached value paints, it never decides).
  const [payload, setPayload] = useState<CachedKeys | null>(() => readCachedKeys(role) ?? null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState('');
  const [onlyHolders, setOnlyHolders] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [gridRef, gridEdges, gridEl] = useScrollEdges<HTMLDivElement>();
  const [page, setPage] = useState(1);
  // The rows only animate one by one for a search; a page turn swaps the whole page with one quick fade.
  const turned = useRef(false);
  const painted = useRef(payload);
  painted.current = payload;

  async function load() {
    const res = await api<KeysPayload>('/api/accounting-scoreboard/keys');
    if (!res.ok) {
      // Refused: forget the cached copy so it never paints again, and show why instead of the old grid.
      if (res.status === 401 || res.status === 403) {
        clearCachedKeys();
        setPayload(null);
        setLoadError(res.error);
        return;
      }
      // A painted grid stays on screen through a failed refresh; with nothing painted, the error is the content.
      if (painted.current) toast.error(`Couldn't refresh the keys: ${res.error}`);
      else setLoadError(res.error);
      return;
    }
    setLoadError(null);
    setPayload(res.data);
    writeCachedKeys(res.data);
  }
  useEffect(() => {
    void load();
  }, []);

  const grid = useMemo(() => (payload ? buildKeyGrid(payload) : null), [payload]);
  const labelOf = useMemo(() => new Map((payload?.keys ?? []).map((k) => [k.id, k.label])), [payload]);
  // Filtering runs on a deferred copy of the query, so typing never waits for the grid to re-render.
  const searched = useDeferredValue(query);
  const shown = useMemo(
    () => (grid?.people ?? []).filter((p) => matchesPerson(p, searched) && (!onlyHolders || p.seats.length > 0)),
    [grid, searched, onlyHolders],
  );
  const openSeats = grid?.offBoard.reduce((n, p) => n + p.seats.length, 0) ?? 0;
  // DISPLAY ONLY: the Person count, the banner and every seat count read the full filtered list, never the page.
  const win = useMemo(() => pageWindow(shown, page, KEYS_PAGE_SIZE), [shown, page]);

  /** Turn the page; bring the grid back into view only if its top has left the screen. */
  function goToPage(next: number) {
    turned.current = true;
    setPage(next);
    if (gridEl && gridEl.getBoundingClientRect().top < 0) {
      gridEl.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
    }
  }

  /** Open someone from the banner, on whichever page they are. */
  function openPerson(email: string) {
    const i = shown.findIndex((p) => p.email === email);
    if (i >= 0) {
      const target = Math.floor(i / KEYS_PAGE_SIZE) + 1;
      if (target !== win.page) {
        turned.current = true;
        setPage(target);
      }
    }
    setOpen(email);
  }

  async function addKey() {
    setAdding(true);
    const res = await api<{ key: ScoreboardKey }>('/api/accounting-scoreboard/keys', {
      method: 'POST',
      body: JSON.stringify({ label }),
    });
    setAdding(false);
    if (!res.ok) return toast.error(res.error);
    toast.success(`${res.data.key.label} added. Tick everyone who holds a seat on it.`);
    setLabel('');
    void load();
  }

  async function archive(key: ScoreboardKey) {
    setBusy(`key:${key.id}`);
    const res = await api(`/api/accounting-scoreboard/keys?id=${encodeURIComponent(key.id)}`, { method: 'DELETE' });
    setBusy(null);
    if (!res.ok) return toast.error(res.error);
    toast.success(`${key.label} archived.`);
    void load();
  }

  /** Tick = give a seat; untick or "Seat removed" = stamp the seat removed (it stays as history). */
  async function setHolds(person: KeyGridPerson, key: ScoreboardKey, holds: boolean) {
    setBusy(`${key.id}:${person.email}`);
    const res = holds
      ? await api('/api/accounting-scoreboard/keys/seats', {
          method: 'POST',
          body: JSON.stringify({ keyId: key.id, email: person.email }),
        })
      : await api(
          `/api/accounting-scoreboard/keys/seats?keyId=${encodeURIComponent(key.id)}&email=${encodeURIComponent(person.email)}`,
          { method: 'DELETE' },
        );
    if (!res.ok) {
      setBusy(null);
      return toast.error(res.error);
    }
    await load();
    setBusy(null);
  }

  if (loadError) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
        <span>Couldn&rsquo;t load the keys: {loadError}</span>
        <Button size="xs" variant="outline" onClick={() => void load()}>
          Try again
        </Button>
      </div>
    );
  }
  if (!payload || !grid) return <LoadingLines label="Loading the keys" lines={KEYS_LOADING_LINES} />;

  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-xs leading-relaxed text-zinc-500">
        A key is a paid platform someone holds a seat on, like QBO or Stripe. Tick everyone who holds one. Before taking
        someone off the team, open their name, remove each seat on its platform, then mark it removed here. Only Admins
        see Keys.
      </p>

      {grid.offBoard.length ? (
        <div
          role="status"
          className="flex flex-wrap items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2.5 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
        >
          <AlertTriangle className="mt-px size-4 shrink-0" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="font-semibold">
              {grid.offBoard.length === 1 ? '1 person is' : `${grid.offBoard.length} people are`} off the board and still{' '}
              {grid.offBoard.length === 1 ? 'holds' : 'hold'} {openSeats === 1 ? '1 seat' : `${openSeats} seats`}.
            </p>
            <p className="mt-0.5">
              {grid.offBoard.map((p, i) => (
                <Fragment key={p.email}>
                  {i ? ', ' : ''}
                  <button
                    type="button"
                    className="font-medium underline decoration-amber-400 underline-offset-2 hover:decoration-amber-700"
                    onClick={() => openPerson(p.email)}
                  >
                    {p.name}
                  </button>
                </Fragment>
              ))}
              . Remove those seats on each platform, then mark them removed.
            </p>
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <form
          className="flex min-w-[16rem] flex-1 gap-2 sm:flex-none"
          onSubmit={(e) => {
            e.preventDefault();
            if (label.trim()) void addKey();
          }}
        >
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={KEY_LABEL_MAX}
            placeholder="New key, e.g. QBO"
            aria-label="New key name"
            className="flex-1 sm:w-56 md:text-[13px]"
          />
          <Button type="submit" size="lg" variant="outline" className="h-9" disabled={adding || !label.trim()}>
            {adding ? <Loader2 className="animate-spin" /> : <Plus />} Add key
          </Button>
        </form>
        <div className="relative min-w-[12rem] flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-zinc-400" aria-hidden />
          <Input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              turned.current = false;
              setPage(1);
            }}
            placeholder="Find a person"
            aria-label="Find a person"
            className="pl-8 md:text-[13px]"
          />
        </div>
        <label className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">
          <input
            type="checkbox"
            className="size-4 accent-orange-600"
            checked={onlyHolders}
            onChange={(e) => {
              setOnlyHolders(e.target.checked);
              turned.current = false;
              setPage(1);
            }}
          />
          Only people holding a seat
        </label>
      </div>

      {!grid.keys.length ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-zinc-300 px-4 py-8 text-center text-xs text-zinc-500 dark:border-zinc-700">
          <KeyRound className="size-5 text-zinc-400" aria-hidden />
          <p>No keys yet. Add one for each paid platform your people hold a seat on, then tick who holds it.</p>
        </div>
      ) : (
        // A size container, so an opened person's panel can be exactly as wide as what is visible (100cqw) and stay put
        // while the grid scrolls sideways on a phone: otherwise "Seat removed" sits off-screen to the right.
        <div className="relative rounded-xl">
          <div
            ref={gridRef}
            className="@container overflow-x-auto rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950"
          >
            <table className="table-keep w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <th
                    scope="col"
                    className={cn(
                      TINY_CAPS,
                      'sticky left-0 z-10 bg-white px-3 py-2 text-left text-zinc-500 transition-shadow dark:bg-zinc-950',
                      gridEdges.left ? CORNER_RULE_STUCK : CORNER_RULE,
                    )}
                  >
                    Person ({shown.length})
                  </th>
                  {grid.keys.map((k) => {
                    const seats = grid.seatCount[k.id] ?? 0;
                    return (
                      <th
                        key={k.id}
                        scope="col"
                        className={cn('px-2 py-2 text-center align-bottom font-semibold whitespace-nowrap text-zinc-800 dark:text-zinc-200', HEAD_RULE)}
                      >
                        <div className="flex h-6 items-center justify-center gap-0.5">
                          <span>{k.label}</span>
                          {canArchiveKey(seats) ? (
                            <Button
                              size="icon-xs"
                              variant="ghost"
                              className="text-zinc-400 hover:text-zinc-800 dark:text-zinc-500 dark:hover:text-zinc-200"
                              aria-label={`Archive ${k.label}`}
                              title={`Archive ${k.label} (nobody holds a seat on it)`}
                              disabled={busy === `key:${k.id}`}
                              onClick={() => void archive(k)}
                            >
                              {busy === `key:${k.id}` ? <Loader2 className="animate-spin" /> : <X />}
                            </Button>
                          ) : null}
                        </div>
                        <div className="text-[11px] font-normal text-zinc-500 tabular-nums">
                          {seats === 1 ? '1 seat' : `${seats} seats`}
                        </div>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <motion.tbody
                key={win.page}
                initial={turned.current && !reduce ? { opacity: 0, y: 4 } : false}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.22, ease: EASE_SETTLE }}
              >
                <AnimatePresence initial={false}>
                  {win.items.map((p) => {
                    const isOpen = open === p.email;
                    return (
                      <Fragment key={p.email}>
                        <motion.tr
                          layout={reduce ? false : 'position'}
                          initial={reduce ? false : { opacity: 0 }}
                          animate={{ opacity: 1 }}
                          exit={{ opacity: 0, transition: { duration: reduce ? 0 : 0.16 } }}
                          transition={{ layout: ROW_MOTION, opacity: { duration: reduce ? 0 : 0.22, ease: 'linear' } }}
                          className={cn(
                            'border-b border-zinc-100 last:border-0 dark:border-zinc-900',
                            !p.onBoard && p.seats.length > 0 && OFF_BOARD_BG,
                          )}
                        >
                          <th
                            scope="row"
                            className={cn(
                              'sticky left-0 z-10 px-3 py-1.5 text-left font-normal transition-shadow',
                              !p.onBoard && p.seats.length > 0 ? OFF_BOARD_BG : 'bg-white dark:bg-zinc-950',
                              gridEdges.left ? COL_RULE_STUCK : COL_RULE,
                            )}
                          >
                            <button
                              type="button"
                              aria-expanded={isOpen}
                              onClick={() => setOpen(isOpen ? null : p.email)}
                              className="group flex max-w-[10.5rem] items-center gap-1.5 text-left sm:max-w-[16rem]"
                            >
                              <ChevronDown
                                className={cn(
                                  'size-3.5 shrink-0 text-zinc-400 transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:text-zinc-600 dark:group-hover:text-zinc-300',
                                  isOpen && 'rotate-180 text-orange-500 group-hover:text-orange-600',
                                )}
                                aria-hidden
                              />
                              <span className="min-w-0">
                                <span className="flex min-w-0 items-center gap-1.5">
                                  <span className="truncate font-medium text-zinc-900 group-hover:underline dark:text-zinc-100">{p.name}</span>
                                  {!p.onBoard ? (
                                    <span className="shrink-0 rounded-full border border-amber-300 bg-amber-100 px-1.5 py-px text-[10px] font-semibold whitespace-nowrap text-amber-900 dark:border-amber-800 dark:bg-amber-900/50 dark:text-amber-200">
                                      Off the board
                                    </span>
                                  ) : null}
                                </span>
                                <span className="block truncate font-mono text-[11px] text-zinc-500">{p.email}</span>
                              </span>
                            </button>
                          </th>
                          {grid.keys.map((k) => {
                            const seat = liveSeatOf(p, k.id);
                            const cell = `${k.id}:${p.email}`;
                            // Someone off the board can lose a seat here, never gain one (the server refuses it too).
                            const canGive = p.onBoard;
                            return (
                              <td key={k.id} className="px-2 py-1.5 text-center">
                                {busy === cell ? (
                                  <Loader2 className="mx-auto size-4 animate-spin text-zinc-400" aria-label="Saving" />
                                ) : (
                                  <input
                                    type="checkbox"
                                    className="size-4 accent-orange-600 disabled:cursor-not-allowed disabled:opacity-40"
                                    checked={!!seat}
                                    disabled={!seat && !canGive}
                                    aria-label={`${p.name} holds a seat on ${k.label}`}
                                    title={
                                      seat
                                        ? `Since ${when(seat.givenAt)}, by ${handle(seat.givenBy)}. Untick once the seat is removed on ${k.label}.`
                                        : canGive
                                          ? `Give ${p.name} a seat on ${k.label}`
                                          : 'Off the board: add them under Members to give a seat'
                                    }
                                    onChange={(e) => void setHolds(p, k, e.target.checked)}
                                  />
                                )}
                              </td>
                            );
                          })}
                        </motion.tr>
                        {/* The dropdown grows open and folds shut (height and fade on one settle curve) instead of snapping.
                            The clip is overflow-y-CLIP, never hidden: hidden would make this wrapper the sticky panel's
                            scroll box and pin it to the table's left edge again on a phone. */}
                        <AnimatePresence initial={false}>
                          {isOpen ? (
                            <motion.tr
                              key="seats"
                              layout={reduce ? false : 'position'}
                              transition={{ layout: ROW_MOTION }}
                              className="border-b border-zinc-100 bg-zinc-50/70 dark:border-zinc-900 dark:bg-zinc-900/40"
                            >
                              <td colSpan={grid.keys.length + 1} className="p-0">
                                <motion.div
                                  initial={{ height: 0, opacity: 0 }}
                                  animate={{ height: 'auto', opacity: 1 }}
                                  exit={{ height: 0, opacity: 0 }}
                                  transition={{
                                    height: { duration: reduce ? 0 : 0.32, ease: EASE_SETTLE },
                                    opacity: { duration: reduce ? 0 : 0.2, ease: 'linear' },
                                  }}
                                  className="overflow-y-clip"
                                >
                                  <div className={cn('sticky left-0 box-border w-[100cqw] px-3 py-3', gridEdges.right && 'pr-9')}>
                                    <PersonSeats
                                      person={p}
                                      labelOf={labelOf}
                                      busy={busy}
                                      reduce={reduce}
                                      onRemove={(seat) => {
                                        const key = grid.keys.find((k) => k.id === seat.keyId);
                                        if (key) void setHolds(p, key, false);
                                      }}
                                    />
                                  </div>
                                </motion.div>
                              </td>
                            </motion.tr>
                          ) : null}
                        </AnimatePresence>
                      </Fragment>
                    );
                  })}
                  {!shown.length ? (
                    <motion.tr
                      key="none"
                      initial={reduce ? false : { opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0, transition: { duration: reduce ? 0 : 0.12 } }}
                      transition={{ duration: reduce ? 0 : 0.2, delay: reduce ? 0 : 0.12 }}
                    >
                      <td colSpan={grid.keys.length + 1} className="px-3 py-6 text-center text-xs text-zinc-500">
                        {searched.trim() ? 'Nobody matches that search.' : 'Nobody holds a seat yet.'}
                      </td>
                    </motion.tr>
                  ) : null}
                </AnimatePresence>
              </motion.tbody>
            </table>
          </div>
          {/* The ticks that do not fit fade out at the right edge instead of being cut through. */}
          <ScrollEdgeFade side="right" shown={gridEdges.right} className="from-white dark:from-zinc-950" />
        </div>
      )}
      {grid.keys.length ? <KeysPager win={win} onPage={goToPage} /> : null}
    </div>
  );
}

/**
 * ui-standards § 5.6: say which slice, Prev / the page as a mono `n / N` chip / Next, and render nothing for one page.
 * The shape of Orientation's `Pager` (OrientationAttendancePanel.tsx), in the scoreboard's orange.
 */
function KeysPager({ win, onPage }: { win: PageWindow<unknown>; onPage: (page: number) => void }) {
  if (win.totalPages <= 1) return null;
  const btn =
    'h-7 gap-1 border-orange-200 px-2 text-xs text-orange-700 hover:bg-orange-50 disabled:opacity-50 dark:border-orange-900/70 dark:text-orange-300 dark:hover:bg-orange-950/40';
  return (
    <nav
      aria-label="People pages"
      className="flex flex-col items-center justify-between gap-2 px-1 text-[11px] text-zinc-500 sm:flex-row dark:text-zinc-400"
    >
      <span className="tabular-nums" aria-live="polite">
        Showing{' '}
        <span className="font-medium text-zinc-700 dark:text-zinc-300">
          {win.from}–{win.to}
        </span>{' '}
        of <span className="font-medium text-zinc-700 dark:text-zinc-300">{win.total}</span> people
      </span>
      <div className="flex items-center gap-1.5">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={win.page <= 1}
          onClick={() => onPage(win.page - 1)}
          className={btn}
          aria-label="Previous page of people"
        >
          <ChevronLeft className="size-3.5" />
          Prev
        </Button>
        <span className="rounded-md border border-zinc-200 bg-white px-2 py-1 font-mono tabular-nums text-zinc-700 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300">
          {win.page} / {win.totalPages}
        </span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={win.page >= win.totalPages}
          onClick={() => onPage(win.page + 1)}
          className={btn}
          aria-label="Next page of people"
        >
          Next
          <ChevronRight className="size-3.5" />
        </Button>
      </div>
    </nav>
  );
}

/** One person's seats: the offboarding checklist, then what was removed and when. */
function PersonSeats({
  person,
  labelOf,
  busy,
  reduce,
  onRemove,
}: {
  person: KeyGridPerson;
  labelOf: Map<string, string>;
  busy: string | null;
  reduce: boolean;
  onRemove: (seat: KeySeat) => void;
}) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div className="space-y-2">
        <h4 className={cn(TINY_CAPS, 'text-zinc-500')}>
          {person.seats.length ? `Seats to remove before ${person.name} leaves (${person.seats.length})` : 'Seats'}
        </h4>
        {person.seats.length ? (
          <ul className="divide-y divide-zinc-100 overflow-hidden rounded-lg border border-zinc-200 bg-white dark:divide-zinc-900 dark:border-zinc-800 dark:bg-zinc-950">
            {person.seats.map((s, i) => {
              const name = labelOf.get(s.keyId) ?? 'Unknown key';
              const saving = busy === `${s.keyId}:${person.email}`;
              return (
                <motion.li
                  key={s.id}
                  initial={reduce ? false : { opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: reduce ? 0 : 0.24, delay: reduce ? 0 : 0.06 + i * 0.04, ease: EASE_SETTLE }}
                  className="flex flex-wrap items-center gap-2 px-3 py-2"
                >
                  <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-orange-100 text-[10px] font-bold text-orange-800 dark:bg-orange-950/60 dark:text-orange-300">
                    {name.slice(0, 3).toUpperCase()}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium text-zinc-900 dark:text-zinc-100">{name}</span>
                    <span className="block text-[11px] text-zinc-500">
                      Since {when(s.givenAt)}, by {handle(s.givenBy)}
                    </span>
                  </span>
                  <Button size="xs" variant="outline" disabled={saving} onClick={() => onRemove(s)}>
                    {saving ? <Loader2 className="animate-spin" /> : null} Seat removed
                  </Button>
                </motion.li>
              );
            })}
          </ul>
        ) : (
          <p className="text-xs text-zinc-500">{person.name} holds no seats.</p>
        )}
      </div>
      <div className="space-y-2">
        <h4 className={cn(TINY_CAPS, 'text-zinc-500')}>Removed</h4>
        {person.removed.length ? (
          <ul className="space-y-1 text-xs text-zinc-600 dark:text-zinc-400">
            {person.removed.map((s) => (
              <li key={s.id}>
                <span className="font-medium text-zinc-800 dark:text-zinc-200">{labelOf.get(s.keyId) ?? 'Unknown key'}</span>{' '}
                removed {when(s.removedAt)} by {handle(s.removedBy ?? '')}
                <span className="text-zinc-400"> (held since {when(s.givenAt)})</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-zinc-500">Nothing removed yet.</p>
        )}
      </div>
    </div>
  );
}
