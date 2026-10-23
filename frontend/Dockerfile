# Development image: runs the Vite dev server (source is bind-mounted by docker-compose).
FROM node:22-alpine AS dev
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
EXPOSE 5173
CMD ["node_modules/.bin/vite", "--host", "0.0.0.0", "--port", "5173"]
