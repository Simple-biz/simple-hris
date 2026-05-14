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
    <div className="flex h-full min-h-0 flex-col">
      {/* ── Sticky header ── */}
      <div className="shrink-0 border-b border-[#ececec] bg-white px-4 py-3 sm:px-6 sm:py-4 dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex items-center gap-2.5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/favicon2.png" alt="Simple" className="h-8 w-8 shrink-0 object-contain" />
          <div>
            <h1 className="flex items-center gap-1.5 text-base font-semibold tracking-tight text-zinc-900 dark:text-white">
              <span className="text-violet-600 dark:text-violet-400">S</span>
              <span className="text-zinc-300 dark:text-zinc-600">·</span>
              <span>Wall</span>
              <span className="ml-1 rounded-full border border-violet-200 bg-violet-50 px-1.5 py-px text-[9px] font-semibold uppercase tracking-[0.14em] text-violet-700 dark:border-violet-900/40 dark:bg-violet-950/30 dark:text-violet-300">
                Simple Wall
              </span>
            </h1>
            <p className="text-[11px] text-zinc-500 dark:text-zinc-500">
              Company policies · CEO announcements · team social feed
            </p>
          </div>
        </div>
      </div>

      {/* ── 3-column scrollable body ── */}
      <div className="min-h-0 flex-1 overflow-y-auto bg-[#fafaf8] dark:bg-[#0d1117]">
        <div className="w-full px-3 py-5 sm:px-5 lg:px-6">
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-[200px_1fr_220px] lg:items-start">

            {/* ── LEFT — Company Policies ── */}
            <aside className="order-3 lg:order-1 lg:sticky lg:top-5">
              <CompanyPoliciesPanel />
            </aside>

            {/* ── CENTER — Wall ── */}
            <main className="order-1 min-w-0 space-y-3.5 lg:order-2">
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
                <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-[#ececec] py-14 text-center dark:border-zinc-800">
                  <WifiOff className="h-7 w-7 text-zinc-300 dark:text-zinc-700" />
                  <p className="text-sm text-zinc-500">{error}</p>
                </div>
              ) : posts.length === 0 ? (
                <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-[#ececec] py-16 text-center dark:border-zinc-800">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-100 text-violet-400 dark:bg-violet-950/40">
                    <span className="text-lg font-bold">S</span>
                  </div>
                  <p className="text-sm font-medium text-zinc-500">The wall is quiet</p>
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

            {/* ── RIGHT — CEO Announcements ── */}
            <aside className="order-2 lg:order-3 lg:sticky lg:top-5">
              <CEOAnnouncementsPanel announcements={announcements} loading={loading} />
            </aside>
          </div>
        </div>
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
    <div className="overflow-hidden rounded-2xl border border-indigo-100/80 bg-white shadow-sm dark:border-indigo-900/30 dark:bg-zinc-950">
      {/* Panel header */}
      <div className="flex items-center gap-2 border-b border-indigo-100/60 bg-gradient-to-br from-indigo-50 to-violet-50/60 px-3.5 py-3 dark:border-indigo-900/30 dark:from-indigo-950/40 dark:to-violet-950/30">
        <div className="flex h-6 w-6 items-center justify-center rounded-md bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-sm">
          <Pin className="h-3 w-3" />
        </div>
        <h2 className="text-[12.5px] font-bold tracking-tight text-indigo-900 dark:text-indigo-100">
          Company Policies
        </h2>
      </div>

      {/* Sections */}
      <div className="divide-y divide-indigo-100/60 dark:divide-indigo-900/30">
        {POLICY_SECTIONS.map((section) => {
          const isOpen = openSections.has(section.id);
          return (
            <div key={section.id}>
              {/* Section toggle */}
              <button
                type="button"
                onClick={() => toggle(section.id)}
                className="flex w-full items-center justify-between px-3.5 py-2.5 text-left transition-colors hover:bg-indigo-50/50 dark:hover:bg-indigo-950/20"
              >
                <span className="text-[11.5px] font-semibold text-zinc-700 dark:text-zinc-300">
                  {section.label}
                </span>
                <ChevronDown
                  className={cn(
                    'h-3.5 w-3.5 shrink-0 text-zinc-400 transition-transform duration-200',
                    isOpen && 'rotate-180',
                  )}
                />
              </button>

              {/* Policy rows — animated */}
              <div
                className={cn(
                  'grid transition-[grid-template-rows] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]',
                  isOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
                )}
              >
                <div className="overflow-hidden">
                  <div
                    className={cn(
                      'divide-y divide-indigo-50 transition-opacity duration-200 ease-in-out dark:divide-indigo-950/40',
                      isOpen ? 'opacity-100 delay-100' : 'opacity-0 delay-0',
                    )}
                  >
                    {section.policies.map((policy) => {
                      const Icon = policy.icon;
                      return (
                        <div key={policy.title} className="flex items-start gap-2.5 bg-indigo-50/30 px-3.5 py-2.5 dark:bg-indigo-950/10">
                          <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-indigo-100 text-indigo-500 dark:bg-indigo-950/60 dark:text-indigo-400">
                            <Icon className="h-3 w-3" />
                          </div>
                          <div className="min-w-0">
                            <p className="text-[11.5px] font-semibold leading-snug text-zinc-800 dark:text-zinc-200">
                              {policy.title}
                            </p>
                            <p className="mt-0.5 text-[11px] leading-snug text-zinc-500 dark:text-zinc-500">
                              {policy.body}
                            </p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="border-t border-indigo-100/60 bg-indigo-50/20 px-3.5 py-2.5 dark:border-indigo-900/30 dark:bg-indigo-950/10">
        <p className="text-[10.5px] leading-relaxed text-zinc-500 dark:text-zinc-500">
          Questions? Ask your manager before acting — it's always better to ask early.
        </p>
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
    <div className="overflow-hidden rounded-2xl border border-[#ececec] bg-white dark:border-zinc-800 dark:bg-zinc-950">
      {/* Header */}
      <div className="flex items-center gap-3 p-4 pb-3">
        <Shimmer className="h-9 w-9 shrink-0 rounded-full" />
        <div className="flex-1 space-y-1.5">
          <Shimmer className="h-3 w-28" />
          <Shimmer className="h-2.5 w-16" />
        </div>
      </div>
      {/* Body lines */}
      <div className="space-y-2 px-4 pb-4">
        <Shimmer className="h-3 w-full" />
        <Shimmer className="h-3 w-5/6" />
        <Shimmer className="h-3 w-3/4" />
      </div>
      {/* Divider */}
      <div className="mx-4 border-t border-[#ececec] dark:border-zinc-800" />
      {/* Action row */}
      <div className="flex items-center gap-3 px-4 py-3">
        <Shimmer className="h-5 w-14" />
        <Shimmer className="h-5 w-20" />
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
    <div className="divide-y divide-amber-100/50 dark:divide-amber-900/20">
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
    <div className="overflow-hidden rounded-2xl border border-amber-100/80 bg-white shadow-sm dark:border-amber-900/30 dark:bg-zinc-950">
      {/* Panel header */}
      <div className="flex items-center gap-2 border-b border-amber-100/60 bg-gradient-to-br from-amber-50 to-orange-50/60 px-3.5 py-3 dark:border-amber-900/30 dark:from-amber-950/40 dark:to-orange-950/20">
        <div className="flex h-6 w-6 items-center justify-center rounded-md bg-gradient-to-br from-amber-500 to-orange-500 text-white shadow-sm shadow-amber-500/25">
          <Megaphone className="h-3 w-3" />
        </div>
        <h2 className="text-[12.5px] font-bold tracking-tight text-amber-900 dark:text-amber-100">
          CEO's Announcements
        </h2>
      </div>

      {/* Announcement list */}
      <div className="divide-y divide-amber-100/50 dark:divide-amber-900/20">
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
      <p className="text-[11.5px] leading-relaxed text-zinc-600 dark:text-zinc-400">
        {preview}
      </p>
      {isLong && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 text-[11px] font-medium text-amber-600 hover:underline dark:text-amber-400"
        >
          {expanded ? 'Show less' : 'Read more'}
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

  return (
    <div className="overflow-hidden rounded-2xl border border-[#ececec] bg-white shadow-[0_2px_12px_-6px_rgba(0,0,0,0.06)] dark:border-zinc-800 dark:bg-zinc-950">
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => { if (e.target.files) addImages(e.target.files); e.target.value = ''; }}
      />

      <div className="flex items-start gap-3 p-4">
        <SwallAvatar email={viewerEmail} name={viewerName} size={36} className="mt-0.5 shrink-0" />
        <div className="relative min-w-0 flex-1">
          {!isExpanded ? (
            <button
              type="button"
              onClick={() => { setFocused(true); setTimeout(() => textareaRef.current?.focus(), 0); }}
              className="w-full rounded-xl border border-[#ececec] bg-[#fafaf8] px-3 py-2 text-left text-[13px] text-zinc-400 transition-colors hover:border-violet-200 hover:bg-violet-50/30 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-600 dark:hover:border-violet-800"
            >
              Share something with the company…
            </button>
          ) : (
            <>
              <div className="relative">
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

              {/* @mention dropdown */}
              {mentionQuery !== null && mentionMatches.length > 0 && (
                <div className="absolute left-0 top-full z-50 mt-1 w-72 max-h-64 overflow-y-auto overflow-x-hidden rounded-xl border border-[#ececec] bg-white shadow-xl dark:border-zinc-700 dark:bg-zinc-900">
                  {mentionMatches.map((profile, i) => (
                    <button
                      key={profile.work_email}
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        insertMention(profile);
                      }}
                      className={cn(
                        'flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors',
                        i === mentionDropdownIdx
                          ? 'bg-violet-50 dark:bg-violet-950/30'
                          : 'hover:bg-zinc-50 dark:hover:bg-zinc-800',
                      )}
                    >
                      <SwallAvatar email={profile.work_email} name={profile.name} size={28} />
                      <div className="min-w-0">
                        <p className="truncate text-[12px] font-semibold text-zinc-900 dark:text-zinc-100">
                          {profile.name ?? profile.work_email.split('@')[0]}
                        </p>
                        <p className="truncate text-[10px] text-zinc-400 dark:text-zinc-500">
                          {profile.work_email}
                        </p>
                      </div>
                    </button>
                  ))}
                </div>
              )}
              </div>

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

  return (
    <article className="overflow-hidden rounded-2xl border border-[#ececec] bg-white shadow-[0_2px_12px_-6px_rgba(0,0,0,0.06)] transition-shadow hover:shadow-md dark:border-zinc-800 dark:bg-zinc-950">
      {/* Header */}
      <div className="flex items-start gap-3 p-4 pb-3">
        <SwallAvatar email={post.author_email} name={post.author_name} size={36} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-semibold text-zinc-900 dark:text-white">
                {displayName(post.author_email, post.author_name)}
              </p>
              <p className="text-[10px] text-zinc-400 dark:text-zinc-600">{timeAgo(post.created_at)}</p>
            </div>
            {post.source_label && (
              <span className="ml-auto shrink-0 rounded-full border border-violet-200/70 bg-violet-50 px-2 py-px text-[9px] font-semibold uppercase tracking-[0.12em] text-violet-700 dark:border-violet-800/40 dark:bg-violet-950/30 dark:text-violet-300">
                {post.source_label}
              </span>
            )}
            {isAuthor && (
              <button
                type="button"
                onClick={() => onDelete(post.id)}
                className="shrink-0 rounded-md p-1 text-zinc-400 transition-all hover:bg-rose-50 hover:text-rose-500 dark:text-zinc-600 dark:hover:bg-rose-950/30 dark:hover:text-rose-400"
                title="Delete post"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Body */}
      {post.body && (
        <p className="px-4 pb-3 text-[13.5px] leading-relaxed text-zinc-700 dark:text-zinc-300">
          {renderBody(post.body)}
        </p>
      )}

      {/* Image grid — edge-to-edge, no horizontal padding (article has overflow-hidden) */}
      {post.image_urls?.length > 0 && (
        <div className="mt-1 mb-1">
          <PostImageGrid urls={post.image_urls} />
        </div>
      )}

      {/* Reaction summary — emoji bubbles + total count */}
      {totalReactions > 0 && (
        <div className="flex items-center gap-1.5 px-4 pt-2.5 pb-0.5">
          <div className="flex -space-x-1">
            {(SWALL_EMOJIS as readonly string[])
              .filter((e) => (post.reaction_counts[e] ?? 0) > 0)
              .sort((a, b) => (post.reaction_counts[b] ?? 0) - (post.reaction_counts[a] ?? 0))
              .slice(0, 3)
              .map((e) => (
                <span
                  key={e}
                  className="flex h-[20px] w-[20px] items-center justify-center rounded-full bg-white shadow-[0_0_0_1.5px_rgba(0,0,0,0.07)] dark:bg-zinc-900 dark:shadow-[0_0_0_1.5px_rgba(255,255,255,0.07)]"
                >
                  <EmEmoji native={e} size="13" />
                </span>
              ))}
          </div>
          <span className="text-[12px] text-zinc-500 dark:text-zinc-400">{totalReactions}</span>
        </div>
      )}

      {/* Divider */}
      <div className="mx-4 border-t border-[#ececec] dark:border-zinc-800" />

      {/* Action row — Like (floating picker on hover) + Comment */}
      <div className="flex items-stretch">
        {/* Like button — picker floats above it, centered */}
        <div className="relative flex flex-1">
          <AnimatePresence>
            {emojiPickerOpen && (
              <motion.div
                initial={{ opacity: 0, scale: 0.7, y: 10 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.7, y: 10 }}
                transition={{ type: 'spring', stiffness: 420, damping: 22 }}
                onMouseEnter={showPicker}
                onMouseLeave={hidePicker}
                className="absolute bottom-full left-1/2 z-20 mb-2 -translate-x-1/2 origin-bottom"
              >
                <div className="flex items-end gap-1 rounded-full border border-[#ececec] bg-white px-3 py-2 shadow-xl dark:border-zinc-700 dark:bg-zinc-900">
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
                        <EmEmoji native={emoji} size="30" />
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
              'flex w-full items-center justify-center gap-1.5 py-2.5 text-[13px] font-semibold transition-colors',
              'hover:bg-zinc-50 dark:hover:bg-zinc-800/60',
              post.my_reactions.length > 0
                ? 'text-blue-600 dark:text-blue-400'
                : 'text-zinc-500 dark:text-zinc-400',
            )}
          >
            {post.my_reactions.length > 0 ? (
              <>
                <EmEmoji native={post.my_reactions[0]!} size="18" />
                <span>{REACTION_NAMES[post.my_reactions[0]!] ?? 'Like'}</span>
              </>
            ) : (
              <>
                <ThumbsUp className="h-4 w-4" />
                <span>Like</span>
              </>
            )}
          </button>
        </div>

        <div className="w-px bg-[#ececec] dark:bg-zinc-800" />

        <button
          type="button"
          onClick={() => setShowComments((v) => !v)}
          className={cn(
            'flex flex-1 items-center justify-center gap-1.5 py-2.5 text-[13px] font-semibold transition-colors',
            'hover:bg-zinc-50 dark:hover:bg-zinc-800/60',
            showComments
              ? 'text-violet-600 dark:text-violet-400'
              : 'text-zinc-500 dark:text-zinc-400',
          )}
        >
          <MessageCircle className="h-4 w-4" />
          <span>Comment{post.comment_count > 0 ? ` · ${post.comment_count}` : ''}</span>
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
