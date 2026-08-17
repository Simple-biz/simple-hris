"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Inline SVG flags, drawn to fill a 24×24 square so they survive a circular
 * crop with the identifying feature centred.
 *
 * Deliberately NOT emoji: Windows has no glyphs for regional-indicator pairs,
 * so 🇺🇸 renders as the letters "US" there. These are self-contained paths, so
 * they look identical on every platform and need no network.
 *
 * Detail is tuned for ~24px. The US canton carries nine suggested stars rather
 * than fifty, because fifty at this size is a grey smear.
 */

type FlagProps = { className?: string }

function FlagUS({ className }: FlagProps) {
  const stripe = 24 / 13
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden focusable="false">
      <rect width="24" height="24" fill="#FFFFFF" />
      {[0, 2, 4, 6, 8, 10, 12].map((i) => (
        <rect key={i} y={i * stripe} width="24" height={stripe} fill="#B22234" />
      ))}
      <rect width="10.5" height={stripe * 7} fill="#3C3B6E" />
      {[0, 1, 2].map((row) =>
        [0, 1, 2].map((col) => (
          <circle
            key={`${row}-${col}`}
            cx={2 + col * 3.2}
            cy={2.3 + row * 4.1}
            r="0.75"
            fill="#FFFFFF"
          />
        )),
      )}
    </svg>
  )
}

function FlagPH({ className }: FlagProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden focusable="false">
      {/* Blue over red — peacetime orientation. */}
      <rect width="24" height="12" fill="#0038A8" />
      <rect y="12" width="24" height="12" fill="#CE1126" />
      <path d="M0 0 L0 24 L16 12 Z" fill="#FFFFFF" />
      <circle cx="5.4" cy="12" r="2.1" fill="#FCD116" />
      {[0, 45, 90, 135, 180, 225, 270, 315].map((deg) => (
        <rect
          key={deg}
          x="5.05"
          y="8.6"
          width="0.7"
          height="1.5"
          fill="#FCD116"
          transform={`rotate(${deg} 5.4 12)`}
        />
      ))}
      {/* The three stars sit at the triangle's corners on the real flag. Held
          inside radius 12 of centre (12,12) so the circular crop keeps them —
          at the true corners they are clipped away entirely. */}
      <circle cx="4.2" cy="5.6" r="0.85" fill="#FCD116" />
      <circle cx="4.2" cy="18.4" r="0.85" fill="#FCD116" />
      <circle cx="10.4" cy="12" r="0.85" fill="#FCD116" />
    </svg>
  )
}

function FlagCO({ className }: FlagProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden focusable="false">
      {/* Yellow half, then blue and red quarters. */}
      <rect width="24" height="12" fill="#FCD116" />
      <rect y="12" width="24" height="6" fill="#003893" />
      <rect y="18" width="24" height="6" fill="#CE1126" />
    </svg>
  )
}

const FLAGS = { US: FlagUS, PH: FlagPH, CO: FlagCO } as const

export type FlagCode = keyof typeof FLAGS

/**
 * Two overlapping circular flags — the conventional currency-pair mark.
 *
 * Decorative by design: every caller renders a text label naming the same pair
 * ("USD → PHP"), so the SVGs stay `aria-hidden` rather than doubling it up for
 * screen readers.
 *
 * `ringClassName` must match the surface behind the pair, since the ring is
 * what separates the two circles where they overlap.
 */
function CurrencyFlagPair({
  from,
  to,
  className,
  ringClassName = "ring-white dark:ring-zinc-900",
}: {
  from: FlagCode
  to: FlagCode
  className?: string
  ringClassName?: string
}) {
  const From = FLAGS[from]
  const To = FLAGS[to]
  const circle = cn(
    "block h-6 w-6 shrink-0 overflow-hidden rounded-full ring-2",
    ringClassName,
  )
  return (
    <span className={cn("flex items-center -space-x-1.5", className)} aria-hidden>
      <span className={circle}>
        <From className="h-full w-full" />
      </span>
      <span className={circle}>
        <To className="h-full w-full" />
      </span>
    </span>
  )
}

export { CurrencyFlagPair, FlagCO, FlagPH, FlagUS }
