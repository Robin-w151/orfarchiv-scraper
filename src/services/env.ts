import { FileSystem } from '@effect/platform';
import { NodeFileSystem } from '@effect/platform-node';
import { Config, Effect, pipe } from 'effect';
export class Environment extends Effect.Service<Environment>()('Environment', {
  succeed: {
    dbConnectionUrl: loadEnvVariable('ORFARCHIV_DB_URL', 'mongodb://localhost'),
  },
  dependencies: [NodeFileSystem.layer],
}) {}

export const EnvironmentLive = Environment.Default;

function loadEnvVariable(name: string, fallback: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* pipe(
      Config.string(`${name}_FILE`),
      Effect.andThen((file) =>
        pipe(
          fs.readFile(file),
          Effect.map((value) => value.toString().trim()),
          Effect.tapError((error) => Effect.logWarning(`${error}`)),
        ),
      ),
      Effect.catchAll(() => Config.string(name)),
      Effect.catchAll(() => Effect.succeed(fallback)),
    );
  });
}
