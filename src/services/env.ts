import { NodeFileSystem } from '@effect/platform-node';
import { Config, Context, Effect, FileSystem, Layer, pipe } from 'effect';

export class Environment extends Context.Service<Environment>()('Environment', {
  make: Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return defineService({ fs });
  }),
}) {
  static readonly layerWithoutDeps = Layer.effect(this, this.make);
  static readonly layer = this.layerWithoutDeps.pipe(Layer.provide(NodeFileSystem.layer));
}

function defineService({ fs }: { fs: FileSystem.FileSystem }) {
  function loadEnvVariable(name: string, fallback: string) {
    return Effect.gen(function* () {
      return yield* pipe(
        Config.string(`${name}_FILE`),
        Effect.andThen((file) =>
          pipe(
            fs.readFile(file),
            Effect.map((value) => value.toString().trim()),
            Effect.tapError((error) => Effect.logWarning(`${error}`)),
          ),
        ),
        Effect.catch(() => Config.string(name)),
        Effect.catch(() => Effect.succeed(fallback)),
      );
    });
  }

  return {
    dbConnectionUrl: loadEnvVariable('ORFARCHIV_DB_URL', 'mongodb://localhost'),
  };
}
