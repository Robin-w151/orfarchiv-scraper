import { CONTENT_STATUS } from '#common/search/search.constants';
import { StoryContentService } from '#common/storyContent/storyContent';
import { parseTargets, withContentExclusions } from '#common/targets/targets';
import { Clock, Duration, Effect, Exit, Fiber, Layer, Logger, Option } from 'effect';
import { TestClock } from 'effect/testing';
import { Binary } from 'mongodb';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DatabaseError,
  EmbeddingError,
  EmbeddingErrorType,
  StoryPageError,
  StoryPageErrorReason,
} from '../shared/errors';
import { CONTENT_MAX_TOKENS } from '../shared/config';
import { ContentEmbedding, selectContentTargets } from './content';
import { Database, type ContentCandidate, type ContentResult } from './database';
import { Embedding } from './embedding';
import { StoryPageFetcher } from './fetcher';

const regionalHtml = readFixture('regional-story.html');
const teaserHtml = readFixture('news-teaser.html');
const TEASER_TEXT =
  'Nach zwei Jahren ausschließlicher Präsenz als TV-Format in CoV-Zeiten kann das Brauchtumsfestival „Aufsteirern“ heute und morgen wieder in der Grazer Innenstadt stattfinden.\n\nMehr dazu in steiermark.ORF.at';

function readFixture(file: string) {
  return readFileSync(new URL(`../shared/common/src/storyContent/fixtures/${file}`, import.meta.url), 'utf8');
}

type Page = { readonly html: string } | { readonly error: StoryPageErrorReason };

const unavailable = { error: StoryPageErrorReason.Unavailable } as const;
const transient = { error: StoryPageErrorReason.Transient } as const;

const targets = parseTargets('mongodb://a:27017/\nmongodb://b:27017/');
const vector = Binary.fromInt8Array(Int8Array.from([1, 2, 3]));

function storyOf(index: number, page: Page = { html: regionalHtml }) {
  return { id: `news:${index}`, title: `Titel ${index}`, url: `https://orf.at/stories/${index}/`, page };
}

describe('ContentEmbedding', () => {
  let stories: Array<ReturnType<typeof storyOf>> = [];
  const status = new Map<string, string>();
  const queries: Array<{ at: number; ids: Array<string> }> = [];
  const writes: Array<{ results: ReadonlyArray<ContentResult>; targets: Array<string> }> = [];
  const fetches: Array<string> = [];
  const embedded: Array<string> = [];
  const truncations: Array<{ input: string; maxTokens: number }> = [];
  let truncateTo: number | undefined;
  const logs: Array<string> = [];
  let failingHealthChecks = 0;
  let embedFailure: EmbeddingError | undefined;
  const embedFailureByTitle = new Map<string, EmbeddingError>();
  let findFailures = 0;
  const failingWriteTargets = new Set<string>();

  beforeEach(() => {
    stories = [];
    status.clear();
    queries.length = 0;
    writes.length = 0;
    fetches.length = 0;
    embedded.length = 0;
    truncations.length = 0;
    truncateTo = undefined;
    logs.length = 0;
    failingHealthChecks = 0;
    embedFailure = undefined;
    embedFailureByTitle.clear();
    findFailures = 0;
    failingWriteTargets.clear();
  });

  const databaseStub = Layer.succeed(Database, {
    persistOrfNews: () => Effect.die('unused'),
    backfillEmbeddings: () => Effect.die('unused'),
    findStoriesWithoutContent: (_target, { limit, excludeIds }) =>
      Effect.gen(function* () {
        if (findFailures > 0) {
          findFailures--;
          return yield* new DatabaseError({ message: 'find failed', cause: undefined });
        }
        const at = yield* Clock.currentTimeMillis;
        const selected: Array<ContentCandidate> = stories
          .filter((story) => !status.has(story.id) && !excludeIds.includes(story.id))
          .slice(0, limit)
          .map(({ id, title, url }) => ({ id, title, url }));
        queries.push({ at, ids: selected.map((story) => story.id) });
        return selected;
      }),
    countStoriesWithoutContent: () => Effect.sync(() => stories.filter((story) => !status.has(story.id)).length),
    writeContentResults: (results, writeTargets) =>
      Effect.sync(() => {
        writes.push({ results, targets: writeTargets.map((target) => target.label) });
        const written = writeTargets.filter((target) => !failingWriteTargets.has(target.label));
        if (written.some((target) => target.label === writeTargets[0].label)) {
          for (const result of results) {
            status.set(result.id, 'failed' in result ? CONTENT_STATUS.failed : CONTENT_STATUS.embedded);
          }
        }
        return written;
      }),
  });

  const fetcherStub = Layer.succeed(StoryPageFetcher, {
    fetchPage: (url) =>
      Effect.gen(function* () {
        fetches.push(url);
        const page = stories.find((story) => story.url === url)!.page;
        if ('error' in page) {
          return yield* new StoryPageError({
            message: `Fetching '${url}' failed.`,
            url,
            reason: page.error,
            status: page.error === StoryPageErrorReason.Unavailable ? 404 : 503,
            cause: undefined,
          });
        }
        return page.html;
      }),
  });

  const embeddingStub = Layer.succeed(Embedding, {
    embed: () => Effect.die('unused'),
    embedContent: (inputs) =>
      Effect.gen(function* () {
        const failure =
          embedFailure ?? [...embedFailureByTitle].find(([title]) => inputs[0].startsWith(`title: ${title} | `))?.[1];
        if (failure) {
          return yield* failure;
        }
        embedded.push(...inputs);
        return inputs.map(() => vector);
      }),
    truncateToTokens: (input, maxTokens) =>
      Effect.sync(() => {
        truncations.push({ input, maxTokens });
        return truncateTo === undefined ? input : input.slice(0, truncateTo);
      }),
    health: () =>
      Effect.suspend(() =>
        failingHealthChecks-- > 0
          ? Effect.fail(new EmbeddingError({ message: 'down', type: EmbeddingErrorType.Unreachable, cause: undefined }))
          : Effect.void,
      ),
  });

  const captureLogs = Logger.layer([
    Logger.make(({ message }) => {
      logs.push(Array.isArray(message) ? message.join(' ') : String(message));
    }),
  ]);

  const layer = ContentEmbedding.layerWithoutDependencies.pipe(
    Layer.provide(databaseStub),
    Layer.provide(fetcherStub),
    Layer.provide(embeddingStub),
    Layer.provide(StoryContentService.layer),
    Layer.provideMerge(captureLogs),
  );

  function withService<A, E>(use: (service: typeof ContentEmbedding.Service) => Effect.Effect<A, E>) {
    return Effect.gen(function* () {
      const service = yield* ContentEmbedding;
      return yield* use(service);
    }).pipe(Effect.provide(layer));
  }

  function runOnce(service: typeof ContentEmbedding.Service) {
    return service.run({ poll: false, idleInterval: Duration.minutes(1), batchSize: 10 }, targets).pipe(Effect.exit);
  }

  function runPolling(advance: ReadonlyArray<Duration.Input>, idleInterval = Duration.minutes(1), batchSize = 10) {
    return Effect.gen(function* () {
      const service = yield* ContentEmbedding;
      const fiber = yield* service.run({ poll: true, idleInterval, batchSize }, targets).pipe(Effect.forkChild);
      for (const duration of advance) {
        yield* TestClock.adjust(duration);
      }
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.provide(Layer.merge(layer, TestClock.layer())), Effect.runPromise);
  }

  it('embeds articles, marks terminal failures and leaves transient ones alone', async () => {
    stories = [
      storyOf(1),
      storyOf(2, unavailable),
      storyOf(3, { html: '<html><body></body></html>' }),
      storyOf(4, transient),
    ];

    const exit = await withService(runOnce).pipe(Effect.runPromise);

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(writes).toEqual([
      {
        results: [
          { id: 'news:1', contentEmbedding: vector },
          { id: 'news:2', failed: true },
          { id: 'news:3', failed: true },
        ],
        targets: ['a:27017', 'b:27017'],
      },
    ]);
    expect(logs).toContain("Story 'news:2' failed (unavailable): Fetching 'https://orf.at/stories/2/' failed.");
    expect(logs.some((log) => log.startsWith("Story 'news:3' failed (empty)"))).toBe(true);
    expect(logs).toContain('Processed 4 stories: 1 embedded, 2 failed (1 unavailable, 1 empty), 1 transient.');
  });

  it('embeds the extracted article text after the title', async () => {
    stories = [storyOf(1)];
    const text = await Effect.gen(function* () {
      const storyContent = yield* StoryContentService;
      return yield* storyContent.extractArticleText(regionalHtml, stories[0].url);
    }).pipe(Effect.provide(StoryContentService.layer), Effect.runPromise);

    await withService(runOnce).pipe(Effect.runPromise);

    expect(embedded).toEqual([`title: Titel 1 | text: ${text}`]);
  });

  it('truncates the input to CONTENT_MAX_TOKENS and embeds the truncated text', async () => {
    stories = [storyOf(1)];
    truncateTo = 50;

    await withService(runOnce).pipe(Effect.runPromise);

    expect(truncations).toHaveLength(1);
    expect(truncations[0].maxTokens).toBe(CONTENT_MAX_TOKENS);
    expect(truncations[0].input.startsWith('title: Titel 1 | text: ')).toBe(true);
    expect(truncations[0].input.length).toBeGreaterThan(50);
    expect(embedded).toEqual([truncations[0].input.slice(0, 50)]);
  });

  it('does not select an unavailable or transiently failing story again', async () => {
    stories = [storyOf(1, unavailable), storyOf(2, transient), storyOf(3)];

    await withService((service) =>
      Effect.gen(function* () {
        yield* runOnce(service);
        stories.push(storyOf(4));
        yield* runOnce(service);
      }),
    ).pipe(Effect.runPromise);

    expect(queries.map((query) => query.ids)).toEqual([['news:1', 'news:2', 'news:3'], ['news:4']]);
    expect(fetches.filter((url) => url.endsWith('/1/'))).toHaveLength(1);
  });

  it('retries a transiently failing story after the cooldown', async () => {
    stories = [storyOf(1, transient)];

    await runPolling(['1 minute', '59 minutes', '1 minute']);

    expect(fetches).toHaveLength(2);
  });

  it('fetches a teaser page once and embeds its own text', async () => {
    stories = [storyOf(1, { html: teaserHtml })];

    await withService(runOnce).pipe(Effect.runPromise);

    expect(fetches).toEqual(['https://orf.at/stories/1/']);
    expect(embedded).toEqual([`title: Titel 1 | text: ${TEASER_TEXT}`]);
  });

  it('ends the batch before fetching when the embedding server is down and retries after the idle interval', async () => {
    stories = [storyOf(1), storyOf(2)];
    failingHealthChecks = 1;

    await runPolling([Duration.minutes(1)]);

    expect(queries.slice(0, 2)).toEqual([
      { at: 0, ids: ['news:1', 'news:2'] },
      { at: 60_000, ids: ['news:1', 'news:2'] },
    ]);
    expect(fetches).toEqual(['https://orf.at/stories/1/', 'https://orf.at/stories/2/']);
    expect(writes).toHaveLength(1);
    expect([...status.values()]).toEqual([CONTENT_STATUS.embedded, CONTENT_STATUS.embedded]);
  });

  it('stops embedding when the server goes down mid-batch and keeps terminal failures', async () => {
    stories = [storyOf(1, unavailable), storyOf(2), storyOf(3)];
    embedFailure = new EmbeddingError({ message: 'down', type: EmbeddingErrorType.Unreachable, cause: undefined });

    const exit = await withService(runOnce).pipe(Effect.runPromise);

    expect(exit).toEqual(Exit.fail(embedFailure));
    expect(writes.map((write) => write.results)).toEqual([[{ id: 'news:1', failed: true }]]);
    expect(status.has('news:2')).toBe(false);
  });

  it('treats a rejected embedding as transient for that story', async () => {
    stories = [storyOf(1), storyOf(2)];
    embedFailure = new EmbeddingError({ message: 'too large', type: EmbeddingErrorType.Rejected, cause: undefined });

    const exit = await withService(runOnce).pipe(Effect.runPromise);

    expect(exit).toMatchObject({ _tag: 'Failure', cause: { reasons: [{ error: { _tag: 'ContentError' } }] } });
    expect(writes.map((write) => write.results)).toEqual([[]]);
    expect(logs).toContain('Processed 2 stories: 0 embedded, 0 failed (0 unavailable, 0 empty), 2 transient.');
    expect(logs).toContain("Failed to embed content of story 'news:1': too large");
  });

  it('runs batches back to back while there is a backlog and waits when it is empty', async () => {
    stories = Array.from({ length: 25 }, (_, index) => storyOf(index + 1));

    await runPolling([Duration.seconds(59), Duration.seconds(1)]);

    expect(queries.map((query) => [query.at, query.ids.length])).toEqual([
      [0, 10],
      [0, 10],
      [0, 5],
      [60_000, 0],
    ]);
  });

  it('logs a failing batch and keeps polling', async () => {
    stories = [storyOf(1)];
    findFailures = 1;

    await runPolling([Duration.minutes(1)]);

    expect(logs).toContain('Content batch failed: find failed');
    expect(queries).toEqual([{ at: 60_000, ids: ['news:1'] }]);
    expect(status.get('news:1')).toBe(CONTENT_STATUS.embedded);
  });

  it('without --poll fails when the write to the selection target fails', async () => {
    stories = [storyOf(1)];
    failingWriteTargets.add('a:27017');

    const exit = await withService(runOnce).pipe(Effect.runPromise);

    expect(exit).toMatchObject({
      _tag: 'Failure',
      cause: {
        reasons: [
          {
            error: {
              message: "Failed to write content results to 'a:27017', the target stories are selected from.",
            },
          },
        ],
      },
    });
  });

  it('waits before the next batch when the write to the selection target fails', async () => {
    stories = [storyOf(1)];
    failingWriteTargets.add('a:27017');

    await runPolling([Duration.seconds(59)]);

    expect(queries).toEqual([{ at: 0, ids: ['news:1'] }]);
    expect(logs).toContain(
      "Content batch failed: Failed to write content results to 'a:27017', the target stories are selected from.",
    );
  });

  it('keeps going when only a secondary target fails to write', async () => {
    stories = [storyOf(1)];
    failingWriteTargets.add('b:27017');

    const exit = await withService(runOnce).pipe(Effect.runPromise);

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(status.get('news:1')).toBe(CONTENT_STATUS.embedded);
  });

  it('logs the remaining backlog every 10 batches', async () => {
    stories = Array.from({ length: 12 }, (_, index) => storyOf(index + 1));

    await runPolling([Duration.seconds(1)], Duration.minutes(1), 1);

    expect(logs).toContain("Remaining backlog on 'a:27017': 2 stories.");
  });

  it.each([
    { name: 'stops after --max-docs', maxDocs: 3, expected: 3 },
    { name: 'stops when the backlog is drained', maxDocs: undefined, expected: 5 },
  ])('without --poll $name', async ({ maxDocs, expected }) => {
    stories = Array.from({ length: 5 }, (_, index) => storyOf(index + 1));

    const exit = await withService((service) =>
      service.run({ poll: false, idleInterval: Duration.minutes(1), batchSize: 2, maxDocs }, targets),
    ).pipe(Effect.exit, Effect.runPromise);

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(status.size).toBe(expected);
  });

  it('waits before the next batch when every story failed transiently', async () => {
    stories = Array.from({ length: 6 }, (_, index) => storyOf(index + 1, transient));

    await runPolling([Duration.seconds(59), Duration.seconds(1)], Duration.minutes(1), 2);

    expect(queries.map((query) => [query.at, query.ids])).toEqual([
      [0, ['news:1', 'news:2']],
      [60_000, ['news:3', 'news:4']],
    ]);
    expect(logs).toContain('Every story in the batch failed transiently (2). Waiting before the next batch.');
  });

  it('keeps going when only some stories failed transiently', async () => {
    stories = [storyOf(1, transient), storyOf(2), storyOf(3), storyOf(4)];

    await runPolling([Duration.seconds(0)], Duration.minutes(1), 2);

    expect(queries.slice(0, 2).map((query) => [query.at, query.ids])).toEqual([
      [0, ['news:1', 'news:2']],
      [0, ['news:3', 'news:4']],
    ]);
  });

  it('without --poll fails when every story failed transiently', async () => {
    stories = [storyOf(1, transient), storyOf(2, transient)];

    const exit = await withService((service) =>
      service.run({ poll: false, idleInterval: Duration.minutes(1), batchSize: 2 }, targets),
    ).pipe(Effect.exit, Effect.runPromise);

    expect(exit).toMatchObject({
      _tag: 'Failure',
      cause: { reasons: [{ error: { _tag: 'ContentError', message: expect.stringContaining('transiently') } }] },
    });
    expect(queries).toHaveLength(1);
  });

  it('cools down a story whose embedding times out, so it does not block the next ones', async () => {
    stories = [storyOf(1), storyOf(2)];
    embedFailureByTitle.set(
      'Titel 1',
      new EmbeddingError({
        message: 'Embedding request timed out.',
        type: EmbeddingErrorType.Timeout,
        cause: undefined,
      }),
    );

    await runPolling([Duration.minutes(1)]);

    expect(queries.map((query) => [query.at, query.ids])).toEqual([
      [0, ['news:1', 'news:2']],
      [60_000, ['news:2']],
    ]);
    expect(status.get('news:2')).toBe(CONTENT_STATUS.embedded);
    expect(status.has('news:1')).toBe(false);
    expect(logs.some((log) => log.startsWith("Embedding story 'news:1' timed out, ending batch early"))).toBe(true);
  });

  it('retries the same stories without a cooldown when the embedding server is unreachable mid-batch', async () => {
    stories = [storyOf(1), storyOf(2)];
    embedFailureByTitle.set(
      'Titel 1',
      new EmbeddingError({ message: 'down', type: EmbeddingErrorType.Unreachable, cause: undefined }),
    );

    await runPolling([Duration.minutes(1)]);

    expect(queries.map((query) => [query.at, query.ids])).toEqual([
      [0, ['news:1', 'news:2']],
      [60_000, ['news:1', 'news:2']],
    ]);
  });

  it('without --poll fails when the embedding server is down', async () => {
    stories = [storyOf(1)];
    failingHealthChecks = 1;

    const exit = await withService((service) =>
      service.run({ poll: false, idleInterval: Duration.minutes(1), batchSize: 2 }, targets),
    ).pipe(Effect.exit, Effect.runPromise);

    expect(Exit.isFailure(exit)).toBe(true);
    expect(fetches).toEqual([]);
  });
});

describe('selectContentTargets', () => {
  const { targets: configured } = withContentExclusions(
    parseTargets('mongodb://a:27017/\nmongodb://b.mongodb.net/'),
    'b.mongodb.net',
  );

  it('keeps only content-enabled targets', async () => {
    const selected = await selectContentTargets(configured, Option.none()).pipe(Effect.runPromise);

    expect(selected.map((target) => target.label)).toEqual(['a:27017']);
  });

  it('rejects an explicitly requested excluded target with its label', async () => {
    const excluded = configured.filter((target) => target.label === 'b.mongodb.net');

    const exit = await selectContentTargets(excluded, Option.some('b.mongodb.net')).pipe(
      Effect.exit,
      Effect.runPromise,
    );

    expect(exit).toMatchObject({
      _tag: 'Failure',
      cause: { reasons: [{ error: { message: expect.stringContaining("'b.mongodb.net' is excluded") } }] },
    });
  });

  it('fails when no target receives content', async () => {
    const exit = await selectContentTargets(
      configured.filter((target) => !target.content),
      Option.none(),
    ).pipe(Effect.exit, Effect.runPromise);

    expect(Exit.isFailure(exit)).toBe(true);
  });
});
