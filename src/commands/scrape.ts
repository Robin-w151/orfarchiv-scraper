import { Cron, Effect, Option, Result, Schedule } from 'effect';
import { Command, Flag } from 'effect/unstable/cli';
import { Database } from '../services/database';
import { Scraper } from '../services/scraper';
import { Targets } from '../services/targets';
import { logCause } from '../shared/logger';
import { sources } from '../sources';
import { scraperCommand, withLogLevel } from './scraper';

const SCRAPE_TIMEOUT = '5 minutes';

export const scrapeCommand = Command.make(
  'scrape',
  {
    poll: Flag.boolean('poll').pipe(Flag.withDefault(false), Flag.withDescription('Keep polling for new stories')),
    cron: Flag.string('cron').pipe(
      Flag.withDefault('0 * * * * *'),
      Flag.mapTryCatch(
        (cron) => Cron.parseUnsafe(cron),
        (error) => `a valid cron expression (${error instanceof Error ? error.message : error})`,
      ),
      Flag.withDescription('Polling interval in cron syntax (default: 0 * * * * *, e.g. poll every minute)'),
    ),
  },
  ({ poll, cron }) =>
    Effect.gen(function* () {
      const { target } = yield* scraperCommand;
      const scrape = scrapeNews(target);

      if (poll) {
        yield* Effect.schedule(scrape.pipe(Effect.catchCause(logCause)), Schedule.cron(cron));
      } else {
        yield* scrape;
      }
    }).pipe(withLogLevel),
).pipe(
  Command.withDescription('Scrape the ORF news feeds and persist the stories to every database target'),
  Command.withExamples([
    { command: 'scraper scrape', description: 'Scrape once' },
    { command: 'scraper scrape --poll --cron "0 0 * * * *"', description: 'Scrape every hour' },
    { command: 'scraper scrape --target orfarchiv-db-2', description: 'Scrape once into one target' },
  ]),
);

function scrapeNews(target: Option.Option<string>) {
  return Effect.gen(function* () {
    const targets = yield* Targets;
    const selectedTargets = yield* targets.select(target);
    const scraper = yield* Scraper;
    const database = yield* Database;

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

    yield* database.persistOrfNews(stories, selectedTargets).pipe(Effect.withLogSpan('persist'));
  }).pipe(Effect.timeout(SCRAPE_TIMEOUT));
}
