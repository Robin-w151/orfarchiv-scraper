import { ConfigProvider, Duration, Effect, Layer } from 'effect';
import { HttpClient, HttpClientResponse } from 'effect/unstable/http';
import { RateLimiter } from 'effect/unstable/persistence';
import type { Binary } from 'mongodb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Embedding } from './embedding';
import { Environment } from './env';

vi.mock('../shared/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../shared/config')>()),
  BATCH_TIMEOUT: Duration.millis(200),
}));

const VECTOR_HEADER_BYTES = 2;

function toInt8(binary: Binary): Int8Array {
  return new Int8Array(
    binary.buffer.buffer,
    binary.buffer.byteOffset + VECTOR_HEADER_BYTES,
    binary.length() - VECTOR_HEADER_BYTES,
  );
}

/** Deterministic pseudo-random vector, so failures are reproducible. */
function randomVector(seed: number, length = 768): Array<number> {
  let state = seed;
  return Array.from({ length }, () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648 - 0.5;
  });
}

describe('Embedding', () => {
  const calls: Array<number> = [];

  beforeEach(() => {
    calls.length = 0;
  });

  const stubHttpClient = HttpClient.make((request) =>
    Effect.sync(() => {
      const body = request.body as { body: Uint8Array };
      const input = (JSON.parse(new TextDecoder().decode(body.body)) as { input: Array<string> }).input;
      calls.push(input.length);
      return HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify({ data: input.map((_, index) => ({ embedding: randomVector(index + 1) })) }), {
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );

  const makeLayer = (limit: string, window: string) =>
    Embedding.layerWithoutDependencies.pipe(
      Layer.provide(Environment.layer),
      Layer.provide(Layer.succeed(HttpClient.HttpClient, stubHttpClient)),
      Layer.provide(RateLimiter.layer.pipe(Layer.provide(RateLimiter.layerStoreMemory))),
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnvRecord({
            ORFARCHIV_EMBEDDING_URL: 'http://embeddings.test/v1',
            ORFARCHIV_EMBEDDING_RATE_LIMIT: limit,
            ORFARCHIV_EMBEDDING_RATE_WINDOW: window,
          }),
        ),
      ),
    );

  it('batches at 100 texts per request', () =>
    Effect.gen(function* () {
      const service = yield* Embedding;
      const result = yield* service.embed(Array.from({ length: 250 }, (_, index) => `title ${index}`));

      expect(calls).toEqual([100, 100, 50]);
      expect(result).toHaveLength(250);
      expect(toInt8(result[0])).toHaveLength(256);
    }).pipe(Effect.provide(makeLayer('100000', '1 minute')), Effect.runPromise));

  it('paces batches against the configured titles-per-window limit', async () => {
    const started = Date.now();

    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* Embedding;
        yield* service.embed(Array.from({ length: 200 }, (_, index) => `title ${index}`));
      }).pipe(Effect.provide(makeLayer('100', '300 millis'))) as never,
    );

    expect(calls).toEqual([100, 100]);
    expect(Date.now() - started).toBeGreaterThan(200);
  });

  it('does not spend the request timeout on the rate-limit delay', async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* Embedding;
        return yield* service.embed(Array.from({ length: 200 }, (_, index) => `title ${index}`));
      }).pipe(Effect.provide(makeLayer('100', '500 millis')), Effect.result) as never,
    );

    expect((result as { _tag: string })._tag).toBe('Success');
    expect(calls).toEqual([100, 100]);
  });

  it('does not pace when the limit comfortably exceeds the batch', async () => {
    const started = Date.now();

    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* Embedding;
        yield* service.embed(Array.from({ length: 200 }, (_, index) => `title ${index}`));
      }).pipe(Effect.provide(makeLayer('100000', '1 minute'))) as never,
    );

    expect(calls).toEqual([100, 100]);
    expect(Date.now() - started).toBeLessThan(150);
  });
});
