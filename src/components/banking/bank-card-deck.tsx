'use client';

import { useState } from 'react';
import { AnimatePresence, motion, useAnimationControls, type Variants } from 'motion/react';
import { RotateCw } from 'lucide-react';
import { BankCard } from './bank-card';
import type { PreferredBank } from '@/lib/banking/preferred-bank';
import { cn } from '@/lib/utils';

/* ── The payout deck ────────────────────────────────────────────────────────
   Two accounts on one record, printed as what they are: a stack of cards with
   the paid one on top and the other tucked behind it (Kane, 2026-09-13: "if
   they have an alternate bank account it should be behind the main card ... a
   button where we can switch banks from Main to Alternative like spin them ...
   this way Accounting will have a secondary account if they have a problem in
   Payment Dispatch").

   **The front of the deck is never a new answer.** It is whatever
   `pickPreferredBank` already returned — the account Payment Dispatch pays — so
   a payee who gains a second card sees the SAME card they saw before, with
   another one behind it. The backup is read raw (`readBankSlot`), because a
   cross-slot fallback would let it borrow the paid slot's bank name and print
   two cards claiming one bank.

   **Which card is facing never implies where the money goes.** Flipping is a
   viewer, not a routing change: the status line under the deck states the role
   of the card currently facing, and it is the ONLY place that claim is made.
   Payroll's destination is changed in the form above (the Primary/Alternative
   picker), through the same save that has always filed it — never by a spin. */
export function BankCardDeck({
  front,
  back,
  facingBack,
  onSwap,
  masked = false,
  reduceMotion,
}: {
  /** The PAID slot, exactly as `pickPreferredBank` resolved it. */
  front: PreferredBank;
  /** The other slot, read raw. Shown behind, never paid. */
  back: PreferredBank;
  /**
   * CONTROLLED. The host owns which card is facing because the rows it renders
   * beneath the deck describe a slot as well — see `PayoutReadView`.
   */
  facingBack: boolean;
  onSwap: () => void;
  masked?: boolean;
  reduceMotion: boolean;
}) {
  // Cumulative, so the icon keeps turning the same way instead of unwinding —
  // the control turns with the deck rather than toggling between two states.
  const [turns, setTurns] = useState(0);
  const deck = useAnimationControls();

  const swap = () => {
    onSwap();
    setTurns((t) => t + 1);
    if (reduceMotion) return;
    // The spin lives on the STACK, not on either card: a card rotated past 90°
    // shows its own back, and there is no back face to show — these are two
    // different accounts, not two faces of one. Tipping the whole stack reads as
    // the deck being turned over in the hand, and no glyph is ever mirrored.
    void deck.start({ rotateY: [0, -13, 0] }, { duration: 0.55, ease: 'easeInOut' });
  };

  const label = (b: PreferredBank) => (b.isAlternativeSlot ? 'alternative' : 'primary');
  const hiddenCard = facingBack ? front : back;

  return (
    <div className="mb-1">
      <div style={{ perspective: 1200 }}>
        <motion.div animate={deck} className="grid pt-3.5">
          <DeckCard bank={front} isFront={!facingBack} masked={masked} reduceMotion={reduceMotion} />
          <DeckCard bank={back} isFront={facingBack} masked={masked} reduceMotion={reduceMotion} />
        </motion.div>
      </div>

      <div className="mt-1 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        {/* One claim, one home. The employee should never have to work out which
            of two cards their salary lands in, and the answer must not depend on
            which one happens to be facing — so it is stated in words, every
            time, about the card in front of them. */}
        <div aria-live="polite" className="min-w-0 max-w-[440px]">
          <AnimatePresence mode="wait" initial={false}>
            <motion.p
              key={facingBack ? 'back' : 'front'}
              initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 3 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -3 }}
              transition={{ duration: reduceMotion ? 0.1 : 0.22, ease: [0.16, 1, 0.3, 1] }}
              className="flex items-start gap-1.5 text-[11.5px] leading-relaxed text-zinc-500 dark:text-zinc-400"
            >
              <span
                className={cn(
                  'mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full',
                  facingBack ? 'bg-zinc-300 dark:bg-zinc-600' : 'bg-emerald-500',
                )}
              />
              {facingBack ? (
                <span>
                  Backup account. Payroll does not send here — Accounting can switch to it if a
                  payment to your {label(front)} account fails.
                </span>
              ) : (
                <span>
                  <span className="font-medium text-zinc-700 dark:text-zinc-200">
                    Payroll sends your salary here.
                  </span>{' '}
                  Your {label(back)} account is kept behind it as a backup.
                </span>
              )}
            </motion.p>
          </AnimatePresence>
        </div>

        <button
          type="button"
          onClick={swap}
          className="inline-flex shrink-0 items-center gap-1.5 self-start rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-[11.5px] font-semibold text-zinc-700 shadow-sm transition-colors hover:border-zinc-300 hover:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500/40 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:border-zinc-700 dark:hover:text-white dark:focus-visible:ring-offset-[#0a0a0a]"
        >
          <motion.span
            className="inline-flex"
            animate={{ rotate: reduceMotion ? 0 : turns * 180 }}
            transition={{ duration: reduceMotion ? 0 : 0.55, ease: [0.16, 1, 0.3, 1] }}
          >
            <RotateCw className="h-3.5 w-3.5" aria-hidden />
          </motion.span>
          Show {label(hiddenCard)} account
        </button>
      </div>
    </div>
  );
}

/**
 * Both cards occupy the SAME grid cell, so the stack is as tall as a card and
 * needs no measurement — `position: absolute` would have collapsed the
 * container, since the card has no fixed height below the `sm` breakpoint.
 */
const DECK_SLOT: Variants = {
  // A degree of tilt on the tucked card: a stack of two perfectly parallel
  // rectangles reads as a rendering artifact, a hand-stacked one reads as cards.
  back: { y: -18, scale: 0.93, rotate: -1.2 },
  front: { y: 0, scale: 1, rotate: 0 },
};

function DeckCard({
  bank,
  isFront,
  masked,
  reduceMotion,
}: {
  bank: PreferredBank;
  isFront: boolean;
  masked: boolean;
  reduceMotion: boolean;
}) {
  return (
    <motion.div
      className="col-start-1 row-start-1"
      // Depth swaps on the press, not across the animation: the card being
      // brought forward rises OVER the other one, the way it would be drawn out
      // of a wallet.
      style={{ zIndex: isFront ? 2 : 1, transformOrigin: '50% 100%' }}
      variants={DECK_SLOT}
      initial={false}
      animate={isFront ? 'front' : 'back'}
      transition={{ duration: reduceMotion ? 0 : 0.46, ease: [0.16, 1, 0.3, 1] }}
      // The tucked card is a few px of visible edge, but its copy buttons and
      // its reveal toggle are still real controls behind the front card — so
      // without this a keyboard user tabs into "copy account number" for an
      // account they cannot see.
      inert={!isFront}
    >
      <BankCard
        spelling={bank.name}
        holder={bank.holder}
        account={bank.account}
        swift={bank.swift}
        isAlternativeSlot={bank.isAlternativeSlot}
        reduceMotion={reduceMotion}
        masked={masked}
        // The deck animates both cards; a second entrance per card would fire
        // underneath this one.
        animateIn={false}
      />
    </motion.div>
  );
}
