# syntax=docker/dockerfile:1.7
#
# The WOLF dashboard, as Next.js's standalone server.
#
#   docker build -f infrastructure/docker/web.Dockerfile \
#     --build-arg NEXT_PUBLIC_WOLF_API_URL=https://api.amizhthan.app \
#     --build-arg NEXT_PUBLIC_WOLF_REALTIME_URL=wss://relay.amizhthan.app \
#     -t wolf/web .
#
# The two public addresses are build arguments because Next.js writes NEXT_PUBLIC_ values into the browser bundle
# and the security policy at build time. They are addresses, not secrets. WOLF_API_URL, the address the dashboard's
# own server uses to reach the API privately, is set at run time.

FROM node:22-bookworm-slim AS build
WORKDIR /repo

ARG NEXT_PUBLIC_WOLF_API_URL
ARG NEXT_PUBLIC_WOLF_REALTIME_URL
RUN test -n "$NEXT_PUBLIC_WOLF_API_URL" && test -n "$NEXT_PUBLIC_WOLF_REALTIME_URL" \
 || (echo "Set NEXT_PUBLIC_WOLF_API_URL and NEXT_PUBLIC_WOLF_REALTIME_URL" >&2 && exit 1)

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
COPY services ./services
COPY apps/web ./apps/web

RUN npm ci --no-audit --no-fund
# The dashboard's type check reads the packages' and services' declarations, so they are compiled first.
RUN npx tsc -b services/api services/realtime
ENV NEXT_TELEMETRY_DISABLED=1 WOLF_WEB_STANDALONE=1
RUN npm run build -w @wolf/web

FROM node:22-bookworm-slim
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app

COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /repo/apps/web/public ./apps/web/public

USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
