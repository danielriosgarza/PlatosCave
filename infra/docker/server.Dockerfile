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
ENV NODE_ENV=production STATIC_DIR=/app/apps/web/dist HOST=0.0.0.0 PORT=3000
USER node
CMD ["pnpm","--filter","@parallax/server","start"]
