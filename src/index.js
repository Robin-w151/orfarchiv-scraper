import dotenv from 'dotenv-flow';
import meow from 'meow';
import { exhaustMap, timer } from 'rxjs';
import { persistOrfNews } from './db.js';
import logger from './logger.js';
import { scrapeOrfNews } from './scrape.js';
import sources from './sources.json' with { type: 'json' };
import { readFile } from 'fs/promises';

dotenv.config({ silent: true });

main().catch(logger.error);

async function main() {
  const cli = meow(
    `
    Usage
      $ scraper [--poll]

    Options
      --poll           Keep polling for new stories
      --poll-interval  Polling interval in seconds (default: 60)

    Examples
      $ scraper
      $ scraper --poll --poll-interval 60
    `,
    {
      importMeta: import.meta,
      flags: {
        poll: {
          type: 'boolean',
          default: false,
        },
        pollInterval: {
          type: 'number',
          default: 60,
        },
      },
    },
  );

  await setup();

  const { poll = false, pollInterval = 60 } = cli.flags;
  if (poll) {
    timer(0, pollInterval * 1000)
      .pipe(
        exhaustMap(async () => {
          await run();
        }),
      )
      .subscribe();
  } else {
    await run();
  }
}

async function setup() {
  const orfArchivDbUrlFile = process.env['ORFARCHIV_DB_URL_FILE'];
  if (orfArchivDbUrlFile) {
    try {
      const orfArchivDbUrl = await readFile(orfArchivDbUrlFile, 'utf8');
      process.env['ORFARCHIV_DB_URL'] = orfArchivDbUrl.trim();
    } catch (error) {
      logger.error(error.message);
    }
  }
}

async function run() {
  try {
    const stories = [];
    for (const source of sources) {
      stories.push(...(await scrapeOrfNews(source.rssUrl, source.source)));
    }

    await persistOrfNews(stories);
  } catch (error) {
    logger.error(error.message);
  }
}
