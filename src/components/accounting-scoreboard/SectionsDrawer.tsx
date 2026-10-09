'use client';

/**
 * Below md the section tabs live in this drawer, behind the header's burger (Kane, 2026-10-01: "The
 * mobile view please make sure the tabs are in burger"). From md up the tab row shows instead and the
 * drawer never opens. The mechanics are the dashboard shell's (ui-standards § 1.1, § 2, § 3.1, § 16):
 * a left drawer over a backdrop, `id` + role="navigation", Escape closes, the close-X is an outline icon
 * Button. Each section carries its stop light from the same summarizeSection call the Overview cards
 * make, so the menu and the cards can never disagree.
 */

import { useEffect, useRef } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { X, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { LIGHT_LABEL, type Light } from '@/lib/accounting-scoreboard/stoplight';
import { BrandMark, EASE_TAB, LIGHT_STYLE } from './shared';

/** The burger's `aria-controls` target (ui-standards § 2: `<surface>-sidebar-nav`). */
export const SECTIONS_NAV_ID = 'acct-sb-sidebar-nav';

export interface DrawerItem<K extends string> {
  key: K;
  label: string;
  icon: LucideIcon;
  /** The section's stop light for the week on screen; null for Overview and Setup. */
  light: Light | null;
  /** Starts a new group, drawn as a hairline above it. */
  divided?: boolean;
}

export function SectionsDrawer<K extends string>({
  open,
  items,
  active,
  email,
  onSelect,
  onClose,
}: {
  open: boolean;
  items: DrawerItem<K>[];
  active: K;
  email: string;
  onSelect: (key: K) => void;
  onClose: () => void;
}) {
  const reduce = useReducedMotion() ?? false;
  const activeRef = useRef<HTMLButtonElement>(null);

  // Opening puts focus on the tab you are on, so a keyboard user starts where they are.
  useEffect(() => {
    if (open) activeRef.current?.focus();
  }, [open]);

  return (
    <AnimatePresence>
      {open ? (
        <motion.button
          key="backdrop"
          type="button"
          tabIndex={-1}
          aria-label="Close sections menu"
          className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px] md:hidden"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          onClick={onClose}
        />
      ) : null}
      {open ? (
        <motion.aside
          key="drawer"
          id={SECTIONS_NAV_ID}
          role="navigation"
          aria-label="Scoreboard sections"
          className="fixed inset-y-0 left-0 z-50 flex w-[min(20rem,86vw)] flex-col border-r border-orange-100/80 bg-white shadow-2xl shadow-black/25 dark:border-zinc-800 dark:bg-zinc-950 md:hidden"
          // Reduced motion keeps the signal and drops the travel (ui-standards § 16).
          initial={reduce ? { opacity: 0 } : { x: '-100%' }}
          animate={reduce ? { opacity: 1 } : { x: 0 }}
          exit={reduce ? { opacity: 0, transition: { duration: 0.12 } } : { x: '-100%', transition: { duration: 0.2, ease: EASE_TAB } }}
          transition={{ duration: reduce ? 0.15 : 0.3, ease: EASE_TAB }}
        >
          <div className="flex shrink-0 items-center gap-2.5 border-b border-orange-100/80 px-4 py-3 supports-[padding:max(0px)]:pt-[max(0.75rem,env(safe-area-inset-top))] dark:border-zinc-800">
            <BrandMark />
            <span className="min-w-0 flex-1 text-sm font-semibold leading-tight text-zinc-900 dark:text-zinc-100">
              Accounting Scoreboard
            </span>
            <Button type="button" variant="outline" size="icon" onClick={onClose} aria-label="Close sections menu">
              <X className="h-5 w-5" />
            </Button>
          </div>

          <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto overscroll-contain p-2">
            {items.map((item) => {
              const isActive = item.key === active;
              const Icon = item.icon;
              const light = item.light && item.light !== 'none' ? item.light : null;
              return (
                <li key={item.key} className={cn(item.divided && 'mt-1.5 border-t border-zinc-100 pt-1.5 dark:border-zinc-900')}>
                  <button
                    ref={isActive ? activeRef : undefined}
                    type="button"
                    aria-current={isActive ? 'page' : undefined}
                    onClick={() => onSelect(item.key)}
                    className={cn(
                      'flex w-full items-center gap-3 rounded-xl px-2.5 py-1.5 text-left text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400/60',
                      isActive
                        ? 'bg-orange-700 text-white'
                        : 'text-zinc-700 hover:bg-orange-50 hover:text-orange-900 dark:text-zinc-300 dark:hover:bg-orange-950/30 dark:hover:text-orange-200',
                    )}
                  >
                    <span
                      className={cn(
                        'flex size-8 shrink-0 items-center justify-center rounded-lg',
                        isActive ? 'bg-white/15 text-white' : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400',
                      )}
                    >
                      <Icon className="size-4" aria-hidden />
                    </span>
                    <span className="min-w-0 flex-1 truncate py-1.5">{item.label}</span>
                    {light ? (
                      <>
                        <span
                          aria-hidden
                          className={cn(
                            'size-2.5 shrink-0 rounded-full ring-2',
                            LIGHT_STYLE[light].dot,
                            isActive ? 'ring-white/80' : 'ring-white dark:ring-zinc-950',
                          )}
                        />
                        <span className="sr-only">, {LIGHT_LABEL[light]}</span>
                      </>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>

          <div className="shrink-0 border-t border-orange-100/80 px-4 py-3 supports-[padding:max(0px)]:pb-[max(0.75rem,env(safe-area-inset-bottom))] dark:border-zinc-800">
            <div className="text-[11px] text-zinc-500 dark:text-zinc-400">Signed in as</div>
            <div className="truncate font-mono text-xs text-zinc-700 dark:text-zinc-300">{email}</div>
          </div>
        </motion.aside>
      ) : null}
    </AnimatePresence>
  );
}
