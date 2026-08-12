'use client';

import React from 'react';

/**
 * Small muted pill showing a payee's payroll department. Renders nothing when
 * there is no known department (e.g. MESA urgent payments, or a dispatch record
 * whose payee couldn't be resolved to one).
 *
 * Shared by the Pending worksheet (`ProcessorQueue`) and the dispatch-log views
 * (`PaidRecordsPanel`) so the same person's department reads identically on both
 * sides of a Mark Paid.
 */
export default function DeptChip({ name }: { name: string | null }) {
  if (!name) return null;
  return (
    <span
      className="inline-flex max-w-full items-center truncate rounded-full bg-zinc-100 px-1.5 py-0.5 text-[9.5px] font-medium uppercase tracking-wide text-zinc-500 dark:bg-zinc-800/70 dark:text-zinc-400"
      title={`Department: ${name}`}
    >
      {name}
    </span>
  );
}
