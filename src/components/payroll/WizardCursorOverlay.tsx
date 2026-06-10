'use client';

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import {
  motion,
  AnimatePresence,
  useMotionValue,
  useSpring,
  useTransform,
} from 'motion/react';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';

const BROADCAST_CHANNEL = 'payroll-wizard-cursors';
const THROTTLE_MS        = 16; // ~60 fps
const TYPING_THROTTLE_MS = 30; // ~33 fps
const SCROLL_THROTTLE_MS = 16; // ~60 fps
const CURSOR_TTL_MS      = 4500;
const TYPING_FADE_MS     = 4000; // clear typing chip if no update for this long

const PALETTE = [
  { bg: '#f43f5e', glow: 'rgba(244,63,94,0.55)' },
  { bg: '#f97316', glow: 'rgba(249,115,22,0.55)' },
  { bg: '#eab308', glow: 'rgba(234,179,8,0.55)' },
  { bg: '#10b981', glow: 'rgba(16,185,129,0.55)' },
  { bg: '#06b6d4', glow: 'rgba(6,182,212,0.55)' },
  { bg: '#3b82f6', glow: 'rgba(59,130,246,0.55)' },
  { bg: '#a855f7', glow: 'rgba(168,85,247,0.55)' },
  { bg: '#ec4899', glow: 'rgba(236,72,153,0.55)' },
];

function hashEmail(email: string) {
  let h = 0;
  for (let i = 0; i < email.length; i++) h = ((h << 5) - h + email.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

function toLabel(email: string) {
  return (email.split('@')[0] ?? email).slice(0, 14);
}

// ─── per-cursor component ────────────────────────────────────────────────────
function RemoteCursor({
  email,
  x,
  y,
  color,
  glow,
  typingLabel,
  typingValue,
}: {
  email: string;
  x: number;
  y: number;
  color: string;
  glow: string;
  typingLabel?: string;
  typingValue?: string;
}) {
  const xMv = useMotionValue(x);
  const yMv = useMotionValue(y);
  const sx = useSpring(xMv, { stiffness: 700, damping: 44, mass: 0.07 });
  const sy = useSpring(yMv, { stiffness: 700, damping: 44, mass: 0.07 });
  const left = useTransform(sx, v => `${v}%`);
  const top  = useTransform(sy, v => `${v}%`);

  useEffect(() => { xMv.set(x); }, [x, xMv]);
  useEffect(() => { yMv.set(y); }, [y, yMv]);

  const showTyping = typingLabel !== undefined || typingValue !== undefined;

  return (
    <motion.div
      className="absolute"
      style={{ left, top }}
      initial={{ opacity: 0, scale: 0.45 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.25, transition: { duration: 0.16 } }}
      transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
    >
      {/* Cursor arrow */}
      <svg
        width="22"
        height="22"
        viewBox="0 0 22 22"
        fill="none"
        style={{
          filter: `drop-shadow(0 0 6px ${glow}) drop-shadow(0 1px 3px rgba(0,0,0,0.55))`,
        }}
      >
        <path
          d="M4 2L17.5 9.5L11 11.5L8.5 19L4 2Z"
          fill={color}
          stroke="rgba(255,255,255,0.88)"
          strokeWidth="1"
          strokeLinejoin="round"
        />
      </svg>

      {/* Name badge */}
      <div
        className="absolute left-5 top-4 flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1"
        style={{
          background: 'rgba(9,9,11,0.86)',
          backdropFilter: 'blur(12px)',
          border: `1px solid ${color}44`,
          boxShadow: `0 0 10px ${glow}, 0 2px 8px rgba(0,0,0,0.35)`,
        }}
      >
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ background: color, boxShadow: `0 0 5px ${color}` }}
        />
        <span
          className="font-mono text-[10px] font-medium leading-none tracking-tight"
          style={{ color: '#e4e4e7' }}
        >
          {toLabel(email)}
        </span>
      </div>

      {/* Typing chip — appears below the name badge when driver is in an input */}
      <AnimatePresence>
        {showTyping && (
          <motion.div
            key="typing"
            className="absolute left-5 top-[2.1rem] flex items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-1"
            style={{
              background: 'rgba(9,9,11,0.92)',
              backdropFilter: 'blur(12px)',
              border: `1px solid ${color}55`,
              boxShadow: `0 0 8px ${glow}, 0 2px 6px rgba(0,0,0,0.4)`,
              maxWidth: '14rem',
            }}
            initial={{ opacity: 0, y: -4, scale: 0.92 }}
            animate={{ opacity: 1, y: 0,  scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.92, transition: { duration: 0.14 } }}
            transition={{ type: 'spring', stiffness: 480, damping: 32 }}
          >
            {/* Blinking caret */}
            <motion.span
              className="h-3 w-px shrink-0 rounded-full"
              style={{ background: color }}
              animate={{ opacity: [1, 0, 1] }}
              transition={{ duration: 0.9, repeat: Infinity, ease: 'linear' }}
            />
            <div className="flex min-w-0 flex-col gap-px leading-none">
              {typingLabel && (
                <span
                  className="truncate text-[9px] uppercase tracking-widest"
                  style={{ color: `${color}cc` }}
                >
                  {typingLabel}
                </span>
              )}
              <span
                className="truncate font-mono text-[11px] font-semibold"
                style={{ color: '#f4f4f5' }}
              >
                {typingValue !== undefined && typingValue !== ''
                  ? typingValue
                  : <span style={{ color: '#52525b' }}>…</span>}
              </span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// ─── types ───────────────────────────────────────────────────────────────────
interface CursorState {
  x: number; y: number;
  color: string; glow: string;
  lastSeen: number;
  typingLabel?: string;
  typingValue?: string;
  typingAt?: number;
}

interface ClickRipple { id: number; x: number; y: number; color: string; glow: string; }
interface SaveToast  { id: number; label: string; color: string; glow: string; }

type BroadcastMsg =
  | { kind: 'move';   email: string; x: number; y: number }
  | { kind: 'click';  email: string; x: number; y: number }
  | { kind: 'save';   email: string }
  | { kind: 'focus';  email: string; label: string }
  | { kind: 'typing'; email: string; value: string }
  | { kind: 'blur';   email: string }
  | { kind: 'scroll'; email: string; pct: number };

export interface WizardCursorOverlayHandle {
  broadcastSave(): void;
  /** Immediately apply the last cached scroll position for a given driver email.
   *  Call this when a spectator resumes observing so they jump to the driver's
   *  current scroll without waiting for the next scroll broadcast. */
  applyDriverScroll(driverEmail: string): void;
}

interface Props {
  selfEmail: string | null | undefined;
  containerRef: React.RefObject<HTMLElement | null>;
  /** Only the driver should broadcast scroll so spectators don't fight each other. */
  isDriver?: boolean;
  /** Spectators apply incoming scroll; non-spectators ignore it. */
  isSpectator?: boolean;
}

// ─── overlay ─────────────────────────────────────────────────────────────────
const WizardCursorOverlay = forwardRef<WizardCursorOverlayHandle, Props>(
  function WizardCursorOverlay({ selfEmail, containerRef, isDriver, isSpectator }, ref) {
    const [cursors,    setCursors]    = useState<Map<string, CursorState>>(new Map());
    const [ripples,    setRipples]    = useState<ClickRipple[]>([]);
    const [saveToasts, setSaveToasts] = useState<SaveToast[]>([]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const channelRef       = useRef<any>(null);
    const lastMoveRef      = useRef(0);
    const lastTypingRef    = useRef(0);
    const lastScrollRef    = useRef(0);
    const idRef            = useRef(0);
    const isDriverRef      = useRef(isDriver);
    const isSpectatorRef   = useRef(isSpectator);
    isDriverRef.current    = isDriver;
    isSpectatorRef.current = isSpectator;
    // Cached scroll position per peer (lowercase email → pct 0–1).
    // Updated regardless of observing state so resume is instant.
    const lastScrollPctRef = useRef<Map<string, number>>(new Map());

    const send = useCallback((msg: BroadcastMsg) => {
      channelRef.current?.send({ type: 'broadcast', event: 'wc', payload: msg });
    }, []);

    useImperativeHandle(ref, () => ({
      broadcastSave() {
        if (!selfEmail) return;
        send({ kind: 'save', email: selfEmail });
        spawnSaveToast(selfEmail);
      },
      applyDriverScroll(driverEmail: string) {
        const pct = lastScrollPctRef.current.get(driverEmail.trim().toLowerCase());
        if (pct === undefined) return;
        const viewport = containerRef.current?.querySelector(
          '[data-slot="scroll-area-viewport"]',
        ) as HTMLElement | null;
        if (!viewport) return;
        const max = viewport.scrollHeight - viewport.clientHeight;
        if (max <= 0) return;
        viewport.scrollTop = pct * max;
      },
    }), [selfEmail, send, containerRef]); // eslint-disable-line react-hooks/exhaustive-deps

    const spawnSaveToast = useCallback((email: string) => {
      const id = ++idRef.current;
      const { bg: color, glow } = hashEmail(email);
      const label = toLabel(email);
      setSaveToasts(prev => [...prev, { id, label, color, glow }]);
      setTimeout(() => setSaveToasts(prev => prev.filter(t => t.id !== id)), 3200);
    }, []);

    // ── Supabase broadcast channel ────────────────────────────────────────────
    useEffect(() => {
      const supabase = getSupabaseBrowserClient();
      if (!supabase || !selfEmail) return;

      const ch = supabase.channel(BROADCAST_CHANNEL, {
        config: { broadcast: { self: false } },
      });
      channelRef.current = ch;

      ch.on('broadcast', { event: 'wc' }, ({ payload }: { payload: BroadcastMsg }) => {
        if (!payload?.email || payload.email === selfEmail) return;
        const { bg: color, glow } = hashEmail(payload.email);

        if (payload.kind === 'move') {
          setCursors(prev => {
            const next = new Map(prev);
            const existing = next.get(payload.email);
            next.set(payload.email, {
              ...existing,
              x: payload.x, y: payload.y,
              color, glow,
              lastSeen: Date.now(),
            });
            return next;
          });

        } else if (payload.kind === 'click') {
          const id = ++idRef.current;
          setRipples(prev => [...prev, { id, x: payload.x, y: payload.y, color, glow }]);

        } else if (payload.kind === 'save') {
          spawnSaveToast(payload.email);

        } else if (payload.kind === 'focus') {
          setCursors(prev => {
            const next = new Map(prev);
            const existing = next.get(payload.email);
            if (!existing) return prev; // cursor not visible yet — skip
            next.set(payload.email, {
              ...existing,
              typingLabel: payload.label,
              typingValue: '',
              typingAt: Date.now(),
            });
            return next;
          });

        } else if (payload.kind === 'typing') {
          setCursors(prev => {
            const next = new Map(prev);
            const existing = next.get(payload.email);
            if (!existing) return prev;
            next.set(payload.email, {
              ...existing,
              typingValue: payload.value,
              typingAt: Date.now(),
            });
            return next;
          });

        } else if (payload.kind === 'blur') {
          setCursors(prev => {
            const next = new Map(prev);
            const existing = next.get(payload.email);
            if (!existing) return prev;
            next.set(payload.email, {
              ...existing,
              typingLabel: undefined,
              typingValue: undefined,
              typingAt: undefined,
            });
            return next;
          });

        } else if (payload.kind === 'scroll') {
          // Always cache — so applyDriverScroll() works instantly on resume.
          lastScrollPctRef.current.set(payload.email.trim().toLowerCase(), payload.pct);
          // Only apply live scrolling when this client is actively spectating.
          if (!isSpectatorRef.current) return;
          const viewport = containerRef.current?.querySelector(
            '[data-slot="scroll-area-viewport"]',
          ) as HTMLElement | null;
          if (!viewport) return;
          const max = viewport.scrollHeight - viewport.clientHeight;
          if (max <= 0) return;
          viewport.scrollTop = payload.pct * max;
        }
      }).subscribe();

      return () => { void supabase.removeChannel(ch); channelRef.current = null; };
    }, [selfEmail, containerRef, spawnSaveToast]);

    // ── Mouse + input + focus + scroll listeners on the wizard container ──────
    useEffect(() => {
      const el = containerRef.current;
      if (!el || !selfEmail) return;

      const onMove = (e: MouseEvent) => {
        const now = Date.now();
        if (now - lastMoveRef.current < THROTTLE_MS) return;
        lastMoveRef.current = now;
        const r = el.getBoundingClientRect();
        send({
          kind: 'move', email: selfEmail,
          x: ((e.clientX - r.left) / r.width)  * 100,
          y: ((e.clientY - r.top)  / r.height) * 100,
        });
      };

      const onClick = (e: MouseEvent) => {
        const r = el.getBoundingClientRect();
        const x = ((e.clientX - r.left) / r.width)  * 100;
        const y = ((e.clientY - r.top)  / r.height) * 100;
        send({ kind: 'click', email: selfEmail, x, y });
        const id = ++idRef.current;
        const { bg: color, glow } = hashEmail(selfEmail);
        setRipples(prev => [...prev, { id, x, y, color, glow }]);
      };

      // focusin/focusout bubble (unlike focus/blur), so we can listen on the container
      const onFocusIn = (e: FocusEvent) => {
        const target = e.target as HTMLElement;
        if (!['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) return;
        const label =
          (target as HTMLInputElement).placeholder?.trim() ||
          target.getAttribute('aria-label')?.trim() ||
          target.getAttribute('name')?.trim() ||
          target.tagName.toLowerCase();
        send({ kind: 'focus', email: selfEmail, label: label ?? target.tagName });
        // Send current value immediately so spectators see the field state on focus
        send({ kind: 'typing', email: selfEmail, value: (target as HTMLInputElement).value ?? '' });
      };

      const onInputChange = (e: Event) => {
        const target = e.target as HTMLInputElement;
        if (!['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) return;
        const now = Date.now();
        if (now - lastTypingRef.current < TYPING_THROTTLE_MS) return;
        lastTypingRef.current = now;
        const value = target.type === 'checkbox' ? String(target.checked) : (target.value ?? '');
        send({ kind: 'typing', email: selfEmail, value });
      };

      const onFocusOut = (e: FocusEvent) => {
        const target = e.target as HTMLElement;
        if (!['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) return;
        send({ kind: 'blur', email: selfEmail });
      };

      el.addEventListener('mousemove', onMove as EventListener);
      el.addEventListener('click',     onClick as EventListener);
      el.addEventListener('focusin',   onFocusIn as EventListener);
      el.addEventListener('input',     onInputChange as EventListener);
      el.addEventListener('change',    onInputChange as EventListener);
      el.addEventListener('focusout',  onFocusOut as EventListener);

      return () => {
        el.removeEventListener('mousemove', onMove as EventListener);
        el.removeEventListener('click',     onClick as EventListener);
        el.removeEventListener('focusin',   onFocusIn as EventListener);
        el.removeEventListener('input',     onInputChange as EventListener);
        el.removeEventListener('change',    onInputChange as EventListener);
        el.removeEventListener('focusout',  onFocusOut as EventListener);
      };
    }, [selfEmail, containerRef, send]);

    // ── Scroll broadcast — driver only ────────────────────────────────────────
    // Scroll doesn't bubble so we attach directly to the scroll area viewport.
    // We look it up after the component mounts; the viewport is always present
    // by then since we're rendered as a sibling inside the wizard container.
    useEffect(() => {
      if (!selfEmail) return;

      // Retry a couple of times in case the scroll area renders slightly after us
      let viewport: HTMLElement | null = null;
      let retries = 0;
      const attach = () => {
        viewport = (containerRef.current?.querySelector(
          '[data-slot="scroll-area-viewport"]',
        ) as HTMLElement | null) ?? null;
        if (!viewport && retries++ < 5) {
          setTimeout(attach, 60);
          return;
        }
        if (!viewport) return;

        const onScroll = () => {
          if (!isDriverRef.current) return; // only the driver broadcasts scroll
          const now = Date.now();
          if (now - lastScrollRef.current < SCROLL_THROTTLE_MS) return;
          lastScrollRef.current = now;
          const max = viewport!.scrollHeight - viewport!.clientHeight;
          if (max <= 0) return;
          send({ kind: 'scroll', email: selfEmail, pct: viewport!.scrollTop / max });
        };

        viewport.addEventListener('scroll', onScroll);
        // Return cleanup via closure captured in the outer effect
        cleanup = () => viewport?.removeEventListener('scroll', onScroll);
      };

      let cleanup: (() => void) | undefined;
      attach();
      return () => cleanup?.();
    }, [selfEmail, containerRef, send]);

    // ── GC stale cursors + expired typing chips ───────────────────────────────
    useEffect(() => {
      const t = setInterval(() => {
        const now = Date.now();
        const cursorCutoff = now - CURSOR_TTL_MS;
        const typingCutoff = now - TYPING_FADE_MS;
        setCursors(prev => {
          let changed = false;
          const next = new Map(prev);
          for (const [e, c] of next) {
            if (c.lastSeen < cursorCutoff) {
              next.delete(e);
              changed = true;
            } else if (c.typingAt !== undefined && c.typingAt < typingCutoff) {
              next.set(e, { ...c, typingLabel: undefined, typingValue: undefined, typingAt: undefined });
              changed = true;
            }
          }
          return changed ? next : prev;
        });
      }, 1000);
      return () => clearInterval(t);
    }, []);

    return (
      <div className="pointer-events-none absolute inset-0 z-50 select-none overflow-hidden">

        {/* ── Remote cursors ──────────────────────────────────────────────── */}
        <AnimatePresence>
          {Array.from(cursors.entries()).map(([email, c]) => (
            <RemoteCursor
              key={email}
              email={email}
              x={c.x} y={c.y}
              color={c.color} glow={c.glow}
              typingLabel={c.typingLabel}
              typingValue={c.typingValue}
            />
          ))}
        </AnimatePresence>

        {/* ── Click ripples ── 3 expanding rings + center flash ───────────── */}
        <AnimatePresence>
          {ripples.map(r => (
            <div
              key={r.id}
              className="absolute"
              style={{ left: `${r.x}%`, top: `${r.y}%`, transform: 'translate(-50%,-50%)' }}
            >
              {[0, 1, 2].map(i => (
                <motion.span
                  key={i}
                  className="absolute block rounded-full"
                  style={{
                    left: '50%', top: '50%',
                    transform: 'translate(-50%,-50%)',
                    border: `${2 - i * 0.4}px solid ${r.color}`,
                    boxShadow: i === 0 ? `0 0 6px ${r.glow}` : undefined,
                  }}
                  initial={{ width: 0, height: 0, opacity: 0.9 - i * 0.18 }}
                  animate={{ width: 40 + i * 28, height: 40 + i * 28, opacity: 0 }}
                  transition={{
                    duration: 0.48 + i * 0.1,
                    delay: i * 0.06,
                    ease: [0.22, 1, 0.36, 1],
                  }}
                  onAnimationComplete={() => {
                    if (i === 2) setRipples(prev => prev.filter(p => p.id !== r.id));
                  }}
                />
              ))}
              <motion.span
                className="absolute block rounded-full"
                style={{
                  left: '50%', top: '50%',
                  transform: 'translate(-50%,-50%)',
                  background: r.color,
                  boxShadow: `0 0 10px ${r.glow}`,
                }}
                initial={{ width: 12, height: 12, opacity: 1 }}
                animate={{ width: 0,  height: 0,  opacity: 0 }}
                transition={{ duration: 0.2, ease: 'easeOut' }}
              />
            </div>
          ))}
        </AnimatePresence>

        {/* ── Save toasts ── dark glass pill with animated checkmark ────────── */}
        <AnimatePresence mode="popLayout">
          {saveToasts.map((t, i) => (
            <motion.div
              key={t.id}
              className="absolute right-5 flex items-center gap-2.5 rounded-xl px-3.5 py-2.5"
              style={{
                bottom: `${20 + i * 58}px`,
                background: 'rgba(8,8,10,0.9)',
                backdropFilter: 'blur(16px)',
                border: `1px solid ${t.color}40`,
                boxShadow: [
                  `0 0 0 1px ${t.color}18`,
                  `0 6px 28px rgba(0,0,0,0.5)`,
                  `inset 0 0 20px ${t.color}06`,
                ].join(', '),
              }}
              initial={{ opacity: 0, x: 88, scale: 0.85 }}
              animate={{ opacity: 1, x: 0,  scale: 1 }}
              exit={{ opacity: 0, x: 64, scale: 0.9 }}
              transition={{ type: 'spring', stiffness: 480, damping: 32 }}
            >
              <div
                className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full"
                style={{
                  background: `${t.color}18`,
                  border: `1.5px solid ${t.color}55`,
                }}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none">
                  <motion.path
                    d="M5 12.5l4.5 5L19 7"
                    stroke={t.color}
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    initial={{ pathLength: 0 }}
                    animate={{ pathLength: 1 }}
                    transition={{ duration: 0.32, delay: 0.1, ease: 'easeOut' }}
                  />
                </svg>
              </div>
              <div className="flex flex-col gap-0.5 leading-none">
                <span
                  className="font-mono text-[11px] font-semibold tracking-tight"
                  style={{ color: t.color }}
                >
                  {t.label}
                </span>
                <span className="font-mono text-[9px] uppercase tracking-widest text-zinc-500">
                  saved changes
                </span>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>

      </div>
    );
  },
);

export default WizardCursorOverlay;
