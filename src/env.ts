import { Config, Effect, pipe } from 'effect';
import { readFile } from 'fs/promises';
import { IOError } from './errors.ts';

export function dbConnectionUrl(): Effect.Effect<string> {
  return pipe(
    Config.string('ORFARCHIV_DB_URL_FILE'),
    Effect.andThen((file) =>
      pipe(
        Effect.tryPromise({
          try: () => readFile(file, 'utf8'),
          catch: (error) => new IOError({ message: `Failed to read env variable from file '${file}'`, cause: error }),
        }),
        Effect.catchAll((error) =>
          Effect.gen(function* () {
            yield* Effect.logWarning(`${error}`);
            return yield* Effect.fail(error);
          }),
        ),
      ),
    ),
    Effect.catchAll(() => Config.string('ORFARCHIV_DB_URL')),
    Effect.catchAll(() => Effect.succeed('mongodb://localhost')),
  );
}
