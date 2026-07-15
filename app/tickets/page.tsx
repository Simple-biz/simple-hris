import { Suspense } from 'react';
import TicketsBoard from '@/components/tickets/TicketsBoard';

function TicketsShellFallback() {
  return (
    <div className="flex h-screen items-center justify-center bg-[#0a0a0a]">
      <div
        className="h-8 w-8 animate-spin rounded-full border-2 border-red-600 border-t-transparent"
        aria-hidden
      />
    </div>
  );
}

export default function TicketsPage() {
  return (
    <Suspense fallback={<TicketsShellFallback />}>
      <TicketsBoard />
    </Suspense>
  );
}
