FROM oven/bun:1-slim AS builder

WORKDIR /app

COPY package.json bun.lock turbo.json ./

COPY apps/api ./apps/api
COPY apps/producer/package.json ./apps/producer/
COPY apps/consumer/package.json ./apps/consumer/
COPY apps/fe/package.json ./apps/fe/
COPY apps/tests/package.json ./apps/tests/

COPY packages/store ./packages/store
COPY packages/redisq/package.json ./packages/redisq/
COPY packages/shared-types/package.json ./packages/shared-types/
COPY packages/eslint-config/package.json ./packages/eslint-config/
COPY packages/typescript-config/package.json ./packages/typescript-config/

# openssl is required by the generated Prisma client
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*

# Placeholder only — `bunx prisma generate` never connects to the database
ENV DATABASE_URL=postgresql://placeholder:placeholder@localhost:5432/statusbus?schema=public

RUN bun install --frozen-lockfile

# Prisma 7 keeps its config in packages/store; pass it explicitly because
# `bunx prisma` only auto-detects prisma.config.ts from the workspace root.
RUN bunx --bun prisma generate --config=packages/store/prisma.config.ts

RUN cd apps/api && bun run build

RUN bun install --frozen-lockfile --production

FROM builder AS runner

WORKDIR /app/apps/api

EXPOSE 3001

ENV HOST=0.0.0.0
ENV PORT=3001

CMD [ "bun", "dist/index.js" ]