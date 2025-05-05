import { Config, Effect, pipe } from 'effect';
import { readFile } from 'fs/promises';

export function dbConnectionUrl(): Effect.Effect<string> {
  return pipe(
    Config.string('ORFARCHIV_DB_URL_FILE'),
    Effect.andThen((file) => Effect.tryPromise(() => readFile(file, 'utf8'))),
    Effect.catchAll(() => Config.string('ORFARCHIV_DB_URL')),
    Effect.catchAll(() => Effect.succeed('mongodb://localhost')),
  );
}
