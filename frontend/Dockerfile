FROM node:20-slim AS build
WORKDIR /app
COPY package*.json ./
COPY api/package.json api/package.json
COPY shared/package.json shared/package.json
COPY frontend/package.json frontend/package.json
COPY agents/package.json agents/package.json
COPY ingestion/package.json ingestion/package.json
RUN npm ci
COPY public public
COPY shared shared
COPY frontend frontend
RUN npm --workspace shared run build && npm --workspace frontend run build
FROM nginx:1.27-alpine
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/frontend/dist /usr/share/nginx/html/studio
EXPOSE 8080
