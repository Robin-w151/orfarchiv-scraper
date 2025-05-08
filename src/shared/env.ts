import { Config, Effect, pipe } from 'effect';
import { readFile } from 'fs/promises';
import { IOError } from './errors.ts';

export class Environment extends Effect.Service<Environment>()('Environment', {
  effect: Effect.succeed({
    dbConnectionUrl: loadEnvVariable('ORFARCHIV_DB_URL', 'mongodb://localhost'),
  }),
  dependencies: [],
}) {}

export const EnvironmentLive = Environment.Default;

function loadEnvVariable(name: string, fallback: string): Effect.Effect<string> {
  return pipe(
    Config.string(`${name}_FILE`),
    Effect.andThen((file) =>
      pipe(
        Effect.tryPromise({
          try: () => readFile(file, 'utf8'),
          catch: (error) => new IOError({ message: `Failed to read env variable from file '${file}'`, cause: error }),
        }),
        Effect.map((value) => value.trim()),
        Effect.tapError((error) => Effect.logWarning(`${error}`)),
      ),
    ),
    Effect.catchAll(() => Config.string(name)),
    Effect.catchAll(() => Effect.succeed(fallback)),
  );
}
