# Chromium host for the Scout browser worker.
# Build from scout/ after `npm run build`:
#   docker build -f deploy/browser-worker.Dockerfile -t scout-browser .
# The existing Azure zip deploy does not use this image.
FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
  && npx playwright-core install --with-deps chromium \
  && npm cache clean --force

COPY src ./src
COPY dist ./dist

ENV NODE_ENV=production
ENV SCOUT_ROLE=browser
ENV BROWSER_WORKER_ENABLED=1
ENV BROWSER_HEADED=0
ENV BROWSER_STATE_DIR=/data/browser
ENV PORT=8080

VOLUME ["/data"]
EXPOSE 8080
STOPSIGNAL SIGTERM

CMD ["node", "--experimental-strip-types", "src/server/prod.ts"]
