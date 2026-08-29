# God's Eye View — LEAN hosted image.
# Builds the app to dist/ AT CONTAINER START (so Render's env vars are present
# for vite.config.js's `define:` block), then serves it with server-lean.mjs —
# a slim Express server that reuses this project's own /api/* proxy plugins.
# No Vite dev server at runtime -> fits the $7 / 512 MB plan.

FROM node:24-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Chromium isn't needed (puppeteer is only used by dev scripts).
ENV PUPPETEER_SKIP_DOWNLOAD=true

# Install deps first for layer caching. Dev deps are needed at build time (vite).
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .

ENV PORT=4173
ENV NODE_ENV=production
EXPOSE 4173

# Build then serve. `npm run build` bakes GOOGLE_MAPS_API_KEY (from the Render
# env) into the bundle; server-lean.mjs then serves dist/ + the live proxies.
CMD ["sh", "-c", "npm run build && node server-lean.mjs"]
