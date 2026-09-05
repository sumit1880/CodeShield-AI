FROM node:20-slim AS base

# Install Python and pip because Semgrep requires Python
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Install Semgrep and verify it is actually runnable on PATH at build time
# (fails the build loudly instead of silently shipping an image without it).
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

# Production
ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "dist/server.js"]