# The runner service (apps/runner, docs/design/runner.md §10.1). Run it on the dedicated runner
# host with the Docker socket mounted and the socket's group added (`--group-add`): the socket
# is root-equivalent on that host, which is acceptable only because the host runs nothing else.
FROM node:22.23.3-bookworm-slim
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/runner/package.json apps/runner/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
COPY packages/ui/package.json packages/ui/
COPY e2e/package.json e2e/
RUN pnpm install --frozen-lockfile --filter @parallax/runner...
COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY apps/runner apps/runner
ENV NODE_ENV=production
USER node
CMD ["pnpm","--filter","@parallax/runner","start"]
