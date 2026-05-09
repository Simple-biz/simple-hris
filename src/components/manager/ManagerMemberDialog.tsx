'use client';

import { useEffect, useState } from 'react';
import { AnimatePresence, LayoutGroup, motion } from 'motion/react';
import { Mail, MapPin, ReceiptText, User as UserIcon } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import type { EmployeeRow } from '@/lib/supabase/employees';
import ManagerMemberHoursMini from './ManagerMemberHoursMini';

type TabId = 'profile' | 'payments';

interface ManagerMemberDialogProps {
  member: EmployeeRow | null;
  ratesHidden: boolean;
  onClose: () => void;
}

function formatPhp(v: number | null | undefined): string {
  if (v == null) return '—';
  return `₱${v.toLocaleString('en-PH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatDate(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function memberInitials(name: string | null | undefined, email: string | null | undefined): string {
  const n = (name ?? '').trim();
  if (n) {
    const parts = n.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    if (parts[0].length >= 2) return parts[0].slice(0, 2).toUpperCase();
    return parts[0][0]!.toUpperCase();
  }
  return (email ?? '??').slice(0, 2).toUpperCase();
}

// Lightweight rate masking: opacity + translate only — no `filter: blur`, which is
// GPU-expensive on mid-tier mobile and causes janky frames during the swap. The
// translate carries enough motion to read as a transition.
function MaskedRate({
  value,
  hidden,
}: {
  value: number | null | undefined;
  hidden: boolean;
}) {
  const transition = { duration: 0.16, ease: [0.22, 1, 0.36, 1] as const };
  return (
    <span className="relative inline-block transform-gpu">
      <AnimatePresence mode="wait" initial={false}>
        {hidden ? (
          <motion.span
            key="hidden"
            initial={{ opacity: 0, y: -3 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 3 }}
            transition={transition}
            className="inline-block select-none tracking-widest text-zinc-400 dark:text-zinc-600"
          >
            ••••••
          </motion.span>
        ) : value != null ? (
          <motion.span
            key="shown"
            initial={{ opacity: 0, y: -3 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 3 }}
            transition={transition}
            className="inline-block"
          >
            {formatPhp(value)}
          </motion.span>
        ) : (
          <motion.span
            key="empty"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.14 }}
            className="inline-block text-zinc-300 dark:text-zinc-700"
          >
            —
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  );
}

function TabBar({ active, onChange }: { active: TabId; onChange: (id: TabId) => void }) {
  const tabs: { id: TabId; label: string; sub: string; Icon: React.ComponentType<{ className?: string }> }[] = [
    { id: 'profile', label: 'Profile', sub: 'Identity & rates', Icon: UserIcon },
    { id: 'payments', label: 'Payment history', sub: 'Hours & pay by month', Icon: ReceiptText },
  ];
  return (
    <LayoutGroup id="manager-member-tabs">
      <div
        className="-mx-4 flex gap-1 overflow-x-auto px-4 sm:mx-0 sm:px-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        role="tablist"
        aria-label="Member sections"
      >
        {tabs.map((t) => {
          const isActive = active === t.id;
          const Icon = t.Icon;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => onChange(t.id)}
              className={cn(
                'relative flex shrink-0 items-center gap-2 px-3 py-3 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-[#0a0a0a] sm:px-4',
                isActive
                  ? 'text-zinc-900 dark:text-zinc-50'
                  : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-500 dark:hover:text-zinc-200',
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              <span className="block">
                <span className="block text-[13px] font-medium tracking-[-0.01em]">{t.label}</span>
                <span className="mt-0.5 block whitespace-nowrap text-[10.5px] text-zinc-400 dark:text-zinc-500">
                  {t.sub}
                </span>
              </span>
              {isActive && (
                <motion.span
                  layoutId="manager-member-tab-underline"
                  className="absolute -bottom-px left-0 right-0 h-[2px] rounded-full bg-gradient-to-r from-blue-500 to-blue-700"
                  transition={{ type: 'spring', stiffness: 380, damping: 32 }}
                />
              )}
            </button>
          );
        })}
      </div>
    </LayoutGroup>
  );
}

function ProfileTab({
  member,
  ratesHidden,
  showRates,
}: {
  member: EmployeeRow;
  ratesHidden: boolean;
  showRates: boolean;
}) {
  const fullAddress =
    member.full_address?.trim() ||
    [member.street, member.city, member.province, member.postal_code]
      .filter((v) => !!v?.trim())
      .join(', ') ||
    null;

  return (
    <div className="space-y-4">
      {showRates && (
        <div className="grid grid-cols-2 gap-2 rounded-xl border border-blue-100/70 bg-gradient-to-br from-white to-blue-50/40 p-3 dark:border-blue-950/50 dark:from-zinc-950/80 dark:to-blue-950/20">
          <div className="flex flex-col gap-0.5">
            <div className="text-[10px] font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
              Hourly
            </div>
            <div className="font-mono text-base tabular-nums text-zinc-900 dark:text-zinc-100">
              <MaskedRate value={member.hsl_hourly_rate} hidden={ratesHidden} />
            </div>
          </div>
          <div className="flex flex-col gap-0.5">
            <div className="text-[10px] font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
              Overtime
            </div>
            <div className="font-mono text-base tabular-nums text-zinc-900 dark:text-zinc-100">
              <MaskedRate value={member.hsl_ot_rate} hidden={ratesHidden} />
            </div>
          </div>
        </div>
      )}

      <dl className="divide-y divide-zinc-100 rounded-xl border border-zinc-200/80 bg-white dark:divide-zinc-800/60 dark:border-zinc-800 dark:bg-zinc-950/40">
        <ProfileRow label="Department" value={member.department} />
        {member.hsl_role && (
          <ProfileRow
            label="Role"
            valueNode={
              <span className="inline-flex items-center rounded-md border border-blue-200 bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-300">
                {member.hsl_role}
              </span>
            }
          />
        )}
        {member.employee_id && <ProfileRow label="Employee ID" value={member.employee_id} mono />}
        <ProfileRow
          label="Start date"
          value={formatDate(member.start_date) ?? '—'}
        />
      </dl>

      <dl className="divide-y divide-zinc-100 rounded-xl border border-zinc-200/80 bg-white dark:divide-zinc-800/60 dark:border-zinc-800 dark:bg-zinc-950/40">
        <ProfileRow label="Work email" value={member.work_email ?? null} mono icon={Mail} />
        <ProfileRow label="Personal email" value={member.personal_email ?? null} mono icon={Mail} />
      </dl>

      {fullAddress && (
        <div className="rounded-xl border border-zinc-200/80 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-950/40">
          <div className="flex items-start gap-2.5">
            <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-blue-50 ring-1 ring-inset ring-blue-100 dark:bg-blue-500/10 dark:ring-blue-500/20">
              <MapPin className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400" />
            </div>
            <div className="min-w-0">
              <div className="text-[10px] font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                Address
              </div>
              <p className="mt-0.5 text-[13px] leading-snug text-zinc-900 dark:text-zinc-100">
                {fullAddress}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ProfileRow({
  label,
  value,
  valueNode,
  mono,
  icon: Icon,
}: {
  label: string;
  value?: string | null;
  valueNode?: React.ReactNode;
  mono?: boolean;
  icon?: React.ComponentType<{ className?: string }>;
}) {
  if (!valueNode && !value?.toString().trim()) return null;
  return (
    <div className="grid grid-cols-[7rem_1fr] items-center gap-3 px-4 py-2.5">
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-zinc-500 dark:text-zinc-400">
        {Icon && <Icon className="h-3 w-3" />}
        {label}
      </div>
      <div
        className={cn(
          'min-w-0 truncate text-[13px] text-zinc-900 dark:text-zinc-100',
          mono && 'font-mono text-[12.5px]',
        )}
      >
        {valueNode ?? value}
      </div>
    </div>
  );
}

export default function ManagerMemberDialog({
  member,
  ratesHidden,
  onClose,
}: ManagerMemberDialogProps) {
  const [activeTab, setActiveTab] = useState<TabId>('profile');

  // Reset to Profile each time a new member is opened so the dialog never lands on
  // a stale tab from a previous open.
  useEffect(() => {
    if (member) setActiveTab('profile');
  }, [member]);

  const showRates = !!(
    member && (member.hsl_hourly_rate != null || member.hsl_ot_rate != null)
  );
  const initials = memberInitials(member?.name, member?.work_email ?? member?.personal_email ?? '');

  return (
    <Dialog open={!!member} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="grid max-h-[88vh] w-[calc(100%-1.5rem)] grid-rows-[auto_auto_1fr] gap-0 overflow-hidden p-0 sm:max-w-lg"
      >
        {member && (
          <>
            <header className="flex items-center gap-3 border-b border-zinc-200/70 bg-gradient-to-br from-white via-blue-50/40 to-blue-50/60 px-5 py-4 dark:border-zinc-800 dark:from-zinc-950 dark:via-blue-950/20 dark:to-blue-950/30">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-blue-700 text-sm font-semibold text-white shadow-md shadow-blue-500/25">
                {initials}
              </div>
              <div className="min-w-0 flex-1">
                <DialogTitle className="truncate text-[15px] font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
                  {member.name ?? '—'}
                </DialogTitle>
                <DialogDescription className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11.5px] text-zinc-500 dark:text-zinc-400">
                  {member.department && (
                    <span className="text-zinc-700 dark:text-zinc-200">{member.department}</span>
                  )}
                  {member.department && member.work_email && (
                    <span className="text-zinc-300 dark:text-zinc-700">·</span>
                  )}
                  {member.work_email && (
                    <span className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
                      {member.work_email}
                    </span>
                  )}
                </DialogDescription>
              </div>
            </header>

            <div className="border-b border-zinc-200/70 bg-white/60 px-3 dark:border-zinc-800 dark:bg-zinc-950/40 sm:px-4">
              <TabBar active={activeTab} onChange={setActiveTab} />
            </div>

            <div className="min-h-0 overflow-y-auto bg-zinc-50/40 px-4 py-4 transform-gpu dark:bg-zinc-950/30 sm:px-5">
              <AnimatePresence mode="wait" initial={false}>
                <motion.div
                  key={activeTab}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -3 }}
                  transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
                  className="transform-gpu"
                >
                  {activeTab === 'profile' ? (
                    <ProfileTab
                      member={member}
                      ratesHidden={ratesHidden}
                      showRates={showRates}
                    />
                  ) : (
                    <ManagerMemberHoursMini
                      workEmail={member.work_email ?? null}
                      personalEmail={member.personal_email ?? null}
                    />
                  )}
                </motion.div>
              </AnimatePresence>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
