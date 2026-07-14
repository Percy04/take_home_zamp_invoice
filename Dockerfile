FROM node:24.18.0-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24.18.0-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000 RUNTIME_DIR=/var/data/zamp PROVIDER_MODE=live
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/data ./data
EXPOSE 3000
CMD ["npm", "start"]
