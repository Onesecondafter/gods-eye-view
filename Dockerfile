# God's Eye View — hosted (Vite dev server + authenticating reverse proxy).
# The app's live-data proxies are Vite dev middlewares, so we run the dev
# server for real; server.mjs puts Basic Auth in front of it.

FROM node:24-bookworm-slim

# git + build tools: some deps (sharp, esbuild) fetch/compile on install.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first for layer caching.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# App source.
COPY . .

# Render provides $PORT; default for local runs.
ENV PORT=4173
ENV INNER_PORT=5199
ENV NODE_ENV=development
EXPOSE 4173

CMD ["node", "server.mjs"]
