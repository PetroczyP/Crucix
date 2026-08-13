FROM node:22-alpine

WORKDIR /app

# Copy package files first for better layer caching
COPY package*.json ./
RUN npm install --production

# Copy source
COPY . .

# Non-root user for the server process (CWE-250)
RUN apk add --no-cache su-exec \
 && addgroup -g 1001 crucix \
 && adduser -D -u 1001 -G crucix crucix \
 && mkdir -p /app/runs \
 && chown -R crucix:crucix /app

# NOTE: no `USER crucix` here. The entrypoint must start as root to align
# ownership of a mounted /app/runs, then drops to crucix via su-exec (R-11).
COPY --chmod=755 docker-entrypoint-wm.sh /usr/local/bin/docker-entrypoint-wm.sh
ENTRYPOINT ["docker-entrypoint-wm.sh"]

# Default port (override with -e PORT=xxxx)
EXPOSE 3117

# Health check
HEALTHCHECK --interval=60s --timeout=10s --retries=3 \
  CMD wget -qO- http://localhost:${PORT:-3117}/api/health || exit 1

CMD ["node", "server.mjs"]
