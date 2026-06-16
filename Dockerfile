# Multi-stage build for the remote (HTTP/OAuth) BeeL MCP server.
# The bundle is self-contained (tsup noExternal), so the runtime image needs only
# dist/ + openapi/ + package.json — no node_modules.

FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV PORT=8787
WORKDIR /app
COPY package.json ./
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/openapi ./openapi
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
USER node
CMD ["node", "dist/serve-http.js"]
