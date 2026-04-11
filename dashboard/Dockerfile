FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY dashboard/package.json dashboard/
RUN pnpm install --frozen-lockfile --filter @airchive/dashboard...

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/dashboard/node_modules ./dashboard/node_modules
COPY tsconfig.base.json ./
COPY dashboard ./dashboard
ENV NEXT_TELEMETRY_DISABLED=1
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
