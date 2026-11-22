FROM node:22-alpine
WORKDIR /app
COPY www ./www
COPY server ./server
ENV NODE_ENV=production PORT=3000 TRUST_PROXY=1
EXPOSE 3000
USER node
CMD ["node", "server/server.js"]
