FROM node:20-alpine AS build

WORKDIR /app
ARG NPM_PROXY
ARG NPM_HTTPS_PROXY

COPY package*.json ./
RUN npm config set registry https://registry.npmmirror.com \
    && if [ -n "${NPM_PROXY:-}" ]; then npm config set proxy "$NPM_PROXY"; fi \
    && if [ -n "${NPM_HTTPS_PROXY:-}" ]; then npm config set https-proxy "$NPM_HTTPS_PROXY"; fi \
    && npm ci

COPY tsconfig.json ./
COPY *.ts ./
COPY scripts ./scripts
COPY migrations ./migrations

RUN npm run build

FROM node:20-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production
ARG NPM_PROXY
ARG NPM_HTTPS_PROXY

COPY package*.json ./
RUN npm config set registry https://registry.npmmirror.com \
    && if [ -n "${NPM_PROXY:-}" ]; then npm config set proxy "$NPM_PROXY"; fi \
    && if [ -n "${NPM_HTTPS_PROXY:-}" ]; then npm config set https-proxy "$NPM_HTTPS_PROXY"; fi \
    && npm ci --omit=dev \
    && npm config delete proxy \
    && npm config delete https-proxy \
    && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY --from=build /app/migrations ./migrations
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["./docker-entrypoint.sh"]
