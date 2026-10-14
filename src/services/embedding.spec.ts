import { ConfigProvider, Duration, Effect, Fiber, Layer } from 'effect';
import { HttpClient, HttpClientError, HttpClientResponse } from 'effect/http';
import { RateLimiter } from 'effect/persistence';
import { TestClock } from 'effect/testing';
import type { Binary } from 'mongodb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CONTENT_EMBEDDING_DIMENSIONS } from '#common/search/search.constants';
import { CONTENT_MAX_TOKENS, CONTENT_TOKEN_MARGIN } from '../shared/config';
import { EmbeddingErrorType } from '../shared/errors';
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

describe('Embedding content', () => {
  interface Call {
    readonly url: string;
    readonly authorization: string | undefined;
    readonly body: Record<string, unknown> | undefined;
    readonly at: number;
  }

  type Respond = 'network' | 'hang' | 'llama-format' | number;

  const calls: Array<Call> = [];
  let pieces: Array<string | Array<number>> = [];
  let respond: Respond | undefined;

  beforeEach(() => {
    calls.length = 0;
    pieces = [];
    respond = undefined;
  });

  const stubHttpClient = HttpClient.make((request) =>
    Effect.gen(function* () {
      const at = yield* Effect.clockWith((clock) => Effect.succeed(clock.currentTimeMillisUnsafe()));
      const raw = (request.body as { body?: Uint8Array }).body;
      const body = raw ? (JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>) : undefined;
      calls.push({ url: request.url, authorization: request.headers['authorization'], body, at });

      if (respond === 'network') {
        return yield* Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request, description: 'ECONNREFUSED' }),
          }),
        );
      }
      if (respond === 'hang') {
        return yield* Effect.never;
      }
      if (respond === 'llama-format') {
        return HttpClientResponse.fromWeb(request, new Response(JSON.stringify([{ index: 0, embedding: [[0.1]] }])));
      }
      if (typeof respond === 'number') {
        return HttpClientResponse.fromWeb(
          request,
          new Response('input (2000 tokens) is too large to process', { status: respond }),
        );
      }

      const json = request.url.endsWith('/tokenize')
        ? { tokens: pieces.map((piece, id) => ({ id, piece })) }
        : request.url.endsWith('/health')
          ? { status: 'ok' }
          : { data: (body!.input as Array<string>).map((_, index) => ({ embedding: randomVector(index + 1) })) };
      return HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(json), { headers: { 'content-type': 'application/json' } }),
      );
    }),
  );

  const makeLayer = (env: Record<string, string> = {}) =>
    Embedding.layerWithoutDependencies.pipe(
      Layer.provide(Environment.layer),
      Layer.provide(Layer.succeed(HttpClient.HttpClient, stubHttpClient)),
      Layer.provide(RateLimiter.layer.pipe(Layer.provide(RateLimiter.layerStoreMemory))),
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnvRecord({
            ORFARCHIV_EMBEDDING_URL: 'http://embeddings.test/v1',
            ORFARCHIV_EMBEDDING_TOKEN: 'secret',
            ...env,
          }),
        ),
      ),
    );

  function run<A>(use: (service: typeof Embedding.Service) => Effect.Effect<A, unknown>, env?: Record<string, string>) {
    return Effect.gen(function* () {
      const service = yield* Embedding;
      return yield* use(service);
    }).pipe(Effect.provide(makeLayer(env)), Effect.runPromise);
  }

  const prefix = 'title: Überschrift | text: ';
  const prefixPieces = ['title', ':', ' Über', 'schrift', ' |', ' text', ':', ' '];
  const bodyPieces = Array.from({ length: 2000 }, (_, index) => ` wort${index}`);
  const limit = CONTENT_MAX_TOKENS - CONTENT_TOKEN_MARGIN;

  it('sends a short input unchanged', async () => {
    const input = `${prefix}kurzer Text`;
    pieces = [...prefixPieces, 'kurzer', ' Text'];

    const result = await run((service) => service.truncateToTokens(input, CONTENT_MAX_TOKENS));

    expect(result).toBe(input);
  });

  it('cuts a long input at a token boundary and keeps the full prefix', async () => {
    pieces = [...prefixPieces, ...bodyPieces];

    const result = await run((service) => service.truncateToTokens(pieces.join(''), CONTENT_MAX_TOKENS));

    expect(result.startsWith(prefix)).toBe(true);
    expect(result).toBe(pieces.slice(0, limit).join(''));
  });

  it('sends tokenize requests to the server root with pieces and the bearer token', async () => {
    pieces = ['a'];

    await run((service) => service.truncateToTokens('a', CONTENT_MAX_TOKENS));

    expect(calls).toEqual([
      expect.objectContaining({
        url: 'http://embeddings.test/tokenize',
        authorization: 'Bearer secret',
        body: { content: 'a', with_pieces: true },
      }),
    ]);
  });

  it.each([
    { name: 'drops an incomplete trailing byte piece', tail: [[0xc3]], expected: '' },
    { name: 'drops an incomplete 3-byte character', tail: [[0xe2, 0x82]], expected: '' },
    { name: 'drops an incomplete 4-byte character', tail: [[0xf0, 0x9f], [0x98]], expected: '' },
    { name: 'keeps a complete 4-byte character', tail: [[0xf0, 0x9f, 0x98, 0x80]], expected: '😀' },
    { name: 'joins byte pieces that form a character at the end', tail: [[0xc3], [0x96]], expected: 'Ö' },
    { name: 'joins byte pieces that form a character mid-text', tail: [[0xc3], [0x96], 'l'], expected: 'Öl' },
  ])('$name when truncating', async ({ tail, expected }) => {
    const head = Array.from({ length: limit - tail.length }, () => 'a');
    pieces = [...head, ...tail, ' rest', ' rest'];

    const result = await run((service) => service.truncateToTokens('ignored', CONTENT_MAX_TOKENS));

    expect(result).toBe(head.join('') + expected);
  });

  it('embeds content one input per request at the content dimension', async () => {
    const result = await run((service) => service.embedContent(['a', 'b']));

    const embeddingCalls = calls.filter((call) => call.url === 'http://embeddings.test/v1/embeddings');
    expect(embeddingCalls.map((call) => call.body)).toEqual([{ input: ['a'] }, { input: ['b'] }]);
    expect(result.map((vector) => toInt8(vector).length)).toEqual([
      CONTENT_EMBEDDING_DIMENSIONS,
      CONTENT_EMBEDDING_DIMENSIONS,
    ]);
  });

  it('checks health at the server root', async () => {
    await run((service) => service.health());

    expect(calls.map((call) => call.url)).toEqual(['http://embeddings.test/health']);
  });

  it.each([
    { name: 'a connection error', response: 'network', call: 'embedContent', type: EmbeddingErrorType.Unreachable },
    { name: 'a slow response', response: 'hang', call: 'embedContent', type: EmbeddingErrorType.Timeout },
    { name: 'HTTP 500 "too large"', response: 500, call: 'embedContent', type: EmbeddingErrorType.Rejected },
    { name: 'a non-OpenAI body', response: 'llama-format', call: 'embedContent', type: EmbeddingErrorType.Malformed },
    { name: 'HTTP 503 while loading', response: 503, call: 'health', type: EmbeddingErrorType.Rejected },
    { name: 'a connection error', response: 'network', call: 'health', type: EmbeddingErrorType.Unreachable },
    { name: 'a slow response', response: 'hang', call: 'health', type: EmbeddingErrorType.Timeout },
    { name: 'a slow response', response: 'hang', call: 'truncateToTokens', type: EmbeddingErrorType.Timeout },
  ] as const)('maps $name from $call to $type', async ({ response, call, type }) => {
    respond = response;
    const invoke = {
      embedContent: (service: typeof Embedding.Service) => service.embedContent(['a']),
      health: (service: typeof Embedding.Service) => service.health(),
      truncateToTokens: (service: typeof Embedding.Service) => service.truncateToTokens('a', CONTENT_MAX_TOKENS),
    };

    const exit = await Effect.gen(function* () {
      const service = yield* Embedding;
      const fiber = yield* invoke[call](service).pipe(Effect.exit, Effect.forkChild);
      yield* TestClock.adjust('1 minute');
      return yield* Fiber.join(fiber);
    }).pipe(Effect.provide(Layer.merge(makeLayer(), TestClock.layer())), Effect.runPromise);

    expect(exit).toMatchObject({ _tag: 'Failure', cause: { reasons: [{ error: { _tag: 'EmbeddingError', type } }] } });
  });

  it.each([
    { url: 'http://e.test/v1', root: 'http://e.test', api: 'http://e.test/v1' },
    { url: 'http://e.test/v1/', root: 'http://e.test', api: 'http://e.test/v1' },
    { url: 'http://e.test', root: 'http://e.test', api: 'http://e.test' },
  ])('derives the endpoints from $url', async ({ url, root, api }) => {
    pieces = ['a'];

    await run(
      (service) =>
        Effect.gen(function* () {
          yield* service.health();
          yield* service.truncateToTokens('a', CONTENT_MAX_TOKENS);
          yield* service.embedContent(['a']);
        }),
      { ORFARCHIV_EMBEDDING_URL: url },
    );

    expect(calls.map((call) => call.url)).toEqual([`${root}/health`, `${root}/tokenize`, `${api}/embeddings`]);
  });

  function requestTimes(use: (service: typeof Embedding.Service) => Effect.Effect<unknown, unknown>) {
    return Effect.gen(function* () {
      const service = yield* Embedding;
      const fiber = yield* use(service).pipe(Effect.forkChild);
      yield* TestClock.adjust('10 minutes');
      yield* Fiber.join(fiber);
      return calls.map((call) => call.at);
    });
  }

  const pacingEnv = {
    ORFARCHIV_EMBEDDING_RATE_LIMIT: '1',
    ORFARCHIV_EMBEDDING_RATE_WINDOW: '1 minute',
    ORFARCHIV_CONTENT_EMBEDDING_RATE_LIMIT: '1000',
    ORFARCHIV_CONTENT_EMBEDDING_RATE_WINDOW: '1 minute',
  };

  it.each([
    {
      name: 'content uses ORFARCHIV_CONTENT_EMBEDDING_RATE_* and ignores ORFARCHIV_EMBEDDING_RATE_*',
      env: pacingEnv,
      use: (service: typeof Embedding.Service) => service.embedContent(['a', 'b', 'c']),
      expected: [0, 0, 0],
    },
    {
      name: 'content is paced by its own limit',
      env: { ...pacingEnv, ORFARCHIV_CONTENT_EMBEDDING_RATE_LIMIT: '1' },
      use: (service: typeof Embedding.Service) => service.embedContent(['a', 'b', 'c']),
      expected: [0, 60_000, 120_000],
    },
    {
      name: 'titles ignore ORFARCHIV_CONTENT_EMBEDDING_RATE_*',
      env: { ...pacingEnv, ORFARCHIV_EMBEDDING_RATE_LIMIT: '100', ORFARCHIV_CONTENT_EMBEDDING_RATE_LIMIT: '1' },
      use: (service: typeof Embedding.Service) =>
        Effect.forEach(['a', 'b', 'c'], (title) => service.embed([title]), { concurrency: 1 }),
      expected: [0, 0, 0],
    },
  ])('$name', async ({ env, use, expected }) => {
    const times = await requestTimes(use).pipe(
      Effect.provide(Layer.merge(makeLayer(env), TestClock.layer())),
      Effect.runPromise,
    );

    expect(times).toEqual(expected);
  });
});
