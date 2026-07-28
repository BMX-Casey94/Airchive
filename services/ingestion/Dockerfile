FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/types/package.json packages/types/
COPY packages/logger/package.json packages/logger/
COPY packages/airports/package.json packages/airports/
COPY packages/flight-phase/package.json packages/flight-phase/
# Ingestion persists flight sessions and aircraft config, so @airchive/db is a
# real dependency — omitting it here made the lockfile install incomplete.
COPY packages/db/package.json packages/db/
COPY services/ingestion/package.json services/ingestion/
RUN pnpm install --frozen-lockfile --prod=false

FROM base AS build
# The workspace manifests are needed here too, otherwise `pnpm -r --filter`
# below has no workspace root to resolve the filter against.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/types packages/types
COPY packages/logger packages/logger
COPY packages/airports packages/airports
COPY packages/flight-phase packages/flight-phase
COPY packages/db packages/db
COPY services/ingestion services/ingestion
# pnpm links each package's binaries into that package's own node_modules/.bin,
# so the root tree alone leaves `tsc` unresolvable inside every workspace
# package.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/types/node_modules packages/types/node_modules
COPY --from=deps /app/packages/logger/node_modules packages/logger/node_modules
COPY --from=deps /app/packages/airports/node_modules packages/airports/node_modules
COPY --from=deps /app/packages/flight-phase/node_modules packages/flight-phase/node_modules
COPY --from=deps /app/packages/db/node_modules packages/db/node_modules
COPY --from=deps /app/services/ingestion/node_modules services/ingestion/node_modules
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
COPY --from=build /app/packages/db/dist packages/db/dist
COPY --from=build /app/packages/db/package.json packages/db/
COPY --from=build /app/services/ingestion/dist services/ingestion/dist
COPY --from=build /app/services/ingestion/package.json services/ingestion/
COPY --from=deps /app/node_modules ./node_modules
# pnpm keeps each project's runtime dependencies in that project's own
# node_modules as relative symlinks into /app/node_modules/.pnpm, so the
# per-project link farms have to come across or nothing resolves at runtime.
COPY --from=deps /app/packages/types/node_modules packages/types/node_modules
COPY --from=deps /app/packages/logger/node_modules packages/logger/node_modules
COPY --from=deps /app/packages/airports/node_modules packages/airports/node_modules
COPY --from=deps /app/packages/flight-phase/node_modules packages/flight-phase/node_modules
COPY --from=deps /app/packages/db/node_modules packages/db/node_modules
COPY --from=deps /app/services/ingestion/node_modules services/ingestion/node_modules
COPY deploy/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
# Entrypoint starts as root so it can read Docker's 0400 secret mounts, then
# drops to `node` via su-exec before the service process starts.
RUN apk add --no-cache su-exec \
  && chmod 0755 /usr/local/bin/docker-entrypoint.sh
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "services/ingestion/dist/index.js"]
