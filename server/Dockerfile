# Sky back end with Chromium and bubblewrap, for any host that runs containers.
# Build from the repo root:  docker build -f server/Dockerfile -t sky .
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends bubblewrap ca-certificates git \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci --omit=dev
# Chromium for the Stars' browser, with the system libraries it needs.
RUN npx playwright-core install --with-deps chromium && rm -rf /var/lib/apt/lists/*

COPY server/ ./
COPY web/ /app/web/
RUN cd /app/web && npm ci && VITE_SKYS_API_URL= npm run build && rm -rf node_modules

ENV SKY_HOST=0.0.0.0 PORT=8787 SKY_DATA_DIR=/data
VOLUME /data
EXPOSE 8787
CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.ts"]
