import { Suspense } from 'react';
import HrApp from '@/components/hr/HrApp';

function Fallback() {
  return (
    <div className="flex h-screen items-center justify-center bg-white dark:bg-[#0d1117]">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" aria-hidden />
    </div>
  );
}

export default function HrPage() {
  return (
    <Suspense fallback={<Fallback />}>
      <HrApp />
    </Suspense>
  );
}
