# syntax=docker/dockerfile:1
FROM node:22-alpine AS base
WORKDIR /repo
RUN corepack enable

FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/archive/package.json packages/archive/package.json
COPY packages/map-schema/package.json packages/map-schema/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/map-publish/package.json packages/map-publish/package.json
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/domain packages/domain
COPY packages/database packages/database
COPY packages/archive packages/archive
COPY packages/map-schema packages/map-schema
COPY packages/protocol packages/protocol
COPY packages/map-publish packages/map-publish
COPY apps/api apps/api
RUN pnpm --filter @railway/domain run build \
  && pnpm --filter @railway/database run build \
  && pnpm --filter @railway/archive run build \
  && pnpm --filter @railway/map-schema run build \
  && pnpm --filter @railway/protocol run build \
  && pnpm --filter @railway/map-publish run build \
  && pnpm --filter @railway/api run build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /repo/pnpm-workspace.yaml /repo/package.json /repo/pnpm-lock.yaml ./
COPY --from=build /repo/packages/domain/package.json packages/domain/package.json
COPY --from=build /repo/packages/domain/dist packages/domain/dist
COPY --from=build /repo/packages/database/package.json packages/database/package.json
COPY --from=build /repo/packages/database/dist packages/database/dist
COPY --from=build /repo/packages/database/migrations packages/database/migrations
COPY --from=build /repo/packages/archive/package.json packages/archive/package.json
COPY --from=build /repo/packages/archive/dist packages/archive/dist
COPY --from=build /repo/packages/map-schema/package.json packages/map-schema/package.json
COPY --from=build /repo/packages/map-schema/dist packages/map-schema/dist
COPY --from=build /repo/packages/protocol/package.json packages/protocol/package.json
COPY --from=build /repo/packages/protocol/dist packages/protocol/dist
COPY --from=build /repo/packages/map-publish/package.json packages/map-publish/package.json
COPY --from=build /repo/packages/map-publish/dist packages/map-publish/dist
COPY --from=build /repo/apps/api/package.json apps/api/package.json
COPY --from=build /repo/apps/api/dist apps/api/dist
RUN pnpm install --frozen-lockfile --prod --filter @railway/api...

WORKDIR /repo/apps/api
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --retries=5 CMD ["node", "dist/healthcheck.js"]
CMD ["node", "dist/index.js"]
