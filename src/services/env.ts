import { parseTargets, type Target } from '#common/targets';
import { NodeFileSystem } from '@effect/platform-node';
import { Config, Context, Effect, FileSystem, Layer, pipe } from 'effect';

export class Environment extends Context.Service<Environment>()('Environment', {
  make: Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return defineService({ fs });
  }),
}) {
  static readonly layerWithoutDependencies = Layer.effect(this, this.make);
  static readonly layer = this.layerWithoutDependencies.pipe(Layer.provide(NodeFileSystem.layer));
}

function defineService({ fs }: { fs: FileSystem.FileSystem }) {
  function loadEnvVariable(name: string, fallback: string) {
    return Effect.gen(function* () {
      return yield* pipe(
        Config.String(`${name}_FILE`),
        Effect.andThen((file) =>
          pipe(
            fs.readFile(file),
            Effect.map((value) => value.toString().trim()),
            Effect.tapError((error) => Effect.logWarning(`${error}`)),
          ),
        ),
        Effect.catch(() => Config.String(name)),
        Effect.catch(() => Effect.succeed(fallback)),
      );
    });
  }

  const dbConnectionUrl = loadEnvVariable('ORFARCHIV_DB_URL', 'mongodb://localhost');

  const dbTargets: Effect.Effect<ReadonlyArray<Target>> = Effect.gen(function* () {
    const targets = parseTargets(yield* loadEnvVariable('ORFARCHIV_DB_URLS', ''));
    if (targets.length > 0) {
      return targets;
    }

    return parseTargets(yield* dbConnectionUrl);
  });

  return {
    dbConnectionUrl,
    dbTargets,
    embeddingUrl: loadEnvVariable('ORFARCHIV_EMBEDDING_URL', ''),
    embeddingToken: loadEnvVariable('ORFARCHIV_EMBEDDING_TOKEN', ''),
    embeddingRateLimit: loadEnvVariable('ORFARCHIV_EMBEDDING_RATE_LIMIT', '1000'),
    embeddingRateWindow: loadEnvVariable('ORFARCHIV_EMBEDDING_RATE_WINDOW', '1 minute'),
  };
}
