import { Layer } from 'effect';
import { Database } from './services/database';
import { Scraper } from './services/scraper';

export const AppLive = Layer.mergeAll(Database.layer, Scraper.layer);
