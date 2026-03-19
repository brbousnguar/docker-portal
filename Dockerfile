FROM node:24-alpine

WORKDIR /app

COPY package.json server.js ./
COPY public ./public

ENV PORT=3200
ENV APP_NAME=portal-brahim

EXPOSE 3200

CMD ["npm", "start"]
