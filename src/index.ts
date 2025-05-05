import { NodeRuntime } from '@effect/platform-node';
import dotenv from 'dotenv-flow';
import { Cron, Effect, pipe, Schedule } from 'effect';
import meow from 'meow';
import { persistOrfNews } from './db.ts';
import type { DatabaseError } from './errors.ts';
import { loggerLayer } from './logger.ts';
import type { Story } from './model.ts';
import { scrapeOrfNews } from './scrape.ts';
import sources from './sources.json' with { type: 'json' };

dotenv.config({ silent: true });

pipe(
  Effect.matchEffect(main(), {
    onSuccess: () => Effect.void,
    onFailure: (error) =>
      Effect.logError(`${error?.message ?? 'Unknown error'}\nCause: ${error.cause}\nStack: ${error?.stack ?? ''}`),
  }),
  Effect.provide(loggerLayer),
  NodeRuntime.runMain({ disablePrettyLogger: true }),
);

function main(): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    const cli = yield* parseArgs();
    const { poll, cron } = cli.flags;

    if (poll) {
      const schedule = Schedule.cron(Cron.unsafeParse(cron));
      yield* Effect.schedule(run(), schedule);
    } else {
      yield* run();
    }
  });
}

function parseArgs() {
  return Effect.try(() =>
    meow(
      `
    Usage
      $ scraper [--poll]

    Options
      --poll    Keep polling for new stories
      --cron    Polling interval in cron syntax (default: 0 * * * * *, e.g. poll every minute)

    Examples
      $ scraper
      $ scraper --poll --cron "0 0 * * * *" // Poll every hour
    `,
      {
        importMeta: import.meta,
        flags: {
          poll: {
            type: 'boolean',
            default: false,
          },
          cron: {
            type: 'string',
            default: '0 * * * * *',
          },
        },
      },
    ),
  );
}

function run(): Effect.Effect<void, DatabaseError> {
  return Effect.gen(function* () {
    const stories: Story[] = [];
    for (const source of sources) {
      stories.push(
        ...(yield* scrapeOrfNews(source.rssUrl, source.source).pipe(
          Effect.catchTag('ScrapeError', (error) =>
            Effect.gen(function* () {
              yield* Effect.logWarning(error.message);
              return [];
            }),
          ),
        )),
      );
    }

    yield* persistOrfNews(stories);
  });
}
