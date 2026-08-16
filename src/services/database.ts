import { Context, Effect, Layer } from 'effect';
import { Collection, MongoClient, type Document, type OptionalId } from 'mongodb';
import { DatabaseError } from '../shared/errors';
import type { Story } from '../shared/model';
import { Environment } from './env';

type StoryWithDate = Omit<Story, 'timestamp'> & { timestamp: Date };
type StoryDocument = Document & StoryWithDate;

export class Database extends Context.Service<Database>()('Database', {
  make: Effect.gen(function* () {
    const environment = yield* Environment;
    return defineService({ environment });
  }),
}) {
  static readonly layerWithoutDependencies = Layer.effect(this, this.make);
  static readonly layer = this.layerWithoutDependencies.pipe(Layer.provide(Environment.layer));
}

function defineService({ environment }: { environment: typeof Environment.Service }) {
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
          yield* Effect.tryPromise({
            try: () => newsCollection.insertMany(storiesToInsert as OptionalId<StoryDocument>[]),
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
          const storyUpdates = storiesToUpdate.map((story) => ({
            replaceOne: {
              filter: { id: story.id },
              replacement: story as StoryDocument,
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
  };
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
