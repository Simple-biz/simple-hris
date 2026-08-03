/**
 * The closed Payroll Notes FAB's readiness ring color: a single continuous
 * fade from orange-500 (0%) to emerald-500 (100%) — the raw score number, not
 * the 3-band grade tone the in-modal dial uses. Hue climbs 21→160 (the short
 * way round the wheel), so the midpoint reads yellow-green with no hardcoded
 * third stop.
 */
export function readinessRingColor(pct: number): string {
  const t = Math.max(0, Math.min(100, pct)) / 100;
  const lerp = (a: number, b: number) => a + (b - a) * t;
  const h = lerp(21, 160);
  const s = lerp(90.6, 84.1);
  const l = lerp(53.1, 39.4);
  return `hsl(${h.toFixed(1)}, ${s.toFixed(1)}%, ${l.toFixed(1)}%)`;
}
