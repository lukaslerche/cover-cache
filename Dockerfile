FROM node:24-alpine

WORKDIR /app

# Keep in step with packageManager in package.json.
RUN npm i -g pnpm@11.22.0

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

COPY src ./src

ENV IMAGE_DIR=/images \
    PORT=9228

EXPOSE 9228
HEALTHCHECK --interval=60s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://localhost:9228/health || exit 1

CMD ["node", "src/server.ts"]
