# Multi-stage build for CodeShield-AI Backend
# Stage 1: Build & Dependencies
FROM node:22-slim AS builder

WORKDIR /app

COPY package*.json ./
COPY prisma ./prisma/

RUN npm ci
RUN npx prisma generate

COPY tsconfig.json ./
COPY src ./src/

RUN npm run build
RUN npm prune --omit=dev

# Stage 2: Production Runtime
FROM node:22-slim AS runner

# Install Python and pinned Semgrep
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    curl \
    && rm -rf /var/lib/apt/lists/*

RUN pip3 install --break-system-packages --no-cache-dir semgrep==1.90.0 \
    && semgrep --version

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

# Copy node_modules and built assets from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY package*.json ./
COPY semgrep-rules ./semgrep-rules

# Create non-root user
RUN groupadd --system appgroup \
    && useradd --system --gid appgroup --home-dir /app --shell /usr/sbin/nologin appuser \
    && chown -R appuser:appgroup /app

USER appuser

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3000/health/ready || exit 1

CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]

