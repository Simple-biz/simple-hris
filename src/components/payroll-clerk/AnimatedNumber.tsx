'use client';

import { useEffect } from 'react';
import { animate, motion, useMotionValue, useTransform } from 'motion/react';

interface AnimatedNumberProps {
  value: number;
  className?: string;
  /** Format the live spring value into the rendered string. */
  formatter?: (n: number) => string;
  /** Override spring stiffness (default 90 — light, dopamine-y). */
  stiffness?: number;
  damping?: number;
}

/**
 * Spring-animated numeric counter. Renders a `motion.span` whose text content
 * tweens from its previous value to the new one. Used for hero stats so digit
 * changes feel alive rather than instant.
 */
export default function AnimatedNumber({
  value,
  className,
  formatter = (n) => Math.round(n).toLocaleString('en-US'),
  stiffness = 90,
  damping = 18,
}: AnimatedNumberProps) {
  const mv = useMotionValue(0);
  const text = useTransform(mv, (v) => formatter(v));

  useEffect(() => {
    const controls = animate(mv, value, { type: 'spring', stiffness, damping });
    return () => controls.stop();
  }, [value, stiffness, damping, mv]);

  return <motion.span className={className}>{text}</motion.span>;
}
