'use client';

import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Globe, Loader2, PenLine, Send, Users } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

interface AnnouncementComposerProps {
  /** Author's session email */
  authorEmail: string;
  /**
   * Which scopes this author is allowed to post to.
   * - 'general'    -> show the General tab
   * - string[]     -> list of departments this author can post to
   */
  allowGeneral: boolean;
  /** Departments this author manages (empty = only general posting allowed). */
  departments: string[];
  /** Whether the author is admin/CEO (can pin). */
  canPin?: boolean;
  /**
   * Who the post is attributed to, shown in the header as
   * "NEW ANNOUNCEMENT - as {authorLabel}" for general posts. Department posts
   * instead read "as {Department}". e.g. pass "HR" on the HR dashboard.
   */
  authorLabel?: string;
  className?: string;
}

type ScopeTab = 'general' | string; // 'general' or a department name

const TITLE_MAX = 120;
const BODY_MAX = 2000;

export default function AnnouncementComposer({
  allowGeneral,
  departments,
  canPin = false,
  authorLabel,
  className,
}: AnnouncementComposerProps) {
  const tabs: ScopeTab[] = [
    ...(allowGeneral ? ['general' as const] : []),
    ...departments,
  ];

  const [activeTab, setActiveTab] = useState<ScopeTab>(tabs[0] ?? 'general');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [pinned, setPinned] = useState(false);
  const [posting, setPosting] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);

  // Focus the title once the reveal starts so typing flows straight in.
  useEffect(() => {
    if (!expanded) return;
    const id = requestAnimationFrame(() => titleRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [expanded]);

  if (tabs.length === 0) return null;

  const canSubmit = !!title.trim() && !!body.trim() && !posting;

  // "as X": the target department when posting to one, else the author label.
  const postingAs = activeTab === 'general' ? authorLabel ?? null : activeTab;

  const collapseIfEmpty = () => {
    if (!title.trim() && !body.trim() && !posting) {
      setExpanded(false);
      setPinned(false);
    }
  };

  // Collapse back to the resting state when focus leaves the whole composer
  // and nothing has been typed yet.
  const handleBlurCapture = (e: React.FocusEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) collapseIfEmpty();
  };

  const cancel = () => {
    setTitle('');
    setBody('');
    setPinned(false);
    setExpanded(false);
  };

  const handlePost = async () => {
    if (!title.trim() || !body.trim()) {
      toast.error('Title and message are required');
      return;
    }
    setPosting(true);
    try {
      const scope = activeTab === 'general' ? 'general' : 'department';
      const department = scope === 'department' ? activeTab : undefined;

      const res = await fetch('/api/announcements', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title.trim(), body: body.trim(), scope, department, pinned }),
      });
      const json = (await res.json()) as { error?: string };
      if (json.error) throw new Error(json.error);

      toast.success('Announcement posted');
      setTitle('');
      setBody('');
      setPinned(false);
      setExpanded(false); // settle back to the resting trigger
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Post failed');
    } finally {
      setPosting(false);
    }
  };

  return (
    <div
      onBlur={handleBlurCapture}
      className={cn(
        'overflow-hidden rounded-xl border border-zinc-200/80 bg-white transition-colors dark:border-zinc-800/80 dark:bg-zinc-900/40',
        expanded && 'border-zinc-300 dark:border-zinc-700',
        className,
      )}
    >
      {/* Header + scope selector */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 pt-3.5">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-zinc-400 dark:text-zinc-500">
          New announcement
          {postingAs && (
            <span className="text-zinc-400 dark:text-zinc-500">
              {' - as '}
              <span className="text-zinc-600 dark:text-zinc-300">{postingAs}</span>
            </span>
          )}
        </h2>

        {expanded && tabs.length > 1 && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex items-center gap-1 rounded-lg bg-zinc-100 p-0.5 dark:bg-zinc-800/70"
          >
            {tabs.map((tab) => {
              const isGeneral = tab === 'general';
              const Icon = isGeneral ? Globe : Users;
              const active = activeTab === tab;
              return (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setActiveTab(tab)}
                  className={cn(
                    'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors',
                    active
                      ? 'bg-white text-zinc-900 shadow-sm dark:bg-zinc-700 dark:text-white'
                      : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200',
                  )}
                >
                  <Icon className="h-3 w-3" strokeWidth={2} />
                  {isGeneral ? 'General' : tab}
                </button>
              );
            })}
          </motion.div>
        )}
      </div>

      {/* Resting trigger — clicking reveals the fields */}
      {!expanded && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="group flex w-full items-center gap-2.5 px-4 pb-4 pt-2.5 text-left text-[14px] text-zinc-400 transition-colors hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300"
        >
          <PenLine className="h-4 w-4 shrink-0 transition-transform group-hover:-rotate-6" strokeWidth={1.75} />
          Share something with the team...
        </button>
      )}

      {/* Expandable compose area */}
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            key="composer-body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-4 pt-2.5">
              <p className="mb-3 text-[11px] text-zinc-400 dark:text-zinc-500">
                {activeTab === 'general'
                  ? 'Visible to everyone in the company.'
                  : `Visible to the ${activeTab} team.`}
              </p>

              <input
                ref={titleRef}
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Title"
                maxLength={TITLE_MAX}
                className="w-full border-0 border-b border-zinc-200/80 bg-transparent px-0 pb-2.5 pt-0 text-[16px] font-semibold tracking-tight text-zinc-900 transition-colors placeholder:font-normal placeholder:text-zinc-300 focus:border-zinc-400 focus:outline-none focus:ring-0 dark:border-zinc-700/70 dark:text-white dark:placeholder:text-zinc-600 dark:focus:border-zinc-500"
              />

              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="Write a message..."
                rows={3}
                maxLength={BODY_MAX}
                className="mt-3 w-full resize-none border-0 border-b border-zinc-200/80 bg-transparent px-0 pb-3 pt-0 text-[13px] leading-relaxed text-zinc-700 transition-colors placeholder:text-zinc-300 focus:border-zinc-400 focus:outline-none focus:ring-0 dark:border-zinc-700/70 dark:text-zinc-200 dark:placeholder:text-zinc-600 dark:focus:border-zinc-500"
              />
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between gap-3 px-4 pb-3 pt-1">
              <div className="flex items-center gap-3">
                {canPin && (
                  <label className="flex cursor-pointer select-none items-center gap-2 text-[11px] text-zinc-500 dark:text-zinc-400">
                    <input
                      type="checkbox"
                      checked={pinned}
                      onChange={(e) => setPinned(e.target.checked)}
                      className="h-3.5 w-3.5 rounded accent-zinc-700 dark:accent-zinc-300"
                    />
                    Pin to top
                  </label>
                )}
                <span className="text-[10.5px] tabular-nums text-zinc-300 dark:text-zinc-600">
                  {body.length}/{BODY_MAX}
                </span>
              </div>

              <div className="flex items-center gap-1.5">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={cancel}
                  disabled={posting}
                  className="h-8 px-3 text-[12px] font-medium text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={handlePost}
                  disabled={!canSubmit}
                  className="h-8 gap-1.5 rounded-lg bg-zinc-900 px-4 text-[12px] font-semibold text-white transition-colors hover:bg-zinc-800 disabled:opacity-40 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
                >
                  {posting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                  Post
                </Button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
