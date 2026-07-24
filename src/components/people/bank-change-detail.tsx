'use client';

import { type ReactNode } from 'react';
import {
  Clock, Landmark, ShieldCheck, CreditCard, Globe, UserPlus, PencilLine, Link2, Sparkles,
  ArrowRight, ArrowUpRight, UserRound,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { TeamAvatar } from '@/components/team/team-ui';
import { cn } from '@/lib/utils';

/**
 * Shared "what changed" rendering for a self-service bank/payout change —
 * used by both the People-tab global "Recent bank changes" feed
 * (PeopleBankChanges.tsx) and the per-employee "Bank change history" section
 * (PersonDetailDialog in PeopleTab.tsx), so the two never drift apart.
 */

/** One field's masked before→after. Mirrors `BankChangeField` from the API. */
export interface BankChangeField {
  field: string;
  before: string | null;
  after: string | null;
  changed: boolean;
}

/** One self-service payout change. Mirrors `BankChangeEntry` from the API. */
export interface BankChangeEntry {
  id: string;
  name: string;
  email: string | null;
  fields: string[];
  /** Masked before→after per field. Empty for rows saved before value-snapshotting. */
  changes: BankChangeField[];
  processor: string | null;
  createdNew: boolean;
  via: string | null;
  ip_address: string | null;
  created_at: string;
}

const FIELD_LABELS: Record<string, string> = {
  preferred_processor: 'Payment method',
  preferred_bank_slot: 'Preferred bank',
  bank_name: 'Bank',
  account_holder_name: 'Account holder',
  account_number: 'Account number',
  routing_number: 'Routing number',
  swift_code: 'SWIFT / BIC',
  full_address: 'Address',
  phone_number: 'Phone',
  alt_bank_name: 'Alt bank',
  alt_account_holder_name: 'Alt account holder',
  alt_account_number: 'Alt account number',
  alt_routing_number: 'Alt routing',
  hurupay_email: 'Hurupay email',
  wepay_email: 'Wepay email',
  higlobe_email: 'HiGlobe email',
  higlobe_account_name: 'HiGlobe name',
  wise_email: 'Wise email',
  wise_tag: 'Wise tag',
};

export function fieldLabel(key: string): string {
  return FIELD_LABELS[key] ?? key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (s < 45) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function absoluteTime(iso: string): string {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleString('en-US') : iso;
}

/* ── "What changed" detail dialog ────────────────────────────────────────── */

export function BankChangeDetailDialog({
  row,
  onClose,
  onOpenProfile,
}: {
  row: BankChangeEntry;
  onClose: () => void;
  /** Jump to this person's roster profile. Omit when already viewing their profile. */
  onOpenProfile?: (email: string | null) => void;
}) {
  // Masked before→after, when recorded. Legacy rows (saved before value-
  // snapshotting) have no `changes` — those get an honest "not tracked" note.
  const valueChanges = row.changes ?? [];
  const hasValueDetail = valueChanges.length > 0;
  const changedEntries = valueChanges.filter((c) => c.changed);
  const unchangedEntries = valueChanges.filter((c) => !c.changed);
  const changedCount = changedEntries.length;
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="gap-4 overflow-hidden p-4 sm:max-w-3xl">
        {/* ── Hero: who + at-a-glance status, bled to the dialog edges ───────── */}
        <div className="relative -mx-4 -mt-4 overflow-hidden border-b border-emerald-100/70 bg-gradient-to-br from-emerald-50 via-white to-teal-50/40 px-5 pb-4 pt-5 dark:border-emerald-900/40 dark:from-emerald-950/40 dark:via-[#0d1117] dark:to-[#0a1628]">
          {/* Decorative watermark */}
          <Landmark
            aria-hidden
            className="pointer-events-none absolute -right-4 -top-5 h-28 w-28 rotate-12 text-emerald-500/10 dark:text-emerald-400/[0.07]"
          />

          <DialogDescription className="relative inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-300/90">
            <span className="flex h-5 w-5 items-center justify-center rounded-md bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
              <Landmark className="h-3 w-3" />
            </span>
            Self-service payout change
          </DialogDescription>

          <div className="relative mt-3 flex items-center gap-3">
            <span className="shrink-0 rounded-full shadow-md ring-2 ring-white dark:ring-zinc-900/80">
              <TeamAvatar name={row.name ?? ''} email={row.email} />
            </span>
            <div className="min-w-0 flex-1">
              <DialogTitle className="truncate text-[15px] font-semibold text-zinc-900 dark:text-zinc-50">
                {row.name || '—'}
              </DialogTitle>
              <div className="truncate text-[11.5px] text-zinc-500 dark:text-zinc-400">
                {row.email ?? 'No email on file'}
              </div>
            </div>
          </div>

          <div className="relative mt-3 flex flex-wrap items-center gap-1.5">
            {row.createdNew ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-sky-100 px-2.5 py-1 text-[11px] font-semibold text-sky-700 dark:bg-sky-950/50 dark:text-sky-300">
                <Sparkles className="h-3 w-3" /> First-time setup
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2.5 py-1 text-[11px] font-semibold text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                <PencilLine className="h-3 w-3" /> Updated details
              </span>
            )}
            {row.processor && (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-1 text-[11px] font-semibold capitalize text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300">
                <CreditCard className="h-3 w-3" /> {row.processor}
              </span>
            )}
          </div>
        </div>

        {/* ── Body: meta + "what changed" side by side on wider screens ─────── */}
        <div className="grid gap-4 sm:grid-cols-2">

        {/* ── Meta: when / type / source / IP ───────────────────────────────── */}
        <div className="divide-y divide-zinc-100 self-start overflow-hidden rounded-xl border border-zinc-200/80 bg-white/60 dark:divide-zinc-800/80 dark:border-zinc-800 dark:bg-zinc-900/40">
          <MetaRow
            icon={<Clock className="h-3.5 w-3.5" />}
            tint="bg-emerald-50 text-emerald-600 dark:bg-emerald-950/50 dark:text-emerald-300"
            label="When"
            value={
              <>
                {absoluteTime(row.created_at)}{' '}
                <span className="text-zinc-400 dark:text-zinc-500">· {timeAgo(row.created_at)}</span>
              </>
            }
          />
          <MetaRow
            icon={row.createdNew ? <UserPlus className="h-3.5 w-3.5" /> : <PencilLine className="h-3.5 w-3.5" />}
            tint={
              row.createdNew
                ? 'bg-sky-50 text-sky-600 dark:bg-sky-950/50 dark:text-sky-300'
                : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400'
            }
            label="Type"
            value={row.createdNew ? 'First-time payout setup' : 'Updated existing details'}
          />
          <MetaRow
            icon={<Link2 className="h-3.5 w-3.5" />}
            tint="bg-amber-50 text-amber-600 dark:bg-amber-950/40 dark:text-amber-300"
            label="Source"
            value={
              row.via === 'external_link'
                ? 'External self-service link'
                : row.via === 'people_tab'
                  ? 'People tab (in-app edit)'
                  : row.via === 'payroll_wizard_readiness'
                    ? 'Payroll Wizard (Readiness)'
                    : row.via === 'employee_dashboard'
                      ? 'Employee dashboard'
                      : row.via || 'External link'
            }
          />
          {row.ip_address && (
            <MetaRow
              icon={<Globe className="h-3.5 w-3.5" />}
              tint="bg-violet-50 text-violet-600 dark:bg-violet-950/40 dark:text-violet-300"
              label="IP address"
              value={<span className="font-mono text-[11.5px]">{row.ip_address}</span>}
            />
          )}
        </div>

        {/* ── What changed — masked before→after. Legacy rows (no snapshot) get an
              honest "not tracked" note instead of guessing from submitted fields. ── */}
        <div>
          <div className="mb-2 flex items-center gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
              What changed
            </span>
            {hasValueDetail && (
              <span className="inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-emerald-100 px-1.5 text-[11px] font-bold tabular-nums text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300">
                {changedCount}
              </span>
            )}
          </div>

          {!hasValueDetail ? (
            <p className="rounded-lg border border-dashed border-zinc-200 bg-zinc-50/60 px-3 py-2.5 text-[12px] text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-400">
              This change predates per-field tracking, so we can&apos;t show which values actually changed.
            </p>
          ) : changedEntries.length === 0 ? (
            <p className="rounded-lg border border-dashed border-zinc-200 bg-zinc-50/60 px-3 py-2.5 text-[12px] text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-400">
              Details were re-submitted, but no values actually changed.
            </p>
          ) : (
            <div className="divide-y divide-zinc-100 overflow-hidden rounded-xl border border-zinc-200/80 bg-white/60 dark:divide-zinc-800/80 dark:border-zinc-800 dark:bg-zinc-900/40">
              {changedEntries.map((c) => (
                <div key={c.field} className="px-3.5 py-2.5">
                  <div className="text-[10.5px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
                    {fieldLabel(c.field)}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    {c.before == null ? (
                      <span className="text-[12px] italic text-zinc-400 dark:text-zinc-500">Not set</span>
                    ) : (
                      <ValuePill tone="before">{c.before}</ValuePill>
                    )}
                    <ArrowRight className="h-3.5 w-3.5 shrink-0 text-zinc-400 dark:text-zinc-500" />
                    {c.after == null ? (
                      <span className="text-[12px] italic text-zinc-400 dark:text-zinc-500">Cleared</span>
                    ) : (
                      <ValuePill tone="after">{c.after}</ValuePill>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Fields re-submitted but unchanged — shown quietly for completeness. */}
          {hasValueDetail && unchangedEntries.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className="text-[10.5px] uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
                Unchanged
              </span>
              {unchangedEntries.map((c) => (
                <span
                  key={c.field}
                  className="inline-flex items-center rounded-md bg-zinc-100 px-1.5 py-0.5 text-[11px] font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
                >
                  {fieldLabel(c.field)}
                </span>
              ))}
            </div>
          )}
        </div>

        </div>

        {/* ── Primary action: jump to this person's roster profile ──────────── */}
        {onOpenProfile && (
          <Button
            type="button"
            className="w-full gap-2 bg-emerald-600 text-white shadow-sm transition-colors hover:bg-emerald-700 focus-visible:ring-2 focus-visible:ring-emerald-400/50 dark:bg-emerald-600 dark:hover:bg-emerald-500"
            onClick={() => {
              onOpenProfile(row.email);
              onClose();
            }}
          >
            <UserRound className="h-4 w-4" />
            Go to Profile
            <ArrowUpRight className="h-4 w-4 opacity-80" />
          </Button>
        )}

        {/* ── Privacy footer, bled to the dialog edges ──────────────────────── */}
        <div className="-mx-4 -mb-4 flex items-start gap-2 rounded-b-xl border-t border-zinc-100 bg-zinc-50/70 px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900/40">
          <ShieldCheck className="mt-px h-4 w-4 shrink-0 text-emerald-500" />
          <p className="text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">
            Account numbers are masked here. Open the full profile to review this person&apos;s audited payout
            details.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** A single before/after value chip in the "what changed" list. */
export function ValuePill({ tone, children }: { tone: 'before' | 'after'; children: ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center break-all rounded-md px-2 py-0.5 text-[12px] font-medium',
        tone === 'before'
          ? 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800/80 dark:text-zinc-400'
          : 'bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200/70 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-900/50',
      )}
    >
      {children}
    </span>
  );
}

/** One labelled detail row inside the dialog's meta card. */
export function MetaRow({
  icon,
  tint,
  label,
  value,
}: {
  icon: ReactNode;
  tint: string;
  label: string;
  value: ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 px-3.5 py-2.5">
      <span className={cn('mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg', tint)}>
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[10.5px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
          {label}
        </div>
        <div className="mt-0.5 break-words text-[12.5px] text-zinc-700 dark:text-zinc-200">{value}</div>
      </div>
    </div>
  );
}
