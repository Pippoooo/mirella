# syntax=docker/dockerfile:1

# Build stage: install all deps and compile TypeScript
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Dev stage: all deps (incl. tsx); source is bind-mounted at runtime
# (compose.yaml targets this stage). Deliberately not the last stage —
# a plain `docker build` must produce the packaged app below.
FROM node:22-alpine AS dev
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
# Do NOT COPY src/ — it comes from the bind mount

# Runtime stage: production deps only, compiled output
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
CMD ["node", "dist/index.js"]