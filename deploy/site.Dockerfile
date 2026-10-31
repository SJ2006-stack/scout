# Full Scout site with Chromium. Build from scout/ after `npm run build`:
#   docker build -f deploy/site.Dockerfile -t scout-site .
# Azure App Service on the Node zip stack cannot start Chromium. This image can.
# Do not bake BROWSER_PROFILE_KEY, API keys, or SCOUT_AGENT into the image.
# Set those as Azure application settings. SCOUT_AGENT stays different on each app.
FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
  && npx playwright-core install --with-deps chromium \
  && npm cache clean --force

COPY src ./src
COPY dist ./dist
COPY scout-landing ./scout-landing

ENV NODE_ENV=production
ENV SCOUT_CONTAINER=1
ENV BROWSER_WORKER_ENABLED=1
ENV BROWSER_HEADED=0
ENV BROWSER_STATE_DIR=/home/data/browser
ENV PORT=8080

EXPOSE 8080
STOPSIGNAL SIGTERM

CMD ["node", "--experimental-strip-types", "src/server/prod.ts"]
