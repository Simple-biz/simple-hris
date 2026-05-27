'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { init } from 'emoji-mart';
import data from '@emoji-mart/data';

// Initialize emoji-mart once — registers <em-emoji> web component with Facebook set
init({ data, set: 'facebook' });

function EmEmoji({ native, size = '24' }: { native: string; size?: string | number }) {
  // em-emoji is a custom web component registered by emoji-mart init()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Tag = 'em-emoji' as any;
  return <Tag native={native} set="facebook" size={String(size)} />;
}
import {
  AtSign,
  Ban,
  CalendarCheck,
  ChevronDown,
  Clock,
  HandHeart,
  Heart,
  HeartHandshake,
  ImagePlus,
  Languages,
  Loader2,
  Megaphone,
  MessageCircle,
  MonitorCheck,
  Pin,
  Radio,
  Repeat2,
  Send,
  ShieldAlert,
  ThumbsUp,
  TimerReset,
  Trash2,
  Video,
  WifiOff,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';
import { SWALL_EMOJIS } from '@/lib/supabase/swall';
import type { SwallComment } from '@/lib/supabase/swall';

/* ── Reaction metadata ────────────────────────────────────────────────── */

const REACTION_NAMES: Record<string, string> = {
  '👍': 'Like',
  '❤️': 'Love',
  '😂': 'Haha',
  '🔥': 'Fire',
  '😮': 'Wow',
  '👏': 'Clap',
};

/* ── Animated brand label ─────────────────────────────────────────────── */

export function SWallNavLabel() {
  return (
    <span
      aria-label="Simple Wall"
      className="relative inline-grid select-none whitespace-nowrap [grid-template-areas:'stack']"
    >
      <span className="[grid-area:stack] [clip-path:inset(0_0%_0_0)] transition-[clip-path] duration-[320ms] ease-[cubic-bezier(0.4,0,0.2,1)] group-hover/sw:[clip-path:inset(0_100%_0_0)]">
        S-Wall
      </span>
      <span className="[grid-area:stack] [clip-path:inset(0_100%_0_0)] transition-[clip-path] duration-[320ms] ease-[cubic-bezier(0.2,0,0,1)] group-hover/sw:[clip-path:inset(0_0%_0_0)]">
        Simple Wall
      </span>
    </span>
  );
}

/* ── Social links ─────────────────────────────────────────────────────── */
// Replace `href`s with the real channels — left as '#' so a missing handle
// renders a disabled-feeling link rather than a 404.
const SOCIAL_LINKS = [
  { key: 'facebook', label: 'Facebook', href: '#', hover: 'hover:text-[#1877F2] hover:bg-[#1877F2]/10' },
  { key: 'youtube',  label: 'YouTube',  href: 'https://www.youtube.com/@Orphans_PH', hover: 'hover:text-[#FF0000] hover:bg-[#FF0000]/10' },
  { key: 'x',        label: 'X',        href: '#', hover: 'hover:text-zinc-900 hover:bg-zinc-900/10 dark:hover:text-white dark:hover:bg-white/10' },
  { key: 'tiktok',   label: 'TikTok',   href: '#', hover: 'hover:text-zinc-900 hover:bg-zinc-900/10 dark:hover:text-white dark:hover:bg-white/10' },
  { key: 'simple',   label: 'Simple',   href: 'https://www.simple.biz/', hover: 'hover:text-rose-500 hover:bg-rose-500/10' },
] as const;

type SocialKey = (typeof SOCIAL_LINKS)[number]['key'];

function SocialGlyph({ kind, className }: { kind: SocialKey; className?: string }) {
  // Brand SVGs — paths from simpleicons.org (CC0). Inlined to avoid adding a dep.
  const common = { viewBox: '0 0 24 24', fill: 'currentColor', 'aria-hidden': true } as const;
  if (kind === 'simple') {
    return <Heart className={className} fill="currentColor" aria-hidden />;
  }
  if (kind === 'facebook') {
    return (
      <svg {...common} className={className}>
        <path d="M9.101 23.691v-7.98H6.627v-3.667h2.474v-1.58c0-4.085 1.848-5.978 5.858-5.978.401 0 .955.042 1.468.103a8.68 8.68 0 0 1 1.141.195v3.325a8.623 8.623 0 0 0-.653-.036 26.805 26.805 0 0 0-.733-.009c-.707 0-1.259.096-1.675.309a1.686 1.686 0 0 0-.679.622c-.258.42-.374.995-.374 1.752v1.297h3.919l-.386 2.103-.287 1.564h-3.246v8.245C19.396 23.238 24 18.179 24 12.044c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.628 3.874 10.35 9.101 11.647Z" />
      </svg>
    );
  }
  if (kind === 'youtube') {
    return (
      <svg {...common} className={className}>
        <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
      </svg>
    );
  }
  if (kind === 'x') {
    return (
      <svg {...common} className={className}>
        <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
      </svg>
    );
  }
  // tiktok
  return (
    <svg {...common} className={className}>
      <path d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z" />
    </svg>
  );
}

/* ── Policy data ──────────────────────────────────────────────────────── */

const POLICY_SECTIONS = [
  {
    id: 'schedule',
    label: 'Work Schedule',
    policies: [
      { icon: Clock,          title: '9 AM – 5 PM Eastern',    body: 'Work and be reachable 9 AM–5 PM NYC time. Reply promptly to team and client requests.' },
      { icon: TimerReset,     title: 'Overtime cap: 45 h/wk',  body: 'Anything beyond 45 hours per week requires manager approval.' },
      { icon: CalendarCheck,  title: 'Planned time off',        body: 'Give two weeks notice. Perfect-attendance bonus applies when you work ≥ 7 h on all five weekdays.' },
      { icon: MonitorCheck,   title: 'Clock in / Clock out',    body: 'Track every working session. Review screenshots and submit receipts if anything looks off.' },
    ],
  },
  {
    id: 'communication',
    label: 'Communication',
    policies: [
      { icon: Languages, title: 'English only',       body: 'Use English in all company communications, no exceptions.' },
      { icon: Video,     title: 'Cameras on',          body: 'Your full face must be on camera for every meeting.' },
      { icon: Repeat2,   title: 'Always close the loop', body: 'Overcommunicate. Keep teammates and clients updated every step of the way.' },
    ],
  },
  {
    id: 'conduct',
    label: 'Conduct & Culture',
    policies: [
      { icon: ShieldAlert,    title: 'Own your mistakes',    body: 'No excuses. Take responsibility and correct the situation.' },
      { icon: HeartHandshake, title: 'Be humble',            body: "Treat everyone as you'd want to be treated. No talking down to others." },
      { icon: Ban,            title: 'No soliciting',        body: 'No lending, borrowing, buying, or selling between team members.' },
      { icon: HandHeart,      title: 'Professional conduct', body: 'No flirting or intrusive questioning that could be interpreted as approach behavior.' },
    ],
  },
] as const;

/* ── Types ────────────────────────────────────────────────────────────── */

interface EnrichedPost {
  id: string;
  author_email: string;
  author_name: string | null;
  body: string;
  created_at: string;
  reaction_counts: Record<string, number>;
  my_reactions: string[];
  comment_count: number;
  image_urls: string[];
  source_label: string | null;
}

interface ReactionEntry {
  id: string;
  post_id: string;
  user_email: string;
  emoji: string;
}

interface AnnouncementItem {
  id: string;
  author_email: string;
  author_name: string | null;
  title: string;
  body: string;
  pinned: boolean;
  created_at: string;
}

/* ── Avatar helpers ───────────────────────────────────────────────────── */

const AVATAR_GRADIENTS = [
  'from-violet-500 to-indigo-600',
  'from-blue-500 to-cyan-600',
  'from-emerald-500 to-teal-600',
  'from-amber-500 to-orange-500',
  'from-rose-500 to-pink-600',
  'from-fuchsia-500 to-purple-600',
  'from-sky-500 to-blue-600',
  'from-lime-500 to-emerald-600',
] as const;

function avatarGradient(email: string): string {
  let h = 0;
  for (let i = 0; i < email.length; i++) h = (email.charCodeAt(i) + ((h << 5) - h)) | 0;
  return AVATAR_GRADIENTS[Math.abs(h) % AVATAR_GRADIENTS.length]!;
}

function initials(email: string, name: string | null): string {
  if (name?.trim()) {
    return name.trim().split(/\s+/).slice(0, 2).map((w) => w[0] ?? '').join('').toUpperCase();
  }
  const local = email.split('@')[0] ?? '';
  const parts = local.replace(/[._-]/g, ' ').trim().split(/\s+/);
  return parts.slice(0, 2).map((w) => w[0] ?? '').join('').toUpperCase() || '?';
}

function displayName(email: string, name: string | null): string {
  if (name?.trim()) return name.trim();
  return (email.split('@')[0] ?? email).replace(/[._-]/g, ' ');
}

/** Avatar that shows a photo from the profile API, falling back to styled initials. */
function SwallAvatar({
  email,
  name,
  size = 36,
  className,
}: {
  email: string;
  name: string | null;
  size?: number;
  className?: string;
}) {
  const [imgFailed, setImgFailed] = useState(false);
  const grad = avatarGradient(email);
  const label = initials(email, name);
  const fontSize = size <= 28 ? 9 : size <= 36 ? 11 : 13;

  if (!imgFailed) {
    return (
      <img
        src={`/api/employee-profile-photo?email=${encodeURIComponent(email)}&_fmt=img`}
        alt={displayName(email, name)}
        width={size}
        height={size}
        className={cn('shrink-0 rounded-full object-cover', className)}
        style={{ width: size, height: size }}
        onError={() => setImgFailed(true)}
      />
    );
  }

  return (
    <div
      aria-label={displayName(email, name)}
      className={cn(
        'flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br font-bold text-white shadow-sm',
        grad,
        className,
      )}
      style={{ width: size, height: size, fontSize }}
    >
      {label}
    </div>
  );
}

/* ── Misc helpers ─────────────────────────────────────────────────────── */

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/* ── Main component ───────────────────────────────────────────────────── */

interface SWallProps {
  viewerEmail: string | null | undefined;
  canPost: boolean;
  viewerName?: string | null;
  sourceLabel?: string;
}

export default function SWall({ viewerEmail, canPost, viewerName, sourceLabel }: SWallProps) {
  const [posts, setPosts] = useState<EnrichedPost[]>([]);
  const [reactions, setReactions] = useState<ReactionEntry[]>([]);
  const [announcements, setAnnouncements] = useState<AnnouncementItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Per-(postId, emoji) in-flight guard — blocks double-clicks and tracks optimistic direction
  const inFlightRef = useRef<Set<string>>(new Set());
  const [inFlight, setInFlight] = useState<ReadonlySet<string>>(new Set());
  // Tracks optimistic reactions so the Realtime echo can be suppressed
  const ownPendingRef = useRef<Map<string, 'add' | 'remove'>>(new Map());

  const normalizedEmail = (viewerEmail ?? '').trim().toLowerCase();

  /* ── Initial fetch ── */
  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [postsRes, annRes] = await Promise.all([
        fetch(`/api/swall/posts?viewer=${encodeURIComponent(normalizedEmail)}`, { cache: 'no-store' }),
        fetch('/api/announcements?scope=general', { cache: 'no-store' }),
      ]);

      const postsJson = (await postsRes.json()) as { posts?: EnrichedPost[]; error?: string };
      if (postsJson.error) throw new Error(postsJson.error);
      const fetched = postsJson.posts ?? [];
      setPosts(fetched);

      const seed: ReactionEntry[] = [];
      for (const p of fetched) {
        for (const emoji of p.my_reactions) {
          seed.push({ id: `seed-${p.id}-${emoji}`, post_id: p.id, user_email: normalizedEmail, emoji });
        }
      }
      setReactions(seed);

      if (annRes.ok) {
        const annJson = (await annRes.json()) as { announcements?: AnnouncementItem[] };
        setAnnouncements(annJson.announcements ?? []);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [normalizedEmail]);

  useEffect(() => { void fetchAll(); }, [fetchAll]);

  /* ── Realtime ── */
  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;

    const channel = supabase
      .channel('swall-feed')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'swall_posts' }, (payload) => {
        const p = payload.new as Omit<EnrichedPost, 'reaction_counts' | 'my_reactions' | 'comment_count'>;
        setPosts((prev) => [{
          ...p,
          reaction_counts: {},
          my_reactions: [],
          comment_count: 0,
          image_urls: p.image_urls ?? [],
          source_label: p.source_label ?? null,
        }, ...prev]);
      })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'swall_posts' }, (payload) => {
        setPosts((prev) => prev.filter((p) => p.id !== payload.old.id));
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'swall_reactions' }, (payload) => {
        const r = payload.new as ReactionEntry;
        const key = `${r.post_id}:${r.emoji}`;
        // Suppress the echo for our own optimistic update
        if (r.user_email.toLowerCase() === normalizedEmail && ownPendingRef.current.get(key) === 'add') {
          ownPendingRef.current.delete(key);
          return;
        }
        setReactions((prev) => [...prev, r]);
        setPosts((prev) => prev.map((p) =>
          p.id !== r.post_id ? p : {
            ...p,
            reaction_counts: { ...p.reaction_counts, [r.emoji]: (p.reaction_counts[r.emoji] ?? 0) + 1 },
            my_reactions: r.user_email.toLowerCase() === normalizedEmail ? [...p.my_reactions, r.emoji] : p.my_reactions,
          },
        ));
      })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'swall_reactions' }, (payload) => {
        const old = payload.old as { id: string; post_id: string; emoji: string; user_email: string };
        const key = `${old.post_id}:${old.emoji}`;
        // Suppress the echo for our own optimistic removal
        if (old.user_email?.toLowerCase() === normalizedEmail && ownPendingRef.current.get(key) === 'remove') {
          ownPendingRef.current.delete(key);
          return;
        }
        setReactions((prev) => prev.filter((r) => r.id !== old.id));
        setPosts((prev) => prev.map((p) =>
          p.id !== old.post_id ? p : {
            ...p,
            reaction_counts: { ...p.reaction_counts, [old.emoji]: Math.max(0, (p.reaction_counts[old.emoji] ?? 1) - 1) },
            my_reactions: old.user_email?.toLowerCase() === normalizedEmail
              ? p.my_reactions.filter((e) => e !== old.emoji) : p.my_reactions,
          },
        ));
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'swall_comments' }, (payload) => {
        const c = payload.new as { post_id: string };
        setPosts((prev) => prev.map((p) => p.id === c.post_id ? { ...p, comment_count: p.comment_count + 1 } : p));
      })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'swall_comments' }, (payload) => {
        const c = payload.old as { post_id: string };
        setPosts((prev) => prev.map((p) => p.id === c.post_id ? { ...p, comment_count: Math.max(0, p.comment_count - 1) } : p));
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'announcements' }, (payload) => {
        const a = payload.new as AnnouncementItem;
        setAnnouncements((prev) => {
          const next = a.pinned ? [a, ...prev] : [...prev.filter((x) => x.pinned), a, ...prev.filter((x) => !x.pinned)];
          return next;
        });
      })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'announcements' }, (payload) => {
        setAnnouncements((prev) => prev.filter((a) => a.id !== payload.old.id));
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'announcements' }, (payload) => {
        const updated = payload.new as AnnouncementItem;
        setAnnouncements((prev) => {
          const list = prev.map((a) => a.id === updated.id ? updated : a);
          return [...list.filter((a) => a.pinned), ...list.filter((a) => !a.pinned)];
        });
      })
      .subscribe();

    return () => { void supabase.removeChannel(channel); };
  }, [normalizedEmail]);

  /* ── Handlers ── */
  const handleReact = useCallback(async (postId: string, emoji: string, currentlyReacted: boolean) => {
    const key = `${postId}:${emoji}`;
    if (inFlightRef.current.has(key)) return;
    inFlightRef.current.add(key);
    setInFlight(new Set(inFlightRef.current));
    ownPendingRef.current.set(key, currentlyReacted ? 'remove' : 'add');

    // Optimistic update — instant UI feedback
    setPosts((prev) => prev.map((p) => {
      if (p.id !== postId) return p;
      return {
        ...p,
        reaction_counts: {
          ...p.reaction_counts,
          [emoji]: Math.max(0, (p.reaction_counts[emoji] ?? 0) + (currentlyReacted ? -1 : 1)),
        },
        my_reactions: currentlyReacted
          ? p.my_reactions.filter((e) => e !== emoji)
          : [...p.my_reactions, emoji],
      };
    }));

    try {
      const res = await fetch('/api/swall/reactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ post_id: postId, emoji }),
      });
      const json = (await res.json()) as { error?: string };
      if (json.error) throw new Error(json.error);
    } catch {
      // Roll back the optimistic update
      setPosts((prev) => prev.map((p) => {
        if (p.id !== postId) return p;
        return {
          ...p,
          reaction_counts: {
            ...p.reaction_counts,
            [emoji]: Math.max(0, (p.reaction_counts[emoji] ?? 0) + (currentlyReacted ? 1 : -1)),
          },
          my_reactions: currentlyReacted
            ? [...p.my_reactions, emoji]
            : p.my_reactions.filter((e) => e !== emoji),
        };
      }));
      ownPendingRef.current.delete(key);
      toast.error('Reaction failed');
    } finally {
      inFlightRef.current.delete(key);
      setInFlight(new Set(inFlightRef.current));
    }
  }, []);

  const handleDeletePost = async (postId: string) => {
    try {
      const res = await fetch(`/api/swall/posts/${postId}`, { method: 'DELETE' });
      const json = (await res.json()) as { error?: string };
      if (json.error) throw new Error(json.error);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Delete failed');
    }
  };

  /* ── Render ── */
  return (
    <div className="flex h-full min-h-0 flex-col bg-zinc-50 dark:bg-[#0a0a0c]">
      {/* ── Minimal sticky header ── */}
      <header className="sticky top-0 z-10 shrink-0 border-b border-zinc-200/70 bg-white/85 px-4 py-3 backdrop-blur-md dark:border-zinc-800/70 dark:bg-zinc-950/80">
        <div className="mx-auto flex max-w-[1240px] items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/favicon2.png" alt="" className="h-7 w-7 shrink-0 object-contain" />
          <h1 className="text-[17px] font-bold tracking-tight text-zinc-900 dark:text-white">
            Simple Wall
          </h1>
          <span className="hidden text-[11.5px] text-zinc-400 sm:inline dark:text-zinc-600">
            · what the team's saying
          </span>
        </div>
      </header>

      {/* ── 2-col layout: centered feed + slim right rail ── */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[1240px] gap-8 px-3 py-5 sm:px-5 xl:gap-10">
          {/* ── Feed (centered, capped width like Twitter) ── */}
          <main className="mx-auto min-w-0 flex-1 space-y-3 sm:max-w-[600px]">
            {canPost && (
              <SWallComposer
                viewerEmail={normalizedEmail}
                viewerName={viewerName ?? null}
                sourceLabel={sourceLabel}
              />
            )}

            {loading ? (
              <SWallFeedSkeleton />
            ) : error ? (
              <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-zinc-200 bg-white py-14 text-center dark:border-zinc-800 dark:bg-zinc-950">
                <WifiOff className="h-7 w-7 text-zinc-300 dark:text-zinc-700" />
                <p className="text-sm text-zinc-500">{error}</p>
              </div>
            ) : posts.length === 0 ? (
              <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-zinc-200 bg-white py-16 text-center dark:border-zinc-800 dark:bg-zinc-950">
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-zinc-100 text-zinc-400 dark:bg-zinc-900">
                  <MessageCircle className="h-5 w-5" />
                </div>
                <p className="text-sm font-medium text-zinc-600 dark:text-zinc-400">The wall is quiet</p>
                <p className="text-xs text-zinc-400 dark:text-zinc-600">
                  {canPost ? 'Be the first to post something.' : 'Check back later for updates.'}
                </p>
              </div>
            ) : (
              posts.map((post) => (
                <SWallPostCard
                  key={post.id}
                  post={post}
                  viewerEmail={normalizedEmail}
                  onReact={handleReact}
                  onDelete={handleDeletePost}
                  inFlight={inFlight}
                />
              ))
            )}
          </main>

          {/* ── Right rail — social + announcements + policies, hidden on small screens ── */}
          <aside className="hidden w-[340px] shrink-0 space-y-3 lg:block xl:w-[360px]">
            <div className="sticky top-[68px] space-y-3">
              <SocialLinksPanel />
              <CEOAnnouncementsPanel announcements={announcements} loading={loading} />
              <CompanyPoliciesPanel />
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}

/* ── Social links panel (top of right rail) ───────────────────────────── */

function SocialLinksPanel() {
  return (
    <div className="overflow-hidden rounded-2xl border border-zinc-200/80 bg-white px-4 pt-3.5 pb-3 dark:border-zinc-800 dark:bg-zinc-950">
      <h2 className="mb-2.5 text-[12.5px] font-bold tracking-tight text-zinc-900 dark:text-white">
        Follow Simple
      </h2>
      <div className="flex items-center gap-1.5">
        {SOCIAL_LINKS.map((s) => (
          <a
            key={s.key}
            href={s.href}
            target="_blank"
            rel="noreferrer noopener"
            aria-label={s.label}
            title={s.label}
            className={cn(
              'flex h-9 w-9 items-center justify-center rounded-full text-zinc-500 transition-all duration-200 ease-out hover:-translate-y-0.5 hover:scale-110 active:scale-95 dark:text-zinc-400',
              s.hover,
            )}
          >
            <SocialGlyph kind={s.key} className="h-4 w-4 transition-transform duration-200" />
          </a>
        ))}
      </div>
    </div>
  );
}

/* ── Company Policies panel (left sidebar) ────────────────────────────── */

function CompanyPoliciesPanel() {
  const [openSections, setOpenSections] = useState<Set<string>>(new Set());

  const toggle = (id: string) =>
    setOpenSections((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  return (
    <div className="overflow-hidden rounded-2xl border border-zinc-200/80 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex items-center gap-2 px-4 pt-3.5 pb-2">
        <Pin className="h-3.5 w-3.5 text-zinc-400 dark:text-zinc-500" />
        <h2 className="text-[12.5px] font-bold tracking-tight text-zinc-900 dark:text-white">
          Company policies
        </h2>
      </div>

      <div className="divide-y divide-zinc-100 dark:divide-zinc-800/60">
        {POLICY_SECTIONS.map((section) => {
          const isOpen = openSections.has(section.id);
          return (
            <div key={section.id}>
              <button
                type="button"
                onClick={() => toggle(section.id)}
                aria-expanded={isOpen}
                className="group/pol flex w-full items-center justify-between px-4 py-2.5 text-left transition-colors duration-200 hover:bg-zinc-50 dark:hover:bg-zinc-900/50"
              >
                <span
                  className={cn(
                    'text-[12px] font-semibold transition-colors duration-200',
                    isOpen
                      ? 'text-zinc-900 dark:text-white'
                      : 'text-zinc-700 group-hover/pol:text-zinc-900 dark:text-zinc-300 dark:group-hover/pol:text-white',
                  )}
                >
                  {section.label}
                </span>
                <span
                  className={cn(
                    'flex h-5 w-5 shrink-0 items-center justify-center rounded-full transition-colors duration-200',
                    isOpen
                      ? 'bg-violet-100 text-violet-600 dark:bg-violet-900/40 dark:text-violet-300'
                      : 'text-zinc-400 group-hover/pol:bg-zinc-200/70 group-hover/pol:text-zinc-600 dark:group-hover/pol:bg-zinc-800 dark:group-hover/pol:text-zinc-300',
                  )}
                >
                  <ChevronDown
                    className={cn(
                      'h-3.5 w-3.5 transition-transform duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)]',
                      isOpen && '-rotate-180',
                    )}
                  />
                </span>
              </button>

              <AnimatePresence initial={false}>
                {isOpen && (
                  <motion.div
                    key="content"
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{
                      height: { duration: 0.34, ease: [0.22, 1, 0.36, 1] },
                      opacity: { duration: 0.22, ease: 'easeOut' },
                    }}
                    className="overflow-hidden"
                  >
                    <motion.div
                      initial="closed"
                      animate="open"
                      exit="closed"
                      variants={{
                        open: { transition: { staggerChildren: 0.05, delayChildren: 0.08 } },
                        closed: {},
                      }}
                      className="divide-y divide-zinc-100 dark:divide-zinc-800/60"
                    >
                      {section.policies.map((policy) => {
                        const Icon = policy.icon;
                        return (
                          <motion.div
                            key={policy.title}
                            variants={{
                              open: { opacity: 1, y: 0, transition: { duration: 0.25, ease: 'easeOut' } },
                              closed: { opacity: 0, y: -6 },
                            }}
                            className="flex items-start gap-2.5 bg-zinc-50/60 px-4 py-2.5 dark:bg-zinc-900/30"
                          >
                            <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-400 dark:text-zinc-500" />
                            <div className="min-w-0">
                              <p className="text-[11.5px] font-semibold leading-snug text-zinc-800 dark:text-zinc-200">
                                {policy.title}
                              </p>
                              <p className="mt-0.5 text-[11px] leading-snug text-zinc-500 dark:text-zinc-500">
                                {policy.body}
                              </p>
                            </div>
                          </motion.div>
                        );
                      })}
                    </motion.div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── Skeleton helpers ─────────────────────────────────────────────────── */

function Shimmer({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'animate-pulse rounded-lg bg-zinc-100 dark:bg-zinc-800',
        className,
      )}
    />
  );
}

function SWallPostSkeleton() {
  return (
    <div className="overflow-hidden rounded-2xl border border-zinc-200/80 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex items-start gap-3 p-4">
        <Shimmer className="h-10 w-10 shrink-0 rounded-full" />
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex items-center gap-2">
            <Shimmer className="h-3 w-24" />
            <Shimmer className="h-3 w-14" />
          </div>
          <Shimmer className="h-3 w-full" />
          <Shimmer className="h-3 w-4/5" />
        </div>
      </div>
      <div className="flex items-center gap-3 px-4 pb-3">
        <Shimmer className="h-6 w-14 rounded-full" />
        <Shimmer className="h-6 w-16 rounded-full" />
      </div>
    </div>
  );
}

function SWallFeedSkeleton() {
  return (
    <div className="space-y-3.5">
      <SWallPostSkeleton />
      <SWallPostSkeleton />
      <SWallPostSkeleton />
    </div>
  );
}

function AnnouncementsSkeleton() {
  return (
    <div className="divide-y divide-zinc-100 dark:divide-zinc-800/60">
      {[0, 1, 2].map((i) => (
        <div key={i} className="px-3.5 py-3">
          <div className="mb-2 flex items-center gap-2">
            <Shimmer className="h-7 w-7 shrink-0 rounded-full" />
            <div className="flex-1 space-y-1.5">
              <Shimmer className="h-2.5 w-24" />
              <Shimmer className="h-2 w-14" />
            </div>
          </div>
          <Shimmer className="mb-1.5 h-3 w-3/4" />
          <Shimmer className="h-2.5 w-full" />
          <Shimmer className="mt-1 h-2.5 w-2/3" />
        </div>
      ))}
    </div>
  );
}

/* ── CEO Announcements panel (right sidebar) ──────────────────────────── */

function CEOAnnouncementsPanel({
  announcements,
  loading,
}: {
  announcements: AnnouncementItem[];
  loading: boolean;
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-zinc-200/80 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex items-center gap-2 px-4 pt-3.5 pb-2">
        <Megaphone className="h-3.5 w-3.5 text-amber-500 dark:text-amber-400" />
        <h2 className="text-[12.5px] font-bold tracking-tight text-zinc-900 dark:text-white">
          From the CEO
        </h2>
      </div>

      <div className="divide-y divide-zinc-100 dark:divide-zinc-800/60">
        {loading ? (
          <AnnouncementsSkeleton />
        ) : announcements.length === 0 ? (
          <div className="flex flex-col items-center gap-1.5 py-10 text-center">
            <Megaphone className="h-7 w-7 text-amber-200 dark:text-amber-900" />
            <p className="text-[11.5px] text-zinc-500 dark:text-zinc-600">No announcements yet.</p>
          </div>
        ) : (
          announcements.map((a) => (
            <AnnouncementRow key={a.id} announcement={a} />
          ))
        )}
      </div>
    </div>
  );
}

function AnnouncementRow({ announcement: a }: { announcement: AnnouncementItem }) {
  const [expanded, setExpanded] = useState(false);
  const isLong = a.body.length > 160;
  const preview = isLong && !expanded ? a.body.slice(0, 160).trimEnd() + '…' : a.body;

  return (
    <div className={cn('px-3.5 py-3', a.pinned && 'bg-amber-50/50 dark:bg-amber-950/10')}>
      {/* Pinned badge */}
      {a.pinned && (
        <div className="mb-2 flex items-center gap-1">
          <Pin className="h-2.5 w-2.5 text-amber-500" />
          <span className="text-[9px] font-semibold uppercase tracking-[0.14em] text-amber-600 dark:text-amber-400">
            Pinned
          </span>
        </div>
      )}

      {/* Author */}
      <div className="mb-2 flex items-center gap-2">
        <SwallAvatar email={a.author_email} name={a.author_name} size={28} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[11.5px] font-semibold leading-tight text-zinc-900 dark:text-white">
            {displayName(a.author_email, a.author_name)}
          </p>
          <p className="text-[10px] text-zinc-400 dark:text-zinc-600">{timeAgo(a.created_at)}</p>
        </div>
      </div>

      {/* Title + body */}
      <p className="mb-1 text-[12.5px] font-bold leading-snug text-zinc-900 dark:text-white">
        {a.title}
      </p>
      <motion.div layout className="overflow-hidden">
        <AnimatePresence mode="wait" initial={false}>
          <motion.p
            key={expanded ? 'full' : 'preview'}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            className="text-[11.5px] leading-relaxed text-zinc-600 dark:text-zinc-400"
          >
            {preview}
          </motion.p>
        </AnimatePresence>
      </motion.div>
      {isLong && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="group/more mt-1 inline-flex items-center gap-0.5 text-[11px] font-medium text-amber-600 transition-colors hover:text-amber-700 dark:text-amber-400 dark:hover:text-amber-300"
        >
          {expanded ? 'Show less' : 'Read more'}
          <ChevronDown
            className={cn(
              'h-3 w-3 transition-transform duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)]',
              expanded && '-rotate-180',
            )}
          />
        </button>
      )}
    </div>
  );
}

/* ── Composer ─────────────────────────────────────────────────────────── */

interface MentionProfile {
  work_email: string;
  name: string | null;
}

function SWallComposer({
  viewerEmail,
  viewerName,
  sourceLabel,
}: {
  viewerEmail: string;
  viewerName: string | null;
  sourceLabel?: string;
}) {
  const [focused, setFocused] = useState(false);
  const [body, setBody] = useState('');
  const [posting, setPosting] = useState(false);
  const [imagePreviews, setImagePreviews] = useState<{ file: File; url: string }[]>([]);

  // @mention state
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionProfiles, setMentionProfiles] = useState<MentionProfile[]>([]);
  const [profilesLoaded, setProfilesLoaded] = useState(false);
  const [mentionDropdownIdx, setMentionDropdownIdx] = useState(0);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mentionStartRef = useRef<number>(-1);

  const isExpanded = focused || body.length > 0 || imagePreviews.length > 0;

  // Load profiles lazily once
  const loadProfiles = useCallback(async () => {
    if (profilesLoaded) return;
    try {
      const res = await fetch('/api/employee-rate-profiles/summary', { cache: 'no-store' });
      const json = (await res.json()) as {
        profiles?: {
          workEmail: string | null;
          personalEmail: string | null;
          displayName: string;
          suspended: boolean;
        }[];
      };
      const mapped: MentionProfile[] = (json.profiles ?? [])
        .filter((p) => !p.suspended && (p.workEmail || p.personalEmail))
        .map((p) => ({
          work_email: (p.workEmail ?? p.personalEmail)!,
          name: p.displayName || null,
        }));
      setMentionProfiles(mapped);
      setProfilesLoaded(true);
    } catch {
      setProfilesLoaded(true);
    }
  }, [profilesLoaded]);

  // Filter profiles for current mention query
  const mentionMatches = mentionQuery !== null
    ? mentionProfiles
        .filter((p) => {
          const q = mentionQuery.toLowerCase();
          return (
            (p.name?.toLowerCase().includes(q) ?? false) ||
            p.work_email.toLowerCase().includes(q)
          );
        })
        .slice(0, 6)
    : [];

  const addImages = useCallback((files: FileList | File[]) => {
    const arr = Array.from(files).filter((f) => f.type.startsWith('image/'));
    setImagePreviews((prev) => {
      const remaining = 10 - prev.length;
      const toAdd = arr.slice(0, remaining).map((f) => ({ file: f, url: URL.createObjectURL(f) }));
      return [...prev, ...toAdd];
    });
  }, []);

  const removeImage = (idx: number) => {
    setImagePreviews((prev) => {
      URL.revokeObjectURL(prev[idx]!.url);
      return prev.filter((_, i) => i !== idx);
    });
  };

  const handleBodyChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setBody(val);

    // Auto-grow
    e.target.style.height = 'auto';
    e.target.style.height = `${e.target.scrollHeight}px`;

    // Detect @mention
    const pos = e.target.selectionStart ?? val.length;
    const before = val.slice(0, pos);
    const match = before.match(/@(\w*)$/);
    if (match) {
      mentionStartRef.current = pos - match[0].length;
      setMentionQuery(match[1] ?? '');
      setMentionDropdownIdx(0);
      void loadProfiles();
    } else {
      setMentionQuery(null);
    }
  };

  const insertMention = (profile: MentionProfile) => {
    const firstName = profile.name?.trim().split(/\s+/)[0] ?? profile.work_email.split('@')[0] ?? 'User';
    const start = mentionStartRef.current;
    const pos = textareaRef.current?.selectionStart ?? body.length;
    const before = body.slice(0, start);
    const after = body.slice(pos);
    const inserted = `@${firstName} `;
    const newBody = before + inserted + after;
    setBody(newBody);
    setMentionQuery(null);
    setTimeout(() => {
      if (textareaRef.current) {
        const newPos = start + inserted.length;
        textareaRef.current.focus();
        textareaRef.current.setSelectionRange(newPos, newPos);
        textareaRef.current.style.height = 'auto';
        textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
      }
    }, 0);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionQuery !== null && mentionMatches.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionDropdownIdx((i) => (i + 1) % mentionMatches.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionDropdownIdx((i) => (i - 1 + mentionMatches.length) % mentionMatches.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const m = mentionMatches[mentionDropdownIdx];
        if (m) insertMention(m);
        return;
      }
      if (e.key === 'Escape') {
        setMentionQuery(null);
        return;
      }
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      void handlePost();
    }
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const imageFiles: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      if (item.type.startsWith('image/')) {
        const f = item.getAsFile();
        if (f) imageFiles.push(f);
      }
    }
    if (imageFiles.length > 0) {
      e.preventDefault();
      addImages(imageFiles);
    }
  };

  const handlePost = async () => {
    if (!body.trim() && imagePreviews.length === 0) return;
    setPosting(true);
    try {
      // Upload images in parallel
      const uploadedUrls = await Promise.all(
        imagePreviews.map(async ({ file }) => {
          const fd = new FormData();
          fd.append('file', file);
          const res = await fetch('/api/swall/upload', { method: 'POST', body: fd });
          const json = (await res.json()) as { url?: string; error?: string };
          if (json.error) throw new Error(json.error);
          return json.url!;
        }),
      );

      const res = await fetch('/api/swall/posts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          body: body.trim(),
          image_urls: uploadedUrls,
          source_label: sourceLabel ?? null,
        }),
      });
      const json = (await res.json()) as { error?: string };
      if (json.error) throw new Error(json.error);

      setBody('');
      imagePreviews.forEach((p) => URL.revokeObjectURL(p.url));
      setImagePreviews([]);
      setFocused(false);
      if (textareaRef.current) textareaRef.current.style.height = 'auto';
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Post failed');
    } finally {
      setPosting(false);
    }
  };

  const handleCancel = () => {
    setBody('');
    imagePreviews.forEach((p) => URL.revokeObjectURL(p.url));
    setImagePreviews([]);
    setFocused(false);
    setMentionQuery(null);
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  };

  const canSubmit = (body.trim().length > 0 || imagePreviews.length > 0) && !posting;

  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounterRef = useRef(0);

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current += 1;
    if (e.dataTransfer.types.includes('Files')) setIsDragOver(true);
  };
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };
  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current -= 1;
    if (dragCounterRef.current === 0) setIsDragOver(false);
  };
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current = 0;
    setIsDragOver(false);
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      setFocused(true);
      addImages(files);
    }
  };

  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-2xl border bg-white transition-colors duration-150 dark:bg-zinc-950',
        isDragOver
          ? 'border-violet-400 dark:border-violet-500'
          : 'border-zinc-200/80 dark:border-zinc-800',
      )}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Drop overlay */}
      {isDragOver && (
        <div className="pointer-events-none absolute inset-0 z-30 flex flex-col items-center justify-center gap-2 rounded-2xl bg-violet-50/90 dark:bg-violet-950/80">
          <motion.div
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: 'spring', stiffness: 400, damping: 20 }}
            className="flex flex-col items-center gap-2"
          >
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-violet-100 ring-2 ring-violet-300 dark:bg-violet-900/60 dark:ring-violet-600">
              <ImagePlus className="h-6 w-6 text-violet-600 dark:text-violet-300" />
            </div>
            <p className="text-[13px] font-semibold text-violet-700 dark:text-violet-300">Drop to add image</p>
          </motion.div>
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => { if (e.target.files) addImages(e.target.files); e.target.value = ''; }}
      />

      <div className="flex items-start gap-3 p-4">
        <SwallAvatar email={viewerEmail} name={viewerName} size={40} className="mt-0.5 shrink-0" />
        <div className="relative min-w-0 flex-1">
          {!isExpanded ? (
            <button
              type="button"
              onClick={() => { setFocused(true); setTimeout(() => textareaRef.current?.focus(), 0); }}
              className="flex h-10 w-full items-center rounded-full bg-zinc-100 px-4 text-left text-[14px] text-zinc-500 transition-colors hover:bg-zinc-200/70 dark:bg-zinc-900 dark:text-zinc-500 dark:hover:bg-zinc-800"
            >
              {viewerName ? `What's on your mind, ${viewerName.split(' ')[0]}?` : "What's on your mind?"}
            </button>
          ) : (
            <>
              <textarea
                ref={textareaRef}
                value={body}
                onChange={handleBodyChange}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                onFocus={() => setFocused(true)}
                placeholder="Share something with the company…"
                rows={3}
                maxLength={2000}
                className="w-full resize-none rounded-xl border border-[#ececec] bg-[#fafaf8] px-3 py-2 text-[13px] leading-relaxed placeholder:text-zinc-400 focus:border-violet-300 focus:outline-none focus:ring-1 focus:ring-violet-200 dark:border-zinc-800 dark:bg-zinc-900 dark:placeholder:text-zinc-600 dark:focus:border-violet-700 dark:focus:ring-violet-900/40"
              />

              {/* @mention list — inline, shows 3 rows then scrolls */}
              <AnimatePresence>
                {mentionQuery !== null && mentionMatches.length > 0 && (
                  <motion.div
                    initial={{ opacity: 0, y: -6, scale: 0.97 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -6, scale: 0.97 }}
                    transition={{ type: 'spring', stiffness: 460, damping: 30 }}
                    className="mt-1.5 origin-top overflow-hidden rounded-xl border border-zinc-200/80 bg-white shadow-lg dark:border-zinc-700/80 dark:bg-zinc-900"
                  >
                    {mentionMatches.slice(0, 3).map((profile, i) => (
                      <motion.button
                        key={profile.work_email}
                        type="button"
                        initial={{ opacity: 0, x: -8 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: 0.04 + i * 0.04, duration: 0.18, ease: 'easeOut' }}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          insertMention(profile);
                        }}
                        onMouseEnter={() => setMentionDropdownIdx(i)}
                        className={cn(
                          'flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors duration-150',
                          'border-b border-zinc-100 last:border-0 dark:border-zinc-800',
                          i === mentionDropdownIdx
                            ? 'bg-violet-50 dark:bg-violet-950/40'
                            : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/60',
                        )}
                      >
                        <SwallAvatar email={profile.work_email} name={profile.name} size={30} />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[13px] font-semibold text-zinc-900 dark:text-zinc-100">
                            {profile.name ?? profile.work_email.split('@')[0]}
                          </p>
                          <p className="truncate text-[11px] text-zinc-400 dark:text-zinc-500">
                            {profile.work_email}
                          </p>
                        </div>
                        <AnimatePresence>
                          {i === mentionDropdownIdx && (
                            <motion.span
                              initial={{ opacity: 0, scale: 0.6 }}
                              animate={{ opacity: 1, scale: 1 }}
                              exit={{ opacity: 0, scale: 0.6 }}
                              transition={{ type: 'spring', stiffness: 500, damping: 24 }}
                              className="shrink-0 rounded-md bg-violet-100 px-1.5 py-0.5 text-[10px] font-medium text-violet-600 dark:bg-violet-900/40 dark:text-violet-300"
                            >
                              {'↵'}
                            </motion.span>
                          )}
                        </AnimatePresence>
                      </motion.button>
                    ))}
                    {mentionMatches.length > 3 && (
                      <p className="px-3 py-1.5 text-[11px] text-zinc-400 dark:text-zinc-600">
                        +{mentionMatches.length - 3} more {'—'} keep typing to narrow
                      </p>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Image previews */}
              {imagePreviews.length > 0 && (
                <div className="mt-2 grid grid-cols-4 gap-1.5">
                  {imagePreviews.map((p, i) => (
                    <div key={p.url} className="group relative aspect-square overflow-hidden rounded-lg">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={p.url} alt="" className="h-full w-full object-cover" />
                      <button
                        type="button"
                        onClick={() => removeImage(i)}
                        className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/60 text-white opacity-0 transition-opacity group-hover:opacity-100"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                  {imagePreviews.length < 10 && (
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="flex aspect-square items-center justify-center rounded-lg border-2 border-dashed border-zinc-200 text-zinc-400 transition-colors hover:border-violet-300 hover:text-violet-500 dark:border-zinc-700 dark:hover:border-violet-700"
                    >
                      <ImagePlus className="h-4 w-4" />
                    </button>
                  )}
                </div>
              )}

              {/* Action bar */}
              <div className="mt-2.5 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="flex h-7 items-center gap-1 rounded-lg border border-[#ececec] bg-[#fafaf8] px-2.5 text-[11px] font-medium text-zinc-600 transition-colors hover:border-violet-200 hover:bg-violet-50 hover:text-violet-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:border-violet-800 dark:hover:text-violet-400"
                >
                  <ImagePlus className="h-3.5 w-3.5" />
                  Photo
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const ta = textareaRef.current;
                    if (!ta) return;
                    const pos = ta.selectionStart ?? body.length;
                    const before = body.slice(0, pos);
                    const after = body.slice(pos);
                    const newBody = before + '@' + after;
                    setBody(newBody);
                    setMentionQuery('');
                    mentionStartRef.current = pos;
                    setMentionDropdownIdx(0);
                    void loadProfiles();
                    setTimeout(() => {
                      ta.focus();
                      ta.setSelectionRange(pos + 1, pos + 1);
                    }, 0);
                  }}
                  className="flex h-7 items-center gap-1 rounded-lg border border-[#ececec] bg-[#fafaf8] px-2.5 text-[11px] font-medium text-zinc-600 transition-colors hover:border-violet-200 hover:bg-violet-50 hover:text-violet-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:border-violet-800 dark:hover:text-violet-400"
                >
                  <AtSign className="h-3.5 w-3.5" />
                  Tag
                </button>
                {sourceLabel && (
                  <span className="flex h-7 items-center gap-1 rounded-lg border border-violet-200/70 bg-violet-50 px-2.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-violet-700 dark:border-violet-800/40 dark:bg-violet-950/30 dark:text-violet-300">
                    <Radio className="h-3 w-3" />
                    {sourceLabel}
                  </span>
                )}
                <div className="flex-1" />
                {body.length > 100 && (
                  <span className={cn(
                    'text-[11px] tabular-nums',
                    body.length > 1900 ? 'text-rose-500' : 'text-zinc-400 dark:text-zinc-600',
                  )}>
                    {2000 - body.length}
                  </span>
                )}
                <button
                  type="button"
                  onClick={handleCancel}
                  className="h-7 rounded-lg px-2.5 text-[12px] font-medium text-zinc-500 transition-colors hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handlePost}
                  disabled={!canSubmit}
                  className="flex h-7 items-center gap-1.5 rounded-lg bg-gradient-to-br from-violet-600 to-indigo-700 px-3.5 text-[12px] font-semibold text-white shadow-sm shadow-violet-500/25 transition-opacity hover:opacity-90 disabled:opacity-40"
                >
                  {posting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                  Post
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── renderBody helper ────────────────────────────────────────────────── */

function renderBody(text: string): React.ReactNode {
  const parts = text.split(/(@\w+)/g);
  return (
    <span className="whitespace-pre-wrap">
      {parts.map((part, i) =>
        part.startsWith('@') && part.length > 1 ? (
          <span key={i} className="font-semibold text-violet-600 dark:text-violet-400">
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </span>
  );
}

/* ── Image grid helper ────────────────────────────────────────────────── */

function PostImageGrid({ urls }: { urls: string[] }) {
  if (urls.length === 0) return null;

  // 1 image — natural ratio, contained, capped at 500 px tall (like Facebook)
  if (urls.length === 1) {
    return (
      <a
        href={urls[0]}
        target="_blank"
        rel="noreferrer"
        className="block max-h-[500px] overflow-hidden bg-zinc-100 dark:bg-zinc-900"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={urls[0]}
          alt=""
          className="mx-auto max-h-[500px] w-full object-contain"
        />
      </a>
    );
  }

  // 2 images — side by side, 4:3 each
  if (urls.length === 2) {
    return (
      <div className="grid grid-cols-2 gap-0.5 overflow-hidden">
        {urls.map((url) => (
          <a key={url} href={url} target="_blank" rel="noreferrer" className="block aspect-[4/3] overflow-hidden">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={url} alt="" className="h-full w-full object-cover" />
          </a>
        ))}
      </div>
    );
  }

  // 3 images — 1 portrait on left, 2 stacked on right (Facebook layout)
  if (urls.length === 3) {
    return (
      <div className="grid grid-cols-2 gap-0.5 overflow-hidden">
        <a href={urls[0]} target="_blank" rel="noreferrer" className="block overflow-hidden" style={{ aspectRatio: '1/1.2' }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={urls[0]} alt="" className="h-full w-full object-cover" />
        </a>
        <div className="flex flex-col gap-0.5">
          {urls.slice(1).map((url) => (
            <a key={url} href={url} target="_blank" rel="noreferrer" className="block flex-1 overflow-hidden">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={url} alt="" className="h-full w-full object-cover" />
            </a>
          ))}
        </div>
      </div>
    );
  }

  // 4+ images — 2×2 grid, square cells, +N overlay on last visible
  const show = urls.slice(0, 4);
  const extra = urls.length - 4;
  return (
    <div className="grid grid-cols-2 gap-0.5 overflow-hidden">
      {show.map((url, i) => (
        <a
          key={url}
          href={urls[i]!}
          target="_blank"
          rel="noreferrer"
          className="relative block aspect-square overflow-hidden"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={url} alt="" className="h-full w-full object-cover" />
          {i === 3 && extra > 0 && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/50 text-2xl font-bold text-white">
              +{extra}
            </div>
          )}
        </a>
      ))}
    </div>
  );
}

/* ── Post card (center column) ────────────────────────────────────────── */

function SWallPostCard({
  post,
  viewerEmail,
  onReact,
  onDelete,
  inFlight,
}: {
  post: EnrichedPost;
  viewerEmail: string;
  onReact: (postId: string, emoji: string, currentlyReacted: boolean) => void;
  onDelete: (postId: string) => void;
  inFlight: ReadonlySet<string>;
}) {
  const [showComments, setShowComments] = useState(false);
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const hidePickerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isAuthor = post.author_email.toLowerCase() === viewerEmail;

  const totalReactions = Object.values(post.reaction_counts).reduce((a, b) => a + b, 0);

  const showPicker = () => {
    if (hidePickerTimer.current) clearTimeout(hidePickerTimer.current);
    setEmojiPickerOpen(true);
  };
  const hidePicker = () => {
    hidePickerTimer.current = setTimeout(() => setEmojiPickerOpen(false), 320);
  };

  const handle = (post.author_email.split('@')[0] ?? '').toLowerCase();

  return (
    <article className="overflow-hidden rounded-2xl border border-zinc-200/80 bg-white transition-colors hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:border-zinc-700">
      {/* Twitter-style header: avatar on left, name · @handle · time inline */}
      <div className="flex items-start gap-3 px-4 pt-3.5">
        <SwallAvatar email={post.author_email} name={post.author_name} size={40} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[14px] font-bold text-zinc-900 dark:text-white">
              {displayName(post.author_email, post.author_name)}
            </span>
            <span className="truncate text-[13px] text-zinc-500 dark:text-zinc-500">
              @{handle}
            </span>
            <span className="text-zinc-400 dark:text-zinc-600">·</span>
            <span className="shrink-0 text-[13px] text-zinc-500 dark:text-zinc-500" title={new Date(post.created_at).toLocaleString()}>
              {timeAgo(post.created_at)}
            </span>
            <div className="ml-auto flex shrink-0 items-center gap-1">
              {post.source_label && (
                <span className="rounded-full bg-zinc-100 px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-wider text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                  {post.source_label}
                </span>
              )}
              {isAuthor && (
                <button
                  type="button"
                  onClick={() => onDelete(post.id)}
                  className="rounded-full p-1 text-zinc-400 transition-colors hover:bg-rose-50 hover:text-rose-500 dark:text-zinc-600 dark:hover:bg-rose-950/40 dark:hover:text-rose-400"
                  title="Delete post"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>

          {/* Body — sits aligned with the name, like Twitter */}
          {post.body && (
            <p className="mt-1 text-[14.5px] leading-[1.45] text-zinc-800 dark:text-zinc-200">
              {renderBody(post.body)}
            </p>
          )}
        </div>
      </div>

      {/* Image grid — edge-to-edge, rounded matching card */}
      {post.image_urls?.length > 0 && (
        <div className="mt-3 overflow-hidden">
          <PostImageGrid urls={post.image_urls} />
        </div>
      )}

      {/* Reaction summary — tiny inline strip above the action row */}
      {totalReactions > 0 && (
        <div className="flex items-center gap-1.5 px-4 pt-3">
          <div className="flex -space-x-1">
            {(SWALL_EMOJIS as readonly string[])
              .filter((e) => (post.reaction_counts[e] ?? 0) > 0)
              .sort((a, b) => (post.reaction_counts[b] ?? 0) - (post.reaction_counts[a] ?? 0))
              .slice(0, 3)
              .map((e) => (
                <span
                  key={e}
                  className="flex h-[18px] w-[18px] items-center justify-center rounded-full bg-white shadow-[0_0_0_1.5px_rgba(0,0,0,0.06)] dark:bg-zinc-900 dark:shadow-[0_0_0_1.5px_rgba(255,255,255,0.08)]"
                >
                  <EmEmoji native={e} size="12" />
                </span>
              ))}
          </div>
          <span className="text-[12px] tabular-nums text-zinc-500 dark:text-zinc-400">
            {totalReactions}
          </span>
        </div>
      )}

      {/* Twitter-style action row — flat icons, generous spacing, no internal dividers */}
      <div className="flex items-center gap-1 px-3 pt-2 pb-2.5">
        {/* Like — picker floats above on hover */}
        <div className="relative">
          <AnimatePresence>
            {emojiPickerOpen && (
              <motion.div
                initial={{ opacity: 0, scale: 0.7, y: 10 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.7, y: 10 }}
                transition={{ type: 'spring', stiffness: 420, damping: 22 }}
                onMouseEnter={showPicker}
                onMouseLeave={hidePicker}
                className="absolute bottom-full left-0 z-20 mb-2 origin-bottom-left"
              >
                <div className="flex items-end gap-1 rounded-full border border-zinc-200 bg-white px-3 py-2 shadow-xl dark:border-zinc-700 dark:bg-zinc-900">
                  {SWALL_EMOJIS.map((emoji) => {
                    const reacted = post.my_reactions.includes(emoji);
                    const pending = inFlight.has(`${post.id}:${emoji}`);
                    return (
                      <motion.button
                        key={emoji}
                        type="button"
                        disabled={pending}
                        title={REACTION_NAMES[emoji]}
                        onClick={() => onReact(post.id, emoji, reacted)}
                        animate={reacted ? { y: -4, scale: 1.2 } : { y: 0, scale: 1 }}
                        whileHover={{ y: -12, scale: 1.5 }}
                        transition={{ type: 'spring', stiffness: 380, damping: 18 }}
                        className={cn(
                          'leading-none',
                          pending ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
                        )}
                      >
                        <EmEmoji native={emoji} size="28" />
                      </motion.button>
                    );
                  })}
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <button
            type="button"
            onMouseEnter={showPicker}
            onMouseLeave={hidePicker}
            onClick={() => {
              const primary = post.my_reactions[0] ?? '👍';
              onReact(post.id, primary, post.my_reactions.includes(primary));
            }}
            className={cn(
              'group/btn flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12.5px] font-medium transition-colors duration-200 active:scale-95',
              post.my_reactions.length > 0
                ? 'text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/30'
                : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-800/70 dark:hover:text-zinc-200',
            )}
          >
            {post.my_reactions.length > 0 ? (
              <span className="transition-transform duration-200 group-hover/btn:scale-125 group-active/btn:scale-90">
                <EmEmoji native={post.my_reactions[0]!} size="16" />
              </span>
            ) : (
              <ThumbsUp className="h-3.5 w-3.5 transition-transform duration-200 ease-[cubic-bezier(0.34,1.56,0.64,1)] group-hover/btn:-rotate-12 group-hover/btn:scale-110" />
            )}
            <span className="tabular-nums">
              {totalReactions > 0 ? totalReactions : 'Like'}
            </span>
          </button>
        </div>

        {/* Comment */}
        <button
          type="button"
          onClick={() => setShowComments((v) => !v)}
          className={cn(
            'group/btn flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12.5px] font-medium transition-colors',
            showComments
              ? 'text-violet-600 dark:text-violet-400'
              : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-800/70 dark:hover:text-zinc-200',
          )}
        >
          <MessageCircle className="h-3.5 w-3.5 transition-transform group-hover/btn:scale-110" />
          <span className="tabular-nums">
            {post.comment_count > 0 ? post.comment_count : 'Reply'}
          </span>
        </button>
      </div>

      {showComments && <CommentSection postId={post.id} viewerEmail={viewerEmail} />}
    </article>
  );
}

/* ── Comment section ──────────────────────────────────────────────────── */

function CommentSection({ postId, viewerEmail }: { postId: string; viewerEmail: string }) {
  const [comments, setComments] = useState<SwallComment[]>([]);
  const [loading, setLoading] = useState(true);
  const [body, setBody] = useState('');
  const [posting, setPosting] = useState(false);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/swall/comments?post_id=${encodeURIComponent(postId)}`, { cache: 'no-store' });
        const json = (await res.json()) as { comments?: SwallComment[]; error?: string };
        if (!json.error) setComments(json.comments ?? []);
      } finally {
        setLoading(false);
      }
    })();
  }, [postId]);

  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const channel = supabase
      .channel(`swall-comments-${postId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'swall_comments', filter: `post_id=eq.${postId}` },
        (payload) => { setComments((prev) => [...prev, payload.new as SwallComment]); })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'swall_comments', filter: `post_id=eq.${postId}` },
        (payload) => { setComments((prev) => prev.filter((c) => c.id !== payload.old.id)); })
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [postId]);

  const handleSubmit = async () => {
    if (!body.trim() || posting) return;
    setPosting(true);
    try {
      const res = await fetch('/api/swall/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ post_id: postId, body: body.trim() }),
      });
      const json = (await res.json()) as { error?: string };
      if (json.error) throw new Error(json.error);
      setBody('');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Comment failed');
    } finally {
      setPosting(false);
    }
  };

  const handleDeleteComment = async (id: string) => {
    try {
      await fetch(`/api/swall/comments/${id}`, { method: 'DELETE' });
    } catch {
      toast.error('Delete failed');
    }
  };

  return (
    <div className="border-t border-[#ececec] bg-[#fafaf8] px-4 pb-3 pt-3 dark:border-zinc-800 dark:bg-zinc-900/40">
      {loading ? (
        <div className="flex justify-center py-2">
          <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />
        </div>
      ) : (
        <>
          {comments.length === 0 && (
            <p className="mb-2 text-center text-[11px] text-zinc-400 dark:text-zinc-600">
              No comments yet — be the first.
            </p>
          )}
          {comments.length > 0 && (
            <div className="mb-3 space-y-2.5">
              {comments.map((c) => {
                const isOwn = c.author_email.toLowerCase() === viewerEmail;
                return (
                  <div key={c.id} className="group/comment flex items-start gap-2">
                    <SwallAvatar email={c.author_email} name={c.author_name} size={24} />
                    <div className="min-w-0 flex-1 rounded-xl bg-white px-3 py-2 text-[12px] dark:bg-zinc-950">
                      <p className="font-semibold text-zinc-900 dark:text-zinc-100">
                        {displayName(c.author_email, c.author_name)}
                        <span className="ml-2 font-normal text-zinc-400 dark:text-zinc-600">
                          {timeAgo(c.created_at)}
                        </span>
                      </p>
                      <p className="mt-0.5 leading-relaxed text-zinc-700 dark:text-zinc-300">{c.body}</p>
                    </div>
                    {isOwn && (
                      <button
                        type="button"
                        onClick={() => handleDeleteComment(c.id)}
                        className="mt-1 rounded p-0.5 text-zinc-300 opacity-0 transition-all hover:text-rose-500 group-hover/comment:opacity-100 dark:text-zinc-700"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      <div className="flex items-center gap-2">
        <SwallAvatar email={viewerEmail} name={null} size={24} />
        <input
          type="text"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void handleSubmit(); }}
          placeholder="Write a comment…"
          className="h-8 flex-1 rounded-full border border-[#ececec] bg-white px-3 text-[12px] placeholder:text-zinc-400 focus:border-violet-300 focus:outline-none focus:ring-1 focus:ring-violet-200 dark:border-zinc-700 dark:bg-zinc-950 dark:placeholder:text-zinc-600 dark:focus:border-violet-700"
        />
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!body.trim() || posting}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-violet-600 to-indigo-700 text-white shadow-sm disabled:opacity-40"
        >
          {posting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3 w-3" />}
        </button>
      </div>
    </div>
  );
}
