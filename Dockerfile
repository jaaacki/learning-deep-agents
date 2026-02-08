# syntax=docker/dockerfile:1

FROM node:24-slim AS base

# Install pnpm via corepack (bundled with Node 24+)
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# ── Install dependencies ────────────────────────────────────────────────────

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# ── Copy source ─────────────────────────────────────────────────────────────

COPY src/ src/
COPY tsconfig.json ./

# ── Runtime ─────────────────────────────────────────────────────────────────

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/health').then(r=>{if(!r.ok)throw r.status}).catch(()=>process.exit(1))"

CMD ["pnpm", "webhook"]
