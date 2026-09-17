'use client';

/**
 * Employee → MESA → FPU Class → "My group".
 *
 * Every member sees who they are with. The LEADER additionally gets one column
 * per session and marks each groupmate present or absent — the only place in
 * this app where an ordinary employee writes a row about a colleague, which is
 * why the server re-checks leadership on every single mark and refuses a leader
 * marking themselves.
 *
 * Governing doc: docs/features/fpu-groups-attendance.md.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Users, Crown, Loader2, Check, X } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { formatDateOnly } from '@/lib/date-only';

interface GroupState {
  group: {
    id: string;
    classId: string;
    groupNo: number;
    classLabel: string | null;
    isLeader: boolean;
    myEnrollmentId: string;
    members: { enrollmentId: string; email: string; name: string; isLeader: boolean }[];
    sessions: { no: number; date: string }[];
    sessionsUnavailable: string | null;
    markable: number[];
    marks: { enrollmentId: string; sessionNo: number; present: boolean; markedBy: string }[];
  } | null;
  migrated: boolean;
  error: string | null;
}

export default function EmployeeFpuGroup({ employeeEmail }: { employeeEmail: string }) {
  const [state, setState] = useState<GroupState | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/fpu-attendance?email=${encodeURIComponent(employeeEmail)}`, { cache: 'no-store' });
      const text = await res.text();
      const json = JSON.parse(text) as GroupState;
      setState(json);
    } catch {
      setState({ group: null, migrated: true, error: null });
    }
  }, [employeeEmail]);

  useEffect(() => {
    void load();
  }, [load]);

  // No group yet is the normal state for most of a class's life — say nothing
  // rather than showing an empty shell.
  if (!state || !state.group) return null;
  const g = state.group;

  const markOf = (enrollmentId: string, sessionNo: number) =>
    g.marks.find((m) => m.enrollmentId === enrollmentId && m.sessionNo === sessionNo)?.present;

  const mark = async (enrollmentId: string, sessionNo: number, present: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch('/api/fpu-attendance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enrollment_id: enrollmentId, session_no: sessionNo, present }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      await load();
    } catch (e) {
      toast.error('Could not record attendance', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="border-teal-100/80 shadow-sm dark:border-teal-900/40">
      <CardContent className="p-5">
        <div className="flex flex-wrap items-center gap-2">
          <Users className="h-4 w-4 text-teal-600 dark:text-teal-300" />
          <h3 className="text-sm font-bold text-zinc-900 dark:text-white">Group {g.groupNo}</h3>
          {g.isLeader && (
            <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-amber-700 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-200">
              <Crown className="h-3 w-3" /> You lead this group
            </span>
          )}
          <span className="ml-auto text-xs text-zinc-500 dark:text-zinc-400">{g.members.length} people</span>
        </div>

        {!g.isLeader ? (
          <ul className="mt-3 divide-y divide-zinc-100 text-sm dark:divide-zinc-800">
            {g.members.map((m) => (
              <li key={m.enrollmentId} className="flex flex-wrap items-center gap-2 py-2">
                <span className="font-medium text-zinc-800 dark:text-zinc-200">{m.name}</span>
                {m.isLeader && <Crown className="h-3 w-3 text-amber-500" aria-label="Group leader" />}
                <a href={`mailto:${m.email}`} className="ml-auto font-mono text-[11.5px] text-zinc-500 hover:text-teal-700 dark:text-zinc-400">
                  {m.email}
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <>
            <p className="mt-2 text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">
              Mark each person present or absent after every session. Missing even one session makes someone
              ineligible for MESA, so an unmarked week counts against them — HR records your own attendance.
            </p>
            {g.sessionsUnavailable ? (
              <p className="mt-3 text-xs text-amber-700 dark:text-amber-300">{g.sessionsUnavailable}</p>
            ) : (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="text-[10.5px] uppercase tracking-wide text-zinc-500">
                    <tr>
                      <th className="py-1.5 pr-3">Member</th>
                      {g.sessions.map((s) => (
                        <th key={s.no} className="px-1.5 py-1.5 text-center" title={formatDateOnly(s.date)}>
                          {s.no}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                    {g.members.map((m) => {
                      const isMe = m.enrollmentId === g.myEnrollmentId;
                      return (
                        <tr key={m.enrollmentId}>
                          <td className="py-1.5 pr-3">
                            <span className={cn('font-medium', isMe ? 'text-zinc-500 dark:text-zinc-400' : 'text-zinc-800 dark:text-zinc-200')}>
                              {m.name}
                            </span>
                            {isMe && <span className="ml-1 text-[10px] text-zinc-400">HR marks you</span>}
                          </td>
                          {g.sessions.map((s) => {
                            const val = markOf(m.enrollmentId, s.no);
                            const open = g.markable.includes(s.no) && !isMe;
                            return (
                              <td key={s.no} className="px-1.5 py-1.5 text-center">
                                <div className="inline-flex gap-0.5">
                                  <button
                                    type="button"
                                    disabled={!open || busy}
                                    onClick={() => void mark(m.enrollmentId, s.no, true)}
                                    title={open ? 'Present' : 'This session has not happened yet'}
                                    className={cn(
                                      'flex h-5 w-5 items-center justify-center rounded border transition-colors',
                                      val === true
                                        ? 'border-emerald-400 bg-emerald-100 text-emerald-700 dark:border-emerald-600 dark:bg-emerald-900/50 dark:text-emerald-200'
                                        : 'border-zinc-200 text-zinc-300 hover:border-emerald-300 dark:border-zinc-700',
                                      !open && 'cursor-not-allowed opacity-40',
                                    )}
                                  >
                                    <Check className="h-3 w-3" />
                                  </button>
                                  <button
                                    type="button"
                                    disabled={!open || busy}
                                    onClick={() => void mark(m.enrollmentId, s.no, false)}
                                    title={open ? 'Absent' : 'This session has not happened yet'}
                                    className={cn(
                                      'flex h-5 w-5 items-center justify-center rounded border transition-colors',
                                      val === false
                                        ? 'border-rose-400 bg-rose-100 text-rose-700 dark:border-rose-600 dark:bg-rose-900/50 dark:text-rose-200'
                                        : 'border-zinc-200 text-zinc-300 hover:border-rose-300 dark:border-zinc-700',
                                      !open && 'cursor-not-allowed opacity-40',
                                    )}
                                  >
                                    <X className="h-3 w-3" />
                                  </button>
                                </div>
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {busy && (
                  <p className="mt-2 inline-flex items-center gap-1 text-[11px] text-zinc-500">
                    <Loader2 className="h-3 w-3 animate-spin" /> Saving
                  </p>
                )}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
