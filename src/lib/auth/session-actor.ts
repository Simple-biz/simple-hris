import 'server-only';

import { getServerSession } from 'next-auth/next';
import { authOptions } from './auth-options';

/**
 * Returns { user_name, user_role } for audit logging — sourced from the
 * NextAuth JWT (zero extra DB round-trips). Use this in every API route
 * instead of hardcoding a user name or role.
 */
export async function getSessionActor(): Promise<{ user_name: string; user_role: string }> {
  try {
    const session = await getServerSession(authOptions);
    const user = session?.user as { email?: string | null; roles?: string[] } | undefined;
    const email = user?.email?.trim().toLowerCase();
    if (!email) return { user_name: 'anonymous', user_role: 'user' };
    const roles: string[] = user?.roles ?? [];
    return { user_name: email, user_role: roles[0] ?? 'user' };
  } catch {
    return { user_name: 'anonymous', user_role: 'user' };
  }
}
