import { isEmbeddable, TITLE_EMBEDDING_FIELD } from '#common/search';
import type { Target } from '#common/targets';
import { Array as Arr, Context, Effect, Layer, Option, Result } from 'effect';
import { Binary, Collection, MongoBulkWriteError, MongoClient, type Document, type OptionalId } from 'mongodb';
import { DB_TARGET_TIMEOUT } from '../shared/config';
import { DatabaseError, EmbeddingError } from '../shared/errors';
import type { Story } from '../shared/model';
import { Embedding } from './embedding';

const DUPLICATE_KEY_ERROR = 11000;

type StoryWithDate = Omit<Story, 'timestamp'> & { timestamp: Date };
type StoryDocument = Document & StoryWithDate & { [TITLE_EMBEDDING_FIELD]?: Binary };

export interface BackfillOptions {
  readonly batchSize: number;
  readonly maxDocs?: number;
}

interface Connection {
  readonly target: Target;
  readonly newsCollection: Collection<StoryDocument>;
}

interface WritePlan extends Connection {
  readonly storiesToInsert: ReadonlyArray<Story>;
  readonly storiesToUpdate: ReadonlyArray<Story>;
  readonly retitled: ReadonlyArray<Story>;
}

export class Database extends Context.Service<Database>()('Database', {
  make: Effect.gen(function* () {
    const embedding = yield* Embedding;
    return defineService({ embedding });
  }),
}) {
  static readonly layerWithoutDependencies = Layer.effect(this, this.make);
  static readonly layer = this.layerWithoutDependencies.pipe(Layer.provide(Embedding.layer));
}

function defineService({ embedding }: { embedding: typeof Embedding.Service }) {
  function persistOrfNews(stories: Story[], targets: ReadonlyArray<Target>) {
    return Effect.gen(function* () {
      yield* Effect.log('Persisting stories...');

      const connections = yield* connectAll(targets);
      const plans = yield* forEachTarget(connections, (connection) =>
        planWrites(connection, stories).pipe(Effect.timeout(DB_TARGET_TIMEOUT)),
      );

      const storiesToEmbed = Arr.dedupeWith(
        plans.flatMap((plan) => [...plan.storiesToInsert, ...plan.retitled]),
        (a, b) => a.id === b.id,
      );
      const embeddingById = yield* embedTitlesById(storiesToEmbed);

      const written = yield* forEachTarget(plans, (plan) =>
        writeStories(plan, embeddingById).pipe(Effect.timeout(DB_TARGET_TIMEOUT)),
      );

      if (written.length === 0) {
        return yield* new DatabaseError({
          message: 'Failed to persist stories to any database target.',
          cause: undefined,
        });
      }
    }).pipe(Effect.scoped);
  }

  function planWrites({ target, newsCollection }: Connection, stories: ReadonlyArray<Story>) {
    return Effect.gen(function* () {
      const storyIds = stories.map((story) => story.id);
      const existingStories = yield* Effect.tryPromise({
        try: () => newsCollection.find<StoryDocument>({ id: { $in: storyIds } }).toArray(),
        catch: (error) => new DatabaseError({ message: 'Failed to fetch existing stories.', cause: error }),
      }).pipe(
        Effect.map((stories) =>
          stories.reduce((map, story) => map.set(story.id, story), new Map<string, StoryDocument>()),
        ),
      );

      const storiesToInsert = stories.filter((story) => !existingStories.has(story.id));
      const storiesToUpdate = stories
        .filter((story) => existingStories.has(story.id))
        .filter((story) => storyShouldUpdate(story, existingStories.get(story.id)!));
      const retitled = storiesToUpdate.filter((story) => !isEqual(story.title, existingStories.get(story.id)!.title));

      return { target, newsCollection, storiesToInsert, storiesToUpdate, retitled } satisfies WritePlan;
    });
  }

  function writeStories(
    { newsCollection, storiesToInsert, storiesToUpdate, retitled }: WritePlan,
    embeddingById: Map<string, Binary>,
  ) {
    return Effect.gen(function* () {
      if (storiesToInsert.length > 0) {
        const documents = storiesToInsert.map((story) => {
          const titleEmbedding = embeddingById.get(story.id);
          return titleEmbedding ? { ...story, [TITLE_EMBEDDING_FIELD]: titleEmbedding } : story;
        });

        const duplicateIndexes = new Set(yield* insertStories(newsCollection, documents));
        const inserted = storiesToInsert.filter((_, index) => !duplicateIndexes.has(index));
        const skipped = storiesToInsert.filter((_, index) => duplicateIndexes.has(index));
        yield* Effect.log(
          inserted.length > 0 ? `Inserted story IDs: ${storyIdsString(inserted)}` : 'Nothing to insert.',
        );
        if (skipped.length > 0) {
          yield* Effect.log(`Skipped already existing story IDs: ${storyIdsString(skipped)}`);
        }
      } else {
        yield* Effect.log('Nothing to insert.');
      }

      if (storiesToUpdate.length > 0) {
        const retitledIds = new Set(retitled.map((story) => story.id));
        const storyUpdates = storiesToUpdate.map((story) => ({
          updateOne: {
            filter: { id: story.id },
            update: buildStoryUpdate(story, embeddingById.get(story.id), retitledIds.has(story.id)),
          },
        }));
        yield* Effect.tryPromise({
          try: () => newsCollection.bulkWrite(storyUpdates),
          catch: (error) => new DatabaseError({ message: 'Failed to update stories.', cause: error }),
        });
        yield* Effect.log(`Updated story IDs: ${storyIdsString(storiesToUpdate)}`);
      } else {
        yield* Effect.log('Nothing to update.');
      }
    });
  }

  function backfillEmbeddings(options: BackfillOptions, targets: ReadonlyArray<Target>) {
    return Effect.gen(function* () {
      const embeddingByTitle = targets.length > 1 ? new Map<string, Binary>() : undefined;

      const backfilled = yield* forEachTarget(
        targets.map((target) => ({ target })),
        ({ target }) =>
          Effect.gen(function* () {
            const connection = yield* connect(target);
            yield* backfillTarget(connection, options, embeddingByTitle);
          }).pipe(Effect.scoped),
        { concurrency: 1 },
      );

      if (backfilled.length === 0) {
        return yield* new DatabaseError({
          message: 'Failed to backfill embeddings on any database target.',
          cause: undefined,
        });
      }
    });
  }

  function backfillTarget(
    { newsCollection }: Connection,
    { batchSize, maxDocs }: BackfillOptions,
    embeddingByTitle: Map<string, Binary> | undefined,
  ) {
    return Effect.gen(function* () {
      const size = Math.max(1, batchSize);
      let processed = 0;
      let embedded = 0;

      for (;;) {
        const remaining = maxDocs === undefined ? size : Math.min(size, maxDocs - processed);
        if (remaining <= 0) {
          break;
        }

        const batch = yield* Effect.tryPromise({
          try: () =>
            newsCollection
              .find<StoryDocument>(
                { [TITLE_EMBEDDING_FIELD]: { $exists: false }, title: { $gt: '' } },
                { projection: { id: 1, title: 1 }, sort: { timestamp: -1 }, limit: remaining },
              )
              .toArray(),
          catch: (error) => new DatabaseError({ message: 'Failed to fetch stories without embeddings.', cause: error }),
        });

        if (batch.length === 0) {
          break;
        }

        const embeddings = yield* embedTitles(
          batch.map((story) => story.title),
          embeddingByTitle,
        );

        const updates = batch.map((story, index) => ({
          updateOne: {
            filter: { id: story.id },
            update: { $set: { [TITLE_EMBEDDING_FIELD]: embeddings[index] } },
          },
        }));

        yield* Effect.tryPromise({
          try: () => newsCollection.bulkWrite(updates, { ordered: false }),
          catch: (error) => new DatabaseError({ message: 'Failed to write embeddings.', cause: error }),
        });

        processed += batch.length;
        embedded += updates.length;
        yield* Effect.log(`Backfilled ${embedded} embeddings.`);

        if (batch.length < remaining) {
          break;
        }
      }

      yield* Effect.log(`Backfill complete: ${embedded} embeddings written.`);
    });
  }

  function embedTitles(titles: ReadonlyArray<string>, embeddingByTitle: Map<string, Binary> | undefined) {
    if (!embeddingByTitle) {
      return embedding.embed(titles);
    }

    return Effect.gen(function* () {
      const missing = [...new Set(titles.filter((title) => !embeddingByTitle.has(title)))];
      if (missing.length > 0) {
        const embeddings = yield* embedding.embed(missing);
        missing.forEach((title, index) => embeddingByTitle.set(title, embeddings[index]));
      }
      return titles.map((title) => embeddingByTitle.get(title)!);
    });
  }

  function embedTitlesById(stories: ReadonlyArray<Story>): Effect.Effect<Map<string, Binary>> {
    const embeddable = stories.filter((story) => isEmbeddable(story.title));
    if (embeddable.length === 0) {
      return Effect.succeed(new Map());
    }

    return embedding.embed(embeddable.map((story) => story.title)).pipe(
      Effect.result,
      Effect.flatMap((result) =>
        Result.isSuccess(result)
          ? Effect.succeed(new Map(embeddable.map((story, index) => [story.id, result.success[index]])))
          : logEmbeddingFailure(result.failure).pipe(Effect.as(new Map<string, Binary>())),
      ),
    );
  }

  function connectAll(targets: ReadonlyArray<Target>) {
    return forEachTarget(
      targets.map((target) => ({ target })),
      ({ target }) => connect(target),
    );
  }

  function connect(target: Target) {
    return Effect.acquireRelease(
      Effect.gen(function* () {
        yield* Effect.log(`Connecting to '${target.label}'...`);
        const client = yield* Effect.tryPromise({
          try: async () => await MongoClient.connect(target.url),
          catch: (error) => new DatabaseError({ message: 'Failed to connect to DB.', cause: error }),
        });
        const db = client.db('orfarchiv');
        const newsCollection: Collection<StoryDocument> = db.collection('news');
        return { target, client, newsCollection };
      }),
      ({ client }) => Effect.sync(() => client.close()),
    );
  }

  return {
    persistOrfNews,
    backfillEmbeddings,
  };
}

function forEachTarget<A extends { readonly target: Target }, B, E extends { readonly message: string }, R>(
  items: ReadonlyArray<A>,
  fn: (item: A) => Effect.Effect<B, E, R>,
  options: { readonly concurrency: number | 'unbounded' } = { concurrency: 'unbounded' },
) {
  return Effect.forEach(
    items,
    (item) =>
      fn(item).pipe(
        Effect.result,
        Effect.flatMap((result) =>
          Result.isSuccess(result)
            ? Effect.succeed(Option.some(result.success))
            : logTargetFailure(item.target, result.failure).pipe(Effect.as(Option.none<B>())),
        ),
        Effect.withLogSpan(item.target.label),
      ),
    options,
  ).pipe(Effect.map(Arr.getSomes));
}

interface StoryUpdate {
  $set: StoryWithDate & { [K in typeof TITLE_EMBEDDING_FIELD]?: Binary };
  $unset?: { [K in typeof TITLE_EMBEDDING_FIELD]?: '' };
}

export function buildStoryUpdate(
  story: StoryWithDate,
  titleEmbedding: Binary | undefined,
  retitled: boolean,
): StoryUpdate {
  if (titleEmbedding) {
    return { $set: { ...story, [TITLE_EMBEDDING_FIELD]: titleEmbedding } };
  }
  if (retitled) {
    return { $set: { ...story }, $unset: { [TITLE_EMBEDDING_FIELD]: '' } };
  }
  return { $set: { ...story } };
}

function storyShouldUpdate(newStory: StoryWithDate, oldStory: StoryWithDate) {
  return (
    !isEqual(newStory.title, oldStory.title) ||
    !isEqual(newStory.category, oldStory.category) ||
    !isEqual(newStory.url, oldStory.url)
  );
}

function insertStories(newsCollection: Collection<StoryDocument>, documents: ReadonlyArray<StoryDocument>) {
  return Effect.tryPromise({
    try: async () => {
      try {
        await newsCollection.insertMany(documents as OptionalId<StoryDocument>[], { ordered: false });
        return [];
      } catch (error) {
        const duplicates = duplicateKeyIndexes(error);
        if (!duplicates) {
          throw error;
        }
        return duplicates;
      }
    },
    catch: (error) => new DatabaseError({ message: 'Failed to insert stories.', cause: error }),
  });
}

function duplicateKeyIndexes(error: unknown): ReadonlyArray<number> | undefined {
  if (!(error instanceof MongoBulkWriteError)) {
    return undefined;
  }

  const writeErrors = Arr.ensure(error.writeErrors);
  return writeErrors.length > 0 && writeErrors.every((writeError) => writeError.code === DUPLICATE_KEY_ERROR)
    ? writeErrors.map((writeError) => writeError.index)
    : undefined;
}

function storyIdsString(stories: ReadonlyArray<{ id: string }>) {
  return `[${stories.map((story) => story.id).join(', ')}]`;
}

function isEqual<T>(a: T, b: T) {
  if (a == null && b == null) {
    return true;
  }
  return a === b;
}

function logEmbeddingFailure(error: EmbeddingError) {
  const message = `Failed to embed titles, storing stories without embeddings: ${error.message}`;
  return error.type === 'unreachable' || error.type === 'timeout'
    ? Effect.logWarning(message)
    : Effect.logError(message);
}

function logTargetFailure(target: Target, error: { readonly message: string; readonly cause?: unknown }) {
  const cause = error.cause === undefined ? '' : ` Cause: ${error.cause}`;
  return Effect.logError(`Database target '${target.label}' failed: ${error.message}${cause}`);
}
