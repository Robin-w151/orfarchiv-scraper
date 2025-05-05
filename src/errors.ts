import { Data } from 'effect';

export class DatabaseError extends Data.TaggedError('DatabaseError')<{ message: string; cause: unknown }> {}

export class ScrapeError extends Data.TaggedError('ScrapeError')<{ message: string; cause: unknown }> {}
