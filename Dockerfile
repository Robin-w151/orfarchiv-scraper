ARG BASE_IMAGE=node:22-alpine

FROM ${BASE_IMAGE}

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci --omit=dev --ignore-scripts && cd node_modules/re2 && npm run install

COPY . .

ENTRYPOINT ["node", "--experimental-strip-types", "src/index.ts"]

CMD ["--poll"]
