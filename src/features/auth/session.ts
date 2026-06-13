import "server-only";

import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";
import { getPrisma } from "@/lib/prisma";

/**
 * Returns the authenticated user's id. The proxy already prevents anonymous
 * access to protected routes, but this helper makes that guarantee explicit
 * inside server functions and server actions (which also run after a session
 * can have been revoked).
 */
export async function requireUserId(): Promise<string> {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/login");
  }
  return session.user.id;
}

export interface CurrentUser {
  id: string;
  email: string;
  name: string | null;
  setting: {
    theme: string;
    defaultPair: "BTC" | "ETH" | "SOL";
    hasApiKeys: boolean;
  };
}

export async function getCurrentUser(): Promise<CurrentUser> {
  const id = await requireUserId();
  const prisma = getPrisma();
  const user = await prisma.user.findUnique({
    where: { id },
    select: {
      id: true,
      email: true,
      name: true,
      setting: {
        select: { theme: true, defaultPair: true, apiKeysEncrypted: true },
      },
    },
  });
  if (!user) redirect("/login");

  // Lazily create UserSetting on first read for accounts that pre-date the
  // signup flow that creates it eagerly (e.g. seeded data, migrations).
  const setting =
    user.setting ??
    (await prisma.userSetting.create({
      data: { userId: id },
      select: { theme: true, defaultPair: true, apiKeysEncrypted: true },
    }));

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    setting: {
      theme: setting.theme,
      defaultPair: setting.defaultPair,
      hasApiKeys: Boolean(setting.apiKeysEncrypted),
    },
  };
}
