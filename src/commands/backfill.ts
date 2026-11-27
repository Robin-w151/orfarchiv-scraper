import { Cron, Effect, Option, Schedule } from 'effect';
import { Command, Flag } from 'effect/cli';
import { Database } from '../services/database';
import { Targets } from '../services/targets';
import { logCause } from '../shared/logger';
import type { DatabaseError } from '../shared/errors';
import { cronFlag, scraperCommand, withLogLevel } from './scraper';

export const backfillCommand = Command.make(
  'backfill-embeddings',
  {
    poll: Flag.Boolean('poll').pipe(
      Flag.withDefault(false),
      Flag.withDescription('Keep running; backfill on the --cron schedule'),
    ),
    cron: cronFlag('0 0 * * * *', 'Backfill schedule in cron syntax (default: 0 0 * * * *, e.g. every hour)'),
    batchSize: Flag.Int('batch-size').pipe(
      Flag.withDefault(100),
      Flag.filter(
        (size) => size > 0,
        () => 'a positive integer',
      ),
      Flag.withDescription('Stories per batch (default: 100)'),
    ),
    maxDocs: Flag.Int('max-docs').pipe(
      Flag.filter(
        (max) => max > 0,
        () => 'a positive integer',
      ),
      Flag.optional,
      Flag.withDescription('Stop after this many stories per target and run (default: no limit)'),
    ),
  },
  ({ poll, cron, batchSize, maxDocs }) =>
    Effect.gen(function* () {
      const { target } = yield* scraperCommand;
      const targets = yield* Targets;
      const selectedTargets = yield* targets.select(target);
      const database = yield* Database;
      const backfill = database
        .backfillEmbeddings({ batchSize, maxDocs: Option.getOrUndefined(maxDocs) }, selectedTargets)
        .pipe(Effect.withLogSpan('backfill'));

      if (poll) {
        yield* backfillOnSchedule(backfill, cron);
      } else {
        yield* backfill;
      }
    }).pipe(withLogLevel),
).pipe(
  Command.withDescription('Embed stories that have no embedding yet, newest first, one target after another'),
  Command.withExamples([
    { command: 'scraper backfill-embeddings --max-docs 1000', description: 'Backfill at most 1000 stories per target' },
    { command: 'scraper backfill-embeddings --target orfarchiv-db-2', description: 'Backfill only one target' },
    { command: 'scraper backfill-embeddings --poll', description: 'Backfill every hour' },
  ]),
);

export function backfillOnSchedule<R>(backfill: Effect.Effect<void, DatabaseError, R>, cron: Cron.Cron) {
  return Effect.schedule(backfill.pipe(Effect.catchCause(logCause)), Schedule.cron(cron));
}
