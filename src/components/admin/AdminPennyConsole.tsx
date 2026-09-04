'use client';

/**
 * Admin → Penny AI, as an operator's console.
 *
 * Kane, 2026-09-04: "the interface looks like a hacker with the caret blinking
 * and all that… black and Orange… center the chat interface… if data loads then
 * make sure it has loading and nice animations." Scoped to the ADMIN Penny on
 * purpose — the CEO tab and the employee widget keep the violet Penny world.
 * This is the same carve-out People → Offboarded took ("futuristic — only this
 * tab"), and it borrows that surface's vocabulary deliberately: a mono readout
 * that narrates real phases, a scan line while a request is in flight, mono
 * uppercase table headers, staggered entrances, reduced-motion fallbacks
 * everywhere.
 *
 * Two rules this file lives by:
 *
 *  1. **The console never claims work that isn't happening.** Every progress
 *     line is driven by an activity frame the route emitted when it actually
 *     called that tool (`lib/penny/console-stream.ts`), and the phrasing comes
 *     from `lib/penny/console-phases.ts`, whose test pins one line per tool. A
 *     timer walking plausible strings would have been much easier and would
 *     have been a lie.
 *  2. **It is always dark.** The console ignores the app's light/dark switch —
 *     a terminal is a terminal, the way an embedded editor is. Everything
 *     outside this panel stays themed.
 *
 * The palette is literal hex rather than Tailwind's zinc/orange ramps because
 * the ground is warmer than zinc and the accent sits at one specific value;
 * secondary text is tinted from the accent's hue, never gray. Contrast on the
 * #101014 panel: body #e8ded2 ≈ 14:1, dim #a89a8d ≈ 7:1, faint #8a7f73 ≈ 4.9:1,
 * accent #ff7a1a ≈ 7.2:1 — all AA or better.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { ArrowUp, Check, ChevronRight, Loader2, Square, Terminal } from 'lucide-react';
import { AssistantContent, MessageFeedback } from '@/components/ceo/ceo-chat-message';
import { useCeoChat } from '@/components/ceo/use-ceo-chat';
import { resolveConsoleCommand, CONSOLE_COMMAND_HINTS } from '@/lib/penny/console-commands';
import {
  CONSOLE_BOOT_LINES,
  CONSOLE_IDLE_LINE,
  phaseForTool,
} from '@/lib/penny/console-phases';
import { cn } from '@/lib/utils';

/** Boot plays once per browser session — this tab remounts on every tab hop,
 *  and replaying a typewriter each time you come back is an irritation, not a
 *  flourish. sessionStorage (never localStorage) so a new tab boots again. */
const BOOT_FLAG = 'penny.console.booted';

/**
 * Boot timing. The banner lines land WHILE the headline is still typing — that
 * is what a real boot log does, and it keeps the whole sequence to ~600ms.
 * Slower was tested and read as a wait rather than an entrance; the starter
 * commands below are timed to follow it (0.75s).
 */
const BOOT_LINE_MS = 110;
const TYPE_MS = 18;

/**
 * How long the CRT power-on runs. It plays on EVERY entry to the tab (Kane:
 * "when we switch to the Penny AI Tab") — unlike the boot banner, which is
 * once per session. The distinction is deliberate: re-reading the same four
 * lines of text is tedious, but a 700ms hardware flick is a transition, and
 * transitions are supposed to happen every time you make the transition.
 */
const CRT_MS = 700;

/**
 * How long the `/clear` erase runs before the screen is actually swapped.
 * Deliberately much shorter than the power-on: an entrance is an event, but a
 * clear is something you do repeatedly and then want to type into.
 */
const CLEAR_MS = 300;

/* ────────────────────────────────────────────────────────────────────────── */
/* Caret                                                                     */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * The block caret. Blinks on a SQUARE wave (`step-end`), because a terminal
 * caret snaps between states — a fade is a pulse animation wearing a caret's
 * clothes. Solid and un-animated under reduced motion, so it still reads as a
 * cursor.
 */
function Caret({ className }: { className?: string }) {
  const reduceMotion = useReducedMotion();
  return (
    <span
      aria-hidden
      className={cn(
        'inline-block h-[1.05em] w-[0.5em] translate-y-[0.15em] bg-[#ff7a1a]',
        !reduceMotion && 'penny-caret',
        className,
      )}
    />
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/* CRT power-on                                                              */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * The overlay half of the 1980s TV power-on. The panel itself supplies the
 * geometry (see the `motion.section` below); this supplies the light, because
 * light is the part a dark panel cannot fake — `filter: brightness()` on a
 * near-black surface multiplies black by three and yields black, so the bloom
 * has to be its own emissive layer.
 *
 * Four real mechanisms of a CRT coming up, in the order they happen:
 *
 *  1. **The raster line.** Before the vertical deflection coil has anything to
 *     do, the entire picture is one bright horizontal streak across the middle
 *     of the tube. This is the signature everyone recognises.
 *  2. **Phosphor bloom.** The high voltage overshoots, the phosphors flare, and
 *     the picture washes out before it settles.
 *  3. **Scanlines**, strongest while the beam is still slow, thinning as the
 *     picture stabilises.
 *  4. **One vertical roll** before the sync locks.
 *
 * The bloom deliberately peaks well below a white-out and rises and falls
 * ONCE — a repeating flash at this size would be a photosensitivity hazard, and
 * the whole overlay never mounts under `prefers-reduced-motion`.
 *
 * It also unmounts when it finishes, so the `backdrop-blur` and the four
 * stacked layers cost exactly nothing for the rest of the session.
 */
function CrtPowerOn() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 z-20 overflow-hidden rounded-lg sm:rounded-xl"
    >
      {/* Sync locking: the picture arrives soft and pulls into focus. */}
      <motion.div
        className="absolute inset-0 backdrop-blur-[2px]"
        initial={{ opacity: 1 }}
        animate={{ opacity: [1, 1, 0.45, 0] }}
        transition={{ duration: 0.7, times: [0, 0.22, 0.62, 1], ease: 'linear' }}
      />

      {/* Phosphor bloom — held at zero until the raster actually opens, so the
          screen reads as OFF rather than as a lit blank panel. */}
      <motion.div
        className="absolute inset-0 bg-[#fff3e2]"
        initial={{ opacity: 0 }}
        animate={{ opacity: [0, 0, 0.44, 0.1, 0] }}
        transition={{ duration: 0.7, times: [0, 0.12, 0.3, 0.62, 1], ease: 'easeOut' }}
      />

      {/* The raster line itself, warm-cored the way an orange-phosphor tube
          blooms. Gone by the time the picture has opened. */}
      <motion.div
        className="absolute inset-x-0 top-1/2 h-[2px] -translate-y-1/2 bg-white"
        style={{
          boxShadow:
            '0 0 10px 3px rgba(255,255,255,0.85), 0 0 34px 10px rgba(255,122,26,0.6)',
        }}
        initial={{ opacity: 1, scaleX: 1.02 }}
        animate={{ opacity: [1, 1, 0], scaleX: [1.02, 1, 0.98] }}
        transition={{ duration: 0.32, times: [0, 0.55, 1], ease: 'easeOut' }}
      />

      {/* Scanlines, thinning out as the beam settles. */}
      <motion.div
        className="absolute inset-0"
        style={{
          backgroundImage:
            'repeating-linear-gradient(to bottom, rgba(0,0,0,0.5) 0px, rgba(0,0,0,0.5) 1px, transparent 1px, transparent 3px)',
        }}
        initial={{ opacity: 0 }}
        animate={{ opacity: [0, 0.5, 0.18, 0] }}
        transition={{ duration: 0.7, times: [0, 0.38, 0.72, 1], ease: 'linear' }}
      />

      {/* One roll-bar pass, the last thing to go before sync holds. */}
      <motion.div
        className="absolute inset-x-0 h-[22%] bg-gradient-to-b from-transparent via-white/[0.13] to-transparent"
        initial={{ y: '-30%' }}
        animate={{ y: '130%' }}
        transition={{ duration: 0.6, delay: 0.15, ease: 'linear' }}
      />
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Boot banner                                                               */
/* ────────────────────────────────────────────────────────────────────────── */

function useBootReveal(lineCount: number, replay: boolean) {
  const reduceMotion = useReducedMotion();
  // Read the flag during the first render so an already-booted session never
  // paints a single frame of the animated state.
  const [booted] = useState(() => {
    try {
      return sessionStorage.getItem(BOOT_FLAG) === '1';
    } catch {
      return false;
    }
  });
  // A clear is an explicit request for a fresh screen, so it replays the boot
  // even though a tab hop does not. Reduced motion still wins over both.
  const instant = (booted && !replay) || reduceMotion;
  const [shown, setShown] = useState(instant ? lineCount : 0);

  useEffect(() => {
    if (instant) return;
    let n = 0;
    const t = setInterval(() => {
      n += 1;
      setShown(n);
      if (n >= lineCount) {
        clearInterval(t);
        try {
          sessionStorage.setItem(BOOT_FLAG, '1');
        } catch {
          /* private mode — the banner simply animates again next time */
        }
      }
    }, BOOT_LINE_MS);
    return () => clearInterval(t);
  }, [instant, lineCount]);

  return { shown, animate: !instant };
}

/** Types one string out character by character. Used for the banner's first
 *  line only — a whole screen of typewriter is a wait, not an entrance. */
function useTypewriter(text: string, enabled: boolean) {
  const [n, setN] = useState(enabled ? 0 : text.length);
  useEffect(() => {
    if (!enabled) {
      setN(text.length);
      return;
    }
    let i = 0;
    const t = setInterval(() => {
      i += 1;
      setN(i);
      if (i >= text.length) clearInterval(t);
    }, TYPE_MS);
    return () => clearInterval(t);
  }, [text, enabled]);
  return text.slice(0, n);
}

function BootBanner({
  adminEmail,
  replay = false,
}: {
  adminEmail: string | null;
  /** Bypass the once-per-session flag (set after a /clear). */
  replay?: boolean;
}) {
  const lines = useMemo(
    () => [
      `${adminEmail ?? 'admin'} · session authenticated`,
      ...CONSOLE_BOOT_LINES,
    ],
    [adminEmail],
  );
  const { shown, animate } = useBootReveal(lines.length + 1, replay);
  const headline = useTypewriter('penny@simple-hris — admin console', animate && shown >= 1);

  return (
    <div className="font-mono text-[12px] leading-relaxed">
      <p className="text-[#ffa24d]">
        {headline}
        {animate && headline.length < 'penny@simple-hris — admin console'.length && <Caret />}
      </p>
      <div className="mt-1 space-y-0.5">
        {lines.map((line, i) => (
          <motion.p
            key={line}
            initial={animate ? { opacity: 0, x: -4 } : false}
            animate={shown > i + 1 ? { opacity: 1, x: 0 } : { opacity: 0, x: -4 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            className="text-[#8a7f73]"
          >
            <span className="select-none text-[#ff7a1a]/50">$ </span>
            {line}
          </motion.p>
        ))}
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/* /clear erase                                                              */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * The erase head for `/clear`.
 *
 * Read against the power-on so the two never blur into "the animation this
 * screen does": the power-on OPENS from the centre outward and takes 700ms,
 * this one SWEEPS top to bottom in 300ms. Different direction, different
 * duration, different event.
 *
 * The bar rides the exact boundary of the transcript's clip (both linear, both
 * `CLEAR_MS`), so the text does not fade out from under a decorative line — the
 * line is what removes it. Behind the bar is a short warm trail, which is the
 * one physically true thing about clearing a CRT: the phosphors do not switch
 * off, they decay, so the just-erased rows glow for a moment after the beam has
 * moved on.
 *
 * `top` is animated rather than `y` because a percentage `y` on a 2px bar
 * resolves against the bar's own height and would move it 2px. The bar is
 * absolutely positioned, so nothing reflows.
 */
function ClearSweep() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 z-10 overflow-hidden">
      {/* The trail: the decaying phosphor the head leaves behind it. Fixed
          height scaled from its top edge rather than an animated `height` —
          this is the large element here, so it stays on the compositor. */}
      <motion.div
        className="absolute inset-x-0 top-0 h-[38%] origin-top bg-gradient-to-b from-[#ff7a1a]/[0.16] to-transparent"
        initial={{ scaleY: 0, opacity: 0.9 }}
        animate={{ scaleY: [0, 1, 0], opacity: [0.9, 0.7, 0] }}
        transition={{ duration: CLEAR_MS / 1000 + 0.12, times: [0, 0.6, 1], ease: 'linear' }}
      />
      {/* The head itself. */}
      <motion.div
        className="absolute inset-x-0 h-[2px] bg-[#ffd9b8]"
        style={{ boxShadow: '0 0 8px 2px rgba(255,122,26,0.75), 0 0 22px 6px rgba(255,122,26,0.3)' }}
        initial={{ top: '0%', opacity: 1 }}
        animate={{ top: '100%', opacity: [1, 1, 0] }}
        transition={{ duration: CLEAR_MS / 1000, ease: 'linear', times: [0, 0.85, 1] }}
      />
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Command rail                                                              */
/* ────────────────────────────────────────────────────────────────────────── */

/** Key bindings the surface actually implements. Listed beside the commands
 *  because "what can I press here" is the same question as "what can I type". */
const CONSOLE_KEYS: { keys: string; describes: string }[] = [
  { keys: 'enter', describes: 'send' },
  { keys: 'shift enter', describes: 'new line' },
];

/**
 * The left rail — a standing reference for what you can type, so the commands
 * are remembered by being visible rather than by being memorised (Kane:
 * "add the commands at the left side so we can remember the functions").
 *
 * Driven by `CONSOLE_COMMAND_HINTS`, the same list whose test asserts every row
 * resolves to a real command. One list, so the rail cannot advertise something
 * the matcher does not answer.
 *
 * Clicking a row **inserts** the command into the prompt and focuses it — it
 * does not run it. Uniform for every command (a future one taking an argument
 * needs you to finish typing), and a stray click can never wipe a transcript
 * you were reading. The Enter you press afterwards is the one that acts.
 *
 * Hidden below `lg`, where 188px of rail would come straight out of the
 * transcript's measure; the compact hint under the prompt is the affordance
 * there, so it never disappears entirely.
 */
function CommandRail({ onInsert }: { onInsert: (command: string) => void }) {
  return (
    <aside
      className="hidden w-[188px] shrink-0 flex-col overflow-y-auto border-r border-[#1c1c22] bg-[#0d0d11] px-2 py-3 lg:flex"
      aria-label="Console commands"
    >
      <h2 className="px-2 pb-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-[#6e655d]">
        Commands
      </h2>
      <ul className="space-y-0.5">
        {CONSOLE_COMMAND_HINTS.map((h) => (
          <li key={h.command}>
            <button
              type="button"
              onClick={() => onInsert(h.command)}
              title={`Insert ${h.command}`}
              className="group flex w-full flex-col items-start gap-0.5 rounded px-2 py-1.5 text-left transition-colors hover:bg-[#ff7a1a]/[0.07]"
            >
              <span className="font-mono text-[11.5px] text-[#ffa24d] group-hover:text-[#ff7a1a]">
                {h.command}
              </span>
              <span className="font-mono text-[10px] leading-snug text-[#6e655d] group-hover:text-[#8a7f73]">
                {h.describes}
              </span>
            </button>
          </li>
        ))}
      </ul>

      <h2 className="mt-4 px-2 pb-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-[#6e655d]">
        Keys
      </h2>
      <ul className="space-y-1 px-2">
        {CONSOLE_KEYS.map((k) => (
          <li key={k.keys} className="flex items-baseline gap-1.5">
            <kbd className="rounded border border-[#2a2a31] bg-[#141418] px-1 py-px font-mono text-[9.5px] text-[#a89a8d]">
              {k.keys}
            </kbd>
            <span className="font-mono text-[10px] text-[#6e655d]">{k.describes}</span>
          </li>
        ))}
      </ul>
    </aside>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Activity readout                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

function elapsedLabel(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * The live step log. Each row is a tool the route really called; the tail row
 * carries the caret. Once tokens start arriving the tools are finished, so the
 * tail becomes "Writing the answer" — the one phase the client can assert on
 * its own, because it can see the text.
 */
function ActivityLog({
  steps,
  busy,
  writing,
  elapsed,
}: {
  steps: { name: string; at: number }[];
  busy: boolean;
  writing: boolean;
  elapsed: number;
}) {
  const reduceMotion = useReducedMotion();
  const [open, setOpen] = useState(false);
  const rows = steps;

  // Finished: one dim line, expandable. The step list is evidence for the
  // answer above it, so it stays reachable rather than disappearing.
  if (!busy) {
    if (rows.length === 0) return null;
    return (
      <div className="border-t border-[#1c1c22] px-3 py-2 sm:px-4">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="group flex items-center gap-1.5 font-mono text-[11px] text-[#6e655d] transition-colors hover:text-[#a89a8d]"
          aria-expanded={open}
        >
          <ChevronRight
            className={cn('h-3 w-3 transition-transform', open && 'rotate-90')}
            aria-hidden
          />
          {rows.length} {rows.length === 1 ? 'step' : 'steps'} · {elapsedLabel(elapsed)}
        </button>
        <AnimatePresence initial={false}>
          {open && (
            <motion.ul
              initial={reduceMotion ? false : { height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={reduceMotion ? undefined : { height: 0, opacity: 0 }}
              transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
              className="overflow-hidden"
            >
              {rows.map((s, i) => (
                <li
                  key={`${s.name}-${i}`}
                  className="flex items-center gap-2 pt-1 font-mono text-[11px] text-[#8a7f73]"
                >
                  <Check className="h-3 w-3 shrink-0 text-[#ff7a1a]/60" aria-hidden />
                  {phaseForTool(s.name)}
                </li>
              ))}
            </motion.ul>
          )}
        </AnimatePresence>
      </div>
    );
  }

  return (
    <div
      className="border-t border-[#1c1c22] px-3 py-2.5 sm:px-4"
      aria-live="polite"
      aria-label="Penny progress"
    >
      <ul className="space-y-1">
        {rows.map((s, i) => {
          const current = !writing && i === rows.length - 1;
          return (
            <motion.li
              key={`${s.name}-${i}`}
              initial={reduceMotion ? false : { opacity: 0, x: -6 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
              className={cn(
                'flex items-center gap-2 font-mono text-[11.5px]',
                current ? 'text-[#ffa24d]' : 'text-[#6e655d]',
              )}
            >
              {current ? (
                <Square
                  className={cn('h-2 w-2 shrink-0 fill-current', !reduceMotion && 'animate-pulse')}
                  aria-hidden
                />
              ) : (
                <Check className="h-3 w-3 shrink-0 text-[#ff7a1a]/50" aria-hidden />
              )}
              <span className="min-w-0 truncate">
                {phaseForTool(s.name)}
                {current && '…'}
              </span>
              {current && <Caret className="ml-0.5 shrink-0" />}
            </motion.li>
          );
        })}

        {/* The head of the queue before any tool has been named, and the tail
            once text is arriving — both states the client can prove. */}
        {(rows.length === 0 || writing) && (
          <li className="flex items-center gap-2 font-mono text-[11.5px] text-[#ffa24d]">
            <Square
              className={cn('h-2 w-2 shrink-0 fill-current', !reduceMotion && 'animate-pulse')}
              aria-hidden
            />
            <span>{writing ? 'Writing the answer…' : 'Reading the question…'}</span>
            <Caret className="ml-0.5 shrink-0" />
          </li>
        )}
      </ul>
      <p className="mt-1.5 pl-[1.15rem] font-mono text-[10.5px] tabular-nums text-[#4f4842]">
        {elapsedLabel(elapsed)}
      </p>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Console                                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

export default function AdminPennyConsole({
  endpoint,
  adminEmail,
  suggestions,
}: {
  endpoint: string;
  adminEmail: string | null;
  /** Starter commands for the empty state. */
  suggestions: { title: string; sub: string }[];
}) {
  const reduceMotion = useReducedMotion();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const {
    messages,
    input,
    setInput,
    busy,
    send,
    clearChat,
    rateMessage,
    lastMsg,
    activity,
  } = useCeoChat({ inputRef, endpoint });

  const empty = messages.length === 0;
  const streamingReply = busy && lastMsg?.role === 'assistant' ? lastMsg : null;
  const writing = !!streamingReply && streamingReply.content.length > 0;

  /* The CRT power-on. Armed on mount — the Admin shell unmounts every tab, so
     mounting IS "switching to the Penny AI tab". */
  const [crtRunning, setCrtRunning] = useState(() => reduceMotion !== true);
  useEffect(() => {
    if (!crtRunning) return;
    const t = setTimeout(() => setCrtRunning(false), CRT_MS + 40);
    return () => clearTimeout(t);
  }, [crtRunning]);
  // `useReducedMotion` can resolve after the first paint; honour a late true.
  useEffect(() => {
    if (reduceMotion) setCrtRunning(false);
  }, [reduceMotion]);

  /* `/clear`. The transcript is swapped when the erase head reaches the bottom,
     not when the command is typed — so the content the head passes over is the
     content being removed, rather than a blank screen with a line on it.
     `bootEpoch` re-types the banner afterwards: a clear is an explicit request
     for a fresh screen, so unlike a tab hop it has earned the boot sequence. */
  const [clearing, setClearing] = useState(false);
  const [bootEpoch, setBootEpoch] = useState(0);
  useEffect(() => {
    if (!clearing) return;
    const finish = () => {
      clearChat(); // also drops the activity log
      setBootEpoch((n) => n + 1);
      setClearing(false);
      inputRef.current?.focus();
    };
    // Under reduced motion there is no sweep to wait for.
    if (reduceMotion) {
      finish();
      return;
    }
    const t = setTimeout(finish, CLEAR_MS);
    return () => clearTimeout(t);
    // clearChat is stable for the life of the hook; re-running on it would
    // restart the timer mid-sweep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clearing, reduceMotion]);

  /* Elapsed time for the question in flight — a real clock, started on send.
     The interval is torn down when `busy` clears, which leaves the last value
     standing as the finished duration. */
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!busy) return;
    const began = Date.now();
    setElapsed(0);
    const t = setInterval(() => setElapsed(Date.now() - began), 100);
    return () => clearInterval(t);
  }, [busy]);

  /* Pin the transcript to the newest content: instant while tokens stream so it
     keeps up, smooth when a message lands. */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: busy ? 'auto' : 'smooth' });
  }, [messages, busy, activity.length]);

  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 180);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

  /**
   * The single submit path — the Enter key AND the send button both go through
   * here, so a command can never work in one and get sent to the model in the
   * other. Anything `resolveConsoleCommand` does not claim is Penny's.
   */
  function submit(text: string) {
    // The erase owns the screen for 300ms. A second /clear or a question landing
    // mid-sweep would swap content out from under the head.
    if (clearing) return;

    const command = resolveConsoleCommand(text);
    if (command === 'clear') {
      // The prompt empties NOW — the erase is about the transcript, and a
      // command still sitting at a prompt that is being wiped looks stuck.
      setInput('');
      setClearing(true);
      return;
    }
    void send(text);
  }

  function onComposerKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit(input);
    }
  }

  return (
    <div className="penny-console flex h-full min-h-0 flex-col bg-[#08080a] p-2 sm:p-4 lg:p-6">
      {/*
        Scoped browser-surface theming. The caret, the text selection and the
        scrollbar all ship with defaults that belong to no design system, and
        inside a console they are the tell. Every rule is namespaced under
        .penny-console so nothing leaks into the rest of Admin.
      */}
      <style>{`
        @keyframes pennyCaretBlink { 0%, 49% { opacity: 1 } 50%, 100% { opacity: 0 } }
        .penny-caret { animation: pennyCaretBlink 1.05s step-end infinite; }
        @keyframes pennyScan { from { transform: translateX(-100%) } to { transform: translateX(320%) } }
        .penny-scan { animation: pennyScan 1.25s linear infinite; }
        .penny-console ::selection { background: #ff7a1a; color: #08080a; }
        .penny-console *::-webkit-scrollbar { width: 9px; height: 9px; }
        .penny-console *::-webkit-scrollbar-track { background: #0b0b0d; }
        .penny-console *::-webkit-scrollbar-thumb {
          background: #2f2a25; border: 2px solid #0b0b0d; border-radius: 999px;
        }
        .penny-console *::-webkit-scrollbar-thumb:hover { background: #ff7a1a; }
        .penny-console * { scrollbar-color: #2f2a25 #0b0b0d; scrollbar-width: thin; }
        @media (prefers-reduced-motion: reduce) {
          .penny-caret, .penny-scan { animation: none; }
        }
      `}</style>

      {/* The panel's box, so the CRT overlay can sit over exactly the same rect
          WITHOUT being squashed by the raster transform below. */}
      <div className="relative mx-auto h-full min-h-0 w-full max-w-[1080px]">
      <motion.section
        /* The geometry half of the power-on: the raster is collapsed to a line,
           holds for a beat, then opens vertically while a slight horizontal
           overscan settles inward. Content squashes with it, which is what a
           real tube does — the picture IS the raster. Transforms only, so this
           half stays on the compositor and leaves no residual filter behind. */
        initial={
          reduceMotion ? false : { scaleY: 0.006, scaleX: 1.035, opacity: 1 }
        }
        animate={
          reduceMotion
            ? { scaleY: 1, scaleX: 1, opacity: 1 }
            : { scaleY: [0.006, 0.006, 1, 1], scaleX: [1.035, 1.035, 1.012, 1] }
        }
        transition={
          reduceMotion
            ? { duration: 0 }
            : {
                duration: 0.7,
                times: [0, 0.12, 0.58, 1],
                ease: ['linear', [0.16, 1, 0.3, 1], [0.33, 1, 0.68, 1]],
              }
        }
        className={cn(
          'relative flex h-full min-h-0 w-full flex-col overflow-hidden',
          'rounded-lg border border-[#26262d] bg-[#101014] sm:rounded-xl',
          'shadow-[0_28px_80px_-24px_rgba(0,0,0,0.95)]',
        )}
      >
        {/* A single hairline of warmth along the top edge — the panel catching
            the accent, not a gradient treatment. */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[#ff7a1a]/40 to-transparent"
        />

        {/* ── Title bar ─────────────────────────────────────────────────── */}
        <header className="flex shrink-0 items-center gap-2.5 border-b border-[#1c1c22] bg-[#0d0d11] px-3 py-2 sm:px-4">
          <Terminal className="h-3.5 w-3.5 shrink-0 text-[#ff7a1a]" aria-hidden />
          <h1 className="min-w-0 truncate font-mono text-[12.5px] text-[#e8ded2]">
            penny@simple-hris
            <span className="text-[#4f4842]">:~</span>
          </h1>
          <span
            aria-hidden
            className={cn(
              'ml-1 h-1.5 w-1.5 shrink-0 rounded-full',
              busy ? cn('bg-[#ff7a1a]', !reduceMotion && 'animate-pulse') : 'bg-[#2f6b3d]',
            )}
          />
          <span className="hidden shrink-0 font-mono text-[10.5px] uppercase tracking-[0.14em] text-[#6e655d] sm:inline">
            {busy ? 'working' : 'ready'}
          </span>

          <div className="ml-auto flex shrink-0 items-center gap-2">
            {busy && (
              <span className="font-mono text-[11px] tabular-nums text-[#8a7f73]">
                {elapsedLabel(elapsed)}
              </span>
            )}
            {!empty && (
              <button
                type="button"
                onClick={clearChat}
                className="rounded border border-[#2a2a31] px-2 py-1 font-mono text-[10.5px] uppercase tracking-[0.1em] text-[#8a7f73] transition-colors hover:border-[#ff7a1a]/50 hover:text-[#ffa24d]"
              >
                clear
              </button>
            )}
          </div>
        </header>

        {/* Everything below the title bar is rail + column, so the title bar
            still spans the full window the way a window title bar should. */}
        <div className="flex min-h-0 min-w-0 flex-1">
          <CommandRail
            onInsert={(command) => {
              setInput(command);
              inputRef.current?.focus();
            }}
          />

          <div className="flex min-h-0 min-w-0 flex-1 flex-col">

        {/* ── Transcript ────────────────────────────────────────────────── */}
        <div className="relative flex min-h-0 flex-1 flex-col">
        <motion.div
          ref={scrollRef}
          className="min-h-0 flex-1 overflow-y-auto px-3 py-3 sm:px-4 sm:py-4"
          /* The erase: the top of the transcript is clipped away downward, in
             lockstep with the head sweeping over it (same duration, both
             linear). Not a fade — the line is what removes the text. */
          animate={
            clearing && !reduceMotion
              ? { clipPath: 'inset(100% 0% 0% 0%)' }
              : { clipPath: 'inset(0% 0% 0% 0%)' }
          }
          transition={
            clearing && !reduceMotion
              ? { duration: CLEAR_MS / 1000, ease: 'linear' }
              : { duration: 0 }
          }
        >
          <BootBanner key={bootEpoch} adminEmail={adminEmail} replay={bootEpoch > 0} />

          {empty ? (
            <div className="mt-5">
              <motion.p
                initial={reduceMotion ? false : { opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.3, delay: reduceMotion ? 0 : 0.62 }}
                className="font-mono text-[11px] text-[#6e655d]"
              >
                {CONSOLE_IDLE_LINE}
              </motion.p>
              <ul className="mt-3 space-y-1.5">
                {suggestions.map((s, i) => (
                  <motion.li
                    key={s.title}
                    initial={reduceMotion ? false : { opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{
                      duration: 0.3,
                      delay: reduceMotion ? 0 : 0.75 + i * 0.07,
                      ease: [0.22, 1, 0.36, 1],
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => void send(s.title)}
                      className="group flex w-full items-baseline gap-2 rounded border border-transparent px-2 py-1.5 text-left transition-colors hover:border-[#ff7a1a]/25 hover:bg-[#ff7a1a]/[0.06]"
                    >
                      <span
                        aria-hidden
                        className="select-none font-mono text-[12px] text-[#ff7a1a]/60 group-hover:text-[#ff7a1a]"
                      >
                        $
                      </span>
                      <span className="min-w-0">
                        <span className="block font-mono text-[12.5px] text-[#e8ded2]">
                          {s.title}
                        </span>
                        <span className="mt-0.5 block font-mono text-[10.5px] text-[#6e655d]">
                          {s.sub}
                        </span>
                      </span>
                    </button>
                  </motion.li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="mt-4 space-y-4">
              {messages.map((m) => {
                const isStreaming = busy && m.id === lastMsg?.id && m.role === 'assistant';
                const showRating = m.role === 'assistant' && !!m.content && !isStreaming;

                // The user's turn is a COMMAND — prompt marker, mono, accent.
                if (m.role === 'user') {
                  return (
                    <motion.div
                      key={m.id}
                      initial={reduceMotion ? false : { opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
                      className="flex items-baseline gap-2"
                    >
                      <span aria-hidden className="select-none font-mono text-[13px] text-[#ff7a1a]">
                        $
                      </span>
                      <p className="min-w-0 whitespace-pre-wrap break-words font-mono text-[13px] leading-relaxed text-[#ffd9b8]">
                        {m.content}
                      </p>
                    </motion.div>
                  );
                }

                // Penny's answer: prose in the app's sans at a readable measure —
                // mono belongs to the chrome and to data, not to paragraphs.
                return (
                  <motion.div
                    key={m.id}
                    initial={reduceMotion ? false : { opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
                    className="pl-[1.35rem]"
                  >
                    {m.content ? (
                      <div className="max-w-[72ch] text-[13.5px] leading-relaxed text-[#e8ded2]">
                        <AssistantContent text={m.content} streaming={isStreaming} tone="console" />
                        {isStreaming && <Caret className="ml-0.5" />}
                      </div>
                    ) : null}
                    {showRating && (
                      <div className="mt-1.5">
                        <MessageFeedback
                          rating={m.rating}
                          onRate={(rating, comment) => void rateMessage(m, rating, comment)}
                          tone="console"
                        />
                      </div>
                    )}
                  </motion.div>
                );
              })}
            </div>
          )}
        </motion.div>
          {clearing && !reduceMotion && <ClearSweep />}
        </div>

        {/* ── Activity readout ──────────────────────────────────────────────
            Suppressed on an empty transcript. `clearChat` does not abort an
            in-flight request, so `busy` can still be true right after a clear —
            and a step log for a conversation that no longer exists would be
            reporting work you cannot see the result of. */}
        {messages.length > 0 && !clearing && (
          <ActivityLog steps={activity} busy={busy} writing={writing} elapsed={elapsed} />
        )}

        {/* ── Prompt line ───────────────────────────────────────────────── */}
        <div className="relative shrink-0 border-t border-[#26262d] bg-[#0b0b0d] px-3 py-2.5 sm:px-4">
          {/* Scan line while a request is in flight — transform only, and gone
              under reduced motion (the readout above carries the state in text). */}
          {busy && !reduceMotion && (
            <span
              aria-hidden
              className="penny-scan pointer-events-none absolute left-0 top-0 h-px w-1/3 bg-gradient-to-r from-transparent via-[#ff7a1a] to-transparent"
            />
          )}

          <div className="flex items-end gap-2">
            <span
              aria-hidden
              className="select-none pb-1 font-mono text-[13px] leading-relaxed text-[#ff7a1a]"
            >
              $
            </span>

            <div className="relative flex min-w-0 flex-1 items-end">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onComposerKey}
                rows={1}
                // Deliberately NOT disabled while busy: the old tab let you
                // compose the next question during a reply, and a 5–10s audit
                // query is exactly when you want to. Only Send is gated.
                placeholder="query the audit log, the probes, payroll state, a person…"
                aria-label="Ask Penny"
                className={cn(
                  'max-h-[160px] min-h-[22px] w-full resize-none bg-transparent py-0.5',
                  'font-mono text-[13px] leading-relaxed text-[#e8ded2] outline-none',
                  'placeholder:text-[#4f4842] disabled:cursor-not-allowed',
                  // A real caret once there is text to edit; hidden while empty
                  // so the block caret below can stand in its place.
                  input ? 'caret-[#ff7a1a]' : 'caret-transparent',
                )}
              />
              {/* The resting caret: shown whenever the field is empty — including
                  mid-reply — so the prompt never looks dead while Penny works. */}
              {!input && (
                <span className="pointer-events-none absolute bottom-[0.2rem] left-0">
                  <Caret />
                </span>
              )}
            </div>

            <button
              type="button"
              onClick={() => submit(input)}
              disabled={busy || !input.trim()}
              aria-label="Send"
              className={cn(
                'mb-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded',
                'bg-[#ff7a1a] text-black transition-colors hover:bg-[#ffa24d]',
                'disabled:cursor-not-allowed disabled:bg-[#26262d] disabled:text-[#6e655d]',
              )}
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <ArrowUp className="h-3.5 w-3.5" aria-hidden strokeWidth={2.5} />
              )}
            </button>
          </div>

          {/* Below `lg` this is the commands' only affordance — the rail is
              hidden there, and an affordance that vanishes at a breakpoint is a
              feature that vanishes with it. Redundant at lg+, so hidden there. */}
          <p className="mt-1.5 flex flex-wrap items-baseline gap-x-2 pl-[1.15rem] font-mono text-[10px] text-[#4f4842]">
            {CONSOLE_COMMAND_HINTS.map((h) => (
              <span key={h.command} className="lg:hidden">
                <span className="text-[#ffa24d]">{h.command}</span>
                <span className="text-[#6e655d]"> {h.describes}</span>
                <span aria-hidden className="text-[#33302c]"> ·</span>
              </span>
            ))}
            <span>Read-only, audited. Penny can be wrong — verify figures before acting.</span>
          </p>
        </div>
          </div>
        </div>
      </motion.section>

        {/* Unmounts the moment the tube has warmed up. */}
        {crtRunning && <CrtPowerOn />}
      </div>
    </div>
  );
}
