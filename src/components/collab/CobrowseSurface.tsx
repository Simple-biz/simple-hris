'use client';

import { motion } from 'motion/react';
import { Eye, Loader2, X } from 'lucide-react';
import type { CobrowseStatus } from '@/hooks/useCobrowse';
import 'rrweb/dist/style.css';

/**
 * Full-screen live mirror of a peer's Accounting screen. Presentational only —
 * the rrweb session is owned by {@link useCobrowse} in AccountingCollabLayer
 * (so the driver half stays live for everyone); this component just hosts the
 * replay container and chrome. Purely passive: the observer cannot interact
 * with the mirrored page.
 *
 * The whole overlay is tagged `.rr-block` so that if this observer is ALSO
 * being observed by someone else, rrweb blocks this surface from their stream
 * (no mirror-of-a-mirror).
 */
export default function CobrowseSurface({
  driverName,
  accent,
  status,
  setReplayContainer,
  onStop,
  surfaceLabel = 'Accounting dashboard',
}: {
  driverName: string;
  accent: { bg: string; glow: string };
  status: CobrowseStatus;
  setReplayContainer: (el: HTMLElement | null) => void;
  onStop: () => void;
  /** Dashboard name shown in the "waiting" copy, e.g. "HR dashboard". */
  surfaceLabel?: string;
}) {
  return (
    <motion.div
      className="rr-block fixed inset-0 z-[120] flex flex-col bg-zinc-950"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
    >
      {/* Header */}
      <div
        className="flex shrink-0 items-center gap-3 border-b px-4 py-2.5"
        style={{ borderColor: `${accent.bg}40`, background: 'rgba(9,9,11,0.92)' }}
      >
        <span className="relative flex h-2.5 w-2.5 shrink-0">
          <span
            className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-70"
            style={{ background: accent.bg }}
          />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full" style={{ background: accent.bg }} />
        </span>
        <Eye className="h-4 w-4 shrink-0 text-zinc-300" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold leading-tight text-white">
            Observing {driverName}
          </div>
          <div className="text-[11px] leading-tight text-zinc-400">
            {status === 'live'
              ? 'Live mirror of their screen'
              : status === 'connecting'
                ? 'Connecting to their screen…'
                : 'Idle'}
          </div>
        </div>
        <button
          type="button"
          onClick={onStop}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-[12px] font-semibold text-white transition-colors hover:bg-white/20"
        >
          <X className="h-3.5 w-3.5" />
          Stop observing
        </button>
      </div>

      {/* Replay surface */}
      <div className="relative min-h-0 flex-1 overflow-hidden bg-zinc-900">
        <div
          ref={setReplayContainer}
          className="pointer-events-none absolute inset-0 overflow-hidden"
        />
        {status !== 'live' && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 text-zinc-400">
            <Loader2 className="h-7 w-7 animate-spin" style={{ color: accent.bg }} />
            <div className="text-sm font-medium">Waiting for {driverName}&apos;s screen…</div>
            <div className="max-w-xs text-center text-[11px] text-zinc-500">
              They need to be online and active in the {surfaceLabel} for the live mirror to start.
            </div>
          </div>
        )}
      </div>
    </motion.div>
  );
}
