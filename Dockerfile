# Portable container image — deploy on any Node host (Fly.io, Railway, Koyeb, a VPS, etc.)
FROM node:22-alpine
WORKDIR /app
# run as the unprivileged `node` user. It owns /app because the server writes posts and rebuilds dist/ at runtime.
RUN chown node:node /app
USER node
COPY --chown=node:node package*.json ./
RUN npm ci
COPY --chown=node:node . .
RUN npm run build && mkdir -p /app/data
# accounts, comments and the session secret live in DATA_DIR — mount a volume there to keep them across redeploys:
#   docker run -p 8080:8080 -e ADMIN_PASSWORD=... -v secblog-data:/app/data <image>
ENV PORT=8080 DATA_DIR=/app/data
EXPOSE 8080
CMD ["node", "admin/server.js"]
