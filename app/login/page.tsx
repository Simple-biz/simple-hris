'use client';

import { useRouter } from 'next/navigation';
import EmployeeLogin, { type LoginRole } from '@/components/employee/EmployeeLogin';
import { Toaster } from '@/components/ui/sonner';

const SESSION_EMAIL_KEY = 'employee_session_email';
const SESSION_ROLE_KEY  = 'employee_session_role';

export default function LoginPage() {
  const router = useRouter();

  const handleSuccess = (email: string, role: LoginRole) => {
    try {
      sessionStorage.setItem(SESSION_EMAIL_KEY, email);
      sessionStorage.setItem(SESSION_ROLE_KEY, role);
    } catch {
      // ignore
    }
    router.push(
      role === 'accounting'
        ? '/'
        : `/employee?email=${encodeURIComponent(email)}`,
    );
  };

  return (
    <>
      <EmployeeLogin onSuccess={handleSuccess} />
      <Toaster position="top-right" />
    </>
  );
}
