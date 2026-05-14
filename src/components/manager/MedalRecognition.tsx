'use client';

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Lock, Eye } from 'lucide-react';
import { cn } from '@/lib/utils';

// ─── Types ────────────────────────────────────────────────────────────────────

export type MedalType = 'commend' | 'flag';

export const MEDALS: Record<MedalType, {
  emoji: string;
  emojiFilter?: string;
  label: string;
  sublabel: string;
  bgClass: string;
  ringClass: string;
  textClass: string;
}> = {
  commend: {
    emoji: '🚩',
    emojiFilter: 'hue-rotate(120deg)',
    label: 'Commendation',
    sublabel: 'Recognizing great work',
    bgClass: 'bg-emerald-50 dark:bg-emerald-900/20',
    ringClass: 'ring-emerald-300/50 dark:ring-emerald-600/30',
    textClass: 'text-emerald-700 dark:text-emerald-300',
  },
  flag: {
    emoji: '🚩',
    label: 'Flag for review',
    sublabel: 'Noting a concern',
    bgClass: 'bg-rose-50 dark:bg-rose-900/20',
    ringClass: 'ring-rose-300/50 dark:ring-rose-600/30',
    textClass: 'text-rose-700 dark:text-rose-300',
  },
};

const MEDAL_ORDER: MedalType[] = ['commend', 'flag'];

export interface MedalRecord {
  id: string;
  employee_email: string;
  employee_name: string | null;
  medal_type: MedalType;
  note: string | null;
  is_private: boolean;
  awarded_by: string;
  awarded_at: string;
}

// ─── Context ──────────────────────────────────────────────────────────────────

interface MedalCtx {
  medals: Record<string, MedalRecord[]>;
  draggedMedal: MedalType | null;
  setDraggedMedal: (t: MedalType | null) => void;
  dragOverEmail: string | null;
  setDragOverEmail: (e: string | null) => void;
  openAwardForDrop: (email: string, name: string | null) => void;
}

const Ctx = createContext<MedalCtx | null>(null);

export function useMedalCtx(): MedalCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useMedalCtx must be inside MedalProvider');
  return c;
}

// ─── Provider ─────────────────────────────────────────────────────────────────

interface AwardTarget { email: string; name: string | null; }

export function MedalProvider({
  viewerEmail,
  memberEmails,
  children,
}: {
  viewerEmail: string | null;
  memberEmails: string[];
  children: React.ReactNode;
}) {
  const [medals, setMedals] = useState<Record<string, MedalRecord[]>>({});
  const [draggedMedal, setDraggedMedal] = useState<MedalType | null>(null);
  const [dragOverEmail, setDragOverEmail] = useState<string | null>(null);
  const [awardTarget, setAwardTarget] = useState<AwardTarget | null>(null);
  const [pendingMedal, setPendingMedal] = useState<MedalType | null>(null);
  const [note, setNote] = useState('');
  const [isPrivate, setIsPrivate] = useState(true);
  const [saving, setSaving] = useState(false);

  const emailsKey = [...memberEmails].sort().join(',');
  useEffect(() => {
    if (!memberEmails.length) return;
    void (async () => {
      try {
        const res = await fetch(`/api/manager/medals?emails=${encodeURIComponent(memberEmails.join(','))}`);
        if (!res.ok) return;
        const data = (await res.json()) as MedalRecord[];
        const map: Record<string, MedalRecord[]> = {};
        for (const r of data) {
          (map[r.employee_email] ??= []).push(r);
        }
        setMedals(map);
      } catch { /* silent */ }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emailsKey]);

  const openAwardForDrop = useCallback((email: string, name: string | null) => {
    if (!draggedMedal) return;
    setPendingMedal(draggedMedal);
    setAwardTarget({ email, name });
    setNote('');
    setIsPrivate(true);
    setDraggedMedal(null);
    setDragOverEmail(null);
  }, [draggedMedal]);

  const closeDialog = useCallback(() => {
    setAwardTarget(null);
    setPendingMedal(null);
    setNote('');
    setIsPrivate(true);
  }, []);

  const handleAward = useCallback(async () => {
    if (!awardTarget || !pendingMedal || !viewerEmail) return;
    setSaving(true);
    try {
      const res = await fetch('/api/manager/medals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          employee_email: awardTarget.email,
          employee_name: awardTarget.name,
          medal_type: pendingMedal,
          note: note.trim() || null,
          is_private: isPrivate,
        }),
      });
      if (res.ok) {
        const record = (await res.json()) as MedalRecord;
        setMedals(prev => ({
          ...prev,
          [awardTarget.email]: [record, ...(prev[awardTarget.email] ?? [])],
        }));
      }
    } catch { /* silent */ }
    setSaving(false);
    closeDialog();
  }, [awardTarget, pendingMedal, viewerEmail, note, isPrivate, closeDialog]);

  return (
    <Ctx.Provider value={{ medals, draggedMedal, setDraggedMedal, dragOverEmail, setDragOverEmail, openAwardForDrop }}>
      {children}

      {/* ── Award dialog ─────────────────────────────────────────────── */}
      <AnimatePresence>
        {awardTarget && pendingMedal && (
          <motion.div
            key="medal-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-[2px]"
            onClick={(e) => { if (e.target === e.currentTarget) closeDialog(); }}
          >
            <motion.div
              key="medal-dialog"
              initial={{ scale: 0.93, opacity: 0, y: 12 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.93, opacity: 0, y: 8 }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
              className="w-full max-w-sm rounded-2xl border border-zinc-200 bg-white p-5 shadow-2xl dark:border-zinc-800 dark:bg-zinc-950"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="mb-4 flex items-center gap-3">
                <div className={cn(
                  'flex h-12 w-12 shrink-0 items-center justify-center rounded-xl ring-1 shadow-sm text-2xl',
                  MEDALS[pendingMedal].bgClass,
                  MEDALS[pendingMedal].ringClass,
                )}>
                  <span style={{ filter: MEDALS[pendingMedal].emojiFilter }}>
                    {MEDALS[pendingMedal].emoji}
                  </span>
                </div>
                <div>
                  <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                    {MEDALS[pendingMedal].label}
                  </div>
                  <div className="text-xs text-zinc-500 dark:text-zinc-400">
                    {MEDALS[pendingMedal].sublabel} ·{' '}
                    <span className="font-medium text-zinc-700 dark:text-zinc-300">
                      {awardTarget.name ?? awardTarget.email}
                    </span>
                  </div>
                </div>
              </div>

              <label className="mb-1.5 flex items-baseline gap-1.5 text-[11px] font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                Note
                <span className="normal-case tracking-normal font-normal text-zinc-400 dark:text-zinc-600">
                  optional
                </span>
              </label>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void handleAward();
                  if (e.key === 'Escape') closeDialog();
                }}
                placeholder={
                  pendingMedal === 'commend'
                    ? 'What stood out? A specific win, trait, or moment worth remembering…'
                    : "What's the concern? Be specific and constructive…"
                }
                rows={3}
                autoFocus
                className="w-full resize-none rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2.5 text-sm text-zinc-800 placeholder:text-zinc-400 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-200 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:placeholder:text-zinc-600 dark:focus:border-blue-700 dark:focus:ring-blue-900/50"
              />
              <p className="mt-1 text-[10px] text-zinc-400 dark:text-zinc-600">⌘↵ to save</p>

              <div className="mt-3 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setIsPrivate(true)}
                  title="Private — only visible in your manager dashboard"
                  className={cn(
                    'flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] font-medium transition-colors',
                    isPrivate
                      ? 'border-zinc-300 bg-zinc-100 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200'
                      : 'border-zinc-200 bg-white text-zinc-400 hover:border-zinc-300 hover:text-zinc-500 dark:border-zinc-800 dark:bg-transparent dark:text-zinc-600 dark:hover:text-zinc-400',
                  )}
                >
                  <Lock className="h-3.5 w-3.5 shrink-0" />
                  Private
                </button>
                <button
                  type="button"
                  onClick={() => setIsPrivate(false)}
                  title="Shared — employee will be able to see this"
                  className={cn(
                    'flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] font-medium transition-colors',
                    !isPrivate
                      ? 'border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-700 dark:bg-blue-950/40 dark:text-blue-300'
                      : 'border-zinc-200 bg-white text-zinc-400 hover:border-zinc-300 hover:text-zinc-500 dark:border-zinc-800 dark:bg-transparent dark:text-zinc-600 dark:hover:text-zinc-400',
                  )}
                >
                  <Eye className="h-3.5 w-3.5 shrink-0" />
                  Share
                </button>
                <span className="ml-1 text-[10px] text-zinc-400 dark:text-zinc-600">
                  {isPrivate ? 'only you can see this' : 'employee can see this'}
                </span>
              </div>

              <div className="mt-4 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={closeDialog}
                  className="rounded-lg px-3 py-1.5 text-xs font-medium text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800/60"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void handleAward()}
                  disabled={saving}
                  className={cn(
                    'rounded-lg px-4 py-1.5 text-xs font-semibold text-white shadow-sm transition disabled:opacity-60',
                    pendingMedal === 'commend'
                      ? 'bg-gradient-to-r from-emerald-500 to-emerald-600 hover:from-emerald-600 hover:to-emerald-700'
                      : 'bg-gradient-to-r from-rose-500 to-rose-600 hover:from-rose-600 hover:to-rose-700',
                  )}
                >
                  {saving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </Ctx.Provider>
  );
}

// ─── Medal Palette ────────────────────────────────────────────────────────────

export function MedalPalette() {
  const { setDraggedMedal } = useMedalCtx();

  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-zinc-200/80 bg-white/70 px-3 py-2 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/50">
      <span className="mr-1.5 select-none text-[11px] font-medium uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
        Recognize
      </span>
      {MEDAL_ORDER.map((type) => {
        const { emoji, label, bgClass, ringClass } = MEDALS[type];
        return (
          <button
            key={type}
            type="button"
            draggable
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = 'copy';
              e.dataTransfer.setData('text/medal_type', type);
              setDraggedMedal(type);
            }}
            onDragEnd={() => setDraggedMedal(null)}
            title={`Drag to award: ${label}`}
            className={cn(
              'cursor-grab select-none rounded-lg px-2 py-1 text-base ring-1 transition-all hover:scale-110 active:cursor-grabbing active:scale-95',
              bgClass, ringClass,
            )}
          >
            <span style={{ filter: MEDALS[type].emojiFilter }}>{emoji}</span>
          </button>
        );
      })}
      <span className="ml-1 hidden select-none text-[10px] text-zinc-400/70 dark:text-zinc-600 sm:block">
        drag to an employee
      </span>
    </div>
  );
}

// ─── Medal Badges (shown next to employee name) ───────────────────────────────

export function MedalBadges({ email }: { email: string | null | undefined }) {
  const { medals } = useMedalCtx();
  const [openId, setOpenId] = useState<string | null>(null);

  if (!email) return null;
  const list = medals[email] ?? [];
  if (list.length === 0) return null;

  // Show most recent of each type
  const deduped = new Map<MedalType, MedalRecord>();
  for (const r of list) {
    if (!deduped.has(r.medal_type)) deduped.set(r.medal_type, r);
  }

  return (
    <span
      className="relative inline-flex items-center gap-0.5 ml-1.5"
      onClick={(e) => e.stopPropagation()}
    >
      {[...deduped.entries()].map(([type, record]) => {
        const { emoji, label, bgClass, ringClass, textClass } = MEDALS[type];
        const isOpen = openId === record.id;
        return (
          <span key={type} className="relative">
            <button
              type="button"
              onClick={() => setOpenId(isOpen ? null : record.id)}
              title={record.note ? `${label}: ${record.note}` : label}
              className={cn(
                'rounded-md px-1 py-0.5 text-xs ring-1 transition-all hover:scale-110 leading-none',
                bgClass, ringClass,
              )}
            >
              <span style={{ filter: MEDALS[type].emojiFilter }}>{emoji}</span>
            </button>

            <AnimatePresence>
              {isOpen && (
                <>
                  <span
                    className="fixed inset-0 z-30"
                    onClick={(e) => { e.stopPropagation(); setOpenId(null); }}
                  />
                  <motion.span
                    key="popover"
                    initial={{ opacity: 0, scale: 0.92, y: 4 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.92, y: 2 }}
                    transition={{ duration: 0.15, ease: 'easeOut' }}
                    className="absolute left-1/2 top-full z-40 mt-1.5 w-52 -translate-x-1/2 rounded-xl border border-zinc-200 bg-white p-3 shadow-xl dark:border-zinc-700 dark:bg-zinc-900"
                  >
                    <span className={cn('flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider', textClass)}>
                      <span style={{ filter: MEDALS[type].emojiFilter }}>{emoji}</span>
                      {label}
                    </span>
                    {record.note && (
                      <span className="mt-1 block text-xs leading-relaxed text-zinc-700 dark:text-zinc-300">
                        &ldquo;{record.note}&rdquo;
                      </span>
                    )}
                    <span className="mt-1.5 block text-[10px] text-zinc-400 dark:text-zinc-600">
                      by {record.awarded_by} · {new Date(record.awarded_at).toLocaleDateString()}
                    </span>
                  </motion.span>
                </>
              )}
            </AnimatePresence>
          </span>
        );
      })}
    </span>
  );
}
