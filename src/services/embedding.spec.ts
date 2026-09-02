import { ConfigProvider, Duration, Effect, Layer } from 'effect';
import { HttpClient, HttpClientResponse } from 'effect/unstable/http';
import { RateLimiter } from 'effect/unstable/persistence';
import type { Binary } from 'mongodb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Embedding, quantize } from './embedding';
import { isEmbeddable } from '../shared/search';
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

function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / Math.sqrt(na * nb);
}

/** Deterministic pseudo-random vector, so failures are reproducible. */
function randomVector(seed: number, length = 768): Array<number> {
  let state = seed;
  return Array.from({ length }, () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648 - 0.5;
  });
}

describe('quantize', () => {
  it('produces one int8 per dimension behind a 2-byte BSON vector header', () => {
    const binary = quantize(randomVector(1).slice(0, 256));
    expect(binary.sub_type).toBe(9);
    expect(Array.from(binary.buffer.subarray(0, 2))).toEqual([3, 0]);
    expect(binary.length()).toBe(256 + VECTOR_HEADER_BYTES);
    expect(toInt8(binary)).toHaveLength(256);
  });

  it('preserves cosine similarity within tolerance', () => {
    const a = randomVector(7).slice(0, 256);
    const b = randomVector(9).slice(0, 256);
    const exact = cosine(a, b);
    const quantized = cosine(toInt8(quantize(a)), toInt8(quantize(b)));
    expect(Math.abs(quantized - exact)).toBeLessThan(0.01);
  });

  it('is invariant to the scale of the input vector', () => {
    const values = randomVector(3).slice(0, 256);
    expect(Array.from(toInt8(quantize(values)))).toEqual(
      Array.from(toInt8(quantize(values.map((value) => value * 42)))),
    );
  });

  it('keeps a vector maximally similar to itself', () => {
    const values = randomVector(5).slice(0, 256);
    expect(cosine(toInt8(quantize(values)), toInt8(quantize(values)))).toBeCloseTo(1, 6);
  });

  it('survives an all-zero vector without producing NaN', () => {
    const binary = quantize(new Array(256).fill(0));
    expect(Array.from(toInt8(binary))).toEqual(new Array(256).fill(0));
  });

  it('uses the full int8 range for the largest component', () => {
    const values = randomVector(11).slice(0, 256);
    expect(Math.max(...Array.from(toInt8(quantize(values))).map(Math.abs))).toBe(127);
  });
});

describe('isEmbeddable', () => {
  it.each([
    ['a real title', 'Teuerung befeuert die Schwarzarbeit', true],
    ['an empty string', '', false],
    ['whitespace only', '   ', false],
    ['a tab', '\t', false],
    ['undefined', undefined, false],
    ['null', null, false],
  ])('%s -> %s', (_label, title, expected) => {
    expect(isEmbeddable(title as string | undefined | null)).toBe(expected);
  });
});

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
