FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY dashboard/package.json dashboard/
# postinstall runs copy-cesium-assets.mjs, so the scripts tree must exist
# before pnpm install — package.json alone is not enough.
COPY dashboard/scripts dashboard/scripts
RUN pnpm install --frozen-lockfile --filter @airchive/dashboard...

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/dashboard/node_modules ./dashboard/node_modules
COPY tsconfig.base.json ./
COPY dashboard ./dashboard

# NEXT_PUBLIC_* values are inlined into the browser bundle at build time, so
# they must be supplied here rather than at runtime. Behind the nginx proxy
# these should be same-origin (https://<host> and wss://<host>/ws).
ARG NEXT_PUBLIC_GATEWAY_URL=http://localhost:4000
ARG NEXT_PUBLIC_WS_URL=ws://localhost:4001
ARG NEXT_PUBLIC_CESIUM_ION_TOKEN=""
ENV NEXT_PUBLIC_GATEWAY_URL=$NEXT_PUBLIC_GATEWAY_URL
ENV NEXT_PUBLIC_WS_URL=$NEXT_PUBLIC_WS_URL
ENV NEXT_PUBLIC_CESIUM_ION_TOKEN=$NEXT_PUBLIC_CESIUM_ION_TOKEN
ENV NEXT_TELEMETRY_DISABLED=1
# next.config.ts only emits the standalone server when this is set, and the
# runner stage copies exactly that output.
ENV NEXT_OUTPUT=standalone
RUN pnpm --filter @airchive/dashboard run build

FROM base AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 airchive \
  && adduser --system --uid 1001 --ingroup airchive airchive

COPY --from=build /app/dashboard/public ./dashboard/public
COPY --from=build /app/dashboard/.next/standalone ./
COPY --from=build /app/dashboard/.next/static ./dashboard/.next/static

USER airchive
WORKDIR /app
EXPOSE 3000
CMD ["node", "dashboard/server.js"]
