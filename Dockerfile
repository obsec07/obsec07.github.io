# Portable container image — deploy on any Node host (Fly.io, Railway, Koyeb, a VPS, etc.)
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build
ENV PORT=8080
EXPOSE 8080
CMD ["node", "admin/server.js"]
