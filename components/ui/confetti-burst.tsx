"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

/**
 * ConfettiBurst — a one-shot, full-viewport confetti celebration for milestone
 * moments (e.g. the Payroll Readiness score reaching 100/Ready live). Mounting
 * it fires the burst; it simulates ~3s of confetti on a single <canvas> and
 * then calls `onDone` so the parent can unmount it. Re-fire by remounting with
 * a new `key`.
 *
 * - Pure decoration: `aria-hidden` + `pointer-events-none`, drawn on ONE
 *   canvas (no DOM node per particle), so it can never block a click or slow
 *   the surface it celebrates.
 * - Portals to <body> at z-[60]: above the app's dialogs (z-50), deliberately
 *   below floating dropdowns/popovers (z-[140]) — confetti must never cover a
 *   control someone is actively using.
 * - Reduced motion is the PARENT's gate: don't mount this when
 *   `useReducedMotion()` says reduce. The component stays deliberately dumb so
 *   the celebrating surface owns the whole "should this fire?" decision.
 * - `origins` are viewport-px launch points (pass e.g. the celebrating
 *   banner's rect corners so the burst erupts from the thing that turned
 *   green). Omitted, it bursts from two points in the upper third of the
 *   viewport, which reads right over a centered modal.
 */

/** Palette-native confetti: the readiness greens the hero flips to, warmed by
 *  the app's orange/amber brand and one sky accent — festive without going
 *  full rainbow on a payroll surface. */
const CONFETTI_COLORS = [
  "#10b981", // emerald-500
  "#34d399", // emerald-400
  "#2dd4bf", // teal-400
  "#a3e635", // lime-400
  "#fbbf24", // amber-400
  "#fb923c", // orange-400
  "#38bdf8", // sky-400
];

/** Hard stop for the rAF loop even if some particle's math never settles —
 *  the normal end is every particle dying (~3s with the second wave). */
const MAX_MS = 3600;
/** First wave per origin; the echo wave (~0.26s later) is half this. */
const WAVE_SIZE = 72;

interface Particle {
  x: number;
  y: number;
  /** Velocity in px/s. */
  vx: number;
  vy: number;
  /** Strip size (w×h); dots use `h` as their radius. */
  w: number;
  h: number;
  color: string;
  dot: boolean;
  /** In-plane rotation of a strip. */
  angle: number;
  spin: number;
  /** Out-of-plane flip — sin(tilt) scales the strip through edge-on, which is
   *  what makes a flat rect read as tumbling paper. */
  tilt: number;
  tiltSpeed: number;
  /** Side-to-side flutter applied at draw time. */
  wobble: number;
  wobbleSpeed: number;
  wobbleAmp: number;
  /** Sim-clock second this particle launches (>0 = the echo wave). */
  born: number;
  /** Seconds from launch until it fades out. */
  life: number;
}

/** One cannon-load: sprays upward with spread, biased toward the viewport's
 *  horizontal centre so side origins arc inward over the surface. */
function spawnWave(
  origin: { x: number; y: number },
  centerX: number,
  count: number,
  born: number,
): Particle[] {
  const bias = Math.max(-1, Math.min(1, (centerX - origin.x) / Math.max(centerX, 1)));
  const aim = -Math.PI / 2 + bias * (Math.PI / 10);
  const out: Particle[] = [];
  for (let i = 0; i < count; i++) {
    const angle = aim + (Math.random() - 0.5) * (Math.PI * 0.62);
    const speed = 520 + Math.random() * 430;
    const dot = Math.random() < 0.22;
    out.push({
      x: origin.x,
      y: origin.y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      w: dot ? 0 : 7 + Math.random() * 5,
      h: dot ? 2.4 + Math.random() * 1.6 : 4 + Math.random() * 2.5,
      color: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)],
      dot,
      angle: Math.random() * Math.PI * 2,
      spin: (Math.random() - 0.5) * 8,
      tilt: Math.random() * Math.PI * 2,
      tiltSpeed: 5 + Math.random() * 6,
      wobble: Math.random() * Math.PI * 2,
      wobbleSpeed: 5 + Math.random() * 7,
      wobbleAmp: 3 + Math.random() * 7,
      born,
      life: 1.7 + Math.random() * 0.9,
    });
  }
  return out;
}

export function ConfettiBurst({
  origins,
  onDone,
}: {
  /** Viewport-px launch points. Omitted → two points in the upper third. */
  origins?: { x: number; y: number }[];
  /** Called once, after the last particle fades — unmount the burst here. */
  onDone?: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Latest-ref the props so the mount-only sim effect never has a reason to
  // re-run (a re-fire is a REMOUNT via key, never a prop update mid-flight).
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const originsRef = useRef(origins);
  originsRef.current = origins;

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) {
      onDoneRef.current?.();
      return;
    }

    // Backing store at device pixels (capped at 2× — confetti doesn't need
    // more), drawing in CSS px. Refit on resize; particle coords stay valid
    // because they live in CSS px too.
    const fit = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(window.innerWidth * dpr);
      canvas.height = Math.floor(window.innerHeight * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    fit();
    window.addEventListener("resize", fit);

    const centerX = window.innerWidth / 2;
    const launch = originsRef.current?.length
      ? originsRef.current
      : [
          { x: window.innerWidth * 0.25, y: window.innerHeight * 0.38 },
          { x: window.innerWidth * 0.75, y: window.innerHeight * 0.38 },
        ];
    // Two pumps per origin — the main burst and a smaller echo a beat later —
    // reads far livelier than one volley for the same particle budget.
    const particles: Particle[] = [];
    for (const o of launch) {
      particles.push(...spawnWave(o, centerX, WAVE_SIZE, 0));
      particles.push(...spawnWave(o, centerX, Math.round(WAVE_SIZE / 2), 0.26));
    }

    const start = performance.now();
    let last = start;
    let raf = 0;
    const frame = (now: number) => {
      // Clamp dt so a background-tab pause can't teleport pieces off-screen;
      // a long absence just lands on the loop's hard stop below.
      const dt = Math.min((now - last) / 1000, 0.032);
      last = now;
      const t = (now - start) / 1000;
      const W = window.innerWidth;
      const H = window.innerHeight;
      ctx.clearRect(0, 0, W, H);

      let alive = 0;
      for (const p of particles) {
        const age = t - p.born;
        if (age > p.life) continue;
        if (age < 0) {
          alive++; // echo wave still queued
          continue;
        }
        // Exponential drag kills the launch burst fast; gravity then settles
        // the fall at a gentle terminal speed (~260 px/s) so pieces flutter
        // down rather than drop.
        p.vx *= Math.exp(-2.4 * dt);
        p.vy = (p.vy + 1350 * dt) * Math.exp(-5.2 * dt);
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.angle += p.spin * dt;
        p.tilt += p.tiltSpeed * dt;
        p.wobble += p.wobbleSpeed * dt;
        if (p.y > H + 24) continue;
        alive++;

        ctx.globalAlpha = Math.min(1, (p.life - age) / 0.45);
        ctx.fillStyle = p.color;
        const drawX = p.x + Math.sin(p.wobble) * p.wobbleAmp;
        if (p.dot) {
          ctx.beginPath();
          ctx.arc(drawX, p.y, p.h, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.save();
          ctx.translate(drawX, p.y);
          ctx.rotate(p.angle);
          ctx.scale(1, Math.sin(p.tilt));
          ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
          ctx.restore();
        }
      }
      ctx.globalAlpha = 1;

      if (alive > 0 && now - start < MAX_MS) {
        raf = requestAnimationFrame(frame);
      } else {
        ctx.clearRect(0, 0, W, H);
        onDoneRef.current?.();
      }
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", fit);
    };
  }, []);

  if (typeof document === "undefined") return null;
  return createPortal(
    <canvas
      ref={canvasRef}
      aria-hidden
      className="pointer-events-none fixed inset-0 z-[60] h-full w-full"
    />,
    document.body,
  );
}
