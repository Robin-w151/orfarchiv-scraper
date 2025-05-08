import { Effect } from 'effect';
import { Collection, MongoClient, type OptionalId } from 'mongodb';
import { Environment, EnvironmentLive } from '../shared/env.ts';
import { DatabaseError } from '../shared/errors.ts';
import type { Story } from '../shared/model.ts';

type StoryWithDate = Omit<Story, 'timestamp'> & { timestamp: Date };
type StoryDocument = Document & StoryWithDate;

export class Database extends Effect.Service<Database>()('Database', {
  effect: Effect.gen(function* () {
    const environment = yield* Environment;

    function persistOrfNews(stories: Story[]): Effect.Effect<void, DatabaseError> {
      return Effect.gen(function* () {
        yield* Effect.log('Persisting stories...');
        const storyIds = stories.map((story) => story.id);

        const handler = (newsCollection: Collection<StoryDocument>) => {
          return Effect.gen(function* () {
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
                try: () => newsCollection.insertMany(storiesToInsert as unknown as OptionalId<StoryDocument>[]),
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
        };

        yield* withOrfArchivDb(handler);
      });
    }

    function storyShouldUpdate(newStory: StoryWithDate, oldStory: StoryWithDate): boolean {
      return (
        newStory.title !== oldStory.title ||
        newStory.category !== oldStory.category ||
        newStory.url !== oldStory.url ||
        newStory.timestamp.toISOString() !== oldStory.timestamp.toISOString()
      );
    }

    function storyIdsString(stories: { id: string }[]): string {
      return `[${stories.map((story) => story.id).join(', ')}]`;
    }

    function withOrfArchivDb(
      handler: (newsCollection: Collection<StoryDocument>) => Effect.Effect<void, DatabaseError>,
    ): Effect.Effect<void, DatabaseError> {
      return Effect.gen(function* () {
        yield* Effect.log('Connecting to DB...');
        const url = yield* environment.dbConnectionUrl;

        yield* Effect.acquireUseRelease(
          Effect.tryPromise({
            try: async () => {
              const client = await MongoClient.connect(url);
              const db = client.db('orfarchiv');
              const newsCollection: Collection<StoryDocument> = db.collection('news');
              return { client, newsCollection };
            },
            catch: (error) => {
              return new DatabaseError({ message: 'Failed to connect to DB.', cause: error });
            },
          }),
          ({ newsCollection }) => handler(newsCollection),
          ({ client }) => Effect.promise(() => client.close()),
        );
      });
    }

    return {
      persistOrfNews,
    };
  }),
  dependencies: [EnvironmentLive],
}) {}

export const DatabaseLive = Database.Default;
