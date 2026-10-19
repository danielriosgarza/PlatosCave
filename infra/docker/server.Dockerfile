FROM node:22.23.3-bookworm-slim
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
COPY packages/ui/package.json packages/ui/
COPY e2e/package.json e2e/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @parallax/web build
# With STORAGE_DRIVER=fs the objects are kept here; a volume mounted on it starts owned by node.
RUN install -d -o node -g node /var/lib/parallax/storage
# The release's one version (docs/design/site.md §12), last, so the layers above stay cached.
ARG PARALLAX_VERSION=0.0.0
LABEL org.opencontainers.image.version="${PARALLAX_VERSION}"
ENV NODE_ENV=production STATIC_DIR=/app/apps/web/dist HOST=0.0.0.0 PORT=3000 \
    STORAGE_DIR=/var/lib/parallax/storage PARALLAX_VERSION=${PARALLAX_VERSION}
USER node
CMD ["pnpm","--filter","@parallax/server","start"]
