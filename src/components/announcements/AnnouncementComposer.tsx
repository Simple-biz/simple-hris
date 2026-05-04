'use client';

import { useState } from 'react';
import { Globe, LayoutList, Loader2, Send } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

interface AnnouncementComposerProps {
  /** Author's session email */
  authorEmail: string;
  /**
   * Which scopes this author is allowed to post to.
   * - 'general'    → show the General tab
   * - string[]     → list of departments this author can post to
   */
  allowGeneral: boolean;
  /** Departments this author manages (empty = only general posting allowed). */
  departments: string[];
  /** Whether the author is admin/CEO (can pin). */
  canPin?: boolean;
  className?: string;
}

type ScopeTab = 'general' | string; // 'general' or a department name

export default function AnnouncementComposer({
  allowGeneral,
  departments,
  canPin = false,
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

  if (tabs.length === 0) return null;

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
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Post failed');
    } finally {
      setPosting(false);
    }
  };

  return (
    <div
      className={cn(
        'rounded-2xl border border-[#ececec] bg-white shadow-[0_2px_12px_-6px_rgba(0,0,0,0.06)] dark:border-zinc-800 dark:bg-zinc-950',
        className,
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[#ececec] px-4 py-3 dark:border-zinc-800">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-orange-500 to-rose-500 text-white shadow-sm">
            <Send className="h-3.5 w-3.5" />
          </div>
          <h2 className="text-[13px] font-semibold text-zinc-900 dark:text-white">
            Post announcement
          </h2>
        </div>
      </div>

      {/* Scope tabs — only show when there's more than one option */}
      {tabs.length > 1 && (
        <div className="flex gap-1 border-b border-[#ececec] px-4 pt-3 dark:border-zinc-800">
          {tabs.map((tab) => {
            const isGeneral = tab === 'general';
            const Icon = isGeneral ? Globe : LayoutList;
            return (
              <button
                key={tab}
                type="button"
                onClick={() => setActiveTab(tab)}
                className={cn(
                  'mb-[-1px] flex items-center gap-1.5 rounded-t-lg border border-b-0 px-3 py-1.5 text-[11px] font-semibold transition-colors',
                  activeTab === tab
                    ? 'border-[#ececec] bg-white text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-white'
                    : 'border-transparent text-zinc-500 hover:text-zinc-700 dark:text-zinc-500 dark:hover:text-zinc-300',
                )}
              >
                <Icon className="h-3 w-3" />
                {isGeneral ? 'General' : tab}
              </button>
            );
          })}
        </div>
      )}

      {/* Compose area */}
      <div className="space-y-3 p-4">
        {/* Audience hint */}
        <p className="text-[10.5px] text-zinc-500 dark:text-zinc-500">
          {activeTab === 'general'
            ? 'This will be visible to everyone in the company.'
            : `This will be visible to ${activeTab} team members.`}
        </p>

        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Announcement title…"
          maxLength={120}
          className="w-full rounded-xl border border-[#ececec] bg-[#fafaf8] px-3 py-2 text-[13px] font-semibold placeholder:font-normal placeholder:text-zinc-400 focus:border-orange-300 focus:outline-none focus:ring-1 focus:ring-orange-200 dark:border-zinc-800 dark:bg-zinc-900 dark:placeholder:text-zinc-600 dark:focus:border-orange-700 dark:focus:ring-orange-900/40"
        />

        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Write your announcement…"
          rows={4}
          maxLength={2000}
          className="w-full resize-none rounded-xl border border-[#ececec] bg-[#fafaf8] px-3 py-2 text-[12.5px] leading-relaxed placeholder:text-zinc-400 focus:border-orange-300 focus:outline-none focus:ring-1 focus:ring-orange-200 dark:border-zinc-800 dark:bg-zinc-900 dark:placeholder:text-zinc-600 dark:focus:border-orange-700 dark:focus:ring-orange-900/40"
        />

        <div className="flex items-center justify-between gap-3">
          {canPin ? (
            <label className="flex cursor-pointer items-center gap-2 text-[11px] text-zinc-600 dark:text-zinc-400">
              <input
                type="checkbox"
                checked={pinned}
                onChange={(e) => setPinned(e.target.checked)}
                className="h-3.5 w-3.5 rounded accent-orange-500"
              />
              Pin to top
            </label>
          ) : (
            <span />
          )}

          <Button
            size="sm"
            onClick={handlePost}
            disabled={posting || !title.trim() || !body.trim()}
            className="h-8 gap-1.5 bg-gradient-to-br from-orange-500 to-rose-500 px-4 text-[12px] font-semibold text-white shadow-sm shadow-orange-500/30 hover:from-orange-600 hover:to-rose-600 disabled:opacity-50"
          >
            {posting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Send className="h-3.5 w-3.5" />
            )}
            Post
          </Button>
        </div>
      </div>
    </div>
  );
}
