FROM node:22-slim

WORKDIR /app

COPY package.json ./

RUN npm install --omit=dev

COPY . .

CMD ["node", "qorb_dip_live_v7.js"]
