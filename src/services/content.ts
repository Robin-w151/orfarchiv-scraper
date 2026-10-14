import { toContentDocumentInput } from '#common/search/search';
import { StoryContentService } from '#common/storyContent/storyContent';
import type { Target } from '#common/targets/targets';
import { Clock, Context, Duration, Effect, Layer, Option, Result } from 'effect';
import {
  CONTENT_BACKLOG_LOG_INTERVAL,
  CONTENT_FETCH_CONCURRENCY,
  CONTENT_MAX_TOKENS,
  CONTENT_TRANSIENT_COOLDOWN,
} from '../shared/config';
import { ContentError, EmbeddingError, EmbeddingErrorType, StoryPageErrorReason, TargetError } from '../shared/errors';
import { Database, type ContentCandidate, type ContentResult } from './database';
import { Embedding } from './embedding';
import { StoryPageFetcher } from './fetcher';

export interface ContentRunOptions {
  readonly poll: boolean;
  readonly idleInterval: Duration.Duration;
  readonly batchSize: number;
  readonly maxDocs?: number;
}

const ContentFailureReason = {
  Unavailable: 'unavailable',
  Empty: 'empty',
} as const;
type ContentFailureReason = (typeof ContentFailureReason)[keyof typeof ContentFailureReason];

interface BatchStats {
  readonly selected: number;
  readonly embedded: number;
  readonly unavailable: number;
  readonly empty: number;
  readonly transient: number;
  readonly aborted?: EmbeddingError;
}

const BatchCounter = {
  Embedded: 'embedded',
  Unavailable: 'unavailable',
  Empty: 'empty',
  Transient: 'transient',
} as const;
type BatchCounter = (typeof BatchCounter)[keyof typeof BatchCounter];

interface Settlement {
  readonly result?: ContentResult;
  readonly counter?: BatchCounter;
  readonly aborted?: EmbeddingError;
}

const PageOutcomeType = {
  Text: 'text',
  Failed: 'failed',
  Transient: 'transient',
} as const;

type PageOutcome =
  | { readonly type: typeof PageOutcomeType.Text; readonly story: ContentCandidate; readonly text: string }
  | {
      readonly type: typeof PageOutcomeType.Failed;
      readonly story: ContentCandidate;
      readonly reason: ContentFailureReason;
      readonly message: string;
    }
  | { readonly type: typeof PageOutcomeType.Transient; readonly story: ContentCandidate; readonly message: string };

export class ContentEmbedding extends Context.Service<ContentEmbedding>()('ContentEmbedding', {
  make: Effect.gen(function* () {
    const database = yield* Database;
    const fetcher = yield* StoryPageFetcher;
    const embedding = yield* Embedding;
    const storyContent = yield* StoryContentService;
    return defineService({ database, fetcher, embedding, storyContent });
  }),
}) {
  static readonly layerWithoutDependencies = Layer.effect(this, this.make);
  static readonly layer = this.layerWithoutDependencies.pipe(
    Layer.provide(Database.layer),
    Layer.provide(StoryPageFetcher.layer),
    Layer.provide(Embedding.layer),
    Layer.provide(StoryContentService.layer),
  );
}

function defineService({
  database,
  fetcher,
  embedding,
  storyContent,
}: {
  database: typeof Database.Service;
  fetcher: typeof StoryPageFetcher.Service;
  embedding: typeof Embedding.Service;
  storyContent: typeof StoryContentService.Service;
}) {
  const cooldownUntil = new Map<string, number>();

  function run({ poll, idleInterval, batchSize, maxDocs }: ContentRunOptions, targets: ReadonlyArray<Target>) {
    return Effect.gen(function* () {
      let processed = 0;
      let batches = 0;

      for (;;) {
        const limit = maxDocs === undefined ? batchSize : Math.min(batchSize, maxDocs - processed);
        if (limit <= 0) {
          break;
        }

        const result = yield* runBatch(targets, limit).pipe(Effect.withLogSpan('batch'), Effect.result);
        batches++;
        if (batches % CONTENT_BACKLOG_LOG_INTERVAL === 0) {
          yield* logBacklog(targets[0]);
        }

        if (Result.isFailure(result)) {
          if (!poll) {
            return yield* Effect.fail(result.failure);
          }
          yield* Effect.logError(`Content batch failed: ${result.failure.message}`);
          yield* Effect.sleep(idleInterval);
          continue;
        }

        const stats = result.success;
        const settled = stats.embedded + stats.unavailable + stats.empty;
        processed += settled + stats.transient;
        if (stats.aborted) {
          if (!poll) {
            return yield* Effect.fail(stats.aborted);
          }
          yield* Effect.sleep(idleInterval);
        } else if (stats.transient > 0 && settled === 0) {
          const message = `Every story in the batch failed transiently (${stats.transient}).`;
          if (!poll) {
            return yield* new ContentError({ message });
          }
          yield* Effect.logWarning(`${message} Waiting before the next batch.`);
          yield* Effect.sleep(idleInterval);
        } else if (stats.selected < limit) {
          if (!poll) {
            break;
          }
          yield* Effect.sleep(idleInterval);
        }
      }

      yield* Effect.log(`Content embedding complete: ${processed} stories processed.`);
    });
  }

  function runBatch(targets: ReadonlyArray<Target>, limit: number) {
    return Effect.gen(function* () {
      const excludeIds = yield* activeCooldowns();
      const stories = yield* database.findStoriesWithoutContent(targets[0], { limit, excludeIds });
      if (stories.length === 0) {
        yield* Effect.log('No stories without content.');
        return toBatchStats(0, []);
      }

      const healthy = yield* embedding.health().pipe(Effect.result);
      if (Result.isFailure(healthy)) {
        yield* Effect.logWarning(`Embedding server is unavailable, ending batch early: ${healthy.failure.message}`);
        return { ...toBatchStats(stories.length, []), aborted: healthy.failure };
      }

      const outcomes = yield* Effect.forEach(stories, fetchText, { concurrency: CONTENT_FETCH_CONCURRENCY });
      const settlements = yield* settleOutcomes(outcomes);
      yield* writeResults(
        settlements.flatMap((settlement) => (settlement.result ? [settlement.result] : [])),
        targets,
      );

      const stats = toBatchStats(stories.length, settlements);
      yield* logBatch(stats);
      return stats;
    });
  }

  function settleOutcomes(outcomes: ReadonlyArray<PageOutcome>) {
    return Effect.gen(function* () {
      const settlements: Array<Settlement> = [];
      for (const outcome of outcomes) {
        const aborted = settlements.some((settlement) => settlement.aborted);
        settlements.push(yield* settleOutcome(outcome, aborted));
      }
      return settlements;
    });
  }

  function settleOutcome(outcome: PageOutcome, aborted: boolean) {
    return Effect.gen(function* () {
      const { story } = outcome;
      switch (outcome.type) {
        case PageOutcomeType.Failed:
          yield* Effect.log(`Story '${story.id}' failed (${outcome.reason}): ${outcome.message}`);
          return { result: { id: story.id, failed: true }, counter: outcome.reason };
        case PageOutcomeType.Transient:
          yield* coolDown(story.id);
          yield* Effect.logWarning(`Story '${story.id}' will be retried later: ${outcome.message}`);
          return { counter: BatchCounter.Transient };
        case PageOutcomeType.Text:
          return aborted ? {} : yield* embedStory(story, outcome.text);
      }
    }) satisfies Effect.Effect<Settlement>;
  }

  function embedStory(story: ContentCandidate, text: string) {
    return Effect.gen(function* () {
      const embedded = yield* embedText(story, text).pipe(Effect.result);
      if (Result.isSuccess(embedded)) {
        return { result: { id: story.id, contentEmbedding: embedded.success }, counter: BatchCounter.Embedded };
      }

      const error = embedded.failure;
      if (error.type === EmbeddingErrorType.Unreachable) {
        yield* Effect.logWarning(`Embedding server is unavailable, ending batch early: ${error.message}`);
        return { aborted: error };
      }

      yield* coolDown(story.id);
      if (error.type === EmbeddingErrorType.Timeout) {
        yield* Effect.logWarning(
          `Embedding story '${story.id}' timed out, ending batch early and retrying it later: ${error.message}`,
        );
        return { counter: BatchCounter.Transient, aborted: error };
      }

      yield* Effect.logError(`Failed to embed content of story '${story.id}': ${error.message}`);
      return { counter: BatchCounter.Transient };
    }) satisfies Effect.Effect<Settlement>;
  }

  function writeResults(results: ReadonlyArray<ContentResult>, targets: ReadonlyArray<Target>) {
    return Effect.gen(function* () {
      const [source] = targets;
      const written = yield* database.writeContentResults(results, targets);
      if (results.length > 0 && !written.some((target) => target.label === source.label)) {
        return yield* new ContentError({
          message: `Failed to write content results to '${source.label}', the target stories are selected from.`,
        });
      }
    });
  }

  function logBatch(stats: BatchStats) {
    const failed = stats.unavailable + stats.empty;
    return Effect.log(
      `Processed ${stats.selected} stories: ${stats.embedded} embedded, ${failed} failed ` +
        `(${stats.unavailable} unavailable, ${stats.empty} empty), ${stats.transient} transient` +
        (stats.aborted ? ', ended early.' : '.'),
    );
  }

  function fetchText(story: ContentCandidate) {
    return Effect.gen(function* () {
      const page = yield* fetcher.fetchPage(story.url).pipe(Effect.result);
      if (Result.isFailure(page)) {
        return page.failure.reason === StoryPageErrorReason.Unavailable
          ? ({
              type: PageOutcomeType.Failed,
              story,
              reason: ContentFailureReason.Unavailable,
              message: page.failure.message,
            } as const)
          : ({ type: PageOutcomeType.Transient, story, message: page.failure.message } as const);
      }

      const text = yield* storyContent.extractArticleText(page.success, story.url).pipe(Effect.result);
      if (Result.isFailure(text)) {
        return {
          type: PageOutcomeType.Failed,
          story,
          reason: ContentFailureReason.Empty,
          message: text.failure.message,
        } as const;
      }

      return { type: PageOutcomeType.Text, story, text: text.success } as const;
    }) satisfies Effect.Effect<PageOutcome>;
  }

  function embedText(story: ContentCandidate, text: string) {
    return Effect.gen(function* () {
      const input = yield* embedding.truncateToTokens(toContentDocumentInput(story.title, text), CONTENT_MAX_TOKENS);
      const [vector] = yield* embedding.embedContent([input]);
      return vector;
    });
  }

  function activeCooldowns() {
    return Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      for (const [id, until] of cooldownUntil) {
        if (until <= now) {
          cooldownUntil.delete(id);
        }
      }
      return [...cooldownUntil.keys()];
    });
  }

  function coolDown(id: string) {
    return Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      cooldownUntil.set(id, now + Duration.toMillis(CONTENT_TRANSIENT_COOLDOWN));
    });
  }

  function logBacklog(target: Target) {
    return database.countStoriesWithoutContent(target).pipe(
      Effect.flatMap((count) => Effect.log(`Remaining backlog on '${target.label}': ${count} stories.`)),
      Effect.catch((error) => Effect.logWarning(`Failed to count the remaining backlog: ${error.message}`)),
    );
  }

  return { run };
}

function toBatchStats(selected: number, settlements: ReadonlyArray<Settlement>) {
  const count = (counter: BatchCounter) => settlements.filter((settlement) => settlement.counter === counter).length;
  return {
    selected,
    embedded: count(BatchCounter.Embedded),
    unavailable: count(BatchCounter.Unavailable),
    empty: count(BatchCounter.Empty),
    transient: count(BatchCounter.Transient),
    aborted: settlements.find((settlement) => settlement.aborted)?.aborted,
  } satisfies BatchStats;
}

export function selectContentTargets(targets: ReadonlyArray<Target>, requested: Option.Option<string>) {
  return Effect.gen(function* () {
    const contentTargets = targets.filter((target) => target.content);
    if (Option.isSome(requested) && contentTargets.length === 0) {
      return yield* new TargetError({
        message: `Target '${requested.value}' is excluded from content embeddings (ORFARCHIV_CONTENT_EMBEDDING_EXCLUDED_TARGETS).`,
      });
    }
    if (contentTargets.length === 0) {
      return yield* new TargetError({ message: 'No database target receives content embeddings.' });
    }
    return contentTargets;
  });
}
