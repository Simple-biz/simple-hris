'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, FileSignature, Home, Loader2, PenLine, Search, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SmoothSelect } from '@/components/ui/smooth-select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { formatDeptLabel } from '@/lib/departments/hsl-subdept';
import {
  ADDRESS_LETTER_COUNTRIES,
  ADDRESS_LETTER_FIELD_LABELS,
  ADDRESS_LETTER_MAX_LENGTH,
} from '@/lib/documents/address-letter';
import {
  ADDRESS_LETTER_FIELDS,
  type AddressLetterField,
  type AddressLetterPreviewFacts,
  type DocumentRequestRow,
  type DocumentSignatureRow,
} from '@/lib/documents/types';
import {
  initialsOf,
  useOptimisticProgress,
  type Candidate,
  type SearchResponse,
} from '@/components/accounting/GenerateCoeDialog';

const PLACEHOLDERS: Record<Exclude<AddressLetterField, 'country'>, string> = {
  street: 'House no., street, barangay',
  cityProvince: 'e.g. Caloocan, Metro Manila',
  postalCode: 'e.g. 1420',
};

/**
 * Accounting → Documents → "Proof of Address": issue a signed Proof of Residential
 * Address letter for an ACTIVE Global Master List person (Carla's rule: only
 * Accounting creates it). Same picker as Generate COE (it reuses the COE search —
 * the population is identical), then the facts the letter will state.
 *
 * The address comes from the records — the roster, else the worker's newest
 * onboarding form — and its source is shown, never printed. A field the records
 * leave BLANK becomes an input; a field on file cannot be edited here (the server
 * refuses it too): a stale roster address is HR's to correct.
 *
 * There is no pending state. One click renders, signs and delivers the letter to
 * the worker's Profile → Request Documents. A 412 steers into the signature
 * capture dialog exactly like Approve; a 503 means the one-time migration that
 * admits the `address` type has not run.
 */
export default function GenerateAddressLetterDialog({
  open,
  onOpenChange,
  signature,
  onRequireSignature,
  onGenerated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  signature: DocumentSignatureRow | null;
  onRequireSignature: () => void;
  onGenerated: () => void;
}) {
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [selected, setSelected] = useState<Candidate | null>(null);

  const [factsLoading, setFactsLoading] = useState(false);
  const [factsBlocked, setFactsBlocked] = useState<string | null>(null);
  const [facts, setFacts] = useState<AddressLetterPreviewFacts | null>(null);
  const [fills, setFills] = useState<Partial<Record<AddressLetterField, string>>>({});

  const [generating, setGenerating] = useState(false);
  const factsProgress = useOptimisticProgress(factsLoading);
  const signingBlocked = !signature || !signature.enabled;
  const searchSeq = useRef(0);

  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (!q) {
      setResult(null);
      setSearching(false);
      return;
    }
    const seq = ++searchSeq.current;
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        // The COE search IS this letter's search: active GML people, work email identifies.
        const res = await fetch(`/api/accounting/documents/coe/search?q=${encodeURIComponent(q)}`, {
          cache: 'no-store',
        });
        const json = (await res.json()) as SearchResponse;
        if (seq !== searchSeq.current) return;
        setResult(res.ok ? json : { candidates: [], error: json.error || `Search failed (${res.status})` });
      } catch (e) {
        if (seq !== searchSeq.current) return;
        setResult({ candidates: [], error: e instanceof Error ? e.message : 'Search failed' });
      } finally {
        if (seq === searchSeq.current) setSearching(false);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [open, query]);

  const loadFacts = useCallback(async (candidate: Candidate) => {
    setSelected(candidate);
    setFacts(null);
    setFactsBlocked(null);
    setFills({});
    setFactsLoading(true);
    try {
      const res = await fetch(
        `/api/accounting/documents/address/preview?email=${encodeURIComponent(candidate.workEmail)}`,
        { cache: 'no-store' },
      );
      const json = (await res.json()) as { facts?: AddressLetterPreviewFacts; blocked?: string; error?: string };
      if (res.status === 422 && json.blocked) {
        setFactsBlocked(json.blocked);
        return;
      }
      if (!res.ok || !json.facts) throw new Error(json.error || 'Could not load the letter details');
      setFacts(json.facts);
    } catch (e) {
      setFactsBlocked(e instanceof Error ? e.message : 'Could not load the letter details');
    } finally {
      setFactsLoading(false);
    }
  }, []);

  const reset = useCallback(() => {
    searchSeq.current += 1;
    setQuery('');
    setResult(null);
    setSearching(false);
    setSelected(null);
    setFacts(null);
    setFactsBlocked(null);
    setFills({});
    setGenerating(false);
  }, []);

  const close = useCallback(
    (o: boolean) => {
      if (!o) reset();
      onOpenChange(o);
    },
    [onOpenChange, reset],
  );

  const blanks = useMemo(() => new Set(facts?.blanks ?? []), [facts]);
  const missing = useMemo(
    () => (facts ? facts.blanks.filter((f) => !(fills[f] ?? '').trim()) : []),
    [facts, fills],
  );

  const generate = async () => {
    if (!selected || !facts || missing.length > 0) return;
    setGenerating(true);
    try {
      // Only blank fields are sent; the server refuses any other key.
      const body = {
        work_email: selected.workEmail,
        fills: Object.fromEntries(facts.blanks.map((f) => [f, (fills[f] ?? '').trim()])),
      };
      const res = await fetch('/api/accounting/documents/address', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as { row?: DocumentRequestRow; blocked?: string; error?: string };
      if (res.status === 412) {
        close(false);
        onRequireSignature();
        throw new Error(json.error || 'No active signature');
      }
      if (!res.ok || !json.row) throw new Error(json.blocked || json.error || `Could not issue the letter (${res.status})`);
      const who = json.row.employee_name || json.row.employee_email;
      toast.success('Proof of Address issued & signed', {
        description: `${who} can download the signed letter from their profile.`,
      });
      close(false);
      onGenerated();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not issue the letter');
    } finally {
      setGenerating(false);
    }
  };

  const candidates = useMemo(() => result?.candidates ?? [], [result]);

  const sourceLine = facts
    ? facts.addressSource
      ? `From ${facts.addressSourceDetail ?? facts.addressSource}`
      : 'No address on file — type the one the contractor gave you'
    : null;

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="flex max-h-[85dvh] flex-col overflow-hidden sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Issue a Proof of Residential Address</DialogTitle>
          <DialogDescription>
            Accounting-only. The signed letter goes to the worker&rsquo;s profile.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
          {/* ── Person picker (same as Generate COE) ──────────────────────── */}
          {selected ? (
            <div className="flex items-center gap-3 rounded-xl border border-orange-200 bg-orange-50/70 px-3 py-2 dark:border-orange-500/30 dark:bg-orange-500/10">
              <span
                aria-hidden
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-orange-500/90 text-[11px] font-semibold text-white dark:bg-orange-500/80"
              >
                {initialsOf(selected.name, selected.workEmail)}
              </span>
              <div className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-orange-950 dark:text-orange-100">
                  {selected.name || selected.workEmail}
                </span>
                <span className="block truncate text-[11.5px] text-orange-900/70 dark:text-orange-200/70">
                  {selected.workEmail}
                  {selected.department ? ` · ${formatDeptLabel(selected.department)}` : ''}
                </span>
              </div>
              <button
                type="button"
                onClick={() => {
                  setSelected(null);
                  setFacts(null);
                  setFactsBlocked(null);
                  setFills({});
                }}
                disabled={generating}
                aria-label="Pick a different worker"
                className="shrink-0 rounded-md p-1 text-orange-700/70 transition-colors hover:bg-orange-100 hover:text-orange-900 dark:text-orange-300/70 dark:hover:bg-orange-500/20"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : (
            <>
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
                <Input
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Name or email…"
                  aria-label="Search active workers"
                  className="h-9 pl-9 pr-8 text-sm focus:border-orange-500 focus:ring-2 focus:ring-orange-500/20"
                />
                {searching && (
                  <Loader2
                    aria-label="Searching"
                    className="absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-orange-500"
                  />
                )}
              </div>
              {result?.error ? (
                <div className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50/70 px-3 py-2.5 text-xs text-rose-800 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{result.error}</span>
                </div>
              ) : result?.tooShort ? (
                <p className="px-1 text-[12px] text-zinc-500 dark:text-zinc-400">Keep typing, at least two characters.</p>
              ) : result && candidates.length === 0 && !searching ? (
                <p className="px-1 text-[12px] text-zinc-500 dark:text-zinc-400">
                  No match for &ldquo;{query.trim()}&rdquo;. Only active workers are listed.
                </p>
              ) : candidates.length > 0 ? (
                <div className="overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-800">
                  <ul className="max-h-60 divide-y divide-zinc-100 overflow-y-auto dark:divide-zinc-800/70">
                    {candidates.map((c) => (
                      <li key={c.workEmail}>
                        <button
                          type="button"
                          onClick={() => void loadFacts(c)}
                          className="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-orange-50/70 focus-visible:bg-orange-50/70 focus-visible:outline-none dark:hover:bg-orange-500/10 dark:focus-visible:bg-orange-500/10"
                        >
                          <span
                            aria-hidden
                            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-orange-100 text-[11px] font-semibold text-orange-700 dark:bg-orange-500/15 dark:text-orange-300"
                          >
                            {initialsOf(c.name, c.workEmail)}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[13px] font-medium text-zinc-800 dark:text-zinc-100">
                              {c.name || c.workEmail}
                            </span>
                            <span className="block truncate text-[11.5px] text-zinc-500 dark:text-zinc-400">
                              {c.workEmail}
                              {c.department ? ` · ${formatDeptLabel(c.department)}` : ''}
                            </span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                  {result?.truncated && (
                    <p className="border-t border-zinc-100 bg-zinc-50/70 px-3.5 py-1.5 text-[11px] text-zinc-500 dark:border-zinc-800/70 dark:bg-zinc-900/40 dark:text-zinc-400">
                      Showing {candidates.length} of {result.matched}. Keep typing to narrow it.
                    </p>
                  )}
                </div>
              ) : null}
            </>
          )}

          {/* ── What the letter will state ────────────────────────────────── */}
          {selected && (
            <div className="rounded-xl border border-zinc-200 bg-zinc-50/70 px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900/40">
              {factsLoading ? (
                <div className="py-1">
                  <div className="flex items-baseline justify-between text-[11.5px] text-zinc-500 dark:text-zinc-400">
                    <span>Reading the records…</span>
                    <span className="tabular-nums">{Math.round(factsProgress)}%</span>
                  </div>
                  <div
                    role="progressbar"
                    aria-label="Loading letter details"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(factsProgress)}
                    className="mt-2 h-1.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800"
                  >
                    <div
                      className="h-full rounded-full bg-orange-500 transition-[width] duration-200 ease-out motion-reduce:transition-none"
                      style={{ width: `${factsProgress}%` }}
                    />
                  </div>
                </div>
              ) : factsBlocked ? (
                <div className="flex items-start gap-2.5">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                  <div className="min-w-0 flex-1">
                    <p className="text-[12.5px] font-medium text-zinc-800 dark:text-zinc-200">
                      This letter can&rsquo;t be issued
                    </p>
                    <p className="mt-0.5 text-[12px] leading-relaxed text-zinc-500 dark:text-zinc-400">{factsBlocked}</p>
                  </div>
                </div>
              ) : facts ? (
                <>
                  <div className="flex items-center gap-2.5">
                    <Home className="h-4 w-4 shrink-0 text-orange-500" />
                    <p className="text-[12.5px] font-medium text-zinc-800 dark:text-zinc-200">The letter will state</p>
                  </div>
                  <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 border-t border-zinc-200/70 pt-3 dark:border-zinc-800/70 sm:grid-cols-[auto_1fr]">
                    {(
                      [
                        ['Worker', facts.employeeId ? `${facts.workerName} · ${facts.employeeId}` : facts.workerName],
                        ['Contracted since', facts.startDateLabel],
                        ['Team', facts.team],
                      ] as ReadonlyArray<readonly [string, string]>
                    ).map(([label, value]) => (
                      <React.Fragment key={label}>
                        <dt className="text-[11.5px] font-medium uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
                          {label}
                        </dt>
                        <dd className="mb-1 text-[12.5px] text-zinc-800 dark:text-zinc-200 sm:mb-0">{value}</dd>
                      </React.Fragment>
                    ))}
                  </dl>

                  <div className="mt-3 border-t border-zinc-200/70 pt-3 dark:border-zinc-800/70">
                    <p className="text-[11.5px] text-zinc-500 dark:text-zinc-400">{sourceLine}</p>
                    <div className="mt-2 space-y-2.5">
                      {ADDRESS_LETTER_FIELDS.map((field) => {
                        const label = ADDRESS_LETTER_FIELD_LABELS[field];
                        const onFile = facts.address[field];
                        const inputId = `address-letter-${field}`;
                        if (!blanks.has(field) && onFile) {
                          return (
                            <div key={field}>
                              <div className="text-[11px] font-medium uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
                                {label}
                              </div>
                              <div className="text-[12.5px] text-zinc-800 dark:text-zinc-200">{onFile}</div>
                            </div>
                          );
                        }
                        return (
                          <div key={field}>
                            <label
                              htmlFor={inputId}
                              className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-300"
                            >
                              <PenLine className="h-3 w-3" aria-hidden />
                              {label} — not on file
                            </label>
                            {field === 'country' ? (
                              <SmoothSelect
                                id={inputId}
                                aria-label={label}
                                value={fills.country ?? null}
                                placeholder="Pick a country…"
                                options={ADDRESS_LETTER_COUNTRIES.map((c) => ({ value: c, label: c }))}
                                onChange={(v) => setFills((f) => ({ ...f, country: v }))}
                                accent="orange"
                                align="start"
                                triggerClassName="mt-1 w-full"
                                disabled={generating}
                              />
                            ) : (
                              <Input
                                id={inputId}
                                value={fills[field] ?? ''}
                                maxLength={ADDRESS_LETTER_MAX_LENGTH[field]}
                                onChange={(e) => setFills((f) => ({ ...f, [field]: e.target.value }))}
                                placeholder={PLACEHOLDERS[field]}
                                disabled={generating}
                                className="mt-1 h-9 text-sm focus:border-orange-500 focus:ring-2 focus:ring-orange-500/20"
                              />
                            )}
                          </div>
                        );
                      })}
                    </div>
                    {facts.blanks.length > 0 && (
                      <p className="mt-2.5 text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">
                        Type only what the contractor gave you. What you type prints on the letter and is
                        recorded as entered by Accounting; it does not change the roster.
                      </p>
                    )}
                  </div>
                </>
              ) : null}
            </div>
          )}

          {/* ── Signing identity ──────────────────────────────────────────── */}
          {selected && facts && (
            signingBlocked ? (
              <div className="flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50/80 px-3 py-2.5 text-xs text-amber-900 dark:border-amber-500/40 dark:bg-amber-950/20 dark:text-amber-200">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  {!signature
                    ? 'No signature on file — set up your signature first.'
                    : 'Your signature is revoked — switch it back on to sign.'}
                </span>
              </div>
            ) : (
              <div className="flex items-center gap-3 rounded-xl border border-zinc-200 px-2 py-2 dark:border-zinc-700">
                {/* Ink is dark navy — the plate stays WHITE in dark mode. */}
                <div className="rounded-lg bg-white px-3 py-1.5">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={signature!.image_data_url} alt="Your signature" className="h-9 w-auto max-w-[150px] object-contain" />
                </div>
                <div className="min-w-0 text-[11px] leading-tight text-zinc-500 dark:text-zinc-400">
                  <div className="truncate font-medium text-zinc-700 dark:text-zinc-300">Signing as {signature!.owner_name}</div>
                  <div className="truncate">Accounting Team · {signature!.owner_email}</div>
                </div>
              </div>
            )
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => close(false)} disabled={generating}>
            Cancel
          </Button>
          {selected && facts && signingBlocked ? (
            <Button
              type="button"
              onClick={() => {
                close(false);
                onRequireSignature();
              }}
              className="gap-1.5 bg-orange-500 text-white hover:bg-orange-600"
            >
              Set up signature
            </Button>
          ) : (
            <Button
              type="button"
              onClick={() => void generate()}
              disabled={!selected || !facts || factsLoading || generating || missing.length > 0}
              title={missing.length > 0 ? `Fill in: ${missing.map((f) => ADDRESS_LETTER_FIELD_LABELS[f]).join(', ')}` : undefined}
              className="gap-1.5 bg-emerald-600 text-white hover:bg-emerald-700"
            >
              {generating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileSignature className="h-3.5 w-3.5" />}
              Issue &amp; sign
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
