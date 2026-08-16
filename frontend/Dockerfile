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
COPY public public
COPY frontend frontend
# Vite bakes VITE_* into the static bundle at build time, so this must be a build arg,
# not a runtime `environment:` entry in docker-compose.yml.
ARG VITE_API_BASE_URL
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
RUN npm --workspace shared run build && npm --workspace frontend run build
WORKDIR /app/frontend
CMD ["npx", "vite", "preview", "--host", "0.0.0.0", "--port", "8080"]
