import { config as loadEnv } from "dotenv";

import { defineConfig } from "prisma/config";

// Match Next.js precedence: `.env.local` wins, then `.env`. dotenv is
// first-write-wins, so list the higher-priority file first.
loadEnv({ path: [".env.local", ".env"], quiet: true });

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env.DATABASE_URL ?? "",
  },
});
