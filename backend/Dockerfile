FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force
COPY . .
EXPOSE 8080
USER node
CMD ["node", "dist/index.js"]  # Assumes built to dist