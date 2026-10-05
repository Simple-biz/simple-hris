import { Suspense } from 'react';
import EmployeeApp from '@/components/employee/EmployeeApp';
import DashboardSwitchLoader from '@/components/common/DashboardSwitchLoader';
import { LOGIN_LOADER_EYEBROW, LOGIN_LOADER_STATUS_MESSAGES } from '@/lib/employee/login-loader';

/**
 * What a hard load paints before the shell exists: the same "Loading your
 * Employee Dashboard" card the shell then holds until the Overview is on screen
 * (docs/features/employee-login-loader.md) — not a bare spinner in between.
 */
function EmployeeShellFallback() {
  return (
    <DashboardSwitchLoader
      view="employee"
      eyebrow={LOGIN_LOADER_EYEBROW}
      statusMessages={LOGIN_LOADER_STATUS_MESSAGES}
    />
  );
}

export default function EmployeePage() {
  return (
    <Suspense fallback={<EmployeeShellFallback />}>
      <EmployeeApp />
    </Suspense>
  );
}
