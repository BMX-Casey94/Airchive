FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/types/package.json packages/types/
COPY packages/db/package.json packages/db/
COPY packages/logger/package.json packages/logger/
COPY services/agent-marketplace/package.json services/agent-marketplace/
RUN pnpm install --frozen-lockfile --prod=false

FROM base AS build
# The workspace manifests are needed here too, otherwise `pnpm -r --filter`
# below has no workspace root to resolve the filter against.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/types packages/types
COPY packages/db packages/db
COPY packages/logger packages/logger
COPY services/agent-marketplace services/agent-marketplace
# This repo ships no .dockerignore, so the source copies above can drag in the
# host's node_modules, compiled dist output and tsc caches. Clear them, so the
# Linux dependency trees from `deps` are authoritative and `tsc -b` cannot skip
# work on the strength of a stale tsbuildinfo.
RUN rm -rf node_modules packages/*/node_modules services/agent-marketplace/node_modules \
      packages/*/dist packages/*/*.tsbuildinfo \
      services/agent-marketplace/dist services/agent-marketplace/*.tsbuildinfo
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/types/node_modules packages/types/node_modules
COPY --from=deps /app/packages/db/node_modules packages/db/node_modules
COPY --from=deps /app/packages/logger/node_modules packages/logger/node_modules
COPY --from=deps /app/services/agent-marketplace/node_modules services/agent-marketplace/node_modules
RUN pnpm -r --filter @airchive/agent-marketplace... run build

FROM base AS runner
ENV NODE_ENV=production
COPY --from=build /app/packages/types/dist packages/types/dist
COPY --from=build /app/packages/types/package.json packages/types/
COPY --from=build /app/packages/db/dist packages/db/dist
COPY --from=build /app/packages/db/package.json packages/db/
COPY --from=build /app/packages/logger/dist packages/logger/dist
COPY --from=build /app/packages/logger/package.json packages/logger/
COPY --from=build /app/services/agent-marketplace/dist services/agent-marketplace/dist
COPY --from=build /app/services/agent-marketplace/package.json services/agent-marketplace/
COPY --from=deps /app/node_modules ./node_modules
# pnpm keeps each project's runtime dependencies in that project's own
# node_modules as relative symlinks into /app/node_modules/.pnpm, so the
# per-project link farms have to come across or nothing resolves at runtime.
COPY --from=deps /app/packages/types/node_modules packages/types/node_modules
COPY --from=deps /app/packages/db/node_modules packages/db/node_modules
COPY --from=deps /app/packages/logger/node_modules packages/logger/node_modules
COPY --from=deps /app/services/agent-marketplace/node_modules services/agent-marketplace/node_modules
COPY deploy/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh
USER node
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "services/agent-marketplace/dist/index.js"]
