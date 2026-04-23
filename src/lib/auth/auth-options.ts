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

const ALLOWED_HD = 'simple.biz';

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
      // On first sign-in stash the Google hd claim so the middleware can trust the JWT alone.
      if (account && profile) {
        token.hd = (profile as { hd?: string }).hd;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        (session.user as typeof session.user & { hd?: string | null }).hd =
          (token as { hd?: string }).hd ?? null;
      }
      return session;
    },
  },
};
