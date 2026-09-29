# syntax=docker/dockerfile:1

# Base image is pinned by digest (multi-arch index) for reproducible builds;
# Dependabot keeps the tag and digest current.
ARG NODE_IMAGE=node:24-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6

# Frontend build. Output is static files, so it always runs on the build
# host's native platform (no emulation) regardless of the target architecture.
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY frontend/ ./
RUN npm run build

# Runtime image
FROM ${NODE_IMAGE} AS runtime

# hdhomerun_config CLI only; no compilers, curl or -dev packages.
RUN apt-get update \
    && apt-get install -y --no-install-recommends hdhomerun-config \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /app

# Production dependencies only, reproducible via the lockfile. The package
# managers are removed afterwards: they are not needed at runtime and only
# add attack surface and scanner noise.
COPY backend/package.json backend/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
       /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
       /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg

COPY backend/ ./
COPY --from=frontend-build /app/frontend/build ./public

# Application files stay root-owned and read-only to the runtime user.
USER 1000:1000

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/version').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

CMD ["node", "server.js"]
