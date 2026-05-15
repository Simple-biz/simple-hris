/**
 * NextAuth configuration for Simple HRIS.
 *
 * Strategy:
 *  - Google provider (company GCP project). Consent screen is Internal, so Google already
 *    filters to the @simple.biz Workspace — the `hd` param + signIn callback are belt-and-suspenders.
 *  - JWT session (stateless; no DB adapter needed because Supabase already holds the employee roster).
 *  - `/login` is our custom sign-in page.
 *
 * Env vars used:
 *  - GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET — OAuth 2.0 Web Client from the company GCP project.
 *  - NEXTAUTH_SECRET — session JWT signing secret.
 *  - NEXTAUTH_URL — canonical origin (local: http://localhost:3000, prod: https://simple-hris.vercel.app).
 */

import type { NextAuthOptions } from 'next-auth';
import GoogleProvider from 'next-auth/providers/google';
import {
  createSupabaseServerClient,
  createSupabaseServiceRoleClient,
} from '@/lib/supabase/server';
import { hasElevatedRole } from './elevated-roles';
import { getForceLogoutEpochFor } from './force-logout';

const ALLOWED_HD = 'simple.biz';

/**
 * Look up active role assignments for `email`. Uses service-role when available so RLS
 * can stay strict on the `employee_roles` table. Returns [] on any error — callers should
 * treat that as "no elevated access."
 */
async function fetchRolesForEmail(email: string): Promise<string[]> {
  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) return [];
  try {
    const { data, error } = await supabase
      .from('employee_roles')
      .select('role')
      .is('revoked_at', null)
      .ilike('work_email', email);
    if (error || !data) return [];
    return (data as { role: string }[]).map((r) => r.role);
  } catch {
    return [];
  }
}

/**
 * Persist the user's Google profile photo URL onto their `global_master_list` row so
 * roster surfaces (Rates & Profiles, payroll dispatch, etc.) can show their avatar
 * even when the viewer isn't them. Fire-and-forget — sign-in must not fail because
 * of a DB hiccup. Updates only when the URL has changed (cheap WHERE filter).
 *
 * Requires `references/seed_global_master_list_google_photo.sql` to have been run
 * (adds the `google_photo_url TEXT` column). When the column doesn't exist this
 * silently no-ops via the catch.
 */
async function persistGooglePhoto(workEmail: string, photoUrl: string): Promise<void> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return;
  try {
    await supabase
      .from('global_master_list')
      .update({ google_photo_url: photoUrl })
      .ilike('"Work Email"', workEmail)
      .neq('google_photo_url', photoUrl);
  } catch {
    /* swallow — sign-in path must not fail if the column/migration is missing */
  }
}

export const authOptions: NextAuthOptions = {
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID ?? '',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
      authorization: {
        params: {
          // Force the account chooser so switching between multiple Google accounts is easy.
          prompt: 'select_account',
          // Restrict to the company Workspace on the Google side as well.
          hd: ALLOWED_HD,
        },
      },
    }),
  ],
  session: { strategy: 'jwt' },
  pages: {
    signIn: '/login',
  },
  callbacks: {
    /**
     * Reject any account that isn't on the company Workspace. The Google consent screen
     * (Internal) should already prevent this, but we double-check here in case the GCP
     * project is later moved to External.
     */
    async signIn({ profile }) {
      // Google's OIDC profile exposes `hd` on Workspace accounts and `email_verified` on all.
      const hd = (profile as { hd?: string } | null)?.hd;
      const emailVerified = (profile as { email_verified?: boolean } | null)?.email_verified;
      if (!emailVerified) return false;
      if (hd !== ALLOWED_HD) return false;
      return true;
    },
    async jwt({ token, account, profile }) {
      // On first sign-in stash the Google hd claim + active Supabase roles so the middleware
      // and API routes can authorize from the JWT alone. Roles are re-fetched only on sign-in;
      // users need to sign out/in to pick up role changes (standard JWT tradeoff).
      if (account && profile) {
        token.hd = (profile as { hd?: string }).hd;
        const emailLower = (token.email ?? '').toString().trim().toLowerCase();
        const roles = emailLower ? await fetchRolesForEmail(emailLower) : [];
        (token as { roles?: string[] }).roles = roles;
        (token as { elevated?: boolean }).elevated = hasElevatedRole(roles);
        // NOTE: feature permissions are intentionally NOT stashed on the token.
        // Encoding a per-tab access map into the JWT pushes the session cookie
        // past Node's default 8 KB header limit once a user has 20+ entries
        // (request fails with 431). Surfaces that need per-tab gating
        // fetch /api/employee-feature-permissions?email=... directly.

        // Persist the Google profile photo URL so the rest of the org can see this
        // user's avatar in roster lists. Fire-and-forget — never block sign-in.
        const picture = (profile as { picture?: string | null }).picture;
        if (emailLower && picture) {
          void persistGooglePhoto(emailLower, picture);
        }
      }

      // Force-logout enforcement. Admins can revoke a user's session via
      // POST /api/auth/force-logout — this stamps a per-email timestamp in
      // app_settings. JWTs whose `iat` is before that stamp are wiped so the
      // session callback sees no email/roles, and the middleware redirects
      // to /login on the next request. Fresh sign-ins (newer `iat`) survive.
      const emailLower = (token.email ?? '').toString().trim().toLowerCase();
      if (emailLower) {
        try {
          const cutoff = await getForceLogoutEpochFor(emailLower);
          const issuedAt = typeof token.iat === 'number' ? token.iat : 0;
          if (cutoff != null && issuedAt > 0 && cutoff >= issuedAt) {
            return {};
          }
        } catch {
          /* never fail auth on force-logout lookup failure */
        }
      }

      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        const extra = session.user as typeof session.user & {
          hd?: string | null;
          roles?: string[];
          elevated?: boolean;
        };
        extra.hd = (token as { hd?: string }).hd ?? null;
        extra.roles = (token as { roles?: string[] }).roles ?? [];
        extra.elevated = (token as { elevated?: boolean }).elevated ?? false;
      }
      return session;
    },
  },
};
