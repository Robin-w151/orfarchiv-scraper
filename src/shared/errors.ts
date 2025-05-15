import { Data } from 'effect';

// Application errors
export class DatabaseError extends Data.TaggedError('DatabaseError')<{ message: string; cause: unknown }> {}
export class ScraperError extends Data.TaggedError('ScraperError')<{ message: string; cause: unknown }> {}
