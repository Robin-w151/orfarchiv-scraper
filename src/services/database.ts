import { Context, Effect, Layer, Result } from 'effect';
import { Binary, Collection, MongoClient, type Document, type OptionalId } from 'mongodb';
import { TITLE_EMBEDDING_FIELD } from '../shared/config';
import { DatabaseError, EmbeddingError } from '../shared/errors';
import type { Story } from '../shared/model';
import { isEmbeddable } from '../shared/search';
import { Embedding } from './embedding';
import { Environment } from './env';

type StoryWithDate = Omit<Story, 'timestamp'> & { timestamp: Date };
type StoryDocument = Document & StoryWithDate & { [TITLE_EMBEDDING_FIELD]?: Binary };

export interface BackfillOptions {
  readonly batchSize: number;
  readonly maxDocs?: number;
}

export class Database extends Context.Service<Database>()('Database', {
  make: Effect.gen(function* () {
    const environment = yield* Environment;
    const embedding = yield* Embedding;
    return defineService({ environment, embedding });
  }),
}) {
  static readonly layerWithoutDependencies = Layer.effect(this, this.make);
  static readonly layer = this.layerWithoutDependencies.pipe(
    Layer.provide(Environment.layer),
    Layer.provide(Embedding.layer),
  );
}

function defineService({
  environment,
  embedding,
}: {
  environment: typeof Environment.Service;
  embedding: typeof Embedding.Service;
}) {
  function persistOrfNews(stories: Story[]) {
    return Effect.gen(function* () {
      yield* Effect.log('Persisting stories...');
      const storyIds = stories.map((story) => story.id);

      const handler = Effect.gen(function* () {
        const { newsCollection } = yield* orfArchivDbConnection();
        const existingStories = yield* Effect.tryPromise({
          try: () => newsCollection.find<StoryDocument>({ id: { $in: storyIds } }).toArray(),
          catch: (error) => new DatabaseError({ message: 'Failed to fetch existing stories.', cause: error }),
        }).pipe(
          Effect.map((stories) =>
            stories.reduce((map, story) => map.set(story.id, story), new Map<string, StoryDocument>()),
          ),
        );

        const storiesToInsert = stories.filter((story) => !existingStories.has(story.id));

        if (storiesToInsert.length > 0) {
          const embeddingById = yield* embedTitlesById(storiesToInsert);
          const documents = storiesToInsert.map((story) => {
            const titleEmbedding = embeddingById.get(story.id);
            return titleEmbedding ? { ...story, [TITLE_EMBEDDING_FIELD]: titleEmbedding } : story;
          });

          yield* Effect.tryPromise({
            try: () => newsCollection.insertMany(documents as OptionalId<StoryDocument>[]),
            catch: (error) => new DatabaseError({ message: 'Failed to insert stories.', cause: error }),
          });
          yield* Effect.log(`Inserted story IDs: ${storyIdsString(storiesToInsert)}`);
        } else {
          yield* Effect.log('Nothing to insert.');
        }

        const storiesToUpdate = stories
          .filter((story) => existingStories.has(story.id))
          .filter((story) => storyShouldUpdate(story, existingStories.get(story.id)!));

        if (storiesToUpdate.length > 0) {
          const retitled = storiesToUpdate.filter(
            (story) => !isEqual(story.title, existingStories.get(story.id)!.title),
          );
          const embeddingById = yield* embedTitlesById(retitled);

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

      yield* Effect.scoped(handler);
    });
  }

  function backfillEmbeddings({ batchSize, maxDocs }: BackfillOptions) {
    return Effect.gen(function* () {
      const handler = Effect.gen(function* () {
        const { newsCollection } = yield* orfArchivDbConnection();
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
            catch: (error) =>
              new DatabaseError({ message: 'Failed to fetch stories without embeddings.', cause: error }),
          });

          if (batch.length === 0) {
            break;
          }

          const embeddings = yield* embedding.embed(batch.map((story) => story.title));

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

      yield* Effect.scoped(handler);
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

  function orfArchivDbConnection() {
    return Effect.acquireRelease(
      Effect.gen(function* () {
        yield* Effect.log('Connecting to DB...');
        const url = yield* environment.dbConnectionUrl;
        const client = yield* Effect.tryPromise({
          try: async () => await MongoClient.connect(url),
          catch: (error) => new DatabaseError({ message: 'Failed to connect to DB.', cause: error }),
        });
        const db = client.db('orfarchiv');
        const newsCollection: Collection<StoryDocument> = db.collection('news');
        return { client, newsCollection };
      }),
      ({ client }) => Effect.sync(() => client.close()),
    );
  }

  return {
    persistOrfNews,
    backfillEmbeddings,
  };
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

function storyIdsString(stories: { id: string }[]) {
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
