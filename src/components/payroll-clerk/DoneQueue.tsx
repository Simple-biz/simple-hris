'use client';

import React from 'react';
import { ClipboardCheck } from 'lucide-react';
import type { PaymentDispatchRow } from '@/lib/supabase/payment-dispatches';
import PaidRecordsPanel from './PaidRecordsPanel';

interface DoneQueueProps {
  /** Every dispatch row for the current cycle (any status). */
  records: PaymentDispatchRow[];
  periodStart?: string | null;
  periodEnd?: string | null;
  /** Silent re-pull after a send-back, to reconcile the pending queue. */
  onRefresh: () => void | Promise<void>;
}

export default function DoneQueue({
  records,
  periodStart,
  periodEnd,
  onRefresh,
}: DoneQueueProps) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Title banner */}
      <div className="shrink-0 border-b border-[#ececec] bg-white px-4 pt-3 pb-2 sm:px-6 sm:pt-5 dark:border-zinc-800 dark:bg-zinc-950">
        <h1 className="inline-flex items-center gap-2 text-base font-semibold tracking-tight text-zinc-900 sm:text-xl dark:text-white">
          <ClipboardCheck className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
          Done
        </h1>
        <p className="mt-1 text-xs text-[#71717a] dark:text-zinc-500">
          Every payment paid this cycle and ready for Reports. Tick rows and use
          <span className="font-medium text-amber-700 dark:text-amber-300"> Undo selected </span>
          to send a batch back to their pay processors as pending.
        </p>
      </div>

      <div className="min-h-0 flex-1">
        <PaidRecordsPanel
          records={records}
          periodStart={periodStart}
          periodEnd={periodEnd}
          onRefresh={onRefresh}
          showProcessorColumn
          csvPrefix="done"
        />
      </div>
    </div>
  );
}
