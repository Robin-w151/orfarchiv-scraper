import { Context, Effect, Layer, Result, Schedule, Schema } from 'effect';
import { FetchHttpClient, HttpClient } from 'effect/unstable/http';
import { XMLParser } from 'fast-xml-parser';
import { ScraperError } from '../shared/errors';
import { isStory, type Story } from '../shared/model';

const GUID_REGEX = /\/stor(y|ies)\/(?<id>[\w-]+)/;

const StoryItem = Schema.Struct({
  link: Schema.String,
});

export class Scraper extends Context.Service<Scraper>()('Scraper', {
  make: Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    return defineService({ httpClient });
  }),
}) {
  static readonly layerWithoutDependencies = Layer.effect(this, this.make);
  static readonly layer = this.layerWithoutDependencies.pipe(Layer.provide(FetchHttpClient.layer));
}

function defineService({ httpClient }: { httpClient: HttpClient.HttpClient }) {
  function scrapeOrfNews(url: string | Array<string>, source: string) {
    return Effect.gen(function* () {
      yield* Effect.log(`Scraping RSS feed: '${source}'`);
      const data = yield* Effect.all(Array.isArray(url) ? url.map(fetchOrfNews) : [fetchOrfNews(url)], {
        concurrency: 'unbounded',
      });
      const stories = yield* Effect.all(
        data.map((d) => collectStories(d, source)),
        { concurrency: 'unbounded' },
      );
      return deduplicateStories(stories.flat());
    });
  }

  function fetchOrfNews(url: string) {
    return Effect.gen(function* () {
      const response = yield* httpClient.get(url);
      if (response.status >= 400) {
        return yield* new ScraperError({
          message: `Failed to fetch news from '${url}'.`,
          cause: response,
          notFound: response.status === 404,
        });
      }

      return yield* response.text;
    }).pipe(
      Effect.catchIf(
        (error) => !(error instanceof ScraperError),
        (error) =>
          Effect.fail(
            new ScraperError({
              message: `Failed to fetch news from '${url}'.`,
              cause: error,
              notFound: false,
            }),
          ),
      ),
      Effect.retry({
        schedule: Schedule.jittered(Schedule.max([Schedule.exponential('1 second'), Schedule.recurs(3)])),
        while: (error) => !error.notFound,
      }),
      Effect.tapError(() => Effect.logWarning(`Failed to fetch news from '${url}'.`)),
      Effect.result,
    );
  }

  return {
    scrapeOrfNews,
  };
}

function collectStories(
  data: Result.Result<string, ScraperError>,
  source: string,
): Effect.Effect<Story[], ScraperError> {
  return Effect.gen(function* () {
    if (Result.isFailure(data)) {
      return [];
    }

    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
    const document = yield* Effect.try({
      try: () => parser.parse(data.success),
      catch: (error) => new ScraperError({ message: 'Failed to parse data.', cause: error }),
    });

    const [format, items] = detectFormat(document);
    yield* Effect.logDebug(`Detected format: '${format}'`);

    const invalidStoryIds = new Set<string>();
    const validStories =
      items
        ?.filter(filterStoryItem)
        .map(mapToStory.bind(null, source, format))
        .filter((story) => {
          const valid = isStory(story);
          if (!valid) {
            invalidStoryIds.add(JSON.stringify(story?.id ?? ''));
          }
          return valid;
        }) ?? [];

    if (invalidStoryIds.size > 0) {
      yield* Effect.logWarning(`Invalid stories found: ${Array.from(invalidStoryIds).join(', ')}`);
    }

    return validStories;
  });
}

function detectFormat(document: any) {
  let items;

  items = document?.['rdf:RDF']?.item;
  if (items && Array.isArray(items)) {
    return ['RDF', items] as const;
  }

  items = document?.rss?.channel?.item;
  if (items && Array.isArray(items)) {
    return ['SIMPLE', items] as const;
  }

  return ['UNKNOWN', []] as const;
}

function filterStoryItem(item: unknown) {
  if (Schema.is(StoryItem)(item)) {
    return /stor(y|ies)/.test(item.link);
  } else {
    return false;
  }
}

function mapToStory(source: string, format: string, item: any) {
  if (format === 'RDF') {
    return mapRdfToStory(source, item);
  }
  if (format === 'SIMPLE') {
    return mapSimpleToStory(source, item);
  }
  return null;
}

function mapRdfToStory(source: string, rdfItem: any) {
  return {
    id: rdfItem['orfon:usid'],
    title: rdfItem.title.trim(),
    category: rdfItem['dc:subject'],
    url: rdfItem.link,
    timestamp: rdfItem['dc:date'] ? clampFutureTimestamp(new Date(rdfItem['dc:date'])) : fallbackTimestamp(),
    source,
  };
}

function mapSimpleToStory(source: string, item: any) {
  const id = GUID_REGEX.exec(item.guid['#text'])?.groups?.id;
  return {
    id: id ? `${source}:${id}` : undefined,
    title: item.title.trim(),
    category: item.category,
    url: item.link,
    timestamp: item.pubDate ? clampFutureTimestamp(new Date(item.pubDate)) : fallbackTimestamp(),
    source,
  };
}

function fallbackTimestamp() {
  return new Date();
}

function clampFutureTimestamp(date: Date) {
  const now = new Date();
  return date > now ? now : date;
}

function deduplicateStories(stories: Story[]) {
  const storyMap = new Map<string, Story>();
  for (const story of stories) {
    if (!storyMap.has(story.id)) {
      storyMap.set(story.id, story);
    }
  }
  return Array.from(storyMap.values());
}
