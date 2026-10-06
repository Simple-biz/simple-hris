import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { resolveAccess } from '@/lib/accounting-scoreboard/server';
import { SCOREBOARD_PAGE } from '@/lib/accounting-scoreboard/host';
import ScoreboardApp from '@/components/accounting-scoreboard/ScoreboardApp';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Accounting Scoreboard',
  description: "Carla's team scoreboard: buckets, collections, inbox, payroll and the rest, added up automatically.",
};

/**
 * /accounting-scoreboard — also the whole site on ACCOUNTING_SCOREBOARD_HOST (accounting-bonus.vercel.app).
 * Governing doc: docs/features/accounting-scoreboard.md.
 *
 * The route is NOT role-gated at the edge (route-access.ts): most of the team who type the numbers
 * hold no HRIS role. This server component is the gate. It checks the board's member list
 * BEFORE the client shell renders or fetches anything, the same "never render a privileged shell
 * for the wrong person" rule as requirePageRoles. The API re-checks on every call.
 */
export default async function AccountingScoreboardPage() {
  const access = await resolveAccess('member');
  if (!access.ok) {
    if (access.status === 401) redirect(`/login?callbackUrl=${encodeURIComponent(SCOREBOARD_PAGE)}`);
    return <Refusal code={access.code} message={access.message} />;
  }
  // The viewer is resolved here, on every request, and handed down: the board's browser cache binds to
  // this email before it paints anything, and `isManager` (a permission) is never read from the cache.
  return <ScoreboardApp viewer={{ email: access.value.email, isManager: access.value.isManager }} />;
}

function Refusal({ code, message }: { code: string; message: string }) {
  const title =
    code === 'not_member'
      ? "You're not on the Accounting Scoreboard"
      : code === 'not_set_up'
        ? 'The scoreboard is not set up yet'
        : 'The scoreboard could not open';
  return (
    <main className="flex min-h-dvh items-center justify-center bg-gradient-to-br from-white via-orange-50/30 to-blue-50/20 px-4 dark:bg-none dark:bg-[#0d1117]">
      <div className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
        <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{title}</h1>
        <p className="mt-2 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">{message}</p>
        {code === 'not_member' ? (
          <a
            href="/api/auth/signout"
            className="mt-4 inline-flex text-sm font-medium text-orange-700 underline-offset-4 hover:underline dark:text-orange-300"
          >
            Sign in with a different account
          </a>
        ) : null}
      </div>
    </main>
  );
}
