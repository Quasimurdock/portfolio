# ---------- build the SPA ----------
# Node is still needed here, but only to build the front end: Vite is the
# toolchain. The API itself does not run on Node any more.
FROM node:22-slim AS build
WORKDIR /app

# Manifests first: `npm ci` is then cached until a dependency actually changes.
# The repo's .npmrc is copied too, so the install comes from the same registry
# mirror (the public registry is unreachable from some networks).
COPY package.json package-lock.json .npmrc ./
COPY web/package.json ./web/
COPY server/package.json ./server/
RUN npm ci --no-fund --no-audit

COPY . .
RUN npm --workspace web run build

# Drop the front-end toolchain before it reaches the runtime image. Deno only
# needs the runtime dependencies (express, zod, pg) to resolve from node_modules.
# `better-sqlite3` is gone, so there is no native addon and no prebuilt binary to
# worry about any more.
RUN npm prune --omit=dev

# ---------- run ----------
# Deno, not Node. The data layer uses `node:sqlite`, which Deno has built in
# (>= 2.2) but Node only gained in 22.5 — and Node 20 was the old base image, so
# it would fail at boot with ERR_UNKNOWN_BUILTIN_MODULE.
FROM denoland/deno:2.6.7 AS runtime

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

# The probe is a file rather than an inline `deno eval` so it can be run and
# verified outside a container build (`deno run --allow-net --allow-env scripts/healthcheck.mjs`).
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["deno", "run", "--allow-net", "--allow-env", "scripts/healthcheck.mjs"]

ENTRYPOINT ["/usr/local/bin/entrypoint"]
