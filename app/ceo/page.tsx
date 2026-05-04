import { Suspense } from 'react';
import CeoApp from '@/components/ceo/CeoApp';

function Fallback() {
  return (
    <div className="flex h-screen items-center justify-center bg-white dark:bg-[#0d1117]">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-yellow-500 border-t-transparent" aria-hidden />
    </div>
  );
}

export default function CeoPage() {
  return (
    <Suspense fallback={<Fallback />}>
      <CeoApp />
    </Suspense>
  );
}
