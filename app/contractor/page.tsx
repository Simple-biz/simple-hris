import { Suspense } from 'react';
import ContractorApp from '@/components/contractor/ContractorApp';

function ContractorShellFallback() {
  return (
    <div className="flex h-screen items-center justify-center bg-white dark:bg-[#0d1117]">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" aria-hidden />
    </div>
  );
}

export default function ContractorPage() {
  return (
    <Suspense fallback={<ContractorShellFallback />}>
      <ContractorApp />
    </Suspense>
  );
}
