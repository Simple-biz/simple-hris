'use client';

import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Eye, EyeOff } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Mask sensitive UI (e.g. an employee's take-home pay) with a click-to-reveal
 * eye toggle. Default state is **hidden** on every mount — we don't persist
 * the reveal across page loads or sessions, so a coworker glancing at the
 * screen sees the masked value (e.g. `₱•••••••••`) until the employee
 * explicitly clicks to reveal.
 *
 * Two modes:
 *  - **Uncontrolled** — pass children + (optionally) `mask`. The component
 *    manages its own `revealed` state and renders an Eye/EyeOff toggle
 *    button next to the value.
 *  - **Controlled** — pass `revealed` (and optionally `onToggleRevealed`).
 *    The component renders only the masked/unmasked content. The eye button
 *    appears only if `onToggleRevealed` is supplied. Useful when several
 *    values should reveal/hide together via a single shared toggle (e.g.
 *    Take-Home + Regular + Overtime on the dashboard).
 *
 * Visual: when hidden, the wrapped content is replaced wholesale with the
 * `mask` string, rendered inside a span that inherits the parent's font /
 * color / size so the placeholder looks like the real value's twin. Clicking
 * the masked span (when interactive) toggles to reveal.
 */
interface HiddenValueProps {
  /** The actual content shown when revealed. */
  children: React.ReactNode;
  /** Placeholder text shown when hidden. Default: `•••••••••`. Pass something
   *  like `₱••••••••• ≈ $•••• USD` for compound values. */
  mask?: React.ReactNode;
  /** External reveal state — switches the component into controlled mode. */
  revealed?: boolean;
  /** External setter — when provided, the component renders an Eye toggle
   *  even in controlled mode. Omit if a parent renders its own toggle. */
  onToggleRevealed?: (next: boolean) => void;
  /** Wrapper className. */
  className?: string;
  /** className applied to the inner content (mask + revealed children share it
   *  so layout is stable). */
  innerClassName?: string;
  /** Visible label for the toggle button (also serves as aria-label). */
  hideLabel?: string;
  showLabel?: string;
  /** Size class for the eye icon. Default `h-4 w-4`. */
  iconClass?: string;
  /** When true, suppress the masked-area click-to-reveal interactivity (use
   *  if a parent already wires an onClick somewhere). Default false. */
  suppressClickToReveal?: boolean;
}

export default function HiddenValue({
  children,
  mask = '•••••••••',
  revealed: revealedProp,
  onToggleRevealed,
  className,
  innerClassName,
  hideLabel = 'Hide value',
  showLabel = 'Reveal value',
  iconClass = 'h-4 w-4',
  suppressClickToReveal = false,
}: HiddenValueProps) {
  const [internalRevealed, setInternalRevealed] = useState(false);
  const isControlled = revealedProp !== undefined;
  const revealed = isControlled ? !!revealedProp : internalRevealed;

  // Show the eye button when:
  //  - uncontrolled (component owns state, eye is the only toggle), OR
  //  - controlled AND the parent provided onToggleRevealed (shared toggle).
  const showEye = !isControlled || !!onToggleRevealed;

  const setRevealed = (next: boolean) => {
    if (isControlled) {
      onToggleRevealed?.(next);
    } else {
      setInternalRevealed(next);
    }
  };

  // The masked-area click reveals when not yet revealed, IF (a) the component
  // owns its own state, or (b) the parent wired up onToggleRevealed. If the
  // parent is fully passive (controlled but no setter), keep the area inert.
  const canClickToReveal =
    !suppressClickToReveal && !revealed && (showEye === true);

  return (
    <span className={cn('inline-flex items-baseline gap-2', className)}>
      {/*
        Crossfade between masked and revealed states with a quick blur+fade
        morph. mode="wait" sequences exit→enter so they never overlap visually
        (which would look messy for inline content with different widths).
        Total animation ≈ 320ms — slow enough to feel smooth, fast enough that
        revealing isn't annoying.
      */}
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={revealed ? 'revealed' : 'masked'}
          initial={{ opacity: 0, filter: 'blur(6px)', scale: 0.985 }}
          animate={{ opacity: 1, filter: 'blur(0px)', scale: 1 }}
          exit={{ opacity: 0, filter: 'blur(6px)', scale: 0.985 }}
          transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
          onClick={canClickToReveal ? () => setRevealed(true) : undefined}
          aria-hidden={!revealed ? true : undefined}
          className={cn(
            innerClassName,
            // inline-block so transform/scale animate cleanly even when the
            // wrapped content is itself inline.
            'inline-block origin-left',
            !revealed && canClickToReveal && 'cursor-pointer select-none',
            !revealed && !canClickToReveal && 'select-none',
          )}
        >
          {revealed ? children : mask}
        </motion.span>
      </AnimatePresence>
      {showEye && (
        <motion.button
          type="button"
          onClick={() => setRevealed(!revealed)}
          aria-pressed={revealed}
          aria-label={revealed ? hideLabel : showLabel}
          title={revealed ? hideLabel : showLabel}
          // Subtle press + tone shift on toggle so the button feels "physical".
          whileTap={{ scale: 0.92 }}
          className="inline-flex shrink-0 translate-y-[2px] items-center justify-center rounded-md p-1 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/50 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
        >
          <AnimatePresence mode="wait" initial={false}>
            <motion.span
              key={revealed ? 'eye-off' : 'eye-on'}
              initial={{ opacity: 0, rotate: -25 }}
              animate={{ opacity: 1, rotate: 0 }}
              exit={{ opacity: 0, rotate: 25 }}
              transition={{ duration: 0.14, ease: 'easeOut' }}
              className="inline-flex"
            >
              {revealed ? <EyeOff className={iconClass} aria-hidden /> : <Eye className={iconClass} aria-hidden />}
            </motion.span>
          </AnimatePresence>
        </motion.button>
      )}
    </span>
  );
}
