FROM node:20-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
COPY api/package.json api/package.json
COPY frontend/package.json frontend/package.json
COPY shared/package.json shared/package.json
COPY agents/package.json agents/package.json
COPY ingestion/package.json ingestion/package.json
RUN npm ci
COPY shared shared
COPY agents agents
RUN npm --workspace shared run build && npm --workspace agents run build
CMD ["node", "agents/dist/server.js"]
