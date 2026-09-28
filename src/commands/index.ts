import { Command } from 'effect/unstable/cli';
import { backfillCommand } from './backfill';
import { scrapeCommand } from './scrape';
import { scraperCommand } from './scraper';
import { targetsCommand } from './targets';

export const mainCommand = scraperCommand.pipe(
  Command.withSubcommands([scrapeCommand, backfillCommand, targetsCommand]),
);
