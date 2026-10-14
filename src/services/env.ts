import { parseTargets, withContentExclusions, type Target } from '#common/targets/targets';
import { NodeFileSystem } from '@effect/platform-node';
import { Config, Context, Duration, Effect, FileSystem, Layer, Option, pipe } from 'effect';
import { version } from '../../package.json';
import { ConfigError } from '../shared/errors';

export class Environment extends Context.Service<Environment>()('Environment', {
  make: Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* defineService({ fs });
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

  function loadRateLimit(prefix: string, defaultLimit: string, defaultWindow: string) {
    return Effect.gen(function* () {
      const rawLimit = yield* loadEnvVariable(`${prefix}_RATE_LIMIT`, defaultLimit);
      const rawWindow = yield* loadEnvVariable(`${prefix}_RATE_WINDOW`, defaultWindow);
      return yield* parseRateLimit(prefix, rawLimit, rawWindow);
    });
  }

  const dbConnectionUrl = loadEnvVariable('ORFARCHIV_DB_URL', 'mongodb://localhost');

  const configuredTargets: Effect.Effect<ReadonlyArray<Target>> = Effect.gen(function* () {
    const targets = parseTargets(yield* loadEnvVariable('ORFARCHIV_DB_URLS', ''));
    if (targets.length > 0) {
      return targets;
    }

    return parseTargets(yield* dbConnectionUrl);
  });

  return Effect.gen(function* () {
    const dbTargets = yield* Effect.cached(
      Effect.gen(function* () {
        const { targets, unknownLabels } = withContentExclusions(
          yield* configuredTargets,
          yield* loadEnvVariable('ORFARCHIV_CONTENT_EMBEDDING_EXCLUDED_TARGETS', ''),
        );
        for (const label of unknownLabels) {
          yield* Effect.logWarning(
            `ORFARCHIV_CONTENT_EMBEDDING_EXCLUDED_TARGETS: '${label}' matches no configured target.`,
          );
        }
        return targets;
      }),
    );

    return {
      dbConnectionUrl,
      dbTargets,
      embeddingUrl: loadEnvVariable('ORFARCHIV_EMBEDDING_URL', ''),
      embeddingToken: loadEnvVariable('ORFARCHIV_EMBEDDING_TOKEN', ''),
      embeddingRateLimit: loadRateLimit('ORFARCHIV_EMBEDDING', '1000', '1 minute'),
      contentUserAgent: loadEnvVariable(
        'ORFARCHIV_CONTENT_USER_AGENT',
        `orfarchiv-scraper/${version} (+https://orfarchiv.news)`,
      ),
      contentFetchRateLimit: loadRateLimit('ORFARCHIV_CONTENT_FETCH', '10', '1 second'),
      contentEmbeddingRateLimit: loadRateLimit('ORFARCHIV_CONTENT_EMBEDDING', '100', '1 minute'),
    };
  });
}

function parseRateLimit(prefix: string, rawLimit: string, rawWindow: string) {
  const limit = Number(rawLimit);
  const window = Duration.fromInput(rawWindow.trim() as Duration.Input);
  if (
    rawLimit.trim() === '' ||
    !Number.isInteger(limit) ||
    limit <= 0 ||
    Option.isNone(window) ||
    Duration.toMillis(window.value) <= 0
  ) {
    return Effect.fail(
      new ConfigError({
        message: `${prefix}_RATE_LIMIT must be a positive integer and ${prefix}_RATE_WINDOW a positive duration (e.g. '1 minute'), got '${rawLimit}' and '${rawWindow}'.`,
      }),
    );
  }
  return Effect.succeed({ limit, window: window.value });
}
