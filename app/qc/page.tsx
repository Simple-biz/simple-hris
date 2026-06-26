import { Suspense } from 'react';
import QCApp from '@/components/qc/QCApp';

function QcShellFallback() {
  return (
    <div className="flex h-screen items-center justify-center bg-white dark:bg-[#0d1117]">
      <div
        className="h-8 w-8 animate-spin rounded-full border-2 border-orange-500 border-t-transparent"
        aria-hidden
      />
    </div>
  );
}

export default function QcPage() {
  return (
    <Suspense fallback={<QcShellFallback />}>
      <QCApp />
    </Suspense>
  );
}
