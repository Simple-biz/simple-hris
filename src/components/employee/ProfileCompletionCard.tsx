'use client';

import { motion } from 'motion/react';
import { Camera, CreditCard, ArrowRight, BadgeCheck, Sparkles } from 'lucide-react';

interface ProfileCompletionCardProps {
  /** No uploaded photo and no Google SSO photo on file. */
  needsPhoto: boolean;
  /** Payout / bank details not filled in yet. */
  needsBank: boolean;
  /** Skill Sets are still empty. */
  needsSkillSet?: boolean;
  /** Jump to the Profile tab, optionally targeting a section. */
  onGoToProfile: (target?: 'overview' | 'payment' | 'skillsets') => void;
}

/**
 * Dashboard nudge shown right after sign-in when an employee still needs a
 * profile photo, bank/payout details, and/or Skill Sets. Renders nothing once
 * all are done. Mirrors the GiftShippingCard placement on the Overview tab.
 */
export default function ProfileCompletionCard({
  needsPhoto,
  needsBank,
  needsSkillSet = false,
  onGoToProfile,
}: ProfileCompletionCardProps) {
  if (!needsPhoto && !needsBank && !needsSkillSet) return null;

  const items: { icon: typeof Camera; label: string; target: 'overview' | 'payment' | 'skillsets' }[] = [];
  if (needsPhoto) items.push({ icon: Camera, label: 'Upload a profile photo', target: 'overview' });
  if (needsBank) items.push({ icon: CreditCard, label: 'Add your bank / payout details', target: 'payment' });
  if (needsSkillSet) items.push({ icon: Sparkles, label: 'Fill in your Skill Sets', target: 'skillsets' });

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
      className="relative flex w-full shrink-0 items-center gap-4 overflow-hidden rounded-2xl border border-amber-200/80 bg-gradient-to-br from-amber-50 via-orange-50/60 to-white px-4 py-3.5 text-left shadow-sm transition-shadow hover:shadow-md dark:border-amber-500/30 dark:from-amber-500/10 dark:via-orange-500/5 dark:to-transparent sm:px-5"
      role="region"
      aria-label="Finish setting up your profile"
    >
      {/* Pulsing alert dot */}
      <span className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-100 ring-1 ring-amber-200 dark:bg-amber-500/15 dark:ring-amber-500/30">
        <span className="absolute -right-0.5 -top-0.5 flex h-3 w-3">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-500/70" />
          <span className="relative inline-flex h-3 w-3 rounded-full bg-rose-500 ring-2 ring-white dark:ring-[#0d1117]" />
        </span>
        <BadgeCheck className="h-5 w-5 text-amber-600 dark:text-amber-400" aria-hidden />
      </span>

      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
          Finish setting up your profile
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
          {items.map(({ icon: Icon, label, target }) => (
            <button
              key={label}
              type="button"
              onClick={() => onGoToProfile(target)}
              className="inline-flex items-center gap-1.5 rounded-full px-1 py-0.5 text-xs text-amber-800/90 transition-colors hover:bg-amber-100/80 hover:text-amber-950 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 dark:text-amber-200/80 dark:hover:bg-amber-500/15 dark:hover:text-amber-100"
            >
              <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
              {label}
            </button>
          ))}
        </div>
      </div>

      <button
        type="button"
        onClick={() => onGoToProfile(items[0]?.target)}
        className="hidden shrink-0 items-center gap-1.5 rounded-full bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-amber-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 sm:inline-flex dark:bg-amber-500 dark:hover:bg-amber-400 dark:text-amber-950"
      >
        Go to Profile
        <ArrowRight className="h-3.5 w-3.5" aria-hidden />
      </button>
      <ArrowRight className="h-4 w-4 shrink-0 text-amber-600 sm:hidden dark:text-amber-400" aria-hidden />
    </motion.div>
  );
}
