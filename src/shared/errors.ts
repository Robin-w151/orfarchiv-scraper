import { Data } from 'effect';

// Application errors
export class DatabaseError extends Data.TaggedError('DatabaseError')<{ message: string; cause: unknown }> {}
export class ContentError extends Data.TaggedError('ContentError')<{ message: string }> {}
export class ConfigError extends Data.TaggedError('ConfigError')<{ message: string }> {}
export class TargetError extends Data.TaggedError('TargetError')<{ message: string }> {}
export class ScraperError extends Data.TaggedError('ScraperError')<{
  message: string;
  cause: unknown;
  notFound?: boolean;
}> {}
export const EmbeddingErrorType = {
  Unreachable: 'unreachable',
  Timeout: 'timeout',
  Rejected: 'rejected',
  Malformed: 'malformed',
} as const;
export type EmbeddingErrorType = (typeof EmbeddingErrorType)[keyof typeof EmbeddingErrorType];
export class EmbeddingError extends Data.TaggedError('EmbeddingError')<{
  message: string;
  type: EmbeddingErrorType;
  cause: unknown;
}> {}
export const StoryPageErrorReason = {
  Unavailable: 'unavailable',
  Transient: 'transient',
} as const;
export type StoryPageErrorReason = (typeof StoryPageErrorReason)[keyof typeof StoryPageErrorReason];
export class StoryPageError extends Data.TaggedError('StoryPageError')<{
  message: string;
  url: string;
  reason: StoryPageErrorReason;
  status?: number;
  cause: unknown;
}> {}
