import { Layer } from 'effect';
import { Database } from './services/database';
import { Scraper } from './services/scraper';
import { Targets } from './services/targets';

export const AppLive = Layer.mergeAll(Scraper.layer, Database.layer, Targets.layer);
