FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
COPY api/package.json api/package.json
COPY shared/package.json shared/package.json
COPY frontend/package.json frontend/package.json
COPY agents/package.json agents/package.json
COPY ingestion/package.json ingestion/package.json
RUN npm ci
COPY shared shared
COPY api api
COPY frontend frontend
COPY public public
RUN npm --workspace shared run build && npm --workspace frontend run build && npm --workspace api run build
CMD ["node", "api/dist/server.js"]
