import { Context, Effect, Layer, Result } from 'effect';
import { sources } from '../sources';
import { Database, type BackfillOptions } from './database';
import { Scraper } from './scraper';

const SCRAPE_TIMEOUT = '5 minutes';

export class Command extends Context.Service<Command>()('Command', {
  make: Effect.gen(function* () {
    const scraper = yield* Scraper;
    const database = yield* Database;
    return defineService({ scraper, database });
  }),
}) {
  static readonly layerWithoutDependencies = Layer.effect(this, this.make);
  static readonly layer = this.layerWithoutDependencies.pipe(
    Layer.provide(Scraper.layer),
    Layer.provide(Database.layer),
  );
}

function defineService({ scraper, database }: { scraper: typeof Scraper.Service; database: typeof Database.Service }) {
  function scrapeNews() {
    return Effect.gen(function* () {
      const stories = (yield* Effect.all(
        sources.map((source) =>
          Effect.gen(function* () {
            const stories = yield* scraper.scrapeOrfNews(source.rssUrl, source.source).pipe(Effect.result);
            if (Result.isFailure(stories)) {
              yield* Effect.logWarning(
                `Failed to scrape stories for source '${source.source}': ${stories.failure.message}`,
              );
            } else {
              return stories.success;
            }
          }).pipe(Effect.withLogSpan(source.source)),
        ),
        { concurrency: 'unbounded' },
      ).pipe(Effect.withLogSpan('scraper')))
        .flat()
        .filter((stories) => !!stories);

      yield* database.persistOrfNews(stories).pipe(Effect.withLogSpan('persist'));
    }).pipe(Effect.timeout(SCRAPE_TIMEOUT));
  }

  function backfillEmbeddings(options: BackfillOptions) {
    return database.backfillEmbeddings(options).pipe(Effect.withLogSpan('backfill'));
  }

  return {
    scrapeNews,
    backfillEmbeddings,
  };
}
