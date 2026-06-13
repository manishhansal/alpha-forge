import "server-only";

import bcrypt from "bcryptjs";
import NextAuth, { type DefaultSession } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { z } from "zod";

import { env } from "@/lib/env";
import { getPrisma } from "@/lib/prisma";

/**
 * Auth.js v5 — Credentials provider with bcrypt password hashes.
 *
 * Notes:
 * - We use `session.strategy: "jwt"` because the Credentials provider only
 *   supports JWT sessions in v5 (no DB-session adapter integration). This also
 *   lets `proxy.ts` decode the session cookie without a DB round-trip.
 * - The Prisma adapter is intentionally NOT wired up: it's designed for OAuth
 *   flows (Account / Session / VerificationToken tables) which we don't have.
 *   Our `User` model is enough for credentials. Adding OAuth providers later
 *   only requires adding the adapter + those three tables.
 */

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
    } & DefaultSession["user"];
  }
  interface User {
    id: string;
  }
}

declare module "@auth/core/jwt" {
  interface JWT {
    uid?: string;
  }
}

const credentialsSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(8).max(128),
});

/**
 * Public pages that anonymous visitors can browse without signing in. The
 * rule is intentionally tight: only the two "showroom" surfaces (Market
 * Overview and Heatmap, per market) are public so search engines + curious
 * visitors get a meaningful taste of the product, while everything that
 * carries personalised state (alerts, journal, saved strategies, settings,
 * profile, scalper, signals board, options chain, scanner, watchlist,
 * charts, futures) stays behind a login wall.
 *
 * Each entry is matched as `pathname === entry` or
 * `pathname.startsWith(entry + "/")` so nested routes (e.g. `/heatmap/x`
 * for a future drill-down) inherit the same gate without a code change.
 */
const PUBLIC_PAGE_PATHS = [
  "/", // Crypto Overview
  "/heatmap", // Crypto Heatmap
  "/in", // Redirects to /in/dashboard
  "/in/dashboard", // India Overview
  "/in/heatmap", // India Heatmap
  "/login",
  "/signup",
  "/not-found",
  "/favicon.ico",
] as const;

/**
 * Public API prefixes — only routes that read public, exchange-side market
 * data with no per-user gating. We're deliberately *not* exposing alerts,
 * notifications, the strategy lab, the scalper journal or any of the
 * settings server actions — those carry per-user state that must stay
 * behind the JWT check.
 */
const PUBLIC_API_PREFIXES = [
  "/api/auth", // Auth.js's own callback routes
  "/api/futures/tickers", // public Delta / Binance market data
  "/api/futures/overview",
  "/api/market", // crypto overview aggregator
  "/api/sentiment", // Fear & Greed + funding sentiment
  "/api/signals", // quick signals card on the overview
  "/api/in", // every India route hits Yahoo / NSE / Groww public data
] as const;

function isPublicPagePath(pathname: string): boolean {
  for (const entry of PUBLIC_PAGE_PATHS) {
    if (pathname === entry) return true;
    if (pathname.startsWith(`${entry}/`)) return true;
  }
  return false;
}

function isPublicApiPath(pathname: string): boolean {
  for (const prefix of PUBLIC_API_PREFIXES) {
    if (pathname === prefix) return true;
    if (pathname.startsWith(`${prefix}/`)) return true;
  }
  return false;
}

export function isPublicPath(pathname: string): boolean {
  if (pathname.startsWith("/_next")) return true;
  if (isPublicApiPath(pathname)) return true;
  if (isPublicPagePath(pathname)) return true;
  return false;
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  // AUTH_SECRET is read from env at runtime by Auth.js when omitted, but
  // making it explicit keeps the failure mode loud at boot.
  secret: env.AUTH_SECRET,
  trustHost: env.AUTH_TRUST_HOST || env.NODE_ENV !== "production",
  session: { strategy: "jwt", maxAge: 60 * 60 * 24 * 7 },
  pages: { signIn: "/login" },
  providers: [
    Credentials({
      name: "credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      authorize: async (raw) => {
        const parsed = credentialsSchema.safeParse(raw);
        if (!parsed.success) return null;
        const { email, password } = parsed.data;
        const prisma = getPrisma();
        const user = await prisma.user.findUnique({
          where: { email: email.toLowerCase() },
          select: { id: true, email: true, name: true, image: true, passwordHash: true },
        });
        if (!user || !user.passwordHash) return null;
        const ok = await bcrypt.compare(password, user.passwordHash);
        if (!ok) return null;
        return { id: user.id, email: user.email, name: user.name, image: user.image };
      },
    }),
  ],
  callbacks: {
    jwt: async ({ token, user }) => {
      if (user) token.uid = user.id;
      return token;
    },
    session: async ({ session, token }) => {
      if (token.uid && session.user) {
        session.user.id = token.uid;
      }
      return session;
    },
    authorized: async ({ auth: session, request }) => {
      const { pathname } = request.nextUrl;
      if (isPublicPath(pathname)) return true;
      return Boolean(session?.user);
    },
  },
});
