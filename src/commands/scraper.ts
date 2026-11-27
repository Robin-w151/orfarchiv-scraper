import { Cron, Effect, References } from 'effect';
import { Command, Flag } from 'effect/cli';

export const scraperCommand = Command.make('scraper').pipe(
  Command.withDescription('ORF Archiv news scraper'),
  Command.withSharedFlags({
    target: Flag.String('target').pipe(
      Flag.optional,
      Flag.withDescription('Only use the database target with this label (host[:port])'),
    ),
    debug: Flag.Boolean('debug').pipe(Flag.withDefault(false), Flag.withDescription('Show debug logs')),
  }),
);

export function withLogLevel<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const { debug } = yield* scraperCommand;
    return yield* effect.pipe(Effect.provideService(References.MinimumLogLevel, debug ? 'Debug' : 'Info'));
  });
}

export function cronFlag(defaultCron: string, description: string) {
  return Flag.String('cron').pipe(
    Flag.withDefault(defaultCron),
    Flag.mapTryCatch(
      (cron) => Cron.parseUnsafe(cron),
      (error) => `a valid cron expression (${error instanceof Error ? error.message : error})`,
    ),
    Flag.withDescription(description),
  );
}
