import { FetchHttpClient } from '@effect/platform';
import { NodeFileSystem, NodeRuntime } from '@effect/platform-node';
import dotenv from 'dotenv-flow';
import { Cause, Cron, Effect, Either, Layer, Logger, LogLevel, Schedule } from 'effect';
import type { UnknownException } from 'effect/Cause';
import meow from 'meow';
import { Database, DatabaseLive } from './services/database.ts';
import { Scraper, ScraperLive } from './services/scraper.ts';
import { LoggerLive } from './shared/logger.ts';
import sources from './sources.json' with { type: 'json' };

dotenv.config({ silent: true });

const AppLive = Layer.mergeAll(DatabaseLive, LoggerLive, ScraperLive, NodeFileSystem.layer, FetchHttpClient.layer);

parseArgs().pipe(
  Effect.andThen((cli) => main(cli).pipe(Logger.withMinimumLogLevel(cli.flags.debug ? LogLevel.Debug : LogLevel.Info))),
  Effect.provide(AppLive),
  Effect.catchAllCause(logCause),
  NodeRuntime.runMain({ disablePrettyLogger: true }),
);

function parseArgs() {
  return Effect.try(() =>
    meow(
      `
    Usage
      $ scraper [--poll]

    Options
      --poll    Keep polling for new stories
      --cron    Polling interval in cron syntax (default: 0 * * * * *, e.g. poll every minute)
      --debug   Enable debug mode (show debug logs)
      --help    Show help

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

function main(cli: Effect.Effect.Success<ReturnType<typeof parseArgs>>) {
  return Effect.gen(function* () {
    const { poll, cron } = cli.flags;

    if (poll) {
      const schedule = Schedule.cron(Cron.unsafeParse(cron));
      yield* Effect.schedule(run().pipe(Effect.catchAllCause(logCause)), schedule);
    } else {
      yield* run();
    }
  });
}

function run() {
  return Effect.gen(function* () {
    const scraper = yield* Scraper;
    const database = yield* Database;

    const stories = (yield* Effect.all(
      sources.map((source) =>
        Effect.gen(function* () {
          const stories = yield* scraper.scrapeOrfNews(source.rssUrl, source.source).pipe(Effect.either);
          if (Either.isLeft(stories)) {
            yield* Effect.logWarning(`Failed to scrape stories for source '${source.source}': ${stories.left.message}`);
          } else {
            return stories.right;
          }
        }).pipe(Effect.withLogSpan(source.source)),
      ),
      { concurrency: 'unbounded' },
    ).pipe(Effect.withLogSpan('scraper')))
      .flat()
      .filter((stories) => !!stories);

    yield* database.persistOrfNews(stories).pipe(Effect.withLogSpan('persist'));
  }).pipe(Effect.timeout('5 minutes'));
}

function logCause(cause: Cause.Cause<Effect.Effect.Error<ReturnType<typeof run>> | UnknownException>) {
  return Effect.gen(function* () {
    if (Cause.isFailType(cause)) {
      yield* logError(cause.error);
    } else if (Cause.isDieType(cause)) {
      yield* Effect.logError(cause.defect);
    } else if (Cause.isInterruptType(cause)) {
      yield* Effect.logError('Fiber interrupted');
    } else {
      yield* Effect.logError('Unknown error');
    }
  });
}

function logError(error: Effect.Effect.Error<ReturnType<typeof run>> | UnknownException) {
  return Effect.logError(`${error?.message ?? 'Unknown error'}\nCause: ${error.cause}\nStack: ${error?.stack ?? ''}`);
}
