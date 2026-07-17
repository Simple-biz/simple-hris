'use client';

import React from 'react';
import {
  ArrowUpRight,
  Check,
  Copy,
  ExternalLink,
  Lock,
  PencilRuler,
  RefreshCw,
  ShieldCheck,
  UserCog,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import {
  TICKET_BOARD_OWNER,
  TICKET_STATUSES,
  isAssignableDeveloper,
  type TicketMember,
  type TicketRow,
} from '@/lib/tickets/types';
import { PRIORITY_STYLES, STATUS_STYLES, initialsFor } from '@/components/tickets/TicketCard';

/**
 * Design & Specifications
 * -----------------------
 * Hosts the design/specifications artifact for the HRIS. The artifact lives on
 * claude.ai, which sends `X-Frame-Options: SAMEORIGIN` — so it CANNOT be embedded
 * in an <iframe> from this origin (the browser refuses the connection). We link
 * out to it instead (opens in a new tab). It's also private to the owner's
 * claude.ai login, so viewers may be prompted to sign in.
 *
 * To point this tab at a new artifact, update ARTIFACT_URL below.
 *
 * Below the document card sits the Ticket Developers configurator: the admin
 * assigns developers to /tickets board items from here. The pool is strictly
 * the people granted "Ticket Board" = Edit in Roles & Permissions (plus
 * admins, who hold edit implicitly) — the API rejects anyone else — and every
 * assignment notifies the developer instantly (in-app + email webhook).
 */
const ARTIFACT_URL = 'https://claude.ai/code/artifact/7a44f6e6-4f7e-419f-8d35-e44e8eed0465';

interface AdminDesignSpecsProps {
  /** Jump to a sibling admin tab (e.g. `roles`, `webhooks`). Wired by
   *  app/admin/page.tsx; the buttons hide when absent. */
  onNavigate?: (tab: string) => void;
}

export default function AdminDesignSpecs({ onNavigate }: AdminDesignSpecsProps) {
  const [copied, setCopied] = React.useState(false);

  const copyUrl = React.useCallback(async () => {
    try {
      await navigator.clipboard.writeText(ARTIFACT_URL);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard unavailable — the link button still works */
    }
  }, []);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 bg-gradient-to-b from-zinc-50/80 to-transparent px-4 py-6 sm:px-6 lg:px-8 dark:from-zinc-950/50">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2.5 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-white">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-orange-500/15 ring-1 ring-orange-500/25">
            <PencilRuler className="h-5 w-5 text-orange-600 dark:text-orange-400" aria-hidden />
          </span>
          Design &amp; Specifications
        </h1>
        <p className="max-w-xl text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
          The living design and specifications document for the HRIS — visual standards,
          layout patterns, and interface decisions, kept as a Claude artifact.
        </p>
      </header>

      {/* Document cover */}
      <div className="relative overflow-hidden rounded-2xl border border-zinc-200/90 bg-white shadow-sm dark:border-zinc-800/80 dark:bg-zinc-900/40">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-28 bg-gradient-to-b from-orange-500/10 to-transparent" aria-hidden />
        <div className="relative flex flex-col items-center gap-5 px-6 py-10 text-center sm:px-10 sm:py-12">
          <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-orange-500/15 ring-1 ring-orange-500/25">
            <PencilRuler className="h-8 w-8 text-orange-600 dark:text-orange-400" aria-hidden />
          </span>

          <div className="space-y-1.5">
            <h2 className="text-lg font-semibold text-zinc-900 dark:text-white">
              HRIS Design &amp; Specifications
            </h2>
            <p className="mx-auto max-w-md text-sm leading-relaxed text-zinc-500 dark:text-zinc-400">
              Opens the full document in a new tab. It&apos;s hosted on claude.ai, so it
              can&apos;t be shown inside this page — but everything lives one click away.
            </p>
          </div>

          <a
            href={ARTIFACT_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 rounded-xl bg-orange-600 px-5 py-3 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-orange-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-500 dark:bg-orange-500 dark:hover:bg-orange-400"
          >
            Open Design &amp; Specifications
            <ExternalLink className="h-4 w-4" aria-hidden />
          </a>

          {/* URL + copy */}
          <div className="flex w-full max-w-md flex-col items-stretch gap-2 sm:flex-row sm:items-center">
            <code className="min-w-0 flex-1 truncate rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-left font-mono text-xs text-zinc-600 dark:border-zinc-800 dark:bg-zinc-950/60 dark:text-zinc-400">
              {ARTIFACT_URL}
            </code>
            <button
              type="button"
              onClick={copyUrl}
              className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
              aria-label="Copy link"
            >
              {copied ? (
                <>
                  <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden />
                  Copied
                </>
              ) : (
                <>
                  <Copy className="h-3.5 w-3.5" aria-hidden />
                  Copy link
                </>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Access note */}
      <div className="flex items-start gap-2.5 rounded-xl border border-zinc-200/80 bg-zinc-50/60 px-4 py-3 text-xs leading-relaxed text-zinc-500 dark:border-zinc-800/70 dark:bg-zinc-900/30 dark:text-zinc-400">
        <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-400 dark:text-zinc-500" aria-hidden />
        <p>
          The document is private to its owner&apos;s claude.ai account — you may be asked to
          sign in. Share it from the artifact&apos;s own menu on claude.ai to give teammates access.
        </p>
      </div>

      <TicketDevelopersSection onNavigate={onNavigate} />
    </div>
  );
}

// ── Ticket Developers configurator ────────────────────────────────────────────

const STATUS_ORDER = Object.fromEntries(TICKET_STATUSES.map((s, i) => [s, i])) as Record<
  string,
  number
>;

/** Profile photo with an initials fallback (missing URL or a broken image). */
function DevAvatar({ member }: { member: TicketMember }) {
  const [broken, setBroken] = React.useState(false);
  const showPhoto = Boolean(member.photo_url) && !broken;
  return (
    <span
      className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-zinc-100 text-[11px] font-semibold text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
      aria-hidden
    >
      {showPhoto ? (
        // eslint-disable-next-line @next/next/no-img-element -- external avatar hosts (Google SSO, Supabase Storage) aren't in next/image's allowlist
        <img
          src={member.photo_url as string}
          alt=""
          className="h-full w-full object-cover"
          referrerPolicy="no-referrer"
          onError={() => setBroken(true)}
        />
      ) : (
        initialsFor(member.name, member.email)
      )}
    </span>
  );
}

/**
 * Configure who develops what on the /tickets board. Two blocks:
 *   1. the developer pool — read-only mirror of Roles & Permissions ("Ticket
 *      Board" = Edit grants + admins). Managed THERE, only surfaced here.
 *   2. per-ticket assignment — a select per open ticket; picking a developer
 *      PATCHes /api/tickets/[id], which notifies them instantly (in-app
 *      notification + the `ticket_assigned` email webhook) and stamps the
 *      ticket's history trail. The board then shows the assignee label.
 */
function TicketDevelopersSection({ onNavigate }: { onNavigate?: (tab: string) => void }) {
  const [members, setMembers] = React.useState<TicketMember[] | null>(null);
  const [tickets, setTickets] = React.useState<TicketRow[] | null>(null);
  const [viewer, setViewer] = React.useState('');
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [refreshing, setRefreshing] = React.useState(false);
  const [savingId, setSavingId] = React.useState<string | null>(null);
  const [unassignedOnly, setUnassignedOnly] = React.useState(false);

  // Assignment is owner-only (POST/PATCH /api/tickets enforce it). Non-owner
  // admins can view the board here but the pickers stay read-only.
  const isOwner = viewer === TICKET_BOARD_OWNER;

  const load = React.useCallback(async () => {
    setRefreshing(true);
    try {
      const [mRes, tRes] = await Promise.all([
        fetch('/api/tickets/members', { cache: 'no-store' }),
        fetch('/api/tickets', { cache: 'no-store' }),
      ]);
      if (!mRes.ok || !tRes.ok) {
        const bad = !mRes.ok ? mRes : tRes;
        const j = (await bad.json().catch(() => null)) as { error?: string } | null;
        throw new Error(j?.error ?? `Request failed (${bad.status})`);
      }
      const mJson = (await mRes.json()) as { members?: TicketMember[] };
      const tJson = (await tRes.json()) as { tickets?: TicketRow[]; viewer?: string };
      setMembers(mJson.members ?? []);
      setTickets(tJson.tickets ?? []);
      setViewer((tJson.viewer ?? '').trim().toLowerCase());
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not load the ticket board');
    } finally {
      setRefreshing(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const developers = React.useMemo(
    () => (members ?? []).filter(isAssignableDeveloper),
    [members],
  );

  // Active workload per developer — everything not yet Done counts.
  const activeCounts = React.useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of tickets ?? []) {
      if (t.status === 'done' || !t.assigned_to) continue;
      counts.set(t.assigned_to, (counts.get(t.assigned_to) ?? 0) + 1);
    }
    return counts;
  }, [tickets]);

  const visibleTickets = React.useMemo(() => {
    const list = (tickets ?? []).filter((t) => !unassignedOnly || !t.assigned_to);
    return [...list].sort(
      (a, b) =>
        (STATUS_ORDER[a.status] ?? 0) - (STATUS_ORDER[b.status] ?? 0) ||
        a.position - b.position ||
        a.created_at.localeCompare(b.created_at),
    );
  }, [tickets, unassignedOnly]);

  const assign = async (ticket: TicketRow, email: string | null) => {
    setSavingId(ticket.id);
    try {
      const res = await fetch(`/api/tickets/${ticket.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assigned_to: email }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { error?: string } | null;
        toast.error(j?.error ?? 'Could not update the assignment');
        return;
      }
      const j = (await res.json()) as { ticket: TicketRow };
      setTickets((prev) =>
        prev ? prev.map((t) => (t.id === ticket.id ? { ...t, assigned_to: j.ticket.assigned_to } : t)) : prev,
      );
      if (email) {
        const dev = developers.find((d) => d.email === email);
        toast.success(
          `Ticket #${ticket.ticket_no} assigned to ${dev?.name ?? email} — they've been notified`,
        );
      } else {
        toast.success(`Ticket #${ticket.ticket_no} unassigned`);
      }
    } finally {
      setSavingId(null);
    }
  };

  const loading = members === null || tickets === null;

  return (
    <section className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h2 className="flex items-center gap-2.5 text-lg font-semibold tracking-tight text-zinc-900 dark:text-white">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-teal-500/15 ring-1 ring-teal-500/25">
              <UserCog className="h-4.5 w-4.5 text-teal-600 dark:text-teal-400" aria-hidden />
            </span>
            Ticket Developers
          </h2>
          <p className="max-w-xl text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
            Assign a developer to each ticket on the{' '}
            <a
              href="/tickets"
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-zinc-900 underline decoration-zinc-300 underline-offset-2 hover:decoration-zinc-500 dark:text-zinc-100 dark:decoration-zinc-600 dark:hover:decoration-zinc-400"
            >
              Tickets board
            </a>
            . They&apos;re notified the moment you assign, the ticket carries their name, and
            they can move it across the board columns as they work.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={refreshing}
          className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} aria-hidden />
          Refresh
        </button>
      </header>

      {/* Where the pool comes from */}
      <div className="flex flex-col gap-2.5 rounded-xl border border-teal-500/20 bg-teal-500/[0.06] px-4 py-3 text-xs leading-relaxed text-zinc-600 sm:flex-row sm:items-center dark:bg-teal-500/[0.08] dark:text-zinc-300">
        <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-teal-600 dark:text-teal-400" aria-hidden />
        <p className="flex-1">
          Only people granted <span className="font-semibold">Ticket Board = Edit</span> in Roles
          &amp; Permissions can be assigned (admins qualify automatically). View-only members
          never appear here.
        </p>
        {onNavigate && (
          <button
            type="button"
            onClick={() => onNavigate('roles')}
            className="inline-flex shrink-0 items-center gap-1 self-start rounded-lg border border-teal-500/30 bg-white px-2.5 py-1.5 text-xs font-medium text-teal-700 transition-colors hover:bg-teal-50 sm:self-auto dark:bg-zinc-900 dark:text-teal-400 dark:hover:bg-zinc-800"
          >
            Roles &amp; Permissions
            <ArrowUpRight className="h-3 w-3" aria-hidden />
          </button>
        )}
      </div>

      {loading && !loadError ? (
        <div className="space-y-2" aria-hidden>
          <div className="h-16 animate-pulse rounded-xl bg-zinc-100 dark:bg-zinc-900" />
          <div className="h-40 animate-pulse rounded-xl bg-zinc-100 dark:bg-zinc-900" />
        </div>
      ) : loadError ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-zinc-300 px-4 py-8 text-center dark:border-zinc-700">
          <p className="text-sm text-zinc-500 dark:text-zinc-400">{loadError}</p>
          <button
            type="button"
            onClick={() => void load()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs font-medium text-zinc-600 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden />
            Try again
          </button>
        </div>
      ) : (
        <>
          {/* The developer pool */}
          <div className="rounded-2xl border border-zinc-200/90 bg-white p-4 shadow-sm sm:p-5 dark:border-zinc-800/80 dark:bg-zinc-900/40">
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-white">
              Developer pool
              <span className="ml-2 rounded-full bg-zinc-100 px-2 py-0.5 font-mono text-[11px] font-medium text-zinc-500 tabular-nums dark:bg-zinc-800 dark:text-zinc-400">
                {developers.length}
              </span>
            </h3>
            {developers.length === 0 ? (
              <p className="mt-3 rounded-lg border border-dashed border-zinc-300 px-3 py-4 text-center text-xs text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
                Nobody holds Edit access to the Ticket Board yet — grant it in Roles &amp;
                Permissions to build the pool.
              </p>
            ) : (
              <ul className="mt-3 grid gap-2 sm:grid-cols-2">
                {developers.map((dev) => {
                  const active = activeCounts.get(dev.email) ?? 0;
                  return (
                    <li
                      key={dev.email}
                      className="flex items-center gap-2.5 rounded-xl border border-zinc-200/80 bg-zinc-50/60 px-3 py-2 dark:border-zinc-800/70 dark:bg-zinc-950/40"
                    >
                      <DevAvatar member={dev} />
                      <span className="min-w-0 flex-1 leading-tight">
                        <span
                          className="block truncate text-sm font-medium text-zinc-900 dark:text-zinc-100"
                          title={dev.email}
                        >
                          {dev.name ?? dev.email.split('@')[0]}
                        </span>
                        <span className="block truncate text-[11px] text-zinc-500 dark:text-zinc-400">
                          {dev.department ?? dev.email}
                        </span>
                      </span>
                      <span className="flex shrink-0 flex-col items-end gap-1">
                        <span
                          className={cn(
                            'inline-flex h-5 items-center rounded-full px-2 text-[10px] font-semibold uppercase tracking-wide',
                            dev.access === 'admin'
                              ? 'bg-red-500/10 text-red-600 dark:bg-red-500/15 dark:text-red-400'
                              : 'bg-emerald-500/10 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400',
                          )}
                        >
                          {dev.access === 'admin' ? 'Admin' : 'Edit'}
                        </span>
                        <span
                          className="text-[11px] text-zinc-500 tabular-nums dark:text-zinc-400"
                          title={`${active} active ticket${active === 1 ? '' : 's'} (not yet Done)`}
                        >
                          {active} active
                        </span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* Per-ticket assignment */}
          <div className="rounded-2xl border border-zinc-200/90 bg-white p-4 shadow-sm sm:p-5 dark:border-zinc-800/80 dark:bg-zinc-900/40">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-zinc-900 dark:text-white">
                Assign tickets
                <span className="ml-2 rounded-full bg-zinc-100 px-2 py-0.5 font-mono text-[11px] font-medium text-zinc-500 tabular-nums dark:bg-zinc-800 dark:text-zinc-400">
                  {visibleTickets.length}
                </span>
              </h3>
              <label className="flex cursor-pointer items-center gap-1.5 text-xs text-zinc-500 select-none dark:text-zinc-400">
                <input
                  type="checkbox"
                  checked={unassignedOnly}
                  onChange={(e) => setUnassignedOnly(e.target.checked)}
                  className="h-3.5 w-3.5 accent-teal-600"
                />
                Unassigned only
              </label>
            </div>

            {!isOwner && (
              <div className="mt-3 flex items-start gap-2.5 rounded-xl border border-amber-500/25 bg-amber-500/[0.07] px-4 py-3 text-xs leading-relaxed text-amber-700 dark:text-amber-300">
                <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                <p>
                  Assignment is owned by{' '}
                  <code className="font-mono">{TICKET_BOARD_OWNER}</code> — the pickers below are
                  read-only for everyone else. You can see who&apos;s on each ticket, but only the
                  board owner can assign or reassign.
                </p>
              </div>
            )}

            {visibleTickets.length === 0 ? (
              <p className="mt-3 rounded-lg border border-dashed border-zinc-300 px-3 py-4 text-center text-xs text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
                {unassignedOnly
                  ? 'Every ticket on the board has a developer. 🎉'
                  : 'No tickets on the board right now.'}
              </p>
            ) : (
              <ul className="mt-3 max-h-96 space-y-1.5 overflow-y-auto pr-1">
                {visibleTickets.map((t) => {
                  const status = STATUS_STYLES[t.status];
                  const prio = PRIORITY_STYLES[t.priority] ?? PRIORITY_STYLES.medium;
                  // Assignee predates the pool rule / lost access — keep it visible.
                  const legacyAssignee =
                    t.assigned_to && !developers.some((d) => d.email === t.assigned_to)
                      ? t.assigned_to
                      : null;
                  return (
                    <li
                      key={t.id}
                      className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border border-zinc-200/80 px-3 py-2 sm:flex-nowrap dark:border-zinc-800/70"
                    >
                      <span className="w-10 shrink-0 font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
                        #{t.ticket_no}
                      </span>
                      <span
                        className="min-w-0 flex-1 basis-40 truncate text-sm font-medium text-zinc-900 dark:text-zinc-100"
                        title={t.title}
                      >
                        {t.title}
                      </span>
                      <span
                        className="flex w-24 shrink-0 items-center gap-1.5 text-[11px] text-zinc-500 dark:text-zinc-400"
                        title={`Column: ${status.label}`}
                      >
                        <span className={cn('h-1.5 w-1.5 rounded-full', status.dot)} aria-hidden />
                        {status.label}
                      </span>
                      <span
                        className={cn(
                          'inline-flex h-5 w-16 shrink-0 items-center justify-center rounded-full text-[10px] font-medium',
                          prio.chip,
                        )}
                      >
                        {prio.label}
                      </span>
                      <select
                        aria-label={`Developer for ticket #${t.ticket_no}`}
                        value={t.assigned_to ?? ''}
                        disabled={savingId === t.id || !isOwner}
                        title={isOwner ? undefined : 'Only the board owner can assign or reassign a ticket'}
                        onChange={(e) => void assign(t, e.target.value || null)}
                        className="h-8 w-full shrink-0 rounded-lg border border-zinc-200 bg-white px-2 text-xs text-zinc-700 outline-none focus-visible:ring-2 focus-visible:ring-teal-500/40 disabled:cursor-wait disabled:opacity-60 sm:w-44 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200"
                      >
                        <option value="">Unassigned</option>
                        {developers.map((d) => (
                          <option key={d.email} value={d.email}>
                            {d.name ?? d.email.split('@')[0]}
                          </option>
                        ))}
                        {legacyAssignee && (
                          <option value={legacyAssignee}>
                            {legacyAssignee.split('@')[0]} (no Edit access)
                          </option>
                        )}
                      </select>
                    </li>
                  );
                })}
              </ul>
            )}

            <p className="mt-3 text-[11px] leading-relaxed text-zinc-400 dark:text-zinc-500">
              Assigning writes to the ticket&apos;s history and notifies the developer instantly —
              in-app always; by email when the <code className="font-mono">ticket_assigned</code>{' '}
              webhook is configured
              {onNavigate ? (
                <>
                  {' '}
                  in{' '}
                  <button
                    type="button"
                    onClick={() => onNavigate('webhooks')}
                    className="underline decoration-zinc-300 underline-offset-2 hover:text-zinc-600 dark:decoration-zinc-600 dark:hover:text-zinc-300"
                  >
                    Admin → Webhooks
                  </button>
                  .
                </>
              ) : (
                ' in Admin → Webhooks.'
              )}
            </p>
          </div>
        </>
      )}
    </section>
  );
}
