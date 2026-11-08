# Both stages share one base, so the builder installs native packages for the runtime's libc
FROM node:26.13.0-trixie-slim@sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072 AS node-builder

ENV NEXT_DOCKER=1

WORKDIR /build

# Node 25+ ships no Corepack: install the exact pnpm that packageManager in package.json names
COPY package.json ./
RUN npm install -g "$(node -p "require('./package.json').packageManager.split('+')[0]")"

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY tsconfig*.json ./
COPY config/ ./config/
COPY packages/ ./packages/
COPY apps/ ./apps/

RUN pnpm install --frozen-lockfile

RUN pnpm run build:packages

# Type checking is disabled for this build via next.config.js
RUN pnpm --filter @spotify-to-plex/web run build

# Swap the dev install for the sync worker's production dependencies only: the web app
# already carries its own in the standalone output, and the jobs run TypeScript through tsx
RUN set -e; \
    rm -rf node_modules apps/*/node_modules packages/*/node_modules; \
    pnpm install --frozen-lockfile --prod --offline --filter "@spotify-to-plex/sync-worker..."; \
    # pnpm 12 writes its install-state file owner-only; the runtime never runs pnpm
    rm -f node_modules/.pnpm-workspace-state*.json; \
    # A context checked out under umask 002 is group-writable; normalise here, where the layer is thrown away
    chmod -R go-w /build

# Runtime: Node.js for the web app and sync worker, Python for the scraper, supervisord for all three
FROM node:26.13.0-trixie-slim@sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072 AS production

# Referenced by the apt layer so a refresh build re-runs the upgrade instead of reusing a cached one
ARG BUILD_DATE

LABEL net.unraid.docker.icon="https://raw.githubusercontent.com/chodeus/spotify-to-plex/testing/apps/web/public/img/logo.png"

ENV TZ=UTC \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    NODE_ENV=production \
    PYTHONPATH=/app/apps/spotify-scraper \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=9030 \
    HOSTNAME=0.0.0.0 \
    PLEX_APP_ID=eXf+f9ktw3CZ8i45OY468WxriOCtoFxuNPzVeDcAwfw= \
    SPOTIFY_SCRAPER_URL=http://localhost:3020 \
    STORAGE_DIR=/app/config \
    PUID=99 \
    PGID=100 \
    UMASK=002

RUN echo "packages as of ${BUILD_DATE}" && \
    apt-get update && \
    apt-get upgrade -y && \
    apt-get install -y --no-install-recommends \
        curl ca-certificates tzdata \
        python3 python3-venv \
        supervisor && \
    rm -rf /var/lib/apt/lists/*

# The jobs run through tsx, so the runtime ships no package manager, and none of their dependencies
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-v*

# The programs run as this user; the entrypoint moves it to PUID/PGID. gid 100 is already "users" here
RUN groupadd -o -g 100 app \
    && useradd -o -u 99 -g 100 -M -d /nonexistent -s /usr/sbin/nologin app

RUN mkdir -p /app/config /var/log/supervisor

RUN --mount=type=bind,source=apps/spotify-scraper/requirements.txt,target=/tmp/requirements.txt \
    python3 -m venv /opt/scraper-venv \
    && /opt/scraper-venv/bin/pip install --no-cache-dir -r /tmp/requirements.txt \
    && /opt/scraper-venv/bin/python -c "from spotify_scraper import SpotifyClient; print('SpotifyScraper installed successfully')" \
    # Nothing installs at runtime, so the venv's own pip is only attack surface
    && /opt/scraper-venv/bin/pip uninstall -y -q pip

# From the builder, whose copy has normalised modes
COPY --from=node-builder /build/apps/spotify-scraper/ /app/apps/spotify-scraper/
# Compiled here so the scraper never writes __pycache__ into a directory it does not own
RUN /opt/scraper-venv/bin/python -m compileall -q /app/apps/spotify-scraper

COPY --from=node-builder /build/apps/sync-worker/src/ /app/apps/sync-worker/src/
COPY --from=node-builder /build/apps/sync-worker/package.json /app/apps/sync-worker/
COPY --from=node-builder /build/apps/sync-worker/tsconfig.production.json /app/apps/sync-worker/tsconfig.json
COPY --from=node-builder /build/apps/sync-worker/node_modules/ /app/apps/sync-worker/node_modules/
COPY --from=node-builder /build/node_modules/ /app/node_modules/
COPY --from=node-builder /build/packages/ /app/packages/

# Next.js with distDir "dist" puts the standalone server in dist/standalone/
COPY --from=node-builder /build/apps/web/dist/standalone/ /app/web/
COPY --from=node-builder /build/apps/web/dist/static/ /app/web/apps/web/dist/static/
COPY --from=node-builder /build/apps/web/public/ /app/web/apps/web/public/

COPY supervisor/supervisord.conf /etc/supervisor/conf.d/supervisord.conf
COPY docker-entrypoint.sh /docker-entrypoint.sh

# The app runs as a non-root user, so everything it runs must be readable by it and none of it writable
RUN set -e; \
    chmod 755 /docker-entrypoint.sh; \
    unreadable="$(find /app /opt/scraper-venv \( -type f ! -perm -0004 \) -o \( -type d ! -perm -0005 \) | head -20)"; \
    if [ -n "$unreadable" ]; then echo "not world-readable:"; echo "$unreadable"; exit 1; fi; \
    writable="$(find /app /opt/scraper-venv -xdev -path /app/config -prune -o ! -type l \( -perm /022 -o ! -user root \) -print -quit)"; \
    if [ -n "$writable" ]; then echo "writable by non-root:"; echo "$writable"; exit 1; fi

WORKDIR /app

# 9030: web app; 3020: scraper (internal)
EXPOSE 9030 3020

VOLUME ["/app/config"]

# Shell form, so a PORT set at run time is the one checked
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -fs "http://localhost:${PORT:-9030}/" > /dev/null || exit 1

ENTRYPOINT ["/docker-entrypoint.sh"]

CMD ["supervisord", "-n", "-c", "/etc/supervisor/conf.d/supervisord.conf"]
