import "server-only";

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

type GlobalForPrisma = typeof globalThis & {
  __prisma?: PrismaClient;
};

const globalForPrisma = globalThis as GlobalForPrisma;

function buildClient(): PrismaClient {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "[prisma] DATABASE_URL is not set. Add it to .env.local (see .env.example) or start the database with `docker compose up -d`.",
    );
  }
  const adapter = new PrismaPg(process.env.DATABASE_URL);
  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });
}

export function getPrisma(): PrismaClient {
  if (globalForPrisma.__prisma) return globalForPrisma.__prisma;
  const client = buildClient();
  if (process.env.NODE_ENV !== "production") {
    globalForPrisma.__prisma = client;
  }
  return client;
}
