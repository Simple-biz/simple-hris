'use client';

/** [TERMINATION-DOCS]
 * The two-pill tablist that splits Accounting → Documents into the existing
 * signing queue and the Termination Letters panel.
 *
 * `role="tablist"` / `role="tab"` are LOAD-BEARING, not decoration: the whole
 * dashboard tab renders inside `<ReadOnlyTab>`, whose capture listener swallows
 * pointerdown unless the target matches its ALLOW_SELECTOR — which exempts
 * `[role="tab"]` and `[role="tablist"]` and nothing else here
 * (src/components/rbac/ReadOnlyTab.tsx:45-51). Drop either role and a view-only
 * rep can no longer switch tabs at all.
 *
 * `role="tabpanel"` is deliberately absent from the panes (ReadOnlyTab does NOT
 * exempt it, by design — a pane is content, not navigation), so these tabs
 * carry no `aria-controls`: pointing at an element that never claims the role
 * would be a worse lie than omitting it.
 *
 * `layoutId` is a GLOBAL shared-element key in motion — `offboardTabPill` and
 * `catalogTabPill` are already taken elsewhere, so this row owns
 * `terminationDocsTabPill` alone.
 */

import type { ComponentType } from 'react';
import { FileSignature, UserX } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { cn } from '@/lib/utils';

export type DocumentsInnerTab = 'queue' | 'termination';

const TABS: {
  value: DocumentsInnerTab;
  label: string;
  Icon: ComponentType<{ className?: string }>;
}[] = [
  { value: 'queue', label: 'Signing queue', Icon: FileSignature },
  { value: 'termination', label: 'Termination letters', Icon: UserX },
];

export default function TerminationDocsTabRow({
  value,
  onChange,
}: {
  value: DocumentsInnerTab;
  onChange: (next: DocumentsInnerTab) => void;
}) {
  const reduce = useReducedMotion();

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div
        role="tablist"
        aria-label="Documents views"
        className="flex items-center gap-1 rounded-lg border border-orange-100/80 bg-orange-50/60 p-1 dark:border-orange-900/50 dark:bg-orange-950/30"
      >
        {TABS.map(({ value: v, label, Icon }) => {
          const active = value === v;
          return (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onChange(v)}
              className={cn(
                'relative flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                active
                  ? 'text-white'
                  : 'text-zinc-600 hover:text-orange-800 dark:text-zinc-400 dark:hover:text-orange-200',
              )}
            >
              {active && (
                <motion.span
                  layoutId="terminationDocsTabPill"
                  className="absolute inset-0 rounded-md bg-gradient-to-r from-orange-500 to-amber-500 shadow-sm"
                  transition={{ duration: reduce ? 0 : 0.28, ease: [0.22, 1, 0.36, 1] }}
                />
              )}
              <span className="relative flex items-center gap-1.5">
                <Icon className="h-3.5 w-3.5" />
                {label}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
