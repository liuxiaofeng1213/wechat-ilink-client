FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
COPY bridge/package.json bridge/package-lock.json bridge/tsconfig.json ./bridge/
COPY bridge/src ./bridge/src

RUN npm ci
RUN npm run build

WORKDIR /app/bridge
RUN npm ci
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/bridge/package.json ./bridge/package.json
COPY --from=builder /app/bridge/node_modules ./bridge/node_modules
COPY --from=builder /app/bridge/dist ./bridge/dist

WORKDIR /app/bridge
EXPOSE 4000

CMD ["npm", "run", "start"]
