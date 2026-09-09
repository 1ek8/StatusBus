FROM oven/bun:1-slim AS builder

WORKDIR /app 

COPY ./apps/producer ./apps/producer
COPY ./packages/redisq ./packages/redisq
COPY ./packages/shared-types ./packages/shared-types

COPY package.json bun.lock ./

COPY apps/consumer/package.json ./apps/consumer/
COPY apps/fe/package.json ./apps/fe/
COPY apps/api/package.json ./apps/api/
COPY apps/tests/package.json ./apps/tests/

COPY packages/eslint-config/package.json ./packages/eslint-config/
COPY packages/store/package.json ./packages/store/
COPY packages/shared-types/package.json ./packages/shared-types/
COPY packages/typescript-config/package.json ./packages/typescript-config/

RUN bun install --frozen-lockfile --production

COPY turbo.json .
RUN cd ./apps/producer && bun run build

FROM builder AS runner

WORKDIR /app/apps/producer

EXPOSE 3001

ENV HOST=0.0.0.0
ENV PORT=3001

CMD [ "bun", "dist/index.js"]
