import { HttpClient, HttpClientError, HttpClientResponse } from '@effect/platform';
import { Effect, Layer } from 'effect';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Scraper } from './scraper';

const mockedHttpClientGet = vi.fn();
let mockedResponseByUrl: Record<string, string | Error> = {};

describe('Scraper', () => {
  beforeEach(() => {
    mockedHttpClientGet.mockReset();
    mockedResponseByUrl = {};
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('RDF feeds', () => {
    test('parses RDF feed items into stories', async () => {
      const feedUrl = 'https://orf.at/news.rdf';
      const source = 'news';
      mockFetchResponses({
        [feedUrl]: buildRdfFeed([
          {
            about: 'https://orf.at/stories/3427584/',
            usid: 'news:3427584',
            link: 'https://orf.at/stories/3427584/',
            subject: 'Ausland',
            date: '2026-04-22T09:35:39+02:00',
            title: '  Trotz Waffenruhe: Beirut meldet einen Toten  ',
          },
          {
            about: 'https://orf.at/stories/3427582/',
            usid: 'news:3427582',
            link: 'https://orf.at/stories/3427582/',
            subject: 'Ausland',
            date: '2026-04-22T08:38:32+02:00',
            title: 'Toter bei russischem Drohnenangriff',
          },
        ]),
      });

      const stories = await runScrape(feedUrl, source);

      expect(stories).toHaveLength(2);
      expect(stories[0]).toMatchObject({
        id: 'news:3427584',
        title: 'Trotz Waffenruhe: Beirut meldet einen Toten',
        category: 'Ausland',
        url: 'https://orf.at/stories/3427584/',
        source: 'news',
      });
      expect(stories[0]?.timestamp).toEqual(new Date('2026-04-22T09:35:39+02:00'));
      expect(stories[1]).toMatchObject({
        id: 'news:3427582',
        title: 'Toter bei russischem Drohnenangriff',
        category: 'Ausland',
        url: 'https://orf.at/stories/3427582/',
        source: 'news',
      });
    });

    test('skips RDF items that are not stories links', async () => {
      const feedUrl = 'https://orf.at/news-filtered.rdf';
      mockFetchResponses({
        [feedUrl]: buildRdfFeed([
          {
            about: 'https://orf.at/stories/3427584/',
            usid: 'news:3427584',
            link: 'https://orf.at/stories/3427584/',
            subject: 'Ausland',
            date: '2026-04-22T09:35:39+02:00',
            title: 'Story Item',
          },
          {
            about: 'https://orf.at/video/3427585/',
            usid: 'news:3427585',
            link: 'https://orf.at/video/3427585/',
            subject: 'Ausland',
            date: '2026-04-22T09:10:00+02:00',
            title: 'Video Item',
          },
        ]),
      });

      const stories = await runScrape(feedUrl, 'news');

      expect(stories).toHaveLength(1);
      expect(stories[0]?.id).toBe('news:3427584');
    });
  });

  describe('simple RSS feeds', () => {
    test('parses simple RSS feed and derives IDs from GUID', async () => {
      const feedUrl = 'https://help.orf.at/rss';
      const source = 'help';
      mockFetchResponses({
        [feedUrl]: buildSimpleFeed([
          {
            title: 'VKI: Jeder dritte Schnuller im Test mit Bisphenol A',
            link: 'https://help.orf.at/stories/3235200/',
            guid: 'https://help.orf.at/stories/3235200/',
            category: 'Wirtschaft',
            pubDate: 'Tue, 21 Apr 2026 12:34:21 +0000',
            description: 'Feed description',
          },
          {
            title: 'Filtered Non-story Item',
            link: 'https://help.orf.at/video/3235204/',
            guid: 'https://help.orf.at/video/3235204/',
            category: 'Wirtschaft',
            pubDate: 'Tue, 21 Apr 2026 13:00:00 +0000',
            description: 'Used to ensure channel.item is an array',
          },
        ]),
      });

      const stories = await runScrape(feedUrl, source);

      expect(stories).toHaveLength(1);
      expect(stories[0]).toMatchObject({
        id: 'help:3235200',
        title: 'VKI: Jeder dritte Schnuller im Test mit Bisphenol A',
        category: 'Wirtschaft',
        url: 'https://help.orf.at/stories/3235200/',
        source: 'help',
      });
      expect(stories[0]?.timestamp).toEqual(new Date('Tue, 21 Apr 2026 12:34:21 +0000'));
    });

    test('skips invalid simple RSS items', async () => {
      const feedUrl = 'https://help.orf.at/rss-invalid-item';
      mockFetchResponses({
        [feedUrl]: buildSimpleFeed([
          {
            title: 'Valid Story',
            link: 'https://help.orf.at/stories/3235201/',
            guid: 'https://help.orf.at/stories/3235201/',
            category: 'Wirtschaft',
            pubDate: 'Tue, 21 Apr 2026 12:34:21 +0000',
            description: 'Valid item',
          },
          {
            title: 'Invalid GUID format',
            link: 'https://help.orf.at/stories/3235202/',
            guid: 'https://help.orf.at/topics/invalid-guid',
            category: 'Wirtschaft',
            pubDate: 'Tue, 21 Apr 2026 10:00:00 +0000',
            description: 'Invalid item',
          },
        ]),
      });

      const stories = await runScrape(feedUrl, 'help');

      expect(stories).toHaveLength(1);
      expect(stories[0]?.id).toBe('help:3235201');
    });
  });

  describe('error handling', () => {
    test('returns empty list for invalid or unrecognized feed data', async () => {
      const feedUrl = 'https://orf.at/invalid.xml';
      mockFetchResponses({
        [feedUrl]: '<root><foo>bar</foo></root>',
      });

      const stories = await runScrape(feedUrl, 'news');

      expect(stories).toEqual([]);
    });

    test('handles network error by returning empty list when single feed fails', async () => {
      vi.useFakeTimers();
      try {
        const feedUrl = 'https://orf.at/network-error.rdf';
        mockFetchResponses({
          [feedUrl]: new Error('network failed'),
        });

        const storiesPromise = runScrape(feedUrl, 'news');
        await vi.advanceTimersByTimeAsync(60_000);
        const stories = await storiesPromise;

        expect(stories).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('multiple feeds', () => {
    test('handles partial network failure for multiple feed URLs', async () => {
      vi.useFakeTimers();
      try {
        const failingUrl = 'https://orf.at/failing.rdf';
        const workingUrl = 'https://help.orf.at/working.rss';
        mockFetchResponses({
          [failingUrl]: new Error('connection reset'),
          [workingUrl]: buildSimpleFeed([
            {
              title: 'Partial Success Story',
              link: 'https://help.orf.at/stories/3235300/',
              guid: 'https://help.orf.at/stories/3235300/',
              category: 'Service',
              pubDate: 'Tue, 21 Apr 2026 08:00:00 +0000',
              description: 'Survives partial network error',
            },
            {
              title: 'Filtered Non-story Item',
              link: 'https://help.orf.at/video/3235301/',
              guid: 'https://help.orf.at/video/3235301/',
              category: 'Service',
              pubDate: 'Tue, 21 Apr 2026 08:05:00 +0000',
              description: 'Used to ensure channel.item is an array',
            },
          ]),
        });

        const storiesPromise = runScrape([failingUrl, workingUrl], 'help');
        await vi.advanceTimersByTimeAsync(60_000);
        const stories = await storiesPromise;

        expect(stories).toHaveLength(1);
        expect(stories[0]?.id).toBe('help:3235300');
      } finally {
        vi.useRealTimers();
      }
    });

    test('deduplicates stories across multiple feed URLs', async () => {
      const firstUrl = 'https://help.orf.at/first.rss';
      const secondUrl = 'https://help.orf.at/second.rss';
      mockFetchResponses({
        [firstUrl]: buildSimpleFeed([
          {
            title: 'First Source Duplicate',
            link: 'https://help.orf.at/stories/3235400/',
            guid: 'https://help.orf.at/stories/3235400/',
            category: 'Wirtschaft',
            pubDate: 'Tue, 21 Apr 2026 06:00:00 +0000',
            description: 'First duplicate',
          },
          {
            title: 'Only In First Feed',
            link: 'https://help.orf.at/stories/3235401/',
            guid: 'https://help.orf.at/stories/3235401/',
            category: 'Wirtschaft',
            pubDate: 'Tue, 21 Apr 2026 06:10:00 +0000',
            description: 'Unique first',
          },
        ]),
        [secondUrl]: buildSimpleFeed([
          {
            title: 'Second Source Duplicate',
            link: 'https://help.orf.at/stories/3235400/',
            guid: 'https://help.orf.at/stories/3235400/',
            category: 'Wirtschaft',
            pubDate: 'Tue, 21 Apr 2026 06:20:00 +0000',
            description: 'Duplicate second',
          },
          {
            title: 'Only In Second Feed',
            link: 'https://help.orf.at/stories/3235402/',
            guid: 'https://help.orf.at/stories/3235402/',
            category: 'Wirtschaft',
            pubDate: 'Tue, 21 Apr 2026 06:30:00 +0000',
            description: 'Unique second',
          },
        ]),
      });

      const stories = await runScrape([firstUrl, secondUrl], 'help');
      const storyIds = stories.map((story) => story.id);

      expect(stories).toHaveLength(3);
      expect(storyIds).toEqual(['help:3235400', 'help:3235401', 'help:3235402']);
      expect(stories.find((story) => story.id === 'help:3235400')?.title).toBe('First Source Duplicate');
    });
  });
});

interface RdfItem {
  about: string;
  usid: string;
  link: string;
  subject: string;
  date: string;
  title: string;
}

interface SimpleItem {
  title: string;
  link: string;
  guid: string;
  description: string;
  category: string;
  pubDate: string;
}

function runScrape(url: string | Array<string>, source: string) {
  const mockedHttpClient = HttpClient.make((request, requestUrl) =>
    mockedHttpClientGet(request, requestUrl).pipe(
      Effect.flatMap((responseOrError: string | Error | undefined) => {
        if (responseOrError instanceof Error) {
          return Effect.fail(
            new HttpClientError.RequestError({
              request,
              reason: 'Transport',
              cause: responseOrError,
            }),
          );
        }

        if (responseOrError === undefined) {
          return Effect.succeed(HttpClientResponse.fromWeb(request, new Response('', { status: 404 })));
        }

        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(responseOrError, {
              status: 200,
              headers: { 'Content-Type': 'application/xml' },
            }),
          ),
        );
      }),
    ),
  );
  const mockedHttpClientLayer = Layer.succeed(HttpClient.HttpClient, mockedHttpClient);

  return Effect.runPromise(
    Effect.gen(function* () {
      const scraper = yield* Scraper;
      return yield* scraper.scrapeOrfNews(url, source);
    }).pipe(Effect.provide(Scraper.DefaultWithoutDependencies), Effect.provide(mockedHttpClientLayer)),
  );
}

function mockFetchResponses(feedByUrl: Record<string, string | Error>) {
  mockedResponseByUrl = feedByUrl;
  mockedHttpClientGet.mockImplementation((_request, requestUrl: URL) => {
    const requestUrlAsString = requestUrl.toString();
    const responseOrError = mockedResponseByUrl[requestUrlAsString];
    return Effect.succeed(responseOrError);
  });
}

function buildRdfFeed(items: Array<RdfItem>) {
  return `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:orfon="http://rss.orf.at/1.0/" xmlns="http://purl.org/rss/1.0/">
  <channel rdf:about="https://orf.at/">
    <title>news.ORF.at</title>
    <link>https://orf.at/</link>
    <items>
      <rdf:Seq>
        ${items.map((item) => `<rdf:li rdf:resource="${item.link}"/>`).join('\n')}
      </rdf:Seq>
    </items>
  </channel>
  ${items
    .map(
      (item) => `<item rdf:about="${item.about}">
    <title>${item.title}</title>
    <link>${item.link}</link>
    <dc:subject>${item.subject}</dc:subject>
    <dc:date>${item.date}</dc:date>
    <orfon:usid>${item.usid}</orfon:usid>
  </item>`,
    )
    .join('\n')}
</rdf:RDF>`;
}

function buildSimpleFeed(items: Array<SimpleItem>) {
  return `<rss version="2.0">
  <channel>
    <title>help.ORF.at</title>
    <link>https://help.orf.at/</link>
    <description>Mocked test feed</description>
    ${items
      .map(
        (item) => `<item>
      <title>${item.title}</title>
      <link>${item.link}</link>
      <guid isPermaLink="true">${item.guid}</guid>
      <description>${item.description}</description>
      <category>${item.category}</category>
      <pubDate>${item.pubDate}</pubDate>
    </item>`,
      )
      .join('\n')}
  </channel>
</rss>`;
}
