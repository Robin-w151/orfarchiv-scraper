import dotenv from 'dotenv-flow';
import meow from 'meow';
import { CronJob } from 'cron';
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
      --poll    Keep polling for new stories
      --cron    Polling interval in cron syntax (default: 0 * * * * *, e.g. poll every minute)

    Examples
      $ scraper
      $ scraper --poll --cron "0 0 * * * *" // Poll every hour
    `,
    {
      importMeta: import.meta,
      flags: {
        poll: {
          type: 'boolean',
          default: false,
        },
        cron: {
          type: 'string',
          default: '0 * * * * *',
        },
      },
    },
  );

  await setup();

  const { poll, cron } = cli.flags;
  if (poll) {
    CronJob.from({
      cronTime: cron,
      onTick: () => {
        run();
      },
      start: true,
    });
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
