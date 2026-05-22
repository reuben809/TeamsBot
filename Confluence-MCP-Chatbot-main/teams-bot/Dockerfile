# ---- Build stage ----
FROM node:20-alpine AS builder
WORKDIR /build

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ---- Production stage ----
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /build/dist ./dist

# Run as non-root user
RUN addgroup -S bot && adduser -S bot -G bot
USER bot

EXPOSE 3978
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD wget -qO- http://localhost:3978/health || exit 1

CMD ["node", "dist/index.js"]
