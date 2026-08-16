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

1. Start and configure a local _MongoDB_ document store (more [info](../db/README.md))
2. Install _NodeJS_ and _npm_

### Run scraper

1. _Optionally_: create _.env.local_ (copy from _.env_ file) and configure **ORFARCHIV_DB_URL** environment variable if
   your _MongoDB_ is not running on **mongodb://localhost:27017**
2. `npm install`
3. `npm start`

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
