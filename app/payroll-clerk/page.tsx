import { Suspense } from 'react';
import PayrollClerkApp from '@/components/payroll-clerk/PayrollClerkApp';

function PayrollClerkShellFallback() {
  return (
    <div className="flex h-screen items-center justify-center bg-white dark:bg-[#0d1117]">
      <div
        className="h-8 w-8 animate-spin rounded-full border-2 border-orange-500 border-t-transparent"
        aria-hidden
      />
    </div>
  );
}

export default function PayrollClerkPage() {
  return (
    <Suspense fallback={<PayrollClerkShellFallback />}>
      <PayrollClerkApp />
    </Suspense>
  );
}
