# ---------- build the SPA ----------
FROM node:20-slim AS build
WORKDIR /app

# Manifests first: `npm ci` is then cached until a dependency actually changes.
# The repo's .npmrc is copied too, so the install (and better-sqlite3's prebuilt
# binary) comes from the same registry mirror.
COPY package.json package-lock.json .npmrc ./
COPY web/package.json ./web/
COPY server/package.json ./server/
RUN npm ci --no-fund --no-audit

COPY . .
RUN npm --workspace web run build

# ---------- run ----------
FROM node:20-slim AS runtime

# Debian (not Alpine) on purpose: better-sqlite3 ships prebuilt binaries for
# glibc, so this image needs no compiler toolchain.
ENV NODE_ENV=production \
    PORT=8787 \
    DATABASE_FILE=/data/app.db \
    STATIC_DIR=/app/web/dist

WORKDIR /app

# workspaces hoist every dependency to the root node_modules, so one copy is enough
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/package-lock.json ./package-lock.json
COPY --from=build /app/server ./server
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/web/package.json ./web/package.json
COPY --from=build /app/web/dist ./web/dist

COPY deploy/entrypoint.sh /usr/local/bin/entrypoint
RUN chmod +x /usr/local/bin/entrypoint && mkdir -p /data

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/entrypoint"]
