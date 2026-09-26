# ORF Archiv Scraper

[![GitHub Actions Workflow Status](https://img.shields.io/github/actions/workflow/status/Robin-w151/orfarchiv-scraper/ci.yaml?branch=main&style=for-the-badge&label=CI)](https://github.com/Robin-w151/orfarchiv-scraper/actions/workflows/ci.yaml)
![GitHub package.json version](https://img.shields.io/github/package-json/v/Robin-w151/orfarchiv-scraper?style=for-the-badge)
[![GitHub License](https://img.shields.io/github/license/Robin-w151/orfarchiv?style=for-the-badge&color=blue)](https://github.com/Robin-w151/orfarchiv-scraper/blob/main/LICENSE)

ORF Archiv Scraper is a _NodeJS_ application, which fetches and persists ORF News Stories from multiple
[RSS feeds](https://rss.orf.at).

## RSS feeds

- [News](https://rss.orf.at/news.xml)
- [Sport](https://rss.orf.at/sport.xml)
- [Help](https://rss.orf.at/help.xml)
- [Science](https://rss.orf.at/science.xml)
- [OE3](https://rss.orf.at/oe3.xml)
- [FM4](https://rss.orf.at/fm4.xml)
- [Österreich](https://rss.orf.at/oesterreich.xml)
- [Burgenland](https://rss.orf.at/burgenland.xml)
- [Wien](https://rss.orf.at/wien.xml)
- [Niederösterreich](https://rss.orf.at/noe.xml)
- [Oberösterreich](https://rss.orf.at/ooe.xml)
- [Salzburg](https://rss.orf.at/salzburg.xml)
- [Steiermark](https://rss.orf.at/steiermark.xml)
- [Kärnten](https://rss.orf.at/kaernten.xml)
- [Tirol](https://rss.orf.at/tirol.xml)
- [Vorarlberg](https://rss.orf.at/vorarlberg.xml)

## Local Development

### Prerequisites

1. Clone with `git clone --recursive` or run `git submodule update --init --recursive` in an existing clone
2. Start and configure a local _MongoDB_ document store (more [info](../db/README.md))
3. Install _NodeJS_ and _npm_

### Run scraper

1. _Optionally_: create _.env.local_ (copy from _.env_ file) and override the database targets (see below)
2. `npm install`
3. `npm start -- scrape`

`scrape` fetches every RSS feed and persists the stories to every database target. New stories are inserted, stories
whose title, category or URL changed are updated. Title embeddings are computed once per run and written to all
targets.

```bash
npm start -- scrape                                  # scrape once
npm start -- scrape --poll                           # scrape every minute until interrupted
npm start -- scrape --poll --cron "0 0 * * * *"      # scrape every hour
npm start -- scrape --target orfarchiv-db-2          # only write to one target
npm start -- targets                                 # list the configured target labels
```

| Flag       | Default       | Description                                    |
| ---------- | ------------- | ---------------------------------------------- |
| `--poll`   | off           | Keep scraping on the `--cron` schedule         |
| `--cron`   | `0 * * * * *` | Polling interval in cron syntax (with seconds) |
| `--target` | all           | Only write to the target with this label       |
| `--debug`  | off           | Show debug logs                                |

- **Database targets:** **ORFARCHIV_DB_URLS** lists one connection URL per line or separated by `;`, highest priority
  first. If it is unset, **ORFARCHIV_DB_URL** is used as the only target (default: `mongodb://localhost`). Both
  variables also accept a `_FILE` suffix pointing to a file with the value. A target's label is its `host[:port]`,
  without credentials.
- **Devcontainer:** _.env_ points to `orfarchiv-db-1` and `orfarchiv-db-2`. When running on the host, override
  **ORFARCHIV_DB_URLS** in _.env.local_ with `localhost:27017` and `localhost:27018`.
- **Failures:** a target that cannot be reached or written to is logged and skipped, and the other targets still get
  their writes. A run fails only if every target failed. Each target has a 1-minute timeout per step, each run a
  5-minute timeout.
- **Embeddings:** if the embedding server fails, stories are stored without an embedding; use
  [backfill-embeddings](#backfill-embeddings) to fill them in later.

### Backfill embeddings

`scrape` stores each story's title embedding next to the story. If the embedding server is unreachable or rejects a
request, the stories are still stored, just without an embedding. `backfill-embeddings` fills in those gaps: it finds
stories with a non-empty title and no `titleEmbedding`, newest first, embeds them in batches and writes the vectors back.

```bash
npm start -- backfill-embeddings                              # every target, until nothing is missing
npm start -- backfill-embeddings --max-docs 1000              # at most 1000 stories per target
npm start -- backfill-embeddings --target orfarchiv-db-2      # only one target, e.g. a newly added one
```

| Flag           | Default  | Description                              |
| -------------- | -------- | ---------------------------------------- |
| `--batch-size` | `100`    | Stories per batch                        |
| `--max-docs`   | no limit | Stop after this many stories per target  |
| `--target`     | all      | Only backfill the target with this label |
| `--debug`      | off      | Show debug logs                          |

- **Embedding server:** requires **ORFARCHIV_EMBEDDING_URL**; **ORFARCHIV_EMBEDDING_TOKEN** is optional.
  Requests are paced by **ORFARCHIV_EMBEDDING_RATE_LIMIT** titles per **ORFARCHIV_EMBEDDING_RATE_WINDOW**
  (default: 1000 per `1 minute`).
- **Multiple targets:** targets from **ORFARCHIV_DB_URLS** are processed one after another. A title missing on several
  targets is embedded only once. A target that fails is logged and skipped; the run fails only if every target failed.
  `npm start -- targets` lists the available labels.

### Dependency overrides

`bson` is pinned to `7.2.0` in the `overrides` block of _package.json_. Without the pin, `npm start` fails immediately
with:

```text
NotImplementedError: node:v8 isBuildingSnapshot is not yet implemented in Bun.
    at node_modules/bson/lib/bson.cjs
    at node_modules/mongodb/lib/index.js
```

`bson` 7.3.0 started calling `v8` `startupSnapshot.isBuildingSnapshot()` while initializing `ObjectId`. _Bun_ defines
that function but throws when it is called, so importing `mongodb` crashes before any application code runs. `npm start`
and [run.sh](./run.sh) use _Bun_, so they are affected; `npm test` and `npm run build` use _NodeJS_ and are not, which is
why CI stays green either way.

This will not be fixed on the `bson` side — [mongodb/js-bson#903](https://github.com/mongodb/js-bson/pull/903) proposed a
guard and was declined as too runtime-specific. The real fix is
[oven-sh/bun#32502](https://github.com/oven-sh/bun/pull/32502), which is merged but not yet in a release
([oven-sh/bun#32501](https://github.com/oven-sh/bun/issues/32501) has the background).

**Remove the pin** once a _Bun_ release newer than `1.3.14` ships that fix, then let `bson` follow `mongodb` again. Until
then the pin holds `bson` a few patch releases behind.
