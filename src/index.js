import { scrapeOrfNews } from './scrape.js';
import { persistOrfNews } from './db.js';
import sources from './sources.json' with { type: 'json' };
import logger from './logger.js';
import dotenv from 'dotenv-flow';

dotenv.config({ silent: true });

main().catch(logger.error);

async function main() {
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
