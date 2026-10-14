import { ConfigProvider, Duration, Effect, Fiber, Layer } from 'effect';
import { HttpClient, HttpClientError, HttpClientResponse } from 'effect/http';
import { RateLimiter } from 'effect/persistence';
import { TestClock } from 'effect/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { Environment } from './env';
import { StoryPageErrorReason } from '../shared/errors';
import { StoryPageFetcher } from './fetcher';

const URL = 'https://orf.at/stories/1/';

interface Request {
  readonly url: string;
  readonly userAgent: string | undefined;
  readonly at: number;
}

describe('StoryPageFetcher', () => {
  const requests: Array<Request> = [];
  let respond: (attempt: number) => number | 'network' | 'stall' = () => 200;

  beforeEach(() => {
    requests.length = 0;
    respond = () => 200;
  });

  const stubHttpClient = HttpClient.make((request) =>
    Effect.gen(function* () {
      const at = yield* Effect.clockWith((clock) => Effect.succeed(clock.currentTimeMillisUnsafe()));
      requests.push({ url: request.url, userAgent: request.headers['user-agent'], at });
      const status = respond(requests.length);
      if (status === 'network') {
        return yield* Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request, description: 'ECONNRESET' }),
          }),
        );
      }
      if (status === 'stall') {
        const body = new ReadableStream({
          start: (controller) => controller.enqueue(new TextEncoder().encode('<html>partial')),
        });
        return HttpClientResponse.fromWeb(request, new Response(body, { status: 200 }));
      }
      return HttpClientResponse.fromWeb(request, new Response(`<html>${status}</html>`, { status }));
    }),
  );

  const layer = (env: Record<string, string> = {}) =>
    StoryPageFetcher.layerWithoutDependencies.pipe(
      Layer.provide(Environment.layer),
      Layer.provide(Layer.succeed(HttpClient.HttpClient, stubHttpClient)),
      Layer.provide(RateLimiter.layer.pipe(Layer.provide(RateLimiter.layerStoreMemory))),
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(env))),
    );

  function fetchWithClock(
    urls: ReadonlyArray<string>,
    env?: Record<string, string>,
    advance: Duration.Input = '1 minute',
  ) {
    return Effect.gen(function* () {
      const fetcher = yield* StoryPageFetcher;
      const fiber = yield* Effect.forEach(urls, (url) => fetcher.fetchPage(url).pipe(Effect.result), {
        concurrency: 10,
      }).pipe(Effect.forkChild);
      yield* TestClock.adjust(advance);
      return yield* Fiber.join(fiber);
    }).pipe(Effect.provide(Layer.merge(layer(env), TestClock.layer())), Effect.runPromise);
  }

  function expectAtMostPerWindow(limit: number, windowMillis: number) {
    for (const request of requests) {
      const inWindow = requests.filter((other) => other.at > request.at - windowMillis && other.at <= request.at);
      expect(inWindow.length).toBeLessThanOrEqual(limit);
    }
  }

  it('returns the page and sends the configured User-Agent', async () => {
    const [result] = await fetchWithClock([URL], { ORFARCHIV_CONTENT_USER_AGENT: 'test-agent/1.0' });

    expect(result).toMatchObject({ _tag: 'Success', success: '<html>200</html>' });
    expect(requests).toEqual([expect.objectContaining({ url: URL, userAgent: 'test-agent/1.0' })]);
  });

  it('sends the default User-Agent', async () => {
    await fetchWithClock([URL]);

    expect(requests[0].userAgent).toMatch(/^orfarchiv-scraper\/\S+ \(\+https:\/\/orfarchiv\.news\)$/);
  });

  it.each([404, 410])('treats %i as unavailable without retrying', async (status) => {
    respond = () => status;

    const [result] = await fetchWithClock([URL]);

    expect(result).toMatchObject({ _tag: 'Failure', failure: { reason: StoryPageErrorReason.Unavailable, status } });
    expect(requests).toHaveLength(1);
  });

  it.each([
    { name: '503', response: 503 as const },
    { name: 'a network error', response: 'network' as const },
  ])('retries $name and then fails as transient', async ({ response }) => {
    respond = () => response;

    const [result] = await fetchWithClock([URL]);

    expect(result).toMatchObject({ _tag: 'Failure', failure: { reason: StoryPageErrorReason.Transient } });
    expect(requests).toHaveLength(4);
  });

  it('succeeds when a retry succeeds', async () => {
    respond = (attempt) => (attempt === 1 ? 502 : 200);

    const [result] = await fetchWithClock([URL]);

    expect(result).toMatchObject({ _tag: 'Success' });
    expect(requests).toHaveLength(2);
  });

  it.each([429, 403])('fails %i as transient without retrying', async (status) => {
    respond = () => status;

    const [result] = await fetchWithClock([URL]);

    expect(result).toMatchObject({ _tag: 'Failure', failure: { reason: StoryPageErrorReason.Transient, status } });
    expect(requests).toHaveLength(1);
  });

  it('never exceeds the configured fetch rate', async () => {
    const urls = Array.from({ length: 35 }, (_, index) => `https://orf.at/stories/${index}/`);

    await fetchWithClock(urls, {
      ORFARCHIV_CONTENT_FETCH_RATE_LIMIT: '10',
      ORFARCHIV_CONTENT_FETCH_RATE_WINDOW: '1 second',
    });

    expect(requests).toHaveLength(35);
    expectAtMostPerWindow(10, 1000);
    expect(Math.max(...requests.map((request) => request.at))).toBeGreaterThanOrEqual(2000);
  });

  it('counts retries against the fetch rate', async () => {
    respond = () => 503;
    const urls = Array.from({ length: 10 }, (_, index) => `https://orf.at/stories/${index}/`);

    await fetchWithClock(urls, {
      ORFARCHIV_CONTENT_FETCH_RATE_LIMIT: '10',
      ORFARCHIV_CONTENT_FETCH_RATE_WINDOW: '1 second',
    });

    expect(requests).toHaveLength(40);
    expectAtMostPerWindow(10, 1000);
  });

  it('times out a page whose body stalls and retries it', async () => {
    respond = () => 'stall';

    const [result] = await fetchWithClock([URL], {}, '5 minutes');

    expect(result).toMatchObject({
      _tag: 'Failure',
      failure: { reason: StoryPageErrorReason.Transient, message: `Fetching '${URL}' timed out.` },
    });
    expect(requests).toHaveLength(4);
  });

  it('does not count waiting for the rate limiter against the timeout', async () => {
    const urls = Array.from({ length: 5 }, (_, index) => `https://orf.at/stories/${index}/`);

    const results = await fetchWithClock(
      urls,
      { ORFARCHIV_CONTENT_FETCH_RATE_LIMIT: '1', ORFARCHIV_CONTENT_FETCH_RATE_WINDOW: '10 seconds' },
      '1 minute',
    );

    expect(results.map((result) => result._tag)).toEqual(['Success', 'Success', 'Success', 'Success', 'Success']);
    expect(Math.max(...requests.map((request) => request.at))).toBe(40_000);
  });
});
