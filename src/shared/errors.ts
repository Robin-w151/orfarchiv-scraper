import { Data } from 'effect';

// Application errors
export class DatabaseError extends Data.TaggedError('DatabaseError')<{ message: string; cause: unknown }> {}
export class ScrapeError extends Data.TaggedError('ScrapeError')<{ message: string; cause: unknown }> {}
