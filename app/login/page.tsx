'use client';

import { useRouter } from 'next/navigation';
import EmployeeLogin from '@/components/employee/EmployeeLogin';
import { Toaster } from '@/components/ui/sonner';
import {
  ACTIVE_VIEW_KEY,
  SESSION_EMAIL_KEY,
  VIEW_ROUTES,
  defaultViewFor,
  viewsForRoles,
  type Role,
} from '@/lib/rbac/views';

const SESSION_ROLE_KEY = 'employee_session_role';

export default function LoginPage() {
  const router = useRouter();

  const handleSuccess = async (email: string) => {
    let roles: Role[] = [];
    try {
      const res = await fetch(`/api/employee-roles?email=${encodeURIComponent(email)}`);
      const json = (await res.json()) as { rows?: { role: Role }[] };
      roles = (json.rows ?? []).map((r) => r.role);
    } catch {
      /* fall through to employee view */
    }

    const views = viewsForRoles(roles);
    const target = defaultViewFor(views);

    try {
      sessionStorage.setItem(SESSION_EMAIL_KEY, email);
      sessionStorage.setItem(SESSION_ROLE_KEY, target);
      sessionStorage.setItem(ACTIVE_VIEW_KEY, target);
    } catch {
      /* ignore */
    }

    const base = VIEW_ROUTES[target];
    const url = target === 'employee' ? `${base}?email=${encodeURIComponent(email)}` : base;
    router.push(url);
  };

  return (
    <>
      <EmployeeLogin onSuccess={handleSuccess} />
      <Toaster position="top-right" />
    </>
  );
}
