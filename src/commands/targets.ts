import { Effect, Option } from 'effect';
import { Command } from 'effect/cli';
import { Targets } from '../services/targets';
import { scraperCommand, withLogLevel } from './scraper';

export const targetsCommand = Command.make('targets', {}, () =>
  Effect.gen(function* () {
    const { target } = yield* scraperCommand;
    const targetsService = yield* Targets;
    const allTargets = yield* targetsService.select(Option.none());
    const selected = yield* targetsService.select(target);
    for (const [index, { label, content }] of allTargets.entries()) {
      if (selected.some((selectedTarget) => selectedTarget.label === label)) {
        yield* Effect.log(`${index + 1}. ${label} (${content ? 'content' : 'no content'})`);
      }
    }
  }).pipe(withLogLevel),
).pipe(
  Command.withDescription(
    'List the labels of all configured database targets in priority order and whether they receive content embeddings',
  ),
);
