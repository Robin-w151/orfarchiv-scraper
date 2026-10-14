import { quantize } from '#common/embedding/embedding';
import { CONTENT_EMBEDDING_DIMENSIONS, TITLE_EMBEDDING_DIMENSIONS } from '#common/search/search.constants';
import { Context, Duration, Effect, Layer, Schema } from 'effect';
import { FetchHttpClient, HttpBody, HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/http';
import { RateLimiter } from 'effect/persistence';
import type { Binary } from 'mongodb';
import { BATCH_SIZE, BATCH_TIMEOUT, CONTENT_TOKEN_MARGIN } from '../shared/config';
import { EmbeddingError, EmbeddingErrorType } from '../shared/errors';
import { toDocumentInput } from '../shared/search';
import { withTimeout } from '../shared/timeout';
import { Environment } from './env';

const EmbeddingResponse = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      embedding: Schema.Array(Schema.Number),
    }),
  ),
});

const TokenizeResponse = Schema.Struct({
  tokens: Schema.Array(
    Schema.Struct({
      piece: Schema.Union([Schema.String, Schema.Array(Schema.Number)]),
    }),
  ),
});

interface RateLimit {
  readonly key: string;
  readonly limit: number;
  readonly window: Duration.Duration;
}

interface EmbedOptions {
  readonly toInput: (text: string) => string;
  readonly dimensions: number;
  readonly batchSize: number;
  readonly rateLimit: RateLimit;
}

export class Embedding extends Context.Service<Embedding>()('Embedding', {
  make: Effect.gen(function* () {
    const environment = yield* Environment;
    const httpClient = yield* HttpClient.HttpClient;
    const withLimiter = yield* RateLimiter.makeWithRateLimiter;

    const baseUrl = yield* environment.embeddingUrl;
    const token = yield* environment.embeddingToken;
    const titleRateLimit = { key: 'title-embeddings', ...(yield* environment.embeddingRateLimit) };
    const contentRateLimit = { key: 'content-embeddings', ...(yield* environment.contentEmbeddingRateLimit) };

    if (!baseUrl) {
      return yield* new EmbeddingError({
        message: 'ORFARCHIV_EMBEDDING_URL is not configured.',
        type: EmbeddingErrorType.Rejected,
        cause: undefined,
      });
    }

    return defineService({ httpClient, withLimiter, baseUrl, token, titleRateLimit, contentRateLimit });
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
  titleRateLimit,
  contentRateLimit,
}: {
  httpClient: HttpClient.HttpClient;
  withLimiter: Effect.Success<typeof RateLimiter.makeWithRateLimiter>;
  baseUrl: string;
  token: string;
  titleRateLimit: RateLimit;
  contentRateLimit: RateLimit;
}) {
  const apiUrl = baseUrl.replace(/\/$/, '');
  const rootUrl = apiUrl.replace(/\/v1$/, '');

  function embed(texts: ReadonlyArray<string>): Effect.Effect<Array<Binary>, EmbeddingError> {
    return embedWith(texts, {
      toInput: toDocumentInput,
      dimensions: TITLE_EMBEDDING_DIMENSIONS,
      batchSize: BATCH_SIZE,
      rateLimit: titleRateLimit,
    });
  }

  function embedContent(inputs: ReadonlyArray<string>) {
    return embedWith(inputs, {
      toInput: (input) => input,
      dimensions: CONTENT_EMBEDDING_DIMENSIONS,
      batchSize: 1,
      rateLimit: contentRateLimit,
    });
  }

  function embedWith(texts: ReadonlyArray<string>, options: EmbedOptions) {
    return Effect.gen(function* () {
      const inputs = texts.map(options.toInput);
      const batches: Array<Array<string>> = [];
      for (let index = 0; index < inputs.length; index += options.batchSize) {
        batches.push(inputs.slice(index, index + options.batchSize));
      }

      const results = yield* Effect.forEach(batches, (batch) => embedBatch(batch, options), { concurrency: 1 });
      return results.flat();
    });
  }

  function embedBatch(inputs: Array<string>, { dimensions, rateLimit }: EmbedOptions) {
    return requestEmbeddings(inputs, dimensions).pipe(
      withTimeout(BATCH_TIMEOUT, () => timeoutError('Embedding request timed out.')),
      withLimiter({
        key: rateLimit.key,
        algorithm: 'token-bucket',
        onExceeded: 'delay',
        window: rateLimit.window,
        limit: rateLimit.limit,
        tokens: inputs.length,
      }),
      Effect.catchTag(
        'RateLimiterError',
        (error) =>
          new EmbeddingError({ message: 'Rate limiting failed.', type: EmbeddingErrorType.Unreachable, cause: error }),
      ),
    );
  }

  function requestEmbeddings(inputs: Array<string>, dimensions: number) {
    return Effect.gen(function* () {
      const response = yield* execute(
        HttpClientRequest.post(`${apiUrl}/embeddings`, { body: HttpBody.jsonUnsafe({ input: inputs }) }),
      );

      const parsed = yield* HttpClientResponse.schemaBodyJson(EmbeddingResponse)(response).pipe(
        Effect.mapError(
          (error) =>
            new EmbeddingError({
              message: 'Embedding response was malformed.',
              type: EmbeddingErrorType.Malformed,
              cause: error,
            }),
        ),
      );

      if (parsed.data.length !== inputs.length) {
        return yield* new EmbeddingError({
          message: `Expected ${inputs.length} embeddings, got ${parsed.data.length}.`,
          type: EmbeddingErrorType.Malformed,
          cause: undefined,
        });
      }

      return yield* Effect.forEach(parsed.data, (entry) => truncateAndQuantize(entry.embedding, dimensions));
    });
  }

  function truncateToTokens(input: string, maxTokens: number) {
    return Effect.gen(function* () {
      const response = yield* execute(
        HttpClientRequest.post(`${rootUrl}/tokenize`, {
          body: HttpBody.jsonUnsafe({ content: input, with_pieces: true }),
        }),
      );

      const { tokens } = yield* HttpClientResponse.schemaBodyJson(TokenizeResponse)(response).pipe(
        Effect.mapError(
          (error) =>
            new EmbeddingError({
              message: 'Tokenize response was malformed.',
              type: EmbeddingErrorType.Malformed,
              cause: error,
            }),
        ),
      );

      const limit = maxTokens - CONTENT_TOKEN_MARGIN;
      if (tokens.length <= limit) {
        return input;
      }

      return joinPieces(tokens.slice(0, limit).map((token) => token.piece));
    }).pipe(withTimeout(BATCH_TIMEOUT, () => timeoutError('Tokenize request timed out.')));
  }

  function health() {
    return execute(HttpClientRequest.get(`${rootUrl}/health`)).pipe(
      Effect.asVoid,
      withTimeout(BATCH_TIMEOUT, () => timeoutError('Health check timed out.')),
    );
  }

  function execute(request: HttpClientRequest.HttpClientRequest) {
    return Effect.gen(function* () {
      const response = yield* httpClient.execute(token ? HttpClientRequest.bearerToken(request, token) : request).pipe(
        Effect.mapError(
          (error) =>
            new EmbeddingError({
              message: 'Embedding server is unreachable.',
              type: EmbeddingErrorType.Unreachable,
              cause: error,
            }),
        ),
      );

      if (response.status < 200 || response.status >= 300) {
        const body = yield* Effect.orElseSucceed(response.text, () => '');
        return yield* new EmbeddingError({
          message: `Embedding server rejected the request with status ${response.status}: ${body.slice(0, 200)}`,
          type: EmbeddingErrorType.Rejected,
          cause: undefined,
        });
      }

      return response;
    });
  }

  return { embed, embedContent, truncateToTokens, health };
}

function timeoutError(message: string) {
  return new EmbeddingError({ message, type: EmbeddingErrorType.Timeout, cause: undefined });
}

function truncateAndQuantize(values: ReadonlyArray<number>, dimensions: number) {
  if (values.length < dimensions) {
    return Effect.fail(
      new EmbeddingError({
        message: `Expected at least ${dimensions} dimensions, got ${values.length}.`,
        type: EmbeddingErrorType.Malformed,
        cause: undefined,
      }),
    );
  }

  return Effect.succeed(quantize(values.slice(0, dimensions)));
}

function joinPieces(pieces: ReadonlyArray<string | ReadonlyArray<number>>) {
  const encoder = new TextEncoder();
  const bytes = pieces.flatMap((piece) => [...(typeof piece === 'string' ? encoder.encode(piece) : piece)]);
  return new TextDecoder().decode(Uint8Array.from(bytes.slice(0, completeUtf8Length(bytes))));
}

/**
 * Returns the length of `bytes` without a trailing incomplete UTF-8 sequence: walks back over continuation bytes
 * (`10xxxxxx`) to the lead byte and cuts it off if the sequence it announces is longer than the bytes present.
 */
function completeUtf8Length(bytes: ReadonlyArray<number>) {
  for (let back = 1; back <= Math.min(4, bytes.length); back++) {
    const byte = bytes[bytes.length - back];
    if ((byte & 0xc0) === 0x80) {
      continue;
    }
    const expected = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return expected > back ? bytes.length - back : bytes.length;
  }
  return bytes.length;
}
