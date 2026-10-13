import { Command } from 'effect/cli';
import { backfillCommand } from './backfill';
import { embedContentCommand } from './embed-content';
import { scrapeCommand } from './scrape';
import { scraperCommand } from './scraper';
import { targetsCommand } from './targets';

export const mainCommand = scraperCommand.pipe(
  Command.withSubcommands([scrapeCommand, backfillCommand, embedContentCommand, targetsCommand]),
);
