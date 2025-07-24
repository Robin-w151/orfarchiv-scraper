import { FetchHttpClient } from '@effect/platform';
import { NodeFileSystem } from '@effect/platform-node';
import { Layer } from 'effect';
import { DatabaseLive } from './services/database';
import { EnvironmentLive } from './services/env';
import { ScraperLive } from './services/scraper';
import { LoggerLive } from './shared/logger';

export const AppLive = Layer.mergeAll(
  DatabaseLive,
  LoggerLive,
  ScraperLive,
  EnvironmentLive,
  NodeFileSystem.layer,
  FetchHttpClient.layer,
);
