import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

import { createLogger } from "./log";

const log = createLogger("worker:db");

let client: PrismaClient | null = null;

export function getPrisma(): PrismaClient {
  if (client) return client;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "[worker:db] DATABASE_URL is not set. See .env.example and `npm run docker:up`.",
    );
  }
  const adapter = new PrismaPg(url);
  client = new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "production" ? ["error"] : ["warn", "error"],
  });
  log.info("prisma client ready");
  return client;
}

export async function closePrisma(): Promise<void> {
  if (!client) return;
  try {
    await client.$disconnect();
  } catch (err) {
    log.warn("disconnect failed", { err: (err as Error).message });
  }
  client = null;
}
