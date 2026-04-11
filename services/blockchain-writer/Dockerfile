FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/types/package.json packages/types/
COPY packages/crypto/package.json packages/crypto/
COPY packages/telemetry-codec/package.json packages/telemetry-codec/
COPY packages/db/package.json packages/db/
COPY packages/logger/package.json packages/logger/
COPY services/blockchain-writer/package.json services/blockchain-writer/
RUN pnpm install --frozen-lockfile --prod=false

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY tsconfig.base.json ./
COPY packages/types packages/types
COPY packages/crypto packages/crypto
COPY packages/telemetry-codec packages/telemetry-codec
COPY packages/db packages/db
COPY packages/logger packages/logger
COPY services/blockchain-writer services/blockchain-writer
RUN pnpm -r --filter @airchive/blockchain-writer... run build

FROM base AS runner
ENV NODE_ENV=production
COPY --from=build /app/packages/types/dist packages/types/dist
COPY --from=build /app/packages/types/package.json packages/types/
COPY --from=build /app/packages/crypto/dist packages/crypto/dist
COPY --from=build /app/packages/crypto/package.json packages/crypto/
COPY --from=build /app/packages/telemetry-codec/dist packages/telemetry-codec/dist
COPY --from=build /app/packages/telemetry-codec/package.json packages/telemetry-codec/
COPY --from=build /app/packages/db/dist packages/db/dist
COPY --from=build /app/packages/db/package.json packages/db/
COPY --from=build /app/packages/logger/dist packages/logger/dist
COPY --from=build /app/packages/logger/package.json packages/logger/
COPY --from=build /app/services/blockchain-writer/dist services/blockchain-writer/dist
COPY --from=build /app/services/blockchain-writer/package.json services/blockchain-writer/
COPY --from=deps /app/node_modules ./node_modules
USER node
CMD ["node", "services/blockchain-writer/dist/index.js"]
