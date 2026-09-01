'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  FileCheck2,
  FileSignature,
  Loader2,
  Search,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { formatDeptLabel } from '@/lib/departments/hsl-subdept';
import type {
  CoePreviewFacts,
  DocumentRequestRow,
  DocumentSignatureRow,
} from '@/lib/documents/types';

/** Mirrors CoeSearchCandidate (src/lib/documents/coe-admin.ts — server-side). */
interface Candidate {
  workEmail: string;
  name: string | null;
  department: string | null;
}

/** Two letters for the avatar tile: first + last word of the display name
 *  (master names are surname-first with a quoted nickname, so strip the
 *  punctuation first), falling back to the email. */
function initialsOf(name: string | null, email: string): string {
  const source = (name ?? '').replace(/["“”().,]/g, ' ').trim() || email;
  const words = source.split(/\s+/).filter((w) => /[a-z0-9]/i.test(w));
  if (words.length === 0) return email.slice(0, 2).toUpperCase();
  return (words[0][0] + (words.length > 1 ? words[words.length - 1][0] : '')).toUpperCase();
}

/**
 * Optimistic load progress for the facts fetch: ramps quickly, eases toward
 * ~92% and NEVER reaches 100 on prediction alone — the data landing completes
 * it by replacing the bar with the facts card (the payroll wizard's step-load
 * rule: a bar may not fill on prediction).
 */
function useOptimisticProgress(active: boolean): number {
  const [progress, setProgress] = useState(0);
  useEffect(() => {
    if (!active) {
      setProgress(0);
      return;
    }
    let p = 8;
    setProgress(p);
    const id = setInterval(() => {
      p += (92 - p) * 0.07;
      setProgress(p);
    }, 90);
    return () => clearInterval(id);
  }, [active]);
  return progress;
}

interface SearchResponse {
  candidates?: Candidate[];
  matched?: number;
  truncated?: boolean;
  tooShort?: boolean;
  error?: string | null;
}

/**
 * Accounting → Documents → "Generate COE": search an ACTIVE Global Master List
 * person, review the same facts card the employee-side request form shows
 * (resolved by the same server resolver), and generate + sign the certificate
 * in one action. The result is an ordinary `document_requests` COE row, so the
 * signed copy lands in the employee's Profile → Request Documents with the
 * usual notification — this dialog exists purely so non-technical employees
 * don't have to file the request themselves.
 *
 * A 412 from the generate call (no active signature) steers into the SAME
 * signature-capture dialog the Approve path uses, via `onRequireSignature`.
 * A sign failure AFTER the row was created is not an error state: the pending
 * row is real and the normal Approve button finishes it — the toast says so.
 */
export default function GenerateCoeDialog({
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
  const [facts, setFacts] = useState<CoePreviewFacts | null>(null);

  const [generating, setGenerating] = useState(false);

  const factsProgress = useOptimisticProgress(factsLoading);

  const signingBlocked = !signature || !signature.enabled;

  // A stale response must never overwrite a newer query's list.
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
        const res = await fetch(`/api/accounting/documents/coe/search?q=${encodeURIComponent(q)}`, {
          cache: 'no-store',
        });
        const json = (await res.json()) as SearchResponse;
        if (seq !== searchSeq.current) return;
        if (!res.ok) {
          setResult({ candidates: [], error: json.error || `Search failed (${res.status})` });
        } else {
          setResult(json);
        }
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
    setFactsLoading(true);
    try {
      const res = await fetch(
        `/api/accounting/documents/coe/preview?email=${encodeURIComponent(candidate.workEmail)}`,
        { cache: 'no-store' },
      );
      const json = (await res.json()) as { facts?: CoePreviewFacts; blocked?: string; error?: string };
      if (res.status === 422 && json.blocked) {
        setFactsBlocked(json.blocked);
        return;
      }
      if (!res.ok || !json.facts) throw new Error(json.error || 'Could not load the certificate details');
      setFacts(json.facts);
    } catch (e) {
      setFactsBlocked(e instanceof Error ? e.message : 'Could not load the certificate details');
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
    setGenerating(false);
  }, []);

  const close = useCallback(
    (o: boolean) => {
      if (!o) reset();
      onOpenChange(o);
    },
    [onOpenChange, reset],
  );

  const generate = async () => {
    if (!selected || !facts) return;
    setGenerating(true);
    try {
      const res = await fetch('/api/accounting/documents/coe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ work_email: selected.workEmail }),
      });
      const json = (await res.json()) as {
        row?: DocumentRequestRow;
        sign_error?: string | null;
        blocked?: string;
        error?: string;
      };
      if (res.status === 412) {
        // Same steering as the Approve path: capture a signature, come back.
        close(false);
        onRequireSignature();
        throw new Error(json.error || 'No active signature');
      }
      if (!res.ok || !json.row) {
        throw new Error(json.blocked || json.error || `Generate failed (${res.status})`);
      }
      const who = json.row.employee_name || json.row.employee_email;
      if (json.sign_error) {
        // The certificate exists as a pending row — say exactly that.
        toast.warning('Certificate generated, but not signed', {
          description: `${json.sign_error}. It is waiting in the queue — finish it with Approve & sign.`,
        });
      } else {
        toast.success('Certificate generated & signed', {
          description: `${who} can now download the signed COE from their profile.`,
        });
      }
      close(false);
      onGenerated();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not generate the certificate');
    } finally {
      setGenerating(false);
    }
  };

  const candidates = useMemo(() => result?.candidates ?? [], [result]);

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="flex max-h-[85dvh] flex-col overflow-hidden sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Generate a Certificate of Engagement</DialogTitle>
          <DialogDescription>
            Issue and sign a COE in one step. The signed copy goes to the employee&rsquo;s profile.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
          {/* ── Person picker ─────────────────────────────────────────────── */}
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
                  {/* Server-formatted already; formatDeptLabel is the unconditional
                      render chokepoint and a no-op on non-HSL labels. */}
                  {selected.department ? ` · ${formatDeptLabel(selected.department)}` : ''}
                </span>
              </div>
              <button
                type="button"
                onClick={() => {
                  setSelected(null);
                  setFacts(null);
                  setFactsBlocked(null);
                }}
                disabled={generating}
                aria-label="Pick a different employee"
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
                  aria-label="Search active employees"
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
                <p className="px-1 text-[12px] text-zinc-500 dark:text-zinc-400">
                  Keep typing, at least two characters.
                </p>
              ) : result && candidates.length === 0 && !searching ? (
                <p className="px-1 text-[12px] text-zinc-500 dark:text-zinc-400">
                  No match for &ldquo;{query.trim()}&rdquo;. Only active employees are listed.
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

          {/* ── Facts card — what the certificate will state ──────────────── */}
          {selected && (
            <div className="rounded-xl border border-zinc-200 bg-zinc-50/70 px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900/40">
              {factsLoading ? (
                <div className="py-1">
                  <div className="flex items-baseline justify-between text-[11.5px] text-zinc-500 dark:text-zinc-400">
                    <span>Preparing certificate details…</span>
                    <span className="tabular-nums">{Math.round(factsProgress)}%</span>
                  </div>
                  <div
                    role="progressbar"
                    aria-label="Loading certificate details"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(factsProgress)}
                    className="mt-2 h-1.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800"
                  >
                    {/* Optimistic ramp, capped under 100 — the facts card landing is
                        what completes it (wizard step-load rule). */}
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
                      This certificate can&rsquo;t be issued
                    </p>
                    <p className="mt-0.5 text-[12px] leading-relaxed text-zinc-500 dark:text-zinc-400">
                      {factsBlocked}
                    </p>
                  </div>
                </div>
              ) : facts ? (
                <>
                  <div className="flex items-center gap-2.5">
                    <FileCheck2 className="h-4 w-4 shrink-0 text-emerald-500" />
                    <p className="text-[12.5px] font-medium text-zinc-800 dark:text-zinc-200">
                      The certificate will state
                    </p>
                  </div>
                  <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 border-t border-zinc-200/70 pt-3 dark:border-zinc-800/70 sm:grid-cols-[auto_1fr]">
                    {(
                      [
                        ['Worker', facts.employeeId ? `${facts.workerName} · ${facts.employeeId}` : facts.workerName],
                        ['Engaged since', facts.startDateLabel],
                        ['Team', facts.team],
                        ['Hourly / OT', `${facts.hourlyRate} · ${facts.overtimeRate} per hour`],
                        ['Schedule', `${facts.weeklyHours} hours per week`],
                      ] as const
                    ).map(([label, value]) => (
                      <React.Fragment key={label}>
                        <dt className="text-[11.5px] font-medium uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
                          {label}
                        </dt>
                        <dd className="mb-1 text-[12.5px] text-zinc-800 dark:text-zinc-200 sm:mb-0">{value}</dd>
                      </React.Fragment>
                    ))}
                    <dt className="text-[11.5px] font-medium uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
                      Bonuses
                    </dt>
                    <dd className="text-[12.5px] leading-relaxed text-zinc-800 dark:text-zinc-200">
                      {facts.standardBonuses.length === 0 && facts.performanceBonuses.length === 0 ? (
                        <span className="text-zinc-400 dark:text-zinc-500">None they currently qualify for</span>
                      ) : (
                        <>
                          {facts.standardBonuses.map((b) => (
                            <div key={b.label}>
                              {b.label}: {b.amount}
                            </div>
                          ))}
                          <div>
                            Performance:{' '}
                            {facts.performanceBonuses.length > 0 ? (
                              facts.performanceBonuses
                                .map((b) => (b.amount ? `${b.label} (${b.amount})` : b.label))
                                .join(', ')
                            ) : (
                              <span className="text-zinc-400 dark:text-zinc-500">none assigned</span>
                            )}
                          </div>
                        </>
                      )}
                    </dd>
                  </dl>
                </>
              ) : null}
            </div>
          )}

          {/* ── Signing identity / block ──────────────────────────────────── */}
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
                {/* Signature ink is dark navy — the plate stays WHITE in dark mode
                    or the ink disappears (same rule as the signature manager card). */}
                <div className="rounded-lg bg-white px-3 py-1.5">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={signature!.image_data_url}
                    alt="Your signature"
                    className="h-9 w-auto max-w-[150px] object-contain"
                  />
                </div>
                <div className="min-w-0 text-[11px] leading-tight text-zinc-500 dark:text-zinc-400">
                  <div className="truncate font-medium text-zinc-700 dark:text-zinc-300">
                    Signing as {signature!.owner_name}
                  </div>
                  <div className="truncate">{signature!.title || 'Accounting Head'}</div>
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
              disabled={!selected || !facts || factsLoading || generating}
              className={cn('gap-1.5 bg-emerald-600 text-white hover:bg-emerald-700')}
            >
              {generating ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <FileSignature className="h-3.5 w-3.5" />
              )}
              Generate &amp; sign
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
