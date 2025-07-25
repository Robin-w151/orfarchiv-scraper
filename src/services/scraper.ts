import { FetchHttpClient, HttpClient } from '@effect/platform';
import { Effect, Schedule } from 'effect';
import { XMLParser } from 'fast-xml-parser';
import { ScraperError } from '../shared/errors';
import { isStory, type Story } from '../shared/model';

type Format = 'RDF' | 'SIMPLE' | 'UNKNOWN';

const GUID_REGEX = /\/stories\/(?<id>[0-9]+)/;

export class Scraper extends Effect.Service<Scraper>()('Scraper', {
  succeed: {
    scrapeOrfNews,
  },
  dependencies: [FetchHttpClient.layer],
}) {}

export const ScraperLive = Scraper.Default;

function scrapeOrfNews(url: string, source: string) {
  return Effect.gen(function* () {
    yield* Effect.log(`Scraping RSS feed: '${source}'`);
    const data = yield* fetchOrfNews(url);
    return yield* collectStories(data, source);
  });
}

function fetchOrfNews(url: string) {
  return Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const response = yield* httpClient.get(url);
    return yield* response.text;
  }).pipe(
    Effect.catchAll((error) =>
      Effect.fail(new ScraperError({ message: `Failed to fetch news from '${url}'.`, cause: error })),
    ),
    Effect.retry(Schedule.jittered(Schedule.intersect(Schedule.exponential('1 second'), Schedule.recurs(3)))),
  );
}

function collectStories(data: string, source: string) {
  return Effect.gen(function* () {
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
    const document = yield* Effect.try({
      try: () => parser.parse(data),
      catch: (error) => new ScraperError({ message: 'Failed to parse data.', cause: error }),
    });

    const [format, items] = detectFormat(document);
    yield* Effect.logDebug(`Detected format: '${format}'`);

    const invalidStoryIds = new Set<string>();
    const validStories =
      items
        ?.filter(filterStoryRdfItem)
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

function detectFormat(document: any): [Format, any[]] {
  let items;

  items = document?.['rdf:RDF']?.item;
  if (items && Array.isArray(items)) {
    return ['RDF', items];
  }

  items = document?.rss?.channel?.item;
  if (items && Array.isArray(items)) {
    return ['SIMPLE', items];
  }

  return ['UNKNOWN', []];
}

function filterStoryRdfItem(rdfItem: any): boolean {
  return rdfItem?.link?.includes('stories');
}

function mapToStory(source: string, format: string, item: any): Partial<Story> | null {
  if (format === 'RDF') {
    return mapRdfToStory(source, item);
  }
  if (format === 'SIMPLE') {
    return mapSimpleToStory(source, item);
  }
  return null;
}

function mapRdfToStory(source: string, rdfItem: any): Story {
  return {
    id: rdfItem['orfon:usid'],
    title: rdfItem.title.trim(),
    category: rdfItem['dc:subject'],
    url: rdfItem.link,
    timestamp: rdfItem['dc:date'] ? new Date(rdfItem['dc:date']) : fallbackTimestamp(),
    source,
  };
}

function mapSimpleToStory(source: string, item: any): Partial<Story> {
  const id = GUID_REGEX.exec(item.guid['#text'])?.groups?.id;
  return {
    id: id ? `${source}:${id}` : undefined,
    title: item.title.trim(),
    category: item.category,
    url: item.link,
    timestamp: item.pubDate ? new Date(item.pubDate) : fallbackTimestamp(),
    source,
  };
}

function fallbackTimestamp(): Date {
  return new Date();
}
