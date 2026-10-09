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

import { Fragment, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ChevronDown, KeyRound, Loader2, Plus, Search, X } from 'lucide-react';
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
import { api, handle, ScrollEdgeFade, TINY_CAPS, useScrollEdges } from './shared';

/**
 * The off-the-board row tint. OPAQUE and the same on the row and its sticky name cell: a see-through sticky cell would
 * show the ticks scrolling under it, and a different tint makes the name cell read as its own block.
 */
const OFF_BOARD_BG = 'bg-amber-50 dark:bg-[color-mix(in_oklab,var(--color-amber-900)_30%,var(--color-zinc-950))]';

/** The name column's edge while the grid is scrolled sideways: the ticks slide under it instead of being cut off. */
const STUCK_EDGE = 'shadow-[8px_0_10px_-8px_rgb(0_0_0/0.22)] dark:shadow-[8px_0_12px_-8px_rgb(0_0_0/0.8)]';

const DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' });
const when = (iso: string | null) => (iso ? DAY.format(new Date(iso)) : '');

export function KeysArea() {
  const [payload, setPayload] = useState<KeysPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState('');
  const [onlyHolders, setOnlyHolders] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [gridRef, gridEdges] = useScrollEdges<HTMLDivElement>();

  async function load() {
    const res = await api<KeysPayload>('/api/accounting-scoreboard/keys');
    if (!res.ok) {
      setLoadError(res.error);
      return;
    }
    setLoadError(null);
    setPayload(res.data);
  }
  useEffect(() => {
    void load();
  }, []);

  const grid = useMemo(() => (payload ? buildKeyGrid(payload) : null), [payload]);
  const labelOf = useMemo(() => new Map((payload?.keys ?? []).map((k) => [k.id, k.label])), [payload]);
  const shown = useMemo(
    () => (grid?.people ?? []).filter((p) => matchesPerson(p, query) && (!onlyHolders || p.seats.length > 0)),
    [grid, query, onlyHolders],
  );
  const openSeats = grid?.offBoard.reduce((n, p) => n + p.seats.length, 0) ?? 0;

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
  if (!payload || !grid) {
    return (
      <p className="flex items-center gap-2 px-1 text-xs text-zinc-500">
        <Loader2 className="size-3.5 animate-spin" /> Loading the keys…
      </p>
    );
  }

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
                    onClick={() => setOpen(p.email)}
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
            onChange={(e) => setQuery(e.target.value)}
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
            onChange={(e) => setOnlyHolders(e.target.checked)}
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
                <tr className="border-b border-zinc-200 dark:border-zinc-800">
                  <th
                    scope="col"
                    className={cn(
                      TINY_CAPS,
                      'sticky left-0 z-10 bg-white px-3 py-2 text-left text-zinc-500 transition-shadow dark:bg-zinc-950',
                      gridEdges.left && STUCK_EDGE,
                    )}
                  >
                    Person ({shown.length})
                  </th>
                  {grid.keys.map((k) => {
                    const seats = grid.seatCount[k.id] ?? 0;
                    return (
                      <th key={k.id} scope="col" className="px-2 py-2 text-center align-bottom font-semibold whitespace-nowrap text-zinc-800 dark:text-zinc-200">
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
              <tbody>
                {shown.map((p) => {
                  const isOpen = open === p.email;
                  return (
                    <Fragment key={p.email}>
                      <tr
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
                            gridEdges.left && STUCK_EDGE,
                          )}
                        >
                          <button
                            type="button"
                            aria-expanded={isOpen}
                            onClick={() => setOpen(isOpen ? null : p.email)}
                            className="group flex max-w-[10.5rem] items-center gap-1.5 text-left sm:max-w-[16rem]"
                          >
                            <ChevronDown
                              className={cn('size-3.5 shrink-0 text-zinc-400 transition-transform', isOpen && 'rotate-180')}
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
                      </tr>
                      {isOpen ? (
                        <tr className="border-b border-zinc-100 bg-zinc-50/70 dark:border-zinc-900 dark:bg-zinc-900/40">
                          <td colSpan={grid.keys.length + 1} className="p-0">
                            <div className={cn('sticky left-0 box-border w-[100cqw] px-3 py-3', gridEdges.right && 'pr-9')}>
                              <PersonSeats
                              person={p}
                              labelOf={labelOf}
                              busy={busy}
                              onRemove={(seat) => {
                                const key = grid.keys.find((k) => k.id === seat.keyId);
                                if (key) void setHolds(p, key, false);
                              }}
                              />
                            </div>
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
                {!shown.length ? (
                  <tr>
                    <td colSpan={grid.keys.length + 1} className="px-3 py-6 text-center text-xs text-zinc-500">
                      {query.trim() ? 'Nobody matches that search.' : 'Nobody holds a seat yet.'}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
          {/* The ticks that do not fit fade out at the right edge instead of being cut through. */}
          <ScrollEdgeFade side="right" shown={gridEdges.right} className="from-white dark:from-zinc-950" />
        </div>
      )}
    </div>
  );
}

/** One person's seats: the offboarding checklist, then what was removed and when. */
function PersonSeats({
  person,
  labelOf,
  busy,
  onRemove,
}: {
  person: KeyGridPerson;
  labelOf: Map<string, string>;
  busy: string | null;
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
            {person.seats.map((s) => {
              const name = labelOf.get(s.keyId) ?? 'Unknown key';
              const saving = busy === `${s.keyId}:${person.email}`;
              return (
                <li key={s.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
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
                </li>
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
