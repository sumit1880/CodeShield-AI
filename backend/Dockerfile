FROM node:20-slim AS base

# Install Python and pip because Semgrep requires Python
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Install Semgrep and verify it is actually runnable on PATH at build time
# (fails the build loudly instead of silently shipping an image without it).
# Installed system-wide (as root, during build) so it stays on PATH and
# readable/executable by the non-root runtime user created below.
RUN pip3 install --break-system-packages --no-cache-dir semgrep \
    && semgrep --version

WORKDIR /app

# Install Node dependencies
COPY package*.json ./
RUN npm ci

# Copy application
COPY . .

# Generate Prisma client
RUN npx prisma generate

# Build TypeScript
RUN npm run build

# Drop dev dependencies now that the build output exists, to shrink the
# final image and reduce the dependency/attack surface at runtime.
RUN npm prune --omit=dev

# Production
ENV NODE_ENV=production

# Run as a dedicated, unprivileged user instead of root. Semgrep and its
# Python packages were installed system-wide above (world-readable/executable
# by default), so this user can still invoke `semgrep` via execFile; it just
# can't write outside directories explicitly granted to it.
RUN groupadd --system appgroup \
    && useradd --system --gid appgroup --home-dir /app --shell /usr/sbin/nologin appuser \
    && chown -R appuser:appgroup /app

USER appuser

EXPOSE 3000

CMD ["node", "dist/server.js"]
