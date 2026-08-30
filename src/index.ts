import { NodeRuntime } from '@effect/platform-node';
import dotenv from 'dotenv-flow';
import { Cause, Cron, Effect, References, Schedule } from 'effect';
import type { TimeoutError, UnknownError } from 'effect/Cause';
import meow from 'meow';
import { AppLive } from './layers';
import { Command } from './services/command';
import type { DatabaseError, EmbeddingError, ScraperError } from './shared/errors';
import { LoggerLive } from './shared/logger';

dotenv.config({ silent: true });

type AppError = DatabaseError | EmbeddingError | ScraperError | TimeoutError | UnknownError | Cron.CronParseError;

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
      $ scraper --backfill-embeddings

    Options
      --poll                 Keep polling for new stories
      --cron                 Polling interval in cron syntax (default: 0 * * * * *, e.g. poll every minute)
      --backfill-embeddings  Embed stories that have no embedding yet, newest first
      --batch-size           Stories per batch when backfilling (default: 100)
      --max-docs             Stop after this many stories when backfilling (default: no limit)
      --debug                Enable debug mode (show debug logs)
      --help                 Show help

    Examples
      $ scraper
      $ scraper --poll --cron "0 0 * * * *" // Poll every hour
      $ scraper --backfill-embeddings --max-docs 1000
    `,
      {
        importMeta: import.meta,
        flags: {
          poll: {
            type: 'boolean',
            default: false,
          },
          backfillEmbeddings: {
            type: 'boolean',
            default: false,
          },
          batchSize: {
            type: 'number',
            default: 100,
          },
          maxDocs: {
            type: 'number',
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
    const command = yield* selectCommand(cli);

    if (poll) {
      const schedule = Schedule.cron(Cron.parseUnsafe(cron));
      yield* Effect.schedule(command.pipe(Effect.catchCause(logCause)), schedule);
    } else {
      yield* command;
    }
  });
}

function selectCommand(cli: Effect.Success<ReturnType<typeof parseArgs>>) {
  return Effect.gen(function* () {
    const command = yield* Command;
    const { backfillEmbeddings, batchSize, maxDocs } = cli.flags;

    return backfillEmbeddings ? command.backfillEmbeddings({ batchSize, maxDocs }) : command.scrapeNews();
  });
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
