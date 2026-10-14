import { Duration, Effect, Option } from 'effect';
import { Command, Flag } from 'effect/cli';
import { ContentEmbedding, selectContentTargets } from '../services/content';
import { Targets } from '../services/targets';
import { scraperCommand, withLogLevel } from './scraper';

const DEFAULT_IDLE_INTERVAL = '1 minute';

export const embedContentCommand = Command.make(
  'embed-content',
  {
    poll: Flag.Boolean('poll').pipe(
      Flag.withDefault(false),
      Flag.withDescription(
        'Keep running; wait --idle-interval when there is nothing to do or a batch could not make progress',
      ),
    ),
    idleInterval: Flag.String('idle-interval').pipe(
      Flag.withDefault(DEFAULT_IDLE_INTERVAL),
      Flag.mapTryCatch(
        (input) => Duration.fromInputUnsafe(input as Duration.Input),
        (error) => `a valid duration, e.g. '1 minute' (${error instanceof Error ? error.message : error})`,
      ),
      Flag.filter(
        (duration) => Duration.toMillis(duration) > 0,
        () => `a positive duration, e.g. '1 minute'`,
      ),
      Flag.withDescription(
        `Wait before the next batch when the backlog is empty or a batch could not make progress (default: ${DEFAULT_IDLE_INTERVAL})`,
      ),
    ),
    batchSize: Flag.Int('batch-size').pipe(
      Flag.withDefault(20),
      Flag.filter(
        (size) => size > 0,
        () => 'a positive integer',
      ),
      Flag.withDescription('Stories per batch (default: 20)'),
    ),
    maxDocs: Flag.Int('max-docs').pipe(
      Flag.filter(
        (max) => max > 0,
        () => 'a positive integer',
      ),
      Flag.optional,
      Flag.withDescription('Stop after this many stories (default: no limit)'),
    ),
  },
  ({ poll, idleInterval, batchSize, maxDocs }) =>
    Effect.gen(function* () {
      const { target } = yield* scraperCommand;
      const targets = yield* Targets;
      const contentTargets = yield* selectContentTargets(yield* targets.select(target), target);
      const contentEmbedding = yield* ContentEmbedding;
      yield* contentEmbedding
        .run({ poll, idleInterval, batchSize, maxDocs: Option.getOrUndefined(maxDocs) }, contentTargets)
        .pipe(Effect.withLogSpan('embed-content'));
    }).pipe(withLogLevel),
).pipe(
  Command.withDescription(
    'Fetch the orf.at page of stories without content, newest first, and store their content embeddings',
  ),
  Command.withExamples([
    { command: 'scraper embed-content --max-docs 200', description: 'Embed the content of at most 200 stories' },
    { command: 'scraper embed-content --poll', description: 'Keep embedding new and old stories' },
    { command: 'scraper embed-content --target orfarchiv-db-1', description: 'Only use one target' },
  ]),
);
