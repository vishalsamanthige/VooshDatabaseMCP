FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Azure Container Apps sets PORT itself; src/config/index.js falls back to 3000.
EXPOSE 3000

CMD ["node", "index.js"]
