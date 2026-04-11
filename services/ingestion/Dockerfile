FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/types/package.json packages/types/
COPY packages/logger/package.json packages/logger/
COPY packages/airports/package.json packages/airports/
COPY packages/flight-phase/package.json packages/flight-phase/
COPY services/ingestion/package.json services/ingestion/
RUN pnpm install --frozen-lockfile --prod=false

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/types/node_modules ./packages/types/node_modules
COPY --from=deps /app/packages/logger/node_modules ./packages/logger/node_modules
COPY --from=deps /app/services/ingestion/node_modules ./services/ingestion/node_modules
COPY tsconfig.base.json ./
COPY packages/types packages/types
COPY packages/logger packages/logger
COPY packages/airports packages/airports
COPY packages/flight-phase packages/flight-phase
COPY services/ingestion services/ingestion
RUN pnpm -r --filter @airchive/ingestion... run build

FROM base AS runner
ENV NODE_ENV=production
COPY --from=build /app/packages/types/dist packages/types/dist
COPY --from=build /app/packages/types/package.json packages/types/
COPY --from=build /app/packages/logger/dist packages/logger/dist
COPY --from=build /app/packages/logger/package.json packages/logger/
COPY --from=build /app/packages/airports/dist packages/airports/dist
COPY --from=build /app/packages/airports/data packages/airports/data
COPY --from=build /app/packages/airports/package.json packages/airports/
COPY --from=build /app/packages/flight-phase/dist packages/flight-phase/dist
COPY --from=build /app/packages/flight-phase/package.json packages/flight-phase/
COPY --from=build /app/services/ingestion/dist services/ingestion/dist
COPY --from=build /app/services/ingestion/package.json services/ingestion/
COPY --from=deps /app/node_modules ./node_modules
USER node
CMD ["node", "services/ingestion/dist/index.js"]
