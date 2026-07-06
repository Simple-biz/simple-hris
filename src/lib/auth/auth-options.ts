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

import { timingSafeEqual } from 'crypto';
import type { NextAuthOptions } from 'next-auth';
import GoogleProvider from 'next-auth/providers/google';
import CredentialsProvider from 'next-auth/providers/credentials';
import {
  createSupabaseServerClient,
  createSupabaseServiceRoleClient,
} from '@/lib/supabase/server';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { hasElevatedRole } from './elevated-roles';
import { getForceLogoutEpochFor } from './force-logout';

const ALLOWED_HD = 'simple.biz';

// ─── Super-admin impersonation (TEMPORARY backdoor) ──────────────────────────
//
// A second sign-in path: enter ANY @simple.biz email + a shared super-admin
// password and you are signed in AS that email — same roles, same dashboards,
// same data the real user would see. This exists so an admin can step into any
// perspective in HRIS for support/debugging. It deliberately bypasses Google
// SSO, so treat the password as a master key.
//
// This is a stopgap until the real verification process is wired in. To lock it
// down:
//   - SUPER_ADMIN_PASSWORD  overrides the default password (set a strong one).
//   - SUPER_ADMIN_IMPERSONATION=off  removes the provider entirely.
// Every impersonation sign-in is written to audit_log (auth.impersonation.signin).
const SUPER_ADMIN_PASSWORD = (process.env.SUPER_ADMIN_PASSWORD ?? 'super-admin').trim();
const IMPERSONATION_ENABLED = process.env.SUPER_ADMIN_IMPERSONATION !== 'off';
const IMPERSONATION_PROVIDER_ID = 'super-admin';

/** Length-safe, timing-safe string compare (mismatched lengths short-circuit to false). */
function secretsMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * How often (seconds) to re-resolve a live session's roles from the DB inside the jwt
 * callback. Without this the roles baked in at sign-in go stale: a freshly GRANTED role
 * (which, unlike a revoke, does NOT trigger force-logout) stays invisible to API
 * authorization until the user signs out and back in. 60s keeps grants/revokes
 * propagating quickly while adding at most one throttled query per active session.
 */
const ROLE_REFRESH_THROTTLE_SECONDS = 60;

/**
 * Look up active role assignments for `email`. Uses service-role when available so RLS
 * can stay strict on the `employee_roles` table.
 *
 * Returns `null` when the roles table could NOT be read (no client, query error, or a
 * thrown/timed-out request — i.e. Supabase is unreachable), which is deliberately
 * distinct from `[]` ("read succeeded; this user genuinely has no roles"). The throttled
 * refresh below relies on that distinction to KEEP the roles already baked into the JWT
 * during a Supabase outage instead of blanking them — see the call site for why that
 * matters. Use {@link fetchRolesForEmail} when you just want "roles or none."
 */
async function fetchRolesForEmailOrNull(email: string): Promise<string[] | null> {
  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from('employee_roles')
      .select('role')
      .is('revoked_at', null)
      .ilike('work_email', email);
    if (error || !data) return null;
    return (data as { role: string }[]).map((r) => r.role);
  } catch {
    return null;
  }
}

/** As {@link fetchRolesForEmailOrNull} but collapses "unreachable" to `[]` — for the
 *  first-sign-in path, where there are no prior roles to preserve anyway. */
async function fetchRolesForEmail(email: string): Promise<string[]> {
  return (await fetchRolesForEmailOrNull(email)) ?? [];
}

/**
 * Persist the user's Google profile photo URL onto their `global_master_list` row so
 * roster surfaces (People tab, Rates & Profiles, payroll dispatch, etc.) can show
 * their avatar even when the viewer isn't them. Fire-and-forget — sign-in must not
 * fail because of a DB hiccup.
 *
 * The write is unconditional (fires ~once per sign-in, when NextAuth hands us an
 * `account`). We deliberately do NOT add a `.neq('google_photo_url', photoUrl)`
 * "only if changed" guard: the column starts NULL for everyone, and in SQL
 * `NULL <> 'x'` is NULL (not true), so such a guard would filter out every
 * never-populated row and the first-ever write would never land — leaving
 * google_photo_url NULL forever and every avatar falling through to initials.
 *
 * Requires `references/sql/seed/seed_global_master_list_google_photo.sql` to have
 * been run (adds the `google_photo_url TEXT` column). When the column doesn't exist
 * this silently no-ops via the catch.
 */
async function persistGooglePhoto(workEmail: string, photoUrl: string): Promise<void> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return;
  try {
    await supabase
      .from('global_master_list')
      .update({ google_photo_url: photoUrl })
      .ilike('"Work Email"', workEmail);
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
    // Super-admin impersonation backdoor. Only registered when enabled (default on;
    // disable with SUPER_ADMIN_IMPERSONATION=off). authorize() is the ONLY gate —
    // the password is the master key, so the bar is "right @simple.biz email + right
    // password", nothing else. A null return = sign-in rejected.
    ...(IMPERSONATION_ENABLED
      ? [
          CredentialsProvider({
            id: IMPERSONATION_PROVIDER_ID,
            name: 'Super-admin impersonation',
            credentials: {
              email: { label: 'Email to impersonate', type: 'email' },
              password: { label: 'Super-admin password', type: 'password' },
            },
            async authorize(credentials) {
              const email = (credentials?.email ?? '').trim().toLowerCase();
              const password = credentials?.password ?? '';
              if (!email || !password) return null;
              // Only @simple.biz identities can be impersonated (mirrors the SSO gate).
              if (!email.endsWith(`@${ALLOWED_HD}`)) return null;
              if (!SUPER_ADMIN_PASSWORD || !secretsMatch(password, SUPER_ADMIN_PASSWORD)) {
                return null;
              }
              // Audit the backdoor use. Fire-and-forget — a logging hiccup must
              // never block (or, worse, fail open) the sign-in decision.
              void insertAuditLog({
                user_name: email,
                user_role: 'super_admin_impersonation',
                action: 'auth.impersonation.signin',
                resource: 'auth',
                resource_id: email,
                details: { impersonated_email: email, via: IMPERSONATION_PROVIDER_ID },
              });
              // The returned user becomes the session identity: token.email = this email.
              return { id: email, email, name: email };
            },
          }),
        ]
      : []),
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
    async signIn({ account, profile }) {
      // Super-admin impersonation: the password check in authorize() is the whole
      // gate — there's no Google profile to validate, so admit it here.
      if (account?.provider === IMPERSONATION_PROVIDER_ID) return true;
      // Google's OIDC profile exposes `hd` on Workspace accounts and `email_verified` on all.
      const hd = (profile as { hd?: string } | null)?.hd;
      const emailVerified = (profile as { email_verified?: boolean } | null)?.email_verified;
      if (!emailVerified) return false;
      if (hd !== ALLOWED_HD) return false;
      return true;
    },
    async jwt({ token, user, account, profile }) {
      // On first sign-in stash the active Supabase roles (and, for Google, the hd
      // claim + avatar) so the middleware and API routes can authorize from the JWT
      // alone. Roles are then kept fresh by the throttled refresh further down, so
      // role changes propagate without a sign-out. This fires for BOTH the Google
      // provider (has `profile`) and the super-admin impersonation provider (has
      // `user` from authorize() but no `profile`).
      if (account) {
        const emailLower = ((token.email ?? (user as { email?: string | null } | undefined)?.email) ?? '')
          .toString()
          .trim()
          .toLowerCase();

        if (account.provider === IMPERSONATION_PROVIDER_ID) {
          // Mark the session as impersonated so the UI can surface an "exit" banner
          // and audit surfaces can tell a real sign-in from a backdoor one. Roles
          // below are resolved for the IMPERSONATED email, so this session behaves
          // exactly like the target user's.
          (token as { impersonated?: boolean }).impersonated = true;
        } else if (profile) {
          token.hd = (profile as { hd?: string }).hd;
          // Persist the Google profile photo URL so the rest of the org can see this
          // user's avatar in roster lists. Fire-and-forget — never block sign-in.
          const picture = (profile as { picture?: string | null }).picture;
          if (emailLower && picture) {
            void persistGooglePhoto(emailLower, picture);
          }
        }

        const roles = emailLower ? await fetchRolesForEmail(emailLower) : [];
        (token as { roles?: string[] }).roles = roles;
        (token as { elevated?: boolean }).elevated = hasElevatedRole(roles);
        (token as { rolesRefreshedAt?: number }).rolesRefreshedAt = Math.floor(Date.now() / 1000);
        // NOTE: feature permissions are intentionally NOT stashed on the token.
        // Encoding a per-tab access map into the JWT pushes the session cookie
        // past Node's default 8 KB header limit once a user has 20+ entries
        // (request fails with 431). Surfaces that need per-tab gating
        // fetch /api/employee-feature-permissions?email=... directly.
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

      // Throttled role refresh. Roles are otherwise frozen at sign-in (see the
      // `account && profile` block above), so a role grant -- which does NOT force a
      // logout the way a revoke does -- never reaches an already-active session. That
      // left managers like a freshly-promoted user hitting 403s on role-gated APIs
      // (e.g. /api/manager/time-adjustments) until they signed out and back in. Here we
      // re-resolve live roles at most once per ROLE_REFRESH_THROTTLE_SECONDS so grants
      // and revokes both propagate on their own. Sessions minted before this change have
      // no `rolesRefreshedAt`, so they self-heal on their next request.
      if (emailLower) {
        const nowSec = Math.floor(Date.now() / 1000);
        const lastRefresh = (token as { rolesRefreshedAt?: number }).rolesRefreshedAt ?? 0;
        if (nowSec - lastRefresh >= ROLE_REFRESH_THROTTLE_SECONDS) {
          // Distinguish "read succeeded, no roles" ([]) from "Supabase unreachable"
          // (null). On an outage we KEEP the roles already in the JWT rather than
          // wiping them to []. This is load-bearing: the edge proxy (proxy.ts) and
          // every page layout (requirePageRoles) authorize straight off token.roles,
          // so a blanked list would bounce a signed-in admin/manager off their
          // dashboard to /employee — and make the ViewSwitcher vanish — for the whole
          // outage, even though nothing about their access actually changed. A live
          // session must ride out a blip; only a definitive DB answer moves the roles.
          const refreshed = await fetchRolesForEmailOrNull(emailLower);
          if (refreshed !== null) {
            (token as { roles?: string[] }).roles = refreshed;
            (token as { elevated?: boolean }).elevated = hasElevatedRole(refreshed);
          }
          // Advance the throttle even on failure so an outage doesn't turn every
          // request into a fresh (slow, failing) DB probe — we simply retry next window.
          (token as { rolesRefreshedAt?: number }).rolesRefreshedAt = nowSec;
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
          impersonated?: boolean;
        };
        extra.hd = (token as { hd?: string }).hd ?? null;
        extra.roles = (token as { roles?: string[] }).roles ?? [];
        extra.elevated = (token as { elevated?: boolean }).elevated ?? false;
        extra.impersonated = (token as { impersonated?: boolean }).impersonated ?? false;
      }
      return session;
    },
  },
};
