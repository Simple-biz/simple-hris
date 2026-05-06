'use client';

import React, { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { cn } from '@/lib/utils';

/**
 * Sci-fi HUD scanning loader for the Payment Dispatch table — replaces the
 * grey shimmer skeleton with a dark cockpit display: rotating concentric
 * reticle, perspective grid, animated counters, radar pings, equalizer-style
 * gauge, and a sweeping scan line. Pure SVG + CSS + Motion, no images.
 *
 * Caller contract: fills `h-full min-h-0 flex flex-col` containers cleanly,
 * mirroring `QueueSkeleton`'s shape so the swap is structural-zero.
 */
export default function DispatchScanLoader() {
  return (
    <div
      className={cn(
        'relative isolate flex h-full min-h-[420px] w-full overflow-hidden',
        'bg-gradient-to-br from-[#04080f] via-[#0a1428] to-[#050a14]',
      )}
      role="status"
      aria-label="Loading dispatch queue"
    >
      <BackgroundGrid />
      <Vignette />
      <RadarDots />
      <CenterReticle />
      <ScanLine />

      {/* Top-left coordinate readout */}
      <div className="pointer-events-none absolute left-4 top-4 sm:left-6 sm:top-6">
        <TopLeftReadout />
      </div>

      {/* Top-right scan list */}
      <div className="pointer-events-none absolute right-4 top-4 sm:right-6 sm:top-6">
        <TopRightScanList />
      </div>

      {/* Bottom-left equalizer */}
      <div className="pointer-events-none absolute bottom-5 left-4 sm:left-6">
        <BarGauge />
      </div>

      {/* Bottom-right caption */}
      <div className="pointer-events-none absolute bottom-5 right-4 sm:right-6">
        <Caption />
      </div>

      {/* Frame ticks at the four corners */}
      <CornerTicks />

      <span className="sr-only">Reading dispatch queue…</span>
    </div>
  );
}

/* ─────────── Background ─────────── */

function BackgroundGrid() {
  return (
    <div
      aria-hidden
      className="absolute inset-0 opacity-40"
      style={{
        backgroundImage: `
          linear-gradient(to right, rgba(59,130,246,0.18) 1px, transparent 1px),
          linear-gradient(to bottom, rgba(59,130,246,0.18) 1px, transparent 1px)
        `,
        backgroundSize: '52px 52px',
      }}
    />
  );
}

function Vignette() {
  return (
    <div
      aria-hidden
      className="absolute inset-0"
      style={{
        background:
          'radial-gradient(ellipse at center, rgba(0,0,0,0) 0%, rgba(0,0,0,0.4) 60%, rgba(0,0,0,0.85) 100%)',
      }}
    />
  );
}

/* ─────────── Center reticle ─────────── */

function CenterReticle() {
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
      <div className="relative h-[260px] w-[260px] sm:h-[340px] sm:w-[340px] lg:h-[400px] lg:w-[400px]">
        {/* Outermost ring + bearing ticks (slow CW) */}
        <motion.svg
          viewBox="0 0 200 200"
          className="absolute inset-0 h-full w-full"
          animate={{ rotate: 360 }}
          transition={{ duration: 22, repeat: Infinity, ease: 'linear' }}
        >
          <circle cx="100" cy="100" r="98" fill="none" stroke="rgba(59,130,246,0.35)" strokeWidth="0.4" />
          {Array.from({ length: 24 }, (_, i) => {
            const len = i % 3 === 0 ? 6 : 3;
            return (
              <line
                key={i}
                x1="100"
                y1="2"
                x2="100"
                y2={2 + len}
                stroke="rgba(96,165,250,0.6)"
                strokeWidth="0.4"
                transform={`rotate(${i * 15} 100 100)`}
              />
            );
          })}
          {[0, 90, 180, 270].map((deg) => (
            <text
              key={deg}
              x="100"
              y="13"
              textAnchor="middle"
              fill="rgba(125,211,252,0.55)"
              fontSize="5"
              fontFamily="ui-monospace, monospace"
              transform={`rotate(${deg} 100 100)`}
            >
              {String(deg).padStart(3, '0')}
            </text>
          ))}
        </motion.svg>

        {/* Mid ring — segmented, dashed, counter-rotating */}
        <motion.svg
          viewBox="0 0 200 200"
          className="absolute inset-0 h-full w-full"
          animate={{ rotate: -360 }}
          transition={{ duration: 14, repeat: Infinity, ease: 'linear' }}
        >
          <circle
            cx="100"
            cy="100"
            r="80"
            fill="none"
            stroke="rgba(59,130,246,0.5)"
            strokeWidth="0.6"
            strokeDasharray="2 5"
          />
          {/* Heavier arc on top — gives the ring direction */}
          <path
            d="M 100 20 A 80 80 0 0 1 178 80"
            fill="none"
            stroke="rgba(96,165,250,0.95)"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
          {/* Red accent arc on bottom */}
          <path
            d="M 22 120 A 80 80 0 0 0 60 178"
            fill="none"
            stroke="rgba(244,63,94,0.85)"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </motion.svg>

        {/* Inner ring (slow CW) with notch markers */}
        <motion.svg
          viewBox="0 0 200 200"
          className="absolute inset-0 h-full w-full"
          animate={{ rotate: 360 }}
          transition={{ duration: 9, repeat: Infinity, ease: 'linear' }}
        >
          <circle cx="100" cy="100" r="60" fill="none" stroke="rgba(59,130,246,0.7)" strokeWidth="0.6" />
          {/* 8 notches around */}
          {Array.from({ length: 8 }, (_, i) => (
            <line
              key={i}
              x1="100"
              y1="40"
              x2="100"
              y2="46"
              stroke="rgba(125,211,252,0.85)"
              strokeWidth="0.6"
              transform={`rotate(${i * 45} 100 100)`}
            />
          ))}
        </motion.svg>

        {/* Inner red dashed ring (fast counter-rotation) */}
        <motion.svg
          viewBox="0 0 200 200"
          className="absolute inset-0 h-full w-full"
          animate={{ rotate: -360 }}
          transition={{ duration: 6, repeat: Infinity, ease: 'linear' }}
        >
          <circle
            cx="100"
            cy="100"
            r="46"
            fill="none"
            stroke="rgba(244,63,94,0.55)"
            strokeWidth="0.5"
            strokeDasharray="3 6"
          />
        </motion.svg>

        {/* Sweep beam — radar wedge */}
        <motion.svg
          viewBox="0 0 200 200"
          className="absolute inset-0 h-full w-full"
          animate={{ rotate: 360 }}
          transition={{ duration: 4, repeat: Infinity, ease: 'linear' }}
        >
          <defs>
            <linearGradient id="sweepGrad" x1="50%" y1="50%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="rgba(244,63,94,0)" />
              <stop offset="50%" stopColor="rgba(244,63,94,0.25)" />
              <stop offset="100%" stopColor="rgba(244,63,94,0.65)" />
            </linearGradient>
          </defs>
          <path
            d="M 100 100 L 100 20 A 80 80 0 0 1 156 44 Z"
            fill="url(#sweepGrad)"
            opacity="0.7"
          />
        </motion.svg>

        {/* Crosshair + center pulse dot */}
        <svg viewBox="0 0 200 200" className="absolute inset-0 h-full w-full">
          <line x1="32" y1="100" x2="78" y2="100" stroke="rgba(125,211,252,0.6)" strokeWidth="0.5" />
          <line x1="122" y1="100" x2="168" y2="100" stroke="rgba(125,211,252,0.6)" strokeWidth="0.5" />
          <line x1="100" y1="32" x2="100" y2="78" stroke="rgba(125,211,252,0.6)" strokeWidth="0.5" />
          <line x1="100" y1="122" x2="100" y2="168" stroke="rgba(125,211,252,0.6)" strokeWidth="0.5" />
        </svg>
        <motion.span
          aria-hidden
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-rose-500"
          style={{ height: 10, width: 10, boxShadow: '0 0 14px rgba(244,63,94,0.85)' }}
          animate={{ opacity: [0.5, 1, 0.5], scale: [0.85, 1.2, 0.85] }}
          transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }}
        />
      </div>
    </div>
  );
}

/* ─────────── Radar dots ─────────── */

const RADAR_POSITIONS = [
  { top: '18%', left: '8%',  delay: 0.0  },
  { top: '72%', left: '18%', delay: 1.1  },
  { top: '36%', left: '88%', delay: 0.55 },
  { top: '82%', left: '78%', delay: 1.95 },
  { top: '12%', left: '64%', delay: 1.65 },
  { top: '58%', left: '6%',  delay: 0.85 },
  { top: '90%', left: '40%', delay: 2.4  },
  { top: '24%', left: '92%', delay: 2.05 },
];

function RadarDots() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0">
      {RADAR_POSITIONS.map((p, i) => (
        <motion.span
          key={i}
          className="absolute h-1.5 w-1.5 rounded-full bg-rose-500"
          style={{
            top: p.top,
            left: p.left,
            boxShadow: '0 0 8px rgba(244,63,94,0.85)',
          }}
          animate={{ opacity: [0, 1, 1, 0], scale: [0.4, 1.6, 1, 0.4] }}
          transition={{
            duration: 2.6,
            repeat: Infinity,
            delay: p.delay,
            times: [0, 0.18, 0.6, 1],
            ease: 'easeOut',
          }}
        />
      ))}
    </div>
  );
}

/* ─────────── Scan line (horizontal sweep) ─────────── */

function ScanLine() {
  return (
    <motion.div
      aria-hidden
      className="pointer-events-none absolute inset-x-0 h-[2px]"
      style={{
        background:
          'linear-gradient(to right, rgba(125,211,252,0) 0%, rgba(125,211,252,0.85) 50%, rgba(125,211,252,0) 100%)',
        boxShadow: '0 0 12px rgba(125,211,252,0.6)',
      }}
      animate={{ top: ['-2%', '102%'] }}
      transition={{ duration: 3.4, repeat: Infinity, ease: 'easeInOut' }}
    />
  );
}

/* ─────────── Top-left readout ─────────── */

function TopLeftReadout() {
  const [batch, setBatch] = useState('0000');
  const [node, setNode] = useState('00.0');
  const [fix, setFix] = useState('OK');

  useEffect(() => {
    const t = setInterval(() => {
      setBatch(String(Math.floor(Math.random() * 9999)).padStart(4, '0'));
      setNode(`${Math.floor(Math.random() * 99)}.${Math.floor(Math.random() * 9)}`);
      setFix(Math.random() > 0.85 ? 'WAIT' : 'OK');
    }, 110);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="space-y-1 font-mono text-[10px] leading-tight">
      <div className="text-cyan-400/80 tracking-[0.32em] uppercase">Dispatch Matrix</div>
      <div className="text-cyan-100/90">
        <span className="text-cyan-400/60">BATCH</span>{' '}
        <span className="font-semibold tabular-nums">#{batch}</span>
      </div>
      <div className="text-cyan-100/90">
        <span className="text-cyan-400/60">NODE</span>{' '}
        <span className="font-semibold tabular-nums">{node}</span>
      </div>
      <div>
        <span className="text-cyan-400/60">FIX&nbsp;&nbsp;</span>
        <span
          className={cn(
            'font-semibold tabular-nums',
            fix === 'OK' ? 'text-emerald-400' : 'text-rose-400 animate-pulse',
          )}
        >
          {fix}
        </span>
      </div>
    </div>
  );
}

/* ─────────── Top-right scan list ─────────── */

const SCAN_TARGETS = [
  'PROCESSORS · 6/6',
  'HUBSTAFF · OK',
  'EMPLOYEE_RATES',
  'PAYMENT_DISPATCHES',
  'DISBURSEMENT_RECORDS',
  'CYCLE LOCK · 1',
  'PERIOD WINDOW',
  'PAB ELIGIBILITY',
];

function TopRightScanList() {
  const [active, setActive] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setActive((a) => (a + 1) % SCAN_TARGETS.length), 380);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="space-y-0.5 text-right font-mono text-[10px] leading-tight">
      <div className="mb-1 tracking-[0.32em] uppercase text-cyan-400/80">Scanning</div>
      {SCAN_TARGETS.map((t, i) => {
        const isActive = i === active;
        return (
          <div
            key={t}
            className={cn(
              'transition-colors duration-150',
              isActive ? 'text-cyan-100' : 'text-cyan-400/30',
            )}
          >
            {isActive ? '> ' : '  '}
            {t}
          </div>
        );
      })}
    </div>
  );
}

/* ─────────── Bottom equalizer-style gauge ─────────── */

function BarGauge() {
  return (
    <div className="flex h-12 items-end gap-[3px]" aria-hidden>
      {Array.from({ length: 22 }, (_, i) => (
        <motion.span
          key={i}
          className="block w-[3px] rounded-sm bg-gradient-to-t from-blue-500 to-cyan-300"
          style={{ boxShadow: '0 0 6px rgba(96,165,250,0.55)' }}
          animate={{ height: ['18%', '95%', '40%', '70%', '22%'] }}
          transition={{
            duration: 1.1 + (i % 5) * 0.18,
            repeat: Infinity,
            ease: 'easeInOut',
            delay: i * 0.04,
          }}
        />
      ))}
    </div>
  );
}

/* ─────────── Bottom-right caption ─────────── */

function Caption() {
  return (
    <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.3em] text-cyan-200/90">
      <motion.span
        className="inline-block h-2 w-2 rounded-full bg-cyan-300"
        style={{ boxShadow: '0 0 8px rgba(125,211,252,0.85)' }}
        animate={{ opacity: [0.3, 1, 0.3] }}
        transition={{ duration: 1.1, repeat: Infinity, ease: 'easeInOut' }}
      />
      Reading dispatch queue
    </div>
  );
}

/* ─────────── Frame corner ticks ─────────── */

function CornerTicks() {
  const tick = 'absolute h-3 w-3 border-cyan-400/60';
  return (
    <div aria-hidden className="pointer-events-none">
      <span className={cn(tick, 'left-2 top-2 border-l border-t')} />
      <span className={cn(tick, 'right-2 top-2 border-r border-t')} />
      <span className={cn(tick, 'left-2 bottom-2 border-l border-b')} />
      <span className={cn(tick, 'right-2 bottom-2 border-r border-b')} />
    </div>
  );
}
