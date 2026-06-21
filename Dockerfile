FROM node:20-alpine AS builder

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm ci

COPY tsconfig*.json ./
COPY src/ ./src/

RUN npm run build

# ---

FROM node:20-alpine AS runner

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /usr/src/app/dist ./dist

# Default env var paths (overridden by docker-compose environment section)
ENV SYNAPSE_ROOMS_CONFIG=/usr/src/app/synapse-rooms.json
ENV SYNAPSE_TOKEN_FILE=/data/synapse-token.json
ENV GOOGLE_CREDENTIALS_PATH=/data/google-sa.json

CMD ["node", "dist/main.js"]
