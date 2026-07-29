# syntax=docker/dockerfile:1.7

FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.7.0 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts

FROM deps AS build
COPY . .
RUN pnpm build

FROM base AS prod-deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

FROM base AS dev
ENV NODE_ENV=development
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY . .
EXPOSE 3000
CMD ["pnpm", "dev"]

FROM node:22-alpine AS runtime
RUN apk add --no-cache dumb-init wget
WORKDIR /app
ENV NODE_ENV=production \
    NODE_OPTIONS=--max-old-space-size=512
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=prod-deps --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/public ./public
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health/live || exit 1
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/main.js"]
