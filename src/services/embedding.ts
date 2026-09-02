import { Context, Duration, Effect, Layer, Schema } from 'effect';
import { FetchHttpClient, HttpBody, HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/unstable/http';
import { RateLimiter } from 'effect/unstable/persistence';
import { Binary } from 'mongodb';
import { BATCH_SIZE, BATCH_TIMEOUT, TITLE_EMBEDDING_DIMENSIONS } from '../shared/config';
import { EmbeddingError } from '../shared/errors';
import { toDocumentInput } from '../shared/search';
import { Environment } from './env';

const EmbeddingResponse = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      embedding: Schema.Array(Schema.Number),
    }),
  ),
});

export class Embedding extends Context.Service<Embedding>()('Embedding', {
  make: Effect.gen(function* () {
    const environment = yield* Environment;
    const httpClient = yield* HttpClient.HttpClient;
    const withLimiter = yield* RateLimiter.makeWithRateLimiter;

    const baseUrl = yield* environment.embeddingUrl;
    const token = yield* environment.embeddingToken;
    const limit = Number.parseInt(yield* environment.embeddingRateLimit, 10);
    const window = yield* environment.embeddingRateWindow;

    if (!baseUrl) {
      return yield* new EmbeddingError({
        message: 'ORFARCHIV_EMBEDDING_URL is not configured.',
        type: 'rejected',
        cause: undefined,
      });
    }

    return defineService({ httpClient, withLimiter, baseUrl, token, limit, window });
  }),
}) {
  static readonly layerWithoutDependencies = Layer.effect(this, this.make);
  static readonly layer = this.layerWithoutDependencies.pipe(
    Layer.provide(Environment.layer),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(RateLimiter.layer.pipe(Layer.provide(RateLimiter.layerStoreMemory))),
  );
}

function defineService({
  httpClient,
  withLimiter,
  baseUrl,
  token,
  limit,
  window,
}: {
  httpClient: HttpClient.HttpClient;
  withLimiter: Effect.Success<typeof RateLimiter.makeWithRateLimiter>;
  baseUrl: string;
  token: string;
  limit: number;
  window: string;
}) {
  function embed(texts: ReadonlyArray<string>): Effect.Effect<Array<Binary>, EmbeddingError> {
    return Effect.gen(function* () {
      const inputs = texts.map(toDocumentInput);
      const batches: Array<Array<string>> = [];
      for (let index = 0; index < inputs.length; index += BATCH_SIZE) {
        batches.push(inputs.slice(index, index + BATCH_SIZE));
      }

      const results = yield* Effect.forEach(batches, embedBatch, { concurrency: 1 });
      return results.flat();
    });
  }

  function embedBatch(inputs: Array<string>): Effect.Effect<Array<Binary>, EmbeddingError> {
    return requestEmbeddings(inputs).pipe(
      Effect.timeout(BATCH_TIMEOUT),
      Effect.catchTag(
        'TimeoutError',
        (error) => new EmbeddingError({ message: 'Embedding request timed out.', type: 'timeout', cause: error }),
      ),
      withLimiter({
        key: 'embeddings',
        algorithm: 'token-bucket',
        onExceeded: 'delay',
        window: window as Duration.Input,
        limit,
        tokens: inputs.length,
      }),
      Effect.catchTag(
        'RateLimiterError',
        (error) => new EmbeddingError({ message: 'Rate limiting failed.', type: 'unreachable', cause: error }),
      ),
    );
  }

  function requestEmbeddings(inputs: Array<string>) {
    return Effect.gen(function* () {
      let request = HttpClientRequest.post(`${baseUrl.replace(/\/$/, '')}/embeddings`, {
        body: HttpBody.jsonUnsafe({ input: inputs }),
      });
      if (token) {
        request = HttpClientRequest.bearerToken(request, token);
      }

      const response = yield* httpClient
        .execute(request)
        .pipe(
          Effect.mapError(
            (error) =>
              new EmbeddingError({ message: 'Embedding server is unreachable.', type: 'unreachable', cause: error }),
          ),
        );

      if (response.status < 200 || response.status >= 300) {
        const body = yield* Effect.orElseSucceed(response.text, () => '');
        return yield* new EmbeddingError({
          message: `Embedding server rejected the request with status ${response.status}: ${body.slice(0, 200)}`,
          type: 'rejected',
          cause: undefined,
        });
      }

      const parsed = yield* HttpClientResponse.schemaBodyJson(EmbeddingResponse)(response).pipe(
        Effect.mapError(
          (error) =>
            new EmbeddingError({ message: 'Embedding response was malformed.', type: 'malformed', cause: error }),
        ),
      );

      if (parsed.data.length !== inputs.length) {
        return yield* new EmbeddingError({
          message: `Expected ${inputs.length} embeddings, got ${parsed.data.length}.`,
          type: 'malformed',
          cause: undefined,
        });
      }

      return yield* Effect.forEach(parsed.data, (entry) => toBinary(entry.embedding));
    });
  }

  return { embed };
}

function toBinary(values: ReadonlyArray<number>) {
  if (values.length < TITLE_EMBEDDING_DIMENSIONS) {
    return Effect.fail(
      new EmbeddingError({
        message: `Expected at least ${TITLE_EMBEDDING_DIMENSIONS} dimensions, got ${values.length}.`,
        type: 'malformed',
        cause: undefined,
      }),
    );
  }

  return Effect.succeed(quantize(values.slice(0, TITLE_EMBEDDING_DIMENSIONS)));
}

/**
 * Matryoshka truncation to TITLE_EMBEDDING_DIMENSIONS, then per-vector max-abs
 * scaling to int8. Cosine similarity is scale-invariant, so the scale factor
 * cancels and does not need to be stored — the whole step is lossless with
 * respect to ranking. Re-normalization after truncation is likewise a no-op
 * under cosine, but would be required under dotProduct.
 */
export function quantize(values: ReadonlyArray<number>) {
  let maxAbs = 0;
  for (const value of values) {
    const abs = Math.abs(value);
    if (abs > maxAbs) {
      maxAbs = abs;
    }
  }

  const scale = maxAbs === 0 ? 0 : 127 / maxAbs;
  const quantized = Int8Array.from(values, (value) => Math.max(-127, Math.min(127, Math.round(value * scale))));
  return Binary.fromInt8Array(quantized);
}
