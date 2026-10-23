# ---- dev: used by docker-compose (source is bind-mounted for live reload) ----
FROM node:22-alpine AS dev
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ENV NODE_ENV=development
EXPOSE 4000
# Apply pending migrations, insert any missing development products (idempotent),
# then start the API with live reload.
# `exec` makes the API process receive SIGTERM directly for graceful shutdown.
CMD ["sh", "-c", "node_modules/.bin/tsx src/db/cli/migrate.ts && node_modules/.bin/tsx src/db/cli/seed.ts && exec node_modules/.bin/tsx watch src/server.ts"]

# ---- build: compile TypeScript ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- prod: small runtime image with compiled JS and production deps only ----
FROM node:22-alpine AS prod
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
USER node
EXPOSE 4000
CMD ["sh", "-c", "node dist/db/cli/migrate.js && exec node dist/server.js"]
