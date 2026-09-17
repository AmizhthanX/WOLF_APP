# syntax=docker/dockerfile:1.7
#
# The WOLF API and realtime service: one image, two commands. They share every package and the migrations, and
# shipping them together means a deploy can never run an API and a relay built from different commits.
#
#   docker build -f infrastructure/docker/server.Dockerfile -t wolf/server .
#
# Runs as the unprivileged `node` user. Carries no secret: configuration arrives as environment variables at run time.

FROM node:22-bookworm-slim AS build
WORKDIR /repo

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
COPY services ./services
# Declared as a workspace by the root package.json; npm refuses a lockfile whose workspaces are missing.
COPY apps/web/package.json ./apps/web/package.json

RUN npm ci --no-audit --no-fund
RUN npx tsc -b services/api services/realtime

# Only what runs: each workspace's package.json, its compiled output, and the migrations.
RUN mkdir /out \
 && cp package.json package-lock.json /out/ \
 && for dir in packages/* services/* apps/web; do \
      if [ -f "$dir/package.json" ]; then mkdir -p "/out/$dir" && cp "$dir/package.json" "/out/$dir/"; fi; \
    done \
 && for dir in packages/* services/api services/realtime; do \
      if [ -d "$dir/dist" ]; then cp -r "$dir/dist" "/out/$dir/"; fi; \
    done \
 && cp -r packages/server-core/migrations /out/packages/server-core/ \
 && find /out -name '*.test.js' -delete -o -name '*.test.d.ts' -delete -o -name '*.tsbuildinfo' -delete

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /repo

COPY --from=build /out ./
RUN npm ci --omit=dev --no-audit --no-fund --workspace @wolf/api --workspace @wolf/realtime \
 && npm cache clean --force

USER node
EXPOSE 8080
CMD ["node", "services/api/dist/server.js"]
