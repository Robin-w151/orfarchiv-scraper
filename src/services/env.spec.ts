import { ConfigProvider, Duration, Effect, Exit } from 'effect';
import { describe, expect, it } from 'vitest';
import { Environment } from './env';

describe('Environment rate limits', () => {
  function load(env: Record<string, string>) {
    return Effect.gen(function* () {
      const environment = yield* Environment;
      return {
        title: yield* Effect.exit(environment.embeddingRateLimit),
        fetch: yield* Effect.exit(environment.contentFetchRateLimit),
        content: yield* Effect.exit(environment.contentEmbeddingRateLimit),
      };
    }).pipe(
      Effect.provide(Environment.layer),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(env))),
      Effect.runPromise,
    );
  }

  function loadFetchRateLimit(limit: string, window: string) {
    return load({
      ORFARCHIV_CONTENT_FETCH_RATE_LIMIT: limit,
      ORFARCHIV_CONTENT_FETCH_RATE_WINDOW: window,
    }).then(({ fetch }) => fetch);
  }

  it('uses the defaults', async () => {
    const { title, fetch, content } = await load({});

    expect(title).toEqual(Exit.succeed({ limit: 1000, window: Duration.minutes(1) }));
    expect(fetch).toEqual(Exit.succeed({ limit: 10, window: Duration.seconds(1) }));
    expect(content).toEqual(Exit.succeed({ limit: 100, window: Duration.minutes(1) }));
  });

  it.each([
    { limit: '10', window: '1 second', expected: { limit: 10, window: Duration.seconds(1) } },
    { limit: ' 100 ', window: ' 1 minute ', expected: { limit: 100, window: Duration.minutes(1) } },
    { limit: '1', window: '500 millis', expected: { limit: 1, window: Duration.millis(500) } },
  ])('accepts $limit per $window', async ({ limit, window, expected }) => {
    expect(await loadFetchRateLimit(limit, window)).toEqual(Exit.succeed(expected));
  });

  it.each([{ variable: 'ORFARCHIV_CONTENT_FETCH_RATE_LIMIT' }, { variable: 'ORFARCHIV_CONTENT_FETCH_RATE_WINDOW' }])(
    'uses the default for an empty $variable',
    async ({ variable }) => {
      const { fetch } = await load({ [variable]: '' });

      expect(fetch).toEqual(Exit.succeed({ limit: 10, window: Duration.seconds(1) }));
    },
  );

  it.each([
    { limit: 'ten', window: '1 second' },
    { limit: '   ', window: '1 second' },
    { limit: '0', window: '1 second' },
    { limit: '-1', window: '1 second' },
    { limit: '1.5', window: '1 second' },
    { limit: '10', window: '1 sec' },
    { limit: '10', window: '0 seconds' },
  ])("rejects '$limit' per '$window'", async ({ limit, window }) => {
    expect(await loadFetchRateLimit(limit, window)).toMatchObject({
      _tag: 'Failure',
      cause: {
        reasons: [
          {
            error: {
              _tag: 'ConfigError',
              message: expect.stringContaining('ORFARCHIV_CONTENT_FETCH_RATE_LIMIT'),
            },
          },
        ],
      },
    });
  });

  it.each([
    { name: 'title', variable: 'ORFARCHIV_EMBEDDING_RATE_LIMIT' },
    { name: 'fetch', variable: 'ORFARCHIV_CONTENT_FETCH_RATE_LIMIT' },
    { name: 'content', variable: 'ORFARCHIV_CONTENT_EMBEDDING_RATE_LIMIT' },
  ] as const)('fails only the $name limit when $variable is invalid', async ({ name, variable }) => {
    const exits = await load({ [variable]: 'ten' });

    for (const [key, exit] of Object.entries(exits)) {
      expect(Exit.isFailure(exit)).toBe(key === name);
    }
  });
});
