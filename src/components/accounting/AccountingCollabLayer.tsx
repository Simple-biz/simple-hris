'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  motion,
  AnimatePresence,
  useMotionValue,
  useSpring,
  useTransform,
  useAnimationControls,
} from 'motion/react';
import { Eye, EyeOff, Send } from 'lucide-react';
import { useSession } from 'next-auth/react';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';
import { normEmail } from '@/lib/email/norm-email';
import { playPingChime, playPingSent } from '@/lib/sound/ping-chime';
import CobrowseSurface from './CobrowseSurface';
import { useCobrowse } from '@/hooks/useCobrowse';

/**
 * Live "who's in Accounting" collaboration layer.
 *
 * Two independent pieces, both over a single Supabase Realtime channel:
 *
 *  1. Presence roster -> a floating avatar rail pinned to the right edge of the
 *     Accounting page. Shows every other accounting user currently online with
 *     their profile photo (or initials) and a green online badge. People on the
 *     SAME section as the viewer get a colored ring (their mouse is observable
 *     right now); people on a different section are dimmed with their section
 *     shown in the tooltip.
 *
 *  2. Cursor broadcast -> remote mouse cursors + click ripples. Each move/click
 *     is tagged with the sender's current section; the viewer only renders
 *     cursors from peers who are on the SAME section. So you only ever see
 *     Carla's cursor when you are both on, e.g., Overview.
 *
 * On top of the passive layer there is an opt-in "Observe" mode: clicking
 * Observe on a peer in the avatar rail mirrors THAT peer's active Accounting
 * tab into your own view in real time (their `section` from presence drives
 * your `onNavigate`), the wizard's driver-mode analogue. Since you then sit on
 * the same section as them, the cursor broadcast above surfaces their pointer
 * automatically. A banner with a "Stop observing" opt-out is shown while active.
 *
 * There is also a lightweight "Ping" (a directed nudge): clicking Ping on a
 * peer broadcasts a `ping` addressed to them. On the RECIPIENT's screen, the
 * SENDER's avatar in the rail wiggles, fires an attention pulse, plays a chime,
 * and pops a chat-head bubble ("waved at you") that auto-dismisses. Pings are
 * NOT section-scoped — you can nudge anyone in Accounting from any tab — and
 * ride the same Realtime broadcast as cursors, so no SQL/table is involved.
 */

const CHANNEL = 'accounting-collab';
const MOVE_THROTTLE_MS = 16; // ~60 fps
const CURSOR_TTL_MS = 4500;
// How long a ping's chat-head bubble lingers on the sender's avatar before it
// floats away. A fresh ping from the same sender resets this window.
const PING_TTL_MS = 5000;
// One-tap canned messages offered alongside the free-text ping composer.
const QUICK_PINGS = ['👋 Hi!', '👀 Look here', '✅ Done?', '🙏 Need you', '🔥 Urgent'];
// Max avatars shown in the right-edge rail before collapsing the rest into a
// "+N" chip. Keeps the (scrollbar-free) rail from running off short screens.
const MAX_RAIL_AVATARS = 9;

const SECTION_LABELS: Record<string, string> = {
  'overview': 'Overview',
  'payroll-wizard': 'Payroll Wizard',
  'payment-dispatch': 'Payment Dispatch',
  'disputes': 'Issues',
  'mesa': 'MESA',
  'announcements': 'Announcements',
  'notifications': 'Notifications',
  's-wall': 'S-Wall',
  'settings': 'System Settings',
};

function sectionLabel(section: string): string {
  return SECTION_LABELS[section] ?? section;
}

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
  return (email.split('@')[0] ?? email).slice(0, 18);
}

function initialsFor(name: string | null, email: string): string {
  const src = (name && name.trim()) || email.split('@')[0] || email;
  const parts = src.replace(/[._-]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// --- types --------------------------------------------------------------------
interface PeerMeta {
  email: string;
  name: string | null;
  avatarUrl: string | null;
  section: string;
}

interface CursorState {
  x: number;
  y: number;
  color: string;
  glow: string;
  email: string;
  name: string | null;
  lastSeen: number;
}

interface ClickRipple {
  id: number;
  x: number;
  y: number;
  color: string;
  glow: string;
}

type CollabMsg =
  | { kind: 'move'; email: string; section: string; x: number; y: number }
  | { kind: 'click'; email: string; section: string; x: number; y: number }
  // A directed nudge: `email` is the sender, `toEmail` the recipient. `text` is
  // the short message shown in the chat-head bubble on the sender's avatar.
  | { kind: 'ping'; email: string; toEmail: string; text: string };

// An active incoming ping, keyed by sender email in the parent. `id` lets the
// bubble + sound re-trigger cleanly when the same person pings again.
interface PingState {
  id: number;
  text: string;
}

interface PresencePayload {
  email: string;
  name: string | null;
  avatarUrl: string | null;
  section: string;
  online_at: string;
}

// --- cursor trails (per-person flair) ----------------------------------------
// A few accounting users get a cosmetic trail behind their live cursor. Purely
// visual and scoped by email, so nobody else's pointer changes.
//   - Aliviah: pink fairy dust  -> "particle" mode (sparkles that fall + tumble)
//   - Carla:   purple laser     -> "segment" mode (glowing beam along the path)
//   - Kaner:   blue + electric  -> "segment" mode (jagged lightning along path)
type TrailKind = 'fairy' | 'laser' | 'electric';

const TRAIL_BY_EMAIL: Record<string, TrailKind> = {
  'aliviah@simple.biz': 'fairy',
  'carla@simple.biz': 'laser',
  'kaner@simple.biz': 'electric',
};

// Optional pointer recolor, independent of the trail. Kaner's cursor is blue.
const CURSOR_OVERRIDE: Record<string, { color: string; glow: string }> = {
  'kaner@simple.biz': { color: '#3b82f6', glow: 'rgba(59,130,246,0.7)' },
};

const FAIRY_DUST_COLORS = ['#ff9ed8', '#ffc2ec', '#ff6fbf', '#ffd9f2', '#f4a8ff', '#ffb0e0'];
const LASER_COLORS = ['#e9d5ff', '#d8b4fe', '#c084fc', '#a855f7', '#9333ea'];
const ELECTRIC_COLORS = ['#e0f2fe', '#bae6fd', '#7dd3fc', '#38bdf8', '#60a5fa'];

const DUST_SPAWN_THROTTLE_MS = 30; // cap spawn rate independent of the 60fps move feed
const DUST_MAX = 70; // hard ceiling on live motes (they self-remove on fade)
const TRAIL_IDLE_RESET_MS = 220; // a gap longer than this starts a fresh stroke
const TRAIL_MAX_SEG_PX = 220; // skip absurdly long segments (cursor jumps)

interface TrailMote {
  id: number;
  x: number; // % of overlay (anchor: particle center, or segment start point)
  y: number;
  color: string;
  dur: number; // fade duration (s)
  // particle motes (fairy dust)
  size?: number; // initial scale
  dx?: number; // sideways drift (px)
  dy?: number; // vertical drift (px): + falls
  rot?: number; // tumble (deg)
  // segment motes (laser / electric): connect the previous point -> this point
  angle?: number; // segment orientation (deg)
  length?: number; // segment length (px)
  points?: string; // electric only: jagged polyline in local segment space
}

// Jagged lightning polyline across a segment of the given pixel length. The
// endpoints sit on the centerline (y=7) so consecutive bolts join cleanly.
function buildBolt(length: number): string {
  const segs = Math.max(2, Math.round(length / 12));
  const pts: string[] = [];
  for (let i = 0; i <= segs; i++) {
    const px = (length * i) / segs;
    const py = i === 0 || i === segs ? 7 : 7 + (Math.random() - 0.5) * 11;
    pts.push(`${px.toFixed(1)},${py.toFixed(1)}`);
  }
  return pts.join(' ');
}

// --- per-cursor component -----------------------------------------------------
function RemoteCursor({
  email,
  name,
  x,
  y,
  color,
  glow,
}: {
  email: string;
  name: string | null;
  x: number;
  y: number;
  color: string;
  glow: string;
}) {
  const xMv = useMotionValue(x);
  const yMv = useMotionValue(y);
  const sx = useSpring(xMv, { stiffness: 700, damping: 44, mass: 0.07 });
  const sy = useSpring(yMv, { stiffness: 700, damping: 44, mass: 0.07 });
  const left = useTransform(sx, (v) => `${v}%`);
  const top = useTransform(sy, (v) => `${v}%`);

  useEffect(() => { xMv.set(x); }, [x, xMv]);
  useEffect(() => { yMv.set(y); }, [y, yMv]);

  // Cursor trail (scoped by email; every other pointer is left untouched).
  const trailKey = normEmail(email) ?? email.trim().toLowerCase();
  const trail = TRAIL_BY_EMAIL[trailKey] ?? null;
  const cursorColor = CURSOR_OVERRIDE[trailKey]?.color ?? color;
  const cursorGlow = CURSOR_OVERRIDE[trailKey]?.glow ?? glow;
  const [motes, setMotes] = useState<TrailMote[]>([]);
  const moteIdRef = useRef(0);
  const lastSpawnRef = useRef(0);
  const lastPosRef = useRef<{ x: number; y: number } | null>(null);
  const layerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!trail) return;
    const now = Date.now();
    const gap = now - lastSpawnRef.current;
    if (gap < DUST_SPAWN_THROTTLE_MS) return;
    lastSpawnRef.current = now;
    // Visible (spring-smoothed) cursor position, so particles land where the
    // pointer actually appears and are left behind as it moves.
    const px = sx.get();
    const py = sy.get();

    if (trail === 'fairy') {
      // Fairy dust: sparkles that fall, tumble, and shrink away.
      const count = 1 + Math.floor(Math.random() * 2);
      const batch: TrailMote[] = [];
      for (let i = 0; i < count; i++) {
        batch.push({
          id: ++moteIdRef.current,
          x: px + (Math.random() - 0.5) * 1.2,
          y: py + (Math.random() - 0.5) * 1.2,
          color: FAIRY_DUST_COLORS[Math.floor(Math.random() * FAIRY_DUST_COLORS.length)],
          size: 0.55 + Math.random() * 0.7,
          dx: (Math.random() - 0.5) * 16,
          dy: 8 + Math.random() * 16,
          rot: (Math.random() - 0.5) * 220,
          dur: 0.65 + Math.random() * 0.55,
        });
      }
      setMotes((prev) => (prev.length > DUST_MAX ? prev.slice(-DUST_MAX) : prev).concat(batch));
      return;
    }

    // Stroke trails (laser / electric): connect the previous spawned point to
    // the current one so the trail traces the cursor's actual path.
    const fresh = gap > TRAIL_IDLE_RESET_MS;
    const prev = fresh ? null : lastPosRef.current;
    lastPosRef.current = { x: px, y: py };
    if (!prev) return; // first point of a stroke -> nothing to connect yet

    const layer = layerRef.current;
    const w = layer?.clientWidth ?? 0;
    const h = layer?.clientHeight ?? 0;
    if (w === 0 || h === 0) return;
    const dxPx = ((px - prev.x) / 100) * w;
    const dyPx = ((py - prev.y) / 100) * h;
    const length = Math.hypot(dxPx, dyPx);
    if (length < 1 || length > TRAIL_MAX_SEG_PX) return; // no move / a jump
    const angle = (Math.atan2(dyPx, dxPx) * 180) / Math.PI;

    const palette = trail === 'laser' ? LASER_COLORS : ELECTRIC_COLORS;
    const segColor = palette[Math.floor(Math.random() * palette.length)];
    const mote: TrailMote = {
      id: ++moteIdRef.current,
      x: prev.x,
      y: prev.y,
      color: segColor,
      angle,
      length,
      dur: trail === 'laser' ? 0.4 + Math.random() * 0.25 : 0.22 + Math.random() * 0.22,
      points: trail === 'electric' ? buildBolt(length) : undefined,
    };
    setMotes((prev2) => (prev2.length > DUST_MAX ? prev2.slice(-DUST_MAX) : prev2).concat(mote));
  }, [x, y, trail, sx, sy]);

  return (
    <>
      {trail && (
        <div ref={layerRef} className="pointer-events-none absolute inset-0 overflow-hidden">
          {motes.map((m) => {
            // Fairy dust -> a falling, tumbling sparkle particle.
            if (trail === 'fairy') {
              return (
                <motion.div
                  key={m.id}
                  className="absolute"
                  style={{ left: `${m.x}%`, top: `${m.y}%` }}
                  initial={{ opacity: 0.95, scale: m.size, x: 0, y: 0, rotate: 0 }}
                  animate={{ opacity: 0, scale: 0, x: m.dx, y: m.dy, rotate: m.rot }}
                  transition={{ duration: m.dur, ease: [0.22, 0.61, 0.36, 1] }}
                  onAnimationComplete={() => setMotes((prev) => prev.filter((p) => p.id !== m.id))}
                >
                  <svg
                    width="11"
                    height="11"
                    viewBox="0 0 10 10"
                    style={{
                      transform: 'translate(-50%, -50%)',
                      filter: `drop-shadow(0 0 4px ${m.color}) drop-shadow(0 0 8px ${m.color})`,
                    }}
                  >
                    <path d="M5 0 L6 4 L10 5 L6 6 L5 10 L4 6 L0 5 L4 4 Z" fill={m.color} />
                    <circle cx="5" cy="5" r="1" fill="rgba(255,255,255,0.95)" />
                  </svg>
                </motion.div>
              );
            }
            // Laser / electric -> a segment anchored at the previous point,
            // rotated along travel direction, fading where the cursor has been.
            return (
              <motion.div
                key={m.id}
                className="absolute"
                style={{ left: `${m.x}%`, top: `${m.y}%` }}
                initial={{ opacity: trail === 'electric' ? 1 : 0.95 }}
                animate={{ opacity: trail === 'electric' ? [1, 0.35, 0.85, 0] : 0 }}
                transition={{ duration: m.dur, ease: 'easeOut' }}
                onAnimationComplete={() => setMotes((prev) => prev.filter((p) => p.id !== m.id))}
              >
                {trail === 'laser' ? (
                  <div
                    style={{
                      width: m.length,
                      height: 3,
                      transformOrigin: '0 50%',
                      transform: `translateY(-50%) rotate(${m.angle}deg)`,
                      borderRadius: 9999,
                      background: `linear-gradient(90deg, rgba(255,255,255,0) 0%, ${m.color} 55%, #ffffff 100%)`,
                      boxShadow: `0 0 6px 2px ${m.color}, 0 0 16px 5px ${m.color}`,
                    }}
                  />
                ) : (
                  <svg
                    width={m.length}
                    height={14}
                    viewBox={`0 0 ${m.length} 14`}
                    style={{
                      transformOrigin: '0 50%',
                      transform: `translateY(-50%) rotate(${m.angle}deg)`,
                      overflow: 'visible',
                      filter: `drop-shadow(0 0 3px ${m.color}) drop-shadow(0 0 6px ${m.color})`,
                    }}
                  >
                    <polyline
                      points={m.points}
                      fill="none"
                      stroke={m.color}
                      strokeWidth={2}
                      strokeLinejoin="round"
                      strokeLinecap="round"
                    />
                    <polyline
                      points={m.points}
                      fill="none"
                      stroke="rgba(255,255,255,0.9)"
                      strokeWidth={0.8}
                      strokeLinejoin="round"
                      strokeLinecap="round"
                    />
                  </svg>
                )}
              </motion.div>
            );
          })}
        </div>
      )}
    <motion.div
      className="absolute"
      style={{ left, top }}
      initial={{ opacity: 0, scale: 0.45 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.25, transition: { duration: 0.16 } }}
      transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
    >
      <svg
        width="22"
        height="22"
        viewBox="0 0 22 22"
        fill="none"
        style={{ filter: `drop-shadow(0 0 6px ${cursorGlow}) drop-shadow(0 1px 3px rgba(0,0,0,0.55))` }}
      >
        <path
          d="M4 2L17.5 9.5L11 11.5L8.5 19L4 2Z"
          fill={cursorColor}
          stroke="rgba(255,255,255,0.88)"
          strokeWidth="1"
          strokeLinejoin="round"
        />
      </svg>
      <div
        className="absolute left-5 top-4 flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1"
        style={{
          background: 'rgba(9,9,11,0.86)',
          backdropFilter: 'blur(12px)',
          border: `1px solid ${cursorColor}44`,
          boxShadow: `0 0 10px ${cursorGlow}, 0 2px 8px rgba(0,0,0,0.35)`,
        }}
      >
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ background: cursorColor, boxShadow: `0 0 5px ${cursorColor}` }}
        />
        <span
          className="font-mono text-[10px] font-medium leading-none tracking-tight"
          style={{ color: '#e4e4e7' }}
        >
          {(name && name.trim()) || toLabel(email)}
        </span>
      </div>
    </motion.div>
    </>
  );
}

// --- avatar rail item ---------------------------------------------------------
// Spring used for the avatar pop-in when a peer joins / the rail mounts. Tuned
// to overshoot slightly so the avatar "pops" into place rather than easing in.
const POP_SPRING = { type: 'spring' as const, stiffness: 520, damping: 24, mass: 0.7 };

function RailAvatar({
  peer,
  sameSection,
  open,
  onToggle,
  observing,
  onObserve,
  onStopObserve,
  ping,
  onPing,
  index,
}: {
  peer: PeerMeta;
  sameSection: boolean;
  open: boolean;
  onToggle: () => void;
  observing: boolean;
  onObserve: () => void;
  onStopObserve: () => void;
  ping: PingState | null;
  onPing: (text: string) => void;
  index: number;
}) {
  const [imgFailed, setImgFailed] = useState(false);
  const { bg: color, glow } = hashEmail(peer.email);
  const url = peer.avatarUrl?.trim();
  const showImg = !!url && !imgFailed;
  const display = (peer.name && peer.name.trim()) || toLabel(peer.email);

  useEffect(() => { setImgFailed(false); }, [url]);

  // --- Ping: incoming wiggle + outgoing "sent" confirmation ------------------
  // Wiggle the avatar each time a NEW ping lands (re-keyed on ping.id so a
  // repeat ping from the same person re-fires). The chime is played by the
  // parent's receive handler, not here, so it can't double-fire.
  const wiggle = useAnimationControls();
  useEffect(() => {
    if (!ping) return;
    void wiggle.start({
      rotate: [0, -12, 10, -7, 5, 0],
      transition: { duration: 0.6, ease: 'easeInOut' },
    });
  }, [ping?.id, wiggle]);

  // Ping composer: a collapsed "Ping" button -> opens a small message box with
  // quick canned replies; submitting fires the ping + a brief "Pinged!" state.
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState('');
  const [pinged, setPinged] = useState(false);
  const sentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (sentTimerRef.current) clearTimeout(sentTimerRef.current); }, []);
  // Collapse + reset the composer whenever this peer's card closes.
  useEffect(() => { if (!open) { setComposing(false); setDraft(''); } }, [open]);

  const submitPing = (text: string) => {
    onPing(text); // empty -> parent falls back to a friendly wave
    setDraft('');
    setComposing(false);
    setPinged(true);
    if (sentTimerRef.current) clearTimeout(sentTimerRef.current);
    sentTimerRef.current = setTimeout(() => setPinged(false), 1600);
  };

  return (
    <motion.div
      layout="position"
      initial={{ opacity: 0, scale: 0.2, x: 24 }}
      animate={{
        opacity: 1,
        scale: 1,
        x: 0,
        // Stagger the entrance so a fresh roster cascades in instead of popping
        // all at once; capped so a big team never feels sluggish.
        transition: { ...POP_SPRING, delay: Math.min(index * 0.06, 0.42) },
      }}
      exit={{ opacity: 0, scale: 0.2, x: 24, transition: { duration: 0.18, ease: [0.4, 0, 1, 1] } }}
      className="group pointer-events-auto relative flex items-center justify-end"
    >
      {/* Name card to the left -- shown on hover, and pinned open on click. */}
      <AnimatePresence>
        {open && (
          <motion.div
            className="absolute right-full mr-3 max-w-[60vw] whitespace-nowrap rounded-xl bg-zinc-900/95 px-3.5 py-2.5 text-right shadow-2xl ring-1 ring-white/10 backdrop-blur-md"
            initial={{ opacity: 0, x: 8, scale: 0.92 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: 8, scale: 0.92 }}
            transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="text-[13px] font-semibold leading-tight text-white">{display}</div>
            <div className="text-[10px] leading-tight text-zinc-400">{peer.email}</div>
            <div
              className="mt-0.5 text-[9px] uppercase leading-tight tracking-widest"
              style={{ color: sameSection ? color : '#a1a1aa' }}
            >
              {sameSection ? `Here - ${sectionLabel(peer.section)}` : sectionLabel(peer.section)}
            </div>
            <button
              type="button"
              onClick={observing ? onStopObserve : onObserve}
              className={
                observing
                  ? 'mt-2 w-full rounded-md bg-rose-500/90 px-2.5 py-1.5 text-[11px] font-semibold text-white shadow transition-colors hover:bg-rose-500'
                  : 'mt-2 w-full rounded-md bg-orange-500/90 px-2.5 py-1.5 text-[11px] font-semibold text-white shadow transition-colors hover:bg-orange-500'
              }
            >
              {observing ? 'Stop observing' : 'Observe'}
            </button>
            <AnimatePresence mode="wait" initial={false}>
              {pinged ? (
                <motion.div
                  key="pinged"
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  className="mt-1.5 flex w-full items-center justify-center gap-1.5 rounded-md bg-emerald-500 px-2.5 py-1.5 text-[11px] font-semibold text-white shadow"
                >
                  <Send className="h-3 w-3" />
                  Pinged!
                </motion.div>
              ) : composing ? (
                <motion.form
                  key="composer"
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
                  className="mt-2 overflow-hidden text-left"
                  onSubmit={(e) => { e.preventDefault(); submitPing(draft); }}
                >
                  <div className="flex items-center gap-1.5">
                    {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
                    <input
                      autoFocus
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Escape') { setComposing(false); setDraft(''); } }}
                      maxLength={200}
                      placeholder="Type a message…"
                      className="w-40 rounded-md bg-zinc-800 px-2 py-1.5 text-[11px] text-white placeholder:text-zinc-500 outline-none ring-1 ring-white/10 focus:ring-1 focus:ring-sky-400"
                    />
                    <button
                      type="submit"
                      title="Send ping"
                      aria-label="Send ping"
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-sky-500 text-white shadow transition-colors hover:bg-sky-400"
                    >
                      <Send className="h-3 w-3" />
                    </button>
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {QUICK_PINGS.map((q) => (
                      <button
                        key={q}
                        type="button"
                        onClick={() => submitPing(q)}
                        className="rounded-full bg-zinc-800 px-2 py-0.5 text-[10px] font-medium text-zinc-200 transition-colors hover:bg-zinc-700"
                      >
                        {q}
                      </button>
                    ))}
                  </div>
                </motion.form>
              ) : (
                <motion.button
                  key="ping-btn"
                  type="button"
                  onClick={() => setComposing(true)}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="mt-1.5 flex w-full items-center justify-center gap-1.5 rounded-md bg-sky-500 px-2.5 py-1.5 text-[11px] font-semibold text-white shadow transition-colors hover:bg-sky-400"
                >
                  <Send className="h-3 w-3" />
                  Ping
                </motion.button>
              )}
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>
      {/* Lightweight hover hint (only when not pinned open) */}
      {!open && (
        <div className="pointer-events-none absolute right-full mr-3 hidden whitespace-nowrap rounded-xl bg-zinc-900/95 px-3 py-2 text-right shadow-xl ring-1 ring-white/10 backdrop-blur-md group-hover:block">
          <div className="text-[11px] font-semibold leading-tight text-white">{display}</div>
          <div
            className="text-[9px] uppercase leading-tight tracking-widest"
            style={{ color: sameSection ? color : '#a1a1aa' }}
          >
            {sameSection ? `Here - ${sectionLabel(peer.section)}` : sectionLabel(peer.section)}
          </div>
        </div>
      )}

      {/* Incoming ping -> a chat-head speech bubble popping out of this person's
          avatar, with a wiggling hand and a tail pointing back at the avatar. */}
      <AnimatePresence>
        {ping && (
          <motion.div
            key={ping.id}
            className="pointer-events-none absolute right-full top-1/2 z-[70] mr-3 -translate-y-1/2"
            initial={{ opacity: 0, x: 14, scale: 0.4 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: 10, scale: 0.5, transition: { duration: 0.2 } }}
            transition={{ type: 'spring', stiffness: 480, damping: 15, mass: 0.7 }}
          >
            <div className="relative flex max-w-[240px] items-start gap-2 rounded-2xl bg-gradient-to-br from-orange-500 to-pink-500 px-3.5 py-2 text-left text-white shadow-[0_8px_24px_rgba(236,72,153,0.45)] ring-1 ring-white/30">
              <motion.span
                className="mt-0.5 shrink-0 text-base leading-none"
                animate={{ rotate: [0, 20, -12, 16, 0] }}
                transition={{ duration: 0.9, ease: 'easeInOut', repeat: Infinity, repeatDelay: 0.7 }}
                style={{ transformOrigin: '70% 80%' }}
              >
                👋
              </motion.span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-[9px] font-bold uppercase leading-none tracking-wide text-white/85">{display}</span>
                <span className="break-words text-[12px] font-medium leading-snug">{ping.text}</span>
              </span>
              {/* tail: a small rotated square fused to the bubble, pointing right */}
              <span className="absolute right-[-4px] top-1/2 h-2.5 w-2.5 -translate-y-1/2 rotate-45 rounded-[2px] bg-pink-500" />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="relative">
        {/* Attention pulse: radiating ring(s) from behind the avatar on a ping. */}
        <AnimatePresence>
          {ping && (
            <motion.span
              key={ping.id}
              className="pointer-events-none absolute left-0 top-0 z-[-1] h-11 w-11 rounded-full"
              style={{ boxShadow: '0 0 0 2.5px rgba(249,115,22,0.75)' }}
              initial={{ opacity: 0.75, scale: 1 }}
              animate={{ opacity: 0, scale: 2 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 1.05, ease: 'easeOut', repeat: 2 }}
            />
          )}
        </AnimatePresence>
      <motion.button
        type="button"
        onClick={onToggle}
        aria-label={`Show ${display}`}
        aria-expanded={open}
        animate={wiggle}
        whileHover={{ scale: 1.08 }}
        whileTap={{ scale: 0.94 }}
        transition={POP_SPRING}
        className="relative block cursor-pointer rounded-full outline-none focus-visible:ring-2 focus-visible:ring-orange-400 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent"
      >
        <div
          className="h-11 w-11 overflow-hidden rounded-full bg-white transition-shadow duration-300 dark:bg-zinc-900"
          style={{
            // While actively observing this peer, pin a bold orange ring so the
            // followed person stands out. Otherwise same-section peers (mouse
            // observable right now) get a glowing ring in their own cursor
            // color; everyone else gets a soft neutral ring + drop shadow so the
            // avatar reads as a raised chip floating over the page.
            boxShadow: observing
              ? '0 0 0 2.5px #f97316, 0 0 16px rgba(249,115,22,0.75), 0 4px 12px rgba(0,0,0,0.28)'
              : sameSection
                ? `0 0 0 2.5px ${color}, 0 0 14px ${glow}, 0 4px 12px rgba(0,0,0,0.25)`
                : '0 0 0 2px rgba(255,255,255,0.9), 0 4px 12px rgba(0,0,0,0.22)',
          }}
        >
          {showImg ? (
            // eslint-disable-next-line @next/next/no-img-element -- Supabase / Google avatar URL
            <img
              src={url}
              alt=""
              referrerPolicy="no-referrer"
              className="h-full w-full rounded-full object-cover"
              onError={() => setImgFailed(true)}
            />
          ) : (
            <div
              className="flex h-full w-full items-center justify-center rounded-full text-[13px] font-bold text-white"
              style={{ background: `linear-gradient(135deg, ${color}, #1e3a8a)` }}
              aria-hidden
            >
              {initialsFor(peer.name, peer.email)}
            </div>
          )}
        </div>
        {/* Online badge with a soft live pulse halo */}
        <span className="absolute -bottom-0.5 -right-0.5 flex h-3.5 w-3.5 items-center justify-center">
          <motion.span
            className="absolute inline-flex h-full w-full rounded-full bg-emerald-400"
            initial={{ opacity: 0.55, scale: 1 }}
            animate={{ opacity: 0, scale: 2.1 }}
            transition={{ duration: 1.9, repeat: Infinity, ease: 'easeOut', delay: Math.min(index * 0.2, 1) }}
          />
          <span className="relative h-3.5 w-3.5 rounded-full border-2 border-white bg-emerald-500 shadow dark:border-zinc-900" />
        </span>
      </motion.button>

      {/* Always-visible Observe affordance: an eye badge pinned to the avatar's
          bottom-left (mirrors the online dot). Click to start/stop following
          this person -- no need to open the name card first. */}
      <motion.button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          if (observing) onStopObserve();
          else onObserve();
        }}
        title={observing ? `Stop observing ${display}` : `Observe ${display}`}
        aria-label={observing ? `Stop observing ${display}` : `Observe ${display}`}
        aria-pressed={observing}
        whileHover={{ scale: 1.18 }}
        whileTap={{ scale: 0.9 }}
        transition={POP_SPRING}
        className={
          'absolute -bottom-1 -left-1 flex h-5 w-5 items-center justify-center rounded-full border-2 border-white shadow-md outline-none focus-visible:ring-2 focus-visible:ring-orange-400 dark:border-zinc-900 ' +
          (observing ? 'bg-rose-500 text-white' : 'bg-orange-500 text-white')
        }
      >
        {observing ? <EyeOff className="h-2.5 w-2.5" /> : <Eye className="h-2.5 w-2.5" />}
      </motion.button>
      </div>
    </motion.div>
  );
}

// --- main layer ---------------------------------------------------------------
interface Props {
  selfEmail: string | null | undefined;
  section: string;
  containerRef: React.RefObject<HTMLElement | null>;
}

export default function AccountingCollabLayer({ selfEmail, section, containerRef }: Props) {
  const { data: session } = useSession();
  const normSelf = useMemo(() => (selfEmail ? normEmail(selfEmail) ?? selfEmail.trim().toLowerCase() : null), [selfEmail]);

  const [uploadedPhoto, setUploadedPhoto] = useState<string | null>(null);
  const [peers, setPeers] = useState<PeerMeta[]>([]);
  const [cursors, setCursors] = useState<Map<string, CursorState>>(new Map());
  const [ripples, setRipples] = useState<ClickRipple[]>([]);
  // Which rail avatar has its name card pinned open (one at a time).
  const [openPeer, setOpenPeer] = useState<string | null>(null);
  // Email of the peer currently being observed (driver-mode follow), or null.
  const [observedEmail, setObservedEmail] = useState<string | null>(null);
  // Active incoming pings, keyed by SENDER email -> the bubble shown on that
  // sender's avatar in our rail. One live bubble per sender at a time.
  const [pings, setPings] = useState<Map<string, PingState>>(new Map());

  const selfName = session?.user?.name ?? (normSelf ? toLabel(normSelf) : null);
  const selfAvatarUrl = (uploadedPhoto && uploadedPhoto.trim()) || session?.user?.image || null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const channelRef = useRef<any>(null);
  const sendRef = useRef<((m: CollabMsg) => void) | null>(null);
  const sectionRef = useRef(section);
  const lastMoveRef = useRef(0);
  const idRef = useRef(0);
  const pingIdRef = useRef(0);
  const pingTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  sectionRef.current = section;

  // Show + sound an incoming ping on the sender's avatar; auto-clear after the
  // TTL. A newer ping from the same sender resets the bubble and its timer.
  const receivePing = useCallback((sender: string, text: string) => {
    const id = ++pingIdRef.current;
    setPings((prev) => {
      const next = new Map(prev);
      next.set(sender, { id, text });
      return next;
    });
    playPingChime();
    const timers = pingTimersRef.current;
    const existing = timers.get(sender);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      setPings((prev) => {
        const cur = prev.get(sender);
        if (!cur || cur.id !== id) return prev; // a newer ping already replaced it
        const next = new Map(prev);
        next.delete(sender);
        return next;
      });
      timers.delete(sender);
    }, PING_TTL_MS);
    timers.set(sender, t);
  }, []);
  // Ref so the (subscribe-once) broadcast handler always calls the latest fn.
  const receivePingRef = useRef(receivePing);
  receivePingRef.current = receivePing;

  // Clear any pending ping timers on unmount.
  useEffect(() => {
    const timers = pingTimersRef.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, []);

  // Fetch the viewer's own uploaded profile photo once, so we can broadcast a
  // resolved avatar URL to peers (falls back to the Google SSO image above).
  useEffect(() => {
    if (!normSelf) return;
    let cancelled = false;
    fetch(`/api/employee-profile-photo?email=${encodeURIComponent(normSelf)}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { profilePhotoUrl?: string | null } | null) => {
        if (!cancelled) setUploadedPhoto(j?.profilePhotoUrl ?? null);
      })
      .catch(() => { /* non-fatal: initials fallback */ });
    return () => { cancelled = true; };
  }, [normSelf]);

  // --- channel: presence (roster) + broadcast (cursors) ----------------------
  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !normSelf) return;

    const ch = supabase.channel(CHANNEL, {
      config: {
        broadcast: { self: false },
        presence: { key: normSelf },
      },
    });
    channelRef.current = ch;

    const send = (m: CollabMsg) => ch.send({ type: 'broadcast', event: 'ac', payload: m });
    sendRef.current = send;

    const syncRoster = () => {
      const state = ch.presenceState<PresencePayload>();
      const list: PeerMeta[] = [];
      for (const key of Object.keys(state)) {
        const meta = state[key]?.[0];
        if (!meta) continue;
        const email = normEmail(meta.email ?? key) ?? (meta.email ?? key).trim().toLowerCase();
        if (!email || email === 'anon' || email === normSelf) continue;
        list.push({
          email,
          name: meta.name ?? null,
          avatarUrl: meta.avatarUrl ?? null,
          section: meta.section ?? '',
        });
      }
      list.sort((a, b) => a.email.localeCompare(b.email));
      setPeers(list);
    };

    ch.on('broadcast', { event: 'ac' }, ({ payload }: { payload: CollabMsg }) => {
      if (!payload?.email) return;
      const sender = normEmail(payload.email) ?? payload.email.trim().toLowerCase();
      if (sender === normSelf) return;

      // Pings are directed (not section-scoped): only react if addressed to us.
      if (payload.kind === 'ping') {
        const to = payload.toEmail
          ? normEmail(payload.toEmail) ?? payload.toEmail.trim().toLowerCase()
          : null;
        if (to && to === normSelf) receivePingRef.current(sender, payload.text || 'waved at you');
        return;
      }

      // Section scoping: only observe peers on the SAME section as the viewer.
      if (payload.section !== sectionRef.current) return;

      const { bg: color, glow } = hashEmail(sender);
      const peerName = peersNameRef.current.get(sender) ?? null;

      if (payload.kind === 'move') {
        setCursors((prev) => {
          const next = new Map(prev);
          const existing = next.get(sender);
          next.set(sender, {
            ...existing,
            x: payload.x,
            y: payload.y,
            color,
            glow,
            email: sender,
            name: peerName,
            lastSeen: Date.now(),
          });
          return next;
        });
      } else if (payload.kind === 'click') {
        const id = ++idRef.current;
        setRipples((prev) => [...prev, { id, x: payload.x, y: payload.y, color, glow }]);
      }
    })
      .on('presence', { event: 'sync' }, syncRoster)
      .on('presence', { event: 'join' }, syncRoster)
      .on('presence', { event: 'leave' }, syncRoster)
      .subscribe((status: string) => {
        if (status !== 'SUBSCRIBED') return;
        void ch.track({
          email: normSelf,
          name: selfNameRef.current,
          avatarUrl: selfAvatarRef.current,
          section: sectionRef.current,
          online_at: new Date().toISOString(),
        } satisfies PresencePayload);
      });

    return () => {
      void supabase.removeChannel(ch);
      channelRef.current = null;
      sendRef.current = null;
    };
  }, [normSelf]);

  // Keep self meta in refs so we can re-track without re-subscribing.
  const selfNameRef = useRef(selfName);
  const selfAvatarRef = useRef(selfAvatarUrl);
  const peersNameRef = useRef<Map<string, string | null>>(new Map());
  selfNameRef.current = selfName;
  selfAvatarRef.current = selfAvatarUrl;
  peersNameRef.current = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const p of peers) m.set(p.email, p.name);
    return m;
  }, [peers]);

  // Re-broadcast presence when our section / name / avatar changes, and clear
  // the cursor map on section change (old-section cursors must disappear).
  useEffect(() => {
    if (!channelRef.current || !normSelf) return;
    void channelRef.current.track({
      email: normSelf,
      name: selfName,
      avatarUrl: selfAvatarUrl,
      section,
      online_at: new Date().toISOString(),
    } satisfies PresencePayload);
  }, [section, selfName, selfAvatarUrl, normSelf]);

  useEffect(() => {
    // Different section now -> drop any cursors we were showing.
    setCursors(new Map());
    setRipples([]);
  }, [section]);

  // --- mouse + click listeners on the accounting container -------------------
  const sendMsg = useCallback((m: CollabMsg) => { sendRef.current?.(m); }, []);

  // Nudge a peer: broadcast a directed ping (they hear/see it) + a soft local
  // "sent" blip. An empty message falls back to a friendly wave. `broadcast.self
  // =false` means we never receive our own ping.
  const sendPing = useCallback((toEmail: string, text?: string) => {
    if (!normSelf) return;
    const msg = (text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200) || 'waved at you';
    sendRef.current?.({ kind: 'ping', email: normSelf, toEmail, text: msg });
    playPingSent();
  }, [normSelf]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !normSelf) return;

    const onMove = (e: MouseEvent) => {
      const now = Date.now();
      if (now - lastMoveRef.current < MOVE_THROTTLE_MS) return;
      lastMoveRef.current = now;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      sendMsg({
        kind: 'move',
        email: normSelf,
        section: sectionRef.current,
        x: ((e.clientX - r.left) / r.width) * 100,
        y: ((e.clientY - r.top) / r.height) * 100,
      });
    };

    const onClick = (e: MouseEvent) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      sendMsg({
        kind: 'click',
        email: normSelf,
        section: sectionRef.current,
        x: ((e.clientX - r.left) / r.width) * 100,
        y: ((e.clientY - r.top) / r.height) * 100,
      });
    };

    el.addEventListener('mousemove', onMove as EventListener);
    el.addEventListener('click', onClick as EventListener);
    return () => {
      el.removeEventListener('mousemove', onMove as EventListener);
      el.removeEventListener('click', onClick as EventListener);
    };
  }, [normSelf, containerRef, sendMsg]);

  // --- GC stale cursors ------------------------------------------------------
  useEffect(() => {
    const t = setInterval(() => {
      const cutoff = Date.now() - CURSOR_TTL_MS;
      setCursors((prev) => {
        let changed = false;
        const next = new Map(prev);
        for (const [e, c] of next) {
          if (c.lastSeen < cutoff) {
            next.delete(e);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, 1000);
    return () => clearInterval(t);
  }, []);

  // --- Observe (live screen mirror) -----------------------------------------
  // The peer we're observing, resolved from the live presence roster.
  const observedPeer = useMemo(
    () => (observedEmail ? peers.find((p) => p.email === observedEmail) ?? null : null),
    [observedEmail, peers],
  );

  // Stop observing if the peer drops off the roster (left Accounting). We keep
  // observing across their tab switches — the mirror streams their whole screen
  // regardless of which tab they're on.
  useEffect(() => {
    if (observedEmail && peers.length > 0 && !peers.some((p) => p.email === observedEmail)) {
      setObservedEmail(null);
    }
  }, [observedEmail, peers]);

  const observedColor = observedEmail ? hashEmail(observedEmail) : null;
  const observedDisplay = observedPeer
    ? (observedPeer.name && observedPeer.name.trim()) || toLabel(observedPeer.email)
    : observedEmail
      ? toLabel(observedEmail)
      : '';

  // Co-browse runs for every accounting user: the DRIVER half (record + stream
  // when watched) must always be live so this person is observable even when
  // they aren't observing anyone. The OBSERVER half activates when observedEmail
  // is set.
  const { setReplayContainer, status: cobrowseStatus } = useCobrowse({
    selfEmail: normSelf,
    observedEmail,
  });

  if (!normSelf) return null;

  return (
    <>
      {/* Section-scoped cursor + click overlay */}
      <div className="pointer-events-none absolute inset-0 z-50 select-none overflow-hidden">
        <AnimatePresence>
          {Array.from(cursors.values()).map((c) => (
            <RemoteCursor
              key={c.email}
              email={c.email}
              name={c.name}
              x={c.x}
              y={c.y}
              color={c.color}
              glow={c.glow}
            />
          ))}
        </AnimatePresence>

        <AnimatePresence>
          {ripples.map((r) => (
            <div
              key={r.id}
              className="absolute"
              style={{ left: `${r.x}%`, top: `${r.y}%`, transform: 'translate(-50%,-50%)' }}
            >
              {[0, 1, 2].map((i) => (
                <motion.span
                  key={i}
                  className="absolute block rounded-full"
                  style={{
                    left: '50%',
                    top: '50%',
                    transform: 'translate(-50%,-50%)',
                    border: `${2 - i * 0.4}px solid ${r.color}`,
                    boxShadow: i === 0 ? `0 0 6px ${r.glow}` : undefined,
                  }}
                  initial={{ width: 0, height: 0, opacity: 0.9 - i * 0.18 }}
                  animate={{ width: 40 + i * 28, height: 40 + i * 28, opacity: 0 }}
                  transition={{ duration: 0.48 + i * 0.1, delay: i * 0.06, ease: [0.22, 1, 0.36, 1] }}
                  onAnimationComplete={() => {
                    if (i === 2) setRipples((prev) => prev.filter((p) => p.id !== r.id));
                  }}
                />
              ))}
            </div>
          ))}
        </AnimatePresence>
      </div>

      {/* Floating right-edge avatar rail (everyone in Accounting).
          NOTE: the rail intentionally has NO overflow/scroll. `overflow-y-auto`
          would (a) show a scrollbar and (b) clip every avatar's decorations --
          the name card pops out to the LEFT (`right-full`) and the online/eye
          badges sit outside the avatar box -- so the rail must render its
          children fully. To stay on-screen without a scrollbar we cap the
          visible avatars and surface the rest as a "+N" chip. */}
      <AnimatePresence>
        {peers.length > 0 && (
          <motion.div
            className="pointer-events-none absolute right-2.5 top-1/2 z-[60] hidden -translate-y-1/2 flex-col items-end gap-3 py-2 md:flex"
            initial={{ opacity: 0, x: 16 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 16 }}
            transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
          >
            <AnimatePresence mode="popLayout" initial>
              {peers.slice(0, MAX_RAIL_AVATARS).map((p, i) => (
                <RailAvatar
                  key={p.email}
                  index={i}
                  peer={p}
                  sameSection={p.section === section}
                  open={openPeer === p.email}
                  onToggle={() => setOpenPeer((cur) => (cur === p.email ? null : p.email))}
                  observing={observedEmail === p.email}
                  onObserve={() => {
                    setObservedEmail(p.email);
                    setOpenPeer(null);
                  }}
                  onStopObserve={() => setObservedEmail(null)}
                  ping={pings.get(p.email) ?? null}
                  onPing={(text) => sendPing(p.email, text)}
                />
              ))}
              {peers.length > MAX_RAIL_AVATARS && (
                <motion.div
                  key="rail-overflow"
                  layout="position"
                  initial={{ opacity: 0, scale: 0.2, x: 24 }}
                  animate={{ opacity: 1, scale: 1, x: 0, transition: POP_SPRING }}
                  exit={{ opacity: 0, scale: 0.2, x: 24, transition: { duration: 0.18 } }}
                  className="pointer-events-auto flex h-11 w-11 items-center justify-center rounded-full bg-zinc-900/90 text-[12px] font-bold text-white shadow-md ring-2 ring-white/70 backdrop-blur-md dark:ring-zinc-700/70"
                  title={`${peers.length - MAX_RAIL_AVATARS} more in Accounting`}
                >
                  +{peers.length - MAX_RAIL_AVATARS}
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Live screen mirror of the observed peer (full-screen overlay). */}
      <AnimatePresence>
        {observedEmail && (
          <CobrowseSurface
            key={observedEmail}
            driverName={observedDisplay}
            accent={observedColor ?? { bg: '#f97316', glow: 'rgba(249,115,22,0.55)' }}
            status={cobrowseStatus}
            setReplayContainer={setReplayContainer}
            onStop={() => setObservedEmail(null)}
          />
        )}
      </AnimatePresence>
    </>
  );
}
