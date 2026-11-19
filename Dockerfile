# The homeserver portal, as static files served by nginx.
#
#   docker build -t homeserver-portal .
#   docker run -p 8080:8080 -e HOMESERVER_PUBLIC_KEY=<key> homeserver-portal

# The build output is plain files, the same on every architecture, so the
# build stage runs once on the build machine's own platform.
FROM --platform=$BUILDPLATFORM node:24-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . ./
RUN npm run build

FROM nginxinc/nginx-unprivileged:1.29-alpine
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY docker/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY docker/write-config.sh /docker-entrypoint.d/40-write-account-config.sh
COPY --from=builder /app/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget --quiet --tries=1 --spider http://127.0.0.1:8080/ || exit 1
