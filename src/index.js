const { scrapeOrfNews } = require('./scrape');
const { persistOrfNews } = require('./db');
const sources = require('./sources.json');
const logger = require('./logger');
require('dotenv-flow').config({ silent: true });

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
