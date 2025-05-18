ARG BASE_IMAGE=node:22-alpine

FROM ${BASE_IMAGE} AS builder

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci --ignore-scripts

COPY . .

RUN npm run build


FROM ${BASE_IMAGE} AS runner

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci --omit=dev --ignore-scripts

COPY --from=builder /app/dist/scraper.js .

ENTRYPOINT ["node", "scraper.js"]

CMD ["--poll"]
