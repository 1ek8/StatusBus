FROM oven/bun:1-slim AS builder

WORKDIR /app 

COPY ./apps/api ./apps/api
COPY ./packages/store ./packages/store

COPY package.json bun.lock ./

COPY apps/consumer/package.json ./apps/consumer/
COPY apps/fe/package.json ./apps/fe/
COPY apps/producer/package.json ./apps/producer/
COPY apps/tests/package.json ./apps/tests/

COPY packages/eslint-config/package.json ./packages/eslint-config/
COPY packages/redisq/package.json ./packages/redisq/
COPY packages/shared-types/package.json ./packages/shared-types/
COPY packages/typescript-config/package.json ./packages/typescript-config/

# needed for prisma
RUN apt-get update -y && apt-get install -y openssl

COPY apps/api/.env .env

RUN bun install --frozen-lockfile --production
RUN bunx prisma generate --config=./packages/store/prisma.config.ts

COPY turbo.json .
RUN cd apps/api && bun run build

FROM builder AS runner

WORKDIR /app/apps/api

EXPOSE 3001

ENV HOST=0.0.0.0
ENV PORT=3001

CMD [ "bun", "dist/index.js"]


# FROM node:20-slim AS base
# WORKDIR /usr/src/app
# RUN npm install -g bun turbo
# RUN apt-get update -y && apt-get install -y openssl

# FROM base AS pruner
# COPY . .

# RUN turbo prune api --docker

# RUN rm -rf /usr/src/app/out/full/**/node_modules

# FROM base AS builder

# # Copy the pruned files from the pruner stage.
# COPY --from=pruner /usr/src/app/out/json/ ./

# COPY --from=pruner /usr/src/app/out/bun.lock ./bun.lock

# RUN bun install 

# COPY --from=pruner /usr/src/app/out/full/ ./

# RUN cd packages/store && bunx prisma generate

# RUN bun build ./apps/api/index.ts --outdir ./apps/api/dist --target=node

# FROM oven/bun:1.0-slim

# WORKDIR /usr/src/app

# # Copy only the necessary pruned manifests from the builder.
# COPY --from=builder /usr/src/app/package.json /usr/src/app/bun.lock ./
# COPY --from=builder /usr/src/app/apps/api/package.json ./apps/api/
# COPY --from=builder /usr/src/app/packages/store/package.json ./packages/store/

# # This will now succeed because the lockfile perfectly matches the pruned manifests.
# RUN bun install

# # Copy the compiled application code.
# COPY --from=builder /usr/src/app/apps/api/dist ./dist

# # Copy the generated Prisma client and schema.
# COPY --from=builder /usr/src/app/generated/client ./generated/client
# COPY --from=builder /usr/src/app/packages/store/prisma/schema.prisma ./prisma/

# EXPOSE 3001
# USER bun
# CMD ["bun", "dist/index.js"]

# ------------------------------------------------------------------------

# FROM oven/bun:1-alpine AS base

# RUN apk add --no-cache libc6-compat python3 make g++

# WORKDIR /app

# FROM base AS deps

# COPY package*.json ./
# COPY bun.lock ./
# COPY turbo.json ./

# #api needs db access only
# COPY apps/api/package*.json ./apps/api/
# COPY packages/store/package*.json ./packages/store/

# # not using --frozen-lockfile --production here, need to allow linux image to resolve bun.lock for linux version
# RUN bun install 

# FROM base AS builder

# # need to copy all dependencies for prisma client generation
# COPY --from=deps /app/node_modules ./node_modules

# # need shared-types and ts-config package code, maybe others too, so copying all packages for build step
# COPY apps/api ./apps/api
# COPY packages ./packages
# COPY turbo.json ./

# # some new prisma update with bun installs the prisma package not within the db sucdirectory's node_modules but within the root dir's nm folder within .bin, it seems
# RUN cd packages/store && bunx prisma generate

# RUN cd apps/api && bun run build

# # after the application has been built, --production removes devDependencies from node_modules, frozen lockfile ensures only devDependy packages are removed, leaving the others intact
# RUN bun install --production --frozen-lockfile

# FROM base AS runner

# WORKDIR /app

# # Cloud Run doesnt need it in GCP, this is apparently for local testing
# RUN wget https://dl.google.com/cloudsql/cloud_sql_proxy.linux.amd64 -O cloud_sql_proxy \
#     && chmod +x cloud_sql_proxy \
#     && mv cloud_sql_proxy /usr/local/bin/

# # # 1001 -> non-root gid/uid (1000 for root), -S -> create sys/usr group
# # RUN addgroup -S nodejs -g 1001
# # RUN adduser -S apiuser -u 1001

# # RUN chown -R nextjs:nodejs /app
# # USER nextjs

# RUN addgroup -g 1001 -S nodejs && \
#     adduser -S apiuser -u 1001 -G nodejs

# COPY --from=builder --chown=apiuser:nodejs /app/apps/api/dist ./apps/api/dist
# COPY --from=builder --chown=apiuser:nodejs /app/apps/api/package.json ./apps/api/
# COPY --from=builder --chown=apiuser:nodejs /app/node_modules ./node_modules
# COPY --from=builder --chown=apiuser:nodejs /app/packages ./packages

# USER apiuser
# EXPOSE 3001

# # trying this
# HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
#   CMD curl -f http://localhost:3001/health || exit 1

# CMD ["bun", "run", "apps/api/dist/index.js"]