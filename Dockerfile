FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.mjs ./
COPY src ./src
COPY policies ./policies
COPY public ./public
ENV NODE_ENV=production
EXPOSE 4200
CMD ["node", "server.mjs"]
