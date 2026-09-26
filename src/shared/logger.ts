import { Cause, Cron, Effect, Logger } from 'effect';
import type { TimeoutError, UnknownError } from 'effect/Cause';
import { CliError } from 'effect/unstable/cli';
import { redact } from '#common/targets';
import type { DatabaseError, EmbeddingError, ScraperError, TargetError } from './errors';

type AppError =
  DatabaseError | EmbeddingError | ScraperError | TargetError | TimeoutError | UnknownError | Cron.CronParseError;

export const redactedLogFmt = Logger.formatLogFmt.pipe(Logger.map(redact));

export const LoggerLive = Logger.layer([redactedLogFmt.pipe(Logger.withConsoleLog), Logger.tracerLogger]);

export function logCause(cause: Cause.Cause<AppError | CliError.CliError>) {
  return Effect.gen(function* () {
    if (cause.reasons.length === 0) {
      yield* Effect.logError('Unknown error');
      return;
    }

    for (const reason of cause.reasons) {
      if (Cause.isFailReason(reason)) {
        if (!CliError.isCliError(reason.error)) {
          yield* logError(reason.error);
        }
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
