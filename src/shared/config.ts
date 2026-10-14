import { Duration } from 'effect';

// Embedding
export const BATCH_SIZE = 100;
export const BATCH_TIMEOUT = Duration.seconds(30);

// Database
export const DB_TARGET_TIMEOUT = Duration.minutes(1);

// Content embeddings
export const CONTENT_MAX_TOKENS = 1024;
export const CONTENT_TOKEN_MARGIN = 8;
export const CONTENT_FETCH_CONCURRENCY = 10;
export const CONTENT_FETCH_TIMEOUT = Duration.seconds(30);
export const CONTENT_BACKLOG_LOG_INTERVAL = 10;
export const CONTENT_TRANSIENT_COOLDOWN = Duration.hours(1);
