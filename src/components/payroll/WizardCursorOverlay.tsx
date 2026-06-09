'use client';

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';

const BROADCAST_CHANNEL = 'payroll-wizard-cursors';
const THROTTLE_MS = 30;
const CURSOR_TTL_MS = 4000;

const CURSOR_PALETTE = [
  '#ef4444',
  '#f97316',
  '#eab308',
  '#22c55e',
  '#06b6d4',
  '#3b82f6',
  '#8b5cf6',
  '#ec4899',
];

function emailToColor(email: string): string {
  let h = 0;
  for (let i = 0; i < email.length; i++) h = ((h << 5) - h + email.charCodeAt(i)) >>> 0;
  return CURSOR_PALETTE[h % CURSOR_PALETTE.length];
}

function emailToLabel(email: string): string {
  return (email.split('@')[0] ?? email).slice(0, 16);
}

interface CursorState {
  x: number;
  y: number;
  color: string;
  lastSeen: number;
}

interface ClickRipple {
  id: number;
  x: number;
  y: number;
  color: string;
}

interface SaveToast {
  id: number;
  label: string;
  color: string;
}

type BroadcastMsg =
  | { kind: 'move'; email: string; x: number; y: number }
  | { kind: 'click'; email: string; x: number; y: number }
  | { kind: 'save'; email: string };

export interface WizardCursorOverlayHandle {
  broadcastSave(): void;
}

interface Props {
  selfEmail: string | null | undefined;
  containerRef: React.RefObject<HTMLElement | null>;
}

const WizardCursorOverlay = forwardRef<WizardCursorOverlayHandle, Props>(
  function WizardCursorOverlay({ selfEmail, containerRef }, ref) {
    const [cursors, setCursors] = useState<Map<string, CursorState>>(new Map());
    const [ripples, setRipples] = useState<ClickRipple[]>([]);
    const [saveToasts, setSaveToasts] = useState<SaveToast[]>([]);

    const channelRef = useRef<ReturnType<NonNullable<ReturnType<typeof getSupabaseBrowserClient>>['channel']> | null>(null);
    const lastMoveRef = useRef(0);
    const idRef = useRef(0);

    const send = useCallback((msg: BroadcastMsg) => {
      channelRef.current?.send({ type: 'broadcast', event: 'wc', payload: msg });
    }, []);

    useImperativeHandle(ref, () => ({
      broadcastSave() {
        if (!selfEmail) return;
        send({ kind: 'save', email: selfEmail });
        // show own save animation too
        const id = ++idRef.current;
        const color = emailToColor(selfEmail);
        const label = emailToLabel(selfEmail);
        setSaveToasts(prev => [...prev, { id, label, color }]);
        setTimeout(() => setSaveToasts(prev => prev.filter(t => t.id !== id)), 2800);
      },
    }), [selfEmail, send]);

    // Set up Supabase broadcast channel
    useEffect(() => {
      const supabase = getSupabaseBrowserClient();
      if (!supabase || !selfEmail) return;

      const ch = supabase.channel(BROADCAST_CHANNEL, {
        config: { broadcast: { self: false } },
      });
      channelRef.current = ch;

      ch.on('broadcast', { event: 'wc' }, ({ payload }: { payload: BroadcastMsg }) => {
        if (!payload?.email || payload.email === selfEmail) return;
        const color = emailToColor(payload.email);

        if (payload.kind === 'move') {
          setCursors(prev => {
            const next = new Map(prev);
            next.set(payload.email, { x: payload.x, y: payload.y, color, lastSeen: Date.now() });
            return next;
          });
        } else if (payload.kind === 'click') {
          const id = ++idRef.current;
          setRipples(prev => [...prev, { id, x: payload.x, y: payload.y, color }]);
        } else if (payload.kind === 'save') {
          const id = ++idRef.current;
          const label = emailToLabel(payload.email);
          setSaveToasts(prev => [...prev, { id, label, color }]);
          setTimeout(() => setSaveToasts(prev => prev.filter(t => t.id !== id)), 2800);
        }
      }).subscribe();

      return () => {
        void supabase.removeChannel(ch);
        channelRef.current = null;
      };
    }, [selfEmail]);

    // Attach mouse listeners to the container
    useEffect(() => {
      const el = containerRef.current;
      if (!el || !selfEmail) return;

      const onMove = (e: MouseEvent) => {
        const now = Date.now();
        if (now - lastMoveRef.current < THROTTLE_MS) return;
        lastMoveRef.current = now;
        const r = el.getBoundingClientRect();
        const x = ((e.clientX - r.left) / r.width) * 100;
        const y = ((e.clientY - r.top) / r.height) * 100;
        send({ kind: 'move', email: selfEmail, x, y });
      };

      const onClick = (e: MouseEvent) => {
        const r = el.getBoundingClientRect();
        const x = ((e.clientX - r.left) / r.width) * 100;
        const y = ((e.clientY - r.top) / r.height) * 100;
        send({ kind: 'click', email: selfEmail, x, y });
        // show own ripple immediately
        const id = ++idRef.current;
        const color = emailToColor(selfEmail);
        setRipples(prev => [...prev, { id, x, y, color }]);
      };

      el.addEventListener('mousemove', onMove as EventListener);
      el.addEventListener('click', onClick as EventListener);
      return () => {
        el.removeEventListener('mousemove', onMove as EventListener);
        el.removeEventListener('click', onClick as EventListener);
      };
    }, [selfEmail, containerRef, send]);

    // Garbage-collect stale cursors
    useEffect(() => {
      const t = setInterval(() => {
        const cutoff = Date.now() - CURSOR_TTL_MS;
        setCursors(prev => {
          let changed = false;
          const next = new Map(prev);
          for (const [email, c] of next) {
            if (c.lastSeen < cutoff) { next.delete(email); changed = true; }
          }
          return changed ? next : prev;
        });
      }, 1000);
      return () => clearInterval(t);
    }, []);

    return (
      <div className="pointer-events-none absolute inset-0 z-50 select-none overflow-hidden">
        {/* Remote cursors */}
        {Array.from(cursors.entries()).map(([email, c]) => (
          <motion.div
            key={email}
            className="absolute will-change-transform"
            style={{ left: 0, top: 0 }}
            animate={{ x: `calc(${c.x}% - 2px)`, y: `calc(${c.y}% - 2px)` }}
            transition={{ type: 'spring', stiffness: 600, damping: 40, mass: 0.08 }}
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <path
                d="M3 2L17 9.5L10.5 11.5L8 18L3 2Z"
                fill={c.color}
                stroke="white"
                strokeWidth="1.5"
                strokeLinejoin="round"
              />
            </svg>
            <span
              className="absolute left-4 top-4 whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-semibold leading-4 text-white shadow-md"
              style={{ backgroundColor: c.color }}
            >
              {emailToLabel(email)}
            </span>
          </motion.div>
        ))}

        {/* Click ripples */}
        <AnimatePresence>
          {ripples.map(r => (
            <motion.span
              key={r.id}
              className="absolute block rounded-full"
              style={{
                left: `${r.x}%`,
                top: `${r.y}%`,
                translateX: '-50%',
                translateY: '-50%',
                backgroundColor: r.color,
              }}
              initial={{ width: 4, height: 4, opacity: 0.75 }}
              animate={{ width: 64, height: 64, opacity: 0 }}
              exit={{}}
              transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
              onAnimationComplete={() =>
                setRipples(prev => prev.filter(p => p.id !== r.id))
              }
            />
          ))}
        </AnimatePresence>

        {/* Save toasts (bottom-right stack) */}
        <AnimatePresence mode="popLayout">
          {saveToasts.map((t, i) => (
            <motion.div
              key={t.id}
              className="absolute right-4 flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold text-white shadow-lg"
              style={{
                bottom: `${16 + i * 48}px`,
                backgroundColor: t.color,
              }}
              initial={{ opacity: 0, x: 56, scale: 0.9 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: 40, scale: 0.88 }}
              transition={{ type: 'spring', stiffness: 420, damping: 28 }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
                <path
                  d="M5 13l4 4L19 7"
                  stroke="white"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              {t.label} saved
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    );
  },
);

export default WizardCursorOverlay;
