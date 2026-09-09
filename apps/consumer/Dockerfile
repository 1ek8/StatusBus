FROM oven/bun:1-slim AS builder

WORKDIR /app 

COPY apps/consumer/ ./apps/consumer/
COPY ./packages/redisq ./packages/redisq
COPY ./packages/shared-types ./packages/shared-types

COPY package.json bun.lock ./

COPY apps/producer/package.json ./apps/producer/
COPY apps/api/package.json ./apps/api/
COPY apps/fe/package.json ./apps/fe/
COPY apps/tests/package.json ./apps/tests/

COPY packages/eslint-config/package.json ./packages/eslint-config/
COPY packages/store/package.json ./packages/store/
COPY packages/shared-types/package.json ./packages/shared-types/
COPY packages/typescript-config/package.json ./packages/typescript-config/

RUN bun install --frozen-lockfile --production

COPY turbo.json .
RUN cd ./apps/consumer && bun run build

FROM builder AS runner

WORKDIR /app/apps/consumer

EXPOSE 3001

ENV REGION_ID=1
ENV CONSUMER_ID=india-consumer-1

CMD [ "bun", "dist/index.js"]
