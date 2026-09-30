import { Effect, Option } from 'effect';
import { Command, Flag } from 'effect/unstable/cli';
import { Database } from '../services/database';
import { Targets } from '../services/targets';
import { scraperCommand, withLogLevel } from './scraper';

export const backfillCommand = Command.make(
  'backfill-embeddings',
  {
    batchSize: Flag.Int('batch-size').pipe(
      Flag.withDefault(100),
      Flag.withDescription('Stories per batch (default: 100)'),
    ),
    maxDocs: Flag.Int('max-docs').pipe(
      Flag.optional,
      Flag.withDescription('Stop after this many stories per target (default: no limit)'),
    ),
  },
  ({ batchSize, maxDocs }) =>
    Effect.gen(function* () {
      const { target } = yield* scraperCommand;
      const targets = yield* Targets;
      const selectedTargets = yield* targets.select(target);
      const database = yield* Database;
      yield* database
        .backfillEmbeddings({ batchSize, maxDocs: Option.getOrUndefined(maxDocs) }, selectedTargets)
        .pipe(Effect.withLogSpan('backfill'));
    }).pipe(withLogLevel),
).pipe(
  Command.withDescription('Embed stories that have no embedding yet, newest first, one target after another'),
  Command.withExamples([
    { command: 'scraper backfill-embeddings --max-docs 1000', description: 'Backfill at most 1000 stories per target' },
    { command: 'scraper backfill-embeddings --target orfarchiv-db-2', description: 'Backfill only one target' },
  ]),
);
