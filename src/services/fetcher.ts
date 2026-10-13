import { Context, Duration, Effect, Layer, Schedule } from 'effect';
import { FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/http';
import { RateLimiter } from 'effect/persistence';
import { CONTENT_FETCH_TIMEOUT } from '../shared/config';
import { StoryPageError, StoryPageErrorReason } from '../shared/errors';
import { withTimeout } from '../shared/timeout';
import { Environment } from './env';

const UNAVAILABLE_STATUSES = new Set([404, 410]);

export class StoryPageFetcher extends Context.Service<StoryPageFetcher>()('StoryPageFetcher', {
  make: Effect.gen(function* () {
    const environment = yield* Environment;
    const httpClient = yield* HttpClient.HttpClient;
    const withLimiter = yield* RateLimiter.makeWithRateLimiter;

    const userAgent = yield* environment.contentUserAgent;
    const { limit, window } = yield* environment.contentFetchRateLimit;

    return defineService({ httpClient, withLimiter, userAgent, limit, window });
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
  userAgent,
  limit,
  window,
}: {
  httpClient: HttpClient.HttpClient;
  withLimiter: Effect.Success<typeof RateLimiter.makeWithRateLimiter>;
  userAgent: string;
  limit: number;
  window: Duration.Duration;
}) {
  function fetchPage(url: string) {
    return Effect.gen(function* () {
      const request = HttpClientRequest.get(url).pipe(HttpClientRequest.setHeader('user-agent', userAgent));
      const response = yield* httpClient.execute(request).pipe(
        Effect.mapError(
          (error) =>
            new StoryPageError({
              message: `Failed to fetch '${url}'.`,
              url,
              reason: StoryPageErrorReason.Transient,
              cause: error,
            }),
        ),
      );

      if (response.status >= 400) {
        return yield* new StoryPageError({
          message: `Fetching '${url}' failed with status ${response.status}.`,
          url,
          reason: UNAVAILABLE_STATUSES.has(response.status)
            ? StoryPageErrorReason.Unavailable
            : StoryPageErrorReason.Transient,
          status: response.status,
          cause: undefined,
        });
      }

      return yield* response.text.pipe(
        Effect.mapError(
          (error) =>
            new StoryPageError({
              message: `Failed to read '${url}'.`,
              url,
              reason: StoryPageErrorReason.Transient,
              cause: error,
            }),
        ),
      );
    }).pipe(
      withTimeout(
        CONTENT_FETCH_TIMEOUT,
        () =>
          new StoryPageError({
            message: `Fetching '${url}' timed out.`,
            url,
            reason: StoryPageErrorReason.Transient,
            cause: undefined,
          }),
      ),
      withLimiter({
        key: 'orf-pages',
        algorithm: 'fixed-window',
        onExceeded: 'delay',
        window,
        limit,
      }),
      Effect.catchTag(
        'RateLimiterError',
        (error) =>
          new StoryPageError({
            message: 'Rate limiting failed.',
            url,
            reason: StoryPageErrorReason.Transient,
            cause: error,
          }),
      ),
      Effect.retry({
        schedule: Schedule.jittered(Schedule.max([Schedule.exponential('1 second'), Schedule.recurs(3)])),
        while: isRetryable,
      }),
    );
  }

  return { fetchPage };
}

function isRetryable(error: StoryPageError) {
  return error.reason !== StoryPageErrorReason.Unavailable && (error.status === undefined || error.status >= 500);
}
