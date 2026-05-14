'use client';

import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Inbox } from 'lucide-react';

interface Commendation {
  id: string;
  note: string | null;
  awarded_by: string;
  awarded_at: string;
}

const FLAG_FILTER = 'hue-rotate(120deg)';

export default function EmployeeReports({ employeeEmail }: { employeeEmail: string }) {
  const [items, setItems] = useState<Commendation[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      try {
        const res = await fetch('/api/employee/commendations');
        if (res.ok) setItems((await res.json()) as Commendation[]);
      } catch { /* silent */ }
      setLoading(false);
    })();
  }, [employeeEmail]);

  return (
    <div className="flex flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <header>
        <h2 className="bg-gradient-to-r from-orange-600 via-zinc-900 to-zinc-900 bg-clip-text text-xl font-bold tracking-tight text-transparent dark:from-orange-400 dark:via-white dark:to-white">
          Reports
        </h2>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Commendations your manager has chosen to share with you.
        </p>
      </header>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-orange-500 border-t-transparent" />
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-zinc-200/80 bg-white py-20 text-center dark:border-zinc-800/80 dark:bg-zinc-950/40">
          <Inbox className="h-8 w-8 text-zinc-300 dark:text-zinc-700" />
          <p className="text-sm font-medium text-zinc-500 dark:text-zinc-400">No commendations yet</p>
          <p className="max-w-xs text-xs text-zinc-400 dark:text-zinc-600">
            When your manager shares a commendation with you it will appear here.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <AnimatePresence initial={false}>
            {items.map((item, idx) => (
              <motion.div
                key={item.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.22, delay: Math.min(idx * 0.04, 0.2), ease: 'easeOut' }}
                className="rounded-2xl border border-zinc-200/80 bg-white px-5 py-4 dark:border-zinc-800/80 dark:bg-zinc-950/40"
              >
                <div className="flex items-start gap-3">
                  <span
                    className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-base ring-1 ring-emerald-200/60 dark:bg-emerald-900/20 dark:ring-emerald-700/30"
                    style={{ filter: FLAG_FILTER }}
                    aria-hidden
                  >
                    🚩
                  </span>
                  <div className="min-w-0 flex-1">
                    {item.note ? (
                      <p className="text-sm leading-relaxed text-zinc-800 dark:text-zinc-200">
                        &ldquo;{item.note}&rdquo;
                      </p>
                    ) : (
                      <p className="text-sm italic text-zinc-400 dark:text-zinc-600">
                        No note left.
                      </p>
                    )}
                    <p className="mt-2 text-[11px] text-zinc-400 dark:text-zinc-600">
                      From <span className="font-medium text-zinc-500 dark:text-zinc-400">{item.awarded_by}</span>
                      {' · '}
                      {new Date(item.awarded_at).toLocaleDateString('en-US', {
                        month: 'short', day: 'numeric', year: 'numeric',
                      })}
                    </p>
                  </div>
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}
