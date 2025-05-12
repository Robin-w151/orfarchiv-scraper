import { NodeFileSystem, NodeRuntime } from '@effect/platform-node';
import dotenv from 'dotenv-flow';
import { Cron, Duration, Effect, Either, Layer, Schedule } from 'effect';
import meow from 'meow';
import { Database, DatabaseLive } from './services/database.ts';
import { Scraper, ScraperLive } from './services/scraper.ts';
import { LoggerLive } from './shared/logger.ts';
import type { Story } from './shared/model.ts';
import sources from './sources.json' with { type: 'json' };
import type { UnknownException } from 'effect/Cause';

dotenv.config({ silent: true });

const AppLive = Layer.mergeAll(DatabaseLive, LoggerLive, ScraperLive, NodeFileSystem.layer);

main().pipe(
  Effect.matchEffect({
    onSuccess: () => Effect.void,
    onFailure: (error) => logError(error),
  }),
  Effect.provide(AppLive),
  NodeRuntime.runMain({ disablePrettyLogger: true }),
);

function main() {
  return Effect.gen(function* () {
    const cli = yield* parseArgs();
    const { poll, cron } = cli.flags;

    if (poll) {
      const schedule = Schedule.cron(Cron.unsafeParse(cron));
      yield* Effect.schedule(
        run().pipe(
          Effect.catchTag('TimeoutException', () => Effect.logWarning('Scheduled task ran into a timeout')),
          Effect.catchAll((error) => {
            logError(error);
            return Effect.void;
          }),
        ),
        schedule,
      );
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

function run() {
  return Effect.gen(function* () {
    const scraper = yield* Scraper;
    const database = yield* Database;

    const stories: Story[] = [];
    for (const source of sources) {
      const sourceStories = yield* scraper.scrapeOrfNews(source.rssUrl, source.source).pipe(Effect.either);
      if (Either.isLeft(sourceStories)) {
        yield* Effect.logWarning(sourceStories.left.message);
      } else {
        stories.push(...sourceStories.right);
      }
    }

    yield* database.persistOrfNews(stories);
  }).pipe(Effect.timeout(Duration.minutes(5)));
}

function logError(error: Effect.Effect.Error<ReturnType<typeof run>> | UnknownException) {
  return Effect.logError(`${error?.message ?? 'Unknown error'}\nCause: ${error.cause}\nStack: ${error?.stack ?? ''}`);
}
