import axios from 'axios';
import { XMLParser } from 'fast-xml-parser';
import RE2 from 're2';
import logger from './logger.ts';
import type { Story } from './model.ts';

type Format = 'RDF' | 'SIMPLE' | 'UNKNOWN';

const GUID_RE2 = new RE2('/stories/(?<id>[0-9]+)');

async function scrapeOrfNews(url: string, source: string): Promise<Story[]> {
  logger.info(`Scraping RSS feed: '${source}'`);
  const data = await fetchOrfNews(url);
  return collectStories(data, source);
}

async function fetchOrfNews(url: string): Promise<string> {
  logger.info('Fetching data...');
  try {
    const response = await axios.get(url);
    return response.data;
  } catch (error) {
    throw Error(`Failed to fetch ORF News. Cause: ${(error as Error).message}`);
  }
}

function collectStories(data: string, source: string): Story[] {
  logger.info(`Parsing data...`);
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  const document = parser.parse(data);

  const [format, items] = detectFormat(document);
  logger.info(`Detected format: '${format}'`);

  return (
    items
      ?.filter(filterStoryRdfItem)
      .map(mapToStory.bind(null, source, format))
      .filter(isValidStory) ?? []
  );
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
    timestamp: rdfItem['dc:date'] || fallbackTimestamp(),
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
    timestamp: item.pubDate ? new Date(item.pubDate).toISOString() : fallbackTimestamp(),
    source,
  };
}

function fallbackTimestamp(): string {
  return new Date().toISOString();
}

function isValidStory(story: Partial<Story> | null): story is Story {
  if (!story) {
    return false;
  }

  const isValid = !!story.id && !!story.title && !!story.url && !!story.timestamp && !!story.source;
  if (!isValid) {
    logger.warn(`Invalid story found: ${story.id}`);
  }
  return isValid;
}

export { scrapeOrfNews };
