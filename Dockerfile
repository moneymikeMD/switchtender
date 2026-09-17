# switchtender HTTP service (CMB-12). Runs src/server.js on Cloud Run.
#
# The image holds the code and the committed Boston example config only.
# The real config.toml is gitignored, never copied here, and arrives at
# runtime as a Secret Manager volume (see docs/deploy.md). Every key comes
# from the environment. Nothing in this image is secret.

FROM node:24-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY config.example.toml ./

# Cloud Run sets PORT; the server defaults to 8080 when it is absent.
ENV PORT=8080
EXPOSE 8080

USER node
CMD ["node", "src/server.js"]
