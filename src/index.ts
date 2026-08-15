import { NodeRuntime } from '@effect/platform-node';
import dotenv from 'dotenv-flow';
import { Cause, Cron, Effect, References, Result, Schedule } from 'effect';
import type { UnknownError } from 'effect/Cause';
import meow from 'meow';
import { AppLive } from './layers';
import { Database } from './services/database';
import { Scraper } from './services/scraper';
import { LoggerLive } from './shared/logger';
import { sources } from './sources';

dotenv.config({ silent: true });

type AppError = Effect.Error<ReturnType<typeof run>> | UnknownError | Cron.CronParseError;

parseArgs().pipe(
  Effect.andThen((cli) =>
    main(cli).pipe(Effect.provideService(References.MinimumLogLevel, cli.flags.debug ? 'Debug' : 'Info')),
  ),
  Effect.provide(AppLive),
  Effect.catchCause(logCause),
  Effect.provide(LoggerLive),
  NodeRuntime.runMain({ disableErrorReporting: true }),
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
          debug: {
            type: 'boolean',
            default: false,
          },
        },
      },
    ),
  );
}

function main(cli: Effect.Success<ReturnType<typeof parseArgs>>) {
  return Effect.gen(function* () {
    const { poll, cron } = cli.flags;

    if (poll) {
      const schedule = Schedule.cron(Cron.parseUnsafe(cron));
      yield* Effect.schedule(run().pipe(Effect.catchCause(logCause)), schedule);
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
  }).pipe(Effect.timeout('5 minutes'));
}

function logCause(cause: Cause.Cause<AppError>) {
  return Effect.gen(function* () {
    if (cause.reasons.length === 0) {
      yield* Effect.logError('Unknown error');
      return;
    }

    for (const reason of cause.reasons) {
      if (Cause.isFailReason(reason)) {
        yield* logError(reason.error);
      } else if (Cause.isDieReason(reason)) {
        yield* Effect.logError(reason.defect);
      } else if (Cause.isInterruptReason(reason)) {
        yield* Effect.logError('Fiber interrupted');
      } else {
        yield* Effect.logError('Unknown error');
      }
    }
  });
}

function logError(error: AppError) {
  return Effect.logError(`${error?.message ?? 'Unknown error'}\nCause: ${error.cause}\nStack: ${error?.stack ?? ''}`);
}
