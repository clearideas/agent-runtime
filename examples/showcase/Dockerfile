FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 bubblewrap util-linux ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/showcase
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY server.ts doctor.ts ./
COPY lib ./lib
COPY demos ./demos
COPY public ./public
ENV SHOWCASE_HOST=0.0.0.0 SHOWCASE_PORT=4178 \
    SHOWCASE_SANDBOX=bubblewrap SHOWCASE_REQUIRE_ISOLATION=1 \
    SHOWCASE_DATA=/data/showcase SHOWCASE_SESSIONS=1 SHOWCASE_MAX_ACTIVE_RUNS=1
EXPOSE 4178
CMD ["node", "server.ts"]
