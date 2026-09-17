'use client';

/**
 * HR → MESA → FPU Classes → the Groups panel.
 *
 * Three states, in order, and the class moves through them once:
 *   1. not divided  — "N have a seat. How many per group?" → preview → confirm
 *   2. divided      — groups, leaders, and the weekly attendance grid
 *   3. closed       — the eligible / ineligible split, published and final
 *
 * Governing doc: docs/features/fpu-groups-attendance.md.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Users, Shuffle, Check, Crown, Lock, Loader2, AlertTriangle } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { formatDateOnly } from '@/lib/date-only';
import { fpuSessions } from '@/lib/mesa/fpu-sessions';
import { fpuAttendanceVerdict } from '@/lib/mesa/fpu-attendance';
import type { FpuClass } from '@/lib/mesa/fpu-class';
import { getHrTabCache, hrFpuGroupsKey, isHrTabCacheFresh, setHrTabCache } from '@/lib/hr/tab-cache';

interface Props {
  cls: FpuClass & { class_closed_on?: string | null; class_closed_by?: string | null };
  /** Approved seats — the population that gets divided. */
  seats: { id: string; email: string; full_name: string; status: string; attendance_override?: 'pass' | 'fail' | null }[];
  onChanged: () => Promise<void> | void;
}

type PreviewGroup = { groupNo: number; members: { enrollmentId: string; email: string; name: string }[] };

interface GroupsState {
  groups: {
    id: string;
    groupNo: number;
    leaderEnrollmentId: string | null;
    members: { enrollmentId: string; email: string; name: string; leftOn: string | null }[];
  }[];
  marks: { enrollmentId: string; sessionNo: number; present: boolean }[];
  migrated: boolean;
}

async function readJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`HTTP ${res.status} — non-JSON response`);
  }
}

async function post<T>(url: string, body: unknown, method: 'POST' | 'PATCH' = 'POST'): Promise<T> {
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' });
  const json = await readJson<T & { error?: string | null }>(res);
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json;
}

const short = (email: string) => email.split('@')[0] ?? email;

export default function FpuGroupsPanel({ cls, seats, onChanged }: Props) {
  // Seeded for PAINT so returning to the tab does not re-flash an empty panel —
  // but `migrated` is FORCED BACK TO TRUE on the seed. It gates the amber "run
  // the migration" notice below, so a cached copy of it would DECIDE, which is
  // the one thing this store forbids. Only the live answer may raise that notice.
  const [state, setState] = useState<GroupsState | null>(() => {
    const cached = getHrTabCache<GroupsState>(hrFpuGroupsKey(cls.id));
    return cached ? { ...cached, migrated: true } : null;
  });
  const [perGroup, setPerGroup] = useState('5');
  const [roll, setRoll] = useState(0);
  const [preview, setPreview] = useState<PreviewGroup[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [closeResult, setCloseResult] = useState<null | {
    eligible: { email: string; name: string; verdict: { reason: string } }[];
    ineligible: { email: string; name: string; verdict: { reason: string } }[];
    unmarkedTotal: number;
    confirmed: boolean;
  }>(null);

  const sessions = useMemo(() => fpuSessions(cls), [cls]);
  const closed = !!cls.class_closed_on;

  const load = useCallback(async () => {
    try {
      const json = await post<GroupsState>('/api/hr/fpu-classes/groups/list', { class_id: cls.id });
      setState(json);
      setError(null);
      // Every write path calls refreshAll -> load(), so a division, a leader
      // change or a mark re-stamps this entry rather than leaving a stale copy.
      setHrTabCache(hrFpuGroupsKey(cls.id), json);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load groups');
    }
  }, [cls.id]);

  useEffect(() => {
    if (isHrTabCacheFresh(hrFpuGroupsKey(cls.id))) return;
    void load();
  }, [load, cls.id]);

  const divided = (state?.groups.length ?? 0) > 0;

  const markBy = useMemo(() => {
    const m = new Map<string, Map<number, boolean>>();
    for (const k of state?.marks ?? []) {
      const inner = m.get(k.enrollmentId) ?? new Map<number, boolean>();
      inner.set(k.sessionNo, k.present);
      m.set(k.enrollmentId, inner);
    }
    return m;
  }, [state]);

  const runPreview = async (nextRoll = roll) => {
    setBusy(true);
    try {
      const json = await post<{ groups: PreviewGroup[] }>('/api/hr/fpu-classes/groups/preview', {
        class_id: cls.id,
        per_group: Number(perGroup),
        roll: nextRoll,
      });
      setPreview(json.groups);
      setRoll(nextRoll);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not build the preview');
      setPreview(null);
    } finally {
      setBusy(false);
    }
  };

  const confirmDivision = async () => {
    setBusy(true);
    try {
      await post('/api/hr/fpu-classes/groups/confirm', { class_id: cls.id, per_group: Number(perGroup), roll });
      toast.success('Groups confirmed', { description: 'Everyone can now see their group. Appoint a leader for each.' });
      setPreview(null);
      await load();
      await onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not confirm');
    } finally {
      setBusy(false);
    }
  };

  const setLeader = async (groupId: string, enrollmentId: string | null) => {
    setBusy(true);
    try {
      await post('/api/hr/fpu-classes/groups/leader', { group_id: groupId, enrollment_id: enrollmentId }, 'PATCH');
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not set the leader');
    } finally {
      setBusy(false);
    }
  };

  const mark = async (enrollmentId: string, sessionNo: number, present: boolean) => {
    setBusy(true);
    try {
      await post('/api/fpu-attendance', { enrollment_id: enrollmentId, session_no: sessionNo, present });
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not record attendance');
    } finally {
      setBusy(false);
    }
  };

  const runClose = async (confirm: boolean) => {
    setBusy(true);
    try {
      const json = await post<{
        eligible: { email: string; name: string; verdict: { reason: string } }[];
        ineligible: { email: string; name: string; verdict: { reason: string } }[];
        unmarkedTotal: number;
        toEnroll: { workEmail: string; name: string; since: string }[];
        alreadyMembers: { email: string }[];
      }>('/api/hr/fpu-classes/class-close', { class_id: cls.id, confirm });
      if (!confirm) {
        setCloseResult({ ...json, confirmed: false });
      } else {
        // MESA membership opens through the ONE route that mints accounts, per person.
        let ok = 0;
        for (const t of json.toEnroll) {
          try {
            await post('/api/toggle-mesa-member', { workEmail: t.workEmail, mesaMember: true, name: t.name, since: t.since });
            ok += 1;
          } catch {
            /* reported in aggregate below */
          }
        }
        toast.success(`Class closed — ${json.eligible.length} eligible, ${json.ineligible.length} not`, {
          description: `${ok} of ${json.toEnroll.length} opted in to MESA${json.alreadyMembers.length ? `, ${json.alreadyMembers.length} already members` : ''}.`,
        });
        setCloseResult({ ...json, confirmed: true });
        await load();
        await onChanged();
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not close the class');
    } finally {
      setBusy(false);
    }
  };

  if (state && !state.migrated) {
    return (
      <Card className="border-amber-200/80 bg-amber-50/50 dark:border-amber-500/30 dark:bg-amber-500/10">
        <CardContent className="px-5 py-4 text-xs leading-relaxed text-amber-900 dark:text-amber-100">
          Groups and attendance need their database migration — double-click{' '}
          <code>scripts/Apply FPU Groups migration.cmd</code>. It rehearses before it writes.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-lg border border-rose-200/80 bg-rose-50/70 px-4 py-2.5 text-xs text-rose-900 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-100">{error}</div>
      )}

      {!sessions.ok && (
        <div className="rounded-lg border border-amber-200/80 bg-amber-50/70 px-4 py-2.5 text-xs text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">
          {sessions.detail}
        </div>
      )}

      {/* ── 1. Divide ─────────────────────────────────────────────────────── */}
      {!divided && sessions.ok && (
        <Card className="border-teal-100/80 dark:border-teal-900/40">
          <CardContent className="space-y-4 p-5">
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <p className="text-sm font-semibold text-zinc-900 dark:text-white">
                  {seats.length} {seats.length === 1 ? 'person has' : 'people have'} a seat in this class.
                </p>
                <p className="mt-0.5 text-xs text-zinc-600 dark:text-zinc-400">
                  How many per group? The number is a target — a remainder is spread, never left alone.
                </p>
              </div>
              <label className="ml-auto">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">People per group</span>
                <Input type="number" min={2} max={50} value={perGroup} onChange={(e) => setPerGroup(e.target.value)} disabled={busy} className="mt-1 h-9 w-28" />
              </label>
              <Button type="button" size="sm" disabled={busy || seats.length === 0} onClick={() => void runPreview(0)} className="h-9 gap-1.5 bg-teal-600 text-white hover:bg-teal-700">
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Shuffle className="h-3.5 w-3.5" />}
                Divide
              </Button>
            </div>

            {preview && (
              <div className="space-y-3 border-t border-zinc-100 pt-4 dark:border-zinc-800">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-xs font-semibold text-zinc-700 dark:text-zinc-200">
                    {preview.length} {preview.length === 1 ? 'group' : 'groups'} — nothing is saved yet.
                  </p>
                  <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void runPreview(roll + 1)} className="ml-auto h-7 gap-1 text-[11px]">
                    <Shuffle className="h-3 w-3" /> Shuffle again
                  </Button>
                  <Button type="button" size="sm" disabled={busy} onClick={() => void confirmDivision()} className="h-7 gap-1 bg-emerald-600 text-[11px] text-white hover:bg-emerald-700">
                    <Check className="h-3 w-3" /> Confirm these groups
                  </Button>
                </div>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {preview.map((g) => (
                    <div key={g.groupNo} className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                      <p className="text-xs font-bold text-zinc-900 dark:text-white">Group {g.groupNo} · {g.members.length}</p>
                      <ul className="mt-1.5 space-y-0.5 text-[11.5px] text-zinc-600 dark:text-zinc-400">
                        {g.members.map((m) => <li key={m.enrollmentId} className="truncate">{m.name}</li>)}
                      </ul>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── 2. Groups, leaders, attendance ────────────────────────────────── */}
      {divided && state && (
        <div className="space-y-3">
          {state.groups.map((g) => (
            <Card key={g.id} className="border-teal-100/80 dark:border-teal-900/40">
              <CardContent className="p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Users className="h-4 w-4 text-teal-600 dark:text-teal-300" />
                  <h4 className="text-sm font-bold text-zinc-900 dark:text-white">Group {g.groupNo}</h4>
                  <span className="text-xs text-zinc-500">{g.members.filter((m) => !m.leftOn).length} people</span>
                  {!closed && (
                    <label className="ml-auto flex items-center gap-1.5 text-[11px] text-zinc-600 dark:text-zinc-400">
                      <Crown className="h-3 w-3 text-amber-500" /> Leader
                      <select
                        value={g.leaderEnrollmentId ?? ''}
                        disabled={busy}
                        onChange={(e) => void setLeader(g.id, e.target.value || null)}
                        className="h-7 rounded-md border border-zinc-200 bg-white px-2 text-[11px] dark:border-zinc-700 dark:bg-zinc-900"
                      >
                        <option value="">Not appointed</option>
                        {g.members.filter((m) => !m.leftOn).map((m) => (
                          <option key={m.enrollmentId} value={m.enrollmentId}>{m.name}</option>
                        ))}
                      </select>
                    </label>
                  )}
                </div>

                {sessions.ok && (
                  <div className="mt-3 overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead className="text-[10.5px] uppercase tracking-wide text-zinc-500">
                        <tr>
                          <th className="py-1.5 pr-3">Member</th>
                          {sessions.sessions.map((s) => (
                            <th key={s.no} className="px-1.5 py-1.5 text-center" title={formatDateOnly(s.date)}>{s.no}</th>
                          ))}
                          <th className="px-2 py-1.5">Verdict</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                        {g.members.filter((m) => !m.leftOn).map((m) => {
                          const mine = markBy.get(m.enrollmentId) ?? new Map<number, boolean>();
                          const seat = seats.find((s) => s.id === m.enrollmentId);
                          const v = fpuAttendanceVerdict({ sessionCount: sessions.sessions.length, marks: mine, override: seat?.attendance_override ?? null });
                          return (
                            <tr key={m.enrollmentId}>
                              <td className="py-1.5 pr-3">
                                <span className="font-medium text-zinc-800 dark:text-zinc-200">{m.name}</span>
                                {g.leaderEnrollmentId === m.enrollmentId && <Crown className="ml-1 inline h-3 w-3 text-amber-500" />}
                              </td>
                              {sessions.sessions.map((s) => {
                                const val = mine.get(s.no);
                                return (
                                  <td key={s.no} className="px-1.5 py-1.5 text-center">
                                    <button
                                      type="button"
                                      disabled={busy || closed}
                                      title={val === undefined ? 'Not marked' : val ? 'Present' : 'Absent'}
                                      onClick={() => void mark(m.enrollmentId, s.no, val !== true)}
                                      className={cn(
                                        'h-5 w-5 rounded border text-[10px] font-bold transition-colors',
                                        val === true && 'border-emerald-300 bg-emerald-100 text-emerald-700 dark:border-emerald-600 dark:bg-emerald-900/50 dark:text-emerald-200',
                                        val === false && 'border-rose-300 bg-rose-100 text-rose-700 dark:border-rose-600 dark:bg-rose-900/50 dark:text-rose-200',
                                        val === undefined && 'border-dashed border-zinc-300 text-zinc-400 dark:border-zinc-700',
                                        closed && 'cursor-default opacity-70',
                                      )}
                                    >
                                      {val === true ? '✓' : val === false ? '✕' : ''}
                                    </button>
                                  </td>
                                );
                              })}
                              <td className={cn('px-2 py-1.5 text-[11px]', v.outcome === 'eligible' ? 'text-emerald-700 dark:text-emerald-300' : 'text-amber-700 dark:text-amber-300')} title={v.reason}>
                                {v.outcome === 'eligible' ? 'Eligible' : 'Not eligible'}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}

          {/* ── 3. Close the class ──────────────────────────────────────────── */}
          {!closed ? (
            <Card className="border-zinc-200 dark:border-zinc-800">
              <CardContent className="space-y-3 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Lock className="h-4 w-4 text-zinc-500" />
                  <p className="text-sm font-semibold text-zinc-900 dark:text-white">Close the class</p>
                  <p className="text-xs text-zinc-600 dark:text-zinc-400">
                    Publishes the eligible list and opens MESA for them. Attendance becomes final.
                  </p>
                  <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void runClose(false)} className="ml-auto h-7 text-[11px]">
                    Preview the split
                  </Button>
                </div>
                {closeResult && !closeResult.confirmed && (
                  <div className="space-y-2 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                    {closeResult.unmarkedTotal > 0 && (
                      <p className="flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-300">
                        <AlertTriangle className="h-3.5 w-3.5" />
                        {closeResult.unmarkedTotal} attendance {closeResult.unmarkedTotal === 1 ? 'cell is' : 'cells are'} still unmarked — those people fail unless the leader fills them in.
                      </p>
                    )}
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div>
                        <p className="text-[11px] font-bold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">Eligible · {closeResult.eligible.length}</p>
                        <ul className="mt-1 space-y-0.5 text-[11.5px] text-zinc-600 dark:text-zinc-400">
                          {closeResult.eligible.map((p) => <li key={p.email} className="truncate">{p.name}</li>)}
                        </ul>
                      </div>
                      <div>
                        <p className="text-[11px] font-bold uppercase tracking-wide text-rose-700 dark:text-rose-300">Not eligible · {closeResult.ineligible.length}</p>
                        <ul className="mt-1 space-y-0.5 text-[11.5px] text-zinc-600 dark:text-zinc-400">
                          {closeResult.ineligible.map((p) => <li key={p.email} className="truncate" title={p.verdict.reason}>{p.name} — {p.verdict.reason}</li>)}
                        </ul>
                      </div>
                    </div>
                    <div className="flex justify-end">
                      <Button type="button" size="sm" disabled={busy} onClick={() => void runClose(true)} className="h-7 gap-1 bg-rose-600 text-[11px] text-white hover:bg-rose-700">
                        <Lock className="h-3 w-3" /> Close the class and open MESA for {closeResult.eligible.length}
                      </Button>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          ) : (
            <Card className="border-emerald-200/80 bg-emerald-50/40 dark:border-emerald-900/50 dark:bg-emerald-950/20">
              <CardContent className="px-4 py-3 text-xs text-emerald-900 dark:text-emerald-100">
                Class closed {formatDateOnly(cls.class_closed_on)}
                {cls.class_closed_by ? ` by ${short(cls.class_closed_by)}` : ''}. The eligible were enrolled in MESA and their ₱100 deduction runs from{' '}
                {formatDateOnly(cls.class_ends_on)}. Attendance is final.
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
