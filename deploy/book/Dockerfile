# FONDACO book server. Build context: repository root.
#   docker build -f deploy/book/Dockerfile -t fondaco-book .
# Base image pinned by digest (node 22.23.4, alpine 3.24). Runs as the unprivileged "node" user; data in /data.
ARG NODE_IMAGE=node:22.23.4-alpine3.24@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914

FROM ${NODE_IMAGE} AS build
WORKDIR /src
# pnpm at the exact version of package.json "packageManager" (corepack)
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile --filter @fondaco/book-server... --filter fondaco \
 && pnpm --filter @fondaco/contracts build && pnpm --filter @fondaco/book-server build \
 && pnpm --filter @fondaco/book-server deploy --prod --legacy /out \
 && rm -rf /out/test /out/src

FROM ${NODE_IMAGE}
ARG VERSION=dev
LABEL org.opencontainers.image.title="fondaco-book" \
      org.opencontainers.image.description="FONDACO book server (off-chain order book for AirSwap SwapERC20 v4.3)" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}"
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out /app
RUN mkdir -p /data /config && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --retries=4 CMD wget -qO- http://127.0.0.1:8080/health >/dev/null || exit 1
ENTRYPOINT ["node", "--no-warnings=ExperimentalWarning"]
CMD ["dist/index.js", "/config/book.json"]
