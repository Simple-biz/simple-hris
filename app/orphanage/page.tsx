import { Suspense } from 'react';
import OrphanageApp from '@/components/orphanage/OrphanageApp';

function OrphanageFallback() {
  return (
    <div className="flex h-screen items-center justify-center bg-white dark:bg-[#0d1117]">
      <div
        className="h-8 w-8 animate-spin rounded-full border-2 border-pink-500 border-t-transparent"
        aria-hidden
      />
    </div>
  );
}

export default function OrphanagePage() {
  return (
    <Suspense fallback={<OrphanageFallback />}>
      <OrphanageApp />
    </Suspense>
  );
}
