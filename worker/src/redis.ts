import { Redis } from "ioredis";

import { IoredisAdapter, type RedisLike } from "@/lib/redis";

import { createLogger } from "./log";

const log = createLogger("worker:redis");

/**
 * Worker-side Redis client wrapped in the same RedisLike adapter the Next
 * app uses. Unlike the Next-side singleton (which falls back to in-memory
 * when REDIS_URL is unset), the worker hard-requires REDIS_URL: cross-process
 * state lives in Redis and the worker is useless without it.
 */

let rawClient: Redis | null = null;
let client: RedisLike | null = null;

export function getRedis(): RedisLike {
  if (client) return client;
  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error(
      "[worker:redis] REDIS_URL is not set. Start Redis (`npm run docker:up`) and put REDIS_URL in .env.local.",
    );
  }
  rawClient = new Redis(url, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: false,
  });
  rawClient.on("error", (err) => log.error("redis error", err.message));
  rawClient.on("connect", () => log.info("connected"));
  rawClient.on("reconnecting", (delay: number) => log.warn("reconnecting", { delay }));
  client = new IoredisAdapter(rawClient);
  return client;
}

export async function closeRedis(): Promise<void> {
  if (!rawClient) return;
  try {
    await rawClient.quit();
  } catch (err) {
    log.warn("quit failed, forcing disconnect", { err: (err as Error).message });
    rawClient.disconnect();
  }
  rawClient = null;
  client = null;
}
