FROM node:22-slim AS base
WORKDIR /app

# Install openssl for Prisma
RUN apt-get update && apt-get install -y openssl curl && rm -rf /var/lib/apt/lists/*

# ─── Dependencies ──────────────────────────────────────────────────────────────
FROM base AS deps
COPY package*.json ./
COPY prisma ./prisma/
RUN npm ci --ignore-scripts
RUN npx prisma generate

# ─── Builder ──────────────────────────────────────────────────────────────────
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
COPY --from=deps /app/node_modules/.prisma ./node_modules/.prisma

# Skip tests during Docker build (they run in CI)
ENV SKIP_ENV_VALIDATION=1
ENV NEXT_TELEMETRY_DISABLED=1

RUN npm run build -- --no-lint 2>/dev/null || npm run build

# ─── Runner ───────────────────────────────────────────────────────────────────
FROM base AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
COPY --from=deps /app/node_modules/.prisma ./node_modules/.prisma

USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]
