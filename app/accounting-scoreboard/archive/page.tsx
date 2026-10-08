import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { resolveAccess } from '@/lib/accounting-scoreboard/server';
import { readArchive } from '@/lib/accounting-scoreboard/archive-server';
import { SCOREBOARD_PAGE } from '@/lib/accounting-scoreboard/host';
import ArchivePanel from '@/components/accounting-scoreboard/ArchivePanel';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Scoreboard archive',
  description: "Carla's older scoreboard history, kept exactly as typed.",
};

const ARCHIVE_PAGE = `${SCOREBOARD_PAGE}/archive`;

/**
 * /accounting-scoreboard/archive — also served on ACCOUNTING_SCOREBOARD_HOST, because host.ts passes
 * everything under /accounting-scoreboard.
 * Governing doc: docs/features/accounting-scoreboard-backfill.md.
 *
 * Gated exactly like the board (app/accounting-scoreboard/page.tsx): the board's member list, checked
 * here before anything renders. Read-only, server-rendered, no API route.
 */
export default async function AccountingScoreboardArchivePage() {
  const access = await resolveAccess();
  if (!access.ok) {
    if (access.status === 401) redirect(`/login?callbackUrl=${encodeURIComponent(ARCHIVE_PAGE)}`);
    return <Notice title={access.code === 'not_member' ? "You're not on the Accounting Scoreboard" : 'The archive could not open'} message={access.message} />;
  }
  const archive = await readArchive();
  if (!archive.ok) return <Notice title="The archive could not open" message={archive.message} />;
  return <ArchivePanel tabs={archive.value} />;
}

function Notice({ title, message }: { title: string; message: string }) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-gradient-to-br from-white via-orange-50/30 to-blue-50/20 px-4 dark:bg-none dark:bg-[#0d1117]">
      <div className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
        <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{title}</h1>
        <p className="mt-2 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">{message}</p>
        <a
          href={SCOREBOARD_PAGE}
          className="mt-4 inline-flex text-sm font-medium text-orange-700 underline-offset-4 hover:underline dark:text-orange-300"
        >
          Back to the scoreboard
        </a>
      </div>
    </main>
  );
}
