import { Collection, MongoClient, type OptionalId, type WithoutId } from 'mongodb';
import logger from './logger.ts';
import type { Story } from './model.ts';

type StoryDocument = Document & Story;
type StoryWithDate = Omit<Story, 'timestamp'> & { timestamp: Date };

async function persistOrfNews(stories: Story[]): Promise<void> {
  logger.info('Persisting stories...');
  const storyIds = stories.map((story) => story.id);

  await withOrfArchivDb(async (newsCollection) => {
    const existingStories = new Map();
    (await newsCollection.find<StoryDocument>({ id: { $in: storyIds } }).toArray()).forEach((story) =>
      existingStories.set(story.id, story),
    );

    const storiesToInsert = stories
      .filter((story) => !existingStories.has(story.id))
      .map((story) => ({ ...story, timestamp: new Date(story.timestamp) }));

    if (storiesToInsert.length > 0) {
      await newsCollection.insertMany(storiesToInsert as unknown as OptionalId<StoryDocument>[]);
      logger.info(`Inserted story IDs: ${storyIdsString(storiesToInsert)}`);
    } else {
      logger.info('Nothing to insert.');
    }

    const storiesToUpdate = stories
      .filter((story) => existingStories.has(story.id))
      .map((story) => ({ ...story, timestamp: new Date(story.timestamp) }))
      .filter((story) => storyShouldUpdate(story, existingStories.get(story.id)));

    if (storiesToUpdate.length > 0) {
      const results = storiesToUpdate.map((story) =>
        newsCollection.replaceOne({ id: story.id }, story as unknown as WithoutId<StoryDocument>),
      );
      await Promise.all(results);
      logger.info(`Updated story IDs: ${storyIdsString(storiesToUpdate)}`);
    } else {
      logger.info('Nothing to update.');
    }
  });
}

async function withOrfArchivDb(handler: (newsCollection: Collection<StoryDocument>) => Promise<void>): Promise<void> {
  logger.info('Connecting to DB...');
  const url = process.env.ORFARCHIV_DB_URL?.trim() || 'mongodb://localhost';
  let client;
  try {
    client = await MongoClient.connect(url);
    const db = client.db('orfarchiv');
    const newsCollection: Collection<StoryDocument> = db.collection('news');
    await handler(newsCollection);
  } catch (error) {
    throw new Error(`DB error. Cause ${(error as Error).message}`);
  } finally {
    await client?.close();
  }
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

export { persistOrfNews };
