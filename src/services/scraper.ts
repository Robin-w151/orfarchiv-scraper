import axios from 'axios';
import { Effect, Schedule } from 'effect';
import { XMLParser } from 'fast-xml-parser';
import RE2 from 're2';
import { ScrapeError } from '../shared/errors.ts';
import { isStory, type Story } from '../shared/model.ts';

type Format = 'RDF' | 'SIMPLE' | 'UNKNOWN';

const GUID_RE2 = new RE2('/stories/(?<id>[0-9]+)');

export class Scraper extends Effect.Service<Scraper>()('Scraper', {
  effect: Effect.succeed({ scrapeOrfNews }),
  dependencies: [],
}) {}

export const ScraperLive = Scraper.Default;

function scrapeOrfNews(url: string, source: string): Effect.Effect<Story[], ScrapeError> {
  return Effect.gen(function* () {
    yield* Effect.log(`Scraping RSS feed: '${source}'`);
    const data = yield* fetchOrfNews(url).pipe(Effect.retry({ times: 3, schedule: Schedule.exponential(1000) }));
    return yield* collectStories(data, source);
  });
}

function fetchOrfNews(url: string): Effect.Effect<string, ScrapeError> {
  return Effect.gen(function* () {
    yield* Effect.log('Fetching data...');
    const response = yield* Effect.tryPromise({
      try: () => axios.get(url),
      catch: (error) => new ScrapeError({ message: `Failed to fetch news from '${url}'.`, cause: error }),
    });
    return response.data;
  });
}

function collectStories(data: string, source: string): Effect.Effect<Story[], ScrapeError> {
  return Effect.gen(function* () {
    yield* Effect.log('Parsing data...');
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
    const document = yield* Effect.try({
      try: () => parser.parse(data),
      catch: (error) => new ScrapeError({ message: 'Failed to parse data.', cause: error }),
    });

    const [format, items] = detectFormat(document);
    yield* Effect.log(`Detected format: '${format}'`);

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
  const id = GUID_RE2.match(item.guid['#text'])?.groups?.id;
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
