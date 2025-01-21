FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci --omit=dev --ignore-scripts && cd node_modules/re2 && npm run install

COPY . .

ENTRYPOINT ["node", "src"]

CMD ["--poll"]
