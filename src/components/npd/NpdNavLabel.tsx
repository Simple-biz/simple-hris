/**
 * Accounting rail label for NPD: reads "NPD" and, while the row is hovered (or
 * keyboard-focused), wipes left-to-right into "New Payroll Dashboard" — the same
 * clip-path wipe and timing as S-Wall's label (`SWallNavLabel`, SWall.tsx).
 *
 * One deliberate difference: S-Wall stacks both labels in one grid cell, so the
 * row is always as wide as the long label. "New Payroll Dashboard" is about as
 * wide as the whole label column, so here the long label is an OVERLAY on the
 * short one and the row keeps "NPD"'s width; the parent must not clip it.
 *
 * Needs a `group` ancestor (the rail button). The button's accessible name is the
 * long label; "NPD" is hidden from assistive tech so it is not read twice.
 */
export default function NpdNavLabel() {
  return (
    <span className="relative inline-block select-none whitespace-nowrap">
      <span
        aria-hidden
        className="block [clip-path:inset(0_0%_0_0)] transition-[clip-path] duration-[320ms] ease-[cubic-bezier(0.4,0,0.2,1)] group-hover:[clip-path:inset(0_100%_0_0)] group-focus-visible:[clip-path:inset(0_100%_0_0)] motion-reduce:transition-none"
      >
        NPD
      </span>
      <span className="pointer-events-none absolute left-0 top-0 [clip-path:inset(0_100%_0_0)] transition-[clip-path] duration-[320ms] ease-[cubic-bezier(0.2,0,0,1)] group-hover:[clip-path:inset(0_0%_0_0)] group-focus-visible:[clip-path:inset(0_0%_0_0)] motion-reduce:transition-none">
        New Payroll Dashboard
      </span>
    </span>
  );
}
