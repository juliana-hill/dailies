FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
COPY api/package.json api/package.json
COPY frontend/package.json frontend/package.json
COPY shared/package.json shared/package.json
COPY agents/package.json agents/package.json
COPY ingestion/package.json ingestion/package.json
RUN npm ci
COPY shared shared
COPY ingestion ingestion
RUN npm --workspace shared run build && npm --workspace ingestion run build
CMD ["node", "ingestion/dist/server.js"]
